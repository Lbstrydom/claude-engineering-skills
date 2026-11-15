# Fable 5.2 vs Opus 5.5 — variance phase report

- **Date**: 2026-11-15
- **Plan**: [`docs/plans/fable-vs-opus-decision-eval.md`](../../plans/fable-vs-opus-decision-eval.md) (pre-registered rule §12; Campaign Contract)
- **Status**: variance phase **complete**. The main comparison has **not** run. It needs Louis's approval of its budget (§4).
- **Revision**: pinned fixture `fable-opus-variance` at `ce49e42c` (`npm run fixture:create -- --name fable-opus-variance --rev ce49e42c…`)
- **Corpus**: 5 cases, `corpusSha256` `7c9f62cff2d8…`, contract epoch 1
- **Evidence**: [`runs/rehearsal/`](runs/rehearsal/summary.json) and [`runs/variance/`](runs/variance/summary.json). Each holds the raw arm outputs (`calls.jsonl`), the raw judge outputs (`grades.jsonl`), every reservation and settlement (`ledger.jsonl`), and `summary.json`.

## Epoch 2 (current): 10 cases, 3 reps — run `variance-e2c`

Louis chose "enlarge corpus first". Epoch 2 adds 3 design forks, 1 review and 1 cross-repo case.
The 10 cases split 3 review, 3 cross-repo and 4 design-fork, so a per-role verdict is possible
for every role. Corpus `5eb0beae2798`, pinned fixture `fable-opus-e2c` at `c72a1d69`. Two
earlier epoch-2 attempts stopped before producing data: `variance-e2`, at the control
checkpoint, and `variance-e2b`, at the egress gate. Both are kept as evidence; see
[`deviations.md`](deviations.md).

| Figure | Value | Label |
|---|---|---|
| Opus mean q | **0.60** | measured grades |
| Within-case spread s_w | **0.20** | derived |
| Correct decisions | **16 / 30** (correct requires a measured output) | measured |
| Judge controls | 79 / 79 passed (1 of 220 grades unmeasured) | measured |
| Judge noise s_j | 0.09 (gate ≤ 0.10) | derived |
| Opus per call | **$0.122** (4.8 K in, 5.1 K out, of which 2.3 K thinking) | derived / measured |
| Opus per correct decision | **$0.229** | derived |
| This run | **$4.47** (arms $3.66, judge $0.80) | derived |
| Budget scope `autonomous`, all runs | **$8.06 of $10** | derived |

Per case (Opus, 3 reps):

| Case | Role | Correct | Mean q | q range |
|---|---|---|---|---|
| `consumer-prepush-schema-behind-refusal` | cross-repo | 0/3 | 0.11 | 0.09–0.13 |
| `sync-manifest-ratchet-report` | cross-repo | 0/3 | 0.38 | 0.25–0.60 |
| `stale-override-four-sites` | cross-repo | 1/3 | 0.52 | 0.30–0.90 |
| `check-ignore-ci-cause-string` | review | 0/3 | 0.46 | 0.25–0.58 |
| `windowed-views-consumer-path-review` | review | 3/3 | 0.88 | 0.87–0.91 |
| `sdk-pin-max-tokens-review` | review | 3/3 | 0.70 | 0.70 |
| `disposable-db-guard-predicate` | design-fork | 1/3 | 0.47 | 0.22–0.96 |
| `cli-system-honour-claim` | design-fork | 3/3 | 0.88 | 0.85–0.90 |
| `skills-manifest-commit-or-ignore` | design-fork | 3/3 | 0.76 | 0.69–0.82 |
| `prepush-check-target-tree` | design-fork | 2/3 | 0.82 | 0.65–0.95 |

**Reading.** The cross-repo diagnoses are where Opus is weakest: 1 of 9 correct. Two cases are
consistently wrong rather than noisy. Design forks are mostly right. There is headroom
(Opus 0.60 < the ceiling line of 1 − 0.20 = 0.80).

