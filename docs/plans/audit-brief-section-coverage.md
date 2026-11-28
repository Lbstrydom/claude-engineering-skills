# Plan: The audit brief condenses the instruction file by section, not by head

- **Date**: 2026-11-28
- **Status**: In progress
- **Author**: Claude + Louis
- **Scope**: backend (`scripts/lib/context.mjs` + one test file; no UI)
- **Upstream report**: `477617f6`

> **Target domain(s)**: `shared-lib`, `tests`

> All `file:line` citations are pinned to commit `067057e9`.

---

## 1. Context Summary

`initAuditBrief()` (`scripts/lib/context.mjs:681 (067057e9)`) builds the brief
every audit pass receives. Its LLM input is `content.slice(0, 48000)`
(`:253`) — a HEAD slice, with no log and no marker. Both the Haiku leg (`:341`)
and the Gemini leg (`:376`) read only that. The two no-LLM fallbacks are head
slices too: `content.slice(0, 1500)` (`:702`) and `content.slice(0, 2000)`
(`:706`), and so are the uninitialised readers `readProjectContextForPass`
(`slice(0, 2000)`) and `readProjectContext` (`slice(0, 4000)`).

**Measured** (`wc -c AGENTS.md` at `067057e9`): CES's own AGENTS.md is 58,916
chars over 34 `## ` sections, so everything after ~char 48,000 — *Scope
discipline*, *Contracts across the prose↔code seam*, *Sensitive paths*,
*Verification discipline*, *Code Style*, *Do NOT*, *Accepted Technical Debt* —
never reached a model. A consumer's file is 86,153 chars (reported). The brief
says nothing about it: an under-read is indistinguishable from a full read.

The regex facts (`:689`) and pass addenda (`:417-430`) already read the full
file; they are out of scope.

## 2. Proposed Architecture

### Right-sizing

- **Band-aid**: raise 48,000 to 90,000. Moves the cliff; the next long file
  falls off it again, still silently. Rejected by the brief and by this plan.
- **Over-built**: an LLM map-reduce (condense each section with its own call,
  then merge), or relevance-ranking sections by embedding. More calls, more
  spend, non-deterministic, and a new failure surface on an *optional*
  enrichment step bounded at 30 s total.
- **Chosen**: a deterministic **fair-share split by section**. Split on `## `
  headings (fence-aware, via the existing `makeFenceTracker`), give every
  section its heading line first, then share the rest **round-robin by whole
  block** (paragraph, list item, quote paragraph, table row; never inside a
  code fence) — a short section ends whole, a long one ends on a block
  boundary with an explicit `…[cut: a/b chars]` marker.
  Same budget, same calls, no ranking judgement to argue about. It is the
  smallest change that makes *"every section is represented"* and *"how much
  was read"* true and visible.

### Components

Items 1–3 live in a new module, `scripts/lib/instruction-sections.mjs`:
`context.mjs` was at 885 lines and the size ratchet forbids crossing 1,000.

1. `splitInstructionSections(content)` — fence-aware `## ` split that keeps the
   preamble as its own section; `join('\n')` round-trips the input exactly.
   *Sibling, not reuse*: `check-context-drift.mjs`'s `extractH2Sections` drops
   the preamble (the CES preamble is ~12.5 K chars of tripwires) and lives in a
   CLI module a `scripts/lib` module must not import.
2. `condenseBySection(content, budget)` → `{ text, coverage }`. Under budget,
   the input is returned verbatim (no behaviour change for small files).
   Over budget: (a) heading lines in file order, skipping any that does not
   fit; (b) round-robin passes, each section taking its next whole block if it
   fits, until a pass adds nothing — every section is offered the same number
   of blocks before any gets another, and a block too big for what is left
   stalls only its own section; (c) render whole, cut (marker), heading-only,
   or omitted (the last two counted in one trailing note).
   `makeFenceTracker` gains an additive `isOpen()` so a cut point can be proven
   outside a fence (its return value is true for a closing delimiter too, so it
   cannot say this).
3. `formatSectionCoverage(coverage, label)` → one line:
   `Instruction-file coverage (AGENTS.md): 35/35 sections represented (33 whole, 2 condensed); 47313 of 58916 chars read (80%)`.
4. `initAuditBrief({ condense })` — computes the LLM input with
   `condenseBySection(content, 48000)`, logs the coverage line to stderr, and
   appends it to the brief (`> ...`) on **every** path: LLM, regex-only
   (budget 1500) and raw (budget 2000). `condense` defaults to `_llmCondense`;
   the parameter is a test seam so no test spends.
