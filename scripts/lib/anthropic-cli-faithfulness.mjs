/**
 * @fileoverview The single oracle for "can the `cli` backend honour this call?"
 *
 * **A backend must not accept a call whose parameters it cannot honour.**
 *
 * `createAnthropicClient`'s cli adapter already refuses what it cannot
 * REPRESENT (multi-turn histories, assistant-role messages, non-text content
 * blocks — `assertOneShotTextMessages`) and what it cannot TARGET (a custom
 * `baseURL` — `reconcileBackendWithBaseUrl`). Both throw. The params below were
 * the silent third category: accepted, then dropped or outranked, so the
 * failure surfaced one layer up as a MODEL failure rather than a transport one.
 *
 * **THROW AND PIN, never route.** An unserviceable call throws, whether `cli`
 * was explicit or ambient, and the remedy is a `{backend:'sdk'}` pin AT THE
 * CALL SITE. The rejected alternative was a lazy sdk fallback that silently
 * served ambient-cli calls on the sdk: it is quieter, and that is the problem —
 * the transport a call runs on, and therefore which meter it bills, would be
 * decided by a param the call site never connected to billing, and nothing in
 * the repo would record which sites had moved. A pin is declared, greppable,
 * reviewable in a diff, and enforced by `npm run anthropic:pin:gate`.
 *
 * Its own module, not a helper inside
 * [anthropic-client.mjs](anthropic-client.mjs), for two reasons. The repo's
 * single-oracle pattern (`classifySelector`, `sensitive-paths.mjs`) gives each
 * policy decision one importable home so a second implementation cannot quietly
 * appear beside it; and `anthropic-client.mjs` is already past the
 * `size:ratchet:gate` limit, where the gate's instruction is to split rather
 * than justify growth.
 *
 * @module scripts/lib/anthropic-cli-faithfulness
 */

/**
 * The ONLY params the `cli` backend can serve.
 *
 * Read off the adapter, not asserted: `createCliAdapter`'s `create()`
 * destructures exactly `{model, max_tokens, system, messages}` and builds an
 * argv from `--model`, `--system-prompt` and stdin. `system` is destructured
 * and DELIVERED, and it is still not serviceable — see
 * `UNREPRESENTABLE_REASONS` — so the serviceable set is NARROWER than the set
 * the adapter reads. Representability is necessary, not sufficient.
 *
 * **An ALLOWLIST, not a denylist, since 2026-11-15.** The denylist this
 * replaced named three params to refuse and let every other key through by
 * default, which is only ever as complete as the last person who thought to add
 * a name. Measured on this repo the day it was flipped — 26 `messages.create`
 * call sites, 19 with a literal argument object: `stream` was passed at one
 * site, dropped by the cli adapter, and refused by nothing; `output_config`
 * (reasoning effort) is assigned onto a request variable rather than written as
 * a literal, so a key-scan cannot see it at all. Neither is a param someone
 * forgot to list — they are params that did not exist when the list was
 * written. The allowlist asks the opposite question, so a param the Messages
 * API gains next month is refused on arrival instead of dropped silently.
 */
export const SERVICEABLE_CLI_PARAMS = Object.freeze(['model', 'max_tokens', 'messages']);

