# Plan: Audit convergence metrics (item 8d)

- **Date**: 2026-11-12
- **Status**: Complete — plan-audit 2 rounds, code-audit 3 rounds + Gemini final review APPROVE (2026-11-12)
- **Author**: Claude + Louis
- **Scope**: backend (read-only store query + CLI + one dashboard section; no UI framework work)

> **Target domain(s)**: `audit-orchestration`, `shared-lib`, `dashboard`, `tests`

## 1. Context

`docs/research/consumer-feedback-2026-11-11.md` theme 8, item 8d: Anthropic tracks the share of PRs passing after
one review round (65% to 78%) and the share needing 5+ rounds (8.9% to 1.5%). CES has no equivalent number, so item
1c (out-of-diff audit noise) would have no "before". This builds the measurement and records the baseline.

Measured 2026-11-12 against the live store (`audit_runs`, 6,924 rows, 2026-07-17 on):

| Fact | Evidence |
|---|---|
| One row per ROUND. `rounds` is the round index of that row (1, 2, 3...), not a session total. | `rounds` sequences per (repo, plan_file, branch) |
| `rounds = 0` is the pre-finalise initial state, not a real round. | `recordRunStart` (see memory `feedback_audit_runs_row_granularity`) |
| `audit_session_id` / `audit_round` are populated on only 112 of 4,093 rows in the last 30 days (since about Nov 2). | `count(audit_session_id)` |
| `round_converged_after` is set (always equal to `rounds`) on the code-audit rounds where the convergence threshold was met; it is never set on plan rows. | 1,506 code rows, 0 plan rows, 0 where it differs from `rounds` |
| Plan audits pass on `gemini_verdict = 'APPROVE'` (153 rows, none with `round_converged_after`). | same query |
| `run_status`: `complete` / `incomplete` (15) / NULL (2,675, pre-column). `incomplete` means a write was lost. | constraint + column comment |
| Experiment rows (`assignment_id`, `arm_eval_run_id`, `phase`) are not organic work. | arm-eval/model-ab columns |

## 2. Definitions (the design decision)

**A change (an audited session)** is the unit that gets one verdict.
1. If `audit_session_id` is set, rows sharing it and `mode` are one session (`groupedBy: 'session-id'`).
   The key includes `repo_id`; ordering is `created_at` then `id`, so ties are deterministic.
2. Otherwise rows are keyed by `(repo_id, mode, plan_file, branch)`, ordered by `created_at` then `id`, and a new session
   starts when `rounds` strictly DROPS (a restart) or the gap exceeds `--gap-hours` (default 24). Rows repeating the
   same `rounds` value are re-runs of one round (measured: up to 8 rows per round), not new sessions. (`groupedBy: 'inferred'`.)
   Known limit: around the 2026-11-02 cutover a session can have an inferred prefix and an identified suffix; each is
   its own session, and the report prints how many sessions came from each path.
3. `plan_file = 'ad-hoc'` or `branch = 'HEAD'` make a weak key (unrelated changes can share it); they are still
   grouped but counted in `weakKey` and reported.
4. The grouping key does not use `audited_sha`/`audited_tree`: they change every round (every fix is a new tree), so
   they identify a round, not a change. They are not used.

**Rounds-to-pass** ("reviews to pass") is the number of DISTINCT `rounds` values from the session's first row up to and
including its first passing row (the counter often does not start at 1: measured chains starting at 51 and 83). The first
passing row is:
- code: `round_converged_after IS NOT NULL` (the threshold `/audit-code` itself computes: HIGH==0, MEDIUM<=2, quickFix==0);
- plan: `gemini_verdict = 'APPROVE'`.

**Not a pass**: a row with `run_status` other than `complete`/NULL (an INCOMPLETE round is unmeasured, per the AGENTS.md
rule, never a clean one); `rounds = 0`; `CONCERNS`/`REJECT` plan verdicts. Session outcome, in precedence order:
`passed` (has a passing row) > `unknown` (an INCOMPLETE round at or before the pass, or with no pass: a lost write may have hidden an earlier pass, so
neither the outcome nor the pass round is known; such sessions get no rounds-to-pass) > `unpassed` (no pass; `settled` when its last row is older than `--gap-hours`, else `open`). `unknown`
sessions are counted and excluded from the pass-rate denominator. NULL `run_status` (pre-column rows) counts as complete,
which is a stated assumption, not a measurement.

