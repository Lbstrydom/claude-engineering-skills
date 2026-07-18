-- symbol_refresh_coverage — the observed graph's honesty record.
--
-- The import graph has always reported what SURVIVED and never what it
-- dropped, across three independent loss sites (the COMMON_SOURCE_DIRS
-- allowlist, the edge filters in extract.mjs, and the untagged-domain skip in
-- observed-deps.mjs). A repo can therefore be missing most of its edges while
-- every surface reads authoritative — measured 2026-07-18: 2% of files
-- invisible on this repo, 1% on one consumer, 68% on another.
--
-- The measurement is taken in a SUBPROCESS (refresh.mjs spawns extract.mjs)
-- but consumed by a DIFFERENT process reading from the DB (render-mermaid.mjs).
-- This table is that route. Without it the measurement is computed and then
-- dropped on the floor, which is what the plan's first draft did.
--
-- Keyed on refresh_id — the snapshot identity refresh.mjs already owns — so
-- coverage can never be attributed to the wrong run. No new identity concept,
-- and one row per refresh (PRIMARY KEY, not just unique) because a refresh has
-- exactly one coverage verdict by construction.
--
-- `payload` is the whole §2.1.6b record verbatim (schemaVersion, verdict,
-- extraction, attribution, samples). The promoted columns beside it are NOT a
-- second source of truth — they are query surface for the dashboard and the
-- gate, so neither has to parse jsonb to answer "is this graph trustworthy".
-- The writer sets both from one object; graph-verdict.mjs remains the single
-- oracle that PRODUCES the verdict.
--
-- jsonb is passed RAW by the store layer — serializeWriteParam handles it
-- (AGENTS.md "jsonb-safe write seam"). There is no genuine Postgres array
-- column here, so nothing needs pgArray().
--
-- Idempotent and purely additive: CREATE TABLE / CREATE INDEX IF NOT EXISTS on
-- a NEW table name. No existing table is altered, no row can fail, nothing is
-- backfilled. A refresh predating this feature simply has no row, which the
-- reader maps to `unknown` / `not_measured` — never to `verified`, because
-- absence is not evidence of cleanliness.

CREATE TABLE IF NOT EXISTS symbol_refresh_coverage (
  -- FK matches symbol_file_imports' convention exactly: refresh_runs(id).
  refresh_id    uuid PRIMARY KEY
                  REFERENCES refresh_runs(id) ON DELETE CASCADE,

  -- Promoted from payload.verdict for indexed querying. Constrained to the
  -- closed enums in graph-verdict.mjs so a typo in a future writer fails LOUDLY
  -- here rather than rendering as an unrecognised (and probably green) status.
  status        text NOT NULL
                  CHECK (status IN ('verified', 'degraded', 'unverified', 'unknown')),
  reason        text
                  CHECK (reason IS NULL OR reason IN (
                    'extraction_failed', 'extraction_timeout', 'not_measured',
                    'stale_measurement', 'empty_universe', 'zero_cruised',
                    'zero_attributed', 'budget_exceeded', 'below_floor',
                    'below_attribution_floor'
                  )),

  -- `verified` is the ONLY status that may carry no reason, and it must not
  -- carry one. Every other status names exactly why — that is the whole point
  -- of the closed enum, and enforcing it here stops a contradictory record
  -- (e.g. degraded with reason NULL) from ever being persisted.
  CONSTRAINT symbol_refresh_coverage_reason_matches_status
    CHECK ((status = 'verified') = (reason IS NULL)),

  -- true when copied forward from an earlier run. Coverage is a FULL-RUN
  -- measurement: an incremental refresh never inherits a verdict, because file
  -- CONTENT can change while the file LIST stays byte-identical.
  stale         boolean NOT NULL DEFAULT false,

  -- Identity of the run that actually MEASURED this, which is NOT refresh_id
  -- when the row was copied forward. Keeping both is what lets the dashboard
  -- say "measured 3 refreshes ago" instead of implying it was measured now.
  measured_at        timestamptz NOT NULL,
  measured_refresh_id uuid NOT NULL,

  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A stale row is never verified, so the dashboard's "show me what is actually
-- trustworthy" query filters on both. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS symbol_refresh_coverage_status_idx
  ON symbol_refresh_coverage (status)
  WHERE stale = false;
