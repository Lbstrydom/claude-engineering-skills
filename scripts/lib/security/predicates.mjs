/**
 * The three built-in predicate kinds (D3). Pure functions —
 * `(finding, config) => {bucket, reason} | null`.
 *
 * Plan: docs/plans/sast-triage-routing.md — Phase 2.
 *
 * Every predicate can only ever DEMOTE. Every unsupported, ambiguous,
 * truncated, or unreadable case returns **no match**, which routes the finding
 * to `A` for a human. A predicate that cannot parse what it was asked about
 * must not pretend to have evaluated it.
 */
import { globMatch } from '../visual/changed-scope.mjs';

export const PREDICATE_KINDS = Object.freeze([
  'path-scope',
  'sink-mismatch',
  'sanitizer-wrapped',
]);

// ---------------------------------------------------------------------------
// D3a2 — comment + string-literal stripping
// ---------------------------------------------------------------------------

/**
 * Mask comment bodies and string-literal *contents* while preserving offsets,
 * line structure, and template `${…}` interpolations (which are code, not
 * literal content).
 *
 * This exists because of a field incident (D3a2): a consumer's `innerHTML`
 * scanner index-scanned for the first backtick in a 60-line window, an
 * explanatory code comment quoting an identifier in backticks won the scan, and
 * the real unescaped sink vanished from detection entirely — while the
 * allowlist reported the entry as *stale*, i.e. as debt paid down. The failure
 * was invisible because it failed open and looked like success.
 *
 * Callers pass source from **line 1**, not from the window start: whether the
 * window opens inside a block comment or a template is undecidable from the
 * window alone, and the bounded read already has the prefix in hand.
 *
 * @param {string} text source from line 1 through the last line needed
 * @returns {{masked: string, terminated: boolean}} `terminated:false` means the
 *   text ends inside a block comment or template — ambiguous, so callers must
 *   return no match rather than analyse a half-open construct.
 */
export function maskCommentsAndStrings(text) {
  const src = String(text);
  const out = new Array(src.length);
  /** @type {Array<{kind:'tpl'|'interp', braces:number}>} */
  const stack = [];
  let state = 'code';
  let i = 0;
  let lastCode = ''; // last significant code char, for the regex/division call

  const put = (idx, ch) => { out[idx] = ch; };
  const blank = (idx) => { out[idx] = src[idx] === '\n' ? '\n' : ' '; };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line-comment'; blank(i); blank(i + 1); i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block-comment'; blank(i); blank(i + 1); i += 2; continue; }
      if (ch === '"') { state = 'dq'; put(i, ch); i++; continue; }
      if (ch === "'") { state = 'sq'; put(i, ch); i++; continue; }
      if (ch === '`') { stack.push({ kind: 'tpl', braces: 0 }); state = 'tpl'; put(i, ch); i++; continue; }
      if (ch === '/' && isRegexStart(lastCode)) {
        const end = skipRegex(src, i);
        if (end > i) { for (let k = i; k < end; k++) blank(k); i = end; continue; }
      }
      // Interpolation bookkeeping: a `}` that closes the interpolation returns
      // us to the enclosing template rather than to plain code.
      const top = stack[stack.length - 1];
      if (top && top.kind === 'interp') {
        if (ch === '{') top.braces++;
        else if (ch === '}') {
          if (top.braces === 0) { stack.pop(); state = 'tpl'; put(i, ch); i++; lastCode = '}'; continue; }
          top.braces--;
        }
      }
      put(i, ch);
      if (!/\s/.test(ch)) lastCode = ch;
      i++;
      continue;
    }

    if (state === 'line-comment') {
      if (ch === '\n') { state = 'code'; put(i, ch); i++; continue; }
      blank(i); i++; continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = 'code'; blank(i); blank(i + 1); i += 2; continue; }
      blank(i); i++; continue;
    }

    if (state === 'sq' || state === 'dq') {
      const quote = state === 'sq' ? "'" : '"';
      if (ch === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (ch === quote) { state = 'code'; put(i, ch); lastCode = quote; i++; continue; }
      // A newline inside a non-template quote is a syntax error in JS; treat it
      // as the literal ending so one malformed line cannot swallow the file.
      if (ch === '\n') { state = 'code'; put(i, ch); i++; continue; }
      blank(i); i++; continue;
    }

    if (state === 'tpl') {
      if (ch === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (ch === '$' && next === '{') {
        stack.push({ kind: 'interp', braces: 0 });
        state = 'code';
        put(i, '$'); put(i + 1, '{');
        lastCode = '{';
        i += 2;
        continue;
      }
      if (ch === '`') { stack.pop(); state = stackTopIsInterp(stack) ? 'code' : (stack.length ? 'tpl' : 'code'); put(i, ch); lastCode = '`'; i++; continue; }
      blank(i); i++; continue;
    }

    /* c8 ignore next 2 -- unreachable: the state set above is closed */
    blank(i); i++;
  }

  const terminated = state !== 'block-comment' && state !== 'tpl' && stack.length === 0;
  return { masked: out.join(''), terminated };
}

