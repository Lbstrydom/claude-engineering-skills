/**
 * @fileoverview Language profile registry — one profile per supported language.
 * Data-driven dispatch for code analysis (chunking, imports, exports).
 * Profiles are IMMUTABLE. Repo-specific state (like detected package roots)
 * lives in LanguageContext (built per-run, not baked into profiles).
 *
 * Phase A of the multi-language audit plan. See
 * docs/plans/phase-a-language-aware-analysis.md for design rationale.
 * @module scripts/lib/language-profiles
 */

import path from 'node:path';
import { normalizePath } from './file-io.mjs';
import {
  languageById, matchFileKind, AUDITABLE_EXTENSIONS, KNOWN_EXTENSIONLESS_FILENAMES, toExtensionAlternation,
} from './file-taxonomy.mjs';
import { scanCsharpBoundaries, csharpBoundaryScanner } from './csharp-scanner.mjs';

/**
 * Profile shape:
 *   {
 *     id: string,              // Stable identity: a language id from file-taxonomy.mjs ('js'|'ts'|'py'|'cs')
 *     extensions: string[],    // taken from the taxonomy's language entry: a profile cannot claim an extension the taxonomy does not know
 *     importRegex: RegExp,     // Import statement matcher (STATEFUL — has 'g' flag)
 *     importExtractor: (match: RegExpMatchArray) => ImportRecord | null,
 *     exportRegex: RegExp,     // Export-line matcher (stateless — no 'g' flag)
 *     resolveImport: (record, fromFile, repoFileSet, langContext) => string[],
 *     getBoundaries: (lines: string[]) => number[],  // Boundary line indices
 *     scanBoundaries?: (lines: string[]) => {state:'completed'|'degraded', boundaries:number[], reason:string|null},
 *                              // optional structured form; `degraded` = the scan bailed out and the
 *                              // chunker must fall back to whole-file chunks (never a guessed split)
 *     tools?: ToolConfig[],    // see linter.mjs; the C# tools are PROJECT-scoped (`projectMarkers`)
 *   }
 *
 * ImportRecord (JS/TS): { kind: 'es'|'cjs', specifier: string }
 * ImportRecord (Py):    { kind: 'from'|'import', dots: number, modulePath: string, importedNames: string[] }
 *
 * CRITICAL: `importRegex` has the 'g' flag (global), so it carries `lastIndex`
 * state across calls. Callers MUST clone it before iterating with `.exec()`:
 *     const regex = new RegExp(profile.importRegex.source, profile.importRegex.flags);
 * Otherwise concurrent/sequential callers will skip matches or loop forever.
 * See `buildDependencyGraph()` in code-analysis.mjs for the canonical pattern.
 */

// ── Boundary helpers ────────────────────────────────────────────────────────

/** Build a getBoundaries function from a boundary regex (for regex-based profiles). */
function makeRegexBoundaries(regex) {
  return (lines) => {
    const boundaries = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) boundaries.push(i);
    }
    return boundaries;
  };
}

/**
 * Python-specific boundary scanner. Groups contiguous @decorator lines
 * with the following def/class so they stay together in chunks.
 * @param {string[]} lines - Source lines (already split by '\n')
 * @returns {number[]} Array of 0-indexed boundary line numbers
 */
export function pythonBoundaryScanner(lines) {
  const boundaries = [];
  let decoratorStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^@\w/.test(line)) {
      // Start of a decorator block (if not already inside one)
      if (decoratorStart === -1) decoratorStart = i;
    } else if (/^(?:async\s+)?(?:def|class)\s+\w+/.test(line)) {
      // def/class at column 0 — this is a boundary
      boundaries.push(decoratorStart !== -1 ? decoratorStart : i);
      decoratorStart = -1;
    } else if (line.trim() !== '' && !line.startsWith(' ') && !line.startsWith('\t')) {
      // Non-decorator, non-def, non-indented, non-blank line breaks any decorator block
      decoratorStart = -1;
    }
    // Blank lines and indented lines don't affect decorator grouping
  }
  return boundaries;
}

