# Arm-evaluation framework — runbook

Operator guide for the unified **blinded-Claude-judge, human-anchored** framework
that answers one question across experiments: **can an OSS combination beat the
proprietary baseline?** Design + audit trail:
[`docs/plans/arm-eval-framework.md`](plans/arm-eval-framework.md).

> **What it is**: Claude is the constant JUDGE (never an arm — self-preference
> guard). Each experiment's arms produce outputs; Claude scores them blinded,
> order-randomized, twice (self-consistency), on a fixed rubric; a human spot-check
> is the ground-truth anchor. Inert until enabled + budgeted.

## The experiments

| Experiment | Arms | Baseline | Output | Scoring |
|---|---|---|---|---|
| **plan-authoring** | GPT · GLM-5.2 (+ DeepSeek/Qwen rotation) | GPT | a plan doc | Claude-judge PRIMARY + audit-proxy cross-check |
| **brainstorm** | D=GPT+Gemini · E=GLM+Gemini · F=GLM+GPT | D | a synthesized take | Claude-judge only |
| **auditor** (shipped) | A/B/C audit pipelines | A | findings | human adjudication (see `docs/model-ab-experiment.md`) |

Arm/rubric config is DATA ([`scripts/lib/arm-eval/experiments.mjs`](../scripts/lib/arm-eval/experiments.mjs)).
GPT/Gemini legs use sentinels; OSS candidates are named concretely (the
experiment's variable). **A Claude-family arm is a hard error.**

## The judge controls (what makes Claude-as-judge proper)

- **Blinded** — arm identity hidden (opaque `output-N` labels).
- **Order-randomized** — seeded presentation order (recorded → replayable).
- **Double-pass** — judged twice → self-consistency Δ (absolute floor ≤ 0.75; a
  breach → `not-credible`, no verdict). The between-arm-spread comparison is
  advisory, NOT a gate — a genuine tie stays provable.
- **Fixed rubric** — core (correctness/completeness/risk/right-sizing/clarity +
  architectural-coherence + repo-intent-fidelity) + per-experiment extension. The
  two INTENT dims are scored only when the repo-intent context pack (architecture-
  map + domain-map `allowedDeps`+`rules` + requirements ledger) is present; else
  `unscored` (never fabricated).
- **Human anchor** — a stratified spot-check ranks the blinded outputs; Kendall τ
  (accumulated across ≥ 8 tasks, floor 0.6) must clear or the verdict is
  `unanchored` (directional only). This is mandatory — plan/brainstorm evidence is
  softer than the auditor's bug-grounded verdict, so the anchor is what makes it
  credible.

## Prerequisites + enabling

1. **Cloud store** — `AUDIT_DB_URL` set; migration applied
   (`node scripts/setup-postgres.mjs --migrate` → `--check-drift`).
2. **Provider keys** — `OPENAI_API_KEY` (GPT), `GEMINI_API_KEY` (Gemini),
   `OPENROUTER_API_KEY` (OSS: GLM/DeepSeek/Qwen), `ANTHROPIC_API_KEY` or the CLI
   backend (Claude judge).
3. **Budget** — every run carries a spend ceiling: `--budget-eur <n>`, else
   `ARM_EVAL_BUDGET_EUR`, else the **€300 default** (`DEFAULT_SPEND_BUDGET_EUR`
   in config.mjs; operator decision 2026-07-02). The library seam still refuses
   a null budget — the default is a ceiling, not unbounded burn. All OSS
   candidates are ≪ the GPT baseline (cost gate holds).

## One-command toggle (collection window)

To put a repo's **audit + plan + brainstorm** functions into A/B/C collection
with one command (and back out when you have enough data):

```bash
node scripts/cross-skill.mjs arm-eval-toggle on [--budget-eur N]   # default €300
node scripts/cross-skill.mjs arm-eval-toggle status                # state + what's active
node scripts/cross-skill.mjs arm-eval-toggle off                   # everything inert again
```

While ON (state file: gitignored `.audit-loop/arm-eval-toggle.json`):
- **/audit-code + /audit-plan** run the B,C shadow arms (observation-only; the
  production A verdict is untouched). Explicit `AUDIT_MODEL_SHADOW` env always
  WINS over the toggle — it stays the kill switch / custom-arm override.
- **/plan** fires one `plan-authoring` arm-eval session per invocation
  (via `arm-eval-maybe-capture`; your plan output is unchanged).
- **/brainstorm** fires one `brainstorm` (D/E/F) session per topic.

While OFF, every surface is inert and byte-identical to the pre-toggle path;
`arm-eval-maybe-capture` is a silent no-op (safe for skills to call
unconditionally). Fail-closed: a missing/malformed toggle file = OFF.

## Two-phase burn-in

1. **Calibration** (`--phase calibration`) — a small known set; calibrate then
   FREEZE the rubric weights + decision constants before the prospective run.
2. **Prospective** (`--phase prospective`, default) — N = 12–25 diverse tasks
   (distinct `task_id` = normalized content hash = the diversity unit).

## Commands

```bash
# Run ONE session (produce all arms → judge → cross-check → persist). Spends.
node scripts/cross-skill.mjs arm-eval-run --experiment plan-authoring \
  --task "add a wine recommendation engine" --budget-eur 25 [--repo-id <id>] [--phase prospective] [--seed N]

# Blinded human spot-check: show a session's outputs (arm hidden) …
node scripts/cross-skill.mjs arm-eval-adjudicate --session-id <id>
# … then record your ranking of the opaque labels (best→worst):
node scripts/cross-skill.mjs arm-eval-adjudicate --session-id <id> --ranked output-2,output-1,output-3

# Leaderboard aggregate (repo-scoped; --all-repos to opt into cross-repo):
node scripts/cross-skill.mjs arm-eval-stats --experiment plan-authoring --repo-id <id>

# The verdict: gate → paired-delta rank + τ anchor + € frontier.
node scripts/cross-skill.mjs arm-eval-decision --experiment plan-authoring --repo-id <id>
```

## Reading the verdict

`arm-eval-decision` returns per-arm `{ rubricMean, pairedDeltaVsBaseline,
selfConsistencyDelta, conformanceRate, costEur, gate }`, a `ranking` of gated-in
arms, an `anchor` (`meanTau`, `topPickMatch`, `anchored`), and a `verdict`:
- `oss-competitive` — an OSS arm meets-or-beats the baseline on paired rubric delta.
- `baseline-wins` — the baseline leads.
- a `-provisional` suffix + `credible:false` → the human anchor isn't yet credible
  (τ/tasks below floor); the call is DIRECTIONAL only until you spot-check more.
- Level-1 gate DISQUALIFIES a low-conformance arm (no survivorship bias) or one
  whose self-consistency Δ exceeds the floor.

## Honest confidence

The auditor verdict rests on real accepted bugs (hard); plan/brainstorm verdicts
rest on Claude-judge + human spot-check (softer). The framework states its
confidence tier and never presents a rubric-only ranking as equal to the bug-
grounded one. Out of scope (v-next): acting on the winner (auto-router) +
outcome-based scoring (implement the plan, measure success).
