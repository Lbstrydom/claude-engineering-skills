/**
 * @fileoverview Pure logic for verifying the AGENTS.md "Accepted Technical
 * Debt" table's revisit-trigger claims against repo state. No CLI concerns
 * live here — see `scripts/check-accepted-debt.mjs` for the process adapter.
 *
 * Design: docs/plans/accepted-debt-table-verification.md §2/§4.
 *
 * @module scripts/lib/accepted-debt-check
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import _traverse from '@babel/traverse';
import { parseSource } from './ast.mjs';
import { resolvesToNamedImport, resolvesToModuleBinding } from './import-binding.mjs';
import { globMatch } from './glob-match.mjs';
import { sha, escapeRegExp } from './cli-io.mjs';

// @babel/traverse ships CJS; under ESM the callable lands on .default (and on
// .default.default via some interop paths). Same normalisation as
// find-rmsync-sites.mjs / adjacency-detector.mjs.
const traverse = _traverse?.default?.default ?? _traverse?.default ?? _traverse;

const TABLE_HEADING = '## Accepted Technical Debt';
const ANALYZED_EXTENSIONS = new Set(['.mjs', '.js', '.ts', '.tsx', '.jsx', '.mts']);
const UNSUPPORTED_FORMAT_EXTENSIONS = new Set(['.cjs', '.cts']);
const JS_TS_FAMILY_PATTERNS = ['*.mjs', '*.js', '*.ts', '*.tsx', '*.jsx', '*.mts', '*.cjs', '*.cts'];
const DEFAULT_EXCLUDE_GLOBS = ['tests/fixtures/**'];

function safeErrorClass(err) {
  return err?.constructor?.name || 'Error';
}

/**
 * Does `trimmed` open a fenced code block? Returns the fence character and
 * its run length (CommonMark: 3+ of the same char), or null.
 * @param {string} trimmed
 * @returns {{char: string, len: number} | null}
 */
