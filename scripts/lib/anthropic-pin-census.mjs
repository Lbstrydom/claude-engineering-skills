/**
 * @fileoverview Census of Anthropic-seam call sites that do NOT pin a backend.
 *
 * **Why a gate at all.** The seam throws at RUN TIME when a cli-backed call
 * carries a param cli cannot honour (`anthropic-cli-faithfulness.mjs`). CI runs
 * the committed default, `sdk`, so that throw **never fires there**: a new
 * `system`-passing site with no `{backend:'sdk'}` pin ships green and breaks
 * only on the operator machines where `CLAUDE_BACKEND=cli` is set — which is
 * where this repo is actually used. A runtime refusal nobody's CI can reach is
 * not a guard; this census is what makes the pin enforceable before merge.
 *
 * **Two rules, because one cannot see both shapes.**
 *
 *   - **Rule A — file-local, fully mechanical.** A file that constructs an
 *     unpinned client AND passes an unserviceable param literal is a defect, no
 *     declaration accepted. This catches the common shape (construct, call, in
 *     one function) with no human in the loop.
 *
 *   - **Rule B — drift-only, declared.** Rule A is blind to the HANDOFF: a file
 *     may construct an unpinned client and give it to another module whose call
 *     passes `system`. `evolve-prompts.mjs` → `llm-wrappers.callClaude` is
 *     exactly that, and a file-local scan reads both halves as clean. Static
 *     analysis cannot close it (the client is a value crossing a module
 *     boundary, sometimes through an options bag), so instead EVERY unpinned
 *     construction is enumerated in the committed `.anthropic-pin-census.json`
 *     with a stated reason. A new one fails until someone decides which it is;
 *     a listed one that disappears fails too, asking for a re-baseline, in the
 *     shape `size:ratchet:gate` and `knip-gate` already use. The list is the
 *     record of a human decision, not an exemption from Rule A.
 *
 * `classifyPinningInSource` is a PURE function of file text, so the gate's
 * positive control can plant a source string rather than a file: a planted
 * unpinned-plus-`system` source must come back as a violation, or the scanner
 * is inert and the green it prints means nothing.
 *
 * @module scripts/lib/anthropic-pin-census
 */

/** The params `unserviceableCliParams` refuses, as they appear in source. */
const UNSERVICEABLE_PARAM_KEYS = Object.freeze(['system', 'tools', 'tool_choice']);

/** `createAnthropicClient(` with its argument list, non-greedy to the first `)`. */
const CONSTRUCTION_RE = /createAnthropicClient\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

/**
 * Does this argument list pin a backend explicitly? Accepts either quote style
 * and any whitespace; deliberately does NOT accept a variable
 * (`{ backend }`), because the gate cannot tell what that resolves to — such a
 * site reads as unpinned and must be declared or made literal.
 */
