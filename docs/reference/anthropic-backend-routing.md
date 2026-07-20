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