// ── Deep freeze helper (Object.freeze is shallow) ───────────────────────────

const freezeProfile = (p) => Object.freeze({
  ...p,
  extensions: Object.freeze(p.extensions),
  tools: p.tools ? Object.freeze(p.tools.map(t => Object.freeze({
    ...t,
    args: Object.freeze(t.args),
    ...(t.projectMarkers ? { projectMarkers: Object.freeze([...t.projectMarkers]) } : {}),
    availabilityProbe: Object.freeze([t.availabilityProbe[0], Object.freeze(t.availabilityProbe[1])]),
    ...(t.fallback ? { fallback: Object.freeze({ ...t.fallback, args: Object.freeze(t.fallback.args), availabilityProbe: Object.freeze([t.fallback.availabilityProbe[0], Object.freeze(t.fallback.availabilityProbe[1])]) }) } : {})
  }))) : Object.freeze([])
});

// ── Resolvers (forward declarations — defined below) ────────────────────────
// These are referenced inside PROFILES; hoisted because they're function declarations.

// ── Language profiles ───────────────────────────────────────────────────────

const PROFILES = Object.freeze({
  js: freezeProfile({
    id: 'js',
    extensions: languageById('js').extensions,
    // Covers: import x from 'y' | import {x} from 'y' | import * as x from 'y'
    //         import 'y' | export {x} from 'y' | export * from 'y'
    //         import('y') | require('y')
    importRegex: /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*\s+from\s+)?['"]([^'"]+)['"]|(?:^|\W)import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\W)require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
    importExtractor: (m) => {
      const specifier = m[1] || m[2] || m[3];
      if (!specifier) return null;
      return { kind: m[3] ? 'cjs' : 'es', specifier };
    },
    exportRegex: /^export\s/,
    resolveImport: jsResolveImport,
    getBoundaries: makeRegexBoundaries(
      /^(?:export\s+)?(?:async\s+)?(?:function|class)\s|^export\s+(?:const|let|var)\s+\w+\s*=/
    ),
    // Phase C: static analysis tools for JS files
    tools: [{
      id: 'eslint',
      kind: 'linter',
      command: 'npx',
      args: ['--no-install', '--offline', 'eslint', '--format', 'json', '--no-error-on-unmatched-pattern', '.'],
      scope: 'project',
      scopeToFiles: true,
      availabilityProbe: ['npx', ['--no-install', '--offline', 'eslint', '--version']],
      parser: 'parseEslintOutput',
    }],
  }),

  ts: freezeProfile({
    id: 'ts',
    extensions: languageById('ts').extensions,
    // Supports require() since .cts is CommonJS-oriented
    importRegex: /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*\s+from\s+)?['"]([^'"]+)['"]|(?:^|\W)import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\W)require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
    importExtractor: (m) => {
      const specifier = m[1] || m[2] || m[3];
      if (!specifier) return null;
      return { kind: m[3] ? 'cjs' : 'es', specifier };
    },
    exportRegex: /^export\s/,
    resolveImport: jsResolveImport, // same as JS for relative imports
    getBoundaries: makeRegexBoundaries(
      /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s|^export\s+(?:const|let|var)\s+\w+\s*[=:]/
    ),
    // Phase C: eslint + tsc type-checker for TypeScript files
    tools: [
      {
        id: 'eslint',
        kind: 'linter',
        command: 'npx',
        args: ['--no-install', '--offline', 'eslint', '--format', 'json', '--no-error-on-unmatched-pattern', '.'],
        scope: 'project',
        availabilityProbe: ['npx', ['--no-install', '--offline', 'eslint', '--version']],
        parser: 'parseEslintOutput',
      },
      {
        id: 'tsc',
        kind: 'typeChecker',
        command: 'npx',
        args: ['--no-install', '--offline', 'tsc', '--noEmit', '--pretty', 'false'],
        scope: 'project',
        availabilityProbe: ['npx', ['--no-install', '--offline', 'tsc', '--version']],
        parser: 'parseTscOutput',
      },
    ],
  }),

  py: freezeProfile({
    id: 'py',
    extensions: languageById('py').extensions,
    // Python imports: captures module + imported names for proper resolution.
    // Matches: `from X import a, b, c` | `from .X import a` | `import X` | `from . import X`
    // NOTE: \t and spaces in imported-names group, NOT \s — \s matches newlines and
    // would greedy-consume across multi-line imports, eating the next line's `from`.
    importRegex: /^(?:from[ \t]+(\.+)?([\w.]*)[ \t]+import[ \t]+([\w,* \t]+(?:[ \t]+as[ \t]+\w+)?)|import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+\w+)?)/gm,
    importExtractor: (m) => {
      // m[4] = bare `import X` or `import X as Y`
      if (m[4]) {
        return { kind: 'import', dots: 0, modulePath: m[4], importedNames: [] };
      }
      // m[1] = leading dots (relative), m[2] = module path after dots, m[3] = imported names
      const dots = (m[1] || '').length;
      const modulePath = m[2] || '';
      const importedNames = (m[3] || '')
        .split(',')
        .map(n => n.trim().split(/\s+as\s+/)[0])
        .filter(n => n && n !== '*');
      return { kind: 'from', dots, modulePath, importedNames };
    },
    // Python "exports" (best-effort regex — v2 will add __all__ handling + lowercase vars):
    // Matches: top-level `def NAME`, `class NAME`, `async def NAME` (not starting with _)
    //          and ALL_CAPS constant assignments.
    exportRegex: /^(?:(?:async\s+)?(?:def|class)\s+[a-zA-Z]|[A-Z_][A-Z0-9_]*\s*=)/,
    resolveImport: pyResolveImport,
    getBoundaries: pythonBoundaryScanner, // custom decorator-aware scanner
    // Phase C: ruff primary, flake8 fallback for Python files
    tools: [{
      id: 'ruff',
      kind: 'linter',
      command: 'ruff',
      args: ['check', '--output-format', 'json', '.'],
      scope: 'project',
      scopeToFiles: true,
      availabilityProbe: ['ruff', ['--version']],
      parser: 'parseRuffOutput',
      fallback: {
        id: 'flake8',
        kind: 'linter',
        command: 'flake8',
        args: ['--format', 'pylint', '.'],
        scope: 'project',
        scopeToFiles: true,
        availabilityProbe: ['flake8', ['--version']],
        parser: 'parseFlake8PylintOutput',
      },
    }],
  }),

  // C#. Deliberately the smallest profile that stops a C# change being invisible:
  // a real lexer + scope-stack boundary scanner (csharp-scanner.mjs) and a
  // compiler pre-pass. NOT an import graph: C# resolves by NAMESPACE, not path,
  // so `resolveImport` returns [] (honest) rather than faking a path resolver,
  // and `buildDependencyGraph` has no production caller today.
  cs: freezeProfile({
    id: 'cs',
    extensions: languageById('cs').extensions,
    // using System.Text; | global using Foo.Bar; | using static X.Y; | using A = X.Y;
    importRegex: /^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:[A-Za-z_]\w*[ \t]*=[ \t]*)?([\w.]+)[ \t]*;/gm,
    importExtractor: (m) => (m[1] ? { kind: 'using', namespace: m[1] } : null),
    exportRegex: /^\s*(?:public|internal)\s+(?:(?:static|sealed|abstract|partial|readonly|unsafe|file)\s+)*(?:class|struct|record|interface|enum|delegate)\s/,
    resolveImport: () => [],
    getBoundaries: csharpBoundaryScanner,
    scanBoundaries: scanCsharpBoundaries,
    // Both tools are PROJECT-scoped: MSBuild builds a project, not a file list, so the
    // runner resolves each changed file to its owning project (`projectMarkers`, nearest
    // directory first) and builds that project once. Findings are then filtered to the
    // audited files, exactly as tsc's are.
    //
    // --no-incremental is load-bearing: an incremental build re-emits NO warnings for an
    // up-to-date project (measured on storyline's renderer: 0 warnings incremental, 1 with
    // --no-incremental), so a plain build reads clean over code it never re-analysed.
    // --no-restore keeps the audit off the NuGet network; an unrestored project fails with
    // NETSDK1004, which the parser flags as a tool fault (failed, never clean).
    tools: [
      {
        id: 'dotnet-build',
        kind: 'typeChecker',
        command: 'dotnet',
        args: ['build', '{project}', '--no-incremental', '--no-restore', '-nologo', '-clp:NoSummary',
          '-nodeReuse:false', '-m:1', '-p:UseSharedCompilation=false'],
        scope: 'project',
        projectMarkers: ['.csproj', '.sln', '.slnx'],
        restoreToggle: true,
        timeoutMs: 300_000,
        maxProjects: 6,
        availabilityProbe: ['dotnet', ['--version']],
        parser: 'parseMsbuildOutput',
      },
      {
        id: 'dotnet-format',
        kind: 'linter',
        command: 'dotnet',
        args: ['format', '{project}', '--verify-no-changes', '--no-restore'],
        scope: 'project',
        projectMarkers: ['.csproj', '.sln', '.slnx'],
        restoreToggle: true,
        combineStderr: true,
        timeoutMs: 300_000,
        maxProjects: 6,
        availabilityProbe: ['dotnet', ['--version']],
        parser: 'parseDotnetFormatOutput',
      },
    ],
  }),
});

