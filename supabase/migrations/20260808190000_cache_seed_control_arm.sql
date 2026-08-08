-- Cache-seed A/B: give the experiment a control arm.
--
-- `cache_seed_enabled` records whether a run EFFECTIVELY seeded, but never why
-- a run did not. That collapsed two unlike populations into one seed-OFF
-- cohort:
--   * eligible, but seeding withheld (AUDIT_CACHE_SEED=0)   <- the real control
--   * ineligible: a single map-reduce unit, or a stable prefix below
--     AUDIT_CACHE_STABLE_PREFIX_MIN                          <- not comparable
--
-- Because `units.length <= 1` correlates with small audits, the seed-OFF cohort
-- skewed systematically smaller than seed-ON. Comparing their hit rates
-- therefore measured audit SIZE, not seeding — which is why the 2026-08-08
-- reading (seed-ON 11.3% vs seed-OFF 5.2%, mean 19.4% vs 20.8%) could not
-- settle whether to revert the 2026-07-14 default-ON flip.
--
-- Both columns are NULLABLE with NO DEFAULT, deliberately. The 583 pre-existing
-- rows genuinely do not know their eligibility, and NULL is the only honest way
-- to say so. A `NOT NULL DEFAULT false` would silently assert "was not
-- eligible" for every historical run and re-contaminate the cohort this
-- migration exists to clean.

ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS cache_seed_eligible boolean;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS cache_seed_skip_reason text;

COMMENT ON COLUMN audit_runs.cache_seed_eligible IS
  'True when the run COULD have cache-seeded (>1 unit and a stable prefix at or '
  'above AUDIT_CACHE_STABLE_PREFIX_MIN), independent of whether it did. NULL for '
  'runs recorded before migration 20260808190000 — unknown, not false.';

COMMENT ON COLUMN audit_runs.cache_seed_skip_reason IS
  'Why the run did not seed: env-disabled (eligible, withheld — the control arm), '
  'units.length<=1, prefix-too-small, or probe-failed:<msg>. NULL when the run '
  'seeded, or when recorded before migration 20260808190000.';
