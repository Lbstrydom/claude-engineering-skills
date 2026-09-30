-- ============================================================================
-- memory_health_metrics — keep the trigram probes on the GIN index.
--
-- The weekly memory-health gate stopped producing a reading: the RPC ran past
-- its 240s caller bound on 2026-09-24 and again on 2026-09-29. Measured on the
-- NAS store (11,882 findings, Postgres 17, aarch64), with no other query
-- active:
--
--   as-is                          > 600s, twice (cancelled at 600s)
--   SET LOCAL enable_seqscan=off     292s  (metric 1 176s, 2 16s, 3 99s)
--
-- The metric 1 and 3 LATERAL probes carry only the `%` predicate behind an
-- OFFSET 0 fence (20260808160000), which kept the planner off the created_at
-- btree but still left a Seq Scan open. On a table this small the planner
-- costs the Seq Scan at ~1,100 units and picks it for every probe, while
-- `similarity()` over 500-char snapshots costs ~220us/row on this CPU: ~2.6s
-- per probe instead of ~0.23s through audit_findings_detail500_trgm_idx.
--
-- A planner GUC in the function's SET clause does apply to the statements the
-- function plans (unlike statement_timeout, whose timer is armed before the
-- clause runs: see 20260808160000's note). ALTER FUNCTION ... SET adds to
-- proconfig without touching the body, the other SET entries or the ACL.
-- Every other statement in the function either has an index path or no base
-- table to scan (metric 2's self-join is between CTE row-sets).
--
-- Idempotent: re-running sets the same value.
-- ============================================================================

ALTER FUNCTION memory_health_metrics(integer, numeric, numeric, integer)
  SET enable_seqscan = off;