**Excluded, and counted**: experiment rows (`assignment_id`, `arm_eval_run_id` or `phase` set), `rounds = 0` rows, and
sessions whose first row lies within `--gap-hours` of the fetch start (`truncatedHead`: the head may be cut). For identified sessions, which have no gap boundary, truncation is `audit_round > 1` on the first fetched row. A session
that merely starts at a round number above 1 is kept and counted as `startsMidChain`. The report states every excluded
count; none is silently dropped.

**Window**: a session belongs to the window by the `created_at` of its last row. Rows are fetched with a 14-day
lookback before the window start (the store returns the exact `fetchStartMs`, and the report prints `asOf`), so the
upper bound is the same `now` for window membership and the open/settled test. Mode and repo are part of every session key, so
rows are filtered by them BEFORE grouping without splitting any session; every exclusion counter then has the same scope
as the metrics. Per-repo groups are keyed by repo ID (a display name shared by two repos is disambiguated with the id
prefix, never merged). One clock read (`asOfMs`) bounds the query (`created_at <= asOf`, `ORDER BY created_at, id`),
window membership and the open/settled test. `rounds = 0` rows carry no `run_status` (measured: 465 of 465 NULL), so
discarding them loses no incomplete-write evidence.

**Metrics** (per mode, per repo and overall), over PASSED sessions:
- `passedFirstRound` share = passed with rounds-to-pass 1 / passed (the Anthropic "passes after one round" analogue);
- `fiveOrMore` share = rounds-to-pass >= 5 / passed;
- `meanRoundsToPass`, `medianRoundsToPass`;
and beside them `unpassed` (sessions that never passed, split into `settled` older than `--gap-hours` and `open`).
Shares over passed sessions only would hide abandonment, so `unpassed` and `passRate = passed / (passed + settled
unpassed)` are always printed with them. The first-round share is the analogue of Anthropic's "passes after one round"
but is NOT equivalent: the unit here is an audit session, not a PR. Median of an even count is the mean of the two
middle values; shares are rounded to 3 decimals.

**Unmeasured**: a group with zero passed sessions reads `unmeasured` (null shares/mean/median, `status: 'unmeasured'`),
never 0%. Its `passRate` is still a real 0 when settled-unpassed sessions exist (null when none). A cloud-off store reads
`unmeasured: cloud-off`. A query failure is an error (CLI exit 1, dashboard `unexpected-error`), never an empty result.

## 3. Implementation

1. `scripts/lib/audit/convergence-metrics.mjs` (pure): `groupSessions(rows, opts)`, `summarize(sessions, ...)`.
2. `scripts/lib/store/convergence.mjs`: `readConvergenceRows({days, lookbackDays})` one read-only SELECT joined to `audit_repos.name`.
3. `scripts/audit-convergence.mjs` CLI: `--days N` (30), `--gap-hours N` (24), both positive integers (else exit 2), `--repo <name>`,
   `--mode code|plan|all`, `--json` (envelope on stdout), `--out <file>` (JSON to file, one-line summary to stdout; wins over
   `--json`), `--selfcheck-relocation`. load-env banners go to stderr, so `--json` stdout is exactly one JSON value (tested on a subprocess). `assertKnownFlags`, `isInvokedAsScript`,
   `finishAndExit`. npm script `audit:convergence`; registered in the CLI catalog.
4. Dashboard: `collectConvergence` in the telemetry collector, `convergence` in the schema, a section "Convergence"
   in the Audit pipeline group. States: cloud-off and no-sessions render the `missing-optional` empty panel with the reason,
   a query failure renders the warning panel, an unmeasured row renders "Unmeasured" with its reason; every share sits in a
   row beside its counts, with the window, `asOf` and excluded counts under the table. Project-wide, not cwd-scoped.
   Cost: one SELECT over `audit_runs` bounded by `created_at >= fetchStart` (about 7k rows for the whole 4-month history),
   grouped in memory; no new index needed at this size.
5. Tests: pure grouping/summarize cases (resets, session-id, INCOMPLETE, headless, weak key, experiment rows, zero
   eligible = unmeasured, repo split), a CLI flag/selfcheck test, a fixture derived from real row shapes, and a
   dashboard section render test.
6. Baseline: run against the live store, record in the 8d row of the feedback doc the as-of timestamp, the command, the
   definition version, and per mode: passed, unpassed, unknown, the three metrics, and the exclusion and grouping counts.

## 4. Non-goals

No new migration (the columns exist). No change to what audits write. Not a gate: advisory only (exit 0 unless the
CLI itself errors). `audit_session_id` coverage grows by itself; the inferred path is the bridge and reports how many
sessions each path produced.
