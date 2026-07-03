/**
 * @fileoverview Selector-policy lint for generated Playwright specs.
 *
 * Plan: docs/completed/ux-lock-selector-policy.md. The /ux-lock DOM-contract rule
 * constrains how specs LOCATE elements, not just what they assert. This module
 * is the single policy oracle:
 *
 *   - `classifySelector(sel)` — allowlist-semantics, deny-by-default: a string
 *     selector is 'semantic' iff every compound is an optional tag name plus
 *     attribute selectors from the semantic allowlist (data-testid,
 *     data-engine-claim, role, aria-*). Everything else — ids, classes, bare
 *     tags, [name=…], :nth-child, combinators over non-semantic operands — is
 *     'structural' and needs the justification marker.
 *   - `scanSpecSource(source, opts)` — pure scan of one file: selector call
 *     sites (locator / querySelector[All] / .$ / .$$), import legality
 *     (app-module-import), marker attachment, stale markers.
 *   - `scanSpecClosure(specPath, opts)` — follows relative imports within the
 *     test root (visited-set, depth cap) so a structural locator or app import
 *     moved into a local helper is still caught. The module's one impure entry
 *     point (fs injectable for tests).
 *   - `resolveTestRoot(specPath, opts)` — deterministic legality boundary:
 *     explicit flag > OUTERMOST of (containing config testDirs ∪ named test
 *     ancestors) > the spec's own directory. Outermost, not deepest: a nested
 *     project testDir (tests/e2e/mobile) must not flag shared sibling helpers
 *     (tests/e2e/helpers) as app imports.
 *
 * Scan mechanics: comments AND string/template literals are masked (spaces,
 * length-preserving, newlines kept) before call-site/import detection — so
 * locator-looking text in comments and `require('./x')` inside a test
 * assertion string can never false-match — while argument literals are
 * recovered from the ORIGINAL source at the masked quote positions.
 * String/regex-based by design (no AST dep); known-miss surface (selectors
 * built dynamically at runtime) is documented in the plan — escalate to an
 * AST pass only if misses recur in practice.
 *
 * Violation classes (exactly these three count toward strict mode + the DB
 * column): 'structural-selector', 'unresolvable-selector', 'app-module-import'.
 * Stale/reasonless markers are a separate warning surface, never counted.
 *
 * @module scripts/lib/ux-lock/selector-policy
 */

import fs from 'node:fs';
import path from 'node:path';

/** The marker token. A reason after the dash is MANDATORY to justify. */
const MARKER_RE = /selector-policy:\s*structural(?:\s*[—–-]+\s*(\S[^\n]*))?/;

/** Semantic attribute allowlist — the only attributes a clean locator() string may target. */
const SEMANTIC_ATTR_RE = /^(?:data-testid|data-engine-claim|role|aria-[\w-]+)$/i;

/** Import specifiers always allowed regardless of shape. */
const IMPORT_PKG_ALLOW = new Set(['@playwright/test', 'axe-core', '@axe-core/playwright']);

/** Alias-like prefixes that usually map into app source (distinguishable from npm scopes: '@/x' has '/' right after '@'). */
const DEFAULT_ALIAS_PREFIXES = ['~/', '@/'];

const RESOLVE_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.tsx', '.jsx', '/index.js', '/index.mjs', '/index.ts', '/index.jsx'];

// ── masking ─────────────────────────────────────────────────────────────────

/**
 * Mask comments and string/template literals with spaces, preserving length
 * and newlines. String QUOTE DELIMITERS are kept (so call-argument literals
 * can be located and recovered from the original source); comment delimiters
 * are masked along with their contents (so a comment-only line masks blank).
 * Handles regex literals via a prev-significant-char heuristic so a regex
 * containing quotes can't corrupt the state machine.
 */