/**
 * Why each NAMED param is unserviceable, measured.
 *
 * A param absent from this map is still refused — by the allowlist, with the
 * generic reason below. These entries exist because the generic reason would
 * UNDERSTATE them: all four are params the adapter touches or the API would
 * change shape for, so "the adapter never reads it" would be false, and the
 * real defect is subtler than absence.
 *
 * Measured 2026-11-14 (docs/plans/anthropic-cli-faithfulness-routing.md §6.B):
 *
 *   - `system` — **not that cli ignores it. It is passed, and it is not
 *     reliable.** `claude -p` receives the string as `--system-prompt` and
 *     obeys it for a simple instruction, but the Claude Code agent persona and
 *     its ~164,000-token auto-discovered project context OUTRANK it on a
 *     structured-output contract, and that prefix is on every call whatever the
 *     prompt says. Both halves measured 2026-11-14/15 on the same seam:
 *       * `normalize-intent`'s REAL `NORMALIZE_PROMPT` → **1995–2784 output
 *         tokens in ~40s against `max_tokens: 200`**, opening "I haven't
 *         changed anything. This session has no file-edit or shell tools …
 *         AGENTS.md requires …", where the sdk backend returned the requested
 *         one-line sentence in 29–43 tokens and 1.3s.
 *       * a SHORTENED variant of that same prompt → a correct one-line answer
 *         **3 of 3 times**, still burning 466–673 output tokens.
 *     So the honest claim is the narrow one: obeyed for a simple instruction,
 *     outranked for a structured-output contract, and never free. A seam cannot
 *     tell the two apart from the params, and "sometimes honoured" is the worst
 *     property a transport can have for a contract a consumer then parses.
 *     Confirms the 2026-07-19 observation recorded at
 *     scripts/lib/arch-memory/normalize-intent.mjs:262-269, and post-dates the
 *     `--tools ''` fix, so disabling tools did not make `claude -p` terse.
 *
 *   - `tools` / `tool_choice` — dropped outright: the adapter always spawns
 *     `--tools ''`. A caller forcing `tool_choice` gets a plain text block back
 *     with NO error. AGENTS.md records this costing the tiered-recall discovery
 *     generator a whole shadow window (20/20 runs fell back to legacy).
 *
 *   - `stream` — the shape of the RESPONSE, not of the request. `claude -p
 *     --output-format json` emits one final message, so an adapter that accepts
 *     `stream: true` hands back a thing the caller will try to iterate.
 *     `streamAnthropicMessage` (final-review/transport.mjs) guards for exactly
 *     this and falls back, which is why it never broke — and why nothing
 *     noticed that the seam below it was refusing nothing.
 */
const UNREPRESENTABLE_REASONS = Object.freeze({
  system: 'the cli backend PASSES `system` as `--system-prompt` but does not '
    + 'honour it reliably — it is obeyed for a simple instruction and '
    + 'OUTRANKED by the `claude -p` agent persona and its ~164K-token '
    + 'project context on a structured-output contract (measured: '
    + '1995-2784 output tokens of first-person prose against a 200 '
    + 'ceiling), and that prefix is charged on every call',
  tools: "the cli backend spawns `claude -p --tools ''` and drops tool "
    + 'definitions silently, returning a plain text block with no error',
  tool_choice: 'the cli backend drops forced tool-calling silently — a caller '
    + 'forcing `tool_choice` gets a text block back and no error',
  stream: 'the cli backend has no streaming mode — `claude -p --output-format json` '
    + 'returns a single final message, so `stream: true` is accepted and the caller '
    + 'is handed a response of a different SHAPE than the one it asked for',
  output_config: 'the cli backend has no reasoning-effort control — `claude -p` takes '
    + 'no such flag, so the effort tier is accepted and dropped and the call runs at '
    + 'whatever the agent decides, which is the dial a caller comparing arms is '
    + 'explicitly trying to hold still',
});

/**
 * The params this module can name a MEASURED reason for.
 *
 * Exported for the static gate ([anthropic-pin-census.mjs](anthropic-pin-census.mjs)),
 * which cannot apply the allowlist file-wide — outside a literal
 * `messages.create({…})` argument it sees property keys without knowing which
 * object is a request, so "every key not on the allowlist" would flag every
 * object in the repo. There it falls back to asking whether a NAMED
 * unserviceable param appears, and this is that list, taken from the oracle
 * rather than re-spelled beside it.
 */
export const UNSERVICEABLE_NAMED_PARAMS = Object.freeze(Object.keys(UNREPRESENTABLE_REASONS));

/**
 * The reason for a param the adapter simply never reads.
 *
 * Names the serviceable set rather than the refused param's semantics, because
 * this branch is reached precisely for params this module knows nothing about —
 * including ones that do not exist yet. Claiming to know what they do would be
 * the denylist's mistake in a new place.
 *
 * @param {string} param
 * @returns {string}
 */
