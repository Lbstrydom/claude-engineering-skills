-- Campaign arm-state and snapshot-identity integrity.
--
-- Plan: docs/plans/campaign-arm-state-and-identity-integrity.md §7 Phase 1.
--
-- Two additive, nullable columns on `campaign_arm_runs` (per-attempt
-- provenance, never per-snapshot — see the plan's Right-sizing gate for why),
-- a DB-level identity constraint that makes double-promotion of one
-- `audit_run_id` structurally impossible, and a new quarantine table.

-- ── Per-attempt provenance columns ───────────────────────────────────────────
-- Both nullable, no default, no backfill: an existing row legitimately
-- predates these columns, and NULL reads as "not recorded" — a grandfathered,
-- trusted state (see Phase 2's `liveArmRunsForSnapshot`), never a guessed
-- value.
ALTER TABLE campaign_arm_runs ADD COLUMN IF NOT EXISTS plan_content_hash TEXT;
ALTER TABLE campaign_arm_runs ADD COLUMN IF NOT EXISTS config_digest     TEXT;

-- ── Data repair: pre-existing corruption from the bug this plan fixes ───────
-- This migration's OWN preflight below (run 2026-08-20 against the live
-- store) found 7 real `audit_run_id` values each recorded across 2-5
-- `campaign_arm_runs` rows — not hypothetical, not covered by the plan's
-- "expected to be a no-op" assumption. Root cause is exactly defect #2 in
-- this plan's Context Summary: the OLD attempt-COUNT-based promotion
-- (`resolvePromotionAttempts` comparing counts, not identities) re-promoted
-- the SAME physical review as a new "attempt" whenever a fresh fixture's
-- local attempt-numbering restarted at 1. Verified before writing this
-- repair: every duplicate row within a group carries the IDENTICAL
-- `cost_usd` (e.g. the `opus` arm-run below recorded $2.50679 three times
-- for one real review), so campaign spend has been triple/quintuple-counted
-- for these five arm-runs; and every `finding_adjudication_events` row
-- referencing any of these `campaign_arm_run_id`s points ONLY at the
-- group's live row, never a superseded one, so collapsing to the live row
-- orphans no adjudication.
--
-- Hardcoded to the EXACT `audit_run_id` values found — not re-derived by a
-- generic "any group with count=1" query after the DELETE below, which
-- would be unable to distinguish this incident's rows from an unrelated
-- arm-run that legitimately reached attempt 4 or 5 through real retries.
-- On any OTHER database these ids simply do not exist and both statements
-- are no-ops; re-running this migration a second time here is also a no-op
-- (idempotent: after the first run each group already has exactly one row
-- at attempt 1).
DELETE FROM campaign_arm_runs
 WHERE id IN (
   SELECT id FROM (
     SELECT id, ROW_NUMBER() OVER (
       PARTITION BY audit_run_id
       ORDER BY (superseded_at IS NULL) DESC, attempt DESC
     ) AS rn
     FROM campaign_arm_runs
     WHERE audit_run_id IN (
       '011a0873-5e99-4b8d-b677-1f179030c0bd',
       '60f71ebd-3f98-4df0-9c0f-dc59af5d9fdf',
       '69bbc140-5e5b-4cde-9c83-3a426ea8f3a9',
       '78e6cb8c-6132-4384-ae07-4705b65b9ece',
       '8cdb46d2-610e-465a-8e87-9ce5361fef3b',
       'aa4a9d61-9110-4f0f-8375-205962b94bfd',
       'db52cbf0-4878-411e-a9cc-b3d50f1b5d02'
     )
   ) ranked
   WHERE rn > 1
 );

-- The surviving row for each formerly-duplicated audit_run_id is renumbered
-- to attempt 1 — every affected group's MIN(attempt) was already 1 before
-- this repair, so there is no other real attempt at that (cohort, snapshot,
-- arm) tuple for the new attempt=1 to collide with once the DELETE above
-- has already run (same transaction, so the old attempt-1 row is gone
-- before this UPDATE executes).
UPDATE campaign_arm_runs
   SET attempt = 1
 WHERE attempt <> 1
   AND audit_run_id IN (
     '011a0873-5e99-4b8d-b677-1f179030c0bd',
     '60f71ebd-3f98-4df0-9c0f-dc59af5d9fdf',
     '69bbc140-5e5b-4cde-9c83-3a426ea8f3a9',
     '78e6cb8c-6132-4384-ae07-4705b65b9ece',
     '8cdb46d2-610e-465a-8e87-9ce5361fef3b',
     'aa4a9d61-9110-4f0f-8375-205962b94bfd',
     'db52cbf0-4878-411e-a9cc-b3d50f1b5d02'
   );

-- ── `audit_run_id` identity constraint ───────────────────────────────────────
-- Preflight: fail LOUDLY and NAME the offending rows rather than let
-- CREATE UNIQUE INDEX below fail with Postgres's own generic "could not
-- create unique index" error. Expected to be a no-op today (every arm run
-- mints a fresh `audit_runs` row), but the migration must not assume that
-- silently.
DO $$
DECLARE
  dupes TEXT;
