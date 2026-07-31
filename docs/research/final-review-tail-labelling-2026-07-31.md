# Final-review shadow — tail labelling + overlap measurement (2026-07-31)

**Follow-up to**: [`final-review-shadow-adjudication-briefing.md`](./final-review-shadow-adjudication-briefing.md)
**Status**: labels applied to the store; supersedes the briefing's "unreadable tail" economics
**Instruments**: the credit loop shipped in [`final-review-credit-and-cheap-shadow.md`](../plans/final-review-credit-and-cheap-shadow.md) + one-off probes (`.claude/tmp/overlap-probe*.mjs`, `label-shadow-backlog.mjs`)

---

## 1. What changed

The closed A/B's verdict (KEEP) rested on 10 formally-accepted HIGH/MED findings,
with a 61-finding unlabelled tail that read as noise. Two things were done:

1. **The `both: 0` overlap bucket was investigated** rather than trusted.
2. **52 of the 61 unlabelled shadow findings were labelled**, from this
   session's blind adjudication of the same fingerprints, tiered by evidence.

Both moved the numbers; the second reversed a recommendation made earlier the
same day.

## 2. Overlap: broken mechanism, honest totals

`diffFindingBuckets` compares reviewers by `_hash = sha256(category|section|detail)`
— the **full free-text prose** of each finding ([findings.mjs:38](../../scripts/lib/findings.mjs)).
Two models describing one defect in different words essentially never collide, so
`both` is structurally ~0 for any cross-model pair. **The bucket measures
phrasing identity, not defect identity.**

But the *actual* overlap, measured with file-normalised matching (the raw
`primary_file` values carry decoration — `"file — location"`, `"fileA + fileB"` —
which defeats naive equality):

| Probe | Result |
|---|---|
| Same run + same normalised file, primary × shadow | 10 candidate pairs across 7 runs |
| Confirmed same-defect | **1** (wine `df2dfeac` ≡ `d1a81eb5` — the unguarded `await import` in `clearAuthState()`) |
| Probable partial | 1 (`perceivable.mjs` composed-tree pair) |
| Real overlap rate | **~1–2 of 92 (~2%)** |

So the earlier hypothesis "zero-overlap is an artifact that inflates Opus" was
half right: the mechanism cannot measure overlap, but the inflation is ~2%, not
~30%. **The marginal counts stand.**

Two byproducts worth recording:

- `finding_embeddings` covers **0/92** shadow findings and 6/22 primary —
  `recordFinalReviewFindings` bypasses the record-time embedding hook that
  `recordFindings` carries. Semantic overlap measurement is impossible until
  that is wired. (Small, deferred — not load-bearing at 2% overlap.)
- Only **7 of 29** paired runs had both reviewers produce ≥1 finding. In most
  runs one reviewer is silent — reviewer output is sparse, which is why
  per-run rates matter more than per-finding comparisons.

## 3. The labelling

Source: the 88-finding blind adjudication run earlier in this same session
(two repos, hidden 25-finding human calibration set), then substantiated
per-fingerprint with code citations. Labels were applied **tiered by evidence
class**, only to rows with `user_action IS NULL`, all reversible:

| Tier | Evidence | Label | n |
|---|---|---|---|
| A | Real when filed, since fixed — 16/21 carry an in-code comment crediting the shadow; 4/4 sampled citations hand-verified | `accepted` + `remediation_state: fixed` | 13 |
| B | Real defect confirmed present in current code | `accepted` | 13 |
| C | Not a defect — contradicted by code or documented deliberate design. **Weakest tier: pure LLM judgement; this judge scored 44% agreement on the calibration set** | `dismissed` | 26 |
| — | `cannot_determine` (mostly transcript-process claims) or post-dates the adjudicated set | left unlabelled | 9 |

**Caveat that must travel with these numbers**: tier C is the one to
spot-check. If a human disagrees with several of the 26 dismissals, the accept
rate moves *up* (dismissals flipping to accepted) — i.e. the residual risk is
in Opus's favour, not against it.

## 4. Economics, before → after

Over all 92 Opus shadow-only findings (29 paired runs, $35.20 shadow spend):

| | before labelling | after |
|---|---|---|
| Accepted | 23 (14 M + 9 L) | **49** (3 H + 30 M + 16 L) |
| — accepted HIGH/MED | 14 | **33** (incl. all 3 HIGH) |
| Dismissed | 8 | 34 |
| Unlabelled | 61 | 9 |
| Accept rate (labelled) | 74% (n=31) | **59%** (n=83) |
| Cost per accepted HIGH/MED | $1.53–unknowable | **~$1.07** |
| Accepted HIGH/MED per run | ~0.5 | **~1.1** |

Reference points: the Gemini primary review costs ~$0.10/run; the Opus shadow
adds ~$1.21/run; a Kimi (k2-thinking) shadow measured ~$0.044/review
single-attempt, but needed **two attempts** on a large transcript (296.7 s
truncated → 60.6 s conciseness retry), so budget ~$0.09.

## 5. Corrected conclusion

The same-day earlier recommendation ("drop Opus, run Kimi") rested on two legs:
the unlabelled tail probably being noise, and overlap inflation. Both are now
measured false — the tail was ~59–62% real, the inflation ~2%. **On this data,
Gemini + Opus is defensible: ~1.1 accepted HIGH/MED per run at ~$1.07 per
accepted defect.** Whether a cheap shadow matches that is an open question with
n=2 Kimi runs (zero unique accepted — no verdict possible either way).

What remains unmeasured, in honesty order:

1. **Pipeline-level uniqueness** — "shadow-only" is defined against the primary
   final reviewer only. `fd33a4e4`'s fix credits a GPT audit-pass finding, so
   some shadow value double-counts what the 5-pass audit already had. No join
   exists to same-run pass findings.
2. **Gemini's own 16 primary-only findings are unlabelled** — the primary's
   accept rate is unknown, so "Opus multiplies accepted output by 3–4×" assumes
   Gemini's rate resembles Opus's.
3. **Kimi's marginal value** — needs same-snapshot data, not alternation (a
   shadow seeing different snapshots measures diff difficulty, not the model).

## 6. Method notes for reuse

- The blinded-judge template (`.audit/shadow-eval/`, gitignored) plus a hidden
  calibration set is the pattern for any future LLM-judge pass; the judge's
  *verdicts* were mediocre (44%), its **checkable `unclear` rationales** ("since
  fixed — here is the comment") were the valuable output.
- Labels through the two-axis writers (`final-review-adjudicate`,
  `final-review-record-fix`), never raw SQL — idempotent, reversible,
  bucket-scoped.
- File-level overlap probes must normalise `primary_file` first; the field
  carries free-text decoration on the shadow side.
