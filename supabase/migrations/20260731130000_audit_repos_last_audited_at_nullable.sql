-- ── audit_repos.last_audited_at: NULL means "never audited" ─────────────────
--
-- `resolveRepoForStore()` guards the UPDATE branch so that a profile-less call
-- (a pure id lookup from a cross-skill read, /ship, persona-test, …) does NOT
-- bump `last_audited_at` — otherwise "last audited" degrades into "last
-- touched" on every read. The sibling INSERT branch could not honour that
-- guard, because this column was declared
--
--   last_audited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
--
-- (20260330063355_learning_store.sql:15). Omitting the column on INSERT was
-- therefore INDISTINGUISHABLE from stamping it: `DEFAULT NOW()` writes exactly
-- the value the code was trying not to write. So the very first read-only
-- command to auto-vivify a repo row stamped that repo as audited when nothing
-- had been audited — and the same is true of every `upsertRepoByUuid` caller
-- (`arch:refresh`, `security:refresh`, azure-doctor, cross-skill), none of
-- which run an audit either.
--
-- Dropping BOTH the NOT NULL and the DEFAULT is what makes omission
-- expressible. Dropping only the NOT NULL would leave the default in place and
-- change nothing observable — the half-fix this migration exists to complete.
--
-- NULL is the honest value for "this row exists because something looked the
-- repo up, and no audit has been recorded against it yet" — the same
-- convention as `audit_repos.band_calibration` (20260720200000), where NULL
-- means uncalibrated rather than a borrowed guess.
--
-- EXISTING ROWS ARE LEFT ALONE. A backfill cannot separate a genuinely-audited
-- row from a read-vivified one: both carry a plausible timestamp and there is
-- no surviving evidence of which write produced it. Nulling everything would
-- destroy real history to remove unreal history; nulling a heuristic subset
-- would guess. Only forward behaviour changes, so any row created before this
-- migration keeps whatever it had, and the column's meaning is exact only for
-- rows created after it.
--
-- Reader audit (done before making it nullable — no reader treats it as
-- non-null): `scripts/check-sync.mjs:90` already prints
-- `last_audited_at || 'never'`; `scripts/phase7-check.mjs:53` selects the
-- column but only reads `name`. No view, RPC or dashboard query references it.
--
-- Idempotent: DROP NOT NULL / DROP DEFAULT on an already-relaxed column are
-- no-ops, so this reconciles cleanly with a hand-patched DB.

ALTER TABLE audit_repos ALTER COLUMN last_audited_at DROP NOT NULL;
ALTER TABLE audit_repos ALTER COLUMN last_audited_at DROP DEFAULT;

COMMENT ON COLUMN audit_repos.last_audited_at IS
  'When an AUDIT last ran against this repo. NULL = never audited — a row may '
  'exist purely because a read-only lookup (cross-skill read, arch:refresh, '
  '/ship) vivified it. Written only by a profile-bearing resolveRepoForStore() '
  'call; never by upsertRepoByUuid(). Rows predating migration '
  '20260731130000 may carry a read-vivified timestamp (not backfillable).';