**n for the main run:** `proposeReps` gives r = 3 (raw 2, clamped to the minimum 3) at
Δ_target = 0.20. So 30 Fable and 30 Opus calls plus about 280 judge grades.
**Projected cost (estimated): $12.01**, or **$15.10** if Fable emits 1.5× the output.
The Fable per-call cost is still an estimate ($0.24–0.35), because no Fable call has been
made. The approved cap is $13, with Louis's quote "fine if it goes up to 20 (if needed)".
The high band exceeds $13, so the cap choice is put to Louis before any main-run spend.

The epoch-1 sections below are kept for the record (5 cases, superseded).

---

Labels: **measured** means a provider-reported count or a timing; **derived** means measured tokens × the published price (`scripts/lib/model-pricing-table.mjs`, reviewed 2026-11-15); **estimated** means a projection.

## 1. Result in one paragraph

Opus 5.5 run four times on each of the five frozen decisions scored a mean quality of **q = 0.68** (0–1 scale). It reached the correct decision on **14 of 20** outputs (measured; judge double pass). It is **not stable run to run**. The pooled within-case standard deviation is **s_w = 0.24** (derived from the measured grades). Three of the five cases flip between a right and a wrong decision across byte-identical reps. One case (`sync-manifest-ratchet-report`) spans q = 0.10 to 0.83. Under the pre-registered rule, a Fable advantage counts only if it exceeds **Δ_target = max(s_w, 0.10) = 0.24**. Fable would have to lift mean q from 0.68 to about 0.92 and do it consistently across cases. A smaller real gain could not be told apart from Opus disagreeing with itself.

## 2. Instrument checks (all passed)

| Check | Rehearsal (Haiku 5.5, 1 rep) | Variance (Opus 5.5, 4 reps) |
|---|---|---|
| Judge controls passed (checkpoint before any arm spend + in-run) | 20 / 20 | 50 / 50 |
| Unmeasured grades | 0 / 50 | 0 / 140 |
| Unverified judge quotes (pass voided) | 0 | 1 |
| Judge noise `s_j`, mean \|q_pass1 − q_pass2\| | 0.03 | 0.07 (gate: ≤ max(0.5·s_w, 0.10) = 0.12) |
| Pass disagreements on "correct" | 0 | 2 |
| Served model = requested | 5 / 5 | 20 / 20 |
| C5 fill-check (every declared field real) | ok | ok |
| Thinking tokens reported by the API | 5 / 5 calls (`output_tokens_details.thinking_tokens`) | 20 / 20 |
| Artifact scan (secret shapes + private terms) | safe to commit | safe to commit |
| Arm statuses | 5 `ok` | 20 `ok` (no truncation, no refusal) |

Haiku got 2 of 5 decisions right in the rehearsal. That is a positive control that the corpus is not trivially easy. Judge noise accounts for about a third of `s_w`: two outputs split between passes (0.35 / 0.95 and 0.20 / 0.80). The rest is Opus itself reaching different conclusions on the same input. That is the "1 vs 25 findings from byte-identical input" lesson again, now measured on decisions.

## 3. Per-case spread (Opus 5.5, measured grades; q per pass)

| Case | Role | Reps correct | q range | Mean q |
|---|---|---|---|---|
| `check-ignore-ci-cause-string` | review | 2 / 4 | 0.25–0.90 | 0.65 |
| `stale-override-four-sites` | cross-repo | 3 / 4 | 0.35–0.95 | 0.78 |
| `sync-manifest-ratchet-report` | cross-repo | 1 / 4 | 0.10–0.83 | 0.43 |
| `cli-system-honour-claim` | design-fork | 4 / 4 | 0.85 (stable) | 0.85 (3 measured) |
| `sdk-pin-max-tokens-review` | review | 4 / 4 | 0.70–0.75 | 0.73 |

Two cases are stable and three are coin-flips. The headroom, and the variance, both sit in the cross-repo diagnosis cases and the CI-race case.

## 4. Cost (Opus 5.5 arm)

