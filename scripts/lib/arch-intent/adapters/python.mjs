/**
 * @fileoverview Python adapter for the architecture-intent framework.
 *
 * Pure-JS Python import analysis — NO Python runtime required. Parses
 * `import` / `from ... import` statements directly, resolves them against a
 * packaging-aware source-root model, and checks each local edge against
 * `domainMap.allowedDeps`.
 *
 * Conforms to the PR-A adapter contract: exports
 * `default async function analyseImports({mapped, domainMap, repoPath})`
 * returning `{violations, _meta, analyzerVersion}`.
 *
 * Resolution is three-state (plan §2.4): `resolved-local` (domain-checked),
 * `proven-external` (stdlib → vendor, always allowed), `unresolved`
 * (recorded in `_meta.unresolvedEdges`, never a violation, never vendor).
 *
 * @module scripts/lib/arch-intent/adapters/python
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveFileToDomain, checkDepAllowed, VENDOR_DOMAIN } from '../domain-resolver.mjs';

const VERSION = 'python-1.0.0';

/**
 * Python standard-library top-level package names. A frozen allowlist — the
 * ONLY way an import becomes `proven-external` (plan §2.4 row 2). Top-level
 * names are extremely stable across Python versions; a miss simply lands the
 * import in `unresolved` (visible, harmless), never a false violation.
 */
export const PYTHON_STDLIB = new Set([
  '__future__', 'abc', 'argparse', 'array', 'ast', 'asyncio', 'base64',
  'bisect', 'builtins', 'bz2', 'calendar', 'cmath', 'collections',
  'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
  'copyreg', 'csv', 'ctypes', 'dataclasses', 'datetime', 'decimal',
  'difflib', 'dis', 'email', 'enum', 'errno', 'faulthandler', 'filecmp',
  'fileinput', 'fnmatch', 'fractions', 'functools', 'gc', 'getopt',
  'getpass', 'gettext', 'glob', 'graphlib', 'gzip', 'hashlib', 'heapq',
  'hmac', 'html', 'http', 'imaplib', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale',
  'logging', 'lzma', 'mailbox', 'math', 'mimetypes', 'multiprocessing',
  'numbers', 'operator', 'os', 'pathlib', 'pickle', 'pickletools',
  'pkgutil', 'platform', 'plistlib', 'poplib', 'posixpath', 'pprint',
  'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'queue', 'quopri',
  'random', 're', 'reprlib', 'resource', 'runpy', 'sched', 'secrets',
  'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site',
  'smtplib', 'socket', 'socketserver', 'sqlite3', 'ssl', 'stat',
  'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'symtable',
  'sys', 'sysconfig', 'tarfile', 'tempfile', 'termios', 'textwrap',
  'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib',
  'trace', 'traceback', 'tracemalloc', 'tty', 'types', 'typing',
  'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'wave',
  'weakref', 'webbrowser', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport',
  'zlib', 'zoneinfo',
]);

const PY_EXTS = ['.py', '.pyi'];

// ── Lexical preprocessing ───────────────────────────────────────────────────

/**
 * Blank out comments and string literals, preserving newlines (so `line`
 * numbers in extracted imports stay accurate). A character-level scanner
 * with explicit state for every Python string form, including PEP 701
 * f-strings (brace-depth tracking so a reused quote inside `{...}` does not
 * desync the scanner).
 *
 * @param {string} source
 * @returns {string} source with comment + string bytes replaced by spaces
 */
