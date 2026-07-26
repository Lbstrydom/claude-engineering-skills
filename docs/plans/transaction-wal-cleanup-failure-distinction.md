# Plan: Distinguish "nothing to clean up" from "cleanup failed" in the install WAL

- **Date**: 2026-07-26
- **Status**: Complete
- **Author**: Claude + Lbstrydom
- **Scope**: backend
- **Target domain(s)**: `install` (`compute-target-domains`: `{"domains":["install"],"crossDomain":false}`)

## 1. Context Summary

**Detected scope**: backend. **Stack**: js-ts.

**What exists today**: `scripts/lib/install/transaction.mjs` (900 lines) is a
crash-safe write-ahead-log (WAL) transaction system backing
`install.mjs`/`setup.mjs`'s skill installer. `executeTransaction()` snapshots
target files, journals the intended writes/deletes, stages them to `.tmp`
paths, atomically renames them into place, then deletes; a crash at any
point is recoverable via `recoverFromJournal()` at the next install's
startup, which either rolls forward completed-but-uncommitted renames or
discards orphaned `.tmp` staging files, depending on which `stage` the
journal recorded.

**The bug cluster**: 9 tech-debt-ledger entries (`0b7661a0`, `22bb5573`,
`6e6e7f3c`, `725c8fff`, `9ffef897`, `aea521d8`, `c0f85a8c`, `cea63575`,
`ee735643`), all one root cause: **best-effort cleanup/recovery/rollback
catches don't distinguish "nothing to clean up" from "cleanup failed."**
Four sub-patterns, each source-verified against current code (see Code
Trace below), each independently confirmed by two separate audit
sub-agents in a prior triage pass (`docs/plans/refactor-install-wal-vcs-2026-07.md`).

**Code Trace**:
1. **Temp-journal leak on rename-retry-exhaustion** — `writeJournal()`
   (`transaction.mjs:467-503`) wraps its `.tmp` write in a try/catch/finally
   (`transaction.mjs:475-494`) that cleans up `tmp` on failure — but the
   final step, `retrySync(() => fs.renameSync(tmp, journalPath))`
   (`transaction.mjs:496`), sits **outside** that block. An exhausted-retry
   throw here leaks the temp journal file.
2. **Null-snapshot silently un-rolled-back** — Phase 1 of
   `executeTransaction()` (`transaction.mjs:636-643`) snapshots each target:
   `snapshots.set(w.absPath, fs.readFileSync(w.absPath))` on success, or
   `snapshots.set(w.absPath, null)` if the read itself throws (a sentinel
   distinct from `undefined` = "no prior file"). `rollbackPartialTransaction()`
   (`transaction.mjs:720-740`) branches on `snapshot === undefined` (delete
   the new file) and `snapshot !== null` (restore the content) — **no
   branch for `snapshot === null`**. That case falls through with zero
   action: the post-transaction content stays in place while the function's
   entire purpose is reverting to pre-transaction state.
   **Structural finding (round-1 plan-audit H1, verified against source):**
   the `snapshots` Map is **never persisted to the journal** —
   `journalBody()` (`transaction.mjs:505-517`) only records `staged`
   (absPath/tmpPath pairs) and `deletes`, never snapshot content. So
   "retain the journal and let a future recovery pass restore it" — this
   plan's original remedy for sub-pattern 2 — is not just incomplete, it's
   **structurally impossible**: `recoverFromJournal()` never calls
   `rollbackPartialTransaction()` at all (confirmed: neither of its two
   `stage` branches, lines 842-871, references it) and has no snapshot data
   to restore from even if it did. Rollback-to-prior-content only ever
   happens synchronously, in-process, inside `executeTransaction()`'s own
   catch block, using the in-memory Map from that single invocation. A null
   snapshot is therefore unrecoverable **by construction**, not by a gap in
   the rollback logic — see the revised fix in §2.
3. **`fsyncDir` not called after deletes** — Phase 3's rename loop
   (`transaction.mjs:672-677`) calls `fsyncDir(path.dirname(absPath), ...)`
   after every rename for directory-entry durability. `attemptDelete()`
   (`transaction.mjs:526-545`) calls `retrySync(() => fs.unlinkSync(d.absPath))`
   (line 541) with no matching `fsyncDir` call.
4. **`cleanupJournal()` runs unconditionally after failed
   recovery/rollback** — two call sites, both discarding the WAL after an
   operation whose success was never actually confirmed:
   - `recoverFromJournal()`'s `stage === 'renaming'` branch
     (`transaction.mjs:842-863`) logs (not tracks) a failed
     `retrySync(() => fs.renameSync(tmpPath, absPath))` per-file
     (line 852-856); the **sibling** `else` branch (`stage === 'staged'`,
     lines 864-871, discarding orphaned `.tmp` files) has the identical
     shape — `try { retrySync(...) } catch { /* best effort */ }` with no
     tracking. **Both branches share one unconditional
     `cleanupJournal(journalPath)` at line 873** — this plan's scope covers
     both, not only the roll-forward branch the ledger topicId names.
   - `executeTransaction()`'s catch block, `staging`/`staged`/`renaming`
     case (`transaction.mjs:704-707`): `rollbackPartialTransaction()` then
     immediately `cleanupJournal(journalPath)` — but
     `rollbackPartialTransaction()` swallows all per-path errors internally
     (`transaction.mjs:736-738`, `process.stderr.write` only) and returns no
     success/failure signal at all.

   **Correction (round-1 plan-audit H4, verified against source) — a
   THIRD, previously-uncited call site has the identical bug**: this
   plan's first draft claimed the normal-completion `cleanupJournal()`
   call (`transaction.mjs:690`) was unaffected, reasoning that reaching it
   means every preceding step succeeded. That reasoning is wrong.
   `attemptDelete()` (`transaction.mjs:526-545`) **never throws** on a
   delete failure — it catches internally and returns `{deleted: false,
   skipped: {absPath, reason: 'DELETE_FAILED: ...'}}`. Phase 4's loop
   (`transaction.mjs:684-688`) accumulates these into `skippedDeletes` but
   the very next line, 690, calls `cleanupJournal()` unconditionally and
   returns `{success: true, ...}` regardless of how many deletes failed —
   discarding the journal that would have let a future run retry them.
   None of the 9 original ledger topicIds cite this location (they're all
   about the rollback/recovery paths), but it's the exact same root cause
   in the exact same file this plan is already touching for sub-pattern 3
   — see the revised fix in §2, which now covers **three** `cleanupJournal()`
   call sites, not two. `attemptDelete()`'s OTHER skip reason,
   `CONFLICT_DELETION_SKIPPED` (line 536 — the target was user-modified
   since the last install), is a deliberate, complete outcome, not a
   failure — the fix below distinguishes the two by matching on the
   `reason` string's prefix, never conflating "worked as designed" with
   "didn't work."

**Neighbourhood considered** (`get-neighbourhood`): top match is
`rollbackPartialTransaction` itself (`transaction.mjs:720-740`,
`recommendation: precedent`, `bandReason: above-floor-cluster`, similarity
0.73) — confirms this is an **extend existing code** case: every function
this plan touches (`writeJournal`, `rollbackPartialTransaction`,
`cleanupJournal`, `attemptDelete`, the roll-forward/discard loops in
`recoverFromJournal`) already lives in `transaction.mjs`; no new module.
49 other candidates scored `review` (below floor), including
`scripts/lib/file-io.mjs::atomicWriteFileSyncImpl` (a generic
temp+rename+fsync helper) — not reused: `transaction.mjs`'s own
degradation-tracking, critical-vs-non-critical fsync distinction is more
specialised than the generic helper, and swapping it in is a larger,
unrelated refactor this plan's 9 ledger entries don't ask for.

**Security-incident neighbourhood** consulted: 2 candidates (INC-001
symlink-path-classification, INC-002 destructive-test-DSN), both low
composite score (~0.51), no path overlap — neither applies. This change
alters failure/degradation reporting inside an already-repo-contained WAL;
no new external trust boundary, no credentials.

## 2. Proposed Architecture

```mermaid
sequenceDiagram
    participant MAIN as install-skills.mjs main()
    participant EX as executeTransaction()
    participant WJ as writeJournal()
    participant RB as rollbackPartialTransaction()
    participant CJ as cleanupJournal()
    participant REC as reconcileJournals()

    Note over MAIN,REC: Startup recovery (Sub-pattern 4a, now covers BOTH recoverFromJournal() branches + delete-replay + idempotent discard)
    MAIN->>REC: reconcileJournals(repoRoot)
    REC->>REC: recoverFromJournal() -- checks stage === 'rollback-failed' FIRST (refuse, no fs action);<br/>else roll-forward (renames + delete-replay) OR discard orphaned .tmp (ENOENT-as-success)
    REC-->>REC: failures: [...] -- NEW: tracked across rename+delete-replay, and staged-discard (non-ENOENT only)
    REC->>CJ: cleanupJournal(path, 'recovery') -- NEW: only when zero failures; context arg (Gemini G2) keeps the failure log accurate per call site
    Note over MAIN: NEW: reconcileJournals() calls process.exit(1) on<br/>non-empty failures, mirroring its EXISTING rec.error<br/>exit path -- main() never reaches executeTransaction()<br/>on top of unresolved WAL state

    Note over EX,WJ: Phase 1 snapshot -- NEW precondition (Sub-pattern 2, revised)
    EX->>EX: for each existing target: readFileSync -- ENOENT: treat as absent (undefined)<br/>non-ENOENT (EACCES etc.): re-throw BEFORE any write/journal/stage/rename/delete
    Note over EX: A null snapshot can no longer reach rollbackPartialTransaction() --<br/>prevented at the source, not patched at rollback time

    Note over EX,MAIN: Normal completion -- NEW gate (Sub-pattern 4c, newly discovered, kind-based round-4)
    EX->>WJ: journal + stage writes + rename
    EX->>EX: Phase 4 deletes -- attemptDelete() never throws, returns a discriminated {kind, ...} result
    EX->>CJ: cleanupJournal(path, 'success') -- NEW: only when no kind:'delete-failed' entries<br/>('conflict-skipped' is a complete, non-failure outcome)
    MAIN->>MAIN: NEW (round-4 H4): a kind:'delete-failed' entry prints an explicit<br/>message and sets a non-zero exit code -- success:true never reads as unqualified-clean

    Note over EX,WJ: Failure during staging/staged/renaming (Sub-pattern 4b, revised round-3 H1, then round-4 H1)
    EX->>RB: rollbackPartialTransaction(writtenPaths, snapshots, staged)
    RB-->>EX: failures: [...] -- NEW: per-path outcome, not void<br/>(ENOENT treated as success -- Gemini G1)
    alt failures.length === 0 (rollback fully succeeded)
        EX->>CJ: cleanupJournal(path, 'rollback') -- context arg (Gemini G2) so a<br/>cleanup failure here, and ONLY here, logs "rollback completed"
    else failures.length > 0
        EX->>WJ: writeJournal(journalBody('rollback-failed', ...)) -- NOT cleanupJournal(), NOT quarantineJournal():<br/>stays at its original path (pre-flight check keeps blocking future installs)<br/>but its stage no longer reads 'renaming', so recoverFromJournal() can never<br/>mistake it for a safe roll-forward candidate, and never silently unblocks new work
    end
```

