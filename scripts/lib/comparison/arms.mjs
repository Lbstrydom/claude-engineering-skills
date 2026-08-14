/**
 * @fileoverview Arm identity + the scored/unscored oracle — role-agnostic.
 *
 * Moved verbatim from `campaign/config.mjs` (2026-08-14) so the synchronous
 * swap-eval harness can declare arms with the same semantics the passive
 * campaign already has. Nothing here knows what a "snapshot" is, which is what
 * makes it shareable: an arm is a model plus a role in the comparison, and
 * whether it competes for the decision is a property of its declaration, not of
 * how the evidence was collected.
 *
 * `ArmSchema` is unchanged from the campaign's original — byte-identical
 * validation, so `configDigest` over a committed campaign is unaffected by the
 * move. That invariant is asserted in tests/comparison-core.test.mjs.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md D2.
 *
 * @module scripts/lib/comparison/arms
 */

import { z } from 'zod';

/** Arm ids become path components (receipt filenames), so they are
 * pattern-constrained at the schema boundary. Defence-in-depth, not the only
 * guard — every derived path is additionally resolved and asserted
 * repo-root-contained before any write (INC-001's lesson, one layer out). */
export const ARM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const ArmSchema = z.object({
  id: z.string().regex(ARM_ID_PATTERN, 'arm id must match ^[a-z0-9][a-z0-9-]{0,63}$ (max 64 chars) — it is a receipt filename component'),
  model: z.string().min(1),
  mode: z.enum(['shadow', 'primary']),
  type: z.enum(['replicate', 'control']).optional(),
}).strict();

/**
 * Does this arm compete for the decision? The SINGLE oracle for that question.
 *
 * Two kinds of arm are collected but never scored, and they are not the same
 * thing:
 *  - **`replicate`** — the SAME model as a scored arm, run again, to read
 *    within-model reroll variance. Must duplicate a scored arm's model; a
 *    replicate of nothing is a mislabelled scenario.
 *  - **`control`** — a DIFFERENT model included to calibrate what the
 *    comparison means, not to win it. The motivating case (2026-08-14): the
 *    incumbent primary reviewer is Gemini, and running Gemini in the shadow
 *    slot separates "is Opus the better second reviewer" from "is a fresh
 *    second look worth anything at all". It must never be scored, because the
 *    same model on both gates has correlated failure modes — the property a
 *    second gate exists to provide — so a control that could win the slot would
 *    be recommending exactly the configuration the design rejects.
 *
 * Four sites re-derived `a.type !== 'replicate'` inline before this existed.
 * Adding a second non-scored type to four independent copies is how one gets
 * missed and a control silently enters the standings.
 *
 * @param {{type?: string}} arm
 * @returns {boolean} true when the arm's findings count toward the verdict
 */
export function isScoredArm(arm) {
  return arm?.type !== 'replicate' && arm?.type !== 'control';
}

/**
 * The arm-set rules structural strictness cannot express — shared by the
 * campaign config and the comparison manifest.
 *
 * Extracted because both encoded the same four rules independently (unique ids,
 * ≥2 scored arms, replicate-backing, incumbent uniqueness). Two copies of one
 * contract is how they drift: the `control` type was added to one of them
 * first, and only a mechanical check caught the other.
 *
 * Reports through a caller-supplied `issue(message, path)` so each consumer
 * keeps its own error surface (Zod `superRefine` here, whatever a future
 * consumer uses) without this module depending on one.
 *
 * @param {{arms: object[], decision: {incumbent: string}}} cfg
 * @param {(message: string, cursor?: Array<string|number>) => void} issue
 */
export function checkArmSetSemantics(cfg, issue) {
  const seen = new Set();
  for (const [i, arm] of cfg.arms.entries()) {
    if (seen.has(arm.id)) issue(`duplicate arm id "${arm.id}" — arm id identifies a receipt and a store row`, ['arms', i, 'id']);
    seen.add(arm.id);
  }

  const scored = cfg.arms.filter(isScoredArm);
  if (scored.length < 2) {
    issue(`a campaign needs >= 2 scored arms (got ${scored.length}; replicate/control arms do not count) — one arm is not a comparison`, ['arms']);
  }

  // AT MOST one primary, not exactly one: a cohort of all-shadow arms is
  // legitimate and shipped (the scoped campaign has zero primaries by design).
  const primaries = cfg.arms.filter((a) => a.mode === 'primary');
  if (primaries.length > 1) {
    issue(`at most one arm may be mode:"primary" (got ${primaries.length}: ${primaries.map((a) => a.id).join(', ')})`, ['arms']);
  }

  // A `replicate` of nothing is a mislabelled scenario. A `control` is exempt —
  // naming a model no scored arm uses is the entire point of one.
  const scoredModels = new Set(scored.map((a) => a.model));
  for (const [i, arm] of cfg.arms.entries()) {
    if (arm.type === 'replicate' && !scoredModels.has(arm.model)) {
      issue(`replicate arm "${arm.id}" names model "${arm.model}", which no scored arm uses — a replicate of nothing is a mislabelled scenario`, ['arms', i, 'model']);
    }
  }

  // The incumbent must be a real, comparable participant — scored arms only,
  // since a control is never scored and could not serve as a baseline.
  const incumbentArms = scored.filter((a) => a.model === cfg.decision.incumbent);
  if (incumbentArms.length === 0) {
    issue(`decision.incumbent "${cfg.decision.incumbent}" names no scored arm's model (available: ${[...scoredModels].join(', ') || 'none'}; replicate/control arms are not eligible)`, ['decision', 'incumbent']);
  } else if (incumbentArms.length > 1) {
    issue(`decision.incumbent "${cfg.decision.incumbent}" matches ${incumbentArms.length} scored arms (${incumbentArms.map((a) => a.id).join(', ')}) — the incumbent must be unambiguous`, ['decision', 'incumbent']);
  }
}
