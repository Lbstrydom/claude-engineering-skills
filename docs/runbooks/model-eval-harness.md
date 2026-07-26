# Model Swap-In Evaluation Harness — Operational Reference

> Moved from AGENTS.md (2026-07-13 sprawl trim) — this holds the full
> operational depth; AGENTS.md keeps the invariants + pointer, per the
> progressive-disclosure policy. Design + prior-art trace:
> [`docs/plans/model-swap-eval-harness.md`](../completed/model-swap-eval-harness.md).
> First real verdict:
> [`docs/research/experiment-3-model-swap-glm-vs-gpt.md`](../research/experiment-3-model-swap-glm-vs-gpt.md).

A standing, repeatable test suite (`scripts/lib/model-eval/`) for evaluating a
candidate LLM release for the **auditor** role (currently GPT) or the
**adjudicator** role (currently Gemini) — "is this new model worth switching
to?" with the same rigor as the completed audit-effectiveness research.
Reuses existing assets rather than rebuilding: the `known-defects.json`
ground-truth corpus, a forked blinded cross-family judge protocol
(`scripts/lib/model-eval/blind-judge.mjs` — a sibling of, not an extraction
from, the live `solo-control-audit.mjs` experiment), the $/KD cost formula,
`model-resolver.mjs`'s sentinel system, and the shadow-final-review A/B's
pre-registered stopping rule.

## Playbook — "a new model just shipped, is it worth switching to?"

**Start here.** This is the standing answer, written 2026-07-26 so the next swap
is a one-sitting job rather than a fresh design exercise. Decided via a
`/brainstorm --debate` round (GPT-5.6 + Gemini-pro both conceded the key point);
rationale in §"Why synchronous" below.

**Rule 0 — a model swap is SYNCHRONOUS. Never open a window for it.** Run it,
adjudicate it, and record the verdict in one sitting. Do not build a collector,
do not add a toggle, do not "let it gather data for a few weeks". Four of this
repo's five evaluation subsystems died exactly there.

### Step 1 — pick the role, because the epistemics differ

| The candidate would replace… | Role | Command | Scoring |
|---|---|---|---|
| GPT, generating audit findings | `auditor` | `node scripts/model-eval-auditor.mjs --candidate <spec> --tier promotion` | Oracle — `known-defects.json` ground truth |
| Gemini, the final-review gate | `adjudicator` | `node scripts/model-eval-adjudicator.mjs --candidate <spec> --tier promotion` | Oracle (Tier C) or live shadow (Tier A/B) |
| The Stage-1 cheap triager | `auditor`, screen tier | `--tier screen` | Oracle, single-shot |
| A `/brainstorm` or `/plan` partner | *not the harness* | see §"Brainstorm/plan roles" | Blinded judge — relative preference, no ground truth |

**Do not unify these two scoring modes.** The oracle asks a partly-objective
question ("did it find the known bug?"); the blinded judge asks a
comparative-preference one ("which output is better?"). A shared `score: number`
would silently license invalid comparisons between them. One CLI per role,
sharing only plumbing, is deliberate.

### Step 2 — read the result with the recall ceiling in mind

`recall` is a **floor constraint, not the deciding metric** — the oracle credits
only the one curated defect per case, so a good model that finds a *different*
real bug scores 0. The verdict rides on **false-positive rate and cost**; that
is what actually decided GLM-5.2 vs GPT-5.6. Before believing any low recall,
read the raw per-case extraction output.

### Step 3 — adjudicate in the same sitting

Anything needing a human call gets rendered as a worksheet, never raw JSON:

```bash
node scripts/cross-skill.mjs final-review-stats --repo <owner/repo> --worksheet
```

Grade it now. A queue left for later is a queue never graded — that is the
empirical record, not a prediction.

### Step 4 — write the verdict where it survives

Terminal verdict → **`docs/research/experiment-N-<topic>.md`**, committed. This
is not a new artifact category; it is an authored decision document, which is
why `experiment-3-model-swap-glm-vs-gpt.md` survived the 2026-07-14 database
wipe while every arm-eval DB row did not. Cite the corpus version, the commands
run, and the numbers. Volatile run bundles stay gitignored (Category A) — commit
the conclusion, not the transcript.

