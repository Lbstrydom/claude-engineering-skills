# docs/ — layout & conventions

This directory has four buckets. Put a new doc in the right one so
`docs/` doesn't drift into a dumping ground.

## `docs/` (root) — living reference

Long-lived reference docs and generated artefacts. **Not** plans — these
describe how the system *is*, not work to be done.

| File | Source | Notes |
|------|--------|-------|
| `SKILLS-INDEX.md` | generated — `npm run skills:index` | one-line summary of every skill |
| `architecture-map.md` | generated — `npm run arch:render` | symbol index, Mermaid + Markdown |
| `architecture-intent.md` | generated (from `architecture-intent.template.md`) | C4-style intent doc |
| `requirements-map.md` | generated — rendered from `.requirements/ledger.json` | human-readable invariant map |
| `security-strategy.md` | hand-curated | security incident memory; seeded by `/security-strategy bootstrap` |
| `skill-reference-format.md` | hand-written | spec for skill reference-file frontmatter |

Don't hand-edit the generated files — re-run the command instead.

## `docs/plans/` — in-flight plans

Plans produced by `/plan` for work **not yet shipped**. Transient: a plan
moves out once its feature ships. This folder is normally empty or small.
One file = one plan, `# Plan: …` header with a `Status:` line.

## `docs/completed/` — plan archive

Where `/ship` moves a plan once its `Status:` is `Complete`. Also holds
each plan's paired `*-audit-summary.md` (the `/audit-code` convergence
record) — kept next to its plan on purpose so the pair sorts adjacently.
This folder is an archive; it's expected to grow unbounded.

## `docs/audit/shared-references/` — shared skill references

Reference material shared across audit skills (`gemini-gate.md`,
`ledger-format.md`). Loaded on demand, not part of any single SKILL.md.

---

**Rule of thumb**: is it a unit of work with a `Status:`? → `plans/` (then
`completed/`). Is it a generated artefact or long-lived reference? → root.
Is it shared skill content? → `audit/shared-references/`.
