# expect_clean adjudication v2: gpt-6.2-sol, each case audited at its OWN commit (2026-11-20)

**Record only.** Supersedes the conclusion of [expect-clean-adjudication-2026-11-20.md](expect-clean-adjudication-2026-11-20.md) where they differ. Source: report `expect-clean-11c.json` (run `expect-clean-1795206449039`, harness `451d5858` = #410, which audits each case in a throwaway detached worktree of the case's commit; candidate `latest-gpt` = `gpt-6.2-sol`; metered $3.71). 107 MEDIUM+ findings across the same 11 cases, each judged by a read-only subagent against the code at the case's commit and, for REAL ones, against `origin/main`. Single-adjudicator model verdicts, not human grading.

## What changed against v1

| | v1 (audit read today's files) | v2 (audit reads the case commit) |
|---|---|---|
| findings | 91 | 107 |
| REAL | 31 (34%) | 52 (49%) |
| NOT_A_DEFECT | 45 | 54 |
| WRONG | 14 | 1 |
| findings citing code absent at the case's commit | 14 of 14 WRONG | 0 |

The instrument defect is confirmed and closed: v1's 14 WRONG findings were all anachronisms (KD-040: 10 of 16 cited `drainLocked`, `readTrackedSpillArtifacts`, `checkAdmission`, which exist only on main); with the case's own tree, KD-040's findings citing those symbols fell to 1 of 18, and no v2 finding is flagged anachronistic. The auditor makes almost no false claims once it reads the right code: 1 WRONG of 107.

## fpRate under each rule (cases with at least one qualifying finding, of 11)

| Rule | Cases | Rate |
|---|---|---|
| (a) current: any MEDIUM or HIGH on the case's files | all | 11/11 (1.00) |
| (b) WRONG findings only (the auditor's false claims) | KD-031 | 1/11 (0.09) |
| (c) HIGH only, any class | | 7/11 (0.64) |
| REAL (the entry was not clean) | KD-030, KD-032, KD-034, KD-036, KD-037, KD-038, KD-040 | 7/11 (0.64) |
| REAL and HIGH | | 6/11 (0.55) |
| REAL and introduced by the case's own commit | KD-032, KD-036, KD-037, KD-038, KD-040 | 5/11 (0.45) |
| REAL and still on `origin/main` | KD-032, KD-034, KD-036, KD-037, KD-038, KD-040 | 6/11 (0.55) |

## Per case (`*` = REAL and introduced by this commit)

| Case | Findings | REAL | NOT_A_DEFECT | WRONG | REAL ids |
|---|---|---|---|---|---|
| KD-030 | 14 | 2 (1 distinct) | 12 | 0 | H4, M3 |
| KD-031 | 4 | 0 (0 distinct) | 3 | 1 | - |
| KD-032 | 11 | 6 (3 distinct) | 5 | 0 | H2*, H3*, M1*, H5*, M2*, M5* |
| KD-034 | 33 | 19 (10 distinct) | 14 | 0 | H1, H2, H3, H5, H8, H10, H11, H12, H13, H15, H17, H18, M1, M2, M8, M9, M10, M11, M12 |
| KD-035 | 4 | 0 (0 distinct) | 4 | 0 | - |
| KD-036 | 7 | 3 (1 distinct) | 4 | 0 | M1*, M2*, H2* |
| KD-037 | 10 | 5 (2 distinct) | 5 | 0 | H1*, H2*, M1*, M4*, H4* |
| KD-038 | 2 | 1 (1 distinct) | 1 | 0 | M1* |
| KD-039 | 2 | 0 (0 distinct) | 2 | 0 | - |
| KD-040 | 18 | 16 (7 distinct) | 2 | 0 | H1*, H2*, H3*, H5*, M1*, H6*, H7*, H8*, M2*, M3*, H9*, H10*, H11*, H12*, M4*, M5* |
| KD-041 | 2 | 0 (0 distinct) | 2 | 0 | - |

## Per pass

| Pass | Findings | REAL | NOT_A_DEFECT | WRONG |
|---|---|---|---|---|
| backend / be-services | 37 | 22 | 14 | 1 |
| Sustainability | 51 | 22 | 29 | 0 |
| Quickfix | 18 | 8 | 10 | 0 |
| Orphan | 1 | 0 | 1 | 0 |

Findings repeat across passes (`dupOf` in the JSON), so these counts overstate distinct defects: for example KD-034's 19 REAL are 10 distinct, and KD-040's 16 REAL are 7 distinct.

## Conclusions

1. **The expect_clean corpus is not clean.** 7 of 11 cases carry a REAL finding and 5 of 11 carry one the commit itself introduced; the "no later commit names a defect" curation criterion does not establish cleanliness. Only KD-031, KD-035, KD-039 and KD-041 produced no REAL finding.
2. **fpRate by "any MEDIUM+" measures corpus cleanliness, not auditor false alarms.** 11/11 here, and the auditor's own false-claim rate is 1/11 cases and 1/107 findings.
3. **Scoring-rule proposal (not applied):** report adjudicated drivers instead of a bare rate: `falseClaims` (WRONG), `realDefects` (REAL, with `introducedByCommit`) and `nits` (NOT_A_DEFECT), and keep the MEDIUM+ rule only as the trigger for adjudication. A candidate is judged on `falseClaims` per finding; `realDefects` is a statement about the corpus. Re-curate: a clean entry needs a reviewer who has the auditor's findings in hand and finds none real (KD-031/035/039/041 are the first candidates).
4. The REAL findings still on `origin/main` are listed per case in the JSON (`stillOnMain`); a pending PR (branch claude/fix-adjudicated-real-bugs, not yet merged) fixes 16 of the earlier set (KD-032, KD-034, KD-037, KD-036, KD-040, KD-041).