### Step 5 — grow the corpus, but never score against a moving oracle

The corpus is the only compounding asset here; every harness around it is cheap
and rewritable. So when a run surfaces genuine bugs that were not curated:

- **Append them** — a permanently frozen corpus lets the recall ceiling flatline
  as models improve.
- **Never credit them in the run that found them.** The discoverer would be
  helping define the oracle it is then scored against.
- **Re-run the incumbent against the new corpus version, same day.** Comparability
  comes from both models facing the same snapshot — not from freezing the data.
  Inference is cheap; curating real defects is what costs.
- Keep one small **frozen anchor subset** untouched by active evaluation, purely
  as rot-detection.

### Brainstorm/plan roles

Not in this harness — they use the blinded-judge arm-eval framework
(`docs/plans/arm-eval-framework.md`), which is **deliberately switched off** as a
background collector. If you need this judgement, run it synchronously for the
decision at hand and write the verdict to `docs/research/`; do not re-enable
passive capture. Its 25 archived sessions in `docs/arm-eval/sessions/` survived
the wipe; its DB rows did not — same lesson as Step 4.

### Why synchronous (the reasoning, so it is not re-litigated)

A swap decision arises roughly quarterly. A quarterly decision does not need a
standing apparatus, and the apparatus is what generated every pathology: epoch
drift needs *elapsed time* between window-open and verdict; dormancy needs
nothing to force the sitting; the wipe only mattered because evidence sat in
mutable storage for months. Run it in one sitting and all three stop existing.

**The one legitimate exception** is a question about behaviour over live incoming
work — an *intervention*, not a model swap. Exactly two are open: the
tiered-pipeline architecture comparison, and the final-review second-gate A/B.
Those keep their shadows, and their window metrics are epoch-stamped
(`TIERED_SHADOW_CONTRACT_EPOCH`) so a stale row can never read green.
**Adding a sixth standing collector is the band-aid this playbook exists to
prevent.**

## Running an evaluation

- **Auditor role**: `node scripts/model-eval-auditor.mjs --candidate <spec> --tier screen|promotion`
  runs the candidate through `known-defects.json` via `structured-extractor.mjs`,
  scores with `deterministic-scorer.mjs`, decides via `verdict.mjs`.
- **Adjudicator role**: `node scripts/model-eval-adjudicator.mjs --candidate <spec> --tier screen|promotion`
  — Tier C (always available) scores the candidate as a structured T/F extractor
  against `getAdjudicatorGroundTruth()` (real, labeled `audit_findings` rows).
  Tier A/B (only when `route-catalog.mjs` judges the candidate/baseline
  genuinely independent model lineages) points `gemini-review.mjs`'s
  `FINAL_REVIEW_SHADOW` mechanism at the candidate for `minLiveShadowRuns`
  live runs (default 20) and finalizes via `finalize-shadow-eval.mjs`.
- Thresholds are versioned, conservative v0.1 bootstrap values
  (`scripts/lib/model-eval/config/{auditor,adjudicator}-thresholds.json`) —
  not yet empirically calibrated; a recalibration is a `version: 2` bump.

## Load-bearing invariants

- **Accepted false-negative direction**: a Tier-C-only run (e.g. a
  restricted-catalog Azure repo) can never emit `verdict:'switch'` —
  only `keep`/`inconclusive`/`manual_review_required`. Schema-enforced
  (`ThresholdConfigSchema`/`verdict.mjs`), not a convention to remember.
- **The oracle-matching recall ceiling** (below) means a low recall or an
  `inconclusive` verdict is NOT necessarily a model-quality signal — check
  the raw per-case extraction output before trusting it.
- **Tier C fallback does NOT substitute for a Tier A/B comparative result** —
  it carries the identical oracle ceiling.

## Screen-tier oracle matching has a real ceiling (2026-07-12 first dogfood run)

