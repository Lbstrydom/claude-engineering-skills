# Plan: Concern identity for re-raise suppression, and a one-week observation window

- **Date**: 2026-09-22
- **Status**: In Progress — fix shipped; observation window running, readout due 2026-09-29
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

## 3. Observation protocol (pre-registered)

Read the report on 2026-09-29, on every store a consumer writes to. The rules
below are fixed now so the week's data cannot be used to tune them.

**Sample floor.** At least 10 stamped R2+ rounds across consumers. Below that,
extend by a week; do not conclude.

| Question | Signal | Reading | Action |
|---|---|---|---|
| Q1. Does hard-suppress fire? | `hard-suppress:` line | `NOT FIRING` with a concern at threshold | Bug. Reproduce from the kept rows before anything else |
| Q2. Is `sameConcernAs` used? | adoption x/y | Low adoption while `in a known concern` or recurring topics are high | The SKILL prose is not steering. Fix the prose, not thresholds |
| Q3. How much still slips? | recurring topics, score bands | Same-concern near-misses mostly below 0.2 | The fuzzy threshold is out of reach by construction. Do not tune it |
| Q4. Is Layer 3 over-suppressing? | re-litigation declined | Any | Sample 5 rows by hand; a stale dismissal hidden is a recall loss |
| Q5. Does `[SYSTEMIC]` keying need work? | multi-file near-misses | A large share of recurring topics are multi-file | Open the keying plan (the report's item 4). Otherwise leave it |

**Store coverage.** A store with no stamped rounds reads `UNMEASURED`. That is
not a clean result. The corporate consumer that filed the report may be on a
different store from this repo's maintainer.

## 4. Deliberately not done

- Fuzzy category matching (see §1 measurements).
- An acceptance-rate stop rule for `/audit-code`: rounds 4 and 5 of the field
  run produced its two most severe findings.
- Splitting `[SYSTEMIC]` findings at assembly time: waits on Q5.
- `sameConcernAs` for debt entries: the near-miss rows against `source=debt`
  measure whether it is needed.
