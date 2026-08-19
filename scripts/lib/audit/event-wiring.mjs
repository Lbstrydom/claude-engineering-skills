/**
 * @fileoverview Pure event-wiring-symmetry extractor + resolver.
 *
 * No I/O, no git, no fs — mirrors orphan-introduced.mjs's purity contract.
 * Orchestration (event-wiring-corpus.mjs) owns all file reads, git access,
 * config loading and caching.
 *
 * Design: docs/plans/event-wiring-symmetry.md §2 (D1-D12, D2c, D2d).
 *
 * @module scripts/lib/audit/event-wiring
 */

export const EXTRACTOR_VERSION = 1;

/**
 * Native DOM/browser event names — a plain lowercase word is treated as
 * native iff listed here; anything kebab-case or containing ':' / '.' is
 * always custom regardless of this list (see isCustomEventName below).
 */
export const NATIVE_EVENTS = new Set([
  'click', 'input', 'change', 'submit', 'keydown', 'keyup', 'keypress',
  'focus', 'blur', 'focusin', 'focusout', 'scroll', 'scrollend', 'load',
  'domcontentloaded', 'pointerdown', 'pointerup', 'pointermove', 'pointerenter',
  'pointerleave', 'pointercancel', 'pointerover', 'pointerout',
  'touchstart', 'touchend', 'touchmove', 'touchcancel',
  'mouseover', 'mouseout', 'mousedown', 'mouseup', 'mousemove', 'mouseenter',
  'mouseleave', 'popstate', 'visibilitychange', 'resize', 'storage', 'message',
  'messageerror', 'error', 'online', 'offline', 'hashchange', 'transitionend',
  'transitionstart', 'transitionrun', 'transitioncancel',
  'animationend', 'animationstart', 'animationiteration', 'animationcancel',
  'dragstart', 'dragover', 'drop', 'dragend', 'dragenter', 'dragleave', 'drag',
  'contextmenu', 'dblclick', 'wheel', 'paste', 'copy', 'cut', 'select',
  'selectionchange', 'selectstart', 'beforeunload', 'unload', 'pagehide',
  'pageshow', 'abort', 'progress', 'loadstart', 'loadend', 'timeout',
  'readystatechange', 'canplay', 'canplaythrough', 'play', 'pause', 'ended',
  'volumechange', 'timeupdate', 'seeked', 'seeking', 'durationchange',
  'loadedmetadata', 'loadeddata', 'emptied', 'stalled', 'suspend', 'waiting',
  'ratechange', 'toggle', 'close', 'open', 'cancel', 'reset', 'invalid',
  'slotchange', 'fullscreenchange', 'fullscreenerror', 'languagechange',
  'rejectionhandled', 'unhandledrejection', 'securitypolicyviolation',
  'gesturestart', 'gesturechange', 'gestureend', 'beforeinput',
  'compositionstart', 'compositionupdate', 'compositionend',
  'controllerchange', 'statechange', 'updatefound', 'install', 'activate',
  'fetch', 'push', 'notificationclick', 'sync', 'appinstalled',
  'beforeinstallprompt', 'orientationchange', 'devicemotion',
  'deviceorientation',
]);

function isCustomEventName(name) {
  if (!name) return false;
  if (/[-:.]/.test(name)) return true;
  // DOM event types are case-sensitive; NATIVE_EVENTS is all-lowercase by
  // convention. A case-variant name (e.g. "Click") is therefore NEVER a
  // native event regardless of what it lowercases to — audit-code R1/M3 fix
  // (the prior unconditional toLowerCase() misclassified such names).
  if (name !== name.toLowerCase()) return true;
  return !NATIVE_EVENTS.has(name);
}

