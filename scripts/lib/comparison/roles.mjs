/**
 * @fileoverview The single role VOCABULARY for model comparison, plus the
 * per-mechanism ELIGIBILITY subsets — the two are different questions and
 * conflating them is a real defect, not a naming preference.
 *
 * Before this module (2026-08-14) the repo carried two disjoint role enums that
 * did not import each other: `ROLES = ['auditor','adjudicator']` in
 * `model-eval/contracts.mjs`, and `role: z.enum(['final_review_shadow'])` in
 * `campaign/config.mjs`. Between them they named exactly the three LLM roles in
 * this repo's audit chain, and neither could see the others — so "compare
 * models for role X" had no repo-wide answer, and two enums cannot share a lock
 * digest.
 *
 * The obvious unification — widen the campaign enum to include `auditor` — is
 * wrong twice over. It would create a THIRD overlapping vocabulary, and it
 * would route an auditor manifest into the PASSIVE collector, which AGENTS.md
 * (2026-07-26) forbids by name: "a model swap is SYNCHRONOUS, never a
 * background window … do NOT add a sixth collector", after passive collection
 * produced five false "window met" reads. Hence the split below:
 *
 *   VOCABULARY  — what role names exist at all            → `ROLES` (here)
 *   ELIGIBILITY — which roles a given mechanism accepts    → a subset, declared
 *                                                            by that mechanism
 *
 * The consumers declare their own subsets (`CAMPAIGN_ELIGIBLE_ROLES`,
 * `SWAP_ELIGIBLE_ROLES`) and validate against those — they deliberately do NOT
 * re-export `ROLES` as their own validator, because that is precisely the bug
 * that would let the passive collector accept an auditor campaign.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md D1.
 *
 * @module scripts/lib/comparison/roles
 */

import { z } from 'zod';

/**
 * Every role a model comparison can be declared for. The union of the
 * per-mechanism eligibility sets must equal this exactly — see
 * `assertRoleCoverage`.
 */
export const ROLES = Object.freeze(['auditor', 'adjudicator', 'final_review_shadow']);

/** Zod enum over the full vocabulary. Validators generally want a SUBSET. */
export const RoleSchema = z.enum(ROLES);

/**
 * Assert a mechanism's eligibility set is a well-formed subset of the
 * vocabulary. Exported so each consumer's own tests can assert it, and so the
 * repo-wide coverage test has one oracle rather than re-deriving the rule.
 *
 * Reference equality was the first design and it is unsatisfiable: a consumer
 * whose eligible set IS `ROLES` accepts every role, which defeats the split.
 * Subset + coverage is what reference-equality was reaching for.
 *
 * @param {readonly string[]} eligible
 * @param {string} label - for the error message
 * @returns {readonly string[]} `eligible`, for chaining
 */
export function assertEligibleSubset(eligible, label) {
  if (!Array.isArray(eligible) || eligible.length === 0) {
    throw new TypeError(`[comparison/roles] ${label}: eligibility set must be a non-empty array`);
  }
  const unknown = eligible.filter((r) => !ROLES.includes(r));
  if (unknown.length > 0) {
    throw new TypeError(
      `[comparison/roles] ${label}: role(s) ${unknown.map((r) => `"${r}"`).join(', ')} are not in the vocabulary `
      + `(${ROLES.join(', ')}) — add them to ROLES deliberately, never invent a role at a consumer`,
    );
  }
  const dupes = eligible.filter((r, i) => eligible.indexOf(r) !== i);
  if (dupes.length > 0) {
    throw new TypeError(`[comparison/roles] ${label}: duplicate role(s) ${[...new Set(dupes)].join(', ')}`);
  }
  return eligible;
}

/**
 * Every role in the vocabulary must be claimed by exactly one mechanism.
 *
 * The two directions are different failures and both matter: an UNCLAIMED role
 * is a name nothing can run (the vocabulary grew without a home), and an
 * OVERLAPPING role is two mechanisms both believing they own it — which is how
 * the passive collector would silently acquire the auditor.
 *
 * @param {Record<string, readonly string[]>} sets - label → eligible roles
 * @returns {{ok: true}}
 */
export function assertRoleCoverage(sets) {
  const seen = new Map();
  for (const [label, eligible] of Object.entries(sets)) {
    assertEligibleSubset(eligible, label);
    for (const role of eligible) {
      if (seen.has(role)) {
        throw new Error(
          `[comparison/roles] role "${role}" is claimed by both ${seen.get(role)} and ${label} — `
          + 'a role belongs to exactly one mechanism, or neither knows who runs it',
        );
      }
      seen.set(role, label);
    }
  }
  const unclaimed = ROLES.filter((r) => !seen.has(r));
  if (unclaimed.length > 0) {
    throw new Error(
      `[comparison/roles] role(s) ${unclaimed.map((r) => `"${r}"`).join(', ')} are in the vocabulary but no `
      + 'mechanism accepts them — a role with no home cannot be compared, so either give it one or remove it',
    );
  }
  return { ok: true };
}
