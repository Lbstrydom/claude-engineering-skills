# Plan: the cli backend must refuse a call it cannot faithfully serve

- **Date**: 2026-11-14
- **Status**: Complete — implemented 2026-11-14; written alongside the change
  as the spec `/audit-code` audits the diff against. Every claim is checkable
  against the commit; figures carry their command (§6).
- **Author**: Claude + Louis
- **Scope**: backend (one transport seam + two call-site fixes + AGENTS.md; no UI)

> **Target domain(s)**: `shared-lib`, `symbol-index`
> - ⚠ **Cross-domain** — the routing decision lands once in `shared-lib`
>   (`anthropic-client.mjs`); `symbol-index` gets two call-site fixes that the
>   seam cannot make for it.

---

## 1. Context summary

`CLAUDE_BACKEND` selects the transport for every Claude call behind one seam,
`createAnthropicClient` ([anthropic-client.mjs](../../scripts/lib/anthropic-client.mjs)).
`sdk` is the direct API billing `ANTHROPIC_API_KEY`; `cli` spawns
`claude -p --output-format json` and draws the Max 20x Agent SDK credit.

The complaint that opened this work: CES's Claude calls burn tokens for little
value — reasoning is good, output is circumspect where one line was asked for.

The proposal that opened this work: **invert the default** — make `sdk` the
default at the seam and require an explicit, reasoned opt-in to `cli`.

**That proposal rests on a false premise, and the audit below corrects it.**
The committed default is already `sdk`
(scripts/lib/anthropic-client.mjs:139 (f48d9863) is
`process.env.CLAUDE_BACKEND || 'sdk'` — this plan's own change inserts above
it, so `docs:citations` reports it MOVED against the working tree; the pin is
to the pre-change commit deliberately, because that is the premise being
corrected),
`AGENTS.md:706` documents it as `sdk`, and
tests/anthropic-client.test.mjs:69 (f48d9863) pins it. Flipping the default is a no-op.

The real asymmetry is different, and worth fixing: **`cli` is chosen
env-globally and refused per-call-site.** One `.env` line routes 30 call sites
onto a transport that cannot honour several of the params they send, and the
only correction mechanism is a call site noticing — which is how 13 sites came
to carry a hand-written `{backend:'sdk'}` pin, each with a comment about a
different symptom it hit.

This plan is the structural form of the proposal, with the premise corrected:
not *which backend is the default*, but *which calls a backend is allowed to
accept*.

---

## 2. The audit

### 2.1 Call-site census (measured 2026-11-14, `f48d9863`)

Derived mechanically over `git ls-files -- scripts` (995 `.mjs` files),
excluding the seam itself. **Every line number in this section is pinned to
`f48d9863`** — these references resolve against a moving file, so an unpinned
one decays into wrong-but-resolving (verification-discipline §1). **13 pinned `{backend:'sdk'}`, 17 ambient.** The
incoming audit said 12 and 11.

Pinned (13), each with its stated reason:

| site | stated reason |
|---|---|
| [azure-doctor.mjs:367](../../scripts/azure-doctor.mjs#L367), [:456](../../scripts/azure-doctor.mjs#L456) | Azure route — cli cannot honour a baseURL |
| [campaign.mjs:464](../../scripts/campaign.mjs#L464) | — |
| [legacy-production-audit.mjs:1599](../../scripts/lib/audit/legacy-production-audit.mjs#L1599) | not the ambient backend |
| [final-review/providers.mjs:111](../../scripts/lib/final-review/providers.mjs#L111), [:129](../../scripts/lib/final-review/providers.mjs#L129) | primary reviewer must be sdk |
| [final-review/shadow.mjs:179](../../scripts/lib/final-review/shadow.mjs#L179) | shadow reviewer must be sdk |
| [model-eval/provider-adapter.mjs:197](../../scripts/lib/model-eval/provider-adapter.mjs#L197), [:205](../../scripts/lib/model-eval/provider-adapter.mjs#L205) | both routes, never ambient |
| [remediation-reconcile.mjs:137](../../scripts/remediation-reconcile.mjs#L137) | forced `tool_choice` is silently dropped on cli |
| [solo-control-audit.mjs:1318](../../scripts/solo-control-audit.mjs#L1318), [:2198](../../scripts/solo-control-audit.mjs#L2198) | — |
| [verify-anchor-contract.mjs:570](../../scripts/verify-anchor-contract.mjs#L570) | Sonnet forced tool-calling |

A 14th pins the same way through an injected factory:
[normalize-intent.mjs:271](../../scripts/lib/arch-memory/normalize-intent.mjs#L271).

Ambient (17): [anthropic-ping.mjs:39](../../scripts/anthropic-ping.mjs#L39) ·
[azure-limits.mjs:63](../../scripts/azure-limits.mjs#L63) ·
[evolve-prompts.mjs:395](../../scripts/evolve-prompts.mjs#L395) ·
[arm-eval/judge.mjs:190](../../scripts/lib/arm-eval/judge.mjs#L190) ·
[brainstorm/azure-claude-adapter.mjs:44](../../scripts/lib/brainstorm/azure-claude-adapter.mjs#L44), [:84](../../scripts/lib/brainstorm/azure-claude-adapter.mjs#L84) ·
[context.mjs:301](../../scripts/lib/context.mjs#L301) ·
[final-review/shadow.mjs:137](../../scripts/lib/final-review/shadow.mjs#L137) ·
[neighbourhood-query.mjs:526](../../scripts/lib/neighbourhood-query.mjs#L526) ·
[visual/explain.mjs:63](../../scripts/lib/visual/explain.mjs#L63) ·
[work-unit-labels.mjs:179](../../scripts/lib/work-unit-labels.mjs#L179) ·
[refine-prompts.mjs:152](../../scripts/refine-prompts.mjs#L152) ·
[solo-control-audit.mjs:852](../../scripts/solo-control-audit.mjs#L852) ·
[summarise-domains.mjs:80](../../scripts/symbol-index/summarise-domains.mjs#L80), [:81](../../scripts/symbol-index/summarise-domains.mjs#L81) ·
[summarise.mjs:43](../../scripts/symbol-index/summarise.mjs#L43), [:44](../../scripts/symbol-index/summarise.mjs#L44).

### 2.2 Is the summariser the highest-volume ambient site?

Yes, **with a caveat that is itself a defect**.
`summariseBatch`'s availability gate (scripts/symbol-index/summarise.mjs, at
line 39 before this change) gated on
`!azureConfig.active && !process.env.ANTHROPIC_API_KEY` — precisely the
availability-gate anti-pattern AGENTS.md records ("ask whether a ROUTE exists,
not whether a public env var is set"). With `CLAUDE_BACKEND=cli` and no key the
summariser emits **null summaries** while a fully working backend sits unused,
so the arch-memory index silently loses every `purposeSummary`. With a key
present — the local state — it runs, on `cli`, once per batch of
`ARCH_INDEX_BATCH_SIZE` (default 50) across the whole symbol corpus.

### 2.3 The `normalize-intent` measurement reproduces, and is understated

scripts/lib/arch-memory/normalize-intent.mjs:262-269 (f48d9863) records, from
2026-07-19: 36.3s vs 0.9s, and `system` not honoured as a terse
instruction — an interactive-Claude-Code essay where one line was asked for.
Re-measured today on the same call shape (§6.B): **40.0s vs 1.3s, 1995 output
tokens vs 29, against a `max_tokens: 200` ceiling**, and the cli answer opens
*"I haven't changed anything. This session has no file-edit or shell tools …
AGENTS.md requires …"*. The comment is accurate. Nothing about it has decayed,
including after `--tools ''` landed (2026-07-04, `bb361456`) — which predates
the measurement, so disabling tools did not make `claude -p` terse.

### 2.4 What actually burns the tokens — the premise correction that matters

The incoming audit attributes the burn to circumspect output. On the
summariser that is **measurably not the mechanism** (§6.A): output is +33% and
the "EXACTLY ONE LINE" instruction was obeyed 10/10 on both backends.

The burn is on the **input** side. `claude -p` injects a **~164,000-token**
Claude Code system prompt plus auto-discovered project context on *every*
call, as a 1-hour ephemeral cache block. Measured cold: 168,679–174,863
cache-creation tokens for one Haiku summariser call, **$0.172–0.178**
self-reported, against ~$0.0098 for the identical prompt on sdk — **17×**.
Warm (inside the 1h window): 164,611 cache-read + ~4,063 cache-create,
**$0.0158** — still 1.6×, and 2.7× the latency.

A 6-token exchange makes this unmissable: `"Reply with exactly the word: pong"`
→ `"pong"` costs **$0.654** on cli (163,589 cache-creation tokens), and
**$0.052** on Haiku warm-ish. There is no prompt-engineering fix for a cost
that does not depend on the prompt.

### 2.5 `--bare` is falsified, so "keep the credit, lose the prefix" does not exist

`claude -p --bare` skips CLAUDE.md auto-discovery and would strip the prefix.
It also, per its own `--help`, makes "Anthropic auth strictly
`ANTHROPIC_API_KEY` or apiKeyHelper (OAuth and keychain are never read)".
Measured: `--bare` returns `"Not logged in · Please run /login"`, cost $0. So
the one flag that removes the prefix also removes the Max credit — a working
`--bare` would bill the API key, i.e. it *is* the sdk backend at 2.7× the
latency. This closes off the narrower alternative and is why the fix has to be
about routing, not flags.

### 2.6 The measured defect is live and unpinned at four sites

Four ambient sites pass `system`. Three have a tight output contract, so the
§2.3 failure is not hypothetical for them:

| site | `max_tokens` | contract | consequence under `cli` |
|---|---|---|---|
| [arm-eval/judge.mjs:190](../../scripts/lib/arm-eval/judge.mjs#L190) | 4000 | *"Return ONLY the requested JSON object — no prose"* | `extractJsonObject` finds none → `{conformant:false, error:'judge returned no JSON'}`. **A transport failure wearing a model failure's clothes** — the judge is scored as non-conformant |
| [work-unit-labels.mjs:179](../../scripts/lib/work-unit-labels.mjs#L179) | **64** | one short label | ceiling ignored; an essay truncated to `MAX_LABEL_CHARS` becomes "the label" |
| [refine-prompts.mjs:152](../../scripts/refine-prompts.mjs#L152) | 2000 | structured refinement | prose |
| [context.mjs:301](../../scripts/lib/context.mjs#L301) | 2000 | brief | prose — least harmful, the output is free-form |

`judge.mjs` is the sharpest: it is an impartial-judge harness whose verdicts
feed arm-eval, and on the ambient `cli` backend it records calibration
failures that are entirely the transport's.

---

## 3. Design

### 3.1 Why not the three obvious alternatives

**Band-aid — pin the 17 ambient sites.** Makes correctness a property of 17
call sites, which is the state we are in: 13 sites already pinned, one burn at
a time, and site 18 arrives unpinned. This file already contains the verdict
on that approach, written after the identical failure with Azure routes
(`anthropic-client.mjs`, the "Why the default flipped" comment): *"Requiring
every call site to pass the route made correctness a property of 30-odd call
sites instead of this seam, and it failed exactly as that predicts: five
separate fixes patched individual sites while new bare calls kept appearing."*
Repeating it knowingly would be the band-aid.

**As-proposed — make the seam ignore ambient `cli` unless opted into.** It is
one seam and it does reach every future site, but it silently voids an
operator's explicit `CLAUDE_BACKEND=cli`. AGENTS.md already classes silently
ignoring an operator's explicit transport choice as a *misroute*, not a
degradation (the baseURL rule in the same file). It also moves **all** Claude
spend from the subscription to the API meter, including the calls `cli` serves
perfectly well — §4 prices that. And it makes `npm run anthropic:ping`, whose
entire job is to exercise the ambient backend, stop testing anything.

**Over-built — a capability-negotiation layer, a per-site policy table, or a
routing config file.** No current requirement needs a table: the set of params
`cli` cannot honour is small, closed, and already enumerated in this very file
as warnings and throws.

### 3.2 The change: faithfulness is the transport's own precondition

> **A backend must not accept a call whose parameters it cannot honour.**

`cli` already refuses what it cannot *represent* — multi-turn histories,
assistant-role messages, non-text blocks (`assertOneShotTextMessages`), a
`baseURL` (`reconcileBackendWithBaseUrl`). Those throw. The gap is the params
it accepts and then quietly fails to honour:

| param | today | measured consequence |
|---|---|---|
| `system` | passed as `--system-prompt`, outranked by the Claude Code persona | §2.3: 69× output tokens, instruction ignored |
| `tools` / `tool_choice` | **silently dropped** (`--tools ''`) | AGENTS.md: 20/20 tiered-recall runs fell back to legacy for a whole shadow window |
| `max_tokens` | warns once, unenforced | §2.3: 1995 emitted against a 200 ceiling |

So the fix extends the mechanism that is already there, rather than adding a
new one. It is decided **from the params**, mechanically — no per-site
judgement, no new config, nothing for a future author to remember.

Precedence mirrors `reconcileBackendWithBaseUrl` exactly, because the
situation is the same shape (the caller's intent vs an ambient env choice):

- **ambient `cli`** + unserviceable params → **route this call to `sdk`**, warn
  once per reason, naming the param and the measurement.
- **explicit `backend:'cli'`** + unserviceable params → **throw**. The caller
  contradicted itself, exactly as with an explicit `cli` + `baseURL`.
- **serviceable params** → unchanged. The call stays on `cli` and keeps the
  credit.

### 3.3 Which params are unserviceable

Refuse on `system` (non-empty), `tools`, or `tool_choice`.

**`max_tokens` is deliberately NOT a refusal trigger.** Every caller sets it,
so refusing on it would refuse every call and collapse this into the
as-proposed variant by the back door. The existing once-per-session warning
stays, reworded to say the limit is *unenforced* rather than merely
"not enforceable".

### 3.4 Placement

The params are known at `messages.create()` time, not at client-construction
time, so the decision lives in the cli adapter. `createAnthropicClient` passes
the adapter a lazily-invoked `sdkFallback` closure over the options already
resolved for the sdk path; the adapter calls it only when it refuses a call,
so the common path constructs nothing extra and the sdk client is never built
for a process that never needs one.

---

## 4. Cost consequence (the part that belongs in the plan)

`cli` exists to draw the Max 20x credit instead of billing
`ANTHROPIC_API_KEY`. Any call this change moves to `sdk` moves spend from the
subscription to the API meter. Named per site, so the trade is explicit:

**Moves to the API meter** (the four `system`-passing ambient sites, §2.6):

| site | volume | API cost after | subscription cost today |
|---|---|---|---|
| `arm-eval/judge.mjs` | per arm-eval judging call, Opus | real, and it is **replacing failures** — today's cli result is `conformant:false` | ~$0.8/call wasted |
| `work-unit-labels.mjs` | per unlabelled work unit, Haiku, 64 tokens | ≈$0.0002/call | ~$0.05–0.65/call |
| `refine-prompts.mjs` | manual, rare | negligible | — |
| `context.mjs` `_llmCondense` | per brief generation | ≈$0.002/call | ~$0.05+/call |

**Stays on the subscription**: the summariser and `summarise-domains` (no
`system`), `neighbourhood-query`, `visual/explain`, `anthropic-ping`,
`evolve-prompts`, `solo-control-audit:852`, the brainstorm adapter,
`azure-limits`, `final-review/shadow:137`. That is the high-volume half of the
census, and it is the half `cli` serves correctly.

**The trade is favourable on the measurements, not merely acceptable.** Three
of the four moved sites are paying 5–3000× the sdk price *for an answer their
own parser rejects or truncates*. Moving them reduces total spend across both
meters while fixing the output. The honest caveat: `arm-eval/judge.mjs` runs
Opus, so its API-meter line will be visible where today it is invisible — but
today's invisible spend is buying `conformant:false`.

**What this change does NOT do**: it leaves the ~164K-token prefix tax in
place on every call that stays on `cli` (§2.4 — 1.6× warm, 17× cold, 2.7×
latency). That is the larger number, and §8 owns it. It is not fixed here
because `--bare` is falsified (§2.5) and the alternative — abandoning the
credit wholesale — is Louis's call on how he wants his subscription spent, not
a correctness fix.

---

## 5. Also in scope

### 5.1 `summarise.mjs` availability gate

`!azureConfig.active && !process.env.ANTHROPIC_API_KEY` → `isClaudeAvailable()`.
Named in AGENTS.md as the anti-pattern; §2.2 is the fourth recorded instance.

### 5.2 `max_tokens: 4096` on a one-line-per-symbol call

Real, and the brief's reading of it needs one correction: it is **not** "a
licence to ramble on cli", because `cli` ignores the ceiling entirely (§2.3:
1995 against 200). And on `sdk` a ceiling costs nothing — you are billed for
tokens emitted, not for the ceiling. Measured output for a 10-symbol batch was
916–1146 tokens, so 4096 never bound.

So the change here buys no measured spend reduction, and the plan says so
rather than claiming one. What it buys is a ceiling that is a function of the
request, behind a **function boundary** (`summaryMaxTokens`, 256 tokens/symbol
— see §6.A for why not 192) rather than an
inline expression — a contract with no function boundary cannot be tested
except by grepping the source, and a static scan over an interpolated
expression is exactly the guard shape AGENTS.md records as defeated. At the
configured default batch of 50 it returns 4096 — **production is
byte-identical**, pinned by a test — and it only bites on the small batches
where the ceiling was three orders of magnitude off. 256/symbol keeps ~2x
headroom over the worst of five observations (1308 for a 10-symbol batch).
Degenerate inputs fail **open** to 4096, never to a tiny ceiling that would
truncate every answer.

**And truncation is now DETECTED, not merely made unlikely.**
`assessBatchCompleteness` reads two independent signals — `stop_reason ===
'max_tokens'`, and a missing entry for any requested index — and
`summariseBatch` logs a named `INCOMPLETE batch` line naming the missing
indices, while `main()` carries `counts.missing` and `complete` in its stdout
envelope. The count check is deliberately NOT conditional on `stop_reason`,
because on the cli backend the ceiling is unenforced and so `stop_reason`
cannot be relied on to report a cut. This closes the round-1 audit's H1/H3/H5:
the plan named truncation as silent data loss and the change then tightened the
ceiling without adding the detection. A retry at a larger ceiling is
deliberately not attempted — on cli it would change nothing while doubling the
spend.

### 5.3 `summarise.mjs` had no entry guard — found by this change, fixed here

Testing `summaryMaxTokens` requires importing the module, and the import hung:
`summarise.mjs` called `main()` at top level unguarded, so **any** import ran
the whole summariser, which blocks forever reading stdin. A census of
`scripts/symbol-index/` found it was the **only** `main()`-bearing script there
without the guard — its own sibling `summarise-domains.mjs` has it.

In scope by the impact rule, not the authorship rule: the correctness of what
is shipped here rides on that path (there is no other way to test the
contract), and the fix is the mandated `if (isInvokedAsScript(import.meta.url))`
— never a hand comparison of `process.argv[1]` with `import.meta.url`, which
Node realpaths on one side only, so through a symlink the hand guard is false
and the CLI exits 0 having run nothing.

Verified both directions: the test imports cleanly, and
`echo '' | node scripts/symbol-index/summarise.mjs` still emits its
`{"type":"summary",...}` envelope.

---

## 6. Measurements

All figures **measured** 2026-11-14 in worktree
`visual-audit-clipping-check-2de96f` @ `f48d9863`, model `claude-haiku-5-5`,
harnesses replicating the production call shapes verbatim. Commands in §6.C.

### 6.A Summariser shape (`summariseBatch`, no `system`), fixed 9,669-char prompt, n=5/backend

| | sdk | cli |
|---|---|---|
| output tokens | 916 / 943 / 991 / 1146 / **1308** | 1266 / 1323 / 1386 / 1452 / **1582** |
| input tokens | 4285 (identical every run) | 2 |
| cache create / read | 0 / 0 | 168679/0, 174863/0 (cold) · 4063/164611 (warm) |
| latency | 4.4 / 4.9 / 5.0 / 5.5 s | 12.2 / 13.9 / 14.1 / 14.2 s |
| self-reported cost | — (computed ~$0.0098) | $0.1719 / $0.1785 (cold) · $0.0158 (warm) |
| numbered lines parsed | 10/10 every run | 10/10 every run |

**The 5th sample arrived last and changed a conclusion.** Re-running the probe
after committing it (§5.2) returned **1308** sdk output tokens, 14% above the
previous maximum of 1146 — so the round-1 audit's H5 ("four samples do not
establish that every batch fits") was right on this plan's own figures, and the
per-symbol budget went from 192 to **256** in response. Recorded here rather
than quietly re-fitted: a range that one further sample broke is the strongest
available argument for the truncation DETECTION that now sits beside it.

### 6.B `normalize-intent` shape (`system` + `max_tokens: 200`)

sdk n=2 through the seam; cli n=1 through the seam plus **n=3 re-measured below
the seam** by raw `claude -p` with the identical argv the adapter builds — the
seam now refuses this shape, so the live path can no longer produce the cli leg.
Model pinned `claude-haiku-5-5` on both sides.

| | sdk | cli |
|---|---|---|
| output tokens | 29, 43 | 1995 · **2254, 2784, 2248** |
| latency | 1.07, 1.29 s | 40.0 s · **25.5, 31.9, 31.4 s** |
| self-reported cost | — (~$0.0003) | $0.8165 · **$0.301, $0.201, $0.155** |
| lines | 1, 1 | 12 · **16, 38, 41** |
| answer | one-line purpose sentence | every run opens *"I haven't changed anything"* / *"I couldn't make the change"* and reports on tool availability — it reads the normalize prompt as a TASK TO PERFORM and answers as an agent |

So **52–96× the output tokens, ~24× the latency, ~500–1000× the cost**, and the
answer is unusable as an embedding input. The 2026-07-19 comment is confirmed.

**Variance finding, and it strengthens the case rather than weakening it.** A
*shortened* 3-sentence replica of the same instruction, same model, same argv,
returned a correct **one-line** answer 3/3 (89–95 chars) — while still burning
466, 673 and 636 output tokens to do it, against sdk's 43. So whether `cli`
honours a given `system` is **not predictable from the instruction**: the real
602-char prompt fails 4/4, a terser variant passes 3/3, and both cost an order
of magnitude more than sdk. That is precisely why the refusal is **mechanical on
the param** rather than a per-prompt judgement at each call site — there is no
rule a future author could apply by reading their own prompt.

### 6.C Reproduce

Run from the repo root. The harness is **committed**, with its prerequisites,
its spend and the figures above recorded beside it:
[`docs/research/anthropic-cli-transport-cost/`](../research/anthropic-cli-transport-cost/README.md).

```bash
node docs/research/anthropic-cli-transport-cost/measure.mjs summariser 3   # §6.A
node docs/research/anthropic-cli-transport-cost/measure.mjs system 3       # §6.B
node docs/research/anthropic-cli-transport-cost/measure.mjs prefix 3       # §2.4
node docs/research/anthropic-cli-transport-cost/measure.mjs bare           # §2.5
```

Committed in response to the round-1 audit's M1, and it was right: §6.D's revert
triggers are stated in terms of these numbers, so pointing them at a `C:/tmp`
path made them unfalsifiable by anyone but their author. The `system` mode runs
its cli leg **below the seam** by design — the seam now refuses that shape, so
the live path cannot produce it. §7.3 additionally lands the routing DECISION as
a test, which is the part that must not regress.
The dollar figures are `claude -p`'s own `total_cost_usd`, i.e. the CLI's
self-report, which AGENTS.md already names as the only available meter for the
scripted cli backend (`claude-trace` cannot meter it).

### 6.D What would make me revert

- A run showing an ambient-`cli` call with `system` set that honours it
  **both** in shape (terse, within `max_tokens`) **and** in cost (output tokens
  within ~2× of sdk's). Note that a shape-only pass is NOT a revert trigger:
  §6.B already found one (the shortened replica, 3/3 one-line answers) and it
  still burned 11–16× the output tokens. The §7.3 tests assert the *routing
  decision*, never the model's prose, so they stay valid either way — but this
  plan's justification would not.
- Evidence that a moved site's API-meter cost exceeds what it replaces. §4's
  per-site figures are the claim to check; `arm-eval/judge.mjs` on Opus is the
  one with real downside if its call volume is higher than "per judging call".
- A `claude -p` release that honours `system` as a system prompt, or exposes a
  flag that strips the project-context prefix **without** forcing API-key auth.
  Either falsifies §2.3 or §2.5 and the refusal set should shrink accordingly.

---

## 6.E A filled slot is not a finished one

The round-2 audit raised the Silent-Data-Loss concern a **second** time, against
the fix for its first raising, and was right both times. The §5.2 fix computed
`complete` from missing entries alone, so a response the provider stopped at
`max_tokens` counted as complete whenever every numbered slot held a non-empty
string — and **the test asserted exactly that**, in a case written as "stop_reason
max_tokens on a COMPLETE list is not an incompleteness".

A summary can be cut mid-sentence and still be a non-empty string. "Every slot
filled" is evidence that every slot is *present*, never that every slot is
*finished*.

The generalisable form, and the reason it is recorded here rather than left in
the ledger: **a check that agrees with the thing it was meant to check
independently has stopped being a check.** The implementation decided
"complete" one way, the test restated that same decision rather than deriving it
from the defect, and both passed. The negative control is what separates them —
reverting `complete` to the old rule now fails 2 of 16 tests by name
(`stop_reason max_tokens is incomplete EVEN with every entry present`,
`distinguishes a skipped entry from a provider cut`), where before the reversal
it failed none.

`complete` is now `missing.length === 0 && !truncated`, the two signals are
reported separately so a skipped entry is distinguishable from a provider cut
(different remedies: reword the prompt vs raise the budget), and the
`INCOMPLETE batch` log names which case it is rather than printing a misleading
"0 symbols have no summary".

---

## 6.F Four rounds on one concern, and what each round's fix missed

Worth recording in full, because the sequence is more instructive than any one
finding, and because the last raise was about the TEST rather than the code.

| round | what was wrong | what the fix missed |
|---|---|---|
| R1 | `summariseBatch` read neither `stop_reason` nor the entry count | — (the concern's first statement) |
| R2 | the new oracle treated a full slate of non-empty entries as clearing a `max_tokens` stop, **and the test asserted that** | a populated slot is not a *finished* one |
| R3 | the verdict was correct and then DISCARDED: `summariseBatch` logged it and returned only the strings, so `main()` re-derived `complete` from a null count | two places computing one answer — the single-oracle rule |
| R4 | the propagation tests exercised only `assessBatchCompleteness`, never `summariseBatch` or `main()` | **the guard's stated subject was a layer it never touched** |

R4's finding was accurate and the measurement is damning: reverting `main()` to
the null count left **all 19** unit tests green. My own negative control for
that fix had been a hand-run `node -e` comparison rather than the suite, so it
never exposed the gap — the control tested the oracle, which was never the part
in doubt.

Closed by `tests/symbol-index-summarise-propagation.test.mjs`, which drives the
real CLI end to end (stdin records → stdout envelope) with a fake `claude`
binary via the cli backend, whose `normaliseCliOutput` carries `stop_reason`
through. Nothing inside `summarise.mjs` is stubbed, so the return shape and
`main()`'s aggregation are both on the measured path. Two controls, both run:

- `main()` recomputing `complete` from the null count → integration suite
  **fails**, unit suite still passes 19/19 (the asymmetry R4 predicted).
- the `incompleteBatches++` increment removed → integration suite fails 2.

The overclaiming comment in the unit suite now states its scope instead: it
pins the oracle, it does **not** detect a caller that recomputes, and it names
the file that does.

**The generalisable rule, which is the same one in both directions:** a check
that agrees with the thing it was meant to check independently has stopped
being a check. R2 was the implementation and its test agreeing; R4 was a test
suite whose comment claimed a layer it never executed. Both passed. Only a
revert-and-watch-it-go-red at the **right layer** separates them, which is why
§4.5's discipline specifies reverting the fix rather than inspecting it.

---

## 7. Implementation

### 7.1 `scripts/lib/anthropic-client.mjs`

1. `unserviceableCliParams(params)` → `null | {param, why}`. Checks `system`
   (non-empty string), `tools`, `tool_choice`. One oracle, exported on
   `_internals` for the test.
2. `createCliAdapter` gains `opts.sdkFallback` and `opts.backendWasExplicit`.
   In `create()`, after `assertOneShotTextMessages`: if
   `unserviceableCliParams(params)` returns a reason —
   - `backendWasExplicit` → throw, naming the param, the measurement and the
     `backend:'sdk'` remedy;
   - else → warn once per reason on stderr, then
     `return (await sdkFallback()).messages.create(params, requestOptions)`.
3. `createAnthropicClient` passes `sdkFallback` (a closure building the sdk
   client from the already-resolved effective values) and
   `backendWasExplicit`. A fallback-routed call must not be cached under the
   cli cache key.
4. Reword the `max_tokens` warning: unenforced, not "not enforceable".
5. `_resetClientCache` clears the new once-per-reason flags.

### 7.2 Call sites

- `summarise.mjs`: availability gate → `isClaudeAvailable()`; `max_tokens` →
  `summaryMaxTokens(batch.length)`; the missing entry guard (§5.3).
- No other call-site edits. That is the point of §3.2.

### 7.3 Tests

**New: `tests/anthropic-cli-faithfulness.test.mjs`** (15 tests). Its own file
rather than an append to the 905-line `anthropic-client.test.mjs`, so the
suite's subject is legible from its name.

- Each of `system` / `tools` / `tool_choice` + ambient `cli` → the call leaves
  via the **sdk transport**, observed through an injected `fetch` (the sdk
  binds its transport at construction, so this is the only vantage point that
  can prove which transport was used).
- The routed call reaches the sdk with `system` and `max_tokens` **intact** —
  stripping `system` to make the call fit would reproduce the defect on the
  other backend.
- **`BILLING PIN` (positive control)**: an ambient-`cli` call with serviceable
  params makes **zero** sdk calls. Without this, the change could silently
  have become "always sdk", voiding an operator's transport choice and moving
  every call's spend off the Max credit.
- An empty / whitespace `system` is serviceable — it carries no instruction.
- Each param on an explicit `backend:'cli'` → throws, naming the param **and**
  the remedy.
- The warning fires **once per reason**, not once per call, and names
  `CLAUDE_BACKEND=cli`.
- `unserviceableCliParams` truth table, including that `max_tokens` is
  explicitly not a trigger and that every refusal carries a non-empty reason.

**Negative control, run before claiming green**: neutering the oracle to
`return null` fails **10 of 15** and leaves green exactly the 5 must-not-fire
cases (billing pin, whitespace `system`, serviceable-explicit-cli, and the two
serviceable truth-table rows). A gate not seen to fail is not evidence.

**New: `tests/symbol-index-summary-budget.test.mjs`** (6 tests) — the
production pin at batch 50 → 4096, the cap at every size, the scaling below it,
≥50% headroom over the measured worst case, fail-open on degenerate input.

**Relocated, not deleted** (`tests/anthropic-client.test.mjs`): two tests
asserted egress redaction of `system` **through the cli adapter**, which is now
unreachable. The assertions moved to the transport that carries `system`:

- `EGRESS: a system prompt routed cli→sdk is still redacted before it leaves` —
  proves the routing does not bypass the redactor. Dropping this instead of
  relocating it would have lost coverage on a sensitive-path egress seam, which
  AGENTS.md makes non-negotiable.
- `applyRedactor structured system` previously said in its own comments that
  its stated subject — array-form system blocks — was *not* exercised ("the cli
  adapter receives `params.system` as a string from this test"). Rewritten to
  test the claim directly via an injected transport, plus a case proving an
  unknown block shape passes through untouched rather than being guessed at.
- The `max_tokens` warn-once test matches the reworded string; the cli
  arg-construction test no longer passes `system`.

---

## 8. Follow-ups (not this change)

1. **The ~164K prefix tax on every remaining `cli` call** (§2.4) is the larger
   number and is untouched here. The options are all policy, not correctness:
   drop `cli` entirely, or accept 1.6×/2.7× on the free meter for the
   `system`-less calls. Louis's call.
2. **`arm-eval` calibration results recorded under ambient `cli`** are
   suspect: §2.6 shows the judge scoring its own transport failures as
   `conformant:false`. Any stored arm-eval verdict produced on `cli` with
   `system` set may be measuring the transport. Worth a dated query before any
   of those numbers is quoted again.
3. **The 13 existing `{backend:'sdk'}` pins** become partly redundant once the
   seam refuses unserviceably. Leave them: they are explicit, they document
   real incidents, and removing a pin to rely on an inferred refusal trades a
   stated intent for a derived one.
4. **AGENTS.md has 321 characters of headroom** against its 79,000 cap after
   this change (two new invariants, net +990). The gate's own message is the
   finding: *"the next invariant will not fit, and shaving words to squeeze
   under the cap is how a file stays permanently full."* The prescribed remedy
   is condensing a dossier-grade section to a what-it-is / when-you-need-it /
   pointer stub — `context:check` names `Consumer-repo layout` (7,793),
   `Architecture` (7,763) and `Postgres-Parity Store` (6,282) as large AND
   already pointing at `docs/`, so their depth is duplicated rather than
   resident. Not done here: it is unrelated to this change, and quietly
   rewriting three other sections inside a backend-routing PR is the scope
   expansion AGENTS.md's own scope-discipline rule forbids.
