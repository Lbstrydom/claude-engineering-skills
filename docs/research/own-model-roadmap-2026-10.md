# Own-model roadmap: distillation now, decision support later (2026-10)

- **Date**: 2026-10-25
- **Status**: Research memo (no code, no migration). Feeds `/plan` for H1 and for the telemetry ledger.
- **Method**: `/brainstorm --debate --depth deep` (OpenAI `gpt-6.1-sol`, Gemini `gemini-pro-latest`, session `1792931944686`, cost $0.14 *measured*), four focal artifacts attached, plus Claude's own read. Three keeper insights saved to `.brainstorm/insights/` (gitignored, local).
- **Figure labels**: *measured* = a query run 2026-10-25 against the store (`store d5a9d07b91225a93`); *derived* = arithmetic on measured; *expected* = estimate, not observed.

## 0. Recommendation (one paragraph)

**Build the dataset now; earn the right to train.** The scarce asset is a trustworthy join from *decision → outcome*, not weights. Spend the next six weeks on (a) a content-bearing **decision ledger** that survives account switches, kept apart from counts-only fleet telemetry, and (b) an H1 *measurement* experiment whose first exit is "a prompted cheap model already meets the bar, skip the LoRA". Do **not** fine-tune a coordinator. H3's durable asset is the dataset; the first H3 tool is retrieval, the second a prompted critic, and a trained ranker only if held-out evaluation shows it adds value.

## 0.1 Decisions received from Louis (2026-10-25)

- **Scope**: storyline, CES, ai-organiser and wine-cellar-app are all approved for the training corpus, **and** Azure-store retrieval is approved. This **supersedes** the default-exclude rows of the first draft and the brainstorm voices' storyline/AIO exclusion, which Louis has overridden. Mechanism unchanged: eligibility stays a per-repo stored flag (`training_eligible`), so a later revocation is one update plus a purge, not a code change. The approval is Louis's; whether Wärtsilä's own terms allow work-repo content to leave the Azure tenant or reach a non-tenant training host is not something this memo can establish, so §6.6 keeps storyline data **on tenant-reachable hosts only** until that is checked.
- **Compute**: local Radeon RX 6600 XT; assessed in §0.2.
- **H1**: prepare the labelling weekend (§3.1); do not execute it yet.
- **Telemetry first**: audit what H1 needs that is not captured (§2.1) and start capturing it.

## 0.2 Is the RX 6600 XT enough? (expected; verify before buying anything)

The screenshot shows an **AMD Radeon RX 6600 XT (Navi 23, RDNA2)**. "Adapter RAM 1,048,576 bytes" is the known 32-bit WMI display bug, not the real memory; the card has **8 GB VRAM** (*expected*, from the model, not read from the machine; confirm in Task Manager).

| Use | Verdict |
|---|---|
| **H1 prompted baselines** (Haiku/Flash/GPT-mini, retrieval few-shot) | Needs no GPU. Unaffected. |
| **Running a small open model for inference** (4-8B, 4-bit, llama.cpp Vulkan) | Works on 8 GB. Enough to try a local classifier or embedder. |
| **LoRA/QLoRA on a 7-14B** | **Not realistic here.** 8 GB is tight for even a 7B QLoRA once a sequence is a finding plus a diff (long context); 14B does not fit. The bigger blocker is software: the usual training stacks (Unsloth, TRL, bitsandbytes) are CUDA-first, and ROCm on Windows for a consumer RDNA2 card is poorly supported (*expected*; check the current ROCm/PyTorch support matrix before relying on it). A 1-3B QLoRA may be possible with effort, but the H1 plan names 7-14B. |

**Recommendation: do not buy a GPU for H1.** The pre-registered rule makes the LoRA a branch expected not to run. If it does, rent a GPU for a few hours (a third-party host, so subject to the terms check in §6.6) or buy **after** the verdict. If you buy for the learning-project goal, an **NVIDIA card with 16-24 GB** (used 24 GB class) is what the tooling assumes; price is not researched here. Revisit at the H1 verdict, not before.

## 1. Where the voices landed

**Agree.** (1) Accept/dismiss is the operator's workflow state, not defect truth; a model can score well by learning Louis's habits and suppress exactly the uncomfortable findings. (2) Skip the LoRA if prompting meets the bar. (3) Dataset durable, model disposable. (4) Decision content must not enter counts-only fleet telemetry. (5) Storyline and the AIO vault are out of any corpus by default. (6) Convergence prediction should *trigger structural review*, not auto-abort.

