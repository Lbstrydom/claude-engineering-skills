-- ============================================================================
-- upstream_issue_events — a fifth, NON-LIFECYCLE event: `annotation`.
--
-- The log is append-only by trigger and `event` was CHECK'd to the four
-- lifecycle values, so a note stored with a mistake in it had exactly two
-- repairs and both were wrong: UPDATE the append-only row (refused, correctly),
-- or emit a SECOND `fixed` event — corrupting the lifecycle record in order to
-- fix a typo. The case that forced this (2026-08-30): closing report
-- `0f5d87a2`, an unescaped backtick in `--note` ran as shell command
-- substitution and silently elided one sentence from the stored text, and the
-- note had to stand with a hole in it.
--
-- Both existing properties are kept, deliberately:
--   * append-only stays enforced — a correction APPENDS, it never rewrites;
--   * `upstream_issues.state` keeps its four values — an annotation is not a
--     state, so it is not in that enum and cannot advance the lifecycle.
--
-- The JS half of the vocabulary is `scripts/lib/upstream/events.mjs`, and
-- `tests/upstream-issue-triage.test.mjs` pins the two against each other by
-- reading the LAST migration that redefines this constraint — a set declared
-- in two places is a set that drifts.
-- ============================================================================

-- Same constraint NAME as the inline CHECK Postgres auto-named in
-- 20260731120000 (`<table>_<column>_check`), so this is a redefinition of one
-- constraint rather than the accumulation of a second, differently-named one
-- that a later reader would have to reconcile.
ALTER TABLE upstream_issue_events
  DROP CONSTRAINT IF EXISTS upstream_issue_events_event_check;
ALTER TABLE upstream_issue_events
  ADD CONSTRAINT upstream_issue_events_event_check
  CHECK (event IN ('reported', 'acknowledged', 'fixed', 'wont_fix', 'annotation'));

-- An annotation whose whole payload is the note cannot have an empty one — it
-- would be an unremovable row asserting nothing. `note` is nullable for the
-- lifecycle events (an `ack` legitimately carries none), so this is expressed
-- as an implication rather than a NOT NULL on the column.
--
-- Written as `event <> 'annotation' OR (...)` and not as a NULL-sensitive
-- comparison on purpose: `event` is NOT NULL, and `note IS NOT NULL` never
-- evaluates to NULL, so neither operand can make this CHECK pass by
-- evaluating to NULL — the trap that makes a CHECK inert on a nullable column.
ALTER TABLE upstream_issue_events
  DROP CONSTRAINT IF EXISTS chk_upstream_event_annotation_has_note;
ALTER TABLE upstream_issue_events
  ADD CONSTRAINT chk_upstream_event_annotation_has_note
  CHECK (event <> 'annotation' OR (note IS NOT NULL AND btrim(note) <> ''));
