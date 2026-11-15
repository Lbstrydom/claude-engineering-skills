# Plan: the cli backend must refuse a call it cannot faithfully serve

- **Date**: 2026-11-14, **reshaped 2026-11-15**
- **Status**: Complete — implemented 2026-11-14, then **reshaped from
  route-or-throw to THROW AND PIN on Louis's decision (§3.2a)**. Written
  alongside the change as the spec `/audit-code` audits the diff against. Every
  claim is checkable against the commit; figures carry their command (§6).
- **Author**: Claude + Louis
- **Scope**: backend (one transport seam + 6 call-site pins + 7 availability
  gates + a merge-time gate + AGENTS.md; no UI)

> **Target domain(s)**: `shared-lib`, `symbol-index`
> - ⚠ **Cross-domain** — the refusal lands once in `shared-lib`
>   (`anthropic-client.mjs` + `anthropic-cli-faithfulness.mjs`); `symbol-index`
>   gets two call-site fixes that the seam cannot make for it, and the pins
>   touch `audit`, `experiments` and `brief` call sites that the seam can only
>   refuse, not fix.

> **What changed on 2026-11-15, in one line**: an unserviceable call now THROWS
> whether `cli` was ambient or explicit; the `sdkFallback` routing and the
> `CLAUDE_CLI_STRICT_MAX_TOKENS` opt-in are gone; 6 sites are pinned (two found
> by a mechanical census the by-hand list missed, §2.6a); 7 availability gates
> became `isClaudeAvailableFor('sdk')`; and `npm run anthropic:pin:gate` makes
> the pin enforceable at merge time, which the runtime throw cannot be (§7.3).

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

### 2.6 The measured defect is live and unpinned at four sites (six — see §2.6a)

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

### 2.6a Re-censused 2026-11-15: SIX sites, not four — and the two extra are the interesting ones

The four above were found by reading the files that pass `system` next to the
files that construct a client. That method is blind to two shapes, and a
mechanical re-census (`node scripts/check-anthropic-pins.mjs --list`, over
TRACKED `scripts/**/*.mjs`) found one of each:

