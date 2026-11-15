/**
 * @fileoverview The ONE reading of a raw `CLAUDE_BACKEND` value. Dependency-free on purpose: `anthropic-client.mjs`'s
 * `resolveBackend` (which throws on an unrecognised value) and the doctors' "which backend is in effect, from which layer" line
 * (`env-provenance.mjs`) both read through it, so the report and the runtime cannot disagree about what a value means — and a
 * doctor does not have to load the SDK client to ask.
 *
 * @module scripts/lib/claude-backend-name
 */

/** Every backend `CLAUDE_BACKEND` may name. */
export const VALID_BACKENDS = new Set(['sdk', 'cli', 'bedrock']);

/**
 * Unset or empty is the default `sdk`; anything else is lower-cased and must name a known backend. `null` when it does not.
 * @param {string|undefined|null} raw
 * @returns {'sdk'|'cli'|'bedrock'|null}
 */
export function parseBackendName(raw) {
  const v = (raw || 'sdk').toLowerCase();
  return VALID_BACKENDS.has(v) ? /** @type {'sdk'|'cli'|'bedrock'} */ (v) : null;
}
