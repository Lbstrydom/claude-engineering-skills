#!/usr/bin/env node
/**
 * @fileoverview `campaign.mjs` — the campaign operator CLI.
 *
 * Plan: docs/plans/model-comparison-campaigns.md §2.5c (adjudication protocol),
 * §5 (resume semantics), §7a (persistence), §7b Phase 3.
 *
 * Commands use REAL values, never angle-bracket placeholders: PowerShell
 * reserves `<`, so a `--campaign <id>` line is unpasteable on the platform half
 * this repo's operators are on (AGENTS.md operator-doc convention).
 *
 *   node scripts/campaign.mjs status               --campaign final-review-2026q3
 *   node scripts/campaign.mjs cluster              --campaign final-review-2026q3 --recluster
 *   node scripts/campaign.mjs adjudicate           --campaign final-review-2026q3 --limit 10
 *   node scripts/campaign.mjs override             --finding FINDING_UUID --verdict dismissed --note "why"
 *   node scripts/campaign.mjs verdict              --campaign final-review-2026q3
 *   node scripts/campaign.mjs reconcile            --campaign final-review-2026q3
 *   node scripts/campaign.mjs declare-inconclusive --campaign final-review-2026q3 --reason "why"
 *   node scripts/campaign.mjs --selfcheck-relocation
 *
 * **The adjudicator VERIFIES; it does not judge.** Every verdict records a
 * `method` — `verified` when the claim was settled against the tree at the
 * snapshot's own `audited_sha`, `unverifiable` when it could not be. Anything
 * the instrument cannot settle routes to the human queue rather than being
 * auto-accepted: LLM re-judgement of historical findings measured 52% agreement
 * with a human here, while verification against code is instrument-settleable.
 * That distinction is the entire reason these verdicts are worth recording.
 *
 * **Tool policy: explicitly none.** The adjudicator runs forced-structured-
 * output with no tool loop. Retrieval happens HERE, in the CLI, where it is
 * deterministic, bounded, sensitive-path-gated and reproducible from the
 * receipt. Giving the model a `git show` tool would put an unbounded, unlogged
 * read loop inside a spend-bearing blind adjudication — the opposite of what
 * makes these verdicts auditable.
 *
 * @module scripts/campaign
 */

import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';

import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { selectCampaignConfig, ANALYSIS_TIME_FIELDS } from './lib/campaign/config.mjs';
import {
  receiptPath, resolveNextAttempt, claimReceipt, completeReceipt, markReceiptRecorded, scanReceipts,
} from './lib/campaign/lock.mjs';
import { evaluateCampaign, terminalEvent } from './lib/campaign/verdict.mjs';
import { resolveArms, readLog } from './bakeoff-collect.mjs';
import { matchFindings, affectedFilesOf } from './lib/finding-match.mjs';
import { findingMatchConfig, FINDING_MATCH_SCHEMA_VERSION } from './lib/config.mjs';
import { classifyPath } from './lib/sensitive-paths.mjs';
import { gitShowFileAtRevision } from './lib/vcs.mjs';
import { resolveModel } from './lib/model-resolver.mjs';
import { costFromUsage } from './lib/model-pricing.mjs';
import { createAnthropicClient } from './lib/anthropic-client.mjs';
import * as store from './lib/store/campaign.mjs';

const KNOWN_FLAGS = Object.freeze([
  '--campaign', '--finding', '--verdict', '--note', '--reason', '--limit',
  '--dry-run', '--recluster', '--actor', '--json',
  '--selfcheck-relocation', '--help', '-h',
]);

const VERBS = Object.freeze(['status', 'cluster', 'adjudicate', 'override', 'verdict', 'reconcile', 'declare-inconclusive']);

/** Lines of a cited file handed to the adjudicator, CENTRED on the cited range. */
export const CITED_SOURCE_WINDOW_LINES = 240;
/** Cited files per row. Beyond this the prompt stops being evidence and becomes noise. */
export const CITED_SOURCE_MAX_FILES = 4;

// ── Cited sources ───────────────────────────────────────────────────────────

/**
 * A window of `content` centred on `line`, or the head when no line is cited.
 *
 * **Centred, not head-truncated, and this is load-bearing.** If an arm
 * correctly finds a defect at line 800 of a file truncated at line 500, the
 * adjudicator sees a resolved file WITHOUT the defect and reports it absent —
 * penalising the arm for being right. Centring normally keeps the relevant span
 * present; the `truncated` flag is the second half of the mitigation, and the
 * prompt turns it into a hard rule (a defect not visible in the shown span is
 * `unverifiable`, never `verified` with outcome `dismissed`).
 *
 * @param {string} content
 * @param {number|null} line - 1-indexed
 * @param {number} [windowLines]
 */
export function centredWindow(content, line, windowLines = CITED_SOURCE_WINDOW_LINES) {
  const lines = String(content ?? '').split('\n');
  if (lines.length <= windowLines) {
    return { text: lines.join('\n'), startLine: 1, endLine: lines.length, truncated: false };
  }
  const half = Math.floor(windowLines / 2);
  const centre = Number.isInteger(line) && line > 0 ? line : half + 1;
  let start = Math.max(1, centre - half);
  let end = Math.min(lines.length, start + windowLines - 1);
  start = Math.max(1, end - windowLines + 1);
  return { text: lines.slice(start - 1, end).join('\n'), startLine: start, endLine: end, truncated: true };
}

