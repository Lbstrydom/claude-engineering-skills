/**
 * @fileoverview Forced-vs-auto `tool_choice` for Claude calls that need ONE
 * structured tool call back.
 *
 * Claude Opus 5.5 (what `latest-opus` resolves to since 2026-09-23), Fable 5.1
 * and Mythos 5.1 reject `tool_choice: {type:'tool'|'any'}` with HTTP 400
 * ("tool_choice: type "tool" and "any" are not supported for this model").
 * On those models the documented replacement is `{type:'auto'}` + a prompt
 * instruction naming the tool + `strict: true` on the tool, which keeps the
 * schema-valid-arguments guarantee forcing gave.
 *
 * The predicate is an ALLOWLIST of the generations known to accept forcing,
 * not a denylist of the ones known to reject it. `auto` is accepted by every
 * model, so an id this module cannot place (a new release, a Bedrock/Azure
 * deployment name) takes the path that cannot 400. A denylist is only as
 * current as the last model launch, and it failed exactly that way here: two
 * opt-in paths kept forcing after `latest-opus` moved.
 *
 * `auto` does not guarantee a call. Every caller must treat "no tool_use
 * block" as a failure it reports, never as an empty result.
 *
 * @module scripts/lib/anthropic-tool-choice
 */

import { parseClaudeModel } from './model-resolver.mjs';

/**
 * True when `model` is a Claude id from a generation that accepts forced
 * `tool_choice`: everything before 5, plus the 5.0 releases (Opus 5,
 * Sonnet 5). Unknown ids return false, i.e. take the `auto` path.
 * @param {string} model
 * @returns {boolean}
 */
export function acceptsForcedToolChoice(model) {
  const parsed = typeof model === 'string' ? parseClaudeModel(model.toLowerCase()) : null;
  if (!parsed) return false;
  return parsed.major < 5 || (parsed.major === 5 && parsed.minor === 0);
}

// JSON-Schema keywords strict tool use rejects (numeric bounds, string length,
// array-size constraints). The caller's own client-side validation (Zod /
// clampToSchema) still enforces them after the call, which is what the SDK's
// `parse()` helpers do with the same keywords.
const STRICT_UNSUPPORTED_KEYWORDS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems',
]);

/**
 * Deep copy of a JSON Schema with strict-unsupported keywords removed. A
 * property NAMED like a keyword (`properties.maxLength`) is kept: only keys of
 * a schema node are filtered, never keys of a `properties` map.
 * @param {object} schema
 * @returns {object}
 */
export function toStrictToolSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toStrictToolSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRICT_UNSUPPORTED_KEYWORDS.has(key)) continue;
    if ((key === 'properties' || key === '$defs' || key === 'definitions') && value && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toStrictToolSchema(v)]));
    } else {
      out[key] = toStrictToolSchema(value);
    }
  }
  return out;
}

/**
 * The request fields for "call exactly this one tool" on `model`.
 *
 * Forcing-capable model: `{tools:[tool], tool_choice:{type:'tool',name}}`,
 * byte-identical to what callers sent before this module existed.
 *
 * Otherwise: `auto`, the tool marked `strict` with a strict-compatible schema,
 * and `instruction`, a sentence the caller MUST put in the system prompt
 * (appended, so a shared user prompt stays byte-identical across models).
 *
 * @param {string} model
 * @param {{name: string, description?: string, input_schema: object}} tool
 * @returns {{tools: object[], tool_choice: object, instruction: string|null, forced: boolean}}
 */
export function buildToolUseRequest(model, tool) {
  if (acceptsForcedToolChoice(model)) {
    return { tools: [tool], tool_choice: { type: 'tool', name: tool.name }, instruction: null, forced: true };
  }
  return {
    tools: [{ ...tool, strict: true, input_schema: toStrictToolSchema(tool.input_schema) }],
    tool_choice: { type: 'auto' },
    instruction: `Respond by calling the ${tool.name} tool exactly once. Do not answer in prose.`,
    forced: false,
  };
}

/** Append a `buildToolUseRequest` instruction to a system prompt (either may be empty). */
export function withToolInstruction(system, instruction) {
  if (!instruction) return system;
  return system ? `${system}\n\n${instruction}` : instruction;
}
