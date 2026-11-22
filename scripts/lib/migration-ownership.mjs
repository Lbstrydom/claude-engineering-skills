/**
 * @fileoverview Is every migration file in the migrations directory TRACKED by git?
 *
 * Incident (2026-11-20): a mirror checkout held three UNTRACKED migration files in
 * `supabase/migrations/` (hidden by `.git/info/exclude`) that replaced three unique
 * keys the code writes against. `setup-postgres.mjs --migrate` applied them to a new
 * store, and bandit / false-positive writes failed silently for two weeks. A
 * fast-forward never touches untracked files, so nothing upstream could ever fix it.
 *
 * The rule: **a migration the repo does not own is never applied by default.** The
 * oracle is git itself (`git ls-files` over the migrations directory: whatever is on
 * disk and not in the index is untracked, ignored or not) - never a hand list.
 *
 * FAIL CLOSED: if git cannot answer (not a work tree, git missing, spawn error), the
 * verdict is `unverified`, which refuses exactly like `untracked`. The override is an
 * explicit flag, {@link ALLOW_UNTRACKED_FLAG}, which a human has to type.
 *
 * Scope: only the git-owned source layout (`<repo>/supabase/migrations`). A consumer's
 * `.audit-loop/migrations` is a SYNCED copy, untracked by design (gitignored by the
 * managed block), so there every file is "untracked" and the question has no meaning:
 * that layout is `not-applicable`.
 *
 * @module scripts/lib/migration-ownership
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ALLOW_UNTRACKED_FLAG = '--allow-untracked-migrations';

/**
 * @typedef {{status: 'tracked'|'not-applicable'} |
 *           {status: 'untracked', untracked: string[]} |
 *           {status: 'unverified', reason: string}} MigrationOwnership
 */

/** True when `migrationsDir` is the git-owned source layout of `repoRoot`. */
export function isGitOwnedMigrationsDir(repoRoot, migrationsDir) {
  const expected = path.resolve(repoRoot, 'supabase', 'migrations');
  const actual = path.resolve(migrationsDir);
  return process.platform === 'win32'
    ? expected.toLowerCase() === actual.toLowerCase()
    : expected === actual;
}

/**
 * Ask git which `.sql` files in `migrationsDir` it does not track.
 *
 * @param {{repoRoot: string, migrationsDir: string,
 *          spawn?: typeof spawnSync, listDir?: (dir: string) => string[]}} opts
 * @returns {MigrationOwnership}
 */
export function assessMigrationOwnership({ repoRoot, migrationsDir, spawn = spawnSync, listDir = (d) => fs.readdirSync(d) }) {
  if (!isGitOwnedMigrationsDir(repoRoot, migrationsDir)) return { status: 'not-applicable' };

  let onDisk;
  try {
    onDisk = listDir(migrationsDir).filter((e) => e.endsWith('.sql')).sort();
  } catch (err) {
    return { status: 'unverified', reason: `could not list ${migrationsDir} (${err.code || err.message})` };
  }
  if (onDisk.length === 0) return { status: 'tracked' };

  const rel = path.relative(repoRoot, migrationsDir).replaceAll('\\', '/');
  const r = spawn('git', ['ls-files', '-z', '--', rel], {
    cwd: repoRoot, encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    const why = r.error ? (r.error.code || r.error.message) : `git exit ${r.status}`;
    return { status: 'unverified', reason: `git could not answer ("git ls-files ${rel}": ${why})` };
  }
  // Exact repo-relative paths, never basenames: a tracked `migrations/archive/003.sql` must not vouch for an untracked `migrations/003.sql`.
  const tracked = new Set(String(r.stdout || '').split('\0').filter(Boolean).map((p) => p.replaceAll('\\', '/')));
  const untracked = onDisk.filter((f) => !tracked.has(`${rel}/${f}`));
  return untracked.length === 0 ? { status: 'tracked' } : { status: 'untracked', untracked };
}

/** The refusal text for a non-`tracked` verdict (names the files and the remedy). */
export function describeOwnershipRefusal(verdict, migrationsDir) {
  if (verdict.status === 'untracked') {
    return [
      `${verdict.untracked.length} migration file(s) in ${migrationsDir} are NOT tracked by git:`,
      ...verdict.untracked.map((f) => `    ? ${f}`),
      '  Applying a file this repo does not own is how a store silently diverges from the code (a fast-forward never touches',
      '  untracked files, so nothing upstream can ever repair it). Remedy: delete the file(s), or `git add` + commit them if',
      '  they are intended. If you really mean to apply them anyway, re-run with ' + ALLOW_UNTRACKED_FLAG + '.',
    ].join('\n');
  }
  return [
    `could not verify that the migrations in ${migrationsDir} are tracked by git: ${verdict.reason}.`,
    '  Failing closed: an unverifiable migration set is treated like an untracked one. Remedy: run from a git work tree with',
    '  git on PATH. If you really mean to apply them anyway, re-run with ' + ALLOW_UNTRACKED_FLAG + '.',
  ].join('\n');
}

/**
 * Throw unless the migration set is git-owned (or the human typed the override).
 *
 * @param {MigrationOwnership} verdict
 * @param {{migrationsDir: string, allowUntracked?: boolean, stderr?: {write: Function}}} opts
 */
export function enforceMigrationOwnership(verdict, { migrationsDir, allowUntracked = false, stderr = process.stderr }) {
  if (verdict.status === 'tracked' || verdict.status === 'not-applicable') return;
  const text = describeOwnershipRefusal(verdict, migrationsDir);
  if (allowUntracked) {
    stderr.write(`WARNING (${ALLOW_UNTRACKED_FLAG} given): ${text.split('\n')[0]}\n`);
    return;
  }
  const err = new Error(text);
  err.code = 'MIGRATIONS_NOT_GIT_OWNED';
  throw err;
}

/**
 * Assess + enforce in one call (what --migrate / --adopt run before any query). `ownership` is injectable for tests.
 *
 * @param {{repoRoot: string, migrationsDir: string, allowUntracked?: boolean, ownership?: () => MigrationOwnership,
 *          stderr?: {write: Function}}} opts
 */
export function guardMigrationOwnership({ repoRoot, migrationsDir, allowUntracked = false, ownership, stderr = process.stderr }) {
  const verdict = ownership ? ownership() : assessMigrationOwnership({ repoRoot, migrationsDir });
  enforceMigrationOwnership(verdict, { migrationsDir, allowUntracked, stderr });
}

/** The verdict as `--check-drift` fields: untracked files, the unverified reason, and how many drift items that is. */
export function summariseOwnership(verdict) {
  const untracked = verdict.status === 'untracked' ? verdict.untracked : [];
  const unverified = verdict.status === 'unverified' ? verdict.reason : null;
  return { untracked, unverified, count: untracked.length + (unverified ? 1 : 0) };
}

/** Human lines for the drift report (distinct classes; never folded into "no drift"). */
export function renderOwnershipDrift(drift, stderr = process.stderr) {
  const R = '\x1b[31m', X = '\x1b[0m';
  if (drift.untrackedMigrations?.length) {
    stderr.write(`\n  ${R}untracked migration file present${X} (${drift.untrackedMigrations.length}) — git does not track it; --migrate/--adopt will refuse it (override: ${ALLOW_UNTRACKED_FLAG}):\n`);
    for (const f of drift.untrackedMigrations) stderr.write(`    ? ${f}\n`);
  }
  if (drift.ownershipUnverified) stderr.write(`\n  ${R}migration ownership unverified${X} — ${drift.ownershipUnverified}\n`);
}