/** First 1-indexed line number a finding's section cites, or null. */
export function citedLineOf(section) {
  const m = /:(\d+)/.exec(String(section ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Resolve the files a finding cites, at the snapshot's OWN revision.
 *
 * Paths come from `affectedFilesOf()` — the same union the matcher uses — so a
 * finding naming its file only in prose still resolves. Sensitive paths are
 * refused and MARKED, never read: this is an egress seam like any other, and a
 * path naming a credential store must fail closed rather than be quoted into a
 * provider prompt.
 *
 * **The classification is LEXICAL, deliberately, and this is not the weaker
 * check it looks like.** `resolveAndClassify` answers a question about the
 * WORKING TREE — it realpaths, and reports `resolutionFailed` for anything not
 * on disk right now. But `git show sha:path` reads the object store, not the
 * filesystem: a file deleted since `auditedSha` still resolves (and would have
 * been wrongly forced into the human queue by a working-tree check), while a
 * symlink planted in the working tree cannot redirect the read at all, because
 * there is no filesystem traversal to redirect. So the hazards that make
 * realpath resolution necessary elsewhere do not exist on this seam, and the
 * two that DO — a lexically sensitive name and a path escaping the repo — are
 * exactly what is checked.
 *
 * @returns {{sources: Array<object>, resolvedAny: boolean}}
 */
export function resolveCitedSources({ section, auditedSha, repoRoot = process.cwd(), show = gitShowFileAtRevision }) {
  const paths = affectedFilesOf({ section }).slice(0, CITED_SOURCE_MAX_FILES);
  const line = citedLineOf(section);
  const sources = [];
  let resolvedAny = false;
  for (const p of paths) {
    if (classifyPath(p) === 'sensitive') {
      sources.push({ path: p, resolved: false, reason: 'sensitive-path' });
      continue;
    }
    if (path.isAbsolute(p) || p.split('/').includes('..')) {
      sources.push({ path: p, resolved: false, reason: 'path-escapes-repo' });
      continue;
    }
    const res = show(repoRoot, auditedSha, p);
    if (!res.ok) {
      sources.push({ path: p, resolved: false, reason: res.error?.code ?? 'unreadable' });
      continue;
    }
    const win = centredWindow(res.content, line);
    resolvedAny = true;
    sources.push({
      path: p, sha: auditedSha, resolved: true,
      startLine: win.startLine, endLine: win.endLine, truncated: win.truncated, content: win.text,
    });
  }
  return { sources, resolvedAny };
}

// ── The adjudication contract ───────────────────────────────────────────────

/**
 * `verified-true`/`verified-false` in the plan's prose map onto the pair
 * (`method: 'verified'`, `outcome: accepted|dismissed`) here — one axis for HOW
 * the verdict was reached, one for WHAT it was, rather than a four-value enum
 * that conflates them.
 *
 * The field is `outcome`, NOT `ruling`, and the distinction is load-bearing:
 * `finding_adjudication_events.ruling` is CHECK'd to
 * `(sustain, overrule, compromise)` — the GPT-vs-Gemini DELIBERATION ruling, a
 * different axis entirely. Writing an accept/dismiss verdict there is rejected
 * by the constraint, which is how the live suite caught this.
 */
export const AdjudicationVerdictSchema = z.object({
  worksheetRowId: z.string().min(1),
  method: z.enum(['verified', 'unverifiable']),
  outcome: z.enum(['accepted', 'dismissed', 'needs_triage']),
  evidence: z.object({
    path: z.string().nullable(),
    sha: z.string().nullable(),
    lineRange: z.string().nullable(),
    quotedSpan: z.string().nullable(),
    absenceReason: z.string().nullable(),
  }),
  confidence: z.number().min(0).max(1),
}).strict();

/** The tool the adjudicator is FORCED to call. No other tool is offered. */
export const ADJUDICATION_TOOL = Object.freeze({
  name: 'record_verdict',
  description: 'Record the verdict for exactly one finding.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['worksheetRowId', 'method', 'outcome', 'evidence', 'confidence'],
    properties: {
      worksheetRowId: { type: 'string' },
      method: { type: 'string', enum: ['verified', 'unverifiable'] },
      outcome: { type: 'string', enum: ['accepted', 'dismissed', 'needs_triage'] },
      evidence: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sha', 'lineRange', 'quotedSpan', 'absenceReason'],
        properties: {
          path: { type: ['string', 'null'] },
          sha: { type: ['string', 'null'] },
          lineRange: { type: ['string', 'null'] },
          quotedSpan: { type: ['string', 'null'] },
          absenceReason: { type: ['string', 'null'] },
        },
      },
      confidence: { type: 'number' },
    },
  },
});

export const ADJUDICATION_SYSTEM_PROMPT = [
  'You VERIFY one code-audit finding against source you are shown. You do not judge whether it is worth fixing.',
  '',
  'Rules, in order of precedence:',
  '1. `method: "verified"` requires that you located the cited code in citedSources and can quote it.',
  '   Set outcome "accepted" when the described defect IS present at that revision, "dismissed" when it is not.',
  '2. If a cited source is marked `truncated: true` and the defect is not visible in the span shown,',
  '   you MUST answer `method: "unverifiable"` with outcome "needs_triage". Never "dismissed".',
  '   A partial view is not evidence of absence, and a wrong dismissal penalises an arm for being right.',
  '3. If the claim cannot be settled against code at all (it is an opinion, a design preference, or the',
  '   sources do not cover it), answer `method: "unverifiable"` with outcome "needs_triage".',
  '4. `evidence` is mandatory. For "accepted": path, sha, lineRange, quotedSpan. For "dismissed": the same',
  '   plus absenceReason. Leave a field null only when it genuinely does not apply.',
  '',
  'Model and provider names have been redacted from the finding text. Do not speculate about which model',
  'wrote it; that information is deliberately withheld and guessing corrupts the measurement.',
].join('\n');

/**
 * Validate a raw verdict, with the plan's non-negotiable downgrade: **a verdict
 * with unparseable or missing evidence becomes `unverifiable`/`needs_triage`,
 * not a warning.** An unsupported machine verdict is worth less than an honest
 * hand-off, and a malformed one must never become a silent `pending`.
 */
export function normaliseVerdict(raw, { worksheetRowId }) {
  const parsed = AdjudicationVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  }
  const v = parsed.data;
  if (v.worksheetRowId !== worksheetRowId) {
    // The row id is the ONLY reconciliation key; a mismatched one would file a
    // verdict against the wrong finding.
    return { ok: false, reason: `worksheetRowId mismatch (expected ${worksheetRowId}, got ${v.worksheetRowId})` };
  }
  if (v.method === 'verified') {
    const e = v.evidence;
    const missing = ['path', 'sha', 'lineRange', 'quotedSpan'].filter((k) => !e[k]);
    if (v.outcome === 'dismissed' && !e.absenceReason) missing.push('absenceReason');
    if (missing.length > 0) {
      return {
        ok: true,
        verdict: { ...v, method: 'unverifiable', outcome: 'needs_triage' },
        downgraded: `verified verdict lacked evidence (${missing.join(', ')}) — downgraded to unverifiable`,
      };
    }
  }
  return { ok: true, verdict: v, downgraded: null };
}

/** Findings whose outcome routes to the human queue rather than counting. */
export function routesToHumanQueue(verdict) {
  return verdict.method === 'unverifiable' || verdict.outcome === 'needs_triage';
}

// ── Clustering ──────────────────────────────────────────────────────────────

/**
 * Cluster one snapshot's findings across ALL arms.
 *
 * `matchFindings` is pairwise (a primary against a shadow), so N arms are
 * clustered by running every arm pair through it and unioning the accepted
 * pairs. That is a faithful generalisation rather than a new matcher: the
 * threshold, the file-sharing conjunction and the deterministic tiebreak are
 * unchanged, and one-to-one within each pair still holds. Transitive closure
 * across pairs is deliberate — if A matches B and B matches C, the three are
 * one defect, and splitting them would double-count the denominator.
 *
 * **Refuses rather than guesses.** A snapshot whose findings yield no resolvable
 * file paths gets `coverage: 'unknown'` and NO cluster set — plan-mode findings
 * cite `§`-sections, so `affectedFilesOf` has nothing to intersect and the
 * prefilter can never fire. `verdict.mjs` then watermarks, which is the honest
 * outcome; writing a cluster set from an unusable match would silently revert to
 * the pre-matcher behaviour that made "unique" mean "total".
 *
 * @param {Array<{findingId: string, armId: string, section: string|null, category: string|null, detail: string|null, severity: string}>} findings
 * @param {{threshold: number, coverageFloor: number}} opts
 */
