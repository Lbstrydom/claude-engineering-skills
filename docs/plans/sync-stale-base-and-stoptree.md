# Plan: Sync checks the consumer's lag BEFORE writing; a failed tree-kill is reported

- **Date**: 2026-10-24
- **Status**: In Progress — implemented on `fix/sync-stale-base-and-stoptree`, pending audit and merge
- **Author**: Claude (fleet chip for CES: Coordinator; proposals 2753, c729)
- **Scope**: backend (consumer sync CLI, shared lease runner; no UI)

## 1. Problem

1. **2753 — the stale-base guard fires after the write.** `npm run sync` writes into a consumer's main checkout that is behind origin (2026-10-24: storyline 17 commits, wine 46); coordinators merge sync PRs on GitHub and nobody pulls that checkout. Only `sync:pr` noticed, afterwards, with `stale-base-collision` and the remedy "discard the synced changes, `git pull --ff-only`, re-run the sync" — paid by hand every time.
2. **c729 — `stopTree` swallows kill failures.** `taskkill` non-zero and non-`ESRCH` signal errors were all treated as "already gone". A tree that survives a stop keeps burning the shared machine, the lease is released over live work, and `fleet lease run`, `sync:pr` and the prepush step runner cannot tell cleanup failed.

## 2. Decisions

### 2.1 One oracle for "stale"
`classifyBaseLag` (`unknown | off-base | diverged | behind | current`) now lives in `scripts/lib/sync-base-lag.mjs` with `gatherBaseFacts` (the fetch + counts half of `gatherConsumerFacts`), `parseSymrefHead` and `spawnRunner`. `lib/sync-pr.mjs` imports and re-exports them, and `planConsumerPr`'s own behind-branch now asks `classifyBaseLag` — the pre-write check and the post-write backstop cannot disagree about "behind". `gatherConsumerFacts` keeps its call sequence (existing tests unchanged).

### 2.2 What the pre-write check does (per target, before the first write, `--dry-run` included)
current / ahead-only / off-base → proceed silently. **Behind and clean apart from provenance-proved sync output** (`classifyRepo`: ownership AND content hash) → restore those tracked files to HEAD (this run rewrites them; they are what blocks `merge --ff-only`, the receipt changes on every landed sync) and fast-forward. Behind with anything else dirty, diverged, or a failed fast-forward → **refuse that consumer** with the exact remedy. Unreachable origin / no `origin` → proceed with `base lag NOT CHECKED (<why>)` — failing the sync of an offline machine would be a worse gate than the one it replaces, but the question is never rendered as a clean answer. `--allow-stale-base` is the explicit, per-run consent (same shape as `--overwrite-diverged`).

*Right-sizing.* Band-aid = print the lag as a warning. Over-built = rebase/merge logic for diverged consumers, or restoring user files. This fast-forwards only the state the tool itself produced and refuses everything else.

*Size ratchet.* `sync-to-repos.mjs` sits at its baseline+tolerance, so the wiring is one call line plus a flag name; the logic is all in the new lib.

### 2.3 `stopTree` reports, callers surface
`stopTree` returns `{ok:true}` or `{ok:false, why}`: taskkill 0 and 128 (not found) are ok; any other status, a spawn failure or a signal is a failure; POSIX `ESRCH` is gone, `EPERM` on the group or the root is a failure (and a root-only signal is reported as a partial stop). `runChild` collects `stopFailed` (labelled first/force) into its result; `runStep` logs a loud line and returns it; `fleet lease run` prints a WARNING and sets `treeStopFailed` in its result. An injected `stop` that returns nothing is read as ok, so every existing caller is unchanged. **Not done, flagged:** whether a failed stop should keep the slot held rather than release it is a product decision (it changes what other sessions see); this change makes the fact visible so that decision can be made on evidence.

## 3. Rollout
Sync tooling and the lease runner only; no hook change. Consumers need **no** `hooks:install`, and no sync is needed for behaviour: the base-lag check runs only in the source checkout's `npm run sync`, and the consumer hook runs `prepush-step.mjs` (and so `lease-spawn.mjs`) from the SOURCE checkout it discovers. The next ordinary sync carries the updated `lease-spawn.mjs` / `prepush-step.mjs` copies into consumers, unobserved by anything.

## 4. Acceptance
`tests/sync-base-lag.test.mjs` (decision table, real-git fast-forward / refuse / dry-run / unreachable, one-oracle pins, and the real `sync-to-repos.mjs` CLI refusing a stale dirty consumer with nothing written and fast-forwarding a clean one) and `tests/fleet-lease-stop-failure.test.mjs` (both platform branches, both directions).
