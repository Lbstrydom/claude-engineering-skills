/**
 * @fileoverview Drift = observed-vs-intent divergence + aging (plan §4a.D/E).
 *
 * The CI gate fires ONLY on declared-intent regressions (coverage-gap / anchor
 * regression — the gate-eligible findings). Undeclared divergences (e.g. a new
 * orphan) are advisory. Aging is CLOUD-sourced (the earliest run-history row
 * carrying a divergence key is its firstSeen, plan §4a.D / Gemini-1-H); the local
 * gitignored ledger is only a convenience cache and its absence in CI is harmless.
 *
 * @module scripts/lib/nav/drift
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { DRIFT_LEDGER_FILE } from './schema.mjs';

/** A stable key for a divergence so it can be aged across runs. */
export function divergenceKey(finding) {
  return `${finding.class}:${finding.destination}`;
}

/**
 * Partition findings into gate-eligible divergences and advisory ones.
 * @param {object[]} findings - from runTaxonomy()
 * @returns {{gateEligible: object[], advisory: object[]}}
 */
export function partitionFindings(findings) {
  const gateEligible = findings.filter((f) => f.gateEligible);
  const advisory = findings.filter((f) => !f.gateEligible);
  return { gateEligible, advisory };
}

/**
 * Scope gate-eligible findings to the changed surface (plan §4a.G). A finding is
 * gate-eligible in diff mode iff its affected files intersect the changed set.
 * @param {object[]} gateEligible
 * @param {Set<string>} changedFiles - repo-relative paths (merge-base diff)
 * @param {{contractChanged: boolean}} [opts]
 * @returns {object[]} the subset that should actually block
 */
export function scopeToChanged(gateEligible, changedFiles, { contractChanged = false } = {}) {
  if (!changedFiles) return gateEligible; // full-scope run: all eligible
  return gateEligible.filter((f) => {
    if (contractChanged) return true; // a contract edit can move any declared intent
    const files = (f.evidence || [])
      .map((e) => (typeof e === 'string' ? (e.match(/([\w./-]+\.[jt]sx?):\d+/) || [])[1] : null))
      .filter(Boolean);
    return files.some((file) => changedFiles.has(file));
  });
}

/**
 * Age divergences using a firstSeen lookup (cloud-sourced) + headCommitDate.
 * @param {object[]} findings
 * @param {object} args
 * @param {(key: string) => string|null} args.firstSeenLookup - returns ISO date or null
 * @param {string} args.headCommitDate - ISO-8601 (deterministic git timestamp)
 * @returns {Array<{key: string, finding: object, firstSeen: string, ageDays: number}>}
 */
export function ageDivergences(findings, { firstSeenLookup, headCommitDate }) {
  const head = Date.parse(headCommitDate);
  return findings.map((finding) => {
    const key = divergenceKey(finding);
    const firstSeen = (firstSeenLookup && firstSeenLookup(key)) || headCommitDate;
    return { key, finding, firstSeen, ageDays: computeAgeDays(head, firstSeen) };
  });
}

/**
 * Age in whole days, or `null` when either endpoint is not a parseable date.
 *
 * The tech-debt entry (`fa6e120c`) named only the visual copy of this function,
 * but the defect is in BOTH — and it is this one that has a live consumer
 * (`scripts/lib/dashboard/collect-nav.mjs` renders `ageDays` into the drift
 * panel). Fixing only the file the ticket named would have left the reachable
 * instance broken.
 *
 * An unparseable `firstSeen` gave `NaN`; an unparseable `headCommitDate` gave
 * **0**, reporting every finding as brand new. `null` says "unknown" and keeps a
 * genuine 0 — first seen AT head — meaning what it says.
 *
 * NOTE: byte-identical to `scripts/lib/visual/drift.mjs`'s copy by design (two
 * separate lenses); `tests/visual-drift.test.mjs` asserts both agree.
 *
 * @param {number} head - `Date.parse` of the head commit date
 * @param {string} firstSeen
 * @returns {number|null}
 */
function computeAgeDays(head, firstSeen) {
  const seen = Date.parse(firstSeen);
  if (!Number.isFinite(head) || !Number.isFinite(seen)) return null;
  return Math.max(0, Math.floor((head - seen) / 86400000));
}

/** Read the local drift-ledger cache (convenience only; never source of truth). */
export function readDriftLedger(root) {
  try {
    const raw = fs.readFileSync(path.join(root, DRIFT_LEDGER_FILE), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.firstSeen === 'object' ? parsed.firstSeen : {};
  } catch { return {}; }
}

/** Reconcile + write the local cache: existing keys keep firstSeen, new keys
 *  stamp headCommitDate, resolved keys are dropped. */
export function writeDriftLedger(root, activeKeys, headCommitDate, prior = {}) {
  const firstSeen = {};
  for (const key of activeKeys) firstSeen[key] = prior[key] || headCommitDate;
  atomicWriteFileSync(path.join(root, DRIFT_LEDGER_FILE), JSON.stringify({ version: 1, firstSeen }, null, 2));
  return firstSeen;
}

/** Build a firstSeenLookup from cloud run-history rows (each {driftKeys, capturedAt}). */
export function firstSeenFromHistory(historyRows) {
  const earliest = new Map();
  for (const row of historyRows || []) {
    const when = row.capturedAt || row.captured_at;
    // Guard invalid/missing timestamps — otherwise an undefined `when` poisons the
    // map and discards every subsequent valid row (Gemini-1-M NaN bug).
    if (!when || Number.isNaN(Date.parse(when))) continue;
    for (const key of row.driftKeys || row.drift_keys || []) {
      if (!earliest.has(key) || Date.parse(when) < Date.parse(earliest.get(key))) earliest.set(key, when);
    }
  }
  return (key) => earliest.get(key) || null;
}
