-- Add the five audit_runs columns `recordRunComplete`/`updateRunMeta` have
-- always written but no migration ever created.
--
-- Found empirically 2026-07-18, by running a real `/audit-code` to verify the
-- un-awaited-finalisation fix (eefc5a2) — which is the only reason this was
-- visible at all. Before that fix the process exited before the UPDATE ran, so
-- the failure never had a chance to surface. Awaiting the write turned a silent
-- loss into a loud one:
--
--   [learning] recordRunComplete failed: column "session_cache_hit" of
--   relation "audit_runs" does not exist
--
-- Same atomic-failure class as the gemini_verdict CHECK widened in
-- 20260718160000: `recordRunComplete` issues ONE UPDATE, so a single absent
-- column discards the ENTIRE finalisation payload — rounds, total_findings,
-- total_duration_ms, every cache metric. So the await fix alone was necessary
-- but NOT sufficient; both had to land for a code run to finalise.
--
-- Third instance of live-schema drift on this table (cf. scope_mode,
-- 20260717200000). The pattern is always the same: a writer gains a field, no
-- migration follows, and because the store layer is deliberately best-effort
-- (stderr only, never throws) nothing surfaces it. Note `cache_seed_enabled`
-- avoided this by being `columnExists`-guarded — these five are not, and rather
-- than add four more probe-guards this migration makes the schema match the
-- writer, which is the actual contract.
--
-- Types follow the writer exactly. `map_reduce_passes` is a GENUINE text[] —
-- it is the one field bound via `pgArray()` to opt OUT of the jsonb
-- auto-serialization seam (AGENTS.md "jsonb-safe write seam"), so it must be a
-- Postgres array column, not jsonb.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout; purely additive, all
-- nullable, so no existing row can fail and no backfill is implied. Historical
-- rows keep NULL, which is honest — those runs genuinely never recorded these.

ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_lines_changed integer;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_files_changed integer;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS session_cache_hit  boolean;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS map_reduce_passes  text[];
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS r2_skip_reason     text;
