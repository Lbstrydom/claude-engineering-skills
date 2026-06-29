/**
 * @fileoverview Single entry point for recording triage outcomes across all stores.
 *
 * Solves the data loop gap: adjudication outcomes (accepted/dismissed) were never
 * persisted after triage. This module writes to ALL stores in one call:
 *   1. Supabase: finding_adjudication_events (source of truth)
 *   2. Supabase: audit_pass_stats (denormalized per-pass counts)
 *   3. Supabase: audit_findings (denormalized per-finding outcome)
 *   4. Supabase: audit_runs (aggregate counts)
 *   5. Local: .audit/outcomes.jsonl (bandit reward + offline fallback)
 *
 * Graceful degradation: if Supabase is unavailable, falls back to local-only.
 *
 * @module scripts/lib/outcome-sync
 */

import fs from 'node:fs';
import path from 'node:path';
import { semanticId } from './findings.mjs';
import { batchAppendOutcomes } from './findings-outcomes.mjs';
import { generateTopicId } from './ledger.mjs';
import { rewardWeights } from './config.mjs';
import { withFileLock } from './brainstorm/file-lock.mjs';
import { atomicWriteFileSync } from './file-io.mjs';

const OUTCOMES_PATH = '.audit/outcomes.jsonl';
const FINALIZED_MARKER = '.audit/.outcomes-finalized';

/** Read the finalized-key set (tolerant of a missing/corrupt marker). */
function readFinalizedKeys() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.resolve(FINALIZED_MARKER), 'utf-8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

/**
 * Append a round's local bandit-reward outcomes to `.audit/outcomes.jsonl`
 * exactly once per `key`. The check→append→mark critical section runs under
 * `withFileLock` so two concurrent same-repo audit sessions can't double-count.
 * When `key` is null (legacy callers), the marker guard is skipped — identical
 * to the pre-refactor append behaviour.
 *
 * @param {object[]} enriched - findings already enriched with adjudicationOutcome
 * @param {{ key?: string|null, round?: number }} opts
 * @returns {Promise<{ appended: number, skipped: boolean }>}
 */
export async function writeLocalOutcomesOnce(enriched, { key = null, round = 1 } = {}) {
  const records = enriched
    .filter(f => f.adjudicationOutcome !== 'pending')
    .map(f => ({
      findingId: f.id,
      semanticHash: f._hash || semanticId(f),
      pass: f._pass,
      severity: f.severity,
      category: f.category,
      section: f.section,
      primaryFile: f._primaryFile || f.section,
      accepted: f.adjudicationOutcome === 'accepted',
      adjudicationOutcome: f.adjudicationOutcome,
      reward: computeOutcomeReward(f),
      round,
    }));
  if (records.length === 0) return { appended: 0, skipped: false };

  // No key → legacy unguarded append (back-compat).
  if (!key) {
    batchAppendOutcomes(OUTCOMES_PATH, records);
    return { appended: records.length, skipped: false };
  }

  let appended = 0;
  let skipped = false;
  await withFileLock(path.resolve(`${FINALIZED_MARKER}.lock`), {}, () => {
    const done = readFinalizedKeys();
    if (done.has(key)) { skipped = true; return; }
    batchAppendOutcomes(OUTCOMES_PATH, records);
    appended = records.length;
    done.add(key);
    try { atomicWriteFileSync(path.resolve(FINALIZED_MARKER), JSON.stringify([...done])); }
    catch (err) { process.stderr.write(`  [outcome-sync] WARN: marker write failed: ${err.message}\n`); }
  });
  return { appended, skipped };
}

/**
 * Enrich findings with adjudication outcomes from the ledger.
 * @param {object[]} findings
 * @param {object} ledger - { entries: [...] }
 * @returns {object[]} Enriched findings
 */
function enrichFindings(findings, ledger) {
  return findings.map(f => {
    const topicId = generateTopicId(f);
    const entry = (ledger?.entries || []).find(e =>
      e.topicId === topicId || e.latestFindingId === f.id
    );
    return {
      ...f,
      _topicId: topicId,
      adjudicationOutcome: entry?.adjudicationOutcome ?? 'pending',
      remediationState: entry?.remediationState ?? 'pending',
      _ruling: entry?.ruling,
      _rulingRationale: entry?.rulingRationale,
    };
  });
}

/**
 * Compute per-pass aggregate counts from enriched findings.
 * @param {object[]} enriched
 * @returns {Object<string, {accepted: number, dismissed: number, compromised: number}>}
 */
function computePassCounts(enriched) {
  const passCounts = {};
  for (const f of enriched) {
    // Normalise case — `audit_pass_stats.pass_name` is lowercase, but a
    // finding's `_pass` can be capitalised (e.g. "Sustainability").
    const pass = (f._pass || 'unknown').toLowerCase();
    if (!passCounts[pass]) passCounts[pass] = { accepted: 0, dismissed: 0, compromised: 0 };
    if (f.adjudicationOutcome === 'accepted') passCounts[pass].accepted++;
    else if (f.adjudicationOutcome === 'dismissed') passCounts[pass].dismissed++;
    else if (f.adjudicationOutcome === 'severity_adjusted') passCounts[pass].compromised++;
  }
  return passCounts;
}

