-- ============================================================================
-- memory_friction — recurrence-aware friction-feedback mirror.
-- Plan: docs/plans/friction-feedback-loop.md (Cluster A).
--
-- A THIN, queryable mirror of `type: friction` harness-memory files. The memory
-- file is the source of truth; this table exists ONLY for the one thing flat
-- per-user files can't give: cross-repo / cross-session RECURRENCE aggregation.
--
-- Two RPCs:
--   friction_recurrence(repo_id_filter, window_days, min_similarity)
--     — cross-repo (repo_id_filter NULL) or per-repo recurrence clusters.
--   friction_neighbourhood(p_repo_id, p_prompt, k, min_word_sim)
--     — hook injection: the friction's SHORT signature matched as the QUERY
--       against the (possibly long) prompt as the DOCUMENT (word_similarity).
--
-- Single-tenant: the runtime pg pool owns `public` and bypasses RLS; the RLS
-- policy (enabled, no anon policy) is defense-in-depth, mirroring
-- security_incidents. pg_trgm is the recurrence/similarity engine (reused from
-- memory_health_metrics).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS memory_friction (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  memory_name     TEXT NOT NULL,
  source_hash     TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  title           TEXT NOT NULL,
  body_excerpt    TEXT NOT NULL DEFAULT '',
  scope_tags      TEXT[] NOT NULL DEFAULT '{}',
  files           TEXT[] NOT NULL DEFAULT '{}',
  symbols         TEXT[] NOT NULL DEFAULT '{}',
  cost            TEXT NOT NULL DEFAULT 'M' CHECK (cost IN ('S','M','L')),
  fingerprint     TEXT NOT NULL,
  trgm_text       TEXT NOT NULL,                 -- title+body+tags (recurrence: full-text, symmetric)
  signature_text  TEXT NOT NULL DEFAULT '',      -- title+scope_tags (injection: SHORT query side)
  mitigation_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mitigation_refs) = 'array'),
  resolved        BOOLEAN GENERATED ALWAYS AS (jsonb_array_length(mitigation_refs) > 0) STORED,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, memory_name)
);

CREATE INDEX IF NOT EXISTS idx_memory_friction_repo ON memory_friction(repo_id);
CREATE INDEX IF NOT EXISTS idx_memory_friction_open ON memory_friction(repo_id, active, resolved);
CREATE INDEX IF NOT EXISTS idx_memory_friction_created ON memory_friction(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_friction_trgm ON memory_friction USING gin (trgm_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memory_friction_sig_trgm ON memory_friction USING gin (signature_text gin_trgm_ops);

-- bump updated_at on UPDATE
CREATE OR REPLACE FUNCTION touch_memory_friction_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_memory_friction_touch ON memory_friction;
CREATE TRIGGER trg_memory_friction_touch
  BEFORE UPDATE ON memory_friction
  FOR EACH ROW EXECUTE FUNCTION touch_memory_friction_updated_at();

-- RLS enabled, no anon policy (explicit absence is the boundary; runtime role bypasses).
ALTER TABLE memory_friction ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- friction_recurrence — recurrence clusters among OPEN friction.
-- repo_id_filter NULL → CROSS-REPO (the unique value); non-null → one repo.
-- Window is ASYMMETRIC: anchor `a` must be recent (created_at in window), peer
-- `b` is NOT windowed, so a fresh note matches an OLDER recurring peer.
-- max_cost via an explicit cost RANK (NOT MAX(text) — 'S'>'M'>'L' alphabetically).
-- Returns scope_tags so the Node caller derives `protected` against config.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION friction_recurrence(
  repo_id_filter UUID DEFAULT NULL,
  window_days INT DEFAULT 30,
  min_similarity NUMERIC DEFAULT 0.5,
  max_anchors INT DEFAULT 500
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSONB;
BEGIN
  PERFORM set_config('pg_trgm.similarity_threshold', min_similarity::text, true);

  WITH base AS (
    SELECT id, repo_id, memory_name, title, cost, trgm_text, scope_tags, created_at
    FROM memory_friction
    WHERE active AND NOT resolved
      AND (repo_id_filter IS NULL OR repo_id = repo_id_filter)
  ),
  anchors AS (
    SELECT * FROM base
    WHERE created_at >= now() - make_interval(days => window_days)
    LIMIT max_anchors
  ),
  pairs AS (
    SELECT a.id AS anchor_id, a.memory_name, a.title, a.cost, a.scope_tags,
           a.created_at, b.repo_id AS peer_repo, b.memory_name AS peer_name,
           similarity(a.trgm_text, b.trgm_text) AS sim
    FROM anchors a
    JOIN base b
      ON a.id <> b.id
     AND a.trgm_text % b.trgm_text
     AND similarity(a.trgm_text, b.trgm_text) > min_similarity
  ),
  clustered AS (
    SELECT anchor_id,
           MIN(memory_name) AS cluster_key,
           MIN(title) AS title,
           -- recurrence = 1 (self) + distinct matching peers
           1 + COUNT(DISTINCT peer_name) AS recurrence_count,
           ARRAY_AGG(DISTINCT peer_repo) AS repos_seen,
           MAX(CASE cost WHEN 'L' THEN 3 WHEN 'M' THEN 2 ELSE 1 END) AS cost_rank,
           (ARRAY_AGG(DISTINCT scope_tags))[1] AS scope_tags,
           EXTRACT(DAY FROM now() - MIN(created_at))::int AS oldest_age_days,
           ARRAY_AGG(DISTINCT peer_name) AS sample_names
    FROM pairs
    GROUP BY anchor_id
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'window_days', window_days,
    'repo_scoped', repo_id_filter IS NOT NULL,
    'clusters', COALESCE(jsonb_agg(jsonb_build_object(
      'cluster_key', cluster_key,
      'title', title,
      'recurrence_count', recurrence_count,
      'repos_seen', to_jsonb(repos_seen),
      'max_cost', CASE cost_rank WHEN 3 THEN 'L' WHEN 2 THEN 'M' ELSE 'S' END,
      'oldest_age_days', oldest_age_days,
      'scope_tags', to_jsonb(scope_tags),
      'sample_names', to_jsonb(sample_names)
    ) ORDER BY recurrence_count DESC, cost_rank DESC), '[]'::jsonb)
  ) INTO result
  FROM clustered;

  RETURN result;
END;
$$;

-- ----------------------------------------------------------------------------
-- friction_neighbourhood — hook injection. The friction's SHORT signature_text
-- is the QUERY; the (possibly long) prompt is the DOCUMENT → word_similarity
-- (asymmetric), gated by pg_trgm.word_similarity_threshold (its OWN GUC).
-- Repo-scoped, OPEN only, top-k by word_similarity.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION friction_neighbourhood(
  p_repo_id UUID,
  p_prompt TEXT,
  k INT DEFAULT 2,
  min_word_sim NUMERIC DEFAULT 0.6
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSONB;
BEGIN
  PERFORM set_config('pg_trgm.word_similarity_threshold', min_word_sim::text, true);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'memory_name', memory_name,
           'title', title,
           'cost', cost,
           'scope_tags', to_jsonb(scope_tags),
           'score', round(score::numeric, 3)
         ) ORDER BY score DESC), '[]'::jsonb)
  INTO result
  FROM (
    SELECT memory_name, title, cost, scope_tags,
           word_similarity(signature_text, p_prompt) AS score
    FROM memory_friction
    WHERE repo_id = p_repo_id
      AND active AND NOT resolved
      AND signature_text <% p_prompt
    ORDER BY score DESC
    LIMIT k
  ) top;

  RETURN result;
END;
$$;
