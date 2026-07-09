# Arm-eval session cf409c86-3ccc-437e-8b10-9b0b128288e0

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-696d2de0` |
| Seed (presentation-order RNG) | 3091547109 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-09T16:47:05.370Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

Redesign the code-audit pipeline from a precision-gated single-pipeline model to a recall-weighted, cost-governed tiered pipeline: cheap discovery portfolio (GLM+Sonnet, GPT-5.5 demoted to triggered specialist/sentinel), deterministic Stage 0 triage, cheap-model Stage 1 triage with asymmetric dismissal authority, Gemini as adjudicator-only Stage 2, cost-per-accepted-HIGH governing metric, and a contrarian-stratified validation session to pick the Stage 1 model without circularity.

## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

# Implementation Plan — Recall-Weighted, Cost-Governed Tiered Audit Pipeline

## 1. Overview

Redesign the audit orchestration from a precision-gated single pipeline into a tiered pipeline optimized for HIGH-finding recall under explicit cost governance.

The new pipeline will:

1. Run a cheap discovery portfolio by default:
   - GLM discovery pass.
   - Sonnet discovery pass.
   - GPT-5.5 is no longer a default discovery model.

2. Introduce deterministic Stage 0 triage:
   - Normalize model outputs.
   - Validate finding schemas.
   - Deduplicate candidates.
   - Reject only objectively invalid candidates.

3. Introduce cheap-model Stage 1 triage:
   - Uses a selected cheap model chosen by a separate validation session.
   - Has asymmetric dismissal authority:
     - Can dismiss clearly low-value / invalid / non-HIGH candidates.
     - Cannot silently dismiss plausible HIGH / security / disagreement candidates.

4. Restrict Gemini to Stage 2 adjudication only:
   - Gemini is not a discovery model.
   - Gemini resolves escalated candidates, disagreement, sentinel samples, and high-risk dismissal attempts.

5. Govern optimization by cost per accepted HIGH:
   - Track model costs by stage and accepted HIGH outcomes.
   - Use `cost_per_accepted_high` as the primary cost metric.
   - Treat zero accepted HIGH as an explicit undefined/infinite-cost state, not as zero.

6. Add a contrarian-stratified validation session:
   - Selects the Stage 1 model without circularity.
   - Stratifies validation samples by source, disagreement, severity, domain, and contrarian cases.
   - Scores candidates using recall-weighted utility rather than precision-only gating.

The implementation should be incremental and right-sized: add new audit-orchestration modules, keep existing model invocation wrappers where possible, and preserve a rollback path to the prior pipeline during migration.

---

## Target Paths

- `scripts/lib/audit/tiered-policy.mjs`
- `scripts/lib/audit/stage0-triage.mjs`
- `scripts/lib/audit/audit-costs.mjs`
- `scripts/lib/audit/tiered-pipeline.mjs`
- `scripts/lib/audit/stage1-validation.mjs`
- `scripts/audit-tiered.mjs`
- `scripts/audit-validate-stage1.mjs`
- `scripts/cycle.mjs`
- `scripts/openai-audit.mjs`
- `scripts/gemini-review.mjs`
- `tests/audit-tiered-pipeline.test.mjs`
- `tests/audit-stage0-triage.test.mjs`
- `tests/audit-costs.test.mjs`
- `tests/audit-stage1-validation.test.mjs`
- `docs/audit-tiered-pipeline.md`

---

## 2. Design Decisions

### 2.1 Add a new tiered pipeline instead of rewriting every existing audit script

**Decision:** Implement the redesigned behavior in a new orchestration module, `scripts/lib/audit/tiered-pipeline.mjs`, and expose it through `scripts/audit-tiered.mjs`. Then wire `scripts/cycle.mjs` to use the tiered pipeline by default or behind an explicit migration flag, depending on current CLI compatibility requirements.

**Rationale:**

- Avoids a risky broad rewrite of existing audit entrypoints.
- Keeps existing model-specific scripts reusable.
- Makes the new pipeline testable in isolation.
- Enables rollback to the old precision-gated flow if cost or recall metrics regress.

---

### 2.2 Keep model routing policy declarative

**Decision:** Add `scripts/lib/audit/tiered-policy.mjs` containing stage roles, model aliases, default portfolio, escalation triggers, dismissal limits, sentinel sampling parameters, and cost-governance defaults.

**Rationale:**

- The task is primarily a policy/orchestration redesign, not a new model client implementation.
- A declarative policy module reduces coupling between audit control flow and model names.
- Future model substitutions should not require rewriting the pipeline.

Initial policy shape should include:

- `discoveryPortfolio`: GLM + Sonnet.
- `stage1CandidateModels`: cheap models eligible for validation.
- `stage1SelectedModel`: loaded from validation output or default conservative choice.
- `specialistModels`: GPT-5.5 as triggered specialist/sentinel only.
- `stage2Adjudicator`: Gemini only.
- `costCaps`: per-run and per-stage caps.
- `sentinelPolicy`: sampling rate and trigger reasons.
- `dismissalPolicy`: asymmetric rules.

---

### 2.3 Make Stage 0 deterministic and deliberately conservative

**Decision:** Stage 0 may reject only candidates that are objectively invalid. It must not make semantic vulnerability judgments.

Stage 0 can reject:

- Malformed model output that cannot be normalized.
- Missing required evidence/location fields.
- Nonexistent files or impossible line ranges.
- Duplicate candidates after stable fingerprinting.
- Findings explicitly outside the audit scope.
- Findings with no actionable claim after normalization.

Stage 0 must not reject solely because:

- The claim appears unlikely.
- The model rationale is weak but location and claim exist.
- Another model failed to find the issue.
- Severity is disputed.

**Rationale:**

- Stage 0 is intended to reduce waste without harming recall.
- Deterministic rejection criteria are auditable and testable.
- This avoids recreating the previous precision gate under another name.

---

### 2.4 Use asymmetric Stage 1 dismissal authority

**Decision:** Stage 1 cheap-model triage can cheaply dismiss low-risk candidates, but its dismissal power is constrained for plausible HIGH findings.

Stage 1 can final-dismiss candidates only when all are true:

- Stage 0 marked the candidate structurally valid.
- The candidate is not claimed as HIGH/CRITICAL by any discovery model.
- The candidate is not security-sensitive by deterministic tags.
- There is no cross-model disagreement requiring adjudication.
- Stage 1 returns a valid structured decision with sufficient confidence.
- The dismissal reason is one of the allowed low-risk reasons.

Stage 1 cannot final-dismiss and must escalate when:

- Any discovery source claimed HIGH/CRITICAL.
- Any deterministic keyword/category marks it as security-sensitive.
- GLM and Sonnet disagree materially.
- The candidate is contrarian, meaning only one model found it but the claim is potentially severe.
- The candidate is selected for sentinel review.
- Stage 1 output is malformed or low-confidence.

**Rationale:**

- Cheap models are useful for cost reduction but dangerous as final HIGH dismissers.
- Recall-weighted behavior requires preserving plausible HIGH candidates until stronger adjudication.
- This explicitly encodes the asymmetry requested by the task.

---

### 2.5 Restrict Gemini to Stage 2 adjudication

**Decision:** Gemini should only receive candidates that have already passed discovery and triage, or sentinel samples. It should not perform open-ended repository discovery in the new pipeline.

Gemini Stage 2 inputs should be candidate-centric:

- Normalized candidate.
- Source model claims.
- Relevant file snippets.
- Stage 0 facts.
- Stage 1 decision.
- Cost history for the candidate, if available.

Gemini Stage 2 outputs should be structured adjudications:

- `accept_high`
- `accept_non_high`
- `dismiss`
- `needs_human`
- confidence
- severity
- rationale
- required evidence references

**Rationale:**

- Keeps expensive adjudication targeted.
- Prevents Gemini from becoming another broad discovery model.
- Makes cost attribution per accepted HIGH meaningful.

---

### 2.6 Demote GPT-5.5 to triggered specialist/sentinel

**Decision:** GPT-5.5 is removed from the default discovery path. It is invoked only when a policy trigger fires.

Allowed triggers:

- Stage 2 requests specialist review for a high-impact ambiguous issue.
- Candidate falls into a configured specialist category.
- Sentinel sampling selects a candidate for false-negative monitoring.
- Discovery portfolio produces no HIGH candidates for a configurable number of runs and sentinel policy allows probing.
- Contrarian validation indicates a category where GPT-5.5 provides unique recall value worth the cost.

**Rationale:**

- Aligns spend with marginal value.
- Avoids defaulting to an expensive precision-gate model.
- Still preserves GPT-5.5’s utility for rare or high-risk cases.

---

### 2.7 Use cost per accepted HIGH as the governing metric

**Decision:** Add a small cost accounting module, `scripts/lib/audit/audit-costs.mjs`, used by the new pipeline and validation script.

The module should calculate:

- Total cost by run.
- Cost by stage.
- Cost by model.
- Number of accepted HIGH findings.
- `cost_per_accepted_high`.

Important correctness rule:

- If accepted HIGH count is zero, the metric must be represented as `null`, `Infinity`, or an explicit sentinel such as `{ defined: false }`.
- It must never be serialized as `0`.

**Rationale:**

- Zero accepted HIGH is not free success.
- This metric aligns optimization with the task’s desired recall/cost tradeoff.
- Centralizing cost math prevents inconsistent reporting.

---

### 2.8 Validation must avoid circularity

**Decision:** Implement Stage 1 model selection in `scripts/lib/audit/stage1-validation.mjs` and expose it via `scripts/audit-validate-stage1.mjs`.

The validation session must avoid using a candidate model’s own prior judgment as ground truth for evaluating that same model.

Validation labels may come from:

- Human-accepted findings.
- Existing accepted HIGH records that were adjudicated independently.
- Gemini adjudication where Gemini is not the model being evaluated.
- Consensus labels excluding the candidate Stage 1 model under evaluation.
- Previously fixed issues with commit evidence.

Validation labels must not come from:

- The same Stage 1 candidate model’s historical accept/dismiss decision.
- A previous precision gate if the same model dominated that gate.
- A dataset filtered only by the old pipeline’s accepted findings without contrarian supplementation.

**Rationale:**

- Prevents selecting a Stage 1 model because it agrees with itself.
- Contrarian stratification corrects for survivorship bias from historical accepted-only datasets.
- The new model choice should be based on recall under hard cases, not legacy precision alignment.

---

### 2.9 Persist append-only run artifacts safely

**Decision:** Store tiered run outputs as structured artifacts using existing persistence helpers if available. Use atomic writes for final summaries and append-only JSONL or equivalent for event traces.

Each run should persist:

- Run metadata.
- Policy snapshot.
- Discovery candidates.
- Stage 0 decisions.
- Stage 1 decisions.
- Stage 2 adjudications.
- Specialist/sentinel invocations.
- Cost summary.
- Accepted findings.

**Rationale:**

- Enables validation, cost analysis, and debugging.
- Policy snapshot makes historical runs reproducible.
- Append-only traces reduce risk of losing partial progress.

Persistence safety requirements:

- Never log API keys or raw environment variables.
- Truncate or redact oversized model responses in diagnostic logs.
- Validate JSON before persisting.
- Write final summaries atomically.

---

## 3. Data Contracts

### 3.1 `AuditCandidate`

Canonical normalized finding candidate emitted after discovery and Stage 0 normalization.

Required fields:

- `id`
- `fingerprint`
- `title`
- `description`
- `severityClaim`
- `sourceModel`
- `sourceStage`
- `locations`
- `evidence`
- `category`
- `rawSourceRef`
- `createdAt`

Optional fields:

- `cwe`
- `owasp`
- `confidence`
- `estimatedImpact`
- `affectedDomains`
- `contrarianFlags`

Correctness requirements:

- `fingerprint` must be stable across runs for the same substantive issue.
- Location paths must be repository-relative and normalized.
- No absolute local paths should be persisted unless already part of the existing contract.

---

### 3.2 `StageDecision`

Used by Stage 0, Stage 1, Stage 2, GPT-5.5 specialist, and sentinel checks.

Fields:

- `candidateId`
- `stage`
- `model`
- `action`
- `confidence`
- `severity`
- `rationale`
- `reasons`
- `cost`
- `createdAt`

Allowed `action` values:

- `pass`
- `dismiss`
- `escalate`
- `accept_high`
- `accept_non_high`
- `needs_human`
- `invalid`

Stage-specific restrictions:

- Stage 0 may use only deterministic `invalid`, `pass`, or duplicate-related decisions.
- Stage 1 may use `dismiss`, `pass`, or `escalate`, but final dismissal is policy-constrained.
- Stage 2 may use final adjudication actions.
- GPT-5.5 specialist output is advisory unless policy explicitly allows it to trigger Stage 2 or human review.

---

### 3.3 `CostSummary`

Fields:

- `runId`
- `totalCost`
- `costByStage`
- `costByModel`
- `acceptedHighCount`
- `costPerAcceptedHigh`
- `costPerAcceptedHighDefined`
- `budgetExceeded`
- `createdAt`

Correctness requirements:

- `acceptedHighCount === 0` implies `costPerAcceptedHighDefined === false`.
- Cost calculations must include discovery, Stage 1, Stage 2, specialist, and sentinel calls.
- Failed model calls with billable usage must be included if usage is reported.

---

## 4. Pipeline Flow

### 4.1 Discovery portfolio

1. Run GLM discovery.
2. Run Sonnet discovery.
3. Normalize model outputs into `AuditCandidate` records.
4. Attach source metadata and raw response references.
5. Do not run GPT-5.5 by default.
6. Do not run Gemini discovery.

Failure mode:

- If one cheap discovery model fails, continue with the other and record degraded coverage.
- If both discovery models fail, abort the audit run with a non-success status.

---

### 4.2 Stage 0 deterministic triage

For each candidate:

1. Validate required fields.
2. Normalize locations.
3. Check referenced files and line ranges.
4. Compute stable fingerprint.
5. Deduplicate across models.
6. Preserve source-model disagreement metadata.
7. Mark deterministic invalids.
8. Pass all structurally valid candidates to Stage 1.

Failure mode:

- Malformed candidate output is quarantined and reported.
- Duplicate candidates are merged, not discarded silently.
- Candidate merge must preserve all source models and severity claims.

---

### 4.3 Stage 1 cheap-model triage

For each Stage 0-passed candidate:

1. Build a minimal candidate-centric prompt.
2. Include relevant snippets, not entire repository context.
3. Invoke the selected Stage 1 cheap model.
4. Validate structured response.
5. Apply asymmetric dismissal rules.
6. Final-dismiss only allowed low-risk candidates.
7. Escalate plausible HIGH, disagreement, malformed, low-confidence, or sentinel-selected candidates.

Failure mode:

- Invalid Stage 1 output escalates rather than dismisses.
- Stage 1 timeout escalates unless the global cost cap requires pausing the run.
- Stage 1 model unavailable should fail over only if a configured validated alternate exists.

---

### 4.4 Specialist/sentinel GPT-5.5

GPT-5.5 may be invoked only when policy triggers fire.

Outputs are advisory and should result in one of:

- Escalate to Gemini Stage 2.
- Add specialist rationale to an already-escalated candidate.
- Mark sentinel sample as no-action with traceability.

Failure mode:

- GPT-5.5 failure must not block non-specialist candidates.
- GPT-5.5 cannot become an implicit final precision gate.

---

### 4.5 Gemini Stage 2 adjudication

For each escalated candidate:

1. Build candidate-centric adjudication request.
2. Include discovery claims and Stage 1 decision.
3. Include specialist/sentinel output if present.
4. Require structured Gemini response.
5. Accept HIGH only with evidence-backed adjudication.
6. Dismiss only with explicit reason and evidence contradiction or non-issue rationale.
7. Mark ambiguous outputs as `needs_human`.

Failure mode:

- Gemini malformed output becomes `needs_human`, not dismissal.
- Gemini unavailable leaves candidates in `pending_adjudication`.
- Cost cap exhaustion stops additional Stage 2 calls and records pending candidates.

---

### 4.6 Final reporting

The final report should include:

- Accepted HIGH findings.
- Accepted non-HIGH findings if current reporting supports them.
- Dismissed candidates by stage and reason.
- Pending adjudications.
- Needs-human candidates.
- Cost summary.
- `cost_per_accepted_high`.
- Recall-risk warnings, such as:
  - Both discovery models did not run.
  - Stage 2 skipped due to budget.
  - High number of Stage 1 escalations.
  - Validation output missing or stale.

---

## 5. File-Level Plan

### `scripts/lib/audit/tiered-policy.mjs` — create

Purpose:

- Centralize tiered pipeline policy.
- Define default model roles and escalation rules.
- Keep model names and thresholds out of orchestration code.

Planned contents:

- Model role constants.
- Default discovery portfolio: GLM + Sonnet.
- GPT-5.5 specialist/sentinel role.
- Gemini Stage 2 adjudicator role.
- Stage 1 selected-model loading policy.
- Cost cap defaults.
- Sentinel sampling defaults.
- Dismissal authority rules.
- Validation-result freshness checks.

Key exported functions:

- `loadTieredAuditPolicy(options)`
- `isStage1FinalDismissalAllowed(candidate, decision, policy)`
- `shouldEscalateToStage2(candidate, stage1Decision, policy)`
- `shouldTriggerSpecialist(candidate, context, policy)`
- `shouldRunSentinel(candidate, context, policy)`

---

### `scripts/lib/audit/stage0-triage.mjs` — create

Purpose:

- Implement deterministic candidate normalization and triage.

Planned contents:

- Candidate schema validation.
- Location normalization.
- Path existence checks.
- Line range validation.
- Stable fingerprinting.
- Deduplication and source merge logic.
- Deterministic rejection reason codes.

Key exported functions:

- `normalizeCandidate(rawCandidate, context)`
- `runStage0Triage(rawCandidates, context)`
- `computeCandidateFingerprint(candidate)`
- `mergeDuplicateCandidates(candidates)`
- `isDeterministicallyInvalid(candidate, context)`

Important behavior:

- Must preserve all source-model evidence during deduplication.
- Must not make semantic vulnerability judgments.
- Must produce auditable reason codes.

---

### `scripts/lib/audit/audit-costs.mjs` — create

Purpose:

- Provide cost accounting and cost-per-accepted-HIGH calculations.

Planned contents:

- Model cost event normalization.
- Aggregation by run/stage/model.
- Cost-per-accepted-HIGH calculation.
- Budget checks.
- Serialization-safe representation for undefined cost-per-HIGH.

Key exported functions:

- `recordCostEvent(context, event)`
- `summarizeAuditCosts(events, acceptedFindings)`
- `calculateCostPerAcceptedHigh(totalCost, acceptedHighCount)`
- `isBudgetExceeded(summary, policy)`
- `formatCostSummary(summary)`

Important behavior:

- Zero accepted HIGH must not serialize as cost-per-HIGH `0`.
- Billable failed calls must be counted if usage exists.
- Unknown usage must be explicit, not silently treated as free.

---

### `scripts/lib/audit/tiered-pipeline.mjs` — create

Purpose:

- Main orchestration for the new tiered audit pipeline.

Planned contents:

- Run initialization and policy snapshotting.
- Discovery portfolio orchestration.
- Stage 0 invocation.
- Stage 1 invocation.
- GPT-5.5 specialist/sentinel routing.
- Gemini Stage 2 adjudication routing.
- Cost governance.
- Final report assembly.
- Safe persistence of run artifacts.

Key exported functions:

- `runTieredAudit(options)`
- `runDiscoveryPortfolio(context)`
- `runStage1Triage(candidates, context)`
- `runStage2Adjudication(candidates, context)`
- `finalizeTieredAuditRun(context)`

Integration notes:

- Reuse existing model invocation utilities where possible.
- Do not duplicate provider client code.
- Preserve existing finding-report contracts where downstream scripts consume them.
- Keep provider-specific logic behind existing wrappers/adapters.

---

### `scripts/lib/audit/stage1-validation.mjs` — create

Purpose:

- Implement contrarian-stratified validation and Stage 1 model selection.

Planned contents:

- Historical artifact loading.
- Label-source validation.
- Circularity checks.
- Stratified sample construction.
- Contrarian bucket construction.
- Candidate Stage 1 model evaluation.
- Recall-weighted scoring.
- Cost-aware tie-breaking.
- Validation report generation.

Key exported functions:

- `buildContrarianStratifiedSample(options)`
- `validateLabelIndependence(sample, candidateModel)`
- `evaluateStage1Model(model, sample, options)`
- `scoreStage1Model(results, weights)`
- `selectStage1Model(validationResults, policy)`
- `writeStage1ValidationReport(report, options)`

Required strata:

- Source model: GLM, Sonnet, historical GPT, historical Gemini if available.
- Severity: HIGH/CRITICAL, MEDIUM, LOW.
- Outcome: accepted, dismissed, needs-human/pending.
- Disagreement: single-model-only, model disagreement, consensus.
- Domain/category: security, persistence, correctness, safety, other.
- Contrarian:
  - rejected-by-old-gate but later accepted,
  - found by only one model,
  - high-severity with weak rationale,
  - historically dismissed but similar issue later fixed,
  - expensive-model-only historical finds.

Scoring approach:

- Primary: HIGH recall.
- Secondary: false dismissal rate for plausible HIGH.
- Tertiary: escalation rate.
- Quaternary: cost per candidate and projected cost per accepted HIGH.

---

### `scripts/audit-tiered.mjs` — create

Purpose:

- CLI entrypoint for the new tiered audit pipeline.

Planned CLI options:

- `--budget`
- `--stage1-model`
- `--policy`
- `--output`
- `--json`
- `--dry-run`
- `--legacy-compatible-output`
- `--no-sentinel`
- `--max-stage2`
- `--fail-on-pending`
- `--run-id`

Behavior:

- Calls `runTieredAudit`.
- Prints concise run summary.
- Exits non-zero only for orchestration failures, invalid config, both discovery models failing, persistence failures, or explicit `--fail-on-pending` conditions.
- Does not treat “zero accepted HIGH” as process failure unless existing audit semantics require it.

---

### `scripts/audit-validate-stage1.mjs` — create

Purpose:

- CLI entrypoint for contrarian-stratified Stage 1 validation.

Planned CLI options:

- `--input`
- `--artifacts-dir`
- `--models`
- `--output`
- `--min-samples`
- `--seed`
- `--write-selection`
- `--no-write-selection`
- `--json`

Behavior:

- Builds validation sample.
- Checks label independence.
- Evaluates candidate models.
- Writes validation report.
- Optionally writes selected Stage 1 model configuration consumed by `tiered-policy.mjs`.

Safety:

- Default should not mutate selected model config unless `--write-selection` is provided.
- Must fail if labels are circular or insufficient.

---

### `scripts/cycle.mjs` — modify

Purpose:

- Integrate the new pipeline into existing audit cycles.

Planned changes:

- Add option to use tiered pipeline.
- Prefer tiered pipeline as default if this repository’s CLI compatibility allows it.
- Otherwise add `--tiered-audit` initially and document migration.
- Preserve old precision-gated pipeline behind `--legacy-audit` or equivalent rollback flag.
- Ensure cycle summaries include cost-per-accepted-HIGH.

Risk control:

- Do not remove old code path in the same change unless test coverage proves no compatibility break.

---

### `scripts/openai-audit.mjs` — modify

Purpose:

- Prevent GPT-5.5/OpenAI audit behavior from remaining an implicit default discovery path.

Planned changes:

- Expose or preserve callable specialist mode for GPT-5.5.
- Add metadata indicating model role when invoked by the tiered pipeline.
- Ensure GPT-5.5 calls can be attributed as `specialist` or `sentinel`, not `discovery`.
- Preserve backward-compatible CLI behavior if the script is used directly, unless existing architecture expects this script to follow central policy.

Important:

- Do not hardcode tiered routing in provider-specific code.
- Provider script should remain a model runner, not the pipeline brain.

---

### `scripts/gemini-review.mjs` — modify

Purpose:

- Support Gemini as candidate adjudicator only in the tiered pipeline.

Planned changes:

- Add or expose adjudication mode accepting normalized candidates and returning structured decisions.
- Ensure tiered pipeline does not call Gemini for broad discovery.
- Preserve direct CLI compatibility if users still run Gemini review manually.
- Attribute Gemini costs as Stage 2 adjudication.

Important:

- Gemini should not decide what to discover in the new flow.
- Gemini malformed adjudication must be distinguishable from valid dismissal.

---

### `tests/audit-tiered-pipeline.test.mjs` — create

Purpose:

- Test orchestration-level behavior.

Test cases:

- GLM + Sonnet discovery are run by default.
- GPT-5.5 is not run without a trigger.
- Gemini is not run for discovery.
- Plausible HIGH candidates reach Stage 2.
- Stage 1 cannot final-dismiss HIGH/CRITICAL candidates.
- Cost cap stops additional expensive calls and records pending candidates.
- One discovery model failure degrades but does not abort.
- Both discovery models failing aborts the run.
- Final summary includes cost-per-accepted-HIGH.

---

### `tests/audit-stage0-triage.test.mjs` — create

Purpose:

- Test deterministic Stage 0 correctness.

Test cases:

- Malformed candidates are rejected with deterministic reason codes.
- Nonexistent paths are rejected.
- Invalid line ranges are rejected.
- Duplicate candidates are merged.
- Source evidence from duplicates is preserved.
- Severity disagreement is preserved.
- Semantically weak but structurally valid candidates are not rejected.

---

### `tests/audit-costs.test.mjs` — create

Purpose:

- Test cost accounting.

Test cases:

- Costs aggregate by stage and model.
- Accepted HIGH count drives cost-per-HIGH.
- Zero accepted HIGH produces undefined/infinite explicit representation, not `0`.
- Billable failed calls are counted.
- Unknown usage is surfaced explicitly.
- Budget exceedance is detected.

---

### `tests/audit-stage1-validation.test.mjs` — create

Purpose:

- Test validation and anti-circularity behavior.

Test cases:

- Contrarian strata are included.
- Validation fails when labels come from the same candidate model.
- Validation fails when sample size is below minimum.
- HIGH recall is weighted above precision.
- Cost is used as a tie-breaker, not the primary score.
- Selected model output is deterministic with a fixed seed.

---

### `docs/audit-tiered-pipeline.md` — create

Purpose:

- Document the new audit design, operator expectations, and migration path.

Content:

- Pipeline diagram.
- Stage responsibilities.
- Model roles.
- GPT-5.5 specialist/sentinel triggers.
- Gemini adjudicator-only rule.
- Stage 1 asymmetric dismissal policy.
- Cost-per-accepted-HIGH definition.
- Validation methodology and anti-circularity rules.
- Failure modes and runbook.

---

## 6. Failure Modes and Handling

### Discovery failure

- One cheap discovery model fails:
  - Continue with remaining discovery model.
  - Mark run as degraded.
  - Increase sentinel/adjudication caution if configured.

- Both cheap discovery models fail:
  - Abort run.
  - Persist failure summary.
  - Exit non-zero.

### Invalid model output

- Discovery invalid output:
  - Quarantine raw output reference.
  - Do not create valid candidate.
  - Count cost if billable.

- Stage 1 invalid output:
  - Escalate candidate to Stage 2.
  - Do not dismiss.

- Gemini invalid output:
  - Mark candidate `needs_human` or `pending_adjudication`.
  - Do not dismiss.

### Budget exhaustion

- Discovery budget exhausted:
  - Abort if minimum discovery portfolio cannot run.
- Stage 1 budget exhausted:
  - Stop additional Stage 1 calls and mark remaining candidates pending.
- Stage 2 budget exhausted:
  - Stop additional adjudication and mark remaining escalations pending.
- Final report must explicitly indicate budget-limited coverage.

### Zero accepted HIGH

- Report as:
  - `acceptedHighCount: 0`
  - `costPerAcceptedHighDefined: false`
- Do not show cost-per-HIGH as `$0`.
- Include warning that the run produced no accepted HIGH and therefore the governing cost metric is undefined.

### Validation insufficiency

- If contrarian-stratified sample is too small:
  - Fail validation.
  - Do not update selected Stage 1 model.
- If labels are circular:
  - Fail validation.
  - Emit exact offending label/model references.
- If candidate models tie:
  - Prefer higher HIGH recall.
  - Then lower plausible-HIGH false dismissal rate.
  - Then lower projected cost per accepted HIGH.
  - Then lower escalation rate.

---

## 7. Security, Persistence, and Contract Safety

### Security

- Never persist API keys, environment variables, auth headers, or provider request metadata containing secrets.
- Redact raw model request bodies if they contain sensitive repository data beyond existing artifact norms.
- Keep snippets minimal and candidate-scoped for Stage 1 and Stage 2.
- Ensure CLI errors do not echo provider credentials.

### Persistence safety

- Use existing repository atomic-write helpers if present.
- Final run summaries should be written atomically.
- Event traces should be append-only where feasible.
- Partial run state must be recoverable enough to explain what happened.
- Persist policy snapshot with every run.

### Contract correctness

- Preserve existing finding output shape where downstream consumers depend on it.
- New fields should be additive unless a migration is explicitly handled.
- Structured model outputs must be schema-validated before being used for routing decisions.
- Stage 1 and Stage 2 action enums should be closed sets.

---

## 8. Testing Strategy

### Unit tests

Cover:

- Stage 0 deterministic triage.
- Candidate fingerprinting and deduplication.
- Asymmetric dismissal policy.
- Cost summary calculations.
- Validation stratification.
- Label independence checks.

### Orchestration tests

Use fake model adapters to verify:

- Correct models run in each stage.
- GPT-5.5 is triggered only by policy.
- Gemini is adjudicator-only.
- Malformed outputs escalate instead of dismissing.
- Budget caps stop expensive calls safely.

### Regression tests

Ensure:

- Existing cycle script can still run.
- Existing output consumers are not broken.
- Legacy pipeline remains available during migration if required.

### Golden fixture tests

Add small fixtures representing:

- GLM-only HIGH candidate.
- Sonnet-only HIGH candidate.
- Cross-model duplicate.
- Contrarian historical candidate.
- Old-gate-rejected but later accepted candidate.
- Zero-HIGH run.

---

## Section 9 — Acceptance Criteria

1. The default tiered audit run executes GLM and Sonnet as the discovery portfolio and does not execute GPT-5.5 or Gemini as discovery models.

2. GPT-5.5 is invoked only when a configured specialist or sentinel trigger fires, and its invocation is recorded with role `specialist` or `sentinel`, not `discovery`.

3. Gemini is invoked only for Stage 2 adjudication of existing candidates and never for broad repository discovery in the tiered pipeline.

4. Stage 0 rejects malformed, duplicate, out-of-scope, nonexistent-path, or invalid-line-range candidates deterministically, with auditable reason codes.

5. Stage 0 does not reject a structurally valid candidate solely because the claim appears semantically unlikely or low confidence.

6. Stage 1 can final-dismiss only candidates permitted by the asymmetric dismissal policy.

7. Stage 1 cannot final-dismiss any candidate claimed as HIGH/CRITICAL by any discovery model; such candidates are escalated, accepted provisionally, or marked pending.

8. Malformed, timeout, or low-confidence Stage 1 responses result in escalation or pending status, never silent dismissal.

9. Accepted HIGH findings in the final report come from Stage 2 adjudication, allowed deterministic acceptance policy, or existing compatible accepted-finding flow explicitly documented by the pipeline.

10. The final tiered audit report includes total cost, cost by stage, cost by model, accepted HIGH count, and cost-per-accepted-HIGH.

11. When accepted HIGH count is zero, cost-per-accepted-HIGH is represented as undefined/infinite with an explicit flag and is not serialized or displayed as `0`.

12. Budget exhaustion stops additional model calls according to stage policy and records unprocessed candidates as pending rather than dropping them.

13. The Stage 1 validation CLI creates a contrarian-stratified sample including disagreement and single-model-found cases.

14. The Stage 1 validation process rejects circular labels where the candidate Stage 1 model being evaluated supplied the ground-truth judgment.

15. Stage 1 model selection is based primarily on HIGH recall, with cost used as a secondary or tie-breaking metric.

16. The selected Stage 1 model can be written to policy only via an explicit validation CLI option; validation does not mutate policy by default.

17. Existing `scripts/cycle.mjs` can run the tiered pipeline or explicitly fall back to the legacy precision-gated pipeline during migration.

18. Unit tests verify Stage 0 triage, asymmetric Stage 1 dismissal, Gemini-only adjudication routing, GPT-5.5 trigger-only routing, cost-per-HIGH calculation, and validation anti-circularity.

19. Persisted run artifacts include the policy snapshot, stage decisions, model role attribution, and cost summary.

20. No persisted artifact or CLI error output contains API keys, authorization headers, or raw environment variable dumps.

---

## 10. Risks

### Risk: Existing model wrappers are tightly coupled to old pipeline assumptions

Mitigation:

- Add thin adapter functions in the new pipeline rather than rewriting provider scripts.
- Keep provider-specific changes minimal.
- Preserve existing direct CLI behavior where possible.

### Risk: Historical validation data is biased by the previous precision gate

Mitigation:

- Require contrarian strata.
- Include rejected, pending, disagreement, and single-model-only samples.
- Fail validation if only accepted historical findings are available.

### Risk: Stage 1 model silently harms recall

Mitigation:

- Enforce asymmetric dismissal in policy code, not prompt text only.
- Escalate malformed/low-confidence decisions.
- Monitor sentinel samples.
- Track false dismissal rate during validation.

### Risk: Cost-per-accepted-HIGH is noisy on small runs

Mitigation:

- Report per-run metric and rolling aggregate separately if existing artifacts support it.
- Treat zero-HIGH runs explicitly.
- Do not auto-optimize policy from a single run.

### Risk: Gemini adjudication becomes a bottleneck

Mitigation:

- Use Stage 1 to dismiss only safe low-risk candidates.
- Apply budget caps.
- Record pending candidates clearly.
- Allow human review queue for unresolved escalations.

### Risk: Policy complexity grows into over-engineering

Mitigation:

- Keep policy fields limited to stage roles, dismissal rules, triggers, and cost caps.
- Avoid building a generic workflow engine.
- Add only the abstractions needed by GLM/Sonnet/GPT-5.5/Gemini tiering.

### Risk: Persistence format breaks downstream consumers

Mitigation:

- Keep existing accepted-finding output additive.
- Store new detailed traces separately if necessary.
- Add compatibility mode to `scripts/audit-tiered.mjs`.
- Cover cycle integration with regression tests.

### output-2

## Plan Overview

The current audit pipeline (precision‑gated, single‑pass OpenAI audit + Gemini review) will be rebuilt into a recall‑weighted, cost‑governed tiered pipeline. The new design introduces: a deterministic pre‑filter (Stage 0), a cheap‑model triage with one‑way dismissal (Stage 1), and Gemini as the final adjudicator (Stage 2). GPT‑5.5 is demoted to a triggered specialist only. A novel contrarian‑stratified validation session selects the optimal Stage 1 model without circularity, and the governing metric switches to cost‑per‑accepted‑HIGH.

The pipeline respects the existing architecture, reusing findings‑domain filters and the existing Gemini review script as an adjudicator, while adding new orchestration modules inside `audit-orchestration`.

---

## Design Decisions (with rationale)

1. **Stage 0 – Deterministic triage**  
   Reuses the existing `findings‑filter` library to apply regex/AST patterns that remove high‑confidence false‑positives before any LLM call. This costs nothing and reduces downstream token consumption.

2. **Stage 1 – Cheap‑model triage with asymmetric dismissal authority**  
   A portfolio of cheap models (GLM, Sonnet) runs on the survivors in parallel.  
   - **Asymmetric authority**: if any cheap model confidently dismisses a finding, it is removed immediately; only items that all cheap models keep are passed forward.  
   - This favours *recall*: cheap models may misclassify real issues but are unlikely to all silently agree on a false‑positive, so we only drop findings where there is strong cheap‑model consensus to discard.  
   - The choice of which cheap model to use is driven by the contrarian‑stratified validation session (see decision 6).

3. **Stage 2 – Gemini as adjudicator‑only**  
   The existing `gemini‑review.mjs` is reused, but it only receives findings that passed Stage 1. It classifies them as HIGH, MEDIUM, or FALSE. Only HIGH findings contribute to the cost‑per‑accepted‑HIGH metric. Gemini was previously a second‑pass reviewer; now it becomes the sole expensive final decider, reducing Gemini token spend to the minimal effective set.

4. **Cost‑governance metric: cost‑per‑accepted‑HIGH**  
   Total API cost across all stages is tracked per batch. The number of HIGH findings confirmed by Stage 2 is counted. The ratio (cost / HIGH count) is the primary efficiency metric logged after each cycle. Threshold alerts and model‑selection feedback loop use this metric.

5. **GPT‑5.5 demoted to triggered specialist/sentinel**  
   GPT‑5.5 is removed from the main pipeline. It is invoked only as a sentinel when Stage 2 returns very‑low‑confidence results or on specific file‑type triggers (e.g., critical security areas). This keeps its high cost bounded while preserving a safety net.

6. **Contrarian‑stratified validation session**  
   A standalone script (`model‑selector‑validation.mjs`) uses a labelled historical dataset of audit findings. It constructs a contrarian set (hard examples where models tend to disagree) and stratifies by finding type. Candidate Stage 1 models are evaluated on their ability to dismiss false‑positives without dismissing true‑positives (recall‑oriented). The script outputs a recommended model configuration, avoiding the circularity of evaluating a model against itself. This configuration is stored in the pipeline config and consumed by Stage 1.

7. **Persistence and safety**  
   All finding records are written atomically (using the existing `atomicWrite` from `symbol‑index/drift.mjs` or the shared‑lib utility). The pipeline stages never mutate in‑place; they produce filtered copies that are persisted as the next stage’s input. This ensures idempotency and rollback safety.

---

## File‑level Plan

### Files to Create

| File | Purpose | Domain (per rules) |
|------|---------|-------------------|
| `scripts/lib/audit/deterministic‑stage0.mjs` | Wraps `findings‑filter` patterns into a deterministic pre‑filter function `filterDeterministic(findings)`. Applies rules, returns filtered list and dismissal reasons for audit trail. | `audit-orchestration` |
| `scripts/lib/audit/cheap‑stage1.mjs` | Orchestrates parallel calls to GLM and Sonnet APIs, collates results, enforces asymmetric dismissal logic, returns survivors. Exports `runCheapTriage(findings, options)`. | `audit-orchestration` |
| `scripts/model‑selector‑validation.mjs` | Contrarian‑stratified validation session. Loads ground‑truth dataset from `learning‑store`, evaluates candidate cheap models, computes recall‑oriented metrics, writes recommended model to `config/audit‑pipeline.json`. | `audit-orchestration` (by path) or `scripts` domain – placed in `scripts/` so it can call audit libs. |
| `tests/unit/deterministic‑stage0.test.mjs` | Unit tests for the deterministic filter logic, ensuring patterns are applied and edge cases handled. | `tests` |
| `tests/integration/tiered‑audit.test.mjs` | Integration test that runs a full pipeline (Stage 0 → 1 → 2) with mocked APIs and verifies staging logic and cost tracking. | `tests` |
| `config/audit‑pipeline.json` | Configuration file: cheap model endpoints, cost rates, dismissal thresholds, GPT‑5.5 trigger rules. | (root config, likely `scripts` domain if accessed by scripts) |

### Files to Modify

| File | Modification | Domain |
|------|--------------|--------|
| `scripts/cycle.mjs` | Replace the old monolithic audit+review with new stage pipeline. Orchestrate: load files → Stage 0 → Stage 1 → Stage 2, compute cost‑per‑accepted‑HIGH, log metric. Read pipeline config. | `audit-orchestration` |
| `scripts/gemini‑review.mjs` | Refactor to accept `--adjudicate‑only` mode. When set, it skips its own triage, directly classifies provided findings as HIGH/MEDIUM/FALSE. Preserve backward compatibility for non‑adjudication uses. | `audit-orchestration` |
| `scripts/lib/findings‑filter.mjs` (if exists) | If deterministic patterns are hardcoded, expose as a configurable module or a set of rules loadable by `deterministic‑stage0`. (Minimal change; reuse existing filtering logic.) | `findings` |

---

## Risks

1. **Data drift in deterministic patterns** – Hard‑coded false‑positive patterns may become stale. Mitigation: periodic refresh process; the patterns are versioned and tested against new findings.

2. **Model API reliability** – Cheap models (GLM, Sonnet) may have outages or rate limits. Mitigation: implement retry logic and fallback (skip Stage 1 and send all to Stage 2) when both cheap models fail, balancing cost.

3. **Contrarian‑validation dataset quality** – The historical dataset must reflect real‑world distribution and include hard cases. Mitigation: use `learning‑store` with known‑outcome findings from previous audits; maintain stratification.

4. **Stage 1 dismissal authority sensitivity** – If both cheap models are overly permissive, Stage 1 filters too little, increasing Gemini load. Mitigation: the model‑selector validation explicitly optimises for a high dismissal‑of‑false‑positives rate while maintaining recall, so the chosen model will be calibrated.

5. **Cost‑per‑accepted‑HIGH metric gaming** – If Gemini is biased toward rejecting everything, the metric appears good but we lose real issues. Mitigation: separate recalibration process (triggered specialist GPT‑5.5) samples a proportion of dismissed findings and escalates if too many false‑dismissals are detected.

---

## Target Paths

- `scripts/lib/audit/deterministic‑stage0.mjs`
- `scripts/lib/audit/cheap‑stage1.mjs`
- `scripts/model‑selector‑validation.mjs`
- `tests/unit/deterministic‑stage0.test.mjs`
- `tests/integration/tiered‑audit.test.mjs`
- `config/audit‑pipeline.json`
- `scripts/cycle.mjs`
- `scripts/gemini‑review.mjs`
- `scripts/lib/findings‑filter.mjs` (minor modification)

---

## Section 9 — Acceptance Criteria

1. Stage 0 deterministic filter removes at least 80% of known false‑positives from a curated test set without suppressing any known HIGH findings.
2. Stage 1 cheap models are fully configurable via `config/audit‑pipeline.json`; swapping a model requires only a configuration change, not code.
3. Asymmetric dismissal authority: a finding dismissed by any single cheap model is immediately excluded from further stages.
4. Stage 2 (Gemini) receives only findings that survived Stage 1.
5. After each batch run, `cost‑per‑accepted‑HIGH` is computed and logged, with a breakdown per stage.
6. The contrarian‑stratified validation session (`model‑selector‑validation.mjs`) runs on historical data, computes recall‑oriented scores for candidate models, and outputs a recommendation that is used to populate the active configuration.
7. All existing unit tests in the `tests/` domain pass when the pipeline is switched to the new tiered configuration.
8. No finding is lost from ingestion to final storage; the pipeline maintains an unbroken audit trail (all stages log their decisions).
9. Running `node scripts/cycle.mjs` without extra flags executes the full tiered pipeline end‑to‑end with the production configuration.
10. Persistence invariants are maintained: each stage writes atomically to the findings store, and intermediate files are never corrupted by concurrent writes.

### output-3

# Implementation Plan — Recall-Weighted, Cost-Governed Tiered Audit Pipeline

## Overview

The current pipeline treats every file with a single precision-gated pass (GPT-5.5 primary, Gemini confirm). This over-spends on files that yield nothing and under-discovers because one model's bias becomes the gate. The redesign introduces a three-stage tiered pipeline:

- **Stage 0 — Deterministic triage**: regex/AST rules cheaply classify each file into risk bands and filter out trivially-safe files (vendored, generated, boilerplate). Zero model cost.
- **Stage 1 — Cheap discovery portfolio**: GLM and Sonnet independently scan Stage-0 survivors. Either model can *raise* a finding (symmetric promotion). Either model can *dismiss* a finding as LOW, but dismissal authority is **asymmetric** — a LOW dismissal by one model does not bind if the other model or Stage 0 flagged the file as elevated risk. Only mutual LOW dismissal on a low-risk file terminates the file.
- **Stage 2 — Gemini adjudicator-only**: receives only (a) files where Stage 1 models disagree on severity, (b) files where both raised HIGH, and (c) a stratified sample of mutual-LOW dismissals as sentinel checks. Gemini never scans from scratch — it rules on the specific finding(s) presented.
- **GPT-5.5 demoted to triggered specialist/sentinel**: invoked only when Gemini is uncertain (split decision), or on a cost-governed random sample of accepted HIGHs to catch false-accepts. Never a primary scanner.

The governing metric is **cost-per-accepted-HIGH** (total model spend ÷ count of findings adjudicated as HIGH and surviving sentinel review). The Stage 1 model pair is selected via a **contrarian-stratified validation session**: each candidate model is evaluated on a corpus where the ground-truth labels were generated by a *different* model family, stratified so that the candidate cannot succeed simply by agreeing with the labeler.

## Design Decisions

### 1. Stage 0 is deterministic and owns the file-level decision to enter Stage 1
**Rationale**: The cheapest finding is the one never sent to a model. A deterministic pre-filter (file-type heuristics, symbol-index integration with the existing `arch-memory` domain, diff-size thresholds, `isThinDelegate` detection) eliminates 30–60% of files at zero cost. Stage 0 also assigns a **risk band** (low/medium/high) that governs Stage 1 dismissal authority — this is what makes the dismissal asymmetric rather than permissive.

### 2. Asymmetric dismissal authority encoded as a decision matrix, not ad-hoc logic
**Rationale**: The dismissal rule is the safety-critical path. Encoding it as an explicit matrix `(risk_band, model_A_dismisses, model_B_dismisses) → {terminate, escalate}` makes it testable in isolation and prevents silent erosion of recall. Low-risk + mutual LOW → terminate. Medium/high-risk + any LOW dismissal → escalate (the dismissal becomes a *vote*, not a verdict).

### 3. Gemini is adjudicator-only — no fresh-scan prompt
**Rationale**: Fresh-scanning at Stage 2 would replicate Stage 1 cost at a higher price point. By constraining Gemini to rule on specific findings (with code context attached), we cap its token budget per file and make its cost predictable. This also makes the cost-per-accepted-HIGH metric stable: Gemini spend becomes a function of disagreement volume, not file volume.

### 4. GPT-5.5 as triggered specialist, not a stage
**Rationale**: GPT-5.5 is expensive and high-precision but was the recall bottleneck in the old model. Using it only on Gemini-uncertain cases and on a sentinel sample of accepted HIGHs gives us its precision where it matters most (borderline HIGH) without making it the gate. Its sentinel role on accepted HIGHs creates a **false-accept detection loop** that feeds back into the validation corpus.

### 5. Contrarian-stratified validation for Stage 1 model selection
**Rationale**: Selecting the Stage 1 model by running it against a corpus it (or a sibling model) labeled creates circularity — a model that over-generates LOW will score well against its own labels. The validation session instead:
1. Builds a ground-truth corpus using a model *outside* the candidate family (e.g., if selecting between GLM and Sonnet, the corpus is labeled by GPT-5.5 or Gemini — which are not candidates for Stage 1).
2. Stratifies the corpus into **contrarian strata**: findings where the labeler was uncertain (severity within one band of threshold), findings where the labeler's own confidence was low, and findings that the labeler initially disagreed with a second labeler on. A candidate must maintain recall on contrarian strata, not just on easy consensus strata.
3. Scores candidates on **cost-per-accepted-HIGH on the contrarian strata**, not raw accuracy.

### 6. Cost ledger as a first-class persistent artifact
**Rationale**: Cost-per-accepted-HIGH can only govern if it is measured per-run and persisted. The existing `learning-store` domain (which depends on `findings` and `shared-lib`) is the natural home for run-level cost telemetry. Each pipeline run records: stage, model, token count, cost, findings raised, findings accepted, findings rejected — keyed by run-id.

### 7. Stage 1 models run in parallel, not sequentially
**Rationale**: Sequential execution (Model A, then Model B only if A raised something) would reintroduce a precision gate — if A misses it, B never sees it. Parallel independent scanning is what makes the portfolio recall-weighted. The cost is bounded because Stage 0 already filtered trivially-safe files.

### 8. No new domain; all changes within `audit-orchestration` + `findings`
**Rationale**: The domain map allows `audit-orchestration` → `findings`, `shared-lib`, `learning-store`, `plan`, `tech-debt`. The tiered pipeline is orchestration logic; finding-level data structures belong in `findings`; cost telemetry belongs in `learning-store`. No layering violations needed.

## File-Level Plan

### `scripts/lib/audit/stage0-triage.mjs` — **CREATE**
Deterministic triage. Exports `triageFile(filePath, context)` → `{ riskBand: 'low'|'medium'|'high', skip: boolean, signals: string[] }`. Integrates with existing `isThinDelegate` from `arch-memory` and diff-size/file-type heuristics. Owns the file-level skip decision (generated/vendored/dead code). No model calls.

### `scripts/lib/audit/stage1-portfolio.mjs` — **CREATE**
Orchestrates parallel GLM + Sonnet scans on Stage-0 survivors. Exports `runStage1(file, triageResult, models)` → `{ findings: Finding[], dismissals: Dismissal[] }`. Each model runs independently. Findings and dismissals are tagged with `sourceModel`. Does not make termination decisions — delegates to the decision matrix.

### `scripts/lib/audit/dismissal-matrix.mjs` — **CREATE**
Pure function implementing the asymmetric dismissal decision. Exports `resolveDismissal(riskBand, dismissals)` → `'terminate'|'escalate'`. Encodes the matrix: low-risk + mutual LOW → terminate; anything else → escalate. No side effects, fully unit-testable.

### `scripts/lib/audit/stage2-adjudicator.mjs` — **CREATE**
Gemini-only adjudication. Exports `adjudicate(escalatedFindings, context)` → `AdjudicationResult[]`. Accepts specific findings (not files). Returns `{ verdict: 'accept'|'reject'|'uncertain', severity, rationale }`. On `uncertain`, triggers GPT-5.5 specialist. Token budget is capped per finding.

### `scripts/lib/audit/specialist-trigger.mjs` — **CREATE**
GPT-5.5 invocation logic. Exports `runSpecialist(finding, triggerReason)` where `triggerReason ∈ {'gemini-uncertain', 'sentinel-sample'}`. Returns a specialist verdict. Includes the sentinel sampling logic (cost-governed random sample of accepted HIGHs) so false-accepts feed back into the validation corpus.

### `scripts/lib/audit/cost-ledger.mjs` — **CREATE**
Cost tracking per pipeline run. Exports `createLedger(runId)`, `ledger.record(stage, model, tokens, cost, findingsCount)`, `ledger.report()` → `{ totalCost, acceptedHigh, costPerAcceptedHigh }`. Persists to `learning-store` via existing store interfaces. This is the governing metric source.

### `scripts/lib/audit/pipeline.mjs` — **CREATE** (or **MODIFY** if an existing orchestration entry point exists)
Top-level pipeline orchestrator. Wires Stage 0 → Stage 1 → dismissal matrix → Stage 2 → specialist trigger. Exports `runTieredAudit(fileList, options)` → `{ findings, costReport }`. Integrates with existing finding-persistence in `findings` domain. This replaces the entry point currently used by `scripts/openai-audit.mjs` / `scripts/cycle.mjs`.

### `scripts/lib/audit/model-selection/contrarian-validation.mjs` — **CREATE**
Contrarian-stratified validation session. Exports `selectStage1Model(candidates, corpus)` → `{ selectedModel, score, strataBreakdown }`. Loads a ground-truth corpus labeled by a non-candidate model, stratifies into contrarian strata, scores each candidate on cost-per-accepted-HIGH within strata. Outputs the selection + full breakdown for auditability.

### `scripts/lib/audit/model-selection/stratifier.mjs` — **CREATE**
Builds contrarian strata from a labeled corpus. Exports `stratify(corpus)` → `{ uncertain, lowConfidence, interLabelerDisagreement, consensus }`. Pure function, testable without model calls.

### `scripts/lib/findings/finding-schema.mjs` — **MODIFY**
Add fields to the existing finding schema: `stage` (0|1|2|specialist), `sourceModel`, `riskBand`, `adjudicationVerdict`, `adjudicationModel`. These are additive — existing consumers that don't read the new fields are unaffected. The finding contract remains backward-compatible.

### `scripts/openai-audit.mjs` — **MODIFY**
Demote from primary scanner to a thin entry that delegates to `pipeline.mjs` with GPT-5.5 configured as specialist-only. Preserves CLI compatibility for existing callers. The `--model` flag now configures the specialist, not the primary scanner.

### `scripts/gemini-review.mjs` — **MODIFY**
Constrain to adjudicator-mode invocation. The existing Gemini review logic is refactored to accept specific findings rather than scanning files. CLI gains `--adjudicate` flag for the new path; existing `--review` path is deprecated but maintained for one release cycle.

### `scripts/lib/audit/config.mjs` — **CREATE**
Centralized pipeline configuration: model endpoints, token budgets per stage, sentinel sample rate, risk-band thresholds, cost-per-accepted-HIGH ceiling. Exports a validated config object. This is the single knob-panel for the tiered pipeline.

### `tests/audit/stage0-triage.test.mjs` — **CREATE**
Unit tests for deterministic triage: file-type filtering, thin-delegate detection, risk-band assignment, skip logic.

### `tests/audit/dismissal-matrix.test.mjs` — **CREATE**
Exhaustive matrix coverage: every `(riskBand, dismissalA, dismissalB)` combination asserts the correct terminate/escalate decision. This is the safety-critical logic.

### `tests/audit/stage2-adjudicator.test.mjs` — **CREATE**
Tests Gemini adjudication contract: uncertain verdict triggers specialist, token budget enforcement, finding-level (not file-level) scope.

### `tests/audit/cost-ledger.test.mjs` — **CREATE**
Tests cost accumulation, cost-per-accepted-HIGH calculation, persistence to learning-store, and zero-division guard when no HIGH findings are accepted.

### `tests/audit/contrarian-validation.test.mjs` — **CREATE**
Tests stratification correctness, circularity prevention (candidate from same family as labeler is rejected), and scoring logic.

### `tests/audit/pipeline.integration.test.mjs` — **CREATE**
End-to-end test with mocked model responses: verifies stage sequencing, that Stage 0 skips propagate, that parallel Stage 1 results are merged correctly, and that the cost ledger captures all stages.

## Risks

1. **Stage 0 false-skip risk**: A deterministic triage that skips a file containing a real issue is a silent recall failure. Mitigation: Stage 0 skip criteria are conservative (only vendored/generated/dead-code files), and a periodic sentinel sample of skipped files is sent to Stage 1 at a low rate (configurable in `config.mjs`).

2. **Parallel Stage 1 cost doubling**: Running two models on every survivor file doubles Stage 1 cost vs. the old single-model approach. Mitigation: Stage 0 filtering must be aggressive enough that survivor volume is low; cost-per-accepted-HIGH is monitored and a ceiling in `config.mjs` aborts the run if exceeded.

3. **Contrarian validation corpus staleness**: The ground-truth corpus labeled by a non-candidate model will drift as the codebase evolves. Mitigation: the sentinel sample from GPT-5.5 (on accepted HIGHs) and the false-accept/false-reject outcomes from Gemini adjudication continuously refresh the corpus. The validation session is re-run on a schedule, not once.

4. **Gemini adjudicator scope creep**: If the finding context provided to Gemini is too small, it will return `uncertain` frequently, triggering expensive GPT-5.5 specialist calls. Mitigation: token budget is configured with a floor (minimum context) and the `uncertain` rate is monitored as a health metric; persistent high `uncertain` rates trigger a prompt-engineering review, not more specialist calls.

5. **Backward compatibility of finding schema changes**: Adding fields to `finding-schema.mjs` could break consumers that do strict shape validation. Mitigation: all new fields are optional with defaults; existing serialization round-trips are covered in tests.

6. **Circularity in model selection if families converge**: If GLM and Sonnet are trained on overlapping data and the labeler (GPT-5.5) shares training lineage with one candidate, the contrarian stratification may not fully break circularity. Mitigation: the validation session explicitly checks candidate-vs-labeler family overlap and warns (does not hard-fail, since overlap is not provable, only heuristically detectable).

## Target Paths

- `scripts/lib/audit/stage0-triage.mjs` — create
- `scripts/lib/audit/stage1-portfolio.mjs` — create
- `scripts/lib/audit/dismissal-matrix.mjs` — create
- `scripts/lib/audit/stage2-adjudicator.mjs` — create
- `scripts/lib/audit/specialist-trigger.mjs` — create
- `scripts/lib/audit/cost-ledger.mjs` — create
- `scripts/lib/audit/pipeline.mjs` — create
- `scripts/lib/audit/config.mjs` — create
- `scripts/lib/audit/model-selection/contrarian-validation.mjs` — create
- `scripts/lib/audit/model-selection/stratifier.mjs` — create
- `scripts/lib/findings/finding-schema.mjs` — modify
- `scripts/openai-audit.mjs` — modify
- `scripts/gemini-review.mjs` — modify
- `tests/audit/stage0-triage.test.mjs` — create
- `tests/audit/dismissal-matrix.test.mjs` — create
- `tests/audit/stage2-adjudicator.test.mjs` — create
- `tests/audit/cost-ledger.test.mjs` — create
- `tests/audit/contrarian-validation.test.mjs` — create
- `tests/audit/pipeline.integration.test.mjs` — create

## Section 9 — Acceptance Criteria

1. Stage 0 triage produces a `riskBand` and `skip` boolean for every input file without invoking any model, and skips only files matching vendored/generated/dead-code/thin-delegate criteria.
2. Stage 1 runs GLM and Sonnet in parallel on all non-skipped files; both models' findings and dismissals are recorded with `sourceModel` attribution.
3. The dismissal matrix terminates a file only when `riskBand === 'low'` AND both models dismiss as LOW; all other dismissal combinations result in escalation to Stage 2.
4. Gemini (Stage 2) receives specific findings with code context, never a full file scan; its output is restricted to `{accept, reject, uncertain}` verdicts per finding.
5. GPT-5.5 is invoked exclusively via `specialist-trigger.mjs` with `triggerReason` of either `gemini-uncertain` or `sentinel-sample`; no code path invokes it as a primary scanner.
6. The sentinel sample rate for accepted-HIGH false-accept checking is configurable and defaults to a non-zero value.
7. `cost-ledger.mjs` records per-stage, per-model token counts and costs for every pipeline run and computes `costPerAcceptedHigh = totalCost / acceptedHighCount` with a zero-division guard returning `Infinity` when `acceptedHighCount === 0`.
8. The contrarian validation session rejects any candidate model whose family matches the corpus labeler's family, and scores remaining candidates on cost-per-accepted-HIGH within contrarian strata (uncertain, low-confidence, inter-labeler-disagreement), not on raw accuracy.
9. The finding schema changes are additive: all new fields (`stage`, `sourceModel`, `riskBand`, `adjudicationVerdict`, `adjudicationModel`) are optional, and existing finding serialization round-trips without loss.
10. `scripts/openai-audit.mjs` and `scripts/gemini-review.mjs` maintain their existing CLI interfaces while delegating to the tiered pipeline; no existing caller breaks without a deprecation warning.
11. The dismissal-matrix test file covers every combination of `(riskBand, modelA_dismissal, modelB_dismissal)` exhaustively and asserts the documented terminate/escalate outcome for each.
12. The pipeline integration test verifies end-to-end stage sequencing with mocked models: Stage 0 skip propagates (no Stage 1 call), parallel Stage 1 results merge, escalation triggers Stage 2, and `uncertain` from Stage 2 triggers the specialist.

