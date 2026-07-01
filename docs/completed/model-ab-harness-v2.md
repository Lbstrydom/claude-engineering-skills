# Plan: Model-A/B/C auditor harness — v2 (composition arms + outcome-based scoring)

- **Date**: 2026-07-01
- **Status**: Complete — built 2026-07-01 via `/cycle code --autonomous` (2 clusters). Audit-plan: GPT R1–R3 H:7→4→4 plateau; Gemini R1 4 design fixes → R2 CONCERNS (completeness) stopped at cap. Code-audit: Cluster A GPT R1–R3 (H:12→7→11 rigor-pressure plateau, genuine v2 bugs fixed each round); consolidated Gemini gate R1 CONCERNS (1 empirically-refuted Zod-4 category error) → R2 APPROVE. Full suite 4120 tests green. See §3–§7 for the plan audit trail + Implementation Log below.
- **Author**: Claude + Louis
- **Scope**: backend (`js-ts` + postgres; `node --test`) — a **delta** on the shipped v1 (`docs/completed/model-ab-experiment-harness.md`)
- **Origin**: operator review of v1 + independent GPT-5.5 + Gemini-pro critique. v1 built the machinery (shadow, spend ledger, scorer view, adjudication queue, decision rule) and the mandatory consolidated Gemini gate caught 5 budget-safety bugs. v2 corrects the **arm compositions**, the **scoring model**, and the **scientific-validity controls** — most of the v1 plumbing is reused unchanged.

---

## 1. What changes from v1 (and what doesn't)

**Reused unchanged**: the stage/provenance attribution model (`stage` on findings, arm membership DERIVED in the view — no per-finding `arm_id`), the reserve-then-reconcile € spend ledger, the redact-once egress path + OSS Chat-Completions adapter + conformance pre-filter, the blinded adjudication queue + union-find dedup, the schema-preflight hard-refusal, the `commit_sha` distinct-assignment key (from the v1 Gemini gate). The architecture was already composition-shaped; v2 mostly re-points data + enriches the scorer.

**Changes**: (a) arm compositions, (b) OSS model, (c) single OSS key, (d) two-level outcome-based scoring + recall, (e) cost as a reported *frontier* not a score term, (f) `stage_type` dimension, (g) validity-control process (two-phase burn-in, prompt-sensitivity probe, randomized arm order).

---

## 2. Design decisions

### D1 — Arms are audit-pipeline COMPOSITIONS; Claude is the constant coder + adjudicator (not an auditor arm)

Claude authors the code in every arm; the variable is the **audit + review stack**. Re-pointed from v1:

| Arm | Composition (stages) | Question it answers |
|---|---|---|
| **A** | GPT audit → Gemini review | production control |
| **B** | OSS audit → 1 GPT round → Gemini review | full stack — does the GPT round earn its keep? (vs C) |
| **C** | OSS audit → Gemini review (no GPT round) | can OSS + Gemini **replace** GPT + Gemini? (vs A) |

`A vs C` = "can we drop GPT entirely?"; `B vs C` = "is the independent GPT round pulling weight?". (v1 had B=OSS+GPT-no-Gemini, C=OSS+GPT+Gemini — a weaker question.) One config edit to `CANONICAL_ARMS` + the view's stage→arm CASE.

### D2 — Adjudicator = Claude Opus 4.8 (author + adjudicator), blind to source_model, human-verifiable

Defensible **because Claude is not an auditor arm** — judging GPT/OSS/Gemini findings is not self-rating. The residual **author-defensiveness** bias (an author under-rates valid criticism of their own code) applies *uniformly across all three arms*, so it **cancels in the relative ranking** (a constant, not a confound). Controls: the queue hides `source_model` (built); the human (Louis) can verify/override any adjudication.

### D3 — Single OSS key (OpenRouter serves ONLY the OSS auditor, shared by B + C)

A uses OpenAI-direct GPT; Gemini reviews use the Gemini API; only the OSS-audit stage (in B and C, which share it) routes through OpenRouter. So **one `OPENROUTER_API_KEY`** suffices. Per-arm keys are an optional later add ONLY if B-vs-C cost isolation is wanted (they share the OSS compute, so isolation is derived in the view anyway).

### D4 — OSS model = DeepSeek V4 Pro (critique ≠ generation) — VERIFIED on OpenRouter

Both GPT-5.5 and Gemini-pro independently rejected GLM-5.2 for this task: code *critique* is logical-contradiction / unhandled-state reasoning, where DeepSeek's reasoning lineage leads ("apex OSS for adversarial vulnerability spotting"). GLM-5.2 → **rotation candidate**.

