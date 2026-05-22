/**
 * @fileoverview Arch-memory sub-module shared internals.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1).
 *
 * Narrowly scoped — only arch-specific constants + the chunk helper.
 * Per R2-M3: this module does NOT re-export generic db primitives.
 * Each sub-module imports `many`, `one`, `insertReturning`, `updateWhere`,
 * `upsert` directly from `'../../db/query.mjs'`, `getPool` from
 * `'../../db/client.mjs'`, and `isCloudEnabled` from `'../repo.mjs'`.
 * Keeping this file thin prevents it from becoming a new god-module
 * just one layer deeper.
 *
 * @module scripts/lib/store/arch/_shared
 */

export const UPSERT_CHUNK_SIZE = 500;
export const IN_CHUNK = 200;

/** Slice an array into chunks of `n` items. */
export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
