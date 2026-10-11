# Plan: fleet — catch abandoned worktree work regularly, and remove account-switch friction
- **Date**: 2026-10-11
- **Status**: Draft
- **Author**: Claude + Louis
- **Scope**: backend (fleet CLI + skill prose; no UI) · stack `js-ts` (`detect-stack`: `js-ts`)
- **Target domain(s)**: `fleet`, `shared-lib`
- ⚠ **Cross-domain work**: `fleet` imports one constant, `RECEIPT_PATH`, from `scripts/lib/sync-receipt.mjs` (`shared-lib`, no imports of its own). `fleet → shared-lib` is a declared edge (`allowedDeps.fleet = ["shared-lib"]` in `.audit-loop/domain-map.json`). Intentional.
- **Depends on**: docs/plans/fleet-handover.md — the unregistered-work predicate (#198) that this plan moves and extends; already landed.

**One word, everywhere: "unregistered work".** The brief called it "unclaimed". The persisted handover manifest field is `unregistered`, and receivers' prompts already say "Unregistered work", so every surface this plan adds uses that term. Only this file's name keeps "unclaimed".

## 0. Decisions at a glance

| Item | Decision | Phase |
|---|---|---|
| **h** live-session defect | Fix first. Handover reads the same merged evidence as `status`; merged-but-unreleased claims are listed as "release these" | 1 |
| **i, n, g** classification | One verdict per unregistered worktree from an ordered contract: `unlanded` · `superseded` · `unverified` · `sync-owned`. Candidates include clean, pushed, unlanded worktrees. Only work with no copy outside this worktree, and unmeasured work, blocks a handover | 2 |
| Part 1.1 status section | Added. Not subject to the 14-day idle hide, which today hides exactly the unlanded, clean, idle work. `status` writes a derived cache | 3 |
| Part 1.2 footer | Reads the cache only (no scan, so no bound to miss). Two lines: an FYI when abandoned work is known, and a request to run `fleet status` when the scan is more than 24 h old or partial | 3 |
| Part 1.3 `fleet archive` | Dry run by default; `--apply` snapshots deterministically to a temporary index, tags, verifies, revalidates under the registry lock, then removes. Refuses anything it cannot preserve. Branch is never deleted | 4 |
| **a, b, j** binding | `claim --worktree`; `add` records the worktree; `release` resolves it by branch (the one reader that does not); warn when id ≠ bound branch | 5 |
| **c** stale tooling | Warn when a hydrated worktree's bundle stamp trails the main checkout's, and name `npm run skills:hydrate` on an unknown verb | 6 |
| **e** gh reachability | Free: reuse the merged-PR query's `queried`/`reason` already in `facts.merged.prs`. No extra `gh` call | 6 |
| **l** stale manifest | `receive` refuses when a newer manifest sits beside the one given, unless `--allow-older`. No "keep latest N" | 6 |
| **d, k** | Prose only (same permission mode; confirm one-offs). Schedule metadata is unreadable, so no date parsing | 7 |
| **f** | Declined. Prepare stays a read-mostly verb; #198's coordinator chips replaced the pasted checkpoint message | — |
| **m** | Measured during planning (§1b). The cross-config-root copy path works; this machine's switch did not change the config root | — |
| 8 `archive/*` tags | Spin out as its own task. Part 1.1 makes them visible meanwhile | — |

## 1. Context Summary

The 2026-10-11 account switch swept every worktree by hand and found 17 that held work no claim covered: 9 superseded, 8 abandoned on 27 Sep to 3 Oct. Nothing in fleet catches that regularly. The Agent-tool worktrees are never claimed, and `fleet status` already lists them, but as undifferentiated untracked items.

### 1a. What exists today (Code Trace, read at `0e287fbd`)

- **The predicate.** `scripts/lib/fleet/handover.mjs:234` `unregisteredWork` lists worktrees no live claim covers (`:241`) that hold staged, unstaged or untracked files or unpushed commits. It probes each one with the full `archiveReport` (`:244`).
- **The probe.** `scripts/lib/fleet/lifecycle.mjs:136` `archiveReport` makes `status`, `status --ignored=traditional` (`:154`), `ls-files -v`, a size walk over untracked and ignored paths (`:164`), `rev-list HEAD --not --remotes`, and `stash list`. `unregisteredWork` then discards the ignored result (`RISK_KINDS` has no `ignored`).
- **The handover state.** `handover.mjs:255` `repoState` builds the live-session list with `gatherFacts({…, merged: false})` (`:272`). `facts.mjs:122` defaults `merged` to `'all'` for the full view that `status` renders. `overlap.mjs:546` `mergedDone` therefore never retires anything in the handover. `receiveHandover` reads the raw registry instead (`:563`).
- **Evidence helpers.** `merged-facts.mjs:154` `mergedEvidenceFor` is the one merged predicate. `overlap.mjs:836` `hideReason` and `prune.mjs:45` `planPrune` already use it (`ahead 0` → `merged`; evidence → `landed`).
- **The status hide.** `overlap.mjs:836-846` hides an untracked branch as `idle` when `ahead` is known, the tip is older than `hideIdleAfterDays` (default 14, `config.mjs:85`), there is no open PR and the worktree is clean. That is **unlanded, committed, idle work**, which the default view folds into "N hidden".
- **Registration.** `commands.mjs:177` `cmdClaim` always binds `currentBranch(cwd)` (`:184`) and the cwd's toplevel (`:225`). `cmdAdd` (`:249`) writes `worktree: null` (`:301`). `lifecycle.mjs:48` `cmdRelease` runs `archiveReport(ctx, { session })` (`:61`), which takes `session.worktree` as given.
- **Dispatch and footer.** `scripts/fleet.mjs:115` dispatches `archive-check`; `:127` appends `checkpointFooter` (`coordination.mjs:65`) after `claim`, `touch` and `ready`. Flag tables: `argv.mjs:16` `VERBS`.
- **Subprocess seam.** `git-facts.mjs:48` `runGit` sanitises git's environment and accepts no `env`.
- **Sync receipt.** `scripts/lib/sync-pr.mjs:20-24` records a decision: a receipt-only change never earns a PR. `sync-receipt.mjs:77` exports `RECEIPT_PATH`.

### 1b. Measured figures (2026-10-11, `0e287fbd`; scratch scripts, not committed)

| # | Figure | Label | Command / source |
|---|---|---|---|
| M1 | `unregisteredWork` wall time: CEE 13 worktrees 3.6 s; wine 23 → 17.2 s; storyline 15 → 13.8 s; ai-organiser 2 → 0.9 s (≈ 280 to 920 ms per worktree) | measured | in-process timing of `unregisteredWork(repo, …)` |
| M2 | On wine's main checkout `status --ignored=traditional` costs 3910 ms; the other five calls cost 31 to 63 ms each. On CEE: 775 ms vs 24 to 43 ms | measured | `spawnSync` timing of the git argv `archiveReport` runs |
| M3 | A light probe (no ignored scan, no size walk) ≈ 150 ms per worktree, so ≈ 3.5 s for wine's 23 | **derived** from M2; re-measure in Phase 2 | sum of M2's four remaining calls |
| M4 | `git tag -l 'archive/*'` → 8 tags | measured | git |
| M5 | 13 scheduled tasks; all 13 have frontmatter `name` + `description` only (no schedule); 6 of 13 descriptions say one-time/one-off | measured | scan of `~/.claude/scheduled-tasks/*/SKILL.md` |
| M6 | A date regex over those descriptions **missed** "Monday 5 October 2026" (an expired one-off). The instrument is unreliable, so no date parsing is planned | measured (instrument defect) | same scan |
| M7 | `CLAUDE_CONFIG_DIR` is unset; this session's memory dir is under `C:\Users\User\.claude`. `handover receive --dry-run` here ran in **`same-config-root`** mode: 713 verified, 0 changed | measured | `node scripts/fleet.mjs handover receive --from <manifest> --dry-run` |
| M8 | The same receive into a **scratch** config root ran in `copy` mode: 713 copied, 0 conflicts, 0 errors; 713 files on disk across 4 project dirs | measured | `CLAUDE_CONFIG_DIR=<scratch> node scripts/fleet.mjs handover receive --from <manifest>` |
| M9 | Defect h on live data today: raw non-terminal = handover-live = status-live in all three repos (2/2/2, 2/2/2, 5/5/5). The 21 stale claims were released by hand, so it **cannot be reproduced live**; it needs a fixture | measured | in-process `gatherFacts` with `merged:false` vs `'all'` |
| M10 | The receive just run flags 2 items: this session's harness worktree `elegant-volhard-cf100d` (4 "unpushed" — the same patch as my branch; `fleet status` prints `DUPLICATE patch`) and a storyline worktree (12 unpushed) | measured | same receive |
| M11 | `.git/fleet/handover/` holds 14 files, 1.6 MB | measured | `ls -la` |
| M12 | Registry record `drift-backlog-refresh-2026-10-11` has `source.branch` equal to its own id. No branch of that name exists; the real branch is `docs/drift-backlog-records-2026-10-11` | measured | `git branch -a --list '*drift-backlog*'` |

### 1c. Where the brief is wrong or silent (corrections that change the design)

| Brief claim | What the code and measurements say | Consequence |
|---|---|---|
| a: "`status` and `claim` do not resolve a worktree for an adopted session" | `buildStatus` falls back to the branch's worktree (`worktree: s.worktree ?? wt?.path`) and `probeSessionWorktrees` does too (`facts.mjs:315`). **`release` is the one reader that does not** (`lifecycle.mjs:61`). With `worktree: null` it skips every worktree probe, so an adopted session with a dirty worktree reads **CLEAN** (derived; pin with a red test) | Fix the read side as well as the write side |
| j: "`claim` records the source branch whenever it differs from the id" | It **always** records the cwd's current branch. The failure is a claim run from the wrong worktree binding the wrong branch silently (M12: a branch that does not exist, so `mergedEvidenceFor` gets `tipOid: null` and never retires it) | Warn on id ≠ bound branch; `--worktree` binds the right one |
| Part 1.1: "reuse `unregisteredWork`" | Reuse, but its probe is the cost (M1, M2) and `status`'s `idle` hide must not apply to the new section | Light probe; section independent of the idle hide |
| g option A: commit receipt-only changes in a rolling PR | Contradicts `sync-pr.mjs:20-24`, which chose not to open a PR for a receipt that changes on every sync | Option B only: classify `sync-owned` |
| k: "from the task's own schedule metadata, where readable" | Not readable (M5); date parsing is unreliable (M6) | Prose + a labelled one-off hint |
| l: "keep the latest N" | 14 files, 1.6 MB (M11). Deleting handover artefacts adds risk for no gain | Receive guard only |
| m: "the first receive in the new account is the empirical check" | The new account shares the old config root (M7), so a real cross-root receive does not exist on this machine. The copy path was exercised against the real manifest anyway (M8) | Recorded here; nothing left to wait for |
| d: "list sessions whose permission mode differs, if the host exposes it" | Only the desktop app's MCP tools can read a mode; no CLI can | Prose only |

### 1d. Neighbourhood considered

`get-neighbourhood` over `handover.mjs` and `status` paths returned 8 candidates, all `review` (below this repo's noise floor, `bandReason: fallback-normalization-uncalibrated`), none in `fleet`. The nearest are `sweepStaleSandboxes` (`prepush-sandbox-cleanup.mjs`, a swept-vs-failed outcome shape) and `checkRegistryParity` (a registered/stale/orphaned/unregistered classification). Both are in other domains and operate on directories and DB rows, not git worktrees, so this plan is greenfield inside `fleet` and borrows only the "report a failed removal as a failure" shape.

## 2. Proposed Architecture

```mermaid
graph LR
  CLI["scripts/fleet.mjs dispatcher"] --> STATUS["cmdStatus (commands.mjs)"]
  CLI --> FOOT["checkpointFooter (coordination.mjs)"]
  CLI --> ARCH["cmdArchive (archive.mjs, new)"]
  CLI --> HAND["cmdHandover (handover.mjs)"]
  STATUS --> UNREG["unregistered.mjs (new): scan, verdict, cache"]
  FOOT --> UNREG
  HAND --> UNREG
  ARCH --> UNREG
  UNREG --> RPT["archiveReport (lifecycle.mjs) with scanIgnored false"]
  UNREG --> EVID["gatherFacts merged evidence (facts.mjs, merged-facts.mjs)"]
  UNREG --> LAND["landedReason (overlap.mjs, shared with hideReason)"]
  ARCH --> RPT
  UNREG --> CACHE[("fleet/unregistered.json, derived")]
```

### 2.1 One verdict per unregistered worktree (`scripts/lib/fleet/unregistered.mjs`, new)

`unregisteredWork` moves here from `handover.mjs` (one predicate; #1, #10) and returns items enriched with a pure verdict (#7, #11).

**Candidates.** Every worktree (not bare, missing or prunable) that no live claim covers. Today's predicate only selects a worktree that is dirty or holds *unpushed* commits, so a clean worktree whose commits were pushed but never landed is invisible, and that is exactly the work the idle hide buries. Selection is therefore independent of push status: each candidate is described by three separate facts, and a candidate with nothing local and nothing off base is simply not listed.

- **L, local changes**: staged, unstaged and untracked paths, with `SYNC_OWNED_PATHS` (the receipt) split out.
- **C, committed work off base**: `none` (the tip is contained in the measured base), `pushed` (commits not on base, but a remote ref holds them), `unpushed` (no remote ref holds them), or `unknown`. `ahead` comes free from `facts.branches`; push placement is the existing `rev-list HEAD --not --remotes`.
- **E, evidence**: `landed` (`landedReason` on the exact tip), `duplicate` (the whole-diff patch-id equals that of a branch a **live claim** covers), `none`, or `incomplete` (`gh` not queried, squash window short).

**Ordered contract; the first matching row wins.**

| # | Condition | Verdict | Blocks handover? |
|---|---|---|---|
| 1a | Any probe failed or was skipped, so L is not known to be empty, **or** C is `unknown` | `unverified` | **yes**: a failed probe proves nothing, so nothing is assumed safe |
| 1b | L is known empty, C is `unpushed`, and E is `incomplete` | `unverified` | yes (the commits exist only here and their landing is unknown) |
| 1c | L is known empty, C is **known** `pushed`, and E is `incomplete` | `unverified` | no: a remote holds the commits; only whether they landed is unknown |
| 2 | L (receipt excluded) is non-empty | `unlanded`, reason "N uncommitted files", noting if the committed part is landed | yes (the files exist nowhere else) |
| 3 | C has commits and E is `landed` or `duplicate` | `superseded`, with `via` (L is already empty here, so a duplicate never rests on a dirty tree) | no, listed as removable (the commands are `fleet prune`'s) |
| 4 | C has commits and E is `none` | `unlanded`, `preserved: remote` when C is `pushed` | yes only when C is `unpushed` |
| 5 | Only the receipt is dirty and C is `none` | `sync-owned` | no, listed with its reason |

The receipt discount applies to **L alone**: receipt-plus-unlanded-commits is row 4, not row 5. A receipt left dirty beside any other verdict is carried as `syncOwnedDirty: true`, so `fleet prune` and `archive` still see it. Rows 2 to 4 are *possibly abandoned* once idle longer than `staleWorktreeDays`; rows 1a and 1b are too, since they block.

- **Evidence.** Callers pass the `facts` they already gathered, so the module makes no extra git or gh call for evidence. Status has `merged:'all'`. Handover builds facts with `merged: <worktree branch names>`. Missing evidence yields row 1, never `superseded` (an unasked question is not an empty answer).
- **Shared landed predicate.** `hideReason`'s two lines become an exported `landedReason(item)` in `overlap.mjs`, used by `hideReason`, `planPrune` and the verdict, so "is this tip on base" has one spelling (#10).
- **Light probe.** `archiveReport` gains `scanIgnored = true` and `probeTimeoutMs = 30000`. The scan passes `scanIgnored:false`, which skips the `--ignored` status call and the size walk. The predicate never used their result, and they are the measured cost (M2). `ls-files -v` stays, so skip-worktree still makes an item `unverified`. Defaults leave `release`, `archive-check` and `prune` byte-identical.
- **Idle age.** `lastActivity = max(HEAD commit time, newest mtime among the first 200 dirty paths)`, run through `isIdleTip(…, staleWorktreeDays)`. An unknown or future-dated time is **not** stale, matching `isIdleTip`. Config key `staleWorktreeDays` (default 3, 1 to 3650) sits beside `hideIdleAfterDays`.
- **Bound: one absolute deadline.** The scan takes `deadlineAt` (status 60 s, handover 120 s from its start). Every subprocess gets `timeoutMs = min(its own cap, deadlineAt − now)`, and the mtime stats and the archive-tag scan stop when it passes, so a slow probe cannot overrun the budget it was started inside. There is **no worktree-count cap**. Candidates are probed **oldest tip first**, a heuristic that front-loads the likeliest abandoned work (the idle age also counts dirty-file mtimes, which are only known after a probe, so the order is not exact). **There is no progress or fairness guarantee, and none is claimed**: with an unchanged set that overflows the budget, the same suffix stays unprobed on every run. What is guaranteed is disclosure, never silence: `partial`, `notProbed` and the footer's refresh request all say so. The overflow is not realistic at the measured cost (≈ 0.15 to 1 s per worktree puts the 60 s budget at 60 to 400 worktrees; the largest estate measured has 23), and a persisted rotation cursor for it would be the over-built answer. What was not reached is returned as `notProbed: n` with `partial: true`; handover treats it as NOT MEASURED (fail closed). At the measured ≈ 0.15 to 1 s per worktree the budget covers 60 or more; an estate beyond that reports partial rather than pretending.
- **Archived, unlanded.** `git for-each-ref --no-merged=<base> refs/tags/archive` lists archive tags not contained in base. Each is checked by whole-diff patch-id against the squash window (`patchId`, `squashPatchIds`); a match is `superseded`, and so is a tag whose whole diff against its merge-base with base is **empty** (nothing left to land); otherwise `unlanded` (≤ 50 tags; overflow is reported). Without this, `fleet archive` would move work from a noisy place to a silent one.

### 2.2 Surfaces

- **Status section (Part 1.1).** After the items and the "N hidden" line:

  ```text
  Unregistered work — 7 worktrees hold work no live claim covers
    possibly abandoned (idle > 3d, unlanded) — 3
      worktree-agent-a17ae…  idle 8d · 4 unpushed, 2 untracked · C:/…/agent-a17ae…
    superseded (on base — removable, see fleet prune) — 2
    fresh (idle ≤ 3d) — 2
    archive tags holding commits not on base — 8
  ```

  `possibly abandoned` and `unverified` items are listed in full; the other groups are counts (`--all` lists them). `--json` carries `status.unregistered`. The section ignores `hideReason`'s `idle`, and the "N hidden" line gains "(k of them unlanded — see Unregistered work)" so the two views agree. Fresh unclaimed desktop worktrees are counted, never alarmed.
- **Footer (Part 1.2): reads a cache, never scans.** `status` writes `fleet/unregistered.json`, a **derived Category-A file** beside `hold.json` (`{schemaVersion, at, staleDays, partial, notProbed, counts}`, zod `.strict()`, written with `atomicWriteFileSync`, never committed). `cmdStatus` still takes no lock and writes no registry state; the cache is a derived artefact like the telemetry spool `status` already writes, and a failed write is a `warning:` line, not a failure. `checkpointFooter` then prints up to two lines:
  - **FYI**, when `counts.abandoned > 0`: `FYI for the user/coordinator, not an action for this session: 3 worktree(s) idle >3d hold unlanded work — fleet status (scan 2h old)`.
  - **Refresh request**, when the cache is missing, unreadable, older than 24 h, or `partial` (even with zero abandoned, so an unmeasured suffix is never silent): `unregistered-work scan is 2d old (or: missing / incomplete, 4 not probed) — run \`fleet status\` (read-only) to refresh`.

  Why no scan in `claim`/`touch`/`ready`: a scan there needs a deadline, rotation and a thundering-herd answer (several sessions crossing a TTL together), and the audit (M1, M2) showed each is real. Reading a file has none of them, and the refresh request turns the first checkpoint after 24 h into the trigger for one `status` run. A corrupt cache prints the refresh request and cannot change a verb's exit code. Archive tags stay out of the footer (they would nag for weeks).
- **Why the wording matters.** The user pre-authorises acting without asking only on `next`'s `DO` lines. A footer line that reads like an instruction would send chip sessions off to inspect other sessions' worktrees. The line says whose it is, and `participant-rules.md` states it is not a `DO`.

### 2.3 `fleet archive <worktree|branch|path|id> [--apply] [--discard-ignored]` (`archive.mjs`, new)

```mermaid
graph TD
  A["resolve target via resolveArchiveTarget"] --> B["refuse: main checkout, this worktree, locked, live claim, not in git worktree list, .gitmodules, any unverified"]
  B --> C["full archiveReport over the preservation set: refuse partially staged, unmerged, ignored without discard-ignored, sensitive, over 50 MiB or unmeasured"]
  C --> D["dry run stops here and prints the plan"]
  C --> E["snapshot: temp index, fixed identity and date, add -A, write-tree, commit-tree parent HEAD"]
  E --> F["tag archive/branch, verify tag tree equals written tree"]
  F --> G["under the registry lock: revalidate HEAD, branch, porcelain status and no live claim"]
  G --> H["git worktree remove --force"]
  H --> I["check directory gone, else report leftover"]
```

- **Preservation set and refusals (#12).** The set is every staged, unstaged and untracked path from the full `archiveReport`. The verb refuses, naming the paths and the remedy ("stage everything with `git add -A` in that worktree, or reset the index, then re-run"), when:
  - a path is **partially staged** (staged *and* changed again in the working tree): a working-tree snapshot would silently drop the staged version, so it cannot be preserved losslessly;
  - the index has **unmerged entries** (`git ls-files -u`);
  - **any** gitignored path outside `archiveIgnore` exists, in a mixed tree as much as an ignored-only one, unless `--discard-ignored` is given; the result lists every discarded path either way;
  - `.gitmodules` exists, any probe is `unverified`, or the preservation set is over 50 MiB or its size could not be measured (the size walk covers all dirty paths, not only untracked ones).
- **Snapshot without side effects, and deterministic (#13, #14).** `GIT_INDEX_FILE=<tmp>`, `read-tree HEAD`, `add -A`, `write-tree`, `commit-tree <tree> -p HEAD` with a **fixed identity** (`fleet archive <fleet-archive@localhost>`), a fixed message, and author and committer dates set to HEAD's commit date. The same tree, parent, identity and date give the same oid on every retry, and the run no longer needs `user.name` configured. **When the preservation set is empty there is no snapshot commit**: the tag points at HEAD itself, so archiving a clean worktree whose tip is already on base cannot mint a commit that the archive-tag scan would then call unlanded. No hook runs, and the branch and worktree are untouched until the removal step. `runGit` accepts an `env` limited to an allowlist (`GIT_INDEX_FILE`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*`) (`git-facts.mjs:48`).
- **Tag.** `archive/<branch>` (detached: `archive/<worktree basename>`); if that name exists at another oid, append `-<short oid>`. A tag already at the same oid is reused, which the deterministic snapshot now makes a real case. Lightweight, matching the 8 existing tags. Tags are local; nothing pushes them.
- **Revalidate, then remove (#14).** Immediately before removal, inside `transact` (the registry lock, so no `claim` can register this worktree meanwhile), the verb re-reads and compares: HEAD oid and branch against the capture, the full `status --porcelain=v1 -z --untracked-files=all` output byte-for-byte against the capture the snapshot was built from, that no live claim covers the worktree or branch, and that the tag still resolves to the verified tree. Any mismatch aborts with the tag and the worktree kept (exit 3, "changed since the snapshot"). Only then `git worktree remove --force`. The remaining window is edits in the milliseconds between that compare and the delete; coordination here is cooperative, not enforced, and the verb says so rather than claiming quiescence.
- **Outcomes and retries.** Artefacts left by stage: before the tag, none; after it, the tag only; after a failed removal, the tag plus the worktree (or a `leftover: <path>` directory when a file lock stopped the delete, the storyline case; exit 1, never "success"). A re-run with the worktree still there and unchanged recreates the same oid and reuses the tag. After a successful removal the target resolves to a branch with no worktree. The verb then lists **every** tag named `archive/<branch>` or `archive/<branch>-<short oid>` with its oid and date and prints `already archived — N tag(s)` (exit 0); it never claims which one the completed removal used, because a failed first attempt can leave an older tag beside the one that was current at removal (snapshot A tagged, removal failed, more edits, snapshot B tagged with a suffix and removed). With no such tag it refuses with "no worktree to archive". The branch is never deleted.
- **No restore verb, no expiry** (`git checkout archive/x` already restores).

### 2.4 Registration and handover (Phases 1, 5, 6)

- **h.** `repoState` passes `merged: [every worktree branch, every registered branch]`. Derived-done claims drop out of `sessions`. Claims whose branch is merged but whose registry record is still non-terminal are listed as `mergedUnreleased` with the exact `release --id …` command, and `receive` derives live sessions through the same function (`liveSessionsOf`). The manifest gains optional fields (the schema is `.strict()`, so each addition is declared): `mergedUnreleased`, `gh`, and per unregistered item `verdict`, `via`, `idleDays`.
- **e.** `gh: { queried, reason }` per repo is `facts.merged.prs` verbatim. A repo with `queried:false` prints "PR state unknown — sign in to gh with an account that can read `<owner>/<repo>`" (owner and repo from `origin`, one git call). `sync-pr.mjs`'s `parseGhAccounts` is not reused: it lives in a module whose imports would enlarge every consumer's synced closure. `receive` re-measures and lists it as a human step.
- **l.** `receive` lists sibling `handover-*.json` in the `--from` directory; any id greater than the given one refuses (exit 3) unless `--allow-older`. Ids sort chronologically (`OP_ID_RE`); an unparseable sibling name is ignored.
- **a, b, j.** `claim --worktree <path>` must be a listed, present worktree of this repo (realpath compared); its checked-out branch becomes `source.branch`, and a detached one needs `--id` and binds no branch (warned). With no flag the behaviour is unchanged, plus a warning when the id ≠ the bound branch ("merged evidence retires a claim by its BRANCH"). An adopted session whose `worktree` is `null` can be filled once (never re-pointed). `add` records the branch's worktree (`gatherFacts` with `worktrees:true`). `release` resolves the worktree through `resolveArchiveTarget`'s branch fallback.
- **c.** `bundle-stamp.mjs`: when fleet runs from a `.claude-skills` tree inside a **linked** worktree, compare its `scripts/.sync-manifest.json` (`commitSha`, `generatedAt`) with the main checkout's. A missing or older stamp prints one stderr warning naming `npm run skills:hydrate`; an unknown-verb error repeats the hint (where `release` was missing). stderr only, so `--json` stays clean. The source repo runs tracked `scripts/` and is skipped.
- **d, k.** The coordination prompt gains "put coordinators in the same permission mode before posting anything" and "a scheduled task's schedule is not in its file; confirm every one-off". Tasks whose description matches `/one[- ]?(time|off)|\bonce\b/i` are marked `(one-off — confirm it is still wanted)`: a labelled text hint, no date arithmetic.

### 2.5 Right-sizing (three lines each)

| New structure | Band-aid | Over-built | Chosen, and the current requirement |
|---|---|---|---|
| `unregistered.mjs` + `unregistered.json` | Print the "N hidden" line louder or cut `hideIdleAfterDays` | A scheduler/daemon, or a per-worktree registry record | One pure verdict, the moved predicate, and a derived cache. Requirement: the 2026-10-11 sweep took a coordinator round trip per item, and a footer at M1 cost per call is unusable |
| `fleet archive` | A runbook of four git commands (today's manual state) | Restore verb, expiry, remote archive repo | One verb: snapshot, tag, verify, remove. Requirement: 8 abandoned worktrees were rescued by hand |
| Footer cache | Recompute on every footer (3.6 to 17 s) | A background watcher, or a bounded scan with rotation inside `claim`/`touch`/`ready` | `status` writes the derived file; footers only read it and ask for a refresh when it is old or partial |
| `landedReason`, `scanIgnored` | Copy `hideReason`'s two lines; a second probe function | A general probe-plan abstraction | Extract one predicate; add one default-preserving option |

Principles: #1/#10 (one predicate, one `landedReason`), #2/#7 (verdict pure, probe injected), #8 (`staleWorktreeDays`, bounds as named constants), #11 (every probe and clock injectable), #12 (realpath and `git worktree list` membership at the boundary), #13/#14 (archive is create-then-verify-then-remove), #15 (closed verdict enum; failures are results), #16 (cache or probe failure degrades to a stated "not derived"), #18 (new manifest fields optional; defaults preserve `release`/`archive-check`/`prune`), #19 (every skipped worktree is counted).

## 3. Execution Model

Dependencies: **1 → 2 → 3 and 4**; **5** is independent of 2 to 4 (touches `cmdClaim`, `cmdAdd`, `cmdRelease`); **6** edits `handover.mjs` after 1 and 2; **7** documents every flag added by 3 to 6, so it is last.

- **Archive chain**: resolve → refuse-checks → snapshot (temp index; worktree and refs untouched) → tag → verify → *lock, revalidate* → remove → leftover check. Each stage's failure leaves a defined artefact (§2.3 "Outcomes and retries"): nothing before the tag, the tag after it, the tag plus the worktree or a named `leftover` after a failed removal. The temp index is deleted in `finally`. A re-run reproduces the same oid (fixed identity and date), so tag reuse and "already archived" are real, not asserted (#13).
- **Cache.** Only `status` writes it, by atomic rename of derived content; two concurrent `status` runs are last-writer-wins and both correct. The scan runs outside any lock. Footers only read.
- **Registry lock.** Phase 5 changes how claims are written, inside the existing `transact` (validation for `--worktree` runs before the lock, like every other git fact). `archive` takes the same lock for its final revalidate-and-remove only: the one in-lock step is a filesystem delete that is fast after the snapshot, and it is what stops a `claim` registering the worktree being removed.

## 4. Security Considerations

The security-incident neighbourhood returned INC-001 (a symlink resolving into a sensitive path evades a lexical classifier). It applies to `archive` because the verb deletes a directory and copies untracked files into a git object:

- The removal target must be a `git worktree list` entry whose **realpath** equals the requested path's realpath. A symlinked or junctioned worktree root is refused (junctions *inside* a worktree, such as `node_modules`, are unlinked by `git worktree remove`; that is existing behaviour the fleet test helper already relies on).
- The **whole preservation set** (staged additions, modified tracked files and untracked paths alike) is classified with `resolveAndClassify` from `scripts/lib/sensitive-paths.mjs`, the single oracle (no fifth classifier). Any `sensitive` hit refuses before an object or a ref is created: a snapshot would copy a credential into the object database, and this repo is public (a stray `git push --tags` would publish it). A newly staged `.env` is no longer "untracked" but is in the set.
- `.gitmodules` present → refuse: a submodule's inner changes cannot be snapshotted.
- The size cap (50 MiB over the same set, or size unmeasured) keeps a build-artefact tree out of the object database.
- The fixed snapshot identity is a literal local string; no user identity or credential is read or written.
- Nothing here sends data to a model or a network service.

## 6. Sustainability Notes

- **Assumptions that could change**: `gh` reaches the repos (every `gh` failure is `unverified`, never a verdict); Agent-tool worktrees stay unclaimed (they are listed, not special-cased); the receipt stays the only sync file left dirty on purpose (a second would be added to one list, `SYNC_OWNED_PATHS`).
- **Extension points**: the verdict enum is closed, with a `via` field; the bounds are named constants; a new surface calls the same `unregisteredWork` + `classify` pair.
- **Not built, on purpose**: a restore verb, archive expiry, mode listing, directive posting from prepare.

## 7. File-Level Plan

| File | Purpose | Key exports / change | Why |
|---|---|---|---|
| `scripts/lib/fleet/unregistered.mjs` (create) | Candidates, ordered verdict contract, idle age, one-deadline scan, archive-tag scan, cache read/write | `unregisteredWork`, `classifyUnregistered`, `scanArchiveTags`, `readUnregisteredCache`, `writeUnregisteredCache`, `UNREGISTERED_BUDGET` | One predicate (#1, #10); testable seams (#11) |
| `scripts/lib/fleet/archive.mjs` (create) | `fleet archive` (imports `transact` from `registry.mjs`) | `planArchive`, `applyArchive`, `cmdArchive` | Snapshot-tag-verify-revalidate-remove (#13, #14) |
| `scripts/lib/fleet/bundle-stamp.mjs` (create) | Stale hydrated tooling | `staleBundleWarning` | Friction c |
| `scripts/lib/fleet/handover.mjs` (modify) | Drop the moved predicate; merged evidence; `liveSessionsOf`; manifest fields; `--allow-older`; prose | schema additions are optional | Friction h, i, e, l, d, k |
| `scripts/lib/fleet/lifecycle.mjs` (modify) | `archiveReport` options; `release` resolves the worktree | `scanIgnored`, `probeTimeoutMs` | Light probe; friction a |
| `scripts/lib/fleet/overlap.mjs` (modify) | Extract `landedReason` | `hideReason` calls it | Single predicate |
| `scripts/lib/fleet/prune.mjs` (modify) | `planPrune` calls `landedReason` instead of its own reading of `hideReason`'s reason | candidate set unchanged | The third consumer of the predicate; leaving it out would keep a second spelling |
| `scripts/lib/fleet/commands.mjs` (modify) | Status section; `claim --worktree`; `add` records the worktree | | Part 1.1; a, b, j |
| `scripts/lib/fleet/render.mjs` (modify) | `renderUnregistered`; "k of them unlanded" in the hidden line | pure text | Renderers live here |
| `scripts/lib/fleet/coordination.mjs` (modify) | Footer line | `checkpointFooter` | Part 1.2 |
| `scripts/lib/fleet/config.mjs` (modify) | `staleWorktreeDays` | zod int 1 to 3650, with `sources` | #8 |
| `scripts/lib/fleet/argv.mjs` (modify) | `archive` verb; `claim --worktree`; `handover --allow-older` | flag tables | Unknown flags are refused otherwise |
| `scripts/lib/fleet/git-facts.mjs` (modify) | `runGit` accepts an `env` limited to `GIT_INDEX_FILE`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*` | | Temp index and deterministic snapshot |
| `scripts/fleet.mjs` (modify) | Dispatch `archive`; run the stamp check | | Entry point |
| `skills/fleet/SKILL.md`, `skills/fleet/references/coordination.md`, `skills/fleet/references/participant-rules.md`, `skills/fleet/gate-contract.json` (modify) | Usage lines and rules; FYI is not a `DO`; `archive --apply` needs the user's go-ahead | | The skill is the only carrier that reaches consumers |
| `tests/fleet-unregistered.test.mjs`, `tests/fleet-archive.test.mjs`, `tests/fleet-bundle-stamp.test.mjs` (create); `tests/fleet-handover.test.mjs`, `tests/fleet-lifecycle.test.mjs`, `tests/fleet-cli.test.mjs`, `tests/fleet-config.test.mjs`, `tests/fleet-coordination.test.mjs`, `tests/fleet-git-facts.test.mjs`, `tests/fleet-prune.test.mjs` (modify) | See §9 | | |

### 7b. Implementation Phases

**Phase 1 — Handover live-session defect (h)**: `repoState` passes merged evidence, so a merged, clean claim reads `done`; merged-unreleased claims are listed with their `release` command; `receive` derives its live list through the same `liveSessionsOf`. Red test first, on a fixture whose PR merged (M9). Files: scripts/lib/fleet/handover.mjs (modify), tests/fleet-handover.test.mjs (modify).

**Phase 2 — Shared unregistered-work module (i, n, g)**: create the module with the moved predicate (candidates no longer limited to dirty or unpushed worktrees), the ordered verdict contract, idle age, the one-deadline scan and cache I/O; add `scanIgnored`/`probeTimeoutMs` to `archiveReport`; extract `landedReason`; handover consumes the verdicts and blocks only per the contract's last column. Files: scripts/lib/fleet/unregistered.mjs (create), scripts/lib/fleet/lifecycle.mjs (modify), scripts/lib/fleet/overlap.mjs (modify), scripts/lib/fleet/prune.mjs (modify), scripts/lib/fleet/handover.mjs (modify), tests/fleet-unregistered.test.mjs (create), tests/fleet-lifecycle.test.mjs (modify), tests/fleet-prune.test.mjs (modify), tests/fleet-handover.test.mjs (modify).

**Phase 3 — Status section, footer and config (Part 1.1, 1.2)**: render the section and have `status` write the derived cache; `checkpointFooter` reads it (FYI line, refresh request) and never scans; add `staleWorktreeDays`. Files: scripts/lib/fleet/commands.mjs (modify), scripts/lib/fleet/render.mjs (modify), scripts/lib/fleet/coordination.mjs (modify), scripts/lib/fleet/config.mjs (modify), scripts/lib/fleet/unregistered.mjs (modify), tests/fleet-unregistered.test.mjs (modify), tests/fleet-coordination.test.mjs (modify), tests/fleet-config.test.mjs (modify), tests/fleet-cli.test.mjs (modify).

**Phase 4 — `fleet archive` (Part 1.3)**: dry run by default, `--apply` runs the snapshot chain with its refusals and the revalidate-under-lock step; `runGit` gains the allowlisted `env`. Files: scripts/lib/fleet/archive.mjs (create), scripts/lib/fleet/git-facts.mjs (modify), scripts/lib/fleet/argv.mjs (modify), scripts/fleet.mjs (modify), tests/fleet-archive.test.mjs (create), tests/fleet-git-facts.test.mjs (modify).

**Phase 5 — Registration binding (a, b, j)**: `claim --worktree`, the id ≠ branch warning, `add` records the worktree, `release` resolves it (the false-CLEAN fix). Files: scripts/lib/fleet/commands.mjs (modify), scripts/lib/fleet/lifecycle.mjs (modify), scripts/lib/fleet/argv.mjs (modify), tests/fleet-cli.test.mjs (modify), tests/fleet-lifecycle.test.mjs (modify).

**Phase 6 — Handover hardening and stale-tooling guard (c, e, l, d, k)**: gh reachability fields, the newer-manifest refusal, the bundle-stamp warning, prompt prose and the one-off hint. Files: scripts/lib/fleet/handover.mjs (modify), scripts/lib/fleet/bundle-stamp.mjs (create), scripts/lib/fleet/argv.mjs (modify), scripts/fleet.mjs (modify), tests/fleet-handover.test.mjs (modify), tests/fleet-bundle-stamp.test.mjs (create).

**Phase 7 — Skill prose**: usage lines for `archive`, `claim --worktree` and `--allow-older`; the footer FYI rule; `archive --apply` needs the user's go-ahead (deletion); regenerate gate-contract candidates if `skills:check` asks. Files: skills/fleet/SKILL.md (modify), skills/fleet/references/coordination.md (modify), skills/fleet/references/participant-rules.md (modify), skills/fleet/gate-contract.json (modify).

**Close-out (not a phase)**: `npm run skills:regenerate` then `npm run skills:check` and `npm run gates:check`; `npm run bundle:deps:check` (new imports: `sync-receipt.mjs`, `sensitive-paths.mjs`; both must be in the consumer closure); `npm run plans:index` + `npm run plans:lint`; `node --test tests/fleet-*.test.mjs`, then `npm test`; update the fleet claim to add `scripts/fleet.mjs` and `.claude/skills/fleet/**`; the empirical run in §9.

## 8. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| The footer line sends chip sessions to inspect other worktrees | Worded "not an action for this session"; `participant-rules.md` says it is not a `DO`; a test pins the exact line |
| A false `superseded` gets real work removed | The contract reaches row 3 only after row 2 found no local changes, and needs exact-tip evidence or a whole-diff duplicate; incomplete evidence is row 1; removal commands are `prune`'s, run by a person |
| The light probe misses something the full probe caught | The predicate never counted ignored files; `ls-files -v` stays; paired controls (§9) |
| Duplicate-of-claim hides work if the twin is later abandoned | Counts only while the twin is a **live claimed** branch and the tree is clean; the next scan reclassifies |
| A stale cache gives false comfort, or nobody runs `status` | Footers print the scan age and, past 24 h or when partial, ask for a `status` run; `status` is always live |
| Footer refresh request becomes noise | It shows only when the cache is missing, over 24 h old, or partial, and one `status` run clears it for 24 h |
| Archive copies a secret, or a huge tree, into the object DB | Sensitive-path refusal over the whole preservation set and the 50 MiB cap (§4) |
| Archive races an active editor or a new claim | Revalidation under the registry lock (§2.3); the millisecond residual window is stated, not hidden |
| Archive silently drops a staged version or ignored data | Refuses partially staged paths, unmerged entries and any ignored data without `--discard-ignored` |
| Windows file lock leaves a directory behind | Reported as `leftover`, exit 1, tag kept |
| `receive` refusing an older manifest blocks a legitimate restore | `--allow-older` |
| Extra scan makes `status` slower | Measured M3 ≈ 3.5 s on wine; the 60 s deadline reports a partial scan, oldest candidates first, never silence |

**Deferred, and why that is acceptable**: mode listing (d, no data source), directive posting (f, a registry write from a read-mostly verb), date parsing (k, unreliable by M6), `sync-pr` rolling PR (g, contradicts a recorded decision), keep-latest-N (l, 1.6 MB), a branch-only `archive` (it would be `git tag`), restore and expiry. **Spun out**: triaging the 8 `archive/*` tags (land or drop, one judgement per tag).

## 9. Testing Strategy

Tier 1 throughout: deterministic modules, no model calls. Tier 3(b) applies because the new modules join the consumer sync closure; add an import test for each new lib module wherever `tests/relocation-guard.test.mjs` covers library modules (it has no `lib/fleet` enumeration today, so verify, don't assume). Fixtures use `tests/helpers/fleet-repo.mjs` (throwaway repos, fake `gh`). Every "does not" case gets a paired control that fires the other way.

- **Red first.** (h) a claim whose PR merged reads live in `repoState` today → fixture. (a) an adopted session with pushed commits and one dirty untracked file: `release` prints CLEAN today, must print AT RISK. (j) a claim run from the wrong worktree binds the wrong branch.
- **Verdict contract**, one case per row with its inverse, including the order between rows: a **clean worktree whose commits are pushed but not landed** → `unlanded`, `preserved: remote`, listed, non-blocking (the case today's predicate misses), against the same worktree with its tip contained in base → not listed (control); dirty vs the same tree clean and merged → `superseded`; exact-tip PR evidence vs a tip one commit past it → not `superseded`; `gh` unreachable → row 1b or 1c, never `superseded`, and blocking exactly when the commits are unpushed; **a failed `status` probe, or an unknown ahead count, on an otherwise clean worktree → row 1a, blocking** (control: the same worktree with the probe succeeding and nothing off base is not listed); detached with unpushed → `unverified`, blocking; **receipt dirty plus unpushed unlanded commits → `unlanded`, not `sync-owned`**; receipt-only → `sync-owned`; receipt + one other file → `unlanded`; duplicate of a live claimed branch → `superseded` vs the same branch **with a dirty file → `unlanded`** vs the twin released → `unlanded`. A contract test pins `SYNC_OWNED_PATHS` against `RECEIPT_PATH`.
- **Light probe and deadline.** An injected `git` records its calls: with `scanIgnored:false` no `--ignored` call and no size walk, and unpushed/untracked/skip-worktree are still found; the default mode makes both calls (control). An injected clock and a **single slow subprocess** show its timeout clipped to the remaining budget (not its own 30 s cap); slow fact gathering and a slow tag scan likewise stop at the deadline. With 45 candidates (more than the old cap) and a deadline that fits 30, the 30 oldest tips are probed in oldest-first order, `notProbed: 15`, `partial: true`, and the section, the cache and the footer's refresh request each say so (the test asserts the disclosure and the order, **not** progress across runs); handover treats `notProbed` as NOT MEASURED.
- **Shared predicate.** After the `landedReason` extraction, `fleet prune`'s candidate and excluded sets are identical on its existing fixtures (the current suite is the control), `hideReason` returns the same reasons for the same items, and a branch landed by squash is `landed` in all three consumers.
- **Idle age.** Frozen clock (`FLEET_NOW`): exactly at, one second inside and one second past `staleWorktreeDays`; a future-dated commit and a missing mtime are not stale.
- **Footer.** No scan in `claim`/`touch`/`ready` (an injected `git` records zero worktree probes); FYI line when `abandoned > 0`; refresh request when the cache is missing, over 24 h, partial (even with `abandoned: 0`), or corrupt; the exact line text is pinned; exit codes unchanged. `status` writes the cache (present after, absent before) and a write failure is a `warning:` not an error.
- **Archive.** Dirty + untracked: the tag's tree contains both, the branch tip did not move, the worktree is gone. **Clean worktree whose tip is on base**: the tag is HEAD itself (no synthetic commit), and the archive-tag scan then does not list it as unlanded (a dirty one whose only change is WIP still is). Refusals, each with a clean control: **partially staged path** (control: staged and unchanged since, which is accepted), **unmerged index entry**, **ignored data in a mixed tree** (control: the same tree with `--discard-ignored`, whose result lists the paths), live claim, locked, main checkout, symlinked root, **sensitive file that is untracked, newly staged or a modified tracked file**, `.gitmodules`, oversize. **Determinism**: two runs with an advancing clock and no `user.name` configured produce the same oid and reuse the tag. **Races**: an edit, a HEAD move, or a new claim injected between the snapshot and the removal aborts with the tag and worktree kept. Other injected failures: tag creation fails → worktree intact; `worktree remove` fails → tag kept, `leftover`, exit 1. **Retry identity**: snapshot A tagged and removal failed, the worktree is edited, snapshot B is tagged with the suffix and removal succeeds; a later run lists both tags and claims neither as "the" archive. A run after a successful removal with no tag refuses.
- **Binding and handover.** `--worktree` accepts a listed worktree and refuses a path outside this repo; the id ≠ branch warning; manifest round-trip with the new optional fields **and** an old manifest without them; newer-manifest refusal vs `--allow-older`; the stamp warning only in a linked worktree with an older stamp.
- **Empirical run before calling it done** (the repo's pre-ship rule): run `status`, a `touch`, and `handover prepare` against CEE, wine, storyline and ai-organiser. Check no fresh worktree alarms, the 8 archive tags are counted, wall time ≤ 5 s on wine (M3), and the harness worktree of M10 reads `superseded (duplicate)`. Record the figures here with their commands.

## 11. Execution Clustering

- **Cluster A** — Phases 1-2 — fix-gate: yes
  - Coupling: both rework `repoState`/`receiveHandover` in `handover.mjs` and define the live-session and unregistered-work facts every later surface consumes; Phase 2's verdict is only as good as Phase 1's merged evidence, which comes from the same `gatherFacts` call.
- **Cluster B** — Phases 3-4 — fix-gate: yes
  - Coupling: the status section writes the cache the footer reads, and `archive` refuses on the same `archiveReport` evidence and the same verdict module, so a verdict change moves all three; both phases edit `argv.mjs` and `fleet.mjs`.
- **Cluster C** — Phases 5-7 — fix-gate: final
  - Coupling: `claim`/`add`/`release` binding, the receive guards and the stamp check share `commands.mjs`, `handover.mjs`, `argv.mjs` and `fleet.mjs`; Phase 7 documents every flag Phases 3 to 6 add, so it must follow them.
- **Final gate**: consolidated Gemini review over the union diff.

## 12. Out of scope

- Moving session transcripts, chips or messages between accounts: impossible by design.
- Auto-removing worktrees: never without `--apply` and a verified preserved tag.
- Changing `sync-pr`'s receipt rule.
