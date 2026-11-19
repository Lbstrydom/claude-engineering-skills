# Plan: fleet hygiene — detached worktrees in prune, a prune ASK threshold, ghAccount in the PR probe
- **Date**: 2026-11-19
- **Status**: In Progress
- **Author**: Claude + Louis
- **Scope**: backend (Node CLI, `scripts/lib/fleet/**`). Stack `js-ts`.
- **Target domain(s)**: `fleet`

Proposals: `p-20261118094801-f685`, `p-20261118101823-25a3` (approved by Louis 2026-11-18: "Yes, add it"),
`p-20261118102217-01e7`. One PR, branch `claude/fleet-hygiene-1d8986`, base `main` at `1df6fbfb`.

## 0. Measurements (before any code)

| Figure | Value | Command | Label |
|---|---|---|---|
| Registered worktrees, CES | 20 | `git worktree list --porcelain \| grep -c '^worktree'` (2026-11-19) | measured |
| of which detached | 13 (`C:/tmp/oodn/*` ×9, `C:/tmp/snaptest`, `C:/tmp/ces-preaudit`, two `-pinned` fixtures) | `git worktree list` | measured |
| detached worktrees `fleet prune` lists | 0 | `planPrune` iterates `status.items` (branches) and `f.branches` only; `prune.mjs:155-176` (1df6fbfb) | derived from source |
| gh call sites in `gatherFacts` that see `.fleet.json` `ghAccount` | 0 | `gatherFacts` passes the caller's `env` to `prefetchGh`, `listPullRequests`, `gatherMerged` (`facts.mjs:126-150`, 1df6fbfb); `ghEnvFor` consumers: `handover.mjs:377,865`, `ci-merge.mjs:120` (`--gh-account` flag, not config) | derived from source |