`known-defects.json` entries are drawn from real, organic multi-file/multi-hunk
commits; oracle-mode `scoreDefectLocalization` can only credit a match against
the ONE specific curated defect per entry, but a careful model review of a real
commit often finds OTHER genuine, describable issues in the same diff instead
(confirmed directly — both GLM and GPT-5.6 found real, valid bugs in
KD-005/015/017's diffs, just not the specific curated one). Both models scoring
`recall:0` on the same 4-case run reflects this structural gap, not
equal-and-bad model quality. A trustworthy comparative verdict needs either
more surgical single-issue KD entries or a scoring redesign that credits "a
real finding in the right file/region" — not yet built. Don't over-read a low
screen-tier recall without checking the raw per-case extraction output first.
**This applies to `promotion` tier's Tier C fallback too** (`scoreArmTierC`
uses the SAME single-shot `extractStructured` mechanism as `screen` tier, not
the full 5-pass `runAuditGenerationArm` path) — a Tier C promotion "verdict"
carries the identical ceiling and is not a real comparative signal either.

## Egress false-positive classes found + fixed (2026-07-12)

**Class 1 — judge-payload prose tripping the path gate.** `promotion` tier's
Tier A/B path is real generation; blind-judging (Gemini) used to trip the
sensitive-path egress gate on genuine findings. A finding's own prose ("a
token/size cap... not enforced globally") read as a word/word-shaped path
mention to `findSensitivePathMentions`
(`scripts/lib/model-eval/egress-path-scan.mjs`) purely because English uses
`/` for "or", not a directory separator, and the first word ("token")
happened to match `sensitive-paths.mjs`'s bare `tokens?`/`password` keyword
patterns (correct and intentionally broad for REAL path classification, wrong
applied to prose). Fix: a `looksLikeRealPath` gate now requires actual path
evidence — dotfile prefix, anchor (`./`, `~/`, `/`), a real filename
extension, 3+ path segments, or an explicit `.aws`/`.ssh` mention — before
trusting a bare-keyword match; unambiguous branches (`.env*`, `id_rsa*`)
always pass. Regression-guarded by `tests/egress-path-scan.test.mjs`;
validated against all 19 known-defect descriptions + 1082 real
grading-rationale text fields from the tiered-recall corpus with zero false
positives. Tier A/B generation itself was already confirmed working
end-to-end (both GLM and GPT-5.6-Terra produced 13-14 real HIGH findings on
the same known-defect commit) — the judge-payload gate was the last blocker
for a real GLM-vs-GPT-5.6 comparative verdict.

**Class 2 — a much bigger false-positive class hiding behind the first, fixed
same day.** `findSensitivePathMentions` also runs on the RAW DIFF in
`known-defect-corpus.mjs::loadCorpusCase` (not just judge prose), and its
`.env`-branch match started mid-identifier: `process.env.GEMINI_API_KEY` or
`import.meta.env.X` (ordinary JS/TS property access, present in nearly every
commit that reads config) produced a token indistinguishable from a real
`.env.production`-style file mention. Fixed with a `(?<!\w)` negative
lookbehind before the leading dot — a genuine `.env` FILE mention is always
preceded by whitespace/quote/path-separator/start-of-string, never a bare
identifier character, so the lookbehind costs no real recall. Confirmed by
mechanically re-running the deterministic corpus gates (diff-size, egress,
path-mention — no LLM calls) over all 331 already-harvested-but-uncurated
`claude-engineering-skills` rows in
`docs/experiments/audit-effectiveness/known-defects.candidates.json`: clean
(gate-passing) candidates went 88 → 146 after this fix alone. **The 6/8
corpus gap was never a candidate-supply problem — it was almost entirely this
gate.**