export function clusterSnapshotFindings(findings, { threshold, coverageFloor }) {
  const rows = (findings || []).filter(Boolean);
  if (rows.length === 0) return { coverage: 'unknown', reason: 'no findings', clusters: [] };

  const withFiles = rows.filter((r) => affectedFilesOf({ section: r.section }).length > 0);
  const coverage = withFiles.length / rows.length;
  if (coverage < coverageFloor) {
    return {
      coverage: 'unknown', clusters: [],
      reason: `only ${withFiles.length}/${rows.length} findings cite a resolvable file path (floor ${coverageFloor}) — `
        + 'the file-set prefilter cannot fire, so no attribution is possible for this snapshot',
    };
  }

  const byArm = new Map();
  for (const r of rows) {
    if (!byArm.has(r.armId)) byArm.set(r.armId, []);
    // `_hash` is the finding id, so the matcher's pairs map straight back.
    byArm.get(r.armId).push({ _hash: r.findingId, section: r.section, category: r.category, detail: r.detail });
  }

  const parent = new Map(rows.map((r) => [r.findingId, r.findingId]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };

  const armIds = [...byArm.keys()].sort();
  for (let i = 0; i < armIds.length; i += 1) {
    for (let k = i + 1; k < armIds.length; k += 1) {
      const res = matchFindings(byArm.get(armIds[i]), byArm.get(armIds[k]), { threshold, coverageFloor });
      for (const pair of res.pairs) union(pair.primaryHash, pair.shadowHash);
    }
  }

  const groups = new Map();
  for (const r of rows) {
    const root = find(r.findingId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }
  // Both the cluster order and the MEMBER order are sorted by finding id.
  // Sorting the clusters alone is not enough: `groups` is built by iterating
  // `rows`, so a differently-ordered input produced identically-partitioned
  // clusters whose member arrays were permuted — two runs over one snapshot
  // that agree on the answer and disagree on the bytes, which is the shape that
  // makes a "deterministic" claim quietly false.
  const clusters = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([root, members]) => ({
      canonicalFindingId: root,
      members: members
        .map((m) => ({ findingId: m.findingId, armId: m.armId, severity: m.severity }))
        .sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0)),
    }));
  return { coverage, clusters, reason: null };
}

// ── CLI plumbing ────────────────────────────────────────────────────────────

function arg(name, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? null : (argv[i + 1] ?? null);
}

function requireArg(name, argv = process.argv) {
  const v = arg(name, argv);
  if (!v || v.startsWith('--')) throw new ArgvError(`--${name} <value> is required`);
  return v;
}

/** Resolve the campaign config + derived lock, refusing ambiguity. */
function loadCampaign(campaignId) {
  const selected = selectCampaignConfig({ campaignId });
  if (!selected.ok) throw new ArgvError(selected.message);
  const resolved = resolveArms({ campaignId: selected.config.id });
  return { config: selected.config, configDigest: selected.configDigest, lock: resolved.lock, arms: resolved.arms };
}

async function repoId() {
  const { resolveRepoForStore } = await import('./lib/store/repo.mjs');
  const { generateRepoProfile } = await import('./lib/context.mjs');
  const ref = await resolveRepoForStore({ profile: generateRepoProfile() }).catch(() => null);
  return ref?.repoRowId ?? null;
}

/** Cloud-off is a hint and exit 0, never a crash: a repo may legitimately run
 *  campaigns with no store, and the local bake-off log still exists. */
function cloudOffNotice(verb) {
  process.stdout.write(`campaign ${verb}: the cloud store is off (AUDIT_DB_URL unset) — nothing to read.\n`
    + '  Local collection still works; set AUDIT_DB_URL to record and adjudicate.\n');
}

// ── Verbs ───────────────────────────────────────────────────────────────────

/**
 * Assemble everything `evaluateCampaign` needs from the store. One read path,
 * shared by `status`, `verdict` and (Cluster C) the dashboard collector — so
 * three surfaces cannot disagree about what a campaign's state is.
 */
