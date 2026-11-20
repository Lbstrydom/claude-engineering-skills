# Plan: Solo-control hardening — pre-existing defects PR #413's audit found but did not touch

- **Date**: 2026-11-20
- **Status**: In Progress — fixes implemented; audit and merge pending
- **Author**: Claude + Louis (Louis: "Yes, plan + fix", 2026-11-20)
- **Scope**: backend (`scripts/solo-control-audit.mjs` CLI + `scripts/lib/solo-control/**`, `scripts/lib/campaign/redo.mjs`, `scripts/campaign.mjs`, `scripts/lib/fleet/**`)

> **Target domain(s)**: `audit-orchestration`, `shared-lib`, `tests`

## 1. Source and method

PR #413's `/audit-code` R1 dismissed a set of findings as pre-existing in code #413 did not touch (ledger
`audit-code-1795205136472-96128-ledger.json`, entries with `adjudicationOutcome: dismissed`, in the sashiko chip's
worktree `.audit/`). That ledger holds **32 dismissed entries = 23 distinct defects** (the audit raised several twice,
once under `[be-services]` and once under `[Sustainability]`); the hand-over said 27. Each was re-read against
`origin/main` at `e220dedf` (#413 merged); none was moot by #413 itself. Severities below are the audit's, adjusted by impact.

## 2. Triage

| # | Defect (ledger ids) | Verdict | Sev | Disposition |
|---|---|---|---|---|
| 1 | `apparatus-bc`, `sonnet-gemini-retro`, `solo-pass-retro`, `judge-gpt` send diffs to providers with no recipient policy (H1, H16) | real | HIGH | **fixed** — policy loaded + `authorizeAll` per commit, before extraction |
| 2 | A cold pass that got NO reply (401, 429, 5xx) is recorded as a conformance miss with 0 findings; commit reads `ran` (H4, H19) | real | HIGH | **fixed** — `providerError` cell → `provider-error` ledger row, commit `provider-error`, resume re-runs it |
| 3 | `budgetBreached` passes when a call is unpriced; `--budget-usd NaN` never breaches (H5, H17) | real | HIGH | **fixed** — `budgetVerdict`: unmeasured ⇒ stop ("UNCHECKABLE"); non-finite/negative budget refused (exit 2) |
| 4 | Blind CSV and private map replaced separately (H6, H24) | real | HIGH | **fixed by detection** — two files cannot be one atomic rename, so `score` now refuses an unpaired sheet/map (#7) |
| 5 | CSV quote loss: `parseCsvLine` drops `"`, records split on newlines (H8) | real | HIGH | **fixed** — RFC 4180 `parseCsv`/`csvField` (`lib/solo-control/csv.mjs`), used by merge, judge and score |
| 6 | `--batch-size 0` / `--max-chars 0` loop forever (H15, H18) | real | HIGH | **fixed** — `positiveInt` on every size flag, exit 2 |
| 7 | `score` coverage ignores deleted rows and unknown ids (H9, H25) | real | HIGH | **fixed** — `sheetPairingProblems`: every map id exactly once, no unknown id, commit/severity/category agree; exit 4 |
| 8 | Gate sees chunk 0 only; saved pre-gate context is chunk 0 (H10, M3) | real | HIGH | **fixed** — gate reads the whole diff; pre-gate artifact records `gateContextScope:'full'`; a legacy multi-chunk artifact is refused for `--gate-only` |
| 9 | Resume reuses units after model / effort / repeats / chunk-size change (H11, H20) | real | HIGH | **fixed** — `assertResumableProvenance` in `cmdRun` and `cmdApparatus`, `--force` is the way out |
| 10 | Judge writes returned `blind_id`s into the grade map unchecked (H14) | real | HIGH | **fixed** — `validateGradings` (in this batch, once) |
| 11 | Pre-gate artifact: findings not bound to the verified digest (H21) | real | HIGH | **fixed** — `findingsSha256` written and checked; legacy artifact warned, not trusted silently |
| 12 | Judge resume identity omits model and KD rubric (H30) | real | HIGH | **fixed** — `<out>.meta.json` sidecar; mismatch re-grades, legacy output kept with a warning |
| 13 | `cmdScore` writes stdout then `process.exit(0)` (H27) | real | HIGH | **fixed** — `await finishAndExit(0)` |
| 14 | Gemini adapters accept any JSON object as "no findings" (M2) | real | MED | **fixed** — `geminiFindingsOrMiss` validates `ShadowPassSchema` |
| 15 | `recordRuleState` read-then-append race (H2) | real | HIGH | **detected, not prevented** — post-append recount flags a concurrent writer (`ok:false`, re-run reconcile). Prevention needs a store-side constraint, see §4 |
| 16 | Fleet: absent uncommitted entry reads as `[]`; `uncommittedUnknown` never moves the verdict (M1) | real | MED | **fixed (facts half)** — an absent entry is now `uncommittedUnknown`, so `decideClaim` discloses it as `uninspected`. The verdict half is NOT changed: `fleet-lifecycle` pins "uncommitted evidence is advisory — disclosed, never a verdict" (a probe-deadline holder with no path overlap stays `ok`), unlike `changedUnknown`, which can hide a BLOCKING committed overlap. Treating `uninspected` as a WARN would make every probe timeout noisy; that is Louis's call, not a hardening fix |
| 17 | `resolveRedoRows` does not itself check `human.ok` (H3) | real (latent: the store fails closed) | HIGH→LOW | **fixed** — an unreadable guard refuses every id |
| 18 | `claimConflictBucket` counts every claim failure as a benign skip (H28) | real | HIGH | **fixed** — only `code:'claimed'` skips; anything else throws. Updates the one test that encoded the old contract |
| 19 | Wiring test greps source text (M4) | real | MED | **fixed** — behavioural tests in `tests/solo-control-hardening.test.mjs` run the subcommands |
| 20 | `fetchExternalFindings` does not filter by repo (H7) | moot | LOW | not fixed — a shared SHA is a shared commit, so the findings are about the same diff; no wrong-diff path exists |
| 21 | Top-level `model` replaced on incremental retro runs (H13) | moot for `cmdRun` (#9 now refuses the mix); LOW for the retro arms | LOW | not fixed — every finding row carries its own `model` |
| 22 | `computeCallId` omits measurement config and audited tree (H12, H22) | real | MED | **deferred** — §4 |
| 23 | `extractAuditedDiff` infers the base as the parent of `auditedSha` (H23) | real, accepted | LOW | **deferred** — §4 |

## 3. Design notes

- **Unpriced means unmeasured** (AGENTS.md cost rule). `budgetVerdict` counts a row as unmeasured when it reached a
  provider (`ok`/`conformance-miss`, or any row with usage) and carries no `costUsd`. A `provider-error`/`excluded` row with no
  usage is NOT counted: nothing came back, and counting it would wedge the experiment on its own failures. The budget
  dedupes by `callId` last-row-wins, the rule `aggregateCostForArm` and `completion.mjs` already use (the old budget
  kept the FIRST row, so a priced re-run never superseded an unpriced attempt).
- **Spend consequence of #8**: for a multi-chunk commit the gate input is the whole diff instead of chunk 0 (bounded by
  `--max-diff-chars`); single-chunk commits are byte-identical. It is priced through `usage`, as before.
- **Spend consequence of #2/#3/#9**: all three can only *stop or refuse* a run; none sends an additional call.
- `solo-control-audit.mjs` was over its 1000-line ratchet baseline (2495): the judge block moved to
  `lib/solo-control/judge.mjs`, the guards to `lib/solo-control/hardening-guards.mjs`, the CSV to `csv.mjs`; the baseline
  is lowered to the new count, never raised.

## 4. Deferred, with the independence named

- **Call identity (#22)** — `callId` is deterministic over (commit, purpose, pass, chunk, repeat, model) and the ledger
  dedupes by it by design (a shared 5-pass cell is one spend under several `sharedBy` labels). Adding config/tree/attempt
  to the id changes the id of every recorded row, which splits every existing shared cell and re-prices the whole
  experiment's history: a ledger-epoch decision (Louis's — baselines and recorded data), not a code fix. Consequence now
  stated in `budgetVerdict`'s doc: a `--force` re-run of the same cell does not add spend, so the budget is a floor.
  The new code does not depend on this path: it only changes which rows are summed, never how ids are made.
- **Audited base (#23)** — no column records the real base of an `--base` run; the fix is an `audit_runs` column (a
  migration). The new code does not call `extractAuditedDiff`.
- **Race prevention (#15)** — a unique/serialising constraint on `campaign_events` is a migration. Detection ships now;
  a reconcile that races reports it and exits 1, so the operator re-runs and the chain converges.
- **Per-call budget reservation (H17's second half)** — the ceiling may be overshot by at most one in-flight call;
  plan §8 states the cap as "enforced at preflight of each cell". Not a defect against that contract.

## 5. Tests

`tests/solo-control-hardening.test.mjs`, `tests/solo-control-hardening-r1.test.mjs` (+ `tests/campaign-adjudicate.test.mjs`):
every fix has a red-then-green test and a negative control (the guard does not fire on the healthy input). Red was
confirmed by restoring origin/main's copies of the six touched files and running the suite (20 of 51 failed; the rest are
pure-guard tests whose subject did not exist).

## 6. /audit-code round 1 on this change (37 findings) — triage

Fixed (new code or a gap in a fix above): pairing now also binds `file`+`detail` through a per-row `sig` written by `merge`
(H6/H19/H27); the judge sidecar binds the CSV it describes, so an interrupted checkpoint re-grades instead of trusting
(H7/H20); a cold pass whose reply carried no usage reports `usage:null` = unmeasured (H10/H17); a permanent 4xx is attempted
once (M5); the budget compares unrounded (M3); `parseCsv` rejects text after a closing quote (H15/M4); `judge` treats "no
structured output" as a failed batch (H14); `--label` is validated as a filename (H13); `cmdApparatus` records a commit whose
generation passes never replied as `provider-error`, and the pre-gate artifact now carries `gptModel` + `generationFailedCells`
that `--gate-only` checks (H8/H23); `merge`'s clustering call consults the recipient policy per commit (H2) and its
fallback cluster key is commit-scoped and no longer `solo:undefined` for rows without `_dup` (H25); the three diff
extractors pass `--literal-pathspecs` so a clean file name cannot select an excluded file (H1).

Rebutted or deferred, with the reason: provider-error rows without usage stay out of the unmeasured count (H9/H18/H28 —
deliberate, §3: counting them wedges the run on its own failures); call identity (H3/H16/H28 — §4, #22); race prevention
(H5/H21/H29 — §4, #15); legacy arm files and judge outputs with missing provenance resume with a warning, not a refusal
(H4/H22/H30 — refusing would force `--force` re-spend on every existing arm; unknown is disclosed, not trusted silently);
DeepSeek responses without a fingerprint (H4), discovered-unit findings keyed by commit SHA (H11), repo scoping (H12, #20),
`extractAuditedDiff` base (H24, #23), retro baseline completeness (H26), `cmdRun` end-of-run metadata checkpoint (M2),
retro top-level model (M1, #21): pre-existing paths this change neither calls nor depends on. M6/M7 are the adjacency
wave's own enumeration bound, not findings.
