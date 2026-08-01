/**
 * @fileoverview Find the test file(s) named after a source file.
 *
 * Used by `cross-skill.mjs lock-with-test --worksheet` to suggest a regression
 * lock target. This is a NAME heuristic and nothing more — a same-named test is
 * not proof of coverage, which is why the worksheet labels it as a suggestion
 * and the operator confirms by reading it.
 *
 * Why it is a search rather than a formula. The worksheet used to compute one
 * path, `tests/<basename>.test.mjs`, which is this repo's own flat layout and
 * extension. Reported from wine-cellar-app 2026-08-01: that repo uses
 * `tests/unit/**\/<name>.test.js`, so every finding came back "none found —
 * write one" despite having a perfectly good existing test, and following the
 * worksheet would have produced duplicate suites. The tooling syncs to consumer
 * repos, so a layout assumption baked into it is wrong everywhere but here.
 *
 * @module scripts/lib/test-file-search
 */

import fs from 'node:fs';
import path from 'node:path';

/** Directories that never hold a repo's own tests, and are expensive to walk. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out']);

/** Roots searched, in order. First existing root wins the walk. */
const TEST_ROOTS = ['tests', 'test', '__tests__', 'spec'];

/** Bounded so a pathological tree cannot stall an operator-facing command. */
const MAX_ENTRIES = 20000;

/**
 * Strip a source file's extension and any test-ish suffix, yielding the stem a
 * test file would be named after. `src/public/cellarSwitcher.js` → `cellarSwitcher`.
 *
 * @param {string} sourcePath
 * @returns {string} the stem, or '' when there is nothing to match on
 */
export function testStemFor(sourcePath) {
  const base = path.basename(String(sourcePath || '').replace(/\\/g, '/'));
  if (!base || base.startsWith('.')) return '';
  // Drop ONE extension only: `foo.config.js` → `foo.config`, which is what a
  // test for it would be named after.
  return base.replace(/\.[A-Za-z0-9]+$/, '');
}

/**
 * Recursively collect files under `dir`, relative to `repoRoot`, POSIX-separated.
 *
 * @param {string} dir absolute
 * @param {string} repoRoot absolute
 * @param {{count: number}} budget mutated; walk stops when it hits MAX_ENTRIES
 * @param {string[]} out
 */
function walk(dir, repoRoot, budget, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory is a non-result, never a throw
  }
  for (const e of entries) {
    if (budget.count >= MAX_ENTRIES) return;
    budget.count += 1;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), repoRoot, budget, out);
    } else if (e.isFile()) {
      out.push(path.relative(repoRoot, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  }
}

/**
 * Test files whose basename matches `<stem>.test.*` or `<stem>.spec.*`, in any
 * test root, at any depth.
 *
 * Ordered shallowest-first then alphabetically, so the suggestion is stable
 * across runs — a worksheet whose suggestion changes between invocations is not
 * a worksheet.
 *
 * @param {string} sourcePath the finding's `primary_file`
 * @param {string} repoRoot absolute path to the repo root
 * @returns {string[]} repo-relative POSIX paths; empty when nothing matches
 */
export function findTestFilesFor(sourcePath, repoRoot) {
  const stem = testStemFor(sourcePath);
  if (!stem) return [];
  const budget = { count: 0 };
  const files = [];
  for (const root of TEST_ROOTS) {
    const abs = path.resolve(repoRoot, root);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) walk(abs, repoRoot, budget, files);
  }
  const wanted = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(test|spec)\\.[A-Za-z0-9]+$`);
  return files
    .filter((f) => wanted.test(path.posix.basename(f)))
    .sort((a, b) => (a.split('/').length - b.split('/').length) || a.localeCompare(b));
}
