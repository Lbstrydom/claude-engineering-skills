# Plan: Close the final-review credit loop + admit a cheap shadow

- **Date**: 2026-07-29
- **Status**: Approved
- **Author**: Claude + Louis

> **Audit trail** — `/audit-plan` (SID `audit-plan-1785374489`). **GPT 3 rounds**
> (H:3→3→1, M:2→3→2; 15 findings, all valid, all in-scope, all fixed — zero
> dismissed, zero deferred, no rebuttal round). Stopped at the 3-round cap with
> HIGH down 67%. **Gemini final gate 2 rounds** (R1 CONCERNS, 2 MEDIUM, both
> fixed; **R2 APPROVE, 0 findings**). One R2 invocation hit a 120s transport
> timeout and was **retried, not treated as a pass** — the gate is mandatory.
> Final `arch_coherence: Strong`; `claude_bias_detected: false`;
> `gpt_false_positive_count: 0`; deliberation fair every round.
>
> **Four findings falsified something the draft asserted** — the value of the
> audit here was catching claims, not adding rigor:
> (1) **R1-H1** — `recordFinalReviewFix` writes only `remediation_state`, never
> `user_action`, so a fixed-but-unadjudicated finding would have nagged in a
> `!user_action` queue forever. It also caught the draft breaking this repo's own
> PowerShell operator-doc rule with `--run-id … --commit <sha>`.
> (2) **R2-H2** — "reuses the existing queue, no new store function" was half
> wrong: the projection is broad enough, but it selects `user_action` and **not**
> `remediation_state`, making the classification unbuildable.
> (3) **R3-H1** — the classification table was not a function: `dismissed +
> regressed` matched two rows, and the command matrix contradicted the prose one
> section earlier. Replaced with 9 ordered first-match rules.
> (4) **Gemini R1-M1** — the plan specified a pure renderer *and* said `/ship`
> renders from JSON itself, with no route for a shell-driven skill to reach an
> internal function. As written it was unimplementable.
>
> Residual: none open. Verification of the implementation is deferred to
> `/audit-code` on the real diff.
- **Scope**: backend
- **Stack**: js-ts + postgres
- **Target domain(s)**: `audit-orchestration`, `stores`, `ship`

> **Deliberately small.** This plan is the right-sized replacement for
> [`final-review-shadow-bakeoff.md`](./final-review-shadow-bakeoff.md), which was
> audited to completion and then **parked** because its instrument (six tables, a
> calibration corpus, a 12-row verification matrix) cost more than the ~$20–30/mo
> decision it would settle. Read that plan's PARKED banner first. If this plan
> starts growing new tables, that is the signal to stop and re-read it.

---

## 1. Context Summary

### 1.1 Code trace — what already exists (verified 2026-07-29)

**Cluster A's mechanism is already built. The gap is that nothing calls it.**

| Component | Location | State |
|---|---|---|
| Adjudication writer (accepted/dismissed) | [`runs-findings.mjs:759`](../../scripts/lib/store/runs-findings.mjs) `adjudicateFinalReviewFinding` | Built, tested |
| Remediation writer (fixed + commit sha) | [`runs-findings.mjs:835`](../../scripts/lib/store/runs-findings.mjs) `recordFinalReviewFix` | Built, tested |
| Pending-queue reader | [`cross-skill.mjs:758`](../../scripts/cross-skill.mjs) `shadowOnlyQueue.filter(f => !f.user_action)` | Built |
| Human worksheet renderer | `cmdFinalReviewStats --worksheet` → `lib/adjudication-worksheet.mjs` | Built |
| CLIs | `final-review-adjudicate`, `final-review-record-fix` (flags `--run-id --fingerprint --action --bucket --commit --state`) | Built |
| Tests | [`tests/final-review-adjudicate.test.mjs`](../../tests/final-review-adjudicate.test.mjs) | Present |
| **Any SKILL.md invoking either CLI** | — | **NONE** ⟵ the actual gap |

