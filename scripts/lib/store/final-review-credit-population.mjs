/**
 * @fileoverview The one definition of "which findings are in the final-review
 * credit queue", as two SQL branch predicates.
 *
 * **Why this is its own module.** `getFinalReviewStats` reads this population
 * twice: `pendingQueue` builds the LIST the `/ship` credit card prints, and
 * `actionablePairs` builds the exact TOTALS printed as that list's header. The
 * two must describe the same set of findings, or one of them lies about the
 * other — and they drifted exactly that way.
 *
 * `docs/plans/skill-efficacy-census.md` Phase 1 widened the LIST from
 * shadow-only to `shadow-only ∪ primary-bucket-label-gap` — the whole point of
 * that phase, since the primary bucket was where the ~1,615-row gap lived — and
 * widened the list's SQL only. The counts query kept its `bucket =
 * 'shadow-only'` filter and went on summarising the narrower half.
 *
 * Measured against the live store on 2026-09-04, before the fix: the card
 * rendered `486 … 3 fixed-but-unlabelled` and then listed ten rows, every one
 * carrying `bucket: null` — ten members of a class the same card counted as
 * three. The true actionable population was 2,175 (536 shadow-only + 1,689
 * primary label-gap) and the true `fixed-unlabelled` count 1,692, so the class
 * the queue exists to surface was under-reported 563-fold.
 *
 * Sharing the predicate makes that drift unrepresentable rather than merely
 * fixed: widening the population is now one edit both readers inherit.
 * `tests/final-review-pending.test.mjs` asserts both query literals still
 * interpolate both branches, so re-inlining either clause fails.
 *
 * **Why not in `runs-findings.mjs` beside its only consumer.** Two reasons, and
 * the second is the real one. It is already an oversized module under the
 * `size:ratchet:gate`, so adding this history to it would have to be paid for
 * by a re-baseline — and a baseline pinned at the high-water mark is what lets
 * a god-module grow back unchallenged. More importantly, `scripts/learning-store.mjs`
 * re-exports that module with `export *`, and its pinned public surface
 * (`tests/learning-store-exports.test.mjs`) is functions-only; a string constant
 * declared there either escapes onto a public API it does not belong to, or has
 * to be kept private by a convention nothing enforces. Here it is imported, not
 * re-exported, so neither problem exists.
 *
 * Both predicates take `repo_id` as `$1`. `UNION ALL` is safe across them
 * because they partition on `bucket` — a row cannot satisfy both.
 *
 * @module scripts/lib/store/final-review-credit-population
 */

/** Shadow-only findings: the second reviewer's own output, actionable or not. */
export const CREDIT_BRANCH_SHADOW_WHERE =
  `r.repo_id = $1 AND f.bucket = 'shadow-only'`;

/**
 * Primary-bucket findings carrying a remediation but no adjudication — the
 * "label gap" Phase 1 exists to surface, and the larger half of the queue.
 */
export const CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE =
  `r.repo_id = $1 AND f.bucket IS NULL ` +
  `AND f.remediation_state IN ('fixed', 'verified') ` +
  `AND f.user_action IS NULL`;

/**
 * The `pendingQueue` SQL — the LIST half of the credit queue, built from BOTH
 * branch predicates above, keyset-paged (docs/plans/backlog-tooling-honesty.md
 * §2, audit-plan R1 H2). Lives here rather than in `runs-findings.mjs` for the
 * same reason the predicates do: that module is ratcheted, and the query is
 * the predicates' only consumer on the list side.
 *
 * The queue is drained by the adjudication that walks it, so an OFFSET skips
 * one row per adjudication. The UNION is wrapped as a subquery so a WHERE can
 * continue from the previous page's last row in the queue's own total order —
 * `severity_rank DESC, created_at DESC, finding_fingerprint ASC, run_id ASC`
 * (the first two are the ranking; the last two are the row identity that makes
 * it TOTAL, and they mirror `orderItems`'s tie-break). Mixed directions rule
 * out a single row-value comparison, hence the expanded predicate.
 * `created_at_cursor` carries the timestamp as TEXT (microsecond-exact) so a
 * µs-tied pair is neither repeated nor skipped when it is bound back as
 * `$4::timestamptz`; `audit_finding_id` is the embedding key the work-unit
 * grouper joins on.
 *
 * Binds: `$1` repo_id, `$2` limit; with `cursor`, `$3` severity_rank,
 * `$4` created_at (text → timestamptz), `$5` finding_fingerprint, `$6` run_id.
 *
 * @param {{cursor: boolean}} opts
 * @returns {string}
 */
export function pendingQueueSql({ cursor }) {
  const cursorWhere = cursor
    ? `WHERE (q.severity_rank < $3)
           OR (q.severity_rank = $3 AND q.created_at < $4::timestamptz)
           OR (q.severity_rank = $3 AND q.created_at = $4::timestamptz AND q.finding_fingerprint > $5)
           OR (q.severity_rank = $3 AND q.created_at = $4::timestamptz AND q.finding_fingerprint = $5 AND q.run_id > $6::uuid)`
    : '';
  return `SELECT q.*, q.created_at::text AS created_at_cursor FROM (
       SELECT f.id AS audit_finding_id, f.run_id, f.finding_fingerprint, f.severity, f.category,
              f.primary_file, f.detail_snapshot, f.source_model,
              f.user_action, f.remediation_state, f.created_at, f.bucket,
              (CASE f.severity WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END) AS severity_rank
         FROM audit_findings f
         JOIN audit_runs r ON r.id = f.run_id
        WHERE ${CREDIT_BRANCH_SHADOW_WHERE}
       UNION ALL
       SELECT f.id AS audit_finding_id, f.run_id, f.finding_fingerprint, f.severity, f.category,
              f.primary_file, f.detail_snapshot, f.source_model,
              f.user_action, f.remediation_state, f.created_at, f.bucket,
              (CASE f.severity WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END) AS severity_rank
         FROM audit_findings f
         JOIN audit_runs r ON r.id = f.run_id
        WHERE ${CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE}
     ) q
     ${cursorWhere}
     ORDER BY q.severity_rank DESC, q.created_at DESC, q.finding_fingerprint ASC, q.run_id ASC
     LIMIT $2`;
}
