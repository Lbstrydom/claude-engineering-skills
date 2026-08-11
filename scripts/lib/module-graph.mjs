/**
 * @fileoverview ESM-only module-specifier resolution — deterministic path
 * arithmetic used by the finding-verification gate (Phase 1) and, later,
 * the T1 adjacency tier (Phase 2).
 * Plan: docs/plans/adaptive-context-blast-radius.md (audit M1).
 *
 * Phase 1 implements `resolveSpecifier` (the gate's need — "does the
 * module this import points at exist in the repo?"). `publicExports`
 * (T1's AST export extraction) is added in Phase 2 alongside its consumer.
 *
 * ESM-only by project rule — `require()` is a documented Do-NOT and is
 * not handled. Specifiers that cannot be statically resolved (bare deps,
 * unknown importer, leading-slash absolute paths) are reported as such,
 * never guessed.
 *
 * @module scripts/lib/module-graph
 */
import path from 'node:path';
import { builtinModules } from 'node:module';

/**
 * Repo file extensions a specifier may resolve to. Single source of truth —
 * the finding-verification gate imports this rather than re-listing
 * extensions (audit M10).
 */
export const RESOLVABLE_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs', '.json']);
const INDEX_PROBES = RESOLVABLE_EXTENSIONS.map((e) => `/index${e}`);

/** A specifier is "bare" (external dep / node builtin / scoped pkg) if not path-like. */
export function isBareSpecifier(spec) {
  return !spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/');
}

/**
 * The npm package a bare specifier installs from, or `null` when the specifier
 * is not an installable dependency (a node builtin, or regex noise — see
 * below). `@scope/pkg/sub/path` → `@scope/pkg`; `pkg/sub/path` → `pkg`.
 *
 * **Why the noise filter is load-bearing.** `parseImports` is a regex, not a
 * parser, so it also matches import-like fragments inside doc comments and
 * template literals ("write the final result to disk", "resolving", `https:`).
 * Those are not packages, and a dependency contract derived from them would
 * be junk. Anything that is not a syntactically valid npm name is rejected
 * rather than guessed — the same "report, never guess" rule this module
 * already applies to specifiers.
 *
 * @param {string} spec - the specifier as written
 * @returns {string|null} the package name, or null if not an installable dep
 */
export function packageNameFromSpecifier(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return null;
  if (!isBareSpecifier(spec)) return null;
  if (spec.startsWith('node:')) return null;
  if (builtinModules.includes(spec)) return null;

  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return NPM_NAME.test(name) ? name : null;
}

