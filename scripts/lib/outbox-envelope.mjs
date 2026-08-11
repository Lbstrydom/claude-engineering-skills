/**
 * @fileoverview Write-ahead envelope core — the shared mechanism behind every
 * outbox in this repo.
 *
 * Extracted from `scripts/lib/upstream/commands.mjs`, which invented it for
 * consumer bug reports and states the principle better than a restatement
 * would: *"A success line is never printed having persisted nothing; the
 * envelope on disk is the proof."*
 *
 * **Why extracted rather than copied** (plan `docs/plans/audit-store-write-durability.md`
 * decision 1d): the audit-store durability work needs the same mechanism for a
 * different writer, and shipping a second implementation would have made three
 * — counting `learning/decision-logger.mjs`, which has its own eviction and
 * backpressure contract and is deliberately left alone. The single-oracle rule
 * in AGENTS.md exists for exactly this fork in the road.
 *
 * **What is generic and what is not.** The FRAME is generic: a version, a
 * fingerprint, and an opaque payload. The PAYLOAD is not — upstream validates
 * `title`/`severity`/`affectedPath`, an audit-store writer will validate
 * something else entirely. So `parseEnvelopeFrame` takes a `validatePayload`
 * predicate rather than pretending one shape fits both.
 *
 * **Two deliberate contract changes from the code this was lifted from**, both
 * from the plan's Gemini gate:
 *
 * 1. `drainEnvelopes` returns a DISCRIMINATED state. The original returned
 *    `{drained: 0, rejected: 0, failed: 0}` both when the directory was absent
 *    and from a `catch` around `readdirSync` — so an unreadable outbox was
 *    indistinguishable from an empty one, and "nothing to do" from "I could not
 *    look". The counters are still returned, so existing callers are unaffected.
 * 2. **A connection-scoped failure aborts the drain**, rather than being
 *    recorded against each artifact in turn. A store outage is a fact about the
 *    store, not about the data: letting it consume every artifact's retry
 *    budget would retire a healthy backlog for a reason that was never its
 *    fault. Callers signal this with `isConnectionError`.
 *
 * Ordering is oldest-first. The original took `readdirSync` order and sliced,
 * so a capped drain processed an arbitrary subset rather than the oldest —
 * harmless at 20 envelopes, wrong at 2000.
 *
 * @module scripts/lib/outbox-envelope
 */

import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFileSync } from './file-io.mjs';

/** Sub-directory holding envelopes the drain refused to apply. */
export const REJECTED_SUBDIR = 'rejected';

/**
 * Validate an envelope read back off disk.
 *
 * Returns `null` when unusable — the caller quarantines rather than deleting
 * (which loses data) or retrying forever (which blocks the queue).
 *
 * @param {string} text - raw file contents
 * @param {object} opts
 * @param {number} opts.version - the frame version this consumer accepts
 * @param {(payload: unknown) => boolean} [opts.validatePayload] - payload-shape
 *   predicate. Omitted ⇒ any non-null object payload is accepted.
 * @returns {object|null}
 */
export function parseEnvelopeFrame(text, { version, validatePayload } = {}) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.v !== version) return null;
  if (typeof parsed.fingerprint !== 'string' || !parsed.fingerprint) return null;
  const p = parsed.payload;
  if (!p || typeof p !== 'object') return null;
  if (validatePayload && !validatePayload(p)) return null;
  return parsed;
}

/**
 * Write-ahead: the envelope lands on disk BEFORE any remote attempt.
 *
 * @param {string} dir - absolute outbox directory
 * @param {{fingerprint: string}} envelope
 * @returns {string} the file written
 */
