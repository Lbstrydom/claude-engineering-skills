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

## The faithfulness refusal: `cli` must not accept a call it cannot honour (2026-11-14, reshaped 2026-11-15)

`cli` already refused what it cannot **represent** (multi-turn histories,
assistant roles, non-text blocks — `assertOneShotTextMessages`) and what it
cannot **target** (a `baseURL` — `reconcileBackendWithBaseUrl`). Both throw.
Params it accepts and then drops or outranks were the silent third category:
the failure surfaced one layer up as a *model* failure.

**Say it precisely.** `cli` does **not** ignore `system` — it passes the string
as `--system-prompt`, and a simple instruction is obeyed. What it cannot promise
is that the instruction *wins*: the agent persona and its injected project
context outrank it on a structured-output contract, and the ~164K-token prefix
is on the bill whatever the prompt asks. "Sometimes honoured" is why `system` is
refused rather than merely warned about — a seam cannot tell a simple
instruction from a contract by looking at the params, and the consumer that
parses the answer cannot either. `tools` and `tool_choice` are the stronger
case: those are genuinely dropped.

`unserviceableCliParams` is the single oracle, decided from the params at
`messages.create()` time (the params are not known at construction time).

**It is an ALLOWLIST, not a denylist (2026-11-15).** It asks *"is every param on
this call one `cli` can serve?"*, and the serviceable set is exactly
`model`, `max_tokens`, `messages`. Everything else throws, named or not — so a
param the Messages API gains next month is refused on arrival instead of dropped
silently. The denylist it replaced named three params and had already been
outrun by two: `stream`, passed at one real call site and refused by nothing,
and `output_config`, which did not exist when the three were chosen.
`max_tokens` is the one allowlist entry argued for rather than read off the
adapter — see the membership test below. It is also the one **declared exception to
parity**: the cross-backend contract is about the KIND and SHAPE of the answer,
not about every numeric bound being honoured, so a cli-eligible caller must not
rely on `max_tokens` as a hard bound. Every unpinned site was audited against
that on 2026-11-15 and none does; the finding is recorded per entry in
`.anthropic-pin-census.json`. Params the oracle cannot enumerate
(not a plain object; a `Proxy` that refuses its own keys) get their own verdict
kind and their own wording: *"I cannot tell what this call passes"* is a
different fact from *"this call passes something I cannot honour"*, and one
string for both teaches the reader to dismiss the second.

**THROW AND PIN, never route.**

| | ambient `CLAUDE_BACKEND=cli` | explicit `backend:'cli'` |
|---|---|---|
| serviceable params | stays on cli, keeps the credit | stays on cli |
| any other param (`system`, `tools`, `tool_choice`, `stream`, anything unlisted) | **throws**, naming the param and the pin | **throws**, same message |
| params that cannot be enumerated | **throws**, saying the keys are unknown | **throws**, same message |

The first implementation (2026-11-14) routed an ambient-cli call to sdk with a
once-per-param warning, mirroring `reconcileBackendWithBaseUrl`'s
ambient-coerces / explicit-throws precedence. That symmetry was the wrong one to
copy: **a `baseURL` names a DESTINATION the operator chose, so coercing the
transport still reaches it, whereas `system` names a billable contract the call
site never made a transport decision about.** Routing on it would let a param
decide which meter a call bills, with nothing committed recording which sites
had moved. A pin is declared, greppable, visible in a diff, and gated.

**The pin is enforced before merge, not at run time.** The throw cannot fire in
CI, which runs the committed `sdk` default — so a new unpinned
`system`-passing site would ship green and break only where
`CLAUDE_BACKEND=cli` is set. `npm run anthropic:pin:gate`
([check-anthropic-pins.mjs](../../scripts/check-anthropic-pins.mjs)) is the
guard, in `check:static`. Two rules, because one cannot see both shapes:

- **Rule A** — a file that constructs an unpinned client AND passes an
  unserviceable param literal. Hard failure, no declaration accepted. The param
  question is the oracle's, in two scopes, because a static scan can only ask
  the ALLOWLIST question where it can see a request's WHOLE key set: inside a
  literal `messages.create({…})` **first argument**, every key outside
  `model`/`max_tokens`/`messages` counts, named or not; anywhere else in the
  file only a NAMED unserviceable param (`system`, `tools`, `tool_choice`,
  `stream`) counts, which is what still covers a request staged into a variable
  before the call. Applied file-wide the allowlist would flag every object
  literal in the repo.
