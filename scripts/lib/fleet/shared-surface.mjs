/**
 * @fileoverview Shared test surfaces (fleet feedback #5): a session marks `ready` on a SUBSET of tests, then the train goes
 * red, because the files it changed (a shared fixture, a test helper, a contract) are loaded by suites it never ran.
 * `ready` and `next` now say so when a branch touches one, and name the fast tier to run first.
 *
 * Recommendation only, deliberately: `ready` carries no verification evidence (it records an oid, not a test run), so
 * there is nothing here that could be REQUIRED honestly - a gate that cannot tell whether the tier ran would either block
 * every ready or nobody's. The train's own tiers remain the authority.
 *
 * Config (`.fleet.json` `sharedSurfaces`): `globs` (claim grammar; default `DEFAULT_SHARED_GLOBS`; `[]` turns it off) and
 * `run` (an argv for the fast tier, named in the message; absent = a generic sentence).
 *
 * @module scripts/lib/fleet/shared-surface
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileOverlap } from './overlap.mjs';
import { parseImports, resolveSpecifier } from '../module-graph.mjs';
import { runGit } from './git-facts.mjs';
import { printable } from './eol-flips.mjs';
import { renderCommand } from './shell-quote.mjs';

/** What counts as shared when a repo configures nothing: test helpers and fixtures are loaded by many suites. */
export const DEFAULT_SHARED_GLOBS = Object.freeze(['tests/helpers/**', 'tests/fixtures/**']);
/** Names listed in one line; the count is always exact. */
export const SHARED_NAME_CAP = 6;

/**
 * @param {string[]} files repo-relative changed files
 * @param {{globs?: string[]}|null|undefined} cfg the resolved `sharedSurfaces`
 * @returns {string[]} the changed files that are shared surfaces, sorted
 */
export function sharedSurfaceTouched(files, cfg) {
  const globs = cfg?.globs ?? DEFAULT_SHARED_GLOBS;
  if (!globs.length || !files?.length) return [];
  return fileOverlap(files, [...globs]).sort();
}

/**
 * The recommendation, or null when nothing shared was touched. `reach` (from `testsLoadingIn`) names the tests that load the
 * files; an unavailable one is said, never silently dropped.
 * @param {string[]} touched
 * @param {{run?: string[]|null}} cfg
 * @param {string} [cmd]
 * @param {{ok: boolean, tests?: string[], unread?: number, reason?: string}|null} [reach]
 */
export function sharedSurfaceLine(touched, cfg, cmd = 'fleet', reach = null) {
  if (!touched.length) return null;
  const names = `${touched.slice(0, SHARED_NAME_CAP).map(printable).join(', ')}${touched.length > SHARED_NAME_CAP ? `, … ${touched.length - SHARED_NAME_CAP} more` : ''}`;
  const parts = [];
  if (reach?.ok && reach.tests.length) {
    const shown = reach.tests.slice(0, REACH_NAME_CAP);
    const more = reach.tests.length > shown.length ? ` (first ${shown.length} of ${reach.tests.length}; all ${reach.tests.length} are in the JSON as sharedSurface.tests)` : '';
    const unread = reach.unread ? ` (${reach.unread} test file(s) could not be read)` : '';
    parts.push(`the ${reach.tests.length} test file(s) that load them: \`${renderCommand(['node', '--test', ...shown])}\`${more}${unread}`);
  } else if (reach && !reach.ok) parts.push(`(which tests load them could not be worked out: ${reach.reason})`);
  if (cfg?.run?.length) parts.push(`the fast tier \`${renderCommand(cfg.run)}\``);
  const what = parts.length ? parts.join(' and ') : 'the fast tier this repo defines (.fleet.json sharedSurfaces.run names it)';
  return `recommend: this branch changes ${touched.length} shared test file(s) (${names}). Those are loaded by suites a targeted run never touches, so a passing SUBSET is not evidence for the train — run ${what} before relying on this mark (\`${cmd}\` does not run it for you and cannot tell whether you did).`;
}

// ── Which tests load the touched files ────────────────────────────────────────────────────────────────────────────────────

/** At most this many test files are named in the recommendation; the count is exact. */
export const REACH_NAME_CAP = 10;
const TEST_FILE = /\.test\.(mjs|js|cjs)$/;
const isScript = (f) => /\.(mjs|js|cjs)$/.test(f);
/** Skipped wholesale: vendored or generated trees that are never part of a test's reach. */
const NOT_SOURCE = /^(node_modules|\.git|\.claude|\.audit|dashboard)\//;

/**
 * The test files that load `touched`. The graph is the STATIC import graph over EVERY tracked script (tests, helpers AND production
 * modules, so a shared contract under `scripts/` reaches the tests that import it through other modules), walked in reverse from the
 * touched files. A path named literally in any script (a fixture or JSON read by path, a helper naming an asset) also counts: the file
 * that names it is a seed, so its own importers are reached too.
 *
 * Best effort by design, and says so: a computed `import()` or a path built at run time is not followed, and an unreadable file is
 * counted in `unread`, never read as "does not load it". Pure: the file list and the reader are injected.
 * @param {string[]} touched repo-relative shared files
 * @param {{repoFiles: string[], readFile: (p: string) => string}} io
 * @returns {{tests: string[], unread: number}}
 */
export function testsLoading(touched, { repoFiles, readFile }) {
  const files = new Set(repoFiles);
  const sources = repoFiles.filter((f) => isScript(f) && !NOT_SOURCE.test(f));
  const importersOf = new Map(); // target -> Set(importer)
  const text = new Map();
  let unread = 0;
  for (const f of sources) {
    let src;
    try { src = readFile(f); } catch { unread += 1; continue; }
    text.set(f, src);
    for (const specifier of parseImports(src, { dynamic: true })) {
      const { resolved } = resolveSpecifier({ fromFile: f, specifier, repoFiles: files });
      if (resolved) { if (!importersOf.has(resolved)) importersOf.set(resolved, new Set()); importersOf.get(resolved).add(f); }
    }
  }
  const reached = new Set();
  const seen = new Set();
  const queue = [];
  const seed = (f) => { if (!seen.has(f)) { seen.add(f); queue.push(f); } };
  for (const t of touched) seed(t);
  // A path named literally: the naming script is itself a seed (it loads the asset), so its importers are reached too.
  for (const [f, src] of text) if (touched.some((t) => src.includes(t))) { reached.add(f); seed(f); }
  while (queue.length) {
    const t = queue.shift();
    for (const imp of importersOf.get(t) ?? []) { reached.add(imp); seed(imp); }
  }
  return { tests: [...reached].filter((f) => TEST_FILE.test(f)).sort(), unread };
}

/** The same, from a checkout: `git ls-files` for the file list and the working tree for the text. */
export function testsLoadingIn(cwd, touched) {
  const ls = runGit(['ls-files', '-z', '--full-name', '--', ':/'], cwd, { timeoutMs: 30_000 });
  if (!ls.ok) return { ok: false, reason: `git ls-files failed (${ls.reason})` };
  const repoFiles = ls.stdout.split('\0').filter(Boolean);
  return { ok: true, ...testsLoading(touched, { repoFiles, readFile: (p) => fs.readFileSync(path.join(cwd, p), 'utf8') }) };
}
