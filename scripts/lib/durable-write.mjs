/**
 * @fileoverview Durable audit-store writes — a writer registry over the shared
 * write-ahead envelope core.
 *
 * Plan: `docs/plans/audit-store-write-durability.md`, Phase 1.
 *
 * **The defect this exists for.** `legacy-production-audit.mjs`'s cloud block
 * calls `recordFindings`/`recordPassStats`/`recordSuppressionEvents`/
 * `syncBanditArms` as `.catch(log)` fire-and-forget: not awaited, nothing
 * persisted, one stderr line if they reject. A dropped `recordFindings` is
 * invisible and produces a believable false zero — the store looks healthy and
 * under-reports.
 *
 * **Why a registry rather than `durableWrite(label, fn, payload)`.** A spilled
 * artifact has to be replayable by a LATER process, and a function is not
 * serialisable. So a writer registers its `replay` once, keyed by id, and the
 * artifact carries data only. `registerWriter` lives in
 * `audit-store-writers.mjs` — imported by BOTH the orchestrator and the
 * operator CLI, because the registry is process-local and a drain in a fresh
 * process would otherwise find zero handlers and quarantine everything.
 *
 * **Retention is not replay eligibility** (the distinction the plan's gate
 * forced). EVERY writer gets a write-ahead envelope. What differs is what
 * happens to it on failure:
 *
 *   success                → envelope deleted            → `written`
 *   failure, `rowKey`      → retained in `spill/`        → `spilled`  (drain replays)
 *   failure, no `rowKey`   → moved to `lost/`            → `lost`     (evidence only)
 *
 * `spill/` is the replay queue; `lost/` is an evidence drawer the drain never
 * reads. Nothing vanishes silently, and nothing without a declared idempotency
 * key is ever replayed — at-least-once delivery on a non-idempotent writer
 * would corrupt the very rows this is protecting.
 *
 * @module scripts/lib/durable-write
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  writeEnvelope, parseEnvelopeFrame, drainEnvelopes, assertSafeFingerprint,
  REJECTED_SUBDIR,
} from './outbox-envelope.mjs';
import { spillConfig } from './config.mjs';
import { withFileLock } from './file-lock.mjs';
import { normalizePostgresError } from './db/errors.mjs';

/** Frame version for audit-store envelopes. Bumping it quarantines older files. */
export const AUDIT_ENVELOPE_VERSION = 1;

/** Replay queue — artifacts a drain will retry. Relative to the repo root. */
export const SPILL_DIR = path.join('.audit', 'write-spill');

/** Evidence drawer — failures that are NOT replayable. The drain never reads it. */
export const LOST_SUBDIR = 'lost';

/**
 * Max artifacts one drain may process. Bounded so a backlog cannot stall the
 * command a drain is piggybacking on; overridable for an operator clearing a
 * large one deliberately.
 */
