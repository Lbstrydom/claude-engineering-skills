# Out-of-diff noise — 1c recall check: result

**Verdict: INCONCLUSIVE on recall; `AUDIT_CHUNK_SCOPE` stays off.** The check could not measure recall, and the structural cost saving is real but modest. Louis decides the default.

## What was run (and how it deviates from plan C3)

`docs/plans/audit-out-of-diff-noise.md` C3 declared a sealed 40-finding corpus labelled from fix-commit hunks. Neither exists in the store (measured 2026-11-13): `fix_commit_sha` is NULL on all 281 fixed/verified HIGH/MEDIUM findings with captured diffs, and only 15 of them sit in files large enough to be chunked (>100 KB: 10 ai-organiser, 5 CES). Approved deviation (Louis, via the CES coordinator): replay those 15 findings' 10 audits, baseline (`off`) vs `overlap` vs `referenced`, from a pinned revision (70621fea). **n = 15, so even 0 misses certifies recall only >= 82% at 95% (0.05^(1/15)); the plan's n = 40 bar (92.8%) is not met.** Not a proof of equivalence in any case.

Replay: each audit's stored diff applied file-by-file onto its audited sha in a scratch worktree (files that no longer apply were skipped), the same neutral stub plan for every arm (the original plans were uncommitted), store writes off. 9 of 10 audits ran; `54cfbf11` (truncated stored diff, 65 files) was not run. `9435f4c4`'s `referenced` arm was not run: the batch was stopped on cost.

## Results

Cost: **USD 38.82 measured** over 26 runs (sum of each run's `_usage.costUsd`), against a USD 15 cap and then USD 30. The preflight estimate (~USD 0.19/run) was ~8x low and spend was not watched during the batch. The over-run is the operator's error.

| Audit | `off` (counted + pre-existing, USD) | `overlap` | `referenced` |
|---|---|---|---|
| 8ec2d5e3 (CES) | 25 + 9P, 0.32 | 22 + 0P, 0.23 | 22 + 10P, 0.32 |
| 0eaed211 | 21 + 0P, 0.46 | 20, 0.47 | 21, 0.48 |
| 98f28921 | 2, 0.33 | 1, 0.22 | 3, 0.24 |
| 037c5d67 | 8 + 1P, 1.55 | 10, 1.36 | 8, 1.37 |
| dc958e58 (CES) | 2, 0.06 | 1, 0.06 | 3, 0.06 |
| a882a4f0 (CES) | 26, 0.32 | 28, 0.34 | 26, 0.33 |
| b0a79bf3 | 28 + 29P, 4.51 | 29, 3.04 | 27 + 7P, 3.59 |
| 931cc7f3 | 27 + 26P, 4.48 | 27, 3.02 | 25 + 8P, 3.60 |
| 9435f4c4 | 33 + 18P, 4.45 | 32, 3.59 | not run |

Full tables: `out-of-diff-noise-campaign/score-corpus-and-arms.txt`.

1. **Cost and noise (supported).** On the large-file audits `overlap` cost ~33% less (4.51 -> 3.04, 4.48 -> 3.02, 4.45 -> 3.59) and `referenced` ~20% less, and both removed most pre-existing findings at the source (26-29 per audit on `off` -> 0 on `overlap`, 7-8 on `referenced`). The 8a tag works on real audits: on `off` it already marks 9-29 findings per large audit as not counted.
2. **Recall against the 15 stored findings (not measurable).** Text similarity between each stored finding and the best same-file finding is <= 0.15 even for the `off` arm, so no arm can be said to have "raised" a stored finding. The instrument cannot label. Stored findings were raised against different states and plans than the replay, and a model re-run does not reproduce them.
3. **Recall of the baseline's in-diff findings (a proxy, uncontrolled).** Treating the baseline's counted findings as labels, a same-file match at similarity >= 0.20 finds 108/172 (63%) for `overlap` and 88/139 (63%) for `referenced`; at >= 0.12, 133/172 (77%) and 107/139 (77%) (`score2-*.txt`). The two arms are indistinguishable, but with no baseline-vs-baseline re-run there is no noise floor, so this is not recall and cannot show whether either arm loses defects. A control run would cost about USD 12 more for these audits.

## What it means for the default

- No evidence of a large recall loss, and no evidence of none. The standing risk in plan §6 (a defect introduced in an unchanged chunk) is untested by this data.
- The saving is concentrated in the few audits over the chunking threshold (about 5% of fixed findings are in such files).
- To decide properly the next step is a baseline self-rerun control (~USD 12) plus hand adjudication of the unmatched baseline findings. Both need Louis's go; neither is started.

## Where the data is

Raw per-arm results: `C:\tmp\oodn\out\<audit>-<arm>\result.json` (not committed, ~2 MB). Committed here: harness (`replay.mjs`), scorers, stub plan and score outputs under `out-of-diff-noise-campaign/`. Pinned fixture: `C:\GIT\claude-engineering-skills-pinned\oodn-1c` (70621fea). Contract epoch `oodn-1`.
