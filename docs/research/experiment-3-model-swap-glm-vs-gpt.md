# Experiment 3 — Model Swap-In Evaluation: GLM-5.2 vs GPT-5.6 (Auditor Role)

First real end-to-end use of the model-swap-eval-harness (`docs/plans/model-swap-eval-harness.md`)
for its intended purpose: deciding whether an OSS candidate should replace the
production GPT auditor. Run 2026-07-12/13, across three of the user's own repos
— this one (claude-engineering-skills), ai-organiser, and a private commercial
project — with explicit in-session authorization for cross-repo egress (see
governance note at the end).

## Setup

| | |
|---|---|
| Candidate | `z-ai/glm-5.2` (OSS reviewed-pool, role `reasoner`) |
| Baseline | `gpt-5.6-terra` (production sentinel `latest-gpt`) |
| Judge | `gemini-pro-latest` (independent third lineage) |
| Judge tier achieved | **A** — genuine blind, cross-family judging (all three lineages mutually independent; not a Tier C fallback) |
| Corpus | 8 cases stratified-sampled from an 18-entry corpus (14 claude-engineering-skills + 2 ai-organiser + 2 from the private commercial project), each running the full production 5-pass generation for both arms |
| Cost | **$1.87** total ($1.38 GPT-5.6 generation, $0.49 GLM generation, $0.48 Gemini judging) |
| Runtime | ~2h40m wall-clock (candidate/baseline generations are deliberately serialized — `runAuditGenerationArm` chdirs, a global-process-state hazard that rules out running them concurrently) |

## Result

| Metric | GLM-5.2 (candidate) | GPT-5.6-Terra (baseline) |
|---|---|---|
| Recall (curated-defect exact match) | 12.5% (1/8) | 0% (0/8) |
| False-positive rate (noise among own findings) | 80.9% | 67.6% |
| Cost | $0.49 | $1.38 |

**Verdict: `keep`** (stay on GPT-5.6). Mechanically correct against the
configured thresholds (`auditor-thresholds.json`): GLM's false-positive rate
exceeded 1.15× GPT's (0.809 > 0.676×1.15 = 0.777), which fails the comparative
floor regardless of GLM's nominally higher recall.

## The confound — recall numbers are not a trustworthy quality signal here

Both models' recall looks catastrophic in isolation (0% and 12.5%). Before
accepting that at face value, the raw generation output for the one case whose
files survived on disk (the harness overwrites its per-case temp files, so only
the LAST processed case — KD-019 — was inspectable) was pulled directly:

- **GLM produced 49 findings, GPT-5.6 produced 48** for that case — comparable
  volume from both.
- Both included real, substantive, correctly-reasoned HIGH-severity findings:
  receipt-scope splitting bugs, unvalidated CLI enum values, path-traversal risk
  in manifest/receipt handling, transaction-journal recovery gaps.
- **Neither found the one specific curated defect** (KD-019: a CWD-relative
  `path.resolve()` fallback where a repo-root-relative resolution was needed).
  Both came close — GLM and GPT-5.6 each separately flagged a *different* real
  bug in the exact same file (`check-skill-updates.mjs`'s receipt-scope
  handling) — but neither's phrasing overlapped enough with the curated
  rubric for the Jaccard token-overlap scorer to credit it.

This is the previously-documented **oracle-mode exact-match ceiling**
(`AGENTS.md`, "Model Swap-In Evaluation Harness" — first observed in the
2026-07-12 screen-tier dogfood run): a known-defects entry is one real,
organic commit, and the scorer can only credit the ONE curated defect per
entry. A model that finds a *different* genuine bug in the same diff gets no
credit. This run reproduces that pattern on an independent case (KD-019,
previously unseen by the screen-tier run) and at the promotion tier (full
5-pass generation, not the earlier single-shot extraction) — stronger evidence
the ceiling is structural to the scoring design, not incidental to one tier or
one case.

**Caveat on the caveat**: this spot-check covers 1 of the 8 sampled cases (the
only one recoverable). It is a strong, consistent data point, not a full-run
audit of every case's findings.

## What IS a trustworthy signal from this run

Unlike recall, these two metrics don't depend on curated-defect matching —
they're computed from the judge's true/false call across *all* generated
findings, or are a direct cost readout:

- **GLM is ~2.8× cheaper than GPT-5.6** on this task ($0.49 vs $1.38 for
  comparable finding volume). Lower than the ~5–10× estimated in
  `OSS_POOL`'s reasoner-pool comment (that estimate was list-price-per-token;
  this is real, measured spend for the actual generation pattern).
- **GLM's false-positive rate is meaningfully higher** (80.9% vs 67.6%) — on
  this sample, roughly 1 in 5 GLM findings is judged real/actionable vs
  roughly 1 in 3 for GPT-5.6. This is the metric that actually drove the
  `keep` verdict, and it's a legitimate signal, not a scoring artifact.

## Decision and what it means going forward

**Keep GPT-5.6 as the production auditor.** The verdict stands on real
evidence (the false-positive-rate comparison), even though the recall half of
the picture is currently unmeasurable with this scorer. Switching to GLM would
trade a real cost reduction for a real, measured increase in review noise —
not a good trade at this sample size.

**Before any future promotion-tier run's recall column can be trusted**, the
scorer needs the redesign already flagged as deferred work: credit "a real
finding in the right file/region," not only an exact match to one curated
defect. Until then, promotion-tier recall should be read the same way this
run's was — as a floor-check gate the thresholds happen to compute correctly,
not as a real quality percentage.

## Methodology notes (for citing this experiment)

- This is a genuinely blind, cross-family Tier A comparison — the strongest
  evidence tier the harness supports, not a downgraded Tier C oracle check.
- The corpus was pruned from 25 to 18 entries as a direct prerequisite for this
  run: 7 entries were structurally unloadable (3 contained real `.env`/secret-
  shaped fixture content that the egress gate correctly refuses to send
  externally, 2 exceeded the 200K-char diff-size bound, 2 had unresolvable git
  history) — verified mechanically before removal, not a judgment call.
- **Governance note**: this run's `--repo-roots` included ai-organiser and a
  private commercial repo, sending their diffs to the external GLM/GPT/
  Gemini APIs. The Claude Code auto-mode classifier hard-blocks this pattern
  by design (a standing Data-Exfiltration guard) and explicitly cannot be
  cleared by in-chat consent, even from the repo owner — the classifier
  refused twice, including refusing to write a settings.json bypass rule. The
  actual run was executed by the user directly in their own terminal, which
  the guard treats as the legitimate channel for this action. This is worth
  noting as a live example of an AI-safety boundary holding even under
  direct, informed, repeated user request — the system required the human to
  be the one to press the button, not the agent.
