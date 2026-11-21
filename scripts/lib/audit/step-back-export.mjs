/**
 * @fileoverview Store-backed replay data (docs/plans/verification-lessons.md §2.4).
 * The audit only ever writes a per-round ledger snapshot for round 1, so the
 * checkpoint state is RECONSTRUCTED from the store's append-only history:
 * `audit_runs` (one row per round), `audit_findings` and
 * `finding_adjudication_events`.
 *
 * `exportRows` is READ-ONLY (SELECTs only, parameterised) and writes one JSON
 * file; everything after it works from that file and never touches the store.
 *
 * **Round = ordinal** within the PR's PINNED run list (the store's `audit_round` / `audit_session_id` are NULL). The spec
 * pins the exact ordered `audit_runs.id` list; `proposeRuns` only proposes one.
 *
 * **No look-ahead.** Checkpoint N sees: findings of runs with ordinal <= N; for
 * each, the LATEST effective event with `round <= N` AND `created_at` < the
 * cutoff, where the cutoff is the `created_at` of run N+1 (when there is none, NO time
 * cutoff applies: the round <= N filter alone, so round N's own rulings are kept). An event is not effective at the cutoff when
 * it was superseded (`superseded_at` < cutoff) or overridden by an event created
 * before the cutoff (`overrides_event_id`). Run N's `audited_sha` must be
 * non-null or the checkpoint is `unrecoverable`.
 *
 * Ground truth (the rounds with a finding whose FINAL effective event is
 * `accepted` at HIGH) is computed here for the SEPARATE scoring file only.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-export
 */
import { DATASET_VERSION, CHECKPOINTS } from './step-back-dataset.mjs';

export const EXPORT_VERSION = 1;

/** The only SQL this module issues. Every statement is a SELECT (asserted by a test). */
export const EXPORT_SQL = Object.freeze({
  runs: 'SELECT id, repo_id, branch, audited_sha, diff_ref, created_at, mode, plan_file FROM audit_runs WHERE branch = ANY($1::text[]) AND created_at >= $2::timestamptz AND repo_id = $3::uuid ORDER BY created_at ASC',
  findings: 'SELECT id, run_id, finding_fingerprint, severity, category, primary_file, detail_snapshot, round_raised, created_at FROM audit_findings WHERE run_id = ANY($1::uuid[]) ORDER BY created_at ASC, id ASC',
  events: 'SELECT id, finding_id, adjudication_outcome, remediation_state, ruling, round, created_at, superseded_at, overrides_event_id FROM finding_adjudication_events WHERE finding_id = ANY($1::uuid[]) ORDER BY created_at ASC, id ASC',
});

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
const normRows = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, iso(v)])));

/**
 * @param {{branches: string[], since: string, repoId: string, query: (sql: string, params: any[]) => Promise<{rows: object[]}|object[]>}} a
 * @returns {Promise<object>} the export document
 */
export async function exportRows({ branches, since, repoId, query }) {
  if (!repoId) throw new Error('exportRows: a repo id is required (runs are filtered by repo_id as well as branch)');
  const rowsOf = async (sql, params) => { const r = await query(sql, params); return normRows(Array.isArray(r) ? r : r.rows); };
  const runs = await rowsOf(EXPORT_SQL.runs, [branches, since, repoId]);
  const runIds = runs.map((r) => r.id);
  const findings = runIds.length ? await rowsOf(EXPORT_SQL.findings, [runIds]) : [];
  const events = findings.length ? await rowsOf(EXPORT_SQL.events, [findings.map((f) => f.id)]) : [];
  return { version: EXPORT_VERSION, exportedAt: new Date().toISOString(), since, branches, repoId, runs, findings, events };
}

const ts = (s) => Date.parse(s);
const HOUR_MS = 3_600_000;

