# Deviations ledger — Fable 5.2 vs Opus 5.5 decision eval

Plan: [`docs/plans/fable-vs-opus-decision-eval.md`](../../plans/fable-vs-opus-decision-eval.md) §C10.
Anything off-contract, outstanding, or differing from the plan is recorded here
**before** merge and raised to Louis in the PR description. Newest first.

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
