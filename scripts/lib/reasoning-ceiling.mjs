/**
 * @fileoverview Clamp a GPT reasoning tier to an operator ceiling.
 *
 * `OPENAI_AUDIT_REASONING` is both the default tier (for a call that names
 * none) and the CEILING every audit pass is clamped to. The per-pass tiers
 * (backend/frontend `high`, …) are literals in the pass code, so without a
 * ceiling an operator could not lower them at all. The default ceiling is
 * `high`, which clamps nothing.
 */

const REASONING_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

/**
 * A tier outside the closed set passes through untouched: rejecting it is the
 * provider's job, and silently rewriting it would hide the bad value.
 */
export function capReasoning(tier, ceiling) {
  if (!(tier in REASONING_RANK) || !(ceiling in REASONING_RANK)) return tier;
  return REASONING_RANK[tier] > REASONING_RANK[ceiling] ? ceiling : tier;
}