/**
 * npm package-name grammar (npm's own rules): optional `@scope/`, then a name
 * of lowercase alphanumerics and `._-`, not starting with `.` or `_`.
 */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * Resolve an import specifier to a repo-relative file path.
 *
 * @param {object} args
 * @param {string} args.fromFile - repo-relative path of the importing file
 * @param {string} args.specifier - the import specifier as written
 * @param {Set<string>|string[]} args.repoFiles - repo-relative file set
 * @param {boolean} [args.exact] - when true (the gate's mode), resolve ESM-
 *   accurately: the specifier must carry its own extension, no extensionless
 *   or directory-`index` probing. Prevents the gate from "resolving" an
 *   import that ESM itself would reject (audit H2).
 * @returns {{resolved: string|null, kind: 'repo'|'external'|'unresolvable'}}
 *   `external` = a bare dependency / node builtin / scoped package — not a
 *   repo-existence question. `unresolvable` = path-like but not found.
 */
export function resolveSpecifier({ fromFile, specifier, repoFiles, exact = false }) {
  if (typeof specifier !== 'string' || specifier.length === 0) {
    return { resolved: null, kind: 'unresolvable' };
  }
  const fileSet = repoFiles instanceof Set ? repoFiles : new Set(repoFiles || []);

  if (isBareSpecifier(specifier)) {
    // Includes scoped packages (`@scope/name`) and node builtins — these
    // are external deps, not repo files (audit M7).
    return { resolved: null, kind: 'external' };
  }
  // A leading-slash specifier is an ABSOLUTE path in ESM, not a repo-root
  // alias — the repo defines no such alias layer (audit M11).
  if (specifier.startsWith('/')) {
    return { resolved: null, kind: 'unresolvable' };
  }
  // Relative specifier — needs the importer's location.
  if (typeof fromFile !== 'string' || fromFile.length === 0) {
    return { resolved: null, kind: 'unresolvable' };
  }

  const fromDir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));

  // `..` escaping the repo root → unresolvable (checked AFTER normalising,
  // so a legitimate `../sibling/x.mjs` that stays in-repo still resolves —
  // audit M6).
  if (base.startsWith('..') || base.startsWith('/')) {
    return { resolved: null, kind: 'unresolvable' };
  }

  if (fileSet.has(base)) return { resolved: base, kind: 'repo' };
  if (exact) {
    // ESM-accurate mode: no extensionless / index probing. `import './x'`
    // does not resolve in ESM, so the gate must not pretend it does.
    return { resolved: null, kind: 'unresolvable' };
  }
  for (const ext of RESOLVABLE_EXTENSIONS) {
    if (fileSet.has(base + ext)) return { resolved: base + ext, kind: 'repo' };
  }
  for (const idx of INDEX_PROBES) {
    if (fileSet.has(base + idx)) return { resolved: base + idx, kind: 'repo' };
  }
  return { resolved: null, kind: 'unresolvable' };
}

/**
 * Strip `/* *\/` block comments and `//` line comments so the import /
 * export regexes below don't match commented-out code (audit M9). The
 * line-comment pass guards `://` (URLs) and quote-prefixed `//` to avoid
 * eating string content — crude but safe for the advisory use here.
 */
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * Extract every import/re-export specifier from ESM source. Catches
 * `import … from 'x'`, side-effect `import 'x'`, and `export … from 'x'`
 * — multiline-tolerant (it anchors on the `from 'x'` clause, so the
 * binding list between `import` and `from` may span lines).
 *
 * Best-effort by design — this feeds the *advisory* T1 adjacency context
 * block, not a deterministic gate. Dynamic `import()` is skipped by
 * default (the specifier may be computed); pass `{ dynamic: true }` to
 * also capture string-literal dynamic imports (`import('./x.mjs')`) —
 * the sync dependency walker needs these because the project lazy-loads
 * many modules. Computed dynamic specifiers (template literals,
 * identifiers) are never captured — they cannot be resolved statically.
 *
 * @param {string} content - ESM source
 * @param {object} [opts]
 * @param {boolean} [opts.dynamic=false] - also capture string-literal
 *   `import('x')` specifiers
 * @returns {string[]} unique specifiers, in first-seen order
 */
export function parseImports(content, { dynamic = false } = {}) {
  const src = stripComments(content);
  const found = [];
  const add = (s) => { if (s && !found.includes(s)) found.push(s); };
  // `import … from 'x'` and `export … from 'x'`
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"\n]+)['"]/g)) add(m[1]);
  // side-effect `import 'x'`
  for (const m of src.matchAll(/(?:^|[;\n])\s*import\s+['"]([^'"\n]+)['"]/g)) add(m[1]);
  // string-literal dynamic import — `import('x')` / `await import("x")`.
  if (dynamic) {
    for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) add(m[1]);
  }
  return found;
}