async function readCohortEvidence({ config, lock }) {
  const rid = await repoId();
  const resolved = await store.resolveCohort({ repoId: rid, campaignKey: config.id, lockDigest: lock?.lockDigest ?? null });
  if (!resolved.cohortId) {
    return { ok: false, reason: 'no cohort recorded for this campaign under the current lock', campaignId: resolved.campaignId };
  }
  const findings = await store.loadCohortFindings(resolved.cohortId);
  const events = await store.loadAdjudicationEvents(findings.rows.map((r) => r.finding_id));
  const clusters = await store.loadClusters(resolved.cohortId, FINDING_MATCH_SCHEMA_VERSION);
  const calibration = await store.calibrationSummary(resolved.cohortId);
  const overhead = await store.adjudicationOverhead(resolved.cohortId);
  const eventLog = await store.listCampaignEvents(resolved.campaignId);

  const eventsByFinding = new Map();
  for (const e of events.rows) {
    if (!eventsByFinding.has(e.finding_id)) eventsByFinding.set(e.finding_id, []);
    eventsByFinding.get(e.finding_id).push({
      id: e.id, adjudicationOutcome: e.adjudication_outcome, adjudicatorKind: e.adjudicator_kind,
      method: e.method, supersededAt: e.superseded_at, createdAt: e.created_at,
    });
  }

  // Snapshots + arm-runs, assembled from the finding rows' arm-run join plus a
  // direct arm-run read (an arm-run with zero findings must still appear, or a
  // silent arm looks like an absent one).
  const armRunRows = await store.loadCohortArmRuns(resolved.cohortId);
  const bySnapshot = new Map();
  for (const r of armRunRows.rows) {
    if (!bySnapshot.has(r.snapshot_id)) bySnapshot.set(r.snapshot_id, { snapshotId: r.snapshot_id, armRuns: [] });
    bySnapshot.get(r.snapshot_id).armRuns.push({
      armId: r.arm_id, attempt: r.attempt, error: r.error, supersededAt: r.superseded_at,
      costUsd: r.cost_usd == null ? null : Number(r.cost_usd), costStatus: r.cost_status,
    });
  }

  const clusterMap = new Map();
  for (const r of clusters.rows) {
    if (!clusterMap.has(r.cluster_id)) clusterMap.set(r.cluster_id, { clusterId: r.cluster_id, snapshotId: r.snapshot_id, members: [] });
    clusterMap.get(r.cluster_id).members.push({
      findingId: r.finding_id, armId: r.arm_id, severity: r.severity, events: eventsByFinding.get(r.finding_id) ?? [],
    });
  }

  let unadjudicated = 0;
  let humanQueuePending = 0;
  for (const f of findings.rows) {
    const term = terminalEvent(eventsByFinding.get(f.finding_id) ?? []);
    if (!term) { unadjudicated += 1; continue; }
    if (term.adjudicatorKind === 'agent' && (term.method === 'unverifiable' || term.adjudicationOutcome === 'needs_triage')) {
      humanQueuePending += 1;
    }
  }

  const snapshots = [...bySnapshot.values()];
  const completeIds = new Set();
  const nonReplicateArmIds = config.arms.filter((a) => a.type !== 'replicate').map((a) => a.id);
  for (const s of snapshots) {
    const ok = new Set(s.armRuns.filter((r) => r.supersededAt == null && !r.error).map((r) => r.armId));
    if (nonReplicateArmIds.every((id) => ok.has(id))) completeIds.add(s.snapshotId);
  }
  const clusteredSnapshots = new Set(clusters.rows.map((r) => r.snapshot_id));
  const snapshotsMissingClusters = [...completeIds].filter((id) => !clusteredSnapshots.has(id)).sort();

  const declared = eventLog.rows.find((e) => e.kind === 'declared-inconclusive') ?? null;
  const firstArmRunAt = armRunRows.rows.length > 0
    ? armRunRows.rows.map((r) => r.created_at).sort()[0]
    : null;
  const ruleChangedAfterFirstArmRun = firstArmRunAt != null
    && eventLog.rows.some((e) => e.kind === 'rule_changed' && String(e.created_at) > String(firstArmRunAt));

  return {
    ok: true,
    campaignId: resolved.campaignId,
    cohortId: resolved.cohortId,
    cohortSuperseded: resolved.cohortSuperseded,
    findings: findings.rows,
    snapshots,
    clusters: [...clusterMap.values()],
    adjudication: { unadjudicatedFindings: unadjudicated, humanQueuePending },
    calibration: { perArm: calibration.perArm },
    clustering: { snapshotsMissingClusters, matcherVersion: String(FINDING_MATCH_SCHEMA_VERSION) },
    overhead,
    declaredInconclusive: declared ? { reason: declared.detail?.reason ?? 'declared by operator' } : null,
    ruleChangedAfterFirstArmRun,
  };
}

