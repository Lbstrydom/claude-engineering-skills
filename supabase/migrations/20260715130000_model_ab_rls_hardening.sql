-- Enable RLS on 3 model-A/B tables that shipped without it.
--
-- Background: `audit_arms`, `finding_equivalence`, and `model_ab_spend_ledger`
-- were created by 20260701120000_model_ab.sql without an ENABLE ROW LEVEL
-- SECURITY statement (the sibling 20260701160000_arm_eval.sql migration
-- looped RLS-enable over its own new tables but didn't retroactively cover
-- these three). Flagged by the Supabase security advisor
-- (rls_disabled_in_public) on project uahjjdelnnpfmaqjrwoz.
--
-- Live grant check on 2026-07-15 found neither anon nor authenticated
-- currently holds a table-level grant on any of the three (confirmed via
-- has_table_privilege) — this project doesn't expose PostgREST to any
-- client, all access is the runtime AUDIT_DB_URL/postgres role, which
-- bypasses RLS regardless of policy. So there is no live read/write
-- exposure today, but RLS-disabled is a silent single-point-of-failure:
-- if grants are ever added to these roles later, the tables become
-- instantly exposed with no additional warning.
--
-- Fix: enable RLS with no policy, deny-by-default for anon/authenticated —
-- same pattern as 20260530120000_audit_loop_migrations_rls.sql and every
-- other table in this schema. The runtime role still bypasses RLS, so the
-- audit-loop's own reads/writes are unaffected.
--
-- Idempotent: ALTER TABLE ... ENABLE ROW LEVEL SECURITY is a no-op on a
-- table that already has it on.

ALTER TABLE audit_arms ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_equivalence ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_ab_spend_ledger ENABLE ROW LEVEL SECURITY;
