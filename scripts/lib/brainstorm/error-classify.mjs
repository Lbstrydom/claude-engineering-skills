/**
 * @fileoverview Single oracle for "was this adapter failure an abort?".
 *
 * **The defect this closes** (consumer report, 2026-08-26). All three brainstorm
 * adapters classified a failure by asking `err?.name === 'AbortError' ||
 * err?.code === 'ABORT_ERR'` first, then `err.status`, then falling through to
 * `state: 'malformed'`. Every adapter aborts on its OWN timeout
 * (`setTimeout(() => controller.abort(), timeoutMs)`), and the OpenAI SDK wraps
 * an aborted request as `APIUserAbortError` — a subclass of `APIError`
 * constructed with `status: undefined` and no `code`. So neither branch matched
 * and a plain **timeout was reported as `malformed`**: the operator is told the
 * model returned unparseable output, when in fact the model was never given
 * time to answer, and the actionable advice (raise `--depth`, raise
 * `--timeout`) never surfaces. `APIConnectionError` /
 * `APIConnectionTimeoutError` land the same way for the same reason.
 *
 * **Ask the signal, not the error.** The authoritative fact is
 * `controller.signal.aborted` — it is set by the code that did the aborting,
 * so it is true regardless of which SDK wrapped the rejection or what it named
 * the class. Error-shape sniffing stays as a fallback for callers that cannot
 * hand over a signal, and is deliberately broader than the two names it
 * replaces.
 *
 * Three copies of one predicate is why fixing one adapter would have left the
 * other two wrong — the same reasoning that made
 * `brainstorm/provider-availability.mjs` one exported function.
 *
 * @module scripts/lib/brainstorm/error-classify
 */

/**
 * Was this failure an abort (i.e. the adapter's own timeout fired)?
 *
 * @param {{err?: unknown, signal?: {aborted?: boolean}|null}} input
 * @returns {boolean}
 */
export function isAbortFailure({ err, signal = null } = {}) {
  if (signal?.aborted) return true;
  const name = String(err?.name ?? '');
  const code = String(err?.code ?? '');
  if (name === 'AbortError' || code === 'ABORT_ERR') return true;
  // SDK wrappers: OpenAI/Azure `APIUserAbortError`, and anything else that
  // names the abort in its class rather than in a code.
  if (/abort/i.test(name)) return true;
  // A DOMException carrying the abort reason.
  if (err instanceof Error && /^(the )?(operation|request) was aborted/i.test(String(err.message ?? ''))) return true;
  return false;
}

/**
 * The operator-facing message for an aborted leg. One spelling, so the three
 * adapters cannot drift into three different explanations of one event.
 *
 * @param {number|null} [timeoutMs]
 * @returns {string}
 */
export function abortMessage(timeoutMs = null) {
  return timeoutMs
    ? `Timed out after ${timeoutMs}ms — raise --timeout, or lower --depth so the model has less to write.`
    : 'Timed out — raise --timeout, or lower --depth so the model has less to write.';
}
