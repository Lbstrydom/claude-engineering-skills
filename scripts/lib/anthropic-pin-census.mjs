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
 * **Stated limits, so nobody mistakes them for coverage.** A request STAGED
 * before the call — `const req = { ...defaults }; client.messages.create(req)` —
 * is not seen, and neither is a construction reached through a dynamic computed
 * member (`mod[whichever]()`). Both need dataflow, which this gate does not do
 * and should not grow into: they are the same shape as the HANDOFF that Rule B
 * exists for, one statement earlier instead of one module over. The declaration
 * is the mechanism for them, not a sixth pattern.
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
import { SERVICEABLE_CLI_PARAMS, UNSERVICEABLE_NAMED_PARAMS } from './anthropic-cli-faithfulness.mjs';

/**
 * The two questions this gate asks about params, and why it is two.
 *
 * The runtime oracle is an ALLOWLIST: every key not in `SERVICEABLE_CLI_PARAMS`
 * is refused. A static scan can ask that same question only where it can see
 * the WHOLE key set of a request — i.e. a literal object argument to
 * `messages.create(…)`. Everywhere else it sees object properties without
 * knowing which object is a request, so "every key not on the allowlist" would
 * flag every object literal in the repo.
 *
 *   - `ALLOWLIST`, scoped to a literal `.messages.create({…})` argument: ANY
 *     key outside `SERVICEABLE_CLI_PARAMS` is unserviceable, named or not. This
 *     is the rule that sees a param nobody listed — `stream` was passed at one
 *     site, dropped by the cli adapter, and refused by nothing (measured
 *     2026-11-15).
 *   - `NAMED`, file-wide: a known-unserviceable key appearing as a property
 *     ANYWHERE in the file. This is what still covers the STAGED request
 *     (`const req = { system }; client.messages.create(req)`), which the scoped
 *     rule cannot see and which Rule B's declaration exists for.
 *
 * Both lists come from the oracle, never re-spelled here: a second spelling of
 * the policy is the exact defect the single-oracle rule forbids.
 *
 * **STATED LIMIT — over-matching is the chosen direction, not an oversight.**
 * Raised three rounds running by the audit of this change, and the answer is
 * the same each time, so it is recorded here rather than re-argued: neither the
 * request-SHAPE rule nor the member-ASSIGNMENT rule ties its subject to a
 * particular `.create` call, because doing so is the dataflow this gate
 * declares it will not do (see `isMessagesCreateCallee`). Three things bound
 * the cost, and they are what makes the trade-off acceptable rather than
 * merely cheap:
 *   1. the shape is narrow — `messages` AND (`model` or `max_tokens`), never a
 *      bare `messages` key, so prompt builders and fixtures are not matched;
 *   2. the assignment rule fires only in a file that contains a
 *      `messages.create` call at all;
 *   3. either rule only MATTERS in a file that also constructs an unpinned
 *      client, which is Rule A's own condition — and measured 2026-11-15, both
 *      together flag 0 additional files in this repo.
 * The failure direction is therefore a demand for a pin or a declared census
 * entry on a file that constructs an unpinned Anthropic client and contains an
 * Anthropic-request-shaped object — never a silent pass. The residual
 * false-positive case (an unrelated request-shaped object, or an unrelated
 * `.system =`, in a file that does make a Messages API call) is answerable
 * with exactly those two mechanisms.
 */
const UNSERVICEABLE_PARAM_KEYS = UNSERVICEABLE_NAMED_PARAMS;

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
 * Is this object literal a Messages API REQUEST, judged by shape alone?
 *
 * `messages` plus `model` or `max_tokens`. That trio is what every request in
 * this repo carries and what no configuration object does, so it identifies a
 * staged request — `const req = {…}` later passed to `.create(req)` — without
 * the dataflow this gate refuses to grow into.
 *
 * Deliberately NOT "has a `messages` key": a `messages` array appears in test
 * fixtures and prompt builders that are not requests, and flagging those would
 * fail the gate for files that send nothing.
 *
 * @param {object} node - an ObjectExpression
 * @returns {boolean}
 */
