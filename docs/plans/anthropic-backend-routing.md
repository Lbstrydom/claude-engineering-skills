# Plan: Anthropic Backend Routing (Agent SDK credit prep)

- **Date**: 2026-05-14
- **Status**: Implemented — submitted for /audit-code
- **Author**: Claude + Louis
- **Scope**: backend
- **Target domain(s)**: `shared-lib`, `docs`
- **Motivation**: Anthropic announced a $200/mo Max 20x Agent SDK credit
  effective 2026-06-15 that covers `claude -p` headless usage but NOT raw
  `@anthropic-ai/sdk` API calls. Prepare the codebase so a single env flag
  flip (`CLAUDE_BACKEND=cli`) routes all Claude calls onto the credit when
  it activates, without touching call-site code.

> **Neighbourhood considered** — no existing factory abstraction for
> Anthropic clients; current call sites each construct `new Anthropic()`
> ad-hoc. No high-similarity matches.

---

## 0. TL;DR

Add a pluggable Anthropic client factory (`scripts/lib/anthropic-client.mjs`)
with two backends, behind env flag `CLAUDE_BACKEND`:

| Backend | Transport | Bills against |
|---|---|---|
| `sdk` (default) | `@anthropic-ai/sdk` direct API | `ANTHROPIC_API_KEY` token meter |
| `cli` | `claude -p --output-format json` subprocess | Max 20x Agent SDK credit ($200/mo from 2026-06-15) |

Both expose identical `.messages.create({model, max_tokens, system, messages})`
shape, so call sites swap `new Anthropic({apiKey})` → `await createAnthropicClient()`
with no other changes. Default stays `sdk` until the credit redeem flow
opens; flip per-env at that point.

Migrate the two highest-volume direct call sites now to prove the pattern;
remaining call sites listed in AGENTS.md "Pending migration" subsection
for follow-up PRs.

---

## 1. Context Summary

**Current state**: ~8 scripts directly construct `new Anthropic()` and call
`anthropic.messages.create()`. Every Claude API call bills against
`ANTHROPIC_API_KEY` per-token.

**Target state**: All Claude calls flow through a single factory. The
factory swaps transport based on `CLAUDE_BACKEND`. Default behaviour is
unchanged (`sdk` backend = identical to today). When `cli` is selected,
the same call sites transparently route through `claude -p` and bill the
Agent SDK credit instead.

**Why now, even though credit is 1 month out**: the abstraction is
risk-reducing (single chokepoint, factory-cached, fully tested) and the
migration is mechanical (drop-in swap). Landing it now means June 15 is a
1-line `.env` change, not a multi-file edit under deadline pressure.

---

## 2. Deliverables

### 2.1 New file: `scripts/lib/anthropic-client.mjs`

Exports:
- `createAnthropicClient(options?) → Promise<{messages: {create}}>`
  - Caches one client per `(backend, apiKey, claudeBin)` key; `fresh: true` bypasses.
  - `backend` option overrides env; defaults to `resolveBackend()`.
- `resolveBackend() → 'sdk' | 'cli'`
  - Reads `process.env.CLAUDE_BACKEND`, case-insensitive, defaults to `sdk`.
  - Invalid value → warn to stderr, fallback to `sdk` (no throw).
- `_resetClientCache()` — test-only, clears the cache.
- `_internals` — `{buildPromptFromMessages, normaliseCliOutput, createCliAdapter, quoteWinArg}` for tests.

**CLI adapter contract**:
- `messages.create(params, requestOptions?)` mimics raw SDK shape.
- `params`: `{model?, max_tokens?, system?, messages}`.
- `requestOptions.signal?: AbortSignal` — aborting kills the child with SIGTERM.
- Returns `{content: [{type:'text', text}], usage: {input_tokens, output_tokens}, model, stop_reason, _meta: {cost_usd?, duration_ms?, num_turns?}}`.
- Prompt content is piped via **stdin** (not argv) so arbitrary user text never traverses a shell quoting layer.
- Spawns `claude -p --output-format json --max-turns 1 [--system-prompt VAL] [--model VAL]`.

**Windows correctness**:
- `claude` ships as `claude.cmd` wrapper on Windows; `spawn` cannot invoke `.cmd` without `shell: true`.
- With `shell: true`, Node does NOT auto-quote args. A `--system-prompt "be brief"` would split into `'be'` + `'brief'` without quoting.
- Solution: `quoteWinArg()` implements CommandLineToArgvW-compatible quoting (double-quotes, escaped internal quotes, doubled backslashes-before-quote), and we pass `windowsVerbatimArguments: true` so Node doesn't re-quote.

**Lazy SDK import**: `@anthropic-ai/sdk` is only imported when `sdk` backend is selected, so a `cli`-only deployment doesn't pay the load cost.

### 2.2 Migrated call sites

| File | Change |
|---|---|
| [scripts/lib/llm-wrappers.mjs](../../scripts/lib/llm-wrappers.mjs) | JSDoc updated to note `callClaude` accepts both raw SDK and factory adapters (same shape). No code change. |
| [scripts/lib/context.mjs](../../scripts/lib/context.mjs) | `_llmCondense` brief generator — `new Anthropic({apiKey})` → `await createAnthropicClient()`. Env gate widened to `ANTHROPIC_API_KEY || CLAUDE_BACKEND === 'cli'`. |
| [scripts/lib/neighbourhood-query.mjs](../../scripts/lib/neighbourhood-query.mjs) | Haiku rephrase path — same swap; bug fix as side-effect (old code created the client before the env gate, factory creation now correctly gated). |

