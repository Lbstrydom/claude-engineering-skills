# Plan: Unified arm-evaluation framework (blinded Claude-judge, human-anchored)

- **Date**: 2026-07-01
- **Status**: Draft — ready for `/audit-plan`
- **Author**: Claude + Louis
- **Scope**: backend (`js-ts` + postgres; `node --test`). Generalises the shipped auditor harness (`docs/completed/model-ab-harness-v2.md`) into ONE evaluation framework that three experiments plug into.
- **Origin**: operator insight — the auditor harness already uses Claude as a **blinded, human-verifiable judge** (it adjudicates GPT/OSS/Gemini findings; the human verifies/overrides). Extend that exact pattern to two more experiments (plan authoring, brainstorm) so all three test ONE principle under ONE rigorous method.

---

## 1. The one principle, three experiments

Every experiment answers: **can an OSS combination beat the proprietary baseline?** They differ only in what the arms *produce* and what the baseline is:

| Experiment | Arms | Baseline | Output judged | Status |
|---|---|---|---|---|
| **Auditor** (built) | A=GPT+Gemini · B=OSS+GPT-round+Gemini · C=OSS+Gemini | A | findings | shipped (v2) |
| **Plan authoring** | GPT · **OSS** (GLM-5.2 default, DeepSeek/Qwen rotation) | GPT | a plan doc | this plan |
| **Brainstorm** | D=GPT+Gemini · E=**OSS**+Gemini · F=**OSS**+GPT | D | a synthesized take | this plan |

*"OSS" resolves to the primary OSS model (GLM-5.2 by default — §1a D0); the same arm re-runs with DeepSeek / Qwen via the rotation to compare OSS models directly. The user's original E=DeepSeek+Gemini / F=DeepSeek+GPT are the DeepSeek rotation of this.*

**Claude is NEVER an arm** — it is the constant judge across all three (so it never grades its own homework). This is what makes the unification honest: it mirrors the auditor harness, where Claude adjudicates and the human anchors.

### 1a — The OSS model is a first-class VARIABLE; GLM-5.2 is the evidence-based default (D0)

Don't hard-commit — but seed the default from the best current evidence, then let the burn-in settle it on our tasks. **Benchmark evidence (2026-07-01):** GLM-5.2 leads the open-weight pack on BOTH the Artificial-Analysis Intelligence Index (51.1) and SWE-bench Pro (62.1%); Qwen3.7 Max is second (46.0 / 60.6%); DeepSeek-V4-Pro trails on both (44.3 / ~55.4%, competitive only on SWE-bench Verified). **Live prices** (all ≪ the GPT-5.5 baseline $5/$30 per 1M, so all pass the cost gate): `z-ai/glm-5.2` $0.93/$3.00, `qwen/qwen3.7-max` $1.25/$3.75, `deepseek/deepseek-v4-pro` $0.43/$0.87.

- **Primary OSS default = GLM-5.2** (best quality on both benchmarks, still ~5–10× cheaper than baseline).
- **DeepSeek-V4-Pro = cost-optimized rotation** (cheapest; if it ties GLM on OUR tasks it wins the €-frontier).
- **Qwen3.7 Max = third candidate.**

No public benchmark directly measures code/plan *critique* — SWE-bench Pro (code) + reasoning are the best proxies, the Intelligence Index a reasonable aggregate; treat all as DIRECTIONAL (Verified≠Pro, vendor scaffolds differ). The harness measures the real thing on our tasks, so the benchmark only picks the starting default. All resolve through sentinels — no pinned ids. **Cost rule (operator):** never adopt an OSS arm pricier than the GPT baseline; all current candidates comply.

## 2. The core: a blinded, human-anchored judge engine (the "properly" part)

A single scoring engine every experiment reuses. Claude-as-judge is legitimate ONLY with these controls (an ungoverned LLM-judge is known-biased — verbosity, position, style, self-preference):

- **Blinded** — the judge never sees which model produced which output (reuse the blinded queue; arm identity hidden).
- **Order-randomized** — outputs presented in a randomized order per task (recorded seed) to kill position bias.
- **Fixed rubric** — structured per-dimension scores, not a gut number (see §4). Shared core dimensions + per-experiment extensions.
- **Self-consistency probe** — judge each output TWICE (or under two rubric phrasings); if intra-judge variance ≈ between-arm variance, the leaderboard is noise → no verdict until fixed (the auditor harness's prompt-probe analog).
- **Human spot-check anchor (load-bearing)** — a stratified sample of Claude's judgments is surfaced for human validation/override. If Claude-judge diverges from the human beyond a threshold, the verdict is flagged NOT credible. This is the ground-truth anchor; it is NOT optional for the plan/brainstorm experiments (their evidence is softer than the auditor's real accepted bugs — see §9).
- **Self-preference guard** — enforced structurally: Claude is not an arm in any experiment. A config that lists a Claude model as an arm is a hard error.

## 3. Design decisions

