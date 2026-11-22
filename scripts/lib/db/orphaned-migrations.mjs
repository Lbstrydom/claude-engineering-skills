/**
 * @fileoverview "The store is behind this revision" - but is the missing migration REAL, or an orphan?
 *
 * Incident (2026-11-22): three migration files were retired upstream (and their store ledger rows removed) while six
 * consumers still held committed copies in `.audit-loop/migrations/`. Every consumer audit then refused with "database is
 * behind this revision: 3 migration(s) absent" and advised `--migrate`, which would have RE-APPLIED the retired files and
 * dropped three unique keys again. The advice was the hazard, not the refusal.
 *
 * A consumer's `.audit-loop/migrations/` is a SYNCED COPY of upstream's tracked migrations. A file there that the store
 * lacks is either genuinely new (apply it) or retired upstream (never apply it). The consumer can only know the second case
 * from its own sync receipt: when the sync retires a migration it cannot delete (the consumer edited it, or declared it in
 * `.sync-overrides.json`) it records the path under the latest entry's `retiredHeld`. Those are ORPHANED.
 *
 * Decision rule (one oracle for both refusal sites - the pre-spend gate and the write-path throw):
 *   - any missing file the latest receipt lists as `retiredHeld`  -> ORPHANED: no `--migrate` advice, point at the sync.
 *   - none, but `dir` is a synced copy (`.audit-loop/migrations`)  -> keep the command, add the retirement caveat (the
 *     consumer cannot see upstream, so it must not claim certainty either way).
 *   - otherwise (the source checkout's own tracked directory)       -> unchanged.
 *
 * @module scripts/lib/db/orphaned-migrations
 */
import fs from 'node:fs';
import path from 'node:path';

import { LAYOUT_CONSTANTS } from '../sync-path-map.mjs';
import { SYNC_RECEIPT_PATH } from '../bundle-generated-stores.mjs';

/** True when `dir` is a consumer's synced copy (`<root>/.audit-loop/migrations`). */
export function isSyncedMigrationsDir(dir) {
  if (!dir) return false;
  const norm = path.resolve(dir).replaceAll('\\', '/').toLowerCase();
  return norm.endsWith(`/${LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX.replace(/\/$/, '').toLowerCase()}`);
}

/**
 * The migration filenames the latest sync receipt says upstream retired but the sync could not delete. Fail-soft by design:
 * an unreadable or absent receipt answers `[]` (nothing is CLAIMED orphaned on a guess; the caveat line still prints).
 *
 * @param {string} dir the synced migrations directory
 * @param {{read?: (file: string) => string}} [io]
 * @returns {string[]}
 */
export function readRetiredMigrationNames(dir, { read = (f) => fs.readFileSync(f, 'utf-8') } = {}) {
  if (!isSyncedMigrationsDir(dir)) return [];
  try {
    const root = path.resolve(dir, '..', '..');
    const receipt = JSON.parse(read(path.join(root, SYNC_RECEIPT_PATH)));
    const held = receipt?.recentSyncs?.[0]?.retiredHeld;
    const prefix = LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX;
    return Array.isArray(held)
      ? held.filter((p) => typeof p === 'string' && p.startsWith(prefix)).map((p) => p.slice(prefix.length))
      : [];
  } catch {
    return [];
  }
}

/**
 * PURE. Split the missing set and word the advice.
 *
 * @param {{missing: string[], dir: string, command: string, retired?: string[]}} a
 * @returns {{orphaned: string[], live: string[], advisesMigrate: boolean, advice: string}}
 *   `advice` is one block, newline-free of a trailing newline, that REPLACES the bare "Run: <command>" line.
 */
export function adviseForMissingMigrations({ missing, dir, command, retired = [] }) {
  const gone = new Set(retired);
  const orphaned = missing.filter((f) => gone.has(f));
  const live = missing.filter((f) => !gone.has(f));
  if (orphaned.length > 0) {
    return {
      orphaned, live, advisesMigrate: false,
      advice: `ORPHANED: ${orphaned.length} of these were retired upstream and are only a stale copy in ${dir} (the sync could not remove `
        + `them: edited here, or declared in .sync-overrides.json): ${orphaned.join(', ')}.\n`
        + `Do NOT run \`${command}\` - it would re-apply retired migrations. Remove the stale file(s) (or the override), re-run the `
        + 'consumer sync so it retires them, then re-run this audit.',
    };
  }
  if (isSyncedMigrationsDir(dir)) {
    // Provenance is UNKNOWN here (no receipt evidence either way), so the command is conditional, never a bare instruction.
    return {
      orphaned, live, advisesMigrate: true,
      advice: `${dir} is a synced copy and nothing here proves these files are still shipped upstream. If any of them was RETIRED `
        + 'upstream, do NOT apply it: re-run the consumer sync first (it removes unedited retired migrations and reports edited ones) '
        + `and check this list again. Only if every listed file is still shipped upstream, run: ${command}`,
    };
  }
  return { orphaned, live, advisesMigrate: true, advice: `Run: ${command}` };
}
