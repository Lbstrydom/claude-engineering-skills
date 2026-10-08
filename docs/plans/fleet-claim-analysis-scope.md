# Plan: /fleet — session-only verbs stop diffing every untracked branch
- **Date**: 2026-10-08
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend (CLI; no UI, no skill text) · stack `js-ts`
- **Target domain(s)**: `fleet`
- **Depends on**: docs/plans/fleet-capstone-feedback.md (Complete) — deferred findings M1 and M4
  of its /audit-code session (audit-code-1791459567)

## 1. Context Summary

`gatherFacts` ran one `git diff --name-only` (and, with patches, one patch-id diff) per branch
ahead of base, for every verb. `claim`, `add`, `ready` and `start` never read that evidence for
an UNTRACKED branch: their only consumer is `othersFor`, which maps registered sessions. In the
capstone repo (~60 stale branches still ahead of base) every `claim` therefore paid ~60 git
calls for nothing. Separately, `gatherFacts` had grown to ~107 lines mixing candidate
selection, the `maxBranches` budget, per-branch evidence and PR-session trust.

**Code Trace (f5c74879).** Callers of `gatherFacts`: `commands.mjs` status `:119` (needs
untracked), claim `:149`, add `:211`, ready `:282`, start `:386` (session-only); `land.mjs:62,86`
(check payload + landing order include untracked overlaps — keep); `train-approve.mjs:159`
(keep); `collect-home-inflight.mjs:51` (keep). `ready` reads only the registry and
`base.measure`.

## 2. Proposed Architecture

- `gatherFacts({..., untracked = true})`. `false` skips untracked branches ahead of base and
  records each in `changed` as `{queried:false, files:[], reason:'not requested: …'}` — the
  existing provenance shape, so nothing can read a skipped branch as "changed nothing".
  A branch some registered session points at (of ANY kind) is still a candidate, so a PR
  session's local-branch trust path is unchanged.
- The four session-only verbs pass `untracked: false`; every other caller keeps the default.
- `gatherFacts` becomes a ~40-line sequencer over `selectBranchesToAnalyse` (exported, pure),
  `branchEvidence` and `prSessionEvidence` (returns the `pr:<n>` keys it adds instead of
  mutating shared state). Behaviour is otherwise byte-for-byte the same.

**Right-sizing.** Band-aid: cap analysis for claim with `maxBranches` (still pays up to the cap
and reports a misleading "not analysed" overflow). Over-built: a per-verb fact-requirements
schema. Chosen: one boolean beside the existing `prs`/`patches`/`worktrees` switches.

## 9. Testing Strategy

`tests/fleet-claim-analysis-scope.test.mjs`. The CLI test counts real `git diff --name-only`
invocations with `GIT_TRACE` (kept by `sanitizeGitEnv`, which strips only repo-local
variables): a claim over 8 untracked branches + 1 session makes exactly 1; the control
(`status` on the same repo) makes 9. The claim gate still blocks on a session's CHANGED file
(declared paths deliberately disjoint). Red-then-green: restoring the full analysis on claim,
ignoring `untracked:false`, and dropping the not-queried record each fail a test.