### D1 — Claude is the judge, arms are GPT/DeepSeek/Gemini combinations
Sentinels only (`latest-gpt`, `latest-oss-reasoner`, `latest-pro`), never pinned ids. Arm sets are DATA per experiment (mirroring `CANONICAL_ARMS`). A validator REFUSES any arm whose model resolves to a Claude family (self-preference guard).

### D2 — Rubric-based scoring, blinded + order-randomized + double-judged
Each output gets per-dimension integer scores (1–5) from the blinded judge, twice. Arm score = mean over dimensions over tasks (prospective + default only, mirroring the auditor headline filter). Report per-arm: rubric profile, self-consistency delta, human-agreement rate.

### D3 — Plan: Claude-judge PRIMARY + audit-proxy CROSS-CHECK (operator-chosen)
Plan quality's primary signal is the blinded Claude rubric-judge. As a FREE objective cross-check (we already have the auditor), each generated plan is also run through the FIXED production `/audit-plan`; its accepted-weighted defect load is reported ALONGSIDE the rubric score. If the two disagree sharply on an arm, that's a flag to inspect (not an auto-override). Claude is dropped as a plan author so judging is clean.

### D4 — Brainstorm: D/E/F combinations, Claude-judge only
Each arm is a two-model combination that produces a synthesized brainstorm take for a topic; Claude judges the takes blinded. No audit-proxy (a brainstorm isn't auditable). D (GPT+Gemini) is the baseline; E/F are the OSS combinations.

### D5 — Paired, diverse task set; distinct-task diversity floor
All arms run the SAME task/topic (paired). N = 12–25 diverse tasks. Diversity unit = distinct `task_id` (hash of the task text) — a rerun of one task can't fake diversity (the auditor harness's distinct-code rule, generalized).

### D6 — Reuse the auditor harness's plumbing
Spend ledger + reserve-then-reconcile €-cap, blinded adjudication queue, model sentinels, severity weights (for the audit-proxy), and the two-phase (calibrate→freeze→prospective) + spot-check protocol all carry over. New: the judge engine, the rubric, arm-eval schema, per-experiment output producers.

### D7 — Inert by default
Byte-identical to today unless explicitly enabled (per-experiment env flag + a budget). No generation, no judging, no spend otherwise — the auditor harness's opt-in invariant, generalized.

### D8 — Ground quality in the repo's OWN intent artifacts (coherence + drift + reuse)
Two ways existing repo-intelligence enriches the verdict beyond raw rubric opinion:

1. **Judge context pack (grounds "coherence" + "intent-drift" as rubric dimensions).** The blinded judge is handed the repo's intent artifacts as context — `docs/architecture-map.md` (symbol index), `.audit-loop/domain-map.json` `allowedDeps` (architectural intent), and `.requirements/ledger.json` (de-facto invariants) — so it scores **architectural coherence** and **drift-from-repo-intent** against the *actual* intent, not vibes. Assembled by a bounded context builder (token-capped, same discipline as the audit brief).
2. **Objective cross-checks (pluggable, reported ALONGSIDE the rubric — harder evidence).** For a *plan* we can already run, with no new LLM:
   - **audit-proxy** (D3) — the fixed `/audit-plan` accepted-defect load.
   - **arch-memory reuse check** — `cross-skill.mjs get-neighbourhood` on the plan's stated intent + target paths: does the plan REINVENT symbols that already exist (`reuse`/`extend` recommendations) instead of reusing them? A good plan reuses.
   - **requirements-invariant check** — does the plan contradict an `active` invariant in the ledger?
   - **security-incident check** — for security-touching plans, `get-incident-neighbourhood` flags a plan that re-treads a known incident class.

   **Outcome-tier (needs real code → deferred):** drift-score + layering-violations from the symbol index can't run on a plan document (no code yet); they belong to the implement-then-measure tier (out of scope here, §9). The judge-with-context approximates them at plan time.

The cross-check layer is **pluggable** — each experiment declares which checks apply (brainstorm: none objective; plan: all of the above; auditor: its own adjudication). A cross-check that disagrees sharply with the rubric is a **flag to inspect**, not an auto-override — the human spot-check remains the anchor.

## 4. Rubric (shared core + per-experiment extensions)

Shared core (all 1–5): **correctness/soundness**, **completeness**, **risk-handling**, **right-sizing** (no over/under-engineering), **clarity**, **architectural coherence**, **repo-intent fidelity** (drift from the domain-map/architecture-map/requirements — grounded by the D8 context pack).
- Plan extension: **implementability**, **acceptance-criteria quality**, **reuse** (extends existing symbols vs reinvents — cross-checked objectively by arch-memory, D8).
- Brainstorm extension: **insight/novelty**, **angle diversity**, **actionability**.
Rubric is DATA (per experiment) so dimensions can be tuned during calibration then frozen. The two intent dimensions are only meaningful when the D8 context pack is present; absent it, they degrade to `unscored` (never a fabricated score).

## 5. Schema (additive, idempotent)

