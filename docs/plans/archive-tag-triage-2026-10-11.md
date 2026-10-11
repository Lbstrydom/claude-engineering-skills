# Triage: the eight `archive/worktree-agent-*` tags (2026-10-11)

- **Date**: 2026-10-11
- **Status**: Draft (findings and recommendations only; no tag was deleted and nothing was landed by this document)
- **Scope**: tooling (repo hygiene)
- **Base measured against**: `origin/main` at `b8091c44`

Eight abandoned Agent-tool worktrees were archived by hand on 2026-10-11 as local
tags (`git tag -l 'archive/*'`). They hold work abandoned between 27 Sep and 3 Oct.
Each tag was classified by what `origin/main` does **today**, not by commit message.
Deleting a tag stays a human decision.

## Table

Tag suffix is the part after `archive/worktree-agent-`. "Fails on main" means the
tag's own new/changed tests, overlaid on `origin/main` code, fail while the same
tests are green at the tag tip.

| Tag | What it contained | Evidence | Decision |
|---|---|---|---|
| `a17ae37087cdde225` (2 commits, 10-02) | Store write-boundary fixes (`recordAdjudicationEvent` lock order, an unresolved round probe falling back to a per-run UPDATE, a `regressed` row flipped back to `verified`, `applied:true` without a written row, `getPassTimings` aggregation, capability probes in a SAVEPOINT) plus regression tests; extracts `scripts/lib/store/column-probes.mjs`. | `column-probes.mjs` absent on main. Merges onto main cleanly. On a real Postgres, `store-finding-write-db` fails 5 of 26 on main (with a shim for the missing module): lock-order deadlock (#25), resolved-overwrites-moved-on-state (#24), `applied:true` on an unwritten row (#16), unresolved throttle probe (#18); #19 (probe in a caller transaction) is inconclusive because the shim stubs `columnExists`. `pass-stats-post-deliberation` fails 5 of 5. Tag tip is 26/26. The tests that lock the earlier #118 fixes pass on main, so those fixes did land. | **land, via the burndown chip** (both commits are in `archive/queue-burndown-2026-10-02`; not from this session) |
| `a3431c2e33d303e8a` (14 commits, 10-02) | A sweep of small hardening fixes; see the split below. | Mixed: most of it was re-implemented by #160 (`913f4ed4`); two commits duplicate `ad8559`; four are still live on main. | **split** (below); the live commits ride the burndown chip; `0987d35f` is **dropped** (landed by #160) |
| `a68f29248c8b90190` (2 commits 09-27, plus a WIP commit 10-11) | Live constraint-drift check (`setup-postgres --check-drift --live`), diff-scope non-code filter, retired copilot bootstrap block; CRLF/UTF-16 diff parse, rulings pass-name match, telemetry-class write, gemini-gate and persona-test prose. | Landed as #125 (`a6b035b3`, 2026-09-27): all four new modules first appear there, 12 touched files are byte-identical on main, five of the eight test files pass on main, and the gate and persona prose is present (reworded). The three failing test files assert pre-hardening output that #125 later changed (SQL identifiers are now double-quoted). The WIP commit changes one line, the `bundleVersion` hash in `skills.manifest.json`, which regenerates. | **landed-already** (drop; do not resurrect its tests) |
| `a7729e417bceceb2b` (4 commits, 10-02) | Collision-safe audit SIDs (epoch-ms + PID) and `PLAN_FILE` no longer assigned a glob in the `/audit-code` and `/audit-plan` recipes; pins for the hydrate one-liner and the click-test driver contract. | `audit-skill-shell-recipes` fails 3 of 4 on main (SID and glob recipes still live). `skills-hydrate` (38/38) and `sync-shared-audit-refs` (29/29) already pass on main, so the two pin-only commits add no new coverage. Conflict is `skills.manifest.json` only, and `.claude/skills/**` is generated, so regenerate instead of picking those files. | **land from this session**: `99330963` (burndown copy `d2468e0c`, plus `72f120c6` and `7b14ee9d`, which chain on it) and `094cf92f` (`f0d20990`), with the new test file; pin `4fc433a0` (`818a82f9`) optional |
| `a8895e6b04909c52f` (1 commit, 10-03, plan doc, shipped through the full gate) | Revives final-review debt suppression: debt context read from `rounds[]`, symmetric signature matcher at 0.30, identity fields no longer truncated, shadow throws on an unknown provider. | Main's `post-review.mjs` has no `rounds[]` reader, so the stage is still dead in production. On main, `debt-transcript-suppression` fails outright (0 pass), `final-review-round-gate` fails 10, `shadow-client-dispatch` 2. Tag tip all green. Merges onto main cleanly, but **conflicts with `ad59c` in 9 files**. | **land first**, as its own PR (coordinator ordering: it is the audited superset of burndown `537a49bb`/`3091c7c5`); awaiting the user's go-ahead to push |
| `aa03e61f5a6524a00` (11 commits, 10-02) | Egress and atomicity hardening: instruction file read through the sensitive-path oracle (`11f2005a`), single-descriptor `safeReadFile` (`c8fcdbd7`), failed cloud read of the debt ledger is unavailable not empty (`65349f64`), `debt-reconcile` reason, atomic `rotate-status-log`, keyset paging for the `/ship-nudge` readers (`92eb975a`), `--threshold` parsing, gitignore-policy key escaping, campaign arm-id prototype keys. | Nine of ten test files fail on main; `ship-nudge-keyset-db` fails 7 of 7 on a real Postgres; tag tip green. Conflicts: `skills.manifest.json` and `scripts/lib/store/debt.mjs` (#193 changed the debt readers on 10-11, so `65349f64` needs a rebase). | **land, via the burndown chip** for 10 of 11; keyset paging `92eb975a` (burndown copy `991bf21e`) is this session's |
| `ad59c28b45a55cd82` (8 commits, 10-02) | Final-review reliability: a truncated or schema-invalid response fails the review, schema recovery never slices an identifier or citation, shadow block carries its request identity, campaign scope refused before provider work, run-id recovery bound to the transcript, one provider list, one `dedupByHash`. | Merges onto main cleanly. Fails on main in 10 of 13 test files (truncation 4, callreviewer 4, shadow 5, round-gate 4, campaign preflight 2 ...); tag tip green. Overlaps `a8895` in the same files. | **land, via the burndown chip**, after `a8895` |
| `ad8559f27235c40c9` (2 commits, 10-03, plan doc, shipped through the full gate) | CLI contract hardening: strict boolean flag values (`--apply=fasle` no longer enables), `emit()` validates `softFail` before writing, replay honesty, `learning-replay` verbs in the registry. | Main's `hasFlag` has no closed value set. On main, `cli-io-equals-flags` fails 11, `emit-exit-coupling` 1, `learning-replay` and `replay-positionals` fail outright (0 pass). Conflicts are `status.md` and `.stdout-flush-baseline.json` only (mechanical). | **land second** (awaiting the user's go-ahead); the burndown chip drops its `8cfbd071`/`b3f80832` in its favour |

### `a3431` split

- **Landed already** (equivalent fixes verified in main's source or tests, via #160): `f47f8107` hermetic capture env, `0987d35f` nav sentinel of unknown state, `c3e8caac` on-conflict recovered parse, `2b3c8521` claudemd autofix write, `59bb020f` accepted-debt atomic `--out`, `f627407f` click-test fence pin. `3c8a4120` is half landed: main drops an edge into a deleted file but does not check a disowned target.
- **Superseded by `ad8559`**: `5362132a` (`softFail`/`hasFlag`) and `cd2276a` (replay). Both rewrite the same functions as `ad8559`; the two tags conflict in 12 files.
- **Still live on main, land**: `aa363001` event-wiring ancestry (4 test failures), `f1ddd0fc` stage0 swallowing impact-lookup throws (1), `b3abd18d` model-eval cohort relabelled on a subject change (fails on a real Postgres), and the disowned-target half of `3c8a4120`.
- **Test-only, already pass on main**: `5bf66ac`, `89e7d92` (optional).

## Findings that change the plan

1. **`claude/queue-burndown` is the superset.** It was local-only (49 commits, all 2026-10-02, none on main by patch-id) and has since been pushed as `origin/archive/queue-burndown-2026-10-02` (`3c0afc4e`) and bundled; a coordinator chip will land its commits in cluster PRs, so **nothing contained in it is landed from this session** (double landing conflicts). It holds patch-equal copies of all of `a17ae` and `ad59c`, 13 of 14 of `a3431`, 10 of 11 of `aa03e`, and same-subject copies (differing only by regenerated skill files) of three of `a7729`. `a8895` and `ad8559` are **not** in it, so for those two the tag is the only copy. The burndown chip should **skip** these, already on main via #160 (burndown SHA in brackets): `f47f8107` [`849402fd`], `c3e8caac` [`d247e3f6`], `2b3c8521` [`7685d1f1`], `59bb020f` [`06d38d7e`], `f627407f` [`c38267bf`], the nav sentinel [`be016f14`], and half of `3c8a4120` [`61e84763`] (the deleted-target half), and these, superseded by `ad8559`: `5362132a` [`8cfbd071`] and `cd2276a` [`b3f80832`].
2. **Three competing debt-suppression implementations** (`a8895`, `ad59c` commit `fd273e26`, and queue-burndown `3091c7c5`) use different thresholds (0.30 versus 0.35 symmetric). Landing more than one without choosing re-creates the churn.
3. The whole-file diff of a tag against `origin/main` over-reports: the real landed set is found by per-file blob comparison, then by running the tag's tests against main.

## Decisions and ordering

Settled with the coordinator (a peer session; none of this is user approval to push):

1. `a8895` `964c1d77` lands first, as its own PR. It is audited (3 plan rounds, 4 code rounds, Gemini approved) and supersedes the competing matchers in `ad59c` `fd273e26` / burndown `537a49bb`, `3091c7c5`, `cd615778`.
2. `ad8559` `a72426c6` + `1f46b567` lands second.
3. This session also owns the keyset-paging and SID/PLAN_FILE copies (use whichever of tag or burndown copy applies cleanly).
4. `a68f2` is dropped: verified landed as #125.

Still open for the user:

- Approval to push and open the `964c1d77` and `a72426c6` PRs (and merge only when PR head equals the audited sha).
- **`a72426c6` gap**: `emit()` validates the `softFail` reason only when `ok:false`, so `emit(env, {softFail:true})` with no reason and `ok:true` is accepted. Burndown `8cfbd071` validated every call. Land as audited and file a follow-up, or tighten first (re-opens an audit round).
- Whether to land the `docs/plans/README.md` index regeneration needed by this document (the fleet claim on that file is held by two other sessions).

## Tag deletion readiness (for the human who decides)

- `a68f2`: nothing unique. Content is on main as #125 and the WIP commit is a regenerable hash.
- `a7729`, `a17ae`, `ad59c`, `aa03e`: also exist as copies on `archive/queue-burndown-2026-10-02` (pushed and bundled). Keep the tags until the burndown clusters merge.
- `a8895`, `ad8559`: the tag is the **only** copy. Delete only after the landing PR merges or the work is explicitly dropped.

## Method (reproducible)

- `git fetch origin`; per tag `git log origin/main..<tag>`, `git diff --stat $(git merge-base origin/main <tag>)..<tag>`, `git cherry origin/main <tag>` (patch-ids: no tag commit matches main), `git merge-tree --write-tree origin/main <tag>` (clean or conflicting files).
- Landed-ness by per-file blob comparison against `origin/main`, then by running each tag's changed test files at the tag tip (control, expected green) and overlaid on `origin/main` code (3-way apply of the tag's test diff). Unit tests ran with provider keys, store DSNs and the home directory blanked. DB-gated suites ran against a throwaway Postgres built from the pinned test image and main's migrations.
- Instrument defects found and fixed along the way (the numbers above are the clean pass; the first pass ran without the credential scrub and was discarded): Git Bash rewrote `rev:.dotfile` arguments, making dotfiles read as absent; two runners shared one sandbox and corrupted each other's output; one DB suite could not load on main at all (missing module), so it was re-run with a shim and the one test the shim affects is marked inconclusive.
