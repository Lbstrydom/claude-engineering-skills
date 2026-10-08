# Plan: /fleet — idle-branch hiding and hot files (capstone consumer feedback)
- **Date**: 2026-10-08
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend (CLI + skill content; no UI) · stack `js-ts`
- **Target domain(s)**: `fleet`, `skills-content`
- **Depends on**: docs/plans/fleet-storyline-feedback.md (Complete) — the hiding rule and its
  "every unknown keeps the item visible" contract this extends

## 1. Context Summary

The capstone consumer (reported 2026-10-08) found the default `fleet status` view
dominated by ~60 stale local branches that are still AHEAD of base — squash-merged
(the squash commit is a new oid, so the original tip never becomes an ancestor) or
abandoned — each listing 5+ overlap files. Two causes, two asks:

- **(a)** the storyline rule hides only `ahead === 0`; a squash-merged branch is
  never ahead 0, so it is never hidden.
- **(b)** most of those overlaps are on files every branch touches by design
  (ratchet baselines such as `domainBudgets.json`, debt ledgers such as
  `tech-debt.json`), so even live work reads as conflicting with everything.

**Code Trace (e9307d26).** `cmdStatus` `commands.mjs:123` → `gatherFacts`
`facts.mjs:97` (`listBranches` already captures `tipTime`; `probeWorktreeCleanliness`
`:191` probes ahead-0 candidates) → `buildStatus` `overlap.mjs:474` (untracked loop
`:531`, overlap join `:568-586`, `overlapCount` for landing order `:596`) →
`splitHidden` `:657` / `isStaleUntracked` `:641` → `renderStatus` `render.mjs:72`.
Claim gate: `decideClaim` `overlap.mjs:232`, called by `cmdClaim`, `cmdAdd`,
`cmdStart`; its `others` are REGISTERED sessions only (`othersFor`), so untracked
branches never reach the gate — hiding is purely presentational. Other readers of
`item.overlaps`: `payloadFromStatus` (hook stdin), Home in-flight overlap count.

## 2. Proposed Architecture

### 2.1 Idle hiding (ask a)

- `hideReason(item, {prsComplete, now, idleMs}) → 'merged' | 'idle' | null`
  replaces the body of `isStaleUntracked` (kept as its boolean form). Common
  conditions are unchanged (untracked, local branch, no open PR, COMPLETE PR
  lookup, clean-or-absent worktree). `idle` additionally needs a KNOWN ahead count
  and `isIdleTip(tipTime, now, idleMs)`: tip older than the window. Unknown tip,
  no clock, a future-dated tip (negative age) and a non-positive window all answer
  "not idle" — every unknown keeps the item visible.
- Window: `.fleet.json` `hideIdleAfterDays` (integer 1–3650, default **14**).
  Configurable because the right cadence is a property of the repo; one key.
- The clock is `status.observedAt` (the one `now` read by `resolveNow`).
- Worktree cleanliness: the bounded probe's candidate set widens from "ahead 0"
  to "ahead 0 OR idle", same caps (20 candidates, 15 s aggregate). An idle branch
  whose worktree is unchecked stays visible and is counted (`N … shown:
  cleanliness unchecked`).
- **Overlaps into hidden items.** Unlike a merged item, an idle item is ahead and
  CAN overlap a visible one. `splitHidden` (still the only presentation boundary;
  `buildStatus` stays complete) moves those entries off the visible copy into
  `overlapsWithHidden` (ids), rendered as one `+ overlaps N hidden items — use
  --all` line — disclosed as a count, never dropped. `--all` shows the original.
- Render: `N hidden (M merged into base, K idle > D days) — use --all`.

### 2.2 Hot files (ask b)

- `.fleet.json` `hotFiles`: array (≤ 200) of patterns, each validated with the
  claim grammar (`validateClaimPattern`), so hot matching and claim matching share
  one bounded, repo-relative semantics. Strict schema intact (a near-miss key is
  refused by name).
- **Classification (sound):** a changed FILE is hot when a hot pattern matches it.
  A declared-path PAIR is hot only when one side is a LITERAL path that is itself
  hot — the pair's intersection is then at most that file. A wildcard pair stays a
  real conflict even when it covers a hot file, because it may cover non-hot files.
