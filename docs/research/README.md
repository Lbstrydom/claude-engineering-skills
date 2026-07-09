# Research — Audit-Effectiveness Experiments & Learnings

This folder is the **consolidated, durable record** of the 2026-06/07 research arc
that asked: *does our heavyweight multi-model code-audit pipeline actually earn
its cost against cheaper alternatives?* — and ended with an approved redesign
([`docs/plans/tiered-recall-audit-pipeline.md`](../plans/tiered-recall-audit-pipeline.md)).

It exists so the learnings are referenceable in one place — including as source
material for an academic write-up or a LinkedIn article. Everything here is the
*synthesis*; raw runtime artifacts stay where the tooling reads them (pointers
below).

## Standing disclosure rule (for any public write-up)

Two of the three subject repos may be named freely: **claude-engineering-skills**
and **ai-organiser**. The third is a private commercial product and must only
ever be described generically — **"a private commercial app"** — never by name,
in any public-facing material.

## The narrative arc (read in this order)

| # | Document | What it covers |
|---|---|---|
| 1 | [`experiment-1-solo-control.md`](experiment-1-solo-control.md) | The main study: 6 arms × 13 commits × 2,314 blind-graded findings × 2 cross-family judges — plus the two targeted follow-ups (Sonnet+Gemini composition; GPT-vs-Gemini generator isolation) and the 4 self-corrections that make it credible. |
| 2 | [`experiment-2-arm-eval-and-model-ab.md`](experiment-2-arm-eval-and-model-ab.md) | The two *other* experiment tracks: the blinded-judge arm-eval framework (brainstorm/plan surfaces) and the model-A/B/C code-audit shadow — including why the shadow's 1,891-cluster backlog was deliberately abandoned un-adjudicated. |
| 3 | [`analysis-cost-rescoring.md`](analysis-cost-rescoring.md) | The re-scoring that changed the conclusion: cost-per-known-defect under the operator's *actual* (recall-weighted) utility function, the portfolio/union analysis, and the triage-burden numbers. |
| 4 | [`field-records-synthesis.md`](field-records-synthesis.md) | Two years of *production* audit records mined across both repos — what the pipeline actually caught, what the false positives actually were, where Gemini genuinely earns its keep (adjudication, not discovery), and the named Claude-author blind-spot classes. |
| 5 | [`design-synthesis-and-decisions.md`](design-synthesis-and-decisions.md) | How the evidence became a design: the cross-family brainstorm round, the synthesis, and the /audit-plan trail (26 findings across 5 review rounds) that hardened the plan. |
| 6 | [`next-steps.md`](next-steps.md) | The roadmap — what the approved plan covers, and the four workstreams that sit *outside* it. |

## Data artifacts in this folder

- [`data/experiment-dataset.json`](data/experiment-dataset.json) — the structured
  dataset behind experiment 1 (all arms, both judges, follow-ups, corrections,
  caveats). This is the citable numbers file.
- [`data/REPORT-BRIEF.md`](data/REPORT-BRIEF.md) — a self-contained brief for
  generating a report/deck from the dataset in a fresh session (audience:
  a university lecturer; editorial guardrails included).
- [`analysis-ledger-decomposition.md`](analysis-ledger-decomposition.md) — the
  Phase-1 cloud-ledger decomposition (13,963 findings → 375 accepted; round-value
  split; the Gemini-gate 4.2% finder-acceptance number) that experiment 1's design
  and the field-records synthesis both draw on. Moved here from its original
  `docs/experiments/` output path — it's an analysis record, not runtime data.

## Pointers to artifacts that intentionally live elsewhere

| Artifact | Location | Why it stays there |
|---|---|---|
| Known-defects ground truth (KD-001…KD-014, incl. the invalidated KD-013) | `docs/experiments/audit-effectiveness/` | **Live tooling path, not documentation** — `solo-control-audit.mjs` reads `known-defects.json` (2 call sites), `defect-harvest.mjs` writes `known-defects.candidates.json` there by default, and the redesign plan's Phase 5 outputs `cheap-triager-validation.json` there. Moving it breaks the harness. |
| Raw experiment outputs (per-arm findings, blind sheets, blind maps, score results) | `.audit-loop/solo-control/` (gitignored) | Volatile/regenerable raw data + the unblind key; the durable numbers are snapshotted in `data/experiment-dataset.json`. |
| Published visual report | Claude Artifact (redeploys from `.audit-loop/solo-control/report.html`) | Interactive HTML for the lecturer discussion; content mirrors the dataset. |
| Arm-eval session archives + worksheets | `docs/arm-eval/` | **Live tooling surface, not documentation** — written by `cross-skill.mjs` (worksheets) and `arm-eval/export.mjs` (sessions), cleaned by `audit-clean.mjs`, path-asserted by `tests/sync-untrack.test.mjs`, and referenced in `sync-to-repos.mjs`'s consumer gitignore patterns. Phase 11's shadow validation writes here again. Experiment 2 doc summarizes its conclusions. |
| Experiment design plan | `docs/plans/audit-effectiveness-experiment.md` | Plan documents stay in `docs/plans/`. |
| The redesign this all produced | `docs/plans/tiered-recall-audit-pipeline.md` | Ditto — and it is the *output* of this research, not part of the record of it. |

## One-paragraph summary of the whole arc

We ran a blind, two-judge, ground-truth-seeded comparison of six code-review
configurations over 13 real commits and found the expensive production pipeline
(GPT-5.5 5-pass + Gemini review) failed its own trust bar (39–41% of claims
flatly wrong) while a solo Claude pass was more trustworthy and a cheap OSS
model (GLM-5.2 + Gemini) matched its hard-bug recall at ~1/6 the cost. Follow-ups
isolated *why*: GPT-5.5's generation layer is the noise source (head-to-head,
same task, Gemini 26.5% vs GPT 51.9% false-rate), and adding a Gemini lens to
Sonnet is additive (finds different real things) but not corrective (closes no
hard-bug gaps). Re-scoring under the operator's actual recall-weighted utility
inverted the headline: the right architecture isn't "pick the cleanest single
reviewer," it's "cheap high-recall discovery + a hardened multi-tier triage
funnel that makes the noise affordable." Two years of production audit records
independently support the same split (discovery vs. adjudication as distinct
jobs). A cross-family brainstorm and a 5-round plan audit turned that into the
approved tiered-pipeline redesign — itself a live demonstration of the thesis,
since external reviewers caught 26 real defects in the plan, several of them in
the author's own fixes.
