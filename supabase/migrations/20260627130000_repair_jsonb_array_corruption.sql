-- Repair jsonb ARRAY columns corrupted by the supabase-js→pg migration
-- (postgres-parity M3, 2026-05-21). PostgREST implicitly JSON-serialized request
-- bodies; the `pg` driver does not — a raw JS array binds as a Postgres array
-- literal, so an EMPTY `[]` silently landed as a jsonb object `{}` (and a non-empty
-- array errored 22P02, never persisting). The code fix (JSON.stringify at every
-- array-jsonb call site) stops new corruption; this repairs the empty-`{}` rows
-- back to `[]` so array readers (jsonb_array_length, ->>, unnest) work again.
--
-- Safe + idempotent: only rows whose value is a jsonb OBJECT are touched, and the
-- only object an array column ever received was the empty-`{}` marker (non-empty
-- arrays never persisted), so no real data is rewritten.

UPDATE persona_test_sessions SET findings = '[]'::jsonb
  WHERE jsonb_typeof(findings) = 'object';

UPDATE plans SET focus_areas = '[]'::jsonb
  WHERE jsonb_typeof(focus_areas) = 'object';

UPDATE plans SET principles_cited = '[]'::jsonb
  WHERE jsonb_typeof(principles_cited) = 'object';

-- click_path defaults to '[]' and was never written before the fix, so no repair
-- needed there. ship_events.block_reasons / regression_specs.dom_contract_types had
-- no post-M3 writes (pre-M3 rows used PostgREST), so nothing to repair either.
