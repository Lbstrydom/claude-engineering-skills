/**
 * @fileoverview Persist + read the `--verify` live-result artifact so the
 * dashboard can show the authoritative live verdicts (pass/misplaced/missing),
 * not just the static scorecard (plan v1.1 §12 / v1.2 boundary, closed).
 *
 * Mirrors envelope.mjs: gitignored Category-A artifact, atomic write, Zod-
 * validated read, rejected as stale when the contract digest moved. The CLI
 * writes it after a successful `--verify`; collect-nav.mjs reads it.
 *
 * @module scripts/lib/nav/verify-store
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { NavVerifyResultSchema, VERIFY_RESULT_FILE } from './schema.mjs';

/**
 * Atomically write the live-verify result. Validated before write.
 * @param {string} root
 * @param {object} result - must satisfy NavVerifyResultSchema
 * @returns {string} path written
 */
export function writeVerifyResult(root, result) {
  const parsed = NavVerifyResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`refusing to write invalid nav-verify-result: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  const file = path.join(root, VERIFY_RESULT_FILE);
  atomicWriteFileSync(file, JSON.stringify(parsed.data, null, 2));
  return file;
}

/**
 * Read + validate the live-verify result, rejecting it as stale when its
 * contract digest no longer matches the live contract.
 * @param {string} root
 * @param {string} expectedContractDigest
 * @returns {{result: object|null, rejectedReason: string|null}}
 */
export function readVerifyResult(root, expectedContractDigest) {
  const file = path.join(root, VERIFY_RESULT_FILE);
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); }
  catch (err) { return { result: null, rejectedReason: err.code === 'ENOENT' ? null : `verify-result unreadable: ${err.message}` }; }
  let parsed;
  try { parsed = NavVerifyResultSchema.safeParse(JSON.parse(raw)); }
  catch (err) { return { result: null, rejectedReason: `verify-result malformed: ${err.message}` }; }
  if (!parsed.success) return { result: null, rejectedReason: `verify-result failed schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  if (expectedContractDigest && parsed.data.contractDigest !== expectedContractDigest) {
    return { result: null, rejectedReason: 'verify-result stale: contract changed since the last --verify — re-run --verify' };
  }
  return { result: parsed.data, rejectedReason: null };
}