/**
 * Walk the ESM import graph from a set of entry points and return the
 * transitive closure of repo files reachable from them.
 *
 * Both static imports and string-literal dynamic imports are followed —
 * the latter because the project lazy-loads modules via
 * `await import('./x.mjs')`. Computed dynamic specifiers
 * (`import(`./adapters/${k}.mjs`)`) cannot be resolved statically and are
 * NOT followed; targets reachable only that way must be supplied to the
 * caller's allowlist explicitly.
 *
 * Pure — no filesystem access. The caller injects `readFile` (keeps this
 * unit-testable) and `repoFiles` (the resolvable file universe, used by
 * `resolveSpecifier` for extension/index probing).
 *
 * @param {object} args
 * @param {string[]} args.entryPoints - repo-relative paths to start from
 * @param {Set<string>|string[]} args.repoFiles - repo-relative file universe
 * @param {(relPath: string) => string|null} args.readFile - file contents,
 *   or null when unreadable/absent
 * @returns {{files: string[], unresolved: Array<{from:string,specifier:string}>,
 *            external: Array<{from:string,specifier:string,pkg:string}>}}
 *   `files` = sorted closure (entry points + every reachable repo file);
 *   `unresolved` = path-like specifiers that did not resolve to a repo file
 *   (a genuinely missing dependency, or a typo — surfaced for diagnostics);
 *   `external` = bare specifiers naming an installable npm package. These are
 *   the closure's **runtime dependency contract**: ship these files to a repo
 *   that lacks these packages and every entry point dies on first import.
 *   Node builtins are excluded (nothing to install).
 *
 *   `external` and `unresolved` are disjoint. Until 2026-07-20 the walk
 *   `continue`d on `kind === 'external'` and reported nothing: the closure
 *   observed its own dependency contract on every edge and discarded it. So
 *   the synced-bundle contract drifted silently each time a lib grew a new
 *   import, and consumers only found out via a hard ERR_MODULE_NOT_FOUND at
 *   the first entry point that touched it. See upstream#57.
 */
export function collectImportClosure({ entryPoints, repoFiles, readFile }) {
  const fileSet = repoFiles instanceof Set ? repoFiles : new Set(repoFiles || []);
  const norm = (p) => path.posix.normalize(String(p || '').replace(/\\/g, '/'));
  const visited = new Set();
  const unresolved = [];
  const external = [];
  const seenExternal = new Set();
  const queue = (entryPoints || []).map(norm);

  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);

    const content = readFile(file);
    if (content == null) continue; // unreadable — caller's sync loop reports the miss

    for (const spec of parseImports(content, { dynamic: true })) {
      const { resolved, kind } = resolveSpecifier({ fromFile: file, specifier: spec, repoFiles: fileSet });
      if (kind === 'external') {
        // Bare specifier. Record the installable package (node builtins and
        // regex noise resolve to null and are not dependencies).
        const pkg = packageNameFromSpecifier(spec);
        if (pkg) {
          const key = `${file}\u0000${pkg}`;
          if (!seenExternal.has(key)) {
            seenExternal.add(key);
            external.push({ from: file, specifier: spec, pkg });
          }
        }
        continue;
      }
      if (kind === 'repo' && resolved) {
        if (!visited.has(resolved)) queue.push(resolved);
      } else {
        unresolved.push({ from: file, specifier: spec });
      }
    }
  }
  return { files: [...visited].sort(), unresolved, external };
}

/**
 * Extract the public export names from ESM source. Covers
 * `export const/let/var/function/class NAME`, `export { a, b as c }`,
 * `export { x } from '…'`, and `export default`. `export * from '…'`
 * cannot be named — reported as the literal `'*'`.
 *
 * Best-effort by design — feeds the advisory T1 context block.
 *
 * @param {string} content - ESM source
 * @returns {string[]} unique export names, in first-seen order
 */
export function publicExports(content) {
  const src = stripComments(content);
  const found = [];
  const add = (s) => { if (s && !found.includes(s)) found.push(s); };
  for (const m of src.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    add(m[1]);
  }
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      add(asMatch ? asMatch[1] : seg.split(/\s+/)[0]);
    }
  }
  if (/\bexport\s+default\b/.test(src)) add('default');
  if (/\bexport\s*\*\s*from\b/.test(src)) add('*');
  return found;
}
