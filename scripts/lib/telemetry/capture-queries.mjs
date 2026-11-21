/**
 * @fileoverview The capture-v1 query recipes (docs/reference/audit-telemetry-queries.md) as CODE.
 *
 * The recipes used to exist only as markdown that a DB test executed. `docs/` is outside the
 * consumer sync closure, and the recipes used `CREATE TEMP VIEW`, which Postgres refuses inside a
 * `READ ONLY` transaction (the exporter's snapshot contract). So a consumer could not run them.
 * Here each recipe is plain text with `$1` standing for the epoch set (a `text[]`), and the two
 * shared views are CTE bodies that {@link captureStatement} prepends — no CREATE anywhere, so a
 * `READ ONLY` transaction accepts every statement.
 *
 * **The doc and this module are pinned equal** by `tests/audit-capture-db.test.mjs` (both directions,
 * modulo `:epochs` <-> `$1` and `CREATE TEMP VIEW x AS <body>;` <-> the CTE body), and the composed
 * statements are executed there on a real Postgres inside `READ ONLY`. This file is the source; the
 * doc stays readable.
 *
 * The epoch set is a PARAMETER, never hard-coded: it is {@link CAPTURE_EPOCHS}, built from the one
 * constant the capture writer stamps rows with, so bumping the epoch changes the cohort here too.
 *
 * @module scripts/lib/telemetry/capture-queries
 */
import { CAPTURE_EPOCH } from '../capture-epoch.mjs';

/** The eligible cohort, as the `$1` parameter every statement takes. */
export const CAPTURE_EPOCHS = Object.freeze([CAPTURE_EPOCH]);

// ── Shared fragments (each is ALSO a doc block) ──────────────────────────────────────────────

const TERMINAL_STATE_CASE = `CASE
  WHEN f.user_action = 'auto_dismissed' THEN NULL
  WHEN f.adjudication_outcome = 'accepted' OR f.user_action = 'accepted-permanent' THEN 'accepted'
  WHEN f.adjudication_outcome = 'dismissed' THEN 'dismissed'
  WHEN f.adjudication_outcome = 'severity_adjusted' THEN 'severity_adjusted'
  WHEN f.adjudication_outcome IS NULL OR f.adjudication_outcome IN ('pending', 'needs_triage') THEN 'open'
  ELSE 'unknown'
END`;

const C_RUN_AGREEMENT_CASE = `CASE
  WHEN gemini_verdict IS NULL THEN 'unknown'
  WHEN gemini_verdict = 'APPROVE' AND converged THEN 'agree'
  WHEN gemini_verdict = 'APPROVE' AND NOT converged THEN 'disagree'
  WHEN gemini_verdict = 'REJECT' AND NOT converged THEN 'agree'
  WHEN gemini_verdict = 'REJECT' AND converged THEN 'disagree'
  ELSE 'unknown'
END`;

/**
 * Recipe name -> SQL text. The keys are the doc's `<!-- sql:NAME:start -->` block names.
 * `capture-rounds` and `capture-concerns` are CTE BODIES (the doc wraps them in `CREATE TEMP VIEW`);
 * `terminal-state` and `c-run-agreement` are CASE expressions; everything else is a statement.
 */
