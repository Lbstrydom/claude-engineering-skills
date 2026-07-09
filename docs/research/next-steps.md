# Next Steps

**The single roadmap lives in the plan**, deliberately — including the
follow-on milestones that sit outside the audited implementation scope:
[`docs/plans/tiered-recall-audit-pipeline.md`](../plans/tiered-recall-audit-pipeline.md).

Sequence summary (details + gating logic in the plan itself):

1. **Cluster C first — Phase 5, the validation session.** Gates everything:
   the cheap-triager candidates re-triage the existing 2,314-row sheet; a
   contrarian-stratified sample gets **~2-4 hours of human grading** (the one
   step only the operator can do); the machine-readable manifest picks Stage 1's
   model. Doubles as the first human check on the original judges' labels.
2. **Clusters A, B, D** — evidence contract → Stage 0 + cost capture →
   discovery portfolio + tiers + ledger routing + Gemini reconfiguration, each
   with its fix-gate, final consolidated Gemini review over the union diff.
3. **Close-out** — prospective shadow validation on the next 10-15 real commits
   (reusing the model-A/B shadow infra, toggle currently OFF until this starts).
4. **Follow-on phases 10-12** (stubs, validated before actioning): mechanical
   quickfix-patterns layer for the blind-spot classes · the production flip +
   consumer re-sync decision gate · the live-verification budget shift.

## The one workstream that is NOT in the plan: publication

Writing up the research (academic discussion paper and/or LinkedIn article) is
a research-folder concern, not an engineering plan item:

- **Source material**: this folder, in reading order (README → experiment-1 →
  experiment-2 → cost re-scoring → field records → design synthesis).
- **Citable numbers**: [`data/experiment-dataset.json`](data/experiment-dataset.json).
- **Ready-made brief** for generating a report/deck in a fresh session:
  [`data/REPORT-BRIEF.md`](data/REPORT-BRIEF.md) (audience: university lecturer;
  includes the editorial guardrails — lead with the nuanced finding, give the
  self-corrections real space, don't overclaim).
- **Visual report**: already published as a Claude Artifact (redeployable from
  `.audit-loop/solo-control/report.html`).
- **Hard rules**: the private commercial repo is never named ("a private
  commercial app"); the additive-vs-corrective distinction and the
  "Gemini > GPT-5.5, NOT Gemini > Sonnet" non-finding must survive editing;
  caveats (N=13, single-judge follow-ups, LLM judges) stay visible.
- **Timing thought**: the strongest version of the article includes the
  *prospective* shadow-validation result (does the redesign hold up
  out-of-sample?) — consider writing after close-out rather than now, since
  "we predicted, then verified" is a much stronger arc than "we measured, then
  redesigned."
