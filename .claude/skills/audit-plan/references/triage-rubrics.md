---
summary: Step 3 rubrics in full — impact-test detail, grounding, test-premise lint, and the §11 execution-clustering checks.
---

# Triage rubrics — full text

Step 3 of `SKILL.md` keeps the triage table, the rules and a one-line form of each
rubric below. This file holds the complete rubrics. Read the section you need when
its condition applies.

## Same-module independence (impact test, detail)

**Same-module independence needs more than "the plan doesn't propose editing
that section" (measured 2026-09-25 in the sibling `/audit-code` invariant —
same failure mode applies here).** A finding about a module/section the
plan's own design already extends is not independent merely because the plan
doesn't touch that section's *text*. When the cited concern is about a
module/table the plan's new design reads or writes, the independence
sentence needs the same two-part answer `/audit-code` Step 3 requires,
reframed for a not-yet-built design: does the plan's new design read/write
the SAME column(s) or depend on the SAME constraint the cited concern
describes (not merely the same table), and does it execute inside the SAME
transaction instance (not merely the same request or subsystem)? If either
is true, fold the resolution into the plan rather than deferring it.

## Grounding rubric (is the plan traced to real code?)

The whole plan file is in context — no new machinery. Check that **§1's Code
Trace** evidences Phase 1 actually happened: on a **non-trivial** plan (§7b
Gate-1 class — ≥6 files, ≥2 subsystems, a dependency chain, or >1 sitting),
the Context Summary must cite concrete `file_path:line` refs and a call path,
not a hand-waved "the codebase does X." An **absent, empty, or generic** Code
Trace on a non-trivial plan is a **HIGH finding** — `ungrounded-plan` — because
every downstream claim about "what exists today" is then unverified, and the
falsehood won't surface until code-audit runs against an implementation (far
too late). Where a "what exists today" assertion drives a design decision,
spot-check that the cited path plausibly supports it; a design built on a
mis-described existing contract is HIGH regardless of trace presence. **An
unpinned `file:line` in the trace is a LOW finding, not a pass**: it resolves
today and decays into a wrong-but-resolving reference by the time anyone
re-checks it, and the spot-check above is exactly the re-check that will land on
the wrong content. Ask for `path:line (sha)`.
→ `verification-discipline.md` §1 (this directory). Trivial
single-file plans are exempt (a bare `Code Trace: <file>` is fine).

## Test-premise lint (#6 — GREEN ≠ REALIZED)

A plan assertion of the form
"tests already cover X" / "the default path resolves Y" / "this is already
exercised" is a **build-time spike**, NOT evidence, unless an **executed
command + its result** is attached (e.g. `npm test -- foo` → `12 passing`).
Flag the bare claim — it reads as green but nothing was run; the gap surfaces
only when the code audit runs the command for real. Likewise a **discovery-freeze
sub-step** that NAMES a source/feed/field must also **prove its semantics match
the contract** (units, scope, filter, freshness) — "name the field → prove the
field means what the design assumes." Naming a source is not proving it.

## Execution-clustering rubric (when the plan has a §11 block)

The whole plan file is already in the GPT/Gemini context, so no new
machinery — but **deliberately scrutinize the §11 Execution Clustering
boundaries**, because `/cycle` executes them and a bad boundary makes it
build on un-audited coupled code. Check: (a) **partition** — every §7b
implementation phase in exactly one cluster, none omitted/duplicated,
close-out correctly outside the phase set; (b) **coupling soundness** —
grouped phases share a real seam; split phases are genuinely independent;
(c) **fix-gate placement** — `fix-gate: yes` before every cluster that
depends on a prior cluster's output; (d) **ordering** — clusters are
contiguous ascending ranges (valid topological order); (e) **derived
scope** — each cluster's scope resolves from member phases' `Files:`
(+ tagged `Additional files:`); flag any free-standing per-cluster `Files:`
line as a second source of truth. A malformed block is a HIGH finding when
it would cause `/cycle` to build on un-audited coupled code. (`/cycle` also
re-validates fail-closed at execution time — this is the first of two
layers.) The optional `author-tier:` sub-bullet is **advisory/observation-only**
(`/cycle` records it, never routes on it) — do NOT treat its presence, absence,
or value as a gate or a finding; a wrong tier hint has zero execution impact.
