# Plan: /fleet — four fixes from the storyline consumer's first real use
- **Date**: 2026-10-06
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend (CLI + skill content; no UI) · stack `js-ts`
- **Target domain(s)**: `fleet`, `skills-content`
- **Depends on**: docs/plans/fleet-multi-session-coordination.md (Complete)

## 1. Context Summary

The storyline consumer ran `/fleet` against a real monorepo and agreed four
changes with the two sessions that own it. All four are small, all four are in
`scripts/lib/fleet/**` plus the skill text, and none touches Home or adds a verb.

1. **`statusCheckRollup` 403s.** storyline's token cannot read check rollups, and
   because `gh pr list --json …,statusCheckRollup` is ONE call, the 403 loses the
   whole PR list: `PRs: not queried (gh failed: …)`, with every PR-backed session
   losing its evidence. The fault is one column wide; the blast radius is the
   table.
2. **`fleet status` noise.** Untracked worktrees whose branch is already in base
   (`ahead 0`) fill the table; a real session is hard to find among them.
3. **A tier/check cannot say why it is deferred.** `deferredLines` prints a bare
   "tier X will run on main after landing". storyline's packaged tier is
   main-only for a reason the operator should see at approval time.
4. **Three-dot `changedFiles` is undocumented.** It is already implemented
   (`git-facts.mjs:243`, `base...branch` = since the merge-base) and nothing pins
   or states it, so a future "simplification" to two-dot would make every branch
   look like it also changed whatever base moved on.

**Code Trace (5b6fedd3).**
`gatherFacts` `scripts/lib/fleet/facts.mjs:90` → `listPullRequests`
`gh-facts.mjs:188` (one `spawnSync gh pr list`, fields `PR_LIST_FIELDS:22`) →
`parsePrList:160` → `normalisePr:130` (`checks: summariseChecks(rollup)`) →
`buildStatus` `overlap.mjs:~460` (`prFor:480`, untracked loop `521-534`, overlaps
`556-574`) → `renderStatus` `render.mjs:62` (`checks:` printed at `:42`).
Consumers of `pr.checks`: **only** `render.mjs:42` (grep over `scripts/` for
`checks?.state`/`.checks` finds no other reader; `land --confirm` reads
`PR_VIEW_FIELDS` via `gh pr view`, never the rollup; Home in-flight reads no PR
checks). Tiers: `TierSchema` `contracts.mjs:47` (strict) is persisted whole into
the manifest (`train.mjs:325` `testCommand`/`deferredTiers`), and user config
derives from it with `.omit({shell:true})` (`config.mjs:47`); `CheckSchema`
`config.mjs:49` is separate and strict. Deferred rendering: `render-train.mjs:38`.

**Neighbourhood considered.** All four edit existing symbols (no new
abstraction); the one new function, `isStaleUntracked`, has no near-duplicate in
`overlap.mjs` (the existing skip at `:524` is a *construction* filter, not a
display predicate).

## 2. Proposed Architecture

### 2.1 Checks fetched apart from the PR list (item 1)

- `PR_LIST_FIELDS` loses `statusCheckRollup` (the identity/state fields stay).
  New `PR_CHECK_FIELDS = ['number','statusCheckRollup']`; both stay real `gh`
  fields, still checked against `tests/fixtures/fleet/gh-pr-view-fields.json`.
- `listPullRequests` runs the core call exactly as today, then ONE second
  `gh pr list --state open --limit PR_LIMIT --json number,statusCheckRollup`.
  Its failure never touches the core result. It returns
  `prs.fields = { checks: {queried: true} | {queried:false, reason} }` —
  per-field provenance, in the shape the other fact blocks already use.
- `reason` is a short string from the existing `classifyGhFailure`, extended with
  one rule: stderr matching `HTTP 403|Resource not accessible|insufficient
  (scope|permission)` → `checks not readable with this token (403)`.
- Each normalised PR's `checks` is `{state:'unknown', total:null}` when the field
  was not queried, else today's `summariseChecks` value. `unknown` is a fifth
  state; **no reader treats it as success** (there is only one reader — render —
  and a test pins that `unknown` never prints as `success`/`none`).
