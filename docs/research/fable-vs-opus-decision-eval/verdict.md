# Fable 5.2 vs Opus 5.5 on coordinator decisions — verdict

- **Date**: 2026-11-15
- **Plan**: [`docs/plans/fable-vs-opus-decision-eval.md`](../../plans/fable-vs-opus-decision-eval.md) (pre-registered rule §12)
- **Status**: **NOT CERTIFIED — one exception awaits Louis (§4).** Every figure below is final. Whether
  the pre-registered verdict is *certified* depends on Louis's ruling on the spot-sample exception.
- **Evidence**: [`runs/main/`](runs/main/summary.json), pinned fixture `fable-opus-main` at `f51bc7b3`
  (arms + primary judge); cross-grade in fixture `fable-opus-xgrade` at `6b18b17d`. Raw arm outputs:
  `calls.jsonl`. Primary judge: `grades.jsonl`. Cross-graders: `cross-grades.jsonl` /
  `cross-grade.json`. Every reservation and settlement: `ledger.jsonl`.
- **Corpus**: 10 cases (3 review, 4 design-fork, 3 cross-repo), corpus `5eb0beae2798`, contract epoch 2.
  n = 3 reps per arm per case, set by `proposeReps` from the variance phase.

Labels: **measured** means a provider-reported count, a timing, or a judge output. **derived** means
computed from measured rows (USD = measured tokens × published price). **estimated** means a projection.

## 1. Result

| Figure | Opus 5.5 | Fable 5.2 | Label |
|---|---|---|---|
| Correct decisions | 18 / 30 | 19 / 30 | measured (both judge passes) |
| Mean quality q | 0.635 | 0.659 | derived |
| Within-case spread s_w | 0.157 | 0.172 | derived |
| USD per call | $0.123 | $0.314 | derived |
| USD per correct decision | $0.206 | $0.495 | derived |
| Output tokens per call (of which thinking) | 5.2 K (2.3 K) | 6.9 K (4.7 K) | measured |
| Median latency | 49.6 s | 66.8 s | measured |
| Arm statuses | 30 ok | 30 ok | measured |

- **Paired difference (Fable − Opus), case-first bootstrap:** Δq = **+0.024**, 95% CI **[−0.111, +0.136]**
  (derived). Δ_target = max(s_w, 0.10) = **0.172**.
- **Cost ratio R** (per correct decision) = **2.41** (derived).
- **Rule outcome if certified:** CI upper bound 0.136 < Δ_target 0.172, so the verdict is
  **`opus:material-gain-ruled-out`**. The rule names no Fable gain this experiment could detect.
- **By role** (3–4 cases each, so wide CIs; derived):

  | Role | Δq | 95% CI | Reading at Δ_target 0.172 |
  |---|---|---|---|
  | review | +0.080 | [−0.051, +0.256] | inconclusive |
  | design-fork | +0.090 | [−0.027, +0.229] | inconclusive |
  | cross-repo | −0.119 | [−0.425, +0.089] | gain ruled out |

## 2. Instrument (all passed except the spot sample)

| Check | Result |
|---|---|
| Judge controls (checkpoint + in-run) | 80 / 80 |
| Unmeasured primary grades | 0 / 280 |
| Judge noise s_j | 0.077 (gate ≤ 0.10) |
| Served model = requested | 60 / 60 |
| Sample completeness, unpaired case-reps | complete, none |
| Fill-check (C5) | ok, thinking tokens reported on 60 / 60 |
| Artifact scan (secret shapes + private terms) | safe to commit |
| **Spot sample, cross-vendor (pre-registered 2026-11-15T15:52Z)** | **12 / 12 exceptions, not certified** |

## 3. Cost of the experiment

| Item | USD | Label |
|---|---|---|
| Main run: arms (Opus $3.70, Fable $9.40) + primary judge | $14.32 | derived |
| Cross-grade: GPT $0.12, Gemini $0.68 | $0.80 | derived |
| Budget scope `main`, total | **$15.12 of $25** | derived |
| Earlier scope `autonomous` (rehearsal + variance) | $8.06 of $10 | derived |

## 4. Exception for Louis — the spot sample

The pre-registered rule (in [`deviations.md`](deviations.md)) has two LLM graders re-grade the
12 sampled outputs blind. An item is an exception if it is unmeasured (E3), if both graders
disagree with the primary on correct (E1), or if their mean q is more than 0.25 off (E2).
The verdict certifies at ≤ 2/12 exceptions.

**What happened.** Both graders passed all 20 gold/trap controls. **Gemini (`gemini-pro-latest`)
voided all 12 of its sample grades.** Every one of them carried at least one positive claim whose
"verbatim" quote was paraphrased or elided with `...`, and the mechanical quote check (the same one
the primary uses) correctly refused it. So every item is E3, and the rate is 12/12. No item tripped
E1 or E2.

The three grades per item (P = primary judge, both passes; correct Y/N and q):