function matchFenceOpen(trimmed) {
  const m = /^(`{3,}|~{3,})/.exec(trimmed);
  if (!m) return null;
  return { char: m[1][0], len: m[1].length };
}

/**
 * Does `trimmed` close a fence opened with `openChar`/`openLen`? Must be the
 * SAME character, at least as long as the opener, and nothing else on the
 * line (an info-string line like "```js" opens but never closes).
 * @param {string} trimmed
 * @param {string} openChar
 * @param {number} openLen
 * @returns {boolean}
 */
function isFenceClose(trimmed, openChar, openLen) {
  const m = /^(`+|~+)\s*$/.exec(trimmed);
  if (!m) return false;
  return m[1][0] === openChar && m[1].length >= openLen;
}

// ── Table parsing ────────────────────────────────────────────────────────

/**
 * Split a markdown table row into cells. Safe for this table's actual
 * content — none of its cells contain a literal `|` (verified against the
 * live AGENTS.md table); a row that did would need escaping this doesn't
 * handle, which is exactly why malformed rows are rejected below rather
 * than silently mis-split.
 * @param {string} line
 * @returns {string[]}
 */
function splitTableRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|');
}

/**
 * Parse the `## Accepted Technical Debt` table out of AGENTS.md content.
 * Requires the exact heading and exactly the three named columns in order.
 * A malformed row (missing cell, empty cell, duplicate anchor) is a HARD
 * parse error — never a silently-dropped row, because a silently-shrunk
 * table is indistinguishable from a clean one downstream.
 * @param {string} markdown
 * @returns {{ok: true, rows: Array<{anchor:string, rationale:string, trigger:string, fingerprint:string}>} | {ok: false, error: string}}
 */
export function parseAgentsDebtTable(markdown) {
  // ONE fence-tracking pass covers the heading, the header row, AND the
  // section end — all three need the same protection (GPT Sustainability M8,
  // round 3: round 2 made the heading search fence-aware but left the
  // header-row search operating on a naive `findIndex` over the sliced
  // section, so a fenced example containing BOTH a heading-shaped line and a
  // header-row-shaped line could still fool the header-row lookup even after
  // the heading itself resolved correctly).
  const allLines = markdown.split('\n');
  const headingRe = new RegExp(`^${escapeRegExp(TABLE_HEADING)}\\s*$`);
  const headerRowRe = /^\|\s*Item\s*\|\s*Rationale\s*\|\s*Revisit trigger\s*\|\s*$/;

  // Delimiter-matched fence tracking (GPT be-services M1 / Sustainability M6,
  // round 4): a bare "toggle on any ``` or ~~~ line" doesn't distinguish
  // fence CHARACTER or length, so a stray ~~~ could incorrectly close a ```
  // fence (or vice versa), and a closing line needs ONLY the fence chars —
  // "```js" doesn't close, matching CommonMark.
  let fence = null; // {char, len} | null
  let headingLineIdx = -1;
  for (let i = 0; i < allLines.length; i++) {
    const trimmed = allLines[i].trim();
    if (fence) {
      if (isFenceClose(trimmed, fence.char, fence.len)) fence = null;
      continue;
    }
    const opened = matchFenceOpen(trimmed);
    if (opened) { fence = opened; continue; }
    if (headingRe.test(trimmed)) { headingLineIdx = i; break; }
  }
  if (headingLineIdx === -1) {
    return { ok: false, error: `heading "${TABLE_HEADING}" not found (as an actual heading line, outside any fenced code block)` };
  }

  // fence is null here (a heading line is never itself a fence marker) —
  // continue the SAME scan for the header row and the section end.
  let headerLineIdx = -1;
  let sectionEndLineIdx = allLines.length;
  for (let i = headingLineIdx + 1; i < allLines.length; i++) {
    const trimmed = allLines[i].trim();
    if (fence) {
      if (isFenceClose(trimmed, fence.char, fence.len)) fence = null;
      continue;
    }
    const opened = matchFenceOpen(trimmed);
    if (opened) { fence = opened; continue; }
    if (headerLineIdx === -1 && headerRowRe.test(trimmed)) { headerLineIdx = i; continue; }
    // Ends at a heading of the SAME OR HIGHER level (Gemini gate G1, round 1:
    // a `# ` (level 1) heading also terminates a level-2 subsection, not just
    // another `## `). `#{1,2}` — not a bare `#`, which would also match `###`.
    if (/^#{1,2}\s/.test(trimmed)) { sectionEndLineIdx = i; break; }
  }
  if (headerLineIdx === -1) {
    return { ok: false, error: 'table header row "| Item | Rationale | Revisit trigger |" not found under the heading (outside any fenced code block)' };
  }
  const sepLine = allLines[headerLineIdx + 1];
  if (!sepLine || !/^\|[\s:-]+\|[\s:-]+\|[\s:-]+\|\s*$/.test(sepLine.trim())) {
    return { ok: false, error: 'table separator row missing or malformed' };
  }

  const rows = [];
  const seenAnchors = new Set();
  for (let i = headerLineIdx + 2; i < sectionEndLineIdx; i++) {
    const line = allLines[i];
    if (!line.trim().startsWith('|')) break; // table ended
    const cells = splitTableRow(line);
    if (cells.length !== 3) {
      return { ok: false, error: `malformed table row (expected 3 cells, got ${cells.length}): ${line.trim()}` };
    }
    const [item, rationale, trigger] = cells.map((c) => c.trim());
    if (!item || !rationale || !trigger) {
      return { ok: false, error: `malformed table row (empty cell): ${line.trim()}` };
    }
    if (seenAnchors.has(item)) {
      return { ok: false, error: `duplicate Item anchor in table: ${item}` };
    }
    seenAnchors.add(item);
    rows.push({ anchor: item, rationale, trigger, fingerprint: computeRowFingerprint({ item, rationale, trigger }) });
  }
  if (rows.length === 0) {
    return { ok: false, error: 'table found but has zero data rows' };
  }
  return { ok: true, rows };
}

/**
 * Content fingerprint of a table row's cells — normalized, never cached, so
 * it cannot itself go stale. Used to detect a row whose prose changed since
 * its registry entry was classified (anchor identity alone can't catch that).
 * @param {{item: string, rationale: string, trigger: string}} row
 * @returns {string}
 */
export function computeRowFingerprint({ item, rationale, trigger }) {
  const normalized = [item, rationale, trigger].map((s) => s.trim().replace(/\s+/g, ' ')).join(' ');
  return sha(normalized, 16);
}

// ── Registry/table parity ───────────────────────────────────────────────

/**
 * Diff the live table rows against the registry by BOTH anchor and content
 * fingerprint. Anchor-only parity would miss a row whose prose changed
 * without its `Item` cell changing.
 *
 * Precondition: `registryRows` has no duplicate `agentsTableAnchor` — the
 * normal caller path enforces this via `loadRegistry()`'s collection-level
 * Zod validation before this function ever runs. Defended anyway (GPT
 * be-services M3, round 2): a caller that bypasses `loadRegistry()` (a
 * hand-built test fixture, a future direct caller) and supplies a
 * duplicate-anchor registry gets every table row sharing that anchor marked
 * `registry-stale` rather than silently trusting whichever duplicate a
 * plain `Map` happened to keep last.
 * @param {Array<{anchor:string, rationale:string, trigger:string, fingerprint:string}>} tableRows
 * @param {Array<{agentsTableAnchor:string, rowFingerprint:string}>} registryRows
 * @returns {Array<{anchor:string, liveFingerprint:string|null, registryStatus:'registered'|'unregistered'|'orphaned'|'registry-stale', registryRow:object|null}>}
 */
export function checkRegistryParity(tableRows, registryRows) {
  const byAnchorTable = new Map(tableRows.map((r) => [r.anchor, r]));
  const byAnchorRegistry = new Map(registryRows.map((r) => [r.agentsTableAnchor, r]));
  const registryAnchorCounts = new Map();
  for (const r of registryRows) {
    registryAnchorCounts.set(r.agentsTableAnchor, (registryAnchorCounts.get(r.agentsTableAnchor) || 0) + 1);
  }

  const results = [];
  for (const tRow of tableRows) {
    const reg = byAnchorRegistry.get(tRow.anchor);
    if (!reg) {
      results.push({ anchor: tRow.anchor, liveFingerprint: tRow.fingerprint, registryStatus: 'unregistered', registryRow: null });
      continue;
    }
    if (registryAnchorCounts.get(tRow.anchor) > 1) {
      results.push({ anchor: tRow.anchor, liveFingerprint: tRow.fingerprint, registryStatus: 'registry-stale', registryRow: reg });
      continue;
    }
    if (reg.rowFingerprint !== tRow.fingerprint) {
      results.push({ anchor: tRow.anchor, liveFingerprint: tRow.fingerprint, registryStatus: 'registry-stale', registryRow: reg });
      continue;
    }
    results.push({ anchor: tRow.anchor, liveFingerprint: tRow.fingerprint, registryStatus: 'registered', registryRow: reg });
  }
  for (const reg of registryRows) {
    if (!byAnchorTable.has(reg.agentsTableAnchor)) {
      results.push({ anchor: reg.agentsTableAnchor, liveFingerprint: null, registryStatus: 'orphaned', registryRow: reg });
    }
  }
  return results;
}

// ── Source enumeration ──────────────────────────────────────────────────

/**
 * Default `git ls-files` invocation, NUL-delimited. Injectable so tests
 * never shell out.
 * @param {string[]} patterns
 * @returns {{ok: true, files: string[]} | {ok: false, error: string}}
 */
function defaultListTrackedFiles(patterns) {
  const r = spawnSync('git', ['ls-files', '-z', '--', ...patterns], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() || `git ls-files exited ${r.status}` };
  const files = r.stdout.split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
  return { ok: true, files };
}

/**
 * Enumerate tracked source files relevant to a `no-invocation-outside-scope`
 * predicate. `allowedGlobs` is applied FIRST, before the analyzed/
 * unsupported-format split — a file allowed to call the symbol doesn't need
 * to be parsed at all, so its format is irrelevant (a `.cjs` fixture inside
 * an allowed directory must never permanently trip `unknown`).
 * @param {{allowedGlobs?: string[], excludeGlobs?: string[], listTrackedFiles?: (patterns: string[]) => ({ok:true, files:string[]}|{ok:false, error:string})}} opts
 * @returns {{ok: true, analyzed: string[], unsupportedFormat: string[]} | {ok: false, error: string}}
 */
export function enumerateTrackedSources({
  allowedGlobs = [],
  excludeGlobs = DEFAULT_EXCLUDE_GLOBS,
  listTrackedFiles = defaultListTrackedFiles,
} = {}) {
  const res = listTrackedFiles(JS_TS_FAMILY_PATTERNS);
  if (!res.ok) return { ok: false, error: res.error };

  const nonExcluded = res.files.filter((f) => !excludeGlobs.some((g) => globMatch(g, f)));
  const nonAllowed = nonExcluded.filter((f) => !allowedGlobs.some((g) => globMatch(g, f)));

  const analyzed = [];
  const unsupportedFormat = [];
  for (const f of nonAllowed) {
    const ext = path.extname(f);
    if (UNSUPPORTED_FORMAT_EXTENSIONS.has(ext)) unsupportedFormat.push(f);
    else if (ANALYZED_EXTENSIONS.has(ext)) analyzed.push(f);
    // any other extension matched by the JS/TS-family pathspec but not in
    // either set is impossible today (the pathspec IS the union of both),
    // so no third bucket is needed.
  }
  return { ok: true, analyzed, unsupportedFormat };
}

function defaultReadTrackedSource(relPath) {
  return fs.readFileSync(path.resolve(relPath), 'utf-8');
}

/**
 * Does `modulePath` still export a top-level named binding `symbol`,
 * whether declared directly (`export function X` / `export const X`) or
 * re-exported (`export { X } from '...'`, `export { Y as X } from '...'`)?
 * @param {string} modulePath
 * @param {string} symbol
 * @returns {boolean}
 */
function defaultHasSymbol(modulePath, symbol) {
  const abs = path.resolve(modulePath);
  if (!fs.existsSync(abs)) return false;
  const source = fs.readFileSync(abs, 'utf-8');
  const { ast, error } = parseSource(source);
  if (error || !ast) throw new Error(`cannot parse provenance module ${modulePath}: ${error}`);

  const program = ast.program ?? ast;
  for (const stmt of program.body) {
    if (stmt.type !== 'ExportNamedDeclaration') continue;
    if (stmt.declaration) {
      if (stmt.declaration.type === 'FunctionDeclaration' && stmt.declaration.id?.name === symbol) return true;
      if (stmt.declaration.type === 'VariableDeclaration') {
        for (const d of stmt.declaration.declarations) {
          if (d.id?.type === 'Identifier' && d.id.name === symbol) return true;
        }
      }
    }
    if (stmt.specifiers) {
      for (const spec of stmt.specifiers) {
        if (spec.type !== 'ExportSpecifier') continue;
        const exportedName = spec.exported.name ?? spec.exported.value;
        if (exportedName === symbol) return true;
      }
    }
  }
  return false;
}

// ── Predicate execution ─────────────────────────────────────────────────

/**
 * Find the first call site in `ast` that genuinely resolves — via real
 * lexical scope, not name matching — to an invocation of `symbol` imported
 * from one of `provenanceAbsPaths`. Checks two call shapes: a bare
 * identifier callee (named import, including aliased) and a member-access
 * callee on a namespace-import binding. Mirrors
 * `find-rmsync-sites.mjs`'s two-shape pattern for `fs.rmSync`.
 * @param {object} ast
 * @param {string} fromFileAbsPath
 * @param {{symbol: string, provenanceAbsPaths: string[]}} spec
 * @returns {{line: number} | null}
 */
function findContradictingCallSite(ast, fromFileAbsPath, { symbol, provenanceAbsPaths }) {
  let found = null;

  traverse(ast, {
    'CallExpression|OptionalCallExpression'(nodePath) {
      if (found) return;
      const callee = nodePath.node.callee;

      if (callee.type === 'Identifier') {
        const calleePath = nodePath.get('callee');
        for (const provAbs of provenanceAbsPaths) {
          if (resolvesToNamedImport(calleePath, { importedName: symbol, moduleAbsPath: provAbs, fromFileAbsPath })) {
            found = { line: nodePath.node.loc?.start?.line ?? 0 };
            return;
          }
        }
        return;
      }

      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
        const propName = !callee.computed && callee.property.type === 'Identifier'
          ? callee.property.name
          : (callee.computed && callee.property.type === 'StringLiteral' ? callee.property.value : null);
        if (propName !== symbol) return;
        if (callee.object.type !== 'Identifier') return;
        const objectPath = nodePath.get('callee').get('object');
        for (const provAbs of provenanceAbsPaths) {
          if (resolvesToModuleBinding(objectPath, { moduleAbsPath: provAbs, fromFileAbsPath })) {
            found = { line: nodePath.node.loc?.start?.line ?? 0 };
            return;
          }
        }
      }
    },
  });

  return found;
}

/**
 * Find a call to `symbol` written LOCALLY inside one of its own provenance
 * modules — a shape `findContradictingCallSite` cannot see, since that
 * function only recognises a callee resolving to a NAMED IMPORT of
 * `symbol` from a provenance module. A call from inside the module that
 * defines/exports `symbol` needs no import at all, so it resolves to
 * neither `resolvesToNamedImport` nor `resolvesToModuleBinding` — it is
 * genuinely invisible to the contradiction check, not merely compliant.
 *
 * Scoped tightly to avoid false positives: only fires when `fromFileAbsPath`
 * IS one of `provenanceAbsPaths` (so an unrelated file that happens to
 * define its own same-named local function is never touched — that shape
 * is already correctly excluded by real scope resolution elsewhere), and
 * only for a bare-identifier callee that does NOT resolve as a named import
 * of `symbol` from another provenance module (which would already be a
 * legitimate re-export chain, not a local call).
 *
 * Deliberately does not classify the call as `contradicted` — the symbol
 * is defined in this file, so referencing it here is not provably a scope
 * violation. But it must not be silently reported as `holds` either: the
 * caller folds a hit from this function into `unknown` evidence.
 *
 * @param {object} ast
 * @param {string} fromFileAbsPath
 * @param {{symbol: string, provenanceAbsPaths: string[]}} spec
 * @returns {{line: number} | null}
 */
function findLocalProvenanceCallSite(ast, fromFileAbsPath, { symbol, provenanceAbsPaths }) {
  if (!provenanceAbsPaths.includes(fromFileAbsPath)) return null;

  let found = null;
  traverse(ast, {
    'CallExpression|OptionalCallExpression'(nodePath) {
      if (found) return;
      const callee = nodePath.node.callee;
      if (callee.type !== 'Identifier' || callee.name !== symbol) return;

      const calleePath = nodePath.get('callee');
      for (const provAbs of provenanceAbsPaths) {
        if (resolvesToNamedImport(calleePath, { importedName: symbol, moduleAbsPath: provAbs, fromFileAbsPath })) {
          return; // a genuine cross-module import chain, not a local call
        }
      }
      found = { line: nodePath.node.loc?.start?.line ?? 0 };
    },
  });
  return found;
}

/**
 * Execute the one V1 predicate type: `no-invocation-outside-scope`.
 * @param {{type:'no-invocation-outside-scope', symbol:string, provenanceModules:string[], allowedGlobs:string[]}} predicate
 * @param {{enumerateTrackedSources?: Function, readTrackedSource?: Function, hasSymbol?: Function}} [deps]
 * @returns {{state: 'holds'|'contradicted'|'unknown', evidence: Array<{file?:string|null, line?:number, reason:string}>}}
 */
export function runPredicate(predicate, {
  enumerateTrackedSources: enumerate = enumerateTrackedSources,
  readTrackedSource = defaultReadTrackedSource,
  hasSymbol = defaultHasSymbol,
} = {}) {
  const { symbol, provenanceModules, allowedGlobs } = predicate;

  for (const mod of provenanceModules) {
    let exportsSymbol;
    try {
      exportsSymbol = hasSymbol(mod, symbol);
    } catch (err) {
      return { state: 'unknown', evidence: [{ file: mod, reason: `provenance check failed: ${safeErrorClass(err)}: ${err.message}` }] };
    }
    if (!exportsSymbol) {
      return { state: 'unknown', evidence: [{ file: mod, reason: `provenance module no longer exports ${symbol}` }] };
    }
  }

  let enumeration;
  try {
    enumeration = enumerate({ allowedGlobs });
  } catch (err) {
    return { state: 'unknown', evidence: [{ file: null, reason: `enumeration failed: ${safeErrorClass(err)}: ${err.message}` }] };
  }
  if (!enumeration.ok) {
    return { state: 'unknown', evidence: [{ file: null, reason: `enumeration failed: ${enumeration.error}` }] };
  }

  const evidence = [];
  for (const f of enumeration.unsupportedFormat) {
    evidence.push({ file: f, reason: 'unsupported module format (no CommonJS resolver) — outside allowed scope' });
  }

  const provenanceAbsPaths = provenanceModules.map((m) => path.resolve(m));

  for (const file of enumeration.analyzed) {
    let source;
    try {
      source = readTrackedSource(file);
    } catch (err) {
      evidence.push({ file, reason: `read failed: ${safeErrorClass(err)}: ${err.message}` });
      continue;
    }

    const { ast, error, recoveredErrors } = parseSource(source);
    if (error) {
      evidence.push({ file, reason: `parse failed: ${error}` });
      continue;
    }
    if (recoveredErrors.length > 0) {
      evidence.push({ file, reason: `parse recovered from a syntax error (partial tree): ${recoveredErrors[0]}` });
      continue;
    }

    let contradictedSite;
    try {
      contradictedSite = findContradictingCallSite(ast, path.resolve(file), { symbol, provenanceAbsPaths });
    } catch (err) {
      evidence.push({ file, reason: `analysis failed: ${safeErrorClass(err)}: ${err.message}` });
      continue;
    }
    if (contradictedSite) {
      return {
        state: 'contradicted',
        evidence: [{ file, line: contradictedSite.line, reason: `${symbol}(...) invoked here, outside allowedGlobs` }],
      };
    }

    // Not a cross-module contradiction — but a local call inside the
    // symbol's OWN provenance module is invisible to the check above and
    // must not silently read as a clean scan either. Doesn't return early:
    // a genuine `contradicted` found in a later file still takes priority
    // (this only ever downgrades an otherwise-`holds` result to `unknown`).
    let localSite;
    try {
      localSite = findLocalProvenanceCallSite(ast, path.resolve(file), { symbol, provenanceAbsPaths });
    } catch (err) {
      evidence.push({ file, reason: `analysis failed: ${safeErrorClass(err)}: ${err.message}` });
      continue;
    }
    if (localSite) {
      evidence.push({
        file,
        line: localSite.line,
        reason: `${symbol}(...) invoked locally inside its own provenance module — not resolvable as a cross-module import site, so this cannot be mechanically confirmed as compliant or as a contradiction; requires manual verification`,
      });
    }
  }

  if (evidence.length > 0) {
    return { state: 'unknown', evidence };
  }
  return { state: 'holds', evidence: [] };
}

// ── Orchestration ───────────────────────────────────────────────────────

/**
 * Run the full check: parse the table, diff against the registry, execute
 * checked predicates (skipping execution for any row whose parity status
 * isn't `registered` — a stale/unregistered/orphaned row's predicate must
 * never report `holds` against a premise that's no longer the live claim).
 * @param {{agentsMarkdown: string, registry: object[]} & {enumerateTrackedSources?: Function, readTrackedSource?: Function, hasSymbol?: Function, runPredicate?: Function}} opts
 * @returns {{ok: true, summary: {schemaVersion: 1, rows: object[]}, triggered: boolean} | {ok: false, error: string}}
 */
export function checkAll({
  agentsMarkdown,
  registry,
  enumerateTrackedSources: enumerate = enumerateTrackedSources,
  readTrackedSource = defaultReadTrackedSource,
  hasSymbol = defaultHasSymbol,
  runPredicate: runPred = runPredicate,
} = {}) {
  const parsed = parseAgentsDebtTable(agentsMarkdown);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const parity = checkRegistryParity(parsed.rows, registry);
  const rows = [];
  let triggered = false;

  for (const p of parity) {
    const reg = p.registryRow;
    const verificationMode = reg?.verification?.mode ?? null;
    let predicateState = null;
    let evidence = [];
    let reason = reg?.verification?.mode === 'unverifiable' ? reg.verification.reason : null;

    if (p.registryStatus !== 'registered') {
      triggered = true;
      evidence = [{ reason: `parity status: ${p.registryStatus} — predicate not executed against a non-current premise` }];
    } else if (verificationMode === 'checked') {
      const result = runPred(reg.verification.predicate, {
        enumerateTrackedSources: enumerate,
        readTrackedSource,
        hasSymbol,
      });
      predicateState = result.state;
      evidence = result.evidence;
      if (result.state !== 'holds') triggered = true;
    }
    // verificationMode === 'unverifiable': predicateState stays null,
    // reason is already set above — visible, never a silent pass.

    rows.push({
      anchor: p.anchor,
      liveFingerprint: p.liveFingerprint,
      registryStatus: p.registryStatus,
      verificationMode,
      predicateState,
      evidence,
      reason,
    });
  }

  return { ok: true, summary: { schemaVersion: 1, rows }, triggered };
}
