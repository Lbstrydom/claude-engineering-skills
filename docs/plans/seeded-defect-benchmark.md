# Plan: Seeded-defect benchmark — pilot-first eval of record for the `/audit-code` loop
- **Date**: 2026-11-23
- **Status**: Draft
- **Author**: Claude + Louis
- **Scope**: backend (stack `js-ts`; CLI extensions + library + a small versioned corpus; no UI)
- **Mode**: campaign
- **Target domain(s)**: `model-eval`, `audit-orchestration`, `scripts`, `docs`
- ⚠ **Cross-domain work** — touches >1 domain; the crossings are intentional and already exist (`model-eval` drives `audit-orchestration` through `runMultiPassCodeAudit`, as `scripts/lib/model-eval/arm-generation.mjs` does today).
- **Depends on**: none — the meta step-back this plan's first pilot measures is on `main` (`75baf959`, #483; `c627f1ea`, #482).
- **Approved by**: Louis approved the *idea* (2026-11-23, relayed by the CES coordinator) and narrowed its scope after a five-gap review (relayed 2026-11-23, §0.1). This document still needs his approval, and each paid run needs its own spend approval (§6).

**Principle set**: `skills/plan/references/engineering-principles.md` (cited `#N`). **Figure labels**: every number is
`measured` (with its source), `derived` (with its arithmetic) or `expected` (a forecast to be checked) —
`docs/audit/shared-references/verification-discipline.md` §2.

**Neighbourhood considered** (`get-neighbourhood`, k=8, 2026-11-23 at `df1686f7`, coverage `verified`):
`scripts/defect-harvest.mjs::main` banded **`precedent` (`above-floor-cluster`)** — the miner exists, so Pilot 2 **extends
it; no second miner**. The other hits banded `review` and were opened because they are seams this plan reuses:
`scoreDefectLocalization` / `matchScore` (`scripts/lib/model-eval/deterministic-scorer.mjs`), `computeStageRecall`
(`scripts/lib/model-eval/stage-recall.mjs`), `harvestCandidates` / `classifyCommit` / `blameIntroducers` /
`harvestWithReport` (`scripts/defect-harvest.mjs`).

**Incident neighbourhood**: INC-001 (sensitive-path symlinks, `manual-verification-required`) applies: both pilots read
historical trees and send diffs and files to third-party LLMs. Addressed in §5.

---

## 0. What this plan decides, and how

### 0.1 Scope (as narrowed 2026-11-23)

The coordinator relayed Louis's five-gap review (a two-round brainstorm with OpenAI and Gemini; Gemini argued for 50
reverted fixes matched by regex, OpenAI for narrowing; the coordinator chose narrowing). The plan therefore:

1. **ends in pilots with decision thresholds**, each with a minimum useful effect and a spend ceiling; results stay
   **advisory** until a repeat run reaches the same decision (§0.3);
2. **runs the meta step-back A/B first** (Pilot 1, §2) — continuations from the same pre-step ledger state, toggling only
   the meta-review — and that result alone decides whether the meta step-back stays;
3. **keeps public-history cases apart**: reverted public fixes are a **calibration** split, never a holdout; fresh seeded
   cases are a **holdout** never used for tuning; clean controls (changes with no defect) are included (§3.2);
4. **calibrates the semantic matcher on a small human-labelled set before any aggregate is read** (§1.4); exact or regex
   matching is rejected because it reads a rewording as a miss;
5. **reuses** the replay, model-eval and arm-eval machinery rather than building a new harness (§4);
6. **stays a plan**: power analysis only as far as the pilots need; no framework adopted.

### 0.2 The two pilots

| | Pilot 1 — meta step-back A/B | Pilot 2 — seeded detection |
|---|---|---|
| Question | At a cap decision point, does the meta-review's admit/stop/structural call buy novel, actionable findings worth its cost, versus always continuing? | Can a seeded corpus separate a known-degraded audit arm from the incumbent, so it can later judge model swaps and `PASS_PROMPTS` edits? |
| Decides | whether the meta step-back stays on by default | whether the seeded corpus becomes the eval of record |
| Ground truth | human, arm-blind adjudication of continuation findings (novel? actionable?) | planted defects with known answers + adjudicated clean controls |
| Spend ceiling | **$100** (`expected`) | **$130** (`expected`) |
| Runs after | the matcher calibration (§1.4) | Pilot 1, and only if Pilot 1's instruments held |

### 0.3 Advisory until repeated

A pilot's decision is **advisory** when first reached. It becomes **binding** (Louis's call, recorded in
`docs/research/`) only when a **repeat run** — fresh replicates on a fresh draw of decision points or cases, same
pre-registered rule, same contract epoch — lands on the **same branch** of the rule. A repeat that lands elsewhere makes
the result `unstable`: the default stays as it is today and the write-up says so.

---

## 1. Context Summary

### 1.1 Why the existing instruments cannot answer these questions (measured)

