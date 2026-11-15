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
 * @returns {{param: string, why: string, kind: 'unrepresentable'|'unresolvable'}|null}
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
  let keys;
  try {
    keys = Reflect.ownKeys(params);
  } catch {
    // A Proxy's ownKeys trap may throw. Unknowable is not clean.
    return {
      param: '(params)',
      kind: 'unresolvable',
      why: 'enumerating the params threw, so which params this call carries is unknown',
    };
  }
  const offending = [];
  for (const key of keys) {
    // A symbol key never reaches the wire and cannot be named in a remedy.
    if (typeof key === 'symbol') continue;
    if (SERVICEABLE_CLI_PARAMS.includes(key)) continue;
    if (isAbsent(key, params[key])) continue;
    offending.push(key);
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
