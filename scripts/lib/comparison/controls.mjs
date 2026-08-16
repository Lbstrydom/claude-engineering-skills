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
import { isCanonicalizableNumber } from './lock.mjs';

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
  // Validation-contract parity with the digest (Cluster A round 6, M4):
  // canonicalJson (lock.mjs) refuses a number that does not survive a 6dp
  // round-trip, because two such values collapse to the same digest bytes and
  // would silently merge distinct cohorts. Before this, a temperature failing
  // that test parsed successfully here and only threw later, deep inside
  // configDigest() — a config-valid-now, digest-fails-later trap. Refusing it
  // at THIS boundary means the caller who set the bad value sees the error.
  temperature: z.number().finite().min(0)
    .refine(isCanonicalizableNumber, 'temperature must be expressible in 6 decimal places — it is digested into cohort identity (see lock.mjs canonicalJson)'),
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
 * Roles this mechanism can actually RUN today — derived from
 * `CONTROLS_BY_ROLE`, never hand-maintained, so it cannot drift from the
 * dispatch table it describes.
 *
 * Distinct from `SWAP_ELIGIBLE_ROLES` (`contracts.mjs`), and the distinction is
 * now load-bearing rather than implicit (Cluster A round 4, M6). Eligibility
 * proves a role has a MECHANISM HOME — the coverage assertion in
 * `roles.mjs::assertRoleCoverage` needs that to hold for the whole vocabulary.
 * Support proves a role can be EXECUTED. `adjudicator` is eligible (this is
 * the right mechanism for it, once built) and NOT supported (no controls
 * schema exists, because that eval has never run and there is no user to
 * design dials for). Before this export, "supported" existed only as the
 * behaviour of `controlsSchemaForRole` throwing, which is not a check anything
 * could ask a question of — `SWAP_ELIGIBLE_ROLES.includes` and
 * `SUPPORTED_ROLES.includes` are now two answerable questions instead of one
 * answerable question and one guaranteed exception. Never assert
 * `SUPPORTED_ROLES` should equal the full vocabulary — the gap is the
 * documented v1 boundary, not a bug to close by widening this array.
 */
export const SUPPORTED_ROLES = Object.freeze(Object.keys(CONTROLS_BY_ROLE));

/**
 * Can a manifest for this role actually be parsed and run today?
 *
 * The queryable half of the eligible/supported split (M6): a caller no longer
 * has to attempt a parse and catch the refusal just to answer this. (This
 * docstring used to sit, misplaced, above `controlsSchemaForRole` below —
 * fixed in the same pass as M4/M5, another instance of the class this repo
 * keeps catching: documentation drifting from the code it describes.)
 *
 * @param {string} role
 * @returns {boolean}
 */
export function isRoleSupported(role) {
  return Object.hasOwn(CONTROLS_BY_ROLE, role);
}

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

/**
 * The `final_review_shadow`-SPECIFIC semantic rules — `envelopeScope` and
 * xAI pre-flight requirements. These reference `cfg.controls.envelopeScope`
 * and `cfg.controls.preflight`, fields that exist ONLY on
 * `FinalReviewShadowControlsSchema` — never call this for any other role
 * (`AuditorControlsSchema` has neither field).
 *
 * Cluster A round 5, M4/M5: this rule set used to live ONLY inside
 * `campaign/config.mjs`'s `semanticRules`, so a `final_review_shadow`
 * manifest parsed via `comparison/manifest.mjs::parseComparisonManifest`
 * could declare an unattested xAI arm — the exact safety check the campaign
 * path enforces, silently absent on the sibling entry point for the SAME
 * role. Same shape as the arm-set rules before `checkArmSetSemantics`
 * existed: two copies of one contract is how one drifts from the other.
 *
 * @param {{controls: object, arms: object[]}} cfg
 * @param {(message: string, cursor?: Array<string|number>) => void} issue
 * @param {(id: string) => boolean} isXaiModel - injected, not imported here,
 *   so this module does not need to depend on model-resolver.mjs for a single
 *   predicate its only two callers already import for other reasons.
 */
export function checkFinalReviewShadowControls(cfg, issue, isXaiModel) {
  // `gap` is campaign-INELIGIBLE (plan KD-5). A gap shadow is conditioned on
  // its OWN arm's stochastic primary result, so two gap arms are answering
  // different questions — the confound is structural, not a data-quality
  // issue a bigger N would fix. `gap` ships as an operator-selectable flag
  // only; it must never appear inside a signed, N-tracked cohort.
  if (cfg.controls.envelopeScope === 'gap') {
    issue(
      'controls.envelopeScope "gap" is campaign-ineligible (plan KD-5) — a gap '
      + 'shadow is conditioned on its own arm\'s primary result, so gap arms are '
      + 'not comparable to each other; use "thin" for a campaign cohort',
      ['controls', 'envelopeScope'],
    );
  }

  // xAI-arm conditional pre-flight requirement (plan KD-2's correction, §8,
  // Phase 6). A manifest declaring ANY arm on the xAI route must carry a
  // PASSING attestation naming that exact model — schema-enforced so it
  // cannot be forgotten, never a runtime-only check a manifest could bypass.
  // Keyed on `isXaiModel`, the SAME predicate `transportForModel` uses
  // (model-resolver.mjs) — one oracle, so the two can never diverge on what
  // counts as "an xAI arm".
  const xaiArms = cfg.arms.filter((a) => isXaiModel(a.model));
  if (xaiArms.length > 0) {
    const distinctModels = new Set(xaiArms.map((a) => a.model));
    if (distinctModels.size > 1) {
      // v1 supports exactly one xAI model per campaign: one pre-flight
      // artifact attests to one model, and there is no mechanism here for
      // "attest to N models" — a real future need, not a corner to cut today.
      issue(
        `multiple distinct xAI models declared (${[...distinctModels].join(', ')}) — `
        + 'one preflight artifact cannot attest to more than one model; v1 supports '
        + 'exactly one xAI model per campaign',
        ['arms'],
      );
    } else if (!cfg.controls.preflight) {
      issue(
        `arm(s) ${xaiArms.map((a) => a.id).join(', ')} declare an xAI model `
        + `("${xaiArms[0].model}") — controls.preflight is REQUIRED before a campaign `
        + 'may include a Grok arm (run scripts/grok-effort-preflight.mjs --run first)',
        ['controls', 'preflight'],
      );
    } else {
      if (cfg.controls.preflight.model !== xaiArms[0].model) {
        issue(
          `controls.preflight.model ("${cfg.controls.preflight.model}") does not match `
          + `the declared xAI arm's model ("${xaiArms[0].model}") — the attestation must `
          + 'name the exact model it measured, not a sentinel or a different release',
          ['controls', 'preflight', 'model'],
        );
      }
      if (cfg.controls.preflight.disposition !== 'pass') {
        issue(
          `controls.preflight.disposition is "${cfg.controls.preflight.disposition}", not `
          + '"pass" — a Grok arm requires a PASSING pre-flight (plan §8): the dial must be '
          + 'proven to move output before the arm may be billed inside a campaign',
          ['controls', 'preflight', 'disposition'],
        );
      }
    }
  }
}
