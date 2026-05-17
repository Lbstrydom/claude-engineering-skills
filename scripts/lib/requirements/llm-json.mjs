/**
 * @fileoverview Shared LLM-response JSON parsing for the requirements layer.
 * Plan: docs/plans/requirements-layer.md.
 *
 * Both `extract.mjs` and `gap-challenge.mjs` receive a JSON payload from the
 * model, optionally wrapped in a ```json fence. This is the SINGLE
 * fence-strip + parse routine so the boundary behaviour cannot drift between
 * the two call sites (audit M3 — copy-pasted LLM-boundary logic).
 *
 * @module scripts/lib/requirements/llm-json
 */

/**
 * Extract a JSON payload from a model response and `JSON.parse` it.
 *
 * Prefers a fenced ```json … ``` block found ANYWHERE in the text — the model
 * sometimes emits a preamble ("Here is the output:") before the fence, which
 * a leading-anchored strip would leave attached and break the parse (Gemini
 * new-finding). Falls back to the bare trimmed text when there is no fence.
 *
 * @param {string} text - raw model response text
 * @returns {unknown} the parsed JSON value
 * @throws {SyntaxError} when the extracted text is not valid JSON
 */
export function parseLlmJson(text) {
  const raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return JSON.parse(fenced ? fenced[1] : raw);
}