export const CAPTURE_RECIPES = Object.freeze({
  'capture-rounds': `SELECT DISTINCT ON (r.repo_id, r.audit_session_id, r.audit_round) r.*
  FROM audit_runs r
 WHERE r.capture_epoch = ANY($1) AND r.run_status = 'complete' AND r.mode = 'code'
   AND r.audit_session_id IS NOT NULL AND r.audit_round IS NOT NULL
 ORDER BY r.repo_id, r.audit_session_id, r.audit_round, r.created_at DESC, r.id DESC`,

  'terminal-state': TERMINAL_STATE_CASE,

  'capture-concerns': `SELECT f.id AS finding_id, r.repo_id, r.audit_session_id, r.audit_round,
       COALESCE(
         (SELECT e.canonical_finding_id FROM finding_equivalence e
            WHERE e.duplicate_finding_id = f.finding_fingerprint
              AND EXISTS (SELECT 1 FROM audit_findings g JOIN audit_runs gr ON gr.id = g.run_id
                           WHERE g.finding_fingerprint = e.canonical_finding_id AND gr.repo_id = r.repo_id)),
         f.finding_fingerprint) AS concern_id,
       ${TERMINAL_STATE_CASE.replace(/\n/g, '\n       ')} AS state
  FROM audit_findings f JOIN capture_rounds r ON r.id = f.run_id
 -- control markers are not concerns (see the CASE: they map to NULL)
 WHERE f.user_action IS DISTINCT FROM 'auto_dismissed'`,

  'reraise-rate': `SELECT count(*) FILTER (WHERE rounds_seen >= 2)::numeric / NULLIF(count(*), 0) AS reraise_rate, count(*) AS concerns
  FROM (SELECT repo_id, audit_session_id, concern_id, count(DISTINCT audit_round) AS rounds_seen
          FROM capture_concerns GROUP BY 1, 2, 3) c`,

  'reopen-rate': `WITH final_round AS (SELECT repo_id, audit_session_id, max(audit_round) AS last_round FROM capture_rounds GROUP BY 1, 2),
dismissed AS (
  SELECT c.repo_id, c.audit_session_id, c.concern_id, min(c.audit_round) AS first_dismissed_round
    FROM capture_concerns c JOIN final_round fr USING (repo_id, audit_session_id)
   WHERE c.state = 'dismissed' AND c.audit_round < fr.last_round
   GROUP BY 1, 2, 3)
SELECT count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM capture_concerns later
          WHERE later.repo_id = d.repo_id AND later.audit_session_id = d.audit_session_id
            AND later.concern_id = d.concern_id AND later.audit_round > d.first_dismissed_round))::numeric
       / NULLIF(count(*), 0) AS reopen_rate, count(*) AS dismissed_concerns
  FROM dismissed d`,

  'dispute-rate': `SELECT count(*) FILTER (WHERE outcomes > 1)::numeric / NULLIF(count(*), 0) AS dispute_rate, count(*) AS rows_with_two_kinds
  FROM (SELECT ev.finding_id, count(DISTINCT ev.adjudicator_kind) AS kinds, count(DISTINCT ev.adjudication_outcome) AS outcomes
          FROM finding_adjudication_events ev
          JOIN audit_findings f ON f.id = ev.finding_id JOIN capture_rounds r ON r.id = f.run_id
         WHERE ev.event_origin IS DISTINCT FROM 'campaign'
         GROUP BY ev.finding_id HAVING count(DISTINCT ev.adjudicator_kind) >= 2) d`,

  'equivalence-receipt': `SELECT count(*) AS runs_with_receipt,
       sum((r.write_outcomes -> 'equivalence' ->> 'expected')::int) AS expected,
       sum((r.write_outcomes -> 'equivalence' ->> 'written')::int) AS written,
       sum((r.write_outcomes -> 'equivalence' ->> 'spilled')::int) AS spilled,
       sum((r.write_outcomes -> 'equivalence' ->> 'lost')::int) AS lost,
       sum((SELECT COALESCE(sum(v.value::int), 0) FROM jsonb_each_text(r.write_outcomes -> 'equivalence') v
             WHERE v.key LIKE 'skipped:%')) AS skipped
  FROM capture_rounds r
 WHERE r.write_outcomes -> 'equivalence' IS NOT NULL`,

  // repo_id is deliberately NOT in this output: the report prints a model's counts, never a repo's.
  'quality-prospective': `SELECT f.source_model, f.pass_name,
       count(*) AS n,
       count(*) FILTER (WHERE c.state = 'accepted') AS accepted,
       count(*) FILTER (WHERE c.state = 'dismissed') AS dismissed,
       count(*) FILTER (WHERE c.state = 'severity_adjusted') AS severity_adjusted,
       count(*) FILTER (WHERE c.state IN ('open', 'unknown')) AS unresolved
  FROM capture_concerns c
  JOIN audit_findings f ON f.id = c.finding_id
  JOIN audit_runs r ON r.id = f.run_id
 WHERE r.write_outcomes -> 'outcome_sync' ->> 'written' = r.write_outcomes -> 'outcome_sync' ->> 'expected'
 GROUP BY 1, 2`,

  'quality-historical': `WITH one_model AS (
  SELECT run_id, pass_name, min(source_model) AS source_model
    FROM audit_pass_stats GROUP BY run_id, pass_name
  HAVING count(*) = 1 AND count(source_model) = 1)
SELECT m.source_model, count(*) AS n, false AS excluded
  FROM audit_findings f
  JOIN one_model m ON m.run_id = f.run_id AND m.pass_name = f.pass_name
 GROUP BY m.source_model
UNION ALL
-- the excluded, counted: findings whose (run_id, pass_name) is NOT a one-model pair. The excluded column is the flag a reader classifies
-- on; the NULL model is not a label (a pass-stat model may carry any text, including text that looks like one).
SELECT NULL::text, count(*), true
  FROM audit_findings f
 WHERE NOT EXISTS (SELECT 1 FROM one_model m WHERE m.run_id = f.run_id AND m.pass_name = f.pass_name)`,

  'c-run-agreement': C_RUN_AGREEMENT_CASE,

  'c-run-agreement-counts': `SELECT result, count(*) AS n
  FROM (SELECT ${C_RUN_AGREEMENT_CASE.replace(/\n/g, '\n               ')} AS result
          FROM (SELECT gemini_verdict, (round_converged_after IS NOT NULL) AS converged
                  FROM audit_runs
                 WHERE capture_epoch = ANY($1) AND run_status = 'complete' AND mode = 'code') v) x
 GROUP BY result`,

  'reversal-rate': `SELECT count(*) AS runs,
       sum((write_outcomes -> 'reviewer' ->> 'reversals_written')::int) AS reversals,
       sum((write_outcomes -> 'reviewer' ->> 'presented_resolved')::int) AS presented_resolved,
       sum((write_outcomes -> 'reviewer' ->> 'reversals_written')::int)::numeric
         / NULLIF(sum((write_outcomes -> 'reviewer' ->> 'presented_resolved')::int), 0) AS reversal_rate
  FROM audit_runs
 WHERE capture_epoch = ANY($1) AND write_outcomes -> 'reviewer' ->> 'status' = 'complete'`,

  'incomplete-reviews': `SELECT count(*) AS incomplete_reviews
  FROM audit_runs
 WHERE capture_epoch = ANY($1) AND write_outcomes -> 'reviewer' ->> 'status' = 'incomplete'`,

  'null-outcome': `SELECT CASE
         WHEN f.detail_snapshot LIKE 'ADJACENCY_INCOMPLETE%' OR f.user_action = 'auto_dismissed' THEN 'control_marker'
         WHEN f.user_action = 'needs_triage' THEN 'needs_triage'
         WHEN f.pass_name LIKE 'final-review%' THEN 'final_review_not_adjudicated'
         WHEN r.labeled IS NOT TRUE THEN 'never_finalized'
         ELSE 'other'
       END AS bucket,
       count(*) AS n
  FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
 WHERE f.adjudication_outcome IS NULL
 GROUP BY 1 ORDER BY n DESC`,
});

