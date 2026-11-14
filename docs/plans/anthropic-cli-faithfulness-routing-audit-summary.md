# Audit summary — anthropic-cli-faithfulness-routing

- **Plan**: [`anthropic-cli-faithfulness-routing.md`](anthropic-cli-faithfulness-routing.md)
- **Date**: 2026-11-14 → 2026-11-15
- **Session**: `audit-code-1794695240854-77644`
- **Scope**: `--scope diff` (R1), then R2+ diff-scoped per round
- **Cloud run id** (final round): `a85b36a0-7368-4f48-a152-a9e6c011d0a9`

## CONVERGED — Round 6

| | |
|---|---|
| Final | **H:0 M:0 L:0** |
| Rounds | 6 (cap 6; R5 and R6 both threshold-met, R6 with zero findings) |
| Findings total | 19 across 6 rounds |
| Disposition | 14 accepted+fixed · 2 severity-adjusted+fixed · 3 dismissed |
| File coverage | `complete` every round |
| Local gate | `guards:preflight` PASS, 35/35 steps, 2591 tests |

### Per-round

| round | verdict | H | M | L | coverage |
|---|---|---|---|---|---|
| R1 | SIGNIFICANT_ISSUES | 5 | 1 | 0 | complete |
| R2 | SIGNIFICANT_ISSUES | 2 | 2 | 2 | complete |
| R3 | SIGNIFICANT_ISSUES | 3 | 1 | 0 | complete |
| R4 | PASS | 0 | 2 | 0 | complete |
| R5 | PASS | 0 | 1 | 0 | complete |
| R6 | PASS | 0 | 0 | 0 | complete |

R4 and R5 met the convergence threshold (`H==0 && M<=2 && quickFix==0`) but
their findings were fixed rather than accepted, because both said a guard in
this change did not guard — see §6.F of the plan.

## CENSUS — final round (R6)

| identifier | state | reason |
|---|---|---|
| `backend` | completed | ran; 0 findings |
| `sustainability` | completed | ran; 0 findings |
| `structure` | ineligible | not selected for R2+; `--files` overrides `--scope`, and R2+ scope is the round's diff. Ran in full at R1 |
| `wiring` | ineligible | as `structure` |
| `frontend` | ineligible | backend-only diff; no frontend surface in scope any round |
| `quickfix` | completed | ran at R1–R3 (raised H4/H5 at R1); 0 at R6 |
| `duplication` | completed | JS/TS diff, examined |
| `adjacency` | completed | JS/TS diff, examined |
| `arch-memory` | ineligible | `--scope=diff`; the symbol catalogue is a `--scope=full` input (Step 0.5) |
| `file coverage` | completed | `_coverage.status: complete`, `gate: pass`, every round |
| tool pre-pass (`eslint`) | `no_tool` | **not a clean lint** — no eslint project resolved in this repo, so nothing was linted |

`structure`/`wiring`/`frontend` are `ineligible` for R2–R6 by the skill's own
R2+ rule, not skipped by choice; R1 ran all five passes. The `eslint` row is
`no_tool`, which is explicitly not a clean result.

## What each round found, and what its fix missed

The same Silent-Data-Loss concern was raised in four consecutive rounds, each
time against the previous round's fix. That sequence is the most useful output
of this audit and is written up as plan §6.F.

| round | defect | the fix's blind spot |
|---|---|---|
| R1 | `summariseBatch` read neither `stop_reason` nor the entry count | — |
| R2 | the oracle treated a full slate of entries as clearing a `max_tokens` stop, **and the test asserted it** | a populated slot is not a *finished* one |
| R3 | the verdict was computed, logged, then **discarded**; `main()` re-derived `complete` from a null count | two places computing one answer (single-oracle) |
| R4 | the propagation tests never executed `summariseBatch` or `main()` | **the guard's stated subject was a layer it never ran** |
| R5 | the integration helper had no subprocess timeout | a hang would read as unrelated flakiness, not a defect |

**Rule extracted**: a check that agrees with the thing it was meant to check
independently has stopped being a check. R2 was an implementation and its test
agreeing; R4 was a test suite whose comment claimed a layer it never executed.
Both passed. Only reverting at the *right layer* separates them.

## Adjudicated against the auditor

| finding | ruling | outcome |
|---|---|---|
| R1 H2/H4 — `max_tokens` accepted-but-unenforced on cli | **compromise** (GPT deliberation, HIGH→MEDIUM) | The description was accepted; the recommendation ("refuse when `max_tokens` is supplied") was arithmetically "always sdk", since the Messages API requires it and all 17 ambient sites set it, and would have required deleting the `BILLING PIN` control. GPT's counter — an operator-level strict path — was better than the rebuttal's position and was adopted as `CLAUDE_CLI_STRICT_MAX_TOKENS`, default off |
| R2 L1/L2 — `process.exit(2)` vs the drain convention | dismissed, false-positive | The cited invariant names "a `stderr` write before an exit" as its own deliberate non-finding (`AGENTS.md:98`); the branch writes to stderr, so there is no stdout buffer to drain |
| R3 H2 — missing `--selfcheck-relocation` | dismissed, false-positive | Verified in the enforcing code: `relocation-guard.test.mjs` iterates `CLI_SMOKE_SET` joined against `scripts/`, the contract covers consumer-synced CLIs, and the sibling `docs/research/out-of-diff-noise-campaign/replay.mjs` carries no handler either |

## Negative controls (all run, none assumed)

| revert | result |
|---|---|
| `unserviceableCliParams` → `null` | 13 of 19 fail; the 5 must-not-fire cases stay green |
| `strictMaxTokensRequested` → `false` | 4 of 27 fail (the strict-path tests) |
| `strictMaxTokensRequested` → `true` | 9 of 27 fail — the `BILLING PIN` and default-serviceable tests, i.e. the direction it must **not** fire |
| `assessBatchCompleteness` → always complete | 7 of 15 fail |
| `complete` → `missing.length === 0` (the pre-R2 defect) | 2 fail, by name |
| `main()` recomputes `complete` from the null count | integration suite **fails**; unit suite passes 19/19 — the asymmetry R4 predicted |
| `incompleteBatches++` removed | integration suite fails 2 |
| a provider that hangs forever | `ETIMEDOUT` + SIGKILL at the cap, named in the failure |

## A figure that corrected itself

Re-running the committed harness produced a **5th** sdk sample of **1308**
output tokens, 14% above the 1146 maximum from the first four. The audit's "four
samples do not establish that every batch fits" was therefore right on this
plan's own numbers; `TOKENS_PER_SYMBOL` went 192 → 256 and the plan records the
correction rather than re-fitting the range.

## Not verified here

- The **full** test suite ran only in `guards:preflight` (35 gates, 2591 tests).
  The whole suite runs in the GitHub `full-suite` check on the PR.
- The **consumer-synced bundle is unverified** — nothing is merged, and
  `scripts/lib/anthropic-cli-faithfulness.mjs` is a new lib module in the sync
  closure. After merge, confirm it reaches a consumer with
  `node scripts/.claude-skills/lib/sync-isolation-verify.mjs` in that
  consumer's MAIN checkout.
- No `docs/status/` entry: that is written at `/ship` time with the PR number.