**Three residual gaps closed the same day**: (a) the mention scan now flags
only the `sensitive` category — `generatedNoise` (lockfiles, `*.min.js`,
`*.map`) is a body-egress category and a mere lockfile path MENTION carries
no secret, so diffs touching `package-lock.json` alongside real code no
longer block (body-egress call sites keep the conflated `isPathSensitive`,
correct there); (b) tokens containing regex-source metachars
(`(){}[]|*+?^$\`) are rejected — real paths never contain them, so the
security tooling's own pattern literals (`/(^|\/)id_rsa.*$/i`) no longer
self-trip (plain-string fixtures like `'.ssh/id_rsa'` still trip, correctly —
indistinguishable from a real mention); (c) the shared classifier's `tokens?`
pattern carves out code/style extensions (`tokens.mjs`/`.ts`/`.css`/… are
design-token modules, not credentials) while `tokens/` dirs, bare
`token(s)`, and data files (`tokens.json`, `tokens.yaml`) stay sensitive — a
code file embedding a real token literal is still caught by the content
scanner. One strengthening attempt was tried and REVERTED same-day
(trailing-punctuation stripping made prose like "keys in .env)" flag,
silently re-blocking two valid corpus entries) — **historical recall is the
contract; don't re-add it**. All guarded in `tests/egress-path-scan.test.mjs`
+ `tests/sensitive-paths.test.mjs`.

## First real promotion-tier run (2026-07-13): GLM-5.2 vs GPT-5.6 → `keep`

Genuine Tier A (blind, cross-family judged, all three lineages independent),
8 cases across 3 of the operator's own repos, cost $1.87 total. GLM's
false-positive rate (80.9%) exceeded 1.15× GPT-5.6's (67.6%) — the metric
that actually drove the verdict, and a trustworthy one (computed from the
judge's per-finding call, not curated-defect matching). **The recall column
(12.5%/0%) is NOT a trustworthy quality signal** — a raw spot-check of the
one case whose output survived confirmed both models produced ~49 real,
substantive findings each but neither matched the ONE curated defect closely
enough for the exact-match scorer to credit it (the oracle-mode ceiling
above, now reproduced at promotion tier on an independent case, not just
screen tier). Corpus pruned 25→18 entries as a prerequisite (7
permanently-unloadable: egress-blocked, oversized, or unresolvable git
history — verified mechanically, not curated away). Full write-up incl. the
raw-finding evidence and a governance note on the cross-repo egress
authorization boundary that held even under direct repeated user request:
[`docs/research/experiment-3-model-swap-glm-vs-gpt.md`](../research/experiment-3-model-swap-glm-vs-gpt.md).

## Adjudicator role — not yet run (open item, 2026-07-14)

Unlike the auditor role above, **no `model-eval-adjudicator.mjs` run has ever
been executed** — screen or promotion tier, any candidate. The harness
supports it identically (`node scripts/model-eval-adjudicator.mjs --candidate
<spec> --tier screen|promotion`), and the shared core (route resolution,
structured extraction, verdict computation) is the same machinery the
auditor-role run above already exercised — nobody has pointed it at a real
candidate yet.

**What running it needs**:
- **Tier C** (always available, cheapest first signal) — `structured-
  extractor.mjs` scores the candidate as a T/F extractor against
  `getAdjudicatorGroundTruth()` (real, labeled `audit_findings` rows via
  `scripts/lib/store/model-ab.mjs`). No live shadow run required.
- **Tier A/B** (comparative — only reachable when `route-catalog.mjs` judges
  candidate/baseline as genuinely independent lineages) — points
  `gemini-review.mjs`'s `FINAL_REVIEW_SHADOW` mechanism at the candidate for
  `minLiveShadowRuns` live runs (default 20, mirroring the shadow-final-
  review A/B's own pre-registered stopping rule), then finalizes via
  `finalize-shadow-eval.mjs`.
- Thresholds are the same uncalibrated v0.1 bootstrap values as the auditor
  role (`config/adjudicator-thresholds.json`) — not yet empirically
  validated by a real run either.

**Cross-reference for the tiered-recall pipeline**: Stage 2 of that pipeline
(`docs/plans/tiered-recall-audit-pipeline.md`) uses Gemini as its adjudicator.
That plan's Phase 14 production-flip review is a natural moment to also ask
whether Gemini is still the right adjudicator choice — the two decisions are
independent (Phase 14 doesn't require this eval to run first) but they touch
the same "which model does final review" question, so decide them together
rather than flipping Phase 14 and separately forgetting this is still open.