| Item | Arm | Case | P | GPT | Gemini (decision only; q voided) |
|---|---|---|---|---|---|
| 7a5f91ef | Opus | disposable-db-guard-predicate | N 0.31 | N 0.31 | voided |
| 4692d66e | Fable | windowed-views-consumer-path-review | Y 0.96 | Y 0.96 | Y |
| 9133744a | Opus | check-ignore-ci-cause-string | Y 0.90 | Y 0.90 | Y |
| 64dc31fb | Opus | sync-manifest-ratchet-report | N 0.25 | N 0.30 | **Y** |
| 350d14b4 | Fable | sdk-pin-max-tokens-review | Y 0.75 | Y 0.75 | Y |
| b3455ebe | Fable | skills-manifest-commit-or-ignore | Y 0.64 | Y 0.69 | Y |
| 08fe9566 | Fable | sdk-pin-max-tokens-review | Y 0.75 | Y 0.75 | Y |
| 284d3e1d | Opus | prepush-check-target-tree | Y 0.95 | Y 0.95 | Y |
| ca169519 | Fable | sync-manifest-ratchet-report | N 0.30 | N 0.30 | N |
| fe4ee2c2 | Fable | stale-override-four-sites | N 0.30 | N 0.30 | voided |
| c4a60856 | Fable | consumer-prepush-schema-behind-refusal | N 0.13 | N 0.13 | **Y** |
| 9a4eaeb0 | Fable | stale-override-four-sites | N 0.25 | N 0.25 | voided |

Read as evidence, not as a certified pass:

- **GPT agrees with the primary on 12/12**, with q within 0.05 on every item. But GPT is the
  **same model** as the primary judge, so this is a consistency check, not an independent one.
- **Gemini's decision call agrees on 7 of the 9 items it could state.** Its 2 disagreements are
  both "lenient" (it says correct where the primary says not), and there is one per arm (Opus 64dc31fb,
  Fable c4a60856). Both are on the two cross-repo cases where both arms are consistently wrong. There
  is no sign of arm-directional bias.
- **Why the verdict is robust to the judge.** Both arms are graded by the same judge, so a judge
  bias common to both arms cancels in Δ. A Gemini-style leniency on the hard cross-repo cases
  would raise both arms.

**Recommendation: accept a disclosed override and certify `opus:material-gain-ruled-out`.**
The failure is an instrument incompatibility: Gemini does not follow the verbatim-quote contract.
It is not evidence that the primary misgraded. Certification would be recorded as an override,
never as a pass of the pre-registered rule. The alternatives:

1. **Override (recommended).** Record "certified by override: GPT 12/12, Gemini decisions 7/9,
   no arm-directional disagreement" in `deviations.md`. Cost $0.
2. **Mark the 12 rows yourself.** The blinded worksheet already exists:
   [`runs/main/spot-sample.md`](runs/main/spot-sample.md). Then run
   `node scripts/model-eval-decision.mjs spot-agree --run-id main`. This is the original protocol,
   at about 15 minutes.
3. **Leave it uncertified.** The figures stand as measured, and the verdict reads "directional only".

Re-running Gemini with a relaxed quote check was **not** done. That would change a pre-registered
instrument after seeing its output.

## 5. Proposed Fable usage rule (pending certification)

- **Coordinator-grade decisions (review, design forks, cross-repo synthesis): use Opus 5.5.**
  On this corpus Fable 5.2 was +0.02 q, within noise. It costs 2.4× per correct decision and is
  35% slower.
- **Cross-repo diagnosis: Opus, and do not expect a model swap to help.** Both arms fail the same
  two cases (consumer-prepush 0/6, sync-manifest 0/6 correct). Process controls (a second run, peer
  review) are the lever there, not the model.
- **Review and design forks: untested at a moderate effect.** The upper CIs (+0.26, +0.23) do not
  rule out a gain of about Δ_target. Showing one would need more cases; more reps would not help,
  because the CI resamples cases.
- **Opus run-to-run variance is itself a finding.** Opus has s_w = 0.16 on byte-identical input, and
  several cases flip between a right and a wrong decision across reps. A second run on a high-stakes
  call is worth more than switching models.

## 6. Limitations

- The spot sample was graded by **LLMs, not a human**, and the two may share biases. The GPT
  cross-grader is the same model as the primary judge, and only Gemini is a different vendor. This is
  not equivalent to human review. In this run it also produced no measured q (§4).
- 10 cases from one repo's history, with corpora authored from a verified dossier. Treat per-role
  results as directional (3–4 cases each).
- Effort was held at `high` for both arms. Fable spent 2× the thinking tokens at the same setting.
- Deviations: [`deviations.md`](deviations.md).

## Reproduce

```bash
node scripts/model-eval-decision.mjs report --run-id main
```

`report` recomputes `summary.json` and `cross-grade.json` from the persisted rows. It makes no API
calls and rewrites both files in place.