/** The pinned runs of a PR, in the listed order. `missing` names listed ids the export does not hold. */
export function pinnedRuns(exp, runIds) {
  const byId = new Map(exp.runs.map((r) => [r.id, r]));
  const missing = runIds.filter((id) => !byId.has(id));
  return { runs: runIds.map((id) => byId.get(id)).filter(Boolean), missing };
}

/**
 * PROPOSE the run list for a branch: runs with mode=code, oldest first, split into contiguous groups where no gap
 * exceeds `gapMs` (default 3h). It never pins anything: the operator copies the chosen group's ids into the spec.
 * @returns {Array<{runIds: string[], from: string, to: string, count: number, shas: number}>}
 */
export function proposeRuns(exp, branch, { gapMs = 3 * HOUR_MS } = {}) {
  const runs = exp.runs.filter((r) => r.branch === branch && (r.mode ?? 'code') === 'code')
    .sort((a, b) => ts(a.created_at) - ts(b.created_at) || String(a.id).localeCompare(String(b.id)));
  const groups = [];
  for (const r of runs) {
    const g = groups[groups.length - 1];
    if (g && ts(r.created_at) - ts(g.runs[g.runs.length - 1].created_at) <= gapMs) g.runs.push(r); else groups.push({ runs: [r] });
  }
  return groups.map((g) => ({ runIds: g.runs.map((r) => r.id), from: g.runs[0].created_at, to: g.runs[g.runs.length - 1].created_at, count: g.runs.length, shas: g.runs.filter((r) => r.audited_sha).length }));
}

/**
 * The event that is effective for a finding as of (`maxRound`, `cutoffMs`); null when none. With NO time cutoff
 * (`cutoffMs` infinite) only the round filter applies and `superseded_at` is NOT honoured: it would be set by a later
 * event this checkpoint must not see. Pass `honourSuperseded: true` for the FINAL state (ground truth).
 */
export function effectiveEvent(events, { maxRound = Infinity, cutoffMs = Infinity, honourSuperseded = Number.isFinite(cutoffMs) } = {}) {
  const live = events.filter((e) => e.round <= maxRound && ts(e.created_at) < cutoffMs);
  const overridden = new Set(live.map((e) => e.overrides_event_id).filter(Boolean));
  const eff = live.filter((e) => !overridden.has(e.id) && !(honourSuperseded && e.superseded_at && ts(e.superseded_at) < cutoffMs));
  eff.sort((a, b) => ts(a.created_at) - ts(b.created_at) || a.round - b.round || String(a.id).localeCompare(String(b.id)));
  return eff.length ? eff[eff.length - 1] : null;
}

const findingView = (f) => ({
  id: f.id, severity: f.severity, category: f.category, section: f.primary_file, detail: f.detail_snapshot,
  _primaryFile: f.primary_file, affectedFiles: f.primary_file ? [f.primary_file] : [], _hash: f.finding_fingerprint, topicId: f.finding_fingerprint,
});

/**
 * Checkpoint snapshot from the export and the PR's pinned run ids; same shape as `buildCheckpointSnapshot`'s `snapshot`.
 * Rounds 1..N must ALL be present. The cutoff is run N+1's created_at; with no run N+1 there is NO time cutoff, only the
 * round <= N filter, so round N's own rulings are kept. A finding belongs to its run (ordinal <= N).
 * @returns {{ok: true, snapshot: object}|{ok: false, status: 'unrecoverable', reason: string}}
 */
