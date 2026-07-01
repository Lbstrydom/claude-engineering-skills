# Model-A/B/C auditor experiment — runbook

Operator guide for the funded (~€200–400) empirical burn-in that picks
**auditor-model configs from real human-adjudication data**, not model
self-opinion. Design + audit trail: [`docs/plans/model-ab-experiment-harness.md`](plans/model-ab-experiment-harness.md).

> **What it is**: an observation-only *generation shadow* that generalizes the
> final-review shadow to the AUDIT GENERATION passes. When enabled it runs the
> baseline audit (arm A) as today AND, in parallel, spawns OSS/GPT auditor arms
> — recording per-arm findings, cost, and structured-output conformance. Nothing
> an arm produces ever gates or ships. A scorer view joins per-arm findings to
> the human `adjudication_outcome`; a CLI reads a **pre-registered** keep/drop
> rule per cell.

## The three arms

| Arm | Config | Gemini | Notes |
|---|---|---|---|
| **A** | GPT ×5 passes + Gemini gate | yes | Today's baseline / production control (run by the real audit, NOT the shadow). |
| **B** | OSS ×5 passes + **1 independent GPT round** | no | Measures the disjoint-coverage thesis (GPT's own catches, not a rubber-stamp). |
| **C** | = B + the normal Gemini gate | yes | **Reuses B's compute** — only adds the Gemini gate. C's cost ≈ B + one Gemini. |

Arms are **data** ([`scripts/lib/audit-arms.mjs`](../scripts/lib/audit-arms.mjs) `CANONICAL_ARMS`)
and reference **sentinels** (`latest-gpt`, `latest-oss-coder`), never concrete
model ids — the resolver picks the newest match. Arm membership is **derived**
in the scorer view from the producing `stage` (no per-finding `arm_id` → B and
C never double-count).

## Prerequisites

1. **Cloud store** — `AUDIT_DB_URL` set (the shadow refuses to spend without
   persistence — decision 13).
2. **Migration applied** — `node scripts/setup-postgres.mjs --migrate` (adds the
   `stage` column, `audit_arms`, `finding_equivalence`, `model_ab_spend_ledger`,
   and the `model_ab_effectiveness` view).
3. **OpenRouter key + credits** — set `OPENROUTER_API_KEY=sk-or-…` in `.env`
   (the "Model A/B/C experiment harness" section) and add credits at
   <https://openrouter.ai/keys>.

## Enabling the burn-in (env)

All in `.env` (per-machine; unset = byte-identical to today):

| Var | Example | Meaning |
|---|---|---|
| `AUDIT_MODEL_SHADOW` | `B,C` | Which observation-only arms to shadow. Unset → inert. `A` is rejected (it's the production baseline, not a shadow target). An unknown id is a hard error. |
| `AUDIT_MODEL_SHADOW_BUDGET_EUR` | `300` | Hard cumulative € ceiling. **Required when the shadow is enabled** — with it unset the shadow refuses to run (no unbounded burn). |
| `OPENROUTER_API_KEY` | `sk-or-…` | OSS provider key (never committed). |
| `OPENROUTER_BASE_URL` | *(default)* | Only for a self-hosted proxy. |
| `OSS_CODER_MODEL` / `OSS_REASONER_MODEL` | `qwen/qwen3-coder` | Optional concrete OSS override (comma-list head wins) without editing source. |
| `AUDIT_MODEL_SHADOW_PASS_MAX_TOKENS` | `8000` | Per-pass output cap (the spend reservation estimates at this cap). |
| `AUDIT_MODEL_SHADOW_RESERVATION_TTL_MS` | `1800000` | Orphaned-reservation release horizon (crash-safety). |
| `AUDIT_MODEL_SHADOW_ARM_TIMEOUT_MS` | `600000` | Per-stage bounded await before the rest is marked `unverified`. |

**Validation errors** you may hit: unknown arm id (`AUDIT_MODEL_SHADOW=B,Z`),
requesting the baseline (`AUDIT_MODEL_SHADOW=A`), a concrete id in an arm config
(arms must use sentinels), or `refused-schema-preflight` / `refused-no-budget`
in the audit log (fix the migration / set the budget).

Once enabled, run any code audit as usual (`/audit-code`, `npm run audit`, …).
The baseline (A) is unaffected; the shadow logs e.g.
`[shadow] model-A/B generation shadow: ran (N findings, M shadow-only, stages: oss-gen+gpt-round+gemini)`.

## The pre-registered decision rule (pinned — decision 8)

Written **before** data collection ([`scripts/lib/model-ab-decision.mjs`](../scripts/lib/model-ab-decision.mjs)
`DECISION_CONSTANTS`). Do **not** tune these against collected results — that
breaks pre-registration.

| Constant | Value | Meaning |
|---|---|---|
| `MIN_ACCEPTED_RATIO` | `0.80` | arm accepted-uniques ≥ 0.80 × A |
| `MAX_DISMISSED_RATIO` | `1.25` | arm dismissed-uniques ≤ 1.25 × A |
| `MAX_COST_RATIO` | `0.50` | arm cost ≤ 0.50 × A |
| `MIN_CONFORMANCE` | `0.98` | structured-output conformance floor (a low-conformance arm is disqualified before quality is scored) |
| `CELL_N` | `20` | paired runs per `(arm × stage)` cell before it is decidable |
| `MIN_ASSIGNMENTS` | `2` | distinct assignments the cell must span |

A cell is **DECIDABLE** only with ≥ `CELL_N` runs **AND** 0 pending findings
(deciding on un-adjudicated findings is deciding on noise). Otherwise it reads
`collecting` (needs runs) or `awaiting-adjudication` (drain the queue). Edge
cases: A's accepted = 0 → `insufficient-baseline`; an unpriced run's cost is
**excluded** from the cost ratio (never counted as €0). **No model votes** — the
scorer is the human ledger only (Gemini-survival is a weak secondary at most,
never the primary metric — the anti-circularity decision).

## Adjudicating (the blinded human queue)

Shadow-only B/C findings never gate, so nothing triages them automatically — the
human labels them via a **blinded** queue (source_model hidden to sidestep model
bias). **Cross-model dedup is the human's job** (the `duplicate` action).

```bash
# 1. Present the blinded queue (source_model hidden; likely-equivalents adjacent)
node scripts/cross-skill.mjs model-ab-adjudicate --run-id <id> --limit 50

# 2. Label a finding
node scripts/cross-skill.mjs model-ab-adjudicate --run-id <id> --fingerprint <hash> --action accepted
node scripts/cross-skill.mjs model-ab-adjudicate --run-id <id> --fingerprint <hash> --action dismissed
node scripts/cross-skill.mjs model-ab-adjudicate --run-id <id> --fingerprint <hash> --action not-actionable
# duplicate → point at the canonical (writes finding_equivalence, union-find root)
node scripts/cross-skill.mjs model-ab-adjudicate --run-id <id> --fingerprint <dup> --action duplicate --canonical <root-hash>
```

## Reading the result

```bash
# Per (arm × stage × source_model) scorer rows + cumulative spend vs budget
node scripts/cross-skill.mjs model-ab-stats [--run-id <id>]

# Evaluate the pinned rule per cell → DECIDE(keep/drop)/CONTINUE + spend
node scripts/cross-skill.mjs model-ab-decision [--run-id <id>]
```

`model-ab-decision` returns per-cell `status` ∈
`{decide, collecting, awaiting-adjudication, insufficient-baseline}` with a
`verdict` ∈ `{keep, drop}` on decidable cells, plus `budget.spentEur` /
`budget.capEur` / `budget.exhausted`.

## Cost model — sizing the €200–400

Per assignment ≈ `cost(A) + cost(OSS 5-pass) + cost(1 GPT round) + cost(1 extra
Gemini)` (C reuses B). Token **usage** is always captured; cost is derived from
[`scripts/lib/model-pricing.mjs`](../scripts/lib/model-pricing.mjs) (`costFromUsage`
for analytics — null-honest; `costForBudget` for the cap — never null, unpriced
models over-estimate, unmeterable usage flagged). **Currency**: prices are USD;
the spend ledger stores **EUR** (`model_ab_spend_ledger.reserved_eur/actual_eur`),
converted at the fixed `EUR_PER_USD` rate in `model-pricing.mjs` — a coarse
fixed rate is deliberate here (the € ceiling is a safety cap, not accounting, so
no live-FX dependency). The **reserve-then-reconcile**
ledger enforces the € ceiling in code: a reservation is created before each call
(serialized across parallel arms so they can't collectively overshoot beyond one
in-flight estimate), reconciled to actual after. Cumulative spend is reported by
`model-ab-stats` / `model-ab-decision` so the burn-in stops at budget.

## Out of scope (v2)

Auto-routing on the winner (reading the scorer's decision to select the
production generation model per pass) is **deliberately deferred** until the data
decides. `audit-shadow.mjs` is the single choke point where that router plugs in.
