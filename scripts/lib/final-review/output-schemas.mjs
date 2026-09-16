/**
 * @fileoverview Structured-output contracts for the final-review CLI — the Zod
 * review schema, its Gemini/OpenAI/Anthropic dialect derivations, and the
 * schema-driven truncation that keeps an over-long model response from
 * failing Zod validation outright.
 *
 * Pure relocation out of `scripts/gemini-review.mjs`
 * (`docs/plans/gemini-review-decomposition.md` Phase 1) — `gemini-review.mjs`
 * imports these back and keeps re-exporting `GeminiFinalReviewSchema` /
 * `ANTHROPIC_REVIEW_TOOL_NAME` at the top level (test-import contract) and
 * `AnthropicReviewToolSchema` via its existing `_internals` object, both
 * unchanged in shape.
 *
 * @module scripts/lib/final-review/output-schemas
 */
import { z } from 'zod';
import { ProducerFindingSchema, zodToGeminiSchema } from '../schemas.mjs';
import { zodToOpenAiJsonSchema } from '../oss-structured-output.mjs';

const WronglyDismissedSchema = z.object({
  original_finding_id: z.string().max(10).describe('The GPT finding ID that was dismissed (e.g. H3, M5)'),
  reason_claude_was_wrong: z.string().max(800).describe('Why Claude should not have dismissed this'),
  recommended_severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  evidence_basis: z.string().max(600).optional().describe(
    'Required if the transcript shows Claude challenged this finding with cited evidence. ' +
    'Explain NEW counter-evidence not already addressed in Claude\'s challenge. ' +
    'Omitting this on a previously-challenged finding signals reassertion without new evidence.'
  ),
  cited_lines: z.array(z.string().max(100)).max(10).optional().describe(
    'Specific line references cited in your reasoning (e.g. ["auth.js:132", "auth.js:137"]). ' +
    'Include these so hallucinated citations can be detected and flagged post-hoc.'
  ),
});

// Exported so tests/provider-contract-enforceable.test.mjs can assert it stays
// refinement-free (evidence-anchor-path-contract §7d). It is handed to a
// provider via z.toJSONSchema below, and z.toJSONSchema drops `.refine`/
// `.superRefine` SILENTLY — the guard is what stops that recurring here.
// Export-only; the module's CLI stays behind its import.meta.url guard.
export const GeminiFinalReviewSchema = z.object({
  verdict: z.enum(['APPROVE', 'CONCERNS', 'CONCERNS_REMAINING', 'REJECT']),

  deliberation_quality: z.object({
    claude_bias_detected: z.boolean().describe('Did Claude dismiss valid findings to protect its own code?'),
    gpt_false_positive_count: z.number().describe('How many GPT findings were noise or incorrect?'),
    deliberation_was_fair: z.boolean().describe('Was the Claude-GPT deliberation balanced overall?'),
    quality_summary: z.string().max(2000).describe('Brief assessment of the deliberation process')
  }),

  new_findings: z.array(ProducerFindingSchema).max(10).describe('Issues neither Claude nor GPT caught. Max 10, only genuinely new.'),

  wrongly_dismissed: z.array(WronglyDismissedSchema).max(10).describe('GPT findings Claude dismissed but were actually valid'),

  over_engineering_flags: z.array(z.string().max(500)).max(10).describe('Places where audit pressure caused unnecessary complexity'),

  architectural_coherence: z.enum(['Strong', 'Adequate', 'Weak']),
  overall_reasoning: z.string().max(3000).describe('Comprehensive final assessment')
});

// Derived from GeminiFinalReviewSchema — single source of truth via Zod → JSON Schema
export const GeminiFinalReviewJsonSchema = zodToGeminiSchema(GeminiFinalReviewSchema);

