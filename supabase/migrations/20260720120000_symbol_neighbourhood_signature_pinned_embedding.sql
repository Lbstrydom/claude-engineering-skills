-- ── symbol_neighbourhood: pin the embedding join to the CURRENT signature ────
--
-- BUG (found 2026-07-20 via the arch-memory band-recalibration probe set)
--
-- `symbol_embeddings` is UNIQUE (definition_id, embedding_model, dimension,
-- signature_hash) — signature_hash is part of the key, and rows deliberately
-- SURVIVE across refreshes (see the table comment in 20260501120000). So a
-- symbol whose signature has changed N times accumulates N embedding rows for
-- the same (definition_id, embedding_model, dimension).
--
-- The RPC's LEFT JOIN matched only (definition_id, embedding_model, dimension)
-- and therefore FANNED OUT: one symbol_index row produced N result rows, each
-- scored against a different historical signature's embedding. Those duplicate
-- rows then consumed slots in the `LIMIT p_k` budget, displacing genuinely
-- distinct symbols.
--
-- Observed on Lbstrydom/claude-engineering-skills @ active refresh:
--   186 of 3,324 index rows fanned out (5.6%), worst case 10 rows for one symbol.
-- The k=5 consultation for "write a file safely so a crash mid-write can't
-- corrupt it" returned 5 rows but only 3 DISTINCT symbols, and the canonical
-- `file-io.mjs:atomicWriteFileSync` was pushed off the list by duplicates of
-- two of its own forks.
--
-- FIX: join the embedding whose signature_hash matches the snapshot's current
-- signature_hash. This is a root-cause fix, not a DISTINCT-ON band-aid:
-- deduplicating by picking an arbitrary surviving row would sometimes pick an
-- embedding of code that no longer exists. Pinning to the current signature
-- always scores against the code actually in the snapshot.
--
-- COST: measured 3,322 of 3,324 index rows already have an exact-signature
-- embedding — and the same 2 rows have no embedding under the old join either,
-- so this predicate loses nothing today.
--
-- TRADE-OFF (accepted, deliberate): if embedding generation ever lags indexing,
-- an affected symbol now scores 0 (drops out) instead of matching on a stale
-- embedding. That is the correct direction — a match computed against a
-- signature that no longer exists is a false match the consultation cannot
-- distinguish from a real one, and it silently mis-ranks the whole result set.
-- The `symbol_refresh_coverage` surface (20260718210000) is where embedding lag
-- is meant to be observed, not here.
--
-- Body is otherwise byte-identical to 20260501120000_symbol_index.sql:231-303.

CREATE OR REPLACE FUNCTION symbol_neighbourhood(
  p_repo_id          UUID,
  p_refresh_id       UUID,
  p_target_paths     TEXT[],
  p_intent_embedding VECTOR(768),
  p_kind_filter      TEXT[] DEFAULT NULL,
  p_k               INTEGER DEFAULT 50
)
RETURNS TABLE (
  symbol_index_id UUID,
  definition_id   UUID,
  symbol_name     TEXT,
  kind            TEXT,
  file_path       TEXT,
  start_line      INTEGER,
  end_line        INTEGER,
  purpose_summary TEXT,
  domain_tag      TEXT,
  similarity      NUMERIC,
  hop_score       NUMERIC,
  combined_score  NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  WITH active_emb_model AS (
    SELECT active_embedding_model AS model, active_embedding_dim AS dim
    FROM audit_repos WHERE id = p_repo_id
  ),
  scored AS (
    SELECT
      si.id                AS symbol_index_id,
      sd.id                AS definition_id,
      sd.symbol_name,
      sd.kind,
      si.file_path,
      si.start_line,
      si.end_line,
      si.purpose_summary,
      si.domain_tag,
      -- Cosine similarity (1 - cosine distance)
      CASE WHEN se.embedding IS NOT NULL AND p_intent_embedding IS NOT NULL
           THEN (1 - (se.embedding <=> p_intent_embedding))::numeric
           ELSE 0::numeric END AS similarity,
      -- Hop score: 1.0 if file in target_paths, 0.5 if file imports a target (1-hop), else 0
      CASE WHEN p_target_paths IS NULL OR array_length(p_target_paths, 1) IS NULL THEN 0::numeric
           WHEN si.file_path = ANY(p_target_paths) THEN 1.0::numeric
           ELSE 0::numeric END AS hop_score
    FROM symbol_index si
    JOIN symbol_definitions sd ON sd.id = si.definition_id
    LEFT JOIN active_emb_model aem ON true
    LEFT JOIN symbol_embeddings se
           ON se.definition_id = sd.id
          AND se.embedding_model = aem.model
          AND se.dimension       = aem.dim
          -- ↓ THE FIX: pin to the snapshot's current signature so a symbol with
          --   historical embedding rows yields exactly ONE scored row.
          AND se.signature_hash  = si.signature_hash
    WHERE si.refresh_id = p_refresh_id
      AND (p_kind_filter IS NULL
           OR array_length(p_kind_filter, 1) IS NULL
           OR sd.kind = ANY(p_kind_filter))
  )
  SELECT
    s.symbol_index_id, s.definition_id, s.symbol_name, s.kind, s.file_path,
    s.start_line, s.end_line, s.purpose_summary, s.domain_tag,
    s.similarity, s.hop_score,
    (s.hop_score * 0.4 + s.similarity * 0.6)::numeric AS combined_score
  FROM scored s
  ORDER BY combined_score DESC
  LIMIT p_k;
END;
$$;

-- Supporting index: the join now filters on signature_hash too.
CREATE INDEX IF NOT EXISTS idx_symbol_embeddings_def_model_dim_sig
  ON symbol_embeddings (definition_id, embedding_model, dimension, signature_hash);
