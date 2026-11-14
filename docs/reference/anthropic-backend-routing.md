# Anthropic backend routing — operational reference

**What it is.** All Claude API calls in this repo go through one seam,
[`scripts/lib/anthropic-client.mjs`](../../scripts/lib/anthropic-client.mjs).
The `CLAUDE_BACKEND` env var switches the underlying transport without touching
any call site.

**When you need this file.** Adding a new Claude call site, debugging a backend
that silently returns the wrong shape, or working out which meter a scripted job
is billing. The load-bearing invariants — the backend table, the
`isClaudeAvailable()` gate, and the forced-tool-calling gotcha — are stated in
[AGENTS.md](../../AGENTS.md); everything below is the operational depth.

## Backends

| Backend | Transport | Bills against | Use when |
|---|---|---|---|
| `sdk` (default) | `@anthropic-ai/sdk` direct API | `ANTHROPIC_API_KEY` token meter | CI without the `claude` CLI installed; any call that forces `tool_choice` |
| `cli` | `claude -p --output-format json` subprocess | **Before 2026-06-15**: the interactive Max 20x subscription (same pool as IDE sessions). **From 2026-06-15**: the dedicated Max 20x Agent SDK $200/mo credit. | High-volume scripted jobs, to reduce API spend |

**Status (2026-06-29): flipped to `cli` locally.** The 2026-06-15 pool split has
passed, so the cli backend now draws from the dedicated Agent SDK credit rather
than the interactive IDE pool. `CLAUDE_BACKEND=cli` lives in the gitignored
`.env` (per-machine); the committed default stays `sdk` for CI without the
`claude` CLI. Consumers opt in via their own `.env`.

## Cost telemetry — what actually works (corrected 2026-06-29)

The cli backend **self-reports** `cost_usd` plus token `usage` per call, parsed
from `claude -p --output-format json` by `normaliseCliOutput`. That is the
authoritative per-call signal for scripted jobs like `npm run arch:refresh` (12
batched `claude -p` calls on its incremental path).

**Where it lands (2026-09-27).** `normaliseCliOutput` puts the cost on
`usage.provider_cost_usd` as well as `_meta.cost_usd`, and
`buildUsageEvent` ([usage-event.mjs](../../scripts/lib/audit/usage-event.mjs))
reads that field as an exact self-reported cost. Before that it reached only
`_meta`, which only `anthropic-ping.mjs` read, so usage events priced cli calls
from tokens, an estimate rather than the backend's own figure (and, until #120
carried the cli cache counts, one that missed most of the prompt). Pass the
response's `usage` through; don't re-derive a cost from tokens.

**`claude-trace` canNOT meter the scripted cli backend.** Three independent
reasons, each fatal on its own:

- Its interceptor writes log banners to *stdout*, which corrupts the JSON
  envelope the backend parses.
- It emits one JSONL+HTML pair (and attempts a browser open) **per spawned
  process** — useless across a batch.
- Injecting it via `NODE_OPTIONS=--require <loader>` breaks `npm` itself: the
  loader expects to wrap the `claude` entry point, not arbitrary node processes.

`claude-trace` remains the right tool for **interactive** Claude Code sessions —
the shared-pool concern it was installed for. It is installed globally and on
PATH.

The $200 credit is non-rolling and overage requires manually-enabled billing, so
watch the backend's own `cost_usd` on high-volume runs.

## Migration pattern

Call sites use the factory instead of `new Anthropic({apiKey})`:

```js
const { createAnthropicClient } = await import('./anthropic-client.mjs');
const client = await createAnthropicClient();
const resp = await client.messages.create({ model, max_tokens, system, messages });
```

The adapter exposes the same `.messages.create()` shape as the raw SDK, so the
body of every call site stays identical. The factory caches a single client per
`(backend, apiKey, claudeBin)` key for the process lifetime — matching the
"reuse the client created in `main()`" rule in AGENTS.md's Do-NOT list.

**Fully migrated (2026-06-29).** Every Claude call site goes through
`createAnthropicClient()`: `lib/context.mjs`, `lib/neighbourhood-query.mjs`,
`lib/llm-wrappers.mjs`, `symbol-index/summarise{,-domains}.mjs`,
`refine-prompts.mjs`, `evolve-prompts.mjs`, and `gemini-review.mjs` (shadow
client, ping, and the Opus final-review fallback). No bare `new Anthropic()`
remains outside the factory itself — regression-guarded by a `grep` in
[`tests/anthropic-client-migration.test.mjs`](../../tests/anthropic-client-migration.test.mjs).

**Smoke test**: `npm run anthropic:ping` invokes a tiny prompt through whichever
backend the env resolves to.

## The faithfulness refusal: `cli` must not accept a call it cannot honour (2026-11-14)

`cli` already refused what it cannot **represent** (multi-turn histories,
assistant roles, non-text blocks — `assertOneShotTextMessages`) and what it
cannot **target** (a `baseURL` — `reconcileBackendWithBaseUrl`). Both throw.
Three params were the silent third category: accepted, then dropped or
outranked, so the failure surfaced one layer up as a *model* failure.

`unserviceableCliParams` is the single oracle, decided from the params at
`messages.create()` time (the params are not known at construction time).
Precedence mirrors `reconcileBackendWithBaseUrl` exactly, because the situation
is the same shape — the caller's stated intent against an ambient env choice:

| | ambient `CLAUDE_BACKEND=cli` | explicit `backend:'cli'` |
|---|---|---|
| serviceable params | stays on cli, keeps the credit | stays on cli |
| `system` / `tools` / `tool_choice` | **routed to sdk**, warned once per reason | **throws**, naming the param and the remedy |