| Figure | Value | Label |
|---|---|---|
| Variance-phase spend, this run | **$2.60** (arms $2.09 + judge $0.51) | derived |
| Budget scope `autonomous` total (rehearsal $0.19 + variance) | **$2.79 of $10** | derived |
| Opus per call | **$0.105** | derived |
| Opus per correct decision | **$0.150** | derived |
| Opus tokens per call (mean) | 5.2 K in, 4.2 K out, of which 1.7 K thinking | measured |
| Opus latency, median | 44 s | measured |
| Judge (`gpt-6.1-terra`) per grade | $0.0036 | derived |
| Cache read / write tokens | 0 / 0 (no caching, by design) | measured |

No reservation was left open (160 reserve rows, 160 settle rows). The hard cap was never approached. The worst-case reservation per Opus call was about $0.5, so the 8x-low estimate risk did not apply.

## 5. Proposed n and the main-comparison budget

- **n = 4 reps per arm per case** (`proposeReps`: r = ⌈2·2.8²·s_w² / (k·Δ_target²)⌉ = 4 at k = 5). That is 20 Opus and 20 Fable calls, plus 180 judge grades.
- **Projected cost** (estimated): **$6.93** at Opus's measured token counts priced at Fable's rate, or **$8.61** if Fable emits 1.5× the output. The Opus arm ($2.09) and the judge are measured. The Fable per-call cost is **estimated** at $0.21–0.29 because no Fable call has been made. Fable's list price is 2× Opus's.
- **Suggested cap: $13** (high band × 1.5). The cap is enforced by reservation. The run stops before any call that could cross it.
- Command, after approval (same pinned fixture):
  ```bash
  node scripts/model-eval-decision.mjs run --phase main --reps 4 --cap-usd 13 --budget-scope main --confirm-main
  ```

## 6. What this measurement can and cannot answer, before you spend $7–13

- **It can answer one question:** is Fable *dramatically* better on these five decisions, with a gain of at least 0.24 q, consistent across cases, at no more than 3× Opus's cost per correct decision? If the whole gain came from correctness (weight 0.6), 0.24 q is about 2 more correct decisions out of 5.
- **It cannot detect a moderate gain.** Opus's run-to-run spread (0.24) is the floor. More reps narrow within-case noise. They do not fix a 5-case corpus: the CI resamples cases, so one case going the other way keeps the lower bound at or below 0.
- **Design forks are untested.** One case is not enough for a per-role verdict. Review and cross-repo have two cases each.

**Options for Louis:**
1. **Run the main comparison as pre-registered** (cap $13, estimated $7–9). It answers "dramatically better on these decisions, yes or no".
2. **Enlarge the corpus first.** Add about 5 cases, including at least 2 more design forks, then re-run the variance phase (about $3) and the main run (about $14–18 estimated). This is the only way to detect a moderate gain or to say anything about design forks. Adding cases changes the corpus hash, so it is a new epoch.
3. **Stop here.** A useful finding already stands: Opus 5.5 flips its decision on 3 of 5 coordinator-grade questions across byte-identical reruns. Process controls (peer review, a second run on high-stakes calls) catch errors a single run makes, whichever model makes it. That matches the "process caught today's errors, not model capability" observation behind this experiment.

No usage rule for Fable is proposed yet. Proposing one now would assert the result this experiment exists to measure.

## 7. Deviations raised by this phase

See [`deviations.md`](deviations.md), 2026-11-15 "variance phase": the correct-count definitional gap, the rubric's penalty on hedging, and the model-name scrub, which also rewrites `claude -p`.

## Reproduce

```bash
node scripts/model-eval-decision.mjs report --run-id variance
node scripts/model-eval-decision.mjs report --run-id rehearsal
```

`report` recomputes `summary.json` purely from the persisted rows. It makes no API calls and spends nothing, and it **rewrites `summary.json` in place**, so point `--root` at a copy to compare. Checked 2026-11-15 on a copy: every figure in `perArm`, `cost`, `instrument` and `proposedN` reproduces exactly. The only difference is $0.0001 of float rounding in `mainProjection.totalUsd.high` (8.6084 vs 8.6085).