**Diverge.**
- *LoRA in H1*: OpenAI keeps it conditional on a measured gap; Gemini would kill it for ML-ops cost and pull retrieval-few-shot forward. **Resolution here**: the plan treats LoRA as a gated branch that is expected not to run; dynamic few-shot over retrieved labelled cases is added to the prompted arm (cheap, same harness).
- *Label*: Gemini wants the `known-defects.json` oracle as the validity label; OpenAI notes the harness documents an oracle-matching recall ceiling (low recall there is not a quality signal). **Resolution**: oracle for a screen only; validity comes from a hand-labelled sample of real findings.
- *Storage*: Gemini proposes local JSONL plus a hash-only Postgres index; OpenAI says hashes are not anonymisation and local files are not a privacy exemption. **Resolution**: a separate **content table** in the store, with per-record training permission, plus a content reference; hashes are join aids only.
- *Capture friction*: OpenAI wants options and rationale logged; Gemini warns a mandatory rationale makes Louis stop overriding. **Resolution**: passive capture by default (proposed action vs executed action); rationale optional, never prompted.
- *Where storyline may sit*: Gemini suggests tenant-isolated RAG on the Azure store could be fine; OpenAI excludes outright. **Resolution**: exclude from every *training* corpus and from cross-repo retrieval by default; Louis decides whether in-tenant retrieval on the Azure store is acceptable (decision D2).
- *Provider fine-tuning APIs*: Gemini bans them; OpenAI says check terms rather than ban. **Resolution**: local-first for anything beyond CES-public data; a provider API only after the exact service's current terms are read, for CES-public data only.

**Raised by one voice only.**
- (OpenAI) Independent-task counting: 50 findings from one audit are correlated; split by group (audit run / PR), not finding. Kept: it changes the effective sample size.
- (OpenAI) Historical reviewer routing is confounded (hard diffs already get the expensive reviewer); only small randomised, budget-capped comparisons can establish equivalence. Kept.
- (OpenAI) "Merged without rework" rewards trivial chips; decompose the outcome. Kept.
- (OpenAI) Raw decisions go stale too; carry policy version per record. Kept.
- (Gemini) Gate-cost and lease scheduling is a queuing problem; use p95 history, not ML. Partly kept: learned duration *estimates* are an input, the scheduler stays deterministic.
- (Gemini) Convert a retrieved-case "shadow adjudicator" (Flash + RAG) into H1. Kept as the second prompted arm.
- (Gemini) A reward-model critic that ranks 3-5 candidate plans. Kept as H3 step 2, gated.
- (Gemini) Extend the existing store rather than building greenfield. Kept: ledger goes through `cross-skill.mjs`.

**Claude's own additions (not in either voice).**
1. The store holds findings *text* (`detail_snapshot`) but H1 needs the **diff**; reconstruct it from `audit_runs.audited_sha`/`audited_tree` and treat missing reconstructions as an exclusion count, not zero.
2. The cheapest, highest-value capture is **not** new instrumentation but a *handover step*: the coordinator writes one decision record whenever it asks Louis for a call or Louis overrides it. The chat transcript is the only place this exists today.
3. Gate on **abstention**: every predictor ships with "unknown" and a fallback, otherwise uncertainty quietly becomes authority.

## 2. Measured starting position (store census)

Queries run 2026-10-25 via `scripts/lib/db/query.mjs` `many()` on the audit store; window `audit_findings.created_at` 2026-07-17 → 2026-10-25 (~14 weeks).

| Fact | Value | Label | Query |
|---|---|---|---|
| Findings / runs | 23,797 / 3,987 | measured | `select count(*), count(distinct run_id) from audit_findings` |
| `user_action` null | 19,752 (83%) | measured | `select user_action, count(*) from audit_findings group by 1` |
| `fix-now` / `dismissed` / `accepted-permanent` / `needs_triage` / `auto_dismissed` | 977 / 547 / 1,185 / 1,231 / 105 | measured | same |
| Cleanly labelled accept-vs-dismiss (`fix-now` + `dismissed`) | 1,524 | derived | 977 + 547 |
| `adjudication_outcome` accepted / dismissed / severity_adjusted / null | 11,607 / 3,909 / 195 / 8,086 | measured | `select adjudication_outcome, count(*) …` |
| `remediation_state` fixed / pending / planned / verified / regressed / null | 8,994 / 3,479 / 2,301 / 367 / 16 / 8,640 | measured | `select remediation_state, count(*) …` |
| `source_kind` MODEL / REVIEWER / null / LINTER | 20,651 / 2,261 / 873 / 12 | measured | `select source_kind, count(*) …` |
| Clean labels by repo (labelled / total findings) | wine 779 / 11,721; CES 709 / 9,865; AIO 36 / 1,994; **storyline 0 / 217** | measured | join `audit_runs` → `audit_repos`, `count(*) filter (where user_action in ('fix-now','dismissed'))` |
| `finding_adjudication_events` | 15,426 events over 15,282 findings | measured | `select count(*), count(distinct finding_id) from finding_adjudication_events` |
| Fleet/ship/learning tables present | `fleet_events`, `ship_events`, `ship_gate_effectiveness`, `learning_decisions` | measured | `information_schema.tables` |
| Tables for coordinator decisions, chip outcomes, per-task cost | **none** | measured | same listing (no chip/decision table) |

