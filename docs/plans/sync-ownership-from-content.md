# Plan: Sync ownership from content, not a tracked artifact

- **Date**: 2026-07-20
- **Status**: Draft
- **Author**: Claude + Louis
- **Scope**: backend (sync collision guard + consumer manifest tracking; no UI)

> **Target domain**: `sync`. **Scope/stack**: backend · `js-ts`.
> **Origin**: wine-cellar-app stopped receiving synced tooling entirely
> (`14 unowned collision(s)`), with all 14 files provably ours. Corrects the
> diagnosis recorded in `9affd5b` (2026-07-19), which fixed two real defects but
> ruled out the actual mechanism.

## Problem

A consumer silently stops receiving synced tooling, permanently, with no error
at the time the damage is done.

Observed in wine-cellar-app on 2026-07-20: `npm run sync` aborted with
`14 unowned collision(s); will not overwrite`. All 14 were provably ours —
9 carried the upstream-owned banner, 5 were `.audit-loop` migrations
byte-identical to source. Zero consumer-authored files were involved.

The abort is the *symptom*, and it is correct behaviour. The defect is that
files we ourselves wrote became unowned.

## Root cause

A structural asymmetry between the files and the record that owns them:

| | Path | Git status |
|---|---|---|
| The files | `scripts/.claude-skills/`, `.audit-loop/migrations/` | **gitignored** (`.gitignore:217`, `:186`) |
| The ownership record | `scripts/.sync-manifest.json` | **tracked** |

The ownership record can move backwards in git history. The files it describes
cannot. So any `reset --hard`, branch checkout, or merge rolls the manifest back
while the gitignored files survive — and every file synced since that manifest
becomes an orphan.

`sync-to-repos.mjs` then classifies each orphan as an unowned collision and
`continue`s past the **whole target**, so one lost record stops every future
update to that consumer.

### Two distinct triggers, not one

1. **Uncommitted rollback.** Sync writes the manifest; it sits uncommitted until
   someone happens to commit it. A `reset --hard` in that window discards it.
2. **Merge divergence.** *This is the worse one.* The manifest is tracked, so
   different branches carry different committed copies, and merging them makes
   ownership a merge artifact — whichever branch's copy wins silently redefines
   which files the consumer owns.

Trigger 2 means "commit the manifest after every sync" is not a fix. It *feeds*
the problem: more branches syncing means more divergent committed records to
scramble.

### Evidence

Direct observation, wine-cellar-app, 2026-07-20:

- Adopted 14 orphans and wrote a manifest at 14:43 (548 files).
- ~30 min later the on-disk manifest read **07-19 19:00, 540 files** — a *third*
  committed version, pulled in by `5c3758bc Merge main into
  feat/data-access-layer-review`. The record moved **backwards in time**.
- Re-running adopt after that merge reported **8** orphans, not 14 — the orphan
  set is a function of which manifest won the merge.

Supporting, from the reflog — orphan write-times bracketed by tree-mutating ops:

```
07-19 15:33     sync writes provider-readiness.mjs   (gitignored — survives)
07-19 15:52:41  reset: moving to HEAD                 (manifest discarded)
07-19 15:52:47  rebase (start): checkout origin/main
```

Orphan mtimes 07-19 15:33 / 20:19 / 22:22 and 07-20 12:07 sit among branch
checkouts at 15:46, 15:54, 16:09, 16:20, a rebase at 16:37, and `checkout main`
+ pull at 16:43.

Caveat: the reflog logs `reset: moving to HEAD` for both `--hard` and mixed
resets, and only `--hard` discards working-tree changes — so no single reflog
line is provably the culprit. It does not need to be: the merge in the first
bullet was observed directly.

## Correction to `9affd5b`

`9affd5b` ("a failed ownership record must fail the sync, not vanish") fixed two
real defects — a manifest-write failure that reported success, and unconditional
deletion of the recovery journal — and both fixes should stand.

But its stated conclusion is wrong and will mislead the next reader:

> The consumer's tree was clean and its committed manifest was the 08:55 one,
> ruling out a consumer-side revert.

That reasoning is inverted. A clean tree whose committed manifest is the *old*
one is the **signature** of a revert, not a refutation — post-revert the tree is
clean precisely *because* the newer manifest was discarded. The observation it
cites as exculpatory is the primary evidence for the mechanism.

