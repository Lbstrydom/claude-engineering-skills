# Arm-eval session b3dbbdcb-d127-4ddc-914c-392fc5db87fa

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-ad19cafe` |
| Seed (presentation-order RNG) | 894528922 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-04T20:18:29.507Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

Design a cost-ordered, phased experimental methodology to get credible cheap initial traction on what is the most cost-effective high-quality code-quality auditing setup — apparatus (GPT+Gemini multi-round) vs single-shot and iterated single-model solo (Sonnet-5, Fable-5). Minimize LLM spend + human adjudication; each phase gates the next. Phases: ledger decomposition (free kill-criterion), git-history defect harvest (free real ground truth), same-model-x3 solo arm, proof-protocol blind adjudication, precision-first coarse-routing decision.

## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

## Overview

Implement a lightweight, documentation-first experimental protocol for cheaply comparing code-quality auditing setups:

- **Apparatus arm:** GPT + Gemini multi-round review protocol.
- **Solo arms:** single-shot and iterated single-model approaches for Sonnet-5 and Fable-5.
- **Cheap gating:** each phase must justify the next phase before any material LLM or human-adjudication spend.
- **Ground truth:** use repository git history to harvest real previously-fixed defects before paying for model evaluations.
- **Evaluation priority:** optimize for **high-confidence precision-first routing**, not broad benchmark completeness.

This should be implemented as a repo-local experiment runbook plus small, auditable templates. No LLM-calling automation should be added initially: the task is methodological, and the lowest-risk credible implementation is a reproducible protocol that can be executed manually or semi-manually before deciding whether automation is worth the spend.

## Design Decisions

### 1. Documentation-first, not automation-first

**Decision:** Create a protocol document and ledger templates under `docs/experiments/`.

**Rationale:**  
The task is to design a cost-ordered methodology, not to build a benchmark harness. Automation would add cost, maintenance burden, and architectural surface area before the kill criteria prove the experiment is worth running. Manual execution with strict ledgers is sufficient for initial traction.

### 2. Use phased gates with explicit stop conditions

**Decision:** Each phase will have an input, action, output, cost ceiling, and kill/continue criterion.

**Rationale:**  
The experiment’s central requirement is minimizing LLM spend and human adjudication. Gates prevent spending on expensive model runs when earlier free checks show the comparison cannot produce credible signal.

### 3. Prefer real historical defects over synthetic examples

**Decision:** The protocol will define a git-history defect-harvest phase that extracts fixed defects from repository commits and reconstructs pre-fix snapshots or hunks.

**Rationale:**  
Real defects provide cheap ground truth and avoid synthetic benchmark bias. Historical fixes give concrete evidence of defect existence, expected behavior, and remediation.

### 4. Ledger decomposition as a free kill criterion

**Decision:** Start by decomposing the experiment into a ledger of candidate audit tasks, expected defect classes, evidence requirements, and adjudication burden.

**Rationale:**  
If the candidate corpus is too small, too ambiguous, or too expensive to adjudicate, the experiment should stop before any model calls.

### 5. Same-model-x3 before multi-model apparatus

**Decision:** The first paid LLM phase should run the same single-model solo prompt three times on a tiny seed set.

**Rationale:**  
This detects variance and prompt fragility cheaply. If a solo model is unstable or has low precision on known defects, expensive apparatus comparison is premature. It also establishes whether iteration within one model provides most of the value.

### 6. Blind adjudication only after proof protocol is satisfied

**Decision:** Human adjudication should be blind to model/arm identity and only performed on normalized finding packets containing claim, evidence, affected path, severity, and proposed fix.

**Rationale:**  
Blind adjudication reduces confirmation bias and makes solo-vs-apparatus comparisons credible. Normalized packets also reduce adjudication time and make precision estimates comparable.

### 7. Precision-first coarse routing, not full ranking

**Decision:** The final decision should classify arms into coarse routing buckets:

- **Use now for high-confidence findings**
- **Use only as secondary reviewer**
- **Do not use yet**
- **Needs another cheap phase**

**Rationale:**  
The requested goal is cheap initial traction on the most cost-effective high-quality setup. A coarse precision-first routing decision is cheaper and more useful than trying to produce definitive leaderboard-style rankings.

### 8. Keep artifacts repo-safe and non-secret

**Decision:** Templates must avoid storing API keys, raw proprietary prompts with secrets, or external model credentials. Outputs should store model names/configuration, timestamps, prompt version IDs, and costs, but not credentials.

**Rationale:**  
The repository should remain safe to commit. Persistence must be durable enough to reproduce decisions while avoiding accidental credential leakage.

### 9. Use stable evidence IDs

**Decision:** Defect cases and model findings should receive stable IDs, e.g.:

- `CASE-YYYYMMDD-NNN`
- `RUN-<arm>-<case>-<replicate>`
- `FIND-<run>-NNN`

**Rationale:**  
Stable IDs make blind adjudication, cost accounting, and later automation possible without changing the experiment structure.

### 10. Avoid changing architectural code paths

**Decision:** Add files only under `docs/experiments/`.

**Rationale:**  
The repository’s architecture map has a high drift score. Adding scripts or shared libraries would increase architectural churn. A docs-only implementation respects current boundaries and avoids dependency questions.

## Target Paths

- `docs/experiments/code-quality-audit-cost-effectiveness-methodology.md`
- `docs/experiments/templates/ledger-decomposition.csv`
- `docs/experiments/templates/git-history-defect-harvest.csv`
- `docs/experiments/templates/model-run-ledger.csv`
- `docs/experiments/templates/blind-adjudication.csv`
- `docs/experiments/templates/routing-decision.md`

## File-Level Plan

### Create: `docs/experiments/code-quality-audit-cost-effectiveness-methodology.md`

Purpose: Primary runbook for the phased experimental methodology.

Content outline:

1. **Experiment objective**
   - Compare cost-effectiveness of GPT+Gemini multi-round apparatus against:
     - single-shot Sonnet-5
     - iterated Sonnet-5
     - single-shot Fable-5
     - iterated Fable-5
   - Emphasize high-quality code-quality auditing, not generic coding performance.

2. **Definitions**
   - “Finding”
   - “True positive”
   - “Actionable”
   - “High-confidence”
   - “Ground-truth defect”
   - “Apparatus”
   - “Solo single-shot”
   - “Solo iterated”
   - “Same-model-x3”
   - “Blind adjudication”

3. **Experimental arms**
   - Arm A: GPT+Gemini multi-round apparatus.
   - Arm B: Sonnet-5 single-shot solo.
   - Arm C: Sonnet-5 iterated solo.
   - Arm D: Fable-5 single-shot solo.
   - Arm E: Fable-5 iterated solo.
   - Arm F: Fable-5 same-model-x3 or Sonnet-5 same-model-x3 seed arm, depending on cost and availability.

4. **Cost-ordering principle**
   - Free phases first.
   - Tiny paid seed before larger paid evaluation.
   - Human adjudication only after normalized proof packets exist.
   - Stop whenever precision or corpus quality is insufficient.

5. **Phase 0 — Ledger decomposition**
   - Inputs:
     - Candidate repositories/modules.
     - Defect classes.
     - Candidate audit prompts.
     - Expected adjudication evidence.
   - Output:
     - Completed `ledger-decomposition.csv`.
   - Free kill criteria:
     - Fewer than a minimum number of candidate historical cases.
     - Defect categories cannot be judged from available evidence.
     - Expected adjudication requires domain experts unavailable for cheap review.
     - Candidate tasks are too broad for comparable prompts.
   - Continue criterion:
     - There is a small but credible seed corpus, e.g. 10–20 candidate historical defects, with at least 5 high-confidence cases.

6. **Phase 1 — Git-history defect harvest**
   - Inputs:
     - Git log.
     - Fix commits.
     - Bug-related commits.
     - Regression tests added with fixes.
   - Harvest rules:
     - Prefer commits with explicit bug/fix language.
     - Prefer commits with tests, assertions, or clear before/after behavior.
     - Exclude cosmetic refactors, pure style changes, generated files, dependency bumps, and ambiguous rewrites.
   - Output:
     - Completed `git-history-defect-harvest.csv`.
   - Ground-truth classification:
     - `confirmed`: clear defect and clear fix evidence.
     - `probable`: likely defect but incomplete evidence.
     - `discard`: insufficient or ambiguous.
   - Free kill criteria:
     - Fewer than 5 confirmed defects.
     - Most cases require large context reconstruction.
     - Fixes are too entangled to isolate.
   - Continue criterion:
     - At least 5 confirmed defects and at least 5 additional probable cases, or an explicitly justified smaller pilot.

7. **Phase 2 — Same-model-x3 solo seed**
   - Inputs:
     - Tiny confirmed-defect sample.
     - One standardized solo prompt.
     - Same pre-fix code context for each replicate.
   - Method:
     - Run the same model three independent times per case.
     - Randomize output IDs.
     - Do not adjudicate with model identity visible.
   - Metrics:
     - Finding repeatability.
     - Exact or near-exact defect hit rate.
     - False-positive volume.
     - Cost per actionable finding.
   - Kill criteria:
     - Severe variance across three runs.
     - High false-positive rate.
     - Findings are not evidence-backed enough for blind adjudication.
   - Continue criterion:
     - At least one solo configuration produces consistently adjudicable, evidence-backed findings.

8. **Phase 3 — Proof-protocol blind adjudication**
   - Inputs:
     - Normalized model findings.
     - Historical ground-truth records.
     - Blind adjudication sheet.
   - Required proof packet for each finding:
     - Claim.
     - Affected file/path.
     - Evidence snippet or reasoning trace suitable for human review.
     - Expected failure mode.
     - Suggested fix or mitigation.
     - Confidence.
   - Adjudication labels:
     - `TP-ground-truth`
     - `TP-new-plausible`
     - `FP`
     - `unclear`
     - `duplicate`
     - `not-actionable`
   - Human-cost minimization:
     - Batch duplicates.
     - Prioritize high-confidence findings first.
     - Stop adjudicating an arm after a configured false-positive ceiling.
   - Continue criterion:
     - Enough adjudicated findings exist to make a coarse routing decision.

9. **Phase 4 — Apparatus comparison only if justified**
   - Inputs:
     - Cases that passed previous phases.
     - Same normalized proof-packet format.
   - Compare apparatus against the strongest solo baseline.
   - Measure:
     - Incremental true positives.
     - Incremental high-severity true positives.
     - False positives added.
     - Cost multiplier.
     - Human adjudication multiplier.
   - Kill criteria:
     - Apparatus adds mostly duplicates or low-value findings.
     - Apparatus cost multiplier is not justified by additional confirmed high-quality findings.
   - Continue criterion:
     - Apparatus materially improves precision or finds important defects missed by solo arms.

10. **Phase 5 — Precision-first coarse routing decision**
    - Output:
      - Completed `routing-decision.md`.
    - Decision buckets:
      - Default route for cheap solo audit.
      - Escalation route to apparatus.
      - Never-use or hold route.
      - More-data-needed route.
    - Minimum decision evidence:
      - Cost per adjudicated finding.
      - Cost per true positive.
      - Precision estimate.
      - Duplicate rate.
      - Human review minutes per useful finding.
      - Qualitative failure modes.

11. **Metrics**
    - LLM spend per arm.
    - Prompt tokens and completion tokens where available.
    - Human minutes.
    - Findings per case.
    - True positives.
    - False positives.
    - Duplicates.
    - Unclear findings.
    - Precision.
    - Cost per true positive.
    - Cost per high-confidence actionable finding.
    - Incremental value over baseline.

12. **Data handling and safety**
    - No API keys in ledgers.
    - No secret-bearing source snippets in committed artifacts.
    - Prefer commit SHAs and file paths over full copied source where possible.
    - If source snippets are necessary, keep them minimal and verify they are safe to commit.
    - Mark external/private data as non-committable.

13. **Reproducibility**
    - Record:
      - repository commit under audit,
      - model name,
      - model version/date if available,
      - prompt version,
      - temperature/settings,
      - case ID,
      - run timestamp,
      - total cost estimate,
      - adjudicator ID or initials if acceptable.

14. **Recommended first pilot**
    - Maximum:
      - 5 confirmed historical cases.
      - 1 same-model-x3 seed arm.
      - 1 strongest solo baseline.
      - Apparatus arm only if solo seed passes.
    - Explicit cost cap before expansion.

### Create: `docs/experiments/templates/ledger-decomposition.csv`

Purpose: Free pre-flight planning ledger.

Columns:

- `ledger_id`
- `candidate_area`
- `repo_or_module`
- `defect_class`
- `why_code_quality_relevant`
- `expected_evidence`
- `expected_adjudication_difficulty`
- `expected_context_size`
- `candidate_prompt_family`
- `risk_of_ambiguity`
- `estimated_human_minutes`
- `include_in_harvest`
- `exclusion_reason`

Rationale: This supports the free kill criterion before any model spend.

### Create: `docs/experiments/templates/git-history-defect-harvest.csv`

Purpose: Structured capture of real historical defects.

Columns:

- `case_id`
- `repo`
- `fix_commit_sha`
- `parent_commit_sha`
- `affected_paths`
- `defect_summary`
- `defect_class`
- `fix_evidence`
- `test_evidence`
- `pre_fix_reproduction_hint`
- `post_fix_expected_behavior`
- `ground_truth_status`
- `isolation_difficulty`
- `context_pack_size_estimate`
- `safe_to_use_in_prompt`
- `notes`

Rationale: This converts git history into an auditable ground-truth seed corpus.

### Create: `docs/experiments/templates/model-run-ledger.csv`

Purpose: Track model runs, prompts, costs, and outputs without storing secrets.

Columns:

- `run_id`
- `case_id`
- `arm_id`
- `model`
- `model_version_or_date`
- `prompt_version`
- `run_type`
- `replicate_number`
- `temperature`
- `input_context_ref`
- `output_artifact_ref`
- `input_tokens`
- `output_tokens`
- `estimated_cost_usd`
- `wall_clock_minutes`
- `operator`
- `run_timestamp_utc`
- `notes`

Rationale: Provides cost accounting and reproducibility across solo, iterated, same-model-x3, and apparatus arms.

### Create: `docs/experiments/templates/blind-adjudication.csv`

Purpose: Blind review sheet for normalized findings.

Columns:

- `blind_finding_id`
- `case_id`
- `finding_claim`
- `affected_path`
- `evidence_summary`
- `suggested_fix_summary`
- `claimed_severity`
- `claimed_confidence`
- `adjudication_label`
- `matches_ground_truth_case`
- `is_duplicate_of`
- `actionability`
- `severity_after_review`
- `human_minutes`
- `adjudicator`
- `review_notes`

Rationale: Keeps adjudication independent from arm/model identity and focuses review effort on evidence quality.

### Create: `docs/experiments/templates/routing-decision.md`

Purpose: Final decision template for precision-first coarse routing.

Content outline:

1. **Experiment metadata**
   - Date.
   - Repository/repositories.
   - Corpus size.
   - Arms compared.
   - Total LLM spend.
   - Total human minutes.

2. **Decision summary**
   - Recommended default audit route.
   - Recommended escalation route.
   - Arms to avoid.
   - Arms requiring more evidence.

3. **Arm comparison table**
   - Arm.
   - Cases run.
   - Findings.
   - True positives.
   - False positives.
   - Unclear.
   - Duplicates.
   - Precision.
   - Cost.
   - Human minutes.
   - Cost per true positive.
   - Notes.

4. **Precision-first routing rule**
   - When to use solo.
   - When to escalate to apparatus.
   - When to stop after single-shot.
   - When iteration is justified.

5. **Failure modes observed**
   - Hallucinated defects.
   - Over-broad architectural complaints.
   - Missed known defects.
   - Duplicate amplification.
   - Poor evidence quality.
   - Excessive context sensitivity.

6. **Next cheapest phase**
   - Expand corpus.
   - Add another model.
   - Add apparatus.
   - Stop and adopt current route.
   - Stop due to insufficient signal.

## Methodology Details

### Phase 0 — Ledger Decomposition

Goal: decide whether the experiment is worth running.

Procedure:

1. List candidate audit targets and defect classes.
2. Estimate how much context a reviewer/model needs.
3. Estimate whether a human can adjudicate the expected findings quickly.
4. Exclude cases that require deep domain knowledge, unavailable runtime systems, or large context reconstruction.
5. Stop if the remaining corpus is too weak.

Primary output: `ledger-decomposition.csv`.

Free kill criteria:

- Fewer than 5 plausible cases.
- No clear adjudication evidence.
- Most defects are subjective quality preferences rather than verifiable defects.
- Human review burden exceeds the intended cheap pilot budget.

### Phase 1 — Git-History Defect Harvest

Goal: build cheap real ground truth.

Procedure:

1. Search git history for commits with terms like:
   - `fix`
   - `bug`
   - `regression`
   - `incorrect`
   - `crash`
   - `security`
   - `validation`
   - `race`
   - `leak`
   - `edge case`
2. Prefer commits that add or update tests.
3. For each candidate, inspect parent and fix diff.
4. Record:
   - pre-fix behavior,
   - post-fix behavior,
   - affected files,
   - evidence quality,
   - isolation difficulty.
5. Mark cases as `confirmed`, `probable`, or `discard`.

Primary output: `git-history-defect-harvest.csv`.

Continue only if enough confirmed cases exist for a tiny pilot.

### Phase 2 — Same-Model-x3 Solo Arm

Goal: cheaply test solo variance before comparing apparatus.

Procedure:

1. Choose the cheapest credible solo model/configuration.
2. Select 3–5 confirmed cases.
3. Run the same prompt independently three times per case.
4. Normalize findings into proof packets.
5. Hide model/run identity before adjudication.

Signals to examine:

- Does the model repeatedly find the same true issue?
- Does it produce many plausible-sounding false positives?
- Are findings specific enough to adjudicate quickly?
- Is iteration likely to improve quality, or merely increase duplicate/false-positive volume?

Stop if the same-model arm cannot produce stable, evidence-backed findings.

### Phase 3 — Proof-Protocol Blind Adjudication

Goal: spend human review time only on evidence-backed findings.

Procedure:

1. Convert model outputs into normalized finding packets.
2. Remove arm/model identity.
3. Adjudicate high-confidence findings first.
4. Mark duplicates before doing full review.
5. Stop reviewing an arm if its false-positive volume exceeds the configured ceiling.

Adjudication labels:

- `TP-ground-truth`
- `TP-new-plausible`
- `FP`
- `unclear`
- `duplicate`
- `not-actionable`

Recommended precision-first metrics:

- `precision = true_positives / (true_positives + false_positives)`
- `actionable_precision = actionable_true_positives / adjudicated_non_duplicate_findings`
- `cost_per_tp = total_llm_cost / true_positives`
- `human_minutes_per_tp = total_human_minutes / true_positives`

### Phase 4 — Apparatus Arm

Goal: test whether GPT+Gemini multi-round review adds enough value over solo.

Run only if:

- The seed solo arm produces adjudicable findings.
- There is a confirmed ground-truth corpus.
- The expected apparatus cost is within a precommitted cap.

Compare apparatus to strongest solo baseline on:

- Incremental true positives.
- Incremental high-severity findings.
- Added false positives.
- Duplicate amplification.
- Human review burden.
- Cost multiplier.

Decision heuristic:

- Apparatus is justified only if it materially improves high-confidence actionable findings per dollar or catches high-severity issues the solo arm misses.
- If apparatus mostly rephrases solo findings or increases adjudication burden, route it only as an escalation path or do not use.

### Phase 5 — Precision-First Coarse Routing

Goal: make an initial practical decision, not a definitive benchmark claim.

Possible outcomes:

1. **Solo default**
   - One solo model has acceptable precision and low cost.
   - Apparatus does not add enough incremental value.

2. **Iterated solo default**
   - Iteration improves true positives without unacceptable false positives.

3. **Apparatus escalation**
   - Solo is cheap for first pass.
   - Apparatus is reserved for high-risk files, security-sensitive changes, or release gates.

4. **Apparatus default**
   - Only if it materially outperforms solo on high-severity true positives and cost remains acceptable.

5. **No adoption yet**
   - Corpus too weak, adjudication inconclusive, or all arms show poor precision.

## Failure Modes and Handling

### Weak ground truth

Risk: Historical fixes are ambiguous or too entangled.

Mitigation:

- Exclude ambiguous commits.
- Prefer test-backed fixes.
- Keep the pilot small but clean.

### False precision from tiny samples

Risk: Small corpus produces unstable conclusions.

Mitigation:

- Use coarse routing buckets, not definitive rankings.
- Record confidence level.
- Require another cheap phase before large rollout.

### Adjudicator bias

Risk: Human reviewers favor expected model/arm.

Mitigation:

- Blind arm identity.
- Normalize finding packets.
- Randomize adjudication order.

### Duplicate inflation

Risk: Iterated or multi-round arms produce many duplicates that look like more findings.

Mitigation:

- Deduplicate before calculating precision.
- Track duplicate rate as a negative cost signal.

### Hidden cost transfer to humans

Risk: A model seems cheap but produces high adjudication burden.

Mitigation:

- Track human minutes per useful finding.
- Stop adjudicating after false-positive ceiling.
- Include human time in routing decision.

### Prompt/context leakage between arms

Risk: Later arms benefit from knowledge of prior outputs.

Mitigation:

- Use fixed prompt versions.
- Keep arm runs isolated.
- Do not feed adjudication results into later arms during the same phase unless explicitly testing iteration.

### Secret or proprietary data exposure

Risk: Prompt packs accidentally include credentials or sensitive source snippets.

Mitigation:

- Redact secrets.
- Use commit refs and minimal snippets.
- Do not commit raw model transcripts if they contain sensitive material.
- Keep API credentials outside all experiment artifacts.

### Overfitting to one repository

Risk: The best setup for one codebase does not generalize.

Mitigation:

- State scope explicitly.
- Treat result as an initial routing rule.
- Expand only after cheap pilot success.

## Section 9 — Acceptance Criteria

1. `docs/experiments/code-quality-audit-cost-effectiveness-methodology.md` exists and describes all required phases: ledger decomposition, git-history defect harvest, same-model-x3 solo arm, proof-protocol blind adjudication, and precision-first coarse-routing decision.

2. The methodology explicitly compares GPT+Gemini multi-round apparatus against single-shot and iterated solo arms for Sonnet-5 and Fable-5.

3. The methodology defines phase gates with explicit continue and kill criteria before paid LLM calls and before human adjudication expansion.

4. The methodology includes a free ledger decomposition phase that can stop the experiment before any model spend.

5. The methodology includes a git-history defect-harvest phase using real historical fixes as ground truth.

6. The methodology includes a same-model-x3 solo seed phase to measure output variance before running the apparatus arm.

7. The methodology requires blind adjudication of normalized finding packets and hides model/arm identity from adjudicators.

8. The methodology prioritizes precision-first coarse routing over exhaustive benchmark ranking.

9. `docs/experiments/templates/ledger-decomposition.csv` exists with fields for candidate area, defect class, evidence expectations, adjudication difficulty, estimated human minutes, inclusion decision, and exclusion reason.

10. `docs/experiments/templates/git-history-defect-harvest.csv` exists with fields for fix commit, parent commit, affected paths, defect summary, evidence, ground-truth status, isolation difficulty, and safe-to-use status.

11. `docs/experiments/templates/model-run-ledger.csv` exists with fields for run ID, case ID, arm ID, model, prompt version, replicate number, token/cost tracking, output reference, and timestamp.

12. `docs/experiments/templates/blind-adjudication.csv` exists with fields for blind finding ID, case ID, claim, evidence, adjudication label, duplicate status, actionability, human minutes, and review notes.

13. `docs/experiments/templates/routing-decision.md` exists and provides a reusable decision template for choosing default, escalation, avoid, or more-data-needed routes.

14. The planned implementation does not add LLM API-calling code, new credentials, or persistence of secrets.

15. All new files are under `docs/experiments/`, preserving existing architecture boundaries and avoiding changes to runtime code.

### output-2

## Overview

The goal is to build a cost-ordered, phased experiment runner that systematically evaluates candidate code‑quality auditing setups (arms) to find the most cost‑effective high‑quality configuration. Arms compared include an existing GPT+Gemini multi‑round apparatus, plus single‑shot and iterated solo runs of Sonnet‑5 and Fable‑5. The experiment minimizes total LLM spend and human adjudication by gating each phase on cheap, early signals; if a kill‑criterion is not met, the arm (or the whole experiment) stops immediately, preventing wasted resources.

Phases:
1. **Ledger decomposition** (free kill‑criterion) – break down the repository’s requirements ledger into atomic checks; test each arm can produce a valid output against that ledger.
2. **Git‑history defect harvest** (free real ground truth) – extract real bug‑fix commits, construct a labelled dataset of known defects, and measure recall/precision on a small code sample.
3. **Same‑model×3 solo arm** – run each solo model three times on the same input to quantify consistency; used later as a supplementary quality signal, not a kill‑criterion on its own.
4. **Proof‑protocol blind adjudication** – blind‑adjudicate a cost‑limited sample of each arm’s novel claims with a cheap LLM (or human as fallback) to obtain unbiased precision estimates.
5. **Precision‑first coarse‑routing decision** – use the precision estimates and LLM‑cost per finding to select the single best arm for future production auditing, discarding all others.

Each phase gates the next; an arm that fails a kill‑criterion is dropped, and if all arms fail, the experiment terminates early.

The implementation extends the existing `audit-orchestration` domain, reusing symbols for running audits, storing findings, and (for phase 5) the existing bandit infrastructure.

---

## Design Decisions

1. **Home in `audit-orchestration` with new orchestration libraries**  
   The experiment runner logically belongs to the domain that already schedules and combines audit tools. We add a new library and a new entry‑point script, keeping the existing audit scripts as callable functions.

2. **Wrap existing audit scripts into callable modules**  
   `scripts/openai-audit.mjs`, `scripts/gemini-review.mjs`, and `scripts/cycle.mjs` are refactored to export a `runAudit(options)` function, while preserving their CLI behaviour. This enables the experiment runner to invoke them programmatically without forking new child processes.

3. **Ledger as an explicit JSON artefact**  
   The current architecture map lists “De‑facto invariants (requirements ledger — active)”. We create a machine‑readable `requirements-ledger.json` under `docs/` (or reuse an existing file if already present). Phase 0 decomposes it into a checklist of atomic assertions that every arm must be able to process (e.g. “detect violation of REQ‑security‑*”).

4. **Git‑defect harvest as a separate utility**  
   The extraction of real defects from git history is a self‑contained operation; placed in `scripts/lib/audit/git-defect-harvest.mjs` (audit‑orchestration can depend on tech‑debt). It yields a JSON dataset that later phases consume.

5. **Blind adjudication via cheap LLM first**  
   Human adjudication is minimised. Phase 4 uses a small, inexpensive model (e.g. GPT‑4o‑mini) as the blinded adjudicator. The system is configured with an optional human‑escalation path for cases where the model’s confidence is low, but the default uses only LLM spend.

6. **Config‑driven arms**  
   The arms under test (models, solo vs. multi‑round, etc.) are defined in a configuration file (e.g. `experiment-config.json`). The phases operate over this list, making it easy to add or remove candidates without changing code.

7. **Cost‑capped sampling at every phase**  
   Every phase that incurs LLM cost accepts a maximum‑spend parameter. The runner uses stratified random sampling (based on file size, change frequency, etc.) to keep cost predictable and low.

8. **Reuse existing `bandit.mjs` for routing**  
   Phase 5 directly calls the already‑existing bandit module to make a data‑driven arm selection, minimising new code.

---

## File‑level Plan

### Create

| File | Purpose |
|------|---------|
| `scripts/lib/audit/experiment-phases.mjs` | Core library implementing each phase’s logic: `decomposeLedger`, `harvestGitDefects`, `runArmMultipleTimes`, `blindAdjudicate`, `applyBanditRouting`. Depends on `shared-lib`, `findings`, `learning-store` (for bandit), and the wrapped audit functions. |
| `scripts/lib/audit/git-defect-harvest.mjs` | Utility that uses `git log -S` and `git show` to extract pre‑fix code snapshots for commits containing known bug‑keywords. Exports `harvestDefects(repoPath)` → `Array<{ commit, file, fixedCode, beforeCode }>`. |
| `scripts/audit-experiment.mjs` | CLI entry point. Reads a configuration file (path provided via `--config`), iterates through arms, calls phase functions in order, logs progress, and produces a final report. Uses `shared-lib` for argument parsing and logging. |
| `docs/requirements-ledger.json` | Machine‑readable version of the active requirements ledger. Each entry has an id, a natural‑language description, and an optional check‑function (for phase 0 smoke testing). |
| `docs/experiment-config.example.json` | Example configuration showing how to define arms, budgets, and phase thresholds. |

### Modify

| File | Change |
|------|--------|
| `scripts/openai-audit.mjs` | Refactor to export a `runOpenAIAudit(targetPath, options)` function; keep the existing CLI block under `if (require.main === module)`. |
| `scripts/gemini-review.mjs` | Same refactoring → export `runGeminiReview(targetPath, options)`. |
| `scripts/cycle.mjs` | If it orchestrates the multi‑round GPT+Gemini flow, export a `runCycleAudit(targetPath, options)` function; preserve CLI. |

No other existing files need modification.

---

## Risks

1. **Insufficient git‑history defects** – The repository may have few commits with clear bug fixes. Mitigation: if fewer than N defects are found, the runner falls back to a small manually‑curated set (included in the config) or aborts phase 1 with a warning and proceeds using only synthetic tests.

2. **Cheap LLM adjudicator inaccuracies** – A small model acting as blind adjudicator may mislabel true/false positives, skewing precision. Mitigation: pre‑pilot the adjudicator on a known sample and set a reliability threshold; if below threshold, escalate a random subset to human (but human cost is high, so the experiment may accept a slightly noisier metric to keep gate logical).

3. **Cost blow‑up from large codebases** – Even stratified sampling may become expensive if many files are audited. Mitigation: apply hard per‑phase cost caps, enforced by token counting and aborting sub‑runs.

4. **Refactoring existing audit scripts may break other consumers** – The `openai-audit.mjs` and `gemini-review.mjs` are currently CLI‑only. Other internal scripts might `fork` them. Mitigation: after refactoring, the CLI stays exactly the same; other internal consumers can be updated to require the module, or the fork path can be left intact (the module can also expose a `cliMain()` that the CLI script calls).

5. **Requirements ledger may not be machine‑parseable** – The current form is bullet‑point text in the architecture map comment. Creating a JSON ledger is manual; if not maintained, phase 0 may become stale. Mitigation: include a validation step that checks the JSON ledger matches the arch‑map invariants, and update instructions.

---

## Target Paths

- `scripts/lib/audit/experiment-phases.mjs`
- `scripts/lib/audit/git-defect-harvest.mjs`
- `scripts/audit-experiment.mjs`
- `docs/requirements-ledger.json`
- `docs/experiment-config.example.json`
- `scripts/openai-audit.mjs` (modify)
- `scripts/gemini-review.mjs` (modify)
- `scripts/cycle.mjs` (modify)

---

## Section 9 — Acceptance Criteria

1. **Phase gating works** – Running `scripts/audit-experiment.mjs` with a config that defines multiple arms stops the experiment as soon as all arms fail a phase’s kill‑criterion; the exit code and log reflect which phase halted it.
2. **Ledger decomposition (phase 0) is free** – The runner parses `docs/requirements-ledger.json` and checks that each arm can produce a non‑empty findings list without crashing; no LLM call costs are incurred if ledger parsing fails.
3. **Git‑defect harvest yields real data** – `scripts/lib/audit/git-defect-harvest.mjs` can be executed standalone; it prints a count of harvested defects and outputs a JSON file; the runner uses that file in phase 1.
4. **Recall threshold kills weak arms** – On a configurable recall threshold, arms that do not flag at least X% of known git‑history defects are dropped after phase 1.
5. **Same‑model×3 produces consistency metrics** – Phase 2 runs the arm three times and records per‑finding overlap metrics; these are stored alongside the arm’s findings and later shown in the final report.
6. **Blind adjudication is unbiased** – The adjudication prompt never includes the identity of the arm; findings are pooled and randomly shuffled. The adjudicator (LLM) receives only a code snippet and the claim text.
7. **Adjudication cost stays within budget** – The runner will not submit more adjudication requests than a configured `max_adjudication_calls` parameter, even if sampling would require more.
8. **Precision‑first routing selects a single winner** – After phase 4, the bandit module is invoked with precision estimates and cost‑per‑finding; the experiment outputs exactly one recommended arm for production use, or reports “no arm meets threshold” if all are rejected.
9. **Existing scripts remain fully functional** – After modification, `scripts/openai-audit.mjs`, `scripts/gemini-review.mjs`, and `scripts/cycle.mjs` can still be run directly from the command line as before, producing identical audit reports.

---

