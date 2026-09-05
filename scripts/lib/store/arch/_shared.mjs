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

/**
 * The retention rule for a copy-forward, as a PURE function over rows.
 *
 * ONE rule, used by both copy-forward paths (`copyForwardUntouchedFiles` here
 * and `copyForwardImports` in `imports.mjs`). They previously carried two
 * spellings of the same two predicates, keyed on different columns, and the
 * ownership fix has to reach BOTH: dropping a disowned file's symbols while
 * carrying its edges leaves `symbol_file_imports` — the table that generates
 * `.audit-loop/domain-deps-observed.json`, the OBSERVED evidence layer — still
 * attributing another codebase's imports to this repo.
 *
 * Each predicate is independently sufficient to EXCLUDE a row; none of them
 * firing retains it.
 *
 * `isDisowned` is nullable and its absence means CARRY EVERYTHING. That is not
 * a convenience default: `disowned-paths.mjs` degrades to an EMPTY set with
 * `degraded: true` when git is unavailable, and an empty set there means
 * "nothing was checked", never "nothing is disowned". A caller that cannot
 * answer the ownership question passes `null` and gets the pre-fix carry —
 * deleting index rows on an unanswered question is worse than the bug.
 *
 * @param {object[]} rows
 * @param {{pathOf?: (r: object) => string, touchedFileSet: Set<string>,
 *   fileStillExists?: ((p: string) => boolean)|null,
 *   isDisowned?: ((p: string) => boolean)|null}} opts
 * @returns {object[]} the rows to carry (input not mutated)
 */
export function retainCarriedRows(rows, { pathOf = (r) => r.file_path, touchedFileSet, fileStillExists = null, isDisowned = null } = {}) {
  return rows.filter((r) => {
    const p = pathOf(r);
    if (touchedFileSet.has(p)) return false;
    if (fileStillExists && !fileStillExists(p)) return false;
    if (isDisowned && isDisowned(p)) return false;
    return true;
  });
}

/**
 * Format a JS number[] as a pgvector literal `[0.1,0.2,...]`. The generic
 * `upsert()` helper serialises arrays as Postgres text-arrays `{"0.1",...}`
 * which pgvector rejects (`invalid input syntax for type vector`). Inline
 * formatter keeps recordSymbolEmbedding self-contained without leaking
 * pgvector knowledge into the generic db layer.
 */
export function vectorLiteral(embedding, expectedDim) {
  if (!Array.isArray(embedding)) {
    throw new TypeError('recordSymbolEmbedding: vector must be number[]');
  }
  // A validator that silently disables itself on an unexpected ARGUMENT type is
  // not a validator. `typeof expectedDim === 'number'` skipped the check
  // entirely for a string dimension — and env-derived config is exactly where a
  // '768' arrives — so a wrong-width vector would reach pgvector as a silent
  // write. Absent still means "do not check"; PRESENT now always checks, and an
  // uninterpretable value is an error rather than a skip.
  if (expectedDim !== null && expectedDim !== undefined) {
    const dim = typeof expectedDim === 'number' ? expectedDim : Number(expectedDim);
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new TypeError(`recordSymbolEmbedding: expectedDim must be a positive integer, got ${JSON.stringify(expectedDim)}`);
    }
    if (embedding.length !== dim) {
      throw new RangeError(`recordSymbolEmbedding: vector has ${embedding.length} dims, expected ${dim}`);
    }
  }
  for (let i = 0; i < embedding.length; i++) {
    const v = embedding[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError(`recordSymbolEmbedding: vector[${i}] is not finite (${v})`);
    }
  }
  return `[${embedding.join(',')}]`;
}
