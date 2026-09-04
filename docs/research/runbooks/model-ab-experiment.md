# Model-A/B/C auditor experiment — runbook (v2)

Operator guide for the funded (~€200–400) empirical burn-in that picks
**audit-pipeline configs from real human-adjudication data**, not model
self-opinion. Design + audit trail: [`docs/plans/model-ab-harness-v2.md`](../../plans/model-ab-harness-v2.md)
(v2 delta) over [`docs/plans/model-ab-experiment-harness.md`](../../plans/model-ab-experiment-harness.md) (v1).

> **What it is**: an observation-only *generation shadow* that generalizes the
> final-review shadow to the AUDIT GENERATION passes. When enabled it runs the
> baseline audit (arm A) as today AND, in parallel, spawns the OSS-composition
> arms (B, C) — recording per-arm findings, cost, and structured-output
> conformance. Nothing an arm produces ever gates or ships. Scorer views join
> per-arm findings to the human `adjudication_outcome`; a CLI applies a
> **two-level, pre-registered** rule: a quality GATE, then a weighted-quality
> RANK, with cost as a reported Pareto FRONTIER (never divided into the score).

## The three arms (v2 — audit-pipeline COMPOSITIONS)

Claude is the **constant coder + adjudicator** across all arms (NOT an auditor
arm — so blinded adjudication is defensible; author bias is uniform across arms
and cancels in the relative ranking). The variable is the **audit + review stack**:

| Arm | Composition | Question it answers |
|---|---|---|
| **A** | GPT audit → Gemini review | production control (run by the real audit, NOT the shadow) |
| **B** | OSS audit → **1 GPT round** → Gemini review | does the GPT round earn its keep? (vs C) |
| **C** | OSS audit → Gemini review | can OSS + Gemini **replace** GPT + Gemini? (vs A) |

`A vs C` = "can we drop GPT entirely?"; `B vs C` = "is the independent GPT round
pulling weight?". The GPT round in B is **independent** — it audits the SAME code
on its own, NOT fed the OSS findings (the diversity thesis).

Arms are **data** ([`scripts/lib/audit-arms.mjs`](../../../scripts/lib/audit-arms.mjs)
`CANONICAL_ARMS`) and reference **sentinels** (`latest-gpt`,
`latest-oss-reasoner`, `latest-pro`), never concrete ids — the resolver picks the
newest match. **Hybrid attribution** (v2): `oss-gen` (shared by B+C) and `gpt-gen`
(A) derive arm membership from `stage`; the **arm-specific** stages `gpt-round`
(B) and `gemini` (per-arm — A, B, C each run their own) carry an explicit `arm`
tag. A null arm on an arm-specific stage is a hard **data error** (fail-closed) —
never silently derived, in both the JS (`attributeStageToArms`) and the SQL
(`model_ab_attribute_arms` → `__INVALID__` sentinel, excluded from the score).

## OSS model — DeepSeek V4 Pro (verified) + reasoning parity

