# Plan: Multi-Language Audit Support + Linter Pre-Pass + SonarQube Taxonomy

- **Date**: 2026-04-04
- **Status**: In Progress (revised after Round 3 audit — converging)
- **Author**: Claude + Louis
- **Scope**: First-class Python/JS/TS parity, linter integration as mechanical pre-pass, SonarQube-style finding classification. Extensible to Go/Java/Rust later.

---

## 1. Context Summary

### What Exists Today

The audit loop has a 5-pass parallel architecture (structure, wiring, backend, frontend, sustainability) that works well for JavaScript/TypeScript codebases. Code analysis is handled by focused modules:

- **`lib/code-analysis.mjs`** — File chunking at function boundaries, dependency graph building, audit unit construction. All regex patterns are JS/TS-only.
- **`lib/file-io.mjs`** — Path extraction from plans, file classification (backend/frontend/shared). Extensions include `.py` in discovery lists, but classification patterns are JS-centric.
- **`lib/context.mjs`** — Repo profiling and stack detection. Reads `package.json` only. No Python project file parsing.
- **`lib/ledger.mjs`** — Finding metadata enrichment. File extraction regex omits `.py` — breaks R2+ suppression for Python findings.
- **`lib/prompt-seeds.mjs`** — Audit rubrics. Reference JS idioms (`async/await`, `catch + ignore`, `console.log`, `apiFetch`). No Python or TypeScript-specific checks.

### Existing Patterns We Can Reuse

| Pattern | Location | How to extend |
|---|---|---|
| `normalizeLanguage()` | `lib/config.mjs:123` | Already maps `python→py`, `typescript→ts`. 7 canonical languages defined. |
| `PASS_PROMPTS` registry | `lib/prompt-seeds.mjs:67` | Map of pass→prompt. Can be extended to `pass:language→prompt`. |
| `classifyFiles()` | `lib/file-io.mjs:395` | Pattern-based dispatch. Can add Python patterns. |
| `generateRepoProfile()` | `lib/context.mjs:256` | Returns `stack` object. Can add Python stack detection. |
| Prompt bandit per pass | `bandit.mjs` | Already supports `contextBucket` for language. |

### What's Broken for Python (from prior investigation)

| Component | Issue | Impact |
|---|---|---|
| `splitAtFunctionBoundaries()` | Regex: `function\|class\|export const` only | Python files fall to naive line-count splitting |
| `buildDependencyGraph()` | Regex: `from 'module'` (quoted) only | Python `import module` / `from module import x` invisible |
| `extractExportsOnly()` | Looks for `export` keyword | Python uses `__all__` or implicit exports |
| `extractImportBlock()` | Stops at `function\|class\|export` | Misses Python header (imports end at first `def`/`class`) |
| `generateRepoProfile()` | Only reads `package.json` | No `requirements.txt`, `pyproject.toml`, `setup.py` |
| `classifyFiles()` | No Python dir patterns | Django views, Flask routes, tests all → "backend" |
| `populateFindingMetadata()` | `.py` not in file regex | Python file refs lost → broken R2+ suppression |
| `fnRegex` in `extractPlanPaths()` | Hardcoded to `js\|mjs\|ts\|md` | Python filenames in plan headings ignored |

### What's New (Not Prior Art)

1. **Linter integration** — No external tool execution exists beyond `git`. Need `execSync`/`spawn` infrastructure for `eslint`, `ruff`/`flake8`, `tsc`.
2. **SonarQube taxonomy** — Finding schema has free-text `category`. No structured classification (Bug, Vulnerability, Code Smell, Security Hotspot).
3. **Language-dispatched code analysis** — Currently one set of regexes. Need strategy pattern per language.

---

## 2. Proposed Architecture

### 2.1 Language Profile Registry (Single Source of Truth)

**New file**: `scripts/lib/language-profiles.mjs`

A data-driven registry of language-specific patterns, replacing scattered regex and extension lists across modules. Each profile defines everything the system needs to analyze code in that language.

