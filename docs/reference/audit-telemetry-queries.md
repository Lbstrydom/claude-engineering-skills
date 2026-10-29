# Audit telemetry queries — the three questions as plain SQL

**What it is**: the committed query recipes behind `docs/plans/audit-telemetry-capture.md`
(§9). After a few weeks of normal audit work these three questions are plain SQL against the
audit store, with no new collector:

- **(a)** At what rate do findings reopen or get disputed across the rounds of one audit?
- **(b)** What is finding quality per auditor model (Terra after experiment 8, Sol before it)?
- **(c)** How often do the final reviewer (Gemini) and the GPT/host-agent ledger agree?

**When you need it**: answering any of those, reading `npm run own-model:coverage`, or changing a
capture writer. **Read the eligibility section first** — a query that skips it counts rows the
fixed writers never produced.

> The SQL between the `sql:` markers is *executed* by `tests/audit-capture-db.test.mjs`
> (with `:epochs` bound to `capture-v1`), so this page cannot drift from the mappings the tests
> pin. Edit the SQL here and the test follows.

## 1. Eligibility (the cohort is a parameter, never hard-coded)

A row is capture-v1 evidence only when the fixed writer **ran and its later writes landed**.
`capture_epoch` proves only that the writer started. All queries take the epoch set as `:epochs`
(today `'{capture-v1}'`); bumping the epoch is a deliberate change of cohort. There is no
backfill and no cutoff by date: rows written before the fix keep NULL and are ineligible.

| Capability | Eligible when |
|---|---|
| Findings, pass stats, events | `capture_epoch = ANY(:epochs)` **and** `run_status = 'complete'` (NULL and every other state are ineligible) |
| Outcome-sync rulings | additionally `write_outcomes -> 'outcome_sync' ->> 'written' = write_outcomes -> 'outcome_sync' ->> 'expected'` |
| Reviewer reversal rate | additionally `write_outcomes -> 'reviewer' ->> 'status' = 'complete'` |
| Equivalence links | no gate; report `write_outcomes -> 'equivalence'` beside the result — every re-raise rate is a **lower bound** |

A round is the composite key `(repo_id, audit_session_id, audit_round)` over rows with
`audit_round IS NOT NULL`, and **a retried round has several rows: take the latest
`created_at` per key** so it counts once. Unified runs (an explicit `--run-id`), and plan A/B and
bake-off arm runs, carry `audit_round IS NULL` and are never rounds.

<!-- sql:capture-rounds:start -->
```sql
CREATE TEMP VIEW capture_rounds AS
SELECT DISTINCT ON (r.repo_id, r.audit_session_id, r.audit_round) r.*
  FROM audit_runs r
 WHERE r.capture_epoch = ANY(:epochs) AND r.run_status = 'complete' AND r.mode = 'code'
   AND r.audit_session_id IS NOT NULL AND r.audit_round IS NOT NULL
 ORDER BY r.repo_id, r.audit_session_id, r.audit_round, r.created_at DESC;
```
<!-- sql:capture-rounds:end -->

## 2. Terminal state of a finding (one committed mapping)

`(adjudication_outcome, user_action)` maps to `accepted | dismissed | severity_adjusted | open |
unknown`. `user_action = 'accepted-permanent'` is an acceptance (`finding-disposition.mjs`), and
`user_action = 'auto_dismissed'` control markers are excluded (NULL). Query (b) reads this CASE;
the view in §3 inlines the same CASE so it stands alone, and a test pins the two together.

<!-- sql:terminal-state:start -->
```sql
CASE
  WHEN f.user_action = 'auto_dismissed' THEN NULL
  WHEN f.adjudication_outcome = 'accepted' OR f.user_action = 'accepted-permanent' THEN 'accepted'
  WHEN f.adjudication_outcome = 'dismissed' THEN 'dismissed'
  WHEN f.adjudication_outcome = 'severity_adjusted' THEN 'severity_adjusted'
  WHEN f.adjudication_outcome IS NULL OR f.adjudication_outcome IN ('pending', 'needs_triage') THEN 'open'
  ELSE 'unknown'
END
```
<!-- sql:terminal-state:end -->

