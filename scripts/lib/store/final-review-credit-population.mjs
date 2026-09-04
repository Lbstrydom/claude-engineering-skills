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
