/**
 * @fileoverview The ship-train operation receipt — the single handoff from
 * planning (`prepare`) to execution (`land`, `verify`, `sync`), and the
 * checkpoint record that makes a partially-landed train recoverable.
 *
 * Plan: docs/plans/ship-trains.md §2.8 (receipt) and §2.9 (phases).
 *
 * Lives at `<git-common-dir>/fleet/ship-trains/<opId>.json`, beside fleet's own
 * train manifests: local, outside the work tree, never committed.
 *
 * Two discipline rules, both enforced here rather than trusted to callers:
 *   - The PLANNING fields (`IMMUTABLE_KEYS`) are write-once. `updateReceipt`
 *     refuses any mutation that changes them, and `readReceipt` refuses a file
 *     whose fingerprint no longer matches them. A material change means a new
 *     `prepare`, never a patched receipt.
 *   - Phase changes follow `TRANSITIONS`. An illegal move is refused, so a
 *     crashed or confused caller cannot skip verification or abandon a train
 *     that is already partly on main.
 *
 * Writes are atomic (temp + rename) under a per-op lock that REFUSES a second
 * writer rather than queueing it — the same posture as fleet's train lock.
 *
 * @module scripts/lib/ship-train/receipt
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';
import { withFileLockSync } from '../file-lock.mjs';

export const SCHEMA_VERSION = 1;
export const OP_ID_RE = /^s-\d{14}-[0-9a-f]{4}$/;
const OID = z.string().regex(/^[0-9a-f]{40}$/);
const PR = z.number().int().positive();

export const PHASES = Object.freeze([
  'prepared', 'log-opened', 'built', 'landing', 'landed',
  'verified', 'verified-interleaved', 'publishing',
  'done', 'partial', 'diverged', 'abandoned',
]);

/**
 * The only legal phase moves (§2.9). `abandoned` is reachable only before any
 * merge — after the first merge part of the train is on main, and the only
 * ways forward are resume or a human.
 *
 * An interrupted LANDING stays `landing` (resume reconciles each PR with
 * GitHub); `partial` is publication-only and returns only to `publishing`.
 * One shared `partial` for both used to let landing → partial → publishing
 * skip `landed` and verification entirely (round-1 code M4).
 */
export const TRANSITIONS = Object.freeze({
  prepared: ['log-opened', 'abandoned'],
  'log-opened': ['built', 'abandoned'],
  built: ['landing', 'abandoned'],
  landing: ['landed', 'diverged'],
  landed: ['verified', 'verified-interleaved'],
  verified: ['publishing'],
  'verified-interleaved': ['publishing'],
  publishing: ['done', 'partial'],
  partial: ['publishing'],
  diverged: [],
  done: [],
  abandoned: [],
});

/** Phases from which each mutable record must exist (phase-specific invariants). */
const REQUIRES = Object.freeze({
  logPr: ['log-opened', 'built', 'landing', 'landed', 'verified', 'verified-interleaved', 'publishing', 'partial', 'done'],
  trainId: ['built', 'landing', 'landed', 'verified', 'verified-interleaved', 'publishing', 'partial', 'done'],
  landingOrder: ['built', 'landing', 'landed', 'verified', 'verified-interleaved', 'publishing', 'partial', 'done'],
  verify: ['verified', 'verified-interleaved', 'publishing', 'partial', 'done'],
  publication: ['partial', 'done'],
});

export const IMMUTABLE_KEYS = Object.freeze([
  'schemaVersion', 'opId', 'createdAt', 'repo', 'destination', 'basePinning', 'selected', 'overrides', 'fingerprint',
]);

const Refusal = z.object({ code: z.string(), message: z.string(), override: z.string().nullable() }).strict();

const Decision = z.object({
  gate: z.enum(['passed', 'converged', 'waived', 'not-run']),
  runId: z.string().nullable(),
  auditedTree: OID.nullable(),
  models: z.array(z.string()).min(1),
  attributionMissing: z.array(z.string()),
  identityProvable: z.boolean(),
}).strict();

const Binding = z.object({
  kind: z.enum(['tree', 'ancestry', 'unbound', 'store-unavailable']),
  runId: z.string().nullable(),
  boundCommit: OID.nullable(),
  postAuditCommits: z.array(OID),
  reason: z.string().nullable(),
}).strict();

