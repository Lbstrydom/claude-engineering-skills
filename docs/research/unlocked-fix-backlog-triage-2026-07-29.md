# Unlocked-fix backlog: which of the 118 actually have regression coverage

**Date**: 2026-07-29 · **Hand-verified**: 33 of 118 · **Real coverage found**: 9

## Headline

The strongest mechanical tier — a test naming ≥2 of the exact identifiers the
finding is about — turned out to be **27% precision**. Nine of the 33 findings
I read had genuine coverage. That number is the point of this document: it is
the measured cost of trusting a heuristic, and it is why `lock-with-test`
refuses to bulk-close.

Had the 119 been closed by filename matching (the obvious shortcut, and the one
I was asked not to take), roughly **three quarters of the resulting locks would
have been false** — each one a `regression_specs` row asserting coverage that
does not exist, in the table the /ship gate trusts.

## Method

1. Pulled all 118 `audit_mode='code'` rows from `unlocked_fixes` (91 in
   claude-engineering-skills, 27 in wine-cellar-app; both repos local).
2. Extracted the identifiers each finding actually names — backticked tokens
   and camelCase words from `detail_snapshot` — and searched every test file in
   the owning repo for them.
3. Ranked by evidence strength, then **read the test** for the top tier.

Ranking is not judging. A symbol appearing in a test proves the test touches
it, never that it pins the claimed behaviour — which is exactly what the
verification found.

### A contamination bug worth recording

The first run reported 37 `symbol-match` hits, of which **34 pointed into
`.claude/worktrees/`** — full repo copies belonging to other agent sessions.
The directory walk excluded `.git` and `node_modules` but not those. Every
"match" was against a different checkout's tests. Fixed before any verdict was
formed; noted because a triage tool that silently reads another checkout is a
failure mode that would survive review.

## Results

| tier | n | hand-verified | real coverage |
|---|---|---|---|
| symbol-match | 37 | 33 | **9** |
| weak-symbol | 34 | 0 | — |
| module-test | 24 | 0 | — |
| no-test | 17 | 0 | — (none exists, by definition) |
| unresolved | 6 | 0 | — (`primary_file` does not resolve on disk) |

Of the 33 read: **9 covered, 9 partial, 15 not covered.**

### The 9 with real coverage

| finding | module | locking test |
|---|---|---|
| `8e8ac4ca` | `audit/diff-path-map.mjs` | `tiered-pipeline-stage0-wiring.test.mjs` — imports and exercises both planned exports (finding was "module absent") |
| `f7b530ff` | `store/arch/coverage.mjs` | `arch-memory-split.test.mjs` — pins both exports (finding was "module and exports absent") |
| `fc7b6229` | `store/runs-findings.mjs` | `persist-kept-embeddings.test.mjs:115` — "scopes every write through a run-owning predicate, not a bare finding_id equality" |
| `f0a262ef` | `persona-consistency-promote.mjs` | `persona-consistency-promote.test.mjs:123,142` — pins the interpreter over `rowsAffected:3` and a genuine `rowsAffected:0` |
| `d31a08c8` | `regenerate-skill-copies.mjs` | `regenerate-skill-copies.test.mjs` — suite's stated purpose is guarding the non-atomic `copyFileIfChanged` write |
| `b70df92c`, `a7a46957` | `security/triage-router.mjs` | `security-triage-router.test.mjs:328` — see note below |
| `0ed87ecc` | `dishFingerprintBackfillPanel.js` (wine) | `dishFingerprintBackfillPanel.test.js:77` — "does NOT claim 'All dishes fingerprinted' while items were skipped" |
| `634fb74f` | `check-arch-drift-scoped.mjs` (wine) | `checkArchDriftScoped.test.js:216` — throws on `Infinity`, with the NaN-comparison rationale in-comment |

**`b70df92c` / `a7a46957` are a different shape and should be read as such.**
The test does not fix the flagged behaviour — it *accepts* it: "sourceContext is
allowed through to the report — its redaction is Phase 3's job". That is still a
legitimate lock (it pins the interim contract so it cannot change silently), but
the underlying concern is deferred, not resolved. Recorded explicitly so nobody
later reads a green gate as "that was fixed".

### Why the other 24 failed

Four distinct failure modes, none visible without reading:

- **Wrong module entirely** (6). Generic identifiers — `result`, `readFileSync`,
  `diffText`, `repo_id` — matched a well-tested but unrelated file.
  `fe3d7989` (runs-findings) matched `arm-eval-judge.test.mjs`; `85c49c1f`
  (lint/on-conflict) matched `db-query.test.mjs`.
- **Export-surface listing mistaken for behaviour** (3). `6ef709e5` /
  `7107517f` matched `arch-memory-split.test.mjs` because
  `markImportGraphPopulated` appears there — in a *list of expected export
  names*. The function is never called.
- **Right module, wrong edge case** (10). The most common. Tests exercise the
  module but not the claimed failure: `9ff852f6` asserts `applyFixes` *calls*
  `atomicWriteFileSync`, not the content-verification the finding is about;
  `ea772d33` tests `classifyLocationPath` and `readBoundedLines` separately,
  never the TOCTOU binding between them; `a06969b1`/`197e068d` never construct
  the unreadable-directory (EACCES) case at all.
- **Matched a helper, not a test** (1). `23ed4020` → `tests/helpers/mockDb.js`.

## What was locked

Seven, in this repo. Code count **119 → 112**.

The two verified wine findings (`0ed87ecc`, `634fb74f`) are **not** locked:
`lock-with-test` resolves the test path against the working directory and
refuses one it cannot see, so they must be run from `wine-cellar-app`. That is
the containment check behaving correctly, not a gap.

## What remains, and the honest read

**112 code obligations.** Of those, 24 were read and found wanting; 81 were
never read.

The unread remainder should **not** be assumed similar to the verified tier. If
anything it is worse: `symbol-match` was the *strongest* evidence tier, and it
came in at 27%. `weak-symbol` (34) is a single generic-token match — expect
mostly wrong-module. `no-test` (17) is definitionally uncovered and needs tests
written, not locks recorded. `unresolved` (6) name files that no longer exist,
which likely means the finding predates a rename and should be adjudicated
away rather than locked.

The realistic path is not a sweep. It is: when you touch one of these modules
next, check whether the finding's edge case is covered, and lock it or write
the test then. The worksheet exists to make that a one-minute step:

```bash
node scripts/cross-skill.mjs lock-with-test --worksheet
```

**A backlog of 112 honest obligations is a better artifact than 119 closed
ones, 82 of which would have been lies.**
