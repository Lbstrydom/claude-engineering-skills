# Deviations ledger — Fable 5.2 vs Opus 5.5 decision eval

Plan: [`docs/plans/fable-vs-opus-decision-eval.md`](../../plans/fable-vs-opus-decision-eval.md) §C10.
Anything off-contract, outstanding, or differing from the plan is recorded here
**before** merge and raised to Louis in the PR description. Newest first.

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
