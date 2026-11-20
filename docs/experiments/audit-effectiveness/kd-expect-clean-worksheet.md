# expect_clean curation worksheet (proposed 2026-11-19, approved 2026-11-20)

> **APPROVED 2026-11-20 by Louis (all 12 entries).** Recorded in `known-defects.json` as KD-030..041. Clean means evidence of absence, not proof.

**What `expect_clean` measures.** A clean case is a known-good commit. The candidate audits its diff with the real 5-pass arm; any MEDIUM or
HIGH finding on the commit's files is a *false positive*. The report is the false-positive rate over measured cases.

**What "clean" means here, and its limit.** These commits are chosen by evidence of absence, not proof:
1. the commit's added lines still survive unmodified at `origin/main` (blame-attributed to it);
2. no later commit message names the sha beside fix, revert, regression or bug;
3. it is a feature or refactor commit (not a fix, docs or chore), touching 1-2 source files under `scripts/`, 2.5K-30K diff chars;
4. its diff passes the egress gates (`assertEgressSafe`, `findSensitivePathMentions`).

A latent defect nobody has found yet is scored as a false positive, so the rate is an upper bound on noise, not an exact figure.

## Your job per entry (~3 min each)
1. `git show <sha>` and skim: do you know of a defect in it that was never fixed or recorded? If so, **discard** the entry.
2. Approve or strike each row. Approved rows are appended to `defects` in `known-defects.json` exactly as the skeleton shows.

**Cost.** Each case is a full 5-pass generation, driven by diff size (the largest two below are 27K and 17K chars). The planned spend
breakdown goes to the coordinator before the first paid call, under a hard $30 cap metered on provider-reported cost.

