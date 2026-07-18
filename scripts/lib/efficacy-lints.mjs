/**
 * @fileoverview Deterministic "efficacy lints" — the GREEN ≠ REALIZED gap, Cluster A
 * (plan: docs/plans/green-not-realized.md). Three recognizers for statically-provable
 * "the marker is present but the mechanism is inert" failures:
 *   - cache-inertness   — `cache_control` on a prefix below the model's minimum cacheable length
 *   - cache-instability — `cache_control` on a block whose text derives from per-request input
 *   - canary-no-test    — a `<canaryPattern>('X')` gate with no test that forces `X` true
 *
 * NO LLM (both brainstorm models: LLMs can't reliably count tokens / trace coverage). Config-driven,
 * cross-repo-general, and HONEST: an unknown model / unparseable block / 0-scanned-files degrades to
 * `unable-to-prove` (yellow), never a fake green — the doctrine applied to our own lint.
 *
 * Detection (plan §2a, Gemini-gate HIGH — AST OR stripped-regex, NEVER both on one file):
 *   - JS/TS → `@babel/parser` AST walk (reuses the shared lib/ast.mjs). The AST distinguishes code from
 *     comments/strings structurally, so regex-literal and quote-in-comment false matches can't occur.
 *   - non-JS, OR a JS parse failure → the cruder fallback: a LANGUAGE-AWARE comment/string strip
 *     (`//`/`/* *​/` for JS-like, `#` for py/sh/yaml, `<!-- -->` for html) then regex. The fallback's
 *     one known residual is a regex literal inside parse-failed JS (documented v1 limit — the AST
 *     path is primary for JS, so this only bites a syntactically-broken JS file).
 * Detection ≠ measurement (plan §2a): the AST/strip path only LOCATES a marker; the token estimate
 * is computed on the ORIGINAL source bytes (a stripped copy would undercount).
 *
 * Result contract (audited): `runEfficacyLints` returns `{status, ruleResults, findings, coverage}`,
 * `ruleResults[rule] = {status: 'skipped'|'clean'|'unverified'|'findings', ...}`. CRUCIAL distinction:
 *   - `scannedFiles:0` (globs matched nothing → COULDN'T LOOK) → `unverified` (fail-closed when gating).
 *   - `scannedFiles>0` but `applicableSites:0` (looked, genuinely nothing) → `clean`, never a failure.
 *
 * @module scripts/lib/efficacy-lints
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { pricingKey } from './model-resolver.mjs';
import { globMatch } from './audit/glob-match.mjs';
import { classifyPath } from './sensitive-paths.mjs';
import { semanticId } from './findings.mjs';
import { parseSource, walk } from './ast.mjs';

/** Per-request-varying signatures (audited built-in, NOT user config) — a `cache_control`
 *  block whose text derives from any of these caches nothing on turn 2+. */
const DYNAMIC_PATTERNS = [
  /\bDate\.now\s*\(/, /\bnew Date\b/, /\bMath\.random\s*\(/, /\bperformance\.now\s*\(/,
  /\b(request|req|turn|message|summary|diff|nonce|uuid|timestamp)Id\b/i,
  /\b(summaryInputHash|perTurn|currentTurn|requestHash)\b/i, /\bcrypto\.randomUUID\s*\(/,
];

const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.cts', '.mts']);
const isJsLike = (rel) => JS_EXT.has(path.extname(rel).toLowerCase());

/** Built-in defaults — OFF. A repo opts in via a committed `efficacy-lints.config.json` (the
 *  two-artifact pattern, like nav-/visual-contract.json — NOT config.mjs, which is env-only). */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: false, gate: false,
  promptSourceGlobs: [], canarySourceGlobs: [], canaryTestGlobs: [],
  canaryPattern: null, canaryTestPattern: null,
  modelHint: null,
  modelMinTokens: { 'claude-opus': 1024, 'claude-sonnet': 1024, 'claude-haiku': 2048 },
});

/** Validated config shape. */
export const EfficacyLintsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  gate: z.boolean().default(false),
  promptSourceGlobs: z.array(z.string()).default([]),
  canarySourceGlobs: z.array(z.string()).default([]),
  canaryTestGlobs: z.array(z.string()).default([]),
  canaryPattern: z.string().nullable().default(null),
  canaryTestPattern: z.string().nullable().default(null),
  modelHint: z.string().nullable().default(null),
  modelMinTokens: z.record(z.string(), z.number().int().positive()).default({}),
}).strict();