- **Status join:** hot-only evidence goes to `item.hotOverlaps`
  (`{with, files}`), not `item.overlaps`; a mixed pair keeps its real files in
  `overlaps` and its hot files in `hotOverlaps`. Landing order's `overlapCount`
  therefore counts real conflicts only. Rendered as ONE collapsed line per item:
  `hot files shared with N items: a, b (not counted as conflicts)`.
- **Claim gate — decided: hot-only evidence does NOT block (new) or warn (adopt),
  and IS disclosed.** A conflict whose only evidence is hot gets `hotOnly:true`
  and `hotFiles`; `isBlockingConflict(c) = !c.known && !c.hotOnly` is the one
  predicate `decideClaim`, `claim --override` and `start` use. Rendered `[hot] …
  (disclosed, not blocking)`. Why not block: by declaration every branch touches
  these files, so blocking would block every new chip and train operators to
  `--override` — a cried-wolf gate. Why disclose: a hot file can still produce a
  real textual conflict at land time (the train's merge catches that, not the
  claim gate). Mixed evidence, identical intent and wildcard pairs still block, with
  hot files listed apart as `(not counted)`.
- **Hook payload:** `overlaps` excludes hot-only pairs (they are not conflicts); a
  new additive `hotOverlaps` array keeps them visible to the repo's check script.
- Home in-flight receives `hotFiles` (patterns are data, not consumer code) so its
  overlap count agrees with `fleet status`; the resumed train's check payload too.

**Right-sizing.** Band-aid: a bigger hard-coded `ahead`/age heuristic or a
consumer-side grep filter on the output. Over-built: per-file weights, a
"conflict severity" model, or querying closed PRs to prove squash merges (a second
PR listing, and still wrong for abandoned branches). Chosen: one age predicate
over a fact already captured (`tipTime`) and one validated pattern list.

## 7. File-Level Plan

| File | Change |
|---|---|
| `scripts/lib/fleet/overlap.mjs` | `isHotFile`, `splitHotFiles`, `isBlockingConflict`, `isIdleTip`, `hideReason`, `idleMsFrom`; `decideClaim` + `buildStatus` hot split; `splitHidden` idle + fold |
| `scripts/lib/fleet/config.mjs` | `hotFiles`, `hideIdleAfterDays` in `FleetFileSchema` + grammar validation |
| `scripts/lib/fleet/facts.mjs` / `checks.mjs` | facts carry `hotFiles`; probe widened; `hotOverlaps` in the hook payload |
| `scripts/lib/fleet/commands.mjs` / `render.mjs` / `land.mjs` | pass `hotFiles`/`idleMs`; render hidden reasons, folded overlaps, hot lines |
| `scripts/lib/dashboard/collect-home-inflight.mjs` | pass `hotFiles` |
| `skills/fleet/SKILL.md`, `docs/plans/fleet-multi-session-coordination.md` | document both |
| `tests/fleet-capstone-feedback.test.mjs` | new |

## 9. Testing Strategy

Every "hides" / "does not block" assertion has a negative control that fires the
other way on the same input: the same 60-day branch is visible under
`hideIdleAfterDays: 90` and with PRs not queried; the same claim is BLOCKED (exit 3)
without `hotFiles`; the same status counts the hot file as an overlap without
`hotFiles`, and the landing order flips. Predicate tables cover recent / unknown /
future-dated tip, unknown ahead, open PR, incomplete PR lookup, registration,
detached / remote-only items, dirty / unknown worktrees. End to end over a real
repo with back-dated commits and the fake `gh`.

## Out of Scope (Future)

Querying closed/merged PRs; hiding registered-but-stale sessions; a per-file
weighting of overlaps.

## Audit trail

- **Red-then-green (2026-10-08, measured: `node --test tests/fleet-capstone-feedback.test.mjs`
  against hand-applied mutants of `overlap.mjs`)**: removing the idle rule fails 7;
  reading a future tip as old fails 1; letting hot conflicts block fails 5; never
  classifying claim path pairs as hot fails 1; treating a wildcard as a literal fails 1
  (it first SURVIVED — the test's hot list never matched a wildcard's text — and the
  `pkg/?.json` case was added); dropping the status hot split fails 4; dropping the
  overlap fold fails 2. Restored: 43/43 pass. The existing fleet suites: 362 pass, the
  2 storyline assertions on the old `hidden` shape/wording updated.
