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
 * **It parses. It does not match text.** The first three versions of this module
 * were regular expressions over source, and three consecutive audit rounds each
 * found a different FAIL-OPEN shape they could not see: shorthand `{ system }`,
 * a spread after the literal, a duplicate key where the LAST one wins, a
 * shorthand `{ backend }` after a literal, a NESTED `metadata: { backend: 'sdk' }`
 * counted as top-level, and a construction with two nesting levels
 * (`{ redactor: makeRedactor(getRules()) }`) that the construction regex missed
 * **entirely** — invisible to both rules at once. Each fix was correct about the
 * shape it was told about and blind to the next one, which is the signature of
 * the wrong tool rather than of an incomplete pattern.
 *
 * The argument against parsing was that it is heavy for a gate over ~33 files.
 * That argument was wrong on the facts: this repo already parses JS in five
 * gates through the shared [ast.mjs](ast.mjs), `find-stdout-exit-sites.mjs`
 * among them — the same shape of gate as this one. So the AST is the cheaper
 * option as well as the correct one, and the regexes are gone.
 *
 * **Two rules, because one cannot see both shapes.**
 *
 *   - **Rule A — file-local, fully mechanical.** A file that constructs an
 *     unpinned client AND passes an unserviceable param is a defect, no
 *     declaration accepted. This catches the common shape (construct, call, in
 *     one function) with no human in the loop.
 *
 *   - **Rule B — drift-only, declared.** Rule A is blind to the HANDOFF: a file
 *     may construct an unpinned client and give it to another module whose call
 *     passes `system`. `evolve-prompts.mjs` → `llm-wrappers.callClaude` is
 *     exactly that, and a file-local analysis reads both halves as clean. No
 *     static analysis closes it (the client is a value crossing a module
 *     boundary, sometimes inside an options bag), so instead EVERY unpinned
 *     construction is enumerated in the committed `.anthropic-pin-census.json`
 *     with a stated reason, a COUNT and a digest of its arguments. A new one
 *     fails until someone decides which it is; a listed one that disappears
 *     fails too, asking for a re-baseline, in the shape `size:ratchet:gate` and
 *     `knip-gate` already use.
 *
 * `classifyPinningInSource` is a PURE function of file text, so the gate's
 * positive control can plant a source string rather than a file: a planted
 * unpinned-plus-`system` source must come back as a violation, or the scanner
 * is inert and the green it prints means nothing.
 *
 * @module scripts/lib/anthropic-pin-census
 */
import { createHash } from 'node:crypto';
import { parseSource, walk } from './ast.mjs';

/** The params `unserviceableCliParams` refuses, as object keys. */
const UNSERVICEABLE_PARAM_KEYS = Object.freeze(['system', 'tools', 'tool_choice']);

/** The factory every seam call site constructs its client through. */
const FACTORY_NAME = 'createAnthropicClient';

/** The module that exports it, as every call site spells it. */
const SEAM_MODULE_RE = /anthropic-client\.mjs$/;

/** Backends that are a usable pin: a declared transport that honours the params. */
const PINNED_BACKENDS = Object.freeze(new Set(['sdk', 'bedrock']));

/**
 * A property key's name, whatever spelling it uses: `system:`, `'system':`,
 * `"system":` or the shorthand `system`. A COMPUTED key (`[k]: v`) has no
 * statically known name and returns null, which callers treat as unresolvable
 * rather than absent.
 *
 * @param {object} prop - an ObjectProperty node
 * @returns {string|null}
 */
function propertyKeyName(prop) {
  if (prop?.computed) return null;
  const key = prop?.key;
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return null;
}

/** Is this an `ObjectExpression` property that assigns a value (not a method)? */
function isValueProperty(node) {
  return node?.type === 'ObjectProperty';
}