export function writeEnvelope(dir, envelope) {
  assertSafeFingerprint(envelope?.fingerprint);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${envelope.fingerprint}.json`);
  atomicWriteFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
  return file;
}

/**
 * A fingerprint becomes a FILENAME, so it is a path, not a label.
 *
 * The extracted code interpolated it straight into `path.join` — safe while the
 * only producer was a sha256 hex digest, and a traversal the moment a second
 * consumer derives one from anything less constrained. `../../../etc/x` escapes
 * the outbox; on Windows `a:b` or a reserved device name fails in stranger ways.
 * Rejecting at the boundary keeps every current caller working and makes the
 * next one safe by construction.
 *
 * @param {unknown} fingerprint
 */
export function assertSafeFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(fingerprint)
      || fingerprint === '.' || fingerprint === '..') {
    throw new TypeError(
      `outbox: fingerprint must be a safe basename ([A-Za-z0-9._-], 1-128 chars); got ${JSON.stringify(fingerprint)}`,
    );
  }
}

/**
 * Envelope files in the directory, OLDEST FIRST, capped.
 *
 * Exported for the test that asserts ordering — a cap over an arbitrary subset
 * is the defect this replaces, and it is invisible unless asserted directly.
 *
 * @param {string} dir
 * @param {number} cap
 * @returns {{ok: true, names: string[]} | {ok: false, reason: string}}
 */
export function listEnvelopesOldestFirst(dir, cap) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    return { ok: false, reason: `readdir failed: ${err.code || err.message}` };
  }
  const stamped = [];
  for (const name of names) {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, name)).mtimeMs; } catch { /* raced away */ }
    stamped.push([name, mtime]);
  }
  stamped.sort((a, b) => (a[1] - b[1]) || a[0].localeCompare(b[0]));
  return { ok: true, names: stamped.slice(0, cap).map(([n]) => n) };
}

/**
 * Is the file at `p` still the one described by `before`?
 *
 * Compares mtime + size + inode where the platform supplies one. Not a lock —
 * it cannot close the window entirely — but it turns "always delete the
 * pathname" into "delete only what we read", which is the difference between
 * discarding a producer's newer envelope and leaving it for the next drain.
 *
 * @param {string} p
 * @param {import('node:fs').Stats} before
 * @returns {boolean}
 */
function fileUnchanged(p, before) {
  try {
    const now = fs.statSync(p);
    return now.mtimeMs === before.mtimeMs
      && now.size === before.size
      && (!now.ino || now.ino === before.ino);
  } catch {
    return false;   // gone or unreadable — do not delete blind
  }
}

/**
 * Drain pending envelopes.
 *
 * Deliberately tolerant of a concurrent winner: two invocations can drain the
 * same file, both apply (idempotent by fingerprint), and the slower one would
 * otherwise throw ENOENT on unlink and abort the command it is piggybacking on.
 *
 * @param {object} opts
 * @param {string} opts.dir - absolute outbox directory
 * @param {(envelope: object) => Promise<boolean>} opts.apply - MUST resolve
 *   `true` only when the write is durably applied. A falsy resolution leaves
 *   the envelope on disk — silence is not success.
 * @param {(text: string) => object|null} opts.parse - frame parser, usually a
 *   `parseEnvelopeFrame` closure carrying this consumer's version + validator.
 * @param {number} opts.cap - max envelopes this invocation may process.
 * @param {(err: unknown) => boolean} [opts.isConnectionError] - true ⇒ the sink
 *   is unreachable; abort the whole drain rather than blaming each artifact.
 * @returns {Promise<{state:'drained'|'empty'|'unavailable', drained:number,
 *   rejected:number, failed:number, reason?:string}>}
 */
export async function drainEnvelopes({ dir, apply, parse, cap, isConnectionError }) {
  const empty = { state: 'empty', drained: 0, rejected: 0, failed: 0 };

  // `cap` reaches `slice`, where a negative value means "all but the last N" —
  // so `cap: -1` would drain everything except the newest, the exact opposite of
  // a maximum. Validate at the shared boundary rather than trusting four
  // consumers to pass a sane number.
  const limit = Number.isInteger(cap) && cap > 0 ? cap : null;
  if (limit === null) {
    throw new TypeError(`outbox: cap must be a positive integer; got ${JSON.stringify(cap)}`);
  }

  // Absent directory is genuinely "nothing to do" — it is created on first
  // write. Unreadable is NOT, and the two used to share a return value.
  // `existsSync` cannot tell them apart (it answers false for a permission
  // failure too), so stat and read the errno.
  try {
    fs.statSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ...empty };
    return {
      state: 'unavailable', drained: 0, rejected: 0, failed: 0,
      reason: `stat failed: ${err?.code || err?.message}`,
    };
  }

  const listed = listEnvelopesOldestFirst(dir, limit);
  if (!listed.ok) {
    return { state: 'unavailable', drained: 0, rejected: 0, failed: 0, reason: listed.reason };
  }
  if (listed.names.length === 0) return { ...empty };

  let drained = 0, rejected = 0, failed = 0;
  for (const name of listed.names) {
    const file = path.join(dir, name);

    // READ and PARSE are separate failures and must not share a branch.
    // Collapsing them quarantines a perfectly good envelope on a transient EIO
    // or a momentary lock — evidence moved out of the queue for a reason that
    // had nothing to do with its contents.
    let text = null;
    let stat = null;
    try {
      stat = fs.statSync(file);
      text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;  // a concurrent drain won it
      failed++;                              // transient — retry next drain
      continue;
    }

    let envelope = null;
    try { envelope = parse(text); } catch { envelope = null; }

    if (!envelope) {
      // Quarantine: a poison envelope must neither block the queue nor vanish.
      try {
        const rej = path.join(dir, REJECTED_SUBDIR);
        fs.mkdirSync(rej, { recursive: true });
        // NEVER clobber earlier evidence. `renameSync` replaces the destination
        // on POSIX, so two rejections of the same fingerprint silently left one.
        let dest = path.join(rej, name);
        for (let n = 1; fs.existsSync(dest); n++) dest = path.join(rej, `${name}.${n}`);
        fs.renameSync(file, dest);
        rejected++;
      } catch { failed++; }
      continue;
    }

    try {
      const applied = await apply(envelope);
      // `=== true`, not truthy. The contract says a handler PROVES application;
      // an adapter returning a status object before its write is durable would
      // otherwise satisfy `if (applied)` and the envelope would be deleted.
      if (applied === true) {
        // Delete the artifact we actually applied, not whatever now occupies
        // the pathname: a producer can rewrite this fingerprint during the
        // await, and deleting by name alone would discard that newer envelope
        // having persisted only the older payload.
        if (fileUnchanged(file, stat)) {
          fs.rmSync(file, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
        }
        drained++;
      } else {
        failed++;   // sink declined or unavailable — leave it for next time
      }
    } catch (err) {
      if (isConnectionError?.(err)) {
        // The sink is down. Stop: the remaining envelopes are fine, and
        // recording a failure against each of them is how an outage retires a
        // healthy backlog.
        return {
          state: 'unavailable', drained, rejected, failed,
          reason: `sink unreachable: ${err?.code || err?.message || 'unknown'}`,
        };
      }
      failed++;
    }
  }
  return { state: 'drained', drained, rejected, failed };
}
