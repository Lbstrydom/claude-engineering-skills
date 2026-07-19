/**
 * @fileoverview Single oracle for `persona_test_sessions.session_id`.
 *
 * WS-C2 root-cause fix. The legacy format was `persona-test-<unix seconds>`,
 * authored by the LLM from a SKILL.md instruction. That id carries no scope and
 * only one second of resolution, so two repos recording a session in the same
 * second mint the SAME key — and `recordPersonaSession` upserts with
 * `update:'all'`, so the second write silently overwrites the first repo's row
 * (findings, report, verdict and all).
 *
 * The measured alternative — widening `UNIQUE (session_id)` to
 * `(repo_id, session_id)` — was rejected as a band-aid: `repo_id` is legitimately
 * NULL when persona-test runs against a deployed URL from outside a resolvable
 * repo, so it would need a sentinel bucket, and two unresolved-repo sessions in
 * the same second would STILL collide. Widening narrows the window without
 * closing it. A session is a globally-unique *event*; its identity is its own id,
 * and `repo_id`/`repo_name` are annotations on it. So the honest fix is to make
 * the id actually unique rather than to composite-key around a weak one.
 *
 * A repo qualifier was considered and deliberately NOT added — it would buy
 * nothing over the random suffix and would make the key depend on repo
 * resolution, which is exactly the thing that isn't always available.
 *
 * The suffix is a full `crypto.randomUUID()` (122 random bits), not a
 * hand-rolled byte slice. An earlier draft used 48 bits, which is *practically*
 * ample at this write rate — but the failure mode being closed here is a SILENT
 * destructive overwrite, the standard primitive costs exactly the same, and
 * "practically ample" is a weaker contract than "standard globally-unique
 * identifier" for no saving (round-1 audit H1/H2, three passes concurring).
 *
 * @module scripts/lib/persona-test/session-id
 */

import { randomUUID } from 'node:crypto';

/** `persona-test-<unix seconds>-<uuid v4>` */
const SESSION_ID_RE =
  /^persona-test-\d{10,}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Mint a collision-resistant persona-test session id.
 *
 * The `<unix seconds>` prefix is retained purely for human legibility and
 * lexical-chronological sorting — it is NOT the uniqueness mechanism. The uuid
 * suffix is.
 *
 * `now` is the only injectable seam, and it cannot affect uniqueness — there is
 * deliberately no `entropy` override: a caller-supplied byte source could emit a
 * short or malformed suffix in production, and the seam bought nothing the
 * frozen clock doesn't already give the tests (round-1 audit M2/L2).
 *
 * @param {{now?: number}} [opts] test seam: freeze the timestamp prefix
 * @returns {string}
 */
export function buildPersonaSessionId(opts = {}) {
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const seconds = Math.floor(nowMs / 1000);
  return `persona-test-${seconds}-${randomUUID()}`;
}

/**
 * Does `id` carry the entropy suffix this module mints?
 *
 * Deliberately NOT enforced at the write seam: a legacy weak id must still be
 * accepted, because re-posting an existing `session_id` is the documented
 * idempotency path and rejecting it would orphan already-stored sessions.
 * Exposed for tests and for diagnostics that want to report legacy rows.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isCollisionResistantSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

export const _internals = { SESSION_ID_RE };