// ---------------------------------------------------------------------------
// Tokenising pre-pass (D7 step 1-3): comments masked to whitespace (pragmas
// harvested first, from the unmasked text); strings/templates preserved
// verbatim so grammar regexes can match literal event-name arguments.
// Output `code` is the SAME LENGTH as `source` so offsets/lines line up.
// ---------------------------------------------------------------------------
function tokenize(source) {
  const n = source.length;
  const out = new Array(n);
  const pragmas = [];
  // `literalSpans`: [start, end) of every string/template literal INCLUDING
  // its delimiter quotes. Used two ways (audit-code R1/M2,M4,M5 fix): (1) a
  // second `structural` view blanks these ranges too (comments AND literal
  // contents), so `{`/`}` characters written inside a string/template can
  // never corrupt findScopeIntervals' brace matching; (2) every grammar-regex
  // match in the main `code` view is rejected if its offset falls inside one
  // of these spans, so documentation text that happens to spell out
  // `el.dispatchEvent(new CustomEvent('x'))` inside a string is never read as
  // real code. Mirrors the two-variant (`code`/`structural`) design in
  // wine-cellar-app's own frontend-inventory-scan.mjs, which this module's
  // single-variant first draft had simplified away.
  const literalSpans = [];
  let i = 0;

  const blankRange = (start, end, target) => {
    for (let k = start; k < end; k++) target[k] = source[k] === '\n' ? '\n' : ' ';
  };
  const copyRange = (start, end, target) => {
    for (let k = start; k < end; k++) target[k] = source[k];
  };

  const structural = new Array(n);

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const start = i;
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      const text = source.slice(start, j);
      const m = text.match(/@event-consumer-external:\s*(.+)/);
      if (m) pragmas.push({ reason: m[1].trim(), span: [start, j] });
      blankRange(start, j, out);
      blankRange(start, j, structural);
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
      j = Math.min(j + 2, n);
      const text = source.slice(start, j);
      const m = text.match(/@event-consumer-external:\s*(.+)/);
      if (m) {
        const reason = m[1].trim().replace(/\*\/\s*$/, '').trim();
        pragmas.push({ reason, span: [start, j] });
      }
      blankRange(start, j, out);
      blankRange(start, j, structural);
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = i;
      let j = i + 1;
      while (j < n && source[j] !== ch) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '\n') break;
        j++;
      }
      j = Math.min(j + 1, n);
      copyRange(start, j, out);
      structural[start] = ch; structural[j - 1] = source[j - 1] === ch ? ch : ' ';
      blankRange(start + 1, j - 1, structural);
      literalSpans.push([start, j]);
      i = j;
      continue;
    }
    if (ch === '`') {
      const start = i;
      let j = i + 1;
      // Substitution regions [subStart, subEnd) — tracked with their OWN
      // brace-nesting counter (audit-code R2/M5 fix), so a `${...}` body
      // containing an object literal or a block (`${fn({a:1})}`,
      // `${(() => { return x; })()}`) doesn't end the substitution on its
      // first inner `}`. `${...}` content is real, executable code: it must
      // stay OUT of `literalSpans` (so a dispatch/listen call written there
      // is still recognised) and must be copied verbatim — not blanked —
      // into `structural` (so its own braces still participate in real
      // scope/interval tracking).
      const substitutions = [];
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '$' && source[j + 1] === '{') {
          const subStart = j;
          // audit-code R3/M1,M5 fix: lexically-aware balancing (skips
          // strings/comments/nested templates as atomic units) instead of a
          // raw brace count, which a `}` inside e.g. `${fn("a}b")}` would
          // have ended on prematurely.
          j = balanceBraces(source, j + 2);
          substitutions.push([subStart, j]);
          continue;
        }
        if (source[j] === '`') { j++; break; }
        j++;
      }
      copyRange(start, j, out);
      // Build `structural` + `literalSpans` from the literal-text segments
      // ONLY — everything between consecutive substitutions (or the
      // template's delimiters), never the substitution bodies themselves.
      let segStart = start;
      for (const [subStart, subEnd] of substitutions) {
        blankRange(segStart, subStart, structural);
        literalSpans.push([segStart, subStart]);
        // audit-code R5/M1 fix (REOPENED twice): a raw copyRange() here left
        // the substitution body's OWN comments/strings/nested-templates
        // un-masked in `structural` — a `{`/`}` inside e.g. `${fn("a}b")}`
        // would still corrupt findScopeIntervals' brace matching, even
        // though balanceBraces (above) already finds the substitution's TRUE
        // end correctly. Recursively mask the substitution body the same way
        // the top-level loop masks the whole file.
        maskStructuralRange(source, subStart, subEnd, structural);
        segStart = subEnd;
      }
      blankRange(segStart, j, structural);
      literalSpans.push([segStart, j]);
      structural[start] = '`';
      if (source[j - 1] === '`') structural[j - 1] = '`';
      i = j;
      continue;
    }
    out[i] = ch;
    structural[i] = ch;
    i++;
  }
  return { code: out.join(''), structural: structural.join(''), pragmas, literalSpans };
}

/**
 * Recursively masks a `${...}` substitution body's OWN comments and
 * string/nested-template literal content into `out` (comments -> blank,
 * string contents -> blank with quotes kept, nested-template literal-text
 * segments -> blank with backticks kept, a nested template's OWN
 * substitutions -> masked recursively the same way) — everything else (real
 * code) is copied verbatim. This is what makes `structural`'s brace matching
 * safe even for `${fn("a}b")}`-shaped input, closing the gap a plain
 * `copyRange` left open (audit-code R5/M1 fix, after two prior rounds fixed
 * only the substitution's END-FINDING, not its recursive masking).
 */
