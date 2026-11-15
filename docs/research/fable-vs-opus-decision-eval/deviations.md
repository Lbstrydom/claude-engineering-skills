# Deviations ledger — Fable 5.2 vs Opus 5.5 decision eval

Plan: [`docs/plans/fable-vs-opus-decision-eval.md`](../../plans/fable-vs-opus-decision-eval.md) §C10.
Anything off-contract, outstanding, or differing from the plan is recorded here
**before** merge and raised to Louis in the PR description. Newest first.

## 2026-11-15 — main-run budget

- **Main-run hard cap: $25, confirmed by Louis directly in this session** ("Yes cap 25").
  Earlier relays via the coordinator said "$13, up to $20 if needed" and then "cap 25 is fine".
  The direct confirmation is the authority. Projection at n = 3: $12.01, high band $15.10
  (estimated). The cap is enforced per call by worst-case reservation in a fresh budget scope,
  `main`.

## 2026-11-15 — epoch 2 (10-case corpus)

- **Corpus enlarged on Louis's call ("enlarge corpus first").** 5 new cases: 3 design-fork,
  1 review, 1 cross-repo. Contract epoch → 2, which also applies the definitional fix below
  (`correct` requires a measured output). The epoch-1 run reproduces at `ce49e42c` only.
- **The control checkpoint caught an incomplete gold answer before any arm spend.** Run
  `variance-e2` (kept as evidence, $0.12, judge only) stopped `InstrumentFailure`: the gold
  control of `consumer-prepush-schema-behind-refusal` graded correct in both passes, but key-point
  coverage was 0.78 against the 0.80 bar. The judge was right: the gold text omitted kp5 (why the
  existing tests passed) and kp6 (a definite set difference is outside the fail-open contract).
  **Fixed the gold control text only** (rubric, context and question unchanged), re-froze
  (corpus `7449289d71f9`), and re-ran as `variance-e2b`. This is instrument repair made before
  any arm output existed under epoch 2, not a change made after seeing results.
- **The egress gate refused a case's arm payload mid-run** (`variance-e2b`, kept as evidence,
  $0.68: checkpoint + 5 Opus calls, then a crash). `disposable-db-guard-predicate` quotes this
  repo's own stock local-dev DSN (`postgres:postgres@127.0.0.1`, already public, not a real
  credential) and it matched `dsn-password`. The gate was right and was not bypassed. Two fixes:
  (1) the credential part of that excerpt is elided to `postgres://[credentials elided]@…` and the
  case re-frozen (corpus `5eb0beae2798`); (2) the runner now **egress-checks every case's arm
  payload before any spend** and stops cleanly (`InstrumentFailure`) instead of crashing after
  paid calls (tested). The 5 Opus outputs from e2b were produced under a superseded corpus hash
  and are excluded.
- **Epoch-2 variance runs at 3 reps, not 4.** The budget scope `autonomous` had $6.41 left after
  e2b. At 4 reps the projected scope total was about $9.25 of $10, too close given the per-call
  worst-case reservations, and a budget stop during grading would leave paid outputs ungraded.
  At 3 reps there are 2 degrees of freedom per case across 10 cases, i.e. 20 within-case dof vs
  epoch 1's 15, which is enough to estimate `s_w`. The variance phase is not the comparison, so
  the main run's n is still set by `proposeReps` from the measured spread.

## 2026-11-15 — variance phase

- **"Correct" counts one output whose q is unmeasured.** `cli-system-honour-claim` r3: pass 2
  was voided by one unverified quote (q null), but both passes said the decision was correct, so
  `combinePasses` counts it in `correct` (14/20) while it is excluded from `meanQ` / `s_w`. The
  plan defines a measured output as both passes non-null. The consistent rule is that `correct`
  requires a measured output, which gives 13/20 and $0.161 per correct. **Not changed after reading
  outputs.** Proposed for the main run as an epoch-2 fix. It does not change `s_w` or the proposed n.
- **The rubric penalises hedging where an excerpt settles the point.** Rubrics credit the gold
  answer's certainty ("the rewriter excerpt establishes it"). An arm that says "probably, verify by
  rendering" loses key points even when its method is right (seen on Haiku's
  `stale-override-four-sites`). This applies to both arms equally, so it is not a bias between them.
  It is part of why q is harsh. Recorded, not changed.
- **The model-name scrub also rewrites tool names.** `scrubModelNames` turns `claude -p` into
  `[model] -p` in graded text (code audit H11, accepted as a limit). The quote check scrubs both
  sides, so verification is unaffected, and both arms are treated identically.
- **Judge splits on individual outputs.** Two outputs split between passes (0.35/0.95, 0.20/0.80).
  Mean judge noise (0.07) passed its gate, but item-level noise is real. The main run's spot sample
  (Louis, all sampled rows) is the check.

## 2026-11-15 — build order

- **Implementation began before `/audit-plan` finished.** Cluster A (judge transport fix,
  Fable 5.2 price row) and the Cluster B library were written while the plan audit ran.
  No spend-bearing run starts until the plan audit and the code audit have converged;
  any plan change the audit forces is applied to the code before the rehearsal.
- **Corpus authored by a delegated agent from a verified dossier**, then reviewed here
  for privacy (no private-consumer identifiers) and leaks (`leakScan` clean on all 5).
  Judgment calls the agent made (elided interpretive sentences in case 1, stripped
  answer-bearing comments in case 2, a private-repo test-header comment omitted in case 5)
  are recorded in each case's `sources` / the PR description.
- **Design forks are under-covered** (1 of 5 cases). Per-role verdicts are possible for
  `review` and `cross-repo` only; `design-fork` will report `untested` unless a case is
  added before the main run.