export const DRAIN_CAP = (() => {
  const n = Number.parseInt(process.env.AUDIT_WRITE_DRAIN_CAP ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

/** @type {Map<string, {schemaVersion:number, rowKey:?Function, replay:Function}>} */
const _registry = new Map();

/**
 * Register a durable writer.
 *
 * @param {string} writerId - stable id, also the artifact's discriminator.
 * @param {object} spec
 * @param {number} spec.schemaVersion - payload schema version.
 * @param {(row: object) => string} [spec.rowKey] - PER-ROW idempotency key.
 *   Its PRESENCE is what makes this writer spill-eligible. Absent ⇒ a failure
 *   is `lost`, never replayed. These are BATCH writers, so the key is derived
 *   per row inside `replay`, not once per payload — a payload-level key would
 *   collapse every batch to one value.
 * @param {(payload: object) => Promise<{applied: boolean}>} spec.replay - the
 *   same code path the live write uses. MUST resolve `{applied: true}` only
 *   when the write is durably applied; a bare `undefined` (what an early
 *   cloud-off `return` produces) is read as NOT applied.
 */
export function registerWriter(writerId, spec) {
  if (typeof writerId !== 'string' || !writerId) {
    throw new TypeError('registerWriter: writerId must be a non-empty string');
  }
  if (typeof spec?.replay !== 'function') {
    throw new TypeError(`registerWriter(${writerId}): replay must be a function`);
  }
  if (!Number.isInteger(spec.schemaVersion) || spec.schemaVersion < 1) {
    throw new TypeError(`registerWriter(${writerId}): schemaVersion must be a positive integer`);
  }
  if (spec.rowKey !== undefined && typeof spec.rowKey !== 'function') {
    throw new TypeError(`registerWriter(${writerId}): rowKey must be a function when present`);
  }
  _registry.set(writerId, {
    schemaVersion: spec.schemaVersion,
    rowKey: spec.rowKey ?? null,
    replay: spec.replay,
  });
}

/** Registered writer ids — the call-site oracle reads this. */
export function registeredWriters() { return [..._registry.keys()]; }

/** Test seam: drop all registrations. Never called in production. */
export function _resetRegistry() { _registry.clear(); }

function spillDir(repoRoot) { return path.join(repoRoot, SPILL_DIR); }
function lostDir(repoRoot) { return path.join(spillDir(repoRoot), LOST_SUBDIR); }

/**
 * Content-derived artifact name. Stable for one payload, so a retry of the same
 * write reuses its envelope rather than accumulating duplicates.
 */
function fingerprintFor(writerId, payload) {
  const h = crypto.createHash('sha256')
    .update(JSON.stringify([writerId, payload]))
    .digest('hex').slice(0, 32);
  return `${writerId.replace(/[^A-Za-z0-9._-]/g, '-')}-${h}`;
}

/**
 * Perform a durable audit-store write.
 *
 * Write-ahead: the envelope lands on disk BEFORE the attempt, so a process that
 * dies mid-write leaves evidence. Spill-on-failure would not — that window is
 * exactly the one worth covering.
 *
 * NEVER throws for a store failure: the store is optional by design (AGENTS.md
 * graceful degradation), and an audit that produced findings must not fail
 * because it could not record them. It throws only for programmer error — an
 * unregistered writer id.
 *
 * @param {string} writerId
 * @param {object} payload
 * @param {{repoRoot?: string}} [opts]
 * @returns {Promise<{outcome:'written'|'spilled'|'lost', writerId:string, error?:string}>}
 */
export async function durableWrite(writerId, payload, { repoRoot = process.cwd() } = {}) {
  const spec = _registry.get(writerId);
  if (!spec) {
    // Programmer error, not a store failure: a write nobody can replay is
    // exactly the silent loss this module exists to stop, so it is loud.
    throw new Error(
      `durableWrite: no writer registered for "${writerId}". `
      + `Register it in scripts/lib/audit-store-writers.mjs (registered: ${registeredWriters().join(', ') || 'none'}).`,
    );
  }

  const fingerprint = fingerprintFor(writerId, payload);
  assertSafeFingerprint(fingerprint);
  const envelope = {
    v: AUDIT_ENVELOPE_VERSION,
    fingerprint,
    writerId,
    schemaVersion: spec.schemaVersion,
    enqueuedAt: new Date().toISOString(),
    payload,
  };

  // Admission cap (decision 4). Checked BEFORE the write-ahead envelope, so a
  // full queue refuses new work rather than growing without bound. Refusing
  // means this write is `lost` — honest, and visible in the counters — whereas
  // evicting an older artifact would silently discard a payload that never
  // reached the store.
  const admission = checkAdmission(repoRoot);
  if (!admission.ok) {
    try {
      const res = await spec.replay(payload);
      if (res?.applied === true) return { outcome: 'written', writerId };
    } catch { /* fall through */ }
    return { outcome: 'lost', writerId, error: admission.reason };
  }

  let file = null;
  try {
    file = writeEnvelope(spillDir(repoRoot), envelope);
  } catch (err) {
    // Cannot even record the intent. Attempt the write anyway — a successful
    // write with no envelope is strictly better than skipping it — but the
    // failure outcome is `lost`, because nothing on disk could carry it.
    try {
      const res = await spec.replay(payload);
      if (res?.applied === true) return { outcome: 'written', writerId };
    } catch { /* fall through to lost */ }
    return { outcome: 'lost', writerId, error: `spill unavailable: ${err?.code || err?.message}` };
  }

  try {
    const res = await spec.replay(payload);
    if (res?.applied === true) {
      fs.rmSync(file, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
      return { outcome: 'written', writerId };
    }
    return retainOrLose(spec, file, repoRoot, writerId, 'not applied');
  } catch (err) {
    return retainOrLose(spec, file, repoRoot, writerId, err?.message || 'threw');
  }
}

/**
 * The retention/eligibility split. A writer with a `rowKey` keeps its envelope
 * in the replay queue; one without is moved to `lost/`, where it is preserved
 * as evidence but never replayed.
 */
function retainOrLose(spec, file, repoRoot, writerId, why) {
  if (spec.rowKey) return { outcome: 'spilled', writerId, error: why };
  try {
    const dest = lostDir(repoRoot);
    fs.mkdirSync(dest, { recursive: true });
    let target = path.join(dest, path.basename(file));
    for (let n = 1; fs.existsSync(target); n++) target = `${path.join(dest, path.basename(file))}.${n}`;
    fs.renameSync(file, target);
  } catch { /* the envelope stays in spill/; the drain will quarantine it */ }
  return { outcome: 'lost', writerId, error: why };
}

/**
 * Is there room for one more artifact?
 *
 * Counts BOTH files and bytes; `*.tmp` is excluded because `atomicWriteFileSync`
 * writes through one and it is not queue content. An unreadable directory
 * admits (the write-ahead attempt will fail loudly on its own) rather than
 * refusing work on a stat error.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkAdmission(repoRoot, limits = spillConfig) {
  let files = 0, bytes = 0;
  try {
    for (const n of fs.readdirSync(spillDir(repoRoot))) {
      if (!n.endsWith('.json')) continue;   // skips *.tmp and the lost/ dir
      files++;
      try { bytes += fs.statSync(path.join(spillDir(repoRoot), n)).size; } catch { /* raced */ }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') return { ok: true };   // unreadable — do not refuse on a stat error
    return { ok: true };
  }
  if (files >= limits.maxFiles) {
    return { ok: false, reason: `spill queue full: ${files} files >= ${limits.maxFiles}` };
  }
  if (bytes >= limits.maxBytes) {
    return { ok: false, reason: `spill queue full: ${bytes} bytes >= ${limits.maxBytes}` };
  }
  return { ok: true };
}

/**
 * Is this failure about the CONNECTION or about the ARTIFACT?
 *
 * The distinction is the whole retry policy. `normalizePostgresError` marks
 * `ECONNREFUSED` and friends `transient` — a true statement about the store
 * that says nothing about the payload. Charging it to the artifact is how one
 * outage retires a healthy backlog: three outage-time drains, three attempts
 * burned on every artifact, everything quarantined for a reason that was never
 * the data's fault.
 *
 * @returns {boolean} true ⇒ abort the drain, increment nothing
 */
export function isConnectionScoped(err) {
  // `normalizePostgresError` cannot answer this on its own, and assuming it
  // could was the first version of this function. It marks BOTH
  // `ECONNREFUSED` and `40001` (serialisation failure) as `transient` —
  // correctly, since both are worth retrying — but one means "the store is
  // gone" and the other means "this transaction lost a race". Treating a
  // deadlock as an outage aborts a drain that should have continued; treating
  // an outage as a bad row burns the backlog's retry budget. The plan names
  // serialisation failure as artifact-scoped explicitly.
  //
  // So discriminate on the SCOPE the code describes:
  const code = String(err?.code || '');
  if (/^E[A-Z]+$/.test(code)) {
    // Node syscall code — the socket never got there. Defer to the classifier
    // for whether it is retryable at all (EACCES is not an outage).
    return normalizePostgresError(err).reason === 'transient';
  }
  // SQLSTATE class 08 is `connection_exception`; 57P01/02/03 are the server
  // telling us it is shutting down or terminating the backend. Both are "the
  // store went away". Class 40 (40001 serialisation, 40P01 deadlock), class 23
  // (integrity) and class 22 (data) are all about THIS statement.
  return code.startsWith('08') || /^57P0[123]$/.test(code);
}

/** Artifact states are exactly: pending → (applied ∧ deleted) | quarantined. */
function quarantine(repoRoot, held, name, envelope, lastError) {
  const dir = path.join(spillDir(repoRoot), REJECTED_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, name);
  for (let n = 1; fs.existsSync(dest); n++) dest = `${path.join(dir, name)}.${n}`;
  // Record WHY. A quarantined artifact with no cause is evidence nobody can act
  // on — the operator has to guess whether it is poison or collateral.
  fs.writeFileSync(dest, `${JSON.stringify({ ...envelope, quarantinedAt: new Date().toISOString(), lastError }, null, 2)}\n`);
  // Remove the CLAIM, not the producer-facing name — that name no longer exists
  // at this point, and taking ownership of the claim is what stops the core
  // handing the artifact straight back into the queue.
  fs.rmSync(held, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
}

/**
 * Drain the replay queue.
 *
 * @param {{repoRoot?: string, cap?: number, isCloudEnabled?: () => Promise<boolean>|boolean,
 *          isConnectionError?: (e:unknown)=>boolean, isTracked?: (f:string)=>boolean}} [opts]
 * @returns {Promise<{state:string, drained:number, rejected:number, failed:number, reason?:string}>}
 */
export async function drainSpill({
  repoRoot = process.cwd(), cap = DRAIN_CAP, isCloudEnabled,
  isConnectionError, isTracked,
} = {}) {
  const nothing = { state: 'empty', drained: 0, rejected: 0, failed: 0 };

  // An EMPTY registry is a bootstrap failure, not "nothing to do". Without this
  // the operator CLI — a fresh process that forgot to import the writers
  // module — would quarantine every artifact as an unknown writerId.
  if (_registry.size === 0) {
    return { ...nothing, state: 'unavailable', reason: 'no writers registered (import audit-store-writers.mjs)' };
  }

  // Draining with the store off would call replay, get a non-applied result for
  // every artifact, and churn. Worse, an early-returning writer that resolved
  // truthy would delete undelivered data — the defect the plan's gate caught.
  if (isCloudEnabled && !(await isCloudEnabled())) {
    return { ...nothing, state: 'unavailable', reason: 'cloud disabled — nothing can be applied' };
  }

  // The operator drain and the run-start drain are two writers over one
  // directory — decision 4's self-contradiction, which the audit caught. Reuse
  // the repo's existing lock (stale detection, PID liveness, corrupted-lock
  // recovery already solved there) rather than writing a second one.
  const lockPath = path.join(spillDir(repoRoot), '.drain.lock');
  fs.mkdirSync(spillDir(repoRoot), { recursive: true });
  try {
    return await withFileLock(lockPath, { maxWaitMs: 5000 }, () =>
      drainLocked({ repoRoot, cap, isConnectionError, isTracked }));
  } catch (err) {
    // Losing the lock race is not a failure — another drain is doing the work.
    // Reporting it as `unavailable` keeps it distinct from an empty queue.
    return { ...nothing, state: 'unavailable', reason: `drain lock unavailable: ${err?.message || err}` };
  }
}

async function drainLocked({ repoRoot, cap, isConnectionError, isTracked }) {
  return drainEnvelopes({
    dir: spillDir(repoRoot),
    cap,
    isConnectionError: isConnectionError ?? isConnectionScoped,
    parse: (text) => {
      const frame = parseEnvelopeFrame(text, {
        version: AUDIT_ENVELOPE_VERSION,
        validatePayload: () => true,
      });
      if (!frame) return null;
      const spec = _registry.get(frame.writerId);
      // Unknown writer or a schema this build does not speak: quarantine, never
      // guess. Both are "a later build wrote this", not "discard it".
      if (!spec || frame.schemaVersion !== spec.schemaVersion) return null;
      return frame;
    },
    apply: async (envelope, ctx) => {
      const name = `${envelope.fingerprint}.json`;
      // `ctx.file` is the CLAIMED path — the file the drain actually holds. The
      // producer-facing name no longer exists at this point, so dispositioning
      // by that name would rewrite nothing and quarantine nothing.
      const held = ctx?.file ?? path.join(spillDir(repoRoot), name);
      // Provenance, not just shape. A git-TRACKED artifact cannot have been
      // written by a runtime drain into a gitignored directory — it arrived by
      // `git add -f`, so it is not ours and schema validity says nothing about
      // that. Refusing it is cheap and keys on a property an attacker
      // committing a file cannot avoid producing.
      if (isTracked?.(path.join(spillDir(repoRoot), name))) return false;
      const spec = _registry.get(envelope.writerId);
      if (!spec) return false;

      try {
        const res = await spec.replay(envelope.payload);
        if (res?.applied === true) return true;
        // A clean "not applied" (cloud off mid-drain, a declining adapter) is
        // NOT the artifact's fault, so it does not consume the retry budget.
        return false;
      } catch (err) {
        // Connection-scoped → rethrow so the CORE aborts the whole drain. The
        // remaining artifacts are fine and must keep their attempts.
        if (isConnectionScoped(err)) throw err;

        // Artifact-scoped. A permanent error (constraint violation, bad input)
        // will fail identically forever, so it quarantines on the FIRST failure
        // rather than burning the budget to reach the same place.
        const norm = normalizePostgresError(err);
        const attempts = (Number.isInteger(envelope.attempts) ? envelope.attempts : 0) + 1;
        const permanent = norm.retryable === false;

        if (permanent || attempts >= spillConfig.maxAttempts) {
          quarantine(repoRoot, held, name, { ...envelope, attempts },
            `${permanent ? 'permanent' : `exhausted after ${attempts}`}: ${norm.operatorHint || err?.message}`);
          return false;
        }
        // Retryable and budget remains: persist the incremented count so the
        // next drain — a different process — can see it. An in-memory counter
        // would reset every invocation and the budget would never be reached.
        try {
          // Rewrite the CLAIMED file: the core hands it back under the original
          // name when apply returns false, so the incremented count survives.
          fs.writeFileSync(held, `${JSON.stringify({ ...envelope, attempts, lastError: norm.operatorHint || String(err?.message || err) }, null, 2)}
`);
        } catch { /* the artifact is still queued at its old count */ }
        return false;
      }
    },
  });
}

/**
 * What is sitting in the queue, and how old is the oldest.
 *
 * Reported so a run that spilled SAYS so. A count that only ever appears in a
 * log line is the shape this plan exists to replace.
 *
 * @param {{repoRoot?: string}} [opts]
 * @returns {{state:'ok'|'unavailable', spilled:number, lost:number, oldestAgeMs:number|null, reason?:string}}
 */
export function spillSummary({ repoRoot = process.cwd() } = {}) {
  const count = (dir) => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    } catch (err) {
      if (err?.code === 'ENOENT') return 0;
      return null;   // unreadable — distinct from empty
    }
  };
  const spilled = count(spillDir(repoRoot));
  const lost = count(lostDir(repoRoot));
  if (spilled === null || lost === null) {
    return { state: 'unavailable', spilled: 0, lost: 0, oldestAgeMs: null, reason: 'spill directory unreadable' };
  }

  let oldest = null;
  try {
    for (const n of fs.readdirSync(spillDir(repoRoot))) {
      if (!n.endsWith('.json')) continue;
      const { mtimeMs } = fs.statSync(path.join(spillDir(repoRoot), n));
      if (oldest === null || mtimeMs < oldest) oldest = mtimeMs;
    }
  } catch { /* counted above; age is best-effort */ }

  return {
    state: 'ok',
    spilled,
    lost,
    oldestAgeMs: oldest === null ? null : Math.max(0, Date.now() - oldest),
  };
}
