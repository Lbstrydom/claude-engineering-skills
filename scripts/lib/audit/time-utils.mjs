/**
 * @fileoverview Shared time helpers for the audit pipeline. Extracted
 * (arch-drift-duplication-cleanup plan) after `nowIso` was independently
 * reimplemented in `evidence-triage.mjs`, `final-adjudication.mjs`, and
 * `stage1-triage.mjs`. Deliberately NOT in `llm-helpers.mjs` — that module
 * is LLM-call-shaping (prompts, model resolution), and a generic timestamp
 * helper has no business depending on it or being found there.
 *
 * @module scripts/lib/audit/time-utils
 */

/**
 * ISO timestamp via an injected clock, falling through to the real clock in
 * production. A clock-taking signature (rather than a bare `nowIso()`) is
 * deliberate: a production caller that forgot to pass one would silently
 * timestamp every decision at 1970 with a hardcoded-epoch default — falling
 * through to the real clock is the safer failure mode. Tests inject a fixed
 * `clock` for determinism.
 * @param {() => string} [clock] - when provided, must return an ISO string directly
 * @returns {string}
 */
export function nowIso(clock) {
  return typeof clock === 'function' ? clock() : new Date().toISOString();
}
