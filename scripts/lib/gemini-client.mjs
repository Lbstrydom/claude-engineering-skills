/**
 * @fileoverview The ONE set of constructor options for every Gemini
 * (`@google/genai`) client in this repo — above all, the API version.
 *
 * WHY THE VERSION IS PINNED HERE, not left to the SDK: synced tooling runs on
 * the CONSUMER's installed `@google/genai`, not ours. `@google/genai` 2.x
 * defaults to `v1beta`; 3.x defaults to `v1`, which 404s the `gemini-*-latest`
 * aliases and rejects `systemInstruction`. Measured 2026-11-27 in a consumer on
 * 3.6.1: the identical `generateContent` call failed on the default (`404 …
 * not found for API version v1`) and succeeded with `apiVersion: 'v1beta'` —
 * `/brainstorm`'s Gemini voice was dead there while this repo (2.24.0) stayed
 * green. Every call site in this repo was written against v1beta semantics, so
 * that is what every client asks for, whatever SDK major the consumer has.
 *
 * `tests/gemini-client-pinned.test.mjs` fails on any GoogleGenAI construction
 * that does not take its options from here.
 */
export const GEMINI_API_VERSION = 'v1beta';

/**
 * @param {object} [extra] extra GoogleGenAI options (an explicit `apiKey`
 *   overrides the env; `httpOptions` merge, but the API version stays pinned)
 * @returns {object}
 */
export function geminiClientOptions(extra = {}) {
  const { httpOptions, ...rest } = extra;
  return {
    apiKey: process.env.GEMINI_API_KEY,
    ...rest,
    httpOptions: { ...(httpOptions || {}), apiVersion: GEMINI_API_VERSION },
  };
}