**Confirmed live on OpenRouter (2026-07-01)** — point `latest-oss-reasoner` → **`deepseek/deepseek-v4-pro`** (1M ctx, ~$0.435/$0.87 per 1M in/out — the reasoning-quality tier). **Pro is FIXED for the burn-in** (operator intent: "see what good quality buys" — and Pro is still far cheaper than GPT-5.5's $2.5/$10). `deepseek/deepseek-v4-flash` (~$0.098/$0.196 per 1M) exists ONLY as a **manual** operator swap, **never auto-selected**, so the "what does top-quality OSS buy vs frontier proprietary" comparison is never silently degraded. **Response Healing is OFF during the burn-in** (§4 R2-H2 supersedes — measure *native* conformance, not the healing layer); check the model's **Tool-Call-Error-Rate** page. Update `model-pricing.mjs` `OSS_PRICING` with both ids.

**API prerequisite — SATISFIED**: `OPENROUTER_API_KEY` is present in `.env`, verified working + **paid** (auto-recharge, `is_free_tier:false`, no spending limit) via `/api/v1/key`. No new key needed; the € *cap* (v1 spend ledger) is what bounds the burn-in.

### D4a — Match reasoning EFFORT across arms (apples-to-apples — operator control)

The production audit runs **tiered reasoning** (structure/wiring = low ∥, backend/frontend = **high** ∥, sustainability = medium). If the OSS/GPT-round arms run at DeepSeek's *default* effort while A runs GPT at high, the experiment measures reasoning-effort, not model quality — a gross confound. Control: the OSS adapter passes OpenRouter's **unified `reasoning` parameter** (`reasoning: { effort }`, normalized across providers → DeepSeek V4's native reasoning mode) set to the **same per-pass effort tier** the production pipeline uses; the GPT round already inherits the tiers. **Record the effort per (arm × pass) as metadata** (alongside transport — D10) so the parity claim is auditable.

Honest caveat (fold into the runbook, don't pretend it away): cross-family "high" is **not perfectly commensurable** — GPT-high and DeepSeek-high spend different absolute compute — so this removes the *gross* confound (one at high, one at default) but not the residual "a reasoning tier means different things per family." That residual is a known, recorded limitation, not a silent one. If DeepSeek ignores or poorly honours the effort knob, that itself is recorded config metadata and a finding.

*Adapter change*: `oss-structured-output.mjs` currently sends no reasoning field — add the OpenRouter `reasoning:{effort}` param (mapped from the pass's tier), and record the requested + (if returned) actual reasoning-token usage.

### D5 — Two-level scoring: quality GATE first, then rank by outcome-based weighted quality (NOT cost-divided)

Both external models rejected `value / cost` (a €0.001 nit beats a €1 ten-critical run). So:

1. **Gate** (disqualify before quality is scored): structured-output conformance ≥ floor (v1 built), no sensitive-egress violation, accepted-precision ≥ floor (e.g. 25–40%).
2. **Rank** by weighted quality (below). Cost is reported separately (D7), never in the denominator.

### D6 — Outcome-based finding quality (the anti-churn axis — operator's core ask)

A finding's value is *not* binary accept/dismiss — it is **whether it drove a sustainable, well-integrated fix**. Wire to the ledger fields that already exist: `is_quick_fix`, the `sustainability` pass, `sonarType`/`effort`, and `remediationState` (planned→fixed→**verified**→regressed). Value tiers:

```
verified non-quick-fix HIGH  ≫  accepted sustainable MED  ≫  accepted quick-fix
  ≫  accepted nit  ≫  dismissed  ≫  malformed/noise
```

Severity weights (strawman, tune on data): LOW=1, MED=3, HIGH=8, CRITICAL=15; a `is_quick_fix` accepted finding is discounted (×0.4); a finding whose fix **regressed** is penalized. This is the "efficient/effective/well-integrated/long-term-sustainable, not quick-fixes-or-useless-nits" signal, made from data the loop already records.

### D7 — Cost is a reported FRONTIER, not a score term

For the commercial ROI story (quality-vs-cost per plan / audit cycle): per `(arm × stage_type)`, report **two separate numbers** — weighted-quality score and € cost — as a Pareto frontier, with headline efficiency metrics **`€ per accepted weighted finding`** and **`€ per accepted-HIGH`**. Legible line: *"Arm C delivers ~90% of A's audit value at ~25% of the cost."* Keep quality and cost separate but reported jointly; the hard € *cap* (v1 spend ledger) still stops the burn-in operationally.

### D8 — RECALL metric (penalize precise-but-blind)

Precision alone crowns a model that submits 3 confident findings and misses the 5 real bugs the others caught. Add **per-arm recall against the union of all arms' human-accepted findings** (the best free ground-truth proxy): `recall(arm) = |accepted findings this arm also caught| / |union of all arms' accepted (canonical) findings|`. Cheap (the canonical-dedup already groups cross-arm equivalents) and powerful.

### D9 — `stage_type` dimension (plan | audit-plan | audit-code)

Record `stage_type` on each arm run so cost + quality break down per coding-round type (both models: OpenRouter per-key aggregate "hides where models bleed tokens" and blocks future hybrid routing). One column on `audit_pass_stats` + the view.

### D10 — Scientific-validity controls (process + small code)

- **Paired** A/B/C per assignment on the SAME redacted context (built).
- **Blinded merged adjudication** — pool all arms, hide source (built).
- **Distinct-assignment count** via `commit_sha` (built, from the v1 Gemini gate) — N is in *assignments*, not findings (findings within an audit are correlated).
- **N = 12–25 small, diverse assignments** (backend/frontend/infra/tests/refactor/plan-audit/risky-diff), not 3 giant ones — process guidance in the runbook.
- **Fix the prompt during the burn-in** (else model-quality confounds with prompt iteration).
- **Randomize arm order** per assignment (cheap; removes any sequence effect).
- **Transport recorded as metadata** (Responses vs OpenRouter is not identical inference substrate — record it, don't pretend it away).
- **Two-phase burn-in**: (1) a small **calibration set** of known historical bugs (ground truth exists) to sanity-check the arms, then (2) the **prospective blinded set**. A model that only wins on curated history = benchmark overfit.
- **Prompt-sensitivity probe** (Gemini's guard): one arm, two prompt phrasings, same assignments. If within-model prompt-variance ≈ between-model variance, the experiment measures prompt-fit, not model quality → no leaderboard is credible until fixed.

### D11 — No live auto-router (v3, deferred)

Reading the scorer to pick the production auditor per stage stays out of scope until the data decides. `audit-shadow.mjs` remains the single choke point where it plugs in.

---

## 3. Plan-audit R1 resolutions

R1 = **H:7 M:6 L:1** (`SIGNIFICANT_GAPS`) — all valid; the delta doc was under-specified. Resolutions (finding → decision):

**H1 (crux) + M1 — hybrid attribution + cost allocation.** Pure stage-derivation breaks in v2 because `gemini` runs **once per arm on different inputs** (A reviews GPT; B reviews OSS+GPT; C reviews OSS) — a `gemini` finding is arm-specific, not shared. So attribution is **hybrid**: (a) **shared** stages — `oss-gen` (used by B **and** C, one execution) — stay *derived from stage* (stored once, view expands to {B,C}); (b) **arm-specific** stages — `gemini` (3 executions) and `gpt-round` (B-only) — carry an **explicit `arm` tag** on the finding (nullable `arm` column, CHECK A|B|C, set only for arm-specific stages; null ⇒ derive from stage). The view reads explicit `arm` when present, else derives. **Cost**: report TWO figures — *per-arm standalone cost* (shared `oss-gen` counted fully for both B and C = "what deploying this arm would cost") for the frontier, and *actual € burn* (shared counted **once**, from the spend ledger) for the budget. This supersedes the v1 "no arm_id ever" rule — v2's composition arms genuinely need per-finding arm on the non-shared stages.

**H3 — pre-registration vs calibration (resolve the contradiction) + concrete constants.** Not contradictory once phased: constants are **calibrated on the two-phase CALIBRATION set** (known historical bugs, D10) → **frozen** → the **PROSPECTIVE run uses frozen constants** (changing them after prospective data invalidates). Pre-registration = frozen-before-prospective, not frozen-before-calibration. Starting defaults (calibrate, then freeze): severity LOW=1/MED=3/HIGH=8/CRIT=15; `is_quick_fix` discount ×0.4; **regression penalty −8** (a fix that regressed); accepted-precision **gate floor 0.30**; unique-coverage **α=0.35**; FP penalty **λ=1.0 LOW-equiv**.

**H4 — quality tier is a pure function of EXISTING ledger state (no new verifier).** Authoritative source: the adjudication ledger's `remediationState` (pending/planned/fixed/**verified**/regressed — existing state machine) + `is_quick_fix` (finding) + `classification.sonarType/effort`. `verified` = the existing state machine's verified (a later audit/test confirmed the fix). Null handling: un-remediated ⇒ `pending` ⇒ the "accepted-unverified" tier (below verified, above dismissed). `qualityTier(adjudication_outcome, is_quick_fix, remediationState)` — pure, no new machinery.

**H5 + H7 — explicit `assignment_id` + separable phases.** `assignment_id` = unique per (commit_sha × stage_type × prompt_variant × attempt) — the per-RUN key (groups an assignment's 3 arm-runs). Grain fields: `stage_type`, `phase` (calibration|prospective), `prompt_variant` (default|probe-A|probe-B), `attempt` (rerun counter). **CRITICAL (Gemini R1 — do NOT count `assignment_id` for diversity)**: `MIN_ASSIGNMENTS` must count **distinct (commit_sha × stage_type)** among `phase='prospective'` + `prompt_variant='default'` rows — i.e. distinct *code under audit*, NOT distinct run-instances. Counting `assignment_id` (which includes `attempt`) would let 20 reruns of ONE commit satisfy the diversity floor — the exact v1 bug. The headline filter (prospective + default) + distinct-code count together keep calibration, probe, and rerun data out of the diversity/ranking signal.

**H6 — scope: v2 = audit-code only; plan/audit-plan hooks DEFERRED to v2.1.** v2 adds the `stage_type` column and populates **`audit-code`** (the built path). Wiring the plan + audit-plan entry points (their entry scripts, arm mapping, redaction, storage) is **deferred** — independence: the audit-code model comparison does not depend on the plan/audit-plan comparison (separate `stage_type` cells). Schema is ready now; v2.1 wires the other two round types. (Moved to Out of Scope.)

**M2 — conformance = NATIVE.** The conformance floor measures the model's native structured-output ability. **Superseded/simplified by §4 R2-H2**: rather than heal-then-flag, Response Healing is simply **OFF** during the burn-in, so the parsed response *is* the native output. No `healing_invoked` column needed.

**M3 — soften D2 (author bias is *mitigated*, not *cancelled*).** The uniform-across-arms argument holds only if my defensiveness is category-independent; per-category defensiveness could interact with an arm that specializes in a finding category. Control: a **spot-check of "dismissed-by-Claude-but-later-accepted-by-human" findings per arm** quantifies residual author bias; if it correlates with arm, flag and correct. Human-verify remains the backstop.

**M4 — migration spec.** `stage_type` text + CHECK (`plan|audit-plan|audit-code`) on `audit_pass_stats` + the assignment grain; historical rows backfill to `audit-code`; idempotent; index (arm, stage_type). `arm` column on `audit_findings`: nullable, CHECK (A|B|C), indexed. `phase`/`prompt_variant`/`attempt` on the assignment grain.

**M5 — record the arm-order RNG seed** on the assignment row (replay); randomization is independent of per-arm spend reservations. Finer detail (rate-limit/cache) defers to implementation.

**M6 — recall cluster rule.** Over **(assignment × within-assignment canonical cluster)** (same unit as the score — Gemini R1): `recall(arm) = |(assignment,cluster) pairs this arm reached with an ACCEPTED finding| / |all accepted (assignment,cluster) pairs, prospective|`. A **dismissed** finding doesn't count as caught; severity = the cluster's adjudicated severity; intra-arm duplicates within an assignment count once.

**L1 — CLI edge cases deferred to implementation** (reuse existing graceful-degradation: cloud-off no-op, missing-migration preflight refusal, no-assignments → `collecting`, pending → `awaiting-adjudication` — the decision rule already models these states).

---

## 4. Plan-audit R2 resolutions

R2 = **H:4 M:4 L:1** (HIGH 7→4). Two were self-inflicted doc contradictions (fixed inline — Phases + Open-decisions now match §3). The rest:

**R2-H1 — attribution fails CLOSED.** `attributeStageToArms` must NOT map a bare `gemini`/`gpt-round` finding to A/B/C by stage — those stages are arm-specific, so a **null `arm` on them is a DATA ERROR** (throw/flag, never silently derive). Only `oss-gen` (shared) and `gpt-gen` (A-only) derive from stage. Rule: `arm-specific stage + null arm ⇒ hard error`; `shared stage ⇒ derive`. (Mirrors the v1 fail-closed `attributeStageToArms` guard.)

**R2-H2 — Response Healing OFF during the burn-in.** The clean way to measure *native* conformance is to not heal at all: the harness runs with OpenRouter Response Healing **disabled**, so the response we parse **is** the model's native output (conformance = did *that* parse+validate). Healing is a separate *operational* lever evaluated outside the experiment (record `healing_available` in the runbook, not per-run). Drops the "capture pre-healing" complexity entirely.

**R2-H4 — execution DAG (GPT round stays INDEPENDENT — Gemini R1).** The generation stages `oss-gen`, `gpt-round`, `gpt-gen` are **mutually independent** — each audits the SAME redacted code on its own; `gpt-round` is NOT fed `oss-gen`'s output (it must contribute GPT's *own* diverse catches, not arbitrate OSS's list — the diversity thesis; anchoring it would bias the experiment). Only the review stages depend on their arm's upstream findings: `A-gemini` reviews `gpt-gen`; `B-gemini` reviews `oss-gen`+`gpt-round`; `C-gemini` reviews `oss-gen`. So the DAG is: `{oss-gen ∥ gpt-round ∥ gpt-gen}` → per-arm `gemini`. **Shared-stage handling (simplified — Gemini R1 over-eng flag)**: `oss-gen` is computed **once per assignment and reused in-memory** for B's and C's `gemini` inputs — no persistent keyed cache, no input digest (the whole assignment runs in one process; `assignment_id` already varies on attempt/variant). Findings stored once, cost charged once (M1). **Arm-order randomization (D10)** applies only to the independent generation units within an assignment.

**R2-M2 — name the grain.** `assignment_id` + `stage_type` + `phase` + `prompt_variant` + `attempt` + `seed` live on **`audit_runs`** (each arm-run is one `audit_runs` row; the 3 arm-runs of an assignment share `assignment_id`). FK path: `audit_runs.assignment_id` groups → `audit_findings.run_id` / `audit_pass_stats.run_id` / `model_ab_spend_ledger.run_id` → `model_ab_effectiveness` view. No new assignments table; `assignment_id` is the grouping key on the existing run grain.

**R2-M3 — executable score (closed form).** Scoring unit = **(assignment × within-assignment canonical cluster)** (Gemini R1 — NOT the global canonical cluster: `finding_equivalence` is semantic-global, so a bug recurring in two assignments is TWO detection events; dedup is cross-ARM *within* an assignment, never cross-assignment). Within an assignment an arm gets credit ONCE per accepted cluster it reached, at that cluster's adjudicated severity + BEST qualMult among its findings; then SUM across prospective + default assignments. Per arm:
```
armScore = Σ_accepted_clusters [ sevW(c) × qualMult(c) ]
         + α × Σ_unique_clusters [ sevW(c) ]     # unique = only this arm reached the cluster
         − λ × Σ_dismissed_findings [ 1 ]         # each FP = 1 LOW-equiv (findings, not clusters)
         − regPen × Σ_regressed_clusters [ 1 ]
  sevW: LOW 1 / MED 3 / HIGH 8 / CRIT 15   (c = the cluster's adjudicated severity)
  qualMult(c): verified 1.0 / fixed-unverified 0.6 / accepted-pending 0.5 / quick-fix ×0.4  (best across the cluster's findings)
  α=0.35, λ=1.0, regPen=8   (calibrate-then-freeze — §3 H3)
```
(Dismissed FPs stay per-*finding* — noise is noise regardless of clustering.)
Reported ALONGSIDE (never divided in): `recall` (M6), `€ standalone`, `€/accepted-weighted`, `€/accepted-HIGH` (D7). Gate (D5) precedes ranking: conformance ≥ floor, no egress violation, accepted-precision ≥ 0.30.

**R2-M4 — sentinels, not pinned ids.** Arm auditor models resolve through **sentinels** (`latest-gpt`, `latest-oss-reasoner`→deepseek-v4-pro, `latest-pro`) — the concrete ids in this doc are documentation of what they currently resolve to, not pins in code. The **adjudicator** ("Claude Opus 4.8") is the *coding agent / human*, not a resolved API model — it is descriptive, carries no `resolveModel` pin.

**R2-L1 — spot-check protocol** (author-bias, M3): deferred to the runbook with concrete params (stratify by arm; ≥10 dismissed-then-human-accepted samples per arm before drawing a bias conclusion; a per-arm correlation flags, doesn't auto-correct the leaderboard). Low; process not code.

---

## 5. Plan-audit R3 resolutions + STOP decision

R3 = **H:4 M:2** — HIGH **plateaued** (R2 also 4), which is the GPT-round stop signal (plan cap = 3 rounds; continue only while HIGH actively drops). 3 of the 4 R3-HIGHs were **self-inflicted doc drift** from the incremental §3/§4 additions (now fixed inline); 2 were genuine and refined:

- **R3-H1 (genuine)** — score now sums over **canonical clusters**, not findings (§4 R2-M3 updated), so a multi-stage arm can't double-count one bug; aligned with recall's unit.
- **R3-H4 (superseded by Gemini R1)** — the input-digest cache was over-engineered; shared `oss-gen` is just **compute-once-reuse-in-memory** within the assignment's single process run (§4 R2-H4 corrected). No persistent cache.
- **R3-H3 (consistency)** — D4 + §3-M2 reconciled to §4 R2-H2: Response Healing **OFF**, no `healing_invoked` column.
- **R3-M1 (consistency)** — migration row now puts the assignment-grain fields on **`audit_runs`** (single source), `stage_type` inherits via `run_id`.
- **R3-H2 / M2 (consistency)** — Open-decisions clarified (constants are calibrate-then-freeze, only the calibration-set *build timing* is open); the view exposes **standalone per-arm cost** + a separate **run-level actual burn** (shared counted once).

**STOP GPT rounds here** (round 3, HIGH plateaued, remaining were consistency + spec-completeness — the latter is the code-audit's job at `/cycle` time, not the plan gate's). → mandatory Gemini final gate.

---

## 6. Gemini final-gate R1 resolutions

Gemini R1 = `CONCERNS`, 4 findings — all valid; it caught real incoherence my incremental GPT-round edits introduced:

- **DAG error (MED, genuine)** — "`oss-gen` feeds `gpt-round`" wrongly anchored the GPT round; it must be **independent** (diversity thesis). §4 R2-H4 corrected: `{oss-gen ∥ gpt-round ∥ gpt-gen}` all independent on the code; only `gemini` reviews per-arm upstream.
- **MIN_ASSIGNMENTS regression (MED, genuine)** — counting distinct `assignment_id` (includes `attempt`) would let 20 reruns of one commit pass the diversity floor (the v1 bug, re-introduced). Fixed: count distinct **(commit_sha × stage_type)** = distinct code.
- **Scoring unit (HIGH, genuine)** — global canonical clusters under-count recurring bugs across assignments. Fixed: unit = **(assignment × within-assignment cluster)**; dedup cross-arm within an assignment only.
- **Over-engineered cache (LOW + over_engineering flag)** — the input-digest cache was unnecessary; simplified to **compute-once-reuse-in-memory** within the assignment run.

All fixes made the design both more correct AND simpler (the over-eng flag). → re-run Gemini (round 2, the cap).

---

## 7. Gemini final-gate R2 — STOP at cap (implementation-completeness tail)

Gemini R2 = `CONCERNS`, 4 findings (3 MED, 1 LOW) — but **all implementation-completeness, zero concrete design defects**. Per the 2-round Gemini cap, this is the STOP signal (R1 fixed the design bugs; R2 is the diminishing-returns tail whose items belong to the **code audit** at `/cycle` build time, which verifies them against real code — the right artifact, not the plan gate). Captured as implementation-notes for the code-audit:

- **run_id ↔ arm grain** (MED): resolve at implementation against the real `audit_runs` write path — either each arm-run is its own `audit_runs` row (grouped by `assignment_id`) OR one row per assignment with `arm` discriminating findings/pass_stats. Pick whichever the existing shadow write path supports cleanly; the view reads `assignment_id` + `arm` regardless.
- **where the two-level gate runs** (MED): the gate (conformance/egress/precision-floor) is enforced in `model-ab-decision.mjs` (already listed) — it filters arms BEFORE ranking; the view exposes the raw inputs, the decision module applies the gate.
- **Arm-B gemini input assembly** (MED): B's `gemini` reviews the **canonical-deduped union** of `oss-gen`+`gpt-round` (same within-assignment cluster rule as scoring), so duplicated cross-stage findings aren't double-fed.
- **prompt-variant → prompts mapping** (LOW): the prompt-sensitivity probe's `probe-A`/`probe-B` variants map to alternate phrasings of the pass prompts; the selection mechanism (a variant→prompt-set map read by the shadow) is a runbook + implementation detail, not a plan-gate concern.

**Audit-plan COMPLETE**: GPT R1–R3 (H:7→4→4 plateau, stopped at the 3-round cap) + Gemini R1 (4 design fixes) → R2 (`CONCERNS` = completeness-only, stopped at the 2-round cap). Design is sound; the residual is implementation-completeness for the code audit. Ready to build.

---

## 7. File-Level Plan (delta on v1)

| File | Action | Purpose |
|---|---|---|
| `scripts/lib/audit-arms.mjs` | modify | Re-point `CANONICAL_ARMS` compositions (D1); update `stagesForArm`/`attributeStageToArms` provenance (A={gpt-gen,gemini}, B={oss-gen,gpt-round,gemini}, C={oss-gen,gemini}). |
| `scripts/lib/model-resolver.mjs` | modify | Point `latest-oss-reasoner` → `deepseek/deepseek-v4-pro` (D4, verified id); keep GLM/Flash as documented rotation/cost entries. |
| `scripts/lib/oss-structured-output.mjs` | modify | Pass OpenRouter's unified `reasoning:{effort}` param mapped from the pass's tier (D4a) so OSS runs at the SAME effort as the GPT passes; record requested effort + returned reasoning-token usage. |
| `scripts/lib/config.mjs` | modify | Single OSS key (already `openrouterApiKey`); OSS arm uses the reasoner sentinel. |
| `scripts/lib/model-pricing.mjs` | modify | Add `deepseek/deepseek-v4-pro` + `-flash` to `OSS_PRICING` (verified rates D4); keep FALLBACK-dominance invariant. |
| `supabase/migrations/<ts>_model_ab_v2.sql` | **create** | **`audit_runs`** (the assignment/run grain — §4 R2-M2): `assignment_id`, `stage_type` (CHECK plan\|audit-plan\|audit-code, backfill audit-code — M4), `phase` (calibration\|prospective), `prompt_variant`, `attempt`, arm-order `seed`. **`audit_findings`**: nullable `arm` (CHECK A\|B\|C, arm-specific stages only — H1). (No `healing_invoked` — Response Healing is OFF, §4 R2-H2.) `stage_type` on pass_stats **inherits via `run_id`** (single source on `audit_runs`, not duplicated). `CREATE OR REPLACE VIEW model_ab_effectiveness` — hybrid arm attribution (explicit `arm` else stage-derive, fail-closed on null arm-specific — H1/§4 R2-H1), per-`(arm × stage_type)` quality-tier counts (`remediationState`/`is_quick_fix` — H4), recall over canonical clusters (M6), **standalone** per-arm cost (shared counted per-arm) + a separate run-level **actual burn** column (shared counted once — M1/§4 R2-M2); filterable `phase`/`prompt_variant`. Idempotent; trailing-column adds only. |
| `scripts/lib/model-ab-decision.mjs` | modify | Two-level rule (D5): quality gate → weighted-quality rank (D6 tiers + severity weights); add `recall` (D8/M6); emit the **cost–quality frontier** + `€/accepted-weighted` + `€/accepted-HIGH` (D7). Constants frozen-after-calibration (H3); headline ranking FILTERS `phase='prospective'` + `prompt_variant='default'`; `MIN_ASSIGNMENTS` = distinct **(commit_sha × stage_type)** = distinct code, NOT `assignment_id` (Gemini R1); score/recall unit = (assignment × within-assignment cluster). |
| `scripts/lib/store/model-ab.mjs` | modify | Adjudication captures the richer outcome (quality tier derived from `is_quick_fix` + `remediationState`); `stage_type` on the pass-stat writes. |
| `scripts/lib/audit-shadow.mjs` | modify | Randomize arm order per assignment + record the seed (D10/M5); stamp `stage_type='audit-code'` (v2 scope — H6), `arm` on arm-specific-stage findings (gemini/gpt-round — H1), transport + requested-reasoning-effort (D4a) metadata; assign the `assignment_id` (H5). |
| `scripts/cross-skill.mjs` | modify | `model-ab-stats` renders the cost–quality frontier + efficiency headlines; `model-ab-decision` applies the two-level rule; adjudication unchanged. |
| `docs/model-ab-experiment.md` | modify | Runbook: v2 arm table, single-OSS-key setup, DeepSeek pick + verify step, two-phase burn-in, prompt-sensitivity probe, the frontier metrics, the quality tiers. |
| `tests/*` | modify/create | Update arm-composition + decision tests for the two-level rule, recall, quality tiers, frontier; egress/shadow tests unchanged. |

### 7b. Implementation Phases

1. **Arms + OSS model + config + reasoning parity** (D1, D3, D4, D4a) — re-point compositions, DeepSeek-Pro sentinel, single OSS key, OSS reasoning-effort param. Files: `scripts/lib/audit-arms.mjs` (modify), `scripts/lib/model-resolver.mjs` (modify), `scripts/lib/oss-structured-output.mjs` (modify), `scripts/lib/config.mjs` (modify), `scripts/lib/model-pricing.mjs` (modify), `tests/audit-arms.test.mjs` (modify).
2. **Schema + scorer** (D5–D9, H1/H3–H7, M1–M6) — migration (arm/stage_type/assignment-grain cols + hybrid-attribution view + quality-tier + recall + cost), two-level decision rule (gate → weighted-quality over canonical clusters), frontier reporting. Files: `supabase/migrations/<ts>_model_ab_v2.sql` (create), `scripts/lib/store/model-ab.mjs` (modify), `scripts/lib/store/runs-findings.mjs` (modify), `scripts/lib/model-ab-decision.mjs` (modify), `scripts/cross-skill.mjs` (modify), `tests/model-ab-decision.test.mjs` (modify).
3. **Shadow wiring + controls** (D9, D10, §4 R2-H4, §6, §7) — execution DAG (independent gen stages + in-memory shared `oss-gen`), arm-order randomization of independent units + seed, `stage_type='audit-code'` (v2 scope — **no** plan/audit-plan hooks; v2.1), `arm`/transport/reasoning metadata, `assignment_id`. Files: `scripts/lib/audit-shadow.mjs` (modify), `tests/audit-shadow.test.mjs` (modify).
4. **Runbook + burn-in process** (D10) — two-phase (calibrate→freeze→prospective) + prompt-probe + spot-check protocol. Files: `docs/model-ab-experiment.md` (modify).
5. **Close-out** (not a cluster phase) — `npm test` + `setup-postgres --migrate`/`--check-drift`; then the empirical calibration run.

### 11. Execution Clustering

- **Cluster A** — Phases 1–2 — fix-gate: yes
  - Coupling: the arm compositions + **fail-closed attribution** + reasoning parity (Phase 1) DEFINE the stages/provenance and the canonical-cluster unit that the migration's `model_ab_effectiveness` view + the `model-ab-decision` scorer (Phase 2) derive arm membership and score from — one seam (the view's stage→arm derivation and the score/recall unit MUST match `attributeStageToArms` + the within-assignment-cluster rule). Safety-adjacent (the € spend cap + native-conformance + OSS egress live here) → must converge before the shadow that spends is wired.
- **Cluster B** — Phases 3–4 — fix-gate: final
  - Coupling: the generation shadow (Phase 3 — DAG, arm-order, `assignment_id`, `arm`/transport/reasoning metadata, in-memory shared `oss-gen`) produces the per-`(assignment × arm × stage)` rows the Cluster-A scorer consumes; its attribution/bucketing must match the Cluster-A view contract. The runbook (Phase 4) documents the two-phase burn-in + prompt-probe + spot-check the shadow implements. Last cluster; gated by the consolidated Gemini pass.
- **Final gate**: mandatory consolidated Gemini review over the union diff of A ∪ B.

---

## Out of Scope (Future)

- **v2.1 — plan + audit-plan stage-type hooks** (H6): v2 ships the `stage_type` column and populates `audit-code`; wiring the plan / audit-plan entry points (arm mapping, redaction, storage for those round types) is deferred. Independence: the audit-code comparison doesn't depend on it.
- **v3 — live auto-router** (act-on-winner).
- Per-arm OpenRouter keys (only if B-vs-C cost isolation is later wanted; they share the OSS compute).
- Self-hosting OSS; reasoning-effort ablation (known-dead end).

## Open decisions for `/audit-plan` / operator

- The scoring constants (§4 R2-M3 formula: severity weights, quick-fix discount, regression penalty, α, λ, precision floor) are **calibrated on the calibration set, then FROZEN before the prospective run** (§3 H3) — *not* tuned on the prospective data. The values in §3/§4 are the starting point for that calibration.
- Whether the calibration set (D10) is built now or after the first prospective batch (the only genuinely-open sequencing choice; the constants themselves are calibrate-then-freeze, not open-ended).

---

## Implementation Log

### 2026-07-01 — built via `/cycle code --autonomous` (2 clusters)

- **Completed**: all of §7b Phases 1–4.
  - **Phase 1** — `CANONICAL_ARMS` re-pointed to the v2 compositions; `attributeStageToArms` rewritten to the hybrid fail-closed model (`SHARED_STAGES`/`ARM_SPECIFIC_STAGES`/`ARM_IDS`); `latest-oss-reasoner`→`deepseek/deepseek-v4-pro` (pool head; -flash env-only, never auto-selected); `OSS_PRICING` + `deepseek-v4-{pro,flash}`; `ossStructuredCall` forwards OpenRouter `reasoning:{effort}` + echoes `requestedReasoningEffort`; `config.PASS_REASONING` added as the parity SSoT.
  - **Phase 2** — migration `20260701140000_model_ab_v2.sql` (assignment grain on `audit_runs`; `audit_findings.arm`+`is_quick_fix` + fail-closed CHECKs NOT VALID; `audit_pass_stats.arm` + widened unique grain; `model_ab_attribute_arms` SQL function; `model_ab_effectiveness` hybrid CREATE OR REPLACE; new `model_ab_finding_scores` + `model_ab_arm_cost` views). `store/model-ab.mjs` (REQUIRED_SCHEMA, `ensureArmSet(2)`, activeTtlMs validation, spend-cap COALESCE hardening, `getModelAbFindingScores`/`getModelAbArmCost`); `store/runs-findings.mjs` (arm/is_quick_fix + assignment-grain writes). `model-ab-decision.mjs` fully rewritten (two-level gate→rank, canonical clusters, recall, €-frontier, calibrate-then-freeze `DECISION_CONSTANTS`). `cross-skill.mjs` stats/decision re-pointed.
  - **Phase 3** — `audit-shadow.mjs` v2 DAG (independent gen units, arm-order seeded shuffle, per-arm gemini with deduped upstream, `_arm` stamping, assignment grain, reasoning parity forwarding).
  - **Phase 4** — `docs/model-ab-experiment.md` rewritten for v2.
- **Deviations from plan**:
  - Migration timestamp `20260701140000` (plan wrote `<ts>`).
  - Added `is_quick_fix` as a persisted `audit_findings` column (the plan's quality tier reads it, but v1 only had it on the finding object) — a trailing-column add, consistent with H4.
  - Added `audit_pass_stats.arm` (not spelled out in §7) — required so per-arm B-gemini vs C-gemini cost splits (D7/M1); the v1 unique grain was widened to include it.
  - `assignment_id` is left to the view's `COALESCE(assignment_id, commit_sha, run_id)` for the default (attempt 1, default variant) case rather than a composite — commit_sha is the natural assignment key; setting a composite would have required editing the out-of-cluster `openai-audit.mjs` call site.
  - Zero-finding assignments are counted by unioning cost/pass-stats rows into `distinctCodeUnits` (cost rows exist even for zero-finding runs) — a cleaner fix than the documented v2.1 deferral.
- **Remaining (operator)**: calibrate the frozen constants on a known-bug set, then run the prospective burn-in (`AUDIT_MODEL_SHADOW=B,C` + budget). v2.1 (plan/audit-plan hooks) + v3 (live auto-router) still deferred.
