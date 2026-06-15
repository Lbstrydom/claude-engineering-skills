-- Record per-run cache-seed state so the AUDIT_CACHE_SEED flip decision can be
-- made on a seed-ON cohort, not the seed-OFF global history (where the cache is
-- never warmed → structural ~0% hit rate). NULL = unknown / pre-canary (no
-- backfill — historical runs genuinely have unknown seed state). Nullable, no
-- index: low-cardinality boolean filtered alongside the existing rounds/
-- created_at predicates.
--
-- Semantics (plan R1-M4): TRUE means the effective cache-seed path actually ran
-- for the run (decideSeed().seedUsed for ≥1 pass), not merely that the env flag
-- was set.
ALTER TABLE audit_runs
  ADD COLUMN IF NOT EXISTS cache_seed_enabled BOOLEAN;
