/**
 * @fileoverview Shared CLI-preflight primitives for the model swap-in
 * evaluation harness's two thin CLIs (model-eval-auditor.mjs,
 * model-eval-adjudicator.mjs) — extracted because both files carried
 * byte-identical copies (flagged by `arch:duplicates`).
 *
 * @module scripts/lib/model-eval/cli-shared
 */

/** Thrown when a CLI-level precondition fails (bad arg, missing config,
 *  insufficient ground truth, …). Carries a stable `reason` code so the
 *  caller can map it to a specific exit path / message. */
export class RunPreflightError extends Error {
  constructor(reason, message) { super(message); this.name = 'RunPreflightError'; this.reason = reason; }
}

/**
 * Parse a JSON CLI argument, wrapping a parse failure as a `RunPreflightError`
 * so it surfaces as a clean preflight failure rather than an uncaught throw.
 * @param {string} raw
 * @param {string} label - the flag name, for the error message
 * @returns {unknown}
 */
export function parseJsonArg(raw, label) {
  try { return JSON.parse(raw); }
  catch (err) { throw new RunPreflightError('bad_arg', `${label}: invalid JSON — ${err.message}`); }
}