**Design**: each of the 4 sub-patterns gets the smallest fix that closes
its ledger entries, reusing this file's own existing conventions rather
than introducing new ones. Revised after round-1 plan-audit (H1-H4, M1 —
see the Code Trace corrections above):

1. **Journal-rename cleanup** (principle #11 Error Handling): move
   `retrySync(() => fs.renameSync(tmp, journalPath))` inside a
   try/catch that mirrors the existing tmp-cleanup block above it —
   on failure, unlink `tmp` (best-effort, matching the existing
   `cleanupErr` logging pattern at line 488-490) before re-throwing.
2. **Snapshot-failure precondition, REVISED from "log + retain" to
   "abort before any mutation"** (principle #11, #13 Transaction Safety —
   round-1 finding H1, tightened by round-3 finding M1): the original
   design added a `snapshot === null` branch to
   `rollbackPartialTransaction()` and retained the journal for a "future
   recovery." That is unsound — per the Code Trace correction above, no
   recovery path can ever restore uncaptured content, so retaining the
   journal buys nothing for this specific failure (no recovery path can
   restore content that was never captured anywhere durable). The fix
   moves upstream, and **removes the `fs.existsSync()` probe entirely**
   rather than layering error-classification on top of it (round-3 M1:
   `existsSync()` collapses stat/access failures — e.g. a permission
   error on the containing directory — into a bare `false`, so some
   non-ENOENT "I can't tell if this file exists" states would still be
   silently treated as "no prior file" and never reach the classifier;
   it's also a TOCTOU race against a target that changes between the
   probe and the read). Phase 1's snapshot loop (`transaction.mjs:636-643`)
   becomes a single classified read per target — no existence check
   first: `try { snapshots.set(w.absPath, fs.readFileSync(w.absPath)); }
   catch (err) { if (err.code === 'ENOENT') snapshots.set(w.absPath,
   undefined); else throw err; }` — and **re-throws** every non-ENOENT
   error, before `writeJournal()`, staging, renaming, or deleting
   anything. At that point `stage` is still `'not-started'`, so
   `executeTransaction()`'s EXISTING catch-block dispatch
   (`transaction.mjs:697-701`) already handles it correctly —
   `cleanupJournal()` on a journal that was never written is a safe no-op
   per `cleanupJournal()`'s own `existsSync` guard. **Net effect: the
   `snapshot === null` value can never be constructed at all**, so
   `rollbackPartialTransaction()` needs no new branch for it — this
   sub-pattern's fix got simpler under review, not larger. This still
   fully closes ledger entries `6e6e7f3c`/`725c8fff`: their symptom
   ("falls through untouched") is eliminated by prevention rather than
   by a rollback-time patch, which is the more correct fix location.
3. **`fsyncDir` after delete, with an explicit contract** (principle #11 —
   revised after round-2 finding H1, which correctly flagged that the
   original one-line description left the failure boundary undefined).
   `fsyncDir(dirPath, what, {critical})` (`transaction.mjs:162-179`)
   **never throws in non-critical mode** — it returns `{ok: true}` or
   `{ok: false, degraded: {code, what}}`, exactly like Phase 3's rename
   loop already consumes it (`transaction.mjs:675-676`:
   `const d = fsyncDir(...); if (!d.ok) degradations.push(d.degraded);`).
   `attemptDelete()`'s new call uses this SAME non-critical, non-throwing
   form and pushes any degradation to the transaction's existing
   `degradations` array — **never** to `skippedDeletes`. This resolves
   the ambiguity by construction, not by a new branch: a post-unlink
   fsync failure can never be misclassified as `DELETE_FAILED` because
   the unlink itself already completed and returned `{deleted: true}`
   before `fsyncDir` is even called; the fsync outcome is durability
   telemetry about an already-successful delete, not a delete-outcome
   value. **Return-shape correction (round-3 finding H2, then round-4
   finding M1 — two rounds converging on the same interface)**: round-3
   H2 established that `degradations` is owned by `executeTransaction()`,
   not `attemptDelete()`, so the fsync outcome needs a new field on
   `attemptDelete()`'s return value (a caller-owned mutable array threaded
   into the function was rejected — a hidden side channel, not an
   explicit contract). Round-4 M1 then found the natural next step
   necessary anyway: gating `cleanupJournal()` on
   `reason.startsWith('DELETE_FAILED')` (round-1's original fix) parses a
   human-readable diagnostic string as control flow — any future wording
   change or wrapped-OS-error message silently changes cleanup behavior,
   and the SAME parsing would have to be duplicated correctly in both the
   normal-completion loop and recovery's delete-replay (round-4 H2) to
   stay consistent. **Combined fix**: `attemptDelete()`'s return becomes a
   real discriminated result instead of `{deleted, skipped?}` boolean-ish
   shape:
   ```
   { kind: 'deleted', degradation? }       // unlinked; degradation iff post-unlink fsyncDir failed
   { kind: 'absent' }                       // target didn't exist — nothing to do (today's silent {deleted:false} case)
   { kind: 'conflict-skipped', reason }     // expectedSha mismatch — intentional, complete (today's CONFLICT_DELETION_SKIPPED)
   { kind: 'delete-failed', reason }        // unlink threw — operational failure (today's DELETE_FAILED)
   ```
   `degradation` is the SAME `{code, what}` shape `fsyncDir`'s own
   `{ok:false, degraded}` already produces, just forwarded, not
   transformed; `reason` keeps today's human-readable diagnostic text but
   is now PURELY for operator display — no code branches on its content
   anywhere in the file after this change. Every call site switches on
   `kind` (an enum, not a string prefix): the caller
   (`executeTransaction()`'s Phase 4 loop AND `recoverFromJournal()`'s
   roll-forward-branch delete replay, `transaction.mjs:684-688` and
   `:860-863` respectively — `attemptDelete()` is called from both)
   checks `if (r.degradation) degradations.push(r.degradation)` for the
   fsync channel, and `kind === 'delete-failed'` (not a string match) for
   the cleanup-gating / recovery-failure-list channel. `skippedDeletes`
   (the existing operator-facing report array both `install-skills.mjs`
   and `recoverFromJournal()` populate) keeps accumulating
   `{absPath, reason}` for `conflict-skipped` and `delete-failed` kinds —
   its own shape is unchanged; only the internal branching that decides
   WHICH kind produced an entry stops parsing `reason` text to do it.
4. **Conditional `cleanupJournal()` — three call sites, not two**
   (principle #11, #13 — round-1 findings H4, M1 expanded scope): all
   three sites (recovery's shared line 873, the rollback catch-block's
   line 706, **and** the newly-found normal-completion line 690) gate on
   an explicit success predicate rather than "no throw occurred":
   - **Recovery** (`recoverFromJournal()`) — **expanded, round-4 findings
     H2 + H3 (both genuine gaps in the round-3 design, not new scope)**:
     the roll-forward branch's rename loop and the `staged`-discard branch
     each accumulate their own failure lists from their per-path `catch`
     (currently only `process.stderr.write`). Two corrections to that:
     - **H2 — the roll-forward branch's delete-replay was never wired
       in.** That branch also calls `attemptDelete()` for every
       `journal.deletes` entry (`transaction.mjs:860-863`) — and
       `attemptDelete()` never throws, so a real unlink failure there was
       invisible to a `catch`-based failure list, exactly the H4(round-1)
       bug recurring in this second call site. Fixed together with M1
       below: `attemptDelete()` becomes a discriminated result (see the
       File-Level Plan `attemptDelete()` bullet), and this loop pushes a
       `kind: 'delete-failed'` entry into the SAME failure list the
       rename loop populates — one aggregate, not two.
     - **H3 — the `staged`-discard loop's retry was not idempotent.** A
       plain "catch and push" for the orphaned-`.tmp` unlink means a
       SECOND recovery attempt sees `ENOENT` for a tmp file the FIRST
       attempt already deleted, and (under "accumulate every catch")
       miscounts that as a new failure — a transient single-file failure
       could then block recovery forever, even after everything is
       actually clean. Fixed: `ENOENT` from the discard `unlinkSync` is
       treated as success (already gone — converged), not a failure; only
       a non-`ENOENT` unlink error is pushed to the failure list.
     `cleanupJournal()` runs only when BOTH loops' complete failure lists
     (now correctly including delete-replay failures) are empty.
   - **Rollback** (`executeTransaction()`'s catch block) — **REVISED
     AGAIN, round-4 finding H1 (round-3's quarantine fix reopened, for a
     different reason than round-3's own H1 fixed)**: quarantining moves
     the journal out of the path any future `recoverFromJournal()` OR
     the pre-flight `existsSync(journalPath)` check
     (`transaction.mjs:622-624`) ever reads — which is exactly the
     behavior that made it wrong here: a rollback-failure journal
     describes a VALID, partially-resolved transaction (parses fine,
     passes containment), unlike a corrupt/invalid/foreign journal that
     genuinely cannot be trusted. Quarantining it silently **unblocks**
     future installs over a filesystem left in a mixed pre-/post-
     transaction state, with no persisted before-images to ever recover
     the original bytes — worse than round-3's bug (wrong-direction
     roll-forward), not better. **Fix: retain the journal on disk (so the
     pre-flight check keeps blocking future installs — the WAL's basic
     fail-safe), but mark it as unsafe for automatic action** so
     `recoverFromJournal()` never takes it down the roll-forward path
     either. This needs exactly one new `stage` value —
     `'rollback-failed'` — added to the existing `JournalSchema` enum
     (`transaction.mjs:347`, currently `z.enum(['staged', 'renaming'])`),
     written via the SAME `writeJournal`/`journalBody` machinery every
     other stage transition already uses — no new persistence mechanism.
     **Write-ordering correction (round-5 finding H1 — a genuine, narrow
     reopen of THIS fix)**: writing the marker AFTER calling
     `rollbackPartialTransaction()` (the original round-4 design) has a
     gap — if that post-rollback marker write itself fails (disk full,
     permission error), the on-disk journal is left at whatever stage it
     last durably held, which is `'renaming'` (written by Phase 2, before
     Phase 3 even starts) — recreating the exact wrong-direction-recovery
     bug the marker exists to prevent, just gated on a second failure
     instead of the first. **Fix: write the `'rollback-failed'` marker
     FIRST, before calling `rollbackPartialTransaction()`**, wrapped in
     its own best-effort `try/catch` (matching this file's pervasive
     convention for non-critical journal operations — `cleanupJournal()`,
     `quarantineJournal()` — never a NEW fragility pattern). If the marker
     write succeeds (the overwhelmingly common case — the marker is one
     small JSON write, identical in kind to the `'renaming'`-stage write
     that ALSO just succeeded moments earlier), the journal is safe from
     the wrong-direction bug for the ENTIRE duration of the rollback
     attempt, not just after it: `rollbackPartialTransaction()` then runs;
     on full success, `cleanupJournal()` removes the marker+journal as
     today; on partial failure, nothing further needs writing — the
     marker is already there. **Simplified (round-6 finding H1 — this is
     a REMOVAL, not new machinery)**: round-5's design still called
     `rollbackPartialTransaction()` even when the marker pre-write itself
     failed ("attempting recovery is still better than not"), reasoning
     that turned out to be backwards — GPT correctly traced that
     proceeding with rollback MUTATIONS while the safety marker is absent
     recreates the exact split-brain state (some files restored, journal
     still reads `'renaming'`) the marker exists to prevent, on the first
     failure, not a rare compound one. The corrected, SIMPLER rule: **if
     the marker pre-write fails, do not call
     `rollbackPartialTransaction()` at all.** Return `fail()` immediately
     and leave the journal exactly as it durably stood before entering
     this catch block (`stage: 'renaming'`, unmodified). This is actually
     SAFE, not merely "the best we can do": since no rollback mutation was
     ever attempted, the filesystem is still in its plain
     partially-renamed Phase-3 state — which is precisely what the
     EXISTING `stage === 'renaming'` roll-forward branch already handles
     correctly (complete the remaining renames, replay the deletes). A
     future recovery pass rolling that state FORWARD is the right outcome
     here, not a residual risk to accept — rollback was never attempted,
     so there is nothing to roll "the wrong direction" away from. This
     removes a code path (the try-rollback-anyway fallback) rather than
     adding one, and eliminates round-5's named residual entirely instead
     of merely narrowing it. `recoverFromJournal()` gains one new branch, checked
     before the existing `stage === 'renaming'` roll-forward branch:
     `journal.stage === 'rollback-failed'` → refuse automatic action and
     return an explicit error (mirroring the foreign-journal error/block
     shape at `transaction.mjs:822-829`, but WITHOUT quarantining — the
     journal stays exactly where it is, so the pre-flight check keeps
     blocking until a human resolves it). This is deliberately NOT durable
     rollback (no persisted before-images, no automated restore of the
     original bytes — GPT's round-3/round-5 recommendation, and still the
     over-engineered end for this plan's actual scope; see Right-sizing
     below): it only guarantees the two invariants this plan's 9 ledger
     entries actually require — never silently lose the record, never let
     an unresolved transaction be silently completed or overwritten by
     mistake. When `rollbackPartialTransaction()`'s failure array is empty
     (the common case — rollback fully succeeded), the marker (already
     written, per the ordering fix above) is removed by the SAME
     `cleanupJournal()` call that runs today — no `'rollback-failed'`
     stage survives on disk past a fully successful rollback.
   - **Normal completion** (`executeTransaction()`'s success path) — this
     retention case is still NOT reopened by round-4's H1 (different
     mechanism, traced separately): `cleanupJournal()` runs only when
     `skippedDeletes` contains no `kind: 'delete-failed'` entries (see the
     `attemptDelete()` discriminated-result bullet below — round-4 M1
     replaces the earlier `DELETE_FAILED`-string-prefix match with a real
     discriminant) — `kind: 'conflict-skipped'` entries do **not** block
     cleanup (that outcome is complete and intentional by the module's own
     design, not a failure to retry). This retention IS safe to
     roll-forward, unlike the rollback case: Phase 4 runs only after
     `stage = 'renamed'`/`'deleting'` — i.e. strictly after the SAME
     `journalBody('renaming', ...)` write — so a retained journal here
     also reads `stage: 'renaming'` on disk, and recovery's existing
     roll-forward branch **already replays `journal.deletes` itself**
     (`transaction.mjs:860-863`, confirmed via direct read) using the same
     `attemptDelete()` — including its `expectedSha` conflict check — so a
     retried delete on the next install run is the CORRECT completion of
     this transaction, not an unwanted one. No new journal stage needed
     for this case; plain retention already does the right thing. **New
     (round-4 finding H4)**: `executeTransaction()`'s return still reports
     `success: true` for this case (the writes/renames genuinely did
     succeed — a delete retry is a real but separate pending action), but
     the CALLER must not present that as an unqualified clean result.
     `install-skills.mjs`'s `main()` (`install-skills.mjs:512-526`, which
     already prints every `skippedDeletes` entry generically) gains one
     check on that same loop: any entry with `kind: 'delete-failed'`
     prints an explicit "journal retained — the next install will block
     until this is resolved" message and sets a non-zero exit code before
     `process.exit()` — reusing the exact convention
     `reconcileJournals()` already uses for recovery failures
     (`install-skills.mjs:184-197`), not a new outcome taxonomy. This is
     narrower than GPT's own recommendation (a full `completed` /
     `completed-with-intentional-conflicts` / `recovery-required` state
     enum traced through every caller) — deliberately: `main()` is the
     ONLY caller of `executeTransaction()` in this codebase (confirmed via
     `grep`), so a multi-state enum threaded through "every caller" has
     exactly one caller to thread through, and a boolean-ish exit-code
     check on the one field that already exists (`kind`) satisfies the
     actual requirement (never a misleadingly clean signal) without
     inventing new result-shape vocabulary nothing else in this file uses.

   In every case, a non-empty failure list means: **do not delete the
   journal**; log the failures to stderr (matching this file's existing
   `process.stderr.write` convention); return them in the function's
   result object so a caller can act on them programmatically, not only
   read stderr. Leaving the journal is not a degraded fallback — it is
   the WAL's entire reason to exist: a future recovery pass gets another
   chance. **Round-1 finding H3 — the caller must act on this**:
   `install-skills.mjs::reconcileJournals()` (the sole caller of
   `recoverFromJournal()`) currently ignores its return value entirely.
   It gains the same `process.exit(1)` it already uses for `rec.error`
   (`install-skills.mjs:184-197`, an established pattern in this exact
   function) when the new failure list is non-empty — `main()` must never
   reach `executeTransaction()` on top of a WAL recovery known to be
   incomplete.

### Right-sizing (Gate 1 — new abstraction introduced: a failure-tracking return shape)
- **Band-aid**: `try { ... } catch { /* swallow, same as today */ }` around
  the 4 spots but leave `cleanupJournal()` unconditional — resolves nothing;
  the whole point of all 9 entries is that the *unconditional* cleanup is
  the bug, not the individual catches.
- **Over-engineered**: a generic `Result<T, E>`-style wrapper type,
  a pluggable recovery-strategy interface, a formal per-journal-entry
  idempotent state machine with content-hash postcondition verification
  (round-1 finding H2's suggested direction — considered and rejected
  below), or promoting per-path failure tracking into a new class/module
  shared across the whole file. Nothing here needs polymorphism or reuse
  outside `transaction.mjs`'s own call sites; a new abstraction layer
  would outlive any actual requirement.
- **Chosen**: plain arrays of `{absPath, reason}` objects, matching the
  `skippedDeletes: Array<{absPath, reason}>` shape `attemptDelete()`'s
  caller already accumulates (`transaction.mjs:684-688`) — literally the
  same shape, reused, not invented. `rollbackPartialTransaction()`, the
  two `recoverFromJournal()` branches, and Phase 4's delete loop
  return/populate one, and all 3 `cleanupJournal()` call sites gate on
  `failures.length === 0`.
- **On H2 specifically (declined, with reasoning — not silently
  dropped)**: round-1 raised whether the `existsSync(tmpPath)`-based
  "already done" check is genuinely idempotent across repeated recovery
  attempts, without content-hash postcondition verification. Traced: the
  on-disk journal's `stage` field only advances to `'renaming'`
  (`journalBody('renaming', ...)`, `transaction.mjs:668`) **after** Phase 2
  (staging) fully completes for every write — so by the time
  `recoverFromJournal()`'s roll-forward branch runs, every entry in
  `journal.staged` is guaranteed to have had a real `.tmp` file created.
  A missing `.tmp` file at recovery time therefore unambiguously means
  "already renamed" (by the original process's partial progress, or a
  prior recovery attempt), never "never happened" — the existing
  `existsSync` guard is not ambiguous for this code path, and repeated
  recovery attempts already converge without content-hash verification.
  Adding one would be solving a problem this specific state machine
  doesn't have, for the cost of a journal-schema version bump and
  migration handling for in-flight journals. Sent to GPT deliberation
  (round-1 rebuttal) rather than silently declined — see the plan's audit
  trail.
- **On rollback-failure retention specifically (round-3 H1, then
  reopened again by round-4 H1 — two genuine reopens, not rigor
  pressure, converging on the actual right-sized middle)**: round-3
  traced and confirmed that plain retention would make a future recovery
  run roll the transaction **forward** instead of back — actively worse
  than the original unconditional-cleanup bug. Round-3's first fix
  (reusing `quarantineJournal()`) solved THAT but introduced a new
  problem round-4 caught: quarantining also removes the journal from the
  pre-flight block, silently letting a NEW install proceed over a
  filesystem left in a mixed pre-/post-transaction state. Both rounds'
  findings are real; the fix needed to satisfy both simultaneously.
  **Band-aid**: keep unconditionally cleaning up on any rollback failure
  (the pre-plan behavior) — reopens the original 9-entry bug class this
  plan exists to close; rejected. **Over-engineered**: GPT's own H1
  recommendation (round 3 AND round 4, restated each time) — a durable,
  fsynced before-image/backup file per write target, plus a dedicated
  recovery branch that actually RESTORES it. This is a real, general
  "durable rollback" feature, and it is exactly the scope the EARLIER,
  broader WAL-durability plan attempt grew into before being abandoned as
  over-scoped (see this plan's own narrower framing relative to that
  history) — no CURRENT requirement in this plan's 9 ledger entries calls
  for surviving a crash *during rollback itself* with full content
  recovery; the requirement is only "don't leave a misleading state;
  don't get automatically completed OR silently unblocked by mistake."
  **Chosen**: retain the journal on disk (so the pre-flight check keeps
  blocking, unlike quarantine) but mark it with a new `stage:
  'rollback-failed'` value so `recoverFromJournal()` refuses to act on it
  automatically (unlike plain `'renaming'`-stage retention). This is
  smaller than quarantine's own machinery would suggest — one new enum
  literal, one extra `writeJournal()` call reusing the existing
  journal-write function, one new `if` branch in `recoverFromJournal()`
  that returns an error without touching the filesystem — and smaller
  still than the durable-before-image design: it adds no new persisted
  content, no backup files, no restore capability. It satisfies exactly
  the two invariants both rounds' findings actually require (never
  silently lose the record; never let an unresolved transaction be
  silently completed OR silently unblocked) without building either the
  general durable-rollback feature or misapplying the corrupt-journal
  quarantine semantics to a structurally different situation (a VALID,
  partially-resolved transaction is not the same category as a journal
  that cannot be trusted at all).