function stackTopIsInterp(stack) {
  const top = stack[stack.length - 1];
  return !!top && top.kind === 'interp';
}

function isRegexStart(lastCode) {
  return lastCode === '' || '(,=:[!&|?{};+-*%~^<>'.includes(lastCode);
}

/** Return the index just past a regex literal starting at `start`, or -1. */
function skipRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') return -1;      // regex literals cannot span lines
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags
      return i;
    }
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const CHAIN_RE = new RegExp(`(${IDENT}(?:\\.${IDENT})*)$`);

/**
 * The clamped sink window (D3a): the region expanded to whole lines and capped
 * at `maxSinkLines`. A region that would EXCEED the clamp yields no window —
 * silently truncating it would let the predicate demote a finding on the basis
 * of source it never saw.
 */
export function sinkWindow(finding, maxSinkLines) {
  const region = finding?.sinkLocation?.region;
  const lines = finding?.sourceLines;
  if (!region || !Array.isArray(lines)) return null;
  const startLine = region.startLine;
  const endLine = Math.max(region.endLine ?? startLine, startLine);
  if (endLine - startLine + 1 > maxSinkLines) return null;
  if (startLine < 1 || endLine > lines.length) return null;
  return { startLine, endLine };
}

/** Offsets of a 1-indexed inclusive line range within the joined source. */
function rangeOffsets(lines, startLine, endLine) {
  let offset = 0;
  for (let n = 1; n < startLine; n++) offset += lines[n - 1].length + 1;
  let length = 0;
  for (let n = startLine; n <= endLine; n++) length += lines[n - 1].length + 1;
  return { start: offset, end: offset + length - 1 };
}

/** Mask the whole prefix, then hand back just the window's masked text. */
function maskedWindow(finding, window) {
  const lines = finding.sourceLines;
  const { masked, terminated } = maskCommentsAndStrings(lines.join('\n'));
  if (!terminated) return null; // D3a2: ambiguous stripping → no match
  const { start, end } = rangeOffsets(lines, window.startLine, window.endLine);
  return { text: masked.slice(start, end), offset: start, full: masked };
}

// ---------------------------------------------------------------------------
// 1. path-scope
// ---------------------------------------------------------------------------

/**
 * Two independent signals that must AGREE (§2b), not a glob alone:
 *
 *  - the producer's own test-context classification, and
 *  - the canonicalized repo-relative path matching a declared non-reachable glob.
 *
 * Measured on the real corpus: 95 of 240 findings carry the producer signal;
 * for 3 of them the producer was RIGHT and our glob was wrong (genuine test
 * files that simply do not live under `tests/`). Requiring agreement costs
 * those 3 a human glance and buys two detectors that fail differently, rather
 * than one inference we made up.
 *
 * Note the asymmetry with the other two predicates: this one reads the
 * **primary** location — "which file is this finding reported in" — while the
 * source-reading predicates read `sinkLocation`.
 */
export function predicateProducerTestSignal(ruleId) {
  // SARIF has no standard field for "the producer thinks this is test code";
  // Snyk encodes it as a rule-id suffix. A producer without the signal simply
  // never satisfies this half, so `path-scope` never demotes — inert in the
  // SAFE direction, which is the correct degradation for an unknown producer.
  return /\/test$/.test(String(ruleId || ''));
}

