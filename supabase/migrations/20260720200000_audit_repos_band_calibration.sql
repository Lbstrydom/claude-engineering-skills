-- ── audit_repos: per-repo band calibration ──────────────────────────────────
--
-- Plan: docs/plans/arch-memory-band-recalibration.md §2.1 C4-REVISED.
--
-- The band floor is NOT a shipped constant. `scripts/lib/config.mjs` and
-- `symbol-index.mjs` both sync to consumer repos, so any threshold written
-- there would carry this repo's corpus statistics (3,478 Node-CLI symbols,
-- terse Haiku summaries) into a wine app with different vocabulary and symbol
-- density. That is the same class of defect as the original unreachable
-- 0.90/0.85/0.75 — a plausible constant meeting a distribution it was never
-- measured against.
--
-- So the FORMULA ships in code and the VALUE lives here, per repo, computed
-- from that repo's own index at refresh time:
--
--   floor = mu + 3*sigma  over pairwise cosine similarity of a random sample
--                         of the repo's own symbol embeddings
--
-- Stored as jsonb rather than scalar columns because the payload is a
-- measurement RECORD, not a setting: it carries the sample statistics, the
-- resulting floor, and the provenance tuple that invalidates it. Splitting
-- those across columns invites reading the floor without checking whether the
-- provenance still matches — which is the failure mode the provenance exists
-- to prevent.
--
-- Shape:
--   {
--     "floor": 0.7146,
--     "k": 3,
--     "minCliffDelta": 0.03,
--     "stats": { "mean":…, "sd":…, "n":…, "pairs":…, "p50":…, "p95":…, "p99":…, "max":… },
--     "provenance": {
--       "embedModel":…, "embedDim":…, "composeVersion":…,
--       "normalizerId":…, "normalizePromptVersion":…, "refreshId":…
--     },
--     "calibratedAt": "2026-07-20T…Z"
--   }
--
-- NULL means UNCALIBRATED, and uncalibrated is not a licence to guess: the
-- consultation bands `review` only. That is the honest default and matches the
-- tool's behaviour before this work, so a consumer sees an accurate label
-- rather than a regression.

ALTER TABLE audit_repos
  ADD COLUMN IF NOT EXISTS band_calibration JSONB;

COMMENT ON COLUMN audit_repos.band_calibration IS
  'Per-repo unsupervised band calibration (mu + k*sigma over the repo''s own '
  'symbol-embedding background distribution), plus the provenance tuple that '
  'invalidates it. NULL = uncalibrated → the consultation bands `review` only, '
  'never a borrowed threshold from another repo.';