function genericReason(param) {
  return `the cli backend builds its argv from ${SERVICEABLE_CLI_PARAMS.join(', ')} alone `
    + `(\`claude -p\` has no equivalent for \`${param}\`), so the param is accepted and `
    + 'dropped: the call is answered, but it is not the call that was made';
}

/**
 * Is this key backed by an ACCESSOR anywhere on the prototype chain?
 *
 * The emptiness exemption below is the oracle's only value read, and the
 * adapter reads the same object again afterwards — so a getter can return
 * blank to the check and a real prompt to `claude -p`, and the value that gets
 * sent is the one nobody validated. Round-6 audit (a TOCTOU, correctly).
 *
 * Rather than widen the contract so the adapter consumes a validated snapshot
 * — a change to the adapter's signature, and too large to bolt onto an audit
 * round — the window is closed by refusing to read an accessor at all: an own,
 * non-accessor DATA property cannot differ between two reads, and anything
 * else is treated as PRESENT without being read. No ordinary caller is
 * affected (measured: no call site in this repo passes a blank `system`, and
 * none passes one through a getter).
 *
 * @param {object} obj
 * @param {string} key
 * @returns {boolean} true when the value must not be trusted to a second read
 */
function isAccessorBacked(obj, key) {
  let cur = obj;
  const seen = new Set();
  let depth = 0;
  while (cur && !seen.has(cur) && depth < MAX_PROTOTYPE_DEPTH) {
    seen.add(cur);
    depth += 1;
    const d = Object.getOwnPropertyDescriptor(cur, key);
    if (d) return typeof d.get === 'function' || typeof d.set === 'function';
    cur = Object.getPrototypeOf(cur);
  }
  return false;
}

/**
 * Is this param ABSENT for the adapter's purposes?
 *
 * `undefined` is absent everywhere: the SDK omits such a key from the wire, so
 * refusing on it would refuse a call that never carried it. `system` has one
 * further absent spelling, read off the adapter rather than assumed — `if
 * (effectiveSystem) args.push('--system-prompt', …)` means a blank string is
 * never delivered, so a blank `system` asks nothing of the transport.
 *
 * Nothing else gets an emptiness rule. `tools: []` is NOT absent: a caller that
 * built an empty tool array asked for tool-calling and received none, which is
 * the failure this module exists to refuse.
 *
 * @param {string} param
 * @param {unknown} value
 * @returns {boolean}
 */