This is why the same damage recurred on a different consumer five weeks later:
the fix addressed a failure mode that was real but not the one biting us, and
the journal-based self-heal it added cannot help here, because these syncs
**succeed** — the journal is correctly deleted, and the rollback happens
afterwards, outside sync's lifetime entirely.

**Action**: add a correction note to this plan's Evidence section (done above)
and reference it from the `9affd5b` follow-up so the misdiagnosis does not get
re-derived.

## Fix

### A. Derive ownership from file content (primary)

Ownership should be a property of the bytes on disk, not of a revertible tracked
artifact. The mechanism already exists and is already trusted: `--adopt-orphans`
reports provenance per file *without consulting the manifest*, and did so
correctly for all 14.

Change the collision guard so an orphan is auto-adopted when it is provably
ours, and aborts only when it is not:

- **Banner-carrying files** → provably ours. A consumer-authored file cannot
  carry the upstream banner. Reuse `BANNER_MARKER` (already normalised at one
  place, pinned by `tests/sync-ownership-recording.test.mjs`).
- **`.audit-loop/migrations/*.sql`** → no banner (SQL is not banner-injected).
  Fall back to a hash against the source file; all 5 were byte-identical, so the
  comparison is exact, not fuzzy. Alternatively add SQL `--` banner support and
  collapse to one rule — decide during implementation, preferring the single
  rule if the migrations' `eol=lf` pin makes hashing stable.
- **Anything else** → abort exactly as today. The guard keeps its real job:
  protecting genuine consumer files.

The manifest stays as the record of *what was synced* (drift reporting, GC,
`sync:dry`). It stops being the arbiter of *who owns a file*.

### B. Untrack the consumer manifest (secondary)

With ownership no longer depending on it, the manifest has no reason to be
tracked, and tracking is what exposes it to merge divergence.

Verified safe on the main consumer: `sync-isolation-verify.mjs` reads the
consumer manifest **from disk**, not from git ("reads the consumer's manifest as
the source of truth and never scans the source repo's filesystem"). Untracking
leaves it on disk, regenerated by every sync.

Consistent with existing doctrine — `docs/runbooks/consumer-adoption.md` already
states a fresh clone must re-run `npm run sync` to hydrate.

**Must verify before landing**: Gate 2A ("Tracked-diff whitelist") and Gate 6
("Manifest layout === 'isolated'") — confirm neither asserts the manifest is
*tracked*. If one does, adjust the gate rather than keeping the file tracked.

Note this also removes per-push churn in consumers, matching the reasoning that
already gitignores the SOURCE repo's own manifest (AGENTS.md, generated-artifact
policy Category A).

## Acceptance criteria

1. A sync into a consumer whose manifest has been reverted to an older committed
   version completes successfully, auto-adopting banner-provable orphans, and
   reports what it adopted.
2. A genuinely foreign file at a destination under `scripts/.claude-skills/`
   still aborts the target.
3. The consumer manifest is untracked, and `sync-isolation-verify` passes all
   gates against a consumer hydrated purely by sync.
4. A regression test drives the real banner injector (extending
   `tests/sync-ownership-recording.test.mjs`) and covers: banner file adopted,
   migration adopted by hash, unbannered non-migration file aborts.

## Risks

- **Weakening a safety guard.** Mitigated by the fact that the banner is a
  stronger ownership signal than the manifest ever was: it travels with the file
  and cannot be reverted, whereas the manifest demonstrably can. The abort path
  is preserved for everything not provably ours.
- **Hash-based migration adoption is brittle if a consumer edits a migration.**
  That edit is already forbidden (upstream-owned governance) and would now abort
  rather than be silently overwritten — arguably an improvement.

## Interim state

wine-cellar-app was unblocked on 2026-07-20 by `--adopt-orphans` + an immediate
commit (`9fd465cf`). Verified zero orphans, sync restored. This holds only until
the next cross-branch merge.

## Out of scope

The `copyForwardUntouchedFiles` justification-column defect
(`scripts/lib/store/arch/symbols.mjs:320`) surfaced during this investigation and
is confirmed — the SELECT/INSERT carries 7 columns and drops all four
`duplicate_justification*` columns, which land on
`duplicate_justified BOOLEAN NOT NULL DEFAULT false`
(`20260715120000_symbol_duplicate_justification.sql:18`). Unrelated to sync
ownership; tracked separately.