## KD-030: feat(cadence-doctor): a green run can declare it measured nothing ('unmeasured')
- Commit `cf4c75f340e1f29e62080ac5f3b5c5b7f2bb370d` (2026-09-13); files: `scripts/lib/measurement-marker.mjs`, `scripts/workflow-cadence-doctor.mjs`
- Evidence: 100% of its 372 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 26886 chars; provenance trailer `AI-Gate: not-run`.
```json
{ "id": "KD-030", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "cf4c75f340e1f29e62080ac5f3b5c5b7f2bb370d", "files": ["scripts/lib/measurement-marker.mjs","scripts/workflow-cadence-doctor.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-031: feat(gate): guards:preflight runs the whole-suite guards in minutes, before a gate slot (#239)
- Commit `d6f7c8895503d6ada22f5af320438dc361d09653` (2026-10-13); files: `scripts/guards-preflight.mjs`, `scripts/lib/guards-preflight.mjs`
- Evidence: 100% of its 285 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 16756 chars; provenance trailer `AI-Gate: waived`.
```json
{ "id": "KD-031", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "d6f7c8895503d6ada22f5af320438dc361d09653", "files": ["scripts/guards-preflight.mjs","scripts/lib/guards-preflight.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-032: feat(campaign): --redo, so a resolver fix can reach the rows it would have helped
- Commit `e638ab7eef070ce3495fe5031f14525dc26e97c0` (2026-08-19); files: `scripts/campaign.mjs`, `scripts/lib/store/campaign.mjs`
- Evidence: 100% of its 122 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 11557 chars; provenance trailer `AI-Gate: not-run`.
```json
{ "id": "KD-032", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "e638ab7eef070ce3495fe5031f14525dc26e97c0", "files": ["scripts/campaign.mjs","scripts/lib/store/campaign.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-033: feat(merge-friction): stop committing skills.manifest.json and the plans-index counts; release.yml fixes (#256
- **INVALIDATED 2026-11-20:** the egress gate refused this commit's diff at preflight (`egress_blocked`); the two scored files are clean, so the trigger elsewhere in the commit is unidentified. Dropped from the run (11 cases).
- Commit `42f9ff84cf512143e1d91bdc391a4a5b432ab8c2` (2026-10-15); files: `scripts/build-manifest.mjs`, `scripts/generate-plans-index.mjs`
- Evidence: 100% of its 48 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 8929 chars; provenance trailer `AI-Gate: converged`.
```json
{ "id": "KD-033", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "42f9ff84cf512143e1d91bdc391a4a5b432ab8c2", "files": ["scripts/build-manifest.mjs","scripts/generate-plans-index.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-034: Prompt audit (Opus 5.5): stop sending temperature to Claude, refresh skill pins and volume (#325)
- Commit `c351ac177ab8f3b27cbf4c3bc06b5744909458ac` (2026-11-01); files: `scripts/lib/model-eval/provider-adapter.mjs`, `scripts/solo-control-audit.mjs`
- Evidence: 100% of its 25 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 8000 chars; provenance trailer `AI-Gate: none`.
```json
{ "id": "KD-034", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "c351ac177ab8f3b27cbf4c3bc06b5744909458ac", "files": ["scripts/lib/model-eval/provider-adapter.mjs","scripts/solo-control-audit.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-035: perf(adjacency): resolve all anchor lines in one AST traversal
- Commit `a83146a97181c4dbaa38e190ff829fa71aac55a6` (2026-09-04); files: `scripts/lib/audit/adjacency-detector.mjs`
- Evidence: 100% of its 62 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 5289 chars; provenance trailer `AI-Gate: not-run`.
```json
{ "id": "KD-035", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "a83146a97181c4dbaa38e190ff829fa71aac55a6", "files": ["scripts/lib/audit/adjacency-detector.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-036: feat(check-accepted-debt): add --print-fingerprints to regenerate drifted registry rows
- Commit `4854f6a5dec6047556213de87dcbb19e9e50ede4` (2026-09-14); files: `scripts/check-accepted-debt.mjs`
- Evidence: 100% of its 56 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 5104 chars; provenance trailer `AI-Gate: none`.
```json
{ "id": "KD-036", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "4854f6a5dec6047556213de87dcbb19e9e50ede4", "files": ["scripts/check-accepted-debt.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-037: visual-audit: expand light-dark() colours into theme-scoped tokens (#111)
- Commit `c5d8f2d70661378357540aaaab018306222ef5bf` (2026-09-21); files: `scripts/lib/visual/tokens.mjs`
- Evidence: 100% of its 59 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 4997 chars; provenance trailer `AI-Gate: none`.
```json
{ "id": "KD-037", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "c5d8f2d70661378357540aaaab018306222ef5bf", "files": ["scripts/lib/visual/tokens.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-038: final reviewer: best available Gemini (latest-pro); version-free reviewer wording (#187)
- Commit `f7ca3c16383e46021cf4ab13f7f133098e3c9588` (2026-10-10); files: `scripts/lib/final-review-config.mjs`
- Evidence: 100% of its 41 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 3768 chars; provenance trailer `AI-Gate: waived`.
```json
{ "id": "KD-038", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "f7ca3c16383e46021cf4ab13f7f133098e3c9588", "files": ["scripts/lib/final-review-config.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-039: feat(gate-honesty): contract the debt-capture partial-refusal gate
- Commit `b0d864dbd29f753025e23583e247221c4d620bab` (2026-09-04); files: `scripts/lib/gate-honesty/oracles.mjs`, `scripts/lib/gate-honesty/schema.mjs`
- Evidence: 100% of its 41 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 2979 chars; provenance trailer `AI-Gate: not-run`.
```json
{ "id": "KD-039", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "b0d864dbd29f753025e23583e247221c4d620bab", "files": ["scripts/lib/gate-honesty/oracles.mjs","scripts/lib/gate-honesty/schema.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-040: feat(durable-write): the writer registry, and the constraint it could not run without
- Commit `72e0a0efcf678a6ac4813d4f3d280beafa1b4c18` (2026-08-12); files: `scripts/lib/durable-write.mjs`
- Evidence: 96% of its 303 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 13079 chars; provenance trailer `AI-Gate: not-run`.
```json
{ "id": "KD-040", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "72e0a0efcf678a6ac4813d4f3d280beafa1b4c18", "files": ["scripts/lib/durable-write.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

## KD-041: perf(fleet): session-only verbs stop diffing every untracked branch; split gatherFacts (#169)
- Commit `daa0fdf3aa65acb45b709d682200ca7cabdd9450` (2026-10-08); files: `scripts/lib/fleet/commands.mjs`, `scripts/lib/fleet/facts.mjs`
- Evidence: 93% of its 83 added lines survive unmodified at origin/main; no later commit names it as a defect; diff 15029 chars; provenance trailer `AI-Gate: none`.
```json
{ "id": "KD-041", "repo": "claude-engineering-skills", "suite": "expect_clean", "commit": "daa0fdf3aa65acb45b709d682200ca7cabdd9450", "files": ["scripts/lib/fleet/commands.mjs","scripts/lib/fleet/facts.mjs"],
  "rationale": "Feature commit whose added lines survive unmodified at origin/main, with no later commit naming a defect in it.",
  "curation": { "method": "human-review", "reviewedIn": "docs/experiments/audit-effectiveness/kd-expect-clean-worksheet.md" } }
```

