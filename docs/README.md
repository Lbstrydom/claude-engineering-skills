# docs/ — layout & conventions

This directory has five buckets. Put a new doc in the right one so
`docs/` doesn't drift into a dumping ground.

## `docs/` (root) — living reference

Long-lived reference docs and generated artefacts. **Not** plans — these
describe how the system *is*, not work to be done.

| File | Source | Notes |
|------|--------|-------|
| `SKILLS-INDEX.md` | generated — `npm run skills:index` | one-line summary of every skill |
| `architecture-map.md` | generated — `npm run arch:render` | symbol index, Mermaid + Markdown |
| `architecture-intent.md` | generated (from `architecture-intent.template.md`) | C4-style intent doc for *this* repo |
| `architecture-intent.template.md` | hand-written | starter template a consumer repo copies + customises to produce its own `architecture-intent.md` |
| `requirements-map.md` | generated — rendered from `.requirements/ledger.json` | human-readable invariant map |
| `security-strategy.md` | hand-curated | security incident memory; seeded by `/security-strategy bootstrap` |
| `consistency-contract.md` | hand-written | persona-test consistency mode — HTML `data-*` attribute spec for consumer apps. Zod enforcement lives in `scripts/lib/persona-test/schemas.mjs` |
| `skill-reference-format.md` | hand-written | spec for skill reference-file frontmatter; enforced by `scripts/check-skill-refs.mjs` |

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

> **Note on legacy entries**: pre-`/ship` plans were bulk-moved here by
> chore commits (`f5cb283`, `190406d`) before the Status-gate existed.
> Several still have `Status: Draft` / `Audit-complete` / `In Progress`
> rather than `Complete`. A 2026-05-23 audit corrected the multi-language
> Phase A/B/C set; ~28 others remain pending review per-plan.

## `docs/audit/shared-references/` — shared skill references

Reference material shared across audit skills (`gemini-gate.md`,
`ledger-format.md`). Loaded on demand, not part of any single SKILL.md.
`scripts/sync-shared-audit-refs.mjs` keeps these byte-identical with
`skills/audit-{plan,code}/references/*.md`.

## `docs/adopter-handoff/` — consumer-app onboarding

Adoption material for consumer apps integrating persona-test consistency
mode. Distilled from the wine-cellar-app Phase 1 adoption; lets the next
adopter (ai-organiser etc.) hit the same outcome in ≤2 hours.

| File | Purpose |
|------|---------|
| `migration-playbook.md` | 10-step linear adoption guide |
| `template-surfaces.json` | minimal `surfaces.json` template |
| `template-canary.json` | minimal canary-journey template |

---

**Rule of thumb**: is it a unit of work with a `Status:`? → `plans/` (then
`completed/`). Is it a generated artefact or long-lived reference? → root.
Is it shared skill content? → `audit/shared-references/`. Is it consumer-
adoption material? → `adopter-handoff/`.