- **Rule B** — every unpinned construction is enumerated in the committed
  `.anthropic-pin-census.json` with a reason. Drift-only (a new one fails; a
  stale one fails and asks for a re-baseline), because Rule A is blind to the
  HANDOFF: `evolve-prompts.mjs` hands its client to `llm-wrappers.callClaude`,
  whose call passes `system`, and both halves read clean file-locally. That
  handoff is one of the two sites the census found which a by-hand list missed.
- The one escape from Rule A is `indirectPins`, and it is **verified, not
  trusted**: an entry naming a `via` function (`azure-claude-adapter.mjs`'s
  `clientOptions()`) is checked by re-reading that function for the literal AND
  by confirming every unpinned construction in the file passes it, so the
  declaration cannot outlive the pin it claims nor describe a factory nothing
  calls.
- **It PARSES.** Three versions of this gate were regular expressions and three
  consecutive audit rounds each found a different fail-open shape they could not
  see — shorthand `{ system }`, a spread after the literal, a duplicate key
  where the last wins, a shorthand `{ backend }` that wins at runtime, a nested
  `metadata:{backend:'sdk'}` read as top-level, and a construction two nesting
  levels deep that the construction regex missed **entirely**. Each fix was
  right about the shape it was shown and blind to the next. The module now uses
  the shared [`ast.mjs`](../../scripts/lib/ast.mjs), as five other gates here
  already do.
- **The effective backend is the last TOP-LEVEL `backend`, resolved from the
  argument node**, with three verdicts: `pinned` (a literal `sdk`/`bedrock`,
  last, no spread after it), `cli` (explicitly the transport that cannot honour
  the params — never coverable by a census entry), `unresolved` (absent, a
  non-literal value, a computed key, or a spread after the winner). The
  fail-closed bucket is deliberately large.
- **An unparseable file is UNKNOWN, not clean** — `parsed: false`, and the audit
  fails on it. Otherwise the gate's strongest claim would evaporate on exactly
  the file most likely to be mid-edit.
- **Anything that assigns the key counts**: a computed property (a string
  literal resolves, an expression is unresolved), a getter and a method named
  `backend` all override a literal that came before them. An **aliased** import
  (`createAnthropicClient as mk`, static or destructured from a dynamic
  `import()`) is a construction — a site the enumeration cannot see is absent
  from Rule A *and* Rule B at once, which is the worst failure available to this
  gate.
- **An `indirectPins` claim rests on what the factory RETURNS**, and on every
  return being pinned. A pinned object elsewhere in the function body is a dead
  object vouching for a live override.
- A **dynamic** request key cannot be read, so it fails Rule A — but only in a
  file that also constructs an unpinned client, which is Rule A's own
  condition. Failing closed therefore costs nothing where a pin already exists.
  Its message is worded as a refusal to guess, never as a claim about a named
  param, matching the oracle's `unresolvable` verdict.
- **Argument 0 only.** `create(params, requestOptions)`'s second argument is
  transport options (`{signal}`, `{timeoutMs}`), which `cli` honours. Scanning
  every argument was harmless while the question was "does any key spell
  `system`"; the allowlist made it read `{ signal: ctrl.signal }` as an
  unserviceable param and fail the gate on a correct call. **When a rule's
  question gets stricter, its subject has to get correspondingly exact.**
- Every one of those shapes has a planted RED case in
  `tests/anthropic-pin-census.test.mjs`, and each fix has a negative control.
- A Rule B declaration carries the **COUNT** of unpinned constructions and an
  **`argsDigest`** of their arguments, not just the file. The count alone let a
  declaration clear every construction added later; the count plus the digest
  also catches a REPLACEMENT, which preserves the total while the declared
  reason goes stale. Growth, an unrecorded shrink and a changed shape all fail.
  The digest folds formatting without touching string contents, so
  `mode === 'use cli'` and `mode === 'usecli'` keep different digests — they can
  select different backends. Two structurally identical constructions still
  share a digest, by design: for this gate they are the same shape.
- Every verdict category is **printed**. Two of the seven were counted in `ok`
  and never reported, so the gate could exit 1 with no line saying why — worse
  than no gate. A test reads the CLI's own source to keep that true.