async function verbStatus(campaignId, { asJson }) {
  const { config, lock } = loadCampaign(campaignId);
  const ev = await readCohortEvidence({ config, lock });
  if (!ev.ok) {
    // Local-only readout: the bake-off log is the collection record even when
    // nothing has been promoted into the store yet. Reporting "0 snapshots"
    // here would read as a measurement of an empty campaign.
    const local = readLog().filter((e) => e.campaignId === config.id);
    process.stdout.write(`campaign ${config.id}: ${ev.reason}\n`
      + `  local bake-off log: ${local.length} snapshot(s) collected under lock ${lock?.lockDigest ?? 'n/a'}\n`
      + '  run `campaign.mjs reconcile` if receipts exist but rows do not.\n');
    return 0;
  }
  const result = evaluateCampaign({
    config, snapshots: ev.snapshots, clusters: ev.clusters, adjudication: ev.adjudication,
    calibration: ev.calibration, clustering: ev.clustering, cohortSuperseded: ev.cohortSuperseded,
    declaredInconclusive: ev.declaredInconclusive, ruleChangedAfterFirstArmRun: ev.ruleChangedAfterFirstArmRun,
  });
  if (asJson) { process.stdout.write(`${JSON.stringify({ ...result, overhead: ev.overhead }, null, 2)}\n`); return 0; }

  const L = [];
  L.push(`campaign ${config.id} — ${result.state}`);
  L.push(`  ${result.stateReason}`);
  L.push(`  lock ${lock?.lockDigest ?? 'n/a'}${ev.cohortSuperseded ? ' (SUPERSEDED)' : ''}`);
  L.push(`  N complete: ${result.nComplete} / ${config.targetN}`);
  for (const row of result.completion.incomplete) {
    L.push(`    incomplete ${row.snapshotId}: missing ${row.missingArms.join(', ')}`);
  }
  L.push('  spend per arm (ALL attempts, superseded included — a retried arm was paid for twice):');
  for (const [armId, s] of Object.entries(result.spend)) {
    const money = s.costEvidence === 'known' ? `$${s.spendUsd.toFixed(4)}` : 'unknown';
    L.push(`    ${armId}: ${money}${s.attempts > 1 ? ` over ${s.attempts} attempts` : ''}`);
  }
  L.push(`  adjudication overhead: ${ev.overhead.costEvidence === 'known' ? `$${Number(ev.overhead.spendUsd).toFixed(4)}` : 'unknown'} over ${ev.overhead.attempts ?? 0} attempt(s)`);
  L.push('  calibration:');
  for (const [armId, c] of Object.entries(ev.calibration.perArm)) {
    L.push(`    ${armId}: sample ${c.dispositioned}/${c.assigned} reviewed · override rate ${c.overrideRate == null ? 'unknown' : `${(c.overrideRate * 100).toFixed(0)}%`} · self-family ${c.selfFamilyShare == null ? 'unknown' : `${(c.selfFamilyShare * 100).toFixed(0)}%`}`);
  }
  if (result.watermark) {
    L.push(`  ${result.watermark.label} — failing gates:`);
    for (const g of result.watermark.failing) L.push(`    ${g.id}: ${g.detail}`);
  }
  for (const a of result.advisories) L.push(`  advisory ${a.id}: ${a.detail}`);
  L.push(`  analysis-time fields (outside every digest): ${ANALYSIS_TIME_FIELDS.join(', ')}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

async function verbVerdict(campaignId, { asJson }) {
  const { config, lock } = loadCampaign(campaignId);
  const ev = await readCohortEvidence({ config, lock });
  if (!ev.ok) { process.stdout.write(`campaign ${config.id}: ${ev.reason} — no verdict is computable.\n`); return 3; }
  const result = evaluateCampaign({
    config, snapshots: ev.snapshots, clusters: ev.clusters, adjudication: ev.adjudication,
    calibration: ev.calibration, clustering: ev.clustering, cohortSuperseded: ev.cohortSuperseded,
    declaredInconclusive: ev.declaredInconclusive, ruleChangedAfterFirstArmRun: ev.ruleChangedAfterFirstArmRun,
  });
  if (asJson) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result.decisionEligible ? 0 : 3; }

  const L = [`campaign ${config.id} verdict — state ${result.state}`];
  L.push(`  floor (incumbent ${result.floor.incumbentArmId} at ${result.floor.incumbentPerSnapshot}/snapshot, margin ${result.floor.floorMargin} → threshold ${result.floor.threshold}):`);
  for (const [armId, f] of Object.entries(result.floor.perArm)) {
    L.push(`    ${armId}: ${f.accepted} accepted → ${f.perSnapshot}/snapshot — ${f.clears ? 'CLEARS' : `blocked (relative ${f.clearsRelative ? 'ok' : 'fail'}, above-zero ${f.clearsAbsolute ? 'ok' : 'fail'})`}`);
  }
  if (result.cost.evaluated) {
    L.push('  cost per accepted:');
    for (const [armId, c] of Object.entries(result.cost.perArm)) {
      L.push(`    ${armId}: ${c.costPerAccepted == null ? 'undefined (0 accepted)' : `$${c.costPerAccepted.toFixed(4)}`}${c.withinCeiling === false ? ' — over ceiling' : ''}`);
    }
  } else {
    L.push(`  cost stage NOT evaluated: ${result.cost.reason}`);
  }
  L.push(result.verdict
    ? `  VERDICT: ${result.verdict.outcome}${result.verdict.armId ? ` ${result.verdict.armId}` : ''} — ${result.verdict.reason}`
    : `  VERDICT: not decision-eligible — ${result.watermark.failing.map((g) => g.id).join(', ')}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return result.decisionEligible ? 0 : 3;
}

async function verbCluster(campaignId, { recluster }) {
  const { config, lock } = loadCampaign(campaignId);
  const ev = await readCohortEvidence({ config, lock });
  if (!ev.ok) { process.stdout.write(`campaign ${config.id}: ${ev.reason}\n`); return 3; }

  const bySnapshot = new Map();
  for (const f of ev.findings) {
    if (!bySnapshot.has(f.snapshot_id)) bySnapshot.set(f.snapshot_id, []);
    bySnapshot.get(f.snapshot_id).push({
      findingId: f.finding_id, armId: f.arm_id, section: f.primary_file,
      category: f.category, detail: f.detail_snapshot, severity: f.severity,
    });
  }

  let written = 0;
  const refused = [];
  for (const [snapshotId, rows] of bySnapshot) {
    if (!recluster && !ev.clustering.snapshotsMissingClusters.includes(snapshotId)) continue;
    const res = clusterSnapshotFindings(rows, findingMatchConfig);
    if (res.coverage === 'unknown') { refused.push({ snapshotId, reason: res.reason }); continue; }
    const w = await store.writeClusterSet({
      cohortId: ev.cohortId, snapshotId,
      matcherVersion: String(FINDING_MATCH_SCHEMA_VERSION), matcherThreshold: findingMatchConfig.threshold,
      clusters: res.clusters,
    });
    if (!w.ok) { refused.push({ snapshotId, reason: w.error }); continue; }
    written += w.written;
  }
  process.stdout.write(`campaign ${config.id}: wrote ${written} cluster(s) under matcher v${FINDING_MATCH_SCHEMA_VERSION} @ ${findingMatchConfig.threshold}\n`);
  for (const r of refused) process.stdout.write(`  REFUSED ${r.snapshotId}: ${r.reason}\n`);
  // A refusal is reported, not fatal: the snapshot keeps its evidence and
  // `verdict.mjs` watermarks on the missing attribution rather than guessing.
  return 0;
}

async function verbAdjudicate(campaignId, { limit, dryRun }) {
  const { config, lock } = loadCampaign(campaignId);
  const ev = await readCohortEvidence({ config, lock });
  if (!ev.ok) { process.stdout.write(`campaign ${config.id}: ${ev.reason}\n`); return 3; }

  const key = store.requireCampaignHmacKey(config.id);
  const keyRef = store.hmacKeyRefFor(config.id);
  const ws = await store.ensureWorksheet({ cohortId: ev.cohortId, hmacKeyRef: keyRef });
  if (!ws.ok) { process.stderr.write(`${ws.error}\n`); return 1; }

  // Build the row set + calibration assignment from the UNBLINDED findings, then
  // persist both before anything is rendered or called.
  const candidates = ev.findings.map((f) => ({
    findingId: f.finding_id, armId: f.arm_id, armRunId: f.arm_run_id, sourceModel: f.source_model,
    auditedSha: f.audited_sha, section: f.primary_file, category: f.category,
    detail: f.detail_snapshot, severity: f.severity,
    worksheetRowId: store.worksheetRowIdFor(f.finding_id, key),
  }));
  const assigned = store.assignCalibrationSample(candidates, { campaignId: config.id, key, rate: config.calibration.sampleRate });
  const persisted = await store.upsertWorksheetRows(ws.id, candidates.map((c) => ({
    worksheetRowId: c.worksheetRowId, findingId: c.findingId, calibrationAssigned: assigned.get(c.worksheetRowId) === true,
  })));
  if (!persisted.ok) { process.stderr.write(`${persisted.error}\n`); return 1; }

  const byRowId = new Map(candidates.map((c) => [c.worksheetRowId, c]));
  const blindRows = await store.loadBlindWorksheet(ws.id, { key, campaignId: config.id });
  if (!blindRows.ok) { process.stderr.write(`${blindRows.error}\n`); return 1; }

  const redact = store.buildModelRedactor({
    armIds: config.arms.map((a) => a.id), armModels: config.arms.map((a) => a.model),
  });
  const adjudicatorModel = resolveModel(config.adjudicator.model);

  // Only rows with no live agent verdict: a re-run must not stack duplicate
  // PAID verdicts, and the partial unique index would supersede the prior one
  // silently if we did not filter here.
  const pending = blindRows.rows.filter((r) => r.agent_event_id == null);
  const todo = Number.isInteger(limit) && limit > 0 ? pending.slice(0, limit) : pending;
  process.stdout.write(`campaign ${config.id}: ${todo.length} row(s) to adjudicate (${pending.length} pending of ${blindRows.rows.length} total)\n`);
  if (todo.length === 0) return 0;

  const client = dryRun ? null : await createAnthropicClient({ backend: 'sdk' });
  let done = 0; let humanQueue = 0; let failed = 0;

  for (const row of todo) {
    // `src` supplies ONLY the store-side facts that are never rendered — the
    // snapshot's revision, the arm-run link, and the source model that
    // `self_family` is computed from. Every field the adjudicator SEES comes
    // from `row`, the blind projection, so the blindness contract is a property
    // of one named query rather than of this loop remembering to be careful.
    const src = byRowId.get(row.worksheet_row_id);
    if (!src) continue;
    const cited = resolveCitedSources({ section: row.primary_file, auditedSha: src.auditedSha });
    const blind = store.buildBlindRow({
      worksheetRowId: row.worksheet_row_id,
      category: row.category,
      primaryFile: row.primary_file,
      detail: row.detail_snapshot,
      severity: row.severity,
      citedSources: cited.sources,
    }, redact);

    // A row whose citations ALL fail to resolve is forced to `unverifiable`
    // BEFORE the call is made — never sent to the model to guess about.
    // Asking an LLM with no tool access to verify code it cannot see does not
    // produce `unverifiable`; it produces confident hallucinated verification,
    // which is worse than no adjudication because it is scored as evidence.
    if (!cited.resolvedAny) {
      await writeVerdict({
        src, ws, adjudicatorModel,
        verdict: { method: 'unverifiable', outcome: 'needs_triage', evidence: { path: null, sha: src.auditedSha, lineRange: null, quotedSpan: null, absenceReason: 'no cited path resolved at this revision' }, confidence: 0 },
      });
      humanQueue += 1;
      continue;
    }
    if (dryRun) { done += 1; continue; }

    const wrRow = await store.resolveWorksheetRowAttempt({ worksheetId: ws.id, worksheetRowId: row.worksheet_row_id });
    const attempt = resolveNextAttempt({
      campaignId: config.id, cohortDigest: adjudicationCohortDir(lock), snapshotId: 'adjudicate',
      armId: row.worksheet_row_id, dbMaxAttempt: wrRow.attempt,
    });
    const receiptArgs = { campaignId: config.id, cohortDigest: adjudicationCohortDir(lock), snapshotId: 'adjudicate', armId: row.worksheet_row_id, attempt };
    const claim = claimReceipt({ ...receiptArgs, body: { kind: 'adjudication', adjudicatorModel } });
    if (!claim.ok) {
      process.stderr.write(`  [campaign] row ${row.worksheet_row_id}: attempt ${attempt} already claimed — another runner holds it; skipping\n`);
      continue;
    }

    const outcome = await callAdjudicator({ client, model: adjudicatorModel, blind });
    completeReceipt({ ...receiptArgs, result: { usage: outcome.usage ?? null, verdict: outcome.verdict ?? null, error: outcome.error ?? null } });

    const cost = costFromUsage(outcome.usage, adjudicatorModel);
    if (!outcome.verdict) {
      failed += 1;
      process.stderr.write(`  [campaign] row ${row.worksheet_row_id}: ${outcome.error} — recording unverifiable, routed to the human queue\n`);
      await writeVerdict({
        src, ws, adjudicatorModel,
        verdict: { method: 'unverifiable', outcome: 'needs_triage', evidence: { path: null, sha: src.auditedSha, lineRange: null, quotedSpan: null, absenceReason: outcome.error }, confidence: 0 },
        cost, attempt, worksheetRowUuid: wrRow.id,
      });
      markReceiptRecorded(receiptArgs);
      humanQueue += 1;
      continue;
    }
    await writeVerdict({ src, ws, adjudicatorModel, verdict: outcome.verdict, cost, attempt, worksheetRowUuid: wrRow.id });
    markReceiptRecorded(receiptArgs);
    if (routesToHumanQueue(outcome.verdict)) humanQueue += 1;
    done += 1;
  }

  process.stdout.write(`  ${done} adjudicated · ${humanQueue} routed to the human queue · ${failed} provider failure(s)\n`);
  if (humanQueue > 0) {
    process.stdout.write('  Rows in the human queue are NOT counted as evidence until dispositioned:\n'
      + '    node scripts/campaign.mjs override --finding FINDING_UUID --verdict accepted --note "why"\n');
  }
  return 0;
}

/** Receipts live under the cohort the evidence belongs to. */
function adjudicationCohortDir(lock) {
  return lock?.lockDigest ?? 'no-lock';
}

async function writeVerdict({ src, ws, adjudicatorModel, verdict, cost = null, attempt = 1, worksheetRowUuid = null }) {
  const selfFamily = store.isSelfFamily(adjudicatorModel, src.sourceModel);
  const res = await store.recordAgentVerdict({
    findingId: src.findingId, worksheetRowId: src.worksheetRowId, worksheetId: ws.id,
    armRunId: src.armRunId, adjudicatorModel, method: verdict.method, outcome: verdict.outcome,
    evidence: verdict.evidence ?? null, selfFamily,
  });
  if (!res.ok) process.stderr.write(`  [campaign] verdict write failed for ${src.findingId}: ${res.error}\n`);
  // Spend is recorded only when a provider call actually happened, and only
  // when we have the row to hang it on. A missing row is REPORTED rather than
  // silently dropped: an unrecorded charge reads as free, which is lesson (e).
  if (cost) {
    if (!worksheetRowUuid) {
      process.stderr.write(`  [campaign] WARNING: adjudication spend for ${src.findingId} could not be recorded (no worksheet row uuid) — the campaign's overhead line will under-report\n`);
    } else {
      await store.recordAdjudicationAttempt({
        worksheetRowUuid, attempt, status: verdict.method,
        usage: { input_tokens: cost.inputTokens, output_tokens: cost.outputTokens },
        costUsd: cost.totalUsd, costStatus: cost.totalUsd == null ? 'unpriced' : 'priced',
      });
    }
  }
  return res;
}

/**
 * One finding per call — isolation, deliberately. A batch lets one row's
 * reasoning contaminate the next, and the whole value of these verdicts is that
 * each is an independent verification against code.
 *
 * Retry once on failure, then hand off. `unverifiable` is the honest terminal
 * state of a call that would not produce a parseable verdict.
 */
async function callAdjudicator({ client, model, blind, attempts = 2 }) {
  let lastError = 'no attempt made';
  let usage = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 4000,
        system: ADJUDICATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(blind, null, 2) }],
        tools: [ADJUDICATION_TOOL],
        // Forced structured output. `{backend:'sdk'}` is pinned at construction
        // because the cli backend silently DROPS tools/tool_choice — a caller
        // forcing tool_choice there gets a plain text block back with no error.
        tool_choice: { type: 'tool', name: ADJUDICATION_TOOL.name },
      });
      usage = resp?.usage ?? null;
      const call = resp?.content?.find((b) => b.type === 'tool_use' && b.name === ADJUDICATION_TOOL.name);
      if (!call) { lastError = `no ${ADJUDICATION_TOOL.name} tool call (stop_reason ${resp?.stop_reason ?? 'unknown'})`; continue; }
      const norm = normaliseVerdict(call.input, { worksheetRowId: blind.worksheetRowId });
      if (!norm.ok) { lastError = norm.reason; continue; }
      if (norm.downgraded) process.stderr.write(`  [campaign] ${norm.downgraded}\n`);
      return { verdict: norm.verdict, usage, error: null };
    } catch (err) {
      lastError = err?.message ?? String(err);
    }
  }
  return { verdict: null, usage, error: lastError };
}

