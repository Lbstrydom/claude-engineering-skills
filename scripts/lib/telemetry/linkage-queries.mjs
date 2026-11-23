/**
 * @fileoverview "Which calls, passes and findings belong to session X round N?" - as a READ-ONLY report that also
 * says what it could NOT link. An unasked question must never render as an empty result: a session that matches
 * nothing still returns the store-wide count of rows that have no session, so the caller sees the gap.
 *
 * Round semantics (the honest part): a per-round run carries `audit_round`; a UNIFIED run (explicit `--run-id`) has
 * `audit_round` NULL and spans every round, so its passes (`round`) and findings (`round_raised`) are placed by
 * their OWN round column, while its LLM calls (`llm_call_provenance` has no round) are reported as run-level:
 * linked to the session, round unresolved. They are counted, never dropped and never guessed into a round. A child
 * row with no round of its own is `unresolved`: the parent run's round is NOT substituted, because the inventory says
 * the writer must carry its own.
 *
 * A session id is caller-supplied and NOT globally unique, so the report is repo-scoped when a repo is given, and
 * reports `ambiguousRepos` (never complete) when an unscoped session spans more than one repo.
 *
 * Statements are plain SELECTs with `$n` parameters. {@link queryLinkage} runs them through a `snapshot` wrapper so a
 * caller can put all six reads under ONE REPEATABLE READ, READ ONLY transaction (the CLI does).
 *
 * Domain: shared-lib.
 *
 * @module scripts/lib/telemetry/linkage-queries
 */
import { classifyStoredRun } from './linkage.mjs';

// `$1` session id, `$2` repo id or NULL (unscoped).
const SCOPE = 'r.audit_session_id = $1 AND ($2::uuid IS NULL OR r.repo_id = $2::uuid)';

/** Runs of the session. */
export const SESSION_RUNS_SQL = `
SELECT r.id, r.repo_id, r.audit_round, r.mode, r.capture_epoch, r.created_at, r.audit_session_id,
       __STATE__ AS linkage_state, __REASON__ AS linkage_reason
  FROM audit_runs r
 WHERE ${SCOPE}
 ORDER BY r.created_at, r.id`;

const rows = (sql, hasState) => sql.replace('__STATE__', hasState ? 'r.linkage_state' : 'NULL::text').replace('__REASON__', hasState ? 'r.linkage_reason' : 'NULL::text');

/** Passes of the session's runs. Round comes from the pass row itself. */
export const SESSION_PASSES_SQL = `
SELECT p.run_id, p.pass_name, p.round
  FROM audit_pass_stats p JOIN audit_runs r ON r.id = p.run_id
 WHERE ${SCOPE}`;

/** Findings of the session's runs. */
export const SESSION_FINDINGS_SQL = `
SELECT f.run_id, f.round_raised AS round, count(*)::int AS n
  FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
 WHERE ${SCOPE}
 GROUP BY f.run_id, f.round_raised`;

/** LLM calls of the session's runs. */
export const SESSION_CALLS_SQL = `
SELECT c.audit_run_id AS run_id, count(*)::int AS n
  FROM llm_call_provenance c JOIN audit_runs r ON r.id = c.audit_run_id
 WHERE ${SCOPE}
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
 * PURE. Fold the raw rows into the report. Anything that cannot be placed is listed under `unresolved` /
 * `unresolvedRound`, never omitted. `complete` is true only when the session is known, unambiguous, the REQUESTED
 * ROUND exists in it, and nothing is unplaced.
 * @param {object} p
 * @returns {object}
 */
export function buildLinkageReport({ session, round = null, repoId = null, runs, passes, findings, calls, unlinked, orphanCalls }) {
  const roundOf = new Map(runs.map((r) => [r.id, r.audit_round]));
  const repos = [...new Set(runs.map((r) => r.repo_id).filter(Boolean))];
  const place = (own) => (own == null ? { eff: null } : { eff: own, match: round == null || own === round });
  const out = {
    session, round, repoId, sessionKnown: runs.length > 0,
    ambiguousRepos: repoId == null && repos.length > 1 ? repos : null,
    runs: runs.map((r) => ({ id: r.id, round: r.audit_round, state: classifyStoredRun(r), reason: r.linkage_reason ?? null, matchesRound: round == null ? null : r.audit_round === round || r.audit_round == null })),
    passes: { matched: 0, otherRounds: 0, unresolved: 0 },
    findings: { matched: 0, otherRounds: 0, unresolved: 0 },
    calls: { matched: 0, otherRounds: 0, unresolvedRound: 0 },
    unlinkedStoreWide: unlinked,
    orphanCalls: orphanCalls ?? 0,
  };
  let roundSeen = round == null || runs.some((r) => r.audit_round === round);
  for (const p of passes) {
    const { eff, match } = place(p.round);
    if (eff == null) out.passes.unresolved += 1; else if (match) { out.passes.matched += 1; roundSeen ||= eff === round; } else out.passes.otherRounds += 1;
  }
  for (const f of findings) {
    const { eff, match } = place(f.round);
    if (eff == null) out.findings.unresolved += f.n; else if (match) { out.findings.matched += f.n; roundSeen ||= eff === round; } else out.findings.otherRounds += f.n;
  }
  for (const c of calls) {
    // No round column on a call: a per-round run places it, a unified/arm run (round NULL) cannot.
    const eff = roundOf.get(c.run_id) ?? null;
    if (round == null) out.calls.matched += c.n;
    else if (eff == null) out.calls.unresolvedRound += c.n;
    else if (eff === round) out.calls.matched += c.n;
    else out.calls.otherRounds += c.n;
  }
  out.roundKnown = roundSeen;
  out.complete = out.sessionKnown && out.ambiguousRepos == null && roundSeen
    && out.passes.unresolved === 0 && out.findings.unresolved === 0 && out.calls.unresolvedRound === 0;
  return out;
}

/**
 * Run the report. `many` is the pg `many(sql, params)` function; `hasState` says whether `audit_runs.linkage_state`
 * exists; `snapshot(fn)` runs `fn` under one consistent read (default: no wrapper, for callers that already hold a
 * transaction or accept per-statement reads). The reads are SEQUENTIAL so they can share a transaction.
 * @returns {Promise<object>}
 */
export async function queryLinkage(many, { session, round = null, repoId = null, hasState = true, snapshot = (fn) => fn() }) {
  return snapshot(async () => {
    const args = [session, repoId];
    const runs = await many(rows(SESSION_RUNS_SQL, hasState), args);
    const passes = await many(SESSION_PASSES_SQL, args);
    const findings = await many(SESSION_FINDINGS_SQL, args);
    const calls = await many(SESSION_CALLS_SQL, args);
    const unlinked = await many(UNLINKED_RUNS_SQL(hasState), []);
    const orphan = await many(ORPHAN_CALLS_SQL, []);
    return buildLinkageReport({ session, round, repoId, runs, passes, findings, calls, unlinked, orphanCalls: orphan[0]?.n ?? 0 });
  });
}
