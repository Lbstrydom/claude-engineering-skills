-- ── symbol_definitions: bounded re-queue for failed summarisation ───────────
--
-- Plan: docs/plans/arch-memory-band-recalibration.md §2.1 C9.
--
-- THE GAP. `summarise.mjs` returns all-null summaries when its batch fails or
-- no Claude provider is configured. Those symbols get no embedding (the C9
-- guard in embed.mjs now withholds it rather than indexing a metadata-only
-- vector), and they surface honestly as `unscored`.
--
-- But they never HEAL. An incremental `arch:refresh` scopes extraction to files
-- from `git diff --name-status <since>` (refresh.mjs), so a symbol whose
-- summarisation failed once is revisited only if its file happens to be edited
-- again. A single transient provider outage therefore creates a PERMANENT blind
-- spot in the index — silently, because the affected symbols still appear in
-- results, just never as candidates.
--
-- WHY THE COUNTER LIVES HERE. `symbol_index` rows are per-refresh; a counter
-- there would reset on every run and the re-queue would be unbounded in
-- practice. `symbol_definitions` is keyed on the stable definition identity and
-- survives refreshes, so an attempt count accumulated across runs is meaningful.
--
-- WHY BOUNDED. Some symbols fail summarisation PERMANENTLY, not transiently —
-- an oversized body, a safety-filter trip, malformed source. An unbounded
-- re-queue would re-attempt those on every refresh forever, spending provider
-- calls on work that cannot succeed. At the cap the symbol is marked terminal
-- and dropped from the queue; it remains `unscored`, which is the honest state.
--
-- Both counts (re-queued, terminally-failed) are reported by the refresh, so a
-- systematic summarisation problem stays visible instead of being absorbed.

ALTER TABLE symbol_definitions
  ADD COLUMN IF NOT EXISTS summary_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS summary_failed   BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN symbol_definitions.summary_attempts IS
  'Consecutive failed summarisation attempts. Reset to 0 on success. Used to '
  'bound the null-summary re-queue so permanently-unsummarisable symbols are '
  'not retried on every refresh forever.';

COMMENT ON COLUMN symbol_definitions.summary_failed IS
  'TRUE once summary_attempts reached the cap. Terminal: excluded from the '
  're-queue. The symbol still surfaces as `unscored` (no embedding), which is '
  'the honest state — we have no semantic representation of it.';

-- Partial index: the re-queue only ever scans not-yet-terminal rows.
CREATE INDEX IF NOT EXISTS symbol_definitions_summary_retry_idx
  ON symbol_definitions (repo_id)
  WHERE summary_failed = FALSE AND summary_attempts > 0;