The refusal set and why each member is in it:

| param | what cli does | measured consequence |
|---|---|---|
| `system` | passed as `--system-prompt`, then outranked by the `claude -p` agent persona and its injected project context | 1995 output tokens in 40.0s against `max_tokens: 200`; a first-person Claude Code reply citing AGENTS.md, where sdk returned the requested one-line sentence in 29 tokens / 1.3s |
| `tools` | dropped — the adapter always spawns `--tools ''` | §"Forced tool-calling" below: 20/20 tiered-recall runs fell back for a whole shadow window |
| `tool_choice` | dropped, no error | same |

`max_tokens` is deliberately **not** in the set. It is equally unenforced on
cli, but *every* caller sets it, so refusing on it would refuse every call —
collapsing this into "ambient cli always means sdk", which voids an operator's
explicit transport choice and moves all spend off the credit. It keeps its own
once-per-session warning instead, reworded to say the ceiling is **accepted and
ignored**, not merely unenforceable.

The `BILLING PIN` test in
[tests/anthropic-cli-faithfulness.test.mjs](../../tests/anthropic-cli-faithfulness.test.mjs)
is the positive control that this did not become "always sdk": a serviceable
call under ambient cli must make **zero** sdk calls. Neutering the oracle fails
10 of the 15 tests in that file and leaves exactly the 5 must-not-fire cases
green.

The `--system-prompt` plumbing in the adapter is **retained though currently
unreachable**: the oracle is the single place that decides, and a `claude -p`
release that honours `system` is a named revert trigger — keeping the plumbing
makes that revert a one-line change rather than a re-implementation.

## `cli`'s cost does not depend on your prompt (measured 2026-11-14)

`claude -p` injects a **~164,000-token** Claude Code system prompt plus
auto-discovered project context on every call, as a 1-hour ephemeral cache
block. The prompt you wrote is a rounding error against it, so **no prompt
change can fix a `cli` cost problem**.

One Haiku summariser call, 9,669-char prompt, identical on both backends
(n=4 each, `claude-haiku-5-5`):

| | sdk | cli |
|---|---|---|
| input tokens | 4,285 (identical every run) | 2 |
| cache create / read | 0 / 0 | 168,679–174,863 / 0 **cold** · ~4,063 / 164,611 **warm** |
| output tokens | 916–1,146 | 1,266–1,452 |
| latency | 4.4–5.5 s | 12.2–14.2 s |
| cost | ~$0.0098 (computed) | **$0.172–0.178 cold · $0.0158 warm** (self-reported) |

17× cold, 1.6× warm, 2.7× latency. `"Reply with exactly the word: pong"` →
`"pong"` costs **$0.654**.

**The output is not the mechanism.** On this shape cli emits only +33% tokens
and obeyed "EXACTLY ONE LINE" 10/10 on both backends. The circumspect-output
complaint is real only where `system` carries the terseness instruction — which
is now refused.

**`--bare` is not the escape hatch.** It skips CLAUDE.md auto-discovery and
would strip the prefix, but per its own `--help` it makes Anthropic auth
"strictly `ANTHROPIC_API_KEY` or apiKeyHelper (OAuth and keychain are never
read)". Measured: it returns `"Not logged in · Please run /login"`, cost $0.
**The only flag that removes the prefix also removes the credit** — a working
`--bare` would bill the API key, i.e. it *is* the sdk backend at 2.7× the
latency. This is why the fix is routing, not flags.

Reproduce: see
[the plan](../plans/anthropic-cli-faithfulness-routing.md#6-measurements) §6.C.
The dollar figures are `claude -p`'s own `total_cost_usd` — the only available
meter for the scripted cli backend, since `claude-trace` corrupts its stdout
envelope.

## Forced tool-calling silently degrades on `cli` (found 2026-07-14)

The `cli` backend's `messages.create()` reads only
`{model, max_tokens, system, messages}`. It **silently drops** `tools` and
`tool_choice` — by design, since it always spawns `claude -p --tools ''`, a
single-shot-text contract.

A caller that needs `tool_choice: {type: 'tool', name: '...'}` for structured
output therefore gets a plain `text` block back **with no error**. The failure
surfaces one layer up, wherever the caller checks for a `tool_use` block — far
from its cause.

This broke the tiered-recall pipeline's Sonnet discovery generator for the
entire 2026-07-13 → 07-14 shadow window: 20 of 20 runs fell back to legacy
before it was root-caused. See
[`docs/plans/tiered-recall-audit-pipeline.md`](../plans/tiered-recall-audit-pipeline.md).

**Rule**: any call site that forces `tool_choice` must pass
`createAnthropicClient({backend: 'sdk'})` explicitly. Never rely on the ambient
`CLAUDE_BACKEND` resolution for that case.

### Forced `tool_choice` is a 400 on Opus 5.5 (and Fable/Mythos 5.1)

`latest-opus` resolves to `claude-opus-5-5` since 2026-09-23, and that model
rejects `tool_choice: {type: 'tool'|'any'}` with HTTP 400. Build the request
with `buildToolUseRequest(model, tool)`
([anthropic-tool-choice.mjs](../../scripts/lib/anthropic-tool-choice.mjs)):
forced where the model accepts it (byte-identical to before), otherwise `auto`
\+ `strict: true` + an `instruction` to append to the **system** prompt. The
predicate is an allowlist (4.x and 5.0), so an unknown id gets `auto`, which
no model rejects. Under `auto` a missing `tool_use` block is possible: report
it as a failure, never as an empty result. Still pin `{backend: 'sdk'}` — the
cli backend drops `tools` either way.
