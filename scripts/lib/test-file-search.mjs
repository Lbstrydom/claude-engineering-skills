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
 * Why relatedness is scored, not just the name. Searching every test root at any
 * depth fixed the misses but created a new failure: a bare stem like `state`
 * collides across modules. Reported from wine-cellar-app 2026-08-01 — the
 * worksheet offered `tests/unit/agentChat/state.test.js` as the lock for
 * `public/js/restaurantpairing/state.js`. Prose caveats do not stop that,
 * because the row also renders a pasteable `lock-with-test` command, and the
 * writer only refuses a MISSING path — a present-but-unrelated one is accepted,
 * the finding leaves `unlocked_fixes`, and it never resurfaces. A false lock is
 * worse than the open obligation it clears, so a contradicted match must not be
 * handed to the operator as a command.
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
 * Directory names that describe the TEST HARNESS rather than the module under
 * test. They carry no evidence either way, so they are removed before asking
 * whether a test's location agrees with its source's.
 */
const HARNESS_DIRS = new Set([...TEST_ROOTS, 'unit', 'integration', 'e2e', 'functional', 'regression', 'specs']);

/** Directory segments of a path, lowercased — the FS here is case-insensitive. */
function dirSegments(p) {
  return String(p || '').replace(/\\/g, '/').split('/').slice(0, -1)
    .filter(Boolean).map((s) => s.toLowerCase());
}

/**
 * Does a candidate test's location AGREE with its source's, disagree, or say
 * nothing?
 *
 * Deliberately three-valued rather than a boolean. A flat layout
 * (`tests/query.test.mjs` — this repo's own) leaves nothing to compare, and
 * calling that "unrelated" would suppress every correct suggestion here. The
 * only actionable state is a genuine CONTRADICTION: the test is filed under
 * module directories, and none of them appear anywhere in the source's path.
 * That is the wine-cellar-app case — `agentChat` versus `restaurantpairing`.
 *
 * @param {string} sourcePath the finding's `primary_file`
 * @param {string} testPath a repo-relative candidate test path
 * @returns {'related'|'unrelated'|'unknown'} `unknown` = no evidence either way
 */
export function classifyTestMatch(sourcePath, testPath) {
  const source = new Set(dirSegments(sourcePath));
  const testDirs = dirSegments(testPath).filter((s) => !HARNESS_DIRS.has(s));
  if (testDirs.length === 0) return 'unknown';
  return testDirs.some((s) => source.has(s)) ? 'related' : 'unrelated';
}

/** Ranking key: agreement first, then shallowest, then alphabetical. */
const MATCH_RANK = { related: 0, unknown: 1, unrelated: 2 };

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
 * Ordered by `classifyTestMatch` agreement first, then shallowest, then
 * alphabetically — so the suggestion is stable across runs (a worksheet whose
 * suggestion changes between invocations is not a worksheet) AND a test filed
 * under the source's own module outranks a basename twin from elsewhere.
 *
 * Ranking is not filtering: an `unrelated` candidate is still returned, because
 * a cross-module integration test can be the right lock. What the caller must
 * not do is hand it over as a ready-to-run command — see `classifyTestMatch`.
 *
 * @param {string} sourcePath the finding's `primary_file`
 * @param {string} repoRoot absolute path to the repo root
 * @returns {string[]} repo-relative POSIX paths, best first; empty when nothing matches
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
    .sort((a, b) => (MATCH_RANK[classifyTestMatch(sourcePath, a)] - MATCH_RANK[classifyTestMatch(sourcePath, b)])
      || (a.split('/').length - b.split('/').length)
      || a.localeCompare(b));
}
