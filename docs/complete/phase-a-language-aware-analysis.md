# Plan: Phase A — Language-Aware Code Analysis

- **Date**: 2026-04-04
- **Status**: Audit-complete, ready to implement
- **Audit history**: 4 rounds (R1 H:2 M:4 L:1 → R2 H:2 M:5 L:1 → R3 H:3 M:4 L:2 → R4 H:3 M:3 L:1)
- **Stopping criteria**: HIGH count plateaued at R3 (3) and did not decrease. R4 findings shifted to architectural refinement pressure (parser-based Python imports, full cross-platform path support, tighter module SRP) rather than correctness bugs. Remaining concerns captured in §7 Out of Scope.
- **Author**: Claude + Louis
- **Scope**: Fix the concrete regex/extension gaps that make Python (and extensible languages) fail in code-analysis, ledger metadata, and dependency graph. **No new features** — only making existing analysis work correctly for JS/TS/Python.
- **Parent plan**: `multi-language-and-linter-integration.md` (Phase A of 3)

---

## 1. Context Summary

### What Exists Today

The audit loop's code analysis is built around JavaScript/TypeScript idioms:

- **`splitAtFunctionBoundaries()`** at [code-analysis.mjs:39](scripts/lib/code-analysis.mjs#L39) — regex matches `function|class|export const` only
- **`buildDependencyGraph()`** at [code-analysis.mjs:128](scripts/lib/code-analysis.mjs#L128) — regex matches `from 'module'` (quoted) only, skips specifiers that don't start with `.`
- **`extractImportBlock()`** at [code-analysis.mjs:24](scripts/lib/code-analysis.mjs#L24) — stops at first `function|class|export`
- **`extractExportsOnly()`** at [code-analysis.mjs:112](scripts/lib/code-analysis.mjs#L112) — grep for `^export\s`
- **`populateFindingMetadata()`** at [ledger.mjs:170](scripts/lib/ledger.mjs#L170) — file regex omits `.py`
- **`classifyFiles()`** at [file-io.mjs:395](scripts/lib/file-io.mjs#L395) — no Python frontend/test patterns

### Observable Symptoms

When this loop audits a Python codebase:
- Python files larger than ~6000 tokens get naive line-count splitting (no `def`/`class` boundary detection)
- Python imports are completely invisible to the dependency graph (`import module` / `from module import x` ignored)
- Python findings lose file references — `populateFindingMetadata()` regex doesn't match `.py` paths
- R2+ suppression cascades into failure because `affectedFiles` is empty for Python findings

### Key Requirement

**Data-driven dispatch by file extension.** One registry, one regex per language, no hidden defaults. This is the foundation for Phase B (classification) and Phase C (linter).

### Non-Goals (deferred to later phases)

- SonarQube taxonomy / `classification` field → Phase B
- Linter integration, `tools[]` config → Phase C
- Framework detection (Django/Flask/FastAPI) → Phase B or later
- tsconfig path alias resolution — v2 enhancement
- Python namespace packages — v2 enhancement
- Full route/DTO/env extractors — deferred indefinitely

---

## 2. Proposed Architecture

### 2.1 Language Profile Registry

**New file**: `scripts/lib/language-profiles.mjs`

A flat, immutable registry of language-specific patterns. **Only what's needed for Phase A** — no framework detection, no linter config, no SonarQube hints.

```javascript
/**
 * @fileoverview Language profile registry — one profile per supported language.
 * Data-driven dispatch for code analysis (chunking, imports, exports).
 * Profiles are IMMUTABLE. Repo-specific state (like detected package roots)
 * lives in LanguageContext (built per-run, not baked into profiles).
 */

import path from 'node:path';

/**
 * Profile shape (TypeScript-like documentation):
 *   {
 *     id: string,              // Stable identity: 'js' | 'ts' | 'py'
 *     extensions: string[],    // e.g. ['.py', '.pyi']
 *     importRegex: RegExp,     // Import statement matcher (with 'g' flag)
 *     importExtractor: (match: RegExpMatchArray) => ImportRecord | null,
 *     exportRegex: RegExp,     // Export-line matcher
 *     resolveImport: (record, fromFile, repoFileSet, langContext) => string[],
 *     getBoundaries: (lines: string[]) => number[],  // Boundary line indices
 *   }
 *
 * getBoundaries is the single boundary-detection capability. Regex-based profiles
 * can build it from a boundaryRegex helper (makeRegexBoundaries) — no branching on profile.id.
 */

/** Build a getBoundaries function from a boundary regex. */
function makeRegexBoundaries(regex) {
  return (lines) => {
    const boundaries = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) boundaries.push(i);
    }
    return boundaries;
  };
}

// NOTE: extensions arrays MUST also be frozen (Object.freeze is shallow).
// A helper ensures deep freezing at profile creation time.
const freezeProfile = (p) => Object.freeze({ ...p, extensions: Object.freeze(p.extensions) });

const PROFILES = Object.freeze({
  js: freezeProfile({
    id: 'js',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    boundaryRegex: /^(?:export\s+)?(?:async\s+)?(?:function|class)\s|^export\s+(?:const|let|var)\s+\w+\s*=/,
    // Covers: import x from 'y' | import {x} from 'y' | import * as x from 'y'
    //         import 'y' | export {x} from 'y' | export * from 'y'
    //         import('y') | require('y')
    importRegex: /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*\s+from\s+)?['"]([^'"]+)['"]|(?:^|\W)import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\W)require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
    // Returns { kind: 'es'|'cjs', specifier } — structured record like Python
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
  }),

  ts: freezeProfile({
    id: 'ts',
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    boundaryRegex: /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s|^export\s+(?:const|let|var)\s+\w+\s*[=:]/,
    // Supports require() since .cts is CommonJS-oriented
    importRegex: /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*\s+from\s+)?['"]([^'"]+)['"]|(?:^|\W)import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\W)require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
    importExtractor: (m) => {
      const specifier = m[1] || m[2] || m[3];
      if (!specifier) return null;
      return { kind: m[3] ? 'cjs' : 'es', specifier };
    },
    exportRegex: /^export\s/,
    resolveImport: jsResolveImport,  // same as JS for relative imports
    getBoundaries: makeRegexBoundaries(
      /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s|^export\s+(?:const|let|var)\s+\w+\s*[=:]/
    ),
  }),

  py: freezeProfile({
    id: 'py',
    extensions: ['.py', '.pyi'],
    // Decorator-aware: match decorator lines OR def/class at column 0
    boundaryRegex: /^(?:@\w|(?:async\s+)?(?:def|class)\s+\w+)/,
    // Python imports: captures module + imported names for proper resolution
    // Matches: `from X import a, b, c` | `from .X import a` | `import X` | `from . import X`
    importRegex: /^(?:from\s+(\.+)?([\w.]*)\s+import\s+([\w,\s*]+(?:\s+as\s+\w+)?)|import\s+([\w.]+)(?:\s+as\s+\w+)?)/gm,
    importExtractor: (m) => {
      // Returns structured import record (not just a string):
      //   { kind: 'from'|'import', dots, modulePath, importedNames }
      if (m[4]) {
        // `import X` or `import X as Y`
        return { kind: 'import', dots: 0, modulePath: m[4], importedNames: [] };
      }
      // `from [.]*X import a, b`
      const dots = (m[1] || '').length;
      const modulePath = m[2] || '';
      const importedNames = (m[3] || '').split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(n => n && n !== '*');
      return { kind: 'from', dots, modulePath, importedNames };
    },
    // Python "exports" (best-effort regex — v2 will add __all__ handling + lowercase vars):
    // Matches: top-level `def NAME`, `class NAME`, `async def NAME` (not starting with _)
    //          and ALL_CAPS constant assignments.
    // Does NOT match: lowercase module vars, __all__ list. Those are out of scope for Phase A.
    exportRegex: /^(?:(?:async\s+)?(?:def|class)\s+[a-zA-Z]|[A-Z_][A-Z0-9_]*\s*=)/,
    resolveImport: pyResolveImport,
    getBoundaries: pythonBoundaryScanner,  // custom decorator-aware scanner
  })
});

// Explicit UNKNOWN_PROFILE for unsupported extensions — no silent JS default
const UNKNOWN_PROFILE = Object.freeze({
  id: 'unknown',
  extensions: [],
  importRegex: null,
  importExtractor: () => null,
  exportRegex: null,
  resolveImport: () => [],
  getBoundaries: () => [],
});

export function getAllProfiles() { return PROFILES; }

export function getProfile(langId) {
  return PROFILES[langId] || UNKNOWN_PROFILE;
}

// ── Extension metadata (single source of truth) ────────────────────────────

/**
 * Code extensions from registered profiles (derived, single source of truth).
 * Any new profile automatically contributes to this list.
 */
const CODE_EXTENSIONS = [...new Set(
  Object.values(PROFILES).flatMap(p => p.extensions.map(e => e.slice(1)))
)];

/**
 * Non-code asset extensions referenced in plans/findings.
 * These are NOT language profiles, but plans commonly reference them
 * (e.g. "update src/schema.json"). Named constant for explicit ownership.
 */
const NON_CODE_REFERENCED_EXTENSIONS = Object.freeze(['json', 'css', 'html', 'md', 'sql']);

/** Union of code + non-code extensions supported for file-reference parsing. */
export const ALL_SUPPORTED_EXTENSIONS = Object.freeze(
  [...CODE_EXTENSIONS, ...NON_CODE_REFERENCED_EXTENSIONS]
);

/**
 * Pipe-joined regex-ready extension alternation.
 * Sorted LONGEST-FIRST so multi-char extensions match before prefixes
 * (e.g. 'tsx' must try before 'ts', 'mjs' before 'js').
 */
export const ALL_EXTENSIONS_PATTERN = [...ALL_SUPPORTED_EXTENSIONS]
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * Build a file-reference regex for path extraction from free text.
 * Handles: 'foo.py', './foo.py', '../foo.py', '/abs/foo.py', backticked, quoted.
 */
export function buildFileReferenceRegex() {
  return new RegExp(
    `(?:^|[\\s\`('"])` +
    `((?:\\.{1,2}\\/|\\/)?(?:[\\w.-]+\\/)*[\\w.-]+\\.(?:${ALL_EXTENSIONS_PATTERN}))`,
    'g'
  );
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
 * Determine dominant language from a file list.
 * Returns the language id with the most SUPPORTED source files, or null
 * if no supported files are present. Callers must handle the null case
 * (no hidden 'js' default — callers decide the fallback policy).
 */
export function detectDominantLanguage(files) {
  const counts = countFilesByLanguage(files);
  counts.delete('unknown');
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
```

### 2.2 LanguageContext (Repo-Specific Resolver State)

**Same file**: `scripts/lib/language-profiles.mjs`

Resolvers need repo-specific data (Python package roots, file set). This is built once per audit run and passed into resolvers — profiles stay immutable.

```javascript
/**
 * Build per-repo language context. Called once at audit start.
 * @param {string[]} files - All source files discovered in the repo
 * @returns {LanguageContext}
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
 *   1. Find all directories containing __init__.py
 *   2. For each, the "root" is its PARENT (so `from pkgname.x` works)
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
```

### 2.3 Resolvers (Per-Language Import Resolution)

**Same file**: `scripts/lib/language-profiles.mjs`

```javascript
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
  const tsExts = PROFILES.ts.extensions;      // ['.ts', '.tsx', '.mts', '.cts']
  const jsExts = PROFILES.js.extensions;      // ['.js', '.mjs', '.cjs', '.jsx']
  const orderedExts = tsExts.includes(fromExt)
    ? [...tsExts, ...jsExts]   // TS importer: TS-family first
    : [...jsExts, ...tsExts];  // JS importer: JS-family first

  const candidates = [base]; // Direct match (specifier already has extension)
  for (const ext of orderedExts) candidates.push(base + ext);
  for (const ext of orderedExts) candidates.push(base + '/index' + ext);

  // Return first match — importer's language family has priority
  const match = candidates.find(c => repoFileSet.has(c));
  return match ? [match] : [];
}

/**
 * Python import resolver. Accepts STRUCTURED import record (not bare string).
 * Handles relative (from .x import y) and absolute (from pkg.x import y) imports.
 * Attempts to resolve imported names as submodules before falling back to package.
 *
 * @param {object} importRecord - { kind, dots, modulePath, importedNames }
 * @param {string} fromFile - File containing the import
 * @param {Set<string>} repoFileSet - Normalized file paths in repo
 * @param {object} langContext - { pythonPackageRoots: string[] }
 * @returns {string[]} Resolved file paths (can be multiple if import X, Y, Z)
 */
function pyResolveImport(importRecord, fromFile, repoFileSet, langContext) {
  const { kind, dots = 0, modulePath = '', importedNames = [] } = importRecord;
  const resolved = [];

  // Determine base directory
  const searchBases = [];
  if (dots > 0 || kind === 'import') {
    // Relative import OR bare `import X`
    if (dots > 0) {
      let base = path.dirname(fromFile);
      for (let i = 1; i < dots; i++) base = path.dirname(base);
      searchBases.push(base);
    } else {
      // Bare `import pkg.mod` — search package roots
      for (const root of (langContext?.pythonPackageRoots || ['.'])) {
        searchBases.push(root === '.' ? '' : root);
      }
    }
  } else {
    // Absolute `from pkg.mod import x` — search package roots
    for (const root of (langContext?.pythonPackageRoots || ['.'])) {
      searchBases.push(root === '.' ? '' : root);
    }
  }

  // Build module path segments
  const moduleParts = modulePath ? modulePath.split('.') : [];

  for (const base of searchBases) {
    // Target path to the module
    const targetDir = base
      ? path.join(base, ...moduleParts)
      : moduleParts.length ? path.join(...moduleParts) : '.';

    // Python extensions to try (source + stub files)
    const pyExts = ['.py', '.pyi'];

    // Strategy 1: modulePath is a file itself
    for (const ext of pyExts) {
      const moduleFile = targetDir + ext;
      if (repoFileSet.has(normalizePath(moduleFile))) resolved.push(normalizePath(moduleFile));
    }

    // Strategy 2: modulePath is a package (__init__.py OR __init__.pyi)
    for (const ext of pyExts) {
      const initFile = path.join(targetDir, '__init__' + ext);
      if (repoFileSet.has(normalizePath(initFile))) resolved.push(normalizePath(initFile));
    }

    // Strategy 3: imported names are submodules (app.services import user → app/services/user.py|.pyi)
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

    if (resolved.length > 0) break; // Found at this base — stop searching
  }

  return resolved; // Empty array = external package
}
```

### 2.4 Python Decorator-Aware Boundary Scanner

**Same file**: `scripts/lib/language-profiles.mjs`

Regex-only boundary detection splits decorator blocks from their functions. FastAPI/Flask/pytest/dataclasses all use decorators — this must be handled.

```javascript
/**
 * Python-specific boundary scanner. Groups contiguous @decorator lines
 * with the following def/class so they stay together in chunks.
 *
 * Interface contract: all profiles provide getBoundaries(lines) — either
 * derived from boundaryRegex (default) or from a custom scanner.
 *
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

// Attach scanner to Python profile (post-freeze trick: wrap with a getter)
// Or: expose scanner separately and dispatch in code-analysis.mjs
```

**Design decision**: Every profile exports `getBoundaries(lines) → number[]`. Regex-based profiles use `makeRegexBoundaries(regex)`, Python uses `pythonBoundaryScanner` directly. **Code-analysis.mjs never branches on `profile.id`** — it always calls `profile.getBoundaries(lines)`. Profiles are frozen with their `getBoundaries` method set at creation time.

### 2.5 Code Analysis — Profile-Dispatched

**Modified file**: `scripts/lib/code-analysis.mjs`

All functions accept an optional `profile` parameter. If not provided, fall back to `getProfileForFile(filePath)`. If the profile is UNKNOWN, the function returns a safe degraded result (no crash).

```javascript
import { getProfileForFile } from './language-profiles.mjs';

/**
 * Extract import block (everything before first function/class).
 * Uses profile's getBoundaries capability. Returns first 2000 chars
 * for UNKNOWN profile (safe degraded behavior).
 */
export function extractImportBlock(source, profile) {
  if (!profile?.getBoundaries) return source.slice(0, Math.min(source.length, 2000));
  const lines = source.split('\n');
  const boundaries = profile.getBoundaries(lines);
  if (boundaries.length === 0) return source.slice(0, Math.min(source.length, 2000));
  return lines.slice(0, boundaries[0]).join('\n');
}

/**
 * Split source at function/class boundaries using profile's getBoundaries.
 * Returns [{source, startLine}] chunks. No branching on profile.id.
 */
export function splitAtFunctionBoundaries(source, profile) {
  const lines = source.split('\n');
  const boundaries = profile?.getBoundaries ? profile.getBoundaries(lines) : [];
  if (boundaries.length === 0) {
    return [{ source, startLine: 1 }]; // Whole file as one chunk
  }
  const chunks = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : lines.length;
    chunks.push({ source: lines.slice(start, end).join('\n'), startLine: start + 1 });
  }
  return chunks;
}

/**
 * Chunk large file. Uses profile-dispatched boundary detection with
 * line-count fallback for unknown profiles / files with no boundaries.
 */
export function chunkLargeFile(source, filePath, maxChunkTokens = 6000, profile) {
  const resolvedProfile = profile || getProfileForFile(filePath);
  const imports = extractImportBlock(source, resolvedProfile);
  const functions = splitAtFunctionBoundaries(source, resolvedProfile);

  if (functions.length <= 1) {
    // No boundaries — line-count fallback (existing behavior preserved)
    const lines = source.split('\n');
    const linesPerChunk = Math.floor(maxChunkTokens * 4 / 80);
    const chunks = [];
    for (let i = 0; i < lines.length; i += linesPerChunk) {
      chunks.push({
        imports,
        items: [{ source: lines.slice(i, i + linesPerChunk).join('\n'), startLine: i + 1 }],
        tokens: estimateTokens(imports) + estimateTokens(lines.slice(i, i + linesPerChunk).join('\n'))
      });
    }
    return chunks;
  }

  // Pack boundaries into chunks
  const chunks = [];
  let current = { imports, items: [], tokens: estimateTokens(imports) };
  for (const fn of functions) {
    const fnTokens = estimateTokens(fn.source);
    if (current.tokens + fnTokens > maxChunkTokens && current.items.length > 0) {
      chunks.push(current);
      current = { imports, items: [], tokens: estimateTokens(imports) };
    }
    current.items.push(fn);
    current.tokens += fnTokens;
  }
  if (current.items.length) chunks.push(current);
  return chunks;
}

/**
 * Build dependency graph. Profile-dispatched import resolution.
 * @param {string[]} files - File paths to analyze
 * @param {LanguageContext} [langContext] - Repo context (for Python package roots)
 * @returns {Map<string, Set<string>>} file → Set of imported files
 */
export function buildDependencyGraph(files, langContext) {
  const graph = new Map();
  const repoFileSet = langContext?.repoFileSet || new Set(files.map(normalizePath));

  for (const file of files) {
    const normFile = normalizePath(file);
    graph.set(normFile, new Set());
    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) continue;

    const profile = getProfileForFile(file);
    if (!profile.importRegex || !profile.resolveImport) continue; // UNKNOWN skips

    const content = fs.readFileSync(absPath, 'utf-8');
    const regex = new RegExp(profile.importRegex.source, profile.importRegex.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const importRecord = profile.importExtractor(match);
      if (!importRecord) continue;
      // resolveImport returns an array of resolved files (0 or more)
      const resolvedPaths = profile.resolveImport(importRecord, file, repoFileSet, langContext);
      for (const resolved of resolvedPaths) {
        graph.get(normFile).add(normalizePath(resolved));
      }
    }
  }
  return graph;
}

/**
 * Extract export signatures only. Profile-dispatched export regex.
 */
export function extractExportsOnly(filePath) {
  const profile = getProfileForFile(filePath);
  if (!profile.exportRegex) return `// ${filePath} — unsupported language`;
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) return '';
  const source = fs.readFileSync(absPath, 'utf-8');
  const lines = source.split('\n');
  const exports = lines.filter(l => profile.exportRegex.test(l));
  return `// ${filePath} — exports only\n${exports.join('\n')}`;
}
```

### 2.6 Fix Finding Metadata File Regex

**Modified file**: `scripts/lib/ledger.mjs` — `populateFindingMetadata()` at line 170

Build the file-extension regex from the profile registry at module load. Single source of truth for all supported extensions.

```javascript
import { buildFileReferenceRegex } from './language-profiles.mjs';

// Single source of truth — regex built from registered profile extensions.
// Handles ./foo.py, ../pkg/mod.py, /abs/foo.py, backticked, quoted forms.
const FILE_REGEX = buildFileReferenceRegex();

export function populateFindingMetadata(finding, passName) {
  const section = finding.section || '';
  const files = [];
  let match;
  // NOTE: global regex — reset lastIndex on each call (or use matchAll)
  FILE_REGEX.lastIndex = 0;
  while ((match = FILE_REGEX.exec(section)) !== null) {
    files.push(normalizePath(match[1]));
  }
  // Rest of function unchanged: dedup, _primaryFile, affectedFiles, _pass, principle, _hash
}
```

### 2.7 Fix `fnRegex` in file-io.mjs

**Modified file**: `scripts/lib/file-io.mjs` — line 244

Consume the single extension pattern exported from `language-profiles.mjs`:

```javascript
import { ALL_EXTENSIONS_PATTERN } from './language-profiles.mjs';
// Allow slash-containing paths: #### `src/app/main.py` or #### `file.py`
const fnRegex = new RegExp(`####\\s+\`([\\w./-]+\\.(?:${ALL_EXTENSIONS_PATTERN}))\``, 'gm');
```

**Fuzzy fallback preserved**: When a heading captures a repo-relative path like `src/app/main.py`, that becomes a direct path to check. When only a basename is captured (`main.py`), existing basename-based fuzzy matching in `_extractPlanKeywords()` handles it.

---

### 2.8 Integration Points (Explicit Caller Wiring)

**Where `LanguageContext` is built**: from RAW discovered files (before any category-based classification), once per audit run.

**Modified file**: `scripts/openai-audit.mjs` — `runMultiPassCodeAudit()`

Build `langContext` BEFORE `classifyFiles()` so Python files reach it regardless of classification heuristics:

```javascript
// Inside runMultiPassCodeAudit(), right after extractPlanPaths() returns `found`:
import { buildLanguageContext } from './lib/language-profiles.mjs';

// CRITICAL: build from raw found files, not from classified buckets.
// classifyFiles() has JS-centric patterns (lacks Python test/frontend detection),
// so Python files may end up in "backend" bucket silently — but langContext
// must see them all for dependency resolution to work.
const langContext = buildLanguageContext(found);

// Classification happens AFTER langContext is built (unchanged):
const { backend, frontend, shared } = classifyFiles(found);
```

**Callers of `buildDependencyGraph()`** — exact list to thread `langContext` through:

| Caller | Location | Change |
|---|---|---|
| `buildAuditUnits()` | `code-analysis.mjs` | Does NOT currently call `buildDependencyGraph()` — no change |
| Any direct usage | grep for `buildDependencyGraph(` | Pass `langContext` as 2nd arg |

**Phase A's direct wins in the audit entrypoint** (even without `buildDependencyGraph` in the flow):

1. **`populateFindingMetadata()` fix** — called for EVERY finding in Round 2+ suppression. Python file paths in findings' `section` field will now populate `affectedFiles` correctly. This alone unblocks R2+ suppression for Python findings.
2. **`fnRegex` fix** — called in `extractPlanPaths()` during plan parsing. Python filenames in plan headings will now be discovered.
3. **Chunking fix** — `chunkLargeFile()` IS called by `buildAuditUnits()` in the entrypoint flow. Python files that exceed `maxChunkTokens` will now split at decorator/def/class boundaries instead of naive line count.

`buildDependencyGraph()` is infrastructure that other phases can wire into. Phase A makes it work correctly for Python so Phase B/C can use it. The `langContext` plumbing in `runMultiPassCodeAudit()` is preparation work — it's unused in Phase A but cheap to add and avoids a second refactor later.

**Contract**: `langContext` parameter is **optional** (backward compat). When omitted:
- `repoFileSet` is built from the `files` arg
- `pythonPackageRoots` defaults to `['.']` (absolute Python imports will only resolve if files live at repo root)
- Callers that want Python src-layout support MUST pass `langContext`

**classifyFiles() note**: Extending `classifyFiles()` with Python patterns (test_*.py, /static/, /templates/) is OUT OF SCOPE for Phase A — it doesn't affect dependency resolution (which uses raw file list). Will be addressed in a future phase if/when pass bucketing needs language-aware classification.

**Integration test**: Add `tests/integration-python-audit.test.mjs` — fixture with `src/app/__init__.py`, `src/app/services.py`, `src/app/main.py` doing `from app.services import foo`. Verify dependency graph has the edge.

## 3. File Impact Summary

| File | Changes |
|---|---|
| `scripts/lib/language-profiles.mjs` | **New** — PROFILES registry, UNKNOWN_PROFILE, resolvers, LanguageContext, pythonBoundaryScanner |
| `scripts/lib/code-analysis.mjs` | Modified — all functions accept `profile`, dispatch to profile's regex/scanner; `buildDependencyGraph` uses `resolveImport` |
| `scripts/lib/ledger.mjs` | Modified — `populateFindingMetadata()` uses ALL_EXTENSIONS from registry |
| `scripts/lib/file-io.mjs` | Modified — `fnRegex` uses ALL_EXTENSIONS from registry |
| `scripts/shared.mjs` | Modified — re-export new symbols from language-profiles.mjs |
| `tests/language-profiles.test.mjs` | **New** — profile dispatch, resolver, boundary scanner tests |
| `tests/code-analysis.test.mjs` | **New or extend existing** — chunking/graph per language |

---

## 4. Testing Strategy

### Unit Tests (hermetic — no external tools)

| Test | What it validates |
|---|---|
| `getProfileForFile('foo.py')` | Returns Python profile |
| `getProfileForFile('foo.tsx')` | Returns TypeScript profile |
| `getProfileForFile('foo.xyz')` | Returns UNKNOWN_PROFILE (not JS) |
| `countFilesByLanguage()` | Counts files per profile.id |
| `detectDominantLanguage([])` | Returns null (no supported files) |
| `detectDominantLanguage(['file.xyz'])` | Returns null (only unknown files) |
| `detectDominantLanguage(pyFiles)` | Returns 'py' for Python-heavy list |
| JS `importRegex` matches `import x from 'y'` | Default imports |
| JS `importRegex` matches `import {x} from 'y'` | Named imports |
| JS `importRegex` matches `import * as x from 'y'` | Namespace imports |
| JS `importRegex` matches `import 'y'` | Side-effect imports |
| JS `importRegex` matches `export {x} from 'y'` | Re-exports |
| JS `importRegex` matches `require('y')` | CommonJS |
| JS `importRegex` matches `import('y')` | Dynamic imports |
| Python `importRegex` matches `import module` | Bare import |
| Python `importRegex` matches `from module import x` | From-import |
| Python `importRegex` matches `from .module import x` | Relative import |
| Python `importRegex` matches `from ..parent.module import x` | Multi-dot relative |
| Python `importRegex` does NOT match `# import comment` | Excludes comments |
| JS `boundaryRegex` matches `function foo()` | Top-level function |
| JS `boundaryRegex` matches `export const x = ...` | Exported const |
| Python `boundaryRegex` matches `def foo():` | Bare def |
| Python `boundaryRegex` matches `@app.route('/')` | Decorator line |
| Python `boundaryRegex` matches `async def foo():` | Async def |
| `pythonBoundaryScanner` groups decorators with def | `@app.route\ndef x():` → one boundary |
| `pythonBoundaryScanner` handles multiple decorators | `@a\n@b\ndef x():` → one boundary |
| `pythonBoundaryScanner` ignores nested defs | Indented `def` doesn't create boundary |
| `detectPythonPackageRoots()` finds package parents | `app/__init__.py` → root is '.' |
| `detectPythonPackageRoots()` handles src/ layout | `src/app/__init__.py` → roots include 'src' |
| `jsResolveImport({specifier:'./foo'}, 'a/b.js', Set('a/foo.js'))` | Returns `['a/foo.js']` |
| `jsResolveImport({specifier:'./foo'}, 'a/b.js', Set('a/foo/index.js'))` | Returns `['a/foo/index.js']` |
| `jsResolveImport({specifier:'./foo'}, 'a/b.ts', Set('a/foo.ts', 'a/foo.js'))` | Returns `['a/foo.ts']` (TS importer prefers TS) |
| `jsResolveImport({specifier:'./foo'}, 'a/b.js', Set('a/foo.ts', 'a/foo.js'))` | Returns `['a/foo.js']` (JS importer prefers JS) |
| `jsResolveImport({specifier:'react'}, ...)` | Returns `[]` (external) |
| `pyResolveImport({kind:'from',dots:1,modulePath:'',importedNames:['utils']}, 'app/x.py', ...)` | Returns relative submodule |
| `pyResolveImport({kind:'from',dots:0,modulePath:'app.services',importedNames:['user']}, 'main.py', ctx)` | Returns `['app/services/user.py']` |
| `pyResolveImport({kind:'import',dots:0,modulePath:'requests',importedNames:[]}, ...)` | Returns `[]` (external) |
| `pyResolveImport({...}, ...)` with `.pyi` stub present | Resolves stub file |

### Regression Tests (backward compat guarantees)

| Test | What it validates |
|---|---|
| `splitAtFunctionBoundaries(jsSource)` without profile arg | Output identical to pre-change behavior for JS |
| `extractImportBlock(jsSource)` without profile arg | Output identical to pre-change behavior |
| `chunkLargeFile(jsSource, 'foo.js')` without profile arg | Output identical to pre-change behavior |
| `extractExportsOnly('foo.js')` | Output identical to pre-change behavior |
| `buildDependencyGraph(jsFiles)` without langContext | Relative JS imports resolve identically to pre-change behavior |
| `populateFindingMetadata()` on JS-only finding | `affectedFiles` unchanged from pre-change behavior |

### Integration Tests (hermetic)

| Test | What it validates |
|---|---|
| Chunk a 1000-line Python file with decorators | Splits at decorator blocks, not inside them |
| Chunk a mixed-export TS file | Splits at interface/type/class boundaries |
| `buildDependencyGraph()` on Python project | Resolves both relative and absolute imports |
| `buildDependencyGraph()` on JS project | Resolves ESM + CommonJS |
| `buildDependencyGraph()` on mixed JS+Python | Each file uses its own profile's resolver |
| `extractExportsOnly()` on Python file | Returns def/class lines (not __all__ yet) |
| `populateFindingMetadata()` extracts `.py` paths | Python file refs populated in affectedFiles |

---

## 5. Rollback Strategy

All changes are **backward compatible** with specific preservation guarantees:

- **`code-analysis.mjs` functions accept an optional `profile` parameter.** When omitted, the function calls `getProfileForFile(filePath)` internally and dispatches to that profile's methods. For existing callers passing `.js`/`.mjs`/`.ts` files, this produces **identical behavior** to the pre-change code because the JS/TS profiles contain equivalent regex patterns. The new code path's "dispatch" is transparent for legacy consumers.
- **`buildDependencyGraph(files, langContext)`** — `langContext` is optional. When omitted, `repoFileSet` is built inline from `files`, and `pythonPackageRoots` defaults to `['.']`. This matches existing behavior EXACTLY for relative JS imports. The only difference: Python absolute imports that previously returned nothing now resolve when files happen to live at repo root.
- **Regression guarantee**: Phase A adds a test case that calls each code-analysis function with NO profile argument on existing JS files and asserts output is identical to the pre-change baseline.
- `UNKNOWN_PROFILE` returns safe defaults (empty arrays, null from resolvers). No crashes on unsupported files.
- The file regex in `ledger.mjs` becomes MORE permissive (adds `.py`, `.pyi`). Findings that matched before still match. This only ADDS matches.

Revert by:
1. Removing import of `language-profiles.mjs` from modified files
2. Restoring inline regex patterns
3. Reverting `populateFindingMetadata()` file regex

---

## 6. Implementation Order

1. **`language-profiles.mjs`** — PROFILES, UNKNOWN_PROFILE, `getAllProfiles()`, `getProfileForFile()`, `getProfile()`, `countFilesByLanguage()`, `detectDominantLanguage()`, `ALL_SUPPORTED_EXTENSIONS`
2. **Resolvers** — `jsResolveImport()`, `pyResolveImport()`, `detectPythonPackageRoots()`, `buildLanguageContext()`
3. **Boundary scanner** — `pythonBoundaryScanner()` exported separately
4. **Unit tests for profiles** — all dispatch, regex, resolver tests
5. **`code-analysis.mjs`** — modify `splitAtFunctionBoundaries`, `extractImportBlock`, `chunkLargeFile`, `extractExportsOnly`, `buildDependencyGraph` to accept profile
6. **`ledger.mjs`** — fix `populateFindingMetadata()` file regex
7. **`file-io.mjs`** — fix `fnRegex`
8. **Integration tests** — Python chunking, mixed-language graph
9. **`shared.mjs`** — barrel re-exports for new symbols
10. Run full `npm test` — verify no regressions against current baseline (157 tests as of 2026-04-04)

---

## 7. Out of Scope (v2+)

- **tsconfig paths/baseUrl** — TS path alias resolution
- **Python namespace packages** (PEP 420) — directories without `__init__.py`
- **Framework detection** (Django/Flask/FastAPI) — Phase B
- **Go, Java, Rust profiles** — future languages
- **Parser-based (AST) analysis** — regex-based is sufficient for Phase A