**A pinned site must also change its availability gate.** `isClaudeAvailable()`
answers for the AMBIENT backend, and on a keyless `CLAUDE_BACKEND=cli` install
that answer is `true` — so a pinned site passed the gate and then threw
`ANTHROPIC_API_KEY required` for a backend the operator never selected. Use
**`isClaudeAvailableFor('sdk')`** (same oracle; `isClaudeAvailable()` is now a
thin ambient-resolving wrapper over it). A named backend deliberately does not
re-validate `CLAUDE_BACKEND`, since a pinned call never reads it.

The params with a MEASURED reason of their own. Every other param is refused
too — by the allowlist, with a generic reason naming the serviceable set — so
this table is what the oracle can say more about, not the extent of the refusal:

| param | what cli does | measured consequence |
|---|---|---|
| `system` | **passed** as `--system-prompt` — obeyed for a simple instruction, **outranked** by the `claude -p` agent persona and its ~164K-token injected project context on a structured-output contract, and the prefix is charged either way | the REAL `NORMALIZE_PROMPT`: 1995–2784 output tokens in ~40s against `max_tokens: 200`, a first-person Claude Code reply citing AGENTS.md, where sdk returned the requested one-line sentence in 29–43 tokens / 1.3s. A **shortened** variant of that same prompt: a correct one-line answer **3/3**, still 466–673 output tokens |
| `tools` | dropped — the adapter always spawns `--tools ''` | §"Forced tool-calling" below: 20/20 tiered-recall runs fell back for a whole shadow window |
| `tool_choice` | dropped, no error | same |
| `stream` | accepted and ignored — `claude -p --output-format json` emits one final message, so the caller gets a different response SHAPE | one real call site (`streamAnthropicMessage`, `final-review/transport.mjs`); it never broke because that helper guards for a non-iterable response and falls back, which is also why nothing noticed the seam was refusing nothing |

`max_tokens` is deliberately **not** in the set. It is equally unenforced on
cli, but *every* caller sets it (the Messages API requires it), so refusing on
it would refuse every call — collapsing this into "cli is never usable", which
voids an operator's transport choice and moves all spend off the credit. It
keeps its own once-per-session warning instead, reworded to say the ceiling is
**accepted and ignored**, not merely unenforceable. What covers the real risk is
a consumer that NOTICES truncation: `assessBatchCompleteness`
([summarise.mjs](../../scripts/symbol-index/summarise.mjs)) reads `stop_reason`
and reports an incomplete batch rather than a silently short answer.

**The membership test, for any new param:** does the param being unmet change
the ANSWER the caller receives? `system` unmet gives a different KIND of answer;
`tools`/`tool_choice` unmet gives the wrong SHAPE; `max_tokens` unmet gives the
answer that was asked for, possibly more of it than budgeted — the content is
not wrong.

### `CLAUDE_CLI_STRICT_MAX_TOKENS` — implemented 2026-11-14, REMOVED 2026-11-15

It made a `max_tokens` call unserviceable on cli, routing it to the backend that
honours the ceiling; default off. It was adjudicated out of a round-1 HIGH
(GPT ruling `compromise`) whose own recommendation — refuse whenever
`max_tokens` is supplied — was arithmetically "always sdk".

It is gone, for two reasons the reshape made plain. It was a **second routing
dial** for a param whose being unmet does not change the answer, so it sat on
the wrong side of this rule's own membership test; and once routing itself was
replaced by throw-and-pin, "strict" would have meant *throwing on every cli
call*, which is not a trade an env var should express. No call site ever asked
for it. `tests/anthropic-cli-faithfulness.test.mjs` carries the negative control
for the removal: a stale `CLAUDE_CLI_STRICT_MAX_TOKENS=1` in an operator's shell
must now change nothing, end to end — a removal that left the read in place
would otherwise be invisible.

The `BILLING PIN` test in
[tests/anthropic-cli-faithfulness.test.mjs](../../tests/anthropic-cli-faithfulness.test.mjs)
is the positive control that this did not become "cli is never usable": a
serviceable call under ambient cli must make **zero** sdk calls. Every throw
test asserts zero sdk calls too — without that half, the suite would pass under
the rejected routing design as well, since that design also threw on the
explicit-cli case.

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
