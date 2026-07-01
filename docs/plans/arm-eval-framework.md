# Plan: Unified arm-evaluation framework (blinded Claude-judge, human-anchored)

- **Date**: 2026-07-01
- **Status**: Approved — audit-plan converged. GPT R1–R3 (H:6→5→6 plateau, all schema-precision/completeness → folded into §10). Gemini gate R1 (3 genuine: contracts) → R2 (3 genuine: survivorship bias, tie-unprovable self-consistency, 1:many join key) → R3 (0 HIGH; 2 MED/2 LOW methodology+completeness tail → STOP, verified by the code-audit at build time). Ready to build via `/cycle code --autonomous`.
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

1. **Judge context pack (grounds "coherence" + "intent-drift" as rubric dimensions).** The blinded judge is handed the repo's intent artifacts as context — `docs/architecture-map.md` (symbol index), `.audit-loop/domain-map.json` (**both `allowedDeps` — domain relationships — AND the `rules` glob array**, so the judge can classify a plan's proposed NEW file paths into their domains *before* judging layer violations; Gemini-R2 fix: `allowedDeps` alone can't assign new files to domains), and `.requirements/ledger.json` (de-facto invariants) — so it scores **architectural coherence** and **drift-from-repo-intent** against the *actual* intent, not vibes. Assembled by a bounded context builder (token-capped, same discipline as the audit brief).
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
| `supabase/migrations/20260701160000_arm_eval.sql` | create | The full §10.1 lifecycle: `arm_eval_sessions`/`_runs`/`_outputs`/`_judgments`/`_human_rankings`/`_crosschecks` + `arm_eval_leaderboard` view + `audit_runs.author_model`/`task_id`/`arm_eval_run_id` (nullable) + nullable `model_ab_spend_ledger.arm_eval_run_id`. RLS + repo_id per §10.1/§10.8. |
| `scripts/lib/store/arm-eval.mjs` | create | Persist sessions/runs/outputs/judgments/crosschecks + blinded human-ranking writeback; leaderboard reader. |
| `scripts/lib/arm-eval/plan-seed.mjs` | create | Shared plan-generation seed (factored from `/plan-*`) so the producer + interactive skill don't drift. |
| `scripts/cross-skill.mjs` | modify | `arm-eval-run` (produce+judge a task), `arm-eval-adjudicate` (blinded human spot-check), `arm-eval-stats`/`-decision`. |
| `docs/arm-eval.md` | create | Runbook: the three experiments, the judge controls, the two-phase burn-in, the spot-check protocol. |
| `tests/*` | create | experiments/validator, judge orchestration (deps-injected — blinding, order-randomization, double-pass), decision/leaderboard. |

### 7b. Implementation Phases

1. **Arm-configs + rubric + self-preference validator** (D1/D2, §10.2). Files: `scripts/lib/arm-eval/experiments.mjs` (create), `tests/arm-eval-experiments.test.mjs` (create).
2. **Judge engine + intent-context pack** (D2/D8, §2, §10.3–§10.4). Files: `scripts/lib/arm-eval/judge.mjs` (create), `scripts/lib/arm-eval/intent-context.mjs` (create), `tests/arm-eval-judge.test.mjs` (create).
3. **Schema + store** (D6, §5, §10.1). Files: `supabase/migrations/20260701160000_arm_eval.sql` (create), `scripts/lib/store/arm-eval.mjs` (create), `tests/arm-eval-store.test.mjs` (create).
4. **Decision + leaderboard** (D2/D3, §10.3, §10.5). Files: `scripts/lib/arm-eval/decision.mjs` (create), `tests/arm-eval-decision.test.mjs` (create).
5. **Producers + cross-checks** (D3/D4/D8, §10.2, §10.5, §10.9). Files: `scripts/lib/arm-eval/cross-checks.mjs` (create), `scripts/lib/arm-eval/producers/plan.mjs` (create), `scripts/lib/arm-eval/producers/brainstorm.mjs` (create), `scripts/lib/arm-eval/plan-seed.mjs` (create), `tests/arm-eval-producers.test.mjs` (create).
6. **Cross-skill CLIs** (§6). Files: `scripts/cross-skill.mjs` (modify).
7. **Runbook** (D10). Files: `docs/arm-eval.md` (create).
8. **Close-out** (not a cluster phase): `npm test` + `node scripts/setup-postgres.mjs --migrate`/`--check-drift`.

## 11. Execution Clustering

