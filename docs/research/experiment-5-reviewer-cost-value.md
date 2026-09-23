# Experiment 5 — Reviewer Cost-vs-Value: Which Configuration Earns Its Cost?

Plan: [`docs/plans/reviewer-cost-value-experiment.md`](../plans/reviewer-cost-value-experiment.md)
(pre-registration frozen 2026-09-21, before any spend). Run 2026-09-21/23. This
closes the question `/audit-code`'s own description has carried unanswered
since 2026-09-20: does the production 5-pass+Gemini pipeline earn its cost
over a cold frontier model or a cheap model run several times?

**Verdict: keep the production configuration (Arm A).** Confirmed
independently by two cross-vendor judges scoring the same blind sheet — full
detail below, including where the two judges disagree and why that doesn't
change the decision.

## Setup

| | |
|---|---|
| Corpus | 35 commits — 18 curated `known-defects.json` entries + 17 stratified draws (size × kind) from claude-engineering-skills / wine-cellar-app / ai-organiser main history, 2026-06..09. One cohort (policy v2 permits every recipient on every repo). |
| Configuration candidates | **A** (production: 5-pass `gpt-5.6-terra` → `gemini-flash-latest` gate) · **A+** (same 5-pass → `gemini-pro-latest` gate) · **A-sonnet** (same 5-pass → `claude-sonnet-5` @xhigh gate) · **A-sol** (same 5-pass → `gpt-5.6-sol` @high gate) · **C** (cold `claude-sonnet-5` ×3 union @xhigh) · **E** (cold `deepseek-flash` ×3 union @max, direct API, fingerprint-pinned) |
| Blind adjudication | 1,551 rows (1,450 auto-included HIGH-tier + 101 stratified medium-pool sample), labeled blind by two independent cross-vendor judges — see §Second-rater below |
| Total spend | **$194.76** (arm-cost ledger; cap was $350) + ~$2–3 separate GPT-judge verification spend, not part of the arm budget |
| Runtime | ~25.5 hours wall-clock (A: ~2h35m; A+/A-sonnet/A-sol gate-only: ~2h30m combined; C: ~13h, xhigh reasoning per cell; E: ~8h, parallel to C in a separate pinned worktree) |

## Per-arm measurement (both judges)

`value` = Σ severity-weight × label-factor over adjudicated clusters (proven=1.0,
actionable=0.6, plausible/false=0). `$/diff` is measured from the call ledger,
not estimated, and is **identical across both judge columns** — it doesn't
depend on labeling.

| Arm | Findings | $/diff | Value (Fable) | Value (GPT) | falseRate (Fable) | falseRate (GPT) | Eligible? |
|---|---|---|---|---|---|---|---|
| **A** (incumbent) | 456 | **$0.366** | 741.0 | 665.8 | 0.314 | 0.241 | ✅ both |
| A+ | 457 | $0.509 | 688.0 | 692.8 | 0.310 | 0.262 | ✅ both |
| A-sonnet | 553 | $0.394 | 596.8 | 603.6 | 0.326 | 0.304 | ✅ both |
| A-sol | 489 | $0.371 | 696.2 | 725.6 | 0.286 | 0.244 | ✅ both |
| C (cold Sonnet ×3) | 2,379 | $4.537 | 809.6 | 662.4 | 0.333 | 0.388 | ❌ both (`false-rate>0.33`) |
| E (cold DeepSeek ×3) | 3,859 | $0.293 | 645.0 | 515.0 | 0.354 | 0.413 | ❌ both (`false-rate>0.33`) |

## `decide()` output — both judges, verbatim fields

| Field | Fable-judge | GPT-judge |
|---|---|---|
| `eligible` | A-sol, A+, A-sonnet, A | A-sol, A+, A-sonnet, A |
| `ineligible` | C, E (`false-rate>0.33`) | C, E (`false-rate>0.33`) |
| `trusted` | A-sol, A+, A | **A only** |
| `best` | A | A |
| `acceptable` | A-sol, A+ | **(none)** |
| `winner` | **A** | **A** |
| `winnerReason` | incumbent | incumbent |
| `nonInferiorCheap` | (none) | (none) |
| `inconclusive` | false | false |
| Cohort | 35/35 commits kept, 0 dropped, 0 partial | 35/35 commits kept, 0 dropped, 0 partial |

## Answering the two questions

**Q1 — does the cheap challenger (E, DeepSeek V4.1 Flash ×3), unioned, reach
non-inferiority at a fraction of the cost?** **No**, and not narrowly: E is
**ineligible** under both judges (`false-rate>0.33`) — it doesn't clear the
eligibility bar at all, so the `nonInferiorCheap` question (≤0.25× A's cost
while acceptable) never gets asked. This despite E being genuinely the
cheapest arm measured ($0.293/diff, cheaper even than A) and producing by far
the most raw findings (3,859) — volume without precision. The 4th-most-noisy
LOW-severity count in the whole experiment (1,648, vs. 57–127 for the four
apparatus variants) is the same signal from a different angle.