// Explicit UNKNOWN_PROFILE for unsupported extensions — no silent JS default.
const UNKNOWN_PROFILE = Object.freeze({
  id: 'unknown',
  extensions: Object.freeze([]),
  importRegex: null,
  importExtractor: () => null,
  exportRegex: null,
  resolveImport: () => [],
  getBoundaries: () => [],
  tools: Object.freeze([]),
});

// ── Profile lookup API ──────────────────────────────────────────────────────

export function getAllProfiles() {
  return PROFILES;
}

export function getProfile(langId) {
  return PROFILES[langId] || UNKNOWN_PROFILE;
}

/**
 * Coverage class for a path: the taxonomy's kind, with `source` split into
 * `profiled` (a profile exists: boundaries, imports, tools) and `model-only`
 * (audited by the model, no deterministic analysis). Pure; path only.
 *
 * @param {string} filePath
 * @returns {{class: 'profiled'|'model-only'|'declarative'|'non-code'|'uncovered',
 *   language: string|null, extension: string|null, rule: string}}
 */
export function classifyFileCoverage(filePath) {
  const m = matchFileKind(filePath);
  if (m.kind === 'source') {
    return { class: PROFILES[m.language] ? 'profiled' : 'model-only', language: m.language, extension: m.extension, rule: m.rule };
  }
  return { class: m.kind, language: m.language, extension: m.extension, rule: m.rule };
}