/**
 * Which unserviceable params does this source pass as an object property?
 *
 * Asked of the AST, so every spelling counts once and prose counts never: a
 * JSDoc `@param {string} system`, a comment, or a string containing the word
 * are not properties and are invisible here. The earlier text-based version
 * needed a comment-stripper and two regexes to approximate that, and still
 * missed shorthand.
 *
 * Deliberately NOT restricted to `messages.create` calls: a param may be built
 * into a request object several statements earlier, and narrowing to the call
 * expression would reintroduce a fail-open for exactly that shape. A file that
 * mentions `system` as an object property anywhere is treated as sending it,
 * which errs toward requiring a pin.
 *
 * @param {string} source
 * @returns {string[]} matched param names, in UNSERVICEABLE_PARAM_KEYS order
 */
export function unserviceableParamsInSource(source) {
  return paramsInSource(source).params;
}

/**
 * The unserviceable params a source passes, plus whether any key is DYNAMIC.
 *
 * A computed key whose value is a string literal is statically known and counts
 * as that key: `{ ['system']: p }` passes `system`, and discarding it was
 * fail-open. A computed key that is an expression cannot be resolved, so it
 * MIGHT be one of them — reported separately as `dynamicKeys` so Rule A can
 * fail closed on it without the key being claimed as a specific param.
 *
 * @param {string} source
 * @returns {{params: string[], dynamicKeys: boolean}}
 */
function paramsInSource(source) {
  const { ast } = parseSource(source);
  if (!ast) return { params: [], dynamicKeys: false };
  const found = new Set();
  let dynamicKeys = false;
  walk(ast, (node) => {
    if (node?.type !== 'ObjectProperty' && node?.type !== 'ObjectMethod') return;
    if (node.computed && node.key?.type !== 'StringLiteral') { dynamicKeys = true; return; }
    const name = propertyKeyName(node) ?? (node.computed ? node.key?.value : null);
    if (name && UNSERVICEABLE_PARAM_KEYS.includes(name)) found.add(name);
  });
  return { params: UNSERVICEABLE_PARAM_KEYS.filter((k) => found.has(k)), dynamicKeys };
}

/**
 * What backend does this construction EFFECTIVELY name?
 *
 * Resolved from the call's own argument node, so only TOP-LEVEL properties of
 * the options object count — `{ backend: 'cli', metadata: { backend: 'sdk' } }`
 * is `cli`, where a text scan read the nested literal as the winner. Within
 * those, **the last assignment wins**, as it does at runtime.
 *
 *   - `'pinned'`     — the last top-level `backend` is a literal `sdk`/`bedrock`
 *                      and no spread follows it.
 *   - `'cli'`        — the last one is a literal `cli`. Explicitly the transport
 *                      that cannot honour the params.
 *   - `'unresolved'` — no `backend` at all, a non-literal value (`{ backend }`,
 *                      `{ backend: x }`), a computed key, or a spread after the
 *                      winner. The gate cannot know, so it is not a pin.
 *
 * `unresolved` is the fail-closed bucket and it is deliberately large: a site
 * that wants the gate's blessing writes a literal, last, with no spread after
 * it — or declares itself in the census with a reason.
 *
 * @param {object|undefined} argNode - the first argument of the construction
 * @returns {'pinned'|'cli'|'unresolved'}
 */
export function resolveBackendOfArg(argNode) {
  if (!argNode) return 'unresolved';
  if (argNode.type !== 'ObjectExpression') return 'unresolved';
  let verdict = 'unresolved';
  for (const prop of argNode.properties || []) {
    if (prop.type === 'SpreadElement') {
      // A spread may carry `backend`, so it both supersedes whatever came
      // before and leaves the result unknowable.
      verdict = 'unresolved';
      continue;
    }
    // An ObjectMethod — `get backend() {...}` or `backend() {...}` — assigns the
    // key too, and its value is not statically known.
    if (prop.type === 'ObjectMethod') {
      if (prop.computed || propertyKeyName(prop) === 'backend') verdict = 'unresolved';
      continue;
    }
    if (!isValueProperty(prop)) continue;
    // A COMPUTED key can be 'backend', and it comes AFTER whatever was resolved
    // before it, so it both supersedes that and is itself unknowable. Skipping
    // it left `{ backend: 'sdk', [key]: 'cli' }` reading as pinned — the
    // docstring below already claimed otherwise, which is the worse kind of
    // defect: the stated contract was right and the code did not implement it.
    if (prop.computed) {
      const key = prop.key;
      // `['backend']` IS statically known, and it is still an override.
      if (key?.type === 'StringLiteral' && key.value !== 'backend') continue;
      verdict = 'unresolved';
      continue;
    }
    const name = propertyKeyName(prop);
    if (name !== 'backend') continue;
    const value = prop.value;
    // Shorthand `{ backend }` is an ObjectProperty whose value is the
    // Identifier `backend` — a variable, so unresolvable. This is the shape
    // round 3 found: it WINS at runtime and the text scan did not see it.
    if (value?.type !== 'StringLiteral') { verdict = 'unresolved'; continue; }
    if (PINNED_BACKENDS.has(value.value)) verdict = 'pinned';
    else if (value.value === 'cli') verdict = 'cli';
    else verdict = 'unresolved';
  }
  return verdict;
}

