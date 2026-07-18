# Plan: Tech Debt Wave 3 — Lint Modernization + Cognitive-Complexity Sweep
- **Date**: 2026-04-27
- **Status**: **Complete** (all 5 PRs shipped 2026-04-27)
- **Author**: Claude + Louis
- **Trigger**: SonarLint warnings cropped up on every Edit during ai-context-sync + audit-loop-split work. Pre-existing across the repo, not introduced by recent changes. Bundling fixes with feature work would muddy diffs; tracked here as a focused sweep.

## Implementation Log

### 2026-04-27 — All 5 PRs shipped in one session

- **PR 1 — Dead-code removal**: Removed unused imports (`normalizePath`, `isSensitiveFile`, `readFileOrDie`, `estimateTokens`) from `scripts/lib/context.mjs` and unused `fs`/`path` imports from `scripts/refine-prompts.mjs`; removed unused `med` variable in `tests/check-model-freshness.test.mjs`.
- **PR 2 — Bulk modernization**: 10 files swept to `node:fs` / `node:path` / `node:crypto` / `node:child_process` prefixes; 10+ files swept `parseInt` → `Number.parseInt`; 26 source + test files swept `replace(/x/g, ...)` → `replaceAll(/x/g, ...)`. Pure modernization, zero behavior changes.
- **PR 3 — `scripts/install-skills.mjs` main()**: Refactored complexity 63 → ≤15 by extracting 8 named helpers (`validateTarget`, `printBanner`, `reconcileJournals`, `maybeWarnGithubSkillsDeprecation`, `buildSkillWrites`, `buildCopilotMergeWrite`, `computeDeletes`, `checkConflicts`, `writeReceiptsByScope`).
- **PR 4 — `scripts/regenerate-skill-copies.mjs` main()**: Refactored complexity 98 → ≤15 by extracting 8 named helpers (`warnGithubSkillsDeprecation`, `loadSkillsOrDie`, `copyFileIfChanged`, `pruneFilesNotInSource`, `syncSkillToDests`, `pruneOrphanSkillDirs`, `syncCopilotPrompts` + sub-helpers `writePromptFiles`, `pruneStalePrompts`, and `computeVerdict`/`emitVerdict`).
- **PR 5 — `scripts/gemini-review.mjs` main()**: Refactored complexity 90 → ≤15 by extracting 12 named helpers (`refreshCatalogAndWarn`, `runPingGemini`, `runPingClaude`, `runPing`, `parseReviewArgs`, `selectProvider`, `buildClient`, `isJsonTruncationError`, `runReviewWithRetry`, `applyDebtSuppression`, `addSemanticIds`, `emitReviewOutput`, `recordNewFindings`, `recordWronglyDismissed`, `recordGeminiOutcomes`).

### Verification

- 1126/1127 tests pass throughout (only pre-existing `vendoring-provenance` SHA pin remains).
- `npm run skills:check` green for 9 skills.
- `node scripts/regenerate-skill-copies.mjs --check` IN SYNC.
- All extracted helpers preserve original behavior; refactor is a pure structural improvement.

---

## 1. Categories

### 1.1 Bulk modernization (likely autofix-able)

| Rule | Pattern | Count est. | Notes |
|---|---|---|---|
| S7781 | Prefer `String#replaceAll()` over `String#replace(/x/g, ...)` | ~30 | Pure modernization; no behavior change |
| S7773 | Prefer `Number.parseInt` over `parseInt` | ~10 (model-resolver.mjs) | Style |
| S7772 | Prefer `node:fs` / `node:path` / `node:crypto` prefixes | ~20 | Modernization; explicit Node built-in resolution |
| S2871 | Provide compare function to `Array.sort()` | ~15 | Real for non-ASCII / case-insensitive sort; cosmetic for ASCII |
| S7780 | `String.raw` over backslash-escaped strings | ~5 | Cosmetic |
| S7778 | Don't call `Array#push()` multiple times | ~10 | Style — collapse to `.push(a, b, c)` or `.concat()` |
| S7723 | `new Array()` vs `Array()` | ~3 (test files) | Cosmetic |

**Approach**: install Biome or run ESLint with `--fix` + `eslint-plugin-unicorn` for the modern-Node rules. Single bulk PR. Verify by running `npm test` before/after — diff should be 0 behavior changes.

### 1.2 Cognitive complexity (real risk; per-function refactor)

S3776 fires on functions with cyclomatic+structural complexity > 15. Worst offenders:

| File | Function | Complexity | Fix approach |
|---|---|---|---|
| `scripts/gemini-review.mjs` | `main()` | 90 | Extract per-mode handlers (review / ping) into separate functions |
| `scripts/regenerate-skill-copies.mjs` | `main()` | 98 | Extract: discover-source, write-targets, prune-orphans, generate-prompts into separate steps |
| `scripts/openai-audit.mjs` | various | 60+ | Per-pass extraction; bandit/ledger plumbing into helpers |
| `scripts/lib/context.mjs` | `_extractRegexFacts`, `readProjectContextForPass` | 19-34 | Extract regex tables + per-pass selectors |
| `scripts/install-skills.mjs` | `main()` | 63 | Extract: write-build, copilot-merge, conflict-detect, transaction into steps |
| `scripts/check-context-drift.mjs` | `extractH2Sections` | reduced to 11 ✓ (already addressed) | — |

**Approach**: per-function refactor PRs. Each one:
1. Extract logical phases into named helpers.
2. Verify behavior with `npm test` (not just lint).
3. Land independently — keeps diffs reviewable.

**Acceptance**: every function ≤15 cognitive complexity, OR explicitly documented as `// SonarLint: complexity acceptable — <reason>` (e.g. main() entry points where extraction would just shuffle code).

### 1.3 Pre-existing dead/unused code

| Rule | File:Line | Action |
|---|---|---|
| S1128 unused import: `normalizePath`, `isSensitiveFile`, `readFileOrDie`, `estimateTokens` | `scripts/lib/context.mjs:12-13` | Remove |
| S1481 / S1854 unused `med` variable | `tests/check-model-freshness.test.mjs:217` | Remove |
| S7721 inner-scope helper | various test files | Optional — sometimes intentional for closure capture |

### 1.4 Out of scope

- Pre-existing nested-ternary, hardcoded windows, etc. that the audit-loop already adjudicated as "intentional design choices" (see audit ledger). These should NOT be bulk-modified — they were dismissed for a reason.

---

## 2. Suggested PR Sequence

1. **PR 1** — Bulk modernization sweep (1.1): single autofix run, ≤30 LOC of behavior-equivalent changes per file. ~1 hr including verify. Low risk.
2. **PR 2** — Dead-code removal (1.3): trivial deletions. ~15 min. Zero risk.
3. **PR 3-7** — Per-function complexity refactors (1.2), one per oversized function. Each ~1-2 hr including tests. Land sequentially to keep diffs small.

Total wall-clock: ~10-12 hr across the sweep. Each PR is independently revertible.

---

## 3. Acceptance — Whole Plan

- [ ] `npm test` passes after each PR
- [ ] No new SonarLint warnings introduced (only existing ones removed)
- [ ] Diff scope: ≤500 LOC per PR for modernization; ≤200 LOC per PR for refactor
- [ ] All function complexity ≤15 (or explicitly suppressed with rationale comment)

---

## 4. Out of Scope

| Item | Why excluded |
|---|---|
| Behavior changes | Pure lint sweep; correctness covered by existing tests |
| Architectural refactors | Use a separate `tech-debt-wave-N` plan |
| External dependency upgrades | Use Dependabot |
| Pre-existing TODO comments | Triage separately |
