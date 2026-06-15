/**
 * @fileoverview Generic decision-logger primitive for the adaptive-learning
 * system.  Wraps every learnable decision point in the audit pipeline:
 * pass selection, convergence prediction, arch-memory band, auto-deferral,
 * quickfix hits.  Writes go to Supabase `learning_decisions` (service-role
 * only).  Reliability is provided by per-type bounded sub-queues, a
 * synchronous flush at audit-end, and an environment-aware outbox for
 * graceful degradation when the cloud is unavailable.
 *
 * Plan: docs/plans/adaptive-learning-phase-1-foundation.md §2 (decision-logger)
 * Master: docs/plans/adaptive-learning-v1.md §6 (file-level plan).
 *
 * @module scripts/lib/learning/decision-logger
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_QUEUE_CAP = 64;
// Validate strictly: an un-checked parseInt accepts `NaN`/`0`/negative/`"10abc"`,
// and `queue.length >= NaN` is ALWAYS false → the cap silently disappears and
// every queue grows unbounded (audit finding). Accept only a finite positive
// safe integer; otherwise warn once and fall back to the documented default.
function resolveQueueCap(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_QUEUE_CAP;
  const n = Number(raw); // Number() rejects "10abc" as NaN (parseInt would accept 10)
  if (!Number.isSafeInteger(n) || n < 1) {
    process.stderr.write(
      `  [decision-logger] WARNING: LEARNING_QUEUE_CAP_PER_TYPE="${raw}" is not a positive integer; ` +
      `falling back to ${DEFAULT_QUEUE_CAP}.\n`
    );
    return DEFAULT_QUEUE_CAP;
  }
  return n;
}
const PER_TYPE_QUEUE_CAP = resolveQueueCap(process.env.LEARNING_QUEUE_CAP_PER_TYPE);
const OUTBOX_DIR_DEFAULT = '.audit/learning-outbox';

// Decision-key field predicates — the single source of truth shared by
// validateInput() and buildDecisionKey() so the validation gate and the key
// builder agree byte-for-byte on what a well-formed key field is (audit R3-H).
// A clean key string is a non-empty trimmed string with NO ':' — the key
// delimiter. Rejecting ':' in caller-controlled id components stops a component
// from forging extra key segments and colliding with a different decision
// (audit R4 delimiter-injection finding). decisionType is separately constrained
// to VALID_DECISION_TYPES (also colon-free), so the joined key is unambiguous.
const _isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '' && !v.includes(':');
const _isKeyInt = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Read CI flag at CALL TIME (not module-load time) so tests can toggle the
 * env without module-cache invalidation, and so containers that set
 * `CI=true` after spawn (rare but possible) are detected correctly.
 * Audit-fix: address the captured-at-import-time defect.
 */
function isCiEnv() {
  return !!(process.env.CI || process.env.GITHUB_ACTIONS);
}

const VALID_DECISION_TYPES = Object.freeze([
  'pass_selection',
  'convergence_predict',
  'arch_memory_band',
  'auto_deferral',
  'needs_triage_route',
  'quickfix_hit',
  'author_tier',
]);

const STDERR_WARN_THROTTLE_MS = 1000;
const _lastWarnAt = new Map();

// ── Per-type sub-queues ────────────────────────────────────────────────────
// Each decision_type gets its own bounded FIFO queue.  High-frequency event
// types (e.g. auto_deferral) cannot evict low-frequency events (e.g.
// pass_selection — once per audit run).

const _queues = new Map();
const _droppedCounts = new Map();

function getQueue(decisionType) {
  let q = _queues.get(decisionType);
  if (!q) { q = []; _queues.set(decisionType, q); }
  return q;
}

function bumpDropped(decisionType) {
  _droppedCounts.set(decisionType, (_droppedCounts.get(decisionType) || 0) + 1);
}

function throttledWarn(key, msg) {
  const now = Date.now();
  const last = _lastWarnAt.get(key) || 0;
  if (now - last >= STDERR_WARN_THROTTLE_MS) {
    process.stderr.write(`[learning:decision-logger] ${msg}\n`);
    _lastWarnAt.set(key, now);
  }
}

