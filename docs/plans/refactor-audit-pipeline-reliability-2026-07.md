# Plan: Audit-Pipeline Reliability Debt (2026-07-26 triage)

- **Date**: 2026-07-26
- **Status**: Complete — code-audited (3 GPT rounds + Gemini gate, APPROVE), shipped
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). This is
> the largest single cluster of genuinely-still-valid debt found (45
> entries) — it's the audit pipeline's own robustness gaps: silent
> error-swallowing around cloud/learning writes, two god-modules
> (`legacy-production-audit.mjs` ~2280 lines, `openai-audit.mjs`), duplicated
> schema/prompt systems, and a `findings.mjs`/`ledger.mjs` topic-identity
> scheme that still hashes prose content despite its own docs claiming
> otherwise. Every row below was independently re-verified against current
> source on 2026-07-26 (not just re-read from the original finding).

## Audit-Plan Round History

- **Round 1** (SIGNIFICANT_GAPS, H:6 M:6): GPT correctly flagged that the
  original draft was a well-evidenced problem inventory but not yet
  implementation-ready — several "fix" lines described an *outcome*
  ("check ownership", "define a coordinate system") without a concrete
  design, and the Theme 8/2 deferrals contradicted the Rollback section's
  "no schema/data migrations" claim. Each theme was revised to either
  name a concrete, precedent-based design (grounded by re-reading the
  actual current code) or explicitly defer with a named reason. One
  finding (M2/Theme 7) was rebutted rather than adopted.