export function stripPythonCommentsAndStrings(source) {
  const out = [];
  const n = source.length;
  let i = 0;

  const isIdentChar = c => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const c = source[i];

    // Comment: # to end of line
    if (c === '#') {
      while (i < n && source[i] !== '\n') { out.push(' '); i++; }
      continue;
    }

    // Potential string start: a quote, possibly with a 1-2 char prefix.
    if (c === '"' || c === "'") {
      // Look back over already-emitted chars for a prefix run.
      let prefix = '';
      let k = out.length - 1;
      while (k >= 0 && isIdentChar(out[k]) && prefix.length < 2) {
        prefix = out[k] + prefix;
        k--;
      }
      const isPrefix = /^[rRbBfFuU]{1,2}$/.test(prefix);
      const isF = isPrefix && /[fF]/.test(prefix);

      const quote = c;
      const triple = source[i + 1] === quote && source[i + 2] === quote;
      const delimLen = triple ? 3 : 1;
      // Emit the opening delimiter as spaces.
      for (let d = 0; d < delimLen; d++) { out.push(' '); }
      i += delimLen;

      // Consume the body until the matching close.
      let braceDepth = 0;
      while (i < n) {
        const ch = source[i];
        // Escape: backslash consumes the next char and never terminates.
        if (ch === '\\') {
          out.push(' ');
          if (i + 1 < n) { out.push(source[i + 1] === '\n' ? '\n' : ' '); }
          i += 2;
          continue;
        }
        // f-string brace-depth tracking (PEP 701).
        if (isF) {
          if (ch === '{' && source[i + 1] === '{') { out.push('  '); i += 2; continue; }
          if (ch === '}' && source[i + 1] === '}') { out.push('  '); i += 2; continue; }
          if (ch === '{') { braceDepth++; out.push(' '); i++; continue; }
          if (ch === '}') { if (braceDepth > 0) braceDepth--; out.push(' '); i++; continue; }
          // Inside an interpolation, a quote opens a NESTED string literal —
          // its braces are string content, not interpolation braces. Skip the
          // whole nested string so they aren't miscounted. Handles the common
          // one-level case (`f"{ d["}"] }"`); deeper PEP 701 nesting is rare.
          if (braceDepth > 0 && (ch === '"' || ch === "'")) {
            const nq = ch;
            const nTriple = source[i + 1] === nq && source[i + 2] === nq;
            const nLen = nTriple ? 3 : 1;
            for (let d = 0; d < nLen; d++) out.push(' ');
            i += nLen;
            while (i < n) {
              if (source[i] === '\\') {
                out.push(' ');
                if (i + 1 < n) out.push(source[i + 1] === '\n' ? '\n' : ' ');
                i += 2; continue;
              }
              if (source[i] === nq &&
                  (!nTriple || (source[i + 1] === nq && source[i + 2] === nq))) {
                for (let d = 0; d < nLen; d++) out.push(' ');
                i += nLen; break;
              }
              if (source[i] === '\n' && !nTriple) { break; }
              out.push(source[i] === '\n' ? '\n' : ' ');
              i++;
            }
            continue;
          }
        }
        // Closing delimiter — only at brace-depth 0.
        if (ch === quote && braceDepth === 0) {
          if (triple) {
            if (source[i + 1] === quote && source[i + 2] === quote) {
              out.push('   '); i += 3; break;
            }
            // lone quote inside a triple-string — literal
            out.push(' '); i++; continue;
          }
          out.push(' '); i++; break;
        }
        // Newline inside a single-quoted string ends it (Python syntax error
        // territory, but stay resilient — treat as terminated). Break WITHOUT
        // emitting/consuming the newline: leave `i` on it so the outer loop
        // emits it exactly once (emitting here would duplicate it → line drift).
        if (ch === '\n' && !triple) { break; }
        out.push(ch === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }
  return out.join('');
}

// ── Import extraction ───────────────────────────────────────────────────────

/**
 * Extract import statements from already-stripped Python source.
 *
 * Known limitation: a single-physical-line compound statement that puts an
 * import after a `:` suite header (`if cond: import x`) is not detected —
 * splitting on `:` is unsafe (slices, annotations, lambdas, dicts all use
 * `:`). This is a false-negative-only gap on an uncommon form, in the same
 * accepted-limitation class as dynamic `importlib` imports (plan §8).
 * Imports on their own line inside `try:`/`if:`/`def` blocks ARE detected.
 *
 * @param {string} source - output of stripPythonCommentsAndStrings
 * @returns {Array<{kind:'import'|'from', module:string, names:string[],
 *   isRelative:boolean, dotCount:number, line:number}>}
 */
export function extractImports(source) {
  const refs = [];
  // Normalise CRLF / lone-CR to LF first — otherwise a continued line on a
  // CRLF file ends with `\\\r`, so the `endsWith('\\')` join below misses it.
  // `\r\n` → `\n` is 1:1 so line numbers are preserved.
  const rawLines = source.replace(/\r\n?/g, '\n').split('\n');

  // Join explicit (\) continuations and parenthesised `from import (...)`
  // groups into logical lines, tracking the starting physical line number.
  const logical = [];
  for (let idx = 0; idx < rawLines.length; idx++) {
    let text = rawLines[idx];
    const startLine = idx + 1;
    // Explicit backslash continuation.
    while (text.endsWith('\\') && idx + 1 < rawLines.length) {
      text = text.slice(0, -1) + ' ' + rawLines[++idx];
    }
    // Parenthesised group: if an unbalanced '(' remains, keep joining.
    while (countUnbalanced(text) > 0 && idx + 1 < rawLines.length) {
      text = text + ' ' + rawLines[++idx];
    }
    logical.push({ text, line: startLine });
  }

  for (const { text, line } of logical) {
    // Python allows multiple simple statements on one line, ';'-separated
    // (`import os; import sys`). Split so imports after the first are seen.
    for (const stmt of text.split(';')) {
      const fromMatch = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(stmt);
      if (fromMatch) {
        const dots = fromMatch[1].length;
        const module = fromMatch[2];
        const names = parseImportedNames(fromMatch[3]);
        refs.push({
          kind: 'from', module, names,
          isRelative: dots > 0, dotCount: dots, line,
        });
        continue;
      }
      const importMatch = /^\s*import\s+(.+)$/.exec(stmt);
      if (importMatch) {
        // Comma-separated: `import a, b.c as d`
        for (const seg of importMatch[1].split(',')) {
          const mod = seg.trim().split(/\s+as\s+/)[0].trim();
          if (mod && /^[\w.]+$/.test(mod)) {
            refs.push({
              kind: 'import', module: mod, names: [],
              isRelative: false, dotCount: 0, line,
            });
          }
        }
      }
    }
  }
  return refs;
}

/** Count unbalanced '(' minus ')' — bounded linear scan. */
function countUnbalanced(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return depth;
}

/** Parse the names clause of a `from x import a, b as c, (d, e)` statement. */
function parseImportedNames(clause) {
  const cleaned = clause.replace(/[()]/g, ' ').trim();
  if (cleaned === '*') return ['*'];
  return cleaned
    .split(',')
    .map(s => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(s => s.length > 0 && /^[\w*]+$/.test(s));
}

// ── Source-root discovery ───────────────────────────────────────────────────

/**
 * Discover Python import roots from four signals (plan §2.1.2): packaging
 * metadata anywhere in the tree, `src/` directories at any depth, the
 * `__init__.py` walk, and the repo root. Handles PEP 420 namespace packages
 * and nested-monorepo layouts.
 *
 * NOT pure — reads `pyproject.toml` / `setup.cfg` under `repoPath`.
 *
 * @param {string} repoPath
 * @param {Map<string,string>} mapped - repo-relative file → domain
 * @returns {string[]} repo-relative source roots, precedence-ordered
 */
export function discoverPythonRoots(repoPath, mapped) {
  const files = [...mapped.keys()];
  const roots = [];
  const seen = new Set();
  const add = r => {
    const norm = r === '.' ? '' : r.replaceAll('\\', '/').replace(/\/+$/, '');
    if (!seen.has(norm)) { seen.add(norm); roots.push(norm); }
  };

  // 1. Packaging metadata anywhere in the tree.
  const metaFiles = files.filter(f =>
    f.endsWith('pyproject.toml') || f.endsWith('setup.cfg'));
  // Also probe the repo root explicitly (metadata files may be untracked-in-mapped).
  for (const rootMeta of ['pyproject.toml', 'setup.cfg']) {
    if (!metaFiles.includes(rootMeta) && fs.existsSync(path.join(repoPath, rootMeta))) {
      metaFiles.push(rootMeta);
    }
  }
  for (const metaFile of metaFiles) {
    const dir = path.dirname(metaFile) === '.' ? '' : path.dirname(metaFile);
    let content = '';
    try { content = fs.readFileSync(path.join(repoPath, metaFile), 'utf-8'); }
    catch { /* unreadable — skip */ }
    const pkgDirs = extractPackageDirs(content);
    if (pkgDirs.length === 0) {
      add(dir); // metadata present but no explicit package-dir → its own dir
    } else {
      for (const pd of pkgDirs) add(dir ? `${dir}/${pd}` : pd);
    }
  }

  // 2. `src/` directories at any depth that hold mapped .py files.
  for (const f of files) {
    if (!isPySource(f)) continue;
    const segs = f.split('/');
    const srcIdx = segs.indexOf('src');
    if (srcIdx >= 0) add(segs.slice(0, srcIdx + 1).join('/'));
  }

  // 3. __init__.py walk — directory above the topmost mapped __init__.py.
  const pkgDirSet = new Set();
  for (const f of files) {
    const b = path.basename(f);
    if (b === '__init__.py' || b === '__init__.pyi') {
      pkgDirSet.add(path.dirname(f).replaceAll('\\', '/'));
    }
  }
  for (const pkgDir of pkgDirSet) {
    let top = pkgDir;
    while (true) {
      const parent = path.dirname(top);
      const parentNorm = parent === '.' ? '' : parent.replaceAll('\\', '/');
      if (pkgDirSet.has(parentNorm)) { top = parentNorm; }
      else { break; }
    }
    const rootDir = path.dirname(top);
    add(rootDir === '.' ? '' : rootDir.replaceAll('\\', '/'));
  }

  // 4. Repo root — always last.
  add('');

  return roots;
}

/** Extract `package-dir` / `where` values from pyproject.toml / setup.cfg text. */
function extractPackageDirs(content) {
  const dirs = [];
  // setup.cfg / pyproject: `package-dir` or `package_dir` with `= src` or `=src`.
  for (const m of content.matchAll(/package[-_]dir\s*=\s*\{?\s*["']?\s*=?\s*["']?([\w./-]+)/gi)) {
    if (m[1] && m[1] !== '{') dirs.push(m[1].replace(/^\.\//, ''));
  }
  // `[tool.setuptools.packages.find]` ... `where = ["src"]`
  for (const m of content.matchAll(/where\s*=\s*\[?\s*["']([\w./-]+)["']/gi)) {
    dirs.push(m[1].replace(/^\.\//, ''));
  }
  return [...new Set(dirs)].filter(d => d && d !== '.');
}

function isPySource(f) {
  const e = path.extname(f).toLowerCase();
  return e === '.py' || e === '.pyi';
}

// ── Module index ────────────────────────────────────────────────────────────

/**
 * Build the dotted-name → file index. Each file is indexed under EXACTLY
 * ONE root — the most-specific (longest prefix) — to avoid bogus aliases
 * and Map collisions (plan §2.1.3 / H1 fix).
 *
 * @param {Map<string,string>} mapped
 * @param {string[]} roots - precedence-ordered (from discoverPythonRoots)
 * @returns {{moduleToFile: Map<string,string>, packageDirs: Set<string>,
 *   indexCollisions: Array<{dottedName:string, files:string[]}>}}
 */
export function buildPythonModuleIndex(mapped, roots) {
  // Longest root first so the most-specific prefix wins.
  const byLen = [...roots].sort((a, b) => b.length - a.length);
  const moduleToFile = new Map();
  const packageDirs = new Set();
  const collisionTracker = new Map(); // dottedName → file[]

  for (const file of mapped.keys()) {
    if (!isPySource(file)) continue;
    const norm = file.replaceAll('\\', '/');
    // Pick the most-specific root that is a path-prefix of this file.
    let chosenRoot = null;
    for (const r of byLen) {
      if (r === '') { chosenRoot = ''; break; }
      if (norm === r || norm.startsWith(r + '/')) { chosenRoot = r; break; }
    }
    if (chosenRoot === null) chosenRoot = '';

    const rel = chosenRoot === '' ? norm : norm.slice(chosenRoot.length + 1);
    const base = path.basename(rel);
    let dotted;
    if (base === '__init__.py' || base === '__init__.pyi') {
      dotted = path.dirname(rel).replaceAll('/', '.');
      if (dotted === '.' || dotted === '') continue; // root __init__ — skip
      packageDirs.add(dotted);
    } else {
      dotted = rel.replace(/\.(py|pyi)$/i, '').replaceAll('/', '.');
    }
    if (!dotted) continue;

    if (!collisionTracker.has(dotted)) collisionTracker.set(dotted, []);
    collisionTracker.get(dotted).push(norm);
  }

  const indexCollisions = [];
  for (const [dotted, files] of collisionTracker) {
    const sorted = [...files].sort((a, b) => a.localeCompare(b));
    moduleToFile.set(dotted, sorted[0]); // deterministic first-sorted-wins
    if (sorted.length > 1) indexCollisions.push({ dottedName: dotted, files: sorted });
  }
  indexCollisions.sort((a, b) => a.dottedName.localeCompare(b.dottedName));

  return { moduleToFile, packageDirs, indexCollisions };
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve one import ref to a three-state result (plan §2.4).
 *
 * @param {object} ref - an extractImports entry
 * @param {string} fromFile - the importing file (repo-relative)
 * @param {{moduleToFile: Map<string,string>, packageDirs: Set<string>}} index
 * @returns {{state:'resolved-local'|'proven-external'|'unresolved',
 *   targetFile?:string, dotted?:string, submodules?:string[]}}
 */
export function resolvePythonImport(ref, fromFile, index) {
  let dotted;

  if (ref.isRelative) {
    // Resolve the importing file's package, then walk up (dotCount-1) levels.
    const fromDir = path.dirname(fromFile).replaceAll('\\', '/');
    let baseParts = fromDir === '.' || fromDir === '' ? [] : fromDir.split('/');
    // Translate the file dir into a dotted package via the index is hard;
    // instead resolve relative dotted names structurally against moduleToFile.
    let up = ref.dotCount - 1;
    while (up > 0 && baseParts.length > 0) { baseParts.pop(); up--; }
    if (up > 0) return { state: 'unresolved' }; // walked above the tree
    const prefix = baseParts.join('.');
    dotted = [prefix, ref.module].filter(Boolean).join('.');
    if (!dotted) {
      // `from . import name` at a package root — resolve each name directly.
      dotted = '';
    }
  } else {
    dotted = ref.module;
  }

  // Absolute import: stdlib check first (proven-external).
  if (!ref.isRelative && dotted) {
    const topLevel = dotted.split('.')[0];
    if (PYTHON_STDLIB.has(topLevel)) {
      return { state: 'proven-external' };
    }
  }

  const { moduleToFile } = index;

  // Try to resolve the module itself.
  let targetFile = dotted ? moduleToFile.get(dotted) : undefined;

  // For `from a.b import c`: also attempt each name as a submodule a.b.c.
  const submodules = [];
  if (ref.kind === 'from') {
    for (const name of ref.names) {
      if (name === '*') continue;
      const subDotted = dotted ? `${dotted}.${name}` : name;
      const subFile = moduleToFile.get(subDotted);
      if (subFile) submodules.push(subFile);
    }
  }

  if (targetFile || submodules.length > 0) {
    return {
      state: 'resolved-local',
      targetFile: targetFile || submodules[0],
      dotted,
      submodules,
    };
  }

  // Relative import that structurally resolved nowhere → unresolved.
  return { state: 'unresolved' };
}

// ── Adapter entry point ─────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Map<string,string>} opts.mapped - repo-relative file → domain
 * @param {object} opts.domainMap - typed config with rules + allowedDeps
 * @param {string} opts.repoPath
 * @returns {Promise<{violations:Array, _meta:object, analyzerVersion:string}>}
 */
export default async function analyseImports({ mapped, domainMap, repoPath }) {
  const meta = {
    edgeCount: 0,
    localEdges: 0,
    vendorEdges: 0,
    unresolvedEdges: [],
    starImports: 0,
    indexCollisions: [],
    sourceRoots: [],
    allFiles: [],
  };

  const pyFiles = [...mapped.keys()].filter(isPySource).sort((a, b) => a.localeCompare(b));
  if (pyFiles.length === 0) {
    return { violations: [], _meta: meta, analyzerVersion: VERSION };
  }

  const roots = discoverPythonRoots(repoPath, mapped);
  const index = buildPythonModuleIndex(mapped, roots);
  meta.sourceRoots = roots;
  meta.indexCollisions = index.indexCollisions;
  meta.allFiles = pyFiles;

  const violations = [];
  const seenViolation = new Set();

  for (const fromFile of pyFiles) {
    let source;
    try { source = fs.readFileSync(path.join(repoPath, fromFile), 'utf-8'); }
    catch { continue; }

    const stripped = stripPythonCommentsAndStrings(source);
    const refs = extractImports(stripped);
    const fromDomain = mapped.get(fromFile) ?? resolveFileToDomain(fromFile, domainMap.rules);
    if (!fromDomain) continue;

    for (const ref of refs) {
      meta.edgeCount++;
      if (ref.kind === 'from' && ref.names.includes('*')) meta.starImports++;

      const res = resolvePythonImport(ref, fromFile, index);

      if (res.state === 'proven-external') {
        meta.vendorEdges++;
        continue;
      }
      if (res.state === 'unresolved') {
        meta.unresolvedEdges.push({ from: fromFile, module: ref.module || `(${'.'.repeat(ref.dotCount)})`, line: ref.line });
        continue;
      }

      // resolved-local — collect every target file (module + submodules).
      const targets = new Set();
      if (res.targetFile) targets.add(res.targetFile);
      for (const s of (res.submodules || [])) targets.add(s);

      for (const toFile of targets) {
        if (toFile === fromFile) continue; // self-edge
        meta.localEdges++;
        const toDomain = mapped.get(toFile) ?? resolveFileToDomain(toFile, domainMap.rules);
        if (!toDomain) continue;
        if (!checkDepAllowed(fromDomain, toDomain, domainMap.allowedDeps)) {
          const key = `${fromFile}\x00${toFile}`;
          if (!seenViolation.has(key)) {
            seenViolation.add(key);
            violations.push({
              fromFile, toFile, fromDomain, toDomain,
              ruleViolated: 'not-in-allowedDeps',
            });
          }
        }
      }
    }
  }

  violations.sort((a, b) =>
    a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile));

  return { violations, _meta: meta, analyzerVersion: VERSION };
}

export const _internals = {
  stripPythonCommentsAndStrings, extractImports, discoverPythonRoots,
  buildPythonModuleIndex, resolvePythonImport, PYTHON_STDLIB,
};
