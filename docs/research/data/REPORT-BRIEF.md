# Brief: build a report or slide deck from this experiment

Paste this whole file into a fresh Claude session, along with
`experiment-dataset.json` (same folder) — either paste its contents inline or
attach it. This is a self-contained brief; the receiving session needs no
other context.

## What this is

I ran a real, blind-adjudicated experiment comparing an AI code-audit
pipeline against solo model review, across 6 "arms," 14 real commits (13
usable), and 2,314 individually-graded findings, judged independently by two
different AI model families so no result rests on one model's opinion of
itself. Full numbers, methodology, and findings are in
`experiment-dataset.json`.

A second, cheaper, targeted follow-up (`followup_targeted_test` in the
dataset) then tested a specific composition the main study never covered:
"Sonnet writes → a fresh Sonnet pass audits cold → Gemini adds one more
independent lens." This is now the evidence-backed headline recommendation —
make sure it lands, not just the six-arm comparison.

A THIRD follow-up (`generator_isolation_test` in the dataset) then closed a
gap in the second one: every Gemini result up to that point came from the
easier "find what a prior pass missed" role, never the harder "audit this
diff cold, from scratch" role GPT-5.5 always did. This follow-up ran BOTH
models through the identical from-scratch task on the same 5 commits and
blind-graded both. Result: Gemini beat GPT-5.5 on every trust metric
(26.5% vs 51.9% false-rate) — even though the GPT-5.5 judge graded its own
GPT-alone output (a bias that should have favored GPT, not hurt it). This is
the answer to "is Gemini actually a better auditor, or does it just get an
easier job" — make sure THIS lands too: it's the mechanism behind why
Sonnet+Gemini beats the GPT-based production pipeline.

## What I want you to build

**[FILL IN: "a one-page report" / "a 6-8 slide deck" / "both" — pick one
before you paste this]**

Audience: **a university lecturer, for an in-person discussion** — not for
publication, not for a general public audience. Assume they understand
research methodology (blinding, ground truth, inter-rater agreement) but have
NOT seen this specific experiment. Tone: rigorous, direct, a little
understated — this is real data with a genuinely interesting, nuanced
result; it doesn't need hype to land.

## Hard constraints

1. **Never name the private commercial repo.** The dataset refers to it as
   "a private commercial app" — keep it that way in whatever you produce.
   `ai-organiser` and `claude-engineering-skills` may be named freely.
2. **Don't overclaim.** The dataset's `caveats` array is not optional
   decoration — the N=14 sample size, the frozen-diff upper-bound caveat, and
   the small known-defect-recall denominators all need to appear somewhere
   the reader will actually see them, not buried in a footnote no one reads.
3. **Lead with the nuanced finding, not the simple one.** The tempting
   headline is "AI audits don't work" — that's NOT what the data shows. The
   real finding is a precision/recall tradeoff: the expensive pipeline is
   less trustworthy per-claim but still catches more of the hard bugs. Both
   halves of that sentence need to survive into the final deliverable.
4. **The follow-up test's distinction between additive and corrective value
   is the sharpest single insight in the whole dataset — don't lose it.**
   Adding Gemini to Sonnet measurably improves trust/value (confirmed at full
   13-commit scale), but it added ZERO extra known-defect catches — it finds
   *different* good things, it doesn't close Sonnet's specific gaps on the
   hardest bugs. That distinction (additive vs. corrective) is more precise
   and more defensible than "diversity helps," and a methodology-literate
   audience will appreciate the precision.
4b. **Do NOT overclaim "Gemini beats Sonnet."** The data supports "Gemini
   beats GPT-5.5 as a standalone auditor" (tested head-to-head, same
   commits, same task) — it does NOT support "Gemini beats Sonnet" (never
   tested head-to-head at equal rigor; the two numbers that look similar come
   from a 5-commit/1-judge slice vs. a 13-commit/2-judge result). State this
   distinction explicitly if the audience asks "so is Gemini just better than
   Claude?" — the honest answer is "better than GPT-5.5, comparable to
   Sonnet, not cross-validated against Sonnet directly."
5. **The three "rigor" stories are not asides — they're the credibility
   backbone.** A lecturer will want to know the methodology holds up: the
   diff-chunking bug fix (root-caused and fixed before this data was
   collected), the KD-013 ground-truth self-correction, and the Fable-5
   pricing correction (an assumption stated as fact, then caught and rebuilt
   on real numbers) are the strongest evidence this wasn't run carelessly.
   Give them real space, not one throwaway line each.
6. **Use the actual numbers from `experiment-dataset.json`, not
   approximations.** If you round for a chart, say what precision you rounded
   to.

## Suggested structure (adapt freely — this isn't a template to fill in blind)

1. **The question** — one line: does a heavyweight multi-model audit
   pipeline actually produce more trustworthy findings than a single model
   reviewing once?
2. **The method** — blind, source-stripped re-grading against real code, two
   independent cross-family judges, 6 arms, 14 commits. Enough to establish
   this wasn't self-graded.
3. **The trust-bar mechanic** — explain the eligibility rule in plain terms
   before showing numbers (an arm that's wrong more than 1-in-3 times isn't
   worth trusting without re-checking everything, which defeats automating
   review in the first place). A reader needs this BEFORE the chart, or the
   chart won't land.
4. **The comparison** — the 6 arms, both judges, false-rate against the 33%
   ceiling. This is the one visual worth making genuinely good if you're
   building slides.
5. **The six findings** (`known_findings` in the dataset) — pick the
   strongest 3-4 if space is tight; don't cut the recall/precision tradeoff
   one (#3) or the repeats-made-it-worse one (#4) even under time pressure —
   those are the two that make this more than a horse race.
6. **The follow-up test** (`followup_targeted_test` in the dataset) — the
   specific "Sonnet writes, Sonnet audits, Gemini adds a lens" composition,
   confirmed at full 13-commit scale, additive not corrective. This is the
   part that turns the six-arm comparison into an actual recommendation.
7. **The three rigor stories** — diff-chunking fix, KD-013 correction, the
   Fable-5 pricing correction.
8. **Bottom line** — Sonnet writes → fresh Sonnet audits cold → Gemini adds
   one lens, as the evidence-backed default; the expensive multi-model
   pipeline reserved for cases where the extra noise is worth chasing GLM's
   distinct hard-bug catches (KD-005/006 in this data) specifically.
9. **Caveats** — visible, not buried, including that the follow-up test used
   only one judge (GPT-5.5), not the two-judge cross-validation of the main
   result.

## Reference visual

A polished HTML version of this data already exists — if it's useful as a
design/content reference (not to be copied verbatim, the tone there is
already dialed in): the chart, findings list, and bottom-line framing in that
version reflect the same editorial judgment calls above. Ask me for the link
if you want to see it.

## Data file

`experiment-dataset.json` (same directory as this brief) has every number
referenced above, plus the full per-arm/per-judge breakdown, judge-agreement
stats, and both rigor-story details in structured form.