## 3. Question (a) — reopen and dispute across the rounds of one audit

Three metrics, each with **its own denominator and never combined**. Computed per
`(repo_id, audit_session_id)` over `capture_rounds`. A *concern* is a finding fingerprint, or its
`finding_equivalence` root — followed **only when the root has a finding row in the same repo**.

<!-- sql:capture-concerns:start -->
```sql
CREATE TEMP VIEW capture_concerns AS
SELECT f.id AS finding_id, r.repo_id, r.audit_session_id, r.audit_round,
       COALESCE(
         (SELECT e.canonical_finding_id FROM finding_equivalence e
            WHERE e.duplicate_finding_id = f.finding_fingerprint
              AND EXISTS (SELECT 1 FROM audit_findings g JOIN audit_runs gr ON gr.id = g.run_id
                           WHERE g.finding_fingerprint = e.canonical_finding_id AND gr.repo_id = r.repo_id)),
         f.finding_fingerprint) AS concern_id,
       CASE
         WHEN f.user_action = 'auto_dismissed' THEN NULL
         WHEN f.adjudication_outcome = 'accepted' OR f.user_action = 'accepted-permanent' THEN 'accepted'
         WHEN f.adjudication_outcome = 'dismissed' THEN 'dismissed'
         WHEN f.adjudication_outcome = 'severity_adjusted' THEN 'severity_adjusted'
         WHEN f.adjudication_outcome IS NULL OR f.adjudication_outcome IN ('pending', 'needs_triage') THEN 'open'
         ELSE 'unknown'
       END AS state
  FROM audit_findings f JOIN capture_rounds r ON r.id = f.run_id;
```
<!-- sql:capture-concerns:end -->

- **Re-raise rate** = concerns seen in at least two rounds ÷ concerns seen:

<!-- sql:reraise-rate:start -->
```sql
SELECT count(*) FILTER (WHERE rounds_seen >= 2)::numeric / NULLIF(count(*), 0) AS reraise_rate, count(*) AS concerns
  FROM (SELECT repo_id, audit_session_id, concern_id, count(DISTINCT audit_round) AS rounds_seen
          FROM capture_concerns GROUP BY 1, 2, 3) c;
```
<!-- sql:reraise-rate:end -->

- **Reopen rate** = concerns re-raised after their terminal state in an earlier **non-final**
  round was `dismissed` ÷ concerns dismissed in a non-final round:

<!-- sql:reopen-rate:start -->
```sql
WITH final_round AS (SELECT repo_id, audit_session_id, max(audit_round) AS last_round FROM capture_rounds GROUP BY 1, 2),
dismissed AS (
  SELECT DISTINCT c.repo_id, c.audit_session_id, c.concern_id, c.audit_round
    FROM capture_concerns c JOIN final_round fr USING (repo_id, audit_session_id)
   WHERE c.state = 'dismissed' AND c.audit_round < fr.last_round)
SELECT count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM capture_concerns later
          WHERE later.repo_id = d.repo_id AND later.audit_session_id = d.audit_session_id
            AND later.concern_id = d.concern_id AND later.audit_round > d.audit_round))::numeric
       / NULLIF(count(*), 0) AS reopen_rate, count(*) AS dismissed_concerns
  FROM dismissed d;
```
<!-- sql:reopen-rate:end -->

- **Dispute rate** = finding rows whose adjudication events carry **conflicting outcomes across
  kinds** ÷ finding rows with events of at least two kinds:

