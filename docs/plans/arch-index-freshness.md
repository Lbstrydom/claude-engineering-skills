# Plan: The drift report says how far the active index trails the default branch

- **Date**: 2026-10-11
- **Status**: In Progress — implemented on `fix/arch-index-freshness`; under /audit-code
- **Author**: Claude + Louis
- **Scope**: backend (architectural-memory report; no store or schema change)

> **Target domain(s)**: `arch-memory`.

## 1. Context Summary

**Measured 2026-10-11** (`npm run arch:drift`): the report printed
`Commit: a6b035b3…` (2026-09-27) while `origin/main` was at `56eb0459`, 62
commits ahead (`git rev-list --count a6b035b3..origin/main`; 40 first-parent).
Nothing in the report said so.

Cause, derived: #134 (2026-09-29) made `arch:refresh` publish the active index
only from the default branch (`scripts/symbol-index/refresh-publish-guard.mjs`).
Since the branch+PR workflow every push is a feature-branch push, so the
pre-push maintenance refresh skips (exit 0, `skipped: not-default-branch`)
and the index stops moving. `arch-maintenance` read `attention` only because
the drift step exits 1 on RED — the skip itself is invisible. The guard is
right; the report's silence about its consequence is the defect.

## 2. Proposed Architecture

- `assessIndexFreshness({run, indexCommit})` beside `resolveDefaultBranch` in
  `refresh-publish-guard.mjs` (one module owns "what is the default branch"):
  decided by identity and ancestry against `origin/<default>` first —
  `current` (same commit) / `behind` N (index an ancestor of the tip; N from
  `rev-list --count`) / `off-branch` (ahead or diverged — a count alone reads
  an index AHEAD of the tip as 0 behind) / `unknown` (shallow clone, commit
  absent, git could not run, no default branch). Never `current` by default.
- `renderDriftIssue` (`scripts/lib/arch-render.mjs`) takes an optional
  `freshness` and renders `Index freshness:` beside `Commit:`; a stale index
  says the report "measures <commit>, not the current code". No `freshness`
  → no line, so other renderers are unchanged.
- `drift.mjs` computes it, puts it in the markdown and the `--json` envelope,
  and warns on stderr when behind. The exit code is unchanged (RED is still
  the only non-zero verdict).

**Out of scope, named**: WHO refreshes the index now that nobody pushes the
default branch (Lane B5, a post-merge maintenance runner). This change makes
the staleness visible; it does not move the index.

## 3. Testing Strategy

- `tests/refresh-publish-guard.test.mjs` (real git fixtures): current at the
  tip; counts default-branch commits the index lacks; measures against
  `origin/main`, not a stale local `main`; an unknown commit and an absent
  commit are `unknown`.
- `tests/arch-render.test.mjs`: behind / current / unknown lines; no line
  when `freshness` is absent.

## 4. Acceptance Criteria

- `npm run arch:drift` on a stale index prints `Index freshness: ⚠ N commits
  behind origin/main` and the stderr warning; `--json` carries `freshness`.
