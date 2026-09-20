# Audit Summary: audit-target-identity-commit-sha-correction

- **Session**: audit-code-1789921259
- **Rounds**: 3 (converged, 2/2 stable at H:0 M:0)
- **Scope**: `--scope diff` (dirty tree, base=HEAD), 10 changed files

## Round 1 — SIGNIFICANT_ISSUES, H:16 M:11

All 16 HIGH and 8 of 11 MEDIUM findings cited pre-existing functions in
`scripts/lib/store/runs-findings.mjs` (write-path transactional/identity
concerns: `recordFindings`, `recordAdjudicationEvent`, `applyRemediationVerificationResults`,
`persistKeptEmbeddings`, `recordFinalReviewFix`, `recordFinalReviewFindings`,
`reconcileRemediationProjection`, etc.) and one in `scripts/lib/campaign/promote.mjs`
(`detectPlanHashMismatches`'s dictionary-lookup bug). **Verified independence
by grep**: zero call-path coupling between any of these functions and
`getRunMeta`/`auditedShasForRuns`/`classifyLogEntry` — the only functions this
plan's diff touches in those two files. Deferred as out-of-scope debt (24
entries captured via `debt-auto-capture.mjs`).

Two MEDIUM findings were real and in-scope:
- **M8** — the captured `audited_tree` object has no durable retention
  mechanism (git gc could theoretically prune it). Fixed: documented as an
  accepted risk in a code comment on `treeExists` — not eliminated (pinning
  the tree with a ref would be schema/tooling scope creep for this plan).
- **M9** — the new test's git fixture inherits ambient config (signing,
  hooks, templates), which could hang/fail in an environment with global
  git config set. Fixed: isolated the fixture via `GIT_CONFIG_NOSYSTEM` +
  a throwaway `HOME` + explicit `-c` overrides.

One MEDIUM (**M7**) restated the plan's own already-documented residual
explicit-`--base` limitation with no new action requested — dismissed.

## Round 2 — PASS, H:0 M:0 L:0

Verification audit scoped to the two files actually changed this round
(`scripts/solo-control-audit.mjs`, `tests/solo-control-audit-target-diff.test.mjs`).

## Round 3 — PASS, H:0 M:0 L:0

Confirms 2/2 stability. **CONVERGED.**

## Detector census (Step 5.0b)

No cross-cutting findings this run — `blocked: false`, `checked: 0`.

## Full test suite

`npm test` — 16,048 pass, 0 fail, 40 skipped (DB-gated), run before the code
audit and unaffected by the M8/M9 documentation/isolation fixes.
