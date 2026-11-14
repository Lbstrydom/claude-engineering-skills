/**
 * @fileoverview Which tooling LAYOUT is a bundled file installed under, and
 * where that layout's audit-loop migrations live.
 *
 * Leaf module: `node:path`/`node:url` only, so the DB write path, an offline
 * gate and the synced bundle can all load it without dragging a domain's
 * dependency graph along. Extracted from `lib/db/schema-realization.mjs`, which
 * had the only copy and re-exports these names unchanged — a second
 * implementation of this question is exactly the duplicate-classifier shape
 * AGENTS.md forbids by name, and the second caller (`check-windowed-views.mjs`)
 * arrived 2026-11-14.
 *
 * **First-existing-wins is not a fallback here — it is a coin flip.** An
 * ordered candidate list was correct in exactly one place: this repo, the only
 * one where just one of the two directories exists. Every consumer has BOTH —
 * `.audit-loop/migrations/` is the synced audit-loop schema, and
 * `supabase/migrations/` is the consumer's OWN app schema, unrelated by design.
 * Picking by existence there compares a consumer's app migrations against
 * audit-loop state; the full incident is in `schema-realization.mjs`'s header
 * and `docs/plans/green-but-unrealized.md`.
 *
 * @module scripts/lib/tooling-layout
 */

import path from 'node:path';

/**
 * The audit-loop migrations directory, repo-relative, **per layout**.
 *
 * Literals rather than an import of `sync-path-map` (the `install` domain):
 * this module is loaded on the DB query path and by offline gates, neither of
 * which may drag the installer's graph in. The literals are pinned by a test
 * that reads them FROM `sync-path-map`, so a rename there fails loudly rather
 * than silently resolving to nothing.
 */
export const MIGRATION_DIR_BY_LAYOUT = Object.freeze({
  source: 'supabase/migrations',
  consumer: '.audit-loop/migrations',
});

/** Consumer tooling lives here (`LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR`) — pinned by test. */
export const CONSUMER_TOOLING_SEGMENT = 'scripts/.claude-skills/';

/**
 * Which layout is the file at `moduleFilePath` installed under?
 *
 * Read off the file's own path, which is the fact that *determines* the answer
 * rather than a proxy for it: the sync maps `scripts/<rest>` →
 * `scripts/.claude-skills/<rest>`, so a copy under that segment is by
 * construction the synced audit-loop bundle. Probing the filesystem instead
 * asks a question whose two answers are both "yes" in a consumer.
 *
 * @param {string} moduleFilePath — the CALLER's own path; pass
 *   `fileURLToPath(import.meta.url)`, never this module's, or every caller
 *   inherits this file's location instead of its own. Injectable so a test can
 *   assert both layouts without relocating anything — the failure is invisible
 *   in this repo, which is the only place the old ordering happened to be
 *   right, and that is exactly why it shipped.
 * @returns {'source'|'consumer'}
 */
export function detectLayout(moduleFilePath) {
  return String(moduleFilePath).replace(/\\/g, '/').includes(CONSUMER_TOOLING_SEGMENT)
    ? 'consumer'
    : 'source';
}

/**
 * The repo-relative migrations directory for a layout.
 *
 * @param {'source'|'consumer'} layout
 * @returns {string}
 */
export function migrationsDirForLayout(layout) {
  const dir = MIGRATION_DIR_BY_LAYOUT[layout];
  if (!dir) throw new Error(`migrationsDirForLayout: unknown layout "${layout}"`);
  return dir;
}

/**
 * The migrations directory for the layout `moduleFilePath` is installed under,
 * resolved against a repo root.
 *
 * Repo roots themselves are `findRepoRootFromScript`'s job (it climbs to the
 * `scripts/` ancestor, which is correct in both layouts) — counting `..`
 * upwards is the fixed-depth climb that lands on `<consumer>/scripts`.
 *
 * @param {string} repoRoot — absolute
 * @param {string} moduleFilePath — the CALLER's own path
 * @returns {{layout: 'source'|'consumer', dir: string, abs: string}}
 */
export function resolveMigrationsLayout(repoRoot, moduleFilePath) {
  const layout = detectLayout(moduleFilePath);
  const dir = migrationsDirForLayout(layout);
  return { layout, dir, abs: path.join(repoRoot, dir) };
}