async function verbOverride({ findingId, outcome, note, actor }) {
  const res = await store.recordHumanOverride({ findingId, outcome, note, actor });
  if (res.cloud === false) { cloudOffNotice('override'); return 0; }
  if (!res.ok) { process.stderr.write(`${res.error}\n`); return 1; }
  process.stdout.write(`override recorded: finding ${findingId} → ${outcome} (overrides agent event ${res.overrides})\n`);
  return 0;
}

/**
 * Classify one bake-off log entry for promotion into the campaign spine.
 *
 * PURE, and every refusal is named rather than silently skipped — a snapshot
 * that quietly fails to promote is indistinguishable from one that was never
 * collected, and the denominator would shrink without anyone seeing it.
 *
 * Three refusals, each from a stated invariant:
 *
 *  - **No `lockDigest`** (collected before the lock existed): ineligible, and
 *    never adopted into the current cohort. Relabelling evidence collected
 *    under an unknown contract is exactly what produced five false "window met"
 *    reads; the rows stay readable in the log, they just cannot count.
 *  - **A different campaign** (or none): not ours.
 *  - **Arms disagreeing about the commit**: not one snapshot (§2.5b-i). One
 *    snapshot is one transcript at one revision, because that revision is what
 *    adjudication verifies against.
 *
 * @param {object} entry
 * @param {{campaignId: string, lockDigest: string, shaByRunId: Record<string,string|null>}} ctx
 */
