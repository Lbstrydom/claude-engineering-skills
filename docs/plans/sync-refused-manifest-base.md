# Plan: the base-lag restore must not manufacture a divergence
- **Date**: 2026-11-18
- **Status**: Approved
- **Author**: Claude + Louis
- **Scope**: backend (Node ESM CLI lib `scripts/lib/sync-base-lag.mjs`; stack `js-ts`)
- **Target domain(s)**: `install`
- **Tier-3 seam**: the consumer sync / relocation contract (AGENTS.md §Testing doctrine). The fix and its test land in the SAME commit.
- **Fleet**: proposals `p-20261118013554-3260` (stated root cause) and `p-20261118010446-6353` (symptom).

**Neighbourhood considered**: `get-neighbourhood` (intent: "restrict the base-lag restore to sync-written paths the
fast-forward changes") returned one `precedent` (`above-floor-cluster`): `gitChangedFiles` in `scripts/nav-audit.mjs`. Opened
and NOT reused: it fails OPEN to `[]` on any git error, diffs against a merge-base it infers itself, and spawns git directly,
whereas this module routes every process call through an injected `run` so its failure branches are tested without a network.
A sibling helper inside `sync-base-lag.mjs` is the right home. The remaining hits were `review` band.

## 1. Context: the stated root cause is falsified; the real one is upstream of the manifest

The proposal says: for a path the sync REFUSES as diverged, the manifest pins the hash of the content it PLANNED to write.
**That does not reproduce on `ceea43d2` (= `f2e332e5` + a status-doc commit).** Measured through the real CLI against a
disposable git consumer (`tests/sync-refused-manifest-base-e2e.test.mjs`), seeding the manifest entry with a third value P so
the three candidates are distinguishable (P prior base, V outbound, Y disk): the refused path keeps P, on the first refusal and
the second, and once disk equals P the next sync updates it to V. **Negative control**: injecting the claimed bug
(`writtenHash.set` in the REFUSE branch, refused paths dropped from `notWrittenByUs`) turns 3 of 4 tests red with
`BUG: refused path recorded the PLANNED hash`; reverted, 4/4 green (21 s). `selectManifestBases`
(`scripts/lib/sync-gc.mjs:141`, `ceea43d2`) is correct. This is the second time this exact claim has been made and falsified
(#357, 2026-11-14).

**What storyline's evidence actually shows** (all read-only, `C:\GIT\storyline`, 2026-11-18):

| Evidence | Value |
|---|---|
| Last two receipted runs | `f3b37321` at 12:20Z on 11-17 (WROTE both files → `9d62e1da`/`7da3cf3b`); `f2e332e5` at 00:58:10.5Z on 11-18 (REFUSED both `diverged-committed`) |
| Manifest | `generatedAt 00:58:10.4Z`, `commitSha f2e332e5`: the refusing run is its last writer, so it carried `7c7aa973`/`d6cf0e45` FORWARD from a prior manifest |
| Upstream change | only `b6f0fca7` (#382, 11-17 17:08) touched these two files after `f3b37321`; any sync from ≥ #382 renders them to `7c7aa973`/`d6cf0e45` |
| mtime of exactly these two files | `2026-11-18 01:58:01.72 +0100`; every sibling in `fleet/references/` is older |
| storyline reflog | `01:58:01 merge ab3316d7: Fast-forward`, sync at 01:58:10 |
| `git diff 99459e2c ab3316d7` for the two files | **empty**: the fast-forward did not change them |

So at 01:58:01 the two files were rewritten to HEAD's bytes by something other than the fast-forward. That something is
`enforceBaseLag` (`scripts/lib/sync-base-lag.mjs:325`, `ceea43d2`), the pre-write step of the very sync that then refused them:

1. An earlier, unreceipted `npm run sync` from a CES commit ≥ #382 WROTE `7c7aa973`/`d6cf0e45` into storyline's tree (the
   sync never commits). The manifest recorded those hashes **correctly**: they were written.
2. The `f2e332e5` sync found storyline behind origin. `planBaseLag` classed the two dirty files as sync output (`classifyRepo`
   proves ownership AND that the bytes equal the manifest) and put them in `discard`. `executeBaseLagPlan` ran
   `git restore --source=HEAD --staged --worktree -- <discard>`, returning them to `9d62e1da`/`7da3cf3b`, then
   `merge --ff-only`.
3. The divergence gate then saw disk (`9d62e1da`, tracked, equal to HEAD) ≠ base (`7c7aa973`, our real last write) and refused
   `diverged-committed`, carrying the base forward, correctly by its own rules. Disk is now committed content that never
   changes, so **every later sync refuses again**: the self-sustaining loop the proposal observed, manufactured by the restore.

The restore's justification in the module header is *"they are what stops `git merge --ff-only` … this very run rewrites them,
so restoring them to HEAD first loses nothing"*. Both halves fail for a path the fast-forward does not touch:

- `git merge --ff-only` does NOT stop for a dirty path it does not change. Probed 2026-11-18 on git for Windows: a worktree-dirty
  AND a staged-dirty untouched path both fast-forward with exit 0, and the dirty bytes survive.
- "This run rewrites them" is a promise the divergence gate is free to break. After the restore, disk ≠ base, and the gate's
  whole job is to refuse exactly that shape.

Why the other synced files escaped: the `f2e332e5` run's 9 updates were files changed by #383–#388, which the earlier
unreceipted run (≤ #382) had not written, so they were not dirty and not restored. Wine and ai-organiser were either current
(no restore) or had no such dirty files, which is why only storyline and only this pair is affected (STO's census: 8 mismatches
= 1 self + 5 override-held + exactly this pair).

## 2. Proposed change

### 2.1 Restore only what the fast-forward needs (`planBaseLag` / `executeBaseLagPlan`)

The restore exists for one reason, to let `merge --ff-only` through, and git refuses a fast-forward only for a dirty path the
fast-forward CHANGES. So restore exactly `discard ∩ changedBy(HEAD, baseSha)`; leave every other sync-written dirty file in
place. It still holds bytes equal to our manifest base, so the write loop classifies it PRISTINE (unchanged, or an ordinary
update), exactly as if no lag had existed.

- **Pin both ends.** `gatherBaseFacts` already resolves `baseSha` to an oid, and `executeBaseLagPlan` already merges that oid
  (`merge --ff-only … facts.baseSha`, `sync-base-lag.mjs:328`, `ceea43d2`), not a ref. It additionally resolves `headSha`
  (`rev-parse --verify HEAD^{commit}`). The changed-path fact is computed between those two oids, and immediately before the
  restore the executor re-reads `rev-parse HEAD`; if it no longer equals `headSha`, it refuses (nothing restored) rather than
  restoring against a plan made for another commit. Syncs into one consumer are already serialised by the per-consumer lock
  (#387). A human editing the tree inside the plan-to-restore window is a pre-existing residual of the restore, which this
  change narrows (fewer paths destroyed) and does not widen.
- New pure helper `parseNameOnlyZ(stdout)` and a fact `ffChangedPaths`, gathered only when `lag === 'behind'`:
  `git diff --name-only -z --no-renames <headSha> <baseSha>`. `-z` so a path with spaces, a newline or non-ASCII is read
  exactly, not C-quoted; `--no-renames` so a rename is listed as its two real paths. **Same decoding as the other side**:
  `classifyRepo` reads `git status --porcelain=v1 -z` through `spawnSync(..., {encoding: 'utf-8'})` and `parsePorcelainZ`
  (`scripts/sync-status.mjs:100-112`, `ceea43d2`); the diff is read with the same encoding, so both sides are the same decoding
  of git's bytes and compare by string equality. **Lossy names fail closed**: UTF-8 decoding maps invalid bytes to U+FFFD, so two
  byte-distinct names can decode to one string and an untouched file could be selected for restore. If any decoded path in the
  diff output OR in `discard` contains U+FFFD, the fact is `null` (refuse; nothing restored). That also refuses a name that
  genuinely contains U+FFFD: conservative, and vanishingly rare in a synced bundle. **Complete or nothing**: a non-zero exit, a
  spawn error, or non-empty output that does not end in NUL makes the fact `null`.
- `planBaseLag` takes `ffChangedPaths: Set<string> | null` and returns `discard` filtered to it. **Fails closed**: `null` (the
  diff could not be read) REFUSES the fast-forward (`reason: 'unreadable-status'`, remedy names `git pull --ff-only`), the same
  shape as an unreadable classification. Falling back to "restore everything" would be today's bug; an unasked question is not
  a clean answer.
- Path comparison: both sides are git's own repo-relative, forward-slash output (`classifyRepo` reads `git status`), so the
  match is exact string equality. Not case-folded: git reports the index's casing on both sides, and folding would make a
  case-only rename on Windows match a path it does not name.
- **Index safety is unchanged and already enforced.** `discard` is built only from `classified.syncOwned`, and
  `classifyDirtyEntries` admits an entry there only when `hasUnambiguousIndexState` holds
  (`scripts/lib/sync-status.mjs:120-126,201`, `ceea43d2`): a status with a real change in BOTH columns (`MM`, `AM`) is never
  sync-owned, so the staged state of every path in `discard` is either HEAD or the verified sync bytes. The narrowing removes
  paths from the restore; it adds none.
- **Which manifest the gate reads.** `enforceBaseLagForTarget` runs at `sync-to-repos.mjs:788`; the prior manifest is read
  after it, at `:909` (`ceea43d2`), and the consumer manifest is gitignored by the sync's managed `.gitignore` block (storyline
  `.gitignore:20`). So the fast-forward cannot change the base the divergence gate reads, and a kept file's bytes still equal
  that base. Stated assumption: a consumer that still TRACKS its manifest (the legacy shape `sync-ownership.mjs` describes) could
  have it changed by the fast-forward; that shape is outside this fix and is listed in §5.
- The receipt and the other sync bookkeeping files are unaffected: they change on every landed sync, so when they are dirty
  they are normally ALSO changed by the fast-forward, and they are restored exactly as today.
- Messages: `realRunVerdictOf` and the `fast-forwarded` line already print `plan.discard.length`; they now count the narrowed
  set, and the real-run line adds `kept N sync-written file(s) the fast-forward does not touch` when N > 0, so an operator can
  see the dirty files were left on purpose.

### 2.2 What this does NOT change

- `selectManifestBases` and the manifest writer: verified correct (§1). No edit.
- The divergence gate's decision table. A path restored because the fast-forward changes it, whose new origin content differs
  from our base, is still refused, because then the difference genuinely came from origin commits; see §5 for the residual.
- Storyline's current stuck state. Its two files are now committed `9d62e1da`/`7da3cf3b` against base `7c7aa973`/`d6cf0e45`,
  and no restore will happen again for them, so this fix stops NEW instances but does not unstick the existing pair. Unsticking
  it is the coordinator's. The refusal's own remedies do not fit ("adopt upstream: revert your change": there is no consumer
  change, the committed bytes ARE an earlier upstream version). The principled unstick is to recognise them as such, which the
  existing prior-upstream check (proposal 2221) would do if it were asked for rewritten files. It is not asked (`sync-to-repos.mjs:1322`, `!rewriteResult.hits`), and both files carry rewrites.
  That gap is a separate finding (§6), not folded here: it is independent of this fix (the restore bug fires on unrewritten
  files too) and it is a larger change to a different module.

## 3. Sustainability

- One predicate, at the one place that destroys bytes. No new manifest field, no second classifier, no flag.
- The narrowing reduces what the only destructive step of the pre-write check touches, so the recovery snapshot
  (`git stash create`) covers a smaller set, never a larger one.

## 4. Testing strategy (Tier 3: same commit)

**Red first, against real git** (`tests/sync-base-lag.test.mjs`, section B, bare origin + clone + advancing clone, which
already exists):

1. **The defect, reproduced**: consumer clone has a tracked sync-written file F dirty with bytes equal to its manifest entry; a
   second clone advances origin with a commit that does NOT touch F. `enforceBaseLag` (real run) fast-forwards and **F keeps its
   dirty bytes** (red today: restored to HEAD). The fixture's `classify` stub reports F as `syncOwned`, as `classifyRepo` does.
2. **Still restores what blocks the fast-forward**: same, but origin's commit changes F → F is restored and the fast-forward
   succeeds (green today and after; guards against over-narrowing).
3. **Mixed**: two dirty sync-owned files, one touched (worktree-dirty, ` M`) and one untouched and STAGED (`M `) → only the
   touched one is restored; the staged untouched one keeps both its index and worktree bytes; the fast-forwarded line names the
   kept count.
4. **Fail closed**: a `run` that fails the `git diff --name-only` call, or returns output without a trailing NUL → plan is
   `refuse` / `unreadable-status`, nothing is restored (asserted on the tree bytes, not on the message).
5. **HEAD moved**: a `run` whose second `rev-parse HEAD` returns a different oid → refused, nothing restored.
6. **Pure**: `parseNameOnlyZ` on a `-z` buffer with a space, a newline-containing name, a non-ASCII name and a trailing NUL, and
   on a truncated buffer (→ `null`); a diff output or a `discard` entry containing U+FFFD (→ refuse, nothing restored; the
   injected `run` returns the decoded form, so this is tested on Windows too, where a real non-UTF-8 name cannot be created);
   `planBaseLag` with `ffChangedPaths: null` refuses, with an empty set keeps everything.

**End to end through the CLI** (extends the existing `sync-to-repos.mjs CLI - the lag is asked before the first write` block,
which already drives the real CLI against a lagging clone): sync 1 writes the bundle and is NOT committed; origin advances with
an unrelated commit; sync 2 must exit 0 with `divergenceRefused` empty and the formerly-dirty subject's manifest entry equal to
its bytes. Red today: sync 2 refuses the subject `diverged-committed`, which is the storyline loop exactly. The test first
asserts `git check-ignore` reports the fixture's manifest ignored, so it cannot pass against a tracked-manifest layout by
accident.

**Kept as a regression guard**: `tests/sync-refused-manifest-base-e2e.test.mjs` (the falsification above), so the next time
this claim is raised the answer is a test name, not a third investigation. It costs ~21 s; it joins `npm test` via the normal
glob (no DB, no enrolment).

**Negative control**: revert the §2.1 filter alone (one line) and re-run 1, 3 and the CLI e2e: they must go red, with the
failure naming the restored file. Recorded in the PR.

Full suite: per `fleet next` (`fullSuite` mode decides whether this session runs it or the train does).

## 5. Residual (stated, not fixed)

A dirty sync-written file that the fast-forward ALSO changes is restored, and after the fast-forward its bytes are origin's.
If origin's bytes are an EARLIER sync's output (an older sync PR landing after a newer unreceipted sync wrote the tree), disk ≠
base and the gate refuses it, the same loop by another route. That needs the prior-upstream check to cover rewritten files
(§6). Rarer than the reproduced case: it needs two syncs and an out-of-order PR merge.

A consumer that still TRACKS `scripts/.sync-manifest.json` (legacy) can have its base moved by the fast-forward itself; the gate
then reads origin's manifest. Unchanged by this fix in either direction, and not the storyline case (its manifest is ignored).

## 6. Findings recorded with `fleet propose` (not folded)

- The prior-upstream recognition (proposal 2221) is skipped for any rewritten destination
  (`sync-to-repos.mjs:1322` `!rewriteResult.hits`, and `sync-outbound.mjs:116`), so a consumer holding an EARLIER upstream
  version of a rewritten file is refused as if edited. That is what keeps storyline's pair stuck after this fix, and it is the §5
  residual's remedy. A candidate: render each earlier source blob through `renderOutbound` with the current `rewriteConfig`.
- An unreceipted sync's writes sit uncommitted in a consumer tree (the known "the sync never commits" design question in
  memory), which is the precondition of this bug. Already a Louis decision; referenced, not re-proposed.

## 7. Acceptance

- Tests 1, 3 and the CLI e2e red on `ceea43d2`, green after; 2, 4 and 5 green; the negative control reproduced.
- `/audit-code` converged with the final-review gate.
- No change to `selectManifestBases`, the manifest writer or the divergence decision table.

## Audit trail

- `/audit-plan` SID `audit-plan-1794979244762-105124`, 2026-11-18.
- R1 GPT: NEEDS_REVISION H:3 M:1. Accepted H1 (manifest read order traced), H3 (pinned HEAD/base oids, HEAD recheck), M1
  (same `-z` decoding, complete-or-nothing); H2 (index safety) rebutted, overruled by GPT deliberation
  (`hasUnambiguousIndexState` already keeps `MM`/`AM` out of `syncOwned`). Acceptance 75%.
- R2 GPT: H:1, lossy U+FFFD path identity, accepted (fail closed). Acceptance 100%.
- R3 GPT: READY_TO_IMPLEMENT H:0 M:0 L:0 (exit 0).
- Final gate round 1: APPROVE (gemini-4-argon), blocking 0, debt 0. Converged; no further rounds.

## Code audit trail (`/audit-code --scope diff`, SID `audit-code-1794981117127-64336`)

- R1 H:3 M:1: H1/M1 (touched file's incoming bytes vs base) dismissed by GPT deliberation, tracked as `p-20261118050838-b759`; H3
  (snapshot-to-restore race) severity-adjusted to MEDIUM, debt captured, `p-20261118060147-1077`; H2 (branch identity) fixed.
- R2 H:2 (rollback collided with kept files; identity check only when restoring) fixed. R3 H:3 (literal pathspecs, unpinned HEAD
  refused at planning, HEAD pinned before the lag) fixed. R4 H:1 M:1 (complete shell-safe recovery command) fixed. R5 H:1 M:1
  (quote the checkout path; assert the manifest base in the CLI e2e) fixed.
- R6 (the cap): PASS H:0 M:0 L:0. Structural card: 0 structural, 12 polish; STOP taken (one clean round at the cap, not two).
- Final gate round 1: APPROVE (gemini-4-argon), blocking 0, debt 0.
- Every fix landed with a test shown red on the old behaviour (negative controls in the commit history of
  `tests/sync-base-lag.test.mjs`).