/**
 * Every `createAnthropicClient(...)` call in an AST, with its resolved backend.
 *
 * Matched on the AST, so nesting depth is irrelevant —
 * `createAnthropicClient({ redactor: makeRedactor(getRules()) })` is a
 * CallExpression like any other, where the construction regex (one nesting
 * level) missed it entirely and left the site invisible to BOTH rules.
 *
 * @param {object} ast
 * @returns {Array<{verdict: string, argNode: object|undefined}>}
 */
function constructionsIn(ast) {
  const names = factoryLocalNames(ast);
  const out = [];
  walk(ast, (node) => {
    if (node?.type !== 'CallExpression') return;
    const callee = node.callee;
    const isFactory = (callee?.type === 'Identifier' && names.has(callee.name))
      // `mod.createAnthropicClient(...)` after a dynamic import.
      || (callee?.type === 'MemberExpression' && !callee.computed
        && callee.property?.type === 'Identifier' && callee.property.name === FACTORY_NAME);
    if (!isFactory) return;
    const argNode = (node.arguments || [])[0];
    out.push({ verdict: resolveBackendOfArg(argNode), argNode });
  });
  return out;
}

/**
 * Every LOCAL name the factory is reachable under in this file.
 *
 * Always includes `createAnthropicClient`, plus any alias an import or a
 * destructuring gives it:
 *   `import { createAnthropicClient as mk } from '…/anthropic-client.mjs'`
 *   `const { createAnthropicClient: mk } = await import('…/anthropic-client.mjs')`
 * Matching the bare name alone left an aliased site invisible to BOTH rules,
 * which is the worst failure this gate can have.
 *
 * @param {object} ast
 * @returns {Set<string>}
 */
function factoryLocalNames(ast) {
  const names = new Set([FACTORY_NAME]);
  walk(ast, (node) => {
    // Static: import { createAnthropicClient as mk } from '...'
    if (node?.type === 'ImportDeclaration' && SEAM_MODULE_RE.test(node.source?.value || '')) {
      for (const spec of node.specifiers || []) {
        if (spec.type === 'ImportSpecifier'
          && (spec.imported?.name === FACTORY_NAME || spec.imported?.value === FACTORY_NAME)) {
          if (spec.local?.name) names.add(spec.local.name);
        }
      }
      return;
    }
    // Dynamic: const { createAnthropicClient: mk } = await import('...')
    if (node?.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern') {
      for (const prop of node.id.properties || []) {
        if (prop.type !== 'ObjectProperty') continue;
        if (propertyKeyName(prop) !== FACTORY_NAME) continue;
        if (prop.value?.type === 'Identifier') names.add(prop.value.name);
      }
    }
  });
  return names;
}

/**
 * The source text of each unpinned construction's argument, for the digest.
 * Taken from the node's own span so it is exactly what was written.
 */
function unpinnedArgSpans(source, ast) {
  return constructionsIn(ast)
    .filter((c) => c.verdict !== 'pinned')
    .map((c) => (c.argNode && Number.isInteger(c.argNode.start) && Number.isInteger(c.argNode.end)
      ? source.slice(c.argNode.start, c.argNode.end)
      : '<none>'));
}

