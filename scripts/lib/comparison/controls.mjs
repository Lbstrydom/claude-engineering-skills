/**
 * @fileoverview The shared dials — role-parameterised, strict, and one set per
 * comparison rather than one per arm.
 *
 * LESSON (b), which the shared-dial rule exists to make unrepeatable: Kimi at
 * `reasoningEffort: 'low'` found 0 findings; at `'high'` it found 3 on an
 * IDENTICAL transcript. Arms must share one dial or the comparison measures the
 * setting, not the model. So `reasoningEffort` is required for EVERY role, and
 * there is deliberately no per-arm override anywhere in this schema — adding
 * one would make the campaign uninterpretable after the spend.
 *
 * ROLE-PARAMETERISED, because the dials genuinely differ: a final-review shadow
 * has an `envelopeScope`; an auditor has `passes`/`scope`/`rounds`. What must
 * NOT differ is strictness — every variant is `.strict()`, so a dial belonging
 * to another role is a load-time refusal rather than a silently ignored key.
 * That is the `reasoningEfort` lesson: a typo'd control must fail loudly rather
 * than run at a provider default.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md D2, D4.
 *
 * @module scripts/lib/comparison/controls
 */

import { z } from 'zod';

/** Effort is the canonical shared dial — same enum for every role. */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The pre-flight ATTESTATION a manifest cites when it declares an xAI arm.
 * Lives inside `controls` — not at the manifest top level — so `configDigest`
 * covers it, making the attestation part of what a re-collection must match.
 *
 * `model` is checked against the declaring arm's model STRING, never a
 * live-resolved id: the schema validates a static file and must not need
 * network access or become non-deterministic when a catalog moves.
 */
export const PreflightSchema = z.object({
  artifact: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'sha256 must be a 64-hex-char digest'),
  model: z.string().min(1),
  disposition: z.enum(['pass', 'fail', 'inconclusive']),
}).strict();

/** Dials every role shares. Not exported as a schema on its own — a bare
 * common block is not a valid controls object for any role. */
const COMMON_SHAPE = {
  reasoningEffort: z.enum(EFFORT_LEVELS),
  promptTemplateId: z.string().min(1),
  outputSchemaId: z.string().min(1),
  maxOutputTokens: z.number().int().positive(),
  toolPolicy: z.string().min(1),
  temperature: z.number().finite().min(0),
  preflight: PreflightSchema.optional(),
};

/**
 * `final_review_shadow` — the passive campaign's dials. Byte-compatible with
 * the campaign's original `ControlsSchema`, so `configDigest` over a committed
 * campaign is unchanged by the extraction.
 */
export const FinalReviewShadowControlsSchema = z.object({
  ...COMMON_SHAPE,
  // Plan KD-6: which final-review envelope every arm's shadow reviewer
  // receives. Inside `controls`, therefore inside `configDigest`, so scope is
  // SIGNED cohort state rather than ambient env — a mismatched snapshot is
  // structurally ineligible rather than merely discouraged.
  envelopeScope: z.enum(['full', 'thin', 'gap']),
}).strict();

/**
 * `auditor` — the synchronous swap-eval's dials.
 *
 * `passes`/`scope`/`rounds` are the auditor's equivalent of `envelopeScope`:
 * they determine what was ASKED of the model, so they are collection-time and
 * belong in the digest. `tier` deliberately does NOT live here — it is a CLI
 * argument applied to the whole manifest, and duplicating it would create two
 * sources for one value.
 */
export const AuditorControlsSchema = z.object({
  ...COMMON_SHAPE,
  passes: z.array(z.string().min(1)).min(1),
  scope: z.enum(['diff', 'plan', 'full']),
  rounds: z.number().int().positive(),
}).strict();

/** role → its controls schema. The single dispatch table.
 *
 * `Object.create(null)`, not a literal: a plain object inherits from
 * `Object.prototype`, so `CONTROLS_BY_ROLE['toString']` returns a function and a
 * truthiness check would accept `toString` as a role. A null-prototype table
 * cannot answer for a key nobody declared. */
export const CONTROLS_BY_ROLE = Object.freeze(Object.assign(Object.create(null), {
  final_review_shadow: FinalReviewShadowControlsSchema,
  auditor: AuditorControlsSchema,
}));

/**
 * The controls schema for a role, or a refusal naming what is missing.
 *
 * `adjudicator` is in the vocabulary and in `SWAP_ELIGIBLE_ROLES`, but has no
 * controls schema here — deliberately, and it must refuse LOUDLY rather than
 * fall through to a default. The adjudicator swap-eval has never been run
 * (AGENTS.md records it pending at Phase 14), so there is no evidence about
 * what its dials should be and designing them now would be guessing at a set
 * with no user. Eligibility is not manifest support.
 *
 * @param {string} role
 * @returns {import('zod').ZodTypeAny}
 */
export function controlsSchemaForRole(role) {
  const schema = Object.hasOwn(CONTROLS_BY_ROLE, role) ? CONTROLS_BY_ROLE[role] : undefined;
  if (!schema) {
    throw new Error(
      `[comparison/controls] role "${role}" has no controls schema — declarative manifests are not yet supported `
      + `for it (supported: ${Object.keys(CONTROLS_BY_ROLE).join(', ')}). This is a deliberate v1 boundary, not a `
      + 'missing default: inventing dials for a role nobody has run would be guessing.',
    );
  }
  return schema;
}
