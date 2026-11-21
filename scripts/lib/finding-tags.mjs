/**
 * @fileoverview The ONE reader of a finding's model-asserted tags (docs/plans/verification-lessons.md §2.3).
 *
 * `importance` ('important'|'nit'), `pre_existing` and `newly_reachable` are asserted by the auditor. They sit BESIDE the
 * mechanical `scope` signal (`finding-scope.mjs` `isInDiff`), never instead of it: a count site keeps both filters, so a
 * finding gates only when BOTH agree it should.
 *
 * Unknown never relaxes. A legacy row (tag null/absent), a half-stated pair and a contradictory pair all GATE; only a
 * fully-stated, self-consistent tag set can excuse a finding. Never read `f.importance` / `f.pre_existing` directly.
 *
 * @module scripts/lib/finding-tags
 */

import { z } from 'zod';

/**
 * Schema fragments. Declared HERE, not in `FindingBase` (schemas.mjs): `FindingBase` is spread into the persisted schema too,
 * and a field required there breaks every legacy re-write. Producer (LLM response) schemas REQUIRE them as plain enums/booleans,
 * never `.nullable()` (same Gemini `anyOf` reason as `is_reopened`); the persisted schema reads them `.nullable().default(null)`,
 * so a legacy row is `null` = unmeasured, never `nit`.
 */
export const FindingTagsProducer = {
  importance: z.enum(['important', 'nit']).describe(
    '"important" = a defect a maintainer must fix before this change ships; "nit" = style/naming/preference with no behavioural consequence. Independent of severity.'
  ),
  pre_existing: z.boolean().describe(
    'TRUE only if the line you cite lies OUTSIDE every changed hunk of the diff shown to you AND is not in a new file. FALSE otherwise.'
  ),
  newly_reachable: z.boolean().describe(
    'Meaningful only when pre_existing is TRUE: TRUE only if you can name, in `detail`, the changed line that makes this old defect newly reachable. FALSE otherwise (and FALSE when pre_existing is FALSE).'
  ),
};
export const FindingTagsPersisted = {
  importance: z.enum(['important', 'nit']).nullable().default(null),
  pre_existing: z.boolean().nullable().default(null),
  newly_reachable: z.boolean().nullable().default(null),
};

/**
 * What the model's tags, read ALONE, say about a finding. Absence of ANY of the three tags gates (checked before any excusal:
 * a half-stated nit gates), so unknown never relaxes. For a count decision use `gatesForCount`, which also asks the mechanical
 * scope: the model's tags never override it.
 * @param {object} f a finding (producer-shaped, persisted-shaped or legacy)
 * @returns {{gates: boolean, reason: string}}
 */
export function findingGateClass(f) {
  const importance = f?.importance ?? null;
  const preExisting = f?.pre_existing ?? null;
  const newlyReachable = f?.newly_reachable ?? null;
  if (importance !== 'important' && importance !== 'nit') return { gates: true, reason: 'importance-unstated' };
  if (typeof preExisting !== 'boolean') return { gates: true, reason: 'pre-existing-unstated' };
  if (typeof newlyReachable !== 'boolean') return { gates: true, reason: 'newly-reachable-unstated' };
  // Contradictory pairs: the tags disagree with each other or with the independent severity axis.
  if (newlyReachable === true && preExisting === false) return { gates: true, reason: 'tag-contradiction' };
  if (importance === 'nit' && f.severity === 'HIGH') return { gates: true, reason: 'tag-contradiction' };
  if (importance === 'nit') return { gates: false, reason: 'nit' };
  if (preExisting && !newlyReachable) return { gates: false, reason: 'pre-existing-not-reachable' };
  if (preExisting) return { gates: true, reason: 'pre-existing-newly-reachable' };
  return { gates: true, reason: 'important' };
}

/**
 * Does a finding count toward the verdict / convergence? `inDiff` is the MECHANICAL scope (`isInDiff`) and outranks the model.
 *  - mechanically pre-existing (`inDiff` false): not counted, EXCEPT `newly_reachable === true` - a pre-existing defect the
 *    change made reachable counts, which is the point of the tag.
 *  - in the diff: counts, unless the tag set is complete AND `nit` AND not HIGH. A model-claimed `pre_existing` on an
 *    in-diff line is ignored and recorded as `tag-contradiction`; it can never excuse the finding.
 * @param {object} f
 * @param {{inDiff: boolean}} ctx
 * @returns {{gates: boolean, reason: string}}
 */
export function gatesForCount(f, { inDiff }) {
  if (!inDiff) {
    return f?.newly_reachable === true
      ? { gates: true, reason: 'pre-existing-newly-reachable' }
      : { gates: false, reason: 'mechanically-pre-existing' };
  }
  const g = findingGateClass(f);
  if (g.reason === 'nit') return g;
  if (!g.gates) return { gates: true, reason: 'tag-contradiction' };
  return g;
}

/**
 * The tags every NON-LLM constructor (mechanical waves, notices, linter, fixtures) spreads into the finding it builds.
 * Fixed and conservative by construction: a deterministic finding is `important`, in-diff, not newly-reachable-only, so it
 * can never be excused by a tag nobody asserted. Required fields break legacy re-writes; this is what fills them.
 */
export const NON_LLM_FINDING_TAGS = Object.freeze({ importance: 'important', pre_existing: false, newly_reachable: false });
