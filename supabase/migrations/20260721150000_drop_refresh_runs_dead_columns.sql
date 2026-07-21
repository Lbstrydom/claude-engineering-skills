-- refresh_runs: drop six columns that were declared but never earned their keep.
--
-- Sustainability cleanup ("no zombie — either live or remove"). All six were
-- declared at the table's birth (migration 20260501120000) and audited as
-- write-only-or-dead:
--
--   files_added / files_modified / files_deleted / files_renamed /
--   files_untracked  — briefly wired to a writer (recordRefreshDiffStats), but
--     NOTHING ever read them and they duplicate `git diff` (reconstructible from
--     the anchor commit). The only real value — per-run churn visibility — is
--     already delivered live by a `differential churn:` log line at refresh
--     time, so durable storage added nothing. Writer + columns removed together.
--
--   walk_end_commit — the intended HEAD-at-completion anchor for the next
--     incremental run. It was never written, and completing it would be a BUG:
--     end-anchoring drops commits that land mid-run, whereas start-anchoring
--     (walk_start_commit) captures them. No correct use + no consumer.
--
-- Idempotent: DROP COLUMN IF EXISTS so re-application on a partially-migrated
-- DB is a no-op. Data loss is intentional and bounded — every dropped column
-- was empty (schema default) or write-only telemetry nothing consumed.

ALTER TABLE refresh_runs DROP COLUMN IF EXISTS files_added;
ALTER TABLE refresh_runs DROP COLUMN IF EXISTS files_modified;
ALTER TABLE refresh_runs DROP COLUMN IF EXISTS files_deleted;
ALTER TABLE refresh_runs DROP COLUMN IF EXISTS files_renamed;
ALTER TABLE refresh_runs DROP COLUMN IF EXISTS files_untracked;
ALTER TABLE refresh_runs DROP COLUMN IF EXISTS walk_end_commit;
