# Skill-efficacy census — verdict memo

**Generated**: 2026-08-22, from `node scripts/cross-skill.mjs skill-census --format json`
(window: 14 days) against the live store, repo `Lbstrydom/claude-engineering-skills`
(`repoId 6461a693-6690-4bf3-98ee-14c0385cc357`). Per
[docs/plans/skill-efficacy-census.md](../plans/skill-efficacy-census.md) §Phase 4:
verdicts are read from that CLI's actual output, not hand-computed.

## Start-condition status: NOT MET — this is an early, provisional read

The plan's Phase 4 executable start condition is: **Cluster A merged AND EITHER
≥7 calendar days elapsed since that merge OR ≥1 finding credited via the
widened nudge — whichever comes first.**

As of this writing:

- Cluster A landed as commit `31be06c5` at `2026-08-22T11:30:35+02:00` — **on a
  local worktree branch, not yet pushed to `main`**. Zero calendar days have
  elapsed since it landed, let alone since it would go live for real `/ship`
  runs across the working tree.
- Direct query against `audit_findings` for primary-bucket credits since that
  timestamp:

  ```sql
  select count(*) from audit_findings
   where user_action in ('accepted-permanent', 'dismissed')
     and bucket is null
     and decided_at >= '2026-08-22T11:30:35+02:00'
  ```

  Result: **0**.

Both halves of the OR are unmet, so per the plan's own **no-data decision
rule**, this memo states that plainly rather than waiting indefinitely or
fabricating a mature-window verdict. The zero here is *expected*, not a
finding: the widened nudge hasn't shipped to `main` yet, so nothing could have
been credited against it.

**What this means for the numbers below**: the per-skill `insufficient-data` /
`prune` / `invest` / `keep` calls use `allTimeCount` and window
current/prior — signals Cluster A's fix does not touch. Those are read as
normal. The **conversion-rate columns are the ones Cluster A's fix is about**
(closing the under-scoped `pendingQueue` read); they are shown below for
completeness but predate the fix going live and should not yet be read as
evidence of the widened nudge's effect either way.

**Re-run trigger**: re-run this memo once Cluster A has been on `main` for 7
calendar days, or once the query above returns ≥1, whichever comes first.

## Structural caveat: this census is single-repo, and this repo has no live app

The store's `skill-census` rows are `repo_id`-scoped to
`claude-engineering-skills` itself — the skills bundle's own source/tooling
repo, not a downstream consumer. This repo has no deployed frontend, so the
four browser-driven lenses (`persona-test`, `click-test`, `nav-audit`,
`ux-lock`, `visual-audit`) are **structurally inapplicable here**, independent
of whether they're valuable in a consumer repo with a real UI. Their
`insufficient-data` calls below read that way and must not be misread as "this
lens earns its keep nowhere" — see the plan's own §1 trade-off: no cloud
persistence exists yet for `click-test`/`visual-audit` by design, and the
other three simply have nothing local to point at.

## Per-skill verdicts

Rubric (plan §Phase 4, evaluated in this exact order, first match wins):
1. **`insufficient-data`** — `allTimeCount` < 5 (checked first, regardless of trend).
2. **`prune`** — clears the floor, AND current window ≤1 AND prior window ≤1.
3. **`invest`** — clears the floor, AND current > prior (strict), AND current ≥ 3.
4. **`keep`** — default: clears the floor, matched neither rule above.

| Skill | Verdict | Rule fired | n (allTimeCount) | current / prior window |
|---|---|---|---|---|
| `audit-code` | **invest** | current(88) > prior(23), current ≥ 3 | 172 | 88 / 23 |
| `audit-plan` | **invest** | current(32) > prior(26), current ≥ 3 | 82 | 32 / 26 |
| `plan` | **invest** | current(29) > prior(22), current ≥ 3 | 90 | 29 / 22 |
| `ship` | **invest** | current(74) > prior(43), current ≥ 3 | 201 | 74 / 43 |
| `cycle` | **invest**† | current(67) > prior(6), current ≥ 3 | 87 | 67 / 6 |
| `persona-test` | **insufficient-data** | n < 5 | 0 | 0 / 0 |
| `nav-audit` | **insufficient-data** | n < 5 | 0 | 0 / 0 |
| `ux-lock` | **insufficient-data** | n < 5 | 0 | 0 / 0 |
| `click-test` | **insufficient-data** | n < 5 | 4 | 0 / 4 |
| `visual-audit` | **insufficient-data** | n < 5 | 0 | 0 / 0 |
| `explain` | **insufficient-data** | n < 5 | 0 | 0 / 0 |
| `investigate` | **insufficient-data** | n < 5 | 0 | 0 / 0 |
| `brainstorm` | **insufficient-data** | n < 5 | 1 | 1 / 0 |
| `security-strategy` | **insufficient-data** | n < 5 | 0 | 0 / 0 |
| `ai-context-management` | **insufficient-data** | n < 5 | 0 | 0 / 0 |
| `skills` | **insufficient-data** | n < 5 | 0 | 0 / 0 |

† `cycle`'s 14-day current window (67 commits) overlaps this same
implementation session, which alone produced dozens of `AI-Skill: cycle`
trailers on 2026-08-22. A single high-volume session inside the window is not
by itself evidence of a sustained trend — re-read this row once the current
window no longer contains today.

No skill fell into `prune` or the bare `keep` default in this snapshot: every
skill either cleared the `insufficient-data` floor and was trending up
(`invest`), or sits below it entirely. That is itself informative — nothing
here shows a *sustained decline from real historical usage* (the `prune`
claim), only "clearing the floor and growing" or "never enough signal yet."

## Conversion rate — informational only, not a rubric input

Per the plan: conversion rate is right-censored by construction (the
`current` window's findings have had systematically less time to accumulate a
fix than `prior`'s) and is **never** a rubric gate. Shown here for the two
skills that produce it, with that caveat standing, **plus** the start-condition
caveat above (both windows below predate Cluster A's fix reaching `main`):

| Skill | current numerator/denominator | prior numerator/denominator |
|---|---|---|
| `audit-code` | 624 / 755 (82.6%) | 172 / 218 (78.9%) |
| `audit-plan` | 296 / 352 (84.1%) | 138 / 152 (90.8%) |

Do not read `audit-plan`'s lower current-window rate as decline — per the
caveat above, `current`'s findings simply haven't had as long to be fixed as
`prior`'s, and neither window yet reflects the widened primary-bucket credit
path Cluster A adds.

## Bottom line

- **No skill is recommended for `prune` in this read.** The four established
  backend-pipeline skills (`audit-code`, `audit-plan`, `plan`, `ship`) plus
  `cycle`'s trailer-proxy signal all clear the floor and show `invest`-shaped
  growth this window — expected, since this repo actively develops itself
  using its own skill chain.
- **Nine skills sit in `insufficient-data`, and that is a data-completeness
  finding about this one repo, not a verdict about the skills.** Five of the
  nine (`persona-test`, `nav-audit`, `ux-lock`, `click-test`, `visual-audit`)
  are structurally inapplicable to a repo with no deployed UI — see the
  caveat above. The remaining four (`explain`, `investigate`,
  `security-strategy`, `ai-context-management`, `skills`, `brainstorm` at
  n=1) genuinely have thin or no trailer history here and would need either
  more elapsed time on this repo or a bundle-wide (not repo-scoped) view to
  say more.
- **The one metric this plan was built to fix — conversion rate under the
  widened primary-bucket credit scope — has not been observed under live
  conditions yet.** Re-run this memo per the trigger above once Cluster A is
  live on `main` and either 7 days have passed or the first credit lands.
