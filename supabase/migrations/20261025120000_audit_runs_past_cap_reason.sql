-- Round-cap override record (docs/plans/audit-round-cap-structural-or-stop.md §2.1).
--
-- `openai-audit.mjs` now refuses a round past the soft cap (plan 3, code 6) unless
-- the caller passes `--past-cap "<reason>"`, and refuses outright past the absolute
-- cap (plan 5, code 8). The reason, and the summary of the structural-or-stop card
-- that was computed for the round, are recorded on the run so a coordinator can
-- review overrides: a past_cap_card with structural > 0 is the review signal.
--
-- Both columns are nullable and purely additive: every existing row stays NULL,
-- which is honest — those runs had no cap to pass. The writer
-- (`updateRunMeta`, runs-findings.mjs) probe-guards them, because consumer stores
-- are migrated at different times and a past-cap round must not fail on an
-- unmigrated one; it logs a named line and the authoritative local record
-- (`_roundCap` on the round result, plus the card JSON) is kept.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS past_cap_reason text;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS past_cap_card   jsonb;