5. `readProjectContextForPass` / `readProjectContext` no-brief fallbacks use
   the same condenser and carry the coverage line.

`_llmCondense` no longer slices; it receives the already-condensed text.

### Accounting (defined)

- "chars" = JavaScript string length (UTF-16 code units), measured with
  `node -e "console.log(require('fs').readFileSync('AGENTS.md','utf8').length)"`
  → **58,916** at `067057e9` (35 sections counting the preamble).
- `budget` bounds the **output**: every block, marker, joining `\n` and the
  summary note is charged against it, so `text.length <= budget` (tested with
  2,000 tiny sections). `charsRead` counts source chars kept, never markers.

### What the fair share trades (measured, `067057e9`, budget 48,000)

| | Old head slice | By section |
|---|---|---|
| Sections represented | 24 of 35 (last 11 absent) | **35 of 35** |
| Sections whole | 23 | 33 |
| Preamble (12,528 chars) | whole | 4,909 chars (cut at a paragraph, marked) |
| Sections cut | 1 (silently, mid-sentence) | 2, each at a block boundary, marked |
| Chars read | 48,000 | 47,313 |
| Visible in the brief | no | coverage line |

Total chars read is ~the same; the change is *where* the ~11K unread chars
come from — spread over the two longest sections instead of the whole
tail. This is deliberate: position in the file is not a priority signal
(the dropped tail held *Do NOT* and *Accepted Technical Debt*), and a cut
that is marked and counted is recoverable by the reader where a missing
section is not. A positional or keyword ranking was rejected as the
over-built option (§Right-sizing): it reintroduces a judgement someone must
tune.

### Data flow (every path)

1. `regexFacts = _extractRegexFacts(full content)` — unchanged, full file.
2. `llmInput = condenseBySection(content, 48000)`; `llmBrief = await condense(llmInput.text)`.
   `condense` honours `_llmCondense`'s never-throws contract (timeouts and
   provider errors degrade to `null` inside it).
3. Path selection is unchanged:
   - `llmBrief` non-null → regex facts + LLM brief; coverage = `llmInput.coverage`.
   - else `regexFacts.length > 200` → regex facts + `## Raw Context` +
     `condenseBySection(content, 1500).text`; coverage = that call's.
   - else → `condenseBySection(content, 2000).text`; coverage = that call's.
4. On every path: stderr `[brief] <coverage line>` and the brief ends with
   `\n\n> <coverage line>`. The coverage line always describes the text the
   brief was actually built from.

## 3. Sustainability Notes

- Deterministic: no clock, no randomness, integer arithmetic; same input →
  byte-identical output (session cache stays valid).
- A file with more headings than the budget can hold reports
  `omitted` sections in the coverage line rather than hiding them.
- Budget constants unchanged.

## 4. File-Level Plan

- `scripts/lib/instruction-sections.mjs` (create) — components 1–3.
- `scripts/lib/markdown-fence-tracker.mjs` (modify) — additive `isOpen()`.
- `scripts/lib/context.mjs` (modify) — components 4–5.
- `tests/brief-section-coverage.test.mjs` (create) — §6.
- `docs/plans/audit-brief-section-coverage.md` (create) — this plan.
- `docs/plans/README.md` (modify) — regenerated by `npm run plans:index`.

## 5. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| A section cut at its share loses a rule in its tail | The marker says so and the coverage line counts it; the old code lost whole sections with no marker |
| Many tiny sections + a tiny budget → headings only | Honest outline, counted as `heading-only` in the coverage line (CES at 1,500: 35/35 named, 2 with body); a head slice there names no `## ` section at all (its 1,500 chars are all preamble) |
| One block bigger than what is left (e.g. a file that is one giant paragraph) | Never split; the section stays heading-only (or the preamble omitted) and the coverage line counts it. Real instruction files are made of paragraphs and list items |
| A cut drops a qualification held in a LATER block of the section | Cuts land only between blocks, so no item is truncated mid-sentence; the marker says the rest of the section is unread |
| `##` inside a code fence split as a heading | Fence-aware via `makeFenceTracker` (tested) |

## 6. Testing Strategy

`tests/brief-section-coverage.test.mjs`, no network, no spend:

1. Fixture AGENTS.md over the 48,000 budget whose **last** section carries a
   sentinel; the condensation input contains it.
2. **Negative control**: the old head-slice (`content.slice(0, 48000)`) of the
   same fixture does NOT contain the sentinel — the test would fail on the old
   code.
3. End-to-end through `initAuditBrief({ condense: fake })` in a temp cwd: the
   fake receives the sentinel; the brief carries the coverage line; the
   regex-only and raw fallbacks (fake returns `null`) carry it and name the last
   section's heading.