<!-- sql:dispute-rate:start -->
```sql
SELECT count(*) FILTER (WHERE outcomes > 1)::numeric / NULLIF(count(*), 0) AS dispute_rate, count(*) AS rows_with_two_kinds
  FROM (SELECT ev.finding_id, count(DISTINCT ev.adjudicator_kind) AS kinds, count(DISTINCT ev.adjudication_outcome) AS outcomes
          FROM finding_adjudication_events ev
          JOIN audit_findings f ON f.id = ev.finding_id JOIN capture_rounds r ON r.id = f.run_id
         WHERE ev.event_origin IS DISTINCT FROM 'campaign'
         GROUP BY ev.finding_id HAVING count(DISTINCT ev.adjudicator_kind) >= 2) d;
```
<!-- sql:dispute-rate:end -->

All three are **lower bounds**: report them next to `write_outcomes -> 'equivalence'`
(`expected`, `written`, `skipped:*`, `spilled`, `lost`) summed over the same runs.

## 4. Question (b) — finding quality per auditor model

**Observational, not a controlled eval.** Every output carries *n* and missingness and is
stratified by repo and pass. A claim that one model "finds better" needs the synchronous
`model-eval-auditor` harness; this query only shows drift. Two cohorts, **never pooled**:

**Prospective** — `audit_findings.source_model` on eligible capture-v1 runs (terminal state from
`capture_concerns`, i.e. the §2 mapping):

<!-- sql:quality-prospective:start -->
```sql
SELECT f.source_model, r.repo_id, f.pass_name,
       count(*) AS n,
       count(*) FILTER (WHERE c.state = 'accepted') AS accepted,
       count(*) FILTER (WHERE c.state = 'dismissed') AS dismissed,
       count(*) FILTER (WHERE c.state IN ('open', 'unknown')) AS unresolved
  FROM capture_concerns c
  JOIN audit_findings f ON f.id = c.finding_id
  JOIN audit_runs r ON r.id = f.run_id
 WHERE r.write_outcomes -> 'outcome_sync' ->> 'written' = r.write_outcomes -> 'outcome_sync' ->> 'expected'
 GROUP BY 1, 2, 3;
```
<!-- sql:quality-prospective:end -->

**Historical (derived)** — the Sol cohort from before experiment 8. Findings joined to
`audit_pass_stats` on `(run_id, pass_name)`, admitted **only where exactly one `audit_pass_stats`
row exists for that pair and its `source_model` is non-null**. A pair with several rows, or with any
null-model row, is excluded and **counted**. This is a deterministic join on recorded data, not a
guess; eligibility is `run_status = 'complete'` *or* the row predates `run_status`.

<!-- sql:quality-historical:start -->
```sql
WITH one_model AS (
  SELECT run_id, pass_name, min(source_model) AS source_model
    FROM audit_pass_stats GROUP BY run_id, pass_name
  HAVING count(*) = 1 AND count(source_model) = 1)
SELECT m.source_model, count(*) AS n
  FROM audit_findings f
  JOIN one_model m ON m.run_id = f.run_id AND m.pass_name = f.pass_name
 GROUP BY m.source_model
UNION ALL
-- the excluded, counted: findings whose (run_id, pass_name) is NOT a one-model pair
SELECT '(excluded: zero, several or null-model pass-stat rows)', count(*)
  FROM audit_findings f
 WHERE NOT EXISTS (SELECT 1 FROM one_model m WHERE m.run_id = f.run_id AND m.pass_name = f.pass_name);
```
<!-- sql:quality-historical:end -->

## 5. Question (c) — final reviewer against the ledger

**What is being compared.** Gemini against the **ledger disposition** — the host agent's triage of
GPT's findings — not against GPT alone.

**Per run.** The reviewer side is read from `audit_runs.gemini_verdict`. The code-computed
`gateDisposition` is **not persisted**, so `CONCERNS*` cannot be split into approve-with-debt vs
blocked and reads `unknown` — a limit of the stored data, stated here rather than guessed.
`converged` is `H = 0 AND M <= 2` on the session's last round.

