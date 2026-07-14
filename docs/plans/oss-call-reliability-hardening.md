# Plan: OSS/OpenRouter Call Reliability Hardening

- **Date**: 2026-07-14
- **Status**: Draft
- **Author**: Claude + Louis
- **Scope**: backend

- **Target domain(s)**: `audit-orchestration`, `shared-lib`
- ⚠ **Cross-domain work** — the shared wrapper (`shared-lib`) gains an
  operation-keyed contract that two `audit-orchestration` call sites opt
  into; the boundary is intentional (a shared reliability primitive serving
  multiple orchestration call sites), not incidental coupling.

## Context Summary

**Origin**: a real incident, same day (2026-07-14). `scripts/lib/oss-structured-output.mjs`'s `ossStructuredCall` is the shared call path for every OpenRouter-routed model. Today, GLM-5.2 (used as the tiered-recall pipeline's Stage-1 triager and one of its two required discovery generators) hit a slow/hanging OpenRouter backend in `ai-organiser`. The function's 300s per-attempt timeout with up to 2 retries (worst case ~15 min) produced total silence — no in-flight log line — so the operator killed the whole audit process after 15 minutes, unable to tell whether it was working or stuck. `/brainstorm --with-gemini` (session `1784057448724`) produced two independent proposals plus a Claude synthesis; this plan implements the synthesized design.

**What exists today** (traced directly, not assumed):
- `scripts/lib/robustness.mjs:46-55` — `classifyLlmError(err)` **already has a `'timeout'` category** (`retryable: true`) for any `AbortError`/`ABORT_ERR`. Both brainstorm participants proposed inventing a NEW parallel taxonomy (`oss_attempt_timeout` / `UpstreamProviderError`) without checking this — the real gap is not a missing category, it's that `ossStructuredCall` computes `classifyLlmError(err)` internally for its own retry decision (`oss-structured-output.mjs:261`) but **discards the category before returning** (`error: describeProviderError(err)` is a flattened string, `oss-structured-output.mjs:270-274`). Callers — and therefore `tiered-shadow-log.jsonl`/the learning-store — never see whether a failure was `timeout`/`network`/`http-4xx`/`permanent`.
- `scripts/lib/oss-structured-output.mjs:146-284` (`ossStructuredCall`) — the retry loop. `timeoutMs=300000`, `maxRetries=2` are **hardcoded defaults on every call**, not per-caller. Retry-boundary logging exists (`OSS retry N/M in Xs`, line 264) but there is **no in-flight heartbeat** while a request is outstanding — the exact gap that made today's stall indistinguishable from progress.
- **Four real call sites**, not two (found by tracing every `ossStructuredCall(` reference, not assumed from the incident report):
  1. `scripts/lib/audit/tiered-pipeline.mjs:138-148` (`validatedTriagerCall`) — Stage 1 triager. Called **once per surviving candidate finding, sequentially in a `for` loop** (`scripts/lib/audit/stage1-triage.mjs:346,372` — `for (const envelope of envelopes) { ... await adapters.triagerCall(dto) ... }`, confirmed by direct read, not inferred). This sequential-multiplication is load-bearing for this plan's timeout choice (see Execution Model below).
  2. `scripts/lib/audit/tiered-pipeline.mjs:203-226` (`glmCall`, the discovery-portfolio GLM generator) — one call per round, run concurrently with the Sonnet generator via `Promise.all` (`discovery-portfolio.mjs:112-114`).
  3. `scripts/lib/audit-shadow.mjs:569-578` — the model-A/B/C shadow arm. **CONCLUDED 2026-07-09** (do not re-enable ad-hoc, per session memory) — dormant code, not to be touched by this plan beyond staying backward-compatible.
  4. `scripts/solo-control-audit.mjs:734-739` — the solo author-model control experiment. **Explicitly frozen** per `docs/completed/model-swap-eval-harness.md`'s own audit trail: *"must not appear in any implementation diff."* This plan must not touch this file.
  5. (also `scripts/cheap-triager-validate.mjs:89-101` — a one-off historical validation script, already run 2026-07-12, PASSED. Low-priority dormant caller; must stay working unmodified.)
- `scripts/lib/audit/tiered-shadow-compare.mjs:154-174` (`runShadowTieredPipeline`) — wraps the **entire** tiered pipeline call (Stage 0 → Stage 1 → discovery → Stage 2) in an **outer 20-minute `Promise.race`**. Any change to inner per-call budgets must be reconciled against this outer ceiling so the outer timeout can never fire mid-retry and mask the real inner cause.
- `scripts/lib/model-eval/config/auditor-thresholds.json` — the repo's own precedent for "small, versioned, committed JSON config, reviewed like code" (`version`, `calibrationNote`, structured sub-keys). This plan follows the same shape for the new operation-keyed policy, at a **new, non-model-eval-specific location** (this feature is not model-eval scoped).
- **No dedicated test file exists for `ossStructuredCall`'s retry/timeout behavior today** — only incidental egress-gate coverage in `tests/model-ab-egress.test.mjs`. This plan adds the first one.

