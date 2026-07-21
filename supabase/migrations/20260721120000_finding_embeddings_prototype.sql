-- ============================================================================
-- finding_embeddings — PROTOTYPE for the pgvector similarity-clustering
-- evaluation (memory-health decision rule: cluster density fired consistently
-- → "prototype pgvector similarity first, re-measure").
--
-- The memory_health cluster-density metric uses pg_trgm (trigram) similarity on
-- `detail_snapshot`. Its limitation: a real finding re-raised across rounds
-- with DIFFERENT WORDING gets a fresh fingerprint AND low trigram overlap, so
-- it neither dedups nor clusters — the churn signal leaks. Semantic embeddings
-- (cosine over VECTOR(768)) should catch same-meaning/different-words pairs
-- that trigram misses. This table + `scripts/memory-pgvector-prototype.mjs`
-- MEASURE whether that is true before any gate integration.
--
-- PROTOTYPE scope: this table stores embeddings for open findings; the
-- clustering query lives in the prototype script, NOT in an RPC or the
-- memory_health gate. If the evaluation shows semantic clustering recovers
-- signal trigram misses, a follow-up promotes it (RPC + gate). If not, this is
-- an empty table that costs nothing. Mirrors the symbol_embeddings /
-- security_incidents pgvector pattern already in this repo.
--
-- `snapshot_hash` lets the prototype re-embed ONLY when a finding's
-- detail_snapshot changed — a re-run is otherwise free.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS finding_embeddings (
  finding_id      UUID PRIMARY KEY REFERENCES audit_findings(id) ON DELETE CASCADE,
  embedding       VECTOR(768),
  embedding_model TEXT NOT NULL,
  dimension       INT  NOT NULL,
  snapshot_hash   TEXT NOT NULL,   -- sha256(detail_snapshot) — re-embed only on change
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finding_embeddings_model
  ON finding_embeddings (embedding_model, dimension);

-- ivfflat cosine index — present for the prototype's self-join clustering query.
-- `lists` tuned small; the open-finding population is a few hundred rows.
CREATE INDEX IF NOT EXISTS idx_finding_embeddings_vector
  ON finding_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20)
  WHERE embedding IS NOT NULL;