**Q2 — does the apparatus beat the best cold arm by enough to justify its
cost?** **Yes.** Both cold arms (C, E) are ineligible under both judges, so
there is no eligible cold-arm comparator to beat: A is not "beaten", it is
simply not competing against anything eligible. A also happens to be the
**cheapest of the four eligible arms** in this run ($0.366/diff vs.
$0.371–$0.509 for A+/A-sonnet/A-sol) — the incumbent wins on cost even among
arms nobody proposed replacing it with.

**Conclusion**: the production configuration (Arm A) stays the default.
Per the pre-registration, this also means the `/audit-code` skill's
description clause ("invoke this for ANY code review, even a pasted snippet")
is **not** reverted — that reversion was conditioned on the winner not being A.

## Second-rater validation (why this is trustworthy despite imperfect agreement)

The pre-registration's blindness clause is a single human-labeled sheet. The
companion adjudication instructions ([`ADJUDICATION-INSTRUCTIONS.md`](../../.audit-loop/solo-control/ADJUDICATION-INSTRUCTIONS.md)-pattern,
this run's version at `FRESH-SESSION-PROMPT-EXP5.md`) set a higher bar before
trusting a single-rater result: a second, independent, cross-vendor rater on a
sample, checked for agreement.

- **Rater 1**: a fresh Claude session on `claude-fable-5` (deliberately a
  different Claude sub-family from the two Sonnet-based arms under test),
  labeled all 1,551 rows against the actual code (`git show`), blind to
  `.blind-map.json`.
- **10% sample check** (seed 20260922, 155 rows): GPT (pinned `gpt-5.6-terra`,
  high effort) blind-graded the same rows against the same diff evidence
  (`extractDiff`+`chunkDiff`, the exact bytes the generation passes saw).
  **62.6% exact agreement**, 16/155 (10.3%) major (>1 tier) disagreements.
  One cluster was independently spot-checked by hand: Fable called `false`
  four times on the same real, provable HIGH bug (`scripts/install-skills.mjs`
  running `npm install` unconditionally under `--dry-run`, unlike the adjacent
  `ensureAuditGitignore` call one line above it, which correctly threads the
  flag through — verified directly via `git show`). GPT was right; Fable was
  wrong. That result escalated the check from a sample to a full second pass.
- **Full second pass** (all 1,551 rows, 33 commit batches, ~625k in / 172k out
  tokens, ~$2–3): **64.9% exact agreement** (1,007/1,551), confirming the
  sample was representative. 147/1,551 (9.5%) major disagreements.

  | Fable ＼ GPT | proven | actionable | plausible | false |
  |---|---|---|---|---|
  | proven | 476 | 142 | 19 | 7 |
  | actionable | 111 | 187 | 66 | 42 |
  | plausible | 1 | 4 | 10 | 6 |
  | false | 40 | 38 | 68 | 334 |

  Fable's `false` calls are the weak spot: 146/478 (31%) were upgraded by GPT
  to proven/actionable/plausible, consistent with the spot-checked error above
  being a real pattern, not an isolated slip.

**What this does and does not mean for the verdict.** Scoring both sheets
independently (§`decide()` table above) shows the row-level disagreement is
**largely non-differential**: it does not flip which arm wins. Both judges
agree on `eligible`/`ineligible`/`winner` exactly. It **does** change the
finer classification — GPT's stricter numbers (lower false-rates measured for
A itself, 0.241 vs. Fable's 0.314) tighten the trust bar
(`falseRate ≤ min(A.falseRate, 0.33)`) enough that A-sol and A+ fall just
outside it under GPT (A-sol's GPT false-rate, 0.244, misses A's own 0.241 by
0.003) while clearing it comfortably under Fable. That knife-edge sensitivity
is itself a finding: **the trust bar is not robust to small measurement
differences in the incumbent's own false-rate**, even though the winner
decision is. Report both judges' numbers together; do not treat either as
ground truth.

## Deviations from the frozen pre-registration (stated, not hidden)

- **Adjudicated severity (`sev`/`sevReason`, §3 "Adjudication (H6)") was
  specified, and a rubric was written for it in Phase 1
  ([`experiment-5-adjudication-rubric.md`](../experiments/audit-effectiveness/experiment-5-adjudication-rubric.md),
  frozen 2026-09-20) — but the labeling session's own instructions
  (`FRESH-SESSION-PROMPT-EXP5.md`) never referenced that rubric or asked for
  `sev`/`sevReason`, so neither rater ever produced them. This is an
  orchestration miss, not a missing feature: the spec existed and was not
  consulted when the actual labeling prompt was written. `scoreArms`'s
  `effSeverity = r.sev || r.severity` therefore fell back to the tool-emitted
  severity for every row in both judge sheets — the exact case the plan
  itself calls "kept in a separate column for calibration only", not the
  intended scoring input. The value numbers above are reported against
  emitted severity, uncalibrated by the written impact rubric. The rubric's
  40-row-per-commit time cap (label first 40, mark the rest
  `plausible`/"unreviewed — over cap") was likewise never applied — Fable
  fully labeled every row of every commit instead, including several with
  100+ rows, which is more thorough than the cap required but is still not
  what was pre-registered.
- **Configuration-candidate vs. gate-ablation terminology is internally
  inconsistent in the plan text** (§3): one passage calls A+/A-sonnet/A-sol
  a "gate ablation... excluded from `decide()`", while the Decision Function
  section explicitly lists A+ as a `decide()` input, and A-sonnet/A-sol were
  added later as "third and fourth candidates". The **implemented** `decide()`
  scores all six arms as full configuration candidates (all six appear in
  `eligible`/`ineligible`); that is the behavior this verdict reports against,
  not the ambiguous prose. Worth reconciling in the plan doc, not resolved
  here.
- **Gate-ablation reporting (Pro vs. Flash, paired per commit) was not
  separately compiled** into the format §3 describes (per-commit adjudicated
  net-new value + cost + paired difference). The `decide()` table above
  answers the configuration question the plan cares about most; the narrower
  "did the 2026-09-07 Flash default cost anything" ablation question is
  answerable from the same artifacts (`G-pro-A-<sha>.json` vs.
  `G-flash-A-<sha>.json`, both preserved) but is not compiled here.

## Run matrix / execution contract

Every `(arm, commit)` cell across all 6 arms × 35 commits landed on a terminal
state; **zero `partial`, zero `excluded`, zero dropped commits** in either
scoring — cohort was `kept: 35/35` both times, so the "verdict document must
print the run matrix" requirement is satisfied trivially: there is nothing to
drop. Both cold arms' ×3 unions showed `samplingDegenerate: false` (repeats
genuinely varied — verified via the model's own decoding for E, temperature
1.0 for C). 3,190 ledger rows total, all priced (`aggregateBudgetSpent`
`complete: true`), $194.76 of $350 cap spent.