- Rows from the second call are joined to PRs **by `number`**. The two listings
  are separate bounded snapshots (a PR can close between them, or membership can
  shift around `PR_LIMIT`), so request success is NOT evidence about an
  unmatched PR: **`none` only when a matching, valid row has an empty rollup
  (today's meaning); a PR with no matching row is `unknown`**, and a rollup row
  for a PR not in the core list is ignored. `fields.checks` also carries
  `missing: <count of PRs left unknown>` and, when `> 0`, a reason, so partial
  evidence renders as `PR checks: partial (N unknown)` and `incompleteSources`
  lists it. A malformed row (`validatePrRow`-style check on `number` and rollup
  shape) leaves its PR `unknown`, never `none`.
- Render: `PR #n checks:unknown` per item, and ONE source line
  `PR checks: not queried (<reason>)` (via `sourceLine`), and `incompleteSources`
  lists `PR checks`. The PR list itself stays `queried:true`, so overlap, land and
  adoption keep their evidence.
- `land --confirm` and Home in-flight: **unchanged**, because neither reads checks
  (Code Trace). The plan states that rather than adding dead handling.

### 2.2 Hide stale untracked items by default (item 2)

- One pure predicate in `overlap.mjs`, over **sufficient** evidence, where every
  unknown keeps the item visible:
  `isStaleUntracked(item, {prsComplete}) ⇒ tracked === false && kind === 'branch' && ahead === 0 && pr === null && prsComplete === true && (worktree === null || worktreeClean === true)`.
  `ahead === 0` is commit containment only — not inactivity — so an attached
  worktree must ALSO be provably clean: `facts.worktreeDirty[path]` comes from
  one bounded `git status --porcelain` per *candidate* worktree (ahead-0, untracked,
  has a worktree — never every branch; failure/timeout ⇒ unknown ⇒ visible).
  The collection is explicitly bounded: sequential probes through `runGit` with a
  **5 s per-process timeout**, at most **20 candidates**, and a **15 s aggregate
  deadline** checked before each probe (so the worst case is deadline + one
  timeout, not N x timeout). Candidates beyond the cap or after the deadline are
  left `unknown` and therefore visible; the render line says so
  (`N unchecked`). `prsComplete` is `prs.queried && prs.complete !== false`, because
  `pr === null` only means "no open PR" when the lookup was complete. Registered
  sessions, detached worktrees and `remote-only` PRs are never hidden.
- **`buildStatus` stays complete** (domain contract: every item, overlaps,
  duplicates, landing order). Its callers, inventoried: `commands.mjs:104/106`
  (the `status` verb — a presentation boundary), `land.mjs:62/90` and
  `train-approve.mjs:160` (all read tracked/landable items and `payloadFromStatus`,
  which filters `tracked` — they need completeness and stay on the unfiltered
  status). Home in-flight does not call it. So the display policy is applied ONLY
  at the `status` verb: a pure `splitHidden(status, {all})` returns
  `{items, hidden:{count, ids}}`, and `renderStatus(status, {all})` and the
  `--json` envelope use it. **Overlaps are unaffected by hiding**: a hidden item
  is ahead-0, so its `changedFiles` is empty and it has no declared paths, hence
  it can be on neither side of an overlap (pinned by a test that compares
  overlaps with and without `--all`).
- Render: one line `N hidden (stale / merged) — use --all` when `count > 0`.
- `fleet status --all` (new bool flag on `status` in `argv.mjs`'s verb table;
  `knownFlagsFor` stays the guard).
- **Measured limit, stated not hidden:** the PR list is `--state open`, so a
  *closed/merged-PR* branch is only recognisable via `ahead === 0`. Querying
  closed PRs is a second PR listing and is out of scope; the ahead-0 test covers
  the merged case, and an unmerged-closed branch remains visible (the safe side).

### 2.3 `note` on tiers and checks (item 3)

- `contracts.mjs`: `NoteSchema = z.string().trim().min(1).max(300)` refined to
  forbid control characters (a newline would let a note forge a status line);
  added as `note: NoteSchema.optional()` to `TierSchema` (so it reaches the
  persisted manifest and user config through the existing `.omit`) and to
  `CheckSchema`. Strict objects keep rejecting every other unknown key.
- Printed beside the output it explains: after the `deferred tier` line
  (`deferredLines`, which also serves `land --approve` and `--dry-run`), on the
  `tier x: result` line, and on the `check x [severity]: status` line.
- Recorded: tiers already persist whole; check results gain `note` copied from
  the config check so the manifest records the explanation that applied.

### 2.4 Document and pin three-dot (item 4)

- `fleet-multi-session-coordination.md` §2b gets an "Amendment 2026-10-06"
  paragraph; `skills/fleet/SKILL.md` gets one sentence in the existing overlap
  description. A test pins the behaviour (see §9).

**Right-sizing.** Band-aid: catch the 403 and drop PR info entirely (kills
adoption + evidence — the bug). Over-built: a general per-field provenance
framework across all fact blocks. Chosen: one extra `gh` call + one `fields`
object, because the current requirement is exactly one optional column.

## 7. File-Level Plan

| File | Change |
|---|---|
| `scripts/lib/fleet/gh-facts.mjs` | modify — field split, second call, `unknown` state, 403 classification |
| `scripts/lib/fleet/overlap.mjs` | modify — `isStaleUntracked`, `splitHidden` (`buildStatus` unchanged) |
| `scripts/lib/fleet/facts.mjs` / `git-facts.mjs` | modify — `worktreeDirty` for candidate worktrees |
| `scripts/lib/fleet/render.mjs` | modify — `checks:unknown`, `PR checks:` source line, hidden line |
| `scripts/lib/fleet/argv.mjs` / `commands.mjs` | modify — `--all` on `status`, pass through |
| `scripts/lib/fleet/contracts.mjs` | modify — `NoteSchema`, `TierSchema.note` |
| `scripts/lib/fleet/config.mjs` | modify — `CheckSchema.note` |
| `scripts/lib/fleet/checks.mjs` | modify — carry `note` into results |
| `scripts/lib/fleet/render-train.mjs` | modify — print notes (deferred, tier, check) |
| `skills/fleet/SKILL.md` (+ regenerated `.claude/skills/fleet/**`) | modify — three-dot sentence, `--all`, `note` |
| `docs/plans/fleet-multi-session-coordination.md` | modify — §2b amendment |
| `tests/fleet-gh-facts.test.mjs` (new), `fleet-overlap`, `fleet-cli`, `fleet-config`, `fleet-checks`, `fleet-git-facts` | create/modify |

## 9. Testing Strategy

- **Fake `gh` that 403s ONLY on `statusCheckRollup`** (a shim that inspects
  `--json`): core call succeeds; assert `prs.queried:true`, every PR present,
  `fields.checks.queried:false` with the 403 reason, every `checks.state ===
  'unknown'`, render shows `PR checks: not queried` and never `checks:success`.
  Negative control: the same shim against the OLD single-call code must fail
  (red-then-green, verified by running the new test against `git stash`-free
  reverted `PR_LIST_FIELDS`).
- Happy path: both calls succeed → states identical to today (existing tests stay).
- Second call fails for a *different* reason (offline/timeout): core intact,
  checks `unknown` with that reason.
- Checks join: a PR absent from the checks listing is `unknown` (not `none`);
  a matching empty rollup is `none`; `missing` count and `PR checks: partial`
  render; a malformed checks row leaves its PR `unknown`.
- `isStaleUntracked` table test: ahead 0 / ahead null / ahead>0 / has PR /
  PR list incomplete or unqueried / dirty worktree / worktree status failed /
  clean worktree / tracked / detached / remote-only; plus `splitHidden` leaves
  overlaps identical with and without `--all`, and `land`/`train-approve` paths
  still see every tracked item.
- `buildStatus` always returns every item (complete domain result, unchanged);
  `splitHidden` alone controls visible items and `hidden:{count,ids}`; a
  registered session at ahead 0 is never hidden; `hidden.ids` complete. CLI:
  `status --all` accepted; status text and `--json` honour it; `land` and
  `train-approve` still receive the complete status.
- Worktree-cleanliness probes: over the candidate cap and past the aggregate
  deadline both leave the remainder `unknown` (visible); a slow probe is cut at
  its per-process timeout.
- `note`: accepted ≤300, rejected at 301, rejected with a newline, rejected
  unknown sibling key; printed beside deferred tier / tier result / check line;
  present in the written manifest and in check results.
- Three-dot: fixture repo where base advances touching `X` after a branch forks
  and touches only `Y`: `changedFiles` is exactly `[Y]` (two-dot would add `X`).

## 8. Risk & Trade-off Register

- A second `gh` call doubles API calls on `status`. Accepted: one extra list
  call, only paid once per status; `--no-prs` paths already skip both.
- Hiding by default can make an untracked ahead-0 worktree look absent. Mitigated:
  a dirty or unknown-cleanliness worktree is never hidden, the hidden-count line
  and `--all` stay explicit, registered sessions are never hidden. Cost: one
  bounded `git status` per ahead-0 untracked worktree.
- Existing fake-`gh` tests assume one call; they are updated, not loosened.

## Out of Scope (Future)

Home dashboard, auto-merge, new verbs, closed-PR listing, hiding detached
worktrees.

## Audit trail

- **/audit-plan** (session audit-plan-1791287978): GPT R1 H:1 M:2 -> R2 M:2 (H:0); all 5 findings accepted as fix-now (acceptance 100% each round, 0 dismissed/deferred). Converged at round 2: round-2 findings were a stale test bullet and an unbounded probe budget, both resolved. Gemini final gate R1 **APPROVE** (blocking 0, debt 0).
- **/audit-code** (session audit-code-1791289945, one unit over 17 files): GPT R1 H:3 M:9; acceptance 17% (2 accepted and fixed, 10 dismissed/deferred as independent pre-existing code or an audit-tool bound), so stopped at R1 per the rigor-pressure rule. Fixed: headRefOid-matched checks join (M1), raw-input control-char validation before trim (M8). Gemini final gate **APPROVE** (blocking 0, new 0, wrongly dismissed 0). Mutation check: restoring the single-call field list fails 5 of 8 new gh-facts tests.
- **Recorded, not fixed (independent of this change):** subprocess process-tree cleanup in checks.mjs/train.mjs (H1-H3, M3; the setsid limit is documented in SKILL.md), hard-coded `fleet repair` hint in `renderClaimVerdict` (M2), `currentBranch` null-vs-failure (M7), branch-name evidence capture in `gatherFacts` (M4), claim-grammar recursion bounds (M5).
