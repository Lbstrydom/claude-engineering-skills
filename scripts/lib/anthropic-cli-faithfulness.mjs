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
 * So `max_tokens` is not in the refusal set by default. It is equally
 * unenforced on cli — accepted and ignored, measured above — but *every* caller
 * sets it (the Messages API requires it), so refusing on it would refuse every
 * call, collapsing the routing into "ambient cli always means sdk". That would
 * void an operator's explicit transport choice for the calls cli serves
 * correctly and move all of their spend off the Max 20x credit.
 *
 * **`CLAUDE_CLI_STRICT_MAX_TOKENS=1` is the operator's opt-in to the other
 * side of that trade** (adjudicated 2026-11-14, GPT ruling `compromise`): an
 * unenforced ceiling IS a real cost/runaway risk even when it is not a semantic
 * contract, and a once-per-session warning gives nobody control over it. Set
 * it and a `max_tokens` call becomes unserviceable on cli, routing to the
 * backend that honours it. Default off, so billing is unchanged unless the
 * operator chooses otherwise — the choice is theirs, not this module's. A
 * per-call `requireMaxTokens` option was rejected as an abstraction no current
 * call site needs; if one ever does, it belongs here, beside this.
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
  // Checked LAST, so the diagnostics for the three answer-changing params are
  // never shadowed by the opt-in cost guard.
  if (params?.max_tokens !== undefined && strictMaxTokensRequested()) {
    return {
      param: 'max_tokens',
      why: 'CLAUDE_CLI_STRICT_MAX_TOKENS is set, and the cli backend does not '
        + 'enforce an output ceiling — it accepts `max_tokens` and ignores it '
        + '(measured: 2254-2784 output tokens against a 200 ceiling), so the '
        + 'budget this call asked for can only be honoured by the sdk backend',
    };
  }
  return null;
}

/**
 * Has the operator opted into treating an unenforceable output ceiling as
 * unserviceable? Read per call, not cached at module load, so a test (and a
 * long-lived process whose env changes) sees the current value.
 *
 * Only `1` and `true` enable it. An unrecognised value reads as OFF rather than
 * throwing: unlike `CLAUDE_BACKEND`, where a typo silently routes billing to
 * the wrong meter, the safe reading here is "leave the operator's billing as it
 * is" — turning strictness ON by accident is what would move their spend.
 */
function strictMaxTokensRequested() {
  const raw = String(process.env.CLAUDE_CLI_STRICT_MAX_TOKENS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * What the cli adapter must DO about an unserviceable call — the precedence
 * rule, kept in the same module as the decision so one import carries the whole
 * policy and a call site cannot adopt half of it.
 *
 * Precedence mirrors `reconcileBackendWithBaseUrl` exactly, because the
 * situation is the same shape — the caller's stated intent against an ambient
 * env choice:
 *
 *   - **explicit `backend:'cli'`** → `throw`. The caller contradicted itself,
 *     just as with an explicit `cli` plus a custom `baseURL`.
 *   - **ambient `CLAUDE_BACKEND=cli`** → `route` the call to sdk and name the
 *     reason once. The caller never asked for this transport, and an operator's
 *     env default is not a licence to return an answer that fails the call's
 *     own contract.
 *   - **serviceable** → `null`, i.e. spawn `claude -p` unchanged. This is the
 *     high-volume half of the call-site census and it keeps the Max 20x
 *     credit; the `BILLING PIN` test is the control that it stayed that way.
 *
 * @param {object} params - the `messages.create()` params
 * @param {{backendWasExplicit?: boolean}} [opts]
 * @returns {{action: 'throw'|'route', param: string, message: string}|null}
 *   null when the call may proceed on cli.
 */
export function cliFaithfulnessVerdict(params, opts = {}) {
  const unserviceable = unserviceableCliParams(params);
  if (!unserviceable) return null;
  const { param, why } = unserviceable;
  if (opts.backendWasExplicit) {
    return {
      action: 'throw',
      param,
      message: `[anthropic-client] backend:'cli' cannot honour \`${param}\` — ${why}. `
        + `Use backend:'sdk' for this call, or drop \`${param}\`.`,
    };
  }
  return {
    action: 'route',
    param,
    message: `  [anthropic-client] \`${param}\` set → using the sdk backend despite `
      + `CLAUDE_BACKEND=cli. ${why}. Honouring the ambient backend would return `
      + `an answer that does not meet the call's contract.\n`,
  };
}