- **On the marker's write-ordering specifically (round-5 finding H1)**:
  writing `'rollback-failed'` after rollback (round-4's original design)
  leaves a gap if that write itself fails. **Band-aid**: ignore the gap —
  it was already smaller than round-3's and round-4's own bugs; rejected,
  because the whole point of this finding chain is closing exactly this
  class of gap, not leaving the smallest remaining one unaddressed for no
  reason when the fix is cheap. **Over-engineered**: GPT's own round-5
  recommendation — a durable two-stage transition (`rollback-pending`
  written BEFORE any rollback mutation, `rollback-failed` only after) with
  explicit handling for the second write ALSO failing. This adds a SECOND
  new enum literal and a second recovery branch for a distinction
  (pending-and-about-to-try vs failed-and-done-trying) that doesn't change
  what `recoverFromJournal()` DOES with either state — both must refuse
  automatic action identically. **Chosen**: reorder the existing single
  write to happen BEFORE `rollbackPartialTransaction()` instead of after,
  wrapped in a best-effort `try/catch` matching the file's own convention
  for non-critical journal operations. This closes the gap for the
  overwhelmingly common case (the write succeeds — it is the same kind of
  small JSON write that just succeeded moments earlier for the
  `'renaming'` transition) with a ONE-LINE reordering, not a new stage
  value. **Correction (round-6 finding H1 — the residual named here was
  itself avoidable, not merely small)**: this entry originally accepted a
  "marker-write AND rollback-restore both fail" residual by having
  rollback proceed even after a failed marker pre-write. GPT correctly
  traced that this reasoning was backwards: proceeding with rollback
  mutations while the safety marker is absent recreates the exact
  split-brain bug on the FIRST failure (the marker write), not a rare
  compound one. The actual fix (§2 item 4's Rollback bullet, round-6)
  removes the "try rollback anyway" fallback entirely rather than
  accepting its risk: if the marker write fails, rollback is never
  attempted, and the journal is left at its prior `'renaming'` stage —
  which is SAFE in that specific case (no rollback mutation occurred, so
  the existing roll-forward branch's ordinary behavior is correct), not a
  residual to name. This is a smaller, not larger, final design than the
  one described above — a removed code path instead of an accepted risk.
- **On round-6 H2 (terminal-state cleanup lifecycle) specifically —
  declined beyond a narrow parity fix**: GPT's finding is real —
  `cleanupJournal()`'s pre-existing `catch { /* best effort */ }`
  silently swallows a delete failure, and for the new `'rollback-failed'`
  stage specifically (unlike every OTHER stage) there is no future
  recovery pass that will ever retry that cleanup, so a swallowed failure
  there is a PERMANENT, silent block instead of a self-healing one.
  **Band-aid**: leave `cleanupJournal()` exactly as-is — ships the
  regression GPT identified (the new stage's cleanup failures are less
  visible than every existing stage's); rejected. **Over-engineered**:
  GPT's full recommendation — a `deleted | absent | failed` return-type
  contract threaded through `cleanupJournal()` and every one of its
  (currently three, soon four) call sites, PLUS a new durable
  "rollback-complete" terminal state distinct from plain journal absence,
  PLUS a defined, tooled operator-resolution protocol ("what the
  installer prints, how an operator verifies the filesystem, what action
  may remove the journal"). This is real infrastructure — CLI commands,
  a bigger state machine, a verification workflow — for a codebase whose
  ONLY current operator recourse, for the two pre-existing blocking cases
  (foreign journal, corrupt/invalid journal), is already "read the error
  message, inspect the path, resolve by hand." Building a formal protocol
  for ONLY the newest blocking case would be inconsistent with the other
  two, not more complete. **Chosen**: the minimal fix that actually
  closes the identified gap — change `cleanupJournal()`'s silent catch to
  a logged one. This restores parity with this file's own stated
  "degrade loudly, never silently" convention (already quoted verbatim
  elsewhere in this plan) at the one call site that violated it, without
  inventing a new result-type contract, a new terminal state, or new
  tooling nothing else in this file has either.

## 3. Sustainability Notes

- **Assumption that could change**: today, a non-empty failure list just
  means "leave the journal, log it." If this ever needs an automated
  retry-with-backoff instead of waiting for the next install invocation,
  the failure-array return shape is already the right seam to build that
  on — no interface change needed, just a new caller.
- **Extension point**: a 5th sub-pattern (should one surface later) is
  one more failure-array push at its own call site; the
  gate-on-`failures.length` pattern is already established at all 3
  `cleanupJournal()` sites.
- **Deferred** (separate, independent concerns per the same triage pass):
  `scripts/lib/vcs.mjs` (whitespace-unsafe parsing, falsy `sinceCommit`,
  mutable exported `Set`) and `scripts/lib/find-rmsync-sites.mjs`
  (scope-blind AST matching) — both listed in the same source triage
  document (`refactor-install-wal-vcs-2026-07.md`) but explicitly
  "two independent, unrelated defect classes" from the WAL cluster, per
  that document's own framing. Not touched here.

## 4. File-Level Plan

- **`scripts/lib/install/transaction.mjs`** (modify)
  - `writeJournal()`: wrap `retrySync(() => fs.renameSync(tmp, journalPath))`
    (line 496) in a try/catch that unlinks `tmp` (best-effort) before
    re-throwing, matching the existing cleanup style at lines 486-490.
  - Phase 1's snapshot loop (lines 636-643, inside `executeTransaction()`):
    **remove the outer `fs.existsSync(w.absPath)` check entirely** (round-3
    finding M1 — `existsSync` collapses stat/access failures to `false`,
    which would silently treat some non-ENOENT "can't tell" states as "no
    prior file", and is a TOCTOU race against the read that follows it).
    Replace the whole `if/else` with one unconditional
    `try { snapshots.set(w.absPath, fs.readFileSync(w.absPath)); }
    catch (err) { if (err.code === 'ENOENT') snapshots.set(w.absPath,
    undefined); else throw err; }` — `ENOENT` still sets `undefined`
    (genuinely absent, unchanged behavior); every other code re-throws
    immediately. `stage` is still `'not-started'` at this point, so the
    existing catch-block dispatch (case `'not-started'`) already handles
    the abort correctly — no new dispatch branch needed.
  - `rollbackPartialTransaction()` (round-2 finding M1 — the snapshot
    domain is now deliberately binary, made exhaustive rather than left
    with a dead comparison against an unreachable value): change return
    type from `undefined` to `Array<{absPath, reason}>` accumulating every
    path whose restore attempt's `catch` fired (line 736-738). Simplify
    the existing `snapshot !== null` condition (line 731) to a bare
    `else` — with `null` no longer constructible, the loop becomes an
    exhaustive two-case operation: `undefined` → delete the new file;
    anything else (a `Buffer`) → restore it. No `null`/`!== null` token
    remains anywhere in the function after this change — a search for
    `null` in `rollbackPartialTransaction()` finding zero hits is the
    literal acceptance check for this item. **Idempotency correction
    (Gemini gate round-1 finding G1)**: this new failure array now has a
    MUCH higher consequence than the log-only behavior it replaces — a
    non-empty array durably blocks future installs via the new
    `'rollback-failed'` marker (§2 item 4), where previously any error
    here was just a stderr line with no further effect. `err.code ===
    'ENOENT'` in the `snapshot === undefined` **delete** sub-branch (the
    target already gone, or never existed despite the `existsSync` guard
    — a benign TOCTOU outcome, not a real restore failure) must NOT be
    pushed to the failure array — mirroring the exact idempotency
    treatment already planned for the staged-discard branch in
    `recoverFromJournal()` (round-4 finding H3). **Correction (Gemini gate
    round-2 finding G1 — my round-1 fix was scoped too broadly and this
    was a genuine data-loss bug, not a false positive)**: the ENOENT
    exemption applies ONLY to that delete sub-branch. In the OTHER
    sub-branch — restoring a captured `Buffer` snapshot via
    `fs.writeFileSync(tmpPath, snapshot)` then
    `fs.renameSync(tmpPath, absPath)` — `ENOENT` means something
    different and dangerous: the parent directory is missing, so the
    write/rename genuinely FAILED and the original content was NOT
    restored. Exempting ENOENT there (as round-1's fix incorrectly did)
    would clear the rollback-failed marker and report success while the
    target's original bytes remain lost — silent data loss, not a benign
    race. **Every error in the restore sub-branch, including ENOENT, is
    pushed to the failure array without exception** — only the delete
    sub-branch gets the ENOENT-as-success treatment; the restore
    sub-branch has no equivalent "already done" precondition to
    reconverge against, because unlike a delete (idempotent — the end
    state "file absent" is reachable however you get there) a restore's
    end state is specific BYTES, which either got written or didn't. The
    first loop (removing unused `.tmp` files, lines 722-724) is
    unaffected by either finding — it was never part of the
    tracked-failures set (still a silent best-effort loop, unchanged by
    this plan; see the separate Gemini round-2 G2 note below for a
    related but distinct proportionality question about THAT loop's
    counterpart in `recoverFromJournal()`).
  - `attemptDelete()`: call `fsyncDir(path.dirname(d.absPath), ...)` after
    a successful unlink (line 541), non-critical, matching the rename
    loop's existing call shape. **Return-shape rewrite (round-3 finding
    H2, completed by round-4 finding M1)**: replace the current
    `{deleted, skipped?}` shape with a real discriminated result —
    `{kind: 'deleted', degradation?} | {kind: 'absent'} |
    {kind: 'conflict-skipped', reason} | {kind: 'delete-failed', reason}`
    — `degradation` is `fsyncDir`'s own `{ok:false, degraded}` result's
    `degraded` payload, forwarded unchanged when `fsyncDir` reports `!ok`
    on the `'deleted'` path; omitted otherwise. `reason` is unchanged
    diagnostic text (today's two literal message formats), now purely for
    display — no caller branches on its content. This is the ONLY way the
    fsync outcome can reach `degradations` (which `attemptDelete()` does
    not own), so both call sites below must read `kind`/`degradation`
    instead of the old `deleted`/`skipped` booleans.
  - Phase 4's delete loop (lines 684-688, inside `executeTransaction()`):
    switch on `r.kind` instead of `r.deleted`/`r.skipped`: `'deleted'` →
    increment `deletedCount`, push `r.degradation` to `degradations` if
    present; `'absent'` → no-op (today's silent case, unchanged); `
    'conflict-skipped'`/`'delete-failed'` → push `{absPath, reason:
    r.reason}` to `skippedDeletes` (the array's own shape is unchanged —
    only the branch that decides which kind produced the entry changes).
    After the loop, `cleanupJournal(journalPath, 'success')`'s condition
    (line 690; `context: 'success'` — G2 — so a cleanup failure here
    logs accurately as a normal-completion cleanup, never claiming a
    rollback happened) becomes "no entry this loop classified as
    `'delete-failed'`" — tracked as a separate boolean/count during the
    loop, NOT by re-parsing `skippedDeletes`' `reason` strings afterward
    (round-4 M1's whole point). **Named field contract (round-6 finding M1 — the earlier
    draft left this field unnamed and unspecified)**: the success return
    object gains `deleteFailures: Array<{absPath, reason}>`, populated
    ONLY from entries this loop classified `kind: 'delete-failed'` —
    never a subset/copy computed by re-inspecting `skippedDeletes`
    afterward (that array keeps its own unchanged shape and role: the
    operator-facing display list containing BOTH `conflict-skipped` and
    `delete-failed` entries, for `install-skills.mjs`'s existing generic
    print loop). `recoverFromJournal()`'s equivalent field (§ bullet
    below) uses the SAME name and shape for its own delete-replay
    failures, so both producers share one contract, not two similarly-
    shaped-but-differently-named ones. **New (round-4 finding H4)**:
    `deleteFailures.length > 0` is the ONLY signal
    `install-skills.mjs`'s `main()` reads to decide its non-zero exit
    code — never `skippedDeletes.length` (which also counts benign
    `conflict-skipped` entries) and never a `reason`-string match — see
    that file's bullet below. **Exhaustiveness (round-7 finding M1,
    half)**: `deleteFailures` is declared as a closure-scoped array at the
    top of `executeTransaction()`, alongside the EXISTING
    `skippedDeletes`/`degradations` declarations (`transaction.mjs:583-584`)
    — not a field conditionally added only to the success object. Since
    `fail()` (line 585) already always includes `skippedDeletes` and
    `degradations` via closure (it references the same variables, not
    literals), `deleteFailures` inherits the identical guarantee for
    free: EVERY return from `executeTransaction()`, success or `fail()`,
    carries `deleteFailures` (empty unless Phase 4 actually ran and
    classified an entry `'delete-failed'`). `main()` therefore never needs
    to branch on `result.success` before reading
    `result.deleteFailures.length` — the field is unconditionally present,
    matching how `main()` already unconditionally reads
    `result.degradations` today (line 517, before the `!result.success`
    check).
  - `recoverFromJournal()`: **expanded, round-4 findings H2 + H3**. The
    `stage === 'renaming'` roll-forward branch has TWO loops: the rename
    loop (lines 842-858, per-path `catch`) and the delete-replay loop
    (lines 860-863, calls `attemptDelete()` — previously unwired into any
    failure list, round-4 H2). Both push into ONE shared failure list for
    this branch: the rename loop on its `catch`; the delete-replay loop on
    `r.kind === 'delete-failed'` (same discriminant Phase 4 uses, not a
    second convention), plus `if (r.degradation)
    degradations.push(r.degradation)` for the fsync channel — pushed into
    this function's own local `degradations` array (already declared at
    line 761), the same field/contract as `executeTransaction()`'s. The
    `stage === 'staged'` else-branch (lines 864-871) discards orphaned
    `.tmp` files — **revised, Gemini gate round-2 finding G2 (a
    proportionality/consistency fix, replacing round-4 H3's original
    approach rather than layering on top of it)**: round-4 H3 made this
    loop's retry idempotent by NOT counting `ENOENT` as a failure, but
    still counted every OTHER unlink error (e.g. a transient `EPERM` from
    an antivirus scan) as one that retains the journal and blocks all
    future installs — inconsistent with `rollbackPartialTransaction()`'s
    OWN equivalent tmp-cleanup loop (lines 722-724), which is a plain
    best-effort, non-blocking loop for the exact same operation
    (discarding orphaned `.tmp` files for an aborted transaction). A
    leaked `.tmp` file is uniquely-named, harmless garbage — it is never
    read by anything, never conflicts with a future transaction's own
    `.tmp` files, and poses zero correctness risk left on disk
    indefinitely. Blocking every future install over a failed delete of
    pure garbage is disproportionate to the risk. **Fix**: this loop's
    unlink failures (of any code, not just non-`ENOENT`) do **not**
    contribute to the failure list that gates `cleanupJournal()` at all —
    matching `rollbackPartialTransaction()`'s treatment exactly. A
    non-`ENOENT` failure is still reported (pushed to this function's
    `degradations` array — informational, non-blocking, the same channel
    already used for fsync durability telemetry elsewhere in this plan);
    `ENOENT` (already gone) produces no output at all, since there is
    nothing to report. The shared
    `cleanupJournal(journalPath, 'recovery')` call at line 873 is
    **revised (round-2 G2 above)** to be conditional on ONLY the
    `renaming` branch's failure list (rename+delete-replay) — the
    `staged` branch's tmp-discard no longer contributes to this gate at
    all, per the fix above, so a `stage === 'staged'` recovery always
    cleans up its journal regardless of individual `.tmp`-unlink outcomes
    — passing the new `context` argument (round-1 G2) so a cleanup
    failure here logs accurately as a recovery-completion cleanup, not a
    rollback one. **Canonical field name (round-7
    finding M1, second half; scope narrowed by Gemini-gate round-2 G2)**:
    `recoverFromJournal()`'s own return object gains exactly ONE new
    field, `recoveryFailures: Array<{absPath, reason}>` — populated ONLY
    from the `renaming` branch's rename+delete-replay failures; the
    `staged` branch's tmp-discard failures never enter this array (they
    go to `degradations` instead, per the fix above, and never gate
    cleanup), unconditionally present on every return (declared as a closure array
    alongside the existing `skippedDeletes`/`degradations`, same pattern
    as `executeTransaction()`'s `deleteFailures` above). This is the SAME
    name `install-skills.mjs`'s `reconcileJournals()` already reads (round-2
    finding L1) — `reconcileJournals()` does not rename or repackage
    anything at the boundary; it reads `rec.recoveryFailures` directly and
    passes it straight to its reporting call and `process.exit(1)` check.
    There is no second, differently-named field anywhere in this data
    path — earlier drafts' "a field surfacing any failures" / "equivalent
    to `deleteFailures`" language is resolved to this one concrete name.
  - `executeTransaction()`'s catch block: the `staging`/`staged`/`renaming`
    case (lines 704-707) is reordered (**round-5 finding H1 — write the
    marker BEFORE rollback, not after; round-6 finding H1 — do not
    attempt rollback at all if that write fails**): first,
    `try { writeJournal(journalPath, journalBody('rollback-failed',
    staged, deletes, repoRoot)); } catch (err) { return fail(...); }` —
    **if this write throws, return immediately WITHOUT calling
    `rollbackPartialTransaction()`**, leaving the journal exactly as it
    durably stood on entry to this catch block (`stage: 'renaming'`,
    unmodified). This is safe, not merely a fallback: no rollback
    mutation was ever attempted, so the filesystem is still in its plain
    partially-renamed Phase-3 state, which the EXISTING `stage ===
    'renaming'` roll-forward branch already handles correctly on a future
    recovery pass. When the marker write succeeds (the common case), call
    `rollbackPartialTransaction()` and read its return value: empty
    (rollback fully succeeded) → `cleanupJournal(journalPath, 'rollback')`
    runs (the `context` argument, G2, is what makes this call site's
    cleanup-failure message correctly say "rollback completed" — a claim
    that's only true HERE, not at the other two call sites), removing the
    marker along with the rest of the journal — no `'rollback-failed'`
    stage survives on disk; non-empty →
    nothing further is written, the marker is already durably in place
    from the pre-write. The journal stays at its original path in every
    branch (the pre-flight `existsSync(journalPath)` check at line
    622-624 keeps blocking future installs whenever it's not cleaned up),
    and its `stage` never reads `'renaming'` while a rollback attempt is
    genuinely in flight or has failed, so a future `recoverFromJournal()`
    cannot mistake an IN-PROGRESS-OR-FAILED rollback for a safe
    roll-forward candidate. The `fail()` result gains a field for
    rollback failures when non-empty.
  - `JournalSchema`'s `stage` field (line 347): widen
    `z.enum(['staged', 'renaming'])` to
    `z.enum(['staged', 'renaming', 'rollback-failed'])` — the one schema
    change this plan makes, additive only (both existing literals keep
    their exact current meaning).
  - `recoverFromJournal()` (continued): gains one new branch, checked
    BEFORE the existing `if (journal.stage === 'renaming')` dispatch
    (lines 842 onward) — `if (journal.stage === 'rollback-failed')`
    returns an explicit error (mirroring the foreign-journal error/block
    shape at lines 822-829: bounded, loud, requires human resolution) and
    performs NO filesystem action — the journal is left exactly where it
    is, so the pre-flight check in the NEXT `executeTransaction()` call
    keeps blocking. This branch does not call `cleanupJournal()` or
    `quarantineJournal()` under any circumstance.
  - `cleanupJournal()` (line 742-745) — **narrow parity fix (round-6
    finding H2, scope confirmed via round-7 H1 rebuttal — GPT's
    `gpt_ruling: compromise`, `final_severity: LOW`: "the current
    retain-and-block behavior is safe... the missing automatic retry is
    an operational-availability/self-healing limitation, not an unsafe
    automatic completion or silent data loss"; message contract corrected
    by Gemini-gate round-1 finding G2)**: change the existing
    `catch { /* best effort */ }` to a logged, **actionable** catch —
    but the function signature gains a required third parameter,
    `cleanupJournal(journalPath, context)`, where `context` is a short
    caller-supplied string (`'success'`, `'rollback'`, or `'recovery'`,
    matching this function's three call sites). **Why a parameter, not a
    hardcoded string (G2)**: `cleanupJournal()` is a SHARED helper called
    from three unrelated call sites — normal completion, rollback
    completion, and recovery completion. The round-7 rebuttal's original
    fix hardcoded rollback-specific wording ("rollback completed; only
    cleanup of the journal file failed") directly into the shared
    function body — so a completely unrelated, fully successful NORMAL
    install whose `cleanupJournal()` call merely failed to unlink would
    ALSO print "rollback completed," which is false and actively
    misleading (no rollback ever happened). The corrected contract: each
    call site passes its own `context`, and the log message is built from
    it — e.g. `` `[transaction] Failed to remove journal ${journalPath}
    after ${context === 'rollback' ? 'a fully successful rollback' :
    context === 'recovery' ? 'recovery completing successfully' : 'a
    successful install'} (only journal cleanup failed): ${err.message}` ``
    — the underlying unlink error and the journal's path are always
    included; only the "what actually happened" clause varies by call
    site. A `'rollback-failed'`-marked journal whose FINAL
    `cleanupJournal()` call fails (after a fully successful rollback)
    leaves the operator blocked until they manually delete the journal —
    unlike every other stage's cleanup failure, which is self-healing (a
    future recovery pass retries cleanup too), because `'rollback-failed'`
    is deliberately never auto-actioned. This is the SAME manual-
    inspection recourse this file already relies on for the
    foreign-journal and corrupt-journal blocking cases, neither of which
    has a dedicated CLI resolution command either. NOT applied: a
    `deleted|absent|failed` return-type contract for `cleanupJournal()`,
    a distinct durable "rollback-complete" terminal state, or a formal
    operator-resolution protocol (GPT's full round-6/round-7
    recommendation) — recorded as an explicit Out-of-Scope (Future) item
    below, not silently dropped. **Fourth call site, signature-only
    change**: `executeTransaction()`'s catch block already calls
    `cleanupJournal(journalPath)` unconditionally for the
    `not-started`/`journal-written` case (transaction aborted before any
    mutation) — this behavior is untouched by this plan, but since
    `context` is now a required parameter, this pre-existing call site
    passes `context: 'abort'` purely for signature consistency (its
    message branch: "aborted before any mutation"). No new failure
    consequence is attached to this case.
  - **Why this file**: it already owns every function this plan touches
    (principle #5 — don't split a single-file invariant across files
    without a reason); confirmed by the neighbourhood query's `precedent`
    match on `rollbackPartialTransaction` itself.

- **`scripts/install-skills.mjs`** (modify — small, targeted)
  - `reconcileJournals()` (`install-skills.mjs:175-210`): reads
    `recoverFromJournal()`'s own `recoveryFailures` field directly — a
    **distinct, structured field**, `Array<{absPath, reason}>` (canonical
    name fixed in the `recoverFromJournal()` bullet above per round-7
    finding M1), the same shape convention as `skippedDeletes`/
    `degradations` but never merged into `rec.degradations` itself
    (round-2 finding L1 — merging would change an existing degradation
    collector's producer/meaning for callers that already consume it as
    "non-critical durability info only"; a `recoveryFailures` entry is
    categorically different — it means the WAL could not be resolved and
    the caller is about to abort). No renaming or repackaging happens at
    this boundary — `rec.recoveryFailures` is read and passed straight to
    a new reporting call, sibling to the existing
    `reportDegradations(rec.degradations)` (line 205) but printing under
    its own "unresolved WAL" heading — not a second ad hoc `console.log`,
    matching this file's one-reporting-function-per-concern convention
    (principle #5). Both may share the same underlying line-formatting
    helper if one already exists; they must not share a result array or
    a message heading.
  - **New (round-1 finding H3)**: when the failure list is non-empty,
    call `process.exit(1)` — the exact pattern this function already uses
    for `rec.error` (lines 184-197), same file, same function, not a new
    control-flow convention. `main()` calls `reconcileJournals(repoRoot)`
    at line 439, well before it builds the write list or calls
    `executeTransaction()` (confirmed via direct read of `main()`,
    lines 431-472) — so this exit already happens before any new
    transaction could stack on top of unresolved WAL state; no separate
    caller-side check is needed in `main()` itself.
  - **New (round-4 finding H4, field named round-6 M1)**: `main()`'s
    existing skip-reporting loop (`install-skills.mjs:524-526`, which
    already prints every `executeTransaction()` `skippedDeletes` entry)
    gains a check on `result.deleteFailures.length > 0` (the named field
    from the `transaction.mjs` Phase-4-delete-loop bullet — NOT
    `skippedDeletes.length`, which also counts benign `conflict-skipped`
    entries, and NOT a `reason`-string match): print an explicit "journal
    retained — the next install will block until this is resolved" line
    and record a non-zero exit code, applied at the function's existing
    `process.exit()` call — reusing the exact convention
    `reconcileJournals()` already uses for `rec.error` / recovery
    failures two bullets above, not a new outcome taxonomy. `main()` is
    confirmed (via `grep`) to be the ONLY caller of `executeTransaction()`
    in this codebase, so this one check is the complete fix — there is no
    second caller to trace the signal through.
  - **Why this file**: it's the one real caller of `recoverFromJournal()`
    (confirmed via `grep`, not assumed) and already owns both conventions
    (the reporting channel and the exit-on-unresolved-state pattern) this
    plan's new data needs to plug into.

- **`tests/install/transaction-hardening.test.mjs`** (modify — the
  existing crash-injection/hardening suite, 642 lines; extend, never
  replace, per the file-level plan already scoped by the source triage
  document's own Rollback note)
  - Sub-pattern 1: inject a `renameSync` failure on the journal-write path
    (mirroring however this suite already injects `fs` failures elsewhere
    — read the existing injection helper before adding a new one) and
    assert the `.tmp` journal file is gone afterward.
  - Sub-pattern 2 (revised — precondition abort via a single classified
    read, round-1 H1 tightened by round-3 M1: no `existsSync` probe at
    all): inject a non-ENOENT read failure (e.g. `EACCES`) on an EXISTING
    target file's snapshot read and assert (a) `executeTransaction()`
    throws/fails before any journal write, staging, rename, or delete
    occurred (assert no `.tmp` files, no journal file, and the target's
    original bytes are byte-for-byte unchanged), and (b) a target that
    does not exist on disk at all produces `undefined` via `readFileSync`'s
    own `ENOENT`, confirmed WITHOUT any `fs.existsSync` call happening
    first (spy/assert `existsSync` is never invoked for this target in
    Phase 1 — the direct regression test proving the TOCTOU probe-then-read
    race round-3 M1 identified is gone by construction, not merely
    documented as safe). A separate case: a null-snapshot-adjacent path
    mid-transaction alongside other valid-snapshot paths — assert the
    WHOLE transaction aborts (no partial mutation of the other paths
    either), not just the one problem path.
  - Sub-pattern 3 (expanded — round-2 finding H1, the contract, not just
    the call): assert `fsyncDir` is invoked after a delete — spy on it the
    same way the existing hardening tests already verify calls for renames
    (read that pattern first; use the same technique, don't invent a
    second one). Then assert the **contract**: inject an `fsyncDir`
    failure on the post-unlink call and confirm (a) the delete itself
    still reports `kind: 'deleted'`/succeeds (round-4 M1's discriminant,
    not a boolean), (b) the failure appears in the transaction's
    `degradations` array, (c) it does NOT appear in `skippedDeletes` and
    the entry's `kind` is `'deleted'`, never `'delete-failed'`, and (d)
    normal-completion cleanup still removes the journal (this is the
    acceptance test named in §7's "Explicit non-membership" note — a
    durability degradation must never be misclassified as a delete
    failure and must never retain the journal).
  - Sub-pattern 4a (recovery — expanded, round-4 findings H2 + H3): inject
    a roll-forward RENAME failure during `recoverFromJournal()` and assert
    `cleanupJournal()` is **not** called (the journal file still exists on
    disk after the call returns) — the direct regression test for "a
    future recovery pass gets another chance." **New (H2)**: a second
    roll-forward case where every rename succeeds but the delete-replay
    loop's `attemptDelete()` call returns `kind: 'delete-failed'` — assert
    this ALSO retains the journal (the direct regression test for the gap
    GPT found: a non-throwing delete failure during recovery was
    previously invisible to the failure list). **New (H3)**: for the
    orphaned-`.tmp`-discard branch (`stage === 'staged'`), a two-attempt
    sequence — first recovery deletes temp A successfully and fails to
    delete temp B (injected error); assert the journal is retained.
    Second recovery attempt: temp A is now gone (`ENOENT` on unlink),
    temp B succeeds — assert this does NOT get miscounted as a fresh
    failure (i.e. `ENOENT` on the discard unlink is treated as converged
    success, not appended to the failure list) and the journal IS cleaned
    up this time — the direct regression test for "a transient failure
    must not permanently block recovery after the real work completes."
  - Sub-pattern 4b (rollback — revised again, round-4 finding H1: a
    marked-and-retained journal, not quarantine): inject a restore
    failure inside `rollbackPartialTransaction()` (during the
    `staging`/`staged`/`renaming` catch path) and assert (a) the journal
    file still exists AT ITS ORIGINAL PATH afterward (`fs.existsSync
    (journalPath)` is `true` — NOT quarantined, NOT deleted), (b) its
    on-disk `stage` field reads `'rollback-failed'`, not `'renaming'`,
    and (c) a subsequent `executeTransaction()` call sees "a prior
    transaction journal exists" and refuses to proceed (the pre-flight
    block is intact — round-4's actual regression target, since round-3's
    quarantine fix silently removed this block). Then: (d) a subsequent
    `recoverFromJournal()` call against this journal returns an explicit
    error and performs NO filesystem action — critically, it must NOT
    take the `stage === 'renaming'` roll-forward branch (the direct
    regression test for round-3's original bug: the journal is never
    mistaken for a safe roll-forward candidate) and must NOT call
    `quarantineJournal()` either (the direct regression test for round-4's
    bug: the record is never silently discarded/unblocked).
  - **New (round-7 finding H1, resolved via rebuttal — `gpt_ruling:
    compromise`)**: a case where `rollbackPartialTransaction()` returns
    an EMPTY failure array (rollback fully succeeded) but the subsequent
    `cleanupJournal()` call itself is injected to fail — assert (a) the
    journal remains on disk (still marked `'rollback-failed'` from the
    pre-rollback write), (b) a subsequent `executeTransaction()` call is
    blocked by the pre-flight check, and (c) the logged stderr message
    names the journal path, the underlying unlink error, AND states that
    rollback itself completed successfully (only cleanup failed) — the
    direct regression test for the round-7 rebuttal's agreed refinement:
    the operator must never have to guess whether the filesystem was
    actually restored.
  - **New (Gemini gate round-1 finding G1)**: inject an `ENOENT` (not an
    arbitrary error) into `rollbackPartialTransaction()`'s restore loop —
    both sub-cases: (a) the `snapshot === undefined` delete branch, and
    (b) the write+rename restore branch — and assert the resulting
    `failures` array is EMPTY (ENOENT does not count as a rollback
    failure) and the `'rollback-failed'` marker is consequently never
    written; rollback completes normally, `cleanupJournal()` runs, no
    journal survives. A second case with a NON-`ENOENT` error (e.g.
    `EACCES`) in the same branches confirms the failure array is still
    populated correctly — the direct regression test proving ENOENT
    specifically, and only ENOENT, is exempted.
  - **New (Gemini gate round-1 finding G2)**: call `cleanupJournal()`
    with each of its three real contexts (`'success'`, `'rollback'`,
    `'recovery'`) against an injected unlink failure, and assert each
    produces a DISTINCT, context-accurate stderr message — specifically,
    that a `'success'`-context failure NEVER contains the string
    "rollback" — the direct regression test for the shared-helper
    message-bleed bug Gemini caught (a normal install's cleanup failure
    previously would have falsely claimed a rollback occurred).
  - Sub-pattern 4c (normal completion, newly discovered in round 1,
    revised round-4 M1 + H4): inject a `kind: 'delete-failed'` (real
    unlink error, e.g. `EPERM`) during Phase 4 and assert the journal
    **survives** even though no exception propagated out of
    `executeTransaction()` — the direct regression test for H4. A second
    case: inject a `kind: 'conflict-skipped'` (mismatched `expectedSha`)
    and assert the journal **is** cleaned up — confirming the fix
    distinguishes "worked as designed" from "didn't work" via the `kind`
    discriminant, not a `reason`-string match (round-4 M1 — assert no
    test in this file constructs its expectation by matching on `reason`
    text). **New (round-4 H4)**: an integration-style test invoking
    `install-skills.mjs`'s `main()` (or its extracted install routine)
    against a fixture producing a `kind: 'delete-failed'` outcome,
    asserting a non-zero process exit AND the explicit "journal
    retained..." message — the direct regression test for "success:true
    at the API layer must not read as an unqualified clean result at the
    CLI layer."
  - **New**: `scripts/install-skills.mjs::reconcileJournals()` exits 1
    when `recoverFromJournal()`'s failure list is non-empty, and never
    reaches the write-list-building code after it (round-1 finding H3) —
    an integration-style test invoking the reconcile step against a
    fixture journal engineered to leave a roll-forward failure, asserting
    both the exit code and that no `executeTransaction()` call was made
    (spy or a canary write that must never appear).
  - **New (round-2 finding L1 — the reporting-contract distinction)**: a
    fixture run that produces BOTH a non-critical `fsyncDir` degradation
    (via sub-pattern 3's injection) AND a genuine `recoveryFailures` entry
    in the same `reconcileJournals()` invocation, asserting the two are
    rendered under separate headings/messages and neither call's output
    can be mistaken for the other — the direct regression test for the
    "must not share semantics or lifecycle" requirement GPT's finding
    named.

- **`tests/install/transaction.test.mjs`** (modify — 46 lines, basic
  coverage; add a case confirming the normal-completion path's
  `cleanupJournal()` call is unaffected by this plan when there are zero
  skipped deletes — a full success still deletes the journal, same as
  today. This is the regression guard against accidentally making the new
  conditional gate ALSO block the already-correct success path.)

## 5. Risk & Trade-off Register

- **Risk**: a failure list that's non-empty but the operator never checks
  stderr could leave a journal behind indefinitely, blocking future
  installs at the pre-flight check (`transaction.mjs:622-624`,
  "a prior transaction journal exists — run recovery first"). **Assessment**:
  this is the correct, intended behavior — a blocked-and-loud install is
  the WAL's fail-safe, matching the file's own existing philosophy for the
  `renamed`/`deleting` stage case (lines 708-712: "Leave the journal so
  recovery can finish... next run") and the foreign-journal handling in
  `recoverFromJournal()` (lines 803-829: "Blocking is bounded, loud, and
  self-healing"). Not a new failure mode, an application of an existing one.
- **Risk**: changing `rollbackPartialTransaction()`'s return type from
  `undefined` to an array is a signature change. **Mitigation**: it has
  exactly one caller in this file (`executeTransaction()`'s catch block,
  line 705) — verified via `grep`. No external module imports it directly
  (it's not in `_internals` — confirmed: the `_internals` export block at
  lines 884-900 does not include it).
- **Risk (round-1 finding H1, resolved by design change, not accepted)**:
  the original design retained the journal on a null-snapshot failure,
  which would have shipped a fix that LOOKED complete but couldn't
  actually recover anything — the exact "looks fixed but isn't" failure
  class this whole plan exists to close. **Resolution**: moved the check
  upstream to an abort-before-any-mutation precondition (§2 item 2), so
  the unrecoverable state can no longer be reached at all, rather than
  being reached and merely reported.
- **Risk (round-1 finding H4, a plan defect, not a code defect)**: the
  original Code Trace's claim that normal completion was unaffected was
  simply wrong — verified directly against `attemptDelete()`'s
  non-throwing failure mode. Left as a corrected note in §1 rather than
  silently rewritten, so the audit trail shows what was caught and why.
- **Risk**: `recoverFromJournal()`'s return shape gains a new field.
  **Mitigation**: additive only (existing fields `recovered`/
  `rolledForward`/`rolledBack`/`skippedDeletes`/`degradations` are
  unchanged); `scripts/install-skills.mjs::reconcileJournals`
  (`install-skills.mjs:175-210`, the one real caller, confirmed via
  `grep`) destructures fields individually (`rec.error`, `rec.foreign`,
  `rec.quarantined`, `rec.skippedDeletes`, `rec.degradations`,
  `rec.recovered`) — non-exhaustive, so a new field is safe to add.
  **This caller already has an established "never silent" convention**
  for exactly this kind of data: `reportDegradations(rec.degradations)`
  (`install-skills.mjs:205`, its own doc comment: "the 'degrade loudly,
  never silently' stance is only real if something actually prints").
  **Resolution (round-2 finding L1)**: the new rollback/roll-forward
  failure list is a distinct `recoveryFailures` field, reported through
  a second, sibling call — never folded into `degradations` (that array
  is an established "non-critical, informational" contract for other
  callers; a recovery failure is instead the reason `main()` is about to
  `process.exit(1)`, a different lifecycle entirely). Added to File-Level Plan below;
  omitting this would repeat the exact silence bug this plan closes, one
  layer up.
- **Risk (round-3 finding H1, a reopened correctness bug — the same
  "looks fixed but isn't" class as round-1 H1)**: round-2's fix retained
  the journal on a rollback failure without checking what a future
  recovery run would DO with it. Traced: the on-disk journal's `stage`
  is already `'renaming'` by the time Phase 3 (where rollback-triggering
  failures occur) even starts, so plain retention would cause
  `recoverFromJournal()`'s roll-forward branch to COMPLETE the aborted
  transaction on the next run — the opposite of rollback, and worse than
  the original unconditional-cleanup bug (which merely lost the record;
  this would actively corrupt state). **Resolution — SUPERSEDED, see the
  round-4 H1 entry below (round-5 finding L1: this entry previously said
  "quarantine instead of retain," which is stale — do not implement
  quarantine)**: round-3's actual fix (quarantining the journal) was
  itself reopened by round-4 H1 for a different reason (it silently
  removed the pre-flight block). The CURRENT, normative instruction is
  round-4's retain-and-mark design (§2 item 4's Rollback bullet,
  Right-sizing §2) — retain the journal at its original path with a new
  `'rollback-failed'` stage, never quarantine. The other two retention
  cases (normal-completion `delete-failed`, recovery-failure) are
  unaffected by any of this — traced separately and confirmed safe to
  retain as-is (they occur at or after the `'renaming'` stage in a
  context where roll-forward IS the correct next action).
- **Risk (round-3 finding H2, an implementability contradiction in the
  plan text, not a code defect — superseded by round-4 M1's full fix,
  kept for the audit trail)**: round-2's fix for the fsync-degradation
  contract said `attemptDelete()`'s return shape stays `{deleted,
  skipped?}` (no third field) while also requiring it push into
  `degradations`, an array it does not own — an unimplementable
  instruction. **Resolution**: added the missing field, later replaced
  entirely by round-4 M1's discriminated-result rewrite (§2 item 3, §4
  `attemptDelete()` bullet) — both call sites (`executeTransaction()`
  Phase 4, `recoverFromJournal()`'s delete replay) read it into their own
  local `degradations` array.
- **Risk (round-4 finding H1, a reopen of round-3's own H1 fix — the
  second time this exact behavior was corrected)**: round-3's fix
  (quarantine on rollback failure) closed the wrong-direction-roll-forward
  bug but introduced a new one — quarantining silently removes the
  journal from the pre-flight block, letting a new install proceed over a
  partially-rolled-back filesystem with no persisted before-images to
  ever recover the original bytes. **Resolution**: retain-and-mark
  instead of quarantine (§2 item 4's Rollback bullet, Right-sizing) — the
  journal stays at its original path (block intact) with a new
  `'rollback-failed'` stage so recovery refuses automatic action.
- **Risk (round-4 finding H2, a recurrence of round-1 H4's root cause in
  a second call site)**: `recoverFromJournal()`'s roll-forward branch also
  calls the non-throwing `attemptDelete()` for delete-replay
  (`transaction.mjs:860-863`), and this call's failures were never wired
  into the branch's own failure list — the exact "non-throwing failure
  invisible to a catch-based tracker" bug round-1 H4 fixed in
  `executeTransaction()`'s Phase 4, recurring here because the two call
  sites weren't audited together the first time. **Resolution**: both
  call sites now switch on the same `kind` discriminant (round-4 M1).
- **Risk (round-4 finding H3, an idempotency gap in retry logic this
  plan itself introduces)**: "accumulate every catch, gate cleanup on
  zero failures" is only correct if failures don't re-appear on retry for
  work already done — the staged-discard branch's per-path unlink `catch`
  didn't distinguish "already gone" (a prior attempt's success) from a
  real failure, so a single transient error could make recovery
  permanently non-convergent even after all real work completed.
  **Resolution**: `ENOENT` on the discard unlink is success, not failure.
- **Risk (round-4 finding H4, an outcome-visibility gap, not a data-loss
  bug)**: `executeTransaction()`'s `success: true` result for a
  `delete-failed` outcome is technically accurate (the writes/renames did
  succeed) but reads as an unqualified clean result to `main()`'s
  existing skip-printing loop, which had no non-zero-exit signal for it.
  **Resolution**: `main()`'s loop gains a `kind === 'delete-failed'`
  check driving an explicit message + non-zero exit — the narrower fix
  GPT's own recommended full outcome-taxonomy would have also achieved,
  scoped to this codebase's actual single caller (see §2 item 4's Normal
  completion bullet for why the narrower fix is complete here, not
  merely cheaper).
- **Deferred**: `vcs.mjs`/`find-rmsync-sites.mjs` — see Sustainability Notes.

## 6. Testing Strategy

- **Unit/integration**: extending `tests/install/transaction-hardening.test.mjs`
  (crash-injection style — this file already exists for exactly this
  purpose) and `tests/install/transaction.test.mjs` (basic coverage),
  per the File-Level Plan above. Run via `node --test tests/install/*.mjs`
  or `npm test`.
- **Edge cases covered**: retry-exhaustion on the journal rename
  specifically (not just staged-file renames, which are already covered);
  a non-ENOENT snapshot-read failure aborting the WHOLE transaction before
  any mutation, even when other target paths would have snapshotted fine;
  an ENOENT snapshot-read failure behaving unchanged (still `undefined`,
  still proceeds) via `readFileSync` alone, with `fs.existsSync` proven
  never called in Phase 1 (round-3 M1 — the TOCTOU probe-then-read race
  is structurally gone, not just documented safe); both
  `recoverFromJournal()` branches (`renaming` roll-forward AND `staged`
  discard) failing independently; the normal-completion path's
  `cleanupJournal()` gated correctly on `DELETE_FAILED` skips but NOT on
  `CONFLICT_DELETION_SKIPPED` ones; the caller-level halt in
  `reconcileJournals()`; a rollback failure producing a journal **retained
  at its original path and marked `'rollback-failed'`** — neither
  plainly-retained (round-3 H1: would roll forward by mistake) nor
  quarantined (round-4 H1: would silently unblock new installs over
  unresolved state) — confirmed both by the pre-flight block staying
  active AND by `recoverFromJournal()` refusing automatic action on it; a
  post-unlink `fsyncDir` failure reaching `degradations` through
  `attemptDelete()`'s discriminated `degradation` field without ever
  producing `kind: 'delete-failed'` (round-3 H2, discriminant finalized
  round-4 M1); a non-throwing delete-replay failure during recovery's
  roll-forward branch correctly retaining the journal (round-4 H2); an
  `ENOENT` on the staged-discard branch's retry treated as converged
  success rather than a fresh failure across two recovery attempts
  (round-4 H3); a `kind: 'delete-failed'` outcome producing a non-zero
  `install-skills.mjs` exit code with an explicit message (round-4 H4).
- **Given this module's safety-critical nature** (per the pre-existing
  refactor plan's own Rollback note), no shortcuts on coverage — every one
  of the 4 sub-patterns gets its own test, not a single combined smoke test.

## 7. Acceptance Criteria

Not applicable in the frontend sense (backend-only scope, no UI surface
for `/ux-lock verify` to grade) — but round-1 finding M1 correctly noted
this repo's convention is backend criteria via a decision table, not a
bare "N/A." One row per `cleanupJournal()` call site (now 3) plus the new
caller-level behavior:

| Call site | Prerequisite for journal deletion | Failure-list source | On failure |
|---|---|---|---|
| Normal completion (`transaction.mjs:690`) | No delete-loop entry with `kind: 'delete-failed'` (round-4 M1 discriminant, not a `reason`-string match). `kind: 'conflict-skipped'` entries do NOT block. | Phase 4's delete loop, classifying each `attemptDelete()` result by `kind` | Journal **retained as-is** (no stage change); `cleanupJournal()` not called; result still reports `success: true`, with the failures surfaced via a new field AND (round-4 H4) `install-skills.mjs`'s `main()` printing an explicit message and setting a non-zero exit code. Safe to retain unmodified because Phase 4 only runs after the on-disk journal already reads `stage: 'renaming'` — the SAME stage recovery's roll-forward branch replays deletes from, so a future recovery run's retry is the correct completion of this transaction (a delete failure doesn't invalidate the writes/renames that already committed). |
| Rollback (`transaction.mjs:706`, catch block) | `rollbackPartialTransaction()`'s returned array is empty | Per-path restore `catch` in the rollback loop | **Revised twice — round-3 H1 then round-4 H1, converged on**: the journal is **retained at its original path** (pre-flight `existsSync` keeps blocking future installs — unlike round-3's quarantine attempt) but its `stage` is rewritten to the new `'rollback-failed'` literal (one extra `writeJournal()` call) so `recoverFromJournal()` refuses to act on it automatically — unlike plain `'renaming'`-stage retention, which round-3 correctly identified would cause the next recovery to roll the transaction FORWARD instead of back. Neither quarantined nor silently retained-as-'renaming'. `fail()` result gains the failure list. |
| Recovery (`transaction.mjs:873`, shared by both `stage` branches) | **Expanded, round-4 H2 + H3**: the `renaming` branch's failure list now includes BOTH the rename loop's `catch` entries AND the delete-replay loop's `kind: 'delete-failed'` entries (previously untracked — H2); the `staged` branch's failure list excludes `ENOENT` on the discard unlink (already-converged success, not a failure — H3). Both lists empty. | Rename-loop `catch` + delete-replay `kind` check (renaming branch); idempotent (non-`ENOENT`-only) `catch` (staged branch) | Journal retained; `recoverFromJournal()`'s return object gains the failure list; `reconcileJournals()` `process.exit(1)`s before any new transaction. A `journal.stage === 'rollback-failed'` journal never reaches either branch — it is intercepted earlier and always treated as a failure requiring human resolution (see the Rollback row above). |
| Pre-mutation snapshot failure (new precondition, not a `cleanupJournal()` site) | N/A — transaction never writes a journal at all | Phase 1's snapshot loop, `err.code !== 'ENOENT'` (single classified `readFileSync`, no `existsSync` probe — round-3 finding M1) | `executeTransaction()` throws; no journal, no `.tmp` files, no target mutation; existing `case 'not-started'` catch-block handling applies unchanged |

Pass/fail assertions this table drives (mirrored in §6's test list): full
success removes the journal; a snapshot-precondition failure creates zero
transaction artifacts; a rollback failure **retains the journal marked
`'rollback-failed'`** (distinct from both plain retention and
quarantine — see the table cell above) so the next recovery run neither
rolls forward by mistake (round-3's bug) nor silently unblocks new
installs over unresolved state (round-4's bug); a recovery failure
(including a non-throwing delete-replay failure, round-4 H2, and
excluding an idempotent `ENOENT` reconvergence, round-4 H3) retains the
journal and stops the installer before a new transaction; a
`delete-failed` outcome retains the journal as-is (safe to
roll-forward-retry) AND surfaces a non-zero CLI exit code (round-4 H4)
while a `conflict-skipped` outcome does not block cleanup at all.

**Explicit non-membership (round-2 finding H1)**: a post-unlink `fsyncDir`
degradation is NOT a row in this table and never gates journal deletion —
it is durability telemetry about an already-successful delete (the unlink
itself already returned `kind: 'deleted'` before `fsyncDir` is even
called), pushed to the transaction's `degradations` array exactly like
Phase 3's rename loop already does. **Data-flow mechanism (round-3
finding H2, discriminant finalized round-4 M1)**: it reaches
`degradations` via an optional `degradation` field on `attemptDelete()`'s
discriminated return value — `{kind: 'deleted', degradation?} |
{kind: 'absent'} | {kind: 'conflict-skipped', reason} |
{kind: 'delete-failed', reason}` — which both callers
(`executeTransaction()`'s Phase 4 loop and `recoverFromJournal()`'s
roll-forward-branch delete replay) check and push into their own local
`degradations` array; it is never threaded through `skippedDeletes` or a
caller-owned mutable parameter, and no code anywhere branches on `reason`
text (round-4 M1 — `kind` is the sole discriminant). It can never carry
`kind: 'delete-failed'`, and therefore can never retain a journal that
would otherwise be cleaned up. Acceptance test: an injected post-unlink
`fsyncDir` failure completes the delete (`kind: 'deleted'`), appears in
`degradations`, and the journal is still removed on normal
completion.

## Out of Scope (Future)

Per the audit-plan skill's rigor-pressure stop rule: this plan's GPT loop
ran 7 rounds (well past the normal 3-round cap) because rounds 3-6
surfaced genuine, concrete, code-traced correctness bugs in the plan's
own evolving rollback design — not rigor pressure — and each earned its
extra round. Round 7's HIGH finding, by contrast, restated round 6's
already-declined H2 without new evidence of an unsafe outcome; sent to
GPT deliberation, which conceded the scope boundary
(`gpt_ruling: compromise`, `final_severity: LOW`, reasoning: "the current
retain-and-block behavior is safe... the missing automatic retry is an
operational-availability/self-healing limitation, not an unsafe automatic
completion or silent data loss"). That is this round's stop signal — the
loop closes here.

**Deferred: automated recovery of a `'rollback-failed'` journal after a
verified-successful rollback whose own `cleanupJournal()` call failed.**

- **What's deferred**: today (after this plan ships), if rollback fully
  restores every snapshot but the final `cleanupJournal()` unlink itself
  fails, the operator gets a loud, actionable stderr message (journal
  path, underlying error, explicit "rollback completed, only cleanup
  failed") and must manually delete the journal to unblock future
  installs. A fuller design — a distinct durable `rollback-complete`
  terminal state (separate from `rollback-failed`), a `deleted | absent |
  failed` result contract for `cleanupJournal()`, and a `recoverFromJournal()`
  branch that safely retries ONLY journal cleanup (never filesystem
  mutation) for a verified-complete rollback — would let this self-heal
  without operator intervention.
- **Why deferred, not fixed here**: (1) it is a safety-preserving
  availability gap, not a correctness or data-loss bug — GPT's own
  round-7 concession confirms the current behavior is fail-closed and
  safe, merely less convenient than full automation; (2) this codebase's
  other two blocking cases (foreign journal, corrupt/invalid journal)
  have no formal resolution protocol either — building one for only the
  newest case would be new inconsistency, not completion; (3) the
  originating 9 tech-debt-ledger entries this plan closes never asked for
  automated post-rollback cleanup retry, only for `cleanupJournal()` to
  stop running unconditionally on failure — which this plan's design
  fully satisfies.
- **Revisit trigger**: a real operator incident where the manual-delete
  recourse proved insufficient or error-prone in practice, OR a
  dedicated follow-up plan that gives ALL of this file's blocking cases
  (foreign/corrupt/rollback-failed) one consistent resolution protocol
  together, rather than a one-off addition to the newest case alone.

**Deferred: symlink identity is not preserved through snapshot/rollback
(Gemini final-review finding, verdict `APPROVE` despite it).**

- **What's deferred**: Phase 1's snapshot loop (`fs.readFileSync`) and
  `rollbackPartialTransaction()`'s restore path (`fs.writeFileSync` +
  `fs.renameSync`) both operate on FILE CONTENT only — a symlinked
  target's snapshot captures the resolved target's bytes, and a rollback
  restores those bytes as a plain regular file, permanently destroying
  the original symlink. This is `fs.lstatSync`/`fs.readlinkSync`/
  `fs.symlinkSync`-shaped work: capture whether a target is a symlink and
  its link target, and restore via `fs.symlinkSync` instead of
  write+rename when it was one.
- **Why deferred, not fixed here**: this behavior is **entirely
  pre-existing** — `rollbackPartialTransaction()`'s write+rename restore
  path is untouched by this plan (this plan only changed its failure
  *tracking*, never its restore *mechanism*); a symlinked skill file was
  mishandled by rollback identically before this plan and after it. The
  plan's 9 originating ledger entries are about `cleanupJournal()`'s
  unconditional-cleanup bug, not snapshot fidelity — this finding is
  independent of everything this plan changes (the load-bearing test:
  none of this plan's new logic reads, writes, or depends on whether a
  target is a symlink). Gemini's own final verdict was `APPROVE` with
  this finding present, explicitly noting "it does not undermine the
  correctness of the primary WAL integrity fixes implemented here" and
  suggesting deferral to "a separate robustness iteration."
- **Revisit trigger**: a consumer repo's install surface begins using
  symlinked skill files (the mechanism this plan's own module already
  supports via the global/repo-scoped shared surface), making this a
  live risk rather than a latent one.

## Implementation Log

### 2026-07-27

- **Completed**: full implementation per this plan's final (round-7 plus
  Gemini-gate-round-3) design — `scripts/lib/install/transaction.mjs`
  (Phase 1 TOCTOU removal, discriminated `attemptDelete()`, rollback-failed
  marker written before mutation with the correct ENOENT scoping,
  context-aware `cleanupJournal()`, `recoverFromJournal()`'s expanded
  dispatch/failure-list handling) and `scripts/install-skills.mjs`
  (`reconcileJournals()`'s `recoveryFailures` exit, `main()`'s
  `deleteFailures` exit). ~20 new regression tests in
  `tests/install/transaction-hardening.test.mjs`. Full repo suite: 8800
  passed, 0 failed.
- **Code-audit (3 rounds) + Gemini gate**: converged PASS / APPROVE. One
  genuine finding surfaced and resolved during implementation review
  (Gemini's primary code-review pass): a test-quality nit where
  `path.join()` was silently collapsing the `..` payload a containment test
  meant to exercise — fixed by building the payload with a template literal
  instead. The one substantive code-level finding across both audits (the
  `isWithinAllowedRoots()` symlink+`..` gap) was pre-existing and out of
  scope — see the Out of Scope section above.
- **Remaining**: none for this plan's scope. The two explicitly deferred
  items (durable-rollback state machine; `isWithinAllowedRoots()`
  containment hardening) are tracked separately, not partially started.
- **Deviations**: none from the final round-7/Gemini-round-3 design — the
  implementation matches the plan's File-Level Plan section exactly,
  including the `context`-parameterized `cleanupJournal()` signature and
  the `deleteFailures`/`recoveryFailures` field names.
