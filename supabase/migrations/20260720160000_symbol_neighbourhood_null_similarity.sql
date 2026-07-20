-- ── symbol_neighbourhood: separate RANKING from BANDING ─────────────────────
--
-- Plan: docs/plans/arch-memory-band-recalibration.md §2.1 C3.
--
-- THE DEFECT
--
-- The RPC scored a symbol with no embedding as `ELSE 0`. That single value was
-- then used for two different jobs, and it was wrong for one of them:
--
--   1. RANKING — "which candidates do we show?"  A 0 here is a defensible
--      ordering choice.
--   2. BANDING — "what recommendation do we emit?"  A fabricated 0 becomes an
--      authoritative "considered and rejected" verdict about a symbol we
--      actually have no evidence about. `recommendationFromSimilarity(0)`
--      returns `review` — indistinguishable from a genuine weak match.
--
-- Collapsing "no evidence" and "orthogonal" into one number is what made the
-- distinction unrecoverable downstream. Three successive attempts to fix the
-- ordering each traded one symptom for another (an unembedded target-path file
-- reaching 0.4 on hop score alone and outranking real matches; then `scored
-- DESC` first burying that file entirely; then `hop_score` first burying
-- perfect semantic matches in untouched files) — all consequences of using one
-- value for both jobs.
--
-- THE FIX
--
--   similarity     NUMERIC  NULL when there is no embedding. Never 0-as-proxy.
--                           This is what banding reads, and ONLY this.
--   scored         BOOLEAN  Explicit "did we have evidence?", so a consumer
--                           can tell absence from a low score without probing
--                           for NULL.
--   ranking_score  NUMERIC  NOT NULL. hop*0.4 + COALESCE(similarity,0)*0.6.
--                           The COALESCE is legitimate HERE and only here: this
--                           is an ordering heuristic, and hop-score is exactly
--                           how an actively-edited file earns its slot. No
--                           burying in either direction — a target-path file
--                           with no embedding still scores 0.4, a perfect
--                           semantic match in an untouched file still scores
--                           0.6.
--
-- `combined_score` is RETAINED as an alias of `ranking_score` so existing
-- callers keep working; it is the column older code sorts on. New code should
-- read `ranking_score` + `scored`.
--
-- BACKWARD-COMPATIBILITY NOTE (deliberate, not an oversight): `similarity` is
-- now nullable, so any caller doing arithmetic on it without a null check
-- changes behaviour. That is the point — such a caller was silently consuming
-- a fabricated 0. Both known JS consumers are updated in the same change:
-- `neighbourhood-query.mjs` (maps the RPC rows) and `symbol-index.mjs`
-- `rankNeighbourhood` (a second, in-process implementation of the same
-- formula that reproduced the identical ELSE-0 defect in Node).
--
-- Retains the signature-pinned embedding join from 20260720120000 — that fix
-- (one embedding row per CURRENT signature, not per historical signature) is
-- independent of this one and must not be lost by this replacement.

-- Postgres cannot change a function's RETURNS TABLE shape via CREATE OR
-- REPLACE ("cannot change return type of existing function"), and this adds
-- `ranking_score` + `scored`. Drop the exact prior signature first. Safe here:
-- single-tenant, and the function is recreated in the same transaction, so no
-- window exists where a caller sees it missing.
DROP FUNCTION IF EXISTS symbol_neighbourhood(UUID, UUID, TEXT[], VECTOR(768), TEXT[], INTEGER);

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
  combined_score  NUMERIC,
  ranking_score   NUMERIC,
  scored          BOOLEAN
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
  scored_rows AS (
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
      -- NULL, not 0, when we have no evidence. Banding reads this.
      CASE WHEN se.embedding IS NOT NULL AND p_intent_embedding IS NOT NULL
           THEN (1 - (se.embedding <=> p_intent_embedding))::numeric
           ELSE NULL END AS similarity,
      CASE WHEN p_target_paths IS NULL OR array_length(p_target_paths, 1) IS NULL THEN 0::numeric
           WHEN si.file_path = ANY(p_target_paths) THEN 1.0::numeric
           ELSE 0::numeric END AS hop_score
    FROM symbol_index si
    JOIN symbol_definitions sd ON sd.id = si.definition_id
    LEFT JOIN active_emb_model aem ON true
    -- Signature-pinned (from 20260720120000): symbol_embeddings is UNIQUE on
    -- (definition_id, model, dimension, signature_hash) and rows survive across
    -- refreshes, so joining without signature_hash fans one symbol out into N
    -- rows scored against N historical signatures, consuming the LIMIT budget.
    LEFT JOIN symbol_embeddings se
           ON se.definition_id   = sd.id
          AND se.embedding_model = aem.model
          AND se.dimension       = aem.dim
          AND se.signature_hash  = si.signature_hash
    WHERE si.refresh_id = p_refresh_id
      AND (p_kind_filter IS NULL
           OR array_length(p_kind_filter, 1) IS NULL
           OR sd.kind = ANY(p_kind_filter))
  )
  SELECT
    s.symbol_index_id, s.definition_id, s.symbol_name, s.kind, s.file_path,
    s.start_line, s.end_line, s.purpose_summary, s.domain_tag,
    s.similarity,
    s.hop_score,
    -- combined_score retained as an alias so existing callers keep sorting.
    (s.hop_score * 0.4 + COALESCE(s.similarity, 0) * 0.6)::numeric AS combined_score,
    (s.hop_score * 0.4 + COALESCE(s.similarity, 0) * 0.6)::numeric AS ranking_score,
    (s.similarity IS NOT NULL)                                     AS scored
  FROM scored_rows s
  ORDER BY (s.hop_score * 0.4 + COALESCE(s.similarity, 0) * 0.6) DESC
  LIMIT p_k;
END;
$$;

COMMENT ON FUNCTION symbol_neighbourhood IS
  'K-nearest symbol consultation. `similarity` is NULL when the symbol has no '
  'embedding for the active (model, dim, signature) — banding MUST read this '
  'column and must never coalesce it, because a fabricated 0 reads as an '
  'authoritative "considered and rejected" verdict. `ranking_score` is the '
  'ordering heuristic and DOES coalesce, which is correct for ordering only. '
  '`scored` distinguishes "no evidence" from "low similarity".';