Three real instrument defects surfaced and were fixed *before* they could
corrupt this result (see the plan's Implementation Log,
2026-09-22 entries): a prose↔schema mismatch that would have zeroed every cold
finding, a conformance-miss that silently dropped billed usage, and a
hardcoded `sharedBy` list that would have mis-priced the two later gate
candidates. All three are locked with regression tests.

## What this does and does not claim

- **Power is thin, by the plan's own admission**: at ~1 verified HIGH per 2–3
  diffs, 35 diffs yield roughly 12–17 HIGHs in the union. The 90% acceptability
  margin (unused here — no cold arm reached it) "misses at most 1–2" and is
  adequate for a *default-configuration* choice, not a rare-event safety bound.
- **Parallel frozen-diff, not a live trial**: every arm reviewed the *same*
  static diff. Apparatus-unique value is an **upper bound** on external
  marginal value — in production, a solo review would fix bugs before the
  apparatus ever saw the diff, which this design cannot observe.
- **The cheap-challenger result is model-specific, not a claim about cheap
  models in general**: DeepSeek V4.1 Flash was selected by live benchmark +
  price + route stability (plan §0), not exhaustively. The fallback order
  (GLM-5.3-Flash, then Qwen3.8-Flash) was never triggered because E failed
  eligibility outright rather than merely missing non-inferiority — a
  different cheap model could plausibly clear the eligibility bar where this
  one did not. This experiment answers "does DeepSeek V4.1 Flash ×3 replace
  the apparatus", not "can any sufficiently cheap model".
- **Two labeled sheets exist and are both preserved**
  (`blind-adjudication-fable.csv`, `blind-adjudication-gpt.csv` in
  `.audit-loop/solo-control/`, gitignored — this is a local artifact, not
  committed) for anyone who wants to re-derive the `decide()` output or
  inspect a specific disagreement; `second-rater-full-report.md` lists all 147
  major disagreements verbatim.

## Security / governance compliance

Both flagged incidents (plan header) were respected without incident: all
diff extraction went through the existing `extractDiff`/sensitive-path
classification path (no local allowlist introduced for this experiment), and
the runner made zero writes to the production audit store
(`LEARNING_DISABLE=1` set for the full run; `solo-control-audit.mjs` writes
only to its own local `.audit-loop/solo-control/` artifacts, never
`audit_findings`).

## Where the artifacts live

Everything under `.audit-loop/solo-control/` in the pinned worktree
`claude-engineering-skills-pinned/exp5` (rev `e114ff0f`), gitignored, not
committed: `S-findings-{A,A+,A-sonnet,A-sol,C,E}.json` (per-arm raw findings),
`call-ledger.jsonl` (3,190 priced rows), `blind-adjudication.csv` (live sheet,
= Fable's labels), `blind-adjudication-{fable,gpt}.csv` (both full judge
sheets), `second-rater-full-report.md`, `logs/score-{fable,gpt}.log` (full
`decide()` JSON, both judges).