/** The recipes that are CTE bodies, and the name each is given when composed. */
const CTE_NAME = Object.freeze({ 'capture-rounds': 'capture_rounds', 'capture-concerns': 'capture_concerns' });

/** Which CTEs a statement reads (in dependency order). Absent = reads none. */
const NEEDS = Object.freeze({
  'reraise-rate': ['capture-rounds', 'capture-concerns'],
  'reopen-rate': ['capture-rounds', 'capture-concerns'],
  'dispute-rate': ['capture-rounds'],
  'equivalence-receipt': ['capture-rounds'],
  'quality-prospective': ['capture-rounds', 'capture-concerns'],
});

/** The recipe names that compose into a runnable statement (not the CTE bodies or bare CASE expressions). */
export const CAPTURE_STATEMENTS = Object.freeze([
  'reraise-rate', 'reopen-rate', 'dispute-rate', 'equivalence-receipt', 'quality-prospective', 'quality-historical',
  'c-run-agreement-counts', 'reversal-rate', 'incomplete-reviews', 'null-outcome',
]);

/**
 * Compose one runnable, READ ONLY-safe statement: the CTEs it needs, then the recipe.
 *
 * `params` is `[CAPTURE_EPOCHS]` only when the statement mentions `$1`: Postgres refuses a bound
 * parameter the statement never references ("could not determine data type of parameter $1").
 *
 * @param {string} name one of {@link CAPTURE_STATEMENTS}
 * @param {readonly string[]} [epochs] the cohort; defaults to {@link CAPTURE_EPOCHS}
 * @returns {{sql: string, params: any[]}}
 */
export function captureStatement(name, epochs = CAPTURE_EPOCHS) {
  if (!CAPTURE_STATEMENTS.includes(name)) throw new Error(`captureStatement: unknown statement "${name}"`);
  const body = CAPTURE_RECIPES[name];
  const ctes = (NEEDS[name] ?? []).map((n) => `${CTE_NAME[n]} AS (\n${CAPTURE_RECIPES[n]}\n)`);
  let sql;
  if (/^\s*WITH\s/i.test(body)) {
    // The recipe brings its own CTEs: merge into ONE WITH list (a second WITH is a syntax error).
    sql = `WITH ${[...ctes, body.replace(/^\s*WITH\s+/i, '')].join(',\n')}`;
  } else {
    sql = ctes.length ? `WITH ${ctes.join(',\n')}\n${body}` : body;
  }
  return { sql, params: sql.includes('$1') ? [[...epochs]] : [] };
}