export function classifyLogEntry(entry, { campaignId, lockDigest, shaByRunId }) {
  if (entry?.campaignId !== campaignId) {
    return { eligible: false, reason: entry?.campaignId ? `belongs to campaign "${entry.campaignId}"` : 'collected before this campaign was declared (no campaignId)' };
  }
  if (!entry.lockDigest) {
    return { eligible: false, reason: 'no lockDigest — collected under an unknown contract; it cannot be adopted into a cohort without relabelling it' };
  }
  if (entry.lockDigest !== lockDigest) {
    return { eligible: false, reason: `superseded lock ${entry.lockDigest} (current ${lockDigest}) — its own cohort, not this one` };
  }
  const armEntries = Object.entries(entry.arms ?? {});
  const shas = new Set();
  for (const [, arm] of armEntries) {
    const sha = arm?.runId ? shaByRunId[arm.runId] : null;
    if (sha) shas.add(sha);
  }
  if (shas.size === 0) {
    return { eligible: false, reason: 'no arm resolved an audited_sha — an unverifiable revision makes the snapshot unadjudicatable (§2.5b-i)' };
  }
  if (shas.size > 1) {
    return { eligible: false, reason: `arms recorded ${shas.size} different commits (${[...shas].join(', ')}) — one snapshot is one revision` };
  }
  return {
    eligible: true,
    auditedSha: [...shas][0],
    armRuns: armEntries.map(([armId, arm]) => ({
      armId,
      auditRunId: arm?.runId ?? null,
      error: arm?.error ?? null,
      // `costUsd` absent is UNPRICED, never 0 — an unrecorded charge that reads
      // as free is lesson (e), and the CHECK constraint enforces the pairing.
      costUsd: Number.isFinite(arm?.costUsd) ? arm.costUsd : null,
      costStatus: Number.isFinite(arm?.costUsd) ? 'priced' : 'unpriced',
    })),
  };
}

/**
 * Promote collected snapshots from the local bake-off log into the store.
 *
 * **This is the producer for `campaign_arm_runs`, and it lives here rather than
 * in the collector on purpose.** The collector writes the log and must never be
 * hostage to the store — refusing to collect because the database is down would
 * lose paid provider results. So the log is the durable file and promotion is a
 * separate, idempotent, re-runnable step: the same file-before-database
 * ordering the receipt protocol already prescribes, one level up.
 */
async function promoteFromLog({ config, lock, configDigest }) {
  const entries = readLog();
  const runIds = entries.flatMap((e) => Object.values(e.arms ?? {}).map((a) => a?.runId).filter(Boolean));
  const shas = await store.auditedShasForRuns(runIds);
  if (shas.cloud === false) { cloudOffNotice('reconcile'); return { cloud: false }; }
  if (!lock?.lockDigest) {
    process.stdout.write('  promotion skipped: this campaign resolved no lock digest, so there is no cohort to promote into.\n');
    return { cloud: true, promoted: 0 };
  }

  const rid = await repoId();
  const campaign = await store.ensureCampaign({ repoId: rid, campaignKey: config.id, configDigest });
  if (!campaign.ok) { process.stderr.write(`  ${campaign.error}\n`); return { cloud: true, promoted: 0 }; }
  const cohort = await store.ensureCohort({ campaignId: campaign.id, lockDigest: lock.lockDigest, resolved: lock });
  if (!cohort.ok) { process.stderr.write(`  ${cohort.error}\n`); return { cloud: true, promoted: 0 }; }

  let promoted = 0;
  const refused = [];
  for (const entry of entries) {
    const cls = classifyLogEntry(entry, { campaignId: config.id, lockDigest: lock.lockDigest, shaByRunId: shas.byRunId });
    if (!cls.eligible) { refused.push({ snapshotId: entry.snapshotId, reason: cls.reason }); continue; }
    const snap = await store.upsertSnapshot({
      cohortId: cohort.id, snapshotId: entry.snapshotId, auditedSha: cls.auditedSha, transcriptPath: entry.transcript ?? null,
    });
    if (!snap.ok) { refused.push({ snapshotId: entry.snapshotId, reason: snap.error }); continue; }
    for (const arm of cls.armRuns) {
      const existing = await store.maxArmRunAttempt({ cohortId: cohort.id, snapshotId: entry.snapshotId, armId: arm.armId });
      // Already recorded: promotion is idempotent and must never append a
      // second attempt, which would double-count the arm's spend.
      if (existing.attempt > 0) continue;
      const res = await store.recordArmRun({
        cohortId: cohort.id, snapshotRowId: snap.id, snapshotId: entry.snapshotId, armId: arm.armId, attempt: 1,
        auditRunId: arm.auditRunId, costUsd: arm.costUsd, costStatus: arm.costStatus, error: arm.error,
      });
      if (res.ok) promoted += 1;
      else refused.push({ snapshotId: entry.snapshotId, reason: `${arm.armId}: ${res.error}` });
    }
  }
  process.stdout.write(`  promoted ${promoted} arm-run(s) into cohort ${lock.lockDigest}\n`);
  // Every refusal is NAMED. A snapshot that quietly fails to promote is
  // indistinguishable from one never collected, and the denominator would
  // shrink with nobody seeing it.
  for (const r of refused) process.stdout.write(`  not promoted ${r.snapshotId}: ${r.reason}\n`);
  return { cloud: true, promoted, refused };
}