/**
 * A stable digest of a file's unpinned construction ARGUMENTS.
 *
 * The count alone could not see a REPLACEMENT: swapping one unpinned
 * construction for a different one preserves the total, so the declared reason
 * kept describing a construction that no longer existed.
 *
 * **Normalisation leaves string literals alone.** The previous version stripped
 * all whitespace from the raw text, which also stripped it from inside STRING
 * LITERALS — so `mode === 'use cli'` and `mode === 'usecli'` shared a digest
 * although they can select different backends. `normaliseArgText` folds
 * whitespace only outside a quote.
 *
 * @param {string} source
 * @returns {string} 12 hex chars, or '' when the file constructs nothing unpinned
 */
export function unpinnedArgsDigest(source) {
  const { ast } = parseSource(source);
  if (!ast) return '';
  const spans = unpinnedArgSpans(source, ast).map(normaliseArgText).sort();
  if (spans.length === 0) return '';
  return createHash('sha256').update(spans.join('\u0000')).digest('hex').slice(0, 12);
}

/**
 * Fold formatting out of an argument span WITHOUT touching string contents.
 *
 * Walks the text once, tracking whether it sits inside a quote, and collapses
 * whitespace only outside one. Escapes are consumed in pairs so a `\'` cannot
 * be read as the closing quote.
 *
 * @param {string} text
 * @returns {string}
 */
export function normaliseArgText(text) {
  const parts = [];        // each entry: {code:true, ch} or {code:false, ch}
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      parts.push({ code: false, ch });
      if (ch === '\\') { parts.push({ code: false, ch: text[i + 1] ?? '' }); i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; parts.push({ code: false, ch }); continue; }
    if (/\s/.test(ch)) continue;              // formatting, outside a literal
    parts.push({ code: true, ch });
  }
  // A trailing comma is formatting ONLY in code. Running the fold over the
  // finished string also folded it inside literals, so `'use,}'` and `'use}'`
  // collided — against this function's own stated guarantee.
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.code && p.ch === ',') {
      const next = parts[i + 1];
      const atEnd = !next;
      const beforeCloser = next && next.code && (next.ch === '}' || next.ch === ']' || next.ch === ')');
      if (atEnd || beforeCloser) continue;
    }
    out.push(p.ch);
  }
  return out.join('');
}

/**
 * Classify one file's pinning state.
 *
 * @param {string} source - the file's text
 * @returns {{constructions: number, unpinned: number, unserviceable: string[],
 *   dynamicKeys: boolean, ruleAViolation: boolean, parsed: boolean}}
 *   `ruleAViolation` is true when the file constructs an unpinned client AND
 *   either passes an unserviceable param or carries a key this gate cannot
 *   resolve — the file-local defect. `parsed` is false when the source could
 *   not be parsed at all, which callers must treat as unknown rather than
 *   clean.
 */
export function classifyPinningInSource(source) {
  const { ast } = parseSource(source);
  if (!ast) {
    return { constructions: 0, unpinned: 0, unserviceable: [], ruleAViolation: false, parsed: false };
  }
  const constructions = constructionsIn(ast);
  const unpinned = constructions.filter((c) => c.verdict !== 'pinned').length;
  const { params: unserviceable, dynamicKeys } = paramsInSource(source);
  return {
    constructions: constructions.length,
    unpinned,
    unserviceable,
    dynamicKeys,
    // FAIL CLOSED on a dynamic key. In a file that constructs an unpinned
    // client, a key this gate cannot resolve might be `system` — and the whole
    // point of Rule A is that such a file must pin or declare. A file with no
    // unpinned construction is unaffected, so the cost falls only where a
    // decision is actually owed.
    ruleAViolation: unpinned > 0 && (unserviceable.length > 0 || dynamicKeys),
    parsed: true,
  };
}

