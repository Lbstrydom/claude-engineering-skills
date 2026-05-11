/**
 * @fileoverview Thin-delegate detection — heuristic for skipping 1-line
 * facade symbols at symbol-index extraction time.
 *
 * @module scripts/lib/symbol-index/thin-delegate
 */

/**
 * Detect "thin delegate" functions — symbols whose entire body is a single
 * call into another symbol's method.
 *
 * Indexing thin delegates produces noise in arch:duplicates: every module
 * that wires into a shared factory ends up with an identical 1-line facade
 * like `const addListener = (el, e, h) => registry.add(el, e, h);` —
 * byte-identical bodies across modules. The cluster analyser correctly
 * flags them as duplicates by signature, but the duplication is deliberate
 * and load-bearing: the facade IS the SSoT pattern.
 *
 * Skipping these at extraction time keeps arch:duplicates focused on real
 * structural duplication. Trade-off: the symbol no longer appears in
 * arch:render — operators searching for the facade name lose per-module
 * hits but gain accurate drift accounting.
 *
 * Heuristic: body, after stripping comments + whitespace + trailing `;`,
 * must match `<member.access>(<passthrough-args>)` either as arrow
 * expression body, single-return block body, or single-statement block
 * body. **Passthrough-args** = empty, or comma-separated identifiers
 * (optionally with `...spread`). Any operator, object/array literal,
 * ternary, or non-identifier expression in arg position disqualifies
 * the body — those signal "wrapping logic", not pure delegation.
 * Bare function calls (`foo(x)`) are NOT classified — the
 * member-access requirement signals "wrapping a shared SSoT method".
 *
 * **Known limitation** (text-based heuristic):
 * Without parameter information from ts-morph, this helper cannot detect
 *   - argument reordering: `(a, b) => target.m(b, a)` is classified as a
 *     delegate even though it transforms the call (semantic concern).
 *   - closed-over identifiers: `() => target.m(defaultId)` is classified
 *     when `defaultId` is module-scope, not a parameter.
 * The wine-cellar case this helper targets (`(el, e, h) => registry.add(el, e, h)`)
 * is pure positional passthrough and is correctly classified. Operators
 * who hit a false positive from reordering/closed-over patterns can pass
 * `--include-delegates` to `arch:refresh` (or to `extract.mjs`) to disable
 * the filter and audit the cluster manually. Tighter classification
 * would require receiving the parameter list as a second arg (deferred).
 *
 * @param {string} bodyText — raw function/arrow body text from ts-morph
 * @returns {boolean} true iff the body is a thin delegate
 */
export function isThinDelegate(bodyText) {
  if (!bodyText || typeof bodyText !== 'string') return false;
  let body = bodyText
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/[^\n]*/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  body = body.replace(/;\s*$/, '');
  // ts-morph's getText() on a VariableDeclaration returns `name = <init>` (the
  // full declarator, sans `const`/`let`/`var`).  Strip these prefixes so the
  // heuristic sees just the function body.  Both forms must be handled BEFORE
  // the arrow-slice / block-strip, because:
  //   - arrow form: `name = (args) => body`       → arrow-slice handles after prefix strip
  //   - func-expr form: `name = function(args) { body }` → block-strip handles after prefix strip
  body = body.replace(/^[A-Za-z_$][\w$]*\s*=\s*/, '');
  body = body.replace(/^(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*\([^()]*\)\s*/, '');
  // Same line, but for anonymous function expressions (`function(args)` or `async function(args)`):
  body = body.replace(/^(?:async\s+)?function\s*\*?\s*\([^()]*\)\s*/, '');
  const arrowIdx = body.search(/=>\s/);
  if (arrowIdx !== -1) {
    body = body.slice(arrowIdx + 2).trim();
  }
  if (body.startsWith('{') && body.endsWith('}')) {
    body = body.slice(1, -1).trim();
    body = body.replace(/^return\s+/, '').replace(/;\s*$/, '').trim();
  }
  body = body.replace(/^(await|return)\s+/, '').trim();
  // Member-access head: identifier(.identifier)+
  // Argument list: empty, or identifier-only (with optional `...` spread),
  // comma-separated.  Any operator/literal/object/ternary in args fails.
  const IDENT = String.raw`[A-Za-z_$][\w$]*`;
  const ARG = String.raw`(?:\.\.\.)?${IDENT}`;
  const ARG_LIST = String.raw`(?:${ARG}(?:\s*,\s*${ARG})*)?`;
  const MEMBER_CALL = new RegExp(String.raw`^${IDENT}(?:\.${IDENT})+\s*\(\s*${ARG_LIST}\s*\)$`);
  return MEMBER_CALL.test(body);
}
