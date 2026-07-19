-- WS-E / E1 hop 2 — bind an audit verdict to its SUBJECT, not just to a time.
--
-- `AI-Gate: passed` is licensed by `audit_runs.round_converged_after` for a
-- given run id. Until now the run recorded WHEN it happened but never WHAT it
-- read, so the only available cross-check at commit time was timestamp
-- freshness — and freshness cannot distinguish "this commit was audited" from
-- "an audit finished after this commit's timestamp". Concretely: audit a clean
-- tree at commit A, edit files, commit. The marker is newer than HEAD, so the
-- gate reads fresh and `passed` attaches to content that was never audited.
--
-- `audited_tree` is the git tree object id of the WORKTREE the audit actually
-- read (staged into a throwaway index, so it reflects files on disk rather than
-- whatever happened to be in the index). `audited_sha` is HEAD at capture time
-- and is a cheap secondary only — a commit sha alone cannot close the hole,
-- because `ship-commit` validates trailers BEFORE the new commit exists, so
-- HEAD is still the parent and `auditedSha === HEAD` succeeds by construction.
--
-- Both are NULLABLE on purpose. Every historical row predates the capture and
-- must stay unverifiable: the verifier treats a NULL `audited_tree` as
-- "cannot verify" → `not-run`, never as a pass. Backfilling these with a
-- guessed value would retroactively legitimise unbound evidence, which is the
-- precise failure this column exists to prevent. Additive and idempotent.

ALTER TABLE audit_runs
  ADD COLUMN IF NOT EXISTS audited_sha  TEXT,
  ADD COLUMN IF NOT EXISTS audited_tree TEXT;

COMMENT ON COLUMN audit_runs.audited_sha IS
  'HEAD commit sha at audit-target capture time (E1). Cheap secondary check only — cannot close the false-pass hole alone, since trailer validation runs before the new commit exists. NULL on pre-2026-07-19 rows.';

COMMENT ON COLUMN audit_runs.audited_tree IS
  'Git tree object id of the worktree the audit read (E1). The primary subject identity: `AI-Gate: passed` requires the tree being committed to equal this. NULL means unverifiable → not-run, never a pass.';

-- Verdict-with-subject lookup: the verifier reads (id) and needs the tree +
-- convergence together. Partial — only rows that actually carry an identity are
-- ever verifiable, so unbound historical rows cost nothing to keep out.
CREATE INDEX IF NOT EXISTS audit_runs_audited_tree_idx
  ON audit_runs (audited_tree)
  WHERE audited_tree IS NOT NULL;
