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
  // A caller that forgets `version` used to get `parsed.v !== undefined`, which
  // a frame with no `v` at all satisfies — so the version gate silently let
  // through exactly the artifacts it exists to quarantine. The check is only
  // meaningful if the expected version is mandatory.
  if (!Number.isInteger(version)) {
    throw new TypeError(`parseEnvelopeFrame: version must be an integer; got ${JSON.stringify(version)}`);
  }
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
  // Windows resolves these as DEVICES wherever they appear as a basename, so
  // `CON.json` is not a file. The docstring above claimed this was handled
  // before the code did — the audit caught the overclaim.
  const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (typeof fingerprint !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(fingerprint)
      || fingerprint === '.' || fingerprint === '..'
      || RESERVED.test(String(fingerprint).split('.')[0])) {
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
 * Restore `.claimed` leftovers from a drain that died mid-flight.
 *
 * @returns {number} how many could NOT be recovered
 */
function reclaimClaimed(dir) {
  let unreclaimed = 0;
  for (const n of fs.readdirSync(dir)) {
    if (!n.endsWith('.claimed')) continue;
    const orig = path.join(dir, n.slice(0, -'.claimed'.length));
    try {
      if (fs.existsSync(orig)) fs.rmSync(path.join(dir, n), { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
      else fs.renameSync(path.join(dir, n), orig);
    } catch { unreclaimed++; }
  }
  return unreclaimed;
}

/**
 * Test seam (mirrors the `_internals` pattern in file-io.mjs / shared.mjs).
 *
 * The unreclaimed-artifact guard is a VACUOUS-PASS guard — it exists so a
 * drain cannot report `empty` over work it failed to recover — and the only
 * way to prove it fires is to make a reclaim fail. That turned out to be
 * unreachable from the filesystem on this platform: `rmSync` succeeds through
 * an open handle (Node opens with FILE_SHARE_DELETE), and every other
 * injection tried was equally cheerful. A guard nobody can drive red is
 * indistinguishable from one that does nothing, so the seam is the honest
 * alternative to leaving it unproven.
 */
export const _internals = { reclaimClaimed };

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

  // Reclaim `.claimed` leftovers from a drain that died mid-flight. Without
  // this they are invisible to the `.json` filter below and leak permanently —
  // the same silent-loss shape this module exists to prevent.
  let unreclaimed = 0;
  try {
    unreclaimed = _internals.reclaimClaimed(dir);
  } catch {
    // An unreadable directory is ONE fact, and `listEnvelopesOldestFirst` below
    // fails on it identically and owns the canonical `readdir failed` reason.
    // Returning here too would give one condition two different messages.
  }
  // A `.claimed` file the sweep could NOT recover is invisible to the `.json`
  // listing below, so continuing would report `empty` over work that is still
  // there — the vacuous pass this module exists to remove (audit H4). Swallowing
  // it, as the first version did, is what made that state reachable.
  if (unreclaimed > 0) {
    return { state: 'unavailable', drained: 0, rejected: 0, failed: 0,
      reason: `${unreclaimed} claimed artifact(s) could not be reclaimed` };
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

    // CLAIM the artifact with an atomic rename before doing anything slow with
    // it. `rename` is the only primitive here that is atomic against a
    // concurrent producer: once the file is moved aside, the producer's next
    // write to this fingerprint lands on a free pathname and cannot be
    // destroyed by our later delete. Compare-then-delete narrowed that window;
    // it could not close it (round-2 H2).
    const claimed = `${file}.claimed`;
    try {
      fs.renameSync(file, claimed);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;   // another drain claimed it first
      failed++;
      continue;
    }

    try {
      // The CLAIMED path is passed through: a consumer doing its own
      // disposition (retry bookkeeping, quarantine) must act on the file the
      // drain actually holds, not on the producer-facing name — which no longer
      // exists at this point. Rewriting the claimed file is preserved by the
      // hand-back below; moving it away is respected too.
      const applied = await apply(envelope, { file: claimed });
      // `=== true`, not truthy. The contract says a handler PROVES application;
      // an adapter returning a status object before its write is durable would
      // otherwise satisfy `if (applied)` and the envelope would be deleted.
      if (applied === true) {
        // The claim above already moved this artifact out of the producer's
        // pathname, so there is nothing left to race: deleting the claim file
        // cannot touch a newer envelope, because a newer envelope is written to
        // the ORIGINAL name. A compare-then-delete would still have had a
        // window between the comparison and the unlink.
        fs.rmSync(claimed, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
        drained++;
      } else {
        // Not applied — hand the artifact back to the queue under its own name
        // so the next drain sees it. If the producer has since written a newer
        // envelope there, that one wins and this claim is dropped: it is a
        // strict predecessor of what now sits in the queue.
        try {
          // The consumer may have dispositioned the claim itself (quarantined
          // it). Absent claim ⇒ nothing to hand back, and that is not an error.
          if (!fs.existsSync(claimed)) { /* consumer took ownership */ }
          else if (fs.existsSync(file)) {
            fs.rmSync(claimed, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
          } else {
            fs.renameSync(claimed, file);
          }
        } catch { /* leave the claim file; the reclaim sweep picks it up */ }
        failed++;   // sink declined or unavailable — leave it for next time
      }
    } catch (err) {
      // Hand the claim back before returning/counting — an artifact stranded as
      // `.claimed` would be invisible to the next drain's `.json` filter.
      try { if (!fs.existsSync(file)) fs.renameSync(claimed, file); else fs.rmSync(claimed, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }); } catch { /* swept next run */ }
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