| site | shape | why a by-hand read missed it |
|---|---|---|
| [evolve-prompts.mjs:395](../../scripts/evolve-prompts.mjs#L395) | **HANDOFF** | It constructs the client and passes it to `createLearningAdapter`, whose `callClaude` ([llm-wrappers.mjs](../../scripts/lib/llm-wrappers.mjs)) sends `system: systemPrompt`. Neither file is a violation on its own: one constructs and passes no param, the other passes a param and constructs nothing |
| [solo-control-audit.mjs:852](../../scripts/solo-control-audit.mjs#L852) | **FORWARDED VARIABLE** | `createAnthropicClient(backend ? { backend } : {})`, where `backend` was `'sdk'` only when `repeats > 1 \|\| --sdk \|\| --reasoning-effort`. The default path was ambient, and `runPass` passes `system` on every pass — on a **spend-bearing** experiment harness whose rows are compared across arms |

`solo-control-audit.mjs` is the worse of the two for the same reason
`judge.mjs` was: it RECORDS the result. An arm whose passes answered off-contract
was scored against arms that did not, and `out.provenance.backend` wrote
`'cli(default)'`, so the rows say which transport they ran on and nothing says
the transport could not serve them. Both are now pinned, and
`solo-control-audit` is sdk-only (`--sdk` kept as a logged no-op).

**The generalisable point, and the reason the gate has a Rule B.** A by-hand
census of "who passes `system`" is a census of SYNTAX; what matters is who
passes a *client* to something that passes `system`. The handoff crosses a
module boundary as a value, sometimes through an options bag, so no file-local
scan can see it — which is why every unpinned construction is enumerated in
`.anthropic-pin-census.json` with a stated reason rather than left to a pattern.

---

## 3. Design

### 3.1 Why not the three obvious alternatives

**Band-aid — pin the ambient sites and stop there.** Makes correctness a
property of the call sites, which is the state we are in: 13 sites already
pinned, one burn at a time, and site 18 arrives unpinned. Note what the shipped
design keeps and what it rejects: it DOES pin the sites (§7.2), because a
transport decision belongs where it can be read — but the pin is not the
mechanism. The seam refuses the unfaithful call whether or not anyone
remembered, and `anthropic:pin:gate` refuses the next unpinned site at merge
time (§7.3). "Pin the sites" is a band-aid only when pinning is the *whole*
answer, which is how sites 14 through 17 arrived. This file already contains the verdict
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
| `system` | passed as `--system-prompt` — obeyed for a simple instruction, outranked by the Claude Code persona on a structured-output contract | §2.3: 69× output tokens, the instruction overridden on the real prompt; §7.12: obeyed 3/3 on a shortened one, still 466–673 tokens |
| `tools` / `tool_choice` | **silently dropped** (`--tools ''`) | AGENTS.md: 20/20 tiered-recall runs fell back to legacy for a whole shadow window |
| `max_tokens` | warns once, unenforced | §2.3: 1995 emitted against a 200 ceiling |

So the fix extends the mechanism that is already there, rather than adding a
new one. It is decided **from the params**, mechanically — no per-site
judgement, no new config, nothing for a future author to remember.

**THROW AND PIN** (decided 2026-11-15; §3.2a records what it replaced):

- **unserviceable params** → **throw**, whether `cli` was ambient or explicit.
  One verdict, one message, naming the param, the measured reason, and the
  remedy: `createAnthropicClient({ backend: 'sdk' })` at the call site.
- **serviceable params** → unchanged. The call stays on `cli` and keeps the
  credit.

### 3.2a What throw-and-pin replaced, and why the first shape was wrong

The first implementation mirrored `reconcileBackendWithBaseUrl`'s precedence —
ambient `cli` ROUTED the call to sdk with a once-per-param warning, explicit
`cli` threw — on the reasoning that both are "the caller's intent vs an ambient
env choice". That reasoning was the defect.

**A `baseURL` names a DESTINATION the operator chose, so coercing the transport
still reaches it. `system` names a billable CONTRACT the call site never made a
transport decision about.** Routing on it meant a param decided which meter a
call bills — quietly, at run time, with nothing committed recording which sites
had moved. The quietness was the whole appeal and the whole problem: a reader of
`evolve-prompts.mjs` could not tell that its calls had left the Max credit.

Three consequences of the throw shape that the routing shape could not have:

1. **The decision is in the diff.** 6 pins, reviewable, greppable, and each with
   the measured reason beside it. "Which sites bill the API meter" is answerable
   from `git grep`, not from reasoning about params at run time.
2. **It is enforceable before merge.** A runtime throw cannot fire in CI, which
   runs the committed `sdk` default — so the routing shape's guard was, in
   effect, "an operator with `CLAUDE_BACKEND=cli` notices". `npm run
   anthropic:pin:gate` is a real guard: Rule A (file-local, mechanical) plus
   Rule B (a declared census, because a client HANDED to another module is
   invisible to a file-local scan — see §2.6a).
3. **The keyless case stops lying.** The routing shape had no sdk credential to
   fall back to on a keyless `cli` install, so the failure surfaced as
   `ANTHROPIC_API_KEY required` — a credential error for a backend the operator
   never selected. The throw names the param instead, and the pinned sites' gate
   became `isClaudeAvailableFor('sdk')` so such an install skips the feature
   cleanly rather than attempting it.

The cost of the throw shape, stated honestly: an operator who sets
`CLAUDE_BACKEND=cli` and then calls an UNPINNED seam site with `system` gets an
error where they previously got an answer. That is the intended trade — the
answer they previously got did not meet the call's contract (§2.3) — but it is a
behaviour change for anyone running a patched or forked call site, and the pin
gate is what keeps the in-repo population at zero.

### 3.3 Which params are unserviceable

Refuse on `system` (non-empty), `tools`, or `tool_choice`.

**`max_tokens` is deliberately NOT a refusal trigger.** Every caller sets it,
so refusing on it would refuse every call and collapse this into the
as-proposed variant by the back door. The existing once-per-session warning
stays, reworded to say the limit is *unenforced* rather than merely
"not enforceable". What covers the real risk an unenforced ceiling carries is a
consumer that NOTICES truncation — `assessBatchCompleteness` (§5.2, §6.E) reads
`stop_reason` — not a second routing dial.

A `CLAUDE_CLI_STRICT_MAX_TOKENS` env opt-in was implemented on 2026-11-14,
adjudicated out of a round-1 HIGH, and **removed on 2026-11-15**. Two reasons,
both visible only once routing was gone: it was a second routing dial for a
param whose being unmet does not change the answer, so it failed this section's
own membership test; and under throw-and-pin "strict" would mean *throwing on
every cli call*, which is not a trade an env var should express. No call site
ever asked for it. The removal carries its own negative control — a stale
`CLAUDE_CLI_STRICT_MAX_TOKENS=1` must now change nothing, end to end — because
a removal that left the read in place would be invisible.

### 3.4 Placement

The params are known at `messages.create()` time, not at client-construction
time, so the decision lives in the cli adapter — which now needs nothing from
the factory beyond what it already had. The `sdkFallback` closure the routing
shape required is gone with it, and with it the one piece of the earlier design
that was genuinely hard to reason about: a cli client that could silently
construct and bill a second client.

---

## 4. Cost consequence (the part that belongs in the plan)

`cli` exists to draw the Max 20x credit instead of billing
`ANTHROPIC_API_KEY`. Any call this change moves to `sdk` moves spend from the
subscription to the API meter. Named per site, so the trade is explicit:

**Moves to the API meter** (the `system`-passing ambient sites — four from
§2.6 plus the two the mechanical census found, §2.6a):

| site | volume | API cost after | subscription cost today |
|---|---|---|---|
| `arm-eval/judge.mjs` | per arm-eval judging call, Opus | real, and it is **replacing failures** — today's cli result is `conformant:false` | ~$0.8/call wasted |
| `work-unit-labels.mjs` | per unlabelled work unit, Haiku, 64 tokens | ≈$0.0002/call | ~$0.05–0.65/call |
| `refine-prompts.mjs` | manual, rare | negligible | — |
| `context.mjs` `_llmCondense` | per brief generation | ≈$0.002/call | ~$0.05+/call |

| `evolve-prompts.mjs` (§2.6a, handoff) | manual, rare | negligible | — |
| `solo-control-audit.mjs` (§2.6a, forwarded var) | **spend-bearing**: 5 passes × N commits × `--repeats`, Sonnet/Opus, `max_tokens` 8000 | real and already budgeted (`--budget`) | the same calls, answering off-contract and recorded as arm results |

`solo-control-audit` is the one site where the move is a genuine new API-meter
line rather than a replacement of waste: its default path previously ran on the
subscription. It is still the right trade — an arm whose passes do not meet the
prompt's contract has no value at any price, and the harness already caps spend
with `--budget` — but it is the one line here an operator could be surprised by,
so it is called out rather than folded into "replacing failures".

**Stays on the subscription**: the summariser and `summarise-domains` (no
`system`), `neighbourhood-query`, `visual/explain`, `anthropic-ping`. That is
the high-volume half of the census, and it is the half `cli` serves correctly.
Each is enumerated in `.anthropic-pin-census.json` with the reason it is
serviceable, so the claim is committed rather than inferred.

**The trade is favourable on the measurements, not merely acceptable.** Three
of the six moved sites are paying 5–3000× the sdk price *for an answer their
own parser rejects or truncates*. Moving them reduces total spend across both
meters while fixing the output. Two honest caveats: `arm-eval/judge.mjs` runs
Opus, so its API-meter line will be visible where today it is invisible — but
today's invisible spend is buying `conformant:false`; and
`solo-control-audit.mjs` is a real new line, as above.

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
the live path cannot produce it. §7.4 additionally lands the REFUSAL as a test,
which is the part that must not regress.
The dollar figures are `claude -p`'s own `total_cost_usd`, i.e. the CLI's
self-report, which AGENTS.md already names as the only available meter for the
scripted cli backend (`claude-trace` cannot meter it).

### 6.D What would make me revert

- A run showing an ambient-`cli` call with `system` set that honours it
  **both** in shape (terse, within `max_tokens`) **and** in cost (output tokens
  within ~2× of sdk's). Note that a shape-only pass is NOT a revert trigger:
  §6.B already found one (the shortened replica, 3/3 one-line answers) and it
  still burned 11–16× the output tokens. The §7.4 tests assert the *refusal*,
  never the model's prose, so they stay valid either way — but this plan's
  justification would not. A revert would mean removing `system` from
  `unserviceableCliParams` and its entries from the pin census; the
  `--system-prompt` plumbing in the adapter is retained though currently
  unreachable, so that is a small change rather than a re-implementation.
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

## 7. Implementation (as shipped 2026-11-15 — throw-and-pin)

### 7.1 The seam

- **`scripts/lib/anthropic-cli-faithfulness.mjs`** — `unserviceableCliParams`
  (`null | {param, why}`; `system` non-empty, `tools`, `tool_choice`) and
  `cliFaithfulnessVerdict` (`null | {param, message}`). Its own module: the
  single-oracle pattern wants one importable home, and
  `anthropic-client.mjs` is past the `size:ratchet:gate` limit, where the
  gate's instruction is to split rather than justify growth.
- **`createCliAdapter`** — after `assertOneShotTextMessages`, a non-null verdict
  THROWS. No `sdkFallback`, no `backendWasExplicit`, no once-per-param warning
  state; the adapter takes `{claudeBin, timeoutMs, redactor}` as it did before
  this change. `cliFaithfulnessVerdict` takes the params alone.
- **`isClaudeAvailableFor(backend)`** — the availability oracle, taking the
  backend as an argument; `isClaudeAvailable()` becomes a thin
  ambient-resolving wrapper over it, so there is still one definition of
  "available". A named backend deliberately does not re-validate
  `CLAUDE_BACKEND`, since a pinned call never reads it.
- The `max_tokens` warning stays, worded *unenforced*, not "not enforceable".

### 7.2 Call sites — 6 pins, and 5 gates that were asking the wrong question

Pinned `{backend:'sdk'}`, each with the reason beside it: `arm-eval/judge.mjs`,
`work-unit-labels.mjs`, `refine-prompts.mjs`, `context.mjs`,
`evolve-prompts.mjs` (§2.6a handoff), `solo-control-audit.mjs` (§2.6a forwarded
variable, now unconditionally sdk with `--sdk` kept as a logged no-op).
`final-review/shadow.mjs`'s azure-claude arm is pinned too — behaviour-neutral,
since an `azureRoute` already coerces ambient cli, but it states the
requirement at the site that has it instead of leaving it to depend on a route.

Gates moved to `isClaudeAvailableFor('sdk')` where the site they guard is
pinned: `work-unit-labels`, `refine-prompts`, `context.mjs`, `evolve-prompts`,
`audit-loop.mjs` (the MANDATORY final review), `remediation-reconcile.mjs`,
`normalize-intent.mjs`. Left ambient where the site is ambient:
`anthropic-ping`, `neighbourhood-query`, `summarise.mjs`.

Also in scope and unchanged from the first implementation: `summarise.mjs`'s
availability gate (§5.1), `summaryMaxTokens` (§5.2), its missing entry guard
(§5.3), and the completeness verdict (§6.E).

### 7.3 The gate — because the throw cannot fire in CI

`npm run anthropic:pin:gate`
([`check-anthropic-pins.mjs`](../../scripts/check-anthropic-pins.mjs) +
[`lib/anthropic-pin-census.mjs`](../../scripts/lib/anthropic-pin-census.mjs)),
in `check:static`. **This is the load-bearing half of the change.** CI runs the
committed `sdk` default, so a new unpinned `system`-passing site ships green and
breaks only where `CLAUDE_BACKEND=cli` is set — which is where this repo is
used. A runtime refusal no CI run can reach is not a guard.

- **Rule A** (file-local, mechanical, no declaration accepted): a file that
  constructs an unpinned client AND passes an unserviceable param literal.
- **Rule B** (drift-only, declared): every unpinned construction enumerated in
  the committed `.anthropic-pin-census.json` with a reason. A new one fails; a
  **stale one fails too**, asking for a re-baseline, in `size:ratchet:gate`'s
  shape — an entry for a file that no longer constructs an unpinned client is a
  claim about nothing, and leaving it makes the list look like coverage.
- **`indirectPins`** — the one escape from Rule A, and it is verified rather
  than trusted: an entry names the `via` function that holds the literal
  (`azure-claude-adapter.mjs`'s `clientOptions()`), and the gate re-reads that
  function, brace-scoped, to confirm the pin is still there.
- Corpus: TRACKED `scripts/**/*.mjs`, asked of git. Tracked is the right
  question for a merge gate — it judges what the commit ships, and it is what
  the pre-push sandbox (a clean worktree at the commit being pushed) contains at
  all. It keeps the gitignored `scripts/.claude-skills/**` out, which is
  upstream's own content indexed twice.
- A corpus of **zero** exits 2 rather than printing clean: the seam's own module
  names the factory, so an empty set means the enumeration broke.

### 7.4 Tests

**`tests/anthropic-cli-faithfulness.test.mjs`** (27). Each of `system` /
`tools` / `tool_choice`, ambient AND explicit → throws, naming the param and
the pin. **Every throw test also asserts ZERO sdk calls**, observed through an
injected `fetch` — without that half the suite would pass under the rejected
routing design too, since that design also threw on the explicit-cli case.
Plus: the keyless-ambient-cli case names the param and NOT `ANTHROPIC_API_KEY`;
a pinned sdk client carries `system`/`tools`/`tool_choice` intact; the removed
`CLAUDE_CLI_STRICT_MAX_TOKENS` is no longer read at any value, end to end;
`isClaudeAvailableFor` disagrees with `isClaudeAvailable()` exactly where it
must. **`BILLING PIN` (positive control)**: a serviceable ambient-cli call makes
zero sdk calls, so this never silently becomes "cli is never usable".

**`tests/anthropic-pin-census.test.mjs`** (27). The scanner's positive control:
`classifyPinningInSource` is pure, so planted sources prove it is not inert —
unpinned+`system` must come back RED, a literal pin GREEN, a forwarded
`{ backend }` RED (the gate cannot check a variable), a param named only in a
comment GREEN. Then the drift rules (undeclared / stale / reasonless /
Rule-A-is-not-declarable-away / broken and stale `indirectPins`), then the real
repo asserted clean against its committed baseline, with the 6 pinned sites
asserted BY NAME and a scan proving no file still reads the removed env var.

**Relocated, not deleted** (`tests/anthropic-client.test.mjs`): the egress
assertion for a redacted `system` prompt. It previously went through the cli
adapter, then briefly through the cli→sdk routing; both are gone, so it now runs
against a PINNED sdk client under ambient cli — which is the documented route
for every `system`-passing site in the repo. Dropping it instead of relocating
it would have lost coverage on a sensitive-path egress seam, which AGENTS.md
makes non-negotiable.

---

## 7.5 What the round-1 audit of the reshape found, and what it changed

Six real defects in the new code, four of them FAIL-OPEN in the scanner — the
direction where a gate prints clean over a violation. Each now has a planted RED
case, because a clean verdict is worth exactly what the ability to go red is
worth.

| # | defect | direction | fix |
|---|---|---|---|
| 1 | `unserviceableParamsInSource` missed SHORTHAND `{ system }` | fail-open | matched as a bare property between `{`/`,` and `,`/`}` |
| 2 | `{ backend:'sdk', ...opts }` read as PINNED, though `opts` may override it | fail-open | a spread AFTER the literal makes the effective backend unresolved, so not a pin |
| 3 | an `indirectPins` claim never checked the CONSTRUCTION calls the named function | fail-open | `indirectPinHolds` returns `used`, and every unpinned construction in the file must pass `via()` |
| 4 | Rule B counted FILES: a second unpinned construction in a declared file was unflagged | fail-open | the declaration carries the COUNT; growth AND an unrecorded shrink fail |
| 5 | the CLI counted `brokenIndirect`/`staleIndirect` in `ok` but never PRINTED them | silent failure | every verdict category is reported, pinned by a test that reads the CLI's own source |
| 6 | the `max_tokens` warn-once test asserted its text only WHEN PRESENT | vacuous pass | `_resetClientCache()` first, then assert exactly one line across two calls |

(5) is the sharpest of the gate defects: a gate that exits 1 printing nothing is
worse than no gate, and two of its seven failure categories were in that state.
(6) I wrote knowingly, with a comment explaining why the assertion was
conditional — which is the form this plan's own §6.E warns about, one layer over:
the comment made the weakness legible and left it in place.

### 7.5a The measured instance of the `max_tokens` class — found by running the audit

The audit's own `[brief]` step printed `claude-haiku-5-5 done in 10.4s
(0 chars)` and fell through to Gemini. Reproduced directly against AGENTS.md as
the user turn: at `max_tokens: 2000` the model returns **`stop_reason:
max_tokens`, `thinking_tokens: 2000`, and a single `thinking` block with no text
at all**. `context.mjs` read `response.content?.[0]?.text`, i.e. the thinking
block, got `undefined`, and logged it as though the model had answered.

Two defects in one line, and both are shapes this plan already names:

- **Reading index 0 is not reading the answer.** The fix takes the first `text`
  block. The log now names `stop_reason` and the block types when there is no
  text, so "0 chars" can never again mean "we did not look in the right place".
- **A ceiling must be sized to the answer PLUS what the model spends getting
  there.** Measured at 4000: `end_turn`, thinking 763–1721, text 2215–3271 chars
  (the brief is capped at 3000 anyway). Same correction as `summaryMaxTokens`
  (§5.2), on a budget nobody had re-measured since thinking became a default.

This leg had therefore been dead in **every** audit run, on both transports:
grep of eight pre-change round logs from 2026-11-14 shows the same `(0 chars)`
line, so the pin did not cause it and the fix is not a regression repair — but
it IS the honest answer to the audit's "unenforced output budget" finding. The
class is real; refusing `max_tokens` at the seam is not the remedy (§3.3), and a
consumer that notices is.

### 7.5b One fix of mine had a concurrency bug, caught before it shipped

Making the labeller lazy (below) first used a resolved-FLAG set before the
await. `labelWorkUnits` runs its units through `Promise.all`, so every other unit
would read `labeller` while it was still `undefined` and conclude the provider
was unavailable — one construction becoming "unavailable" for all but one unit.
Memoising the PROMISE instead is the fix; a test asserts the labeller resolves
once across three concurrent units and that all three got a label.

### 7.5c A regression the pin itself introduced

`defaultLabeller` is pinned to sdk, so on a keyless `CLAUDE_BACKEND=cli` install
it returns `null`. `labelWorkUnits` resolved it BEFORE touching the cache and
returned `labeller-unavailable`, serving **none** of the labels already on disk —
strictly worse than before the pin, for exactly the population the pin was
written for. A cache hit needs no provider, so the provider is now resolved
lazily on the first MISS, and `labeller-unavailable` is reported only when a
provider was actually needed and absent. Negative control: reverting to the
eager resolve fails 2 of the file's 24 tests.

---

## 7.6 Round 2: the fail-closed pass was itself fail-open, and my tests were vacuous again

| # | defect | why the round-1 fix missed it |
|---|---|---|
| 1 | `{ backend:'sdk', backend:'cli' }` and `{ ...clientOptions(), backend:'cli' }` read as PINNED | the check asked whether an `sdk` literal appeared ANYWHERE, then looked for a spread after the FIRST `backend:`. **JavaScript resolves the LAST one.** `resolveBackendInArgs` now resolves the last, and returns `'cli'` as its own verdict |
| 2 | an `indirectPins` claim was satisfied by `{ ...clientOptions(), backend:'cli' }` | `used` only asked whether the factory was CALLED, not whether its pin survived. It now also requires the construction to name no backend of its own |
| 3 | the count ratchet could not see a REPLACEMENT | swapping one unpinned construction for another preserves the total. Each declaration now carries `argsDigest` |
| 4 | three of the five tests written to close round 1 were vacuous or non-hermetic | below |

(1) and (2) are the same error twice: **a check that resolves the first match is
not a check on the effective value.** The round-1 fix added a spread guard, which
is the right idea anchored to the wrong occurrence — and anchoring it to the
first occurrence is what let a plain duplicate key through, a shape simpler than
the one the guard was written for.

### 7.6a The vacuous-test lesson, for the third time in this plan

§6.E and §7.5 already record one instance each. Round 2 found three more, all in
the tests I had just written to close a fail-open:

- an `asked` counter **wired to nothing**, so its `assert.equal(asked, 0)` could
  never fail;
- a `built` counter incremented in an **IIFE, before `labelWorkUnits` was
  entered**, so it could not observe lazy resolution — the one thing the test
  was named for;
- `labeller: null`, which falls through to `defaultLabeller()` and therefore to
  **the operator's environment**: the test's verdict depended on whether the
  machine running it had `ANTHROPIC_API_KEY` set.

The fix is not more assertions but a seam that makes the claim observable:
`labelWorkUnits` now takes `labellerProvider`, an async thunk it calls **at most
once and only after a cache MISS**. A test counting provider calls is then
testing the laziness itself rather than a proxy for it, and never reaches a real
provider, so the suite is hermetic. That is a better API than a test-only hook —
laziness is a property of the caller's contract, so it belongs in the signature.

**The pattern, stated plainly because it keeps recurring here:** when a test
counts something, ask what would have to break for the counter to move. If the
answer is "nothing the test controls", the counter is decoration. All three of
these had a plausible name, a plausible comment, and a counter that could not
move.

### 7.6b Dismissed, verified against the contract

`--selfcheck-relocation` runs before `assertKnownFlags` and ignores the POSIX
`--` terminator (one MEDIUM, one LOW). Checked the enforcing code rather than the
convention's name: **every** CLI in this repo does exactly this —
`check-windowed-views.mjs:74`, `check-stdout-flush.mjs:219`, `doctor.mjs:164`,
`check-setup.mjs:961` — and AGENTS.md's smoke contract specifies the handler "at
the head of `main()`", with `tests/relocation-guard.test.mjs` enforcing its
presence over `CLI_SMOKE_SET`. Changing it in this one file would make it the
only CLI that differs, which is the two-spellings divergence this repo warns
about. If the terminator should be honoured it is a repo-wide change to the
contract and its 26 implementations, not a local fix — recorded as §8.5.

---

## 7.7 Round 3 triggered the pivot rule, and the pivot is: parse, do not match text

Three consecutive rounds on the same concern is `/audit-code`'s pivot
threshold — stop patching, propose a new design. Round 3's findings named it:

| round | fail-open shape the text scan could not see |
|---|---|
| R1 | shorthand `{ system }`; a spread after the literal; an unverified `via` claim; a count that could not see a second construction |
| R2 | a duplicate key where the LAST one wins; `{ ...opts(), backend:'cli' }` satisfying a `via` claim; a replacement at a constant count |
| R3 | a shorthand `{ backend }` that WINS at runtime; a NESTED `metadata:{backend:'sdk'}` read as top-level; a construction with **two** nesting levels the construction regex did not match at all — invisible to BOTH rules; `{ ...opts(), ...overrides }` still satisfying a `via` claim; the digest stripping whitespace from inside STRING LITERALS |

**Every individual fix was correct about the shape it was told about and blind
to the next one. That is the signature of the wrong tool, not of an incomplete
pattern** — and it is what three rounds were needed to make undeniable, because
each round's fix genuinely closed what it was shown.

### 7.7a The argument I made against parsing was wrong on the facts

I declined a parser twice (§7.5, §7.6) as "the over-engineering cliff for a gate
over 33 files". The auditor asked for one five times across three rounds. It was
right, and my reason was not a judgement call that went the other way — it was
false: **this repo already parses JS in five gates** through the shared
[`ast.mjs`](../../scripts/lib/ast.mjs), including
`find-stdout-exit-sites.mjs`, which backs `stdout:flush:gate` — the same shape
of gate as this one, over a larger corpus. So the AST was the cheaper option as
well as the correct one, and "find the existing oracle before building a second
one" would have found it in one grep.

The generalisable form, and it is the uncomfortable one: **"that would be
over-engineering" is a claim about this repo's existing machinery, so it has to
be checked against the repo rather than asserted from the shape of the
problem.** I asserted it twice and shipped two rounds of fail-open gate instead.

### 7.7b What the AST version is

`resolveBackendOfArg` reads the construction's own argument node, so only
TOP-LEVEL properties count and the last assignment wins, as it does at runtime.
Three verdicts: `pinned`, `cli` (explicitly the transport that cannot honour the
params), `unresolved`. The fail-closed bucket is deliberately large — a
non-literal value, a computed key, or a spread after the winner all land in it.

`constructionsIn` matches a CallExpression, so nesting depth is irrelevant;
`unserviceableParamsInSource` matches an ObjectProperty, so every spelling
(`system:`, `'system':`, shorthand `system`) counts once and prose counts never,
with no comment-stripper. `argRestsOnFactory` requires an indirect claim's
construction to call the factory AND add no `backend`, no computed key and no
other spread — the factory's object must be the last word.

Two new guarantees the text version could not offer:

- **An unparseable file is UNKNOWN, not clean.** `classifyPinningInSource`
  returns `parsed: false` and the audit fails on it. Without that the gate's
  strongest claim would evaporate on exactly the file most likely to be
  mid-edit.
- **The digest folds formatting without touching string contents.**
  `normaliseArgText` walks the span tracking quote state, so
  `mode === 'use cli'` and `mode === 'usecli'` keep different digests — they can
  select different backends, and the whitespace-stripping version gave them one.

### 7.7c The pivot immediately found a real defect the regexes had passed

`azure-claude-adapter.mjs` builds its test-seam client as
`{ ...clientOptions(), ..._clientOptions }`. The second spread can carry a
`backend` and override the Azure route's sdk requirement; the stricter
`argRestsOnFactory` flagged it. No caller does so (every one passes
`azureRoute`/`fetch`/`redactor` only), so writing `backend: 'sdk'` last is
behaviour-neutral — it just stops being possible. A gate's first real find after
a rewrite is the best evidence the rewrite was the right call.

### 7.7d Also fixed: a swallowed provider error

`labelWorkUnits`' provider catch folded every rejection into `null`, so a
programming error or a broken configuration was indistinguishable from "no
credential on this machine", with the diagnostic discarded — the
absence-is-not-evidence shape. It still degrades, because labelling is advisory
and must never crash a backlog listing, but the reason is kept:
`labeller-error: <message>` rather than `labeller-unavailable`.

---

## 7.8 Round 4: the AST was the right tool, and it still had seven fail-opens

The pivot was correct and did not make the gate correct. Round 4 found seven
defects in the AST version — but note what changed in their CHARACTER: these are
all "this node type also assigns the key" or "this is the wrong node to read",
which are *answerable* against the grammar. The regex rounds kept producing
shapes with no principled enumeration.

| # | defect | direction |
|---|---|---|
| 1 | a COMPUTED key after the literal was SKIPPED, leaving the earlier verdict: `{ backend:'sdk', [key]:'cli' }` read as pinned | fail-open |
| 2 | a GETTER or METHOD named `backend` was ignored, though it assigns the key | fail-open |
| 3 | `indirectPinHolds` accepted a pinned object ANYWHERE in the factory, not the one it RETURNS — a dead object vouching for a live override | fail-open |
| 4 | a computed REQUEST key was discarded: `{ ['system']: p }` did not record `system` | fail-open |
| 5 | an ALIASED import (`createAnthropicClient as mk`) matched nothing, so the site was invisible to BOTH rules | fail-open |
| 6 | the trailing-comma fold ran over the whole normalised string, literals included, so `'use,}'` and `'use}'` collided | lossy |
| 7 | a rejection with an empty message was reported as an ABSENCE, not an error | misclassification |

**(1) and (6) were defects against this module's own docstrings.** Both texts
already said computed keys are unresolved and that literal contents are
preserved. The contract was right and the code did not implement it, which is
worse than an undocumented gap: a reader checking the claim would have been
reassured. Where a docstring states a guarantee, the test for it is not
optional.

(3) is the same error as §7.6's `used`, one level in: *asking whether something
exists somewhere, rather than whether it is the thing that takes effect.* The
fix reads the function's RETURN, and requires every return to be pinned —
`if (x) return {backend:'sdk'}; return {backend:'cli'};` fails.

(5) is the one that would have been worst in practice. A site the enumeration
does not see is absent from Rule A *and* from Rule B's count, so it ships with
no record anywhere. `factoryLocalNames` now collects the local name from a
static `import { createAnthropicClient as mk } from '…/anthropic-client.mjs'`
and from a destructured dynamic `import()`.

(4) needed a decision rather than a fix. A computed key whose key is a string
literal is statically known and now counts. A *dynamic* one cannot be resolved,
so it might be `system` — reported as `dynamicKeys` and failing Rule A **only in
a file that also constructs an unpinned client**, which is Rule A's own
condition. A file where every construction is pinned is unaffected, so the cost
of failing closed falls exactly where a decision is owed.

### 7.8a A negative control that would not fire, and what it exposed

The control for (7) — revert the throw/absence decision to the message's
truthiness — **passed**, which meant the fix was not the thing being tested. Two
mechanisms were covering one question: a `providerThrew` flag AND a
`|| '(no message)'` fallback that made the message always truthy after a throw.
Either would have done, so neither was tested, and a control cannot tell them
apart.

Collapsed to one: the flag decides, the text is a diagnostic that may be empty,
and the fallback moved to the display site. The control then fails 2 of 32.

**The rule: if a negative control will not go red, do not weaken the control —
look for the second mechanism.** A guard that cannot be shown to matter usually
has a twin, and a redundant pair is how both go untested.

---

## 7.9 Round 5: control flow, spellings, provenance — and one cost measured before choosing

| # | defect | fix |
|---|---|---|
| 1 | a BARE `return;` and an IMPLICIT fallthrough were invisible, so `function opts(){ if(x) return {backend:'sdk'}; }` counted as pinned | every path out must return a pinned object; a body not ending in `return` has an unresolvable path |
| 2 | `mod['createAnthropicClient']()` was excluded by the non-computed test | `memberNameOf` reads a bracketed name too; a DYNAMIC computed member is a stated limit, since flagging every `obj[x]()` would make the gate useless |
| 3 | a SPREAD into a `.create()` argument hides every param from Rule A | flagged — see §7.9a |
| 4 | an alias was recorded for ANY object with a `createAnthropicClient` property | provenance checked: the initializer must be an `import()` of the seam module |
| 5 | `String(err)` THROWS for a value with no `toString`, so formatting the diagnostic could throw out of the catch that exists to contain the rejection | the flag is set first, the text is best-effort inside its own try |

### 7.9a The spread rule: measured before choosing, because the broad version had a price

The obvious fix — treat any object spread in a file as hiding a param — would
have flagged **3 of the 6** unpinned files, the SUMMARISER among them. That is
the highest-volume deliberately-cli site in the repo, and forcing it to pin
would move its spend off the Max 20x credit to guard a hypothesis. Measured
2026-11-15 before deciding; the narrow rule (a spread inside a `.create()`
argument, which is where a request object actually is) flags **0** today, so it
costs nothing and still closes the shape.

**A fail-closed rule has a price, and the price is measurable.** "Fail closed"
was the right instinct in four earlier rounds precisely because its cost there
was zero; here the broad version's cost was the thing the whole design exists to
protect. Measure the blast radius before widening a guard.

### 7.9b `import()` is an ImportExpression, not a CallExpression

The provenance check's first version tested
`node.callee?.type === 'Import'`, which is the Babel 7 shape most examples
show. Babel 8 models `import(x)` as its own `ImportExpression` with a `source`.
That shape matched nothing, so the check was silently rejecting EVERY genuine
alias — fail-closed, and therefore harmless here, but only by luck of which
direction the mistake fell. Caught by probing the real parser rather than
asserting the node shape; a one-line `parseSource` probe is cheaper than
either reading the changelog or being wrong.

---

## 7.10 Round 6 — the CAP, not convergence, and the card

**Round 6 did not converge: H:3 M:5 against a threshold of H==0 && M<=2.** Six
is `/audit-code`'s cap, so the decision to continue is the operator's, not mine.
The structural-or-stop card (`scripts/audit-structural-card.mjs`) reports **5
structural clusters, 84 polish, of 89**, with `anthropic-pin-census.mjs` raised
in 6 rounds and `work-unit-labels.mjs` in 4. Every structural cluster is the
same one: the census's control-flow analysis.

Four of round 6's findings were fixed anyway, because two were regressions I
introduced in round 5 and leaving a guard that cries wolf is worse than the gap
it covers:

| # | defect | note |
|---|---|---|
| 1 | `endsInReturn` marked `if (x) return A; else return B;` unresolvable, though every path returns | **my R5 regression.** `alwaysReturns` now recognises if/else, try/catch, switch-with-default and throw; anything unrecognised still reads as unresolvable |
| 2 | the spread rule matched ANY member call named `create`, so `db.records.create({ ...row })` failed the gate | **my R5 regression.** Scoped to a `…messages.create` receiver |
| 3 | provenance missed the two-step `const mod = await import(seam); const { createAnthropicClient: mk } = mod;` | a missed alias is invisible to BOTH rules |
| 4 | a member call counted on property name alone, so `unrelatedBag['createAnthropicClient']()` counted as a seam construction | provenance now required on the receiver; no site in this repo uses the member form at all (measured), so it costs nothing |

**These four fixes were unaudited when this section was written; round 7 has
since read them.** They were written after round 6's final pass, at the cap,
which is the normal state at a cap. They carry four negative controls
(last-statement-only 4/128 fail · any-`create` 2/128 · no namespace 1/128 · no
receiver provenance 2/128), and §7.13 records what the extra round found in
them — three more fail-opens of the same class, which is why the round was
worth running rather than a formality.

### 7.10a The one finding left open, and why it is a limit rather than a gap

A request STAGED before the call — `const req = { ...defaults };
client.messages.create(req)` — is not seen by the spread rule. Following it needs
dataflow, which this gate does not do. That is not a patch waiting to happen: it
is the same shape as the HANDOFF that Rule B exists for (§2.6a), one statement
earlier instead of one module over. The honest answer is the declaration, not a
sixth pattern. Written into the module's own docstring as a stated limit.

### 7.10b What six rounds on one file actually says

The file was raised in every round. Reading that as "the audit is churning"
would be the comfortable conclusion and the wrong one: each round found a REAL
fail-open, and four of the six rounds found one I had introduced while fixing
the previous. The honest reading is that **a gate asserting a security-shaped
property over source is harder than it looks, and I under-estimated it three
times — twice by arguing a parser was over-engineering, once by assuming
"fail closed" was free.**

What changed each round is worth recording, because the trend is the argument
for stopping rather than for another round: the regex rounds produced shapes
with no principled enumeration (R1–R3), the AST rounds produced "this node type
also assigns the key" (R4–R5), and round 6 produced two over-broad matches of my
own making plus one declared limit. The defect class is converging even though
the count has not, which is exactly the judgement the cap exists to hand to a
human.

---

## 7.11 Four coordinator addenda, answered by measurement

### 7.11a The pin turned `max_tokens` from IGNORED into ENFORCED — and killed two sites

**This is a regression this PR introduced**, found by the addendum's question
rather than by any of the six audit rounds. MEASURED 2026-11-15 against
`claude-haiku-5-5` on each site's own prompt:

| site | cap | on sdk, measured | consequence |
|---|---|---|---|
| `work-unit-labels` | **64** | `stop_reason: max_tokens`, thinking_tokens **64**, **zero text blocks** | **every label underived.** 100% dead |
| `refine-prompts` | **2000** | `stop_reason: max_tokens`, thinking 1206, text cut mid-sentence | truncated suggestion |
| `context.mjs` brief | 2000 | thinking 2000, zero text blocks | already fixed in §7.5a |
| `arm-eval/judge` | 4000 | not re-measured live (Opus spend); it joins ALL blocks so it has no index-0 bug, and §7.11b changes how its failures are recorded | **inferred**, flagged |

On `cli` the cap was **accepted and ignored**, so 64 never bound. The pin makes
it bind. New caps are measurements, not guesses: labeller 64 → **1000**
(measured 600 and 1000 both `end_turn`, thinking 149–183; `MAX_LABEL_CHARS`
bounds what is kept, so a generous cap costs thinking, never a long label);
refine 2000 → **4000** (measured `end_turn`, thinking 552, 3695 chars complete).

**And the same index-0 bug was at THREE sites**, not one:
`res.content[0].text` is the THINKING block on a thinking-capable model. One
reader now lives at the seam — `textFromResponse` — because three spellings of
one question deserve one answer.

**The generalisable rule: changing which backend serves a call changes which of
its parameters are ENFORCED, so every cap at a moved site is a new number that
needs measuring.** I pinned four sites and re-measured one. That is the gap the
addendum closed.

### 7.11b `unavailable` is not `non-conformant` (judge)

`callJudgeDefault`'s catch returned `{conformant:false, error}` for every throw
but the egress gate, so a missing credential read as a judgement about the
judge's OUTPUT. Load-bearing here, not adjacent: the pin makes it reachable on a
keyless install. `unavailable: true` now propagates out of `judgeSession`;
`conformant` stays false so every consumer still fails closed. The corrective
retry is SKIPPED when unavailable — a credential does not appear because the
prompt was reworded, and the retry doubled the spend on a dead config. A
positive control asserts a genuinely non-conformant judge still gets its retry.

Scope boundary: `decision.mjs` already returns an EMPTY decision for a
non-conformant judge rather than a scored-against row, so the per-arm
conformance rate is not depressed by this. Re-working that accounting to record
`unmeasured` is a measurement-semantics change on a spend-bearing harness and is
left out deliberately (§8.6).

### 7.11c Azure: NOT a blocker, proven on the emitted request

`tests/anthropic-pin-on-azure.test.mjs`, asserting on url + headers + body, never
the client config:

- A site pinned to `{backend:'sdk'}` with **no public `ANTHROPIC_API_KEY`** emits
  to `https://tenant.openai.azure.com/anthropic/v1/messages` with the **Azure**
  `api-key`, and `system` survives. The omitted `azureRoute` adopts the tenant
  route, so a keyless-for-public Azure install is served by Foundry.
- A stray public key is **not** sent to the tenant endpoint — the 2026-08-13
  cross-service-credential rule, asserted on the wire.
- A **misconfigured** profile (endpoint set, credential missing) makes BOTH
  availability oracles THROW, by design. `isClaudeAvailable()` always did, so
  the backend-aware oracle did not introduce it; pinned under `work-unit-labels`
  it degrades inside the existing try, and `refine-prompts` calls it outside one
  — pre-existing and unchanged. The deliberate refusal to demote to the public
  endpoint is NOT weakened.
- **Precedence today, recorded not changed**: ambient `CLAUDE_BACKEND=cli` WINS
  over an active Azure route, because the route is consulted only once the
  candidate backend is sdk. So on a tenant with cli set, a serviceable call is
  spawned against PUBLIC Anthropic while Foundry sits unused — measured, nothing
  reached the tenant. A pinned site on that same install does reach Foundry,
  which is why the precedence is survivable today. Left for a policy decision
  (§8.7).

### 7.11d The refusal set is a DENYLIST, and the fix is a follow-up

Correct and conceded. The cli adapter destructures
`{model, max_tokens, system, messages}` and discards the rest, so naming three
params refuses three and lets the next one through by default. Census of every
`messages.create` body key in the repo (AST, 19 call sites):

| key | sites | cli can represent it |
|---|---|---|
| `model` / `max_tokens` / `messages` | 19 | yes |
| `system` | 10 | passed as `--system-prompt`, then outranked |
| `tools` / `tool_choice` | 3 | no — refused today |
| `stream` | 1 | **no — silently dropped** |
| a spread | 1 | unknowable |

Plus `output_config` (reasoning effort), which is assigned rather than written
as a literal and so is invisible to that scan — itself an argument for an
allowlist over a pattern.

**Proposed as a follow-up, not dropped** (§8.8). It flips the seam's refusal
semantics for every future key, which wants its own audit, and this PR is
already at the round cap. The cross-backend contract test belongs with it, since
it asserts the allowlist's contract.

### 7.11e Wording, checked

No doc, error string or comment says cli "ignores" or "drops" `system`; the
module has always said it is **not honoured as an instruction** because the
persona and its ~164K context outrank it. One AGENTS.md line lumped `system`
with the dropped params and now says "dropped or OUTRANKED" with the
`--system-prompt` fact stated. Restated once more in §7.12, because "not
honoured as an instruction" still reads as *never*, and the measurement says
*not reliably*.

---

## 7.12 The `system` claim, narrowed to what was measured (2026-11-15)

**Louis's decision: keep the throw.** This section records the claim the throw
now rests on, because the earlier wording claimed more than the evidence.

Two measurements on the same seam, one prompt family:

| prompt | cli result | sdk result |
|---|---|---|
| the REAL `NORMALIZE_PROMPT` | 1995–2784 output tokens in ~40s against `max_tokens: 200`; first-person Claude Code prose citing AGENTS.md | the requested one line, 29–43 tokens, 1.3s |
| a SHORTENED variant | a **correct one-line answer, 3 of 3 runs** — still 466–673 output tokens | — |

So all three of these are true at once, and the first two are what a reader of
the old wording would have got wrong:

1. `--system-prompt` **is passed**, and the string **reaches the model**.
2. A **simple instruction is obeyed**.
3. A **structured-output contract is outranked** by the agent persona and its
   ~164K-token auto-discovered project context, which is also charged on every
   call whatever the prompt says.

**Why that still justifies a throw rather than a warning.** The seam decides
from the params, and *nothing in the params distinguishes a simple instruction
from a contract a consumer will parse*. "Sometimes honoured" is the worst
property a transport can have for a contract: a warning would be ignored on the
runs that work, and the runs that fail do so as a model failure one layer up —
which is the exact conflation this change exists to end. `arm-eval/judge.mjs`
scoring its own transport failure as `conformant: false` is that failure mode
with a row written to the store.

**What this is NOT a claim about.** It does not say cli ignores `system`, drops
it, or fails to deliver it — `tools`/`tool_choice` are the params that are
genuinely dropped, and conflating the two overstates the case for the throw. A
future operator who wants cli for `system`-passing work has a real option the
measurement supports (shorten the prompt, accept the prefix, verify the parse);
this PR declines to make that the default, and says why rather than implying it
is impossible.

---

## 7.13 Round 7 — the extra round, over the WHOLE PR diff (2026-11-15)

**Louis's decision after the round-6 card: keep the `system` throw, run one more
round.** Scoped deliberately to all 41 changed files rather than the last
commit, because round 6's fixes, the four addenda and the wording restatement
had never been read adversarially. **H:11 M:18 L:2** — the count went UP, and
that is the scope widening, not a regression: 15 files were in front of the
auditor for the first time.

20 accepted · 7 dismissed · 5 deferred · 32/32 ledgered · 5/5 deferrals captured.

### The three that justified the round

All one class, and the worst class a MERGE GATE can have — it did not miss a
site, it **certified** one:

| | the shape | why it was certified |
|---|---|---|
| 1 | `{ ...opts(), get backend() { return 'cli'; } }` | `isValueProperty` is false for an `ObjectMethod`, and `argRestsOnFactory` `continue`d past it. `resolveBackendOfArg` has always called that shape unresolved — two answers to one question inside one module |
| 2 | `switch (x) { case 1: return a; default: }` | an EMPTY consequent read as terminating, so the one path that falls out with no value counted as a return. The allowance exists for stacked fall-through labels; it now applies only when a LATER case terminates |
| 3 | `const mk = ns.createAnthropicClient` | a factory LIFTED off a seam namespace was not a binding, so every call through it was invisible to BOTH rules and the file read as containing no client at all |

Each verified red against the pre-fix module (exactly 3 of 134 fail), each with
a positive or negative control beside it, so the fix cannot have closed the hole
by refusing the shape the escape hatch exists for.

### What only the wider scope could see

- **The unconditional sdk pin made a RESUME inherit a transport.** An arm file
  recorded under `cli` would have had sdk rows appended — two prompt prefixes,
  two `max_tokens` semantics, two meters — in the file that is compared ACROSS
  arms. `assertResumableBackend` refuses; a warning on a long run is read after
  the spend. An arm with no recorded provenance still resumes: an unknown
  transport is not a known-different one.
- **`isClaudeAvailableFor` THROWS on a half-configured Azure profile** — this
  PR's own test asserts it — and five call sites asked that about an OPTIONAL
  capability inside no try block, `audit-loop.mjs`'s final-review gate among
  them. `claudeAvailability` sits beside the oracle it wraps: not a second
  oracle, and not a silent `false`, which would report a broken route as an
  absent one.
- **`defaultLabeller`'s blanket `catch { return null }`** meant no rejection
  could reach `getLabeller`, so the `providerThrew` distinction added in the
  addenda was unreachable in production.
- **A raised cap is half a fix.** 64→1000 and 2000→4000 fixed the measured
  samples; a ceiling cannot make a longer answer fit, and a truncated label is
  worse than none — short, plausible, cached for the TTL. All three sites check
  `stop_reason`, and a test asserts the cap and the check travel together.
- **`normaliseArgText` merged tokens**: whitespace was dropped outright, so
  `typeof x` and `typeofx` shared a digest. Collapsed to one space where it
  separates tokens. The regex-literal half is a STATED limit rather than
  engineered around — it needs the parser's token stream, cannot occur in an
  options object, and fails toward a shared digest, never a false alarm.
- **Two tests were not checking what they claimed.** One compared a pure
  function with itself (a tautology that passes whatever the adapters do); it
  now asserts on two real clients. The other matched the first `max_tokens` in
  the source — and each of those files now carries a comment quoting the OLD
  cap, so a comment edit could have turned it red or green with the request
  unchanged.

### Dismissed, each checked in the enforcing code

- **`--selfcheck-relocation` ordering** (3rd raise): the repo-wide smoke
  contract all 26 CLIs implement, and AGENTS.md's own declared non-finding for
  the stdout-flush gate. A change to all 26 is §8's follow-up.
- **No `{ok:false}` envelope on failure**: `check-windowed-views.mjs`, the
  nearest sibling gate, emits none either. These gates are read by humans and by
  `npm run check`'s exit code.
- **"The census ignores requests staged before `messages.create()`"**: false.
  `paramsInSource` walks EVERY object property in the file, deliberately not
  restricted to a `create()` argument; `walk()` ignores a visitor's return value,
  so the early `return` stops no descent; and Rule A is evaluated BEFORE and
  independently of the declared baseline, which is the undeclarable-away
  property the gate was built for.

### The final review, in seven disjoint batches

`FULL_CODE_MAX_CHARS` is a hard 100,000-char constant and `windowTargetFor`
divides it by the changed-file count — ~2.4K of window each at 41 files, which
is why round 6's gate reported **PARTIAL, 1917 of 2657 changed lines never
shown**. No flag tunes it, so the review runs as disjoint batches whose union is
every changed file, with disjointness and completeness asserted in both
directions first. Five new findings, **0 blocking**, 0 wrongly dismissed — and
one of them was a real silent failure: `auditPinCensus` sets `ok: false` on
`unparsed`, and the CLI printed every category but that one, so the gate exited
1 with nothing on stderr explaining itself, on exactly the file most likely to
be mid-edit. Now reported, and asserted MECHANICALLY from the verdict's own keys
rather than from a list written beside them — a list would be updated by the
same person who forgot the loop.

A sixth finding is recorded as a follow-up rather than acted on: `npm run
stdout:flush:gate`'s census walks `scripts/*.mjs` and never descends into
`scripts/symbol-index/`, so it reported "at baseline" over a corpus that had not
looked there. The one site in this diff is fixed; widening the gate's corpus
changes a ratchet population repo-wide and is not a round-7 change.


## 8. Follow-ups (not this change)

1. **The ~164K prefix tax on every remaining `cli` call** (§2.4) is the larger
   number and is untouched here. The options are all policy, not correctness:
   drop `cli` entirely, or accept 1.6×/2.7× on the free meter for the
   `system`-less calls. Louis's call.
2. **`arm-eval` AND `solo-control-audit` results recorded under ambient `cli`**
   are suspect: §2.6 shows the judge scoring its own transport failures as
   `conformant:false`, and §2.6a found `solo-control-audit`'s default path doing
   the same for every pass while recording `provenance.backend: 'cli(default)'`.
   Any stored verdict produced on `cli` with `system` set may be measuring the
   transport. Worth a dated query before any of those numbers is quoted again —
   and the solo-control rows are the ones compared ACROSS arms, so a mixed
   population is worse there than a uniformly bad one.
3. **The 13 existing `{backend:'sdk'}` pins are now load-bearing, not
   redundant.** Under the first (routing) shape they were belt-and-braces over
   an automatic coercion; under throw-and-pin they ARE the mechanism by which
   those calls reach a transport that can serve them. Removing one would now
   break the call, not merely make its intent implicit. `anthropic:pin:gate`
   enforces that they stay.
4. **`--selfcheck-relocation` ignores the POSIX `--` terminator** in all 26 CLIs
   that implement the smoke contract, so `-- --selfcheck-relocation` triggers it
   and an unknown flag beside it is not rejected (§7.6b). Real, uniform, and a
   contract-level change: it belongs in one pass over `cli-io.mjs` plus the
   contract text in AGENTS.md, not in a backend-routing PR that would leave one
   file behaving differently from the other 25.
6. **The judge's conformance ACCOUNTING** — `decision.mjs` returns an empty
   decision for a non-conformant judge, so an `unavailable` one is not recorded
   as `unmeasured` either. Changing that is measurement semantics on a
   spend-bearing harness and wants its own change (§7.11b).
7. **Ambient `CLAUDE_BACKEND=cli` wins over an active Azure route**, so a
   serviceable call on a tenant goes to public Anthropic while Foundry sits
   unused (measured, §7.11c). A policy decision, not a defect. If a refusal is
   wanted, the faithfulness seam IS the natural home: it already decides
   per-call from state the caller did not choose, and `reconcileBackendWithBaseUrl`
   next to it already refuses a cli/destination contradiction — an active route
   is the same shape of contradiction one level up. It would be a THROW under
   throw-and-pin, not a coercion, and would need the same per-site pin census
   this PR did for `system`.
8. ~~**The refusal set is a DENYLIST; make it an ALLOWLIST**~~ — **SHIPPED
   2026-11-15, as its own PR.** See §9.
9. **AGENTS.md has 238 characters of headroom** against its 79,000 cap after
   this change (the reshape itself was net +12 chars, having reworded in place
   rather than adding). The gate's own message is the
   finding: *"the next invariant will not fit, and shaving words to squeeze
   under the cap is how a file stays permanently full."* The prescribed remedy
   is condensing a dossier-grade section to a what-it-is / when-you-need-it /
   pointer stub — `context:check` names `Consumer-repo layout` (7,793),
   `Architecture` (7,763) and `Postgres-Parity Store` (6,282) as large AND
   already pointing at `docs/`, so their depth is duplicated rather than
   resident. Not done here: it is unrelated to this change, and quietly
   rewriting three other sections inside a backend-routing PR is the scope
   expansion AGENTS.md's own scope-discipline rule forbids.

---

## 9. Addendum 4 — the refusal set became an ALLOWLIST (shipped 2026-11-15)

§8 item 8, deferred out of the parent PR deliberately because it changes
refusal semantics for every future param. Its own change, its own review.

### 9.1 What the oracle now asks

`unserviceableCliParams` asked *"is this call carrying one of these three
params?"* It now asks *"is every param on this call one the cli backend can
serve?"* The serviceable set is `SERVICEABLE_CLI_PARAMS` —
`{model, max_tokens, messages}` — and anything else throws with the same
throw-and-pin remedy.

Two things the allowlist had to get right, or it is worse than the denylist it
replaced:

- **`max_tokens` stays serviceable.** It is as unenforced on cli as `system`
  is unhonoured, but the membership test settled in the parent PR is whether
  the param being unmet changes the ANSWER the caller receives, and an unmet
  ceiling gives the answer that was asked for, possibly more of it. Refusing on
  it would refuse every call (every caller sets it — the Messages API requires
  it), collapsing the routing into "cli is never usable" and moving all of the
  operator's spend off the Max 20x credit. The module's docstring carries that
  reasoning next to the list it justifies.
- **A key the scan cannot resolve fails CLOSED, in its own words.** "This call
  passes a param cli cannot honour" and "I cannot tell what this call passes"
  are different facts. The oracle returns `kind: 'unrepresentable' |
  'unresolvable'` and the two verdicts share no wording; the gate's
  spread/computed-key message says the same thing. Collapsing them into one
  string is how a true positive gets dismissed as noise.

### 9.2 The census, re-measured on this branch

Re-derived by AST over every tracked `scripts/**/*.mjs` (`messages.create`
argument 0, 2026-11-15). It reproduces §7.11d exactly:

| key | literal call sites | under the allowlist |
|---|---|---|
| `model` / `max_tokens` / `messages` | 19 each | serviceable |
| `system` | 10 | refused (was refused) |
| `tools` / `tool_choice` | 3 | refused (was refused) |
| `stream` | 1 | **refused (was SERVED)** |
| spread into the argument | 1 | unresolvable → fails closed |

26 `messages.create` call sites in all; 19 pass a literal object, 7 pass a
staged request variable (the declared dataflow limit, unchanged). `output_config`
is assigned onto a request variable at three sites and appears in no literal, so
a key-scan cannot see it at all — which is the second half of the argument for
an allowlist: a denylist can only refuse what someone thought to name, and these
are params that did not exist when the names were chosen.

### 9.3 Blast radius: zero new pins

`npm run anthropic:pin:gate` is clean with the baseline unchanged. All five
declared-unpinned files — `anthropic-ping.mjs`, `neighbourhood-query.mjs`,
`visual/explain.mjs`, `symbol-index/summarise.mjs`,
`symbol-index/summarise-domains.mjs` — send exactly `{model, max_tokens,
messages}`, which is the allowlist. **The summariser, the highest-volume
deliberately-cli site, is untouched**, so no spend moves off the Max credit.

`stream`'s one site is `streamAnthropicMessage` in
`lib/final-review/transport.mjs`, and every client reaching it is already pinned
`{backend:'sdk'}` by `final-review/providers.mjs` and `final-review/shadow.mjs`.
Decided on the code at the site rather than assumed: the runtime refusal is
unreachable there today, and the value of naming `stream` is that the NEXT
caller of that helper cannot reach it from an ambient-cli client silently.

### 9.4 What the flip found: a gate asking a stricter question needs an exacter subject

The first clean-looking run of the gate failed on
`symbol-index/summarise-domains.mjs:91` for passing `signal` — which is
`create(params, requestOptions)`'s SECOND argument, transport options the cli
adapter honours. The census had always looped over every argument of the call;
under the denylist that was harmless, because argument 1 never spells `system`.
The allowlist made the sloppiness load-bearing in one step, and it would have
pinned a deliberately-cli site for a param that is not a param.

Generalises: **when a rule's question gets stricter, its SUBJECT has to get
correspondingly exact.** Recorded as a `GREEN:` case in
`tests/anthropic-pin-census.test.mjs` — the direction the gate must not fire.

### 9.5 Ordering: the faithfulness verdict now runs FIRST

`createCliAdapter`'s `create()` destructured params and ran
`assertOneShotTextMessages` before consulting the oracle. With an `unresolvable`
verdict in play that order answered "I cannot enumerate this call's params" with
`cli backend requires a non-empty messages array` — a true sentence about the
wrong problem, which would send a reader to inspect their messages array. The
verdict is now the first statement in the method.

### 9.6 The cross-backend contract test

`tests/anthropic-backend-parity.test.mjs`: for one set of params, `sdk` and
`cli` either both serve the call or the cli path throws — never one quietly
doing something different from the other.

- Asserted on the **emitted request** both sides: the sdk arm reads the captured
  fetch BODY, the cli arm reads the ARGV the `claude` binary was spawned with
  (its transport's equivalent of a request). Asserting on client config is how a
  misroute passes review.
- Each refused param is asserted to be **honoured by sdk on the wire** first.
  Without that half the test could pass on a param neither backend supports,
  which demonstrates no divergence at all.
- Every ambient var the factory reads is scrubbed, for the reason recorded in
  §7.11c: `anthropic-pin-on-azure` passed locally and failed in CI (3 of 8) on
  exactly that.
- **Negative control, run before claiming green**: widening
  `SERVICEABLE_CLI_PARAMS` to include `stream`, `output_config`, `temperature`,
  `metadata` and `stop_sequences` turns 6 of the 12 cases red and the oracle's
  own suite stays green — so the parity suite, and only the parity suite, is
  what measures the flip.

### 9.7 Round-1 audit of the allowlist (2026-11-15) — two real defects

`SIGNIFICANT_ISSUES | H:6 M:3 L:2`, coverage `complete`, audited against
`origin/main`. Eleven findings, four concerns. Two were real and the rebuttal
written for one of them was **wrong**, which is worth recording rather than
smoothing over.

**The inherited-property divergence — the audit was right, the rebuttal was not.**
`Reflect.ownKeys(params)` sees own keys only, so `Object.create({system:'x'})`
passed the allowlist. The first rebuttal argued this was harmless because
`JSON.stringify` omits inherited properties — true of the **sdk** arm, and
irrelevant to **cli**, whose adapter does `const { system } = params`, and
**destructuring walks the prototype chain**. Measured on the real objects: sdk
emits no `system`; cli reads `'INHERITED'` and would push `--system-prompt`.
That is precisely the cross-backend divergence this module exists to refuse,
and the oracle declared it serviceable. The enumeration is now own ∪ `for…in`.

The deliberation also named the test this would have needed: a case checking
only the sdk body and "cli served it" passes straight over the defect. Both
arms are now asserted. **Generalises: a claim about what a transport does is
settled against the transport, not against the serialization format it happens
to use** — and when two adapters read the same object by different mechanisms,
"what does this object contain" has two answers.

**The staged request escaped the gate.** `const req = { model, max_tokens,
messages, temperature: 0.2 }; client.messages.create(req)` is not an argument
to `.create`, so the scoped allowlist rule could not see it, and the file-wide
rule knew only four named params — `temperature` passed a gate that described
itself as an allowlist. Closed by **shape**: an object literal carrying
`messages` plus `model` or `max_tokens` is a request, judged by the allowlist
wherever it sits. Shape rather than dataflow because it needs no variable
chasing and cannot be defeated by an extra assignment; measured, it flags zero
additional files in this repo. A `messages` key alone is deliberately not
enough — prompt builders and fixtures carry one and send nothing.

**`max_tokens`: deliberation compromised to MEDIUM/LOW, not dismissed.** The
reviewer accepted that refusing every call deletes the backend, and still held
that an unenforced required param is not harmless for every consumer. Its ask
was concrete and is done: each of the five unpinned cli-eligible sites was
audited for reliance on `max_tokens` as a HARD bound, the per-site answer is
recorded in `.anthropic-pin-census.json`, and none relies on one (a probe with
no output contract; a cost budget rather than a correctness constraint;
advisory prose that degrades to `''`; and two summarisers where
`assessBatchCompleteness` reads `stop_reason`, which is the enforcement that
matters). The parity claim is now qualified in both the reference doc and the
suite: `max_tokens` is the **declared exception to parity** — the contract is
about the KIND and SHAPE of the answer, not every numeric bound.

Also fixed: the gate contract's `guards` sentence conflated Rule A (a hard
failure no entry excuses) with Rule B (the declared-unpinned record), and the
parity suite pinned a concrete model id where the house rule wants a sentinel.

### 9.8 Six audit rounds, and what the loop was actually for

Full numbers, the pass census and the final-gate verdicts are in
[`…-audit-summary.md`](anthropic-cli-faithfulness-routing-audit-summary.md).
Three things belong here because they are reusable, not bookkeeping.

**The audit found two defects in the change and four in its own fixes.** Rounds
1–3 each patched the key ENUMERATION — own keys, then `for…in`, then the
prototype chain — and each time the next round found a layer the patch could
not see. That is the signature of fixing instances rather than the invariant.
Round 3's pivot was to ask the invariant instead: **what sdk will SEND (own
enumerable) versus what cli can READ (a destructure, which walks the prototype
chain and ignores enumerability)**, and refuse any key in the difference,
whatever its name. Three rounds of specific keys collapsed into one rule.

**Then round 4 corrected the direction, which is the half that is easy to
miss.** The invariant as first written was too broad: an inherited key the
adapter never destructures — `temperature`, say — is read by NEITHER backend, so
flagging it was a false positive, not caution. The oracle now mirrors the
adapter's actual destructure (`CLI_READ_PARAMS`), and the duplication is
CHECKED: a test parses `createCliAdapter`'s own pattern and asserts set
equality, because a field added to the adapter and not to the list would be
invisible to the divergence check and nothing else reads both sides.

**Two of my own tests asserted the defect as desirable**, and both were caught
by a later round rather than by review. One said "an inherited SERVICEABLE param
is still served" — but an inherited `max_tokens` makes sdk send `{"model":"m"}`,
which the Messages API rejects, while cli serves it happily: a divergence,
pinned as correct. The other used a prototype getter for `tools`, encoding the
over-broad rule round 4 removed. **A test written in the same sitting as the
fix inherits the fix's blind spot**, which is the argument for the adversarial
round rather than for more care.

**One rebuttal was wrong, and the deliberation said why.** Round 1's rebuttal
argued the inherited-property finding was harmless because `JSON.stringify`
omits inherited properties. True of the sdk arm; irrelevant to cli, which
destructures. The deliberation also named the test the fix would need — one
checking only the sdk body and "cli served it" passes straight over the defect.
**A claim about what a transport does is settled against the transport, not
against the serialization format it happens to use.**

### 9.9 The batched final gate, and two things it taught

The gate's first two runs approved over **PARTIAL** coverage — 197 of 1556
changed lines never shown — so it was re-run as **disjoint batches** over the
code files until every changed line had been rendered. Per-batch verdicts and
the combined coverage are in the audit summary.

**A new file is not covered by the rounds that audited its old home.** The
first attempt to fix the census's line count split it into
`anthropic-pin-params.mjs`. The move changed no rule — and the final gate
refused it anyway: coverage `NONE`, gate `blocked`, *"all 1 changed file(s)
were dropped before the reviewer … not selected for the envelope"*. The
envelope is built from the files the AUDIT ROUNDS examined, and a file created
after round 6 appears in none of them. The gate was right: no reviewer had seen
that file at that sha, and "it is only a move" is an argument, not evidence.

Making it an audited subject needs a round past the soft cap, and **the
cap-override was correctly refused** — `--past-cap` is an oversight bypass, and
reaching for one to clear a gate that is accurately reporting an unaudited file
is the wrong direction. So the cause was removed instead: the split is reverted,
and the census is back under the limit by condensing the audit narrative in its
own comments, which belongs in this plan (where it already is) rather than
duplicated at length in the module. **Generalises: when a guard blocks you,
check whether the thing it is protecting against is the thing you just did.**

**A finding can be correct and still not yours to act on.** The same review
flagged the census's file-wide computed-key fail-closed: `{ [someKey]: v }` in
an unrelated lookup table fails Rule A for a file that sends nothing of the
sort. True, and verified on a planted source. It is also #360's deliberate
choice with two tests encoding it, and narrowing it trades that false positive
for a false NEGATIVE — a request built entirely from computed keys is not
request-shaped and would escape. I narrowed it, saw those two tests go red, and
reverted. Captured as debt, with four cases pinning the behaviour so the next
change to it is a visible decision. The reviewer's own disposition said the
same: `approve_with_debt` means capture and list, not re-litigate.
