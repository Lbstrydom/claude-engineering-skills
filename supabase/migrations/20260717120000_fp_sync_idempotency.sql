-- FP-pattern sync idempotency + disk-IO runaway fix (2026-07-17).
--
-- syncFalsePositivePatterns wrote repo_id = NULL (explicit null overrides the
-- column DEFAULT), and Postgres treats NULLs as distinct in unique constraints,
-- so ON CONFLICT (repo_id, pattern_type, pattern_value) never matched — every
-- audit run re-inserted the entire local FP tracker as brand-new rows
-- (403k rows / ~140MB in the 3 days after the 2026-07-14 restore; depleted the
-- Supabase Disk IO Budget). The rows were also unreadable: the reader filters
-- repo_id = $1, which never matches NULL.

-- 1. Re-assert the GLOBAL sentinel repo (idempotent; FK target for the
--    sentinel fallback — originally seeded by 20260403083803, re-asserted
--    here so a post-wipe restore that misses that backfill still has it).
INSERT INTO audit_repos (id, fingerprint, name, stack)
VALUES ('00000000-0000-0000-0000-000000000000', 'GLOBAL_SENTINEL', 'Global (cross-repo)', '{"type": "sentinel"}')
ON CONFLICT (id) DO NOTHING;

-- 2. Purge the unreadable NULL-repo rows (write-only garbage by construction).
DELETE FROM false_positive_patterns WHERE repo_id IS NULL;

-- 3. Columns the reader (loadFalsePositivePatterns) selects and the
--    suppression policy consumes (resolveFpPatterns reads decayed_* for
--    effective-sample-size). They were selected but never existed — the read
--    errored on every call and was swallowed.
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS dismissed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS accepted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS ema DOUBLE PRECISION NOT NULL DEFAULT 0.5;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS decayed_accepted DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS decayed_dismissed DOUBLE PRECISION NOT NULL DEFAULT 0;

-- 4. repo_id can never be NULL again — sentinel default + NOT NULL. A stale
--    consumer still running the old synced code gets a loud 23502 in its
--    fire-and-forget stderr log instead of silently growing the table.
ALTER TABLE false_positive_patterns ALTER COLUMN repo_id SET DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE false_positive_patterns ALTER COLUMN repo_id SET NOT NULL;

-- 5. Drop the stale user_id-based unique key. 20260330065641 tried to drop it
--    but misspelled the constraint name (..._patte_key vs ..._patter_key), so
--    it survived. user_id is always NULL, so it never deduplicates anything —
--    it is pure dead index weight on every insert.
ALTER TABLE false_positive_patterns DROP CONSTRAINT IF EXISTS false_positive_patterns_user_id_repo_id_pattern_type_patter_key;