- New table `arm_eval_judgments` — `(experiment_type, task_id, arm, output_hash, rubric_scores jsonb, judge_pass int, human_verdict, created_at)`. One row per (output × judge_pass); human_verdict null until spot-checked.
- New view `arm_eval_leaderboard` — per `(experiment_type, arm)`: mean rubric score, self-consistency delta, human-agreement rate, distinct tasks, + (plan only) the audit-proxy defect load joined from `audit_runs`/`model_ab_finding_scores`.
- Reuse `audit_runs` (`author_model`, `task_id`) for the plan audit-proxy runs; reuse `model_ab_spend_ledger` for all generation + judging spend under one cap.

## 6. File-Level Plan

| File | Action | Purpose |
|---|---|---|
| `scripts/lib/arm-eval/experiments.mjs` | create | Per-experiment arm-configs + rubric (DATA); self-preference validator (no Claude arm). |
| `scripts/lib/arm-eval/judge.mjs` | create | The blinded, order-randomized, double-pass rubric judge (Claude via anthropic-client); pure orchestration, deps-injected. |
| `scripts/lib/arm-eval/intent-context.mjs` | create | Bounded repo-intent context pack for the judge (D8): architecture-map + domain-map `allowedDeps` + requirements ledger; token-capped; degrades to absent (intent dimensions → `unscored`) when artifacts are missing. |
| `scripts/lib/arm-eval/cross-checks.mjs` | create | Pluggable objective cross-checks (D8): audit-proxy, arch-memory reuse (`get-neighbourhood`), requirements-invariant, security-incident. Per-experiment declares which apply; results reported alongside the rubric. |
| `scripts/lib/arm-eval/producers/plan.mjs` | create | Headless plan generation per author (shared plan seed) + runs the applicable cross-checks. |
| `scripts/lib/arm-eval/producers/brainstorm.mjs` | create | Per-arm two-model brainstorm combination → synthesized take. |
| `scripts/lib/arm-eval/decision.mjs` | create | Leaderboard + gate (self-consistency + human-agreement floor) → OSS-vs-baseline verdict, pure. |
| `supabase/migrations/<ts>_arm_eval.sql` | create | `arm_eval_judgments` + `arm_eval_leaderboard` + `audit_runs.author_model`/`task_id`. |
| `scripts/lib/store/arm-eval.mjs` | create | Persist judgments + spot-check writeback; leaderboard reader. |
| `scripts/cross-skill.mjs` | modify | `arm-eval-run` (produce+judge a task), `arm-eval-adjudicate` (blinded human spot-check), `arm-eval-stats`/`-decision`. |
| `docs/arm-eval.md` | create | Runbook: the three experiments, the judge controls, the two-phase burn-in, the spot-check protocol. |
| `tests/*` | create | experiments/validator, judge orchestration (deps-injected — blinding, order-randomization, double-pass), decision/leaderboard. |

## 7. Execution Clustering

- **Cluster A** — judge engine + experiments/rubric config + schema + decision/leaderboard — fix-gate: yes (the self-preference guard, spend cap, and judge-blinding are integrity-critical; converge first).
- **Cluster B** — the two producers (plan, brainstorm) + cross-skill CLIs + runbook — fix-gate: final.
- **Final gate**: mandatory consolidated Gemini review over A ∪ B.

## 8. Acceptance criteria

1. Arm-configs validate; a Claude-family arm is a hard error (self-preference guard).
2. The judge scores a set of arm outputs blinded (arm hidden), in a randomized recorded order, twice, on the fixed rubric.
3. Self-consistency delta + human-agreement rate are computed; the decision GATES the verdict when either breaches its floor (verdict flagged not-credible).
4. Plan experiment: each author's plan is rubric-judged (with the D8 repo-intent context pack grounding the coherence/intent dimensions) AND run through the objective cross-checks (audit-proxy + arch-memory reuse + requirements-invariant); all signals reported per arm. A missing intent artifact degrades that dimension to `unscored`, never a fabricated score.
4a. The OSS model is a variable: DeepSeek-v4-pro and GLM-5.2 both compete (co-arms or rotation); a Claude-family arm is rejected (self-preference guard).
5. Brainstorm D/E/F: each arm's take is rubric-judged; D is the baseline in the OSS-vs-baseline verdict.
6. Blinded human spot-check queue hides arm identity; human_verdict writes back and feeds the agreement rate.
7. Diversity floor counts distinct task_ids; spend bounded by the €-cap; fully inert unless enabled.
8. One bounded live run per experiment verifies the end-to-end path before declaring done.

## 9. Honest caveats + out of scope

- **Confidence tiers differ, and we state it.** The auditor verdict rests on real *accepted bugs* (hard). Plan/brainstorm verdicts rest on Claude-judge + human spot-check (softer) — so the spot-check anchor is mandatory there, and the reported verdict carries its confidence tier. We do not present a rubric-only ranking as equivalent to the auditor's bug-grounded one.
- **Measuring CLAUDE's own outputs is out of scope** — Claude can't judge itself; that needs a human or a different judge (a documented asymmetry). Hence Claude is judge-only, never an arm.
- **v-next**: acting on the winner (auto-selecting the production model per task type); outcome-based scoring (implement the plan, measure success); a frontend-plan authoring axis.
