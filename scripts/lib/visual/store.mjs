/**
 * @fileoverview Persistence for the gitignored Category-A artifacts (plan §7,
 * M4) — the observed envelope + the live verify-result + the drift-ledger cache.
 * Merges nav's envelope.mjs + verify-store.mjs into one module (right-sized).
 *
 * ALL writes go through atomicWriteFileSync (temp+rename — the drift ledger IS a
 * ledger); readers treat malformed JSON / digest-or-version mismatch as stale and
 * return null rather than crashing (mirrors nav's verify-store + envelope).
 *
 * @module scripts/lib/visual/store
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import {
  VisualObservedSchema, VisualVerifyResultSchema,
  OBSERVED_FILE, VERIFY_RESULT_FILE, DRIFT_LEDGER_FILE,
  VISUAL_VERIFY_TOOL_VERSION,
} from './schema.mjs';

// ── Observed envelope (static layer output) ─────────────────────────────────

/**
 * Read the observed envelope, rejecting a stale one whose configDigest no longer
 * matches the caller-recomputed digest.
 * @param {string} root
 * @param {string} expectedConfigDigest
 * @returns {{envelope: object|null, reason: string|null}}
 */
export function readObservedEnvelope(root, expectedConfigDigest) {
  let raw;
  try { raw = fs.readFileSync(path.join(root, OBSERVED_FILE), 'utf-8'); }
  catch { return { envelope: null, reason: `no ${OBSERVED_FILE}` }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { envelope: null, reason: 'observed envelope malformed JSON' }; }
  const r = VisualObservedSchema.safeParse(parsed);
  if (!r.success) return { envelope: null, reason: `observed envelope failed schema: ${r.error.issues[0]?.message ?? 'invalid'}` };
  if (expectedConfigDigest && r.data.configDigest !== expectedConfigDigest) {
    return { envelope: null, reason: 'observed envelope stale: config digest changed — re-run /visual-audit' };
  }
  return { envelope: r.data, reason: null };
}

/**
 * @param {string} root
 * @param {object} envelope - a VisualObserved-shaped object (validated before write)
 * @returns {{ok:boolean, error?:string}}
 */
export function writeObservedEnvelope(root, envelope) {
  const r = VisualObservedSchema.safeParse(envelope);
  if (!r.success) return { ok: false, error: `refusing to write invalid observed envelope: ${r.error.issues[0]?.message ?? 'invalid'}` };
  atomicWriteFileSync(path.join(root, OBSERVED_FILE), `${JSON.stringify(r.data, null, 2)}\n`);
  return { ok: true };
}

// ── Live verify-result ──────────────────────────────────────────────────────

/**
 * Read the live verify-result, rejecting it as stale on a contract-digest OR
 * tool-version mismatch (mirrors nav's readVerifyResult).
 * @param {string} root
 * @param {string} expectedContractDigest
 * @returns {{result: object|null, reason: string|null}}
 */
export function readVerifyResult(root, expectedContractDigest) {
  let raw;
  try { raw = fs.readFileSync(path.join(root, VERIFY_RESULT_FILE), 'utf-8'); }
  catch { return { result: null, reason: `no ${VERIFY_RESULT_FILE}` }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { result: null, reason: 'verify result malformed JSON' }; }
  const r = VisualVerifyResultSchema.safeParse(parsed);
  if (!r.success) return { result: null, reason: `verify result failed schema: ${r.error.issues[0]?.message ?? 'invalid'}` };
  if (expectedContractDigest && r.data.contractDigest !== expectedContractDigest) {
    return { result: null, reason: 'verify result stale: contract digest changed — re-run --verify' };
  }
  if ((r.data.toolVersion ?? null) !== VISUAL_VERIFY_TOOL_VERSION) {
    return { result: null, reason: 'verify result stale: tool version changed — re-run --verify' };
  }
  return { result: r.data, reason: null };
}

/**
 * @param {string} root
 * @param {object} result - a VisualVerifyResult-shaped object
 * @returns {{ok:boolean, error?:string}}
 */
export function writeVerifyResult(root, result) {
  const stamped = { ...result, toolVersion: VISUAL_VERIFY_TOOL_VERSION };
  const r = VisualVerifyResultSchema.safeParse(stamped);
  if (!r.success) return { ok: false, error: `refusing to write invalid verify result: ${r.error.issues[0]?.message ?? 'invalid'}` };
  atomicWriteFileSync(path.join(root, VERIFY_RESULT_FILE), `${JSON.stringify(r.data, null, 2)}\n`);
  return { ok: true };
}

// ── Drift-ledger cache (convenience only; cloud is source of truth) ──────────

export function readDriftLedger(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, DRIFT_LEDGER_FILE), 'utf-8'));
    return parsed && typeof parsed.firstSeen === 'object' ? parsed.firstSeen : {};
  } catch { return {}; }
}

export function writeDriftLedger(root, activeKeys, headCommitDate, prior = {}) {
  const firstSeen = {};
  for (const key of activeKeys) firstSeen[key] = prior[key] || headCommitDate;
  atomicWriteFileSync(path.join(root, DRIFT_LEDGER_FILE), `${JSON.stringify({ version: 1, firstSeen }, null, 2)}\n`);
  return firstSeen;
}