function isRequestShaped(node) {
  const names = new Set();
  for (const p of node.properties || []) {
    if (p.type === 'SpreadElement') continue;
    const k = propertyKeyName(p) ?? (p.computed && p.key?.type === 'StringLiteral' ? p.key.value : null);
    if (k) names.add(k);
  }
  return names.has('messages') && (names.has('model') || names.has('max_tokens'));
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
 * TWO rules, because the allowlist question is only answerable where the whole
 * key set is visible (see the note beside `UNSERVICEABLE_PARAM_KEYS`). Inside a
 * literal `messages.create({…})` argument, every key outside
 * `SERVICEABLE_CLI_PARAMS` counts. Elsewhere in the file, only a NAMED
 * unserviceable key counts — deliberately not restricted to the call
 * expression, because a param may be built into a request object several
 * statements earlier, and narrowing to the call would reintroduce a fail-open
 * for exactly that shape. A file that mentions `system` as an object property
 * anywhere is treated as sending it, which errs toward requiring a pin.
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
  // Does this file make a Messages API call at all? The assignment rule below
  // is only meaningful where one exists; computed in a first pass because
  // `walk` reaches the assignment before the call just as often as after.
  let callsMessagesCreate = false;
  walk(ast, (node) => {
    if (node?.type === 'CallExpression' && isMessagesCreateCallee(node.callee)) {
      callsMessagesCreate = true;
    }
  });
  walk(ast, (node) => {
    // A SPREAD into a request object can carry `system`:
    // `messages.create({ ...request })` hides every param from this scan.
    // Scoped to a `.create(...)` argument rather than to every object literal:
    // measured 2026-11-15, the broad rule would flag 3 of the 6 unpinned files
    // — including the summariser, the highest-volume deliberately-cli site —
    // and move their spend off the Max credit to guard a hypothesis. The narrow
    // rule flags 0 today, so it costs nothing and still closes the shape.
    if (node?.type === 'CallExpression' && isMessagesCreateCallee(node.callee)) {
      // ARGUMENT 0 ONLY. `create(params, requestOptions)` — the second argument
      // is transport options (`{signal}`, `{timeoutMs}`), not params, and the
      // cli adapter honours both. Scanning every argument was harmless while
      // the question was "does any key spell `system`"; under the allowlist it
      // read `{ signal: ctrl.signal }` at summarise-domains.mjs:91 as an
      // unserviceable param and failed the gate on a call cli serves correctly.
      // A rule that asks a stricter question needs a correspondingly exact
      // subject.
      const arg = (node.arguments || [])[0];
      if (arg?.type === 'ObjectExpression') {
        for (const p of arg.properties || []) {
          if (p.type === 'SpreadElement') { dynamicKeys = true; continue; }
          // THE ALLOWLIST QUESTION, asked where the whole key set is visible.
          // A computed key that is not a string literal is unknowable: it might
          // be serviceable and it might be `stream`, so it fails closed through
          // `dynamicKeys` rather than being claimed as a named param.
          if (p.computed && p.key?.type !== 'StringLiteral') { dynamicKeys = true; continue; }
          const key = propertyKeyName(p) ?? (p.computed ? p.key?.value : null);
          if (!key) { dynamicKeys = true; continue; }
          if (!SERVICEABLE_CLI_PARAMS.includes(key)) found.add(key);
        }
      }
      return;
    }
    // A REQUEST-SHAPED LITERAL ANYWHERE IN THE FILE gets the allowlist too.
    // The staged request — `const req = { model, max_tokens, messages,
    // temperature: 0.2 }; client.messages.create(req)` — is not an argument to
    // `.create`, so the scoped rule above cannot see it, and the named rule
    // below only knows four spellings: `temperature` escaped the gate while
    // the census described itself as an allowlist. Raised by the round-1 audit
    // of this very change ("Fail-Open Merge Gate").
    //
    // Recognised by SHAPE, not by dataflow: an object literal carrying
    // `messages` AND (`model` or `max_tokens`) is a Messages API request, and
    // no unrelated config object in this repo carries that trio (measured
    // 2026-11-15: the rule flags 0 additional files). Shape is the right
    // instrument here because the alternative — following the variable to its
    // `.create` call — is the dataflow this gate deliberately does not do, and
    // a shape test cannot be defeated by an extra assignment in between.
    if (node?.type === 'ObjectExpression' && isRequestShaped(node)) {
      for (const p of node.properties || []) {
        if (p.type === 'SpreadElement') { dynamicKeys = true; continue; }
        if (p.computed && p.key?.type !== 'StringLiteral') { dynamicKeys = true; continue; }
        const key = propertyKeyName(p) ?? (p.computed ? p.key?.value : null);
        if (!key) { dynamicKeys = true; continue; }
        if (!SERVICEABLE_CLI_PARAMS.includes(key)) found.add(key);
      }
      return;
    }
    // A REQUEST ASSEMBLED BY MEMBER ASSIGNMENT — `req.tool_choice = {...}`,
    // `params.output_config = {...}`. Every rule above and below looks at
    // object PROPERTIES, so an assignment was invisible to the whole gate,
    // before this change as well as after it: a file could stage
    // `const req = { model, max_tokens, messages }` (clean) and then add
    // `req.system = SYSTEM` on the next line. Raised by the round-2 audit of
    // this change.
    //
    // Scoped to the NAMED params, not the allowlist: `obj.foo = 1` is every
    // assignment in the repo, and the allowlist question is only answerable
    // where a whole key set is visible. Measured 2026-11-15 — 9 member
    // assignments of a named param exist in tracked `scripts/**`, every one in
    // a file that pins or is indirect-pinned, so this rule flags 0 additional
    // files today.
    // STATED LIMIT, and the first cut got it wrong: a COMPUTED member
    // assignment is NOT folded into `dynamicKeys`. `out[idx] = …` is an array
    // index write, and treating one as an unreadable request key failed the
    // gate on summarise.mjs:185 — a line that has nothing to do with params.
    // A computed assignment says nothing about this file's requests unless we
    // know the object is one, which is the dataflow this gate does not do; the
    // declaration (Rule B) is the mechanism for it, as it is for a staged
    // request. Failing closed is only honest where the thing failed closed on
    // is in fact a candidate.
    if (node?.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression') {
      if (node.left.computed && node.left.property?.type !== 'StringLiteral') return;
      // ONLY IN A FILE THAT ACTUALLY CALLS `messages.create`. Without that
      // condition an unrelated `stats.system = …` in a file that happens to
      // construct a client read as a request param — named by the round-3
      // audit. File-level co-occurrence is not dataflow and does not pretend
      // to be: it removes the false positive wherever no Messages API call
      // exists at all, and the residual case (an unrelated `.system =` in a
      // file that does make such a call) is stated in the module docstring and
      // answerable with a pin or a declaration.
      if (!callsMessagesCreate) return;
      const key = memberNameOf(node.left);
      if (key && UNSERVICEABLE_PARAM_KEYS.includes(key)) found.add(key);
      return;
    }
    if (node?.type !== 'ObjectProperty' && node?.type !== 'ObjectMethod') return;
    if (node.computed && node.key?.type !== 'StringLiteral') { dynamicKeys = true; return; }
    const name = propertyKeyName(node) ?? (node.computed ? node.key?.value : null);
    if (name && UNSERVICEABLE_PARAM_KEYS.includes(name)) found.add(name);
  });
  // Named params first, in the oracle's documented order, then anything the
  // ALLOWLIST rule caught — alphabetically, so the gate's output is stable.
  // Filtering to the named list here was the denylist's last hiding place: a
  // key the allowlist rule had just caught would be collected and then dropped
  // on the way out, leaving the gate green about a param it HAD seen.
  const named = UNSERVICEABLE_PARAM_KEYS.filter((k) => found.has(k));
  const rest = [...found].filter((k) => !UNSERVICEABLE_PARAM_KEYS.includes(k)).sort();
  return { params: [...named, ...rest], dynamicKeys };
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
  const { names, namespaces } = factoryBindings(ast);
  const out = [];
  walk(ast, (node) => {
    if (node?.type !== 'CallExpression') return;
    const callee = node.callee;
    const isFactory = (callee?.type === 'Identifier' && names.has(callee.name))
      // `mod.createAnthropicClient(...)` after a dynamic import, and the
      // bracketed spelling `mod['createAnthropicClient']()`, which the
      // non-computed test excluded. PROVENANCE REQUIRED on the receiver: the
      // property name alone counted `unrelatedBag['createAnthropicClient']()`
      // as a seam construction, failing the gate for a call that is not this
      // seam's. No site in this repo uses the member form at all (measured
      // 2026-11-15), so requiring provenance costs nothing today. A computed
      // property whose key is NOT a string literal stays a declared limit.
      || (callee?.type === 'MemberExpression' && memberNameOf(callee) === FACTORY_NAME
        && callee.object?.type === 'Identifier' && namespaces.has(callee.object.name));
    if (!isFactory) return;
    const argNode = (node.arguments || [])[0];
    out.push({ verdict: resolveBackendOfArg(argNode), argNode });
  });
  return out;
}

