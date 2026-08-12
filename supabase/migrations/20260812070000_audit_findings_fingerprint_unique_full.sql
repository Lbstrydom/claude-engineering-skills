-- audit_findings: replace the PARTIAL unique index with a full one.
--
-- Plan: docs/plans/audit-store-write-durability.md. Fixes a defect the Cluster A
-- code audit found in 20260812060000 (H6/H11), verified against the live store
-- rather than argued:
--
--   INSERT ... ON CONFLICT (run_id, finding_fingerprint) DO UPDATE
--     -> 42P10: there is no unique or exclusion constraint matching the
--        ON CONFLICT specification
--
-- Postgres will not infer a PARTIAL index for a bare conflict target. The
-- upsert must repeat the index predicate verbatim
-- (`ON CONFLICT (run_id, finding_fingerprint) WHERE finding_fingerprint IS NOT NULL`)
-- — measured: with the predicate it works, without it fails. So the previous
-- migration created an index the planned Phase 3 upsert could not have used.
--
-- This is the SAME defect the plan already caught once and one level down: an
-- upsert target asserted without executing the upsert. The fix is the shape that
-- needs nothing remembered — a full unique index answers a bare ON CONFLICT, and
-- since NULLs are DISTINCT in a unique index it constrains exactly the same rows
-- the partial one did. The partial form's only advantage was index size.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFETY NOTE for anyone writing the next dedup here (audit H7/H12/H14).
--
-- 20260812060000 deleted duplicate rows to make this index creatable. That was
-- measured first (1 group / 1 excess row of 4,222) and left 0 orphans across all
-- seven referencing tables — but FIVE of those FKs are ON DELETE CASCADE:
--
--   finding_adjudication_events, finding_embeddings, campaign_worksheet_rows,
--   campaign_clusters, campaign_cluster_members     -> CASCADE
--   persona_audit_correlations, recurring_finding_clusters -> SET NULL
--
-- So a DELETE there does not fail loudly on a referenced row; it takes the
-- children with it. "0 orphans" afterwards is consistent BOTH with "the row had
-- no children" and with "its children were cascaded away", and those cannot be
-- told apart retrospectively. In this instance the deleted row was a duplicate
-- `[Adjacency]` control marker created 12 minutes after its twin, so dependents
-- were unlikely — but that is an argument from plausibility, not evidence.
--
-- A future dedup on this table MUST count dependents per candidate row before
-- deleting, and repoint or refuse rather than relying on the absence of orphans
-- afterwards. This migration deletes nothing.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_run_fingerprint_uniq_full
    ON audit_findings (run_id, finding_fingerprint);

DROP INDEX IF EXISTS audit_findings_run_fingerprint_uniq;

COMMIT;