function maskStructuralRange(source, start, end, out) {
  let i = start;
  while (i < end) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      let j = i;
      while (j < end && source[j] !== '\n') j++;
      for (let k = i; k < j; k++) out[k] = source[k] === '\n' ? '\n' : ' ';
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < end && !(source[j] === '*' && source[j + 1] === '/')) j++;
      j = Math.min(j + 2, end);
      for (let k = i; k < j; k++) out[k] = source[k] === '\n' ? '\n' : ' ';
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < end && source[j] !== ch) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '\n') break;
        j++;
      }
      j = Math.min(j + 1, end);
      out[i] = ch;
      for (let k = i + 1; k < j - 1; k++) out[k] = source[k] === '\n' ? '\n' : ' ';
      if (j - 1 > i) out[j - 1] = source[j - 1] === ch ? ch : ' ';
      i = j;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      const subs = [];
      while (j < end) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '$' && source[j + 1] === '{') {
          const subStart = j;
          j = balanceBraces(source, j + 2);
          subs.push([subStart, j]);
          continue;
        }
        if (source[j] === '`') { j++; break; }
        j++;
      }
      out[i] = '`';
      let seg = i;
      for (const [subStart, subEnd] of subs) {
        for (let k = seg; k < subStart; k++) out[k] = source[k] === '\n' ? '\n' : ' ';
        maskStructuralRange(source, subStart, subEnd, out); // recurse into the nested substitution
        seg = subEnd;
      }
      for (let k = seg; k < j; k++) out[k] = source[k] === '\n' ? '\n' : ' ';
      if (source[j - 1] === '`') out[j - 1] = '`';
      i = j;
      continue;
    }
    out[i] = ch;
    i++;
  }
}

/**
 * If `source[i]` begins a string literal, a comment, or a nested template
 * literal, returns the offset immediately past it (skipping its content as
 * one atomic unit, recursively for a nested template's own substitutions).
 * Returns `null` for ordinary code, meaning the caller should just look at
 * `source[i]` itself. Factored out of the main tokenizer loop so the
 * substitution-brace balancer below can share the same character-class
 * awareness (audit-code R3/M1,M5 fix) — without it, a `{`/`}` written inside
 * a string, comment, or nested template inside a `${...}` substitution could
 * end the substitution at the wrong offset. Regex literals are a known,
 * documented residual (same right-sizing tradeoff D7 already accepts for the
 * main grammar — a `/{/`-shaped regex inside a substitution is not
 * special-cased).
 */
function skipNonCodeUnit(source, i) {
  const n = source.length;
  const ch = source[i];
  const next = source[i + 1];
  if (ch === '/' && next === '/') {
    let j = i;
    while (j < n && source[j] !== '\n') j++;
    return j;
  }
  if (ch === '/' && next === '*') {
    let j = i + 2;
    while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
    return Math.min(j + 2, n);
  }
  if (ch === "'" || ch === '"') {
    let j = i + 1;
    while (j < n && source[j] !== ch) {
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === '\n') break;
      j++;
    }
    return Math.min(j + 1, n);
  }
  if (ch === '`') {
    let j = i + 1;
    while (j < n) {
      const skip = skipNonCodeUnit(source, j);
      if (skip !== null) { j = skip; continue; }
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === '$' && source[j + 1] === '{') {
        j = balanceBraces(source, j + 2);
        continue;
      }
      if (source[j] === '`') { j++; break; }
      j++;
    }
    return j;
  }
  return null;
}

/**
 * Scans forward from `start` (the offset right after an opening `{`,
 * so depth is implicitly 1) to the offset immediately past its MATCHING
 * `}`, skipping strings/comments/nested-templates as atomic units so their
 * internal braces never perturb the count.
 */
function balanceBraces(source, start) {
  const n = source.length;
  let depth = 1;
  let j = start;
  while (j < n && depth > 0) {
    const skip = skipNonCodeUnit(source, j);
    if (skip !== null) { j = skip; continue; }
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    j++;
  }
  return j;
}

/** True iff `offset` falls strictly inside a string/template literal's span. */
function isInsideLiteral(literalSpans, offset) {
  for (const [start, end] of literalSpans) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

/**
 * Backs up from a `.dispatchEvent`/`.addEventListener` match offset (which
 * points at the `.`) to the start of its receiver expression (`window`,
 * `el`, `this.foo`, `arr[0]`) — the natural anchor for locus and pragma
 * binding. Without this, a pragma placed directly above a `receiver.dispatch
 * Event(...)` statement reads the receiver identifier itself as "intervening
 * code" and the binding silently fails (found while verifying the oracle
 * fixtures against this exact real-world shape).
 */
function backupToReceiverStart(code, dotOffset) {
  let i = dotOffset;
  while (i > 0 && /[\w$.\]]/.test(code[i - 1])) i--;
  return i;
}

