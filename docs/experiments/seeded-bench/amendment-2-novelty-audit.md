# Amendment 2 — pilot-time novelty audit (epoch `seeded-bench-v2`)

Approved by Louis in chat, 2026-11-23, after a one-round brainstorm with a debate (`brainstorm-recalibration-1795446244532`). Machine-readable twin:
[`amendment-2-novelty-audit.json`](amendment-2-novelty-audit.json), which the tooling reads, validates against policy floors and binds to this approval by a content digest
(`AMENDMENT_2_SHA256` in `pilot-novelty-audit.mjs`): changing a tolerance, sample size or the approval is a reviewed code change, never a quiet file edit.

## Why

The pre-registered gate (plan §1.4) asked a judge to clear precision ≥ 0.90 on a prevalence sample before the pilot. Only about 7% of candidate pairs are
`same`, so the 80-pair sample held 8 judge-positive pairs (6 correct): its 95% interval 0.41–0.93 could not show 0.90 either way, all pairs came from code
audits (the "per source arm" rule could not be met, and the two pilot arms do not exist before the pilot), and Gemini returned malformed JSON on 4 of 200 pairs.
The v1 verdict is and stays **INCONCLUSIVE** (calibration spend $2.2286 of $10). The data show the judge works (recall 1.00; 46 of 48 predicted `same` pairs
human-confirmed pooled), but they do not certify it, and certifying it cheaply is not possible at this base rate.

## What changes

1. **A finding is hidden from the human only when BOTH judges (Opus and Gemini) call it `same` as a prior ledger entry.** A judge that fails, returns
   unparseable output, or disagrees sends the finding to the human. A judge failure no longer blocks anything.
2. **The human decides novelty for everything shown.** Each finding comes with its closest earlier ledger entries; `KNOWN` means it restates one, and such a
   finding is not novel whatever the judges said. The judges only decide what the human is spared.
3. **The judges' one dangerous error (hiding a novel finding) is audited on the real pilot findings.** A seeded, finding-level probability sample of **80** hidden
   findings, **stratified by arm** (about 40 per arm; an arm with fewer is audited in full), goes onto the same blind worksheet, indistinguishable from the rest. Each
   one the human does not call `KNOWN` is a false suppression.
4. **The audit passes iff the one-sided 95% Clopper–Pearson upper bound of false suppressions ÷ audited is ≤ 0.15 for EACH arm and pooled.** That is **at most 2 of
   40 per arm and 6 of 80 pooled** (0 of 40 gives a bound of 0.072). Pre-registered here, before any pilot data. Only the CONTINUE arm's findings can change a
   stop pair's miss test, which is why the bound is not allowed to average across arms.
5. **If the audit fails the result is not reported.** The worksheet is rebuilt with `--audit all` and the human labels every hidden finding; the decision then
   rests entirely on human labels. A failed audit is therefore a cost, never a way to a different answer.

## What does not change

The Pilot 1 decision rule and all its thresholds (plan §2.3), the frozen dataset, partition and seeds, the $125 / $100 hard caps metered per call, human blind
labelling, and the rule that a result is advisory until a repeat run lands on the same branch. Existing calibration labels are kept as evidence for planning and
for the judge-versus-human agreement report; they are not recycled as confirmation.

## Known limits

- The audit bounds the false-suppression rate on the pilot's own findings, per arm and pooled; at about 40 per arm it can detect a rate near 15% but not distinguish 3% from 6%.
- Each shown finding lists up to 10 same-file earlier entries plus every entry the judges matched; the human can always call a finding `KNOWN` for a concern the list does not show.
- One adjudicator labels everything (plan C4). The audited hidden findings are indistinguishable from the others.
- Recall of the judges is not certified: a missed duplicate reaches the human, who sees the closest ledger entries and can call it `KNOWN`.
