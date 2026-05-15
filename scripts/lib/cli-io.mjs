/**
 * @fileoverview Shared CLI / I/O micro-helpers.
 *
 * These one-liners were independently copy-pasted across many scripts
 * (the `arch:duplicates` detector flagged them). Consolidated here so
 * there is a single source of truth — DRY without ceremony.
 *
 * @module scripts/lib/cli-io
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Write a JSON object to stdout followed by a newline. The standard
 * machine-readable output line for the repo's CLIs (stderr stays free
 * for human progress logging).
 * @param {unknown} obj
 */
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Create a directory recursively, tolerating a pre-existing path.
 * @param {string} dir
 */
export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * SHA-256 of a buffer/string, hex, truncated. Default 12 chars — enough
 * to make collisions negligible for content-identity use (skill-copy
 * sync, audit-ref sync).
 * @param {import('node:crypto').BinaryLike} buf
 * @param {number} [len=12]
 * @returns {string}
 */
export function sha(buf, len = 12) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, len);
}

/**
 * Error thrown by CLI argv parsers. Carries `code: 'ARGV_ERROR'` so the
 * entry point can distinguish a usage mistake from a runtime failure.
 */
export class ArgvError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ARGV_ERROR';
    this.name = 'ArgvError';
  }
}
