-- ============================================================================
-- Audit Loop — Security-Memory Schema (003)
-- Full security_incidents index + security_strategy_events audit trail +
-- security_incident_neighbourhood() retrieval RPC.
--
-- Plan: docs/plans/security-strategy-postgres-port.md §4.2 (Phase 1).
--
-- Coexists with the lightweight `security_incident_log` heartbeat table from
-- 001-core.pg.sql — different roles, both permanent (see plan §4.2 note).
--
-- pgvector is OPTIONAL and runtime-detected: the `embedding` column, its HNSW
-- index, and the neighbourhood RPC are created only when the `vector` extension
-- is present. When absent, cross-skill retrieval falls back to path-overlap
-- ranking (see scripts/cross-skill.mjs get-incident-neighbourhood).
--
-- Apply via: node scripts/setup-postgres.mjs --migrate
-- Safe to re-apply (all CREATE/ALTER IF NOT EXISTS / idempotent DO blocks).
-- ============================================================================

-- gen_random_uuid() lives in core on PostgreSQL 13+, but pgcrypto provides it on
-- older servers. 001-core already enables pgcrypto; we repeat it here so this
-- migration is self-contained and applies cleanly even if run in isolation
-- (R3 finding 8b25c13c / Opus O2). IF NOT EXISTS makes the repeat a no-op.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Base table: no VECTOR type — embedding column added conditionally below.
CREATE TABLE IF NOT EXISTS security_incidents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id             UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  incident_id         TEXT NOT NULL,                          -- INC-NNN per-repo
  description         TEXT NOT NULL,
  affected_paths      TEXT[] NOT NULL DEFAULT '{}',
  mitigation_ref      TEXT,                                   -- semgrep:rule-id | scripts/path | manual
  mitigation_kind     TEXT NOT NULL DEFAULT 'manual'
                        CHECK (mitigation_kind IN ('semgrep', 'manual', 'file-ref')),
  status              TEXT NOT NULL DEFAULT 'manual-verification-required'
                        CHECK (status IN ('mitigation-passing', 'mitigation-failing',
                                          'manual-verification-required', 'historical')),
  lessons_learned     TEXT,

  -- Audit-loop corporate hardening (uppercase 4-value vocabulary matches the
  -- shipped /security-strategy skill, docs/security-strategy.md template, and
  -- the security_incident_log table — see plan §4.2 implementation note):
  commit_sha          TEXT NOT NULL,                          -- mandatory git linkage; no orphan incidents
  classification      TEXT NOT NULL DEFAULT 'INTERNAL'
                        CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
  compliance_tags     TEXT[] NOT NULL DEFAULT '{}',           -- ['org-security', 'org-data', ...]

  -- Embedding columns: only populated when pgvector available (column added
  -- conditionally below). embedding_model / embedding_dim are always present.
  embedding_model     TEXT,                                   -- e.g. 'azure-openai/text-embedding-3-small-768'
  embedding_dim       INTEGER,                                -- must equal actual embedding length before insert

  -- Change detection + audit:
  source_fingerprint  TEXT NOT NULL,                          -- sha256 of canonical incident block
  status_check_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_id, incident_id)
);

CREATE INDEX IF NOT EXISTS idx_security_incidents_repo ON security_incidents(repo_id);
CREATE INDEX IF NOT EXISTS idx_security_incidents_fingerprint ON security_incidents(source_fingerprint);

-- Bump updated_at on every UPDATE so freshness checks work.
CREATE OR REPLACE FUNCTION touch_security_incidents_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_security_incidents_touch ON security_incidents;
CREATE TRIGGER trg_security_incidents_touch
  BEFORE UPDATE ON security_incidents
  FOR EACH ROW EXECUTE FUNCTION touch_security_incidents_updated_at();