**Code Trace**: incident (ai-organiser `.audit/tiered-shadow-log.jsonl`, 2026-07-14T19:10:46.490Z entry, `tieredFallbackReason: "required generator failed: glm: glmCall: providers.ossCall did not return a result.findings array"`) → `discovery-portfolio.mjs::runDiscoveryPortfolio` (glmCall adapter) → `oss-structured-output.mjs::ossStructuredCall` (the shared retry loop, lines 185-276) → `robustness.mjs::classifyLlmError` (already-existing category computed then discarded) → `tiered-pipeline.mjs::validatedTriagerCall`/`glmCall` (the two live production call sites) → `stage1-triage.mjs::runStage1CheapTriage` (confirms the sequential-loop shape) → `tiered-shadow-compare.mjs::runShadowTieredPipeline` (the outer 20-min race this plan must reconcile against).

**Neighbourhood considered**: architectural-memory cloud store returned `cloud:false` for this repo (`repo not found in cloud store; run npm run arch:refresh`) — proceeded without it per the documented degradation path; the direct code trace above substitutes for it here. `compute-target-domains` confirms `crossDomain: true` (`audit-orchestration` + `shared-lib`), no untagged paths.

## Proposed Architecture

```mermaid
graph LR
    subgraph "shared-lib"
        POLICY["oss-call-policy.json<br/>(NEW — operation-keyed<br/>timeoutMs/maxRetries)"]
        OSC["ossStructuredCall<br/>(oss-structured-output.mjs)<br/>+ heartbeat timer<br/>+ operation resolution<br/>+ category passthrough"]
        CLE["classifyLlmError<br/>(robustness.mjs)<br/>— unchanged, reused"]
    end
    subgraph "audit-orchestration"
        S1["validatedTriagerCall<br/>(tiered-pipeline.mjs)<br/>operation: stage1_triage"]
        DISC["glmCall<br/>(tiered-pipeline.mjs)<br/>operation: discovery_generation"]
        OUTER["runShadowTieredPipeline<br/>(tiered-shadow-compare.mjs)<br/>outer 20-min race — reconciled"]
    end
    POLICY -->|resolves timeoutMs/maxRetries by operation| OSC
    OSC -->|classifyLlmError(err)| CLE
    CLE -->|category, now returned not discarded| OSC
    S1 -->|operation label| OSC
    DISC -->|operation label| OSC
    S1 --> OUTER
    DISC --> OUTER
```

**Data flow**: a call site names its semantic `operation` (`stage1_triage` | `discovery_generation`); `ossStructuredCall` resolves `timeoutMs`/`maxRetries` from the committed policy config (falling back to today's hardcoded defaults when `operation` is omitted — dormant callers 3/4/5 above are unaffected). While a request is in flight, a heartbeat timer (independent of the existing abort timer) logs elapsed progress. On terminal failure, the already-computed `classifyLlmError` category is now included in the return value, so `discovery-portfolio.mjs`'s thrown error message and `tiered-shadow-log.jsonl`'s `tieredFallbackReason` can carry it forward for future diagnosis without a live repro.

**Key design decisions**:
- **Reuse, don't duplicate, error classification** (#5 Single Source of Truth) — extend what `classifyLlmError` already returns into the caller-visible contract, rather than the parallel taxonomies both brainstorm models proposed.
- **Operation-keyed, not model-keyed, policy** (#4 No Hardcoding + #3 Modularity) — reconciles the brainstorm's GPT-vs-Gemini disagreement: call sites stay simple (name an operation), the actual numbers live in one reviewable file, and it never needs updating just because a new model is swapped in (the stated future need — testing more OpenRouter models).
- **Optional `operation` param, default preserves today's behaviour exactly** (#18 Backward Compat) — the 3 dormant/frozen call sites (audit-shadow.mjs, solo-control-audit.mjs, cheap-triager-validate.mjs) require zero changes and zero behavior change.
- **Heartbeat only, no streaming, no circuit breaker** — both explicitly considered and rejected in the brainstorm as disproportionate machinery for a low-frequency batch pipeline; heartbeat logging alone resolves the actual reported symptom (silence during a live call).

## Execution Model

**Dependency chain identified** (Phase 1.5): the two call-site changes (tiered-pipeline.mjs) cannot be written correctly until the wrapper's new contract (what `operation` resolves to, what fields the return shape gains) is decided and implemented — a real sequential dependency, not an artificial one. This is reflected in phase ordering below (§7b), but is **not** split into separately-gated §11 clusters: the wrapper change and its call-site wiring must be read together to verify correctness (a reviewer auditing "wire the call sites" needs full context of the wrapper's new contract anyway), so splitting them into two audit gates would add ceremony without adding review value. One cohesive union diff, audited once.

**Worst-case latency reconciliation against the outer 20-minute race** (the concrete numeric check §6 of the incident report demanded): with the chosen `stage1_triage` policy (45s timeout, 1 retry → worst case 90s per candidate) and the confirmed **sequential** Stage 1 loop, N surviving candidates cost up to `N × 90s`. Discovery generation (GLM ∥ Sonnet via `Promise.all`) costs up to `120s × 2 attempts = 240s` (bounded by the slower of the two, and this plan only touches GLM's budget — Sonnet's own timeout is out of scope here). Stage 0 is deterministic (no LLM call, negligible). For a typical candidate count (single digits — Stage 0 already filters before Stage 1 runs), e.g. N=5: `5×90s + 240s = 690s (~11.5 min)`, leaving ~8.5 min of the 20-min budget for Stage 2's Gemini adjudication + overhead. This is workable but not generous — **documented as an accepted, monitored limit**, not silently assumed safe: if production candidate counts routinely exceed ~8-10, the outer budget could still be exceeded before Stage 2 completes. Parallelizing Stage 1 (removing the sequential-loop multiplier entirely) is explicitly **out of scope** for this plan (right-sizing — that is a larger, independent change than fixing today's silence-during-a-hang incident) and is flagged as the concrete revisit trigger below.