const Selected = z.object({
  pr: PR,
  title: z.string(),
  headOid: OID,
  mergeBaseOid: OID,
  tier: z.enum(['urgent', 'standard', 'ride-along']),
  reasons: z.array(z.string()),
  binding: Binding,
  decision: Decision,
}).strict();

const Claims = z.object({
  gate: z.enum(['passed', 'converged', 'waived', 'not-run']),
  runId: z.string().nullable(),
  auditedTree: OID.nullable(),
  models: z.array(z.string()).min(1),
}).strict();

const Actual = z.object({
  headOid: OID,
  baseOid: OID,
  basePinning: z.enum(['strict', 'none']),
  claims: Claims,
  subject: z.string(),
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
  bodyPath: z.string(),
  at: z.string(),
}).strict();

const VerifyRecord = z.object({
  at: z.string(),
  perPr: z.record(z.string(), z.object({ ok: z.boolean(), problems: z.array(z.string()) }).strict()),
  plannedVsActual: z.array(z.object({ pr: PR, planned: z.string(), actual: z.string() }).strict()),
  interleaved: z.array(z.object({ oid: OID, subject: z.string() }).strict()),
  finalMergeOid: OID.nullable(),
  publicationBlocked: z.boolean(),
  blockedReason: z.string().nullable(),
  orderOk: z.boolean(),
  observedOrder: z.array(PR),
}).strict();

export const ReceiptSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  opId: z.string().regex(OP_ID_RE),
  createdAt: z.string(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  destination: z.object({ ref: z.string().startsWith('refs/heads/'), expectedOid: OID }).strict(),
  basePinning: z.object({ verdict: z.enum(['strict', 'none']), evidence: z.string() }).strict(),
  selected: z.array(Selected).min(1),
  overrides: z.object({ waive: z.array(PR), allowUnaudited: z.array(PR), endOfDay: z.boolean() }).strict(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  phase: z.enum(PHASES),
  // ── mutable, appended by later steps ──
  logPr: z.object({ number: PR, headOid: OID }).strict().optional(),
  trainId: z.string().optional(),
  landingOrder: z.array(PR).optional(),
  actual: z.record(z.string(), Actual).optional(),
  merges: z.record(z.string(), z.object({ mergeOid: OID, observedHeadOid: OID, at: z.string() }).strict()).optional(),
  verify: VerifyRecord.optional(),
  // A re-verify whose result contradicts the recorded phase is kept HERE, beside
  // the original record, never written over it (round-5 code H1/H3): the old
  // record stays valid for its phase, and any revocation blocks publication.
  revocation: z.object({ at: z.string(), reason: z.string(), freshPhase: z.enum(['verified', 'verified-interleaved']), verify: VerifyRecord }).strict().optional(),
  publicationAmendment: z.object({ acceptedOids: z.array(OID), at: z.string() }).strict().optional(),
  publication: z.object({
    sync: z.record(z.string(), z.enum(['syncing', 'synced', 'failed-retryable', 'failed-terminal'])),
    syncPr: z.record(z.string(), z.enum(['syncing', 'synced', 'failed-retryable', 'failed-terminal'])),
  }).strict().optional(),
  history: z.array(z.object({ at: z.string(), phase: z.enum(PHASES), note: z.string() }).strict()),
}).strict();

export { Refusal as RefusalSchema };

export class ReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReceiptError';
    this.code = code;
  }
}