4. Under budget → verbatim; split round-trips; fenced `##` not split;
   deterministic; total read ≤ budget.

## 7. Acceptance Criteria

- Over budget, the summary note's length is reserved first; then every section
  whose heading line + join fits what is left is **represented** (headings in
  file order, skipping any that does not fit); a section is *omitted* only when
  its heading cannot fit, and the coverage line counts it. So every section is
  represented whenever `Σ(heading + 1) + note ≤ budget` (CES: 1,277 + 35 + ~60
  chars, so all 35 at 1,500) — and `text.length ≤ budget` always.
- Body text is added in whole blocks only. On a file over 48,000 chars whose
  last section's heading and first block fit their round-robin turn, the LLM
  input contains that block (tested with a sentinel). A block larger than
  what is left is never split: that section stays heading-only and is counted
  as such.
- Every brief ends with a measured `Instruction-file coverage` line. On the LLM
  path it is labelled `→ LLM brief input`: it states what the model was
  given, not what its ≤3,000-char summary kept — the summary's own fidelity is
  the model's, and is not measured here.
- No head-slice of the instruction file remains in `context.mjs`.

## 8. Implementation Log

- 2026-11-28: plan written. GPT R1 (4 H) and R2 (2 H, 2 M) addressed:
  accounting defined and the output bounded (markers charged), cuts moved to
  block boundaries outside fences, acceptance made conditional, fallback flow
  spelt out. Water-fill replaced by round-robin-by-block once snapping was
  measured to waste small shares (33/35 heading-only at 4,000). GPT R3 (3 H)
  addressed: the LLM-path coverage line is labelled `→ LLM brief input`, and
  both acceptance claims carry their conditions. Gemini plan gate: APPROVE.
- 2026-11-28: code R1 (3 H, 6 M), all fixed with a regression test each:
  an indented line never starts a block (a nested item stays with its parent;
  red-checked by mutation); a fence line with an info string no longer closes
  a fence (`markdown-fence-tracker.mjs`, CommonMark); the headingless preamble
  starts at "nothing", so a cut can never land inside its opening fence or
  paragraph and an unread preamble counts as omitted; a budget below the note
  returns empty text. Measured at 48,000: 35/35 sections, 33 whole, 2 cut,
  47,313 chars read.
- 2026-11-28: code R2 (2 H, 2 M): fixed — a fence indented 4+ spaces is
  indented code (tracker, CommonMark 0-3 spaces); a line ending in `:` keeps
  the whole list it introduces, blank line or not (red-checked by mutation).
  M2 (one block larger than what is left stalls its section; a file that is a
  single 48K paragraph yields no body) is the stated design, not a defect:
  splitting a block is exactly the mid-instruction cut R2 of the plan audit
  ruled out, and the stall is counted (`heading-only` / `omitted`) in the
  coverage line rather than hidden. Recorded in §5.
- 2026-11-28: code R3 (0 H, 3 M), fixed: `cutPoints` is one linear pass (the
  introducer lookup and the trimmed kept-end are carried forward, never
  rescanned; 40,000-item list tested); a section may jump straight to whole
  when that is cheaper than its next cut (whole drops the marker; red-checked
  by mutation). AGENTS.md output unchanged by both.
- 2026-11-28: code R4 (2 H, 1 M), fixed, each red-checked by mutation: an
  h2 may carry up to three spaces of indent (CommonMark); a closed fence ends
  its block without a following blank line; an unindented lazy-continuation
  line inside a list no longer becomes a new introducer (it detached later
  conditions from `…only when:`). Stopped GPT rounds here (past the usual
  2-3) and went to the final gate; AGENTS.md output unchanged.
- 2026-11-28: the first Gemini code run approved but reported Code coverage
  PARTIAL: rounds 1-4 ran with `--files` and no `--base`, so no diff base was
  stamped and `context.mjs`'s changed lines were unmeasured. Code R5 ran with
  `--base 067057e9`. R5 (2 H, 3 M): fixed, each red-checked by mutation — a
  fence inside a blockquote (a non-quote line closes it), multi-line HTML
  comments (no heading, no cut inside), `##` + tab is a heading; the
  round-robin keeps only ACTIVE sections (`left` never grows, so a stalled
  section never resumes), so total work is linear in blocks (2,000 sections +
  a 30,000-item list tested). **Challenged** R5 H2 (split a colon-introduced
  list item by item when the whole list does not fit): that is the split code
  R2 rated HIGH — an introduction shown without its conditions. The safe side
  holds; the stalled section is counted in the coverage line.