function maskSource(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let prevSignificant = '';
  let prevWord = ''; // last identifier/keyword seen — disambiguates regex vs division
  let wordActive = false; // whether the previous char continued that word
  const blank = (idx) => { if (out[idx] !== '\n') out[idx] = ' '; };

  // A `/` starts a regex when the previous significant char is an operator or
  // opener — or when the previous WORD is a keyword after which an expression
  // (not a division) must follow. Tracking the word (audit R3-M4) avoids the
  // old `prevSignificant === 'n'` hack that misread `count_n / 2` as a regex.
  const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await']);
  const regexCanStart = (ch) => {
    if (ch === '' || '([{,;=:!&|?+-*%~^<>'.includes(ch)) return true;
    return /[a-zA-Z_$0-9]/.test(ch) && REGEX_KEYWORDS.has(prevWord);
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { blank(i); i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i++; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    if (c === '\'' || c === '"') {
      i++; // keep opening quote
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
        if (src[i] === '\n') break; // unterminated — bail at line end
        blank(i); i++;
      }
      if (i < n && src[i] === c) i++; // keep closing quote
      prevSignificant = c;
      continue;
    }
    if (c === '`') {
      // Template literal: mask the STRING parts but keep `${ … }` expression
      // interiors visible — they are executable code, and masking them would
      // hide selector-policy violations inside template expressions
      // (audit R2-H3). Nested templates inside expressions recurse via the
      // depth counter on this same loop.
      i++; // keep opening backtick
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2; // keep `${` visible (marks the expression boundary)
          let depth = 1;
          while (i < n && depth > 0) {
            const e = src[i];
            if (e === '{') depth++;
            else if (e === '}') { depth--; if (depth === 0) break; }
            else if (e === '\'' || e === '"' || e === '`') {
              // Same rule as top level: keep delimiters, blank contents (so a
              // `}` inside the string can't end the expression early, and
              // literal call-args inside expressions still classify). A NESTED
              // template here is masked as a simple string — its own `${}`
              // interiors are NOT re-entered (audit R3-M2: one level of
              // expression visibility; deeper nesting degrades safe-side to
              // masked text, never to corrupted depth tracking).
              const q = e; i++;
              while (i < n && src[i] !== q) {
                if (src[i] === '\\') { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
                blank(i); i++;
              }
              if (i < n) i++; // keep closing delimiter
              continue;
            }
            i++; // expression code stays UNmasked
          }
          if (i < n) i++; // consume the closing '}'
          continue;
        }
        blank(i); i++;
      }
      if (i < n) i++; // keep closing backtick
      prevSignificant = '`';
      continue;
    }
    if (c === '/' && regexCanStart(prevSignificant)) {
      // Probable regex literal — mask to the unescaped closing '/'.
      let j = i + 1; let inClass = false; let found = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { found = true; break; }
        j++;
      }
      if (found) {
        for (let k = i; k <= j; k++) blank(k);
        i = j + 1;
        while (i < n && /[a-z]/i.test(src[i])) { blank(i); i++; } // flags
        prevSignificant = '/';
        continue;
      }
    }
    if (/[a-zA-Z_$0-9]/.test(c)) {
      prevWord = wordActive ? prevWord + c : c;
      wordActive = true;
    } else {
      wordActive = false;
      if (!/\s/.test(c)) prevWord = ''; // an operator/punct breaks the word context; whitespace preserves it
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join('');
}

// ── selector classification ─────────────────────────────────────────────────

/**
 * Classify a selector string: 'semantic' | 'structural'.
 * Semantic = every combinator-separated compound is an optional tag name plus
 * one or more allowlisted attribute selectors, nothing else.
 */
