/**
 * @fileoverview WHICH PARAMS does a source pass to the Anthropic Messages API?
 *
 * Split out of [anthropic-pin-census.mjs](anthropic-pin-census.mjs) on
 * 2026-11-15, when the allowlist flip grew that file from 822 to 1009 lines and
 * crossed the 1000-line `size:ratchet:gate` limit. The gate's instruction there
 * is to SPLIT rather than justify growth, and the seam was already visible: one
 * half answers "which params does this source pass", the other "which client
 * constructions are unpinned", and all of the growth was in the first.
 *
 * Nothing about the rules changed in the move. The census imports what it needs
 * and remains the module the gate calls.
 *
 * @module scripts/lib/anthropic-pin-params
 */
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
export const UNSERVICEABLE_PARAM_KEYS = UNSERVICEABLE_NAMED_PARAMS;

/**
 * A property key's name, whatever spelling it uses: `system:`, `'system':`,
 * `"system":` or the shorthand `system`. A COMPUTED key (`[k]: v`) has no
 * statically known name and returns null, which callers treat as unresolvable
 * rather than absent.
 *
 * @param {object} prop - an ObjectProperty node
 * @returns {string|null}
 */
export function propertyKeyName(prop) {
  if (prop?.computed) return null;
  const key = prop?.key;
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return null;
}

/** Is this an `ObjectExpression` property that assigns a value (not a method)? */
export function isValueProperty(node) {
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
export function paramsInSource(source) {
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
    // FILE-WIDE FAIL-CLOSED ON A COMPUTED KEY — #360's deliberate choice, NOT
    // changed here. The batched final review flagged it as a false-positive
    // generator (`{ [someKey]: v }` in an unrelated lookup table fails Rule A
    // for a file that sends nothing of the sort), and that is true. It is also
    // a decision #360 made explicitly, with two tests encoding it, on the
    // reasoning that a dynamic key might BE `system` and the cost falls only
    // where a pin decision is already owed.
    //
    // Narrowing it to request-shaped objects — as the computed MEMBER
    // ASSIGNMENT case above was narrowed — trades the false positive for a
    // false NEGATIVE: a request built entirely from computed keys
    // (`{ [a]: 1, [b]: 2 }`) is not request-shaped and would escape. That is a
    // different trade-off from the one #360 chose, and overturning another
    // change's tested decision on one reviewer comment, inside a PR about
    // something else, is the scope expansion this repo's own rule forbids.
    // Captured as debt instead.
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
export function isMessagesCreateCallee(callee) {
  if (callee?.type !== 'MemberExpression') return false;
  if (memberNameOf(callee) !== 'create') return false;
  const receiver = callee.object;
  if (receiver?.type === 'MemberExpression') return memberNameOf(receiver) === 'messages';
  return receiver?.type === 'Identifier' && receiver.name === 'messages';
}

/**
 * A member expression's statically known property name, bracketed or dotted.
 * `obj.x` and `obj['x']` both yield `'x'`; `obj[expr]` yields null.
 */
export function memberNameOf(callee) {
  const prop = callee?.property;
  if (!callee?.computed) return prop?.type === 'Identifier' ? prop.name : null;
  return prop?.type === 'StringLiteral' ? prop.value : null;
}