`recordFinalReviewFix`'s own docstring states why it was written: *"'14 accepted,
0 converted to fixes' … was not a measurement. It was an artifact of there being
no way to record the other outcome."* The writer was added; the **workflow step
that calls it was never added**, so the artifact persists for a new reason —
nobody is prompted, so `user_action` stays null and credit lands only in source
comments (the "unreadable tail" recovered by hand on 2026-07-28).

This is a wiring change, **not** new infrastructure. No migration. No new table.

### 1.2 Code trace — Cluster B

The `openrouter` route is fully built **for the PRIMARY reviewer**:
[`gemini-review.mjs:891`](../../scripts/gemini-review.mjs) carries
`requestExtras: () => ({ provider: {require_parameters:true, sort:'throughput'}, reasoning: {effort:'low'} })`
— the exact pins AGENTS.md mandates, with the measured kimi-k3/glm-5.2 routing
evidence in its comment block.

The **shadow** path cannot reach it. `SHADOW_PROVIDER_SPECS`
([`gemini-review.mjs:1195`](../../scripts/gemini-review.mjs)) admits only
`claude-opus` / `anthropic` / `gemini`; `buildShadowClient` has three branches;
`shadowModelMatchesFamily` knows only the gemini and claude regexes.

**Empirical basis** (smoke test, 2026-07-29, this repo's own
`final-review-shadow-bakeoff` plan + its 3-round GPT transcript as the fixture,
zero code changes, `--provider openrouter` + `FINAL_REVIEW_MODEL=moonshotai/kimi-k2-thinking`):

| | Gemini primary | Kimi K2-thinking |
|---|---|---|
| Parseable JSON | yes | yes (1 field auto-truncated) |
| Latency | 83–95 s | 92 s |
| Verdict / coherence | CONCERNS / Strong | CONCERNS / Strong |
| Cost | ~$0.15 | **~$0.044** |
| Findings | H:1 M:1 L:1 | M:2 L:1 |
| Overlap with Gemini's findings | — | **zero** |

Kimi is operationally viable and ~33× cheaper than Opus. Its findings were all
"specify X more precisely" rather than the consistency/logic defects Gemini
found — one data point, reported as one.

### 1.3 What this plan does NOT claim

It does **not** decide whether a cheap shadow should replace Opus. It makes that
switch a one-line env change so the question can be answered by use rather than
by a campaign. `FINAL_REVIEW_SHADOW` stays operator-chosen and default-unset.

---

## 2. Cluster A — wire credit into the fix workflow

**Goal**: after a `/ship`, a shadow finding that was actually fixed carries
`remediation_state='fixed'` + `fix_commit_sha`, and one that was judged bogus
carries `user_action='dismissed'` — without the maintainer remembering a CLI.

**Design**: a **nudge, never a gate** — the same posture as the quick-fix hook and
the skill recommender. `/ship` must never fail because a label is missing.

### 2.1 The outcome state machine (R1-H1)

Verified 2026-07-29, and it exposes a real defect in the draft's predicate:
`recordFinalReviewFix` ([runs-findings.mjs:860](../../scripts/lib/store/runs-findings.mjs))
writes **only** `remediation_state` + `fix_commit_sha` — never `user_action`.
`adjudicateFinalReviewFinding` (:748) writes `user_action` +
`adjudication_outcome` + `decided_at`. The two axes are deliberately orthogonal
(AGENTS.md), and record-fix explicitly permits a not-yet-adjudicated finding so a
fix-first workflow isn't blocked. Consequence: **a fixed-but-unadjudicated
finding keeps `user_action = NULL` and would nag in a `!user_action` queue
forever.** Widening the filter would hide it; the correct treatment is to name
it as its own state.

**One classifier over the COMPLETE `user_action` CHECK set** (R2-H2 — the draft
covered only 3 of the 7 permitted values). `classifyFinalReviewOutcome({user_action,
remediation_state})` is a pure exported function.

**Evaluated as ORDERED rules, first match wins (R3-H1).** The draft presented an
unordered table whose rows genuinely overlapped — `any | regressed` collided with
`dismissed | any`, `deferred | any` and `unrecognised | any`, so `dismissed +
regressed` matched two rows and the table was not a function. Precedence is now
explicit, and contradictory pairs get their own surfaced outcome rather than an
arbitrary winner:

| # | `user_action` | `remediation_state` | → Classification |
|---|---|---|---|
| 1 | not NULL and **not in the CHECK set** | any | `unknown` (raw value surfaced) |
| 2 | `dismissed` / `auto_dismissed` / `deferred` | `regressed` | **`integrity-warning`** — a dismissed or deferred finding cannot have regressed; surfaced, never silently resolved either way |
| 3 | NULL / `needs_triage` / `fix-now` / `accepted-permanent` | `regressed` | `regressed` |
| 4 | `dismissed` / `auto_dismissed` | any remaining | `closed` |
| 5 | `deferred` | any remaining | `deferred` |
| 6 | NULL / `needs_triage` | `fixed` / `verified` | `fixed-unlabelled` |
| 7 | NULL / `needs_triage` | NULL / anything else | `unadjudicated` |
| 8 | `fix-now` / `accepted-permanent` | `fixed` / `verified` | `closed` |
| 9 | `fix-now` / `accepted-permanent` | NULL / anything else | `accepted-unfixed` |

Rules 1–9 are **total** over `user_action ∈ {NULL} ∪ CHECK ∪ {unrecognised}` ×
`remediation_state ∈ {NULL, fixed, verified, regressed, unrecognised}`; the test
suite enumerates every pair in that product and asserts exactly one
classification each, so a future CHECK widening fails the test rather than
falling through. `needs_triage + fixed` lands on rule 6 (`fixed-unlabelled`) —
deliberately, since the triage marker means "not yet decided" and a shipped fix
is the stronger signal.

No schema change: these are the existing CHECK values (`fix-now`, `deferred`,
`dismissed`, `needs_triage`, `accepted-permanent`, `auto_dismissed`) plus NULL.
The `unknown` row exists because the CHECK constraint has been widened once
before (migration `20260722120000` added `auto_dismissed`) — a future value must
degrade loudly, not vanish.

**The store projection needs one added column (R2-H2, corrected claim).** The
draft said "reuses the existing queue — no new store function". Half wrong:
`getFinalReviewStats`'s `shadowOnlyQueue` query
([runs-findings.mjs:1008](../../scripts/lib/store/runs-findings.mjs)) does **not**
filter on `user_action` — the CLI does, at `cross-skill.mjs:758` — so the
projection is broad enough. But it selects `user_action` and **not
`remediation_state`**, so the classification above is unbuildable from it. The
change is **adding `f.remediation_state` to that SELECT list** — one column, no
new function, no new table. The `!user_action` filter moves out of the CLI and is
replaced by the classifier.

### 2.2 Steps

