-- bandit_arms: context_bucket can never be NULL or empty (2026-07-18).
--
-- Plan: docs/plans/sibling-path-suppression-defects.md (WS-A).
--
-- THE DEFECT: syncBanditArms wrote `context_bucket: arm.contextBucket || null`
-- while upserting ON CONFLICT (pass_name, variant_id, context_bucket). Postgres
-- treats NULLs as DISTINCT in a unique constraint, so a null-bucket row could
-- never match its own conflict target — every sync would INSERT a duplicate
-- instead of updating. This is the EXACT defect class that produced 403k
-- garbage rows in false_positive_patterns in 3 days and depleted the Supabase
-- Disk IO budget (fixed for that table by 718ca90 +
-- 20260717120000_fp_sync_idempotency.sql). Nobody checked bandit_arms.
--
-- It never fired: PromptBandit normalizes to 'global' twice upstream
-- (bandit.mjs:66, :78), so the `|| null` was unreachable — measured 0 null rows
-- / 0 duplicates / 100% 'global' across 20 rows. The code fix makes the writer
-- agree with its own conflict target; THIS migration makes the invariant
-- unbypassable by a writer that skips the builder (a stale consumer running old
-- synced code, or a future call site). Both, or neither is a real fix.

-- ── Serialize writers across check-then-act ────────────────────────────────
-- The preflights below READ, and the ALTERs later ACT on what they read. A
-- concurrent writer (a stale consumer still running the old `|| null` code) can
-- insert an invalid row in between, and the SET NOT NULL then fails with a raw
-- validation error instead of the guided RAISE — the preflight's whole purpose,
-- defeated by a race it never closed.
--
-- This is NOT the lock-timeout ceremony the plan deliberately rejected: SET NOT
-- NULL takes ACCESS EXCLUSIVE anyway, moments later. Taking it up front costs
-- nothing extra and is what makes check-then-act atomic. The runner wraps each
-- migration in a transaction, so the lock is held for the whole file and
-- released on commit/rollback. On a 20-row table it is sub-millisecond.
LOCK TABLE bandit_arms IN ACCESS EXCLUSIVE MODE;

-- ── Preflight 1: the prerequisite this design rests on ──────────────────────
-- Verified present on the live store during planning:
--   bandit_arms_unique :: UNIQUE (pass_name, variant_id, context_bucket)
-- A consumer whose schema differs must fail with a PRECISE contract error, not
-- a confusing NOT NULL error downstream of an already-broken ON CONFLICT.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'bandit_arms'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (pass_name, variant_id, context_bucket)'
  ) THEN
    RAISE EXCEPTION
      'bandit_arms is missing UNIQUE (pass_name, variant_id, context_bucket) — ON CONFLICT is broken for a DIFFERENT reason; fix the key before this migration';
  END IF;
END $$;

-- ── Preflight 2: refuse rather than destroy ─────────────────────────────────
-- Measured 0 invalid rows here, so this never fires locally. It exists for a
-- drifted consumer.
--
-- It preflights BOTH invalid identities this migration recognizes — NULL *and*
-- '' — not just NULL. Checking only NULL would let a consumer with '' rows pass
-- every preflight, receive the NOT NULL alteration, and then fail on the
-- CHECK below with a raw constraint violation and no guidance: a worse failure
-- than the one the preflight exists to prevent, and asymmetric with the very
-- contract this file establishes.
--
-- Why DELETE is the recovery, and why it is cheap: the LIVE bandit state is
-- LOCAL — PromptBandit loads `.audit/bandit-state.json` (bandit.mjs:57) and
-- never reads this table on the audit path (`loadBanditArms`' only caller is
-- the dashboard's collect-telemetry.mjs). These rows are write-only telemetry
-- snapshots, so deleting them costs dashboard history, NOT learned state — the
-- authoritative posterior is untouched on disk and re-syncs on the next audit.
--
-- A blind `UPDATE ... SET context_bucket = 'global'` is NOT a safe substitute:
-- an invalid row can collide with an existing 'global' row for the same
-- (pass_name, variant_id), and summing/merging the duplicates would double-count
-- (arm.alpha += reward accumulates; the sync writes the full cumulative value
-- with update:'all', so the rows are SNAPSHOTS, not increments).
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM bandit_arms
   WHERE context_bucket IS NULL OR context_bucket = '';
  IF n > 0 THEN
    RAISE EXCEPTION
      'bandit_arms has % row(s) with a NULL or empty context_bucket — cannot apply the identity constraints. These are unattributable telemetry snapshots produced by the sync defect this migration fixes; the live bandit state is local (.audit/bandit-state.json) and is NOT affected, so deleting them costs dashboard history only and it re-syncs on the next audit. Recover with:  DELETE FROM bandit_arms WHERE context_bucket IS NULL OR context_bucket = '''';  then re-run --migrate. (Inspect first if you like:  SELECT pass_name, variant_id, context_bucket, count(*) FROM bandit_arms WHERE context_bucket IS NULL OR context_bucket = '''' GROUP BY 1,2,3;)', n;
  END IF;
END $$;

-- ── The invariant ──────────────────────────────────────────────────────────
ALTER TABLE bandit_arms ALTER COLUMN context_bucket SET DEFAULT 'global';
ALTER TABLE bandit_arms ALTER COLUMN context_bucket SET NOT NULL;

-- NOT NULL alone does NOT match the canonicalization contract: buildBanditArmRows
-- normalizes missing, null AND empty to the sentinel, so a bypassing writer
-- could still insert context_bucket = '' — a DISTINCT unique-key identity even
-- though the application treats empty as absent. That leaves the
-- identity-fragmentation bug alive for one of the explicitly-normalized invalid
-- values. Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard on the catalog
-- to keep this file re-runnable independently of the migration ledger.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'bandit_arms'::regclass AND conname = 'bandit_arms_bucket_nonempty'
  ) THEN
    ALTER TABLE bandit_arms ADD CONSTRAINT bandit_arms_bucket_nonempty
      CHECK (context_bucket <> '');
  END IF;
END $$;