Reading: the clean-label set (1,524) is smaller than it looks (two repos carry 98%; findings cluster by run) and the effective independent-task count is far lower. `adjudication_outcome` is richer (15,711 non-null) but is exactly the confounded triage column; keep it as a *feature of the process*, never the sole target. **Storyline findings (217) exist in the store and must be excluded by an explicit repo filter before any export (D2).**

## 2.1 H1 telemetry gap audit (what is captured vs what H1 needs)

Queries run 2026-10-25 on the audit store (*measured*).

| H1 need | State in store | Evidence (query) | Action |
|---|---|---|---|
| **The diff the finding was raised on** | **Not stored.** Only reconstructable from `audit_runs.audited_sha`/`audited_tree`, set on 3,906 of 6,092 runs (64%); no base sha, so the range is not recoverable | `select count(*), count(audited_sha) from audit_runs` | Persist a bounded, redacted, content-addressed diff per run plus `diff_base_sha`; make `audited_sha` non-null |
| **Finding text** | `detail_snapshot` on every finding (avg 334 chars) | `count(detail_snapshot), avg(length(detail_snapshot))` | Adequate; confirm it is not truncated |
| **Who decided** | `finding_adjudication_events.adjudicator_kind` null on 14,973 of 15,426 events (97%); only campaign code writes it (`scripts/lib/store/campaign.mjs`). 139 `human`, 314 `agent` | `group by adjudicator_kind` | Set `adjudicator_kind`/`adjudicator_model` on the normal adjudication write path |
| **When it was resolved** | `audit_findings.decided_at` exists; `time_to_resolution_ms` populated on **0** rows | `count(time_to_resolution_ms)` | Populate or drop the dead column |
| **Why dismissed** | `dismiss_reason` on 136 of 652 dismissed + auto-dismissed rows | `count(dismiss_reason)` vs `user_action in ('dismissed','auto_dismissed')` | Closed-vocabulary reason at dismissal |
| **Fixed before adjudication** | `fix_commit_sha` on 842 of 23,797 (3.5%) | `count(fix_commit_sha)` | Remediation sweep sets it; add a `fixed_before_adjudication` flag |
| **Pipeline prediction at decision time** | `stage` and `arm` null on all 23,797 findings | `select stage, arm, count(*) …` | Record the Stage-1 prediction and its model per finding (shadow data for H1 baselines) |
| **Run cost** | `total_cost_estimate` on 5,142 of 6,092 runs | `count(total_cost_estimate)` | Make non-null |
| **Corpus eligibility** | no flag; storyline rows share the table (217 findings, 0 clean labels) | repo census in §2 | Add `audit_repos.training_eligible` and an export-time check |
| **Join key to decisions** | `audit_runs.task_id` **exists but is the arm-eval task-text hash and is empty (0 rows)**: a name collision | `count(task_id), count(distinct task_id)` | Use a different name (`work_item_id`) for the ledger join key |

**Reuse, do not duplicate.** `learning_decisions` already is a decision-trace table (`context`, `context_hash`, `choice`, `outcome`, `outcome_at`; *measured*: arch_memory_band 11,144, pass_selection 3,971, convergence_predict 3,971 with 2,561 outcomes, author_tier 3,869, quickfix_hit 1,213; query `select decision_type, count(*), count(outcome) from learning_decisions group by 1`). The H2 convergence candidate therefore **already has ~2,600 outcome-labelled rows**. Coordinator decisions should extend this table (new `decision_type` values) unless content-bearing columns force a separate one.

## 3. H1 — narrow distillation experiment (ready for `/plan`)

**Question.** Can a cheap model identify *actionable* GPT audit findings well enough to cut reviewer spend, without suppressing valid findings?

**Objective hygiene.** Three separate labels, never aliased: `disposition` (workflow: fix-now/dismissed/deferred), `actionable` (hand-judged at decision time, includes findings fixed before adjudication), `valid` (a true defect). Primary target = **actionable**. The dangerous error = *actionable predicted safe-to-dismiss*.