// ── Validation ─────────────────────────────────────────────────────────────
//
// Pure JavaScript validation (no Zod dependency to keep the hot-path light).
// Throws on malformed input — callers MUST validate at API boundaries; this
// is the boundary.

class DecisionLoggerError extends Error {
  constructor(message, code) { super(message); this.code = code; this.name = 'DecisionLoggerError'; }
}

function validateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new DecisionLoggerError('input must be an object', 'BAD_INPUT');
  }
  const { decisionType, repoId, auditRunId, round, sequence, externalId, context, choice } = input;

  if (!decisionType || typeof decisionType !== 'string') {
    throw new DecisionLoggerError('decisionType is required', 'BAD_INPUT');
  }
  if (!VALID_DECISION_TYPES.includes(decisionType)) {
    throw new DecisionLoggerError(`unknown decisionType: ${decisionType}`, 'BAD_INPUT');
  }
  if (!context || typeof context !== 'object') {
    throw new DecisionLoggerError('context must be an object', 'BAD_INPUT');
  }
  if (!choice || typeof choice !== 'object') {
    throw new DecisionLoggerError('choice must be an object', 'BAD_INPUT');
  }

  // Schema CHECK: either fully audit-bound OR has external_id.  Mirror of the
  // SQL constraint `decision_key_audit_or_external`.  Key fields are validated
  // by TYPE + RANGE (not just truthiness) — a malformed auditRunId or a
  // negative/non-integer counter would produce a colliding or unstable
  // persistence key (audit R3-H).
  const auditBound = _isNonEmptyString(auditRunId) && _isKeyInt(round) && _isKeyInt(sequence);
  const externalBound = _isNonEmptyString(externalId);
  if (!auditBound && !externalBound) {
    throw new DecisionLoggerError(
      'must provide either (auditRunId:non-empty-string + round/sequence:non-negative-int) OR externalId:non-empty-string',
      'BAD_INPUT'
    );
  }
  if (repoId !== undefined && repoId !== null && typeof repoId !== 'string') {
    throw new DecisionLoggerError('repoId must be string|null', 'BAD_INPUT');
  }
}

// ── Decision-key derivation ────────────────────────────────────────────────
//
// Format MUST match the SQL CHECK constraint and the JS-side decision_key
// builder.  Both produce the same string for the same inputs, so audit-bound
// decisions and the stored-procedure-internal builder agree byte-for-byte.

export function buildDecisionKey({ decisionType, auditRunId, round, sequence, externalId }) {
  // decisionType must be a known, colon-free type even on the direct-call path
  // (recordDecision validates it upstream; this guards independent callers — audit R4).
  if (!VALID_DECISION_TYPES.includes(decisionType)) {
    throw new DecisionLoggerError(`unknown decisionType: ${decisionType}`, 'BAD_INPUT');
  }
  // Same type+range gate as validateInput (shared predicates) so the builder
  // never emits a key from malformed fields even if called directly (audit R3-H).
  if (_isNonEmptyString(auditRunId) && _isKeyInt(round) && _isKeyInt(sequence)) {
    return `${auditRunId}:${decisionType}:r${round}:s${sequence}`;
  }
  if (_isNonEmptyString(externalId)) {
    return `${decisionType}:${externalId}`;
  }
  throw new DecisionLoggerError('cannot build decision_key from input', 'BAD_INPUT');
}

/**
 * Deep canonicalisation: recursively sorts object keys so semantically
 * equivalent contexts hash identically, regardless of nested key order.
 * Arrays preserve insertion order (positional semantics).  Primitive
 * values are returned as-is.
 *
 * Audit-fix: prior implementation used `JSON.stringify(ctx, Object.keys(ctx).sort())`
 * which only acts as a top-level whitelist (replacer), not a recursive
 * sort — nested objects retained source key order.
 */
function _canonicalise(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(_canonicalise);
  const sortedKeys = Object.keys(value).sort();
  const out = {};
  for (const k of sortedKeys) out[k] = _canonicalise(value[k]);
  return out;
}

function canonicaliseContext(context) {
  return JSON.stringify(_canonicalise(context));
}