### 2.3 Tests: `tests/anthropic-client.test.mjs`

26 tests covering:
- `resolveBackend()` — default, accepted values, case-insensitivity, invalid fallback.
- `buildPromptFromMessages()` — string content, array content with image blocks, empty messages, type validation.
- `normaliseCliOutput()` — happy-path JSON envelope, missing fields, empty result, malformed JSON, model resolution.
- `quoteWinArg()` — alphanumeric pass-through, space-wrapping, embedded-quote escaping, backslash-before-quote doubling, cmd metacharacter quoting, empty input.
- `createAnthropicClient()` (cli backend) — end-to-end roundtrip via fake CLI shim that reads stdin + dumps argv for verification, cache hit/miss, fresh-bypass, non-zero exit handling.
- `createAnthropicClient()` (sdk backend) — error path when API key missing.

Tests use a generated fake CLI binary (`.cmd` wrapper on Windows, shell script otherwise) so no real network or Claude installation is required.

### 2.4 CLI: `scripts/anthropic-ping.mjs` (+ `npm run anthropic:ping`)

Sends a 1-token "ping" prompt via whichever backend resolves, prints JSON
with response, usage, latency, and cost. Exits non-zero on any error. For
operator pre-flight before flipping `CLAUDE_BACKEND` in production.

### 2.5 Docs

- `.env.example` — `CLAUDE_BACKEND`, `CLAUDE_BIN` entries with rationale.
- `AGENTS.md` — new "Anthropic Backend Routing" section. Includes pending-migration list (5 remaining call sites) and operator migration recipe.

---

## 3. Non-goals (deferred)

- Migrating the 5 remaining direct-SDK call sites (summarise.mjs,
  summarise-domains.mjs, refine-prompts.mjs, evolve-prompts.mjs,
  gemini-review.mjs Opus fallback). Drop-in swap once pattern is proven.
- Prompt-caching (`cache_control`) on system prompts. The current
  prompts (BRIEF_SYSTEM_PROMPT ~900 chars, neighbourhood failure-mode
  prompt ~250 chars) fall under Anthropic's 1024-token caching threshold,
  so caching wouldn't apply.
- Installing `@anthropic-ai/claude-agent-sdk` Node package as a peer.
  The `cli` backend already covers the same use case via the stable
  `claude -p` interface; adding the Node SDK is a separate evaluation.
- Touching the ai-organiser repo. That repo has `@anthropic-ai/sdk` as
  devDependency only (no runtime Claude usage); its burn is interactive
  Claude Code, not API spend, so different mitigation.

---

## 4. Acceptance Criteria

1. **Factory works for sdk backend** — `npm run anthropic:ping` returns
   non-empty response with `ANTHROPIC_API_KEY` set and `CLAUDE_BACKEND`
   unset. (Verified: response "pong", 1060ms.)
2. **Default behaviour unchanged** — all existing tests pass; no test
   file references the factory except the new one.
3. **All 26 new tests pass** on Windows. (Verified.)
4. **No raw `new Anthropic()` left in migrated files** (context.mjs,
   neighbourhood-query.mjs) — grep returns 0 matches in those two files.
5. **Migrated files still parse and import cleanly** — `node -e
   "import('./scripts/lib/context.mjs')"` etc. exit 0. (Verified.)
6. **Windows arg-quoting is CommandLineToArgvW-correct** — `quoteWinArg`
   tests cover quote escaping, backslash doubling, and metacharacter
   handling.
7. **Prompt content never traverses a shell** — `cli` adapter pipes
   prompt via stdin; the `--system-prompt` value (controlled by app code,
   not user input) is the only arg that may contain whitespace, and is
   protected by `quoteWinArg` on Windows.
8. **AbortSignal honoured** — passing `{signal}` to `.messages.create()`
   kills the spawned child process; existing call sites that use
   `AbortController` (summarise-domains.mjs) work unchanged when migrated.

---

## 5. Risk register

| Risk | Mitigation |
|---|---|
| `claude -p --output-format json` output schema changes | Stable per Claude Code docs; defensive parsing (`Number(...)||0` etc.) in `normaliseCliOutput`. |
| Subprocess spawn latency vs API latency | `sdk` is default; operators flip `cli` only post-2026-06-15 when credit savings outweigh latency. |
| Windows arg-injection via untrusted `--system-prompt` | Prompts come from application code, never user input. Belt-and-braces: `quoteWinArg` + `windowsVerbatimArguments: true`. |
| `claude` binary not on PATH | Factory throws clear error; `cli` backend opt-in only. |
| Module-global client cache leaks between test cases | `_resetClientCache()` exported and called in `beforeEach`/`afterEach`. |

---

## 6. Rollout

1. **Today**: merge with `CLAUDE_BACKEND` unset everywhere. Behaviour
   identical to pre-change (sdk backend).
2. **2026-06-15** (credit activates): set `CLAUDE_BACKEND=cli` in the
   `.env` of repos that want to draw from the credit. Verify via
   `npm run anthropic:ping`. Revert by unsetting if any issues.
3. **Follow-up PR**: migrate the 5 remaining call sites listed in
   AGENTS.md. Drop-in swap, no design changes.
