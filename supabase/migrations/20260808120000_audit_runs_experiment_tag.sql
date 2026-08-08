-- audit_runs.experiment_tag — separate REPLAY runs from organic ones.
--
-- Why this column exists. The final-review bake-off replays a saved audit
-- transcript through several reviewer configurations. Each replay needs an
-- `audit_runs` row, because `--run-id` is what arms `recordFinalReviewFindings`
-- (without it the whole cloud write is a silent no-op — that is why bake-off
-- snapshots 2 and 3 persisted `final_review_shadow_model = NULL` and zero
-- findings, and the markdown table was the only record).
--
-- But an unlabelled replay row is worse than no row. `getFinalReviewStats`
-- aggregates `COUNT(*)` per `final_review_model` over the repo's runs, and the
-- campaign's own comparison baseline — Opus at ~1.1 accepted HIGH/MED per run —
-- is a per-RUN rate read from exactly that denominator. Twelve snapshots x three
-- arms would silently add 36 runs to it and deflate the rate by ~4x, which is
-- the same shape as this repo's recorded "audit_runs rows are per-ROUND" false
-- alarms: a believable number derived from a contaminated denominator.
--
-- NULL means an ordinary run — the default, and every pre-existing row. The
-- column is deliberately free text rather than an enum: a CHECK would have to be
-- migrated for each new experiment, and this is descriptive telemetry, not a
-- state machine. Readers filter on `experiment_tag IS NULL` for organic-only.
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS experiment_tag TEXT;

COMMENT ON COLUMN audit_runs.experiment_tag IS
  'Non-null marks a run as belonging to a named EXPERIMENT (e.g. final-review-bakeoff) rather than an organic audit. NULL = ordinary run. Aggregate readers of per-run rates must exclude non-null rows or report them separately; the adjudication queue deliberately includes them.';

-- Partial index: the selective direction is "find this experiment's runs".
-- Organic runs are the overwhelming majority, so indexing NULLs would buy
-- nothing and cost writes on every ordinary audit.
CREATE INDEX IF NOT EXISTS audit_runs_experiment_tag_idx
  ON audit_runs (experiment_tag) WHERE experiment_tag IS NOT NULL;