/**
 * Is this callee the Messages API's `…messages.create`?
 *
 * Narrowed after round 6: matching any member call named `create` meant
 * `db.records.create({ ...row })` in a file that happens to construct a client
 * set the unknown-param flag, failing the gate for an unrelated call. The
 * receiver must itself be a `messages` member.
 *
 * **Stated limit.** A request STAGED first — `const req = { ...defaults };
 * client.messages.create(req)` — is not seen. Following that needs dataflow,
 * which this gate does not do and should not grow into: the honest answer is
 * that Rule B exists precisely because a value crossing a boundary cannot be
 * tracked statically, and a staged request is that same shape one step earlier.
 * A file doing it keeps its census entry and its reason, which is the mechanism
 * for exactly this.
 */
function isMessagesCreateCallee(callee) {
  if (callee?.type !== 'MemberExpression') return false;
  if (memberNameOf(callee) !== 'create') return false;
  const receiver = callee.object;
  if (receiver?.type === 'MemberExpression') return memberNameOf(receiver) === 'messages';
  return receiver?.type === 'Identifier' && receiver.name === 'messages';
}

/**
 * Is this initializer an `import()` of the seam module?
 *
 * Covers `await import('…/anthropic-client.mjs')` and the bare
 * `import('…/anthropic-client.mjs')`. Anything else — a function call, a
 * variable — is not provenance this gate can establish, so an alias from it is
 * not recorded.
 */
