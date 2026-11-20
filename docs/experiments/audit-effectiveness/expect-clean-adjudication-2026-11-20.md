# expect_clean adjudication: gpt-6.2-sol on 11 curated-clean commits (2026-11-20)

**Record only.** Nothing here changes code or the corpus. Source: report `expect-clean-11b.json` (run `expect-clean-1795164003797`, harness `1b814de2`, candidate `latest-gpt` = `gpt-6.2-sol`, metered $4.95). The first run (`expect-clean-1795160466117`, $4.96) had the same fpRate but kept no claim text, so this rerun is a different sample of the same cases; generation is not deterministic.

Method: 91 MEDIUM+ findings, each judged by a read-only subagent against the code AT the case's commit (`git show <sha>:<path>`), with `origin/main` checked for the REAL ones. Classes: **REAL** (a genuine defect), **NOT_A_DEFECT** (accurate but a preference, hardening wish, missing-test wish or documented behaviour), **WRONG** (false about the code at that commit), UNDETERMINED. These are single-adjudicator model verdicts, not a human grading; the REAL and WRONG calls are the ones worth a human glance. Per-finding verdicts: [expect-clean-adjudication-2026-11-20.json](expect-clean-adjudication-2026-11-20.json).

## Headline

1. **The corpus entries are not all clean.** 31 of 91 findings are REAL, in 7 of 11 cases (KD-032, KD-034, KD-036, KD-037, KD-038, KD-040, KD-041). 13 were introduced by the case's own commit (marked `*` below; cases KD-032, KD-037, KD-040, KD-041); the rest are pre-existing code the commit touched or relied on. A REAL finding means the curated entry was not clean, not that the auditor was wrong.
2. **There is an instrument defect: the audit reads the current checkout, not the case commit.** All 14 WRONG findings are anachronisms: they cite code that does not exist at the case's commit and was added later (KD-040: 10 of 16 findings cite `drainLocked`, `readTrackedSpillArtifacts`, `checkAdmission`, `quarantine`, which exist only on main; KD-030, KD-039 and KD-041: a claimed deletion or field that a later commit made). Cause: `runAuditGenerationArm` calls `chdir` into the case's `repoRoot` and every file read resolves against that working tree (arm-generation.mjs, around lines 175-190), while only the DIFF comes from the case commit (known-defect-corpus.mjs extracts it via git). The model sees the commit's diff against today's files. Not yet checked: whether the `detect` suite shares this (it uses the same arm); treat as likely until looked at.
3. **fpRate 1.0 is not one number.** See the table below.

## fpRate under each rule (cases with at least one qualifying finding, of 11)

| Rule | Cases | Rate |
|---|---|---|
| (a) current: any MEDIUM or HIGH on the case's files | all | 11/11 (1.00) |
| (b) counting only WRONG findings (the auditor's false claims) | KD-030, KD-039, KD-040, KD-041 | 4/11 (0.36) |
| (b') any finding that is not WRONG | | 10/11 (0.91) |
| (c) HIGH only, any class | | 10/11 (0.91) |
| REAL only (the entry was not clean) | KD-032, KD-034, KD-036, KD-037, KD-038, KD-040, KD-041 | 7/11 (0.64) |
| REAL and HIGH | | 6/11 (0.55) |
| REAL and introduced by the case's own commit | KD-032, KD-037, KD-040, KD-041 | 4/11 (0.36) |

Rule (a) cannot separate the cases: it is 11/11 whether the findings are real, wrong or a preference. Under the stricter readings the auditor's false-claim rate is 4/11 (0.36) and the share of "clean" entries that are not clean is 7/11 (0.64) (4/11 (0.36) for defects the commit itself introduced).

## Per case (`*` = REAL and introduced by this commit)

| Case | Findings | REAL | NOT_A_DEFECT | WRONG | UNDETERMINED | REAL ids |
|---|---|---|---|---|---|---|
| KD-030 | 2 | 0 | 0 | 2 | 0 | - |
| KD-031 | 3 | 0 | 3 | 0 | 0 | - |
| KD-032 | 8 | 4 | 4 | 0 | 0 | H2*, H4, H7*, M1 |
| KD-034 | 28 | 13 | 14 | 0 | 1 | H1, H5, H7, H8, H9, H10, H11, H13, H14, H16, H18, H19, M4 |
| KD-035 | 4 | 0 | 4 | 0 | 0 | - |
| KD-036 | 8 | 1 | 7 | 0 | 0 | H2 |
| KD-037 | 11 | 5 | 6 | 0 | 0 | H2*, H4*, M3*, M4*, M5* |
| KD-038 | 5 | 2 | 3 | 0 | 0 | M1, M2 |
| KD-039 | 4 | 0 | 3 | 1 | 0 | - |
| KD-040 | 16 | 5 | 1 | 10 | 0 | H1*, H2*, H7*, H8*, H12* |
| KD-041 | 2 | 1 | 0 | 1 | 0 | H2* |

## Per pass

| Pass | Findings | REAL | NOT_A_DEFECT | WRONG | UNDETERMINED |
|---|---|---|---|---|---|
| backend / be-services | 40 | 16 | 18 | 6 | 0 |
| Sustainability | 39 | 13 | 21 | 4 | 1 |
| Quickfix | 12 | 2 | 6 | 4 | 0 |

Per severity: HIGH 55 (REAL 24, NOT_A_DEFECT 21, WRONG 10); MEDIUM 36 (REAL 7, NOT_A_DEFECT 24, WRONG 4, UNDETERMINED 1).

Findings repeat across passes (the same defect from backend, Sustainability and Quickfix); `dupOf` in the JSON marks them, so these counts overstate distinct defects.

## Recommendation (not applied)

1. **Fix the instrument before trusting any expect_clean rate.** Audit each case against the case commit's tree (a detached worktree or a `git archive` of the commit), not the fixture checkout. Re-run; the WRONG anachronisms should disappear and the rate move. Check the `detect` suite for the same defect.
2. **Change the scoring rule.** "Any MEDIUM+ on the case's files" is saturated here and measures the corpus's cleanliness as much as the model. HIGH-only does not fix it (still 10/11 (0.91)). The data supports a per-case adjudication step that classifies the drivers, reporting `fpRate` over WRONG findings and a separate `notClean` count over REAL ones: a bare rate cannot tell a false alarm from a true catch.
3. **Re-curate.** A clean case should require both that no later commit fixed anything in its files and that a reviewer with the findings in hand found none real. Cases with only NOT_A_DEFECT findings (KD-031, KD-035) remained clean under this audit.
4. The 13 introduced-by-commit REAL findings (e.g. KD-032 H2: a trailing `--redo` runs ordinary paid adjudication; KD-032 H7: duplicate redo ids cause two paid calls; KD-041 H2: facts gathered before the registry transaction) are reported as still present on `origin/main`; filing them is a separate decision.