**Steps.**
1. **Census (1-2 days).** Re-run §2 per repo and per tool version; count independent tasks (distinct audit run / PR); count findings with a reconstructable diff (`audited_sha` resolves in git). Output: an eligible-set table with exclusion reasons.
2. **Hand-checked label sample (≈1 weekend of Louis time, *expected* 4-6 h).** ~250 findings, stratified by disposition (fix-now, dismissed, null `user_action`, fixed-before-adjudication), severity, repo (CES, wine, AIO; **not storyline**). Labels: actionable / non-actionable+reason / indeterminate (excluded from hard labels). Double-label a 40-item subset after a gap to report self-agreement.
3. **Baselines through the model-eval harness** (reuse its execution, cost accounting and blinding; add an explicit *classifier* task contract and the independent label set — the harness's oracle matching is a same-role replacement screen, not a safety check). Arms: *dismiss-nothing*, existing Stage-1 triage, prompted Haiku, Flash, GPT-mini (zero-shot), and **retrieval few-shot** (5-10 nearest labelled cases, tenant-isolated per repo). Inputs limited to what existed at decision time (finding + diff + file context; no later patch, no adjudicator explanation).
4. **LoRA only if gated.** A 7-14B LoRA runs only if the best prompted arm misses the keep/kill rule on quality, cost *or* latency **and** there are enough independent examples (*expected* ≥ ~1,500 independent-task-grouped labels). Local GPU only (D1).
5. **Splits.** Group by audit run/PR (no group in two splits); forward-in-time test (last ~3 weeks held out); held-out repo report with each repo reported separately, never one average.

**Pre-registered keep/kill (fix before looking at test data).**
- *Primary safety metric*: upper confidence bound (95%, Wilson/Clopper-Pearson) of the rate of **actionable findings predicted dismissible**, among high/medium severity, must be ≤ **5%** (placeholder; Louis sets the final tolerance, D3).
- *Coverage*: ≥ **30%** of findings routed as dismissible at that bound (otherwise no spend saving).
- *Net cost*: (reviewer tokens avoided) − (inference + hosting + maintenance) > 0, in measured $ per 100 findings.
- *Availability*: truncation/timeout/fallback counted as an unmeasured outcome, never a pass (the tiered-pipeline lesson).
- **Sparse evidence = "not demonstrated safe", not "passed".**
- **Kill** on any of: bound > tolerance in any severity stratum, coverage < threshold, net cost ≤ 0, or forward-in-time degradation > 10 points vs random-split.
- **Skip-the-fine-tune rule**: if any prompted arm meets keep, stop; record the verdict in `docs/research/`; no LoRA.

**Rollout if kept.** Shadow mode inside the tiered pipeline's Stage 1 (observation only, never gates) for a pre-declared window, then validated low-risk strata only. Follow the repo's "synchronous, not a background window" rule for model evaluations.

### 3.1 Labelling-weekend preparation (design only; not executed)

Prepared in advance so the weekend is pure labelling. **Nothing here runs until Louis says go.**

- **Sampling frame** (a read-only script, written when approved): findings with a reconstructable diff, `created_at` ≥ 2026-07-17, excluding `source_kind='LINTER'`; one row per `finding_fingerprint` (latest raise); tag each with repo, severity, pass, round, `user_action`, `adjudication_outcome`, `remediation_state`, `fix_commit_sha` presence.
- **Strata and quotas (~250 items)**: disposition (fix-now, dismissed, auto_dismissed, accepted-permanent, null-user_action-but-`remediation_state=fixed`, null-with-nothing) × repo (CES, wine, storyline, ai-organiser) × severity. Storyline is now in scope: give it a small quota (*expected* ~40) because its labelled share is zero today. Draw with a seed written down before sampling; stratify by audit run so no run supplies more than 3 items.
- **Worksheet** (rendered, not raw JSON): finding text, file, severity and the diff hunk(s) around `primary_file`; **no** adjudicator ruling, **no** later patch, **no** user_action. Fields: `actionable` (yes/no/indeterminate), `valid` (yes/no/indeterminate), reason code (wrong-premise, out-of-scope-for-diff, duplicate, style-only, already-handled, real-defect, needs-context), confidence 1-3, free note. Order randomised; stored labels held out until labelling ends.
- **Double-label**: a 40-item subset re-shown after the first pass; report Cohen's kappa.
- **Time box**: ~5 h *expected* for ~290 label events; a 15-item pilot first to calibrate reason codes and timing.
- **Outputs**: labelled rows in the store (`h1_label_sample`, `training_eligible` inherited from the repo) and the eligible-set table from step 1.
- **Gate**: every sampled item's diff must be reconstructable, so the diff-persistence fix in §2.1 (or a one-off reconstruction check on the frame) comes first.

**Cost / effort (*expected*).** Census + sample prep: 2-3 engineer-days; Louis labelling 4-6 h; prompted baselines: ≈$15-40 of API spend (five arms × ~250 + 400 holdout items); LoRA branch if taken: local GPU hours, no API spend, +1 week. Calendar: 4 weeks to verdict, 6 with the LoRA branch.

## 4. H2 — learnable decisions (3-6 months)

"Learnable when" thresholds are *expected* sizes, to be revised against the census.

| Candidate | Target / label | Data needed (beyond today) | Learnable when | Note |
|---|---|---|---|---|
| **Audit convergence / round-cap risk** | remaining rounds; P(cap) at round *k* | per-round features already in `audit_runs` (`rounds`, `round_converged_after`, `diff_*`) | ≥ ~300 independent audits with all rounds, 2+ repos | First choice: label is clean, data exists. Output triggers *structural review*, never auto-stop. Use gradient boosting before any LLM. |
| **Gate-cost and lease duration** | queue time, expiry risk, gate minutes | event timing from `fleet_events` plus gate-run durations | ≥ ~500 gate runs | Learned *estimates* only; scheduler stays deterministic. |
| **Reviewer routing** | cheapest reviewer set that matches the full set's finding recall | **randomised** budget-capped comparisons (historical routing is confounded) | ≥ ~200 randomised paired runs | Needs a deliberate experiment, not log mining. |
| **Consumer sync-incident risk** | incident within N days of a sync | sync receipts + incident log joined | ≥ ~30 incidents | Rare event: calibrated warnings and retrieval, not a classifier. |
| **Chip success** | merged without rework; decomposed (execution failure / review rework / abandonment / revert) | the chip ledger of §6 (brief, PR, rounds, cost, rework) | ≥ ~150 chips with outcomes | Outcome is blind today; needs §6 capture first. |

**Cost / effort (*expected*).** Convergence + gate-cost: 1-2 weeks each (tabular, local); routing experiment: ≈$100-250 of reviewer spend across a randomised window; chip success: blocked on §6, then 1 week.

## 5. H3 — coordinator decision support (6-12 months)

**Framing: the dataset is the durable asset, the model disposable — adopted, with two amendments.** (a) Raw decisions also go stale, so every record carries `policy_version` and `tool_sha` so obsolete behaviour can be filtered out. (b) The dataset is only durable if it is *joinable and permissioned*; a hoard with no outcomes or no consent is a liability.

**Order of work (each gated by the previous):**
1. **Retrieval of similar past decisions** (state → nearest past decisions + outcomes), surfaced to the coordinator at decision time. No training. *Learnable when*: ≥ ~300 decision records with outcomes across ≥ 2 repos.
2. **Prompted critic**: a frontier model scores a proposed action against retrieved precedents and current rules. *Learnable when*: ≥ ~300 override/correction pairs with the original proposal preserved.
3. **Trained ranker/critic (7-14B, local)** — only if held-out evaluation shows it beats step 2 by a pre-registered margin. *Learnable when*: ≥ ~1,500 preference pairs spanning ≥ 3 policy versions.
4. **No fine-tuned coordinator**: rules change weekly, frontier models improve every few months, so it would be stale before it is trusted (see §7).

**Preference data caveat.** A correction is a preference pair only if the *proposal*, the *revision* and the *context* are all kept; "keep it simple" may reflect new information or taste, not a better action. Classify each correction (`safety` | `scope` | `style` | `new-info`) and use only the first two for ranking.

**Cost / effort (*expected*).** Retrieval: 1-2 weeks; prompted critic: 1 week + ≈$20-60/month at the coordinator's call volume; trained critic: 2-3 weeks plus local GPU hours.

## 6. Telemetry to collect now

### 6.1 Principle: reconcile with counts-not-content

Fleet telemetry stays exactly as it is. The **decision ledger is a separate surface** with its own consent model, so the "counts, not content" invariant never has to bend:

| | Fleet telemetry (today) | Decision ledger (new) |
|---|---|---|
| Content | none: counts, closed vocabularies | bounded text (proposals, options, corrections) |
| Table | `fleet_events` | new `own_model_*` tables (names tentative) |
| Gate | always on | **default-deny**: a row is trainable only when `training_eligible` is true |
| Writer | fleet spool → `cross-skill.mjs fleet-telemetry flush` | `cross-skill.mjs` verbs only (no hand-written inserts) |
| Retention | rolling | explicit, per class (§6.5) |

Content lives in the store row itself (bounded, secret-redacted via the existing classifier), **not** in hash-only rows plus local files: hashes are join aids, not anonymisation, and a local JSONL does not remove the rights question. Local files remain acceptable as a *spill* during store outage.

### 6.2 Join keys

- `task_id` (UUID v7): minted when a brief/chip is created; carried in the brief text, the PR body footer, the branch trailer and every ledger row. **Survives account switches** because it is in git and the store, not in a chat.
- `decision_id` (UUID v7), `parent_decision_id`.
- `session_ref`: the account-specific session id, stored as a secondary pointer only.
- Existing keys reused, not replaced: `audit_runs.id`, `audited_sha`/`audited_tree`, PR number, `ship_events` row, `fleet_events` id, AI-Run-ID trailer.

### 6.3 Event shapes

```text
task            task_id, repo, kind(chip|audit|sync|merge|plan), brief_ref, brief_text(bounded),
                coordinator(CES|WCA|STO|AIO), created_at, sensitivity, training_eligible
decision        decision_id, task_id, parent_decision_id?, at, actor(coordinator|louis|chip),
                decider_model, policy_version, tool_sha,
                state_summary(bounded text + refs: sha, PR, lease ids, budget, active directives),
                options[{id, label, summary}], chosen_option_id, rationale?(optional, short),
                override_of?(decision_id), sensitivity, training_eligible
correction      correction_id, decision_id(the one corrected), proposal_text, revision_text,
                class(safety|scope|style|new-info), source(chat|approval|button),
                training_eligible
outcome         outcome_id, task_id|decision_id, kind(merged|reverted|reworked|abandoned|ci-red|
                incident|converged|cap-hit), at, observation_window_days, ref(PR|sha|run id)
usage           task_id|decision_id, provider, model, input_tokens, output_tokens, cost_usd, latency_ms
```

An **absent outcome means unknown, never success**. Outcomes are appended (revert window checked at +7 days by a sweep).

### 6.4 Capture points (each becomes a fleet proposal, theme `own-model-telemetry`)

| # | Capture point | Records | Privacy class | Repos in scope |
|---|---|---|---|---|
| 1 | **Ledger store + `cross-skill.mjs` verbs** (tables, schema, `decision`/`correction`/`outcome` writers, redaction, default-deny) | foundation | class P (see §6.5) | all writers; export gated |
| 2 | **Chip launch**: mint `task_id`, write `task`, embed id in brief and branch | `task` | C1/C2 | CES, WCA (STO/AIO ledger-only, not exportable) |
| 3 | **Chip wrap-up**: PR number, rounds, cost, rework flag | `outcome`, `usage` | C1 | same |
| 4 | **ship-commit / `/ship`**: AI-* trailer carries `task_id`; merge writes `outcome(merged)`; revert sweep | `outcome` | C1 | same |
| 5 | **Fleet verbs** (`claim`, `land`, `ready`, `restack`): attach `task_id` to the fleet event, add decision record on WAIT/refusal where the coordinator chooses | `decision` | C1 | same |
| 6 | **Coordinator handover**: at every account switch the coordinator writes its open decisions + pending outcomes so the chain does not die with the chat | `decision` (snapshot), `task` | C2 | same |
| 7 | **Correction capture**: when Louis overrides or corrects, one command records `{proposal, revision, class}` from the preceding turn; default passive (diff of proposed vs executed), no mandatory rationale | `correction` | C3 | same |
| 8 | **Audit-store linkage**: add `task_id` to the `audit_runs` row, expose finding → decision join | join | C1 | all audited repos |
| 9 | **Cost-per-task rollup**: join `usage` + `audit_runs.total_cost_estimate` + chip cost by `task_id` | derived view | C1 | all |
| 10 | **Purge/forget path**: delete by `task_id`, and a repo-level hard stop | governance | — | all |

### 6.5 Privacy classes and repo scope

| Class | Fields | Rule |
|---|---|---|
| **C1 structural** | ids, timestamps, counts, shas, PR numbers, closed-vocabulary labels, costs | Always captured; not training data by itself. |
| **C2 operational text** | brief, state summary, option labels, proposal text | Captured for CES/WCA with `training_eligible=true` only after the redaction classifier passes; STO and AIO captured as C1 only. |
| **C3 human feedback** | Louis's corrections, free-text rationale | Louis is the author; captured for CES/WCA; stored with `class`; excluded from provider APIs by default. |
| **P prohibited** | secrets, vault note content, work-repo content | Refused at write (existing secret classifier), never exportable. |

| Repo | Ledger capture | Training / export | Horizon |
|---|---|---|---|
| CES (public) | C1 + C2 + C3 | eligible after licence/secret check (public ≠ rights-cleared) | H1 yes |
| WCA / wine (private, owned) | C1 + C2 + C3 | eligible with Louis's explicit sign-off + redaction check (third-party material, secrets) | H1 optional, H2 yes |
| STO / storyline (work, Wärtsilä, Azure store) | C1 + C2 + C3, **Louis approved 2026-10-25**; flag stored per repo, revocable; stays on the Azure store | approved by Louis; **runs only on hosts inside the tenant boundary** until the work-repo terms question (§0.1) is checked | H1 sample quota; H2 |
| AIO / ai-organiser (Obsidian vault) | C1 + C2 + C3 for repo code and audit data, **Louis approved 2026-10-25**; **vault note content stays prohibited (class P)**: it is not repo data | eligible for audit/decision data, never vault notes | H1; H2 |

Enforcement is **default-deny by provenance**: eligibility is a stored flag decided at write time by repo + class, checked again at export. A repo-name `if` alone is not the control; an export that cannot prove eligibility refuses.

### 6.6 Where training may run

- **Local GPU (preferred)**: no third-party disclosure; does not create rights, so the eligibility rules above still apply. Cost is hardware time, not zero. Hardware inventory is open (D1).
- **Provider fine-tuning API / rented GPU**: only after reading the exact service's *current* retention, training-use, deletion and residency terms (they change; do not rely on this memo). Louis approved all four repos for the corpus; the remaining constraint is the host boundary: CES-public may go to any host passing the terms check, wine and ai-organiser need the same check, **storyline stays inside the tenant** until Wärtsilä's terms are confirmed.
- **Never** pool first and sort out consent later; eligibility travels with each record through every export and derivative model.

### 6.7 Minimal first slice (smallest thing that preserves data)

Do the **H1 gap fixes in §2.1 first** (diff persistence and non-null `audited_sha`, `adjudicator_kind`, `dismiss_reason`, `fix_commit_sha` / fixed-before-adjudication, Stage-1 prediction, `audit_repos.training_eligible`), then capture points 1, 2, 3, 6 and 7 (≈ 1-2 weeks, *expected*): they cover the data that is lost today (decisions in chat, corrections, chip outcomes, handover). Points 4, 5, 8, 9 enrich joins; point 10 ships with 1.

### 6.8 Data-science collection checklist (data mining / ML lens)

Added 2026-10-25 at Louis's request: collect broadly **now**, because history cannot be re-observed. Each item names the failure it prevents. Capture is cheap; missing history is permanent.

| # | Principle | Collect | Prevents |
|---|---|---|---|
| 1 | **Append-only, event-time vs ingest-time** | Every label change is a new row with `event_at` and `ingested_at`; never overwrite. Today `audit_findings.user_action` is overwritten in place; `finding_adjudication_events` is append-only (good) and must become the source of truth for labels | Losing label history; cannot tell what was known when |
| 2 | **Point-in-time features** | Snapshot decision-time inputs (state summary, diff hash, prompt hash, retrieved precedents) at decision time, never re-derive later | Target leakage; training on information that did not exist at the decision |
| 3 | **Negatives and denominators** | Log what was *not* done: options not chosen, suppressed re-raises and auto-dismissals with reason, runs that found nothing, audits that skipped a pass, and the eligible population per decision | Survivorship bias; a model that never sees the cases the process filtered out |
| 4 | **Propensity and exploration** | For every routing/policy choice (reviewer, pass set, rounds, model) record the policy version, the probability or rule that selected it, and a `randomised` flag; reserve a small randomised share (H2 routing) | Confounded learning (hard diffs always get the expensive reviewer); no counterfactual |
| 5 | **Model and prompt provenance** | Per LLM call: resolved model id, route (native or OpenRouter), prompt-variant/hash, temperature, tokens in/out, cached tokens, truncation/retry/fallback flags, latency, cost | Mixing outputs of different models/prompts into one label distribution |
| 6 | **Code and policy versions** | `tool_sha`, AGENTS.md hash (`policy_version`), SKILL.md hashes, key config flags, on every decision and run | Rules change weekly: without versions, drift is indistinguishable from noise |
| 7 | **Outcome windows and censoring** | `outcome_observed_at` plus window (+1 d CI, +7 d revert, +30 d incident); an unobserved outcome is *censored*, never success | Survival-analysis errors; false "merged cleanly" labels |
| 8 | **Human-in-the-loop timing** | When the question was asked, when Louis answered, which option, override direction, count of rework cycles, and whether the answer was the default | Latency/effort features; separating approvals from rubber-stamps |
| 9 | **Grouping and split keys** | `work_item_id`, `run_id`, PR number, `repo`, `split_date` on every row; `finding_fingerprint` for dedup | Group leakage across train/test; duplicate-inflated sample counts |
| 10 | **Embeddings with provenance** | Store embeddings of findings, briefs and decisions with model id, dimension and compose-template version | Retrieval (H3 step 1) that silently mixes vector spaces |
| 11 | **Schema and quality metadata** | `schema_version` and `redaction_version` per row; a weekly **null-rate and coverage report per column** (a capture-quality gate, drift-only, like the existing ratchets) | Silent gaps: `adjudicator_kind` was 97% null and nobody saw it |
| 12 | **Consent lineage** | `training_eligible`, who approved it, when, and which repo flag it derived from | A corpus that cannot prove it may be used |
| 13 | **Resource accounting** | Per chip/task: wall-clock, queue/wait time, token and money cost, gate minutes, lease time | Cost-per-task and scheduling models |
| 14 | **Free-text feedback as structured pairs** | Louis's corrections stored as (proposal, revision, class, context ref); chip briefs stored with their outcome | Preference learning; brief-quality prediction |

**Backfill-now actions (history that dies):**
- **Archive existing coordinator and chip transcripts** (the desktop app's `export_transcript`) into a durable, access-controlled store *before* the next account switch, tagged with repo, coordinator, date and `training_eligible`; they are the only record of historical decisions and Louis's corrections. Mining them into decision rows is a later offline job.
- **Snapshot the current `learning_decisions`, `finding_adjudication_events` and `fleet_events`** counts and null-rates as the dated baseline for the coverage report.
- **Back-populate where the data still exists in git**: `audited_sha`/diffs for runs whose commits are reachable, `fix_commit_sha` via the remediation sweep.

## 7. What NOT to build

- **A fine-tuned coordinator/agent.** Rules change weekly, frontier models improve quarterly; it is stale before it is trusted.
- **Automatic dismissal or auto-stop from any predictor** before shadow evidence and a validated stratum.
- **Transcript hoarding** or any LLM-chat-log scraper; capture decision records at action boundaries, not conversations.
- **Content in `fleet_events`** or any weakening of counts-not-content.
- **A mandatory rationale prompt** on overrides.
- **ML for lease scheduling**; learned duration estimates feeding a deterministic scheduler is the limit.
- **Mining historical reviewer routing** for a "cheaper equivalent" claim; only randomised comparisons.
- **A graph/vector memory for decisions** beyond what `pgvector` already provides; retrieval first.
- **A model-eval harness fork**; reuse it with an explicit classifier contract.
- **Vault note content** from ai-organiser in any corpus (repo and audit data are approved; the vault is not repo data).

## 8. Cost and effort summary (all *expected*)

| Horizon | Engineering | Louis time | Spend | Calendar |
|---|---|---|---|---|
| Telemetry slice (§6.7) | 1-2 wk | review of schema, 1 h | ≈$0 | weeks 1-2 |
| H1 experiment | 2-3 d prep + 1-2 wk run | 4-6 h labelling | $15-40 API; +local GPU if LoRA | verdict by week 4-6 |
| H2 | 3-5 wk across candidates | routing-experiment oversight | $100-250 routing experiment | months 3-6 |
| H3 | 4-6 wk (retrieval → critic → optional ranker) | ongoing corrections | $20-60/month critic; local GPU for ranker | months 6-12 |

## 9. Decisions only Louis can make

- **D1. Local GPU: resolved 2026-10-25** (§0.2): the RX 6600 XT (8 GB) suffices for H1 prompted baselines and small inference, not for 7-14B LoRA. Open: buy now or wait for the H1 verdict (recommended: wait).
- **D2. Storyline: resolved 2026-10-25**, approved for training and Azure retrieval. Residual check: confirm Wärtsilä's terms permit non-tenant training hosts, otherwise train in-tenant only.
- **D3. H1 go/no-go and tolerance.** Approve the census + 250-item labelling weekend, and set the maximum tolerated rate of wrongly suppressed actionable findings (placeholder 5%).
- **D4.** Which of wine's content may enter an eligible corpus (and whether wine needs a separate sign-off).

## 10. References

Brainstorm insights are local (`.brainstorm/`, gitignored). Inputs: [fleet-telemetry.md](../plans/fleet-telemetry.md), [model-eval-harness.md](../runbooks/model-eval-harness.md), [cross-skill-data-loop.md](../reference/cross-skill-data-loop.md), [tiered-recall-audit-pipeline.md](../plans/tiered-recall-audit-pipeline.md).