BEGIN
  SELECT string_agg(DISTINCT audit_run_id::text, ', ')
    INTO dupes
    FROM (
      SELECT audit_run_id
        FROM campaign_arm_runs
       WHERE audit_run_id IS NOT NULL
       GROUP BY audit_run_id
      HAVING COUNT(*) > 1
    ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'campaign_arm_runs already has duplicate non-NULL audit_run_id values, cannot add the identity index: %', dupes;
  END IF;
END $$;

-- A given `audit_run_id` can be recorded at most once across the whole
-- table, so a conflict-safe insert (§7 Phase 3) makes double-promotion of
-- the same run structurally impossible, not just application-discouraged.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_arm_runs_audit_run_id
  ON campaign_arm_runs (audit_run_id)
  WHERE audit_run_id IS NOT NULL;

-- ── Quarantine ────────────────────────────────────────────────────────────
-- A snapshot may accumulate more than one exclusion over its life (the
-- legacy NULL-hash pairing quarantined now, and hypothetically a later
-- hash-bearing pairing quarantined for an unrelated reason) — a child table
-- expresses all of them; two nullable columns on `campaign_snapshots` could
-- only ever express the LAST one.
CREATE TABLE IF NOT EXISTS campaign_snapshot_exclusions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id         UUID NOT NULL,
  snapshot_id       TEXT NOT NULL,
  scope             TEXT NOT NULL CHECK (scope IN ('pairing', 'all')),
  plan_content_hash TEXT,
  excluded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  excluded_reason   TEXT NOT NULL,
  lifted_at         TIMESTAMPTZ,
  lifted_reason     TEXT,
  CONSTRAINT exclusions_lift_coherent_chk
    CHECK ((lifted_at IS NULL) = (lifted_reason IS NULL)),
  -- `scope='all'` ignores plan_content_hash entirely — a hash on an
  -- all-pairings exclusion would be a value nobody reads, and a value
  -- nobody reads is a value that can silently drift from the truth.
  CONSTRAINT exclusions_all_scope_ignores_hash_chk
    CHECK (scope = 'pairing' OR plan_content_hash IS NULL),
  -- A genuine composite FK against campaign_snapshots' own
  -- UNIQUE(cohort_id, snapshot_id) — a typo'd snapshot_id (a realistic
  -- CLI-argument mistake) is refused outright rather than creating a
  -- valid-looking, silently dangling exclusion that could later match a
  -- real snapshot.
  CONSTRAINT exclusions_snapshot_fk FOREIGN KEY (cohort_id, snapshot_id)
    REFERENCES campaign_snapshots (cohort_id, snapshot_id) ON DELETE CASCADE
);

-- Three indexes, each scoped to ACTIVE (non-lifted) rows so a lifted
-- exclusion never blocks re-creating one for the same key. Postgres treats
-- NULL as distinct in a plain UNIQUE, so the NULL (legacy) case needs its
-- own partial index or duplicate "legacy" exclusions could be inserted
-- silently.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_snapshot_exclusions_all
  ON campaign_snapshot_exclusions (cohort_id, snapshot_id)
  WHERE scope = 'all' AND lifted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_snapshot_exclusions_pairing_hash
  ON campaign_snapshot_exclusions (cohort_id, snapshot_id, plan_content_hash)
  WHERE scope = 'pairing' AND plan_content_hash IS NOT NULL AND lifted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_snapshot_exclusions_pairing_null
  ON campaign_snapshot_exclusions (cohort_id, snapshot_id)
  WHERE scope = 'pairing' AND plan_content_hash IS NULL AND lifted_at IS NULL;

-- A cohort-scoped read (Phase 2/5's `WHERE cohort_id = $1 AND lifted_at IS
-- NULL`) is the hot lookup path for every consumer of arm-run liveness.
CREATE INDEX IF NOT EXISTS idx_campaign_snapshot_exclusions_cohort_active
  ON campaign_snapshot_exclusions (cohort_id)
  WHERE lifted_at IS NULL;