- **Cluster A** — Phases 1–4 — fix-gate: yes
  - Coupling: the arm-config + rubric + **self-preference validator** (Phase 1) define the arms/rubric the judge (Phase 2) consumes; the judge's blinded/order-randomized/double-pass output grain + the intent-context pack are the exact rows the schema (Phase 3) persists and the decision/leaderboard (Phase 4) scores — one seam (the judge output shape, the persisted grain, and the decision's gate inputs MUST match). INTEGRITY-critical (self-preference guard + judge blinding + spend cap + egress governance live here) → must converge before the producers that actually spend are wired.
- **Cluster B** — Phases 5–7 — fix-gate: final
  - Coupling: the producers + cross-checks (Phase 5) generate the per-(session × arm) outputs the Cluster-A judge/schema/decision consume; their egress + persistence + arm-eval-run linkage must match the Cluster-A contract. The CLIs (Phase 6) orchestrate produce→judge→adjudicate→decide; the runbook (Phase 7) documents the two-phase burn-in + spot-check the CLIs implement. Last cluster; gated by the consolidated Gemini pass.
- **Final gate**: mandatory consolidated Gemini review over the union diff of A ∪ B.

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

## 10. Contracts & hardening (resolves audit-plan R1)

### 10.1 Persistence lifecycle (H1/R2 — full data model with the SESSION grain)
Normalize the whole lifecycle (all additive, idempotent, `public`-only, RLS mirroring the auditor tables). The **session** is the load-bearing grain the R1 schema missed — it groups ALL arms' outputs for one task so the judge ranks the *set* and the human anchor is computable:
- `arm_eval_sessions` — `session_id` (PK), `experiment_type`, `task_id`, `phase`, `config_version`, `rubric_version`, `seed` (blinded presentation-order RNG), `created_at`. One row per (experiment × task × phase × config); the batch the judge sees together.
- `arm_eval_runs` — `run_id` (PK), `session_id` FK, `arm`, `resolved_model` jsonb (**the concrete provider/model/version/pricing resolved AT RUN TIME** — R2: sentinels resolve to different concretes over time, so persist the snapshot for reproducibility), `context_pack_hash`, `budget_lease_id`, `created_at`.
- `arm_eval_outputs` — `run_id` FK, `output_hash`, `output_ref`, `producer_conformant`, `normalized`.
- `arm_eval_judgments` — `run_id`/`output_hash` FK, per-dimension scores jsonb, `judge_pass` (1|2), `presentation_order`, `rubric_version`.
- `arm_eval_human_rankings` — `session_id` FK, `ranked_arms` (ordered array), `reviewer`, `created_at` — R2: the human anchor is a RANKING per session (Kendall τ needs ordered sets), NOT a nullable per-item verdict. Claude's blinded ranking is likewise derived per session.
- `arm_eval_crosschecks` — `run_id` FK, `check_name`, `check_version`, `status`, `score`/`load`, `findings` jsonb, `evidence_refs`, `failure_reason`.
- Unique index `(session_id, arm)`; leaderboard indexes on `(experiment_type, arm)`.
- **Spend integration (R2 — don't break existing rows):** do NOT add a NOT-NULL FK to `model_ab_spend_ledger`. Add a **nullable** `arm_eval_run_id` column (existing auditor rows stay null, no backfill, no constraint violation); the lease linkage is by that nullable column only.

### 10.2 Producer contract (H2)
`produce({ runId, experimentType, task, armConfig, contextPack, budgetLease }) -> { output, outputHash, usage, conformant, error }`. Per-experiment protocol is FIXED + versioned:
- **plan**: shared plan seed (`plan-seed.mjs`) + task → one model call per author; the model IS the author (no Claude synthesis step — that would contaminate).
- **brainstorm**: the two arm models each answer the topic, then a FIXED, model-neutral synthesis prompt (run by the *arm's own* first model, not Claude) merges them into the arm's take — so Claude never authors an arm's output.
Conformance = non-empty, well-formed artifact of the expected type; a malformed output is `conformant:false` (disqualified before quality scoring), never silently scored.

### 10.3 Decision contract (H3 — concrete metrics + thresholds + human anchor)
- **Self-consistency** = per-dimension mean absolute delta between the two judge passes; arm-level = mean over dimensions. **Floor is ABSOLUTE**: consistency-delta ≤ 0.75 (on the 1–5 scale) → breach = `not-credible` (no verdict). (Gemini-gate fix: the floor is NOT relative to the between-arm spread — a `< spread` gate would make a genuine near-TIE unprovable, since a tiny spread becomes an impossible threshold. The signal-vs-noise comparison "is between-arm spread > consistency-delta?" is reported as an ADVISORY confidence note, never a gate that blocks a tie verdict — a credible tie is a valid result.)
- **Human-agreement** = rank-correlation (Kendall τ) between Claude's blinded ranking and the human spot-check ranking. **Floor**: τ ≥ 0.6 over **≥ 8 spot-checked tasks** stratified across arms; below → `unanchored` (report, no verdict). (Gemini-R3 note: with only ~3 arms a single task's τ is coarse, so the anchor ACCUMULATES across the ≥8 tasks — report the mean τ AND the fraction of tasks where Claude's top-pick matches the human's; treat τ as directional, not a precise per-task statistic.)
- **Ranking**: paired per-task deltas vs the baseline arm (not absolute means — controls task difficulty); frozen dimension weights (calibrated then frozen); `unscored` dimensions excluded from that task's mean, never zero-filled. Report per-arm profile + CI; the OSS-vs-baseline verdict states its confidence tier (§9).

### 10.4 Shared LLM-call executor + egress governance (H4, H5)
All producers + the judge route through ONE executor that: (a) takes a **budget lease** (reserve-then-reconcile on `model_ab_spend_ledger`) before each call and reconciles actual usage; (b) uses idempotency keys (`run_id`×call) for crash-safe resume; (c) bounded retry/timeout via the existing `classifyLlmError` policy; (d) treats malformed structured output as a conformance miss, not a crash. **Egress**: every outbound payload passes the existing `assertEgressSafe` / redact-once path + a provider allowlist; the intent-context builder + producers emit a **context manifest** (what was sent, to which provider, redaction applied) persisted per run. Reuses the auditor harness's egress + spend seams verbatim — no new secret-egress surface.

### 10.5 CrossCheck contract (H6)
`CrossCheck.run(planRef, ctx) -> { checkName, checkVersion, status, score|load, findings[], evidenceRefs, confidence, failureReason }`, persisted to `arm_eval_crosschecks`. "Disagrees sharply" = the cross-check's arm ranking inverts the rubric's top-2 → a `flag` (surface for human inspection), never an auto-override. Each check declares typed failure modes (missing artifact → `unavailable`, not silent pass).

### 10.6 Resolver aliases + rotation discipline (M — no time-confound)
Models route through the resolver via LOGICAL aliases — `latest-oss-reasoner-primary` (GLM-5.2), `latest-oss-reasoner-cost` (DeepSeek-v4-pro), `latest-oss-reasoner-alt` (Qwen3.7-max) — never pinned ids. **Rotation is NOT interleaved with time**: a rotation is a distinct frozen arm run over the SAME task set + frozen config, so OSS-model choice never confounds with task mix / calibration drift. Prefer running the OSS candidates as parallel co-arms in one pass over sequential rotation when budget allows.

### 10.7 Task-set manifest + blinding-leak control (M)
- **Manifest** (`arm-eval-tasks.<experiment>.json`, versioned, committed): each task = `{ id, canonical_text_hash (whitespace/case-normalized), source, domain_tags, difficulty, artifact_type, egress_class }`. Diversity floor counts distinct canonical hashes from the frozen manifest.
- **Blinding-leak**: producer prompts forbid self-identification; a pre-judge normalization pass strips provider/model boilerplate + scans for model names (reject/sanitize on hit); length/format normalized so verbosity/style can't proxy identity.

### 10.9 Audit-proxy data flow (R2 — explicit linkage)
For the plan experiment's objective cross-check: the plan producer, after generating arm P's plan, invokes the FIXED production `/audit-plan` on it, creating an `audit_runs` row stamped `author_model` + `task_id` + a **nullable `arm_eval_run_id`** column (added by this migration to `audit_runs`; null for all non-arm-eval audits). The accepted-weighted defect load is joined **1:1 by `arm_eval_run_id`** (Gemini-gate R2 fix: a session groups ALL arms → multiple plans → multiple `audit_runs` per session, so `session_id` is 1:MANY and can't map an audit back to a specific arm; `arm_eval_run_id` = the unique (session × arm) execution, giving a true 1:1) from `audit_runs`/`model_ab_finding_scores` back to that arm's run, and mirrored into `arm_eval_crosschecks` (check_name=`audit-proxy`) so the leaderboard reads one surface. The audit runs at a FIXED auditor config (same for all arms) — recorded in `resolved_model` so a mid-experiment auditor change is detectable.

### 10.8 Migration governance + test enumeration (M)
Migration declares PKs, FKs, unique + leaderboard indexes, RLS (deny-all + owner-bypass, mirroring `security_incidents`), nullable/backfill for `audit_runs.author_model`/`task_id`/`arm_eval_run_id`, and a `setup-postgres --check-drift` pass. **Tests follow the project testing doctrine (AGENTS.md) — do NOT mock the whole provider SDK** (that tests the mock + masks SDK/schema drift): inject the model-call SEAM (`deps.callModel`/`callGemini`, as the audit-shadow tests already do) for orchestration invariants, and use **HTTP-level interception** (`undici` MockAgent) for the SDK-boundary parse/conformance paths so the real SDK + Zod configs are exercised (Gemini-R2 fix). Coverage MUST include: schema idempotency, the no-Claude self-preference guard, budget reserve/reconcile + idempotent resume, malformed-output conformance-gate (not per-session drop), missing-context degradation (`unscored`), blinded+seeded presentation order, decision-gate floors (absolute self-consistency; tie-provable), and cross-check typing.

### 10.10 R3 hardening (final GPT round — cap reached; HIGH plateaued 6→5→6)
- **repo_id everywhere (genuine).** `arm_eval_sessions` (and thus all children via FK) carries `repo_id`, resolved via the same `resolveRepoForStore` identity every other table uses; leaderboard + RLS are repo-scoped. The store is multi-repo — omitting it was a real gap.
- **Cross-check linkage is RUN-scoped (genuine; refined in Gemini R2).** The audit-proxy join key is `arm_eval_run_id` (the unique (session × arm) execution) — NOT `session_id` (1:many: a session has one audit_run per arm) and NOT the non-unique `(author_model, task_id)`. The plan-audit `audit_runs` row records `arm_eval_run_id` for a true 1:1 join.
- **Human rankings are BLINDED labels + a separate unblind map (genuine).** The reviewer ranks opaque labels (`output-A/B/C`, order set by the session seed); `arm_eval_human_rankings.ranked_labels` stores that; the label→arm mapping is derived post-hoc from the seed (never shown to the reviewer). Kendall τ is computed after unblinding. This preserves blinding while making the anchor computable.
- **Malformed-output = conformance GATE + rate, NOT a silent per-session drop (Gemini-gate fix — survivorship bias).** Dropping a malformed output from just that session would CHERRY-PICK a flaky model's successes and flatter its quality. Instead, mirror the auditor harness's two-level rule: (1) track a per-arm **conformance rate** across the task set (every malformed output counts against it); (2) an arm whose conformance rate < floor is **disqualified from the leaderboard entirely** (Level-1 gate, before quality is ranked) — so a frequently-failing arm is penalized, never flattered. The quality mean is computed only over that arm's conformant sessions, but the conformance gate (not per-session exclusion) is what prevents the bias. Report conformance rate alongside every arm's score.
- **Logical aliases are registered.** `latest-oss-reasoner-{primary,cost,alt}` are added to the resolver's `SENTINEL_TO_TIER` (role: oss) resolving to GLM-5.2 / DeepSeek-v4-pro / Qwen3.7-max — real sentinels, not free-floating strings.
- **Plan artifact contract.** Generated plans MUST include the machine-readable intent block the repo already uses (target paths + a "Section 9 — Acceptance Criteria"-style stanza) so the cross-checks (arch-memory reuse, requirements-invariant) can parse intent + paths deterministically; a plan lacking it → the affected cross-check returns `unavailable` (never a fabricated pass).

**STOP GPT rounds (3-round cap + HIGH plateau 6→5→6).** R2/R3 findings were schema-precision + spec-completeness (all folded into §10), not design-invalidating — the diminishing-returns tail. → mandatory Gemini final gate.

## 9. Honest caveats + out of scope

- **Confidence tiers differ, and we state it.** The auditor verdict rests on real *accepted bugs* (hard). Plan/brainstorm verdicts rest on Claude-judge + human spot-check (softer) — so the spot-check anchor is mandatory there, and the reported verdict carries its confidence tier. We do not present a rubric-only ranking as equivalent to the auditor's bug-grounded one.
- **Measuring CLAUDE's own outputs is out of scope** — Claude can't judge itself; that needs a human or a different judge (a documented asymmetry). Hence Claude is judge-only, never an arm.
- **v-next**: acting on the winner (auto-selecting the production model per task type); outcome-based scoring (implement the plan, measure success); a frontend-plan authoring axis.