export function pathScope(finding, config) {
  const globs = config?.pathScope?.nonReachableGlobs || [];
  if (globs.length === 0) return null;

  const p = finding?.location?.repoRelativePath;
  if (typeof p !== 'string' || p.length === 0) return null;

  const producerSaysTest = predicateProducerTestSignal(finding.ruleId);
  const globSaysUnreachable = globs.some((g) => globMatch(g, p));

  if (producerSaysTest && globSaysUnreachable) {
    return { bucket: 'D', reason: 'path-scope:producer-and-glob-agree' };
  }
  if (producerSaysTest !== globSaysUnreachable) {
    return {
      bucket: null,
      reason: producerSaysTest
        ? 'path-scope:disagree-producer-only'
        : 'path-scope:disagree-glob-only',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. sink-mismatch
// ---------------------------------------------------------------------------

/**
 * Resolve the callee name of the call expression the region *identifies*
 * (§7c constraint 1). Three accepted forms, because Snyk and Semgrep anchor
 * the region differently and an earlier draft's arguments-only rule would have
 * missed the very `caches.match` ReDoS mislabel this predicate exists for:
 *
 *   1. the region IS the call expression — `caches.match(req)`
 *   2. the region IS the callee        — `caches.match` / `match`
 *   3. the region is ENCLOSED BY the call's argument list
 *
 * Returns the dotted chain and its last segment; either may match the declared
 * `sinkFunction`. None of the three → null.
 */
export function resolveSinkFunction(maskedText, regionText, regionStart) {
  const text = String(regionText).trim();

  const asCall = new RegExp(`^(${IDENT}(?:\\.${IDENT})*)\\s*\\(`).exec(text);
  if (asCall) return splitCallee(asCall[1]);

  // Prefer the caller-supplied offset: `indexOf` would happily locate an
  // EARLIER occurrence of the same token and resolve the wrong call.
  const idx =
    typeof regionStart === 'number' && regionStart >= 0
      ? regionStart
      : maskedText.indexOf(text);
  if (idx < 0) return null;

  // Form 2: the region is the callee — only if a call actually follows it.
  // Falling through (rather than returning null) is load-bearing: `req` in
  // `caches.match(req)` looks exactly like a callee, and form 3 is the one
  // that resolves it.
  if (new RegExp(`^${IDENT}(?:\\.${IDENT})*$`).test(text)) {
    const after = maskedText.slice(idx + text.length);
    if (/^\s*\(/.test(after)) return splitCallee(text);
  }

  // Form 3: walk back from the region start to the nearest unmatched `(`.
  let depth = 0;
  for (let k = idx - 1; k >= 0; k--) {
    const c = maskedText[k];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) {
        const chain = CHAIN_RE.exec(maskedText.slice(0, k).trimEnd());
        return chain ? splitCallee(chain[1]) : null;
      }
      depth--;
    }
  }
  return null;
}

function splitCallee(chain) {
  const parts = chain.split('.');
  return { chain, name: parts[parts.length - 1] };
}

export function sinkMismatch(finding, config, bounds) {
  const pairs = config?.sinkMismatch?.pairs || [];
  if (pairs.length === 0) return null;

  const window = sinkWindow(finding, bounds.maxSinkLines);
  if (!window) return null;
  const masked = maskedWindow(finding, window);
  if (!masked) return null;

  const region = finding.sinkLocation.region;
  const regionText = extractRegionText(finding.sourceLines, region);
  if (!regionText) return null;

  // Absolute offset of the region within the window, so form 3 walks back from
  // the RIGHT occurrence rather than the first textual match.
  const regionAbs =
    rangeOffsets(finding.sourceLines, region.startLine, region.startLine).start +
    (region.startColumn ? region.startColumn - 1 : 0);
  const regionStart = regionAbs - masked.offset;

  const callee = resolveSinkFunction(masked.text, regionText, regionStart);
  if (!callee) return null;

  const hit = pairs.find(
    (p) =>
      p.ruleId === finding.ruleId &&
      (p.sinkFunction === callee.chain || p.sinkFunction === callee.name),
  );
  if (!hit) return null;
  return { bucket: 'D', reason: `sink-mismatch:${hit.ruleId}/${hit.sinkFunction}` };
}

function extractRegionText(lines, region) {
  if (!region) return null;
  const { startLine, endLine, startColumn, endColumn } = region;
  if (startLine < 1 || endLine > lines.length) return null;
  if (startLine === endLine) {
    const line = lines[startLine - 1];
    const a = startColumn ? startColumn - 1 : 0;
    const b = endColumn ? endColumn - 1 : line.length;
    return line.slice(a, Math.max(a, b));
  }
  const parts = [lines[startLine - 1].slice(startColumn ? startColumn - 1 : 0)];
  for (let n = startLine + 1; n < endLine; n++) parts.push(lines[n - 1]);
  parts.push(lines[endLine - 1].slice(0, endColumn ? endColumn - 1 : undefined));
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 3. sanitizer-wrapped
// ---------------------------------------------------------------------------

/**
 * D3a. Every interpolation in the sink region's single candidate expression
 * must be wrapped by a declared sanitizer → `C` (never `D`: this is the
 * predicate that can be wrong in the dangerous direction, so it never reaches
 * the bottom bucket).
 *
 * Supported sink forms are closed: one template literal, or one
 * `+`-concatenation. §7c constraint 2 — more than one candidate expression in
 * the clamped window returns **no match** rather than choosing between them.
 */
export function sanitizerWrapped(finding, config, bounds) {
  const sanitizers = config?.sanitizerWrapped?.sanitizers || [];
  if (sanitizers.length === 0) return null;

  const window = sinkWindow(finding, bounds.maxSinkLines);
  if (!window) return null;
  const masked = maskedWindow(finding, window);
  if (!masked) return null;

  const templates = findTemplateLiterals(masked.text);
  if (templates.length === 0) return null;
  if (templates.length > 1) return null; // ambiguity → A, never a demotion

  const interps = extractInterpolations(templates[0]);
  if (interps === null) return null;       // nesting depth > 1 → unsupported
  if (interps.length === 0) return null;   // nothing to sanitize cannot explain
                                           // the finding; refuse to demote

  for (const expr of interps) {
    if (!outermostCallIsSanitizer(expr, sanitizers)) return null;
  }
  return {
    bucket: 'C',
    reason: `sanitizer-wrapped:${interps.length}-interpolation(s)`,
  };
}

/** Template-literal spans in already-masked text (backticks survive masking). */
function findTemplateLiterals(masked) {
  const spans = [];
  let i = 0;
  while (i < masked.length) {
    if (masked[i] === '`') {
      const start = i;
      let depth = 0;
      i++;
      while (i < masked.length) {
        if (masked[i] === '$' && masked[i + 1] === '{') { depth++; i += 2; continue; }
        if (masked[i] === '}' && depth > 0) { depth--; i++; continue; }
        if (masked[i] === '`' && depth === 0) { i++; break; }
        i++;
      }
      if (masked[i - 1] === '`' && i - 1 > start) spans.push(masked.slice(start, i));
      else return spans; // unterminated within the window
    } else i++;
  }
  return spans;
}

/** `${…}` bodies. Returns null when nesting depth exceeds 1 (unsupported). */
function extractInterpolations(template) {
  const out = [];
  let i = 0;
  while (i < template.length) {
    if (template[i] === '$' && template[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      let sawNested = false;
      while (j < template.length && depth > 0) {
        if (template[j] === '$' && template[j + 1] === '{') { depth++; sawNested = true; j += 2; continue; }
        if (template[j] === '{') depth++;
        else if (template[j] === '}') depth--;
        j++;
      }
      if (depth !== 0) return null;
      if (sawNested) return null;
      out.push(template.slice(i + 2, j - 1).trim());
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * An interpolation matches iff its OUTERMOST call expression's callee name is
 * declared. Bare identifiers, member expressions not in the list, aliases, and
 * re-assignments deliberately do NOT match — the predicate proves a wrapper is
 * present, it does not chase what a name might be bound to.
 */
export function outermostCallIsSanitizer(expr, sanitizers) {
  const text = String(expr).trim();
  const m = new RegExp(`^(${IDENT}(?:\\.${IDENT})*)\\s*\\(`).exec(text);
  if (!m) return false;
  // The outermost call must span the whole expression: `esc(a) + b` is not a
  // sanitized interpolation, it is a concatenation with a raw operand.
  if (!closesAtEnd(text, m[0].length - 1)) return false;
  const { chain, name } = splitCallee(m[1]);
  return sanitizers.includes(chain) || sanitizers.includes(name);
}

function closesAtEnd(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i === text.length - 1;
    }
  }
  return false;
}

export const PREDICATES = Object.freeze({
  'path-scope': pathScope,
  'sink-mismatch': sinkMismatch,
  'sanitizer-wrapped': sanitizerWrapped,
});
