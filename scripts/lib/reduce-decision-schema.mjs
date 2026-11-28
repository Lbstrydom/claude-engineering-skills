/**
 * @fileoverview REDUCE's decision contract for the map-reduce code audit
 * (upstream aa0298f2). Its own module because `schemas.mjs` is over the
 * file-size ratchet; `schemas.mjs` imports it only to register it in
 * `PROVIDER_FACING_SCHEMAS`.
 * @module scripts/lib/reduce-decision-schema
 */

import { z } from 'zod';

/**
 * ReduceDecisionSchema — what the REDUCE call returns (upstream aa0298f2).
 *
 * DECISIONS keyed by the payload's refs (`F1`…), never finding text: output
 * findings are rebuilt from the full MAP objects by `applyReduceDecisions`
 * (robustness.mjs; the call is in audit/map-reduce-scheduler.mjs), so REDUCE cannot cut, paraphrase or drop a MAP field. It
 * used to return `PassFindingsSchema` — regenerated findings capped at 15,
 * written from a view that had already cut `detail` to 200 characters.
 *
 * `systemic_findings` is the one place REDUCE still writes prose: a genuinely
 * new cross-unit finding. Every non-prose field (id, flags, classification,
 * tags) is filled in code from its sources.
 *
 * Minimum array lengths (a merge needs a duplicate, a systemic finding two
 * sources) are enforced by the applier, not declared here as `minItems`.
 * Validated in code with `safeParse`: `callGPT` only rejects a non-array
 * `findings` key, and this schema has none.
 *
 * Provider-facing (handed to GPT through `zodTextFormat`), so it is registered
 * in `PROVIDER_FACING_SCHEMAS` and must stay refinement-free: every rule a
 * provider cannot enforce lives in the applier, not in `.refine()`.
 */
const ReduceRef = z.string().max(12).describe('A payload ref such as "F3" — exactly as given in the input');
export const ReduceDecisionSchema = z.object({
  pass_name: z.string().max(30),
  merge_groups: z.array(z.object({
    keep_ref: ReduceRef.describe('The ref of the finding to keep — the clearest statement of the issue'),
    duplicate_refs: z.array(ReduceRef).describe('Refs that describe the SAME issue as keep_ref; they leave the output'),
    reason: z.string().max(200),
  })).describe('Groups of findings describing the same issue. A ref may appear in at most one group.'),
  severity_elevations: z.array(z.object({
    ref: ReduceRef,
    severity: z.enum(['HIGH', 'MEDIUM', 'LOW']).describe('The raised severity — never lower than the finding already has'),
    reason: z.string().max(200),
  })).describe('Findings whose severity should be raised. Raise only; never lower.'),
  systemic_findings: z.array(z.object({
    source_refs: z.array(ReduceRef).describe('At least 2 distinct refs whose _mapUnits together name at least 2 different units'),
    severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    category: z.string().max(80),
    section: z.string().max(120),
    detail: z.string().max(600),
    risk: z.string().max(500),
    recommendation: z.string().max(600),
    is_quick_fix: z.boolean().describe('TRUE if YOUR recommendation for the pattern is a band-aid rather than a proper fix'),
    principle: z.string().max(150),
  })).max(5).describe('New cross-unit findings: one pattern that several units each found an instance of. The instances stay.'),
  quick_fix_warnings: z.array(z.string().max(300)).max(5),
  summary: z.string().max(500).describe('Brief summary of the synthesis'),
});
