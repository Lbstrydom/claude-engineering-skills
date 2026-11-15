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
import { createHash } from 'node:crypto';

/** The params `unserviceableCliParams` refuses, as they appear in source. */
const UNSERVICEABLE_PARAM_KEYS = Object.freeze(['system', 'tools', 'tool_choice']);

/** `createAnthropicClient(` with its argument list, non-greedy to the first `)`. */
const CONSTRUCTION_RE = /createAnthropicClient\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

/**
 * What backend does this argument list EFFECTIVELY name?
 *
 * **The last assignment wins.** The first cut tested whether an `sdk` literal
 * appeared anywhere and then looked for a spread after the FIRST `backend:`,
 * so `{ backend: 'sdk', backend: 'cli' }` and `{ ...clientOptions(), backend:
 * 'cli' }` both read as PINNED — fail-open, and the second shape is one an
 * `indirectPins` entry would also have covered. JavaScript resolves the last
 * one, so this resolves the last one too.
 *
 *   - `'pinned'`    — the last `backend:` is a literal `sdk`/`bedrock` and no
 *                     spread follows it.
 *   - `'cli'`       — the last `backend:` is a literal `cli`. Explicitly the
 *                     transport that cannot honour the params; never coverable
 *                     by a census entry.
 *   - `'unresolved'`— no `backend:` at all, a variable (`{ backend }`), or a
 *                     spread after the literal. The gate cannot know, so it is
 *                     not a pin.
 *
 * @param {string} argText
 * @returns {'pinned'|'cli'|'unresolved'}
 */