**Principles**: Single Source of Truth (#10), No Hardcoding (#8), Open/Closed (#3), Strategy Pattern.

```javascript
/**
 * Language profile — everything the audit system needs to analyze code in one language.
 * Add a new language by adding a new profile object. No existing code changes required.
 */
const PROFILES = {
  js: {
    id: 'js',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    // Function/class boundary regex — used by chunkLargeFile()
    boundaryRegex: /^(?:export\s+)?(?:async\s+)?(?:function|class)\s|^export\s+(?:const|let|var)\s+\w+\s*=/,
    // Import/require regex — used by buildDependencyGraph()
    // Covers all standard ESM forms: default, named, namespace, side-effect, re-export, dynamic, CommonJS
    // - import x from 'y' | import {x} from 'y' | import * as x from 'y'
    // - import 'y' (side-effect)
    // - export {x} from 'y' | export * from 'y'
    // - import('y') (dynamic)
    // - require('y') (CommonJS)
    importRegex: /(?:^|\s)(?:import|export)[^'"]*['"]([^'"]+)['"]|(?:^|\s)import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\W)require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
    importExtractor: (match) => match[1] || match[2] || match[3],
    // How to resolve relative imports
    resolveExtensions: ['.js', '.mjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts'],
    // Export detection — used by extractExportsOnly()
    exportRegex: /^export\s/,
    // Import block terminator — everything before first boundary is "imports"
    importBlockTerminator: /^(?:export\s+)?(?:async\s+)?(?:function|class)\s|^export\s+(?:const|let|var)\s+\w+\s*=/,
    // Stack detection: project files and dependency mapping
    projectFiles: ['package.json'],
    stackDetectors: {
      backend: { express: 'express', fastify: 'fastify', koa: 'koa', hono: 'hono', 'nest': 'nestjs' },
      db: { pg: 'postgresql', '@supabase/supabase-js': 'postgresql', mysql2: 'mysql', mongoose: 'mongodb', 'better-sqlite3': 'sqlite' },
      frontend: { react: 'react', 'react-dom': 'react', vue: 'vue', svelte: 'svelte', '@angular/core': 'angular' },
      testing: { vitest: 'vitest', jest: 'jest', mocha: 'mocha' }
    },
    // Async for consistency with Python profile (even though JS parsing is sync)
    parseDeps: async (content) => {
      const pkg = JSON.parse(content);
      return { ...pkg.dependencies, ...pkg.devDependencies };
    },
    // File classification overrides
    frontendPatterns: [/^public\//, /\/css\//, /\/html\//, /\.css$/, /\.html$/, /\/components\//],
    testPatterns: [/\.test\.|\.spec\.|__tests__|__mocks__/],
    // Static analysis tools (multiple per language, each with structured config)
    // NOTE: Each tool has a stable `id` used for RULE_METADATA lookup + sourceName.
    // The `command` may be `npx` or `node_modules/.bin/eslint` — `id` is the canonical identity.
    tools: [
      {
        id: 'eslint',
        kind: 'linter',
        command: 'npx',
        args: ['eslint', '--format', 'json', '--no-error-on-unmatched-pattern'],
        scope: 'project',  // 'file' | 'project' | 'workspace'
        outputFormat: 'json',
        configFiles: ['.eslintrc.js', '.eslintrc.json', 'eslint.config.js', 'eslint.config.mjs'],
        availabilityProbe: ['npx', ['eslint', '--version']],
        parser: 'parseEslintOutput',
      }
    ],
    // SonarQube-style category hints for prompts
    sonarHints: {
      bugs: 'async/await without error handling, null dereference, type coercion traps, unclosed resources',
      vulnerabilities: 'eval(), innerHTML, SQL injection via string concat, prototype pollution, XSS',
      codeSmells: 'callback hell, any type, console.log in production, catch + ignore, magic numbers',
      securityHotspots: 'JWT without expiry, CORS *, hardcoded credentials, crypto usage'
    }
  },

  ts: {
    id: 'ts',
    extensions: ['.ts', '.tsx'],
    // Inherits most JS patterns
    boundaryRegex: /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s|^export\s+(?:const|let|var)\s+\w+\s*[=:]/,
    importRegex: /(?:import|from)\s+['"]([^'"]+)['"]/g,
    importExtractor: (match) => match[1],
    resolveExtensions: ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'],
    exportRegex: /^export\s/,
    importBlockTerminator: /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s|^export\s+(?:const|let|var)\s+\w+\s*[=:]/,
    projectFiles: ['package.json', 'tsconfig.json'],
    stackDetectors: null, // Inherits from 'js'
    parseDeps: null, // Inherits from 'js'
    frontendPatterns: [/^src\/components\//, /^src\/pages\//, /\.css$/, /\.html$/, /\/components\//],
    testPatterns: [/\.test\.|\.spec\.|__tests__/],
    tools: [
      {
        id: 'eslint',
        kind: 'linter',
        command: 'npx',
        args: ['eslint', '--format', 'json'],
        scope: 'project',
        outputFormat: 'json',
        configFiles: ['.eslintrc.js', 'eslint.config.js', 'eslint.config.mjs'],
        availabilityProbe: ['npx', ['eslint', '--version']],
        parser: 'parseEslintOutput',
      },
      {
        id: 'tsc',
        kind: 'typeChecker',
        command: 'npx',
        args: ['tsc', '--noEmit', '--pretty', 'false'],
        scope: 'project',  // tsc runs against tsconfig, not individual files
        outputFormat: 'text',
        configFiles: ['tsconfig.json'],
        availabilityProbe: ['npx', ['tsc', '--version']],
        parser: 'parseTscOutput',
      }
    ],
    sonarHints: {
      bugs: 'as any casting, non-null assertion (!), unchecked index access, promise without await',
      vulnerabilities: 'type assertion bypassing validation, any in security-critical paths',
      codeSmells: 'excessive type widening, unused type parameters, barrel file bloat, complex union types',
      securityHotspots: 'JSON.parse without validation, user input to type assertion'
    }
  },

  py: {
    id: 'py',
    extensions: ['.py', '.pyi'],
    // Python function/class boundaries — decorator-aware
    // A boundary is the START of a decorator block or a bare def/class at column 0.
    // Scanner groups contiguous @decorator lines with the following def/class.
    boundaryRegex: /^(?:@\w|(?:async\s+)?(?:def|class)\s+\w+)/,
    // Custom boundary scanner for Python (overrides regex-only splitting)
    boundaryScanner: (lines) => {
      // Walk lines: when we see @decorator or def/class at col 0, start a new boundary.
      // Group consecutive @decorators with the following def/class.
      const boundaries = [];
      let inDecoratorBlock = false;
      let blockStart = -1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^@\w/.test(line)) {
          if (!inDecoratorBlock) { blockStart = i; inDecoratorBlock = true; }
        } else if (/^(?:async\s+)?(?:def|class)\s+\w+/.test(line)) {
          if (inDecoratorBlock) {
            boundaries.push(blockStart); // decorator block start
            inDecoratorBlock = false;
          } else {
            boundaries.push(i); // bare def/class
          }
        } else {
          inDecoratorBlock = false; // non-decorator, non-def line breaks decorator block
        }
      }
      return boundaries;
    },
    // Python import syntax
    importRegex: /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm,
    importExtractor: (match) => match[1] || match[2],
    resolveExtensions: ['.py', '/__init__.py'],
    // Python export detection
    exportRegex: /^(?:__all__\s*=|(?:def|class|async\s+def)\s+(?!_)\w+)/,
    // Import block: everything before first def/class at column 0
    importBlockTerminator: /^(?:async\s+)?(?:def|class)\s+\w+/,
    projectFiles: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
    stackDetectors: {
      backend: { django: 'django', flask: 'flask', fastapi: 'fastapi', starlette: 'starlette', pyramid: 'pyramid', tornado: 'tornado', aiohttp: 'aiohttp' },
      db: { sqlalchemy: 'sqlalchemy', django: 'django-orm', psycopg2: 'postgresql', 'psycopg2-binary': 'postgresql', pymongo: 'mongodb', redis: 'redis', 'databases': 'async-db' },
      frontend: {}, // Python rarely has frontend
      testing: { pytest: 'pytest', unittest: 'unittest', nose2: 'nose2', tox: 'tox' }
    },
    // Dependency detection precedence: pyproject.toml > setup.cfg > requirements.txt > setup.py (best-effort)
    // NOTE: async because pyproject.toml parsing uses dynamic import of smol-toml
    parseDeps: async (content, filename) => {
      const deps = {};
      if (filename === 'requirements.txt' || filename.startsWith('requirements')) {
        for (const line of content.split('\n')) {
          const match = line.match(/^([a-zA-Z0-9_-]+)/);
          if (match && !line.startsWith('#') && !line.startsWith('-')) deps[match[1].toLowerCase()] = true;
        }
      } else if (filename === 'pyproject.toml') {
        // Use smol-toml (lightweight TOML parser) for correct parsing
        // Falls back to regex if parser unavailable
        try {
          const toml = await import('smol-toml');
          const parsed = toml.parse(content);
          // PEP 621 dependencies
          for (const dep of (parsed.project?.dependencies || [])) {
            const name = dep.match(/^([a-zA-Z0-9_-]+)/)?.[1];
            if (name) deps[name.toLowerCase()] = true;
          }
          // Optional dependencies (dev, test groups)
          for (const group of Object.values(parsed.project?.['optional-dependencies'] || {})) {
            for (const dep of group) {
              const name = dep.match(/^([a-zA-Z0-9_-]+)/)?.[1];
              if (name) deps[name.toLowerCase()] = true;
            }
          }
        } catch {
          // Fallback: regex extraction from dependency arrays (covers most common cases)
          const depRegex = /"([a-zA-Z0-9_-]+)(?:[>=<~!].*)?"/g;
          let m;
          while ((m = depRegex.exec(content)) !== null) deps[m[1].toLowerCase()] = true;
        }
      } else if (filename === 'setup.py') {
        // Best-effort only — setup.py is executable Python, not a data format
        const installRegex = /['"]([a-zA-Z0-9_-]+)(?:[>=<~!].*)?['"]/g;
        let m;
        while ((m = installRegex.exec(content)) !== null) deps[m[1].toLowerCase()] = true;
      }
      return deps;
    },
    frontendPatterns: [/\/templates\//, /\/static\//, /\.html$/, /\.css$/],
    testPatterns: [/test_\w+\.py$/, /\w+_test\.py$/, /\/tests\//, /\/test\//],
    tools: [
      {
        id: 'ruff',
        kind: 'linter',
        command: 'ruff',
        args: ['check', '--output-format', 'json'],
        scope: 'project',
        outputFormat: 'json',
        configFiles: ['pyproject.toml', 'ruff.toml', '.ruff.toml'],
        availabilityProbe: ['ruff', ['--version']],
        parser: 'parseRuffOutput',
        fallback: {
          id: 'flake8',
          command: 'flake8',
          args: ['--format', 'pylint'],  // flake8 JSON requires plugin; pylint format is built-in
          outputFormat: 'text',
          availabilityProbe: ['flake8', ['--version']],
          parser: 'parseFlake8TextOutput',
        }
      }
    ],
    sonarHints: {
      bugs: 'bare except, mutable default arguments, f-string without f prefix, __eq__ without __hash__, async without await',
      vulnerabilities: 'pickle.loads on user input, os.system/subprocess.call with shell=True, eval(), SQL string formatting, yaml.load without Loader',
      codeSmells: 'print() in production, bare except + pass, star imports, global state, missing type hints on public API, god class',
      securityHotspots: 'hardcoded secrets, JWT without expiry, CORS *, DEBUG=True in production, weak hashing (md5/sha1)'
    }
  }
};

// Unknown/unsupported file profile — explicit, not hidden behind JS default
const UNKNOWN_PROFILE = Object.freeze({
  id: 'unknown',
  extensions: [],
  boundaryRegex: null,
  importRegex: null,
  resolveExtensions: [],
  exportRegex: null,
  tools: [],
  sonarHints: {}
});

// Exports
export function getProfile(langId) { return PROFILES[langId] || UNKNOWN_PROFILE; }
export function getProfileForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  for (const profile of Object.values(PROFILES)) {
    if (profile.extensions.includes(ext)) return profile;
  }
  return UNKNOWN_PROFILE; // Explicit — callers must handle null boundaries/tools
}
export function getAllProfiles() { return PROFILES; }
export function detectDominantLanguage(files) { /* count extensions, return most common profile id */ }
```

### 2.2 Language-Aware Code Analysis

**Modified file**: `scripts/lib/code-analysis.mjs`

Replace hardcoded regex with profile-dispatched calls. **Principles**: DRY (#1), Open/Closed (#3), Dependency Inversion (#6).

#### `splitAtFunctionBoundaries(source, profile)`

Currently uses one regex. Change to accept a language profile:

```javascript
export function splitAtFunctionBoundaries(source, profile = null) {
  const boundaryRegex = profile?.boundaryRegex ?? DEFAULT_BOUNDARY_REGEX;
  // ... rest unchanged
}
```

Same for `extractImportBlock(source, profile)`, `chunkLargeFile(source, filePath, maxChunkTokens, profile)`.

#### Import Resolution — Per-Language Resolver Interface

Replace the single "starts with `.`" check with a language-dispatched resolver. Each profile provides a `resolveImport(specifier, fromFile, repoFiles)` function.

```javascript
// In language-profiles.mjs, each profile adds:
resolveImport(specifier, fromFile, repoFileSet) {
  // JS/TS: relative imports start with '.' — existing behavior
  // Python: both relative (from .module) AND absolute (from app.module) need resolution
}
```

**Key design**: Profiles are **immutable registry data**. Repo-specific dynamic state (tsconfig paths, Python package roots) lives in a separate `LanguageContext` object, built once per audit run:

```javascript
/**
 * Per-repo language context — mutable, built at audit start from repo scan.
 * Separates repo-specific state from immutable profile definitions.
 */
export async function buildLanguageContext(files) {
  return {
    tsconfigPaths: await loadTsconfigPaths(),     // Parsed from tsconfig.json baseUrl + paths
    pythonPackageRoots: detectPythonPackageRoots(files), // Dirs with __init__.py at top-level
    repoFileSet: new Set(files.map(normalizePath))
  };
}

// Resolvers receive langContext as explicit parameter — no mutable profile state
profile.resolveImport(specifier, fromFile, repoFileSet, langContext)
```

**Python resolver** (handles the critical case GPT flagged):

```javascript
// Python profile resolver
resolveImport(specifier, fromFile, repoFileSet) {
  // Relative imports: from .module → sibling, from ..module → parent
  if (specifier.startsWith('.')) {
    const dots = specifier.match(/^\.+/)[0].length;
    const parts = specifier.slice(dots).split('.');
    const fromDir = path.dirname(fromFile);
    const base = dots === 1 ? fromDir : path.join(fromDir, ...Array(dots - 1).fill('..'));
    const candidates = [
      path.join(base, ...parts) + '.py',
      path.join(base, ...parts, '__init__.py')
    ];
    return candidates.find(c => repoFileSet.has(normalizePath(c))) || null;
  }

  // Absolute imports: from app.services.user import x
  // Try each discovered package root (handles src/ layouts, nested packages, monorepos)
  const parts = specifier.split('.');
  const roots = langContext?.pythonPackageRoots || ['.']; // fallback to repo root

  for (const root of roots) {
    for (let i = parts.length; i >= 1; i--) {
      const candidates = [
        path.join(root, ...parts.slice(0, i)) + '.py',
        path.join(root, ...parts.slice(0, i), '__init__.py')
      ];
      const match = candidates.find(c => repoFileSet.has(normalizePath(c)));
      if (match) return match;
    }
  }
  return null; // External package
}
```

**Package root detection** (in `buildLanguageContext()`):

```javascript
function detectPythonPackageRoots(files) {
  // Common Python layouts: repo/, src/, pkg/, app/
  // A "package root" is a directory containing __init__.py where its PARENT is NOT a package
  const initFiles = files.filter(f => f.endsWith('/__init__.py'));
  const packageDirs = initFiles.map(f => path.dirname(f));

  // Find roots: directories whose parent is NOT itself a package
  const roots = new Set();
  for (const pkgDir of packageDirs) {
    const parent = path.dirname(pkgDir);
    const parentIsPackage = packageDirs.includes(parent);
    if (!parentIsPackage) {
      // The root is one level ABOVE the package itself (so `from pkg.module import x` works)
      roots.add(parent === '.' ? '.' : parent);
    }
  }

  // Always include repo root + common src/ layout
  roots.add('.');
  if (files.some(f => f.startsWith('src/'))) roots.add('src');
  return [...roots];
}
```

**TS/JS resolver** (adds tsconfig path alias support):

```javascript
// TS profile resolver — stateless, uses langContext for tsconfig paths
resolveImport(specifier, fromFile, repoFileSet, langContext) {
  // Relative imports
  if (specifier.startsWith('.')) {
    return jsResolveRelative(specifier, fromFile, repoFileSet, this.resolveExtensions);
  }
  // tsconfig paths: try to resolve @/foo → src/foo, etc.
  const tsconfigPaths = langContext?.tsconfigPaths;
  if (tsconfigPaths) {
    for (const [alias, targets] of Object.entries(tsconfigPaths)) {
      const prefix = alias.replace('/*', '');
      if (specifier.startsWith(prefix)) {
        const rest = specifier.slice(prefix.length);
        for (const target of targets) {
          const base = target.replace('/*', '');
          const resolved = normalizePath(path.join(base, rest));
          for (const ext of this.resolveExtensions) {
            if (repoFileSet.has(resolved + ext)) return resolved + ext;
          }
        }
      }
    }
  }
  return null; // External package
}
```

#### `buildDependencyGraph(files, profiles)`

Replace single import regex with profile-dispatched parsing:

```javascript
export function buildDependencyGraph(files, langContext) {
  const graph = new Map();
  const repoFileSet = new Set(files.map(normalizePath));

  for (const file of files) {
    const normFile = normalizePath(file);
    graph.set(normFile, new Set());
    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath, 'utf-8');

    const profile = getProfileForFile(file);
    if (!profile.importRegex || !profile.resolveImport) continue; // unknown profile skips

    const regex = new RegExp(profile.importRegex.source, profile.importRegex.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const specifier = profile.importExtractor(match);
      if (!specifier) continue;
      // Delegate to profile's resolver — handles relative, absolute, path aliases
      const resolved = profile.resolveImport(specifier, file, repoFileSet, langContext);
      if (resolved) graph.get(normFile).add(normalizePath(resolved));
    }
  }
  return graph;
}
```

#### `extractExportsOnly(filePath)`

Dispatch on profile:

```javascript
export function extractExportsOnly(filePath) {
  const profile = getProfileForFile(filePath);
  const lines = source.split('\n');
  const exports = lines.filter(l => profile.exportRegex.test(l));
  return `// ${filePath} — exports only\n${exports.join('\n')}`;
}
```

### 2.3 Multi-Language Stack Detection

**Modified file**: `scripts/lib/context.mjs` — `generateRepoProfile()`

Currently only reads `package.json`. Extend to iterate over all detected language profiles' `projectFiles` and `stackDetectors`.

```javascript
// 3. Stack detection — iterate all language profiles
const stack = { backend: {}, frontend: {}, testing: {}, languages: [] };

for (const profile of Object.values(getAllProfiles())) {
  for (const projectFile of profile.projectFiles) {
    const pf = path.resolve(projectFile);
    if (!fs.existsSync(pf)) continue;
    const content = fs.readFileSync(pf, 'utf-8');
    const deps = await profile.parseDeps(content, projectFile);
    if (!deps || Object.keys(deps).length === 0) continue;

    stack.languages.push(profile.id);

    // Match dependencies against stack detectors
    if (profile.stackDetectors) {
      for (const [category, mapping] of Object.entries(profile.stackDetectors)) {
        for (const [dep, name] of Object.entries(mapping)) {
          if (deps[dep]) stack[category] = stack[category] || {};
          if (deps[dep]) stack[category].framework = stack[category].framework || name;
          // For db, always check (multiple DBs possible)
          if (category === 'db' && deps[dep]) stack.backend.db = stack.backend.db || name;
        }
      }
    }
  }
}

// Dominant language detection from file inventory
const langCounts = {};
for (const f of allFiles) {
  const profile = getProfileForFile(f);
  langCounts[profile.id] = (langCounts[profile.id] || 0) + 1;
}
stack.dominantLanguage = Object.entries(langCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'js';
```

### 2.4 Fix Finding Metadata (`.py` in file regex)

**Modified file**: `scripts/lib/ledger.mjs` — `populateFindingMetadata()` line 170

Build the file extension list from the language registry instead of hardcoding:

```javascript
import { getAllProfiles } from './language-profiles.mjs';

// Build once at module load
const ALL_EXTENSIONS = [...new Set(
  Object.values(getAllProfiles()).flatMap(p => p.extensions.map(e => e.slice(1))) // strip leading dot
)].join('|');

export function populateFindingMetadata(finding, passName) {
  const section = finding.section || '';
  const fileRegex = new RegExp(
    `(?:^|[\\s\`(])([a-zA-Z][\\w./\\\\-]*\\.(?:${ALL_EXTENSIONS}|json|css|html|md|sql))`, 'g'
  );
  // ... rest unchanged
}
```

Also fix `fnRegex` in `file-io.mjs:244` to use the same extension set.

### 2.5 Linter Pre-Pass Integration

**New file**: `scripts/lib/linter.mjs`

Runs language-appropriate linters before the GPT audit, producing mechanical findings that GPT can skip. This frees GPT's reasoning budget for architectural and design issues.

**Principles**: SRP (#2), Modularity (#7), Composable Pipeline, Graceful Degradation (#16).

```javascript
/**
 * @fileoverview Linter pre-pass — runs language-appropriate static analysis tools.
 * Findings are mechanical and deterministic. Injected into GPT context as "already detected"
 * so GPT focuses on higher-order issues.
 *
 * Design:
 * - Graceful: linter not installed → skip with warning (never blocks audit)
 * - Parallel: runs all applicable linters concurrently
 * - Cached: same files + same config = same results (content-hash based)
 * - Normalized: all linter outputs → unified LintFinding format
 */

import { execFileSync } from 'child_process';
import path from 'path';
import { getProfileForFile, getAllProfiles } from './language-profiles.mjs';

/**
 * Normalized lint finding — same shape regardless of source tool.
 */
const LintFinding = {
  file: '',           // Relative file path
  line: 0,            // Line number
  column: 0,          // Column number
  rule: '',           // Rule ID (e.g. 'no-unused-vars', 'F401', 'TS2304')
  message: '',        // Human-readable message
  severity: 'LOW',    // Mapped to audit severity
  sonarCategory: '',  // Bug | Vulnerability | CodeSmell | SecurityHotspot
  source: '',         // 'eslint' | 'ruff' | 'tsc' | etc.
  fixable: false      // Whether the tool can auto-fix this
};

/**
 * Check if a linter command is available on the system.
 */
/**
 * Check if a tool is available. Uses argv array, not shell string.
 * @param {string[]} probe - [command, args] e.g. ['npx', ['eslint', '--version']]
 */
function isToolAvailable([command, args = []]) {
  try {
    execFileSync(command, args, { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch { return false; }
}

/**
 * Run linter for a set of files, return normalized findings.
 * Graceful: returns empty array if linter not available.
 */
/**
 * ToolRunResult — contract for all tool executions.
 * Distinguishes 'no findings' from 'tool failed' from 'tool unavailable'.
 */
const ToolRunResult = {
  status: 'ok',        // 'ok' | 'no_tool' | 'failed' | 'timeout'
  findings: [],        // Normalized LintFinding[]
  usage: { files: 0 }, // How many files the tool analyzed
  latencyMs: 0,
  stderr: '',          // Captured stderr for debugging
  toolId: '',          // Stable identity: 'ruff' | 'eslint' | 'tsc' | 'flake8'
  toolKind: '',        // 'linter' | 'typeChecker'
};

/**
 * Run a single analysis tool. Uses execFileSync with argv arrays (no shell).
 * Runs at project scope (cwd) — tools like tsc and ruff operate on config, not file lists.
 * File-scoped tools get files appended to args.
 * Post-filters results to the audited file set (prevents unbounded pre-pass).
 * @returns {ToolRunResult}
 */
export function runTool(toolConfig, files, profileId) {
  const fileSet = new Set(files.map(f => normalizePath(f)));
  const startMs = Date.now();
  // Check availability
  if (!isToolAvailable(toolConfig.availabilityProbe)) {
    if (toolConfig.fallback) {
      return runTool(toolConfig.fallback, files, profileId);
    }
    process.stderr.write(`  [tool] ${profileId}/${toolConfig.kind}: ${toolConfig.command} not found\n`);
    return { status: 'no_tool', findings: [], usage: { files: 0 }, latencyMs: 0, stderr: '',
      toolId: toolConfig.id, toolKind: toolConfig.kind };
  }

  // Build argv — file-scoped tools get file list, project-scoped rely on config
  const argv = [...toolConfig.args];
  if (toolConfig.scope === 'file') argv.push(...files);

  try {
    const stdout = execFileSync(toolConfig.command, argv, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024
    });
    const rawFindings = parseToolOutput(stdout, toolConfig, profileId);
    // Post-filter to audited file set (bounds project-scoped tools)
    const findings = rawFindings.filter(f => fileSet.has(normalizePath(f.file)));
    process.stderr.write(`  [tool] ${profileId}/${toolConfig.kind}: ${findings.length} findings (${rawFindings.length - findings.length} filtered out-of-scope) in ${((Date.now() - startMs) / 1000).toFixed(1)}s\n`);
    return { status: 'ok', findings, usage: { files: files.length }, latencyMs: Date.now() - startMs,
      stderr: '', toolId: toolConfig.id, toolKind: toolConfig.kind };
  } catch (err) {
    // Non-zero exit often means findings exist — parse stdout if available
    if (err.stdout) {
      const rawFindings = parseToolOutput(err.stdout, toolConfig, profileId);
      const findings = rawFindings.filter(f => fileSet.has(normalizePath(f.file)));
      return { status: 'ok', findings, usage: { files: files.length }, latencyMs: Date.now() - startMs,
        stderr: err.stderr?.toString() || '', toolId: toolConfig.id, toolKind: toolConfig.kind };
    }
    const isTimeout = err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT';
    process.stderr.write(`  [tool] ${profileId}/${toolConfig.kind}: ${isTimeout ? 'timeout' : 'failed'}: ${err.message?.slice(0, 100)}\n`);
    return { status: isTimeout ? 'timeout' : 'failed', findings: [], usage: { files: 0 },
      latencyMs: Date.now() - startMs, stderr: err.message, toolId: toolConfig.id, toolKind: toolConfig.kind };
  }
}

/**
 * Run all applicable tools for a file set. Groups by language, runs each tool.
 * @returns {ToolRunResult[]} — one per (tool × language bucket). Findings inside each.
 */
export function executeTools(files) {
  const byLang = bucketFilesByLanguage(files);
  const results = [];
  for (const [langId, { profile, files: langFiles }] of byLang) {
    if (langId === 'unknown') continue;
    for (const toolConfig of (profile.tools || [])) {
      results.push(runTool(toolConfig, langFiles, langId));
    }
  }
  return results;
}

/**
 * Normalize all tool results into canonical FindingSchema objects.
 * @param {ToolRunResult[]} results
 * @param {object} ruleMetadata - Rule metadata registry (RULE_METADATA)
 * @returns {object[]} Array of FindingSchema-shaped findings
 */
export function normalizeToolResults(results, ruleMetadata) {
  const findings = [];
  let idx = 0;
  for (const result of results) {
    if (result.status !== 'ok') continue;
    const toolRegistry = ruleMetadata[result.toolId] || ruleMetadata._default;
    for (const raw of result.findings) {
      findings.push(normalizeExternalFinding(
        { ...raw, _autoIndex: ++idx, sourceKind: result.toolKind === 'typeChecker' ? 'TYPE_CHECKER' : 'LINTER', sourceName: result.toolId },
        toolRegistry
      ));
    }
  }
  return findings;
}

/**
 * Run all applicable linters for a file set. Groups files by language, runs in parallel.
 */
export async function runAllLinters(files) {
  // Group files by language profile
  const byLang = new Map();
  for (const f of files) {
    const profile = getProfileForFile(f);
    if (!byLang.has(profile.id)) byLang.set(profile.id, { profile, files: [] });
    byLang.get(profile.id).files.push(f);
  }

  const allFindings = [];
  for (const [langId, { profile, files: langFiles }] of byLang) {
    const findings = runLinter(langFiles, profile);
    allFindings.push(...findings);
  }

  return allFindings;
}

/**
 * Parse linter JSON output to normalized LintFinding format.
 * Each linter has its own output shape — normalize here.
 */
function parseLinterOutput(output, command, langId) {
  try {
    const data = JSON.parse(output);
    if (command.includes('eslint')) return parseEslintOutput(data, langId);
    if (command.includes('ruff')) return parseRuffOutput(data, langId);
    if (command.includes('flake8')) return parseFlake8Output(data, langId);
    return []; // Unknown linter
  } catch {
    return []; // Non-JSON output
  }
}

function parseEslintOutput(data, langId) { /* normalize eslint JSON → LintFinding[] */ }
function parseRuffOutput(data, langId) { /* normalize ruff JSON → LintFinding[] */ }
function parseFlake8Output(data, langId) { /* normalize flake8 JSON → LintFinding[] */ }
function parseTscOutput(rawText, langId) { /* normalize tsc --pretty false → LintFinding[] */ }

const LINT_CONTEXT_TOKEN_BUDGET = 2000; // ~8K chars — cap for lint context in GPT prompt

/**
 * Format lint findings as a SUMMARIZED context block for GPT prompt injection.
 * Uses a global token budget — summarizes by rule/severity when findings exceed budget.
 * Full lint results are kept outside the prompt for dedup/reporting.
 */
export function formatLintSummary(lintFindings, tokenBudget = LINT_CONTEXT_TOKEN_BUDGET) {
  if (lintFindings.length === 0) return '';

  const header = '## Pre-detected Lint Issues (mechanical — already flagged)\n' +
    'Static analysis found the issues below. Do NOT re-report these.\n' +
    'Focus on architectural, design, and logic issues that linters cannot detect.\n\n';

  // If few findings, list them directly
  if (lintFindings.length <= 15) {
    const lines = lintFindings.map(f => `- ${f.section}: [${f.principle}] ${f.detail.slice(0, 80)}`);
    const block = header + lines.join('\n');
    if (estimateTokens(block) <= tokenBudget) return block;
  }

  // Budget exceeded — summarize by rule frequency
  const ruleCount = {};
  const sevCount = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of lintFindings) {
    ruleCount[f.principle] = (ruleCount[f.principle] || 0) + 1;
    sevCount[f.severity]++;
  }

  const topRules = Object.entries(ruleCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, count]) => `- ${rule}: ${count} occurrence(s)`)
    .join('\n');

  return header +
    `**Summary**: ${lintFindings.length} findings (H:${sevCount.HIGH} M:${sevCount.MEDIUM} L:${sevCount.LOW})\n` +
    `**Top rules**:\n${topRules}\n\n` +
    `Full lint report available outside prompt for dedup. Do NOT re-raise these patterns.`;
}
```

#### TypeScript Type Checking

TypeScript gets a second linter pass via `tsc --noEmit`:

```javascript
// In language-profiles.mjs, ts profile:
linter: {
  command: 'npx eslint',
  args: ['--format', 'json'],
  // TypeScript also runs tsc for type errors
  typeChecker: {
    command: 'npx tsc',
    args: ['--noEmit', '--pretty', 'false'],
    parseOutput: parseTscOutput
  }
}
```

### 2.6 SonarQube-Style Finding Taxonomy

**Modified file**: `scripts/lib/schemas.mjs` — `FindingSchema`

Add structured classification fields that map to SonarQube's taxonomy. These give findings consistent categorization across all three models (Claude, GPT, Gemini).

**Versioned contract approach**: New fields are in an optional nested `classification` object. Existing producers continue to emit the current shape. New producers/consumers adopt `classification` incrementally. Fields become required only after all producers are migrated.

```javascript
// Optional classification envelope — backward compatible with existing FindingSchema
const ClassificationSchema = z.object({
  sonarType: z.enum(['BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT']).describe(
    'SonarQube classification: BUG=broken behavior, VULNERABILITY=exploitable flaw, ' +
    'CODE_SMELL=maintainability debt, SECURITY_HOTSPOT=needs security review'
  ),
  effort: z.enum(['TRIVIAL', 'EASY', 'MEDIUM', 'MAJOR', 'CRITICAL']).describe(
    'Fix effort: TRIVIAL=<5min, EASY=<30min, MEDIUM=<2h, MAJOR=<1day, CRITICAL=architectural'
  ),
  // Two-dimensional source: stable kind + free-text name for extensibility
  sourceKind: z.enum(['MODEL', 'LINTER', 'TYPE_CHECKER', 'REVIEWER']).describe(
    'Stable source category — adding a new tool does NOT require schema migration'
  ),
  sourceName: z.string().max(32).describe(
    'Specific tool/model: gpt-5.4, eslint, ruff, tsc, gemini-3.1-pro, claude-opus-4.1, etc.'
  ),
  // Structured location (avoids reparsing the human-readable section field)
  location: z.object({
    file: z.string().describe('Normalized file path'),
    line: z.number().int().min(0).describe('1-based line number; 0 = whole file'),
    endLine: z.number().int().min(0).optional(),
    column: z.number().int().min(0).optional(),
  }).optional().describe('Machine-parseable location — preferred over parsing section field'),
}).optional();

export const FindingSchema = z.object({
  id: z.string().max(10),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string().max(80),
  section: z.string().max(120),
  detail: z.string().max(600),
  risk: z.string().max(300),
  recommendation: z.string().max(600),
  is_quick_fix: z.boolean(),
  is_mechanical: z.boolean(),
  principle: z.string().max(80),
  // NEW: optional classification — all fields within are required when present
  classification: ClassificationSchema,
});
```

**Migration path for all consumers**:

| Consumer | Current | Migration |
|---|---|---|
| `openai-audit.mjs` (GPT) | Emits findings via `zodTextFormat(FindingSchema)` | Add `classification` to prompt + schema. GPT fills it when instructed. |
| `gemini-review.mjs` | Receives findings in transcript, emits own | Update Gemini schema via `zodToGeminiSchema()`. ClassificationSchema auto-derived. |
| `learning-store.mjs` | `recordFindings()` reads `f.severity`, `f._hash` | Add `f.classification?.sonarType` to cloud row (nullable column). |
| `lib/ledger.mjs` | `writeLedgerEntry()` / `batchWriteLedger()` | Passthrough — ledger stores raw finding snapshot, no schema enforcement on classification. |
| `lib/findings.mjs` | `appendOutcome()` logs to JSONL | Add `classification` to outcome record (optional field). |
| Existing persisted data | No `classification` field | Read-boundary defaulting: `f.classification ?? null`. No backfill needed. |

### 2.7 Language-Aware Prompt Generation

**Modified file**: `scripts/lib/prompt-seeds.mjs`

Instead of one prompt per pass, generate prompts with language-aware rubric sections injected from the profile's `sonarHints`.

```javascript
/**
 * Build a pass prompt with language-specific rubric injections.
 * @param {string} passName - structure | wiring | backend | frontend | sustainability
 * @param {object} profile - Language profile from language-profiles.mjs
 * @param {string} [lintContext] - Pre-detected lint findings block
 * @returns {string} Full system prompt
 */
export function buildPassPrompt(passName, profile, lintContext = '') {
  const base = PASS_PROMPTS[passName];
  const hints = profile.sonarHints || {};

  const sonarBlock = `
## SonarQube Classification (REQUIRED for every finding)
Classify each finding as one of:
- **BUG**: Code that is demonstrably broken or will break at runtime
- **VULNERABILITY**: Exploitable security flaw (OWASP Top 10)
- **CODE_SMELL**: Works but makes the code harder to maintain/extend
- **SECURITY_HOTSPOT**: Needs manual security review — not necessarily a flaw

### Language-Specific Patterns to Check (${profile.id.toUpperCase()})
- Bugs: ${hints.bugs || 'standard patterns'}
- Vulnerabilities: ${hints.vulnerabilities || 'OWASP Top 10'}
- Code Smells: ${hints.codeSmells || 'general maintainability'}
- Security Hotspots: ${hints.securityHotspots || 'credential/crypto patterns'}
`;

  const lintBlock = lintContext
    ? `\n${lintContext}\n`
    : '';

  return `${base}\n${sonarBlock}${lintBlock}`;
}
```

### 2.8 Integration in openai-audit.mjs

The audit pipeline gains a "Phase 0" linter pre-pass and language-aware prompt generation:

```javascript
// In runMultiPassCodeAudit():

// Phase 0: Tool pre-pass (mechanical findings from linters + type checkers)
process.stderr.write('\n── Phase 0: Tool Pre-Pass ──\n');
const toolResults = executeTools([...found]);
const normalizedLintFindings = normalizeToolResults(toolResults, RULE_METADATA);
const toolCapability = {
  toolsAvailable: toolResults.filter(r => r.status === 'ok').map(r => r.toolName),
  toolsFailed: toolResults.filter(r => r.status !== 'ok').map(r => ({ name: r.toolName, status: r.status })),
};
if (normalizedLintFindings.length > 0) {
  process.stderr.write(`  [tools] ${normalizedLintFindings.length} mechanical findings from ${toolCapability.toolsAvailable.join(',')}\n`);
}

// Audit topology for mixed-language repos:
//
// REPO-LEVEL passes (cross-language, fed by language-agnostic inventory):
//   - structure: does planned file layout exist? (all languages)
//   - wiring: do frontend API calls match backend routes? (cross-bucket DTO/schema alignment)
//
// BUCKET-LEVEL passes (per-language subanalysis):
//   - backend, frontend, sustainability: run once per language bucket with that language's rubric

// Build language-agnostic inventory for repo-level passes
const repoInventory = buildCrossLanguageInventory(found);
// Inventory shape: {
//   routes: [{method, path, file, lang, handler}],       // HTTP endpoints
//   dtos: [{name, file, lang, fields}],                  // Request/response schemas
//   envVars: [{name, file, lang}],                       // process.env.X / os.environ.get('X')
//   dbTouchpoints: [{file, lang, operation}]             // Query sites
// }
//
// Extractor interface: each language profile exports optional extractors
//   profile.extractors = { routes, dtos, envVars, dbTouchpoints }
// Each extractor: (fileContent, filePath, profile) → InventoryItem[]
//
// V1 supported frameworks (documented explicitly):
//   JS/TS: express (routes), fastify (routes), zod schemas (dtos), process.env (envVars)
//   Python: FastAPI (routes via @app.get/@router.get), Flask (@app.route), Pydantic (dtos), os.environ (envVars)
// Unsupported frameworks: extractors return []. No silent heuristics.

// Language-aware bucket audit
const buckets = bucketFilesByLanguage(found); // Map<profileId, { profile, files }>
const dominantLang = detectDominantLanguage(found);

// Repo-level passes use dominant-language profile + cross-language inventory
const structurePrompt = buildPassPrompt('structure', getProfile(dominantLang), '', { repoInventory });
const wiringPrompt = buildPassPrompt('wiring', getProfile(dominantLang), '', { repoInventory });

// Compute audit budget based on bucket count
// Prevents polyglot repos from running unbounded passes
const budget = computeAuditBudget(buckets, found.length);
// budget shape: { maxBucketPasses, perPassTimeoutMs, perPassMaxTokens, degradeMode }
//
// Rules:
//   - 1 bucket: normal budget (existing behavior)
//   - 2 buckets: same pass limits, runs sequentially
//   - 3+ buckets: MERGE buckets into dominant + 'other' bucket, warn user
//   - Total expected passes > 12: degrade to only run 'backend' + 'sustainability' per bucket

process.stderr.write(`  [budget] ${buckets.size} bucket(s), ${budget.maxBucketPasses} passes, ${(budget.perPassTimeoutMs / 1000)}s timeout/pass\n`);

// Bucket-level passes for each language
for (const [langId, { profile, files: langFiles }] of buckets) {
  if (langId === 'unknown') continue; // Skip unsupported files
  const bucketLintFindings = normalizedLintFindings.filter(f =>
    langFiles.some(lf => f.section.startsWith(lf))
  );
  const lintSummary = formatLintSummary(bucketLintFindings, LINT_CONTEXT_TOKEN_BUDGET);
  const backendPrompt = buildPassPrompt('backend', profile, lintSummary);
  // ... frontend, sustainability per bucket
}
```

**Canonical lifecycle for tool findings**: All linter/tsc findings enter the same pipeline as GPT findings via a normalization stage. They are NOT a parallel finding type.

```javascript
/**
 * Normalize an external tool finding into the canonical FindingSchema shape.
 * Tool findings get semantic IDs, enter the ledger, and participate in dedup/suppression.
 * @param {object} lintFinding - Raw normalized lint finding from parsers
 * @returns {object} FindingSchema-compatible object
 */
function normalizeExternalFinding(lintFinding, ruleMetadata) {
  // ruleMetadata comes from per-tool rule registry (see §2.9)
  const meta = ruleMetadata[lintFinding.rule] || ruleMetadata._default;
  const recommendation = meta.recommendation || `Review and fix rule violation: ${lintFinding.rule}`;
  return {
    id: `T${lintFinding._autoIndex}`,
    severity: meta.severity,
    category: `[${meta.sonarType}] ${lintFinding.rule}`,
    section: `${lintFinding.file}:${lintFinding.line}`,
    detail: lintFinding.message,
    risk: meta.risk || 'Static analysis violation.',
    recommendation,
    // is_quick_fix comes from rule metadata, NOT tool fixability.
    // Auto-fixable ≠ band-aid. A rule like 'no-unused-vars' is fully durable when fixed.
    is_quick_fix: meta.isQuickFix ?? false,
    is_mechanical: true,
    principle: lintFinding.rule,
    classification: {
      sonarType: meta.sonarType,
      effort: meta.effort,
      sourceKind: lintFinding.sourceKind,
      sourceName: lintFinding.sourceName,
      location: {
        file: normalizePath(lintFinding.file),
        line: lintFinding.line,
        endLine: lintFinding.endLine,
        column: lintFinding.column
      }
    }
  };
}
```

**Verdict determinism** (fixes non-reproducibility across machines): Tool findings are **ADVISORY by default** — they do NOT count toward verdict math unless `--strict-lint` CLI flag is passed. This keeps verdict reproducible even when tools are missing on some machines.

| Mode | Tool findings in verdict? | Tool findings in ledger? | Use case |
|---|---|---|---|
| Default | No — advisory only | Yes — tracked for dedup | Local dev, variable tool availability |
| `--strict-lint` | Yes | Yes | CI environments with pinned toolchain |

Capability state is persisted per run:

```javascript
// Persisted with audit result
result._toolCapability = {
  toolsAvailable: ['ruff', 'eslint'],
  toolsFailed: [{ name: 'tsc', status: 'no_tool' }],
  strictLint: false,
  timestamp: Date.now()
};
```

Normalized tool findings:
- Get `semanticId()` hashes for cross-round dedup (using `file:line:rule` as identity inputs — see §2.11)
- Enter the adjudication ledger with `adjudicationOutcome: 'accepted'` (auto-accepted, no deliberation)
- Participate in R2+ suppression (fixed lint issues are suppressed in subsequent rounds)
- Appear in Gemini final review transcript
- `is_mechanical: true` — stability is not reset when new lint findings appear

### 2.9 Rule Metadata Registry (Tool Rule → Severity/Taxonomy Mapping)

**New file**: `scripts/lib/rule-metadata.mjs`

Per-tool registry mapping rule IDs to canonical severity and SonarQube taxonomy. Without this, different linters would classify similar issues differently and corrupt verdict math.

```javascript
/**
 * Rule metadata registry: maps tool rule IDs to canonical audit taxonomy.
 * One registry per tool. Unknown rules fall through to _default.
 */
export const RULE_METADATA = {
  eslint: {
    // Bugs (runtime-breaking)
    'no-undef': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY' },
    'no-unreachable': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY' },
    'no-dupe-keys': { severity: 'HIGH', sonarType: 'BUG', effort: 'TRIVIAL' },
    // Vulnerabilities
    'no-eval': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM' },
    // Code smells
    'no-unused-vars': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL' },
    'no-console': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL' },
    '@typescript-eslint/no-explicit-any': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY' },
    _default: { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'EASY' }
  },
  ruff: {
    // Security (S-prefix rules from bandit integration)
    'S102': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM' }, // exec-builtin
    'S301': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM' }, // pickle
    'S608': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM' }, // sql injection
    // Bugs (F/E prefix = pyflakes/pycodestyle)
    'F401': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL' }, // unused import
    'F821': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY' },          // undefined name
    'F811': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY' },        // redefined
    // Code smells (rest of ruff rules)
    _default: { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'EASY' }
  },
  tsc: {
    'TS2304': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY' },        // Cannot find name
    'TS2322': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY' },        // Type mismatch
    'TS7006': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY' }, // Implicit any
    _default: { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY' }
  }
};
```

**Coverage strategy**: Start with top-20 most common rules per tool. Unknown rules get `_default`. Registry grows from actual audit outcomes — when the team sees a classification feels wrong, they add a specific entry.

### 2.11 Cross-Source Finding Identity

**File**: `scripts/lib/findings.mjs` — extend `semanticId()`

Content-hash alone won't dedup a tool finding (`no-undef at user.js:42`) against a model finding (narrative about undefined reference). Each finding source needs a deterministic identity scheme:

```javascript
/**
 * Compute semantic identity from finding shape.
 * Tool findings: file:line:rule (deterministic, cross-round stable)
 * Model findings: content hash of category + section + normalized detail
 */
export function semanticId(finding) {
  const kind = finding.classification?.sourceKind;

  if (kind === 'LINTER' || kind === 'TYPE_CHECKER') {
    // Tool finding: identity is file + line + rule (from structured location field)
    const loc = finding.classification?.location;
    const file = loc ? normalizePath(loc.file) : 'unknown';
    const line = loc ? loc.line : 0;
    const rule = finding.principle || 'unknown';
    return crypto.createHash('sha256').update(`${file}:${line}:${rule}`).digest('hex').slice(0, 8);
  }

  // Model finding: content hash (existing behavior)
  const content = `${finding.category}|${finding.section}|${finding.detail}`.toLowerCase().trim();
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}
```

**Cross-source equivalence**: A tool finding and a model finding about the same defect will NOT have identical `semanticId` values (different schemes). R2+ suppression still works because:
- Tool findings dedup across rounds (same `file:line:rule` = same ID)
- Model findings dedup across rounds (same content hash = same ID)
- When a fix removes both (common case), both IDs are resolved independently

Full cross-source merging is deferred to a future iteration — tracking two parallel IDs is simpler and semantically honest than forcing false equivalence.

### 2.10 Persistence Migration Spec

**Supabase column addition** (new migration file `supabase/migrations/<ts>_add_classification.sql`):

```sql
-- Nullable columns — backward compatible with existing rows
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS sonar_type TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS effort TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS source_kind TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS source_name TEXT;
-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_audit_findings_sonar_type ON audit_findings(sonar_type) WHERE sonar_type IS NOT NULL;
```

**Write boundaries** (must validate classification schema):

| Boundary | Current | After Migration |
|---|---|---|
| `learning-store.mjs:recordFindings()` | Writes core fields | Add nullable `sonar_type`, `effort`, `source_kind`, `source_name` |
| `lib/ledger.mjs:batchWriteLedger()` | Stores raw snapshot | Validate `classification` sub-schema before write |
| `lib/findings.mjs:appendOutcome()` | JSONL append | Include `classification` if present, no schema enforcement (append-only) |
| `scripts/gemini-review.mjs` output | Uses `FindingSchema` | Gemini auto-fills classification (schema regenerated from Zod) |

**Read-time defaulting**: Old persisted findings without `classification` are read as `classification: null`. Callers must handle null defensively:

```javascript
const sonarType = finding.classification?.sonarType ?? 'UNKNOWN';
```

---

## 3. Sustainability Notes

### Assumptions That Could Change

| Assumption | Mitigation |
|---|---|
| Ruff is the standard Python linter | `fallbackCommand: 'flake8'` + linter detection at runtime |
| ESLint is the standard JS linter | Profile supports any command; swap to Biome/oxlint by changing profile |
| SonarQube categories are sufficient | Free-text `category` field preserved alongside structured `sonarType` |
| 3 languages are enough | Adding Go/Java/Rust = add a profile object, no code changes |

### Extension Points

1. **New language** = new entry in `PROFILES` object. No existing code modified (Open/Closed #3).
2. **New linter** = new `parseXxxOutput()` function + profile entry. No pipeline changes.
3. **New SonarQube category** = add to `sonarType` enum + update prompts. Schema migration needed.
4. **Custom project rubrics** = `sonarHints` in profile can be overridden per-project via CLAUDE.md.

### What Was Deliberately Deferred

- **Full TOML parser** — Simple regex extraction from `pyproject.toml` is sufficient for dependency detection. Full TOML parsing (with sections, nested tables) is overkill until we need to read `[tool.ruff]` config.
- **Python virtual environment activation** — Running `ruff` assumes it's on PATH or in the project. We don't activate venvs.
- **Monorepo language mixing** — Each file gets one profile. A JS+Python monorepo works (files classified independently) but prompt context is per-dominant-language.

---

## 4. Module Contract Table

Single authoritative list of all new/modified exports. Tests, implementation, and file-level plan must align to this.

| Export | Module | Signature | Called by |
|---|---|---|---|
| `getProfile(langId)` | `lib/language-profiles.mjs` | `(string) → Profile` | code-analysis, context, linter |
| `getProfileForFile(filePath)` | `lib/language-profiles.mjs` | `(string) → Profile` | code-analysis, ledger, linter |
| `getAllProfiles()` | `lib/language-profiles.mjs` | `() → Record<string, Profile>` | context (stack detection) |
| `detectDominantLanguage(files)` | `lib/language-profiles.mjs` | `(string[]) → string` | openai-audit |
| `bucketFilesByLanguage(files)` | `lib/language-profiles.mjs` | `(string[]) → Map<string, {profile, files}>` | openai-audit, linter |
| `buildLanguageContext(files)` | `lib/language-profiles.mjs` | `(string[]) → Promise<LanguageContext>` | openai-audit |
| `runTool(config, files, profileId)` | `lib/linter.mjs` | `(ToolConfig, string[], string) → ToolRunResult` | executeTools |
| `executeTools(files)` | `lib/linter.mjs` | `(string[]) → ToolRunResult[]` | openai-audit (Phase 0) |
| `normalizeToolResults(results, meta)` | `lib/linter.mjs` | `(ToolRunResult[], RuleMeta) → Finding[]` | openai-audit (Phase 0) |
| `normalizeExternalFinding(raw, meta)` | `lib/linter.mjs` | `(LintFinding, RuleMeta) → Finding` | normalizeToolResults |
| `formatLintSummary(findings, budget)` | `lib/linter.mjs` | `(Finding[], number) → string` | openai-audit, buildPassPrompt |
| `parseToolOutput(stdout, config, profileId)` | `lib/linter.mjs` | `(string, ToolConfig, string) → LintFinding[]` | runTool |
| `RULE_METADATA` | `lib/rule-metadata.mjs` | `Record<tool, Record<rule, Meta>>` | normalizeExternalFinding |
| `splitAtFunctionBoundaries(src, profile)` | `lib/code-analysis.mjs` | `(string, Profile) → Chunk[]` | chunkLargeFile |
| `buildDependencyGraph(files, langContext)` | `lib/code-analysis.mjs` | `(string[], LanguageContext) → Map` | openai-audit |
| `buildPassPrompt(pass, profile, lintCtx, opts)` | `lib/prompt-seeds.mjs` | `(string, Profile, string, object) → string` | openai-audit |
| `buildCrossLanguageInventory(files)` | `lib/context.mjs` | `(string[]) → Inventory` | openai-audit (structure/wiring) |

## 5. File-Level Plan

### New Files

| File | Purpose | Key Exports | Why |
|---|---|---|---|
| `scripts/lib/language-profiles.mjs` | Language registry — single source of truth for all language-specific patterns | `getProfile()`, `getProfileForFile()`, `getAllProfiles()`, `detectDominantLanguage()` | Single Source of Truth (#10), Open/Closed (#3) |
| `scripts/lib/linter.mjs` | Tool pre-pass orchestration | `runTool()`, `executeTools()`, `normalizeToolResults()`, `formatLintSummary()` | SRP (#2), Modularity (#7) |
| `scripts/lib/rule-metadata.mjs` | Tool rule → severity/taxonomy mapping | `RULE_METADATA` | No Guessing (#12) |

### New dependencies

| Package | Version | Why |
|---|---|---|
| `smol-toml` | `^1.3.0` | Correct TOML parsing for `pyproject.toml`. Adds ~30KB, zero runtime deps. |

### Python project file support matrix (V1)

| File | Parsed | Notes |
|---|---|---|
| `pyproject.toml` | Yes (via smol-toml) | PEP 621 `[project]` deps + optional-dependencies |
| `requirements.txt` / `requirements-*.txt` | Yes (regex) | First token per line |
| `setup.py` | Best-effort (regex) | Executable Python, not a data format |
| `setup.cfg` | Not in V1 | Surface as "unparsed" in repo profile output |
| `Pipfile` | Not in V1 | Surface as "unparsed" in repo profile output |

### Modified Files

| File | Changes | Why |
|---|---|---|
| `scripts/lib/code-analysis.mjs` | `splitAtFunctionBoundaries()`, `extractImportBlock()`, `chunkLargeFile()`, `buildDependencyGraph()`, `extractExportsOnly()` — accept `profile` parameter, use profile regexes | DRY (#1), Dependency Inversion (#6) |
| `scripts/lib/context.mjs` | `generateRepoProfile()` — multi-project-file stack detection | No Hardcoding (#8) |
| `scripts/lib/ledger.mjs` | `populateFindingMetadata()` line 170 — file regex built from profile extensions | Single Source of Truth (#10) |
| `scripts/lib/file-io.mjs` | `fnRegex` line 244 — use shared extension constant; `classifyFiles()` — add Python dir patterns | DRY (#1) |
| `scripts/lib/schemas.mjs` | `FindingSchema` — add `sonarType`, `effort`, `source` fields | Schema Evolution |
| `scripts/lib/prompt-seeds.mjs` | Add `buildPassPrompt(passName, profile, lintContext)` | Open/Closed (#3) |
| `scripts/openai-audit.mjs` | Phase 0 linter pre-pass; language-aware prompt generation; lint findings in output | Composable Pipeline |
| `scripts/shared.mjs` | Re-export new modules | Backward Compatibility (#18) |
| `tests/shared.test.mjs` | Tests for profile dispatch, linter output parsing, schema changes | Testability (#11) |

---

## 5. Risk & Trade-off Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Linter not installed on user's machine | High | Low | Graceful skip + warning; audit proceeds without lint pre-pass |
| Python import regex misses complex cases | Medium | Low | Regex handles `from x import y` and `import x`; edge cases (conditional imports, `__import__`) fall to GPT |
| SonarQube `sonarType` field breaks existing Gemini schema | Medium | Medium | Field is `optional()` — old outputs remain valid; Gemini schema derivation tested |
| Prompt length increase from lint context + sonar hints | Low | Medium | Lint context capped at 10 findings per file; sonar hints are ~100 chars per category |
| `tsc --noEmit` is slow on large TS projects | Medium | Low | Timeout at 60s; skip with warning if too slow |
| `ruff` output format changes between versions | Low | Medium | Version-pin in tests; parser handles missing fields gracefully |

---

## 6. Testing Strategy

### Unit Tests

| Test | What it validates |
|---|---|
| `getProfileForFile('.py')` returns py profile | Profile dispatch by extension |
| `getProfileForFile('.tsx')` returns ts profile | TypeScript extension mapping |
| `getProfileForFile('.unknown')` returns UNKNOWN_PROFILE | Explicit unsupported handling (no silent JS default) |
| Python `boundaryRegex` matches `def`, `class`, `async def` | Boundary detection |
| Python `boundaryRegex` does NOT match indented `def` (nested functions) | Only top-level boundaries |
| Python `importRegex` matches `from module import x` | Import parsing |
| Python `importRegex` matches `import module` | Import parsing |
| Python `importRegex` does NOT match `# import comment` | Comment exclusion |
| `parseDeps('requirements.txt')` extracts package names | Python dep parsing |
| `parseDeps('pyproject.toml')` extracts dependencies | Python dep parsing |
| `parseEslintOutput()` normalizes to LintFinding shape | ESLint adapter |
| `parseRuffOutput()` normalizes to LintFinding shape | Ruff adapter |
| `parseTscOutput()` normalizes to LintFinding shape | TypeScript adapter |
| `buildPassPrompt()` includes sonarHints for language | Prompt generation |
| `buildPassPrompt()` includes lint context when provided | Lint injection |
| `formatLintContextBlock()` caps findings per file | Context budget |
| `isToolAvailable('nonexistent')` returns false | Graceful tool detection |
| `FindingSchema` with `sonarType` validates | Schema backward compat |
| `FindingSchema` without `sonarType` validates (optional) | Schema backward compat |
| `populateFindingMetadata()` extracts `.py` file paths | Fixed regex |

### Integration Tests (Hermetic — no external tool dependencies)

| Test | What it validates |
|---|---|
| Chunk a 1000-line Python file | Splits at `def`/`class` boundaries, not naive line count |
| Build dep graph for Python project | `from .module import x` creates edges |
| Build dep graph with absolute Python imports | `from app.services.user import x` resolves to repo file |
| Build dep graph for mixed JS+Python | Each file uses its own profile's resolver |
| `generateRepoProfile()` on Python-only repo | Detects Django/Flask, no `package.json` crash |
| `parseEslintOutput()` on captured fixture | JSON→LintFinding normalization |
| `parseRuffOutput()` on captured fixture | JSON→LintFinding normalization |
| `parseTscOutput()` on captured text fixture | Text→LintFinding normalization |
| `runTool()` with mocked execFileSync | Status envelope populated correctly |
| `runTool()` post-filters to audited file set | Out-of-scope findings excluded |

### Smoke Tests (Gated behind `AUDIT_LOOP_SMOKE=1` env flag — optional)

| Test | What it validates |
|---|---|
| Run real `ruff` on Python fixture | End-to-end execution (requires ruff installed) |
| Run real `eslint` on JS fixture | End-to-end execution (requires eslint installed) |
| Full audit with lint pre-pass | Lint findings appear in output with `sourceKind: 'LINTER'` |

**Default `npm test` stays hermetic** — no network, no external binaries, reproducible in CI.

---

## 7. Implementation Order

1. **`language-profiles.mjs`** — Foundation. All other changes depend on this.
2. **`code-analysis.mjs`** — Profile-dispatched chunking and imports. Highest impact.
3. **`ledger.mjs`** + **`file-io.mjs`** — Fix `.py` in regexes. Quick wins.
4. **`context.mjs`** — Multi-language stack detection.
5. **`schemas.mjs`** — Add `sonarType`, `effort`, `source` to FindingSchema.
6. **`prompt-seeds.mjs`** — `buildPassPrompt()` with language hints.
7. **`linter.mjs`** — Linter pre-pass orchestration.
8. **`openai-audit.mjs`** — Wire Phase 0 linter, language-aware prompts.
9. **Tests** for all of the above.
10. **`shared.mjs`** — Barrel re-exports.