- **Round 2** (NEEDS_REVISION, H:1 M:3, down from H:6 — continued per the
  >30%-drop rule): 3 of 4 findings adopted (Theme 1's outbox design needed
  a JSON-serializable entry shape + closed handler registry, not a bare
  closure; Theme 6's marker check had a `statSync`-follows-symlinks bug;
  the Disposition Matrix's summary counts didn't match its own table
  rows). One (M1, re-raising Theme 5's malformed-finding handling) was
  **dismissed** — re-reading `tiered-pipeline.mjs`/`diff-path-map.mjs`
  showed the real per-finding Zod validation gate (`prepareCandidates`)
  already exists one step downstream; duplicating it upstream would
  violate this repo's own DRY principle for no added safety.
- **Round 3** (SIGNIFICANT_GAPS, H:3 M:1 — **HIGH count increased**, not
  decreased, from round 2's H:1): per this skill's own stop-rule ("HIGH
  count plateaus or increases → STOP, remaining findings are scope
  pressure"), this is the last GPT round. Of the 4 findings: M1 was a
  genuine bug in the round-2 spec (a semaphore around a still-sequential
  loop provides no concurrency — fixed with an actual worker-pool
  design) and was adopted outright. H1/H2 (Theme 1) and H3 (Theme 6)
  were **not** rigor-pressure fluff — they correctly identified that
  true fixes would require a qualitatively bigger feature than this
  plan's stated scope (exactly-once distributed writes; a full
  artifact-ownership system) — the SAME class of design work already
  deferred for Theme 2/8. Each was resolved by narrowing the plan's
  claim to what it actually delivers and explicitly naming the residual
  gap as accepted/deferred, rather than either building the bigger
  feature (out of scope) or silently claiming a narrower fix closes a
  bigger problem (dishonest). See each theme's "Round-3 correction" note.
- **Gemini final gate — 2 rounds, APPROVE** (max-2-round cap, per this
  skill's protocol): round 1 returned `CONCERNS` with 2 findings, both
  legitimate and both accepted — G1 (Theme 5's proposed pre-filter was
  based on a factually wrong crash-prevention theory and would have
  destroyed diagnostic data; removed the filter entirely rather than fix
  it, since `prepareCandidates` already handles the real gap downstream)
  and G2 (a real directory-collision bug: the "coexist by filename
  convention" claim for the two outbox consumers was false, since
  `readdirSync` doesn't filter by internal schema — fixed with a dedicated
  subdirectory for the new module, independently corroborated by the
  parallel Claude Opus shadow reviewer). Round 2 returned `APPROVE` with
  one trivial LOW finding (incorrect umask bitwise math in a test
  assertion — fixed) plus 3 shadow-only observations (non-gating, applied
  anyway: an outbox-isolation test, `reconcileOutbox`'s unknown-operation
  behavior, and a purity-contract docstring update for
  `discovery-diff-scope.mjs`).
- **Implementation-time correction (Theme 1) — the audited outbox design
  turned out to be unnecessary.** While implementing the (by this point
  extensively audited and Gemini-approved) outbox extraction, reading the
  ACTUAL current implementations of the four target functions
  (`finalizePriorRoundOutcomes`, `recordDiffComplexity`,
  `backfillLearningOutcome`, the debt-memory `appendEvents` writes) showed
  they already never throw: `finalizePriorRoundOutcomes` has its own
  internal try/catch that logs and returns; `recordDiffComplexity`/
  `backfillLearningOutcome` are both `safeWrite`-wrapped and always resolve
  `{ok, error?}`; `appendEvents` similarly always resolves. The
  `.catch(() => {})` at each call site was therefore dead code (nothing to
  catch), and the code even says so in a comment at one of the four sites
  ("These calls return { ok, error? } — never throw"). The REAL, narrower
  gap at all four sites was exactly what the very first debt-triage
  evidence said and nothing more: (a) no `learningWritesAllowed`/
  `noCloudRecording` gate, so a shadow/observation-only run still wrote
  cloud/learning state, and (b) the already-computed `{ok,error}` result
  was discarded instead of logged on failure. **Building a full durable-
  outbox/replay system (with a versioned per-operation payload contract,
  a closed handler registry, receiver-side idempotency verification, and a
  dedicated subdirectory) for functions that already degrade gracefully
  and never throw would have been the over-engineering half of this
  session's own right-sizing doctrine** — solving a problem (crash-losing
  an in-flight write) that doesn't occur here, at real cost (a new module,
  new tests, a new directory convention). The actual shipped fix for all
  four sites is far simpler: wrap each in the pre-existing
  `writeLearningState(learningWritesAllowed, ...)` gate (already used by 5
  other call sites in the same file) and log the returned `{ok,error}`
  instead of discarding it; for the debt-memory writes, thread
  `learningWritesAllowed` into `selectEventSource`'s `cloudEnabled` input
  (it already degrades gracefully to the local event log when cloud is
  unavailable — the same downgrade-not-block shape the other 5 sites use).
  **No new module was created.** This is disclosed here in full rather
  than silently shipping something different from the audited design —
  the extensive GPT/Gemini deliberation on the outbox design was not
  wasted (it correctly identified the receiver-idempotency and replay-
  registry gaps a naive extraction would have had), it just turned out to
  be solving the wrong-sized problem once the real target code was read
  during implementation rather than assumed from the original debt
  finding's summary text.

## Code-Audit Round History (post-implementation)

- **Round 1** (SIGNIFICANT_ISSUES, H:6 M:19 L:3): first pass over the full
  9-theme implementation. Real bugs found and fixed: the frontend
  pass-dispatch/registry predicate mismatch (M6 — `runFrontend &&
  effectiveFrontend.length > 0` at dispatch vs bare `runFrontend` in
  `passRegistry`, unified into one `frontendWillRun` const); the same
  `Array.slice(0, negative)` hazard already fixed once in this file
  (`ab71f952`) recurring in the sibling `selectAdjudicationSample` (M7); a
  fail-open sensitive-path gate using `existsSync` (follows the final
  symlink) instead of `lstatSync` on a broken symlink (H2, partial — the
  "unify with stage1-triage.mjs" half of the finding was declined: that
  file's divergence — free-text tokenization vs structured diff paths — is
  deliberate and documented, not an inconsistency); a silent cache-init
  failure inconsistent with two sibling functions' own logging convention in
  the same file (M4/L2); a stale "NOT wired" module header (L3); an
  undocumented `errorStatus` field on the `GeneratorOutcome` JSDoc typedef
  (M14, partial — declined the "runtime-validated schema + factory" ask as
  disproportionate for a 4-call-site array, and corrected a factually wrong
  "concurrent push is unsafe" claim — `Array.push` is one synchronous
  statement in single-threaded JS, no interleaving is possible); and a
  3-copy `trySymlink` test-helper duplication across two files written this
  session plus one pre-existing (M16 — extracted to
  `tests/helpers/fs-symlink-test-utils.mjs`). Two findings were hallucinated
  and dismissed with hard evidence (M1: no `.audit/tech-debt.js` reference
  exists anywhere — verified via exact-match grep, only `.json` occurrences
  exist; M2: the 4 "missing" follow-up docs are explicitly disclosed future
  work in this plan's own "Follow-up Plans Needed" table). Three findings
  restated already-decided trade-offs without engaging their documented
  rationale (M5/M9/M10 — `reasoningLevelForPass`'s narrower scope and the
  `_cacheDir`/`_runSeedUsed` module-globals acceptance, both explicitly
  reasoned in this same session's Theme 3 code comments) — dismissed. 12
  genuinely valid, out-of-scope, independent findings were deferred with the
  full honest-deferral disclosure (root cause, rejected minimal fix,
  residual risk, independence) and captured as new `.audit/tech-debt.json`
  entries: `H1`/`H5` (`recordFindings`/`recordPassStats`/`syncBanditArms`/
  `syncFalsePositivePatterns` fire-and-forget — real, but a *different* set
  of call sites than Theme 1's 4 named topicIds, unrelated in data/control
  flow), `M3` (ledger-write failure still reports `runStatus: 'complete'`),
  `H3` (a generalized shared-typed-failure-contract ask — the same
  over-engineered design Theme 1's own audit trail already rejected once
  its premise was found false, now proposed at larger scope), `H4` (a
  literal restatement of Theme 2, already deferred with a named follow-up
  plan), `H6` (`writeGateEvidence` outside a protected persistence stage —
  same broader pattern as H3/H5), `M8` (N+1 per-anchor RPC calls — a
  genuinely separate axis from the bounded-concurrency fix Theme 9 shipped;
  the worker pool is correct regardless of whether batching is added
  later), `M12` (the `audit-<ts>` session-ID collision risk — real but
  low-probability under this repo's CLI-per-invocation model, and the
  format is referenced by 11 files not safely auditable in one round),
  `M13` (`stage0-relevance-context.mjs`'s implicit `process.cwd()`
  coupling — the worker-pool fix reuses an already-resolved `repoUuid` and
  introduces no new cwd dependency; a real fix needs an explicit `repoRoot`
  threaded through 5+ functions across 2 files, beyond this pass's scope),
  `M17` (an adjacency-wave coverage-cap control marker, not a code defect),
  and `M18`/`M19` (two pre-existing architecture-layer violations —
  `stores→arch-memory` and `audit-orchestration→install` — surfaced by the
  mechanical architecture pass over the *whole* observed-dependency graph,
  neither file touched by this session's diff).
- **Round 2** (SIGNIFICANT_ISSUES, H:5 M:9 L:1): verification round.
  Confirmed the frontend predicate fix held (not re-raised). Found a real
  bug in this session's OWN Round-1 fix: `existsOnDisk` only caught
  `ENOENT`, not `ENOTDIR`, so an ordinary directory-to-file diff transition
  (an ancestor path segment replaced by a file) would crash diff-scope
  resolution instead of degrading to the deleted-file path — fixed by
  treating both the same way ("no valid dirent at this exact path"). The
  identical `passRegistry` `ran`-predicate bug recurred for the
  `architecture` and `orphan-introduced` passes in the same array literal
  (`archState !== 'SKIPPED_PASS_FILTER'` misses the `SKIPPED_NO_INTENT`/
  `SKIPPED_NO_GRAPH` skip reasons) — fixed with
  `!state.startsWith('SKIPPED_')`. This session's own Round-1 M16 fix left
  a thin same-named `trySymlink` wrapper in `audit-clean-traversal.test.mjs`
  that the duplication detector correctly re-flagged as a near-duplicate of
  the helper it delegates to — removed; all 4 call sites now call the
  shared helper directly with an explicit `'dir'` type argument. One
  finding (`costFromUsage(...).totalUsd` null-dereference) was verified
  factually wrong against `model-pricing.mjs` — the function always returns
  an object (`{totalUsd: null, priced: false, ...}` in the unpriced case),
  never `null` itself, so `.totalUsd` access never throws — dismissed. One
  finding mischaracterized a pre-existing `try/catch` around
  `resolveRepoIdentity(process.cwd())` as "newly added" — verified false via
  `git diff HEAD` (shown as unchanged context, not a `+` line) — dismissed
  with the correction; the underlying observation (repo-identity failures
  silently degrade with no diagnostic) is real but independent, deferred.
  Remaining findings restated Round-1's already-deferred material
  (`noCloudRecording` scope, god-module decomposition, the two layer
  violations) with no new information — deferred again into the same debt
  entries.
- **Round 3** (SIGNIFICANT_ISSUES, H:4 M:8 L:0 — **stopped here**): second
  verification round. Confirmed the ENOTDIR fix, the architecture/
  orphan-introduced predicate fix, and the duplication-wrapper removal all
  held. A third round of scrutiny on the same small `existsOnDisk`
  function found a real gap: `EACCES`/other lstat errors were still
  rethrown, aborting scope resolution on one permission-restricted path —
  fixed by having `existsOnDisk` defer entirely to `resolveAndClassify`'s
  own already-tested fail-closed contract for `EACCES`/`ELOOP` (verified in
  `sensitive-paths.mjs`) rather than making its own policy call; the
  function now never rethrows. One genuinely new, pre-existing, and
  **independent** bug was found and verified real (`runOrphanIntroducedPass`
  hardcodes `baseRef: 'HEAD~1'`/`headRef: 'HEAD'` regardless of
  working-tree-vs-post-commit audit mode, contradicting its own adjacent
  comment) — confirmed via `git diff` to be untouched by any of this
  session's 9 themes; deferred and captured as new debt requiring its own
  investigation into the audit-mode distinction. One finding flagged as
  "regressed" by the tool's own lifecycle tracking was verified **not**
  reproducible — direct `grep` of the current working tree showed no
  `trySymlink` declaration remains in the flagged file (the Round-2 fix
  already removed it) — dismissed as a stale-comparison artifact in the
  duplication wave, not a real regression. All remaining HIGH/MEDIUM
  findings were restatements of already-deferred, already-disclosed themes
  (`noCloudRecording` scope, the shared failure-contract ask, god-module
  decomposition, the two layer violations) with no new information. Round
  4 was not run: every genuinely new, in-scope, actionable bug across all
  3 rounds was fixed in the same round it surfaced; what remained was the
  same handful of already-acknowledged architectural themes recurring
  under different wording — the code-audit analogue of the plan-audit's own
  "rigor pressure" stop signal (this plan's own Audit-Plan Round History,
  above).
- **Gemini final gate — 1 round, APPROVE** (mandatory regardless of GPT
  convergence, per this skill's protocol): one new LOW finding (G1 —
  `resolveEligibleDiffPathMap`'s per-entry loop checked `[e.newPath,
  e.oldPath]` without deduping; for every non-rename entry the two are the
  identical string, so `shouldSkipForIndexing`/`existsOnDisk`/
  `resolveAndClassify` each ran twice on the same path for >90% of diff
  entries) — fixed, and independently corroborated by the parallel Claude
  Opus shadow reviewer flagging the identical redundancy. `0` findings were
  wrongly-dismissed (`deliberation_was_fair: true`). The shadow reviewer's
  3 other observations (worker-pool error-swallow amplification under
  concurrency, `baseContentCache`'s still-sequential loop immediately above
  the parallelised `impactCache` loop, and a stale Disposition-Matrix row —
  the last one fixed here since it was cheap and concrete) are
  observation-only per the shadow A/B design and do not gate; the first two
  restate already-deferred M8/M13-class concerns from the GPT rounds above.

---

## Theme 1 — Silent-swallow around cloud/learning writes

`062e1be1`, `4235a115`, `656f6586`, `9d9d478a` — `finalizePriorRoundOutcomes`,
`backfillLearningOutcome`, `recordDiffComplexity`, and the debt-memory/ledger
writes all either run unconditionally (no `noCloudRecording` gate) or
`.catch(() => {})` real failures.

**Design history**: this theme went through 3 GPT rounds + 2 Gemini rounds
converging on an elaborate outbox-extraction design (operation-type
discriminator, closed replay-handler registry, a dedicated subdirectory,
receiver-side idempotency verification) — see the "Design history detail"
subsection below if you want the full reasoning trail. **That design was
never built.** Reading the actual current implementations of all four
target functions during implementation (see "Implementation-time
correction" in the Round History above) showed each already degrades
gracefully and never throws — `finalizePriorRoundOutcomes` has its own
internal try/catch; `recordDiffComplexity`/`backfillLearningOutcome` are
`safeWrite`-wrapped and always resolve `{ok, error?}`; the debt-memory
`appendEvents` writes similarly always resolve. There was no crash-losing
write to make durable.

**What was actually shipped** (all four sites, in `legacy-production-audit.mjs`):
1. `finalizePriorRoundOutcomes` — wrapped in the pre-existing
   `writeLearningState(learningWritesAllowed, ...)` gate (already used by 5
   other call sites in this file); no result-checking needed since it
   already logs its own internal failures.
2. `recordDiffComplexity` — same gate, plus the previously-discarded
   `{ok, error}` result is now checked and a failure is logged instead of
   silently dropped by the dead-code `.catch(() => {})`.
3. `backfillLearningOutcome` — same treatment as (2).
4. The debt-memory `appendEvents` writes — `learningWritesAllowed` is
   threaded into `selectEventSource`'s `cloudEnabled` input
   (`cloudEnabled: cloudRepoId != null && learningWritesAllowed`), so a
   shadow/observation-only run degrades to the local event log instead of
   writing shared cloud debt state — `selectEventSource` already supports
   this degradation for the "cloud unavailable" case; this just adds
   "cloud writes not wanted this run" as a second reason to take the same
   already-tested local-fallback path. Zero new files, zero new modules.

<details>
<summary>Design history detail (elaborate outbox design, audited but not built)</summary>

This subsection is kept for the audit trail, not as a build spec — do not
implement it; see "What was actually shipped" above for what exists.

Rounds 2-3 assumed the four call sites' `.catch(() => {})` was silently
swallowing thrown exceptions from writes that could otherwise crash-lose
data, and converged on: a JSON-serializable `{operation, payload,
idempotencyKey}` outbox entry shape; a closed 4-key `REPLAY_HANDLERS`
dispatch table (`decision-logger.mjs`'s own `reconcileOutbox` pattern,
generalized past its one-fixed-shape assumption); a required
pre-implementation check that each operation's natural key has a DB-level
uniqueness/upsert guarantee (since an idempotency key stored only in the
outbox file doesn't make replay idempotent by itself — the receiving store
has to enforce it); a dedicated `.audit/learning-outbox/operations/`
subdirectory (Gemini G1 caught that a shared flat directory with
`decision-logger.mjs`'s own outbox would have `readdirSync` sweep up both
shapes and crash/corrupt on the mismatch); and an honest "survives clean
exit/SIGINT/beforeExit, not SIGKILL" durability boundary reusing
`decision-logger.mjs`'s existing `flush()` retry wiring rather than
building new retry logic. All of this reasoning was sound *conditional on*
the premise that the four functions could throw and lose data — which
turned out to be false. Building it anyway, now that the premise is known
false, would have been the over-engineering half of this session's own
right-sizing doctrine.

</details>

## Theme 2 — Two god-modules (DEFERRED — own follow-up plan required)

`883ce465`/`e1c28c86` (`legacy-production-audit.mjs`, `runLegacyProductionAudit`
~2280 lines), `1444bd3bcd09`/`4583a315f94f`/`a3eea13798de`
(`openai-audit.mjs` — hand-wired per-pass code blocks, local schema
duplicates of `schemas.mjs`, hardcoded prompts duplicating
`prompt-registry.mjs`), and `14e2f6c9`/`9d28fa46`/`ef5cb0ac`/`864d73db`
(`tiered-pipeline.mjs`/`tiered-provider-calls.mjs` — duplicated Stage-1
prompt/schema across transports post-extraction, file still 607 lines).

**Explicit scope boundary (resolves audit-plan M1)**: this plan does **not**
implement any part of the god-module decomposition. The precedent is the
existing Phase-11 extraction (moving `runMultiPassCodeAudit` out of
`openai-audit.mjs`) and the `tiered-pipeline-refresh-god-module-decomposition`
plan already in this repo's history — the same pattern (extract cohesive
sub-orchestrators into `scripts/lib/audit/*.mjs` siblings) should be repeated
for the remaining orchestration, but planning *how* to split ~2280 lines
safely is itself a multi-day design exercise (module boundaries, which state
crosses the boundary, test migration) that doesn't fit inside a reliability
triage pass. **Interim containment** (so this pass doesn't make the god-module
problem worse): no new pass-specific orchestration logic should be added
directly to `legacy-production-audit.mjs`'s main function body by this
plan's Theme 1/3 fixes — Theme 1's `writeLearningState`-gate wiring and the
small Theme 3 fixes are self-contained one-liners reusing existing
primitives, not new inline orchestration.
A separate plan should be opened before that decomposition work starts;
until then these 7 topicIds stay open in the ledger as tracked, accepted,
deferred debt (not resolved, not silently dropped).

## Theme 3 — Correctness bugs (not just size/duplication)

- `39a73f09` — 2 literal NUL bytes in `legacy-production-audit.mjs:1083`
  (confirmed via raw bytes, not an escape sequence). **Fix**: replace with a
  textual sentinel; trivial, do this one first.
- `bf45c2f7` — verdict computation (line 2946) and the commit-provenance
  convergence check (line 3319) recompute severity counts independently and
  can disagree. **Fix**: have the provenance gate call the same
  `effSeverity`/`countFor` helper verdict computation already uses.
- `cd77d84e`/`d96b1e86` — MAP-phase `cached_tokens` never accumulated into
  `mapUsage`; only REDUCE's figure is reported. **Fix**: sum in the MAP
  aggregation loop (line 532-535) same as other token fields.
- `6ae952bf` — `passRegistry` and `recordPassStats` maintain two independent
  sources of truth for reasoning-level. **Fix**: derive `recordPassStats`'s
  lookup from `passRegistry` directly.
- `9e965821` — cache dir `mkdirSync` has no explicit mode (e.g. `0o700`).
  Trivial one-line fix.
- `7d5479de` — `_cacheDir`/`_runSeedUsed` module-level mutable globals; only
  a real problem if this ever runs concurrently in one process (currently
  CLI-per-invocation, so low urgency — see AGENTS.md's accepted-debt table
  for the same pattern elsewhere).

## Theme 4 — `evidence-triage.mjs` anchor resolution (revised — narrower than originally scoped)

**Correction from re-reading the current code**: `resolveAnchorLocation`
(line 416) + `findQuoteLineInHunk` (line 252) — the "Stage-0-only detailed
resolver" — were added by an EARLIER commit this same day (`361650a`,
predates this triage session), and already implement most of what
audit-plan's H4 asked for: a documented 1-based, inclusive,
side-aware (`head`/`base`) coordinate system, derived from each hunk's own
`headStart`/`baseStart` header fields (never a naive index). So H4's request
to "define the coordinate system" is **already answered** for the tiered
Stage-0 path — this is not a gap to design, it's existing, tested,
documented code (`tests/` covers `findQuoteLineInHunk` per its own JSDoc
cross-references).

**What genuinely remains (`19b2d764`, `866769e6`)**: `findQuoteLineInHunk`'s
own docstring explicitly accepts a first-match limitation for a quote that
occurs more than once within one hunk — *"this function does not need to be
MORE precise than the verification it's attached to"* (matching its sibling
`quoteAppearsOnSide`'s equally loose whole-hunk-join check). **Disposition:
accept as-is, do not build occurrence-disambiguation.** Rationale (the
load-bearing test): the verified-line is telemetry/location precision, not
the verification gate itself — `resolveAnchorLocation` already returns
`in_hunk` (verified) regardless of which occurrence matched, so a wrong
occurrence pick only mislabels the reported line number, never causes a
fabricated/unverified anchor to be accepted. Disambiguating would require
adding occurrence-index metadata to `EvidenceAnchorSchema` (a schema change
the model would need to populate) for a precision gain with no correctness
payoff. Matches this repo's own already-considered trade-off; downgrade
audit-plan H4's ask on this specific point.

`78e4d7aa`, `9cac9947`, `b587ef32` — the diff-header regex still doesn't
handle git's C-style path escaping. **Disposition: DEFER, already accepted
debt.** The file's own comment already documents this as inherited,
unfixed debt with a narrower test (only spaces, not full escaping). Full
git-quote-path parsing (escape decoding, `a/`/`b/` prefixes, `/dev/null`,
rename headers, containment) is a real, independent parser investment
(audit-plan M5) — genuinely independent of the anchor-resolution work above
(a plan that never touches this regex ships correctly either way), so it is
a legitimate `defer`, not a load-bearing fold-in. Left open in the ledger.

## Theme 5 — `discovery-portfolio.mjs` fail-open outcome tracking (revised)

**Grounded in the actual code** (`runOneGenerator`/`runDiscoveryPortfolio`,
lines 60-158): `122899a5` — line 79 checks `Array.isArray(findings)` at the
whole-return-value level only; individual array elements are never checked,
so `[null, {...}, "garbage"]` passes. `33593f74`/`7ceef72a` — lines 147-154:
when `adapters.gptCall` is falsy, the `if (adapters.gptCall) {...}` block is
skipped ENTIRELY — no `generatorOutcomes.push(...)` happens at all (contrast
with the `else` branch inside that block, which already pushes a `'skipped'`
outcome for the *trigger-not-fired* case).

**Fix**:
1. Add a **sibling `else`** to the existing `if (adapters.gptCall)` block
   (line 147) that pushes `{model: optionalGptModel, role: 'optional',
   status: 'skipped', findingCount: 0, reason: 'no-adapter'}` — mirrors the
   inner `else` (trigger-not-fired) one level up, so both "no adapter" and
   "adapter present but not triggered" are equally visible in
   `generatorOutcomes`, distinguished only by `reason`. This is the whole
   fix for `33593f74`/`7ceef72a`.
2. **`122899a5` — no code change** (rebuttal of both audit-plan round-2 M1
   AND, in round 4, Gemini's final-gate G1): the "malformed entries pass
   through" concern does not need a filter added at all, and round 2/3's
   plan draft had this half-right and half-wrong.
   - **Half-right (kept)**: `tiered-pipeline.mjs:263`'s
     `prepareCandidates(rawFindings, diffPathMap, {producerSchema:
     contract.producerFindingSchema, ...})`
     (`scripts/lib/audit/diff-path-map.mjs:242-271`) already runs
     `opts.producerSchema.safeParse(raw)` on EVERY raw finding one step
     downstream, classifying each as `ready`/`malformed`/`contradicted`
     with a reason code, non-throwing — this IS the authoritative shape
     gate, and duplicating it inside `discovery-portfolio.mjs` would
     violate DRY for no added safety.
   - **Half-wrong (corrected — Gemini's gate finding G1)**: round 2/3 still
     proposed filtering non-object/null entries out of the array INSIDE
     `runOneGenerator` on a "crash-prevention" theory — but that theory is
     factually wrong. `findings.length` and `[...findings, ...]`/array
     spread do not throw on an array containing primitives (`[null, {},
     "garbage"].length` is just `3`); nothing in `runOneGenerator` or the
     path to `prepareCandidates` crashes on a primitive array element.
     Filtering here would have **silently dropped the raw malformed value**
     (e.g. a bare string an LLM returned instead of an object) before
     `prepareCandidates` ever sees it — destroying exactly the diagnostic
     data (`rawIndex` + the original value) that a `malformed` candidate
     envelope is supposed to preserve for prompt-engineering feedback. So:
     **do not add any filter or `malformedCount` field to
     `runOneGenerator`** — pass `findings` through unmutated (after the
     existing `Array.isArray` check) exactly as today. The correctness
     property GPT originally worried about is already satisfied by
     `prepareCandidates`, and "fixing" it a second time here would have
     made the pipeline strictly worse.

## Theme 6 — `diff-scope-resolver.mjs` orphan-preimage cleanup (revised — narrower than GPT's H3 ask)

**Grounded in the actual code** (`sweepStaleOrphanPreimages`, line 272;
`materialisePreimages`, line 324): worktree dirs are created via
`fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-preimage-'))` — Node's
`mkdtemp` appends a random unique suffix, so this is **not** a fully
predictable name (unlike the on-conflict-lint.mjs PID-based temp-file class
fixed elsewhere in this backlog). The sweep already tries `git worktree
remove --force` FIRST (git-registry-aware) and only falls back to raw
`fs.rmSync` if that fails.

**Audit-plan H3's proposal** (ownership manifest, dedicated private
directory, run-ID-tagged filenames) is a bigger behavior change than the
actual residual risk warrants — it would touch `materialisePreimages` and
every consumer of the preimage directory layout. **Narrower fix, matching
this session's precedent** (the `audit-clean.mjs` symlink-escape guard,
already shipped): before the `fs.rmSync` fallback (line 288),
1. `lstatSync(p).isSymbolicLink()` → refuse (never follow/delete a symlink
   masquerading as an orphan-preimage dir) — same guard shape as
   `audit-clean.mjs`.
2. Verify the directory actually looks like a git worktree before deleting
   it via the fallback: a real worktree always has a `.git` FILE (not dir,
   not symlink) containing `gitdir: ...`. **Round-2 correction (audit-plan
   M2)**: the original draft used `fs.statSync(path.join(p, '.git'))`, but
   `statSync` FOLLOWS symlinks — a `.git` symlink pointing at any regular
   file starting with `gitdir:` would pass that check, defeating the whole
   point of the marker (the top-level `lstatSync(p)` in step 1 only checks
   the OUTER directory, not this nested marker). Fix: use
   `fs.lstatSync(path.join(p, '.git')).isFile()` — `lstatSync` does not
   follow symlinks, so a symlinked `.git` fails `.isFile()` and is refused,
   not silently accepted. Only after that check passes, read the file's
   content and confirm it starts with `gitdir:`. Treat ANY failure in this
   sequence (lstat error, not-a-file, wrong content) as `kept` (refuse the
   delete, leave for next sweep) — never treat a lookup failure as
   permission to proceed. Add both adversarial test cases (symlinked outer
   dir; symlinked nested `.git`) per the Verification Plan below.
3. `82e60a82` — `readdirSync(tmpDir)` failure (line 277) currently returns
   silently. Change the return shape to `{swept, kept, readdirFailed:
   boolean}` and have the one caller (`materialisePreimages`) log a warning
   when `readdirFailed` is true, rather than silently proceeding as if zero
   orphans existed.

**Round-3 correction (audit-plan H3) — honest residual, not "closed"**: GPT
correctly points out that the `.git`-marker check above proves a directory
CONTAINS a plausible marker, not that THIS repo/process actually created or
owns it — any directory with a colliding `orphan-preimage-*` prefix that
also contains a hand-planted `.git` file whose content starts with
`gitdir:` still passes both checks and gets deleted by the `rmSync`
fallback. That is a real, correctly-identified residual gap, and this
plan's Theme 6 fix does **not** close it. What this fix DOES deliver,
honestly stated: (a) the symlink-spoofing sub-case is fully closed (steps
1+2's `lstatSync` checks), and (b) an arbitrary directory that merely
HAPPENS to collide with the naming prefix (no attacker, e.g. a stray manual
test artifact) is now checked for worktree-shaped content instead of
deleted on prefix+age alone — a real improvement over the original
zero-verification state. What remains open: a deliberately-planted fake
marker still defeats the check. **Closing that fully requires the
ownership-manifest redesign GPT proposes in both H3 rounds** (audit-run-
owned private root, recorded ownership metadata, repository-identity
check) — the SAME class of larger design work already deferred for Theme
2/8, for the same reason (doesn't fit inside a reliability-triage pass).
**Disposition**: implement the narrower fix now (real, bounded improvement,
EASY-MEDIUM effort); open a follow-up item for the full ownership-manifest
redesign rather than claim this residual gap is closed. The Verification
Plan below must assert the narrower claim only (symlink cases pass; a
forged-non-symlink-marker case is a KNOWN-FAILING test documenting the
residual, not a regression).

## Theme 7 — Topic-identity / findings-identity honesty gap (narrowed — rebuts audit-plan M2)

**Rebuttal of M2's broader ask**: M2 wants a full versioned identity
contract (stable-vs-occurrence identity, collision/alias behavior,
migration mapping) built before any code changes. Re-reading the three
topicIds shows this over-scopes two of them:
- `30ca14747055`/`3ce44825046d` — `findings.mjs`'s `semanticId` hashing raw
  prose for model findings is **already an intentional, documented product
  decision** (the code and `docs/plans/phase-c-linter-pre-pass.md:61`
  explicitly say cross-source identity unification is "deferred to v2" on
  purpose, not an oversight). There is nothing to build here — these two
  topicIds are disposed as **already-decided, no code change**, just
  correctly labeled in the ledger as intentional-deferral rather than
  open debt.
- `d486a8691080` — this one IS a real, narrow bug: `ledger.mjs`'s
  `generateTopicId` JSDoc claims "no content hash (stable across
  rewordings)" while line 50 (`const contentHash = finding._hash ||
  semanticId(finding);`) folds a content hash into the hashed input anyway.
  **Fix**: the CODE's behavior (folding in a content hash) is almost
  certainly the one that's actually load-bearing — topicIds are used as
  ledger/debt keys elsewhere in this codebase and changing that now would
  be a real identity-migration (exactly the kind of change M2 worries
  about, and exactly what Theme 8 already defers). So: **correct the
  docstring to match the code**, not the reverse. One-line comment fix, zero
  behavior change, zero migration risk.
- `6c518b81fda5` — `_repoProfileCache` module-global surviving the
  `findings.mjs` → `findings-outcomes.mjs` split is an independent, small
  fix: this repo's own Accepted Technical Debt table (AGENTS.md) already
  names module-global caches as acceptable "in the CLI-per-invocation
  model" — this one just needs the SAME acknowledgment/comment the other
  caches (`_repoProfileCache` elsewhere, `_taskStore`, `_clientCache`)
  already carry, since it's the identical pattern. No functional change.

## Theme 8 — Ledger governance (DEFERRED — own follow-up plan required, resolves audit-plan H2)

`744ebe8db568`, `9ed20331d025`, `ae4d3a65ad4a`, `75981b9b`, `92fe5776`,
`dd651e36` — corruption fail-open behavior, 3 divergent read-modify-write
paths, regex-based path extraction, and 3 missing/inconsistent schema
fields (`contentAliases`, lifecycle fields, `classification: null` on
31/211 entries).

**Explicit scope boundary (resolves audit-plan H2 — the "no migrations"
contradiction)**: this plan does **not** implement a ledger schema change.
GPT is right that these six items constitute a genuine ledger-v2 design
(target schema, compatibility contract for 211 existing entries,
concurrency model, migration/backfill) — that's real design work, not a
quick fix, and doing it inside a reliability-triage pass would repeat
Theme 2's mistake (silently expanding scope past what "additive,
no-migration" fixes can honestly claim). **Left explicitly open and
deferred**, same treatment as Theme 2 — a dedicated ledger-v2 plan should
own the schema/migration decision before any of these six are implemented.
Until then the Rollback section below is accurate: everything this plan
DOES implement is additive/refactor-only.

## Theme 9 — Remaining standalone items (resolves audit-plan M6, M3, H5)

Four topicIds from the entry table had no theme/disposition (audit-plan
M6) — each is independent, no shared root cause:

- `ab71f952` — `final-adjudication.mjs:154-159` `Number.isFinite(n)` accepts
  negative `maxMechanicalTailItems`/`maxCleanRegionFiles`, and
  `.slice(0, n)` with a negative `n` means "all but the last `|n|`
  items" (JS `Array.prototype.slice` semantics), not "cap at n" — silently
  wrong, not an error. **Fix**: `Math.max(0, n)` before both `.slice(0, n)`
  calls (lines 154-158). One-line-per-call fix.
- `71a8f46a` — `stage1-triage.mjs:7-15`'s header comment claims the module
  is "NOT wired into openai-audit.mjs's production chooser" and that the
  validation manifest "does not exist" — both are now false (confirmed:
  `openai-audit.mjs` imports/calls `runTieredAuditPipeline`, which uses
  `runStage1CheapTriage`; `scripts/cheap-triager-validate.mjs` exists).
  **Fix**: update the header comment to reflect current wiring. Doc-only.
- `5308a5d6` — `stage0-relevance-context.mjs:84-96`'s sequential
  `for...of` + `await getFreshImportersOrNull(...)` loop. Audit-plan M3
  correctly warns that a blind `Promise.all` would create unbounded
  fan-out. **Round-3 correction (audit-plan M1) — the round-2 spec was
  still sequential**: gating `acquire()`/`release()` around each iteration
  of a single `for...of` loop does NOT create concurrency — the loop still
  awaits one lookup to completion before starting the next; a semaphore
  around a sequential loop is decorative, not a fix. **Actual worker-pool
  design**: a fixed number of worker coroutines (`min(
  STAGE0_IMPACT_CONCURRENCY, candidateFiles.length)`, named cap
  `STAGE0_IMPACT_CONCURRENCY = 8`, a module constant, not
  env-configurable — this is an internal fan-out limit against a local
  Postgres RPC, not an external rate-limited API, so no operator-facing
  knob is warranted) each pull the next index from one shared cursor
  (`let nextIndex = 0` closed over by all workers) in a loop until the
  cursor exceeds `candidateFiles.length`, run `getFreshImportersOrNull` for
  their claimed file with the existing `catch { result = null }` behavior
  (line 94, unchanged), write to `impactCache`, then claim the next index.
  `await Promise.all(workers)` where each worker is one `async function
  worker() { let i; while ((i = nextIndex++) < candidateFiles.length) {
  ... } }`. No semaphore/acquire-release primitive is needed once the
  worker-pool shape is used — a semaphore serializes access to a *shared
  resource*; this problem is *N workers pulling from a queue*, a different
  primitive, and using the wrong one is exactly how the round-2 spec ended
  up accidentally sequential.
  - **Non-issue confirmed**: `candidateFiles` is a bounded, known-size
    array (the audit's own diff scope) — no cancellation/backpressure
    protocol needed beyond each worker's own `while` loop terminating.
  - **Output ordering is a non-issue here**: the result is written into a
    `Map` keyed by `filePath` (`impactCache.set(...)`), not an ordered
    array, so out-of-order completion has no observable effect — M3's
    ordering concern doesn't apply to this specific call site.
- `6cfb5541` — `discovery-diff-scope.mjs` (`resolveEligibleDiffPathMap`,
  lines 12-70) and audit-plan H5. **Re-read the file's own extensive
  rationale (lines 27-43) before treating this as an oversight**: it
  already documents a deliberate, reasoned decision to use lexical-only
  `shouldSkipForIndexing` instead of `resolveAndClassify`'s symlink-aware
  canonicalisation, specifically BECAUSE the diff can reference deleted
  files / a rename's `oldPath`, which legitimately don't exist on disk —
  full `resolveAndClassify` would `resolutionFailed → sensitive` on every
  one of those, silently making deleted/renamed files unauditable. This is
  not the oversight H5 assumes; it's a considered trade-off with a real
  reason to prefer the current behavior for the general case.
  **Narrow, additive fix** that closes the residual live-symlink gap
  WITHOUT regressing the deleted-file case: before the lexical check, for
  each path that `fs.existsSync`s in the current worktree (i.e. it's NOT a
  deleted/renamed-away path), additionally run `resolveAndClassify` and
  fail closed on `resolutionFailed`/`escapedRepo`; a path that does not
  exist on disk keeps today's lexical-only behavior exactly as now. This
  is genuinely additive (adds a check only for the subset where it's safe
  to add), so H5's security concern is addressed for the case where it's
  actually actionable, without discarding the file's own reasoned
  deleted-file handling. **Note from shadow review**: both
  `discovery-diff-scope.mjs` and `diff-path-map.mjs` document
  `resolveEligibleDiffPathMap` as a "Pure: no filesystem, no network, no
  clock" function today — adding `fs.existsSync` makes that no longer
  strictly true. Update the docstring to describe the new, narrower
  contract ("pure except for a worktree-existence probe used only to
  decide which of two already-pure code paths to take") rather than
  silently invalidating a documented invariant; no adapter-injection
  needed for this one call — `fs.existsSync` is synchronous, deterministic
  for a given worktree state, and not a call this module needs to mock in
  tests (the two branches are tested directly with fixtures that do or
  don't exist on disk).

## Disposition Matrix (resolves audit-plan H6/M6 completeness gap)

| topicId(s) | Disposition | Section |
|---|---|---|
| `062e1be1`, `4235a115`, `656f6586`, `9d9d478a` | **Fix now** — `writeLearningState` gate + result-logging (no outbox module needed, see implementation-time correction) | Theme 1 |
| `883ce465`, `e1c28c86`, `1444bd3bcd09`, `4583a315f94f`, `a3eea13798de`, `14e2f6c9`, `9d28fa46`, `ef5cb0ac`, `864d73db` | **Defer** — own follow-up plan (god-module decomposition) | Theme 2 |
| `39a73f09`, `bf45c2f7`, `cd77d84e`, `d96b1e86`, `6ae952bf`, `9e965821` | **Fix now** — isolated one/few-line corrections | Theme 3 |
| `7d5479de` | **Accept** — matches AGENTS.md's documented accepted-debt pattern for module-global CLI state | Theme 3 |
| `19b2d764`, `866769e6` | **Accept as-is** — already-reasoned trade-off in shipped code | Theme 4 |
| `78e4d7aa`, `9cac9947`, `b587ef32` | **Defer** — independent parser investment, already accepted debt | Theme 4 |
| `122899a5`, `33593f74`, `7ceef72a` | **Fix now** — explicit no-adapter outcome only; `122899a5` gets NO malformed-entry filter (Gemini G1, round 4 — see Theme 5) | Theme 5 |
| `ce44f372`, `e5f71156`, `82e60a82` | **Fix now (partial)** — symlink-spoofing closed + readdir failure surfaced; forged-non-symlink-marker spoofing is a known, deferred residual (see Theme 6) | Theme 6 |
| `30ca14747055`, `3ce44825046d` | **Accept** — already an intentional, documented v2 deferral in code | Theme 7 |
| `d486a8691080` | **Fix now** — correct docstring to match code | Theme 7 |
| `6c518b81fda5` | **Fix now** — document as accepted pattern (matches AGENTS.md table) | Theme 7 |
| `744ebe8db568`, `9ed20331d025`, `ae4d3a65ad4a`, `75981b9b`, `92fe5776`, `dd651e36` | **Defer** — own follow-up plan (ledger-v2 schema/migration) | Theme 8 |
| `ab71f952`, `71a8f46a`, `5308a5d6`, `6cfb5541` | **Fix now** | Theme 9 |

**Round-2 correction (audit-plan M3)**: the counts below are regenerated
directly from the table rows above (the table is the source of truth; these
are a checked total, not an independently-maintained figure) —

**Fix-now: 22 topicIds** — Theme 1 (4) + Theme 3 (6) + Theme 5 (3) +
Theme 6 (3) + Theme 7 (2) + Theme 9 (4) = 22. Implemented by this plan.

**Deferred: 18 topicIds** — Theme 2 (9) + Theme 4's C-style-escaping subset
(3: `78e4d7aa`/`9cac9947`/`b587ef32`) + Theme 8 (6) = 18. Explicitly tracked
open debt, not silently dropped, pending two follow-up plans this session
does not open (god-module decomposition; ledger-v2) plus the independent
git-quote-path parser investment.

**Accepted-as-is: 5 topicIds** — Theme 3's module globals (1: `7d5479de`)
+ Theme 4's first-match limitation (2: `19b2d764`/`866769e6`) + Theme 7's
v2-deferred semanticId (2: `30ca14747055`/`3ce44825046d`) = 5. Reviewed and
deliberately not changed, with rationale recorded above.

**22 + 18 + 5 = 45**, matching the plan's total entry count. The
Rollback section's "additive/no-migration" claim applies to the 22
fix-now topicIds only.

## Verification Plan (resolves audit-plan H6)

No new sweeping test-infrastructure — extend the existing suite per theme,
naming the actual files:

- **Theme 1 (superseded by the implementation-time correction above — no
  outbox module was built)**: `tests/legacy-production-audit-hardening.test.mjs`
  is the injection seam for `legacy-production-audit.mjs` and already
  passed unmodified after the actual fix (the `writeLearningState` gate +
  result-logging on the 4 call sites, plus threading `learningWritesAllowed`
  into `selectEventSource`). No new test file was needed since the fix
  reuses existing, already-tested primitives (`writeLearningState`,
  `selectEventSource`'s existing local-fallback path) rather than
  introducing new durability machinery to test.
- **Theme 3 (quick fixes)** — one file + assertion per behavior-changing
  correction (resolves the round-2 ambiguity):
  - `39a73f09` (NUL bytes): a fixture-based assertion in
    `tests/legacy-production-audit-hardening.test.mjs` that the relevant
    regex/parsing function still matches the same real-world drive-letter
    input after the sentinel replacement — same behavior, different bytes.
  - `bf45c2f7` (verdict/provenance parity): extend
    `tests/legacy-production-audit-hardening.test.mjs` with a fixture whose
    verdict computation and commit-provenance gate must now agree (a case
    that previously could diverge — a tool finding excluded from one but
    not the other).
  - `cd77d84e`/`d96b1e86` (cached_tokens): extend the same file with a
    stubbed MAP-phase result carrying `cached_tokens` and assert the final
    usage sums MAP + REDUCE, not REDUCE-only.
  - `6ae952bf` (passRegistry/recordPassStats): assert `recordPassStats`'s
    reasoning-level lookup for each pass name matches `passRegistry`'s
    value directly (a round-trip assertion, not two independent literals).
  - `9e965821` (mkdirSync mode — corrected per Gemini final-gate G1, round
    2): directory mode is masked by the process umask, so a naive
    `assert.equal(fs.statSync(dir).mode, 0o40700)` is environment-dependent
    and will flake. **Round-2 gate correction**: the mask arithmetic is
    `requestedMode & ~process.umask()` (bitwise NOT of the umask, applied
    by the OS at creation time) — NOT `requestedMode & process.umask()`
    (a direct AND, which Gemini caught would evaluate to `0` for
    `0o700 & 0o022` and make the test fail by construction). Assert
    `fs.statSync(dir).mode & 0o777 === (requestedMode & ~process.umask())
    & 0o777`. **POSIX-only assertion**: this repo explicitly supports
    Windows (`docs/plans/windows-fs-transient-error-hardening.md`), and
    Windows does not meaningfully honor POSIX mode bits at all — skip this
    specific assertion on `process.platform === 'win32'` (the fix itself,
    i.e. passing an explicit `mode` to `mkdirSync`, is harmless and still
    applied there; only the assertion is POSIX-specific).
- **Theme 5 (discovery-portfolio.mjs)**: extend the file's own existing
  test suite (this module already has adapter-injection tests per its
  JSDoc) with a malformed-entry-in-array case and a null-`gptCall` case,
  asserting the new outcome fields.
- **Theme 6 (diff-scope-resolver.mjs)**: extend
  `tests/` coverage for `sweepStaleOrphanPreimages` with: (a) a symlinked
  OUTER directory named `orphan-preimage-x` → must be refused/kept, never
  deleted; (b) a symlinked NESTED `.git` inside an otherwise-plain
  directory → must be refused/kept (the specific bypass audit-plan M2
  found); (c) a plain non-worktree directory with a colliding prefix and
  NO `.git` marker at all → must be refused; (d) the existing
  legitimate-worktree-cleanup case must still pass unchanged (regression
  guard). **Known-failing case, document not silently skip**: a forged
  NON-symlink `.git` regular file with `gitdir:`-prefixed content in a
  non-worktree directory currently DOES get deleted (the accepted
  residual from audit-plan H3, round 3) — add this as an explicit
  `// KNOWN GAP: see Theme 6 residual, tracked for follow-up` test comment
  (not a passing assertion) so it's visible in the suite rather than
  silently absent.
- **Theme 7**: `d486a8691080`'s docstring fix has no test (comment-only);
  `6c518b81fda5`'s documentation fix has no test (comment-only).
- **Theme 9**: `ab71f952` gets a negative-value unit assertion;
  `5308a5d6`'s concurrency cap gets a test asserting no more than N
  in-flight calls at once (a controllable-delay stub, same technique
  `azure-throttle`'s own tests likely already use — check before writing a
  new harness); `6cfb5541` gets a live-symlink-to-sensitive-target case
  AND a regression case proving a deleted-file path still resolves via the
  lexical fallback (the exact case the file's own comment says must keep
  working).
- **Command**: `npm test` (the full `node --test` suite covers all of the
  above once written — this repo has no separate `test:unit`/`test:e2e`
  split for this scope, per `package.json`).

---

## Full entry table


**`scripts/lib/audit/legacy-production-audit.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `062e1be1` | HIGH | legacy-production-audit.mjs:1305 finalizePriorRoundOutcomes unconditional, no noCloudRecording check internally |
| `4235a115` | HIGH | legacy-production-audit.mjs:3387-3396 backfillLearningOutcome catch swallow, docblock admits deferred gap |
| `656f6586` | HIGH | legacy-production-audit.mjs:1405 recordDiffComplexity catch swallow, same acknowledged gap |
| `6ae952bf` | MEDIUM | legacy-production-audit.mjs:2446-2475,3116-3119 passRegistry vs recordPassStats two sources of truth |
| `7d5479de` | MEDIUM | legacy-production-audit.mjs:247,388 _cacheDir/_runSeedUsed mutable module globals |
| `883ce465` | HIGH | legacy-production-audit.mjs:1268-3545 ~2280-line function still orchestrates everything |
| `9d9d478a` | HIGH | legacy-production-audit.mjs:1488,1523,2876 debt-memory/ledger writes have no noCloudRecording/learningWritesAllowed check |
| `9e965821` | MEDIUM | legacy-production-audit.mjs:255 mkdirSync no explicit mode set |
| `bf45c2f7` | HIGH | legacy-production-audit.mjs:2946-2958,3319-3323 verdict vs commit-provenance gate recompute diverge |
| `cd77d84e` | MEDIUM | legacy-production-audit.mjs:526,532-535,663 mapUsage never accumulates cached_tokens from MAP results |
| `d96b1e86` | MEDIUM | legacy-production-audit.mjs same cached_tokens gap duplicate of cd77d84e |
| `e1c28c86` | MEDIUM | legacy-production-audit.mjs:1268-3545 same ~2280-line function duplicate of 883ce465 |
| `39a73f09` | HIGH | legacy-production-audit.mjs:1083 2 literal NUL bytes in string literals confirmed via raw bytes |

**`scripts/lib/audit/tiered-pipeline.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `14e2f6c9` | MEDIUM | tiered-provider-calls.mjs:36-51,65-92 duplicated Stage-1 prompt/schema across transports post-extraction |
| `864d73db` | MEDIUM | tiered-pipeline.mjs 607 lines still over 500-line threshold, still orchestrates everything |
| `9d28fa46` | MEDIUM | tiered-provider-calls.mjs same duplication duplicate of 14e2f6c9 |
| `ef5cb0ac` | MEDIUM | tiered-provider-calls.mjs same duplication duplicate of 14e2f6c9 |

**`scripts/lib/audit/evidence-triage.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `19b2d764` | HIGH | evidence-triage.mjs:188-211,252-273 no anchor startLine/endLine check, first-match bug admitted |
| `78e4d7aa` | MEDIUM | evidence-triage.mjs:113-128 header regex no C-style unescape, accepted debt comment |
| `866769e6` | HIGH | evidence-triage.mjs:416-476,188-211 zero anchor.startLine/endLine refs, dup quote misattribution |
| `9cac9947` | MEDIUM | evidence-triage.mjs:117 header regex only unquoted/space-quoted |
| `b587ef32` | MEDIUM | evidence-triage.mjs:101-107 same gap, own doc admits only spaces covered |

**`scripts/lib/audit/discovery-portfolio.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `122899a5` | MEDIUM | discovery-portfolio.mjs:79-81 only Array.isArray checked, malformed entries pass |
| `33593f74` | MEDIUM | discovery-portfolio.mjs:147-154 gptCall null skips outcome push, reachable in prod |
| `7ceef72a` | MEDIUM | discovery-portfolio.mjs:147-154 duplicate of 33593f74 |

**`scripts/lib/audit/diff-scope-resolver.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `82e60a82` | MEDIUM | diff-scope-resolver.mjs:49-63 readdirSync failures logged not surfaced |
| `ce44f372` | HIGH | diff-scope-resolver.mjs:272-291 basename+mtime heuristic ownership |
| `e5f71156` | HIGH | diff-scope-resolver.mjs:285-289 fallback rmSync no ownership check |

**`scripts/lib/findings.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `30ca14747055` | HIGH | findings.mjs:38-39 semanticId still raw content hash of prose for non-tool findings |
| `3ce44825046d` | HIGH | findings.mjs:27-40 dispatch confirmed, plan doc explicitly still documents deferred to v2 |
| `6c518b81fda5` | HIGH | findings-outcomes.mjs:20,28,45,68 _repoProfileCache module-global mutable state persists post-split |
| `d486a8691080` | HIGH | ledger.mjs:43-53 generateTopicId JSDoc claims no content hash but line 50 folds contentHash into hashed content |

**`scripts/openai-audit.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `1444bd3bcd09` | HIGH | config.mjs:265 PASS_NAMES flat array, legacy-production-audit.mjs:1717-1774 hand-wired per pass |
| `4583a315f94f` | HIGH | openai-audit.mjs:197,221,235 local schemas vs schemas.mjs owning ~30 others |
| `a3eea13798de` | HIGH | openai-audit.mjs:251,283 hardcoded prompts vs prompt-registry.mjs separate system |

**`scripts/lib/ledger.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `744ebe8db568` | HIGH | ledger.mjs:78-95 corruption only warns+backs up+continues fresh empty ledger, fail-open despite fail-loud comment |
| `9ed20331d025` | MEDIUM | ledger.mjs multiple independent RMW implementations diverge in corruption handling |
| `ae4d3a65ad4a` | HIGH | ledger.mjs:260-278 populateFindingMetadata extracts paths via regex on free-text section field |

**`scripts/lib/audit/final-adjudication.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `ab71f952` | MEDIUM | final-adjudication.mjs:154-159 Number.isFinite accepts negative maxMechanicalTailItems |

**`scripts/lib/audit/stage0-relevance-context.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `5308a5d6` | MEDIUM | stage0-relevance-context.mjs:84-96 sequential await loop no Promise.all/batching |

**`scripts/lib/audit/discovery-diff-scope.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `6cfb5541` | HIGH | discovery-diff-scope.mjs:27-44,57 lexical-only shouldSkipForIndexing, symlink-aware check not implementable over diff per own comment |

**`scripts/lib/audit/stage1-triage.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `71a8f46a` | LOW | stage1-triage.mjs:7-15 stale header re: wiring, contradicted by `scripts/openai-audit.mjs`, `scripts/lib/audit/tiered-pipeline.mjs`, `scripts/cheap-triager-validate.mjs` |

**`.audit/tech-debt.json`**

| topicId | severity | evidence |
|---|---|---|
| `75981b9b` | HIGH | tech-debt.json 0/211 entries have contentAliases, duplicate defects uncorrelated |
| `92fe5776` | MEDIUM | tech-debt.json no supersededBy/reviewDeadline/expiry/etc fields exist |
| `dd651e36` | HIGH | tech-debt.json 31/211 entries classification:null |

## Follow-up Plans Needed (closes a shadow-review completeness gap)

Four items are deferred by this plan without this plan opening the
follow-up itself. Named here so the deferral has a concrete next step,
not just a label:

| Deferred item | Topic IDs | Suggested follow-up plan file | Trigger to open it |
|---|---|---|---|
| God-module decomposition (Theme 2) | 9 | `docs/plans/audit-pipeline-god-module-decomposition.md` (planned) | Next time either `legacy-production-audit.mjs` or `openai-audit.mjs` needs a non-trivial change — decompose before extending further |
| Ledger-v2 schema/migration (Theme 8) | 6 | `docs/plans/tech-debt-ledger-v2-schema.md` (planned) | Before the next full-backlog triage pass like this one, so duplicate-entry noise doesn't recur |
| Orphan-preimage ownership manifest (Theme 6 residual) | 0 new — same 2 topicIds as the partial fix, residual noted in-line | `docs/plans/orphan-preimage-ownership-manifest.md` (planned) | If this heuristic is ever observed to delete something it shouldn't (no incident has occurred; this is preventative) |
| Git-quote-path parser (Theme 4 C-style escaping) | 3 | `docs/plans/evidence-triage-git-path-escaping.md` (planned) | If a repo with non-ASCII/quoted filenames in its diffs is onboarded and evidence anchoring misbehaves on it |

None of these four are blocking — they're accepted, named debt, not
silent gaps.

## Rollback

**Scoped to what this plan actually implements** (the 22 fix-now topicIds in
Themes 1, 3, 5, 6, 7, 9 — see Disposition Matrix): all additive/refactor-only
within the audit tooling itself, no schema/data migrations. Revert per-commit
if a regression surfaces in `npm test`. This claim does **not** extend to
Theme 2, Theme 8, or Theme 4's C-style-escaping subset (18 topicIds total) —
all explicitly deferred to their own follow-up work precisely because the
first two would require larger, non-additive changes (module decomposition;
ledger schema migration for 211 existing entries) that this plan does not
attempt.

## Implementation Log

### 2026-07-27
- **Completed**: all 22 fix-now topicIds across Themes 1, 3, 5, 6, 7, 9
  implemented; 3 rounds of code audit (H:6→5→4, converging on the same
  handful of already-deferred architectural themes rather than plateauing on
  fresh bugs) plus the mandatory Gemini gate (1 round, APPROVE) — see
  "Code-Audit Round History" above for the full per-round detail. Every
  genuinely new, in-scope, actionable bug the audit found (including 3 found
  in this session's own fixes: `existsOnDisk`'s ENOTDIR then EACCES gaps,
  and a `passRegistry` predicate bug recurring for two more passes) was
  fixed in the same round it surfaced. Full test suite green throughout
  (8795/8817 passing, 22 pre-existing environment-gated skips, 0 failing).
- **Remaining**: Theme 2 (god-module decomposition), Theme 8 (ledger-v2
  schema/migration), Theme 4's C-style-escaping subset, and 4 additional
  independent topicIds newly captured during code-audit (session-ID
  collision risk, `stage0-relevance-context.mjs`'s cwd coupling, the
  `runOrphanIntroducedPass` baseRef/headRef bug, N+1 per-anchor RPC calls)
  — all deferred with named follow-up plans or captured as new
  `.audit/tech-debt.json` entries per the disposition trail above.
- **Deviations**: none from the audited design — the Theme 1
  implementation-time correction (outbox → simple wrapper) was disclosed
  and audited *before* this code-audit began, not discovered by it.
