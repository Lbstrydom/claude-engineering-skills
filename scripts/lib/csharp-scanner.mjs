/**
 * @fileoverview C# structural scanner — declaration boundaries for chunking.
 *
 * Deliberately NOT a parser and NOT Roslyn. It answers one question for
 * `code-analysis.mjs`'s chunker: on which lines does a type or member
 * declaration begin? The design choices, each forced by a real defect class:
 *
 * ## A lexer first, structure second
 *
 * Counting braces on raw text is wrong for C#: `'{'`, `"{"`, `@"{"`, `$"{x}"`,
 * `"""{"""`, comments and `#if` lines all carry braces that are not scopes.
 * `maskLine` is a small state machine that erases every string / char /
 * comment / directive and every interpolation hole before structure sees the
 * text. It is parameterised by raw-string quote count (>= 3) and interpolation
 * dollar count (>= 0), and handles both interpolated-verbatim prefix orders
 * (`$@"…"`, `@$"…"`). What is left is only code that can open or close a scope.
 *
 * ## A scope stack, not absolute brace depth
 *
 * Depth cannot tell a member from a local function: in a file-scoped namespace
 * a method body sits at the same depth a nested type's members do. Each `{`
 * instead pushes the kind decided by the declaration pending when it opens —
 * `ns`, `type`, or `code` (a method/accessor/lambda/initializer body) — and
 * boundaries fire only when the innermost scope is the compilation unit, a
 * namespace or a type. A local function is never a boundary at any depth.
 *
 * ## Degrade, never guess
 *
 * A file that ends with an open string, comment, hole or unbalanced braces
 * (a `#if` that legitimately splits a brace pair, malformed input, a diff
 * fragment) returns `{state:'degraded', boundaries: []}`: the chunker then
 * falls back to whole-file line chunks. A valid file with no declarations
 * (top-level statements) is `{state:'completed', boundaries: []}` — the two
 * must stay distinguishable, because a coverage report that cannot tell them
 * apart would call a lexer bailout "no boundaries".
 *
 * @module scripts/lib/csharp-scanner
 */

const MODS = '(?:public|private|protected|internal|static|async|override|virtual|abstract|sealed|partial|readonly|unsafe|extern|new|required|file|const|volatile|ref)';
const TYPE_DECL = new RegExp(`^\\s*(?:${MODS}\\s+)*(?:class|struct|record(?:\\s+(?:class|struct))?|interface|enum)\\s+[A-Za-z_@]`);
const NAMESPACE_BLOCK = /^\s*namespace\s+[\w.]+\s*$|^\s*namespace\s+[\w.]+\s*\{/;
const NAMESPACE_FILE = /^\s*namespace\s+[\w.]+\s*;/;
// A member at type scope: optional modifiers, a return type / name token run, then `(`.
// `=` and `=>` are not token characters, so a field initialiser or expression-bodied
// PROPERTY (`int P => Foo();`) does not match; a method with `=>` after its parameter
// list does, because `(` comes first.
const MEMBER_DECL = new RegExp(
  `^\\s*(?:${MODS}\\s+)*(?:\\([^()]*\\)\\s+(?=[A-Za-z_@])|(?!(?:if|for|foreach|while|switch|using|lock|return|else|catch|when|new|throw|await|yield|var)\\b))`
  + '[A-Za-z_@][\\w<>\\[\\],.?@]*(?:\\s+[A-Za-z_@][\\w<>\\[\\],.?@]*)*\\s*(?:<[^>()]*>)?\\s*\\(',
);
// Operators and conversions: the operator symbol (`+`, `==`, `<`) is not a token character above.
const OPERATOR_DECL = new RegExp(
  `^\\s*(?:${MODS}\\s+)*(?:[\\w<>\\[\\],.?@]+\\s+operator\\s*[^\\s\\w(]+|(?:implicit|explicit)\\s+operator\\s+[\\w<>\\[\\],.?@]+)\\s*\\(`,
);
const ATTR_PREFIX = /^\s*\[[^\]]*\]\s*/;

/**
 * Erase everything that is not scope-shaping code from one line. Mutates `st`,
 * the lexer context stack that persists across lines (multi-line strings,
 * block comments, interpolation holes).
 *
 * @param {string} line
 * @param {Array<object>} st
 * @returns {string} masked code (only what is visible at the top level)
 */