function resolveBackendInArgs(argText) {
  const re = /\bbackend\s*:\s*(?:(['"`])([A-Za-z]+)\1)?/g;
  let last = null;
  let m;
  while ((m = re.exec(argText)) !== null) last = m;
  if (!last) return 'unresolved';
  const value = last[2];
  if (!value) return 'unresolved';                 // `{ backend }` or `{ backend: x }`
  // A spread AFTER the winning literal may override it, and the gate cannot
  // know what the spread holds.
  if (/\.\.\./.test(argText.slice(last.index + last[0].length))) return 'unresolved';
  if (value === 'sdk' || value === 'bedrock') return 'pinned';
  return value === 'cli' ? 'cli' : 'unresolved';
}

/** Does this argument list carry a usable literal pin? */
function pinsBackendLiterally(argText) {
  return resolveBackendInArgs(argText) === 'pinned';
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
    const explicit = new RegExp(`(?:^|[{,]|\\s)${key}\\s*:(?!:)`, 'm');
    // SHORTHAND, which the first cut missed — and missed in the FAIL-OPEN
    // direction, so a file writing `messages.create({ model, max_tokens,
    // system, messages })` cleared Rule A while sending the param. Matched as
    // a bare property between `{`/`,` and `,`/`}`, which is the only position a
    // shorthand can occupy.
    const shorthand = new RegExp(`[{,]\\s*${key}\\s*[,}]`, 'm');
    return explicit.test(code) || shorthand.test(code);
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
 * It also checks that the file's unpinned CONSTRUCTIONS actually reference the
 * named function. Without that, the claim was only "this file defines a pinned
 * options factory somewhere" — true of a file whose constructions ignore it
 * entirely, which is the shape the entry is supposed to rule out.
 *
 * @param {string} source
 * @param {string} fnName
 * @returns {{found: boolean, pinned: boolean, used: boolean}}
 */
export function indirectPinHolds(source, fnName) {
  const code = stripComments(source);
  const safe = fnName.replace(/[^A-Za-z0-9_$]/g, '');
  if (!safe) return { found: false, pinned: false, used: false };
  const header = new RegExp(
    '(?:function\\s+' + safe + '\\s*\\(|(?:const|let|var)\\s+' + safe + '\\s*=)',
  );
  const m = header.exec(code);
  if (!m) return { found: false, pinned: false, used: false };
  // Every unpinned construction in this file must name the function the claim
  // rests on — otherwise the claim describes a factory nothing calls.
  // Every unpinned construction must pass the factory AND name no backend of
  // its own: `{ ...clientOptions(), backend: 'cli' }` passes the factory and
  // then overrides the pin the claim rests on, so a call-check alone is
  // fail-open in exactly the shape the claim exists to rule out.
  const used = unpinnedConstructionArgs(code).every((a) => (
    new RegExp(`\\b${safe}\\s*\\(`).test(a) && resolveBackendInArgs(a) !== 'cli'
  ));
  const open = code.indexOf('{', m.index);
  if (open === -1) return { found: true, pinned: false, used };
  let depth = 0;
  let end = code.length;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  return { found: true, pinned: pinsBackendLiterally(code.slice(open, end + 1)), used };
}

/**
 * A stable digest of a file's unpinned construction ARGUMENTS.
 *
 * The count alone could not see a REPLACEMENT: swapping one unpinned
 * construction for a different one preserves the total, so the declared reason
 * kept describing a construction that no longer existed. Whitespace is
 * normalised (and comments are already stripped) so the digest tracks the
 * construction's shape rather than its formatting.
 *
 * @param {string} source
 * @returns {string} 12 hex chars, or '' when the file constructs nothing unpinned
 */
export function unpinnedArgsDigest(source) {
  const args = unpinnedConstructionArgs(stripComments(source))
    // ALL whitespace and a trailing comma are formatting, not shape. Folding
    // only runs of whitespace left `{ redactor: null }` and `{ redactor: null,
    // }` with different digests, so a reformat would churn the baseline and the
    // declarations would become noise nobody reads.
    .map((a) => a.replace(/\s+/g, '').replace(/,(?=[}\])]|$)/g, ''))
    .sort();
  if (args.length === 0) return '';
  return createHash('sha256').update(args.join('\u0000')).digest('hex').slice(0, 12);
}

/** The argument text of every construction in `code` that carries no literal pin. */
function unpinnedConstructionArgs(code) {
  const out = [];
  CONSTRUCTION_RE.lastIndex = 0;
  let m;
  while ((m = CONSTRUCTION_RE.exec(code)) !== null) {
    const arg = m[1] || '';
    if (!pinsBackendLiterally(arg)) out.push(arg);
  }
  return out;
}

/**
 * Compare a filesystem census against the declared baseline.
 *
 * @param {Map<string, string>} sources - repo-relative path → file text
 * @param {{unpinnedConstructions?: Record<string, {reason: string, constructions: number}>,
 *   indirectPins?: Record<string, {via: string, reason: string}>}} baseline
 * @returns {{ok: boolean, ruleA: Array<{file: string, params: string[]}>,
 *   undeclared: string[], countDrift: Array<{file: string, declared: *, actual: number}>,
 *   stale: string[], declaredWithoutReason: string[],
 *   brokenIndirect: Array<{file: string, via: string, why: string}>,
 *   staleIndirect: string[]}}
 */
export function auditPinCensus(sources, baseline) {
  const declared = baseline?.unpinnedConstructions || {};
  const indirect = baseline?.indirectPins || {};
  const ruleA = [];
  const undeclared = [];
  const countDrift = [];
  const brokenIndirect = [];
  const seen = new Set();
  const seenIndirect = new Set();
  for (const [file, source] of sources) {
    const c = classifyPinningInSource(source);
    const claim = Object.prototype.hasOwnProperty.call(indirect, file) ? indirect[file] : null;
    if (claim) {
      if (c.unpinned > 0) seenIndirect.add(file);
      const via = String(claim.via || '');
      const held = via ? indirectPinHolds(source, via) : { found: false, pinned: false, used: false };
      if (!via) brokenIndirect.push({ file, via: '(none)', why: 'the entry names no `via` function' });
      else if (!held.found) brokenIndirect.push({ file, via, why: `${via}() is not defined in this file` });
      else if (!held.pinned) brokenIndirect.push({ file, via, why: `${via}() contains no literal backend pin` });
      else if (!held.used) brokenIndirect.push({ file, via, why: `an unpinned construction in this file does not pass ${via}()` });
      continue; // its pinning is judged by the claim above, not by Rule A/B
    }
    if (c.ruleAViolation) ruleA.push({ file, params: c.unserviceable });
    if (c.unpinned > 0) {
      seen.add(file);
      if (!Object.prototype.hasOwnProperty.call(declared, file)) {
        undeclared.push(file);
      } else {
        // THE COUNT, not merely the presence. Declaring a file used to clear
        // every unpinned construction in it for ever, so adding a SECOND one to
        // a declared file — with any params at all — was unflagged, and the
        // reason text kept describing only the first. Same lesson as every
        // other ratchet here: a population check that counts presence cannot
        // see growth.
        const want = Number(declared[file]?.constructions);
        const wantDigest = String(declared[file]?.argsDigest || '');
        const haveDigest = unpinnedArgsDigest(source);
        if (!Number.isInteger(want) || want !== c.unpinned) {
          countDrift.push({ file, declared: declared[file]?.constructions, actual: c.unpinned });
        } else if (wantDigest !== haveDigest) {
          // Same COUNT, different constructions. The reason text now describes
          // something that is not there any more, which is the state Rule B
          // exists to prevent.
          countDrift.push({ file, declared: `digest ${wantDigest || '(none)'}`, actual: `digest ${haveDigest}` });
        }
      }
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
      && staleIndirect.length === 0 && countDrift.length === 0,
    ruleA,
    undeclared,
    countDrift,
    stale,
    declaredWithoutReason,
    brokenIndirect,
    staleIndirect,
  };
}
