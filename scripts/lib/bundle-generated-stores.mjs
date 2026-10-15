/**
 * @fileoverview The files this bundle WRITES INTO a consumer's repo and commits — data the tooling owns, not code under review.
 *
 * Since CES #247 the tech-debt ledger is one committed file per entry (`.audit/tech-debt/entries/<id>.json`), so an ordinary
 * migration PR touches hundreds of them. The adjacency preflight counted every one against `maxChangedFiles` and forced
 * INPUT_BOUND / PARTIAL on a diff of a handful of hand-written files (upstream 3b84d8bb).
 *
 * ## One list, owned by the writers
 *
 * The writers import their default location FROM here (`debt-ledger.mjs`'s `DEFAULT_DEBT_LEDGER_PATH`, `sync-receipt.mjs`'s
 * `RECEIPT_PATH`), so the writer and this classifier read one constant and a relocation moves both. A test resolves the
 * writer's real layout (`resolveLedgerLocation`) through `isBundleGeneratedStore` — drift detection, not enforcement: a
 * writer that re-hardcodes the same string cannot be seen, only one that moves.
 *
 * DEPENDENCY-FREE on purpose: `file-taxonomy.mjs` (itself dependency-free, imported by everything) consumes it.
 *
 * Out of scope (documented, not a regression): a ledger relocated with `--ledger` is not recognised.
 *
 * @module scripts/lib/bundle-generated-stores
 */

/** The ledger's one location descriptor. Both forms derive from it, exactly as `resolveLedgerLocation` derives them from any path. */
export const DEBT_LEDGER_STEM = '.audit/tech-debt';

/** Where the sync receipt lives, relative to the consumer root. */
export const SYNC_RECEIPT_PATH = '.sync-receipt.json';

/** @type {ReadonlyArray<Readonly<{path: string, kind: 'file'|'tree', writer: string}>>} */
export const BUNDLE_GENERATED_STORES = Object.freeze([
  Object.freeze({ path: `${DEBT_LEDGER_STEM}.json`, kind: 'file', writer: 'scripts/lib/debt-ledger.mjs' }),
  Object.freeze({ path: `${DEBT_LEDGER_STEM}/`, kind: 'tree', writer: 'scripts/lib/debt-ledger.mjs' }),
  Object.freeze({ path: SYNC_RECEIPT_PATH, kind: 'file', writer: 'scripts/lib/sync-receipt.mjs' }),
]);

/** Repo-relative, forward-slashed, lower-cased (the stores are matched case-insensitively, as git's `icase` does). */
function norm(relPath) {
  return String(relPath ?? '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Is `relPath` one of the bundle's own generated stores? Anchored at the repo root: `src/.audit/tech-debt.json` is not one.
 * @param {string} relPath repo-relative
 * @returns {boolean}
 */
export function isBundleGeneratedStore(relPath) {
  const p = norm(relPath);
  if (!p) return false;
  return BUNDLE_GENERATED_STORES.some((s) => {
    const sp = s.path.toLowerCase();
    return s.kind === 'tree' ? p.startsWith(sp) : p === sp;
  });
}

/**
 * Git pathspecs for the same set, so a `git diff` can partition at the source instead of re-deriving it from path text.
 * Rename detection then only ever pairs VISIBLE paths: store→visible reads as an addition, visible→store as a deletion.
 *
 * @param {{exclude?: boolean}} [opts] `exclude: true` yields the `:(exclude)` form (append after `'.'`); false the include form.
 * @returns {string[]}
 */
export function bundleStorePathspecs({ exclude = true } = {}) {
  const ex = exclude ? ',exclude' : '';
  return BUNDLE_GENERATED_STORES.map((s) => (s.kind === 'tree'
    ? `:(top,icase,glob${ex})${s.path}**`
    : `:(top,icase${ex})${s.path}`));
}