1. **New read**: `cross-skill.mjs final-review-pending --repo <name>` returning a
   **discriminated, versioned JSON result** (R1-H2, R2-M1) — never a bare count.
   JSON is the machine boundary, never prose to be parsed.

   **Two output modes, because `/ship` is a shell caller (Gemini gate R1-M1).**
   The draft said both "`/ship` consumes this JSON directly and renders the card"
   *and* that a pure JS function owns every rendering rule — contradictory, and
   with no defined route for a SKILL.md driving shell commands to reach an
   internal function. Resolved by making the renderer reachable **as a flag on
   the same CLI**:
   - default → the JSON below (for tests and any programmatic consumer);
   - `--render --commit <sha>` → the CLI calls `renderFinalReviewCard` internally
     and writes **the finished card text** to stdout, empty when there is nothing
     to say. `/ship` runs exactly this one command and prints its output verbatim.

   One renderer, one code path, two surfaces — so the unit-tested function and
   the text `/ship` actually shows cannot diverge.

   ```
   { schemaVersion: 1, state: 'ready', cloud: true,
     counts: { unadjudicated, fixedUnlabelled, acceptedUnfixed, regressed, unknown },
     items: [ { runId, fingerprint, bucket, classification, severity,
                userAction, remediationState, primaryFile } ] }
   { schemaVersion: 1, state: 'disabled' }
   { schemaVersion: 1, state: 'unavailable', diagnostic: <CODE> }
   ```

   `items` carries **only display-safe fields** — no `detail_snapshot`, no DSN,
   no credential. **Ordering is deterministic**: severity (HIGH→LOW), then
   `created_at` DESC, then `fingerprint` ASC as the total-order tiebreak, so two
   runs on unchanged data render identically. Exit code is **0 in all three
   states**; only a usage error is non-zero.

   **Bounded, and counts are exact anyway (R3-M1).** This matters immediately,
   not theoretically: ~63 unadjudicated shadow findings already exist, so an
   unbounded card would print all 63 on the first ship.
   - `counts` come from a **separate aggregate** —
     `SELECT user_action, remediation_state, COUNT(*) … GROUP BY 1,2` over the
     full actionable set, classified in JS. Tiny result, exact totals,
     independent of any page limit.
   - `items` is a **bounded page**: `pageSize` default **10**, hard max 50
     (matching `getFinalReviewStats`'s existing `queueLimit`), taken in the
     deterministic order above. `shownCount` and `totalActionable` are both
     reported.
   - **No cursor, deliberately.** When `totalActionable > shownCount` the card
     prints one overflow line pointing at the existing full-list surface
     (`final-review-stats --worksheet`), which already renders and persists the
     complete queue. Paginating a ship card would duplicate a tool that exists;
     the right-sizing note at the top of this plan applies.

   **Closed diagnostic enum (R2-M2)** — `unavailable` carries exactly one of
   `CLOUD_UNREACHABLE` · `AUTH_FAILED` · `NOT_MIGRATED` · `MALFORMED_RESPONSE` ·
   `UNKNOWN`. A boundary classifier maps every caught failure to one of those
   literals. **`error.message`, `error.cause`, DSNs, headers and provider
   payloads must never be forwarded** into the result, stdout, or the card — the
   code is the entire payload. (`NOT_MIGRATED` already exists as a
   `getFinalReviewStats` error value and maps straight through.)

   **State → command matrix** (literal CLI values, no inference):

   | classification | command the card prints |
   |---|---|
   | `unadjudicated` | `final-review-adjudicate --action accepted` **and** `--action dismissed` |
   | `fixed-unlabelled` | `final-review-adjudicate --action accepted` **only** — a shipped fix implies the finding was real, so offering `dismissed` here would invite a contradictory label (R3-H1: the draft's matrix grouped this with `unadjudicated` and printed both, contradicting §2.1's own prose one section earlier) |
   | `accepted-unfixed` | `final-review-record-fix --state fixed --commit <the resolved sha>` |
   | `regressed` | `final-review-record-fix --state verified --commit <the resolved sha>`, after re-fixing — `--commit` included, matching `accepted-unfixed`; the draft omitted it, which would have recorded a re-verification with no provenance (Gemini gate R1-M2) |
   | `integrity-warning` | none — printed as a warning naming both field values, for manual reconciliation |
   | `deferred`, `closed` | none — absent from the card |
   | `unknown` | none — printed as a warning naming the raw value |

   `--bucket shadow-only` is always passed explicitly (constant for this queue),
   so the ambiguous-bucket refusal can never fire.
2. **`/ship` step**: `/ship` **continues on every non-`ready` state** (R1-H2).
   `ready` with a non-zero count prints an advisory card; `ready` with zero
   counts prints nothing; `disabled` prints nothing; `unavailable` prints one
   non-blocking diagnostic line. **No state can fail the ship.**
3. **Fix-time capture**: the card prints complete, paste-able commands with the
   real resolved values — the SHA read **after** the ship commit succeeds, so it
   is the actual commit, e.g.:
   `node scripts/cross-skill.mjs final-review-record-fix --run-id 9c09c543-dd4b-4013-9c60-4faf29fb62a7 --fingerprint 7b4952b5 --bucket shadow-only --commit a1b2c3d --state fixed`
   Every flag present, no ellipsis, **no `<angle-brackets>`** (PowerShell
   reserves `<`; the draft of this plan violated the repo's own rule here).
   **The maintainer selects which finding** — never inferred from "a file
   changed", the guesswork the parked plan forbade.
4. **A pure renderer is the testable boundary (R3-M2).** A SKILL.md is an
   instruction artifact, not an executable seam, so "three `/ship` regression
   tests" could not have been satisfied by the reader test alone. Split the
   concern: the reader owns the JSON, and a **pure
   `renderFinalReviewCard(result, {commitSha})` → `string`** owns every rendering
   rule (which commands appear, exact flag values, the overflow line, the
   warnings, and returning **`''`** for `disabled` / zero-count `ready`). It is
   deterministic and directly unit-testable; `/ship` only prints what it returns,
   reaching it through the `--render` flag in step 1 rather than by calling into
   the module. `skills/ship/SKILL.md` names the exact phase — **after the commit
   succeeds**, so the SHA passed to `--commit` is the real one — and the single
   canonical invocation.
5. **Skill docs**: `skills/ship/SKILL.md` is the **sole authoritative source**;
   `.claude/skills/ship/**` is a **generated Category-B artifact** regenerated by
   `npm run skills:regenerate` and freshness-verified by `npm run skills:check`
   in the pre-push `check` (R1-M1). Edit the authoritative copy only; never
   hand-edit the generated tree.

**Files**: `scripts/cross-skill.mjs` (one reader + one CLI case + `KNOWN_FLAGS`
entry), `scripts/lib/store/runs-findings.mjs` (**+1 column** in the
`shadowOnlyQueue` SELECT, **+1 aggregate query** for exact counts), a pure
`classifyFinalReviewOutcome` + `renderFinalReviewCard` (colocated),
`skills/ship/SKILL.md`, **regenerated** `.claude/skills/ship/**`.

| Test file | Covers |
|---|---|
| `tests/final-review-pending.test.mjs` | the three result states; **every pair in the §2.1 rule domain** (one classification each); deterministic ordering; `pageSize` bound + exact-count independence; a **hostile-error test** — synthetic error whose `message` embeds a fake DSN and API key, asserting stdout carries the code alone and neither secret (R2-M2) |
| `tests/final-review-card.test.mjs` | `renderFinalReviewCard` — the state→command matrix verbatim (incl. `fixed-unlabelled` offering `accepted` only, and `--commit` present on **both** `record-fix` variants), `''` for `disabled` and zero-count `ready`, the `unavailable` one-liner, the overflow line, and **no `<angle-brackets>` or ellipsis in any emitted command**. Plus one test that `--render` stdout equals `renderFinalReviewCard`'s return for the same input, so the two surfaces cannot drift |

**Non-goals**: no auto-attribution, no new table, no change to either existing
writer.

---

## 3. Cluster B — admit an OpenAI-compatible shadow provider

**Goal**: `FINAL_REVIEW_SHADOW=openrouter` works, with the primary route's
routing pins applied.

### 3.1 The shadow-resolution result contract (R1-H3)

`resolveShadow` already returns discriminated states (`skipped-unset`,
`skipped-azure`, `skipped-unsupported-provider`, `skipped-no-key`, `ready`).
Extend that **existing** vocabulary rather than inventing a parallel one, and fix
the precedence explicitly — the draft left evaluation order and multi-credential
behaviour unstated:

**Evaluation order, in this sequence, no reordering:**

1. provider unset → `skipped-unset`
2. **Azure profile active → `skipped-azure`** — stays FIRST after the unset
   check, exactly as today, so a gateway shadow is a no-op under Azure **before
   any credential is read or client constructed** (R1-M2).
3. unknown provider → `skipped-unsupported-provider`
4. no usable credential → `skipped-no-key`
5. gateway provider with no explicit model → **`skipped-no-model`** (new state)
6. otherwise → `ready`

**Credential resolution** moves behind a per-spec resolver so the single-string
`keyEnv` assumption disappears (the one structural change): existing specs keep
a one-variable resolver; `openrouter` delegates to the existing
`resolveOpenRouterCreds()`, inheriting its documented precedence
(`FINAL_REVIEW_API_KEY` first, then `OPENROUTER_API_KEY`). With both set the
first wins — deterministic, not an error. The resolver returns only a
**boolean "usable"** to `resolveShadow`; the secret itself never enters the
result object, the log line, or the persisted `_shadow` block.

### 3.2 Steps

1. `SHADOW_PROVIDER_SPECS` gains an `openrouter` entry whose `canonical` is
   `'openrouter'` — matching the `PROVIDERS.openrouter` key is what earns the
   routing pins for free (§3 item 4).
2. `buildShadowClient` gains an `openrouter` branch delegating to
   `resolveOpenRouterCreds()` + `createOpenAIClient({oss:{…}})` — no new client
   code.
3. **Family check**: a gateway passes model ids verbatim (descriptor D6: no
   `resolveModel` sentinel rewrite), so a `gemini|claude` regex cannot validate
   `moonshotai/kimi-k2-thinking`. Gateway specs are marked as such and skip the
   family check, requiring an explicitly pinned `FINAL_REVIEW_SHADOW_MODEL`
   instead — `skipped-no-model` when unset, never a silent default.

### 3.3 `skipped-no-model` consumers — traced, not assumed (R2-H3)

The new state must be inert everywhere an existing skip state already is.
Verified consumer inventory:

| Consumer | Handling required | Verified state |
|---|---|---|
| `runShadowAndPersist` (:1435) | takes the skip branch; `runShadowReview` never called ⇒ **no client, no request, no spend** | already generic — branches on `state !== 'ready'` |
| `shadowSkipBlock` (:1405) | persists `{state, provider, model, verdict:null, …}` | **already generic** — echoes `shadow.state` verbatim, so the new state serialises with no change |
| `_shadow` block on the result | carries the state for the operator | inherits the above |
| stderr log line | names the skip reason | inherits the above |

So the code change for this state is confined to `resolveShadow` itself; the
representation is free. **The plan asserts this because it was traced, not
because it seemed likely** — an integration test from env → `runShadowAndPersist`
asserts the `_shadow.state` round-trip and that no client is constructed.
4. **The routing-pin risk — VERIFIED RESOLVED 2026-07-29, no plumbing needed.**
   The draft flagged as unverified whether `requestExtras` reaches the wire on
   the shadow path. Traced: `runShadowReview`
   ([gemini-review.mjs:1352](../../scripts/gemini-review.mjs)) →
   `runReviewWithRetry` (:1759) → `runFinalReview`, which resolves
   `const descriptor = PROVIDERS[provider]` (:1081) and passes
   `requestExtras: descriptor.requestExtras?.()` (:1112). The shadow supplies
   its **canonical** provider string, so a spec whose `canonical: 'openrouter'`
   matches the `PROVIDERS.openrouter` key gets the pins — and
   `structuredOutput: true` — **for free, via the shared path**. Nothing to
   plumb. The test in §3 files therefore pins existing behaviour rather than
   new behaviour; it stays because the pins are load-bearing and a future
   refactor of the descriptor lookup would silently drop them.
5. **Two consequences the same trace establishes**, both shaping the spec:
   - `modelOverride` (= `shadow.model`) wins over `descriptor.resolveModel()`
     (:1083), so a Kimi **shadow** reads `FINAL_REVIEW_SHADOW_MODEL` and does
     **not** require `FINAL_REVIEW_MODEL` — which is what keeps it from also
     redirecting the primary. This is why step 3's explicit-model requirement is
     the right design and not merely a safety net.
   - `buildShadowClient` has its own provider switch and never calls
     `PROVIDERS[…].buildClient`/`assertReady`, so the openrouter descriptor's
     `assertReady` (which demands `FINAL_REVIEW_MODEL`) never runs on this path.
     Readiness for the shadow must therefore be enforced in `resolveShadow`
     itself — the `keyEnv` + explicit-model checks in steps 1 and 3 are the
     only gate, and there is no second one to rely on.
5. Keep the Azure guard: gateway shadows stay a no-op under an active Azure
   profile, same as today.

**Files**: `scripts/gemini-review.mjs`, `tests/shadow-gateway-provider.test.mjs`
(new — named, so the disjointness claim in §6 is real rather than asserted over a
generic `tests/`; R1-L1). Cases:

| Test | Asserts |
|---|---|
| openrouter + pinned model + key | `ready`, canonical `'openrouter'` |
| openrouter, model unset | `skipped-no-model` |
| openrouter, no credential either variable | `skipped-no-key` |
| openrouter, both credential variables set | asserted at the **client-construction boundary** with a fake client factory and two distinguishable synthetic values: the value handed to `createOpenAIClient` is the `FINAL_REVIEW_API_KEY` one, and **neither** value appears in the resolver result, the log line, or the persisted `_shadow` block. Asserting only `ready` would pass whichever key was chosen (R2-M3) |
| env → `runShadowAndPersist`, `skipped-no-model` | `_shadow.state` round-trips; **no client constructed, no request issued** (R2-H3) |
| **openrouter + model + key, Azure profile ACTIVE** | `skipped-azure`, **and no client constructed / no outbound request** (R1-M2) |
| claude-opus / gemini unchanged | existing states byte-identical |
| shadow request body | `provider.require_parameters` + `reasoning.effort` present — pins existing shared-path behaviour so a future descriptor-lookup refactor cannot silently drop them |

---

## 4. Acceptance criteria

1. **Two SEPARATE compatibility contracts — the draft wrongly stated one
   (R2-H1).** Cluster A is not gated on `FINAL_REVIEW_SHADOW` at all: it reads
   *historical* shadow findings, so it legitimately produces output with that
   variable unset, and a byte-identical claim over it is unsatisfiable.
   - **Cluster B**: `FINAL_REVIEW_SHADOW` unset ⇒ byte-identical to today (the
     standing opt-in invariant; regression-guarded).
   - **Cluster A**: always active, always non-blocking. Its contract is
     *`/ship` cannot fail and prints nothing when there is nothing to say* —
     verified against the **pure renderer** (§2.2 step 4) for (a) pending
     findings present, (b) none present, (c) cloud unavailable. Three distinct
     renderer tests, not one cross-cluster invariant and not an untestable
     assertion about a SKILL.md.
2. `final-review-pending` returns `state:'disabled'` with cloud off, and
   `state:'unavailable'` with a code (never a credential) on a DB/credential
   failure — **exit 0 in every state** bar a usage error.
3. `/ship` continues through `ready`/`disabled`/`unavailable` alike; prints the
   card only for `ready` with a non-zero count. **No state can fail the ship.**
4. A **fixed-but-unlabelled** finding (`remediation_state` set, `user_action`
   NULL) is surfaced in its own bucket, not silently re-nagged as
   unadjudicated and not hidden (§2.1).
5. Every command the card prints is complete and paste-able with resolved
   values — no ellipsis, no `<angle-brackets>`.
6. `FINAL_REVIEW_SHADOW=openrouter` + a pinned model runs and persists a shadow
   observation; without a pinned model it reports `skipped-no-model`; under an
   active Azure profile it reports `skipped-azure` with no client constructed.
7. A test proves `provider.require_parameters` + `reasoning.effort` are in the
   shadow request body.
8. `npm run check` clean; `skills:check` clean after `skills:regenerate`.

## 5. Out of scope

- Any keep/drop verdict on Opus vs Kimi (parked plan's territory).
- Auto-inferring fix attribution.
- Retiring `FINAL_REVIEW_SHADOW`'s claude/gemini providers.

## 6. Execution clustering

- **Cluster A** — §2. Files: `scripts/cross-skill.mjs`,
  `skills/ship/SKILL.md` (authoritative), `.claude/skills/ship/**` (generated by
  `skills:regenerate`), `tests/final-review-pending.test.mjs`. fix-gate: no.
- **Cluster B** — §3. Files: `scripts/gemini-review.mjs`,
  `tests/shadow-gateway-provider.test.mjs`. fix-gate: no.

**Disjointness is now checkable** (R1-L1): the two clusters share no source file
and no test file, and neither needs a shared fixture. Cluster B's tests mock
provider resolution; Cluster A's exercise the cross-skill reader. Either can land
first.