/** A literal is "static" iff it's a plain string, or a template with zero `${...}` substitutions. */
const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"', '`': '`', '\n': '' };

/**
 * Decodes a JS string/template literal body to its runtime value — audit-code
 * R2/M4 fix: the original decoder handled only a fixed single-char escape
 * table, so `:` (a real, common way to spell `:` — e.g. to dodge a
 * linter or obfuscate a literal) decoded to the LITERAL text `u003a` instead
 * of `:`, silently misreporting the event name. Now covers `\uXXXX`,
 * `\u{X...}`, and `\xXX` in addition to the standard single-char table; any
 * OTHER unrecognised escape sequence is treated as undecodable (returns
 * undefined -> dynamic), never silently dropped or guessed at.
 */
function staticLiteralValue(quote, raw) {
  if (quote === '`' && /\$\{/.test(raw)) return undefined; // has substitutions — dynamic
  let undecodable = false;
  const decoded = raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, esc) => {
    if (esc[0] === 'u' && esc[1] === '{') {
      const code = parseInt(esc.slice(2, -1), 16);
      if (!Number.isFinite(code) || code > 0x10ffff) { undecodable = true; return ''; }
      return String.fromCodePoint(code);
    }
    if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc in SIMPLE_ESCAPES) return SIMPLE_ESCAPES[esc];
    // An escape not in the table is still valid JS (e.g. `\d` -> `d`) but
    // this extractor has no confident semantics for it — fail closed to
    // dynamic rather than guessing.
    undecodable = true;
    return '';
  });
  return undecodable ? undefined : decoded;
}

// ---------------------------------------------------------------------------
// Line index — offset -> 1-based line number.
// ---------------------------------------------------------------------------
function buildLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}
function lineOfOffset(lineStarts, offset) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// ---------------------------------------------------------------------------
// Enclosing-symbol resolution (D2c / D7 precedence): named function/method
// declaration -> const|let|var = (arrow|function) -> class method
// `<Class>#<method>` -> object-literal property holding a function ->
// `<module-toplevel>`. Anonymous callbacks with no named ancestor inherit
// their nearest named ancestor + an ordinal (`name#cb2`).
// ---------------------------------------------------------------------------
const DECL_PATTERNS = [
  // function foo(...) {  |  async function foo(...) {  |  function* foo(...) {
  { re: /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/g, group: 1 },
  // const|let|var foo = function|async function|(...) =>
  { re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g, group: 1 },
  // class method: <name>(...) {  — matched separately with class-name prefix, see below
];

