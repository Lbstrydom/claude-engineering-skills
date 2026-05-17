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
 * block, not a deterministic gate. Dynamic `import()` is intentionally
 * skipped (the specifier may be computed).
 *
 * @param {string} content - ESM source
 * @returns {string[]} unique specifiers, in first-seen order
 */
export function parseImports(content) {
  const src = stripComments(content);
  const found = [];
  const add = (s) => { if (s && !found.includes(s)) found.push(s); };
  // `import … from 'x'` and `export … from 'x'`
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"\n]+)['"]/g)) add(m[1]);
  // side-effect `import 'x'`
  for (const m of src.matchAll(/(?:^|[;\n])\s*import\s+['"]([^'"\n]+)['"]/g)) add(m[1]);
  return found;
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
