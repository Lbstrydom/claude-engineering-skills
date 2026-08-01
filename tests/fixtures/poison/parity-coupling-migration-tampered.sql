-- POISON FIXTURE — not a real migration.
--
-- A copy of 20260403083809_learning_v2_stage4_constraints.sql with one line
-- schema-qualified. `public.` qualification is exactly the non-portable coupling
-- `--schema-coupling` exists to catch, and this occurrence is not in
-- SCHEMA_COUPLING_BASELINE, so the gate must reject it.
--
-- Three such qualifications reached main unnoticed in June 2026 while this lint
-- existed but was absent from the check chain.
ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_pass_name_variant_id_key;
ALTER TABLE public.bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_unique;
ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_pass_variant_bucket_key;
ALTER TABLE bandit_arms ADD CONSTRAINT bandit_arms_unique
  UNIQUE (pass_name, variant_id, context_bucket);