function isSeamImportInit(init) {
  const node = init?.type === 'AwaitExpression' ? init.argument : init;
  // Babel 8 models `import(x)` as its own `ImportExpression` with a `source`,
  // NOT as a CallExpression whose callee is `Import` (which is how Babel 7 and
  // most online examples show it). Probed against the real parser rather than
  // assumed — the assumed shape matched nothing and the provenance check was
  // silently rejecting every genuine alias.
  const source = node?.type === 'ImportExpression'
    ? node.source
    : (node?.type === 'CallExpression' && node.callee?.type === 'Import'
      ? (node.arguments || [])[0]
      : null);
  return source?.type === 'StringLiteral' && SEAM_MODULE_RE.test(source.value || '');
}

/**
 * A member expression's statically known property name, bracketed or dotted.
 * `obj.x` and `obj['x']` both yield `'x'`; `obj[expr]` yields null.
 */
function memberNameOf(callee) {
  const prop = callee?.property;
  if (!callee?.computed) return prop?.type === 'Identifier' ? prop.name : null;
  return prop?.type === 'StringLiteral' ? prop.value : null;
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
 * @returns {{names: Set<string>, namespaces: Set<string>}}
 */
function factoryBindings(ast) {
  const names = new Set([FACTORY_NAME]);
  // Namespace bindings for the seam, so the TWO-STEP form resolves:
  //   const mod = await import('…/anthropic-client.mjs');
  //   const { createAnthropicClient: mk } = mod;
  // The one-step check missed it, and a missed alias is invisible to BOTH rules.
  const seamNamespaces = new Set();
  walk(ast, (node) => {
    if (node?.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
      && isSeamImportInit(node.init)) {
      seamNamespaces.add(node.id.name);
    }
    if (node?.type === 'ImportDeclaration' && SEAM_MODULE_RE.test(node.source?.value || '')) {
      for (const spec of node.specifiers || []) {
        if (spec.type === 'ImportNamespaceSpecifier' && spec.local?.name) {
          seamNamespaces.add(spec.local.name);
        }
      }
    }
  });
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
    //
    // PROVENANCE CHECKED. Recording an alias for any object with a
    // `createAnthropicClient` property would count an unrelated factory of the
    // same name as this seam's — a false construction, which fails the gate
    // for the wrong reason and teaches the next author to distrust it.
    // Member alias: `const makeClient = anthropic.createAnthropicClient;`
    // The namespace call `anthropic.createAnthropicClient(...)` was already a
    // recognised construction, but LIFTING the member into a plain identifier
    // first was not — so every call through `makeClient` escaped both rules,
    // and a missed alias is invisible to the whole gate rather than merely
    // mis-attributed. Provenance is checked the same way as the destructuring
    // form below: the object must be a seam namespace, never any object that
    // happens to carry a property of this name.
    if (node?.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
      && node.init?.type === 'MemberExpression' && !node.init.computed
      && memberNameOf(node.init) === FACTORY_NAME
      && node.init.object?.type === 'Identifier' && seamNamespaces.has(node.init.object.name)) {
      names.add(node.id.name);
    }
    if (node?.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern') {
      const fromSeam = isSeamImportInit(node.init)
        || (node.init?.type === 'Identifier' && seamNamespaces.has(node.init.name));
      if (!fromSeam) return;
      for (const prop of node.id.properties || []) {
        if (prop.type !== 'ObjectProperty') continue;
        if (propertyKeyName(prop) !== FACTORY_NAME) continue;
        if (prop.value?.type === 'Identifier') names.add(prop.value.name);
      }
    }
  });
  return { names, namespaces: seamNamespaces };
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
 * be read as the closing quote. Whitespace that SEPARATES TWO WORD CHARACTERS
 * becomes one space rather than nothing, because there it is a token boundary,
 * not formatting.
 *
 * **Known limit, stated rather than engineered around.** A regular-expression
 * literal is not tracked: `/a  b/` folds to `/a b/`, which is a different
 * pattern. Distinguishing a regex literal from division needs the parser's own
 * token stream, and this runs on a client-construction ARGUMENT — an options
 * object — where a multi-space regex does not occur. The failure direction is a
 * shared digest (a missed drift), never a false alarm, and the token-boundary
 * rule above already closes every merge that was actually reachable.
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
    if (/\s/.test(ch)) {
      // WHITESPACE BETWEEN TWO WORD CHARACTERS IS NOT FORMATTING, IT IS A
      // TOKEN BOUNDARY. Dropping it outright merged distinct programs into one
      // digest — `typeof x` and `typeofx`, `new Foo` and `newFoo`, `a in b` and
      // `ainb` — so two arguments that select different backends could share a
      // digest and the drift rule would see nothing. Collapsed to ONE space
      // where it separates tokens, and dropped everywhere else.
      const prev = parts.length ? parts[parts.length - 1] : null;
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      const next = text[j];
      if (prev?.code && /[\w$]/.test(prev.ch) && next && /[\w$]/.test(next)) {
        parts.push({ code: true, ch: ' ' });
      }
      i = j - 1;
      continue;
    }
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
 * Does every path through this statement return?
 *
 * A deliberately small completion analysis over the shapes that actually occur
 * in an options factory. Anything it does not recognise is treated as NOT
 * terminating, so the error falls toward "unresolvable" — but only after the
 * common terminating shapes are recognised, because fail-closed-but-WRONG is
 * noise, and a gate that cries wolf is a gate that gets bypassed. The R5
 * version tested only "is the last statement a `return`", which marked
 * `if (x) return A; else return B;` unresolvable although every path returns.
 *
 * @param {object} node - a statement, or a BlockStatement
 * @returns {boolean}
 */