/** Merge the committed `efficacy-lints.config.json` (if any) over the off-by-default base.
 *  ABSENCE (ENOENT) → defaults (off — opt-in). But a MALFORMED / unreadable / schema-invalid file
 *  THROWS (audit HIGH — a broken config must NOT silently disable the lint: that's the exact
 *  green-but-not-realized trap, where you think you're protected and aren't). The CLI surfaces the
 *  throw as a non-zero exit. */
export function loadEfficacyConfig(root) {
  const file = path.join(root, 'efficacy-lints.config.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return EfficacyLintsConfigSchema.parse({});
    throw new Error(`efficacy-lints.config.json present but unreadable (${e.code || e.message}) — refusing to silently disable the lint`);
  }
  let user;
  try { user = JSON.parse(raw); } catch (e) { throw new Error(`efficacy-lints.config.json is malformed JSON: ${e.message}`); }
  if (user === null || typeof user !== 'object' || Array.isArray(user)) {
    throw new Error(`efficacy-lints.config.json must be a JSON object (got ${user === null ? 'null' : Array.isArray(user) ? 'array' : typeof user})`);
  }
  // `_`-prefixed keys are JSON "comments" (e.g. the `_note` in the example template) — drop them
  // before the .strict() schema (which otherwise rejects them, breaking copy-the-example).
  const cleaned = Object.fromEntries(Object.entries(user).filter(([k]) => !k.startsWith('_')));
  const merged = { ...cleaned, modelMinTokens: { ...DEFAULT_CONFIG.modelMinTokens, ...(cleaned.modelMinTokens || {}) } };
  const parsed = EfficacyLintsConfigSchema.safeParse(merged);
  if (!parsed.success) throw new Error(`efficacy-lints.config.json invalid: ${parsed.error.issues[0]?.path?.join('.')} — ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export const EfficacyFindingSchema = z.object({
  id: z.string(),                  // stable semanticId (plan §2a)
  ruleId: z.enum(['cache-inertness', 'cache-instability', 'canary-no-test']),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
  confidence: z.enum(['high', 'unable-to-prove']),
  file: z.string(),
  loc: z.string(),                 // file:line
  evidence: z.string(),
  message: z.string(),
}).strict();

/** General, conservative token estimate (~chars/4). Deliberately NOT the audit-prompt-specific
 *  `estimateStablePrefixTokens` (it assumes the audit builder's shape). Approximate → callers carry
 *  the uncertainty into `confidence`. */
export function estimateTokens(text) {
  return Math.ceil((typeof text === 'string' ? text.length : 0) / 4);
}

/** Canonical model→family key (reuses model-resolver's `pricingKey`: `claude-opus`, `claude-haiku`,
 *  `gpt-5`, `gemini-pro`, …). Returns null when no known family can be derived → `unable-to-prove`. */
export function modelFamily(modelId) {
  if (typeof modelId !== 'string' || !modelId) return null;
  const key = pricingKey(modelId);
  return key && key !== modelId ? key : null;   // pricingKey echoes the id verbatim when it can't parse
}

// ── language-aware comment/string strip (regex FALLBACK only) ─────────────────

const COMMENT_STYLES = {
  js: { line: ['//'], block: [['/*', '*/']] },
  hash: { line: ['#'], block: [] },                 // py / sh / yaml / toml
  html: { line: [], block: [['<!--', '-->']] },
  css: { line: [], block: [['/*', '*/']] },
};
function stylesFor(rel) {
  const e = path.extname(rel).toLowerCase();
  if (['.py', '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml', '.rb'].includes(e)) return COMMENT_STYLES.hash;
  if (['.html', '.htm', '.vue', '.svelte', '.xml'].includes(e)) return COMMENT_STYLES.html;
  if (['.css', '.scss', '.less'].includes(e)) return COMMENT_STYLES.css;
  return COMMENT_STYLES.js;
}

/** Strip comments + string/template literals so a marker INSIDE a comment or string can't false-match.
 *  Detection only — byte offsets of real code survive (blanked to equal-length spaces so `slice(0,idx)`
 *  on the ORIGINAL still measures the true prefix). `styles` selects the comment grammar (default JS). */
export function stripForDetection(src, styles = COMMENT_STYLES.js) {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    let matched = false;
    for (const [open, close] of styles.block) {
      if (src.startsWith(open, i)) {
        const e = src.indexOf(close, i + open.length);
        const end = e < 0 ? n : e + close.length;
        out += blank(src.slice(i, end)); i = end; matched = true; break;
      }
    }
    if (matched) continue;
    for (const open of styles.line) {
      if (src.startsWith(open, i)) {
        const e = src.indexOf('\n', i); const end = e < 0 ? n : e;
        out += blank(src.slice(i, end)); i = end; matched = true; break;
      }
    }
    if (matched) continue;
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      const end = Math.min(j + 1, n);
      out += blank(src.slice(i, end)); i = end; continue;
    }
    out += c; i++;
  }
  return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// ── marker extraction (AST primary, strip+regex fallback) ────────────────────

const isKeyNamed = (prop, name) =>
  prop && (prop.type === 'ObjectProperty' || prop.type === 'Property') && prop.key &&
  ((prop.key.type === 'Identifier' && prop.key.name === name) || (prop.key.type === 'StringLiteral' && prop.key.value === name));

/** Static string value of a property (`StringLiteral` / concatenated `TemplateLiteral`), else null
 *  (a dynamic expression → can't measure → inertness emits unable-to-prove; instability uses the window). */
function staticStringOf(prop) {
  const v = prop && prop.value;
  if (!v) return null;
  if (v.type === 'StringLiteral') return v.value;
  if (v.type === 'TemplateLiteral') return v.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
  return null;
}

function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property) return callee.property.name || (callee.property.value ?? null);
  return null;
}

/** Extract markers from one file. AST for JS/TS (structural — no comment/string false matches);
 *  language-aware strip+regex otherwise OR on parse failure.
 *  @returns {{cacheBlocks: Array<{line,text,windowSrc}>, gates: Array<{key,line}>, trueKeys: Set<string>, mode}} */
function extractMarkers(src, rel, { canaryPattern, canaryTestPattern }) {
  if (isJsLike(rel)) {
    const { ast } = parseSource(src);
    if (ast) return astExtract(ast, src, { canaryPattern, canaryTestPattern });
  }
  return regexExtract(src, rel, { canaryPattern, canaryTestPattern });
}

function astExtract(ast, src, { canaryPattern, canaryTestPattern }) {
  const cacheBlocks = [];
  const gates = [];
  const trueKeys = new Set();
  walk(ast, (node) => {
    if (node.type === 'ObjectExpression' && Array.isArray(node.properties)) {
      const cc = node.properties.find((p) => isKeyNamed(p, 'cache_control'));
      if (cc) {
        const textProp = node.properties.find((p) => isKeyNamed(p, 'text') || isKeyNamed(p, 'content'));
        const start = node.start ?? 0;
        cacheBlocks.push({
          line: lineOf(src, cc.start ?? start),
          text: textProp ? staticStringOf(textProp) : null,   // null → dynamic/absent → unable-to-prove (inertness)
          windowSrc: src.slice(Math.max(0, start - 600), (node.end ?? start) + 600),
        });
      }
    }
    if (node.type === 'CallExpression') {
      const name = calleeName(node.callee);
      const arg0 = node.arguments && node.arguments[0];
      const key = arg0 && arg0.type === 'StringLiteral' ? arg0.value : null;
      if (canaryPattern && name === canaryPattern && key) gates.push({ key, line: lineOf(src, node.start ?? 0) });
      if (canaryTestPattern && name === canaryTestPattern && key &&
          node.arguments.some((a) => a.type === 'BooleanLiteral' && a.value === true)) trueKeys.add(key);
    }
  });
  return { cacheBlocks, gates, trueKeys, mode: 'ast' };
}

function regexExtract(src, rel, { canaryPattern, canaryTestPattern }) {
  const styles = stylesFor(rel);
  const stripped = stripForDetection(src, styles);
  const cacheBlocks = [];
  const ccRe = /cache_control/g;
  let m;
  while ((m = ccRe.exec(stripped)) !== null) {
    cacheBlocks.push({
      line: lineOf(src, m.index),
      text: measureCachedBlock(src, m.index),
      windowSrc: src.slice(Math.max(0, m.index - 600), m.index + 600),
    });
  }
  const gates = [];
  const trueKeys = new Set();
  if (canaryPattern) {
    const gateRe = new RegExp(`${escapeRe(canaryPattern)}\\s*\\(\\s*['"\`]([A-Za-z0-9_.-]+)['"\`]`, 'g');
    while ((m = gateRe.exec(src)) !== null) {
      if (isBlanked(stripped, m.index)) continue;                       // skip comment/string call sites
      gates.push({ key: m[1], line: lineOf(src, m.index) });
    }
  }
  if (canaryTestPattern) {
    const trueRe = new RegExp(`${escapeRe(canaryTestPattern)}\\s*\\(\\s*['"\`]([A-Za-z0-9_.-]+)['"\`][^)]*\\btrue\\b`, 'g');
    while ((m = trueRe.exec(src)) !== null) trueKeys.add(m[1]);
  }
  return { cacheBlocks, gates, trueKeys, mode: 'regex' };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex-fallback cached-block text: the nearest `text:`/`content:` string property preceding the
 *  marker within the same object (bounded to the enclosing `{`). Measured on the ORIGINAL source. */
function measureCachedBlock(src, markerIdx) {
  let depth = 0, objStart = -1;
  for (let i = markerIdx; i >= 0 && i > markerIdx - 4000; i--) {
    if (src[i] === '}') depth++;
    else if (src[i] === '{') { if (depth === 0) { objStart = i; break; } depth--; }
  }
  const region = src.slice(objStart >= 0 ? objStart : Math.max(0, markerIdx - 1200), markerIdx);
  const re = /\b(?:text|content)\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  let m, last = null;
  while ((m = re.exec(region)) !== null) last = m[2];
  return last;
}

/** True when `idx` falls in a blanked (comment/string) region of the stripped source. */
function isBlanked(stripped, idx) {
  return stripped[idx] === ' ';
}

// ── recognizers (consume extracted markers) ──────────────────────────────────

function lintCacheInertness({ markersByFile, modelMinTokens, modelHint }) {
  const findings = [];
  let cacheBreakpoints = 0;
  const family = modelHint ? modelFamily(modelHint) : null;
  const min = family && modelMinTokens[family] != null ? modelMinTokens[family] : null;
  for (const { rel, markers } of markersByFile) {
    for (const b of markers.cacheBlocks) {
      cacheBreakpoints++;
      const loc = `${rel}:${b.line}`;
      if (min == null || b.text == null) {
        findings.push(mk('cache-inertness', 'unable-to-prove', rel, loc,
          `cache_control found; ${min == null ? `unknown model family (hint: ${modelHint || 'none'})` : 'could not bound the cached prefix'} — can't prove it's effective`,
          'MEDIUM'));
        continue;
      }
      const toks = estimateTokens(b.text);
      if (toks < min) {
        findings.push(mk('cache-inertness', 'high', rel, loc,
          `cache_control on a ~${toks}-token prefix, below the ${family} minimum cacheable length (${min}) — PROVABLY INERT`,
          'HIGH'));
      }
    }
  }
  return { findings, applicableSites: cacheBreakpoints };
}

function lintCacheInstability({ markersByFile }) {
  const findings = [];
  let cacheBreakpoints = 0;
  for (const { rel, markers } of markersByFile) {
    for (const b of markers.cacheBlocks) {
      cacheBreakpoints++;
      const hit = DYNAMIC_PATTERNS.find((p) => p.test(b.windowSrc));
      if (hit) {
        findings.push(mk('cache-instability', 'high', rel, `${rel}:${b.line}`,
          `cache_control near a per-request-varying value (${hit.source}) — the prefix changes each turn, so it caches nothing on turn 2+`,
          'MEDIUM'));
      }
    }
  }
  return { findings, applicableSites: cacheBreakpoints };
}

function lintCanaryCoverage({ sourceMarkers, testMarkers }) {
  const findings = [];
  const gates = new Map();             // canaryKey → first {file, loc}
  for (const { rel, markers } of sourceMarkers) {
    for (const g of markers.gates) if (!gates.has(g.key)) gates.set(g.key, { file: rel, loc: `${rel}:${g.line}` });
  }
  const covered = new Set();
  for (const { markers } of testMarkers) for (const k of markers.trueKeys) covered.add(k);
  for (const [key, g] of gates) {
    if (!covered.has(key)) {
      findings.push(mk('canary-no-test', 'high', g.file, g.loc,
        `canary gate '${key}' has no test that forces it true — the gated branch is uncovered`, 'MEDIUM'));
    }
  }
  return { findings, applicableSites: gates.size };
}

function mk(ruleId, confidence, file, loc, message, severity) {
  // semanticId hashes category|section|detail — section=loc (file:line), detail=message → unique per site.
  const id = semanticId({ category: ruleId, section: loc, detail: message });
  return EfficacyFindingSchema.parse({ id, ruleId, confidence, file, loc, evidence: loc, message, severity });
}

/** Reduce per-file findings/coverage to a rule status. scannedFiles:0 → unverified (couldn't look);
 *  any unable-to-prove with no high findings → unverified; else clean/findings. */
function ruleStatus({ enabled, scannedFiles, findings }) {
  if (!enabled) return 'skipped';
  if (scannedFiles === 0) return 'unverified';                          // globs matched nothing → couldn't look
  if (findings.some((f) => f.confidence === 'high')) return 'findings';
  if (findings.some((f) => f.confidence === 'unable-to-prove')) return 'unverified';
  return 'clean';                                                       // looked, genuinely nothing
}

function listFiles(root, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return [];
  const out = [];
  const SKIP = new Set(['node_modules', '.git', '.audit-loop', 'dashboard', '.claude']);
  const walkDir = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).replaceAll(path.sep, '/');
      if (e.isSymbolicLink()) continue;                                // never follow symlinks
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walkDir(abs); continue; }
      // Defence-in-depth: never read a sensitive path even if a glob matches it — the
      // canonical classifier is the SSoT (sensitive-paths.mjs), not a local list.
      if (classifyPath(rel) === 'sensitive') continue;
      if (globs.some((g) => globMatch(g, rel))) out.push(rel);
    }
  };
  walkDir(root);
  return out.sort();                                                   // deterministic file order
}

