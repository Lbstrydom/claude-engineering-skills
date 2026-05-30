/**
 * @fileoverview Runtime pgvector availability + embedding-column probes.
 *
 * Plan: docs/plans/security-strategy-postgres-port.md §4.5.
 *
 * The security_incidents `embedding` column and the neighbourhood RPC only
 * exist when pgvector is installed. Two independent facts matter and both are
 * cached per process:
 *   1. pgvectorAvailable() — the `vector` extension is loaded.
 *   2. securityEmbeddingColumnExists() — the `embedding` column was actually
 *      added to security_incidents (the extension can be installed AFTER the
 *      migration ran, leaving the column absent — see plan Phase 2.3).
 *
 * Writers must check BOTH before including `embedding` in an INSERT/UPSERT.
 *
 * @module scripts/lib/security/pgvector-check
 */

let _vectorCached = null;
let _columnCached = null;

/**
 * @param {import('pg').Pool} pool
 * @returns {Promise<boolean>} true when the `vector` extension is installed.
 */
export async function pgvectorAvailable(pool) {
  if (_vectorCached !== null) return _vectorCached;
  try {
    const r = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    _vectorCached = r.rowCount > 0;
  } catch (err) {
    process.stderr.write(`  [pgvector-check] extension probe failed (treating as absent): ${err.message}\n`);
    _vectorCached = false;
  }
  return _vectorCached;
}

/**
 * @param {import('pg').Pool} pool
 * @returns {Promise<boolean>} true when security_incidents.embedding exists.
 */
export async function securityEmbeddingColumnExists(pool) {
  if (_columnCached !== null) return _columnCached;
  try {
    // Constrain to the public schema — the db layer pins search_path=public and
    // only supports the public schema, so an unqualified probe could otherwise
    // match a same-named column in another schema.
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'security_incidents' AND column_name = 'embedding'`
    );
    _columnCached = r.rowCount > 0;
  } catch (err) {
    // Treat as "feature absent" but surface the cause — a swallowed error here
    // would silently disable embeddings on a transient DB blip.
    process.stderr.write(`  [pgvector-check] embedding-column probe failed (treating as absent): ${err.message}\n`);
    _columnCached = false;
  }
  return _columnCached;
}

/**
 * Both facts together — the single gate writers should consult before
 * including `embedding` in a statement.
 * @param {import('pg').Pool} pool
 * @returns {Promise<boolean>}
 */
export async function embeddingsEnabled(pool) {
  return (await pgvectorAvailable(pool)) && (await securityEmbeddingColumnExists(pool));
}

/** Reset the per-process caches (test seam). */
export function _resetPgvectorCacheForTest() {
  _vectorCached = null;
  _columnCached = null;
}