## Sustainability Notes

**Right-sizing** (band-aid / over-engineered / chosen):
- **Band-aid**: bump `timeoutMs` down globally for `ossStructuredCall` and call it done. Leaves the silence-during-a-live-call problem unsolved for any future long-running operation, and a global timeout is provably wrong for two call sites with very different latency profiles (today's actual root cause).
- **Over-engineered**: a circuit breaker + per-`(model, provider, operation)` timeout matrix + streaming-as-heartbeat. Explicitly rejected in the brainstorm — this is a low-frequency batch audit pipeline, not a live service; a breaker adds state/failure-modes disproportionate to the problem, and a model-keyed matrix is a maintenance burden that will constantly be stale as new OpenRouter models are tested.
- **Chosen**: an operation-keyed (not model-keyed) policy config + heartbeat logging + category passthrough via the *existing* classifier. Serves the current requirement (two known call sites with different latency needs, today) without inventing infrastructure for hypothetical futures (streaming, breakers) the brainstorm already ruled out.

**Assumptions that could change**: the assumption that Stage 1's sequential per-candidate loop stays a small-N operation (documented above, not silently assumed) — if candidate volume grows, this plan's timeout choice alone won't be sufficient and parallelizing Stage 1 becomes the real fix, not a smaller timeout tweak. **Revisit trigger**: if the heartbeat logging this plan adds shows Stage 1 routinely processing >8-10 candidates per round, or if the outer 20-minute race fires with `fallbackReason` indicating an in-progress (not-yet-failed) inner call, escalate to parallelizing Stage 1 as a follow-up plan.

**Extension points deliberately built in**: the policy config is additive — a future third operation (e.g. `adjudicator_screen` if a Tier-C OSS adjudicator eval is ever run through this same wrapper) is one new JSON entry, not a code change.

## File-Level Plan

1. **`scripts/lib/oss-structured-output.mjs`** (modify)
   - Add `resolveOssCallPolicy(operation)` (or inline resolution) reading the new `oss-call-policy.json` — returns `{timeoutMs, maxRetries}` for a known `operation`, or `{timeoutMs: 300000, maxRetries: 2}` (today's literal defaults, unchanged) when `operation` is omitted/unrecognized. `opts.operation` is a new, **optional** param; explicit `opts.timeoutMs`/`opts.maxRetries` (if a caller ever passes them) still win over the resolved policy (explicit beats config, config beats hardcoded default).
   - Add an in-flight heartbeat: a `setInterval` started alongside the existing abort `setTimeout` (same `try`/`finally` scope, both always cleared), logging elapsed seconds every 15-20s while the `fetch`/`chat.completions.create` call is outstanding. Zero change to request/response handling.
   - On terminal failure (line ~268-274 today), include the already-computed `classifyLlmError(err).category` in the returned object as a new `category` field (`null` on success or on the one non-`classifyLlmError`-routed early-return paths — schema-derivation failure, truncation, JSON-parse failure, schema-validation failure — which already have their own explicit `error` string and don't need re-classification).
   - **Why this file**: it's the single shared call path every current and future OpenRouter-routed model goes through (#5 Single Source of Truth) — the fix belongs here, not duplicated per call site.

2. **`scripts/lib/oss-call-policy.json`** (create)
   - `{"version": 1, "calibrationNote": "v1 bootstrap values from the 2026-07-14 OpenRouter stall incident — recalibrate if either operation still times out routinely.", "operations": {"stage1_triage": {"timeoutMs": 45000, "maxRetries": 1}, "discovery_generation": {"timeoutMs": 120000, "maxRetries": 1}}}`
   - **Why this file**: follows the repo's own established "small, versioned, committed config reviewed like code" pattern (`auditor-thresholds.json` precedent) rather than inline literals scattered across call sites (#3 Modularity, #4 No Hardcoding).

3. **`scripts/lib/audit/tiered-pipeline.mjs`** (modify)
   - `validatedTriagerCall` (~line 141): add `operation: 'stage1_triage'` to the `providers.ossCall({...})` opts.
   - `glmCall` (~line 205): add `operation: 'discovery_generation'` to the `providers.ossCall({...})` opts.
   - No other behavior change — both sites already throw/propagate failures identically; they just now opt into the tuned policy instead of the 300s/2-retry default.
   - **Why this file**: the only two live production call sites that need the new contract.

4. **`scripts/lib/audit/tiered-shadow-compare.mjs`** (modify)
   - Add a code comment at `runShadowTieredPipeline` (near the existing 20-min-race comment, line ~157-165) citing the worst-case reconciliation math from Execution Model above, so a future reader sees the inner/outer budget relationship is deliberate, not accidental. No numeric change to the outer race unless the audit round surfaces a genuine mismatch.
   - **Why this file**: closes the "nested timeouts must be reasoned about together" gap the incident review identified.

5. **`tests/oss-structured-output.test.mjs`** (create)
   - First dedicated test file for `ossStructuredCall`. Cover (Tier 1-adjacent — this module has crisp inputs/outputs suitable for direct testing, per the repo's testing doctrine): policy resolution for a known operation vs. an unrecognized one (falls back to today's literal defaults); the heartbeat timer is set and always cleared (success path AND error path) via a fake client with an injectable delay; the `category` field appears on a classified failure and is `null`/absent on the non-`classifyLlmError` early-return paths; a call with no `operation` behaves byte-identical to before this plan (regression guard for the 3 dormant callers).
   - **Why this file**: this exact gap (no dedicated retry/timeout test coverage) is itself part of what let today's incident go undiagnosed from stored telemetry alone.

6. **`tests/tiered-pipeline-wiring.test.mjs`** (modify)
   - Extend/adjust existing fixture assertions so the two call sites' `providers.ossCall` invocations are asserted to include the new `operation` field (a static-source pin, matching this file's existing pattern of pinning specific wiring details literally).

## Risk & Trade-off Register

- **Trade-off**: shortening `discovery_generation`'s timeout from the implicit 300s to 120s could, in principle, fail a genuinely slow-but-healthy GLM call that previously would have succeeded within 300s. Mitigated by: (a) today's two successful `tieredRunStatus: "complete"` comparisons (2026-07-14, 18:43/18:49 UTC) completed in well under 120s total including discovery, so 120s is not aggressive against observed healthy behavior; (b) the heartbeat makes a genuinely-still-working call visible before it's killed, so an operator can raise the config value with evidence rather than guessing.
- **What could go wrong**: the sequential Stage-1 multiplication (Execution Model above) is a known, accepted limit, not eliminated by this plan — documented with an explicit revisit trigger rather than silently assumed safe.
- **Deliberately deferred**: streaming-as-heartbeat and a circuit breaker (both brainstorm proposals) — genuinely useful ONLY if OpenRouter instability recurs frequently or output sizes grow much larger; premature now (YAGNI — no current requirement forces either).

## Testing Strategy

- **Unit** (`tests/oss-structured-output.test.mjs`, new): policy resolution, heartbeat timer lifecycle (set + cleared on both success and failure paths, via fake timers), category passthrough, backward-compatible no-`operation` default.
- **Integration/wiring** (`tests/tiered-pipeline-wiring.test.mjs`, extend): the two live call sites pass the expected `operation` literal — a static-source pin so a future edit can't silently drop it.
- **Key edge cases**: `operation` omitted (dormant callers); `operation` present but unrecognized (falls back to default, doesn't throw); heartbeat timer firing zero times on a fast call (no spurious log noise); failure BEFORE any classification is possible (e.g. schema-derivation failure) — `category` must be absent/null, not fabricated.
- **Full suite**: run `npm test` — must show zero new failures (the 18 pre-existing sandbox-env failures are the known baseline, not this plan's concern).