/** Rulings the `finding_adjudication_events.ruling` CHECK constraint allows. */
const VALID_RULINGS = new Set(['sustain', 'overrule', 'compromise']);

/**
 * A DB-CHECK-valid `ruling` for a finding. Uses the ledger's ruling when it
 * is one of the three allowed values; otherwise derives it from the
 * adjudication outcome (the ledger schema also permits `defer`, and entries
 * may carry no ruling at all — both must NOT reach the DB verbatim).
 * @param {object} f — enriched finding
 * @returns {'sustain'|'overrule'|'compromise'}
 */
function dbRuling(f) {
  if (VALID_RULINGS.has(f._ruling)) return f._ruling;
  if (f.adjudicationOutcome === 'accepted') return 'sustain';
  if (f.adjudicationOutcome === 'severity_adjusted') return 'compromise';
  return 'overrule'; // dismissed / anything else
}

/**
 * Write outcomes to cloud store (Supabase). Returns true on success.
 * @param {object} store
 * @param {string} runId
 * @param {object[]} enriched
 * @param {object} passCounts
 * @param {number} round
 * @returns {Promise<boolean>}
 */
async function writeCloudOutcomes(store, runId, enriched, passCounts, round) {
  if (typeof store.recordAdjudicationEvent === 'function') {
    for (const f of enriched) {
      if (f.adjudicationOutcome === 'pending') continue;
      // 2nd arg MUST be the finding fingerprint (`_hash`) — that is what
      // recordFindings stores in `audit_findings.finding_fingerprint`.
      // `f.id` is a per-run short id ("H1") and never resolves.
      await store.recordAdjudicationEvent(runId, f._hash || semanticId(f), {
        adjudicationOutcome: f.adjudicationOutcome,
        remediationState: f.remediationState,
        ruling: dbRuling(f),
        round,
      });
    }
  }

  if (typeof store.updatePassStatsPostDeliberation === 'function') {
    await store.updatePassStatsPostDeliberation(runId, passCounts);
  }

  // Stamp the run via a NON-destructive partial update — recordRunComplete
  // rewrites the whole row and would null rounds/total_findings/cost.
  if (typeof store.updateRunMeta === 'function') {
    const accepted = enriched.filter(f => f.adjudicationOutcome === 'accepted').length;
    const dismissed = enriched.filter(f => f.adjudicationOutcome === 'dismissed').length;
    await store.updateRunMeta(runId, {
      labeled: true,
      acceptedCount: accepted,
      dismissedCount: dismissed,
    });
  }

  return true;
}

/**
 * Record all triage outcomes from a deliberation round.
 * Writes to cloud + local stores atomically (best-effort for cloud).
 *
 * @param {object|null} store - Learning store instance (null = local-only)
 * @param {string} runId - Cloud run ID (or session ID for local)
 * @param {object[]} findings - All findings from this round
 * @param {object} ledger - Adjudication ledger { entries: [...] }
 * @param {object} [opts]
 * @param {number} [opts.round=1] - Current round number
 * @returns {{ enriched: object[], passCounts: object, cloudOk: boolean }}
 */
export async function recordTriageOutcomes(store, runId, findings, ledger, opts = {}) {
  const { round = 1 } = opts;

  const enriched = enrichFindings(findings, ledger);
  const passCounts = computePassCounts(enriched);

  // Cloud writes (graceful degradation)
  let cloudOk = false;
  if (store && runId) {
    try {
      cloudOk = await writeCloudOutcomes(store, runId, enriched, passCounts, round);
    } catch (err) {
      process.stderr.write(`  [outcome-sync] Cloud write failed: ${err.message} — local only\n`);
    }
  }

  // Local outcomes — idempotent (marker-guarded) when an idempotencyKey is
  // supplied (orchestrator/finalize path); unguarded append otherwise (legacy).
  const { appended, skipped } = await writeLocalOutcomesOnce(enriched, {
    key: opts.idempotencyKey ?? null,
    round,
  });
  if (appended > 0) {
    process.stderr.write(`  [outcome-sync] ${appended} outcomes recorded (cloud: ${cloudOk ? 'yes' : 'no'})\n`);
  }

  return { enriched, passCounts, cloudOk, localAppended: appended, localSkipped: skipped };
}

/**
 * Compute reward signal for bandit learning from triage outcome.
 * Accepted findings = positive reward, dismissed = negative.
 * Severity-weighted: HIGH accepted = 1.0, MEDIUM = 0.7, LOW = 0.4.
 * @param {object} finding - Enriched finding with adjudicationOutcome
 * @returns {number} Reward in [0, 1]
 */
function computeOutcomeReward(finding) {
  const weight = rewardWeights[finding.severity] ?? rewardWeights.default;

  if (finding.adjudicationOutcome === 'accepted') return weight;
  if (finding.adjudicationOutcome === 'severity_adjusted') return weight * 0.5;
  return 0; // dismissed
}
