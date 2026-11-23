/**
 * @fileoverview "Which calls, passes and findings belong to session X round N?" - as a READ-ONLY report that also
 * says what it could NOT link. An unasked question must never render as an empty result: a session that matches
 * nothing still returns the store-wide count of rows that have no session, so the caller sees the gap.
 *
 * Round semantics (the honest part): a per-round run carries `audit_round`; a UNIFIED run (explicit `--run-id`) has
 * `audit_round` NULL and spans every round, so its passes (`round`) and findings (`round_raised`) are placed by
 * their OWN round column, while its LLM calls (`llm_call_provenance` has no round) are reported as run-level:
 * linked to the session, round unresolved. They are counted, never dropped and never guessed into a round.
 *
 * Statements are plain SELECTs with `$n` parameters, so a `READ ONLY` transaction accepts them.
 *
 * Domain: shared-lib.
 *
 * @module scripts/lib/telemetry/linkage-queries
 */
import { classifyStoredRun } from './linkage.mjs';

/** Runs of the session. `$1` session id. */
export const SESSION_RUNS_SQL = `
SELECT r.id, r.audit_round, r.mode, r.capture_epoch, r.created_at, r.audit_session_id,
       __STATE__ AS linkage_state, __REASON__ AS linkage_reason
  FROM audit_runs r
 WHERE r.audit_session_id = $1
 ORDER BY r.created_at, r.id`;

const rows = (sql, hasState) => sql.replace('__STATE__', hasState ? 'r.linkage_state' : 'NULL::text').replace('__REASON__', hasState ? 'r.linkage_reason' : 'NULL::text');

/** Passes of the session's runs. `$1` session id. Round comes from the pass row itself. */
export const SESSION_PASSES_SQL = `
SELECT p.run_id, p.pass_name, p.round
  FROM audit_pass_stats p JOIN audit_runs r ON r.id = p.run_id
 WHERE r.audit_session_id = $1`;

/** Findings of the session's runs. `$1` session id. */
export const SESSION_FINDINGS_SQL = `
SELECT f.run_id, f.round_raised AS round, count(*)::int AS n
  FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
 WHERE r.audit_session_id = $1
 GROUP BY f.run_id, f.round_raised`;

/** LLM calls of the session's runs. `$1` session id. */
export const SESSION_CALLS_SQL = `
SELECT c.audit_run_id AS run_id, count(*)::int AS n
  FROM llm_call_provenance c JOIN audit_runs r ON r.id = c.audit_run_id
 WHERE r.audit_session_id = $1
 GROUP BY c.audit_run_id`;

/** Store-wide: rows that cannot be linked to any session. No parameters. */
export const UNLINKED_RUNS_SQL = (hasState) => `
WITH u AS (
  SELECT r.id, ${hasState ? "COALESCE(r.linkage_state, 'legacy-unstated')" : "'legacy-unstated'"} AS state,
         ${hasState ? 'r.linkage_reason' : 'NULL::text'} AS reason
    FROM audit_runs r WHERE r.audit_session_id IS NULL
), c AS (SELECT audit_run_id AS id, count(*)::int AS n FROM llm_call_provenance GROUP BY 1),
   p AS (SELECT run_id AS id, count(*)::int AS n FROM audit_pass_stats GROUP BY 1),
   f AS (SELECT run_id AS id, count(*)::int AS n FROM audit_findings GROUP BY 1)
SELECT u.state, u.reason, count(*)::int AS runs,
       COALESCE(sum(c.n), 0)::int AS calls, COALESCE(sum(p.n), 0)::int AS passes, COALESCE(sum(f.n), 0)::int AS findings
  FROM u LEFT JOIN c USING (id) LEFT JOIN p USING (id) LEFT JOIN f USING (id)
 GROUP BY u.state, u.reason
 ORDER BY runs DESC`;

/** LLM calls whose run is absent or NULL: nothing to attribute them to. */
export const ORPHAN_CALLS_SQL = `
SELECT count(*)::int AS n FROM llm_call_provenance c
 WHERE c.audit_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM audit_runs r WHERE r.id = c.audit_run_id)`;

/**
 * PURE. Fold the raw rows into the report. A row is placed in round N when its own round says N, or - for a run whose
 * round is known - the run's round does. Anything that cannot be placed is listed under `unresolved`, never omitted.
 * @param {object} p
 * @returns {object}
 */
export function buildLinkageReport({ session, round = null, runs, passes, findings, calls, unlinked, orphanCalls }) {
  const roundOf = new Map(runs.map((r) => [r.id, r.audit_round]));
  const inRound = (own, runId) => {
    const eff = own ?? roundOf.get(runId) ?? null;
    return { eff, match: round == null ? null : eff === round };
  };
  const out = {
    session, round, sessionKnown: runs.length > 0,
    runs: runs.map((r) => ({ id: r.id, round: r.audit_round, state: classifyStoredRun(r), reason: r.linkage_reason ?? null, matchesRound: round == null ? null : r.audit_round === round || r.audit_round == null })),
    passes: { matched: 0, otherRounds: 0, unresolved: 0 },
    findings: { matched: 0, otherRounds: 0, unresolved: 0 },
    calls: { matched: 0, unresolvedRound: 0 },
    unlinkedStoreWide: unlinked,
    orphanCalls: orphanCalls ?? 0,
  };
  for (const p of passes) {
    const { eff, match } = inRound(p.round, p.run_id);
    if (eff == null) out.passes.unresolved += 1; else if (round == null || match) out.passes.matched += 1; else out.passes.otherRounds += 1;
  }
  for (const f of findings) {
    const { eff, match } = inRound(f.round, f.run_id);
    if (eff == null) out.findings.unresolved += f.n; else if (round == null || match) out.findings.matched += f.n; else out.findings.otherRounds += f.n;
  }
  for (const c of calls) {
    // No round column on a call: a per-round run places it, a unified/arm run (round NULL) cannot.
    const eff = roundOf.get(c.run_id) ?? null;
    if (round == null) out.calls.matched += c.n;
    else if (eff == null) out.calls.unresolvedRound += c.n;
    else if (eff === round) out.calls.matched += c.n;
  }
  out.complete = out.sessionKnown && out.passes.unresolved === 0 && out.findings.unresolved === 0 && out.calls.unresolvedRound === 0;
  return out;
}

/**
 * Run the report. `many` is the pg `many(sql, params)` function; `hasState` says whether `audit_runs.linkage_state` exists.
 * @returns {Promise<object>}
 */
export async function queryLinkage(many, { session, round = null, hasState = true }) {
  const [runs, passes, findings, calls, unlinked, orphan] = await Promise.all([
    many(rows(SESSION_RUNS_SQL, hasState), [session]),
    many(SESSION_PASSES_SQL, [session]),
    many(SESSION_FINDINGS_SQL, [session]),
    many(SESSION_CALLS_SQL, [session]),
    many(UNLINKED_RUNS_SQL(hasState), []),
    many(ORPHAN_CALLS_SQL, []),
  ]);
  return buildLinkageReport({ session, round, runs, passes, findings, calls, unlinked, orphanCalls: orphan[0]?.n ?? 0 });
}