function contextHash(context) {
  return crypto.createHash('sha256').update(canonicaliseContext(context)).digest('hex');
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Enqueue a decision for asynchronous flushing.  Fire-and-forget — the
 * audit pipeline never blocks on cloud round-trips.
 *
 * @param {object} input
 * @param {string} input.decisionType - Must be in VALID_DECISION_TYPES
 * @param {string} [input.repoId]
 * @param {string} [input.auditRunId]
 * @param {number} [input.round]
 * @param {number} [input.sequence]
 * @param {string} [input.externalId] - For off-audit decisions (hit_id etc.)
 * @param {object} input.context
 * @param {object} input.choice
 * @param {object|null} [input.outcome]
 * @returns {string} the derived decision_key (caller may use it for backfill)
 */
export function recordDecision(input) {
  if (process.env.LEARNING_DISABLE === '1') return null;

  validateInput(input);
  const decisionKey = buildDecisionKey(input);
  const ctxHash = contextHash(input.context);

  const entry = {
    decisionKey,
    decisionType: input.decisionType,
    auditRunId: input.auditRunId ?? null,
    round: input.round ?? null,
    sequence: input.sequence ?? null,
    externalId: input.externalId ?? null,
    repoId: input.repoId ?? null,
    context: input.context,
    contextHash: ctxHash,
    choice: input.choice,
    outcome: input.outcome ?? null,
    enqueuedAt: new Date().toISOString(),
  };

  const queue = getQueue(input.decisionType);
  if (queue.length >= PER_TYPE_QUEUE_CAP) {
    // Drop the OLDEST entry of THIS type only.  Other types are not affected.
    queue.shift();
    bumpDropped(input.decisionType);
    throttledWarn(
      `cap:${input.decisionType}`,
      `queue cap reached for ${input.decisionType} (cap=${PER_TYPE_QUEUE_CAP}); dropped oldest`
    );
  }
  queue.push(entry);
  return decisionKey;
}

/**
 * Update the `outcome` of a previously-recorded decision by composite key.
 * Called once we know what the decision led to (e.g. how many findings
 * survived triage, whether a quickfix hit was accepted).
 *
 * @param {object} input
 * @param {string} input.decisionKey - From recordDecision return value
 * @param {object} input.outcome
 */
export function backfillOutcome({ decisionKey, outcome }) {
  if (process.env.LEARNING_DISABLE === '1') return;
  if (!decisionKey || typeof decisionKey !== 'string') {
    throw new DecisionLoggerError('decisionKey is required', 'BAD_INPUT');
  }
  if (!outcome || typeof outcome !== 'object') {
    throw new DecisionLoggerError('outcome must be an object', 'BAD_INPUT');
  }

  // Find the entry in the queue and mutate; if already flushed, enqueue an
  // outcome-only update (the store layer translates this into an UPDATE).
  for (const queue of _queues.values()) {
    for (const entry of queue) {
      if (entry.decisionKey === decisionKey) {
        entry.outcome = outcome;
        entry._isOutcomeOnly = false; // still a fresh-insert candidate
        return;
      }
    }
  }
  // Not in queue → enqueue as outcome-only update.  Store will translate to
  // UPDATE on `decision_key`.
  const updateEntry = {
    decisionKey,
    decisionType: '_outcome_update', // sentinel; routed differently by flush
    outcome,
    _isOutcomeOnly: true,
    enqueuedAt: new Date().toISOString(),
  };
  let q = _queues.get('_outcome_update');
  if (!q) { q = []; _queues.set('_outcome_update', q); }
  q.push(updateEntry);
}

/**
 * Drain all queues to the cloud (or outbox on failure).  Called at:
 *   - audit-run end
 *   - process.on('SIGINT')
 *   - process.on('beforeExit')
 *
 * @param {object} [opts]
 * @param {object} [opts.store] - learning-store-like {insertLearningDecision, backfillLearningOutcome, isCloudEnabled}
 * @param {string} [opts.outboxDir]
 * @returns {Promise<{flushed:number, dropped:number, outboxed:number, lostInCI:number}>}
 */
export async function flush({ store = null, outboxDir = OUTBOX_DIR_DEFAULT } = {}) {
  const summary = { flushed: 0, dropped: 0, outboxed: 0, lostInCI: 0, retained: 0 };
  for (const [, count] of _droppedCounts) summary.dropped += count;

  // Two-phase drain (H9 fix): stage entries WITHOUT clearing the queues, try
  // each write, then remove only the entries that succeeded (cloud or
  // outbox-or-CI-loss contract).  Entries whose persistence failed remain
  // in the queue so the next flush() can retry them.
  const staged = [];
  for (const [type, queue] of _queues) {
    for (let i = 0; i < queue.length; i += 1) {
      staged.push({ type, idx: i, entry: queue[i] });
    }
  }
  if (staged.length === 0) {
    _droppedCounts.clear();
    return summary;
  }

  const cloudEnabled = !!(store && typeof store.isCloudEnabled === 'function' && await store.isCloudEnabled());
  const inCi = isCiEnv();

  // Track per-queue retained indices so we can splice survivors back in.
  const retainPerQueue = new Map(); // type -> Set<idx>

  for (const { type, idx, entry } of staged) {
    const written = cloudEnabled ? await tryWrite(store, entry) : false;
    if (written) {
      summary.flushed += 1;
      continue;
    }
    if (inCi) {
      // Ephemeral CI runtime: sync-retry already attempted by tryWrite; count + log.
      // Per the v1 design (graceful degradation), lost-in-CI is acceptable telemetry
      // loss — the alternative (failing the audit on telemetry write failure) is worse.
      summary.lostInCI += 1;
      throttledWarn('ci-loss', `flush failed for ${entry.decisionKey} in CI; telemetry lost`);
      continue;
    }
    // Local runtime: try outbox.  If outbox fails, RETAIN the entry in-memory
    // for the next flush() attempt — never silently drop.
    const outboxOk = writeOutbox(entry, outboxDir);
    if (outboxOk) {
      summary.outboxed += 1;
    } else {
      summary.retained += 1;
      let retainSet = retainPerQueue.get(type);
      if (!retainSet) { retainSet = new Set(); retainPerQueue.set(type, retainSet); }
      retainSet.add(idx);
    }
  }

  // Rebuild queues from retained survivors only.  Drop everything else.
  for (const [type, queue] of _queues) {
    const retainSet = retainPerQueue.get(type);
    if (!retainSet) {
      queue.length = 0;
    } else {
      const survivors = [];
      for (let i = 0; i < queue.length; i += 1) {
        if (retainSet.has(i)) survivors.push(queue[i]);
      }
      queue.length = 0;
      for (const s of survivors) queue.push(s);
    }
  }

  _droppedCounts.clear();
  return summary;
}

/**
 * Replay outbox files into the cloud.  Idempotent via decision_key UNIQUE.
 * Run at audit-run START, before the new run accumulates decisions.
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {string} [opts.outboxDir]
 * @returns {Promise<{processed:number, succeeded:number, failed:number}>}
 */
export async function reconcileOutbox({ store, outboxDir = OUTBOX_DIR_DEFAULT } = {}) {
  const summary = { processed: 0, succeeded: 0, failed: 0 };
  if (!fs.existsSync(outboxDir)) return summary;
  if (!store || typeof store.isCloudEnabled !== 'function' || !await store.isCloudEnabled()) return summary;

  const files = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    summary.processed += 1;
    const fullPath = path.join(outboxDir, f);
    try {
      const entry = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      const written = await tryWrite(store, entry);
      if (written) {
        fs.unlinkSync(fullPath);
        summary.succeeded += 1;
      } else {
        summary.failed += 1;
      }
    } catch (err) {
      // Corrupt file — leave for human inspection.
      summary.failed += 1;
      throttledWarn('outbox-parse', `outbox file ${f} unreadable: ${err.message}`);
    }
  }
  return summary;
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function tryWrite(store, entry) {
  if (entry._isOutcomeOnly) {
    if (typeof store.backfillLearningOutcome !== 'function') return false;
    try {
      // CI sync-retry: 3 attempts with exponential backoff.
      return await retryWithBackoff(() => store.backfillLearningOutcome(entry));
    } catch {
      return false;
    }
  }
  if (typeof store.insertLearningDecision !== 'function') return false;
  try {
    return await retryWithBackoff(() => store.insertLearningDecision(entry));
  } catch {
    return false;
  }
}

async function retryWithBackoff(fn) {
  const delays = isCiEnv() ? [200, 600, 1800] : [0]; // local: one shot
  let lastErr;
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
    try {
      const result = await fn();
      // Treat truthy result OR { ok: true } as success.
      if (result === true) return true;
      if (result && typeof result === 'object' && result.ok === true) return true;
      lastErr = new Error('store reported failure');
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return false;
}

function writeOutbox(entry, outboxDir) {
  try {
    fs.mkdirSync(outboxDir, { recursive: true });
    const keyHash = crypto.createHash('sha256').update(entry.decisionKey).digest('hex').slice(0, 12);
    const ts = entry.enqueuedAt.replace(/[:.]/g, '-');
    const finalPath = path.join(outboxDir, `${ts}-${keyHash}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(entry));
    fs.renameSync(tmpPath, finalPath);
    return true;
  } catch (err) {
    throttledWarn('outbox-write', `outbox write failed for ${entry.decisionKey}: ${err.message}`);
    return false;
  }
}

// ── Lifecycle hooks ────────────────────────────────────────────────────────
// Auto-flush on signal/exit so the audit pipeline doesn't have to remember
// to call flush().  Callers can still call flush() explicitly to capture the
// summary card output.

let _hooksInstalled = false;
let _resolvedStore = null;
let _drainInFlight = null;

/**
 * Drain the queues and resolve when persistence (cloud OR outbox) is
 * confirmed.  Concurrent callers share the in-flight drain.  Used by both
 * SIGINT and beforeExit handlers, and by CLI entrypoints that explicitly
 * await drain before exit (H5 fix — async-aware shutdown contract).
 */
export async function drain({ store } = {}) {
  if (_drainInFlight) return _drainInFlight;
  _drainInFlight = (async () => {
    try {
      return await flush({ store: store ?? _resolvedStore });
    } finally {
      _drainInFlight = null;
    }
  })();
  return _drainInFlight;
}

export function installLifecycleHooks(store) {
  if (_hooksInstalled) return;
  _resolvedStore = store;
  // beforeExit fires when the event loop has no more work; we can run async
  // here and Node will wait until the promise settles before exiting.
  process.on('beforeExit', async () => {
    try { await drain({ store: _resolvedStore }); } catch { /* swallow */ }
  });
  // SIGINT: we explicitly delay process exit until drain completes.  If a
  // second SIGINT arrives during drain, fall through and exit.
  let sigintCount = 0;
  process.on('SIGINT', async () => {
    sigintCount += 1;
    if (sigintCount > 1) {
      process.stderr.write('[learning] second SIGINT — exiting without flush\n');
      process.exit(130);
    }
    process.stderr.write('[learning] SIGINT — draining queue (Ctrl-C again to skip)...\n');
    try { await drain({ store: _resolvedStore }); } catch { /* swallow */ }
    process.exit(130);
  });
  _hooksInstalled = true;
}

// ── Test-only helpers ──────────────────────────────────────────────────────
// Exposed for unit tests; production code should not depend on these.

export function _resetForTest() {
  _queues.clear();
  _droppedCounts.clear();
  _lastWarnAt.clear();
  _hooksInstalled = false;
  _resolvedStore = null;
}

// Exposed for unit tests (queue-cap validation) — see audit R3-M config finding.
export { resolveQueueCap as _resolveQueueCap };

export function _getStateForTest() {
  return {
    queueSizes: Object.fromEntries(
      [..._queues.entries()].map(([k, v]) => [k, v.length])
    ),
    droppedCounts: Object.fromEntries(_droppedCounts),
  };
}

export const _internals = Object.freeze({
  PER_TYPE_QUEUE_CAP,
  isCiEnv,
  VALID_DECISION_TYPES,
  contextHash,
  canonicaliseContext,
});
