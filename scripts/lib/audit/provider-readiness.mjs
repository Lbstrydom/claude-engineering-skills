/**
 * @fileoverview Why a provider client could not be constructed — classified,
 * and safe to persist.
 *
 * A null client conflates four different causes: credentials missing, malformed
 * configuration, transport/SDK init failure, and a regression in construction.
 * The tiered shadow reported all of them as one generic
 * `providers.anthropicClient unavailable`, so 51 records produced by a single
 * keyless 14-hour session read as intermittent flakiness for two days
 * (2026-07-16/17). Only `credentials-missing` and `disabled` are benign; the
 * rest are operational defects that must not hide behind a routine skip line.
 *
 * REDACTION IS PART OF THE CONTRACT. Provider construction errors routinely
 * carry endpoint URLs, proxy settings and credential-bearing query components,
 * and these records flow into the store, stderr, the report and the dashboard.
 * The classified result is an allowlisted shape with a redacted message; any
 * unredacted cause stays in-process only.
 *
 * Plan: docs/plans/debt-burndown-workstreams.md §4 WS-B2.
 * @module scripts/lib/audit/provider-readiness
 */

import { redactSecrets } from '../secret-patterns.mjs';

/**
 * @typedef {'available'|'credentials-missing'|'disabled'|'config-invalid'|'transport-init-failed'|'not-attempted'} ReadinessState
 */

/** States where skipping dependent work is the CORRECT, expected outcome. */
const BENIGN_STATES = new Set(['credentials-missing', 'disabled', 'not-attempted']);

/**
 * Is this state a routine skip rather than an operational defect?
 * @param {{state: ReadinessState}} readiness
 */
export function isBenignUnavailability(readiness) {
  return BENIGN_STATES.has(readiness?.state);
}

/**
 * Classify a client-construction error into an allowlisted, persistable record.
 *
 * Matching is on stable, self-authored shapes first (our own factory's
 * messages), then on transport-level signals. Anything unrecognised is
 * `transport-init-failed` — deliberately the NON-benign default, so a new
 * failure mode surfaces as a defect rather than being silently absorbed into
 * "no key" and skipped.
 *
 * @param {unknown} err
 * @returns {{state: ReadinessState, code: string|null, message: string}}
 */
export function classifyProviderReadiness(err) {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error');
  // `code` is persisted and rendered exactly like `message`, so it goes through
  // the SAME boundary. It is usually a short enum (`ECONNREFUSED`), but nothing
  // guarantees that — an SDK is free to put a URL or token-bearing string
  // there, and "usually safe" is not a redaction contract. Also length-capped:
  // a code is an identifier, and an unbounded one is a payload.
  const code = (err && typeof err === 'object' && 'code' in err && err.code != null)
    ? safeRedact(String(err.code)).slice(0, 120)
    : null;
  // Redact BEFORE anything else touches it — this string is persisted and
  // rendered. Never expose the raw text, not even in the "unrecognised" branch.
  const message = safeRedact(raw);

  // Our own factory's contract: `ANTHROPIC_API_KEY required for sdk backend`.
  // Matched on the stable half of the sentence, not the whole string.
  if (/API_KEY required/i.test(raw) || /\bapi[- ]?key\b[^.]*\b(required|missing|not set)\b/i.test(raw)) {
    return { state: 'credentials-missing', code, message };
  }
  if (/\b(disabled|opted out|not enabled)\b/i.test(raw)) {
    return { state: 'disabled', code, message };
  }
  // Configuration the caller got wrong (bad backend name, unhonourable
  // baseURL, malformed deployment) — actionable by the operator, but NOT a
  // missing credential, and NOT a benign skip.
  if (/unknown backend|invalid|malformed|unsupported|must be one of|cannot be honoured|unhonourable/i.test(raw)) {
    return { state: 'config-invalid', code, message };
  }
  return { state: 'transport-init-failed', code, message };
}

/**
 * Redaction must never be the thing that throws — a failure here would turn a
 * diagnostic into a crash. Fail closed to a fixed marker rather than leaking
 * the raw text (mirrors `redactSecrets`' own fail-closed contract).
 */
function safeRedact(text) {
  try {
    // `redactSecrets` returns `{text, redacted[]}`, NOT a string. Treating the
    // object as the result made every message read `[REDACTED:redaction-failed]`
    // — a redactor that redacts everything destroys the diagnostic just as
    // surely as one that redacts nothing leaks it.
    const out = redactSecrets(text);
    const redacted = typeof out === 'string' ? out : out?.text;
    return typeof redacted === 'string' ? redacted : '[REDACTED:redaction-failed]';
  } catch {
    return '[REDACTED:redaction-failed]';
  }
}