The 2026-11-18 census (18 registered, 14 detached, one leaked `ces-prepush-336f9ad8-*` sandbox) no longer
reproduces: the sandbox entry is gone (a later push's sweep retired it — dead owner, `prepush-sandbox-cleanup.mjs`),
and the archived #390 chip's worktree is back on a branch. The class is unchanged: 13 of 20 are invisible to prune.

## 1. Design

### 1.1 Detached-HEAD worktrees and stale registrations in `fleet prune` (f685)

New module `scripts/lib/fleet/prune-detached.mjs`, called by `planPrune` with the worktree list it already read.
It enumerates **worktrees, not branches**: every non-bare entry of `listWorktrees` that is `detached`, plus every
`prunable` entry (directory gone).

A present detached worktree is judged in this order; the first rule that fires decides:

1. Locked, the main checkout, or the worktree this command runs in → skipped (as for branches).
2. Another worktree's `core.hooksPath` lies inside it → kept (`hooksPathDependents`/`hooksPathRefusals`, reused).
3. Its basename carries a self-sweeping owner's prefix — `SANDBOX_PREFIX` (`ces-prepush-`) or
   `CONSUMER_SNAPSHOT_PREFIX` (`ces-consumer-snap-`), imported from `prepush-sandbox-cleanup.mjs` (one spelling) —
   → kept, the reason naming the owner: "a pre-push sandbox husk: the next push's sweep removes it". prune never
   races the tool that owns the directory.
4. Past the status deadline → `unjudged` (counted, never dropped or kept).
5. `archiveReport(ctx, {branch: null, worktree})` — the archive-check evidence. **Every** risk class counts,
   `unpushed` included: unlike a branch candidate there is no merged-tip evidence for a detached HEAD, so
   "nothing lost" means "HEAD's commits are on a remote-tracking ref" (`rev-list HEAD --not --remotes` empty,
   which `archiveReport` already runs) and the worktree is clean. Any risk or unverified line → kept, with it.
6. **Registration history** (`registrationHistory`, shared with stale registrations below). Removing a worktree
   also deletes its admin dir `<git-common-dir>/worktrees/<id>/`: its HEAD reflog and any per-worktree refs
   (`refs/bisect/*`, `refs/worktree/*`, `refs/rewritten/*`). The admin dir is found by matching each
   `worktrees/*/gitdir` file to `<path>/.git` (works when the directory is gone). The commit set is the **listed
   HEAD** (from `git worktree list`, independent of the reflog, which may have expired) plus **both** the old and
   the new object id of every retained `logs/HEAD` entry (a reset away from an unpushed commit leaves it only as an
   old id), excluding only git's all-zero sentinel; each must resolve to a commit (`rev-parse --verify <sha>^{commit}`),
   and a malformed line or an unresolvable non-zero id is unverified. Kept when any per-worktree ref
   exists, when the HEAD is missing or does not resolve, or when `git rev-list <commit set> --not --remotes` is
   non-empty (a commit only this worktree holds); an unreadable admin dir or reflog is kept as unverified. An empty
   or absent reflog is fine — the HEAD is still checked. A reflog over 1000 lines is kept as unverified rather than
   truncated.
7. Otherwise a **candidate**: one step `git worktree remove <path>` (never `--force`), `fresh` by the same
   `lastActivity`/`provablyIdle` rule branch candidates use, so `--apply` skips a fresh one without `--include-fresh`.
   Ignored files count as a risk unless the repo's `archiveIgnore` declares them regenerable — the same rule
   `archive-check` applies, since `git worktree remove` deletes ignored files without asking.

A `prunable` entry (directory gone) is judged by rule 6 only — the directory cannot be inspected, so its HEAD,
reflog and per-worktree refs are the whole evidence; its HEAD comes from the listing. Removable ones are listed under
"stale registrations"; a locked one is kept (git's lock; git would skip it anyway).

`applyPrune` runs detached candidates after branch candidates, each under `fleet/.lock`, re-checking **at apply
time** everything the plan judged: still listed, still detached, HEAD unchanged, not locked, `archiveReport` still
clean (ignored and unpushed included), rule 6 still clear, hooks guard still clear. A failure stops that candidate
only.

**Freshness at apply** (the one predicate): activity is re-read under the lock. A candidate that is fresh now is
skipped, with one exception: `--include-fresh` admits a candidate that was **already fresh in the plan the user
saw** and whose activity time has not advanced since. A candidate not fresh in the plan but fresh now (activity
that began after planning), or a fresh one whose activity advanced, is skipped even with `--include-fresh` — the
flag accepts what was shown, never what happened since.

**`--apply` never runs `git worktree prune`.** It is repository-wide, and no lock fleet holds serialises other git
processes, so a registration another process makes prunable between any check and the command would lose its
history unjudged. Stale registrations are therefore **listed only**, with their evidence and the printed command
`git worktree prune` plus the note that it affects every prunable entry, for the user to run by hand. They still
count toward the threshold (§1.2) — the ASK is how they reach a person.

Every step is an argv array executed without a shell (`runGit(argv.slice(1))`, as today) and displayed through
`renderCommand` (`shell-quote.mjs`); a path with spaces or quotes is data in both.

**Residual limit, stated, not solved:** `fleet/.lock` serialises fleet, not other git processes or tools. A tool
that starts using an unlocked detached worktree between the apply-time re-check and `git worktree remove` can still
lose it. Mitigations: `git worktree remove` refuses a dirty tree on its own; `--apply` is the user's; the
`SESSION_LIST_CHECK` line asks for the session-list confirmation.

Output: a `detached worktrees` section (removable / kept / unjudged) and a `stale registrations` section in
`renderPrune` and `renderApplied`; JSON gains `prune.detached = {candidates, excluded, unjudged, prunable}`.

**The pre-push half of f685.** The sweep (`sweepStaleSandboxes`) already removes a killed run's husk at the next
push and prunes its registration (`prepush-check.mjs:487-497`). What was missing is visibility between pushes, which
rule 3 gives. `prepush-check.mjs` is NOT changed; its claim path is kept only in case review asks for it.

### 1.2 The prune ASK threshold (25a3)

`.fleet.json` gains `pruneAlert`: `{ removable?: int ≥ 1, worktrees?: int ≥ 1 }` or `false` (off). Resolved
default `{ removable: 25, worktrees: 30 }`; a repo overrides either number. `parseFleetConfig` validates it
(Zod `.strict()`, so a misspelt key is an error, not inert).

**Data flow.** There are exactly two cache writers and one reader, unchanged in shape: `fleet status` calls
`planPrune` under `PRUNE_STATUS_BUDGET_MS` and writes `summarisePrune(plan)`; `fleet prune` (read-only) writes the
same, unbudgeted; `prune --apply` writes `unmeasuredRecord`. `fleet next` only reads (`pruneNext`). `planPrune`
returns the detached result inside the plan (`plan.detached`), and the registered count from the `listWorktrees`
call it already makes, so both writers get both with no new call. When the worktree list is unreadable, `planPrune`
already returns early: `worktrees` is then `null` and the record is unmeasured.

The prune cache record (`prune-summary.mjs`) goes to **schema version 2**, adding a `detached` block kept apart from
the branch half's `complete`/`reason`:
`detached: { removable, fresh, kept, stale, unjudged }` and `worktrees: int|null` (registered count). Branch
completeness and detached completeness are separate facts — detached judging needs no PR list but can be cut by the
deadline (`detached.unjudged`). `unmeasuredRecord` sets every detached count to 0 with `worktrees: null`. A v1 file
reads as `unreadable: schema mismatch`, which `next` already renders as "unmeasured — run `fleet status`": honest,
one status run heals it. `pruneCountText` prints detached counts with `≥` when `detached.unjudged > 0` (as the
branch counts already do), and `pruneIsEmpty` is true only when the detached block is also all zero, unjudged
included.

One pure function, `pruneAlertCrossed(record, alert)` → `{crossed, lowerBound, why[]}`:
- **removable** side: `detached.removable + detached.stale + (complete ? removable : 0)` against `alert.removable`.
  Any unjudged part (branch half incomplete, `unjudged`, `detached.unjudged`) makes the sum a **lower bound**: it
  may cross (the true count is at least that), and a sum under the threshold is reported as "not shown crossed",
  never as "below threshold".
- **worktrees** side: `worktrees` against `alert.worktrees` — a direct count, independent of either completeness;
  `null` never crosses.
- `alert === null` (off), a stale or unreadable cache → never crossed (the existing unmeasured line stands).

`pruneNext` (and so `fleet next`) prints, after the FYI line when crossed:
`ASK (for the coordinator's next pass, not an action for this session): prune threshold crossed — <why> — show the user `fleet prune` (read-only) and ask <action>`.
`<why>` names the parts separately (`N apply-removable (branches + detached), M stale registrations, W registered`).
`<action>` follows what can act on them: apply-removable > 0 → "whether to run `fleet prune --apply`"; stale
registrations > 0 → "whether to run `git worktree prune` by hand (repository-wide; `fleet prune` lists every entry it
affects)"; both → both clauses; only the worktrees side crossed with nothing removable → "which worktrees to retire
(`fleet prune` lists what is kept and why)". Tests: stale-only, candidate-only, mixed, worktrees-only.
`fleet status`'s prune line appends `· threshold crossed (<why>)`. Removal stays the user's: no code path removes.

### 1.3 `ghAccount` in the gatherFacts PR probe (01e7)

`gatherFacts` applies `ghEnvFor(config, env)` once at its head and uses the result for every gh call it makes
(`prefetchGh`, `listPullRequests`, `gatherMerged`). Every read-only caller that passes a resolved config — `status`,
`prune`, `next`'s cache writers — then honours the declared account; a caller passing a partial config
(`{baseBranch}`) or one without the key is unchanged (`ghEnvFor` returns `env` itself). Mutating callers: below.

When the account cannot be read, the probe already fails closed (`UNAVAILABLE_TOKEN`); `gatherFacts` additionally
replaces the PR block's reason with `gh account <name> is not available: <reason>`, so `status` and `prune` name the
account instead of a bare 401.

`handover` already switches `env` before calling `gatherLive`; the second application is idempotent (the lookup strips
every credential variable before asking gh, and the token is memoised), so handover is left as is.

The `gh-account.mjs` header is rewritten to list its real consumers: `gatherFacts` (config), `handover`
(config), `ci-merge` (the `--gh-account` flag only).

**Mutating workflows keep one identity (audit R3 H1, deliberated → MEDIUM compromise).** `land` and `ship-batch`
decide from `gatherFacts` and then mutate through `train.mjs:85` `ghRun`, which spawns gh with `process.env`. Reading
as the declared account and mutating as the ambient one would let an ambient account WITH access act as a different
actor than the one whose evidence was read. So `gatherFacts` takes `ghIdentity: 'declared' | 'ambient'`, default
`'declared'`; `land.mjs` (both calls) and `ship-batch.mjs` pass `'ambient'` explicitly, citing proposal
`p-20261119105615-d6fb` (thread `ghEnvFor` through `ghRun`), which flips them to `'declared'` together with their
mutations. Read-only callers (`status`, `prune`, `next`'s cache writers, `handover`) use the default. A test asserts
each mutating caller's probe ran with the ambient token while a read-only caller's ran with the declared one.
`references/config.md` states the key's exact scope: PR reads of `status`, `prune`, `next`'s caches and `handover`;
NOT `land`/`ship-batch`/train (until d6fb), NOT `ci-merge` (its own `--gh-account` flag).

### 1.4 Right-sizing

- **Band-aid:** list detached worktrees as a count in `fleet status` only, hard-code 25/30 in `next`, and pass
  `ghEnvFor` at the two call sites the proposal names (`cmdStatus`, `planPrune`).
- **Over-built:** a worktree ownership registry (who created each detached worktree), `git worktree add` latency
  telemetry as the alert signal, and threading `ghAccount` through every gh call in fleet (train, ledger, CI facts).
- **Chosen:** judge detached worktrees with the evidence `archive-check` already uses (no new oracle); one optional
  config key with defaults; one `ghEnvFor` call at the single seam every PR probe goes through. Each is the smallest
  thing that makes the count true, the alert actionable and the declared key effective.

### 1.5 Architectural memory

`get-neighbourhood` (2026-11-19, k=8) on prune/prune-summary/coordination: one `precedent`,
`sweepStaleOrphanPreimages` (`diff-scope-resolver.mjs:308`) — a self-sweeping owner of `orphan-preimage-*`
worktrees, the same class as rule 3. Decision: extend rule 3's prefix list with its prefix if it is exported;
otherwise recognise it by the same constant moved to an export. Everything else `review`.

## 2. Files

| File | Change |
|---|---|
| `scripts/lib/fleet/prune-detached.mjs` | new: `planDetached`, `applyDetached`, `renderDetached` |
| `scripts/lib/fleet/prune.mjs` | call them; `notJudged` unaffected; `cmdPrune` JSON |
| `scripts/lib/fleet/prune-summary.mjs` | schema v2, new counts, `pruneAlertCrossed` |
| `scripts/lib/fleet/coordination.mjs` | `pruneNext` ASK line, threshold from `ctx.config` |
| `scripts/lib/fleet/config.mjs` | `pruneAlert` key + resolved default |
| `scripts/lib/fleet/facts.mjs` | `ghEnvFor` at the head of `gatherFacts` |
| `scripts/lib/fleet/gh-account.mjs` | header only |
| `tests/fleet-prune.test.mjs`, `tests/fleet-prune-summary.test.mjs`, `tests/fleet-gh-account.test.mjs`, config/next tests | see §3 |
| `tests/helpers/fleet-repo.mjs` | fake gh: optional `state.requireToken` → "Could not resolve to a Repository" unless `GH_TOKEN` matches |
| `skills/fleet/references/config.md`, `skills/fleet/references/ending-a-session.md` (+ regenerated `.claude/skills/fleet/**`) | `pruneAlert`; detached worktrees in prune. `SKILL.md` is over the 12,000-char ratchet and is not touched |

## 3. Proof plan and tests

PROOF PLAN: red-then-green tests on real git fixtures — a detached clean worktree on a pushed commit is removable
and one on an unpushed commit is kept (both red today: neither is listed); a v2 record at 25 removable / 30 worktrees
prints the ASK and one below prints none; a fake gh that answers only the declared account's token makes
`fleet status --json` report `prs.queried:true` (red today: `false`, "Could not resolve") — plus a before/after
`fleet prune` on this repo showing the 13 detached worktrees judged.

1. **Detached, red→green** (`fleet-prune.test.mjs`, real repo via `makeFleetRepo`): worktree `add --detach` at a
   commit on `origin/main` → candidate with `git worktree remove <path>`; at an unpushed commit → kept naming
   `1 unpushed`; dirty → kept naming the file; locked → skipped; basename `ces-prepush-…` → kept naming the sweep;
   directory deleted → stale registration with the printed `git worktree prune`; directory deleted but its reflog
   holds an unpushed commit → kept; directory deleted, reflog emptied, HEAD unpushed → kept (pushed-HEAD control →
   listed); a detached worktree whose only reflog entry moved from an unpushed commit to a pushed one → kept
   (control: both pushed → candidate); a `refs/bisect/*` in the admin dir → kept; an ignored file outside `archiveIgnore` → kept;
   a path with a space and a quote → executed as argv, rendered quoted. **Negative control:** the same fixture with the
   worktree on a branch is judged by the branch path exactly as before (existing tests unchanged).
2. **Apply re-checks**: HEAD moved between plan and apply → skipped; a file (tracked change or ignored) created
   after the plan → skipped; freshness, both flag settings: fresh-in-plan unchanged (skipped without the flag,
   removed with it), activity after the plan on a non-fresh candidate (skipped with and without the flag), a
   fresh-in-plan candidate whose activity advanced (skipped with the flag); stale registrations → `--apply` never
   invokes `worktree prune` (asserted on the git call log), the command is printed. Each with the passing control
   (unchanged state → removed).
3. **Threshold and cache** (`fleet-prune-summary.test.mjs`, plus `status`→`next` through the real cache): boundary
   at exactly 25 / 30 crosses, 24 / 29 does not; `pruneAlert:false` never; incomplete branch half with 25 detached
   crosses, with 25 branch `removable` does not; 20 judged + 10 `detached.unjudged` reads "≥20 … not shown crossed",
   never "below"; all detached unjudged; `worktrees:null` never crosses; v1 file → unreadable → no ASK; empty v2
   record → silent. Config: unknown key in `pruneAlert` rejected.
4. **ghAccount** (`fleet-gh-account.test.mjs`, end to end through `runFleet status --json`): fake gh with
   `accounts:{acct: 'tok-declared'}` and `requireToken:'tok-declared'`, ambient `GH_TOKEN=tok-ambient`:
   without `ghAccount` → `prs.queried:false` (the control, red today and after); with `ghAccount:"acct"` →
   `prs.queried:true`, and `FAKE_GH_TOKEN_LOG` shows every `pr list` ran with `tok-declared`, none with the ambient
   one. Unknown account → reason names it, no ambient token used.
5. Gates: `npm run guards:preflight`, `skills:regenerate`/`skills:check`, `bundle:deps:check` (new import from
   `prepush-sandbox-cleanup.mjs`), `size:ratchet:gate`, `skills:size:gate`, targeted fleet tests.

## 4. Risks

- A detached worktree some tool is using but has not locked (e.g. a running `oodn` experiment) could be listed
  removable. Mitigations: `fresh` (activity within `staleWorktreeDays`) is skipped by `--apply`, `--apply` is the
  user's, and the `SESSION_LIST_CHECK` line already asks for the session-list confirmation.
- Schema v2 makes every existing prune cache read as unmeasured until the next `fleet status` (one run per repo).

## Audit trail

- `/audit-plan`, SID `audit-plan-1795085789047-75864`, 2026-11-19. R1 H4 M2 (6/6 accepted) · R2 H2 M1 (3/3
  accepted) · R3 H2 M1 (3/3 accepted; R3 H1 rebutted, deliberated to MEDIUM compromise and folded as §1.3
  "Mutating workflows keep one identity").
- **Stopped by the round cap, not by convergence**: no round was clean, acceptance stayed 100%, HIGH 4→2→2 with each
  round narrower (data-loss evidence on registrations → reflog old ids). Structural card: 0 structural, 2
  unclassifiable clusters, no shared primitive. Decision STOP (CONTINUE past the cap is the user's call, not taken in
  an autonomous run); the remaining risk is carried to the mandatory final gate and to `/audit-code`.
