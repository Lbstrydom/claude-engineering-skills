-- Widen symbol_refresh_coverage.reason's CHECK constraint to include
-- 'malformed_measurement' (fp=d0c0d2ba, 2026-08-20 unremediated-acceptances
-- triage).
--
-- graph-verdict.mjs's GRAPH_REASON has carried MALFORMED_MEASUREMENT
-- ('malformed_measurement') since the coverage-honesty feature landed — it is
-- what `graphVerdict()` returns whenever extraction.elapsedMs/ratio or
-- attribution.ratio comes back non-finite but nothing earlier in the
-- precedence table already fired. This table's CHECK constraint (and the
-- app-layer CoverageSchema in scripts/lib/coverage-schema.mjs, fixed
-- alongside this migration) never had that 11th value added — the three
-- "shared" definitions (GRAPH_REASON, CoverageSchema, this constraint) had
-- drifted apart. `recordGraphCoverage`'s `safeParse` silently refused to
-- persist that verdict; `render-mermaid.mjs`'s `ObservedDepsSchema.parse`
-- — a THROWING parse — would have crashed `arch:render` outright had the
-- app-layer schema not already caught it.
--
-- PostgreSQL rebuilds CHECK constraints by drop/add (same idiom as
-- 20260419130000_plan_verify.sql's regression_specs widening) — safe,
-- additive, and only ever WIDENS the allowed set, so no existing row can
-- violate it.

ALTER TABLE symbol_refresh_coverage DROP CONSTRAINT IF EXISTS symbol_refresh_coverage_reason_check;
ALTER TABLE symbol_refresh_coverage ADD  CONSTRAINT symbol_refresh_coverage_reason_check
  CHECK (reason IS NULL OR reason IN (
    'extraction_failed', 'extraction_timeout', 'not_measured',
    'stale_measurement', 'empty_universe', 'zero_cruised',
    'zero_attributed', 'budget_exceeded', 'below_floor',
    'below_attribution_floor', 'malformed_measurement'
  ));