/**
 * Does the named function in this source itself contain a literal backend pin,
 * and do this file's unpinned constructions actually rest on it?
 *
 * The one escape from Rule A, and it is CHECKED rather than trusted. A file may
 * legitimately define the pin once in a shared options factory
 * (`azure-claude-adapter.mjs`'s `clientOptions()`), where duplicating the
 * literal at each construction would be the worse code. Such a file declares
 * `{"via": "<function name>"}` and the gate then reads that function and
 * confirms the literal is there.
 *
 * `used` is the second half, and round 3 narrowed it twice. It is not enough
 * that the factory be CALLED: the construction must also leave the factory's
 * pin standing. `{ ...opts(), backend: 'cli' }` overrides it outright;
 * `{ ...opts(), backend: selected }` and `{ ...opts(), ...overrides }` are
 * UNRESOLVED, and an unresolved override can be `cli` just as easily as not. So
 * `used` requires every unpinned construction to pass the factory and to add no
 * `backend` of its own and no other spread — i.e. the factory's object is the
 * last word on the backend.
 *
 * @param {string} source
 * @param {string} fnName
 * @returns {{found: boolean, pinned: boolean, used: boolean}}
 */
export function indirectPinHolds(source, fnName) {
  const { ast } = parseSource(source);
  if (!ast || !fnName) return { found: false, pinned: false, used: false };

  let fnNode = null;
  walk(ast, (node) => {
    if (fnNode) return;
    if (node?.type === 'FunctionDeclaration' && node.id?.name === fnName) { fnNode = node; return; }
    if (node?.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
      && node.id.name === fnName
      && (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')) {
      fnNode = node.init;
    }
  });
  if (!fnNode) return { found: false, pinned: false, used: false };

  // The pin must be in what the function RETURNS, not merely somewhere inside
  // it. Accepting any pinned object in the body let
  // `function opts() { const unused = { backend: 'sdk' }; return { backend: 'cli' }; }`
  // satisfy the claim — a dead object vouching for a live override.
  const returned = returnedObjectsOf(fnNode);
  const pinned = returned.length > 0
    && returned.every((o) => resolveBackendOfArg(o) === 'pinned');

  const used = constructionsIn(ast)
    .filter((c) => c.verdict !== 'pinned')
    .every((c) => argRestsOnFactory(c.argNode, fnName));

  return { found: true, pinned, used };
}

/**
 * The ObjectExpressions a function can RETURN.
 *
 * `() => ({...})` is the concise-body form; `return {...}` is the block form.
 * Anything else a function might return — a variable, a call, a conditional —
 * yields no object here, so `pinned` is false and the claim fails: the gate
 * cannot follow a value it cannot see, and an unfollowable value is not a pin.
 *
 * Nested functions are NOT descended into: a `return` inside a callback belongs
 * to that callback, not to this function.
 *
 * @param {object} fnNode
 * @returns {object[]}
 */
function returnedObjectsOf(fnNode) {
  const body = fnNode?.body;
  if (!body) return [];
  if (body.type === 'ObjectExpression') return [body];       // () => ({...})
  if (body.type !== 'BlockStatement') return [];
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    // Do not cross into a nested function: its `return` is not ours.
    if (node !== body && /Function(Declaration|Expression)$|ArrowFunctionExpression/.test(node.type || '')) return;
    if (node.type === 'ReturnStatement') {
      if (node.argument?.type === 'ObjectExpression') out.push(node.argument);
      else if (node.argument) out.push({ type: 'Unresolvable' });
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      visit(node[key]);
    }
  };
  visit(body);
  return out;
}

/**
 * Does this construction's argument hand the backend decision to `fnName`?
 *
 * True only when the argument calls `fnName` AND adds nothing after it that
 * could change the backend: no `backend` property of its own, no computed key,
 * and no spread other than the factory's. Anything else is a possible override,
 * and a possible override is not a pin.
 */