export function getProfileForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  for (const profile of Object.values(PROFILES)) {
    if (profile.extensions.includes(ext)) return profile;
  }
  return UNKNOWN_PROFILE;
}

/**
 * Count files per language. Returns a Map of profile.id → count.
 */
export function countFilesByLanguage(files) {
  const counts = new Map();
  for (const f of files) {
    const profile = getProfileForFile(f);
    counts.set(profile.id, (counts.get(profile.id) || 0) + 1);
  }
  return counts;
}

/**
 * Determine dominant language from a file list. Returns null if no supported
 * files are present — callers must handle null explicitly (no hidden JS default).
 */
export function detectDominantLanguage(files) {
  const counts = countFilesByLanguage(files);
  counts.delete('unknown');
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ── Extension metadata (single source of truth) ────────────────────────────

/**
 * Every extension the audit will read (source languages + declarative files),
 * without the leading dot, derived from the taxonomy so a new language is one
 * edit there. Feeds file-reference parsing (`buildFileReferenceRegex`).
 */
export const ALL_SUPPORTED_EXTENSIONS = Object.freeze(
  [...new Set(AUDITABLE_EXTENSIONS.map((e) => e.slice(1)))]
);

// `toExtensionAlternation` now lives in file-taxonomy.mjs (dependency-free); re-exported so the public API is unchanged.
export { toExtensionAlternation };

/** Pipe-joined regex-ready extension alternation (longest-first). */
export const ALL_EXTENSIONS_PATTERN = toExtensionAlternation(ALL_SUPPORTED_EXTENSIONS);

/**
 * Well-known filenames that carry no extension. Without this branch the
 * dotted-extension requirement below made `Dockerfile`/`Makefile` invisible to
 * every caller of `buildFileReferenceRegex` — found as a HIGH in
 * `scripts/lib/finding-match.mjs` (a candidate mentioning `Dockerfile`
 * resolved to zero file refs while the literal same string on a stored row's
 * `primary_file` resolved fine via `normalizePath`, defeating same-file
 * suppression checks both there and in `semantic-suppression.mjs`) and
 * independently as a MEDIUM on the suppression side. Case-sensitive and
 * exact-match (no trailing extension of their own), matching the ecosystem
 * convention for each.
 */
// KNOWN_EXTENSIONLESS_FILENAMES: imported from file-taxonomy.mjs (the one registry).


/** Pipe-joined, longest-first alternation of the filenames above. */
const EXTENSIONLESS_FILENAME_PATTERN = toExtensionAlternation(KNOWN_EXTENSIONLESS_FILENAMES);

/**
 * Build a file-reference regex for path extraction from free text.
 * Handles: 'foo.py', './foo.py', '../foo.py', '/abs/foo.py', backticked, quoted,
 * and a well-known extensionless filename (optionally path-prefixed, e.g. 'docker/Dockerfile').
 */
export function buildFileReferenceRegex() {
  return new RegExp(
    `(?:^|[\\s\`('"])` +
    `((?:\\.{1,2}\\/|\\/)?(?:[\\w.-]+\\/)*(?:[\\w.-]+\\.(?:${ALL_EXTENSIONS_PATTERN})|(?:${EXTENSIONLESS_FILENAME_PATTERN})))`,
    'g'
  );
}

// ── LanguageContext (repo-specific resolver state) ──────────────────────────

/**
 * Build per-repo language context. Called once at audit start.
 * @param {string[]} files - All source files discovered in the repo
 * @returns {{repoFileSet: Set<string>, pythonPackageRoots: string[]}}
 */
export function buildLanguageContext(files) {
  return {
    repoFileSet: new Set(files.map(f => normalizePath(f))),
    pythonPackageRoots: detectPythonPackageRoots(files),
  };
}

/**
 * Discover Python package roots. A root is a directory whose packages
 * can be imported with absolute syntax (e.g. `from app.services import x`).
 *
 * Algorithm:
 *   1. Find all directories containing __init__.py (or __init__.pyi for stubs)
 *   2. For each, the "root" is its PARENT (so `from pkgname.x import y` works)
 *   3. Deduplicate and add common layout roots ('.' and 'src' if present)
 */
export function detectPythonPackageRoots(files) {
  // Include both __init__.py and __init__.pyi (stub packages)
  const initFiles = files.filter(f =>
    f.endsWith('/__init__.py') || f === '__init__.py' ||
    f.endsWith('/__init__.pyi') || f === '__init__.pyi'
  );
  const packageDirs = new Set(initFiles.map(f => path.dirname(f) || '.'));

  const roots = new Set();
  for (const pkgDir of packageDirs) {
    const parent = path.dirname(pkgDir);
    // If parent is NOT also a package, then parent is a root
    if (!packageDirs.has(parent)) {
      roots.add(parent === '.' ? '.' : parent);
    }
  }

  // Always include repo root + common src/ layout
  roots.add('.');
  if (files.some(f => f.startsWith('src/'))) roots.add('src');

  // Return in deterministic order (shortest path first = closest to repo root)
  return [...roots].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

// ── Resolvers (implementations referenced by profiles above) ────────────────

/**
 * JavaScript/TypeScript import resolver.
 * Accepts structured import record: { kind: 'es'|'cjs', specifier }
 * Candidates are derived from registered JS/TS profile extensions (no hardcoding).
 * Only handles relative imports — tsconfig paths deferred to v2.
 * @returns {string[]} Resolved paths (0 or 1 element for JS/TS)
 */
function jsResolveImport(importRecord, fromFile, repoFileSet, _langContext) {
  const { specifier } = importRecord;
  if (!specifier.startsWith('.')) return []; // External package
  const fromDir = path.dirname(fromFile);
  const base = normalizePath(path.join(fromDir, specifier));

  // Caller-aware resolution: prefer extensions matching importer's language family.
  // A .ts file prefers .ts → .tsx → .js (dual-package fallback). A .js file prefers
  // .js → .mjs → .ts (allows JS depending on TS via built output).
  const fromExt = path.extname(fromFile).toLowerCase();
  const tsExts = PROFILES.ts.extensions;
  const jsExts = PROFILES.js.extensions;
  const orderedExts = tsExts.includes(fromExt)
    ? [...tsExts, ...jsExts]  // TS importer: TS-family first
    : [...jsExts, ...tsExts]; // JS importer: JS-family first

  const candidates = [base]; // Direct match (specifier may already have extension)
  for (const ext of orderedExts) candidates.push(base + ext);
  for (const ext of orderedExts) candidates.push(base + '/index' + ext);

  const match = candidates.find(c => repoFileSet.has(c));
  return match ? [match] : [];
}

/**
 * Python import resolver. Accepts structured import record.
 * Handles relative (from .x import y) and absolute (from pkg.x import y) imports.
 * Attempts to resolve imported names as submodules before falling back to package.
 *
 * @param {object} importRecord - { kind, dots, modulePath, importedNames }
 * @param {string} fromFile - File containing the import
 * @param {Set<string>} repoFileSet - Normalized file paths in repo
 * @param {object} [langContext] - { pythonPackageRoots: string[] }
 * @returns {string[]} Resolved file paths (can be multiple for `from X import a, b`)
 */
function pyResolveImport(importRecord, fromFile, repoFileSet, langContext) {
  const { kind, dots = 0, modulePath = '', importedNames = [] } = importRecord;
  const resolved = [];

  // Determine base directory(ies) to search
  const searchBases = [];
  if (dots > 0) {
    // Relative import: walk up (dots - 1) directories from the source file
    let base = path.dirname(fromFile);
    for (let i = 1; i < dots; i++) base = path.dirname(base);
    searchBases.push(base);
  } else {
    // Absolute import (from pkg.mod import x) OR bare import X — search package roots
    for (const root of (langContext?.pythonPackageRoots || ['.'])) {
      searchBases.push(root === '.' ? '' : root);
    }
  }

  const moduleParts = modulePath ? modulePath.split('.') : [];
  const pyExts = ['.py', '.pyi'];

  for (const base of searchBases) {
    const targetDir = base
      ? path.join(base, ...moduleParts)
      : (moduleParts.length ? path.join(...moduleParts) : '.');

    // Strategy 1: modulePath is a file itself (foo.py or foo.pyi)
    for (const ext of pyExts) {
      const moduleFile = targetDir + ext;
      if (repoFileSet.has(normalizePath(moduleFile))) resolved.push(normalizePath(moduleFile));
    }

    // Strategy 2: modulePath is a package (__init__.py OR __init__.pyi)
    for (const ext of pyExts) {
      const initFile = path.join(targetDir, '__init__' + ext);
      if (repoFileSet.has(normalizePath(initFile))) resolved.push(normalizePath(initFile));
    }

    // Strategy 3: imported names are submodules
    // e.g. `from app.services import user` → app/services/user.py|.pyi
    if (kind === 'from') {
      for (const name of importedNames) {
        for (const ext of pyExts) {
          const submoduleFile = path.join(targetDir, name + ext);
          if (repoFileSet.has(normalizePath(submoduleFile))) resolved.push(normalizePath(submoduleFile));
          const submodulePkg = path.join(targetDir, name, '__init__' + ext);
          if (repoFileSet.has(normalizePath(submodulePkg))) resolved.push(normalizePath(submodulePkg));
        }
      }
    }

    if (resolved.length > 0) break; // Found matches at this base — stop searching
  }

  return resolved; // Empty array = external package or unresolvable
}