<!-- sql:c-run-agreement:start -->
```sql
CASE
  WHEN gemini_verdict IS NULL THEN 'unknown'
  WHEN gemini_verdict = 'APPROVE' AND converged THEN 'agree'
  WHEN gemini_verdict = 'APPROVE' AND NOT converged THEN 'disagree'
  WHEN gemini_verdict = 'REJECT' AND NOT converged THEN 'agree'
  WHEN gemini_verdict = 'REJECT' AND converged THEN 'disagree'
  ELSE 'unknown'
END
```
<!-- sql:c-run-agreement:end -->

| GPT side | Reviewer side | Result |
|---|---|---|
| converged | `APPROVE` | **agree** |
| not converged | `REJECT` | **agree** |
| converged | `REJECT` | **disagree** |
| not converged | `APPROVE` | **disagree** |
| any | NULL verdict, failed or skipped review, or `CONCERNS*` | **unknown** |

**Per finding — the reversal rate.** The reviewer's schema lists **reversals only**
(`wrongly_dismissed[]`): a presented finding it did not reverse is *not reversed*, never
*sustained*, and no sustain event exists. The metric is **reversals ÷ `presented_resolved`**, over
runs whose reviewer receipt is `complete`; incomplete runs and unresolved ids are reported as their
own counts.

<!-- sql:reversal-rate:start -->
```sql
SELECT count(*) AS runs,
       sum((write_outcomes -> 'reviewer' ->> 'reversals_written')::int) AS reversals,
       sum((write_outcomes -> 'reviewer' ->> 'presented_resolved')::int) AS presented_resolved,
       sum((write_outcomes -> 'reviewer' ->> 'reversals_written')::int)::numeric
         / NULLIF(sum((write_outcomes -> 'reviewer' ->> 'presented_resolved')::int), 0) AS reversal_rate
  FROM audit_runs
 WHERE capture_epoch = ANY(:epochs) AND write_outcomes -> 'reviewer' ->> 'status' = 'complete';
```
<!-- sql:reversal-rate:end -->

Incomplete reviews are counted separately with `write_outcomes -> 'reviewer' ->> 'status' =
'incomplete'`. Reviewer events are `finding_adjudication_events` rows with
`adjudicator_kind = 'reviewer'`, `adjudicator_model` = the primary reviewer,
`evidence = {reviewing_run_id, review_round}`, written on the **source** finding row (which can sit
in an earlier round of the session). They never rewrite the finding's own `adjudication_outcome`.

## 6. Null-outcome classification (the "34.7% null" is mostly lifecycle, not failure)

Findings with `adjudication_outcome IS NULL`, bucketed. **`other` is the capture-failure signal.**

<!-- sql:null-outcome:start -->
```sql
SELECT CASE
         WHEN f.detail_snapshot LIKE 'ADJACENCY_INCOMPLETE%' OR f.user_action = 'auto_dismissed' THEN 'control_marker'
         WHEN f.user_action = 'needs_triage' THEN 'needs_triage'
         WHEN f.pass_name LIKE 'final-review%' THEN 'final_review_not_adjudicated'
         WHEN r.labeled IS NOT TRUE THEN 'never_finalized'
         ELSE 'other'
       END AS bucket,
       count(*) AS n
  FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
 WHERE f.adjudication_outcome IS NULL
 GROUP BY 1 ORDER BY n DESC;
```
<!-- sql:null-outcome:end -->

## 7. Coverage

`npm run own-model:coverage:gate` (offline, in `check`) fails when a capture column has no
entry or exemption; `npm run own-model:coverage` is the live null-rate check — zero eligible rows
reads `unmeasured`, never green. The new columns: `audit_runs.audit_session_id` / `capture_epoch`,
`audit_findings.source_model`, `audit_pass_stats.source_model`,
`finding_adjudication_events.ruling_rationale` / `adjudicator_model` (reviewer rows only —
unknowable on `pipeline` rows, where the model is the host agent), `finding_equivalence`.
`audit_pass_stats.source_model` is measured only over passes that made a model call
(`input_tokens > 0`, mechanical waves excluded): measured on 2026-10-29 over rows since 2026-08-23
that predicate reads 100% filled where the unqualified column read 51%.