export function maskLine(line, st) {
  let out = '';
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line[i];
    const t = st[st.length - 1];

    if (t && t.t === 'block') {
      if (c === '*' && line[i + 1] === '/') { st.pop(); i += 2; } else i++;
      continue;
    }

    if (t && t.t === 'str') {
      if (t.raw) {
        if (c === '"') {
          let r = 0;
          while (line[i + r] === '"') r++;
          if (r >= t.raw) st.pop();
          i += r;
          continue;
        }
        if (t.dollars > 0 && c === '{') {
          let r = 0;
          while (line[i + r] === '{') r++;
          if (r >= t.dollars) st.push({ t: 'hole', depth: 0, dollars: t.dollars });
          i += r;
          continue;
        }
        i++;
        continue;
      }
      if (t.verbatim) {
        if (c === '"') {
          if (line[i + 1] === '"') { i += 2; continue; }
          st.pop(); i++; continue;
        }
      } else {
        if (c === '\\') { i += 2; continue; }
        if (c === '"') { st.pop(); i++; continue; }
      }
      if (t.dollars > 0) {
        if (c === '{') {
          if (line[i + 1] === '{') { i += 2; continue; }
          st.push({ t: 'hole', depth: 0, dollars: 1 });
          i++;
          continue;
        }
        if (c === '}' && line[i + 1] === '}') { i += 2; continue; }
      }
      i++;
      continue;
    }

    // ── code mode: top level (t undefined) or inside an interpolation hole ──
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '/' && line[i + 1] === '*') { st.push({ t: 'block' }); i += 2; continue; }
    if (c === '#' && !t && out.trim() === '') break; // preprocessor directive line
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\') j += 2;
        else if (line[j] === "'") { j++; break; }
        else j++;
      }
      i = j;
      continue;
    }
    if (c === '"') {
      let k = i - 1;
      let dollars = 0;
      let verbatim = false;
      while (k >= 0 && (line[k] === '$' || line[k] === '@')) {
        if (line[k] === '$') dollars++; else verbatim = true;
        k--;
      }
      let r = 0;
      while (line[i + r] === '"') r++;
      if (!verbatim && r >= 3) {
        st.push({ t: 'str', raw: r, dollars, verbatim: false });
        i += r;
      } else {
        st.push({ t: 'str', raw: 0, dollars, verbatim });
        i++;
      }
      continue;
    }
    if (t && t.t === 'hole') {
      if (c === '{') { t.depth++; i++; continue; }
      if (c === '}') {
        if (t.depth > 0) { t.depth--; i++; continue; }
        if (t.dollars > 1) {
          let r = 0;
          while (line[i + r] === '}') r++;
          if (r >= t.dollars) st.pop();
          i += r;
          continue;
        }
        st.pop();
        i++;
        continue;
      }
      i++;
      continue;
    }
    out += c;
    i++;
  }
  // A regular (single-line) string cannot span a line break: an unterminated one
  // ends here, so one stray quote cannot mask the rest of the file.
  const top = st[st.length - 1];
  if (top && top.t === 'str' && !top.raw && !top.verbatim) st.pop();
  return out;
}

/**
 * Scan C# source lines for declaration boundaries.
 *
 * @param {string[]} lines
 * @returns {{state: 'completed'|'degraded', boundaries: number[], reason: string|null}}
 *   `boundaries` are 0-indexed line numbers, strictly ascending and unique.
 */
export function scanCsharpBoundaries(lines) {
  const boundaries = [];
  const st = [];
  const scopes = [];
  let pending = null;
  let paren = 0;
  let leadStart = -1;
  let underflow = false;

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const wasInLiteral = st.length > 0;
    const code = maskLine(raw, st);
    const trimmedCode = code.trim();
    const trimmedRaw = raw.trim();
    const innermost = scopes.length ? scopes[scopes.length - 1] : 'unit';
    const atDeclScope = innermost !== 'code' && paren === 0 && !wasInLiteral;

    if (atDeclScope) {
      if (trimmedCode === '') {
        if (/^\/\/\//.test(trimmedRaw)) { if (leadStart === -1) leadStart = li; }
        // any other blank/comment-only line neither starts nor breaks a lead block
      } else {
        let rest = trimmedCode;
        let sawAttr = false;
        while (ATTR_PREFIX.test(rest)) { rest = rest.replace(ATTR_PREFIX, ''); sawAttr = true; }
        if (sawAttr && leadStart === -1) leadStart = li;
        if (rest === '') {
          // attribute-only line: lead stays open for the declaration below
        } else if (NAMESPACE_FILE.test(rest)) {
          leadStart = -1;
        } else if (NAMESPACE_BLOCK.test(rest)) {
          pending = 'ns';
          leadStart = -1;
        } else if (TYPE_DECL.test(rest)) {
          boundaries.push(leadStart !== -1 ? leadStart : li);
          pending = 'type';
          leadStart = -1;
        } else if (innermost !== 'unit' && (MEMBER_DECL.test(rest) || OPERATOR_DECL.test(rest))) {
          boundaries.push(leadStart !== -1 ? leadStart : li);
          pending = 'code';
          leadStart = -1;
        } else if (innermost === 'unit' && /^(?:(?:public|internal|static|unsafe|partial|extern|file)\s+)*delegate\s/.test(rest)) {
          boundaries.push(leadStart !== -1 ? leadStart : li);
          leadStart = -1;
        } else {
          leadStart = -1;
        }
      }
    }

    // Advance scope/paren state over this line's masked code, in order.
    for (const ch of code) {
      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '{') {
        // A `{` inside parentheses is an expression brace (an object initializer or lambda body in a
        // primary-constructor base argument): it must neither consume the pending declaration nor open a
        // type scope.
        if (paren > 0) scopes.push('code');
        else { scopes.push(pending || 'code'); pending = null; }
      }
      else if (ch === '}') { if (scopes.length === 0) underflow = true; else scopes.pop(); }
      else if (ch === ';' && paren === 0) pending = null;
    }
  }

  if (underflow) return { state: 'degraded', boundaries: [], reason: 'closing brace without an opening scope' };
  if (st.length > 0) return { state: 'degraded', boundaries: [], reason: 'unterminated string, comment or interpolation at end of file' };
  if (scopes.length > 0) return { state: 'degraded', boundaries: [], reason: 'unbalanced braces at end of file' };
  return { state: 'completed', boundaries, reason: null };
}

/** Array-returning wrapper matching the profile `getBoundaries` contract. */
export function csharpBoundaryScanner(lines) {
  return scanCsharpBoundaries(lines).boundaries;
}