export function buildExportSnapshot({ exp, runIds, checkpoint }) {
  const { runs, missing } = pinnedRuns(exp, runIds);
  if (missing.length) return { ok: false, status: 'unrecoverable', reason: `${missing.length} pinned run(s) missing from the export` };
  if (runs.length < checkpoint) return { ok: false, status: 'unrecoverable', reason: `pinned list has ${runs.length} run(s), checkpoint ${checkpoint} needs ${checkpoint}` };
  const run = runs[checkpoint - 1];
  if (!run.audited_sha) return { ok: false, status: 'unrecoverable', reason: `run ${checkpoint} has no audited_sha` };
  const next = runs[checkpoint];
  const cutoffMs = next ? ts(next.created_at) : Infinity;
  const ordinalOfRun = new Map(runs.map((r, i2) => [r.id, i2 + 1]));
  const rounds = runs.slice(0, checkpoint).map((r, i2) => ({
    round: i2 + 1, auditedSha: r.audited_sha, verdict: null,
    findings: exp.findings.filter((f) => f.run_id === r.id).map(findingView),
  }));
  const ledgerEntries = [];
  for (const f of exp.findings) {
    const ord = ordinalOfRun.get(f.run_id);
    if (!ord || ord > checkpoint) continue;
    const ev = effectiveEvent(exp.events.filter((e) => e.finding_id === f.id), { maxRound: checkpoint, cutoffMs });
    if (!ev) continue;
    ledgerEntries.push({
      topicId: f.finding_fingerprint, findingId: f.id, severity: f.severity, category: f.category, affectedFiles: f.primary_file ? [f.primary_file] : [],
      adjudicationOutcome: ev.adjudication_outcome, remediationState: ev.remediation_state, ruling: ev.ruling, firstSeenRound: ord, round: ev.round,
    });
  }
  return { ok: true, snapshot: { sid: run.branch, checkpoint, auditedSha: run.audited_sha, rounds, ledgerEntries, provenance: 'store-events', planFile: run.plan_file ?? null, paths: [] } };
}

/**
 * Freeze a dataset (and the separate scoring doc) from an export and a spec of `{pr, label, branch, runIds}`. The spec
 * PINS the exact ordered `audit_runs.id` list: a PR with no list, or whose listed runs are not all present, is refused
 * (unrecoverable), never guessed from the branch. PRs with fewer than 3 runs are CONTROLS: no checkpoint, no call.
 */
export function freezeFromExport({ exp, spec, exportPath }) {
  const prs = []; const truth = {};
  for (const p of spec.prs) {
    const base = { pr: p.pr, label: p.label, branch: p.branch, runIds: p.runIds ?? null };
    if (!Array.isArray(p.runIds) || p.runIds.length === 0) { prs.push({ ...base, rounds: 0, planFile: null, status: 'unrecoverable', reason: 'the spec pins no runIds for this PR (use the propose command)', checkpoints: [] }); continue; }
    const { runs, missing } = pinnedRuns(exp, p.runIds);
    if (missing.length) { prs.push({ ...base, rounds: p.runIds.length, planFile: null, status: 'unrecoverable', reason: `${missing.length} of ${p.runIds.length} pinned runs are not in the export`, checkpoints: [] }); continue; }
    const pinned = { ...base, rounds: runs.length, planFile: runs[0]?.plan_file ?? null };
    const cps = CHECKPOINTS.filter((c) => c <= runs.length).map((c) => {
      const s = buildExportSnapshot({ exp, runIds: p.runIds, checkpoint: c });
      return s.ok ? { checkpoint: c, status: 'recoverable', auditedSha: s.snapshot.auditedSha } : { checkpoint: c, status: 'unrecoverable', reason: s.reason };
    });
    prs.push({ ...pinned, status: 'recoverable', control: cps.length === 0, checkpoints: cps });
    const ordinal = new Map(runs.map((r, i2) => [r.id, i2 + 1]));
    const rounds = new Set();
    for (const f of exp.findings) {
      if (!ordinal.has(f.run_id) || String(f.severity).toUpperCase() !== 'HIGH') continue;
      const ev = effectiveEvent(exp.events.filter((e) => e.finding_id === f.id), { honourSuperseded: true });
      if (ev?.adjudication_outcome === 'accepted') rounds.add(ordinal.get(f.run_id));
    }
    truth[p.pr] = { label: p.label, acceptedHighRounds: [...rounds].sort((a, b) => a - b), lastRound: runs.length };
  }
  return { dataset: { version: DATASET_VERSION, source: 'store-export', exportPath, prs }, scoring: { version: DATASET_VERSION, truth } };
}
