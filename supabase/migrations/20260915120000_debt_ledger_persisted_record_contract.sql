-- docs/plans/debt-ledger-persisted-record-contract.md §2.
--
-- Fix A + Fix D — new debt_entries columns for the classification-or-
-- explicit-unavailable contract and the revalidation/successor-link fields.
-- Additive + idempotent. Safe to re-run.
ALTER TABLE debt_entries ADD COLUMN IF NOT EXISTS classification_unavailable_reason TEXT;
ALTER TABLE debt_entries ADD COLUMN IF NOT EXISTS review_deadline TIMESTAMPTZ;
ALTER TABLE debt_entries ADD COLUMN IF NOT EXISTS superseded_by TEXT;

-- Fix C — debt_embeddings, mirroring finding_embeddings' shape
-- (20260721120000_finding_embeddings_prototype.sql) for content-aliasing at
-- debt-capture time. Intentionally NOT FK'd to debt_entries: the alias
-- lookup runs against OTHER entries before this entry's own row necessarily
-- exists, so an FK would force an ordering the write path doesn't have.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS debt_embeddings (
  repo_id         UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  topic_id        TEXT NOT NULL,
  embedding       VECTOR(768),
  embedding_model TEXT NOT NULL,
  dimension       INT NOT NULL,
  snapshot_hash   TEXT NOT NULL,  -- sha256 of the embedded text — re-embed only on change
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_debt_embeddings_model ON debt_embeddings (embedding_model, dimension);

-- ivfflat cosine index — population is small (one row per deferred debt
-- topic), `lists` tuned accordingly, mirroring finding_embeddings' tuning.
CREATE INDEX IF NOT EXISTS idx_debt_embeddings_vector
  ON debt_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20)
  WHERE embedding IS NOT NULL;

-- RLS — same single-tenant "Allow all for anon" shape already applied to
-- debt_entries/debt_events (20260405092206_add_debt_memory.sql). This is a
-- personal/single-user CLI tool, not a multi-tenant service.
ALTER TABLE debt_embeddings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for anon" ON debt_embeddings;
CREATE POLICY "Allow all for anon" ON debt_embeddings FOR ALL USING (true) WITH CHECK (true);