function findScopeIntervals(code) {
  // First pass: locate every '{' and, via a stack, its matching '}'.
  const stack = [];
  const matches = new Map(); // open offset -> close offset
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') stack.push(i);
    else if (code[i] === '}') {
      const open = stack.pop();
      if (open !== undefined) matches.set(open, i);
    }
  }

  const intervals = []; // { name: string|null, start, end }

  // Named function declarations + const/let/var = function/arrow.
  for (const { re, group } of DECL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) {
      const name = m[group];
      const braceStart = code.indexOf('{', m.index + m[0].length - 1);
      if (braceStart === -1) continue;
      // Guard: an arrow with an expression body (no `{`) before the next
      // statement — bail if the found `{` looks unrelated (heuristic: within
      // 200 chars). Real code with longer param lists is rare enough here.
      if (braceStart - (m.index + m[0].length) > 400) continue;
      const end = matches.get(braceStart);
      if (end !== undefined) intervals.push({ name, start: braceStart, end });
    }
  }

  // Class methods: `<ClassName>` ... `methodName(...) {` inside the class body.
  const classRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  let cm;
  while ((cm = classRe.exec(code))) {
    const classBraceStart = code.indexOf('{', cm.index);
    if (classBraceStart === -1) continue;
    const classEnd = matches.get(classBraceStart);
    if (classEnd === undefined) continue;
    const methodRe = /(?:^|[;{}\s])(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
    methodRe.lastIndex = classBraceStart;
    let mm;
    while ((mm = methodRe.exec(code)) && mm.index < classEnd) {
      const braceStart = mm.index + mm[0].length - 1;
      const end = matches.get(braceStart);
      if (end !== undefined && ['constructor', mm[1]].includes(mm[1])) {
        intervals.push({ name: `${cm[1]}#${mm[1]}`, start: braceStart, end });
      }
    }
  }

  // Anonymous function/arrow bodies — recorded unnamed, for ordinal counting.
  const anonRe = /(?:\bfunction\s*\*?\s*\(|\([^()]*\)\s*=>|\b[A-Za-z_$][\w$]*\s*=>)/g;
  let am;
  while ((am = anonRe.exec(code))) {
    const braceStart = code.indexOf('{', am.index + am[0].length - 1);
    if (braceStart === -1 || braceStart - (am.index + am[0].length) > 200) continue;
    const end = matches.get(braceStart);
    if (end === undefined) continue;
    if (intervals.some(iv => iv.start === braceStart)) continue; // already named
    intervals.push({ name: null, start: braceStart, end });
  }

  intervals.sort((a, b) => a.start - b.start);
  return intervals;
}

function resolveEnclosingSymbol(intervals, offset, anonOrdinals) {
  // Innermost containing interval = the one with the largest start <= offset
  // and the smallest end >= offset, walking from most-to-least nested.
  let containing = intervals.filter(iv => iv.start <= offset && offset <= iv.end);
  containing.sort((a, b) => (a.end - a.start) - (b.end - b.start)); // smallest span = most nested
  for (const iv of containing) {
    if (iv.name) return iv.name;
  }
  // Nearest named ancestor of the innermost anonymous interval + ordinal.
  const innermostAnon = containing.find(iv => !iv.name);
  if (innermostAnon) {
    const ancestor = containing.find(iv => iv.name) || null;
    const key = ancestor ? ancestor.name : '<module-toplevel>';
    const ord = (anonOrdinals.get(key) || 0) + 1;
    anonOrdinals.set(key, ord);
    return `${key}#cb${ord}`;
  }
  return '<module-toplevel>';
}

// ---------------------------------------------------------------------------
// extractEventSites — the main pure extractor.
// ---------------------------------------------------------------------------

/**
 * @param {string} source
 * @param {{path: string, wrappers?: Array<{direction:'listen'|'dispatch', callee:string, eventArgIndex:number, targetArgIndex?:number}>, runtime?: 'production'|'test'|'doc-example'}} opts
 */
export function extractEventSites(source, { path, wrappers = [], runtime = 'production' } = {}) {
  const { code, structural, pragmas, literalSpans } = tokenize(source);
  const lineStarts = buildLineStarts(source);
  // Scope/brace structure is computed over `structural` (comments AND
  // literal contents blanked) so a `{`/`}` or a keyword written inside a
  // string/template can never corrupt interval detection (audit-code
  // R1/M4 fix).
  const intervals = findScopeIntervals(structural);
  const anonOrdinals = new Map();

  const dispatches = [];
  const listens = [];
  let dynamicDispatch = 0;
  let indirectDispatch = 0;
  let dynamicListen = 0;

  const localeOf = (offset) => {
    const line = lineOfOffset(lineStarts, offset);
    return { path, startLine: line, endLine: line };
  };
  const symbolAt = (offset) => resolveEnclosingSymbol(intervals, offset, anonOrdinals);

  // Track pragma-suppression: a pragma binds to the NEXT recognised dispatch
  // site in source order, within the same enclosing symbol, with no
  // intervening code (only blank lines/comments — comments are already
  // masked to whitespace in `code`, so "no intervening code" reduces to "no
  // non-whitespace code between the pragma's end and the dispatch site").
  const usedPragmas = new Set();
  function pragmaSuppressing(dispatchOffset, enclosingSymbol) {
    let best = null;
    for (let idx = 0; idx < pragmas.length; idx++) {
      if (usedPragmas.has(idx)) continue;
      const [, pEnd] = pragmas[idx].span;
      if (pEnd > dispatchOffset) continue;
      const between = code.slice(pEnd, dispatchOffset);
      if (/\S/.test(between)) continue; // intervening non-whitespace code breaks the binding
      if (symbolAt(pEnd) !== enclosingSymbol) continue;
      if (!best || pEnd > pragmas[best].span[1]) best = idx;
    }
    if (best !== null) { usedPragmas.add(best); return true; }
    return false;
  }

  // --- Named constructions pending a later dispatchEvent(varName) call ---
  // (Corrected during implementation, 2026-08-18: the plan's literal grammar
  // — "a bare `new CustomEvent` not in argument position of dispatchEvent is
  // ignored entirely" — silently drops the extremely common
  // `const evt = new CustomEvent(name); target.dispatchEvent(evt)` idiom,
  // which real wine-cellar-app source uses for 2 of the oracle's 7 events,
  // including one of the two confirmed defects. Construction alone is still
  // never evidence — a pending construction is only realised into a site
  // when a dispatchEvent(sameVar) call is later found in the SAME enclosing
  // symbol; an unreferenced construction is still correctly ignored.)
  const pendingCtorRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(CustomEvent|Event)\s*\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g;
  const pendingCtors = new Map(); // varName -> {eventName, form, symbol, offset}
  {
    let m;
    while ((m = pendingCtorRe.exec(code))) {
      if (isInsideLiteral(literalSpans, m.index)) continue; // R1/M2,M5 fix — reject matches inside string/template contents
      const [, varName, ctorKind, quote, raw] = m;
      const eventName = staticLiteralValue(quote, raw);
      if (eventName === undefined || !isCustomEventName(eventName)) continue;
      pendingCtors.set(varName, { eventName, form: ctorKind, symbol: symbolAt(m.index), offset: m.index });
    }
  }

  // --- Direct dispatch forms: dispatchEvent(new CustomEvent(<static>)|new Event(<static>)|identifier) ---
  const dispatchRe = /\.dispatchEvent\s*\(\s*(?:new\s+(CustomEvent|Event)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2|([A-Za-z_$][\w$]*))/g;
  {
    let m;
    while ((m = dispatchRe.exec(code))) {
      if (isInsideLiteral(literalSpans, m.index)) continue; // R1/M2,M5 fix
      const offset = backupToReceiverStart(code, m.index);
      const symbol = symbolAt(offset);
      if (m[1] !== undefined) {
        // dispatchEvent(new CustomEvent(<literal>) | new Event(<literal>))
        const eventName = staticLiteralValue(m[2], m[3]);
        if (eventName === undefined) { dynamicDispatch++; continue; }
        if (!isCustomEventName(eventName)) continue;
        dispatches.push({
          eventName, dispatchForm: m[1], enclosingSymbol: symbol, runtime,
          locus: localeOf(offset), pragmaSuppressed: pragmaSuppressing(offset, symbol),
        });
      } else if (m[4] !== undefined && m[4] !== 'new') {
        const pending = pendingCtors.get(m[4]);
        if (pending && pending.symbol === symbol) {
          // Anchor locus + pragma binding at the CONSTRUCTION, not the
          // dispatchEvent(var) call — that's where the event name literal
          // and any suppression comment naturally sit (found while verifying
          // this against real wine-cellar-app source, which writes pragmas
          // this way).
          dispatches.push({
            eventName: pending.eventName, dispatchForm: pending.form, enclosingSymbol: symbol,
            runtime, locus: localeOf(pending.offset), pragmaSuppressed: pragmaSuppressing(pending.offset, symbol),
          });
        } else {
          indirectDispatch++;
        }
      }
    }
  }

  // --- Direct listen form: addEventListener(<static>|identifier) ---
  const listenRe = /\.addEventListener\s*\(\s*(?:(['"`])((?:\\.|(?!\1)[^\\])*)\1|([A-Za-z_$][\w$]*))/g;
  {
    let m;
    while ((m = listenRe.exec(code))) {
      if (isInsideLiteral(literalSpans, m.index)) continue; // R1/M2,M5 fix
      const offset = backupToReceiverStart(code, m.index);
      if (m[2] !== undefined) {
        const eventName = staticLiteralValue(m[1], m[2]);
        if (eventName === undefined) { dynamicListen++; continue; }
        if (!isCustomEventName(eventName)) continue;
        listens.push({ eventName, dispatchForm: 'addEventListener', enclosingSymbol: symbolAt(offset), runtime, locus: localeOf(offset) });
      } else if (m[3] !== undefined) {
        dynamicListen++;
      }
    }
  }

  // --- Configured wrappers (D9/M2, R4/M2 dispatch-direction semantics) ---
  for (const w of wrappers) {
    const calleePattern = w.callee.startsWith('*')
      ? `[A-Za-z_$][\\w$]*${w.callee.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
      : w.callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wrapRe = new RegExp(`\\b(${calleePattern})\\s*\\(`, 'g');
    let m;
    while ((m = wrapRe.exec(code))) {
      if (isInsideLiteral(literalSpans, m.index)) continue; // R1/M2,M5 fix
      const callOffset = m.index;
      const argsStart = m.index + m[0].length;
      const args = splitTopLevelArgs(code, argsStart);
      const argTok = args[w.eventArgIndex];
      if (argTok === undefined) continue;
      const lit = matchStaticLiteral(argTok);
      const symbol = symbolAt(callOffset);
      if (w.direction === 'listen') {
        if (lit === undefined) { dynamicListen++; continue; }
        if (!isCustomEventName(lit)) continue;
        listens.push({ eventName: lit, dispatchForm: `wrapper:${w.callee}`, enclosingSymbol: symbol, runtime, locus: localeOf(callOffset) });
      } else {
        if (lit === undefined) { dynamicDispatch++; continue; }
        if (!isCustomEventName(lit)) continue;
        dispatches.push({
          eventName: lit, dispatchForm: `wrapper:${w.callee}`, enclosingSymbol: symbol, runtime,
          locus: localeOf(callOffset), pragmaSuppressed: pragmaSuppressing(callOffset, symbol),
        });
      }
    }
  }

  // --- Orphaned pragmas (D5 / Gemini round-4 G1) ---
  const orphanedPragmas = pragmas
    .map((p, idx) => ({ ...p, idx }))
    .filter(p => !usedPragmas.has(p.idx))
    .map(p => ({ locus: localeOf(p.span[0]), pragmaText: source.slice(p.span[0], p.span[1]) }));

  return { dispatches, listens, dynamicDispatch, indirectDispatch, dynamicListen, pragmas, orphanedPragmas };
}

/** Splits `f(a, b, c)`-shaped args starting right after `(`, respecting nesting. Returns raw text per arg. */
function splitTopLevelArgs(code, start) {
  const args = [];
  let depth = 0;
  let cur = '';
  let i = start;
  for (; i < code.length; i++) {
    const c = code[i];
    if (depth === 0 && c === ')') { args.push(cur); break; }
    if (depth === 0 && c === ',') { args.push(cur); cur = ''; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    cur += c;
  }
  return args.map(a => a.trim());
}

function matchStaticLiteral(tok) {
  const m = tok.match(/^(['"`])((?:\\.|(?!\1)[^\\])*)\1$/);
  if (!m) return undefined;
  return staticLiteralValue(m[1], m[2]);
}

// ---------------------------------------------------------------------------
// diffSites — D2/D2b multiset differences over one before/after pair.
// Cancellation signature (D2 rule 4, widened by R4/H2, narrowed by Gemini
// round-2 G1): {eventName, dispatchForm, runtime, pragmaSuppressed} —
// deliberately NOT enclosingSymbol, NOT line number.
// ---------------------------------------------------------------------------
function dispatchSignature(s) {
  return [s.eventName, s.dispatchForm, s.runtime, s.pragmaSuppressed].join(String.fromCharCode(31));
}
function listenSignature(s) {
  return [s.eventName, s.runtime, s.enclosingSymbol].join(String.fromCharCode(31));
}

function multisetDiff(beforeSigs, afterSigs) {
  const beforeCounts = new Map();
  for (const s of beforeSigs) beforeCounts.set(s, (beforeCounts.get(s) || 0) + 1);
  const added = [];
  for (const s of afterSigs) {
    const remaining = beforeCounts.get(s) || 0;
    if (remaining > 0) beforeCounts.set(s, remaining - 1);
    else added.push(s);
  }
  return added;
}

/**
 * @param {{dispatches: object[], listens: object[]}} before
 * @param {{dispatches: object[], listens: object[]}} after
 */
export function diffSites(before, after) {
  const beforeDispatchSigs = before.dispatches.map(dispatchSignature);
  const afterDispatchSigs = after.dispatches.map(dispatchSignature);
  const addedSigSet = new Set(multisetDiff(beforeDispatchSigs, afterDispatchSigs));
  // Multiset semantics for output too: walk `after` in order, take each site
  // whose signature is in the added set, consuming one occurrence per match
  // so a genuinely duplicated (non-added) site isn't over-reported.
  const addedRemaining = new Map();
  for (const s of addedSigSet) addedRemaining.set(s, (addedRemaining.get(s) || 0) + multisetCount(afterDispatchSigs, beforeDispatchSigs, s));
  const addedDispatches = [];
  for (const site of after.dispatches) {
    const sig = dispatchSignature(site);
    const remaining = addedRemaining.get(sig) || 0;
    if (remaining > 0) { addedDispatches.push(site); addedRemaining.set(sig, remaining - 1); }
  }

  const beforeListenSigs = before.listens.map(listenSignature);
  const afterListenSigs = after.listens.map(listenSignature);
  const removedSigSet = new Set(multisetDiff(afterListenSigs, beforeListenSigs)); // present-before, absent-after
  const removedRemaining = new Map();
  for (const s of removedSigSet) removedRemaining.set(s, (removedRemaining.get(s) || 0) + multisetCount(beforeListenSigs, afterListenSigs, s));
  const removedListeners = [];
  for (const site of before.listens) {
    const sig = listenSignature(site);
    const remaining = removedRemaining.get(sig) || 0;
    if (remaining > 0) { removedListeners.push(site); removedRemaining.set(sig, remaining - 1); }
  }

  return { addedDispatches, removedListeners };
}

function multisetCount(fromSigs, subtractSigs, target) {
  let count = 0;
  for (const s of fromSigs) if (s === target) count++;
  for (const s of subtractSigs) if (s === target) count--;
  return Math.max(0, count);
}

// ---------------------------------------------------------------------------
// resolveSymmetry — D2/D2b/D8/D9/D10/D12. Only PRODUCTION sites are
// candidates (D2 rule 7); test/doc-example sites are counted separately.
// ---------------------------------------------------------------------------

/**
 * @param {{corpus: {dispatches: object[], listens: object[]}, addedDispatches: object[], removedListeners: object[]}} args
 */
export function resolveSymmetry({ corpus, addedDispatches, removedListeners }) {
  const findings = [];
  const coverage = [];
  const counters = { testDispatchSites: 0, indirectDispatchSites: 0, dynamicListenSites: 0 };

  const productionListensByName = new Map();
  const testListensByName = new Map();
  for (const l of corpus.listens) {
    const map = l.runtime === 'production' ? productionListensByName : (l.runtime === 'test' ? testListensByName : null);
    if (!map) continue;
    if (!map.has(l.eventName)) map.set(l.eventName, []);
    map.get(l.eventName).push(l);
  }
  const productionDispatchesByName = new Map();
  for (const d of corpus.dispatches) {
    if (d.runtime !== 'production') continue;
    if (!productionDispatchesByName.has(d.eventName)) productionDispatchesByName.set(d.eventName, []);
    productionDispatchesByName.get(d.eventName).push(d);
  }

  const byEvent = new Map(); // eventName -> { triggers:Set, addedSites:[], removedListenerLocus }

  for (const site of addedDispatches) {
    if (site.runtime !== 'production') { counters.testDispatchSites++; continue; }
    if (!byEvent.has(site.eventName)) byEvent.set(site.eventName, { triggers: new Set(), addedSites: [] });
    const e = byEvent.get(site.eventName);
    e.triggers.add('added-dispatch');
    e.addedSites.push(site);
  }
  for (const site of removedListeners) {
    if (site.runtime !== 'production') continue; // deleting a test listener is not a trigger
    const stillDispatched = (productionDispatchesByName.get(site.eventName) || []).length > 0;
    if (!stillDispatched) continue; // deleted the listener AND the last dispatch -> nothing fired
    if (!byEvent.has(site.eventName)) byEvent.set(site.eventName, { triggers: new Set(), addedSites: [] });
    const e = byEvent.get(site.eventName);
    e.triggers.add('removed-listener');
    e.removedListenerLocus = site.locus;
  }

  for (const [eventName, e] of byEvent) {
    const productionListeners = productionListensByName.get(eventName) || [];
    const testListeners = testListensByName.get(eventName) || [];

    if (productionListeners.length > 0) continue; // resolved — no finding

    const allDispatchSites = productionDispatchesByName.get(eventName) || e.addedSites;
    const dispatchLoci = allDispatchSites.map(s => s.locus).sort((a, b) =>
      a.path === b.path ? a.startLine - b.startLine : a.path.localeCompare(b.path));
    const primaryLocus = dispatchLoci[0] || e.addedSites[0]?.locus;
    const totalDispatchSites = allDispatchSites.length;
    const pragmaSuppressedSites = allDispatchSites.filter(s => s.pragmaSuppressed).length;

    // `class: 'dispatch-only'` is explicit, not merely implied by the guard
    // above (audit-code R1/H1 fix) — a future edit that pushed to `coverage`
    // from a different branch could otherwise silently break the "presence
    // here means dispatch-only" invariant the Phase-0 oracle relies on, with
    // no field on the record itself to catch it.
    coverage.push({ eventName, class: 'dispatch-only', totalDispatchSites, pragmaSuppressedSites });

    if (pragmaSuppressedSites === totalDispatchSites && totalDispatchSites > 0) continue; // fully suppressed

    const triggers = [...e.triggers].sort();
    const severity = testListeners.length > 0 ? 'LOW' : 'MEDIUM';
    const rationale = testListeners.length > 0
      ? `no production listener found; contract exercised only by tests (${testListeners.length} test listener(s))`
      : 'no listener found for this event anywhere in the repo';

    findings.push({
      kind: 'event-wiring-symmetry',
      eventName,
      triggers,
      severity,
      enforcement: 'advisory',
      evidence: 'name-presence',
      locus: primaryLocus,
      relatedLoci: dispatchLoci,
      removedListenerLocus: e.removedListenerLocus,
      rationale,
      testOnlyConsumer: testListeners.length > 0,
    });
  }

  return { findings, coverage, counters };
}

/**
 * @param {{dispatches: object[], listens: object[]}} corpus
 * @param {string} eventName
 */
export function lookupEventStatus(corpus, eventName) {
  const dispatches = corpus.dispatches.filter(d => d.eventName === eventName && d.runtime === 'production');
  const listens = corpus.listens.filter(l => l.eventName === eventName && l.runtime === 'production');
  return {
    hasProductionListener: listens.length > 0,
    hasAnyDispatch: dispatches.length > 0,
    totalDispatchSites: dispatches.length,
    pragmaSuppressedSites: dispatches.filter(d => d.pragmaSuppressed).length,
  };
}
