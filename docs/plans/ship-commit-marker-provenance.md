# Plan: ship-commit refuses an audit marker that describes another branch's code
- **Date**: 2026-10-15
- **Status**: In Progress
- **Author**: Claude + Louis
- **Scope**: backend (one CLI + one pure module; no UI)
- **Origin**: fleet `p-20261015130416-f9f9`, found while shipping `audit-unadmitted-files` PR 1. Direct fix (coordinator route): no plan phase, no new behaviour beyond the refusal.

## The defect, replayed

`.audit/last-audit-run.json` was written by the audit of branch `fix/audit-generated-stores`. The next `/ship` commit was on `fix/audit-unadmitted-files`. `scripts/ship-commit.mjs` compared the worktree to the caller's own `--expect-head/--expect-branch` (which matched) and never compared the MARKER's `auditedBranch` / `auditedSha` to the commit being made, so it stamped `AI-Gate: converged` and the other branch's `AI-Run-ID`. Caught only by reading the trailer back.

## The fix

`checkEvidenceProvenance` (`scripts/lib/commit-trailers.mjs`, pure) and its one call site in `scripts/ship-commit.mjs`, after worktree identity is verified: a `fresh` or `stale` marker whose `auditedBranch` is a string different from the committing branch, or whose `auditedSha` is not an ancestor of HEAD (or HEAD is unborn), is treated as ABSENT. No `AI-Run-ID`; `--gate passed|converged|waived` cannot be claimed from it; a notice on stderr names the reason. Legacy markers with neither field, markers captured detached (`auditedBranch: null`), and absent/opted-out/malformed evidence are not judged.

A rebased branch's marker is refused too (its audited sha leaves HEAD's history); the ship then records `not-run`, which is true of the rebased tree.

## Tests

`tests/ship-commit-evidence-provenance.test.mjs`: the pure rule with controls in the directions it must not fire; the incident replayed through the real CLI (another branch's marker; an audited sha outside the history; the unborn first commit); the control that this branch's own marker is still evidence.
