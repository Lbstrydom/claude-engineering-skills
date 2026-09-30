# Plan: Concern identity for re-raise suppression, and a one-week observation window

- **Date**: 2026-09-22
- **Status**: Complete — readout done 2026-09-29 (§3.1): hard-suppress fires, no tuning
- **Author**: Claude + Louis Strydom
- **Scope**: backend

## 1. Problem

A consumer ran six rounds of `/audit-code` and re-adjudicated one concern ("this
module hardcodes an operational limit that should come from policy") under eight
category phrasings across three files. Every dismissal was recorded correctly.
The hard-suppress counter ("Fix #4") never fired: it keyed on an exact category
string plus `affectedFiles[0]`, and both vary between rounds. It was the second
time the counter was found dead (first: 2026-08-10, a `[Tag]` prefix).

Measured before the fix (scratch replays, not committed):

- The report's eight rows produced hard-suppress counts of 2 + 1 and 1 + 1 + 1,
  never 3. A seventh raise was kept; its best fuzzy score was 0.350 against a
  strict `> 0.35`.
- `wine-cellar-app/.audit/tech-debt.json` (186 entries), replayed in date order:
  "Incomplete Cache Identity" vs "Incomplete cache identity" on one file scored
  0.17; one lifecycle-disposal concern was stored four times (best 0.31).
- The report's proposed category-similarity cut (>= 0.6) merged 1 of 21 pairs of
  its own rows, and "Error swallowing in retry loop" vs "…parse loop" scored 0.67.

## 2. What shipped

1. **Adjudicator links.** `write-ledger-entries --triage` accepts `sameConcernAs`
   (finding id in the same triage, ledger topicId, or unique 6+ char prefix),
   stored as the root `concernId`. Unresolvable or ambiguous refuses the batch.
2. **Concern index** (`scripts/lib/concern-identity.mjs`). Entries group by
   `concernId`, or by same category key plus any shared file. A raise matches on
   any linked phrasing and any file the concern named. Category text is never
   fuzzily merged; `stage1-mechanical` still never counts.
3. **Telemetry**, stamped `concern-v1` at the collector:
   - `suppression_events` gains `action='kept'` rows: a kept finding that shares
     a file with a prior ruling, with its best score, pass, source, file count
     and matched concern. Previously a missed re-raise left no trace.
   - `audit_runs.suppression_stats.concern`: per-round counts (hard, fuzzy,
     Layer 3 declined, near-miss score bands, multi-file, linked concerns,
     concerns at threshold, undeclared reopens).
   - `npm run concern:report -- --days 7` reads it back, per repo, and counts R2+
     rounds that ran an older bundle as unmeasured.

No migration: `kept` was already in the table's CHECK, and `suppression_stats`
is jsonb.

**Follow-up (2026-09-22).** The link is no longer left to prose: a dismissal
whose finding carries `_priorRuling` naming an earlier dismissal must say
`sameConcernAs` or `newConcern: true`, or `write-ledger-entries` refuses the
batch. The weekly local maintenance run gains a `concern-report` check writing
`.audit/concern-report.json`.

## 3. Observation protocol (pre-registered)

Read the report on 2026-09-29, on every store a consumer writes to (the weekly `concern-report` maintenance check leaves it in `.audit/concern-report.json`). The rules
below are fixed now so the week's data cannot be used to tune them.

**Sample floor.** At least 10 stamped R2+ rounds across consumers. Below that,
extend by a week; do not conclude.

| Question | Signal | Reading | Action |
|---|---|---|---|
| Q1. Does hard-suppress fire? | `hard-suppress:` line | `NOT FIRING` with a concern at threshold | Bug. Reproduce from the kept rows before anything else |
| Q2. Are links right? | adoption x/y, recurring topics | Linking is enforced at write (2026-09-22 follow-up), so low adoption means few re-raises, not skipped links. Recurring topics that stay high mean links are being answered `newConcern` wrongly | Sample 5 `newConcern` rulings from the ledgers by hand |
| Q3. How much still slips? | recurring topics, score bands | Same-concern near-misses mostly below 0.2 | The fuzzy threshold is out of reach by construction. Do not tune it |
| Q4. Is Layer 3 over-suppressing? | re-litigation declined | Any | Sample 5 rows by hand; a stale dismissal hidden is a recall loss |
| Q5. Does `[SYSTEMIC]` keying need work? | multi-file near-misses | A large share of recurring topics are multi-file | Open the keying plan (the report's item 4). Otherwise leave it |

**Store coverage.** A store with no stamped rounds reads `UNMEASURED`. That is
not a clean result. The corporate consumer that filed the report may be on a
different store from this repo's maintainer.

### 3.1 Readout (2026-09-29)

**Scope.** Lbstrydom/* repos only: this repo, wine-cellar-app and ai-organiser,
all on store `d5a9d07b91225a93`. The work repos on store `c7177057dcafa55d`
(storyline, gd-afeu-project-readiness) run through Azure and were excluded by
decision: their 41 unstamped R2+ rounds are not a reason to change this repo.
Their numbers stay in the raw readout, not in the verdict.

**Sample floor: met.** 16 stamped R2+ rounds (this repo 9, wine-cellar-app 7,
ai-organiser 0: no audits ran there). 0 unstamped R2+ rounds on the store.
Measured with `npm run concern:report -- --days 7 --json`, plus read-only
queries over `suppression_events` for the hand samples.

| Q | Measured | Reading |
|---|---|---|
| Q1 | 1 hard-suppress (2026-09-25, round 6, `linked=yes`, 3 dismissals). The only other round with a concern at threshold had `nearMissInConcern = 0`, so no raise in that concern was missed | Firing. No action |
| Q2 | Linked concern in 4/16 rounds. 7 recurring topics, 6 of them beside **accepted** rulings (fix iterations on one file), which the decision rule does not govern; the one beside a dismissal (`16d5c7a3`) is already linked | No sign of wrong `newConcern` answers. The hand sample could not run: `newConcern` was validated but never stored. Fixed the same day (`newConcernOf` on the ledger entry) |
| Q3 | Near-miss bands <.1: 6, <.2: 30, <.35: 23, >=.35: 0 (36/59 below 0.2). Recurring-topic rows: 11/19 below 0.2, max 0.298 | Threshold out of reach by construction. Not tuned; §4's no-fuzzy-matching stands |
| Q4 | 3 re-litigation declines, all sampled from the ledger by hand: each was the same concern reworded (swallowed `rmSync` cleanup twice, a cloud-off test once) against a dismissal with a stated rationale | No recall loss |
| Q5 | 9/59 kept rows multi-file (15%). 4/7 recurring topics contain a multi-file row; 1/7 is mostly multi-file | Not a large share on the row count the report computes. Left alone. The rule never defined "large share" or its unit; next window should |

**Instrument notes for a next window.** `recurringMissedTopics` counts topics
beside accepted rulings too; for Q2 only dismissed priors matter, so filter or
split it before reading Q2 again. Q2's sample now reads `newConcernOf` from the
session ledgers.

## 4. Deliberately not done

- Fuzzy category matching (see §1 measurements).
- An acceptance-rate stop rule for `/audit-code`: rounds 4 and 5 of the field
  run produced its two most severe findings.
- Splitting `[SYSTEMIC]` findings at assembly time: waits on Q5.
- `sameConcernAs` for debt entries: the near-miss rows against `source=debt`
  measure whether it is needed.
