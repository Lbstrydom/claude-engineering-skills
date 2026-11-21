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
 * **Round = ordinal** of the run by `created_at` within the branch (the store's
 * `audit_round` / `audit_session_id` are NULL).
 *
 * **No look-ahead.** Checkpoint N sees: findings of runs with ordinal <= N; for
 * each, the LATEST effective event with `round <= N` AND `created_at` < the
 * cutoff, where the cutoff is the `created_at` of run N+1 (or run N's own
 * `created_at` when there is none). An event is not effective at the cutoff when
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
  runs: 'SELECT id, branch, audited_sha, diff_ref, created_at, mode, plan_file FROM audit_runs WHERE branch = ANY($1::text[]) AND created_at >= $2::timestamptz ORDER BY created_at ASC',
  findings: 'SELECT id, run_id, finding_fingerprint, severity, category, primary_file, detail_snapshot, round_raised, created_at FROM audit_findings WHERE run_id = ANY($1::uuid[]) ORDER BY created_at ASC, id ASC',
  events: 'SELECT id, finding_id, adjudication_outcome, remediation_state, ruling, round, created_at, superseded_at, overrides_event_id FROM finding_adjudication_events WHERE finding_id = ANY($1::uuid[]) ORDER BY created_at ASC, id ASC',
});

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
const normRows = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, iso(v)])));

/**
 * @param {{branches: string[], since: string, query: (sql: string, params: any[]) => Promise<{rows: object[]}|object[]>}} a
 * @returns {Promise<object>} the export document
 */
export async function exportRows({ branches, since, query }) {
  const rowsOf = async (sql, params) => { const r = await query(sql, params); return normRows(Array.isArray(r) ? r : r.rows); };
  const runs = await rowsOf(EXPORT_SQL.runs, [branches, since]);
  const runIds = runs.map((r) => r.id);
  const findings = runIds.length ? await rowsOf(EXPORT_SQL.findings, [runIds]) : [];
  const events = findings.length ? await rowsOf(EXPORT_SQL.events, [findings.map((f) => f.id)]) : [];
  return { version: EXPORT_VERSION, exportedAt: new Date().toISOString(), since, branches, runs, findings, events };
}

const ts = (s) => Date.parse(s);

/** Runs of a branch, ordinal 1.. by created_at (ties by id). */
export function branchRuns(exp, branch) {
  return exp.runs.filter((r) => r.branch === branch).sort((a, b) => ts(a.created_at) - ts(b.created_at) || String(a.id).localeCompare(String(b.id)));
}

/** The event that is effective for a finding as of (`maxRound`, `cutoffMs`); null when none. Exported for tests. */
export function effectiveEvent(events, { maxRound = Infinity, cutoffMs = Infinity } = {}) {
  const live = events.filter((e) => e.round <= maxRound && ts(e.created_at) < cutoffMs);
  const overridden = new Set(live.map((e) => e.overrides_event_id).filter(Boolean));
  const eff = live.filter((e) => !overridden.has(e.id) && !(e.superseded_at && ts(e.superseded_at) < cutoffMs));
  eff.sort((a, b) => ts(a.created_at) - ts(b.created_at) || a.round - b.round || String(a.id).localeCompare(String(b.id)));
  return eff.length ? eff[eff.length - 1] : null;
}

const findingView = (f) => ({
  id: f.id, severity: f.severity, category: f.category, section: f.primary_file, detail: f.detail_snapshot,
  _primaryFile: f.primary_file, affectedFiles: f.primary_file ? [f.primary_file] : [], _hash: f.finding_fingerprint, topicId: f.finding_fingerprint,
});

/**
 * Checkpoint snapshot from the export; same shape as `buildCheckpointSnapshot`'s `snapshot`.
 * @returns {{ok: true, snapshot: object}|{ok: false, status: 'unrecoverable', reason: string}}
 */
export function buildExportSnapshot({ exp, branch, checkpoint }) {
  const runs = branchRuns(exp, branch);
  if (runs.length < checkpoint) return { ok: false, status: 'unrecoverable', reason: `branch has ${runs.length} run(s), checkpoint ${checkpoint} needs ${checkpoint}` };
  const run = runs[checkpoint - 1];
  if (!run.audited_sha) return { ok: false, status: 'unrecoverable', reason: `run ${checkpoint} has no audited_sha` };
  const next = runs[checkpoint];
  const cutoffMs = ts((next || run).created_at);
  const ordinalOfRun = new Map(runs.map((r, i) => [r.id, i + 1]));
  const rounds = runs.slice(0, checkpoint).map((r, i) => ({
    round: i + 1, auditedSha: r.audited_sha, verdict: null,
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
  return { ok: true, snapshot: { sid: branch, checkpoint, auditedSha: run.audited_sha, rounds, ledgerEntries, provenance: 'store-events', planFile: run.plan_file ?? null, paths: [] } };
}

/**
 * Freeze a dataset (and the separate scoring doc) from an export and a spec of `{pr, label, branch}`.
 * PRs with fewer than 3 runs are CONTROLS: no checkpoint, no call.
 */
export function freezeFromExport({ exp, spec, exportPath }) {
  const prs = []; const truth = {};
  for (const p of spec.prs) {
    const runs = branchRuns(exp, p.branch);
    const base = { pr: p.pr, label: p.label, branch: p.branch, rounds: runs.length, planFile: runs[0]?.plan_file ?? null };
    if (runs.length === 0) { prs.push({ ...base, status: 'unrecoverable', reason: `no runs for branch since ${exp.since}`, checkpoints: [] }); continue; }
    const cps = CHECKPOINTS.filter((c) => c <= runs.length).map((c) => {
      const s = buildExportSnapshot({ exp, branch: p.branch, checkpoint: c });
      return s.ok ? { checkpoint: c, status: 'recoverable', auditedSha: s.snapshot.auditedSha } : { checkpoint: c, status: 'unrecoverable', reason: s.reason };
    });
    prs.push({ ...base, status: 'recoverable', control: cps.length === 0, checkpoints: cps });
    const ordinal = new Map(runs.map((r, i) => [r.id, i + 1]));
    const rounds = new Set();
    for (const f of exp.findings) {
      if (!ordinal.has(f.run_id) || String(f.severity).toUpperCase() !== 'HIGH') continue;
      const ev = effectiveEvent(exp.events.filter((e) => e.finding_id === f.id));
      if (ev?.adjudication_outcome === 'accepted') rounds.add(ordinal.get(f.run_id));
    }
    truth[p.pr] = { label: p.label, acceptedHighRounds: [...rounds].sort((a, b) => a - b), lastRound: runs.length };
  }
  return { dataset: { version: DATASET_VERSION, source: 'store-export', exportPath, prs }, scoring: { version: DATASET_VERSION, truth } };
}
