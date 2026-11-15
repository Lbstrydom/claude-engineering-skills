# Deviations ledger — Fable 5.2 vs Opus 5.5 decision eval

Plan: [`docs/plans/fable-vs-opus-decision-eval.md`](../../plans/fable-vs-opus-decision-eval.md) §C10.
Anything off-contract, outstanding, or differing from the plan is recorded here
**before** merge and raised to Louis in the PR description. Newest first.

## 2026-11-15 — focused code audit of the post-audit delta (after the experiment)

The last code-audit round ran on the tree just before `d5d83b8f`. Three later code commits had not been
audited: `60c848f3` (epoch 2), `c72a1d69` (egress pre-check) and `6b18b17d` (cross-grade). A focused
`/audit-code` covered them. Fixes:
- `cross-grade` refuses a budget scope other than the main run's.
- `report` and `cross-grade` refuse a run produced under a different corpus hash, epoch or prompt hashes.
- The existence check is repeated under the scope lock.
- `loadCorpus` verifies and returns cases from one read.
- Cross-grade controls are checked by identity.
- `CaseSchema` requires `trap1`.
- The Gemini reservation is bounded by the request actually sent.
- The served model id is persisted.

**Control rule tightened for future runs:** a control now passes only with a measured q, both in the
primary `controlOutcomes` and in the cross-grade check. This closes the weakness recorded in the
next entry. **No persisted result changes.**
- `report --run-id main` reproduces `summary.json` and `cross-grade.json` byte-identically.
- The persisted cross-grade `controlPassed` flags are kept as graded. Under the tightened rule,
  Gemini's controls would fail, which gives the same outcome: not certified under the rule.

## 2026-11-15 — spot sample: CERTIFIED BY OVERRIDE (Louis)

- **Louis's ruling**, relayed verbatim by the coordinator: "as for certify, if I read this correctly it
  is pretty clear on the result so I am assuming certify by override is ok?" That is option 1 of
  [`verdict.md`](verdict.md) §4.
- **This is an override, not a pass under the pre-registered rule.** Under the rule the sample is still
  12/12 exceptions and `certified: false`. `cross-grade.json` and `summary.json` are **not** edited to
  say otherwise; the override exists only here and in `verdict.md`.
- **Stated reason:** the failure was an instrument incompatibility. Gemini (`gemini-pro-latest`) did not
  follow the verbatim-quote contract: its quotes were paraphrased or `...`-elided, so the mechanical
  quote check voided all 12 of its grades (E3). This is not evidence that the primary judge misgraded.
  - GPT agreed with the primary on 12/12, with q within 0.05.
  - Gemini's decision calls agreed on 7/9.
  - Both of Gemini's disagreements were lenient, one per arm, with no arm-directional pattern.
- **Disclosure kept:** the spot sample was graded by LLMs, not a human, and the two may share biases.
  The GPT grader is the same model as the primary judge. This is not equivalent to human review.
- **Certified outcome:** `opus:material-gain-ruled-out` (by override).

## 2026-11-15 — spot-sample outcome: exception (awaiting Louis)

- Cross-grade ran as pre-registered (fixture `fable-opus-xgrade` at `6b18b17d`, $0.80, scope `main` now
  $15.12 of $25). Both graders passed 20/20 controls.
- **Gemini voided all 12 sample grades.** Its "verbatim" quotes are paraphrased or `...`-elided, and the
  mechanical quote check refused them. That makes 12/12 items E3, so the verdict is **not certified**.
  GPT agrees with the primary on 12/12. Gemini's decision call agrees on 7/9, and its 2 disagreements are
  lenient, one per arm.
- **Not done:** re-running Gemini with a relaxed quote check. That would change a pre-registered
  instrument after seeing its output.
- **Known weakness, recorded and not changed after the fact:** the single-pass control definition
  (copied from the primary checkpoint) checks `correct` and coverage but not `q`. So a gold control
  whose grade carried an unverified quote still counts as passed. 5 of Gemini's 10 gold controls were
  like that. Had controls required a measured q, Gemini would have failed its controls, which is the
  same outcome: not certified.
- Options and recommendation: [`verdict.md`](verdict.md) §4.

## 2026-11-15T15:52Z — spot sample: two cross-vendor graders replace the human marks (pre-registered)

Louis changed the protocol, relayed by the coordinator: "why don't we use Gemini and GPT from our
brainstorm to do the grading - then only if there is an exception you can bring that to me with
your recommendation". **This entry is written while the main run is still in progress. No
main-run arm output, grade or summary has been read.** The rule below is fixed now and is not
changed after the main run's results are seen.

- **Sample.** The main run's own persisted draw, `summary.spotSampleIds` (seeded, ⌈0.2·n⌉, min 4;
  at 60 calls that is 12 items). Variance runs are not regraded.
- **Graders.** S1 = GPT (`latest-gpt`), S2 = Gemini (`latest-pro`). Both use the providers
  `/brainstorm` uses. Each grades every sampled item **once, independently**. A grader sees the
  same blinded, model-name-scrubbed judge input and frozen rubric the primary judge saw. It never
  sees the primary's grade, the other grader's grade, or which arm wrote the output. Each grade
  goes through the same schema and the same mechanical quote check; an unverified positive quote
  voids that grade.
- **Positive control first.** Each grader grades every case's frozen gold and trap answers,
  20 per grader, under the same pass/fail definition the primary judge's control checkpoint uses.
  A grader that fails **any** control contributes no spot-sample grades. The sample then cannot
  certify and goes to Louis as an exception.
- **Primary reference per item.** `correct_p` is the judge label used everywhere else: correct
  only when both primary passes say correct. `q_p` is the mean of the two primary passes.
- **Item exception** if any of these holds:
  - **E1:** both S1 and S2 disagree with `correct_p` on correct vs. incorrect.
  - **E2:** |mean(q_S1, q_S2) − q_p| > **0.25**. That is larger than Δ_target (0.20): a
    disagreement bigger than the effect the experiment is built to detect is material.
  - **E3:** either grader's grade is unmeasured (transport, malformed, or quote-voided). Unchecked
    is not agreement.
- **Sample-level rule.** The verdict **certifies only if** both graders pass every control **and**
  the exception rate is **≤ 0.20** (≤ 2 of 12). This matches the former human-agreement gate
  (≥ 0.8). The existing credibility gate receives `spotAgreement = 1 − exceptionRate` and keeps
  its 0.8 threshold unchanged.
- **Cost.** Metered per call in the same ledger, under the existing budget scope `main` and its
  $25 cap.
- **Escalation.** Louis sees only the exceptions. Each comes with the item, the three grades and a
  recommendation. With no exceptions, the report states "certified" plus the agreement figures.
- **Limitation, stated in the verdict.** Both graders are LLMs and may share biases. S1 is the
  **same model** as the primary judge: its independence is a fresh, blind call, not a different
  model. Only S2 is a different vendor. This is not equivalent to human review.

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