function pinsBackendLiterally(argText) {
  return /\bbackend\s*:\s*(['"`])(sdk|bedrock)\1/.test(argText);
}

/** Strip line and block comments, so a param named only in prose never counts. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Which unserviceable params does this source pass as an object key?
 *
 * Keyed on `<key>:` at a property position, after comments are stripped. A
 * JSDoc `@param {…} system` or a sentence mentioning `system` therefore does
 * not count, which is what let the first draft of this scanner flag ten files
 * that pass nothing.
 *
 * @param {string} source
 * @returns {string[]} the matched param names, in UNSERVICEABLE_PARAM_KEYS order
 */
export function unserviceableParamsInSource(source) {
  const code = stripComments(source);
  return UNSERVICEABLE_PARAM_KEYS.filter((key) => {
    // A property key: start of line / `{` / `,` before it, `:` after it, and
    // not a string-literal key or a type annotation.
    const re = new RegExp(`(?:^|[{,]|\\s)${key}\\s*:(?!:)`, 'm');
    return re.test(code);
  });
}

/**
 * Classify one file's pinning state.
 *
 * @param {string} source - the file's text
 * @returns {{constructions: number, unpinned: number, unserviceable: string[],
 *   ruleAViolation: boolean}}
 *   `ruleAViolation` is true when the file both constructs an unpinned client
 *   and passes an unserviceable param — the file-local defect.
 */
export function classifyPinningInSource(source) {
  const code = stripComments(source);
  let constructions = 0;
  let unpinned = 0;
  CONSTRUCTION_RE.lastIndex = 0;
  let m;
  while ((m = CONSTRUCTION_RE.exec(code)) !== null) {
    constructions += 1;
    if (!pinsBackendLiterally(m[1] || '')) unpinned += 1;
  }
  const unserviceable = unserviceableParamsInSource(source);
  return {
    constructions,
    unpinned,
    unserviceable,
    ruleAViolation: unpinned > 0 && unserviceable.length > 0,
  };
}

/**
 * Does the named function in this source itself contain a literal backend pin?
 *
 * The one escape from Rule A, and it is CHECKED rather than trusted. A file may
 * legitimately define the pin once in a shared options factory
 * (`azure-claude-adapter.mjs`'s `clientOptions()`), where duplicating the
 * literal at each construction would be the worse code. Such a file declares
 * `{"via": "<function name>"}` and the gate then reads that function and
 * confirms the literal is there — so the declaration cannot survive someone
 * deleting the pin it names. A `via` naming a function the file does not define
 * is a failure, not an exemption.
 *
 * Scoped by brace matching from the function header, so a pin in a LATER
 * function cannot satisfy the claim.
 *
 * @param {string} source
 * @param {string} fnName
 * @returns {{found: boolean, pinned: boolean}}
 */
export function indirectPinHolds(source, fnName) {
  const code = stripComments(source);
  const safe = fnName.replace(/[^A-Za-z0-9_$]/g, '');
  if (!safe) return { found: false, pinned: false };
  const header = new RegExp(
    '(?:function\\s+' + safe + '\\s*\\(|(?:const|let|var)\\s+' + safe + '\\s*=)',
  );
  const m = header.exec(code);
  if (!m) return { found: false, pinned: false };
  const open = code.indexOf('{', m.index);
  if (open === -1) return { found: true, pinned: false };
  let depth = 0;
  let end = code.length;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  return { found: true, pinned: pinsBackendLiterally(code.slice(open, end + 1)) };
}

/**
 * Compare a filesystem census against the declared baseline.
 *
 * @param {Map<string, string>} sources - repo-relative path → file text
 * @param {{unpinnedConstructions?: Record<string, {reason: string}>,
 *   indirectPins?: Record<string, {via: string, reason: string}>}} baseline
 * @returns {{ok: boolean, ruleA: Array<{file: string, params: string[]}>,
 *   undeclared: string[], stale: string[], declaredWithoutReason: string[],
 *   brokenIndirect: Array<{file: string, via: string, why: string}>,
 *   staleIndirect: string[]}}
 */
export function auditPinCensus(sources, baseline) {
  const declared = baseline?.unpinnedConstructions || {};
  const indirect = baseline?.indirectPins || {};
  const ruleA = [];
  const undeclared = [];
  const brokenIndirect = [];
  const seen = new Set();
  const seenIndirect = new Set();
  for (const [file, source] of sources) {
    const c = classifyPinningInSource(source);
    const claim = Object.prototype.hasOwnProperty.call(indirect, file) ? indirect[file] : null;
    if (claim) {
      if (c.unpinned > 0) seenIndirect.add(file);
      const via = String(claim.via || '');
      const held = via ? indirectPinHolds(source, via) : { found: false, pinned: false };
      if (!via) brokenIndirect.push({ file, via: '(none)', why: 'the entry names no `via` function' });
      else if (!held.found) brokenIndirect.push({ file, via, why: `${via}() is not defined in this file` });
      else if (!held.pinned) brokenIndirect.push({ file, via, why: `${via}() contains no literal backend pin` });
      continue; // its pinning is judged by the claim above, not by Rule A/B
    }
    if (c.ruleAViolation) ruleA.push({ file, params: c.unserviceable });
    if (c.unpinned > 0) {
      seen.add(file);
      if (!Object.prototype.hasOwnProperty.call(declared, file)) undeclared.push(file);
    }
  }
  const staleIndirect = Object.keys(indirect).filter((f) => !seenIndirect.has(f));
  // A declared file that no longer constructs an unpinned client: the entry is
  // now a claim about nothing, so it must be removed rather than left to make
  // the list look like coverage it no longer provides.
  const stale = Object.keys(declared).filter((f) => !seen.has(f));
  const declaredWithoutReason = Object.entries(declared)
    .filter(([, v]) => !String(v?.reason || '').trim())
    .map(([k]) => k);
  return {
    ok: ruleA.length === 0 && undeclared.length === 0 && stale.length === 0
      && declaredWithoutReason.length === 0 && brokenIndirect.length === 0
      && staleIndirect.length === 0,
    ruleA,
    undeclared,
    stale,
    declaredWithoutReason,
    brokenIndirect,
    staleIndirect,
  };
}