function isAbsent(param, value) {
  if (value === undefined) return true;
  if (param !== 'system') return false;
  if (value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * `Object.prototype`'s standard members, hardcoded.
 *
 * Read from `Object.getOwnPropertyNames(Object.prototype)` at first, which was
 * wrong in the one case that matters: a polluted `Object.prototype.system`
 * would be in that list and so excluded, while `const { system } = params`
 * reads it and `JSON.stringify` does not serialise it — measured, the exact
 * divergence this module refuses. A fixed list excludes the real members and
 * nothing else, so prototype pollution is caught rather than whitelisted.
 */
const OBJECT_PROTOTYPE_MEMBERS = Object.freeze(new Set([
  'constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable', '__proto__',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]));

/** Depth at which a prototype chain is treated as unenumerable rather than walked. */
const MAX_PROTOTYPE_DEPTH = 100;

/**
 * The params the cli adapter actually DESTRUCTURES — `const { model,
 * max_tokens, system, messages } = params` (anthropic-client.mjs:774).
 *
 * This is the set the divergence check applies to, and narrowing it to this is
 * the round-4 correction. Divergence means "cli reads it and sdk will not send
 * it", and cli can only read what it destructures: an inherited `temperature`
 * is read by NEITHER backend — sdk does not serialise it and the adapter never
 * names it — so flagging it was a false positive, not caution. An inherited
 * `system` or `messages` is a different thing entirely, and still refused.
 *
 * Read off the adapter, so it is a superset of `SERVICEABLE_CLI_PARAMS`:
 * `system` is destructured and delivered, and still unserviceable.
 *
 * **Duplicated from the adapter, and the duplication is CHECKED rather than
 * trusted** (round-6 audit): adding a field to the adapter's destructure
 * without adding it here would make inherited or non-enumerable values for
 * that field invisible to the divergence check — silently, since nothing else
 * reads both. `tests/anthropic-cli-faithfulness.test.mjs` parses
 * `createCliAdapter`'s own destructuring pattern and asserts the two sets are
 * equal, which is the repo's prose-to-code answer applied to code-to-code: one
 * side cannot drift without the test saying so.
 */
export const CLI_READ_PARAMS = Object.freeze(['model', 'max_tokens', 'system', 'messages']);

/**
 * Every key a DESTRUCTURE could read off this object.
 *
 * The question is not "what would serialize" but "what can each adapter get
 * at", because the two adapters reach into the object by different mechanisms:
 *
 *   - sdk sends `JSON.stringify` / spread → **own enumerable** only.
 *   - cli does `const { system } = params` → the whole prototype chain, and
 *     **destructuring does not care about enumerability**.
 *
 * So the union has to be own ∪ inherited ∪ non-enumerable. Two rounds of audit
 * walked this down one layer at a time and both layers were real, measured on
 * the objects rather than argued:
 *   - `Reflect.ownKeys` alone missed `Object.create({ system })` — enumerable,
 *     inherited; sdk omits it, cli reads it.
 *   - adding `for…in` still missed a NON-ENUMERABLE inherited `system`
 *     (`Object.defineProperty(proto, 'system', { enumerable: false })`) — for…in
 *     does not see it, `JSON.stringify` does not either, and the destructure
 *     reads it all the same.
 *
 * `Object.prototype`'s own names are excluded: a plain object's chain ends
 * there, and counting `constructor`/`toString`/`valueOf` as request params
 * would refuse every call. A class instance's own prototype IS walked, and its
 * `constructor` is excluded by the same list.
 *
 * @param {object} params
 * @returns {Set<string|symbol>|null} null when the chain does not terminate
 */
function destructurableKeys(params) {
  const keys = new Set(Reflect.ownKeys(params));
  const seen = new Set([params]);
  let proto = Object.getPrototypeOf(params);
  let depth = 0;
  // BOUNDED, and the first version's docstring was wrong about why it did not
  // need to be: it claimed a cyclic chain is impossible because
  // `Object.setPrototypeOf` refuses to create one. A **Proxy** returns whatever
  // its `getPrototypeOf` trap says, including itself, and that loops forever —
  // measured. `null` here means "cannot enumerate", and the caller fails
  // closed on it, which is the honest answer for an object whose own shape is
  // adversarial.
  while (proto) {
    if (seen.has(proto) || depth >= MAX_PROTOTYPE_DEPTH) return null;
    seen.add(proto);
    depth += 1;
    for (const k of Reflect.ownKeys(proto)) {
      if (typeof k === 'string' && OBJECT_PROTOTYPE_MEMBERS.has(k)) continue;
      keys.add(k);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return keys;
}

/**
 * The keys the **sdk** backend will actually put on the wire.
 *
 * `JSON.stringify` and object spread copy OWN ENUMERABLE properties, so this
 * is the whole of what the sdk arm sends — and the comparison that matters is
 * against `destructurableKeys`, not against the allowlist.
 *
 * @param {object} params
 * @returns {Set<string>}
 */
function sdkVisibleKeys(params) {
  return new Set(Object.keys(params));
}

/**
 * Which param on this call can the `cli` backend not honour?
 *
 * **The membership test — apply this to any new param.** Does the param being
 * unmet change the ANSWER the caller receives?
 *   - `system` unmet → a different KIND of answer than was asked for. Not
 *     every time — that is the trap. The consumer's parse then fails, or
 *     succeeds on garbage: `arm-eval/judge.mjs` records it as
 *     `conformant: false`, scoring its own transport failure as a model one.
 *   - `tools`/`tool_choice` unmet → a text block where a tool call was
 *     demanded. Structurally the wrong shape.
 *   - `stream` unmet → a final message where an event stream was expected.
 *   - `max_tokens` unmet → **the answer the caller asked for**, possibly more
 *     of it than was budgeted. The content is not wrong.
 *
 * So `max_tokens` is SERVICEABLE, and it is the allowlist entry that has to be
 * argued for rather than read off the adapter. It is equally unenforced on cli
 * — accepted and ignored, and the adapter warns once per session — but *every*
 * caller sets it (the Messages API requires it), so refusing on it would refuse
 * every call, collapsing the routing into "cli is never usable". That would
 * void an operator's transport choice for the calls cli serves correctly and
 * move all of their spend off the Max 20x credit. What covers the real risk an
 * unenforced ceiling carries is a consumer that NOTICES truncation:
 * `assessBatchCompleteness` in scripts/symbol-index/summarise.mjs reads
 * `stop_reason` and reports an incomplete batch rather than a silently short
 * answer. A `CLAUDE_CLI_STRICT_MAX_TOKENS` env opt-in was implemented and then
 * removed (2026-11-15): a second routing dial for a param whose being unmet
 * does not change the answer, which no call site asked for.
 *
 * **Fails CLOSED on params it cannot enumerate**, and says so with its own
 * `kind`. "This call passes a param cli cannot honour" and "I cannot tell what
 * this call passes" are different facts; a caller that renders them as one
 * string teaches the next reader to dismiss the second as noise.
 *
 * @param {object} params - the `messages.create()` params
 * @returns {{param: string, why: string,
 *   kind: 'unrepresentable'|'unresolvable'|'divergent'}|null}
 *   null when cli can serve the call
 */
export function unserviceableCliParams(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return {
      param: '(params)',
      kind: 'unresolvable',
      why: 'the params are not a plain object, so the keys this call carries cannot be '
        + 'enumerated and the allowlist cannot be applied to them',
    };
  }
  let readable;
  let sent;
  try {
    // TWO QUESTIONS, NOT ONE, because the two adapters reach into the object
    // by different mechanisms and three audit rounds each found a new key that
    // one could see and the other could not. Patching the enumeration a third
    // time would have found a fourth; this asks the invariant instead:
    //
    //   `sent`     — what sdk puts on the wire: OWN ENUMERABLE keys.
    //   `readable` — what cli's `const { system } = params` can reach: own,
    //                inherited, and non-enumerable, anywhere on the chain.
    //
    // A key in `readable` but not in `sent` is a DIVERGENCE whatever its name:
    // cli answers a call sdk never made. Measured 2026-11-15, all three on the
    // real objects: `Object.create({ system })` (enumerable, inherited); a
    // non-enumerable inherited `system` (invisible to `for…in` as well);
    // `Object.prototype.system = …` (prototype pollution, which an
    // `Object.getOwnPropertyNames(Object.prototype)` exclusion had whitelisted).
    // And the direction the first two fixes got backwards: an inherited
    // ALLOWLISTED param — `Object.create({ max_tokens: 64, messages: [...] })`
    // — makes sdk send `{"model":"m"}`, which the Messages API rejects for a
    // missing required param, while cli serves it happily. An earlier test here
    // asserted that as CORRECT. It was a divergence, and it is now refused.
    readable = destructurableKeys(params);
    sent = sdkVisibleKeys(params);
  } catch {
    // A Proxy's ownKeys trap, or a throwing prototype getter, may fail here.
    // Unknowable is not clean.
    return {
      param: '(params)',
      kind: 'unresolvable',
      why: 'enumerating the params threw, so which params this call carries is unknown',
    };
  }
  if (readable === null) {
    return {
      param: '(params)',
      kind: 'unresolvable',
      why: 'the prototype chain did not terminate (a Proxy may return itself from its '
        + '`getPrototypeOf` trap), so which params this call carries cannot be established',
    };
  }
  // A `toJSON` ANYWHERE ON THE CHAIN makes the sdk's wire shape undecidable
  // from the keys: `JSON.stringify` calls it and sends WHATEVER IT RETURNS, so
  // `sent` is a fiction. Measured 2026-11-15 — a params object with a `toJSON`
  // returning `{ system: 'SNEAKY', … }` puts `system` on the sdk wire while
  // none of the keys say so. Not refused as a param (it is not one); refused
  // because this oracle cannot answer, which is the `unresolvable` verdict's
  // whole purpose. Raised by the round-5 audit.
  //
  // CALLABILITY, not merely the name: `JSON.stringify` invokes a resolved
  // `toJSON` only if it is a function. Measured 2026-11-15 —
  // `{ x: 1, toJSON: null }` serialises as `{"x":1,"toJSON":null}`, and an own
  // `toJSON: undefined` shadowing an inherited method serialises ordinarily.
  // The first cut keyed on the key's presence and refused both, which is a
  // false positive on a request with a perfectly ordinary wire shape
  // (round-6 audit).
  if (readable.has('toJSON')) {
    let toJson;
    try {
      toJson = params.toJSON;
    } catch {
      return {
        param: 'toJSON',
        kind: 'unresolvable',
        why: 'reading `toJSON` off the params threw, so whether the sdk backend will serialise '
          + 'this object or whatever that hook returns cannot be established',
      };
    }
    if (typeof toJson === 'function') {
      return {
        param: 'toJSON',
        kind: 'unresolvable',
        why: 'the params carry a callable `toJSON`, so what the sdk backend serialises is '
          + 'whatever that method returns rather than the keys on this object — the two '
          + 'backends cannot be compared from the params at all',
      };
    }
  }
  const divergent = [];
  const offending = [];
  for (const key of readable) {
    // A symbol key never reaches the wire and cannot be named in a remedy.
    if (typeof key === 'symbol') continue;
    // MEMBERSHIP BEFORE VALUE. The previous order read `params[key]` first, so
    // an inherited getter for a key NEITHER backend reads — a `temperature`
    // getter, say — was invoked anyway: it could throw (measured: the oracle
    // crashed instead of returning a verdict) or run a side effect for a key
    // about to be ignored. Round-5 audit. A check that can be turned into an
    // exception by the object it is checking is not a check.
    const isSent = sent.has(key);
    const isRead = CLI_READ_PARAMS.includes(key);
    if (!isSent && !isRead) continue;
    // AN ACCESSOR IS NOT READ. Its value is whatever it returns on the NEXT
    // read, which is the adapter's, so a check based on this read would be
    // validating a different call from the one that gets sent.
    if (isAccessorBacked(params, key)) {
      if (!isSent) { divergent.push(key); continue; }
      if (SERVICEABLE_CLI_PARAMS.includes(key)) continue;
      offending.push(key);
      continue;
    }
    let value;
    try {
      value = params[key];
    } catch {
      // A getter that throws leaves this call's shape unknown. Fail closed,
      // and say which key could not be read rather than guessing past it.
      return {
        param: key,
        kind: 'unresolvable',
        why: `reading \`${key}\` off the params threw, so what this call carries cannot be `
          + 'established — a getter on the request (or on its prototype) decides the answer',
      };
    }
    if (isAbsent(key, value)) continue;
    // DIVERGENCE FIRST, for any key the cli adapter actually DESTRUCTURES,
    // allowlisted ones included: a param cli reads and sdk will not send is
    // the two backends answering different calls, which is the thing this
    // module is for. Reported before the allowlist so the message names the
    // real defect rather than the param's name.
    //
    // Scoped to `CLI_READ_PARAMS` after round 4: an inherited key the adapter
    // never names — `temperature`, say — is read by NEITHER backend, so
    // flagging it was a false positive. A key that is not sent AND not read is
    // simply not part of this call.
    if (!isSent) { divergent.push(key); continue; }
    if (SERVICEABLE_CLI_PARAMS.includes(key)) continue;
    offending.push(key);
  }
  if (divergent.length) {
    divergent.sort();
    const param = divergent[0];
    const rest = divergent.slice(1);
    const base = 'the cli backend can READ this param and the sdk backend will not SEND it — '
      + '`claude -p` is driven by a destructure, which walks the prototype chain and ignores '
      + 'enumerability, while the sdk serialises own enumerable properties only. So the two '
      + 'backends would answer different calls, which is the divergence this seam exists to '
      + 'refuse. Make it an own enumerable property of the params object';
    return {
      param,
      kind: 'divergent',
      why: rest.length ? `${base} (same for \`${rest.join('`, `')}\`)` : base,
    };
  }
  if (offending.length === 0) return null;
  // Deterministic order: the named params first, in their documented order, so
  // the message a reader sees does not depend on key-insertion order.
  const named = Object.keys(UNREPRESENTABLE_REASONS);
  const rank = (k) => (named.indexOf(k) < 0 ? named.length : named.indexOf(k));
  offending.sort((a, b) => (rank(a) - rank(b)) || a.localeCompare(b));
  const param = offending[0];
  const base = UNREPRESENTABLE_REASONS[param] ?? genericReason(param);
  const rest = offending.slice(1);
  return {
    param,
    kind: 'unrepresentable',
    // Every offending param is named, not just the first: a caller that drops
    // the one in the message and retries should not meet a second refusal it
    // could have been told about the first time.
    why: rest.length ? `${base} (this call also passes \`${rest.join('`, `')}\`)` : base,
  };
}

/**
 * The error a cli-backed `messages.create()` must raise for an unserviceable
 * call, or `null` when the call may proceed on cli.
 *
 * **One verdict, not two.** The earlier version branched on whether `cli` was
 * explicit (throw) or ambient (route to sdk with a once-per-param warning),
 * mirroring `reconcileBackendWithBaseUrl`. That symmetry was the wrong one to
 * copy: a baseURL names a DESTINATION the operator chose, so coercing the
 * transport still reaches it, whereas `system` names a BILLABLE contract the
 * call site never made a transport decision about. Both cases now throw, and
 * the message carries the same remedy, because the remedy is the same: pin the
 * call site.
 *
 * Message shape is deliberate — the param, the measured reason, and the exact
 * code change — so the throw is actionable from a log line alone, without
 * reading this module. An `unresolvable` verdict is worded as its own fact: it
 * is not a claim about a param, it is a refusal to guess.
 *
 * @param {object} params - the `messages.create()` params
 * @returns {{param: string, kind: string, message: string}|null}
 */
export function cliFaithfulnessVerdict(params) {
  const unserviceable = unserviceableCliParams(params);
  if (!unserviceable) return null;
  const { param, why, kind } = unserviceable;
  if (kind === 'divergent') {
    return {
      param,
      kind,
      message: `[anthropic-client] \`${param}\` would reach the cli backend but NOT the sdk `
        + `backend — ${why}. This is not a report that cli cannot honour the param: the two `
        + 'transports would answer different calls, which is worse, because the one that '
        + 'silently answers the wrong call is whichever the operator happens to be on. Pin '
        + "this call site with createAnthropicClient({ backend: 'sdk' }) if you want the sdk's "
        + 'reading, or assign the param directly onto the params object so both see it.',
    };
  }
  if (kind === 'unresolvable') {
    return {
      param,
      kind,
      message: '[anthropic-client] the cli backend cannot establish which params this call '
        + `carries — ${why}. This is NOT a report that a named param is unhonourable: it is `
        + 'a refusal to guess, and it fails closed for that reason. Pin this call site with '
        + "createAnthropicClient({ backend: 'sdk' }), or pass a plain params object whose "
        + 'keys can be read.',
    };
  }
  return {
    param,
    kind,
    message: `[anthropic-client] the cli backend cannot honour \`${param}\` — ${why}. `
      + `Pin this call site with createAnthropicClient({ backend: 'sdk' }), or drop `
      + `\`${param}\`. The cli backend serves ${SERVICEABLE_CLI_PARAMS.join(', ')} and `
      + 'refuses every other param by default, so one the Messages API gains later is '
      + 'refused on arrival rather than dropped silently. It is never chosen implicitly '
      + 'for a call it would answer off-contract, and it is not silently swapped for sdk '
      + 'either: which meter a call bills is a decision the call site declares.',
  };
}
