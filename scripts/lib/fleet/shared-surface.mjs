/**
 * @fileoverview Shared test surfaces (fleet feedback #5): a session marks `ready` on a SUBSET of tests, then the train goes
 * red, because the files it changed (a shared fixture, a test helper, a contract) are loaded by suites it never ran.
 * `ready` and `next` now say so when a branch touches one, name the tests that load it, and name the fast tier to run too.
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
import { RESOLVABLE_EXTENSIONS, parseImports, resolveSpecifier } from '../module-graph.mjs';
import { runGit } from './git-facts.mjs';
import { printable } from './eol-flips.mjs';
import { renderCommand } from './shell-quote.mjs';

/** What counts as shared when a repo configures nothing: test helpers and fixtures are loaded by many suites. */
export const DEFAULT_SHARED_GLOBS = Object.freeze(['tests/helpers/**', 'tests/fixtures/**']);
/** Names listed in one line; the count is always exact. */
export const SHARED_NAME_CAP = 6;
/** Test files put in ONE runnable command; beyond it the command is labelled partial and the complete set is in the JSON. */
export const REACH_NAME_CAP = 40;

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
 * files. The reach is ALWAYS described as static and best-effort; the unread count and an unavailable reach are said whether or
 * not any test was found; and the configured fast tier - or, with none configured, a generic sentence - is named alongside it.
 * @param {string[]} touched
 * @param {{run?: string[]|null}} cfg
 * @param {string} [cmd]
 * @param {{ok: boolean, tests?: string[], unread?: number, reason?: string}|null} [reach]
 */
export function sharedSurfaceLine(touched, cfg, cmd = 'fleet', reach = null) {
  if (!touched.length) return null;
  const names = `${touched.slice(0, SHARED_NAME_CAP).map(printable).join(', ')}${touched.length > SHARED_NAME_CAP ? `, … ${touched.length - SHARED_NAME_CAP} more` : ''}`;
  const parts = [];
  const caveats = [];
  if (reach?.ok) {
    if (reach.tests.length) {
      const shown = reach.tests.slice(0, REACH_NAME_CAP);
      const partial = reach.tests.length > shown.length;
      parts.push(`${partial ? 'the first' : 'all'} ${shown.length} of the ${reach.tests.length} test file(s) found loading them: \`${renderCommand(['node', '--test', ...shown])}\``);
      if (partial) caveats.push(`that command is PARTIAL — all ${reach.tests.length} are in the JSON as sharedSurface.tests`);
    } else caveats.push('no test file was found that loads them statically, which does not mean none does');
    if (reach.unread) caveats.push(`${reach.unread} test/source file(s) could not be read, so the list may be missing some`);
    caveats.push('the list is static and best-effort: a computed import() or a path built at run time is not followed, so run a broader suite when in doubt');
  } else if (reach) caveats.push(`which tests load them could not be worked out (${reach.reason})`);
  if (cfg?.run?.length) parts.push(`the fast tier \`${renderCommand(cfg.run)}\``);
  else parts.push('the fast tier this repo defines (.fleet.json sharedSurfaces.run names it)');
  return `recommend: this branch changes ${touched.length} shared test file(s) (${names}). Those are loaded by suites a targeted run never touches, so a passing SUBSET is not evidence for the train — run ${parts.join(' and ')} before relying on this mark${caveats.length ? ` (${caveats.join('; ')})` : ''}. \`${cmd}\` does not run it for you and cannot tell whether you did.`;
}

// ── Which tests load the touched files ────────────────────────────────────────────────────────────────────────────────────

// What the import parser understands, from the graph module's own list (never a second spelling): every resolvable extension but JSON.
const isScript = (f) => RESOLVABLE_EXTENSIONS.some((e) => e !== '.json' && f.endsWith(e));
/** The names Node's test runner discovers by default: `*.test.*`, `*-test.*`, `*_test.*`, `test-*.*`, `test.*`. */
const isTestFile = (f) => isScript(f) && /(?:^|\/)(?:[^/]*[._-]test|test(?:-[^/]*)?)\.[^./]+$/.test(f);
/** Skipped wholesale: vendored trees that are never part of a test's reach. */
const NOT_SOURCE = /^(node_modules|\.git)\//;
/** A relative path written as a string literal: `'./x.json'`, `new URL('../fixtures/a.json', import.meta.url)`, `path.join(__dirname, '../x')`. */
const REL_LITERAL = /['"`](\.{1,2}\/[^'"`\s]+)['"`]/g;

/**
 * The test files that load `touched`. The graph is the STATIC import graph over EVERY tracked script (tests, helpers AND production
 * modules, so a shared contract under `scripts/` reaches the tests that import it through other modules), walked in reverse from the
 * touched files; a touched file that was DELETED or renamed away still counts as a node, so an import of its old path is linked. A
 * path named as a string - repo-relative, or relative to the naming file (`new URL('../fixtures/a.json', import.meta.url)`) - also
 * counts: the file that names it is a seed, so its own importers are reached too.
 *
 * Best effort by design, and says so: a computed `import()` or a path built at run time is not followed, and an unreadable file is
 * counted in `unread`, never read as "does not load it". Pure: the file list and the reader are injected.
 * @param {string[]} touched repo-relative shared files (may include deleted paths)
 * @param {{repoFiles: string[], readFile: (p: string) => string}} io
 * @returns {{tests: string[], unread: number}}
 */
export function testsLoading(touched, { repoFiles, readFile }) {
  const files = new Set([...repoFiles, ...touched]);
  const touchedSet = new Set(touched);
  const sources = repoFiles.filter((f) => isScript(f) && !NOT_SOURCE.test(f));
  const importersOf = new Map(); // target -> Set(importer)
  const names = new Set(); // scripts that name a touched path as a string
  let unread = 0;
  for (const f of sources) {
    let src;
    try { src = readFile(f); } catch { unread += 1; continue; }
    for (const specifier of parseImports(src, { dynamic: true })) {
      const { resolved } = resolveSpecifier({ fromFile: f, specifier, repoFiles: files });
      if (resolved) { if (!importersOf.has(resolved)) importersOf.set(resolved, new Set()); importersOf.get(resolved).add(f); }
    }
    if (touched.some((t) => src.includes(t))) names.add(f);
    for (const m of src.matchAll(REL_LITERAL)) {
      const abs = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (touchedSet.has(abs)) names.add(f);
    }
  }
  const reached = new Set();
  const seen = new Set();
  const queue = [];
  const seed = (f) => { if (!seen.has(f)) { seen.add(f); queue.push(f); } };
  for (const t of touched) seed(t);
  for (const f of names) { reached.add(f); seed(f); }
  while (queue.length) {
    const t = queue.shift();
    for (const imp of importersOf.get(t) ?? []) { reached.add(imp); seed(imp); }
  }
  return { tests: [...reached].filter(isTestFile).sort(), unread };
}

/** The same, from a checkout: `git ls-files` for the file list and the working tree for the text. */
export function testsLoadingIn(cwd, touched) {
  const ls = runGit(['ls-files', '-z', '--full-name', '--', ':/'], cwd, { timeoutMs: 30_000 });
  if (!ls.ok) return { ok: false, reason: `git ls-files failed (${ls.reason})` };
  const repoFiles = ls.stdout.split('\0').filter(Boolean);
  return { ok: true, ...testsLoading(touched, { repoFiles, readFile: (p) => fs.readFileSync(path.join(cwd, p), 'utf8') }) };
}