-- Conditionally add the VECTOR column + HNSW index when pgvector is available.
-- FIRST try to install the extension, THEN check whether it actually loaded.
-- Idempotent — re-running the migration is safe.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector extension unavailable (%). Proceeding without embedding column.', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'security_incidents' AND column_name = 'embedding'
    ) THEN
      ALTER TABLE security_incidents ADD COLUMN embedding vector(768);
    END IF;
    -- HNSW index: safe on empty or populated table. Default params (m=16,
    -- ef_construction=64) are appropriate for v1.
    -- Schema-qualify (public.) so the ALTER/CREATE target the same schema the
    -- existence probe above checks (table_schema='public'), even under a
    -- non-default search_path. Defensive consistency; runtime pins search_path=public.
    CREATE INDEX IF NOT EXISTS idx_security_incidents_embedding
      ON security_incidents USING hnsw (embedding vector_cosine_ops);
  END IF;
END $$;

-- ── Audit-trail table (corporate requirement) ───────────────────────────────
CREATE TABLE IF NOT EXISTS security_strategy_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  incident_id     TEXT NOT NULL,                              -- INC-NNN (FK soft — incident may be historical)
  event_kind      TEXT NOT NULL
                    CHECK (event_kind IN ('inserted', 'updated', 'embedding_rebuilt',
                                          'marked_historical', 'refused_secret', 'redacted_secret')),
  who             TEXT,                                       -- $USER / git config user.name
  branch          TEXT NOT NULL,                              -- e.g. 'main' or 'feature/foo'
  commit_sha      TEXT,
  detail          JSONB NOT NULL DEFAULT '{}',                -- redacted before insert
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_security_strategy_events_repo
  ON security_strategy_events(repo_id, created_at DESC);

-- ── Cosine-distance neighbourhood RPC ───────────────────────────────────────
-- Named security_incident_neighbourhood to avoid colliding with the
-- arch-memory stub incident_neighbourhood() (different signature) in
-- 002-arch-memory.pg.sql. Created only when pgvector is present; callers fall
-- back to the path-overlap-only SQL in cross-skill.mjs when it is absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE $func$
      CREATE OR REPLACE FUNCTION security_incident_neighbourhood(
        p_repo_id          UUID,
        p_target_paths     TEXT[],
        p_intent_embedding vector(768),
        p_k                INTEGER DEFAULT 8
      ) RETURNS TABLE (
        id              UUID,
        incident_id     TEXT,
        description     TEXT,
        affected_paths  TEXT[],
        status          TEXT,
        classification  TEXT,
        compliance_tags TEXT[],
        similarity      NUMERIC,
        path_overlap    INTEGER
      ) LANGUAGE SQL STABLE AS $fn$
        SELECT
          si.id, si.incident_id, si.description, si.affected_paths,
          si.status, si.classification, si.compliance_tags,
          CASE WHEN p_intent_embedding IS NULL THEN NULL
               ELSE (1 - (si.embedding <=> p_intent_embedding))::NUMERIC
          END AS similarity,
          cardinality(ARRAY(SELECT unnest(si.affected_paths) INTERSECT SELECT unnest(p_target_paths)))::INTEGER
            AS path_overlap
        FROM security_incidents si
        WHERE si.repo_id = p_repo_id
          AND si.status <> 'historical'
          AND (p_intent_embedding IS NULL OR si.embedding IS NOT NULL)
        ORDER BY path_overlap DESC, similarity DESC NULLS LAST
        LIMIT p_k
      $fn$
    $func$;
  END IF;
END $$;

-- When pgvector is absent, cross-skill.mjs uses a plain SQL fallback
-- (path-overlap only) — see scripts/lib/store/security.mjs.

-- schema_version: this migration records v=5 (plan §4.2 + acceptance criteria
-- 6/7). Existing inserts are 001-core=4 and 002-arch-memory=2 (the latter is a
-- pre-existing quirk); v=5 is unused, so this row is unambiguous. There is no
-- UNIQUE constraint on schema_version.v — the migration ledger
-- (audit_loop_migrations sha256) guards against re-applying this file, so the
-- row is inserted at most once.
INSERT INTO schema_version (v) VALUES (5) ON CONFLICT DO NOTHING;