- **Model**: `latest-oss-reasoner` → **`deepseek/deepseek-v4-pro`** (the pool head
  in [`model-resolver.mjs`](../../../scripts/lib/model-resolver.mjs); 1M ctx,
  ~$0.435/$0.87 per 1M in/out). **Pro is FIXED for the burn-in** ("see what good
  quality buys"). `deepseek/deepseek-v4-flash` (~$0.098/$0.196) is a **manual**
  operator swap only (`OSS_REASONER_MODEL=deepseek/deepseek-v4-flash`), **never
  auto-selected**, so the "top-quality OSS vs frontier proprietary" comparison is
  never silently degraded.
- **Verify the id before spending**: `node scripts/lib/model-resolver.mjs resolve
  latest-oss-reasoner` (should print `deepseek/deepseek-v4-pro`). Confirm it lists
  on OpenRouter (`…/api/v1/models`) and check its **Tool-Call-Error-Rate** page.
- **Response Healing is OFF** during the burn-in — measure the model's *native*
  structured-output conformance. The response the harness parses **is** the native
  output; conformance = did *that* parse + Zod-validate. (Healing is a separate
  operational lever, evaluated outside the experiment.)
- **Reasoning PARITY** (a gross-confound control): the shadow feeds the SAME
  per-pass effort tier the production pipeline uses (`config.PASS_REASONING`:
  structure/wiring=low, backend/frontend=high, sustainability=medium) to BOTH the
  OSS adapter (OpenRouter's unified `reasoning:{effort}`) and the GPT round, and
  records the requested effort per pass. **Honest caveat**: cross-family "high" is
  not perfectly commensurable (GPT-high and DeepSeek-high spend different absolute
  compute) — this removes the *gross* confound (one at high, one at default) but
  not the residual "a tier means different things per family." That residual is a
  recorded, known limitation; if DeepSeek ignores the knob, that too is recorded.

## Prerequisites

1. **Cloud store** — `AUDIT_DB_URL` set (the shadow refuses to spend without
   persistence).
2. **Migration applied** — `node scripts/setup-postgres.mjs --migrate` then
   `--check-drift`. v2 adds the assignment grain (`audit_runs.assignment_id`,
   `stage_type`, `phase`, `prompt_variant`, `attempt`, `arm_order_seed`), the
   `audit_findings.arm` + `is_quick_fix` columns, `audit_pass_stats.arm`, the
   `model_ab_attribute_arms` function, and the `model_ab_finding_scores` +
   `model_ab_arm_cost` views.
3. **OpenRouter key + credits** — a **single** `OPENROUTER_API_KEY=sk-or-…` in
   `.env` serves the OSS auditor for BOTH B and C (they share the OSS compute).
   Per-arm keys are unnecessary. Add credits at <https://openrouter.ai/keys>.

## Enabling the burn-in (env)

All in `.env` (per-machine; unset = byte-identical to today):

| Var | Example | Meaning |
|---|---|---|
| `AUDIT_MODEL_SHADOW` | `B,C` | Which observation-only arms to shadow. Unset → inert. `A` is rejected (production baseline). Unknown id → hard error. |
| `AUDIT_MODEL_SHADOW_BUDGET_EUR` | `300` | Hard cumulative € ceiling. **Required** — unset → the shadow refuses (no unbounded burn). |
| `OPENROUTER_API_KEY` | `sk-or-…` | The single OSS provider key (never committed). |
| `OPENROUTER_BASE_URL` | *(default)* | Only for a self-hosted proxy. |
| `OSS_REASONER_MODEL` | *(unset)* | Manual concrete OSS override (e.g. `deepseek/deepseek-v4-flash`) — never auto-selected. |
| `AUDIT_MODEL_SHADOW_PHASE` | `prospective` | `calibration` \| `prospective` — the two-phase burn-in (below). |
| `AUDIT_MODEL_SHADOW_PROMPT_VARIANT` | `default` | `default` \| `probe-A` \| `probe-B` — the prompt-sensitivity probe. |
| `AUDIT_MODEL_SHADOW_ATTEMPT` | `1` | Rerun counter (grain; does NOT count toward diversity). |
| `AUDIT_MODEL_SHADOW_PASS_MAX_TOKENS` | `8000` | Per-pass output cap (the spend reservation estimates at this cap). |
| `AUDIT_MODEL_SHADOW_RESERVATION_TTL_MS` | `1800000` | Orphaned-reservation release horizon (crash-safety). |
| `AUDIT_MODEL_SHADOW_ARM_TIMEOUT_MS` | `600000` | Per-stage bounded await before the rest is marked `unverified`. |

Once enabled, run any code audit as usual (`/audit-code`, `npm run audit`, …).
The baseline (A) is unaffected; the shadow logs e.g.
`[shadow] model-A/B generation shadow: ran (N findings, M shadow-only, stages: oss-gen+gpt-round+gemini:B+gemini:C)`.

## Two-phase burn-in + validity controls (D10)

Run in this order — the constants are **calibrated then FROZEN before the
prospective run** (pre-registration = frozen-before-*prospective*, not
frozen-before-*calibration*):

1. **Calibration** (`AUDIT_MODEL_SHADOW_PHASE=calibration`) — a small set of
   **known historical bugs** (ground truth exists). Sanity-check the arms and
   **calibrate** the scoring constants (severity weights, quick-fix discount,
   regression penalty, α, λ, floors), then **freeze** them. A model that only
   wins on curated history = benchmark overfit.
2. **Prospective** (`AUDIT_MODEL_SHADOW_PHASE=prospective`, `prompt_variant=default`)
   — **N = 12–25 small, diverse assignments** (backend/frontend/infra/tests/
   refactor/plan-audit/risky-diff), NOT 3 giant ones. `MIN_ASSIGNMENTS` counts
   **distinct (commit_sha × stage_type)** = distinct CODE (a rerun of one commit
   does NOT satisfy the diversity floor). Fix the prompt during this phase (else
   model quality confounds with prompt iteration).
3. **Prompt-sensitivity probe** (Gemini's guard) — run ONE arm at two prompt
   phrasings (`prompt_variant=probe-A` / `probe-B`) over the same assignments. If
   within-model prompt-variance ≈ between-model variance, the experiment measures
   prompt-fit, not model quality → no leaderboard is credible until fixed. Probe
   rows are excluded from the headline ranking (headline = prospective + default).

**Other controls (built)**: paired A/B/C per assignment on the SAME redacted
context; blinded merged adjudication (source hidden); arm-order randomized per
assignment with the **seed recorded** (`arm_order_seed`) for replay; transport
recorded implicitly (derivable from stage × source_model).

## Adjudicating (the blinded human queue)

Shadow findings never gate, so the human labels them via a **blinded** queue
(source_model hidden to sidestep model bias). **Cross-model dedup is the human's
job** (the `duplicate` action → `finding_equivalence`, collapsed to a union-find
root). The scorer is the **human ledger ONLY** (never model/Gemini-survival —
anti-circular).

**Worksheet-first (the human path).** `--worksheet` renders the queue as readable
markdown with one **paste-ready** command per finding (real run-id + fingerprint
baked in — nothing to substitute). Read a block, edit the action word if you
disagree, paste the command. Duplicates: rule the root normally, then rule each
sibling `duplicate` with `--canonical` + the root's fingerprint (the how-to is at
the top of the worksheet; items are sorted so likely-duplicates sit adjacent).

```powershell
# 1. Render the review worksheet (default: worksheet is written on every plain listing;
# out: docs/arm-eval/worksheets/model-ab-adjudication-worksheet.md — gitignored, regenerable.
# Raw queue JSON for scripts: add --json. Prune old working files: npm run audit:clean.
# Optional --suggestions FILE.json ({fingerprint:{action,why,canonical?}}) renders advisory
# verdicts from the blinded adjudicator — you confirm by pasting or override by editing)
$runId = "93580799-977d-4fef-9465-fbe4be47213c"   # from model-ab-stats / the queue listing
node scripts/cross-skill.mjs model-ab-adjudicate --run-id $runId

# 2. Paste the per-finding commands from the worksheet. They look like:
node scripts/cross-skill.mjs model-ab-adjudicate --run-id $runId --fingerprint e476d966 --action accepted
# actions: accepted | dismissed | not-actionable | duplicate (duplicate additionally
# takes --canonical plus the root finding's fingerprint)
```

Raw JSON queue (scripts/automation): omit `--worksheet`. Doc convention: examples
in this repo use real values or PowerShell variables — **never `<angle-bracket>`
placeholders** (PowerShell reserves `<`, and a placeholder command can't be pasted).

## The two-level decision rule (pinned — calibrate-then-freeze)

[`scripts/lib/model-ab-decision.mjs`](../../../scripts/lib/model-ab-decision.mjs)
`DECISION_CONSTANTS`. The values below are the **calibration starting point**;
freeze them before the prospective run and do NOT tune against prospective data.

**LEVEL 1 — quality GATE** (disqualify before ranking): structured-output
conformance ≥ `MIN_CONFORMANCE` (0.98) AND accepted-precision ≥ `PRECISION_FLOOR`
(0.30). (The plan's third clause, no sensitive-egress violation, is enforced
STRUCTURALLY upstream — a run that hit an egress refusal never persists a finding,
so a scored row's existence already proves no violation.)

**LEVEL 2 — rank the survivors by OUTCOME-BASED weighted quality** over
per-assignment canonical clusters. Scoring/recall **unit = (assignment ×
within-assignment canonical cluster)**; dedup is cross-ARM *within* an assignment
(the same bug in two assignments = two detection events). Per arm:

```
armScore = Σ_accepted_clusters [ sevW(c) × qualMult(c) ]          # clusters the arm reached
         + α × Σ_unique_clusters [ sevW(c) ]                       # accepted clusters ONLY this arm reached
         − λ × (dismissed findings)                                # each FP = 1 LOW-equiv (per-finding)
         − regPen × (regressed clusters the arm reached)
```

| Constant | Value | Meaning |
|---|---|---|
| `SEV_WEIGHTS` | LOW 1 / MED 3 / HIGH 8 / CRIT 15 | cluster severity weight (the cluster's adjudicated severity) |
| `QUAL_BASE` × `QUICK_FIX_MULT` | verified 1.0 / fixed 0.6 / pending 0.5 ; quick-fix ×0.4 | quality tier (best across the cluster's ACCEPTED findings — from `remediation_state` + `is_quick_fix`, pure ledger state) |
| `ALPHA` | 0.35 | unique-coverage bonus weight |
| `LAMBDA` | 1.0 | FP penalty per dismissed finding |
| `REG_PEN` | 8 | penalty per regressed cluster |
| `PRECISION_FLOOR` | 0.30 | Level-1 gate: accepted / (accepted + dismissed) |
| `MIN_CONFORMANCE` | 0.98 | Level-1 gate: structured-output conformance |
| `MIN_ASSIGNMENTS` | 12 | decidability: distinct (commit_sha × stage_type) code units |

Reported ALONGSIDE (never divided into the score):
- **recall(arm)** = accepted clusters the arm reached / all accepted clusters (union).
- **cost frontier** — per arm: **standalone €** (a shared stage counted fully for
  each arm it serves — "what deploying this arm would cost"), **€/accepted-weighted**,
  **€/accepted-HIGH**. The headline line reads like *"Arm C delivers ~90% of A's
  audit value at ~25% of the cost."* Actual € burn (shared counted once) comes from
  the spend ledger; the hard € cap still stops the burn-in operationally.

Decidability: a run reads `collecting` (< `MIN_ASSIGNMENTS` distinct code),
`awaiting-adjudication` (any cluster still pending), `insufficient-baseline` (0
accepted clusters), else `decide` (per-arm scorecard + gate + ranking).

## Reading the result

```bash
# Aggregate scorer rows + per-arm cost frontier + cumulative spend vs budget
node scripts/cross-skill.mjs model-ab-stats [--run-id <id>]

# Two-level rule: gate → weighted-quality ranking + recall + frontier + spend
node scripts/cross-skill.mjs model-ab-decision [--run-id <id>]
```

`model-ab-decision` returns `status`, `distinctAssignments`, per-arm `arms`
(score / acceptedWeighted / recall / precision / conformanceRate / gate /
frontier), and a `ranking` of the gated-in arms by score, plus
`budget.spentEur` / `budget.capEur` / `budget.exhausted`.

## Author-bias spot-check (M3 / R2-L1)

D2's "author bias cancels across arms" holds only if defensiveness is
category-independent. To quantify residual bias: stratify by arm and sample
**≥10 "dismissed-by-Claude-but-later-accepted-by-human" findings per arm** before
drawing any conclusion. If the dismissed-then-accepted rate **correlates with
arm**, flag it (it does NOT auto-correct the leaderboard — human-verify is the
backstop). This is a process/manual step, not code.

## Cost model — sizing the €200–400

Per assignment ≈ `cost(A) + cost(OSS 5-pass) + cost(1 GPT round, B) + cost(B-gemini)
+ cost(C-gemini)` (oss-gen shared once across B+C). Token **usage** is always
captured; cost is derived from [`model-pricing.mjs`](../../../scripts/lib/model-pricing.mjs)
(`costFromUsage` for analytics — null-honest; `costForBudget` for the cap — never
null, unpriced models over-estimate, unmeterable usage flagged). Prices are USD;
the ledger stores **EUR** at the fixed `EUR_PER_USD` rate (a coarse fixed rate is
deliberate — the € ceiling is a safety cap, not accounting, so no live-FX
dependency). The **reserve-then-reconcile** ledger enforces the ceiling in code:
a reservation is created before each call (serialized across parallel arms so they
can't collectively overshoot beyond one in-flight estimate), reconciled to actual
after; a reconciled row with a (impossible-in-code) null actual falls back to the
reservation, never €0 (fail-closed toward the ceiling).

## Comparing across skills (audit-plan vs audit-code — v2.1, built)

The shadow runs in BOTH the code-audit and plan-audit paths, tagging each run's
`stage_type` so the A/B/C comparison is broken down per skill. Enable the shadow
(same env) and run either skill:

- **audit-code** — `/audit-code` (or `openai-audit.mjs code …`) → `stage_type='audit-code'`.
- **audit-plan** — `/audit-plan` (or `openai-audit.mjs plan <plan.md>`) → `stage_type='audit-plan'`
  (one plan-audit pass per arm over the plan document + per-arm Gemini; the plan
  path is byte-identical when the shadow is off).

Every scorer view/query carries `stage_type`, so `model-ab-decision` /
`model-ab-stats` naturally partition by skill — run the burn-in across both to
see whether arm performance differs by skill. `plan`-generation (writing a plan)
is NOT an auditor task and is intentionally not shadowed.

## Out of scope (v3)

- **v3** — the live auto-router (reading the scorer's ranking to select the
  production auditor per stage). `audit-shadow.mjs` is the single choke point where
  it plugs in.
- Per-arm OpenRouter keys (only if B-vs-C cost isolation is later wanted — they
  share the OSS compute, so isolation is already derived in the view).