| Instrument | Why it cannot decide | Source |
|---|---|---|
| Step-back replay v1/v2 (#451) | **Saturated**: 27 of 27 replies were a stopping action; its truth ("a later round had an accepted HIGH") marks nearly every round, so every R3 stop scored false and all three arms scored identically by construction. | `docs/research/step-back-replay-v2-2026-11.md` §2.1, §3, §4 |
| Model-eval auditor role | One curated defect per whole organic commit, matched by Jaccard ≥ **0.15** (`FUZZY_CONFIG_V2`, `scripts/lib/model-eval/deterministic-scorer.mjs:74 (df1686f7)`): a model that finds the bug in other words scores 0, and other real bugs in the diff are unscorable. Experiments 7–8 decided on cost with "not worse on 11 cases". | `docs/runbooks/model-eval-harness.md` §Step 2, §"Screen-tier oracle matching has a real ceiling" |
| Arm-eval | Relative preference, no ground truth; switched off as a collector. | `docs/plans/arm-eval-framework.md` |

The corpus today: `known-defects.json` has **30** entries — **18 `detect`** (8 HIGH, 10 MEDIUM), **12 `expect_clean`**
(`measured`, read with `node -e` at `df1686f7`).

### 1.2 Code Trace (all read at `df1686f7`)

- **Meta step-back** (on `main`): runs inside `openai-audit.mjs`'s round-cap gate. T1 fires on a round refused past the
  soft cap (plan rounds 4–5, code 7–8); T2 at code round 4 when a round signal fired at checkpoint 3 (`META_T2_ROUND = 4`,
  `scripts/lib/audit/round-cap.mjs:34 (df1686f7)`). Verdicts admit / stop / structural, bounded by a deterministic guard;
  opt-out `--no-meta-review` or `AUDIT_META_REVIEW=off`; every decision is appended to `.audit/<sid>-meta-review.jsonl`
  with model, tokens and cost (`scripts/lib/audit/meta-review.mjs`: `isMetaReviewOptedOut` L49, `metaTriggerFor` L58,
  `appendMetaEvent` L136; contract in `docs/audit/shared-references/meta-review.md`).
- **No-look-ahead checkpoint state**: `scripts/lib/audit/step-back-snapshot.mjs` builds a checkpoint from round results
  `<sid>-r<N>-result.json` for N ≤ checkpoint (each with `_auditedSha`) and the per-round ledger snapshot
  `<sid>-r<checkpoint>-ledger.json`; disagreeing provenance is `unrecoverable`, never reconstructed.
  `scripts/lib/audit/step-back-dataset.mjs` freezes a dataset before any paid call and writes ground truth to a separate
  scoring file the pack builder never opens. `scripts/lib/audit/step-back-gitfs.mjs` serves file reads from the audited
  revision with the egress classifier still on every path.
- **Replay CLI**: `scripts/step-back-replay.mjs` — `export | propose | freeze | run | score`; a paid `run` needs
  `--confirm-spend`, `--max-usd`, `--results` (JSONL appended before scoring, never truncated); hard stop on **metered**
  actuals (exit 5). Cost helpers `estimateCostUsd` in `scripts/lib/audit/step-back-replay.mjs`.
- **Model-eval**: corpus loader `scripts/lib/model-eval/known-defect-corpus.mjs` (diff from git, `findSensitivePathMentions`
  on it, stamp `suite`/`subset`/`corpusVersion`/`corpusDigest`/`selection`, `stampMismatch`); case tree
  `scripts/lib/model-eval/case-tree.mjs` (throwaway detached worktree at the case's commit); full 5-pass generation
  `runAuditGenerationArm` `scripts/lib/model-eval/arm-generation.mjs` (visible/hidden split: the arm never sees the
  answer); `expect_clean` report + adjudication `scripts/lib/model-eval/expect-clean-report.mjs`,
  `scripts/lib/model-eval/expect-clean-adjudication.mjs` (REAL / NOT_A_DEFECT / WRONG / UNDETERMINED, INCOMPLETE on any
  unjudged finding); blinded judge `scripts/lib/model-eval/blind-judge.mjs` (forked from arm-eval's protocol); cost
  `scripts/lib/model-eval/cost.mjs`. CLI `scripts/model-eval-auditor.mjs` (810 lines, under the size ratchet's 1000).
- **Concern identity**: `scripts/lib/concern-identity.mjs` — identity rests on the adjudicator's `sameConcernAs` link and
  **file overlap, never `affectedFiles[0]`**; free-text similarity measured unsafe ("Hardcoded timeout value" vs
  "Hardcoded credential value" Jaccard 0.50, its header). `finding_equivalence` (`scripts/lib/audit/equivalence-links.mjs`)
  links a duplicate finding fingerprint to a canonical one in the store — it relates findings to findings, not to
  defects, so §1.4 reuses its file-overlap discipline, not the table.
- **Canary**: `scripts/lib/audit/canary.mjs` (`AUDIT_CANARY=1`): a planted defect per wave-2 pass; a miss is INCOMPLETE.
- **Pinned runs**: `npm run fixture:create` → `node scripts/pinned-worktree.mjs create` (`package.json:220 (df1686f7)`).

### 1.3 Patterns reused vs new

**Reused unchanged**: checkpoint snapshot, dataset freezer, revision fs, metered `--max-usd`, canary, case tree, corpus
stamp, generation arm, expect-clean adjudication, blind judge, cost, pinned fixture, run-heartbeat. **Extended**:
`step-back-replay.mjs` (a `continue` subcommand, Pilot 1), `known-defect-corpus.mjs` + `model-eval-auditor.mjs`
(`--suite seeded`, Pilot 2), `defect-harvest.mjs` (bench candidate fields). **New**: a semantic matcher module, a
continuation runner module, a seeded scorer module, the small corpus.

### 1.4 The matcher, calibrated before it is used (#11, #13)

Both pilots need "is finding F the same concern as X?" — X a prior ledger entry (Pilot 1: is F *novel*?) or a planted
defect (Pilot 2: did F *find* it?). One module, two calls:

1. **Candidate filter** (deterministic): F is a candidate for X only if they share a file (normalised, case-insensitive)
   and, when both cite lines, the lines fall within ±15 of each other (`expected` window, set on the calibration set);
   a finding with no line is a candidate for every X in its file. Loose on purpose — a pair the filter drops can never
   match, and the filter's recall is measured.
2. **Semantic judge**: reads F and X and returns `same | partial | different` with a quote from F (schema-enforced).
   Named by sentinel through `resolveModel()` (default `latest-opus`, `{backend:'sdk'}` — forced schema needs the sdk
   pin, and `max_tokens` is unenforced on `cli`); the **effective** provider + model id is resolved once at dataset
   freeze, stamped, and a repeat whose resolution differs is refused (`stampMismatch`). Because Opus is also the meta
   reviewer, every Pilot 1 judgement is also made by a second judge (`latest-pro`, frozen the same way) and both are
   reported; a decision stands only if both judges put it on the same branch of the rule.
3. **Assignment** (one policy, both pilots): edges are judged `same` pairs only. A maximum-cardinality one-to-one
   matching is taken over them. Among all maximum-cardinality matchings, the one chosen is the **lexicographically
   smallest** list of edges sorted by the key (X severity descending, F severity descending, line distance ascending,
   X id, F id) — ids are stable strings from the corpus and the run, never array positions — computed by a min-cost
   assignment over that key, so the choice is a total order and independent of input order. A test shuffles findings
   and defects across many permutations of ambiguous graphs (one finding equidistant from a HIGH and a LOW defect; two
   findings tied for one defect) and asserts the same matching every time. F with a `same` edge only to an already-matched X is a **duplicate** (neither credit
   nor false positive). `partial` never earns credit (Pilot 2: not a detection) and never makes F non-novel (Pilot 1: F
   goes to the human as novel, flagged `partial-of <X>`), so `partial` can only move a finding toward human review,
   never decide it.

**Calibration (gate before any aggregate figure).** Sessions are partitioned **before** labelling (C2): calibration
pairs come only from the *calibration* session set, never from rehearsal, pilot or repeat sets. Two samples, labelled by a
human blind to arm and to the judge's verdict:

- a **challenge set** of 120 pairs — ⅓ same, ⅓ hard negatives (same file, different concern), ⅓ easy negatives — to
  expose failure modes;
- a **prevalence set** of 80 pairs drawn at random from the filter's real output on calibration sessions, so precision is
  measured at the base rate the pilots will see;
- a **filter-recall set**: 60 findings drawn at random from calibration sessions, each paired by the human with whatever
  ledger entry (or nothing) it restates, searching the **whole** ledger, not the filter's window. Filter recall = share
  of those human-found `same` pairs the filter kept. This is the only sample that can see pairs the filter drops.

Reported per stratum and per source arm: counts, judge precision and recall of `same` (Wilson 95%), prevalence-weighted
precision, filter recall. The Jaccard-0.15 scorer runs on all sets as the **negative control**; the plan expects it to
miss `same` pairs the judge finds.

**Two tasks, two gates.** The sets above calibrate Pilot 1's task (finding vs prior ledger entry). Pilot 2's task
(finding vs planted defect description) is a different text pairing, so it has its own gate before Pilot 2's
aggregate is read: the same three samples (challenge 60, prevalence 40, filter-recall 30 — smaller because answer keys
are authored and precise) drawn **from both arms' runs** (incumbent and degraded, one replicate each) on the
**public-history calibration split**, never the holdout, stratified so each arm contributes ≥ 15 `same` pairs; the
same accept bar, and fewer positives in either arm ⇒ calibration `inconclusive` and Pilot 2 does not read its holdout.

**Accept**: judge precision ≥ 0.90 and recall ≥ 0.85 on `same` (prevalence set), filter recall ≥ 0.95, per-arm recall
within 0.05, with **≥ 15 `same` pairs per source arm**. Fewer positives → calibration `inconclusive`, labels grow. Below the bar → **the pilots
stop**; there is no fallback to the file/line filter alone, because proximity is not concern identity (§1.2). 120 pairs
rejects a badly wrong judge but does not certify 0.90 tightly (`derived`: 36/40 = 0.90 has a Wilson lower bound ≈ 0.77).

---

## 2. Pilot 1 — the meta step-back A/B

### 2.1 Design

A **decision point** is a real audit session at the moment the meta-review would fire, frozen with the existing
no-look-ahead snapshot: round results up to the checkpoint, the per-round ledger snapshot, the audited sha (§1.2).
From that identical state, two arms run the **next round** of the same audit:

| Arm | Invocation | Toggled |
|---|---|---|
| **META** | the round as production runs it — meta-review on; if it admits, the round runs; if it stops or goes structural, the round does not run and its debt command is recorded, not executed | meta-review only |
| **CONTINUE** | `--no-meta-review`. T1: the first invocation is refused and writes the structural card (no provider call), the second adds `--past-cap "seeded-bench continuation control"` and runs — the production human-override path. T2: the round runs | meta-review only |

Everything else is held fixed: revision, models, `PASS_PROMPTS`, ledger state, `AUDIT_CANARY=1`. One continuation round
per point (the first round the meta-review decides), so no fixer is needed and the arms differ only by the toggle.

**Restoring a point (the continuation contract).** The production gate finds a session by the `<sid>` of
`--out <sid>-r<N>-result.json` in `.audit/` under the cwd (`sessionIdFromArgv`, `scripts/lib/audit/round-cap-gate.mjs:38
(df1686f7)`), and the meta-review reads `.audit/<sid>-meta-review.jsonl` and the prior round results by that sid. So a run is:

1. materialise a case tree at the point's `audited_sha` (`case-tree.mjs`; the plan file for plan-mode points comes from
   that tree);
2. copy the snapshot's round results `r1..rN` and the per-round ledger snapshot into the tree's `.audit/` under a fresh
   sid `sb-<pointId>-<arm>-<rep>`, rewriting only the file names (contents byte-identical, digests checked after copy), together with the session's
   **meta-review events up to the checkpoint**: `freeze` records the events of `.audit/<sid>-meta-review.jsonl` whose
   round ≤ N (an earlier T2 decision, a prior T1 at the soft cap, overrides, revocations), with their digest, and the
   restore writes exactly those under the fresh sid. A session whose log cannot be shown complete up to N (missing file
   while its results record a meta decision, a digest mismatch, an event that names a later round) is `unrecoverable`;
3. re-issue the **original invocation's** arguments (mode, plan file, `--scope`/`--diff`/`--changed`, recorded at freeze
   from the session's result and stderr files; a point whose arguments are not recoverable is `unrecoverable`), with
   `--round N+1 --ledger .audit/<sid>-ledger.json --out .audit/<sid>-r<N+1>-result.json`;
4. validate before any provider call: the gate's computed trigger (T1/T2, via `metaTriggerFor`) equals the point's
   frozen trigger; mismatch ⇒ the point is `unrecoverable`, never run;
5. remove the tree (one step, as `case-tree.mjs` does) after the result, meta log and stderr are copied out.

An **offline end-to-end test** drives steps 1–5 against the real `openai-audit.mjs` gate with injected providers for one
plan T1, one code T1, one code T2, one code T1 preceded by an honoured T2 admission, and one second consecutive T1
fixture, asserting the gate's received sid, round, ledger and trigger and that META
and CONTINUE differ in exactly the meta flags (§6, §8).

**Decision points and their partition.** All recoverable sessions that reached T1 (plan round 4, code round 7) or T2
(code round 4 with a checkpoint-3 signal) are frozen first with `step-back-replay.mjs freeze` (plan audits included —
they reach the cap far more often). The frozen list is then partitioned **by session**, by a seeded shuffle recorded in
the dataset, into four disjoint sets: **calibration** (matcher labels, §1.4), **rehearsal** (5 points; results
discarded from the pilot), **pilot** (target 16, at least 6 code), **repeat** (the rest, for §0.3). The loader refuses a
run whose set label does not match its purpose, and a test asserts the sets are disjoint. The 5 PRs of replay v2 are
eligible like any other session.

**Replicates**: each arm runs each pilot point **twice**. The two CONTINUE runs of one point are an A/A pair: the spread of
their novel-finding counts is the noise floor; an arm difference inside it is reported "not distinguishable".

### 2.2 What is counted

For every finding a run produces at MEDIUM+:

- **novel** — the matcher (§1.4) finds no `same` ledger entry in the snapshot, and the finding is not marked
  `_priorRuling`;
- **actionable** — a human, blind to arm (findings from both arms of all points pooled, shuffled, source-blinded — the
  arm-eval / solo-control blinding convention), labels **every** novel MEDIUM+ finding: REAL and worth fixing now, or
  WRONG / NOT_A_DEFECT / `rigour-chasing` (REAL but not worth a round) / UNDETERMINED, in the expect-clean vocabulary.
  The pilot is small enough (`expected` ≤ 200 novel findings) that nothing the rule reads rests on a judge label; judge
  pre-labels are kept only to report judge-vs-human agreement. An UNDETERMINED finding blocks the score (INCOMPLETE,
  the expect-clean rule) until resolved;
- **noise** — novel findings labelled WRONG, NOT_A_DEFECT or `rigour-chasing`.

Per run (point × arm × replicate): novel actionable count, noise count, metered cost (meta call + round), the meta verdict
and whether the guard honoured it.

### 2.3 Decision rule (pre-registered)

**Unit and aggregation.** The unit is a **run**. A META run is a *stop-run* when the guard honoured a stop or structural
verdict (the round did not run); a downgraded or failed meta call that fell to the production default counts as META
running or not running exactly as production did. Replicates are paired by index (META rep *i* with CONTINUE rep *i*),
so split META verdicts on one point need no point-level vote. A run is **valid** when it completed (§2.5); a pair counts
only when both runs are valid.

- **miss rate** = among valid pairs whose META run is a stop-run, the share whose CONTINUE run found ≥ 1 novel
  actionable HIGH/MEDIUM finding. Denominator \|*S*\| = number of such pairs.
- **cost saved** = 1 − (Σ META cost ÷ Σ CONTINUE cost) over all valid pairs.
- **admission yield** = over valid pairs whose META run admitted, Σ META novel actionable ÷ Σ CONTINUE novel actionable;
  if that CONTINUE sum is 0 the yield is `undefined` and its condition is skipped (nothing was available to find).

**Branches, evaluated in this order** (first match wins):

| # | Outcome | Rule | Default afterwards |
|---|---|---|---|
| 1 | **Invalid** | valid pairs < 24 of 32, or completion differs between arms by > 10 points (§2.5) | unchanged; fix the harness, re-run |
| 2 | **Turn off** | cost saved < 0 (META costs more than always continuing), **or** \|*S*\| ≥ 5 and miss rate > 40% | `AUDIT_META_REVIEW=off` default proposed to Louis (a gate change; his call) |
| 3 | **Inconclusive** | \|*S*\| < 5 | unchanged; widen the point set for the repeat |
| 4 | **Keep** | miss rate ≤ 20%, cost saved ≥ 25%, admission yield ≥ 0.8 or `undefined` | meta step-back stays on |
| 5 | **Inconclusive** | anything else | unchanged |

Both judges (§1.4) are only an input to novelty; if the two judges' novelty sets put the pilot on different branches, the
outcome is **Inconclusive**. `decideMetaPilot` implements this table and is tested row by row, including a 1–1 split, a
zero CONTINUE sum and each precedence collision, before any pilot data exists.

**Minimum useful effect**: the meta step-back saves **≥ 25%** of continuation spend while missing novel actionable
findings at **≤ 20%** of its stops. With \|*S*\| ≈ 8 a 20% miss rate is 1–2 points (`derived`), so Pilot 1 can tell a
clearly good or clearly bad step-back from each other, not a marginal one — which is all the keep/off decision needs.
Plan-mode and code-mode points are reported separately as well as pooled; opposite signs are reported, never pooled away.

### 2.4 Cost (`expected` until metered)

Per point, both arms, two replicates: CONTINUE 2 × one round ($0.18–0.72 per code round, `measured`,
`docs/research/field-records-synthesis.md:18`; plan rounds cheaper); META 2 × (one Opus decision ≈ $0.975, `measured`,
replay v2 §2.2 `higher` arm, + the round when admitted) → ≈ **$2.5–5 per point** (`derived`). 16 points ≈ $40–80, plus
judge pre-labels ≈ $5 → ceiling **$100**, enforced on metered actuals (§2.6).

### 2.5 Completion and canary (both pilots)

- `AUDIT_CANARY=1` plants into every wave-2 correctness pass **the arm actually runs**; a pass an arm omits by design
  (Pilot 2's degraded arm) is not planted and not counted missing. A run is **valid** only if every planted pass
  `detected` the canary and no pass was lost (exit 3 / INCOMPLETE). A META stop-run made no audit call and is valid when
  its meta decision was recorded with usage.
- Each invalid run records its reason (`canary-missed`, `pass-lost:<pass>`, `provider-error`, `budget-stop`) per arm.
- Pairs with an invalid member are excluded from both arms and listed. If completion is under 75% overall or differs by
  more than 10 points between arms, the pilot is **Invalid** (branch 1), never scored on the survivors, because a failure
  correlated with an arm is a result about the arm, not noise.

### 2.6 One budget per run (both pilots)

The ceiling must hold for calls the pilots do not make themselves (audit passes inside an `openai-audit.mjs` child, the
final gate inside `gemini-review.mjs`), so it is enforced **at the provider-call seams**, not in the harness:

- **Seam inventory** (each gains one call to a new `scripts/lib/llm-budget.mjs`, active only when `AUDIT_BUDGET_LEDGER`
  names a ledger file; unset ⇒ byte-identical behaviour): `_callGPTOnce` `scripts/lib/audit/llm-helpers.mjs:277
  (df1686f7)` (every GPT pass and the GPT meta/step-back arm), the final-review transport
  `scripts/lib/final-review/transport.mjs` (Gemini/Opus final gate), the `createAnthropicClient` messages seam
  `scripts/lib/anthropic-client.mjs` (Opus meta reviewer and judge), and `scripts/lib/llm-wrappers.mjs` (Gemini judge).
  A test derives the set of files that construct a provider request (`responses.parse|messages.create|generateContent`)
  under `scripts/**` and fails on one outside the inventory, so a new seam cannot silently bypass the budget.
- **Reservation is an upper bound, not an estimate**: before a request is sent, reserve (request **UTF-8 bytes** — a
  byte-level BPE token is ≥ 1 byte, so bytes bound input tokens — × input price) + (the request's **enforced** output cap
  — `max_output_tokens` / `maxOutputTokens` / sdk `max_tokens`, reasoning included — × output price). A request with no
  enforced output cap, or a model with no price, is **refused** before sending (`budget-stop`). A retry is a new request
  and reserves again. If the reservation would exceed the remaining cap, the request is refused and the run stops (exit 5)
  — so total spend ≤ cap by construction.
- **Concurrency**: the five passes of a round run in parallel inside one process; reservations are taken under an
  in-process mutex and the ledger file under an exclusive lock file (`wx`), so two processes cannot both spend the last
  dollars. Child processes of one pilot run share the ledger via the env variable.
- **Per-call states, durable before and after**: `reserved` (appended before send) → `settled` (metered usage, the
  reservation replaced), `failed-billed` (error with usage, debited), `failed-unbilled` — **only** on positive evidence
  that nothing was processed: the request was never sent (a local error before the socket write), or the provider
  returned a synchronous refusal (a 4xx other than 408/429, which providers do not bill) — or `failed-unknown` (timeout,
  connection loss, 5xx, 408/429 or any error without usage), which **keeps its full reservation** as spent until
  `reconcile` records provider evidence. A test simulates a timeout after the provider accepted the request and
  asserts the reservation stays counted. A process that dies between send and settle leaves a `reserved` record: on resume it is
  **indeterminate** — its full reservation stays counted as spent, and the run refuses to continue until the operator
  runs `step-back-replay.mjs reconcile` (provider usage dashboards / logs checked by hand, recorded as `reconciled` with
  the evidence). Nothing re-sends an indeterminate call automatically.
- **Unknown cost is never zero**: a settled call with no usage keeps its reservation as its cost and is flagged.

The JSONL extends the replay's `--results` file format rather than adding a second artifact kind.

---

## 3. Pilot 2 — seeded detection

### 3.1 Case model

A **case** is a base tree plus one diff under audit carrying **0–3 planted defects** (0 = clean control). A new
`suite: "seeded"` entry shape in the existing corpus family (`.strict()` Zod schema; legacy suites unchanged, #18):

```jsonc
{
  "id": "SB-0042", "suite": "seeded",
  "split": "calibration" | "holdout",
  "source": "public-history" | "fresh-seeded" | "clean-control",
  "shape": "intro" | "reverse-fix" | "mutant" | "clean",
  "repo": "claude-engineering-skills", "baseCommit": "<full sha>", "diffRef": "patches/SB-0042.diff",
  "defects": [{ "defectId": "SB-0042-D1", "file": "...", "lines": [120, 128], "class": "swallowed-error",
                "severity": "HIGH", "description": "...", "rubric": "...", "witness": "test" | "review",
                "provenance": { "fixCommit": "<sha>", "introCommit": "<sha>", "fixDate": "2026-08-14" } }],
  "authorisedBy": null, "curation": { "method": "human-review", "reviewedIn": "...", "miner": "..." }
}
```

History shapes: **`intro`** (preferred) — base = the introducing commit's parent, diff = its hunks restricted to the
defect's files, i.e. the forward change a reviewer really saw; **`reverse-fix`** (no introducer known) — base = the fix's
tree, diff = the fix reversed, a reported stratum because a diff that removes a guard is a tell. Diffs over 600 lines or
10 files are dropped (sashiko's filter, `docs/plans/sashiko-audit-improvements.md` §1.1).

**Curation evidence (stored per case, checked by `--suite seeded --validate`, no spend):**

- `diffRef` applies cleanly to `baseCommit` (`git apply --check`), and the defect's `lines` exist in the applied tree;
- **witness**: `test` — the command, and its recorded result on the defective tree (fails) and on the corrected tree
  (passes; for history, the fix commit; for a mutant, the base); `review` — the reviewer, date and a one-paragraph
  rationale for why the code is defective and at what severity. A case with neither is not admitted;
- a second person (or, when only one curator exists, a second sitting at least a day later — the stated
  single-adjudicator limit, C4) confirms location, class and severity;
- **incidental defects**: before freeze the incumbent's detect run on the calibration split is adjudicated, and any REAL
  finding no planted defect explains either joins the case's answer key (calibration split only) or removes the case.
  Holdout cases are built on adjudicated clean bases precisely so this question is already answered;
- **clean controls** must carry an `expect_clean` adjudication of `clean-under-audit`; a commit merely untouched by later
  fixes is a *candidate*, not a control, until adjudicated.

### 3.2 Splits and sources (custody)

| Source | Split | Use | Why |
|---|---|---|---|
| **public-history** — reverted fixes from this public repo (and authorised consumer repos), via `defect-harvest.mjs` candidates and `audit_findings.fix_commit_sha` rows (`supabase/migrations/20260508120000_adaptive_learning_v1.sql:23`) | **calibration only** | matcher calibration, threshold tuning, development, the smoke subset | public and possibly memorised: never a clean holdout |
| **fresh-seeded** — mutants from a closed class catalogue (§3.3) applied to clean bases, never published | **holdout** | scored only; never used to tune the matcher, thresholds or prompts | **unpublished** (not in any public repo or training corpus we control); it is still sent to providers at run time, so it is not secret from them |
| **clean-control** — `expect_clean` commits adjudicated `clean-under-audit`, and soaked commits with no later fix touching the lines | **both** (split by case) | false-positive rate on changes with no defect | precision needs changes known to have nothing to find |

Results are **always reported per source**, and the holdout figure is the headline.

**Frozen manifest.** Each split has a canonical manifest listing, per case, the case JSON digest, the `diffRef` and every
fix/witness artifact's content digest, `baseCommit` and the witness command; the manifest's SHA-256 is the split's
identity. Every run and repeat recomputes all of it before the first call and refuses on any mismatch. The holdout's
manifest and files live outside the public repo (Category P in `.gitignore`, `Durable home:` the operator's private store,
per `docs/reference/gitignore-policy.md`); only the manifest hash is committed. Every holdout access is logged (C2).
Provider retention is the providers' standard API terms, the same as every audit; a holdout run sends each case to the
arms' providers and the judges', so a holdout case **stays eligible for at most 3 recorded runs** (the pilot, its
repeat and one comparison) and is then retired to the calibration split at the next corpus version. A REAL finding on
any case that no planted defect explains is added at the **next** corpus version, never credited in the run that found
it (runbook Step 5).

### 3.3 Size and mix (pilot sizing only)

- **44 cases** (`expected`): 12 public-history (calibration), **24 fresh-seeded (holdout)**, 8 clean controls (4 per
  split). The holdout carries ≈ 36 planted defects (`derived`: 24 × ~1.5), ≈ 31 HIGH+MEDIUM (`derived`: × 0.85);
  severity HIGH 40% / MEDIUM 45% / LOW 15%. Headline recall is holdout HIGH+MEDIUM.
- **Classes**: the CES shapes AGENTS.md records as recurring and that occur among curated history — use-before-declaration;
  inverted/off-by-one condition; swallowed error rendered as empty result; fail-open default; missing `await`; exit
  without stdout drain; wrong field across a prose↔code seam; missing egress guard; jsonb hand-stringification; check
  green having checked nothing. One mutation operator per class; a class with neither history nor an operator is dropped.
- **Smoke subset**: 8 calibration-split cases, hand-listed, frozen (the `tiny` anchor convention).
- **Power, only as far as the pilot needs**, computed on the **holdout alone**: 24 case clusters, ≈ 31 HIGH+MEDIUM
  defects. From the McNemar approximation *n* ≈ (1.96·√p_d + 0.84·√(p_d − δ²))² / δ² (`derived`, 80% power, α 0.05):
  δ = 0.15 at a discordant rate p_d = 0.30 needs *n* ≈ 102 defects; δ = 0.30 at p_d = 0.40 needs *n* ≈ 32. This treats defects as independent, so
  with clustering it is an **optimistic** bound: the 31-defect holdout is powered for a gap of **at best ≈ 30 points**,
  and actual power is unknown until the A/A pair measures within-case correlation; a 15-point gap may be seen but will often land
  **inconclusive**. That is acceptable only because the degraded arm removes two of the five passes, chosen to make a
  large gap likely; the rule has an explicit inconclusive branch, and p_d is an assumption until the A/A pair measures
  it. Sizing for small effects (model swaps) is deferred until Pilot 2 measures within-arm variance (§7).

### 3.4 Decision rule (pre-registered)

Arms: **incumbent** — production 5-pass (`structure`, `wiring`, `backend`, `frontend`, `sustainability`;
`PASS_PROMPTS`, `scripts/lib/prompt-seeds.mjs:292 (df1686f7)`) + R1 final gate, via `runAuditGenerationArm` and
`scripts/gemini-review.mjs` — vs **degraded** — the same with **`wiring` and `backend` removed**: the two passes that
carry most correctness findings on CES's backend-heavy code (removing `frontend` would be a near no-op here). The final
gate receives exactly the findings the arm produced, through the same transcript builder; nothing else changes. Each
arm's full configuration (passes, seed revision hash, models resolved, effort, final-gate model, canary) is stamped on
every result, and a test asserts the two configurations differ **only** in the pass list. Two replicates each, all 44 cases.

**Aggregation (pre-registered).**
- A **case is valid** for the comparison when **both** replicates of **both** arms are valid (§2.5); otherwise it is
  excluded from both arms and listed. No single-replicate case is scored.
- **Defect score** for an arm = mean over its two replicates of found (1) / not found (0); `partial` counts 0.
- **Arm recall** = Σ defect scores ÷ number of HIGH+MEDIUM planted defects, over valid holdout cases (defect-weighted).
- **A/A gap** = |recall(incumbent rep 1) − recall(incumbent rep 2)| on the same valid cases, each replicate scored alone.
- **Clean-control false positives** = MEDIUM+ findings on valid holdout clean-control cases ÷ number of those cases, per
  arm; with branch 1 requiring ≥ 3 valid controls the denominator is never 0 when a later branch reads it, and a test
  asserts a zero-control input lands on branch 1.
- **Interval**: 10,000 cluster-bootstrap resamples (seeded; seed in the stamp) **of valid holdout cases with
  replacement**; each resampled case brings all its defects and both arms' replicate scores, and the statistic
  (incumbent recall − degraded recall) is recomputed on the resample; the 2.5th and 97.5th percentiles are the interval.
- `decideSeededPilot` is tested with worked examples: a case with one failed replicate (excluded), a 1-of-2 detection
  (scores 0.5), a two-defect case resampled as a unit, and every branch boundary.

**Branches, in order** (first match wins; computed on the holdout):

| # | Outcome | Rule |
|---|---|---|
| 1 | **Invalid** | < 20 of 24 seeded holdout cases valid in both arms, **or < 3 of the 4 holdout clean controls valid in both arms**, or completion differs by > 10 points (§2.5) |
| 2 | **Adopt (advisory, §0.3)** | incumbent − degraded HIGH+MEDIUM recall ≥ 0.15, 95% cluster-bootstrap interval (over cases) excludes 0, the incumbent's A/A replicate gap < the arm gap, and the incumbent's clean-control false positives ≤ the degraded arm's + 1 per case |
| 3 | **Not adopted** | the interval excludes 0 in the **wrong** direction, or its upper bound < 0.10 (the bench sees no difference a 40% cut in passes should make) |
| 4 | **Inconclusive** | anything else — widen the holdout for the repeat |

**What adoption claims**: only that the bench separates *this* degradation from the incumbent. It is necessary, not
sufficient, for judging a model swap; that needs a separately sized design once variance is measured (§7).

- **Minimum useful effect**: 15 recall points between arms. **Spend ceiling $130** (`derived`: 44 cases × 2 arms × 2
  replicates × ≈ $0.35–0.65 detect-only ≈ $62–114, + judges ≈ $10).

---

## 4. Relation to the existing harnesses

| Harness | Decision | How |
|---|---|---|
| Step-back replay (`scripts/step-back-replay.mjs`, `scripts/lib/audit/step-back-*.mjs`) | **Extend** — Pilot 1's harness | Reuse `freeze` (snapshot, provenance, separate scoring file), the revision fs, the metered cap and JSONL results; add a `continue` subcommand that runs the two arms from each frozen point. Its saturated ground truth is replaced by §2.2's adjudication; its pre-registered-rule shape is kept. |
| Model-eval (`scripts/model-eval-auditor.mjs`, `scripts/lib/model-eval/**`) | **Extend** — Pilot 2's harness | `--suite seeded` in the existing loader + CLI; reuse case tree, generation arm, stamp + `stampMismatch`, cost, expect-clean adjudication, blind judge. The Jaccard scorer stays the default for legacy suites and becomes the matcher's negative control. |
| Arm-eval | **Reuse its blinding** | The pooled, shuffled, source-blinded adjudication sheet (as solo-control's `merge`); no arm-eval collector is re-enabled. |
| Shadows (model-A/B/C, tiered-recall) | **Unchanged** | Both pilots are synchronous; no collector is added (AGENTS.md: do not add a sixth). |

**Gating**: both pilots are **report-only**; nothing runs in CI (they spend, and CES is public). A later proposal may make a
Pilot-2 smoke report required evidence on `PASS_PROMPTS` edits; whether that becomes a gate is Louis's decision.

**Prior art, briefly**: from SWE-bench, real fix commits as cases, FAIL_TO_PASS tests as a validity witness
(`witness: test`), and Verified's lesson that mined items need human review; from SWE-bench-Live, freshness as the
contamination control (here, the unpublished holdout). From Inspect AI, the dataset / solver / scorer separation and
epochs (replicates) as the modules' shape. From promptfoo, per-case assertions as the shape of a future seed-edit check.
**No framework is adopted**: no current requirement needs one, Inspect is Python in an ESM-only repo, and promptfoo models
one prompt → one output, not a multi-round loop.

---

## 5. Security Considerations

- **Egress**: every diff and file read goes through the existing gates — `findSensitivePathMentions` on the diff at load,
  `resolveAndClassify` (realpath + re-classify, fail closed; INC-001) on every read via the case tree or the revision fs
  (which already refuses symlink entries), `redactSecrets` on bodies.
- **Judge payloads are a new egress path** and get the same treatment: a judge sees a finding (possibly from a stored
  ledger, quoting code), a ledger entry or a hidden defect description, and the cited code. Every judge request is built
  by one function, `prepareJudgePayload`, which runs `findSensitivePathMentions` over every text field, drops any cited
  code whose path `resolveAndClassify` marks sensitive (counted, never sent), applies `redactSecrets` to every string,
  and fails closed (`[REDACTED:redaction-failed]` semantics) — the judge call is skipped and the pair counted
  `not-judged`, which blocks the score. Ledger findings from a consumer repo are judged only under that repo's
  `authorisedBy`. A Tier 3 test asserts on the **emitted request body** (not the client config): a secret-shaped
  string, a sensitive path mention and a symlinked sensitive file each fail to leave.
- **Cross-repo**: a consumer repo's code enters a pilot only with Louis's recorded authorisation for that repo
  (`authorisedBy` + date); the loader refuses a non-CES case without it (exp-3's boundary,
  `docs/research/experiment-3-model-swap-glm-vs-gpt.md`).
- **Holdout custody**: never committed or pasted into a PR, issue or status entry; only its hash is public. Hidden
  `description`/`rubric` never reach an arm (the generation arm's visible/hidden split).
- **Pilot 1 debt**: META's stop/structural debt command is recorded, never executed, so a pilot cannot write debt.

---

## 6. File-Level Plan

| File | Intent | Purpose / key exports | Principle |
|---|---|---|---|
| `scripts/lib/model-eval/concern-matcher.mjs` | create | `filterCandidates` (pure), `prepareJudgePayload` (egress, §5), `judgePairs` (frozen judge, schema quote), `assignMatches` (pure, min-cost maximum-cardinality assignment over a total-order key), `MATCHER_VERSION`; used by both pilots. | #1, #2, #11 |
| `scripts/lib/model-eval/matcher-calibration.mjs` | create | Score judge + Jaccard control against a human-labelled pair file; per-arm agreement; Wilson intervals; accept/reject per §1.4. | #11 |
| `scripts/lib/audit/step-back-continuation.mjs` | create | `runContinuation({point, arm, replicate})`: seed a fresh sid from the frozen snapshot inside a case tree at the audited sha, run the next round META or CONTINUE, record verdict, findings, cost; `decideMetaPilot(results)` (pure, §2.3). | #2, #11 |
| `scripts/step-back-replay.mjs` | modify | `freeze --pilot meta-ab` (all cap-reaching sessions, recorded invocation args, seeded partition into calibration / rehearsal / pilot / repeat), `continue` subcommand (`--dataset`, `--set`, `--replicates`, `--max-usd`, `--confirm-spend`, `--results`), `reconcile` (resolve an indeterminate `reserved` call, §2.6) and `score --pilot meta-ab`. | #1 (extend, no new CLI) |
| `scripts/lib/llm-budget.mjs` | create | `reserveCall` / `settleCall` (§2.6): byte + output-cap upper bound, mutex + `wx` lock, per-call states, refusal on unpriced or uncapped requests; inert unless `AUDIT_BUDGET_LEDGER` is set. | #2, #16 |
| `scripts/lib/audit/llm-helpers.mjs`, `scripts/lib/final-review/transport.mjs`, `scripts/lib/anthropic-client.mjs`, `scripts/lib/llm-wrappers.mjs` | modify | One `reserveCall`/`settleCall` pair at each provider-call seam; byte-identical when the env variable is unset. | #1, #18 |
| `scripts/lib/model-eval/known-defect-corpus.mjs` | modify | `seeded` suite schema, `split`/`source`/`shape`, holdout load by path + digest, `authorisedBy` check; stamp gains `matcherVersion`, `split`. | #5, #13, #18 |
| `scripts/lib/model-eval/seeded-report.mjs` | create | Recall per split/source/severity/class, clean-control false positives, cluster bootstrap (seeded), `decideSeededPilot` (pure, §3.4). Kept out of the CLI so `model-eval-auditor.mjs` stays well under 1000 lines. | #2, #11 |
| `scripts/model-eval-auditor.mjs` | modify | `--suite seeded` wiring to `seeded-report.mjs`. | #1 |
| `scripts/lib/model-eval/case-tree.mjs` | modify | Apply a case's `diffRef` on `baseCommit` as a throwaway local commit, so `--scope diff` sees exactly the seeded diff. | #1 |
| `scripts/defect-harvest.mjs` | modify | Candidate fields `introCommit`, `revertsCleanly`, `fixDate`, test-witness probe; second stream from `audit_findings.fix_commit_sha` (read-only, `scripts/lib/store/runs-findings.mjs`). Outcomes still reconcile or exit 3. | #1 (precedent) |
| `docs/experiments/seeded-bench/README.md` | create | Corpus card: version, splits, holdout digest, access log, deviations, authorisations. | #5 |
| `docs/experiments/seeded-bench/cases.calibration.json` | create | Calibration split + clean controls (public). | — |
| `docs/runbooks/seeded-bench.md` | create | Operator runbook for both pilots: freeze, fixture, heartbeat, spend, adjudication sitting, verdict. | — |
| `.gitignore` | modify | Category P block for the local holdout copy; Category A for `.audit-loop/bench/` output. | gitignore policy |
| `tests/concern-matcher.test.mjs` | create | Scorer controls (oracle 1.0, null 0, shuffled ≈ 0, duplicate credited once); filter window; assignment. | #11 |
| `tests/step-back-continuation.test.mjs` | create | Offline end-to-end through the real `openai-audit.mjs` gate with injected providers for plan T1, code T1, code T2 fixtures: received sid / round / ledger / trigger; arms differ only in the meta flags; a stop records but never runs the debt command; trigger mismatch ⇒ `unrecoverable`; partition sets disjoint; `decideMetaPilot` every row of §2.3 incl. a 1–1 split, a zero CONTINUE sum and precedence collisions. | #11 |
| `tests/pilot-budget-ledger.test.mjs` | create | Reservation ≥ metered cost on recorded real requests; a call over the remaining cap is refused before send; unpriced or uncapped request refused; concurrent reservations from two processes never exceed the cap; a `reserved` record left by a killed process blocks resume until reconciled; seam inventory derived from `scripts/**` has no unlisted provider-request site; unset env ⇒ seams byte-identical. | #11, #16, #18 |
| `tests/judge-payload-egress.test.mjs` | create | Tier 3 (a): emitted judge request bodies carry no secret-shaped string, no sensitive path mention, no symlinked sensitive file. | Tier 3 (a) |
| `tests/seeded-corpus-loader.test.mjs` | create | `.strict()` rejects unknown keys; holdout digest mismatch refused; non-CES case without `authorisedBy` refused; legacy suites unchanged. | #13, #18 |
| `tests/seeded-report.test.mjs` | create | Bootstrap deterministic under seed; per-split reporting never pools a holdout into calibration; `decideSeededPilot` branches. | #11 |
| `tests/egress-path-scan.test.mjs` | modify | A seeded case tree with a symlink into a sensitive path is refused (INC-001 shape). | Tier 3 (a) |

### 6.1 Implementation Phases

**Phase 1 — Freeze, partition, budget, matcher, calibration**: freeze every cap-reaching session and partition it (§2.1)
**first**; then the budget module and its four seams (§2.6), so the very first paid call — a calibration judge call —
already runs under a ledger initialised by the calibration command (`--max-usd 10`, same states, same refusal rules);
then the matcher, its egress step and offline controls, and the calibration scorer; label the 200 pairs (challenge +
prevalence) from the **calibration** set only (judge calls ≈ $10). Files: `scripts/step-back-replay.mjs` (modify),
`scripts/lib/model-eval/concern-matcher.mjs` (create), `scripts/lib/model-eval/matcher-calibration.mjs` (create),
`tests/concern-matcher.test.mjs` (create), `tests/judge-payload-egress.test.mjs` (create), `scripts/lib/llm-budget.mjs`
(create), `scripts/lib/audit/llm-helpers.mjs` (modify), `scripts/lib/final-review/transport.mjs` (modify),
`scripts/lib/anthropic-client.mjs` (modify), `scripts/lib/llm-wrappers.mjs` (modify), `tests/pilot-budget-ledger.test.mjs`
(create).

**Phase 2 — Pilot 1 harness, rehearsal and run**: continuation contract + budget ledger + scoring; dress rehearsal on the
5 rehearsal points (discarded from scoring); the paid pilot on the pilot set; adjudication sitting; advisory verdict.
Files: `scripts/lib/audit/step-back-continuation.mjs` (create),
`scripts/step-back-replay.mjs` (modify), `tests/step-back-continuation.test.mjs` (create),
`docs/runbooks/seeded-bench.md` (create),
`docs/research/experiment-9-meta-step-back-ab.md` (create).

**Phase 3 — Pilot 2 corpus and run**: loader suite, case tree diff application, miner fields, the 44 cases, the paid pilot,
advisory verdict. Files: `scripts/lib/model-eval/known-defect-corpus.mjs` (modify), `scripts/lib/model-eval/case-tree.mjs`
(modify), `scripts/defect-harvest.mjs` (modify), `scripts/lib/model-eval/seeded-report.mjs` (create),
`scripts/model-eval-auditor.mjs` (modify), `docs/experiments/seeded-bench/README.md` (create),
`docs/experiments/seeded-bench/cases.calibration.json` (create), `.gitignore` (modify),
`tests/seeded-corpus-loader.test.mjs` (create), `tests/seeded-report.test.mjs` (create), `tests/egress-path-scan.test.mjs`
(modify), `docs/research/experiment-10-seeded-detection-pilot.md` (create).

**Close-out (not a phase)**: `npm run check`, `npm test`, `npm run skills:regenerate` if a skill reference changed,
`node scripts/campaign-contract-check.mjs docs/plans/seeded-defect-benchmark.md --closeout --rev origin/main`.

### 6.2 Execution Clustering

- **Cluster A** — Phases 1–2 — fix-gate: yes
  - Coupling: Pilot 1's novelty count is the matcher's first consumer; auditing them together lets the wiring pass check
    the `same`/`partial` contract at the seam where it decides a number.
- **Cluster B** — Phase 3 — fix-gate: final
  - Coupling: the corpus schema, case tree, report and CLI wiring are one `--suite seeded` contract.
- **Final gate**: consolidated Gemini review over the union diff of Clusters A–B.

### 6.3 Spend (every figure `expected` until metered)

| Run | Hard `--max-usd` |
|---|---|
| Matcher calibration (both judges on 200 pairs) | $10 |
| Pilot 1 dress rehearsal (5 points × 1) | $15 |
| Pilot 1 (16 points × 2 arms × 2 replicates) | $100 |
| Pilot 2 dress rehearsal (5 cases × 1) | $10 |
| Pilot 2 matcher calibration gate (both judges on 130 calibration-split pairs; its own ledger, run before the holdout is read) | $5 |
| Pilot 2 (44 cases × 2 arms × 2 replicates) | $130 |
| Each repeat run (§0.3) | same as its pilot |

Each paid run is a separate spend request to the coordinator / Louis, with the price review date; the hard stop meters
provider usage per call, never the preflight (memory: a replay preflight once estimated 8× low).

---

## 7. Risk & Trade-off Register

| Risk / trade-off | Handling |
|---|---|
| The judge is an LLM that may favour one arm's phrasing | Per-arm agreement in calibration; a second judge on Pilot 1 because Opus is the meta reviewer; Jaccard negative control. |
| Few decision points reach the cap | Plan-audit points included; \|*S*\| < 5 is `inconclusive`, never a decision. |
| One-round continuation undercounts what a longer continuation would find | Stated limit; the meta-review decides one round at a time, so one round is the unit of its decision. |
| A human labeller is a single adjudicator | Stated (C4); judge-vs-human agreement reported. |
| Public-history cases are memorised | Calibration split only; the headline is the unpublished holdout. |
| Pilot 2 could saturate like replay v2 | Its rule is a large, designed effect; "not adopted" is a written outcome, not a retry. |
| **Deferred**: sizing for small effects (model swaps, single-prompt edits) | Needs Pilot 2's measured variance first; a true scope boundary, not difficulty. |
| **Deferred**: an oracle fixer and multi-round loop mode | No current decision needs more than one continuation round; revisit if Pilot 1 is inconclusive for that reason. |
| **Deferred**: a CI/PR gate on `PASS_PROMPTS` edits | Needs an adopted, repeated Pilot 2; Louis's decision. |

---

## 8. Testing Strategy

- **Unit (offline, injected providers only)**: matcher filter / assignment / controls; `decideMetaPilot` and
  `decideSeededPilot` every branch; loader schema; the continuation arms' emitted argv differ only by the toggle.
- **Integration**: `step-back-replay.mjs continue --dry-run` on a frozen dataset in a clean pinned worktree
  (sandbox-honesty: a missing snapshot is `unrecoverable`, never a skipped green); `model-eval-auditor.mjs --suite seeded
  --dry-run` with no holdout present reports `holdout: unmeasured`.
- **Edge cases**: a finding with no line; a defect over two files; a duplicate across passes; a point where META's verdict
  is downgraded by the guard (counts as META running the round); a case whose passes all failed (INCOMPLETE, excluded
  from both arms); an unknown judge verdict (fails closed).
- **Proof plan** (`skills/plan/references/proof-oracle.md`):
  - *Matcher works* — oracle: offline controls written red before the matcher; pass: oracle 1.0, null 0, duplicate
    credited once; evidence: test names + counts. Then the §1.4 calibration bar; evidence: calibration report in experiment 9.
  - *Arms differ only by the toggle* — oracle: a test asserting the two arms' argv/env differ in exactly the meta flags;
    red on a deliberately leaky arm; evidence: test name.
  - *Pilot 1 decides* — oracle: §2.3 rule on adjudicated counts; evidence: `docs/research/experiment-9-meta-step-back-ab.md`
    with the dataset hash, commands and metered spend.
  - *Pilot 2 can separate arms* — oracle: §3.4 rule; evidence: `docs/research/experiment-10-seeded-detection-pilot.md`.

---

## Campaign Contract

### C1 — Decision and metric
- **decision**: Pilot 1 — whether the meta step-back stays on by default; Pilot 2 — whether the seeded corpus becomes the
  eval of record for model swaps and `PASS_PROMPTS` edits. Louis decides on the verdict documents; both advisory until
  repeated (§0.3).
- **metric**: Pilot 1 — miss rate over META's stops, cost saved versus always continuing, admission yield (§2.3);
  Pilot 2 — holdout HIGH+MEDIUM recall difference incumbent − degraded with a cluster-bootstrap interval, plus
  clean-control false positives (§3.4).
- **error-costs**: Pilot 1 — keeping a step-back that misses real findings loses defects silently at every cap (high);
  turning off a good one costs a few dollars and a human call per cap (moderate). Pilot 2 — adopting a blind instrument
  lets bad prompt edits ship to every consumer (high); rejecting a good one delays it (low). Trivial base rates: an
  always-stop arm has miss rate = CONTINUE's yield and cost saved 100%; an arm flagging every line has recall ~1 and
  clean-control false positives ~all — so no metric is read alone.

### C2 — Split, leakage and sealed test custody
- **split**: Pilot 2 — public-history cases are calibration only; fresh-seeded cases are the holdout and never tune the
  matcher, thresholds or prompts; clean controls split by case; two cases from one fix or one base never straddle splits.
  Pilot 1 — every cap-reaching session is frozen, then partitioned by session with a recorded seed into calibration,
  rehearsal, pilot and repeat sets (§2.1); the loader refuses a run whose set does not match its purpose.
- **test-set-hash**: SHA-256 of the canonical holdout file, computed by the loader at freeze and committed in
  `docs/experiments/seeded-bench/README.md`; Pilot 1's frozen dataset hash is recorded by `step-back-replay.mjs freeze`;
  every run re-verifies both.
- **access-record**: every run against the holdout appends `{runId, revision, arm, operator, date, purpose}` to the
  "Holdout access log" table in `docs/experiments/seeded-bench/README.md`; analysis designed after a result is seen is
  labelled exploratory; a changed rule needs a new corpus version.

### C3 — Feasibility and power
- **bound**: Pilot 1 with \|*S*\| ≈ 8 stops resolves a miss rate to about one point in eight (`derived`), enough to
  separate ≤ 20% from > 40% but not 20% from 30%; Pilot 2 with ≈ 31 holdout HIGH+MEDIUM defects in 24 case clusters is
  powered for a recall gap of at best ≈ 30 points (`derived`, optimistic — it ignores clustering, §3.3); a 15-point gap will often be inconclusive.
- **assumptions**: enough real sessions reach the cap with recoverable snapshots (checked at freeze; \|*S*\| < 5 ⇒
  inconclusive); replicates independent given a fixed state; defects within a case correlated (cluster bootstrap). Both
  rules can return a non-empty answer: each has an explicit inconclusive branch.

### C4 — Instrument and controls
- **controls**: matcher offline controls (oracle, null, shuffled, duplicate) and the Jaccard negative control (§1.4); the
  A/A replicate pairs in both pilots; `AUDIT_CANARY=1` in every round; Pilot 2's degraded arm as the discriminability
  control; clean controls; fresh-seeded and public-history cases share one form with opaque ids and no source marker an
  arm can see.
- **independence**: one human labeller (Louis or the operator) for calibration and adjudication — a stated
  single-adjudicator limit; labelling is blind to arm; a second judge model re-scores Pilot 1 because the default judge
  shares a family with the meta reviewer.

### C5 — Declared telemetry
- **telemetry**: per run: `runId`, `revision`, `datasetHash` / `corpusDigest`, `split`, `matcherVersion`,
  `judgeModelServed`, `arm`, `replicate`, `modelsServed` per provider call, round, findings (MEDIUM+, with matcher
  verdicts), meta verdict + guard result (Pilot 1), canary outcome, INCOMPLETE flag, tokens and `costUsd` per call,
  wall time.
- **fill-check**: the dress rehearsal asserts every field non-null on every row; `costUsd: null` or an empty
  `modelsServed` fails it.

### C6 — Operations
- **revision**: `npm run fixture:create` pinned worktree at a stated full sha; both CLIs refuse a paid run outside a
  fixture; corpus and datasets read via `git show <rev>:…` or their frozen hash.
- **model**: arms and judges named by `{"kind":"pinned-model","value":"…"}` when a specific model is meant; the id each
  provider served is recorded per call.
- **spend-limit**: hard `--max-usd` per run from §6.3 on metered usage; OpenAI, Google and Anthropic sdk quotas checked in
  the preflight; the price review date stated in each spend request.
- **heartbeat**: `node scripts/run-heartbeat.mjs run --run-id seeded-bench-pilot1 --stale-after 900 -- node scripts/step-back-replay.mjs continue …` (Pilot 2: `--run-id seeded-bench-pilot2`, `node scripts/model-eval-auditor.mjs --suite seeded …`).

### C7 — Dress rehearsal
- **items**: 5
- **evidence**: `docs/experiments/seeded-bench/rehearsal-pilot1.md`

### C8 — In-run canary
- **canary**: `AUDIT_CANARY=1` on every audited round of both pilots; a miss makes that run INCOMPLETE and its point or
  case is excluded from both arms of the paired comparison.
- **evidence**: `docs/experiments/seeded-bench/canary-log.md`

### C9 — Contract epoch
- **contract-epoch**: `seeded-bench-v1` stamped at the collector on every evidence row with `matcherVersion` and the
  dataset/corpus digest; a meaning-changing fix bumps it and re-collects, never a backfill by date.

### C10 — Deviations
- **ledger**: the "Deviations" section of `docs/experiments/seeded-bench/README.md`; anything off-contract goes to the
  coordinator and Louis before merge.

### C11 — Done means artifact
- **done-evidence**: docs/experiments/seeded-bench/README.md, docs/experiments/seeded-bench/rehearsal-pilot1.md, docs/research/experiment-9-meta-step-back-ab.md, docs/research/experiment-10-seeded-detection-pilot.md

### C12 — Close-out claims check
- **claims-check**: docs/research/experiment-9-meta-step-back-ab.md, docs/research/experiment-10-seeded-detection-pilot.md

---

## Audit Trail

- **Scope narrowing (2026-11-23)**: an earlier draft (a 90-case benchmark with an oracle-fixer loop mode) was rewritten
  before any audit round completed, on the coordinator's relay of Louis's five-gap review (§0.1). The in-flight round-1
  run on the old draft was stopped and discarded; nothing from it was triaged.
- **GPT plan audit** (SID `audit-plan-1795426000566-82052`, `/audit-plan`, 3 rounds = the default cap):
  - R1 — `SIGNIFICANT_GAPS`, H11 M3; 14/14 accepted and fixed (decision rule aggregation, full human labelling,
    matching semantics, session partition, continuation contract, completion/canary, manifest custody, curation evidence,
    holdout size + inconclusive branch, judge-payload egress, budget ledger, calibration prevalence, named degraded
    passes, sentinel-resolved judges).
  - R2 — `NEEDS_REVISION`, H4 M1; 5/5 accepted and fixed (true upper-bound reservations at the provider seams,
    indeterminate in-flight calls, Pilot 2 aggregation, filter-independent recall sample + a separate Pilot 2 matcher
    gate, total-order tie-break).
  - R3 — `NEEDS_REVISION`, H5 M1; 6/6 accepted and fixed (unknown billing keeps its reservation, budget before the first
    paid call, pre-checkpoint meta-review history restored, Pilot 2 calibration from both arms, clean-control minimum,
    power labelled optimistic).
  - Acceptance 100% in every round and HIGH counts falling 11 → 4 → 5 (narrower each round): productive, but the
    round cap was reached, so the loop stopped there and went to the final gate.
- **Final gate**: Gemini (`gemini-4-argon`), round 1, verdict **APPROVE**, `gateDisposition: approve` (0 blocking, 1 LOW
  debt; $0.16 metered). The LOW (G1: Pilot 2's calibration-gate spend unallocated) was folded in after the gate as one
  row of §6.3 — a spend-table line, no design change.
- **Remaining / debt**: none open.