function alwaysReturns(node) {
  if (!node) return false;
  switch (node.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
      return true;
    case 'BlockStatement': {
      const statements = node.body || [];
      return statements.some((st) => alwaysReturns(st));
    }
    case 'IfStatement':
      // BOTH branches, and there must BE an else — `if (x) return A;` falls
      // through when x is false.
      return Boolean(node.alternate)
        && alwaysReturns(node.consequent) && alwaysReturns(node.alternate);
    case 'TryStatement':
      // The handler decides: a try whose catch returns, returns. A `finally`
      // that returns also terminates, but relying on that is obscure enough
      // that an options factory doing it should be read by a human.
      return Boolean(node.handler)
        && alwaysReturns(node.block) && alwaysReturns(node.handler.body);
    case 'SwitchStatement': {
      // Only with a `default`, and only if every case terminates.
      //
      // An EMPTY consequent is a fall-through to the NEXT case, so it
      // terminates only if something after it does. The earlier `length === 0
      // || …` treated every empty consequent as terminating, which made
      // `switch (x) { case 1: return a; default: }` read as always-returning
      // although the default falls out with no value — a fail-open in the one
      // direction that matters, since the whole point of this analysis is to
      // refuse a pin that is absent on some path.
      const cases = node.cases || [];
      if (!cases.some((c) => !c.test)) return false;
      const lastIndex = cases.length - 1;
      return cases.every((c, i) => {
        const body = c.consequent || [];
        if (body.length === 0) return i < lastIndex;        // falls through to a case checked below
        return body.some((st) => alwaysReturns(st));
      });
    }
    default:
      return false;
  }
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
  // IMPLICIT FALLTHROUGH. If the last statement of the body is not a `return`,
  // some path reaches the end and returns undefined — `function opts() { if (x)
  // return { backend: 'sdk' }; }` is the shape. A full completion analysis is
  // not needed to be SOUND here, only conservative: a body that does not end in
  // a return has an unresolvable path, full stop.
  const endsInReturn = alwaysReturns(body);
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    // Do not cross into a nested function: its `return` is not ours.
    if (node !== body && /Function(Declaration|Expression)$|ArrowFunctionExpression/.test(node.type || '')) return;
    if (node.type === 'ReturnStatement') {
      // A BARE `return;` returns undefined — not an object, and certainly not a
      // pinned one. Pushing nothing made it invisible, so a function with one
      // pinned return and one bare return counted as pinned.
      if (node.argument?.type === 'ObjectExpression') out.push(node.argument);
      else out.push({ type: 'Unresolvable' });
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      visit(node[key]);
    }
  };
  visit(body);
  if (!endsInReturn) out.push({ type: 'Unresolvable' });
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
    // A GETTER OR METHOD IS NOT "NOT A PROPERTY", IT IS AN UNRESOLVED ONE.
    // `isValueProperty` is false for an ObjectMethod, and `continue` then
    // SKIPPED it — so `{ ...opts(), get backend() { return 'cli'; } }` was
    // certified as resting on a factory that pins sdk. `resolveBackendOfArg`
    // already calls this shape unresolved; this function did not, which is two
    // answers to one question inside one module. Same verdict in both now.
    if (!isValueProperty(prop)) return false;
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
