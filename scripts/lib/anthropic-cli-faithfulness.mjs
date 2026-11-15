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
 * Parameters the `cli` backend accepts and then quietly fails to honour.
 *
 * Measured 2026-11-14 (docs/plans/anthropic-cli-faithfulness-routing.md §6.B):
 *
 *   - `system` — `claude -p` receives it as `--system-prompt`, but the Claude
 *     Code agent persona plus its ~164,000-token auto-discovered project
 *     context outrank it. On `normalize-intent`'s own call shape the cli
 *     backend emitted **1995 output tokens in 40.0s against
 *     `max_tokens: 200`**, opening "I haven't changed anything. This session
 *     has no file-edit or shell tools … AGENTS.md requires …", where the sdk
 *     backend returned the requested one-line sentence in 29 tokens and 1.3s.
 *     Confirms the 2026-07-19 observation recorded at
 *     scripts/lib/arch-memory/normalize-intent.mjs:262-269, and post-dates the
 *     `--tools ''` fix, so disabling tools did not make `claude -p` terse.
 *
 *   - `tools` / `tool_choice` — dropped outright: the adapter always spawns
 *     `--tools ''`. A caller forcing `tool_choice` gets a plain text block back
 *     with NO error. AGENTS.md records this costing the tiered-recall discovery
 *     generator a whole shadow window (20/20 runs fell back to legacy).
 *
 * **The membership test — apply this to any new param.** Does the param being
 * unmet change the ANSWER the caller receives?
 *   - `system` unmet → a different KIND of answer than was asked for. The
 *     consumer's parse then fails, or succeeds on garbage:
 *     `arm-eval/judge.mjs` records it as `conformant: false`, scoring its own
 *     transport failure as a model failure.
 *   - `tools`/`tool_choice` unmet → a text block where a tool call was
 *     demanded. Structurally the wrong shape.
 *   - `max_tokens` unmet → **the answer the caller asked for**, possibly more
 *     of it than was budgeted. The content is not wrong.
 *
 * So `max_tokens` is NOT in the refusal set. It is equally unenforced on cli —
 * accepted and ignored, measured above, and the adapter warns once per session —
 * but *every* caller sets it (the Messages API requires it), so refusing on it
 * would refuse every call, collapsing the routing into "cli is never usable".
 * That would void an operator's transport choice for the calls cli serves
 * correctly and move all of their spend off the Max 20x credit. What covers the
 * real risk an unenforced ceiling carries is a consumer that NOTICES truncation:
 * `assessBatchCompleteness` in scripts/symbol-index/summarise.mjs reads
 * `stop_reason` and reports an incomplete batch rather than a silently short
 * answer. A `CLAUDE_CLI_STRICT_MAX_TOKENS` env opt-in was implemented and then
 * removed (2026-11-15): it was a second routing dial for a param whose being
 * unmet does not change the answer, and no call site asked for it.
 *
 * @param {object} params - the `messages.create()` params
 * @returns {{param: string, why: string}|null} null when cli can serve the call
 */
export function unserviceableCliParams(params) {
  if (typeof params?.system === 'string' && params.system.trim()) {
    return {
      param: 'system',
      why: 'the cli backend does not honour `system` as an instruction — the '
        + '`claude -p` agent persona and its auto-discovered project context '
        + 'outrank it (measured: 1995 output tokens against a 200 ceiling)',
    };
  }
  if (Array.isArray(params?.system) && params.system.length) {
    return {
      param: 'system',
      why: 'the cli backend takes `--system-prompt` as a single string and does '
        + 'not honour a structured system block as an instruction',
    };
  }
  if (params?.tools !== undefined) {
    return {
      param: 'tools',
      why: "the cli backend spawns `claude -p --tools ''` and drops tool "
        + 'definitions silently, returning a plain text block with no error',
    };
  }
  if (params?.tool_choice !== undefined) {
    return {
      param: 'tool_choice',
      why: 'the cli backend drops forced tool-calling silently — a caller '
        + 'forcing `tool_choice` gets a text block back and no error',
    };
  }
  return null;
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
 * reading this module.
 *
 * @param {object} params - the `messages.create()` params
 * @returns {{param: string, message: string}|null}
 */
export function cliFaithfulnessVerdict(params) {
  const unserviceable = unserviceableCliParams(params);
  if (!unserviceable) return null;
  const { param, why } = unserviceable;
  return {
    param,
    message: `[anthropic-client] the cli backend cannot honour \`${param}\` — ${why}. `
      + `Pin this call site with createAnthropicClient({ backend: 'sdk' }), or drop `
      + `\`${param}\`. The cli backend is never chosen implicitly for a call it `
      + `would answer off-contract, and it is not silently swapped for sdk either: `
      + `which meter a call bills is a decision the call site declares.`,
  };
}
