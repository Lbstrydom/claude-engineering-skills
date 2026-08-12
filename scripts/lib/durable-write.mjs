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
 *   DECLINED (not tried)   → envelope deleted            → `skipped`
 *
 * The fourth outcome is not a softening of the other three — it exists because
 * they had no name for the store being OFF, which is a supported mode
 * (AGENTS.md: an unset `AUDIT_DB_URL` is local-only, not an error). Without it a
 * cloud-off run classified every write as `lost`: unbounded junk in `lost/`, and
 * `runStatus: 'incomplete'` on runs where nothing went wrong at all. A write
 * that was never attempted is not a write that failed, and calling it one is the
 * same false-signal class this module exists to remove, pointed the other way.
 * A writer signals it by resolving `{applied: false, declined: true}`.
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
import { spawnSync } from 'node:child_process';

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
function fingerprintFor(writerId, payload, spec) {
  const h = crypto.createHash('sha256')
    .update(JSON.stringify([writerId, payload]))
    .digest('hex').slice(0, 32);
  const base = `${writerId.replace(/[^A-Za-z0-9._-]/g, '-')}-${h}`;
  // A KEYED writer is idempotent by declaration, so content identity is the
  // right identity: a retry of the same write reuses its envelope instead of
  // accumulating duplicates.
  if (spec?.rowKey) return base;
  // A KEYLESS writer has no such guarantee. Two independent operations that
  // happen to carry equal payloads — two identical pass-stat batches, say — are
  // DIFFERENT operations, and collapsing them onto one filename silently
  // discards one piece of evidence. Disambiguate.
  return `${base}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
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
 * @returns {Promise<{outcome:'written'|'spilled'|'lost'|'skipped', writerId:string, error?:string}>}
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

  // The fingerprint is derived by serialising the payload, so a payload that
  // cannot be serialised (a cycle, a BigInt) throws HERE — before any store
  // attempt. That mattered the moment the orchestrator started awaiting these
  // calls: the sites it replaced were `.catch(log)`, so a throw that used to be
  // swallowed would now abort an audit that had already produced its findings.
  // A payload that cannot be written to disk is exactly `lost` by this module's
  // own definition, so classify it as such and still ATTEMPT the write — a
  // successful store write with no envelope beats skipping it.
  let fingerprint;
  try {
    fingerprint = fingerprintFor(writerId, payload, spec);
    assertSafeFingerprint(fingerprint);
  } catch (err) {
    try {
      const res = await spec.replay(payload);
      if (res?.applied === true) return { outcome: 'written', writerId };
    } catch { /* fall through to lost */ }
    return { outcome: 'lost', writerId, error: `payload not serialisable: ${err?.message || err}` };
  }
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
    if (res?.applied !== true && res?.declined === true) {
      // Nothing was attempted, so there is nothing to retain: the envelope
      // records an INTENT to write, and an intent the sink refused to receive is
      // not evidence of anything. Keeping it would grow `lost/` without bound on
      // every local-only run.
      try {
        fs.rmSync(file, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
      } catch { /* swept by the next drain's reclaim */ }
      return { outcome: 'skipped', writerId, error: res.reason };
    }
    if (res?.applied === true) {
      // Cleanup is OUTSIDE the attempt's failure path. If the write committed
      // and only the envelope removal failed, the operation SUCCEEDED — calling
      // it a failure would spill (or worse, `lost`) a write that is already in
      // the store. A leftover envelope is harmless: it is idempotent for a keyed
      // writer, and the drain's reclaim handles it.
      // NOTE: deliberately UNTESTED, and that is a disposition rather than an
      // oversight. `rmSync` with `force: true` does not throw for a missing
      // path, and on this platform Node opens with FILE_SHARE_DELETE so an open
      // handle does not block removal either — no injection reaches this catch.
      // The guard is kept because the classification it protects is important
      // (a committed write must not be reported as a failure) and it costs
      // nothing; the TEST for it was deleted, because one that passes with the
      // guard reverted is a false signal, not coverage.
      try {
        fs.rmSync(file, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
      } catch { /* the write landed; the envelope is swept later */ }
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
 * **Deliberately SYNCHRONOUS, and the cost is measured** (verification gate G1,
 * which called for an async rewrite on the grounds that this "will stall audit
 * runs and cause severe CPU spikes"). Measured 2026-08-12 on this platform with
 * the queue at its full 1000-file cap across `spill/`, `lost/` and `rejected/`:
 * **8.3 ms per call** (82.7 ms for 10). An audit run makes roughly ten of these
 * and each one precedes a store round trip of 10–1000 ms, so the worst case is
 * ~80 ms per run and the ordinary case — an empty queue — is a single failed
 * `stat`. Converting an exported, synchronously-tested helper to async to
 * recover 80 ms in the pathological case is the over-engineering side of the
 * right-sizing gate. Re-measure before revisiting: the number, not the shape of
 * the code, is what would justify the change.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkAdmission(repoRoot, limits = spillConfig) {
  // The queue AND its two evidence directories. `lost/` and `rejected/` are
  // append-only and nothing ever drains them, so counting only the top level —
  // as the first version did — leaves the actual unbounded growth invisible to
  // the very check meant to bound it (audit H9). Whatever the operator has to
  // clear by hand is what the cap must see.
  let files = 0, bytes = 0;
  const tally = (dir, recurse) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (recurse && (e.name === LOST_SUBDIR || e.name === REJECTED_SUBDIR)) tally(path.join(dir, e.name), false);
        continue;
      }
      if (!e.name.endsWith('.json')) continue;   // skips *.tmp
      files++;
      try { bytes += fs.statSync(path.join(dir, e.name)).size; } catch { /* raced */ }
    }
  };
  try {
    fs.statSync(spillDir(repoRoot));
  } catch {
    return { ok: true };   // absent or unreadable — do not refuse work on a stat error
  }
  tally(spillDir(repoRoot), true);
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
  // NO CODE AT ALL is not "not a connection error" (verification gate G2).
  // `normalizePostgresError` deliberately supports legacy `pg` wrappers that
  // strip `err.code` by matching the message instead — measured: a bare
  // `new Error('connect ECONNREFUSED 127.0.0.1:5432')` classifies `transient`
  // there while every branch below returns false for it. That gap sends a real
  // outage down the artifact-scoped path, which is the one thing this function
  // exists to prevent. Defer to the canonical classifier rather than growing a
  // second set of message patterns here: two spellings of "is the store down"
  // is how they drift apart.
  if (!code) return normalizePostgresError(err).reason === 'transient';
  // `[A-Z_]`, not `[A-Z]` (final gate G4): `EAI_AGAIN` — a DNS resolution
  // timeout, i.e. the store could not even be looked up — carries an
  // underscore and fell through to the artifact-scoped branch, where a
  // name-server blip would burn every queued artifact's retry budget. Measured:
  // the classifier calls it `transient`, so only this regex stood between it
  // and the right answer.
  if (/^E[A-Z_]+$/.test(code)) {
    // Node syscall code — the socket never got there. Defer to the classifier
    // for whether it is retryable at all (EACCES is not an outage).
    return normalizePostgresError(err).reason === 'transient';
  }
  // SQLSTATE class 08 is `connection_exception`; 57P01/02/03 are the server
  // telling us it is shutting down or terminating the backend. Class 53 is
  // `insufficient_resources` — 53100 disk full, 53200 out of memory, 53300 too
  // many connections, 53400 configuration limit — added by the final gate (G4).
  // Every one of those is a statement about the SERVER's capacity that will be
  // identical for every artifact behind it, which is the precise definition of
  // connection-scoped here; charging them to the data is how a capacity
  // incident quarantines a healthy backlog. Class 40 (40001 serialisation,
  // 40P01 deadlock), class 23 (integrity) and class 22 (data) remain about THIS
  // statement.
  return code.startsWith('08') || code.startsWith('53') || /^57P0[123]$/.test(code);
}

/**
 * Which artifacts in the spill directory are git-TRACKED?
 *
 * Provenance, not content (plan decision 2e). A legitimate spill artifact is
 * written at runtime into a gitignored directory, so it is never tracked;
 * `.gitignore` does not stop `git add -f`, which makes "it is ignored" a
 * convention rather than a control. Reasoning about the JSON's shape cannot
 * help — a hostile artifact would be perfectly well-formed. Tracked-ness keys on
 * a property whoever committed the file cannot avoid producing.
 *
 * ONE `git ls-files` for the whole directory, tested in memory afterwards. A
 * per-artifact `--error-unmatch` would be up to `cap` synchronous spawns per
 * drain (the plan's R2 LOW).
 *
 * Scoped by pathspec deliberately: an unscoped listing of a large repo can
 * exceed `spawnSync`'s 1 MiB `maxBuffer` and come back truncated, which for a
 * membership test reads as "nothing is tracked" — a silent fail-OPEN in a
 * security check. The pathspec bounds it to the queue, and the buffer is raised
 * anyway; a buffer overrun is reported as a failure, never as an empty set.
 *
 * @returns {{ok: true, tracked: Set<string>} | {ok: false, reason: string}}
 */
export function readTrackedSpillArtifacts(repoRoot) {
  const dir = spillDir(repoRoot);
  const res = spawnSync(
    'git', ['-C', repoRoot, 'ls-files', '-z', '--', dir],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.error) return { ok: false, reason: `git ls-files failed: ${res.error.code || res.error.message}` };
  // ENOBUFS arrives as a truncated stdout with a non-zero signal/status — treat
  // ANY non-zero exit as unverified rather than as an empty tracked set.
  if (res.status !== 0) {
    // …EXCEPT "this is not a git repository", which is not an unknown: nothing
    // in a non-repo can be git-tracked, so the empty set is the VERIFIED answer
    // and refusing to drain would be a false alarm. Disambiguated by a second
    // probe rather than by matching git's stderr prose, which is localised.
    // Only reached on the failure path, so the normal case stays one spawn.
    const probe = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--git-dir'], { encoding: 'utf-8' });
    if (probe.status !== 0) return { ok: true, tracked: new Set() };
    return { ok: false, reason: `git ls-files exited ${res.status ?? res.signal}: ${String(res.stderr || '').trim().slice(0, 200)}` };
  }
  const tracked = new Set(
    String(res.stdout || '').split('\0').filter(Boolean)
      // Paths come back repo-relative with forward slashes on every platform.
      .map((p) => path.basename(p)),
  );
  return { ok: true, tracked };
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

  // Provenance check (decision 2e). Resolved ONCE per drain and defaulted HERE
  // rather than at each call site: it was an optional injectable that nothing
  // supplied, so the refusal it describes was unimplemented for every real
  // caller. An injectable with no default is a control on paper only.
  //
  // Unverifiable provenance is `unavailable`, not "nothing is tracked". The
  // fail-open reading is the one that lets a planted artifact replay, and this
  // module already has the honest vocabulary for "I could not look" — the
  // artifacts stay on disk and the operator is told why.
  let trackedCheck = isTracked;
  if (!trackedCheck) {
    const tracked = readTrackedSpillArtifacts(repoRoot);
    if (!tracked.ok) {
      return { ...nothing, state: 'unavailable', reason: `provenance unverifiable: ${tracked.reason}` };
    }
    trackedCheck = (file) => tracked.tracked.has(path.basename(file));
  }

  // The operator drain and the run-start drain are two writers over one
  // directory — decision 4's self-contradiction, which the audit caught. Reuse
  // the repo's existing lock (stale detection, PID liveness, corrupted-lock
  // recovery already solved there) rather than writing a second one.
  const lockPath = path.join(spillDir(repoRoot), '.drain.lock');
  fs.mkdirSync(spillDir(repoRoot), { recursive: true });
  try {
    return await withFileLock(lockPath, { maxWaitMs: 5000 }, () =>
      drainLocked({ repoRoot, cap, isConnectionError, isTracked: trackedCheck }));
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
      // QUARANTINE it, do not merely decline (final gate G5). Returning false
      // hands the artifact back to the queue under its own name, so a planted
      // file would be re-examined and re-refused on every drain for ever —
      // occupying admission capacity and reading, in the counters, exactly like
      // a store that keeps failing. "Refused" has to be a terminal state or it
      // is not a control, just a delay.
      if (isTracked?.(path.join(spillDir(repoRoot), name))) {
        quarantine(repoRoot, held, name, envelope, 'git-tracked artifact refused: not written by a runtime drain');
        return false;
      }
      const spec = _registry.get(envelope.writerId);
      // Same reasoning: an unknown writerId is not going to become known by
      // being asked again. The parse step above already quarantines version and
      // id mismatches; this is the belt for a registry that changed mid-drain.
      if (!spec) {
        quarantine(repoRoot, held, name, envelope, `unknown writerId "${envelope.writerId}"`);
        return false;
      }

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