export function classifySelector(sel) {
  const s = String(sel ?? '').trim();
  if (!s) return 'structural';
  // Tokenize compounds, respecting quoted attribute values.
  const compounds = [];
  let cur = '';
  let depth = 0; let quote = null;
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === '\'') { cur += ch; quote = ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      if (cur) { compounds.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) compounds.push(cur);
  if (compounds.length === 0) return 'structural';

  for (const comp of compounds) {
    // Optional leading tag name.
    let rest = comp;
    const tag = rest.match(/^[a-zA-Z][\w-]*/);
    if (tag) rest = rest.slice(tag[0].length);
    if (rest === '' && tag) return 'structural'; // bare tag compound — positional/structural
    while (rest.length > 0) {
      if (rest[0] !== '[') return 'structural'; // #id, .class, :pseudo, *, …
      // Find the matching ']' respecting quotes.
      let j = 1; let q = null;
      while (j < rest.length) {
        const ch = rest[j];
        if (q) { if (ch === q) q = null; }
        else if (ch === '"' || ch === '\'') q = ch;
        else if (ch === ']') break;
        j++;
      }
      if (j >= rest.length) return 'structural'; // unterminated
      const inner = rest.slice(1, j);
      const attrName = inner.match(/^\s*([\w-]+)/)?.[1] ?? '';
      if (!SEMANTIC_ATTR_RE.test(attrName)) return 'structural';
      rest = rest.slice(j + 1);
    }
  }
  return 'semantic';
}

// ── test-root + alias resolution ────────────────────────────────────────────

const norm = (p) => path.resolve(p).replace(/\\/g, '/');
const normKey = (p) => (process.platform === 'win32' ? norm(p).toLowerCase() : norm(p));

/** True when `child` is inside (or equals) `parent`. */
function contains(parent, child) {
  const p = normKey(parent);
  const c = normKey(child);
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}

/**
 * Deterministic legality boundary for a spec file:
 * flag > OUTERMOST of (config testDirs containing the spec ∪ ancestors named
 * tests|test|e2e) > the spec file's own directory.
 *
 * The ancestor walk is ANCHORED at `repoRoot` when provided — a repository
 * that itself lives under a directory named `tests`/`test`/`e2e`
 * (e.g. /home/user/tests/myrepo) must not get a legality boundary outside
 * the repo, which would silently legalise app imports (audit R1-H7).
 */
export function resolveTestRoot(specPath, { flag = null, configTestDirs = [], repoRoot = null } = {}) {
  if (flag) return path.resolve(flag);
  const abs = path.resolve(specPath);
  const anchor = repoRoot ? path.resolve(repoRoot) : null;
  const candidates = [];
  for (const dir of configTestDirs || []) {
    const d = path.resolve(dir);
    if (contains(d, abs) && (!anchor || contains(anchor, d))) candidates.push(d);
  }
  let cur = path.dirname(abs);
  for (;;) {
    if (anchor && !contains(anchor, cur)) break; // never climb above the repo
    if (/^(tests|test|e2e)$/i.test(path.basename(cur))) candidates.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (candidates.length === 0) return path.dirname(abs);
  // Outermost = shortest normalized path.
  candidates.sort((a, b) => norm(a).length - norm(b).length);
  return candidates[0];
}

/**
 * JSONC-tolerant alias-map read from tsconfig.json / jsconfig.json
 * `compilerOptions.paths`. Any failure degrades to null (no alias map) —
 * never throws (tsconfig legitimately contains comments + trailing commas).
 */
export function readAliasMapFromTsconfig(repoRoot, fsImpl = fs) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = path.join(repoRoot, name);
    let raw;
    try { raw = fsImpl.readFileSync(p, 'utf8'); } catch { continue; }
    try {
      const jsonish = maskJsoncComments(raw).replace(/,\s*([}\]])/g, '$1');
      const cfg = JSON.parse(jsonish);
      const paths = cfg?.compilerOptions?.paths;
      if (!paths || typeof paths !== 'object') continue;
      const baseUrl = cfg?.compilerOptions?.baseUrl || '.';
      const map = {};
      for (const [key, targets] of Object.entries(paths)) {
        const target = Array.isArray(targets) ? targets[0] : targets;
        if (typeof target !== 'string') continue;
        const prefix = key.replace(/\*$/, '');
        const dir = path.resolve(repoRoot, baseUrl, target.replace(/\*$/, ''));
        if (prefix) map[prefix] = dir;
      }
      return Object.keys(map).length ? map : null;
    } catch {
      return null; // malformed config → no alias map (degraded, not fatal)
    }
  }
  return null;
}