// The OpenAI-compatible dialect of the SAME Zod source of truth. Deliberately
// NOT `GeminiFinalReviewJsonSchema`: `zodToGeminiSchema` strips `maxLength` /
// `additionalProperties` / etc. for Gemini's dialect, and an OpenAI-compatible
// router wants the unstripped draft schema.
//
// Why this exists (experiment-4, 2026-07-28): the openai transport only ever
// appended "Output strictly valid JSON" to the system prompt and hoped. Opus
// complies because the anthropic transport FORCES a `submit_review` tool call
// carrying the real schema — so the OpenAI-side arms were being judged against
// a contract they were never given. Measured: kimi-k3 returned
// `{file,title,description,evidence}` and glm-5.2 returned
// `{title,description,evidence_basis,cited_lines}`, neither carrying the
// `category`/`section`/`risk`/`recommendation` the finding taxonomy and R2+
// suppression ledger key on — and Zod validation here is warn-and-keep, so
// those degraded rows flow into the store silently.
export const OpenAiFinalReviewJsonSchema = zodToOpenAiJsonSchema(GeminiFinalReviewSchema);

/**
 * Anthropic forced-tool-use `input_schema` — the SAME Zod source of truth as
 * the Gemini schema above, but a different dialect on purpose.
 * `zodToGeminiSchema` strips `maxLength`/`additionalProperties`/etc. for
 * Gemini's restricted subset; Anthropic accepts standard JSON Schema, and the
 * length hints are worth keeping (the provider does not enforce them — see the
 * anthropic transport — but they steer the model, and `truncateToSchema` is
 * still the actual enforcement downstream).
 *
 * `$schema` is dropped: it is metadata, not a constraint, and tool `input_schema`
 * has no use for it.
 */
export const AnthropicReviewToolSchema = (() => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(GeminiFinalReviewSchema);
  return rest;
})();

/** Tool name for the Anthropic structured-review call. Exported for tests. */
export const ANTHROPIC_REVIEW_TOOL_NAME = 'submit_review';

// ── Schema-driven truncation ──────────────────────────────────────────────────
// Gemini verbosity regularly exceeds field maxLength constraints, causing Zod to
// reject the entire response. Instead of failing, we truncate verbose fields and
// log what was shortened. Map is built from the raw JSON Schema (before Gemini
// stripping removes maxLength) so it stays in sync with the Zod definitions.

/**
 * Walk a JSON Schema tree and collect all path → maxLength entries.
 * Handles nested objects, arrays (path[]), and $defs references.
 * @param {object} schema - Raw JSON Schema node
 * @param {string} path - Dot-path to current node
 * @param {Map<string,number>} map - Accumulator
 * @param {object} [defs] - Top-level $defs for $ref resolution
 */
function _collectMaxLengths(schema, path, map, defs) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) {
    const refName = schema.$ref.replace('#/$defs/', '');
    if (defs?.[refName]) _collectMaxLengths(defs[refName], path, map, defs);
    return;
  }
  if (schema.type === 'string' && schema.maxLength) {
    map.set(path, schema.maxLength);
  }
  if (schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      _collectMaxLengths(v, path ? `${path}.${k}` : k, map, defs);
    }
  }
  if (schema.items) {
    _collectMaxLengths(schema.items, `${path}[]`, map, defs);
  }
}

const _rawGeminiReviewSchema = z.toJSONSchema(GeminiFinalReviewSchema);
const _maxLengthMap = new Map();
_collectMaxLengths(_rawGeminiReviewSchema, '', _maxLengthMap, _rawGeminiReviewSchema.$defs);

/**
 * Recursively walk a parsed JSON result and truncate strings that exceed their
 * schema-defined maxLength. Returns a new object (no mutation). Logs truncations.
 * @param {*} obj
 * @param {string} path
 * @param {string[]} truncated - Accumulator for log messages
 * @returns {*}
 */
export function truncateToSchema(obj, path, truncated) {
  if (typeof obj === 'string') {
    const max = _maxLengthMap.get(path);
    if (max && obj.length > max) {
      truncated.push(`${path} (${obj.length} → ${max})`);
      return obj.slice(0, max);
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => truncateToSchema(item, `${path}[]`, truncated));
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = truncateToSchema(v, path ? `${path}.${k}` : k, truncated);
    }
    return out;
  }
  return obj;
}

// No verifySchemaSync needed — JSON Schema is derived from Zod, drift is impossible.