/** Read + extract markers for a file list (one parse per file, shared across recognizers). */
function markersFor(root, files, patterns) {
  const out = [];
  for (const rel of files) {
    let src; try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    out.push({ rel, markers: extractMarkers(src, rel, patterns) });
  }
  return out;
}

/**
 * Run the efficacy lints. Pure I/O-bounded, no LLM, no network.
 * @param {object} a
 * @param {string} a.root
 * @param {object} a.config — EfficacyLintsConfig (see loadEfficacyConfig)
 * @param {string} [a.modelHint] — a model id for the cache-inertness min-token lookup
 * @returns {{status, ruleResults, findings, coverage}}
 */
export function runEfficacyLints({ root, config = {}, modelHint = null } = {}) {
  const {
    enabled = false, promptSourceGlobs = [], canarySourceGlobs = [], canaryTestGlobs = [],
    canaryPattern = null, canaryTestPattern = null, modelMinTokens = {},
  } = config;
  const effectiveHint = modelHint ?? config.modelHint ?? null;

  const ruleResults = {};
  const allFindings = [];
  const coverage = { scannedFiles: 0, applicableSites: 0 };

  // cache-inertness + cache-instability share the prompt-source globs (one parse per file).
  const promptFiles = enabled ? listFiles(root, promptSourceGlobs) : [];
  const promptMarkers = enabled ? markersFor(root, promptFiles, { canaryPattern: null, canaryTestPattern: null }) : [];
  for (const [ruleId, fn] of [
    ['cache-inertness', () => lintCacheInertness({ markersByFile: promptMarkers, modelMinTokens, modelHint: effectiveHint })],
    ['cache-instability', () => lintCacheInstability({ markersByFile: promptMarkers })],
  ]) {
    if (!enabled) { ruleResults[ruleId] = { status: 'skipped', coverage: { scannedFiles: 0, applicableSites: 0 }, findings: [] }; continue; }
    const r = fn();
    const status = ruleStatus({ enabled, scannedFiles: promptFiles.length, findings: r.findings });
    ruleResults[ruleId] = { status, coverage: { scannedFiles: promptFiles.length, applicableSites: r.applicableSites }, findings: r.findings, ...(promptFiles.length === 0 ? { skipReason: 'no-files-matched-promptSourceGlobs' } : {}) };
    allFindings.push(...r.findings); coverage.scannedFiles += promptFiles.length; coverage.applicableSites += r.applicableSites;
  }

  // canary-no-test
  if (!enabled || !canaryPattern) {
    ruleResults['canary-no-test'] = { status: 'skipped', coverage: { scannedFiles: 0, applicableSites: 0 }, findings: [], skipReason: !enabled ? 'disabled' : 'no-canaryPattern-configured' };
  } else {
    const sourceFiles = listFiles(root, canarySourceGlobs);
    const testFiles = listFiles(root, canaryTestGlobs);
    const sourceMarkers = markersFor(root, sourceFiles, { canaryPattern, canaryTestPattern: null });
    const testMarkers = markersFor(root, testFiles, { canaryPattern: null, canaryTestPattern });
    const r = lintCanaryCoverage({ sourceMarkers, testMarkers });
    const status = ruleStatus({ enabled, scannedFiles: sourceFiles.length, findings: r.findings });
    ruleResults['canary-no-test'] = { status, coverage: { scannedFiles: sourceFiles.length, applicableSites: r.applicableSites, testFiles: testFiles.length }, findings: r.findings, ...(sourceFiles.length === 0 ? { skipReason: 'no-files-matched-canarySourceGlobs' } : {}) };
    allFindings.push(...r.findings); coverage.scannedFiles += sourceFiles.length; coverage.applicableSites += r.applicableSites;
  }

  // Aggregate status = worst per-rule (findings > unverified > clean > skipped).
  const order = { findings: 3, unverified: 2, clean: 1, skipped: 0 };
  const status = Object.values(ruleResults).reduce((w, r) => (order[r.status] > order[w] ? r.status : w), 'skipped');
  // Stable output order (audit MED — deterministic findings) by ruleId → file → loc.
  allFindings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.file.localeCompare(b.file) || a.loc.localeCompare(b.loc));
  return { status, ruleResults, findings: allFindings, coverage };
}

export const _internals = Object.freeze({ stripForDetection, stylesFor, extractMarkers, measureCachedBlock, ruleStatus, DYNAMIC_PATTERNS, mk });