function argRestsOnFactory(argNode, fnName) {
  if (!argNode) return false;
  // `createAnthropicClient(clientOptions())` — the factory's object IS the arg.
  if (argNode.type === 'CallExpression') {
    return argNode.callee?.type === 'Identifier' && argNode.callee.name === fnName;
  }
  if (argNode.type !== 'ObjectExpression') return false;
  let callsFactory = false;
  for (const prop of argNode.properties || []) {
    if (prop.type === 'SpreadElement') {
      const arg = prop.argument;
      const isFactoryCall = arg?.type === 'CallExpression'
        && arg.callee?.type === 'Identifier' && arg.callee.name === fnName;
      if (isFactoryCall) { callsFactory = true; continue; }
      // Any OTHER spread can carry `backend`; it is an unresolved override.
      return false;
    }
    if (!isValueProperty(prop)) continue;
    if (prop.computed) return false;                       // a computed key could be 'backend'
    if (propertyKeyName(prop) === 'backend') return false;
  }
  return callsFactory;
}

/**
 * Compare a filesystem census against the declared baseline.
 *
 * @param {Map<string, string>} sources - repo-relative path → file text
 * @param {{unpinnedConstructions?: Record<string, {reason: string, constructions: number, argsDigest: string}>,
 *   indirectPins?: Record<string, {via: string, reason: string}>}} baseline
 * @returns {{ok: boolean, ruleA: Array<{file: string, params: string[]}>,
 *   undeclared: string[], countDrift: Array<{file: string, declared: *, actual: *}>,
 *   unparsed: string[], stale: string[], declaredWithoutReason: string[],
 *   brokenIndirect: Array<{file: string, via: string, why: string}>,
 *   staleIndirect: string[]}}
 */
export function auditPinCensus(sources, baseline) {
  const declared = baseline?.unpinnedConstructions || {};
  const indirect = baseline?.indirectPins || {};
  const ruleA = [];
  const undeclared = [];
  const countDrift = [];
  const unparsed = [];
  const brokenIndirect = [];
  const seen = new Set();
  const seenIndirect = new Set();
  for (const [file, source] of sources) {
    const c = classifyPinningInSource(source);
    // A FILE THE PARSER COULD NOT READ IS UNKNOWN, NOT CLEAN. Without this the
    // gate's strongest guarantee would evaporate on exactly the file most
    // likely to be mid-edit.
    if (!c.parsed) { unparsed.push(file); continue; }
    const claim = Object.prototype.hasOwnProperty.call(indirect, file) ? indirect[file] : null;
    if (claim) {
      if (c.unpinned > 0) seenIndirect.add(file);
      const via = String(claim.via || '');
      const held = via ? indirectPinHolds(source, via) : { found: false, pinned: false, used: false };
      if (!via) brokenIndirect.push({ file, via: '(none)', why: 'the entry names no `via` function' });
      else if (!held.found) brokenIndirect.push({ file, via, why: `${via}() is not defined in this file` });
      else if (!held.pinned) brokenIndirect.push({ file, via, why: `${via}() contains no literal backend pin` });
      else if (!held.used) brokenIndirect.push({ file, via, why: `an unpinned construction here does not rest on ${via}() — it calls something else, or adds a backend or spread that could override the pin` });
      continue; // its pinning is judged by the claim above, not by Rule A/B
    }
    if (c.ruleAViolation) ruleA.push({ file, params: c.unserviceable });
    if (c.unpinned > 0) {
      seen.add(file);
      if (!Object.prototype.hasOwnProperty.call(declared, file)) {
        undeclared.push(file);
      } else {
        // THE COUNT AND THE SHAPE, not merely the presence. Declaring a file
        // used to clear every unpinned construction in it for ever, so adding a
        // SECOND one to a declared file was unflagged and the reason kept
        // describing only the first; and a REPLACEMENT preserves the count, so
        // the digest is what sees that.
        const want = Number(declared[file]?.constructions);
        const wantDigest = String(declared[file]?.argsDigest || '');
        const haveDigest = unpinnedArgsDigest(source);
        if (!Number.isInteger(want) || want !== c.unpinned) {
          countDrift.push({ file, declared: declared[file]?.constructions, actual: c.unpinned });
        } else if (wantDigest !== haveDigest) {
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
      && staleIndirect.length === 0 && countDrift.length === 0 && unparsed.length === 0,
    ruleA,
    undeclared,
    countDrift,
    unparsed,
    stale,
    declaredWithoutReason,
    brokenIndirect,
    staleIndirect,
  };
}