/** A fresh op id: `s-<yyyymmddhhmmss>-<4 hex>` (UTC) — fleet's train-id shape, `s-` prefix. */
export function newOpId(now = new Date()) {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `s-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Key-sorted JSON: one byte sequence per value, whatever the insertion order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** sha256 over the canonical planning fields, excluding the fingerprint itself. */
export function fingerprintOf(receipt) {
  const planning = {};
  for (const k of IMMUTABLE_KEYS) if (k !== 'fingerprint') planning[k] = receipt[k];
  return crypto.createHash('sha256').update(canonicalJson(planning)).digest('hex');
}

/** @param {string} gitCommonDir */
export function receiptDir(gitCommonDir) {
  return path.join(gitCommonDir, 'fleet', 'ship-trains');
}

/**
 * @param {string} gitCommonDir
 * @param {string} opId
 */
export function receiptPath(gitCommonDir, opId) {
  if (!OP_ID_RE.test(String(opId))) throw new ReceiptError('BAD_OP_ID', `invalid op id ${JSON.stringify(String(opId).slice(0, 80))} (expected s-<14 digits>-<4 hex>)`);
  return path.join(receiptDir(gitCommonDir), `${opId}.json`);
}

function validate(receipt) {
  const parsed = ReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ReceiptError('INVALID_RECEIPT', `receipt failed validation at ${first.path.join('.') || '(root)'}: ${first.message}`);
  }
  for (const [field, phases] of Object.entries(REQUIRES)) {
    if (phases.includes(parsed.data.phase) && parsed.data[field] === undefined) {
      throw new ReceiptError('INVALID_RECEIPT', `a receipt in phase ${parsed.data.phase} must carry ${field}`);
    }
  }
  if (parsed.data.phase === 'verified-interleaved' && parsed.data.verify.interleaved.length === 0) {
    throw new ReceiptError('INVALID_RECEIPT', 'phase verified-interleaved needs at least one interleaved commit in verify');
  }
  if (fingerprintOf(parsed.data) !== parsed.data.fingerprint) {
    throw new ReceiptError('FINGERPRINT_MISMATCH', 'receipt planning fields no longer match their fingerprint — it was edited after prepare; run prepare again');
  }
  return parsed.data;
}

function locked(gitCommonDir, opId, fn) {
  const file = receiptPath(gitCommonDir, opId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = withFileLockSync(`${file}.lock`, {}, fn);
  if (!r.ok) throw new ReceiptError('LOCKED', `op ${opId} is being written by another process — refused, not queued`);
  return r.value;
}

/**
 * Create a receipt in phase `prepared`. Refuses to overwrite an existing op.
 *
 * @param {string} gitCommonDir
 * @param {object} planning — every IMMUTABLE_KEYS field except `fingerprint`
 * @param {{now?: Date}} [opts]
 */
export function createReceipt(gitCommonDir, planning, { now = new Date() } = {}) {
  const receipt = { ...planning, phase: 'prepared', history: [{ at: now.toISOString(), phase: 'prepared', note: 'prepare' }] };
  receipt.fingerprint = fingerprintOf(receipt);
  const valid = validate(receipt);
  return locked(gitCommonDir, valid.opId, () => {
    const file = receiptPath(gitCommonDir, valid.opId);
    if (fs.existsSync(file)) throw new ReceiptError('EXISTS', `op ${valid.opId} already exists`);
    atomicWriteFileSync(file, `${JSON.stringify(valid, null, 2)}\n`);
    return valid;
  });
}

/**
 * @param {string} gitCommonDir
 * @param {string} opId
 */
export function readReceipt(gitCommonDir, opId) {
  const file = receiptPath(gitCommonDir, opId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new ReceiptError('NOT_FOUND', `no receipt for op ${opId}`);
    throw new ReceiptError('UNREADABLE', `receipt for op ${opId} is unreadable: ${err.code || err.message}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ReceiptError('INVALID_RECEIPT', `receipt for op ${opId} is not valid JSON`);
  }
  return validate(json);
}

/**
 * Read-modify-write under the lock. `mutate(draft)` edits a deep copy; the
 * result must keep every planning field byte-identical, move the phase only
 * along `TRANSITIONS`, and validate.
 *
 * @param {string} gitCommonDir
 * @param {string} opId
 * @param {(draft: object) => void} mutate
 * @param {{now?: Date, note?: string}} [opts]
 */
export function updateReceipt(gitCommonDir, opId, mutate, { now = new Date(), note = '' } = {}) {
  return locked(gitCommonDir, opId, () => {
    const before = readReceipt(gitCommonDir, opId);
    const draft = structuredClone(before);
    mutate(draft);
    for (const k of IMMUTABLE_KEYS) {
      if (canonicalJson(draft[k]) !== canonicalJson(before[k])) {
        throw new ReceiptError('IMMUTABLE_FIELD', `refusing to change planning field "${k}" of op ${opId} — run prepare again`);
      }
    }
    if (draft.phase !== before.phase) {
      if (!(TRANSITIONS[before.phase] ?? []).includes(draft.phase)) {
        throw new ReceiptError('ILLEGAL_TRANSITION', `op ${opId}: ${before.phase} → ${draft.phase} is not a legal move`);
      }
      draft.history = [...before.history, { at: now.toISOString(), phase: draft.phase, note }];
    }
    const valid = validate(draft);
    atomicWriteFileSync(receiptPath(gitCommonDir, opId), `${JSON.stringify(valid, null, 2)}\n`);
    return valid;
  });
}