/**
 * Receipt recovery (§5) + log promotion. `complete` = paid and unrecorded → the
 * row can be inserted. `intent` = the true crash window, where paid-or-not is
 * genuinely UNKNOWN — reported for an operator decision and NEVER auto-retried,
 * because silently re-calling is exactly the double-charge this protocol exists
 * to prevent. That is the honest boundary, not a gap in the design.
 */
async function verbReconcile(campaignId) {
  const { config, lock, configDigest } = loadCampaign(campaignId);
  await promoteFromLog({ config, lock, configDigest });
  const receipts = scanReceipts(config.id);
  const byState = { intent: [], complete: [], recorded: [], unreadable: [] };
  for (const r of receipts) (byState[r.state] ?? (byState[r.state] = [])).push(r);

  process.stdout.write(`campaign ${config.id}: ${receipts.length} receipt(s)\n`
    + `  recorded:   ${byState.recorded.length}\n`
    + `  complete:   ${byState.complete.length} (paid, unrecorded — recoverable)\n`
    + `  intent:     ${byState.intent.length} (crash window — paid-or-not UNKNOWN)\n`
    + `  unreadable: ${byState.unreadable.length}\n`);

  for (const r of byState.complete) {
    process.stdout.write(`  COMPLETE ${r.snapshotId}--${r.armId}--${r.attempt}: ${r.path}\n`);
  }
  for (const r of byState.intent) {
    process.stdout.write(`  INTENT   ${r.snapshotId}--${r.armId}--${r.attempt}: ${r.path}\n`
      + '           NOT auto-retried. Decide whether the provider was charged, then delete the receipt to allow a new attempt.\n');
  }
  for (const r of byState.unreadable) process.stdout.write(`  TORN     ${r.path}\n`);
  // Exit 4 when operator action is outstanding — a reconcile that always exits 0
  // is a reconcile nobody reads.
  return (byState.intent.length + byState.unreadable.length) > 0 ? 4 : 0;
}

async function verbDeclareInconclusive(campaignId, { reason, actor }) {
  const { config, lock } = loadCampaign(campaignId);
  const rid = await repoId();
  const resolved = await store.resolveCohort({ repoId: rid, campaignKey: config.id, lockDigest: lock?.lockDigest ?? null });
  if (resolved.cloud === false) { cloudOffNotice('declare-inconclusive'); return 0; }
  if (!resolved.campaignId) { process.stderr.write(`campaign ${config.id} has no store row yet — nothing to declare against.\n`); return 3; }
  const res = await store.appendCampaignEvent({
    campaignId: resolved.campaignId, kind: 'declared-inconclusive', actor: actor ?? null, detail: { reason },
  });
  if (!res.ok) { process.stderr.write(`${res.error}\n`); return 1; }
  process.stdout.write(`campaign ${config.id}: declared INCONCLUSIVE — ${reason}\n`
    + '  This is terminal and append-only; the evidence stays readable and stops counting.\n');
  return 0;
}

// ── main ────────────────────────────────────────────────────────────────────

// Real values, never angle brackets — PowerShell reserves `<` and an
// unpasteable example is an example nobody runs (AGENTS.md operator-doc
// convention). Substitute your own campaign id and finding uuid.
const USAGE = [
  'Usage (substitute your own campaign id / finding uuid — these examples paste as-is):',
  '  node scripts/campaign.mjs status               --campaign final-review-2026q3 --json',
  '  node scripts/campaign.mjs cluster              --campaign final-review-2026q3 --recluster',
  '  node scripts/campaign.mjs adjudicate           --campaign final-review-2026q3 --limit 10 --dry-run',
  '  node scripts/campaign.mjs override             --finding FINDING_UUID --verdict dismissed --note "why" --actor louis',
  '  node scripts/campaign.mjs verdict              --campaign final-review-2026q3 --json',
  '  node scripts/campaign.mjs reconcile            --campaign final-review-2026q3',
  '  node scripts/campaign.mjs declare-inconclusive --campaign final-review-2026q3 --reason "eligible pool exhausted"',
  '',
  '--verdict is one of: accepted, dismissed, severity_adjusted.',
  'Exit codes: 0 ok · 1 error · 2 bad arguments · 3 not computable · 4 operator action outstanding',
].join('\n');

async function main() {
  const verb = process.argv[2];
  if (!verb || process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!VERBS.includes(verb)) throw new ArgvError(`unknown verb "${verb}" — expected one of: ${VERBS.join(', ')}`);
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'campaign', from: 3 });

  const asJson = process.argv.includes('--json');
  switch (verb) {
    case 'status':      return verbStatus(arg('campaign'), { asJson });
    case 'verdict':     return verbVerdict(arg('campaign'), { asJson });
    case 'cluster':     return verbCluster(arg('campaign'), { recluster: process.argv.includes('--recluster') });
    case 'adjudicate':  return verbAdjudicate(arg('campaign'), {
      limit: arg('limit') == null ? null : Number(arg('limit')),
      dryRun: process.argv.includes('--dry-run'),
    });
    case 'override':    return verbOverride({
      findingId: requireArg('finding'),
      outcome: assertOutcome(requireArg('verdict')),
      note: arg('note'), actor: arg('actor'),
    });
    case 'reconcile':   return verbReconcile(arg('campaign'));
    case 'declare-inconclusive': return verbDeclareInconclusive(arg('campaign'), { reason: requireArg('reason'), actor: arg('actor') });
    default:            throw new ArgvError(`unhandled verb "${verb}"`);
  }
}

/** `adjudication_outcome` is CHECK'd; refusing here names the legal set instead
 *  of surfacing a constraint name from Postgres. A human override may NOT write
 *  `needs_triage` — the point of a human disposition is that it DECIDES, and a
 *  human routing a row back to the human queue is a no-op wearing a verdict's
 *  clothes. */
function assertOutcome(value) {
  const legal = ['accepted', 'dismissed', 'severity_adjusted'];
  if (!legal.includes(value)) throw new ArgvError(`--verdict must be one of: ${legal.join(', ')} (got "${value}")`);
  return value;
}

const invokedDirectly = (() => {
  try { return (process.argv[1] || '').replace(/\\/g, '/').toLowerCase().endsWith('/campaign.mjs'); }
  catch { return false; }
})();

if (invokedDirectly) {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  main().then((code) => { process.exitCode = code ?? 0; }).catch((err) => {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') { process.stderr.write(`${err.message}\n`); process.exit(2); }
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}

export const _internals = Object.freeze({ callAdjudicator, adjudicationCohortDir, assertOutcome });