/** Mask JSONC comments (string-aware) so JSON.parse can run. */
function maskJsoncComments(src) {
  let out = ''; let i = 0; let quote = null;
  while (i < src.length) {
    const c = src[i]; const c2 = src[i + 1];
    if (quote) { out += c; if (c === '\\') { out += c2 ?? ''; i += 2; continue; } if (c === quote) quote = null; i++; continue; }
    if (c === '"') { quote = c; out += c; i++; continue; }
    if (c === '/' && c2 === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

/** Best-effort testDir scrape from playwright.config.* (tolerant — regex, never throws). */
export function readPlaywrightTestDirs(repoRoot, fsImpl = fs) {
  const dirs = [];
  for (const name of ['playwright.config.js', 'playwright.config.mjs', 'playwright.config.ts', 'playwright.config.cjs', 'playwright.config.mts']) {
    const p = path.join(repoRoot, name);
    let raw;
    try { raw = fsImpl.readFileSync(p, 'utf8'); } catch { continue; }
    for (const m of raw.matchAll(/testDir\s*:\s*['"]([^'"]+)['"]/g)) {
      dirs.push(path.resolve(repoRoot, m[1]));
    }
    break;
  }
  return dirs;
}

// ── import classification ───────────────────────────────────────────────────

/**
 * Classify one import specifier.
 * @returns {{kind: 'clean'|'closure'|'violation'|'unresolved-alias', resolved?: string}}
 */
function classifyImport(spec, { fileDir, testRoot, aliasMap }) {
  if (spec.startsWith('node:')) return { kind: 'clean' };
  if (IMPORT_PKG_ALLOW.has(spec)) return { kind: 'clean' };
  if (/^[a-zA-Z]+:\/\//.test(spec) || spec.startsWith('file:')) return { kind: 'violation' }; // URL import
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const resolved = path.resolve(fileDir, spec);
    return contains(testRoot, resolved) ? { kind: 'closure', resolved } : { kind: 'violation' };
  }
  if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return { kind: 'violation' };
  // Alias-like? Configured prefixes first, then the default alias shapes.
  const prefixes = [...Object.keys(aliasMap || {}), ...DEFAULT_ALIAS_PREFIXES];
  for (const prefix of prefixes) {
    if (!spec.startsWith(prefix)) continue;
    const dir = aliasMap?.[prefix];
    if (!dir) return { kind: 'unresolved-alias' };
    const resolved = path.resolve(dir, spec.slice(prefix.length));
    return contains(testRoot, resolved) ? { kind: 'closure', resolved } : { kind: 'violation' };
  }
  // Bare npm specifier ('lodash', '@scope/pkg') — third-party test deps are fine;
  // the prohibited thing is app SOURCE in the spec process.
  return { kind: 'clean' };
}

// ── single-file scan ────────────────────────────────────────────────────────

/**
 * Pure scan of one spec/helper source.
 *
 * @param {string} source
 * @param {{filePath: string, testRoot: string, aliasMap?: Object}} opts
 * @returns {{
 *   violations: Array<{file: string, line: number, class: string, snippet: string}>,
 *   justifiedCount: number,
 *   staleMarkers: Array<{file: string, line: number, reason: string}>,
 *   unresolvedAliases: Array<{file: string, line: number, specifier: string}>,
 *   relativeImports: string[],
 * }}
 */
export function scanSpecSource(source, { filePath, testRoot, aliasMap = null } = {}) {
  const masked = maskSource(source);
  const origLines = source.split('\n');
  const maskedLines = masked.split('\n');
  const lineAt = (idx) => masked.slice(0, idx).split('\n').length; // 1-based

  // Markers (read from ORIGINAL source — they live in comments, which masking blanks).
  const markers = new Map(); // line → {hasReason}
  origLines.forEach((text, i) => {
    const m = text.match(MARKER_RE);
    if (m) markers.set(i + 1, { hasReason: !!m[1] });
  });
  const commentOnly = (line) => (maskedLines[line - 1] ?? '').trim() === '';
  const justifiedAt = (line) => {
    const own = markers.get(line);
    if (own?.hasReason) return true;
    const above = markers.get(line - 1);
    return !!(above?.hasReason && commentOnly(line - 1));
  };

  const violations = [];
  const unresolvedAliases = [];
  const relativeImports = [];
  let justifiedCount = 0;
  const structuralLines = new Set(); // lines carrying any structural pattern (for stale-marker calc)
  const snippetAt = (line) => (origLines[line - 1] ?? '').trim().slice(0, 160);

  const pushSelectorViolation = (line, cls) => {
    structuralLines.add(line);
    if (justifiedAt(line)) { justifiedCount++; return; }
    violations.push({ file: filePath, line, class: cls, snippet: snippetAt(line) });
  };

  // Selector call sites: .locator( / bare locator( / querySelector[All]( /
  // .$( / .$$( — plus the always-structural DOM lookups (getElementById /
  // getElementsByClassName / getElementsByTagName target ids/classes/tags by
  // definition, so their argument needs no classification; audit R2-M7).
  const callRe = /(?:\.|\b)(locator|querySelectorAll|querySelector)\s*\(|\.\s*(\$\$?)\s*\(|(?:\.|\b)(getElementById|getElementsByClassName|getElementsByTagName)\s*\(/g;
  for (const m of masked.matchAll(callRe)) {
    const openIdx = masked.indexOf('(', m.index + m[0].length - 1);
    if (openIdx < 0) continue;
    const line = lineAt(m.index);
    if (m[3]) { // getElementBy* — structural location strategy regardless of argument
      pushSelectorViolation(line, 'structural-selector');
      continue;
    }
    let k = openIdx + 1;
    while (k < masked.length && /\s/.test(masked[k])) k++;
    const ch = masked[k];
    if (ch === '\'' || ch === '"') {
      const close = masked.indexOf(ch, k + 1);
      if (close < 0) { pushSelectorViolation(line, 'unresolvable-selector'); continue; }
      const sel = source.slice(k + 1, close);
      if (classifySelector(sel) === 'structural') pushSelectorViolation(line, 'structural-selector');
    } else if (ch === '`') {
      pushSelectorViolation(line, 'unresolvable-selector'); // template — not statically provable
    } else if (ch === ')') {
      continue; // no-arg call (e.g. Playwright .$$() misuse) — nothing to classify
    } else {
      pushSelectorViolation(line, 'unresolvable-selector'); // identifier/expression arg
    }
  }

  // Imports: static `import … from '…'` / `import '…'`, dynamic `import(…)`, `require(…)`.
  const fileDir = path.dirname(path.resolve(filePath));
  const handleImport = (specStart, quote, line, { nonLiteral = false } = {}) => {
    if (nonLiteral) {
      violations.push({ file: filePath, line, class: 'app-module-import', snippet: snippetAt(line) });
      return;
    }
    const close = masked.indexOf(quote, specStart);
    if (close < 0) return;
    const spec = source.slice(specStart, close);
    const res = classifyImport(spec, { fileDir, testRoot, aliasMap });
    if (res.kind === 'violation') {
      violations.push({ file: filePath, line, class: 'app-module-import', snippet: snippetAt(line) });
    } else if (res.kind === 'unresolved-alias') {
      unresolvedAliases.push({ file: filePath, line, specifier: spec });
    } else if (res.kind === 'closure') {
      relativeImports.push(res.resolved);
    }
  };

  const staticImportRe = /\bimport\s+(?:[\w${}\s,*]+?\s+from\s+)?(['"])/g;
  for (const m of masked.matchAll(staticImportRe)) {
    handleImport(m.index + m[0].length, m[1], lineAt(m.index));
  }
  const dynImportRe = /\bimport\s*\(\s*(['"`])?/g;
  for (const m of masked.matchAll(dynImportRe)) {
    const line = lineAt(m.index);
    if (!m[1]) handleImport(0, '', line, { nonLiteral: true });
    else if (m[1] === '`') handleImport(0, '', line, { nonLiteral: true });
    else handleImport(m.index + m[0].length, m[1], line);
  }
  const requireRe = /\brequire\s*\(\s*(['"`])?/g;
  for (const m of masked.matchAll(requireRe)) {
    const line = lineAt(m.index);
    if (!m[1] || m[1] === '`') handleImport(0, '', line, { nonLiteral: true });
    else handleImport(m.index + m[0].length, m[1], line);
  }

  // Stale markers: a marker whose target line carries no structural pattern,
  // or a marker missing its mandatory reason.
  const staleMarkers = [];
  for (const [line, info] of markers) {
    if (!info.hasReason) {
      staleMarkers.push({ file: filePath, line, reason: 'missing-reason — a bare marker justifies nothing' });
      continue;
    }
    const target = commentOnly(line) ? line + 1 : line;
    if (!structuralLines.has(target)) {
      staleMarkers.push({ file: filePath, line, reason: 'no structural selector on the target line' });
    }
  }

  return { violations, justifiedCount, staleMarkers, unresolvedAliases, relativeImports };
}

// ── closure scan (the one impure entry point) ───────────────────────────────

/**
 * Scan a spec plus its relative-import closure within the test root.
 * Fail-closed: an unreadable file or unresolvable relative import lands in
 * `failures` — the caller must treat a non-empty `failures` as unverified.
 */
export function scanSpecClosure(specPath, { testRoot, aliasMap = null, fsImpl = fs, maxDepth = 8 } = {}) {
  const agg = { files: [], violations: [], justifiedCount: 0, staleMarkers: [], unresolvedAliases: [], failures: [] };
  const visited = new Set();

  const visit = (filePath, depth) => {
    const key = normKey(filePath);
    if (visited.has(key)) return;
    visited.add(key);

    // Resolve to an existing file (extension attempts for extension-less specifiers).
    let resolved = null;
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = filePath + ext;
      try { if (fsImpl.statSync(candidate).isFile()) { resolved = candidate; break; } } catch { /* keep trying */ }
    }
    if (!resolved) {
      agg.failures.push({ file: filePath, reason: depth === 0 ? 'unreadable-spec' : 'unresolvable-import' });
      return;
    }
    let source;
    try { source = fsImpl.readFileSync(resolved, 'utf8'); }
    catch (e) { agg.failures.push({ file: resolved, reason: `unreadable: ${e.message}` }); return; }

    agg.files.push(resolved);
    const r = scanSpecSource(source, { filePath: resolved, testRoot, aliasMap });
    agg.violations.push(...r.violations);
    agg.justifiedCount += r.justifiedCount;
    agg.staleMarkers.push(...r.staleMarkers);
    agg.unresolvedAliases.push(...r.unresolvedAliases);
    if (depth >= maxDepth) return;
    for (const imp of r.relativeImports) visit(imp, depth + 1);
  };

  visit(path.resolve(specPath), 0);
  return agg;
}

// Test-internal exports.
export const _internals = Object.freeze({
  maskSource,
  maskJsoncComments,
  classifyImport,
  contains,
  MARKER_RE,
  IMPORT_PKG_ALLOW,
  DEFAULT_ALIAS_PREFIXES,
});
