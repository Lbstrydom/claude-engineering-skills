/**
 * @fileoverview The `/cycle` preview-gate mode vocabulary — the single
 * definition, in shared-lib.
 *
 * ## Why it lives here and not beside its resolver
 *
 * `PREVIEW_GATE_MODES` was declared in `lib/cycle/topology.mjs`, which the
 * domain tagger reads as `audit-orchestration`. `lib/config.mjs` — a
 * genuinely domain-neutral primitive that nearly everything imports — needed
 * the enum to validate `PREVIEW_GATE_MODE`, and reaching for it manufactured a
 * `shared-lib -> audit-orchestration` edge: the base layer depending UP on a
 * feature, purely to read three strings.
 *
 * That edge is one of the entries `_comment_allowedDeps` records as debt, not
 * intent ("~6 top-level lib files … are feature coordinators, not
 * domain-neutral primitives; retag or move them"). For `config.mjs` the right
 * verdict was neither: it IS a primitive, and the misplaced thing was the
 * constant.
 *
 * This is the same move, for the same reason, as
 * [`status-vocabulary.mjs`](./status-vocabulary.mjs) — whose own header records
 * that a `stores -> plan` edge is not in allowedDeps, so the plan-status
 * vocabulary lives in shared-lib and BOTH the store and the plan-domain parser
 * import it. A vocabulary shared across a layer boundary belongs to neither
 * side.
 *
 * `topology.mjs` re-exports this so existing importers are unaffected; the
 * definition is here.
 *
 * @module scripts/lib/preview-gate-vocabulary
 */

/**
 * What `/cycle` Step 5 must do about preview gating.
 *
 * - `pre_merge_required` — a preview env exists and MUST gate; halt before
 *   merge until persona-test passes against the preview URL.
 * - `post_merge_warning` — deploy-from-main or no preview; persona-test is
 *   post-hoc and cannot prevent prod exposure, so findings are fast-follow.
 * - `not_applicable` — the default; the gate is silent.
 *
 * Frozen: it is a closed set, and an unknown value must fall back to
 * `not_applicable` rather than extend the vocabulary at runtime.
 */
export const PREVIEW_GATE_MODES = Object.freeze([
  'pre_merge_required',
  'post_merge_warning',
  'not_applicable',
]);

/** The value any unrecognised mode degrades to. Named so callers stop spelling it. */
export const PREVIEW_GATE_DEFAULT = 'not_applicable';

/**
 * Is `raw` a declared preview-gate mode?
 *
 * A predicate rather than a bare `.includes` at each call site: `config.mjs`
 * previously wrote the membership test three times in ten lines, which is how
 * two spellings of one rule drift apart.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isPreviewGateMode(raw) {
  return typeof raw === 'string' && PREVIEW_GATE_MODES.includes(raw);
}
