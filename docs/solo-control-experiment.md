# Solo author-model control — the code-audit null hypothesis

**What / why.** The model-A/B/C code-audit shadow compares three *external* auditor
pipelines against each other (A = GPT→Gemini, B = OSS→GPT-round→Gemini, C = OSS→Gemini).
None of them measures the counterfactual the whole audit apparatus is justified
against: **what does a capable model catch reviewing the same diff bare, with no
external audit?** The solo control adds that baseline as two clean, cold-diff author
models:

- **Sonnet-5 (clean)** — *does an author-class model catch what the apparatus catches?*
  (capability ceiling for solo review)
- **Fable-5 (clean)** — the **cost-frontier floor**: *is the cheap model, run bare,
  already good enough — so why pay for any apparatus?*

Three actionable outcomes: both under-catch → the apparatus earns its keep; Sonnet
recovers most but Fable doesn't → replaceable only by a strong model; Fable already
recovers most apparatus-accepted HIGHs → the stack is on notice and you've found your
cheap default.

**Design** (origin: `/brainstorm --with-gemini`, 2026-07-04; sessions 1783178984262 +
1783179213097). Deliberately an **offline script**, not a 4th in-harness arm, so the
A/B/C paired comparison stays uncontaminated. Load-bearing:

1. **Cold-diff, not in-context self-review** — isolates author bias from context-window
   pollution; the true sibling to A/B/C (same frozen artifact, same audit framing). It
   runs the *same 5 passes* the arms run (`PASS_PROMPTS`), with the author model, no
   downstream GPT-round / Gemini gate.
2. **Blind union re-adjudication by a HUMAN** — the ledger's accept/dismiss labels were
   produced BY the external pipeline, so grading solo against them makes it a structural
   subset of the incumbent. `merge` emits a source-blinded, shuffled, uniform-detail
   sheet; a human labels it; `score` unblinds. **No LLM judge** (Claude-judging-Claude /
   model-preference bias).
3. **Parallel frozen-diff is an UPPER BOUND** on external marginal value — in production
   a solo review would fix bugs *before* the apparatus saw the diff. We caveat this
   rather than model the sequential pipeline.

## Tool — `scripts/solo-control-audit.mjs`

| Phase | Command | Does |
|---|---|---|
| run | `node scripts/solo-control-audit.mjs run --model claude-sonnet-5` | Cold-diff audit of each shadow commit with the author model. Incremental (skips covered commits); self-gates on the arm-eval toggle; egress-gated + sensitive-file-filtered; chunks large diffs (no truncation bias). Writes `S-findings-<label>.json`. |
| merge | `node scripts/solo-control-audit.mjs merge [--severity high[,medium,low]]` | Pulls A/B/C from the ledger (via the `model_ab_finding_scores` view — arm A included) + all solo runs → source-blinded shuffled CSV `blind-adjudication.csv` (+ private `.blind-map.json`). HIGH-only default. |
| score | `node scripts/solo-control-audit.mjs score` | Unblinds the labeled CSV → per-solo-arm recall-of-apparatus-accepted, solo-only-accepted, apparatus-only-accepted; compares solo arms to each other (cost frontier). |

Convenience: `npm run solo-control:catchup` (both models, incremental) · `:merge` · `:score`.

Outputs live under `.audit-loop/solo-control/` (gitignored — Category-A derived artifact;
the `.blind-map.json` unblind key must never be committed).

**Multi-repo**: the script locates each commit across `process.cwd()` + any
`SOLO_CONTROL_REPO_ROOTS` (comma-separated absolute paths in local `.env`), so a single
source-repo catch-up sweeps sibling repos' (wine-cellar, ai-organiser) shadow commits.

## Standing policy (2026-07-04)

Whenever the `arm-eval` shadow toggle is ON, the solo control runs automatically:
`/audit-code` Step 6.5b fires `solo-control run` for both author models **in the
background** after each audit (non-blocking; the script self-gates + is incremental).
`/cycle` inherits it via its `/audit-code` delegation. Human adjudication stays a
separate, deliberate offline step.

## Adjudication how-to

1. `npm run solo-control:merge` → open `.audit-loop/solo-control/blind-adjudication.csv`.
2. For each row fill **`verdict`** (`accept` | `dismiss` | `uncertain`) and, for
   findings that are the *same underlying issue*, give them a shared **`cluster`** value
   (semantic dedup — the tool pre-seeds a verbatim-dup hint but you do the real
   clustering). **Do not open `.blind-map.json`** while labeling.
3. `npm run solo-control:score` → the six metrics + the interpretation line.
