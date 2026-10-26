/**
 * @fileoverview Identity helpers for the own-model ledger
 * (docs/plans/own-model-decision-ledger.md decisions 11, 13).
 *
 * - `mintWorkItemId()` / `mintEventId()`: UUIDv7 (time-ordered, so spool files
 *   sort in capture order by name).
 * - `observationEventId(parentEventId)`: a deterministic UUIDv5 so two sweepers,
 *   or a sweeper replaying after an outage, mint the SAME id and the
 *   `event_id UNIQUE` constraint collapses them.
 * - `workItemFromBranch(branch)`: the `wi-<uuidv7>` branch-name convention. A
 *   branch that does not carry one yields null — never a guess.
 *
 * @module scripts/lib/ledger/work-item
 */
import crypto from 'node:crypto';
import { UUIDV7 } from './schemas.mjs';

const hex = (buf) => buf.toString('hex');
const fmt = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;

/**
 * UUIDv7 (RFC 9562): 48-bit unix-ms timestamp, version 7, variant 10, 74 random bits.
 * @param {number} [nowMs]
 * @param {Buffer} [rand] 10 random bytes (tests inject)
 */
export function mintUuidV7(nowMs = Date.now(), rand = crypto.randomBytes(10)) {
  const ts = Buffer.alloc(6);
  ts.writeUIntBE(nowMs, 0, 6);
  const b = Buffer.concat([ts, rand]);          // 16 bytes
  b[6] = (b[6] & 0x0f) | 0x70;                  // version 7
  b[8] = (b[8] & 0x3f) | 0x80;                  // variant 10
  return fmt(hex(b));
}

export const mintWorkItemId = (nowMs, rand) => mintUuidV7(nowMs, rand);
export const mintEventId = (nowMs, rand) => mintUuidV7(nowMs, rand);

/** Fixed namespace for derived ledger event ids (a v4-shaped constant, never changes). */
export const LEDGER_NAMESPACE = '6f1c2b7e-8a4d-4c1e-9b3a-5d0e7f2a9c14';

/**
 * UUIDv5 (SHA-1, RFC 9562) of `name` under `namespace`.
 * @param {string} name
 * @param {string} [namespace]
 */
export function uuidV5(name, namespace = LEDGER_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;                  // version 5
  b[8] = (b[8] & 0x3f) | 0x80;                  // variant 10
  return fmt(hex(b));
}

/** Deterministic id of the single terminal observation of a merged event. */
export const observationEventId = (parentEventId) => uuidV5(`observe:${parentEventId}`);

/** True for a well-formed UUIDv7 (the work-item id grammar). */
export const isWorkItemId = (s) => typeof s === 'string' && UUIDV7.test(s);

/**
 * The work item named by a branch (`wi-<uuidv7>` anywhere as a path segment or
 * prefix), or null. Never a guess: no match, no id.
 * @param {string|null|undefined} branch
 * @returns {string|null}
 */
export function workItemFromBranch(branch) {
  if (typeof branch !== 'string') return null;
  const m = branch.match(/(?:^|[/_-])wi-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:$|[/_-])/);
  return m ? m[1] : null;
}

/** The PR-body footer convention: a line `Work-Item: <uuidv7>`; null when absent. */
export function workItemFromPrBody(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/^Work-Item:\s*([0-9a-f-]{36})\s*$/m);
  return m && isWorkItemId(m[1]) ? m[1] : null;
}

/**
 * The `work_item_id` patch for an audit run's convergence state from an env value:
 * `{}` when unset, `{work_item_id}` when it is a UUIDv7, and — for a value that IS set
 * but malformed — a LOUD stderr line and `{}`, so a mistyped id is never silently
 * dropped while the run reads as correlated.
 * @param {string|undefined} value
 */
export function ownModelWorkItemPatch(value) {
  if (!value) return {};
  if (isWorkItemId(value)) return { work_item_id: value };
  process.stderr.write(`  [own-model] OWN_MODEL_WORK_ITEM_ID is not a UUIDv7 (${JSON.stringify(String(value).slice(0, 60))}); this run is NOT correlated to a work item\n`);
  return {};
}
