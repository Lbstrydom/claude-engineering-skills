-- debt_summary — surfaced by check-setup.mjs (DEBT_SUMMARY_SQL constant) as a
-- "create by hand if missing" hint since Phase D shipped, but never actually
-- captured in a migration — so it never survived a fresh --migrate. Exposed
-- by the 2026-07-14 production-wipe incident (see docs/postgres-parity-runbook.md
-- §Incident): a full schema restore from migrations alone did not recreate it.
-- Idempotent (CREATE OR REPLACE), matches check-setup.mjs's DEBT_SUMMARY_SQL
-- verbatim so the two never drift.

CREATE OR REPLACE VIEW debt_summary AS
SELECT repo_id, severity, deferred_reason, COUNT(*) AS count,
  MIN(deferred_at) AS oldest, MAX(deferred_at) AS newest,
  array_agg(DISTINCT category) AS categories
FROM debt_entries
GROUP BY repo_id, severity, deferred_reason
ORDER BY CASE severity WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, count DESC;
