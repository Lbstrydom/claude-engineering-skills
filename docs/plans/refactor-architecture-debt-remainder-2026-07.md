# Plan: Architecture-Debt Backlog Remainder (2026-07-26 triage)

- **Date**: 2026-07-26
- **Status**: Draft
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend (mechanical, no product behavior change)

> Origin: full `.audit/tech-debt.json` backlog triage (384 open entries). Of
> the 183 `[Architecture]` entries, 173 were resolved as either already
> declared/retagged in `.audit-loop/domain-map.json` or already tracked as
> accepted debt in that file's own `_comment_allowedDeps` /
> `_adjudication_2026_07_20` blocks (see resolution events, run-ids
> `debt-triage-2026-07-26-fixed` / `-consolidate`). This plan scopes the
> remaining **3 genuinely still-open** issues, each real and independently
> verified against current source on 2026-07-26.

---

## 1. Dashboard collector imports a root CLI script (layering inversion)

**Debt entries**: `7cd98d98`, `dafaf6c8`, `1f6dd42d`

`scripts/lib/dashboard/collect-reference.mjs:15` imports `loadAllSkills` from
`../../skills-help.mjs` — a top-level CLI entrypoint, not a library module.
This reverses the CLI → library layering every other dashboard collector
follows (they read from producer *modules*, not executable scripts).

**Fix**: extract `loadAllSkills` (and any other collector-relevant exports)
out of `scripts/skills-help.mjs` into a neutral module (e.g.
`scripts/lib/skill-refs-parser.mjs`, which already exists and is
skills-content-adjacent) or a new `scripts/lib/skills-index.mjs`. Have both
`skills-help.mjs` and `collect-reference.mjs` import from there.

**Effort**: EASY — one function move + two import updates + re-run
`npm test` for `tests/` coverage of both call sites.

**Risk**: low. No behavior change if the extracted function is a pure read.

---

## 2. `stores` domain imports `arch-memory`'s `observed-deps.mjs` (undeclared)

**Debt entry**: `bfb06662`

`scripts/lib/store/arch/coverage.mjs:23` imports `CoverageSchema` from
`scripts/lib/observed-deps.mjs` (arch-memory domain). This edge is real and
current (confirmed via direct grep and via `domain-deps-observed.json`, which
already carries `stores → arch-memory` in its *observed* — but not
*allowed* — graph). It is distinct from the three edges domain-map.json
already records as accepted debt (that list is shared-lib- and
cross-skill-bridge-rooted; this is stores-rooted and undeclared, not merely
unendorsed).

**Fix options** (pick one, don't do both):
- (a) Move `CoverageSchema` to a neutral contracts module (e.g.
  `scripts/lib/schemas.mjs` or a new `scripts/lib/observed-deps-contracts.mjs`
  that both `stores/arch/coverage.mjs` and `observed-deps.mjs` import from) —
  removes the edge entirely.
- (b) If the coupling is intentional (coverage persistence needs to validate
  against the exact shape arch-memory produces), declare `stores -> arch-memory`
  in `.audit-loop/domain-map.json` allowedDeps with a `_why` note, mirroring
  the existing `_adjudication_2026_07_20` style.

**Recommendation**: (a) — a schema is a data contract, not arch-memory
implementation; moving it removes the smell instead of just declaring it.

**Effort**: EASY–MEDIUM depending on how many other files import
`CoverageSchema` from `observed-deps.mjs` today (check before moving).

---

## 3. `docs/architecture-intent.md` is stale relative to `domain-map.json`

**Debt entries**: `01c442ec`, `0dda0192`, `2181558f`, `68e1845c`, `aa7172a9`, `e50c245b`

`docs/architecture-intent.md` is v0.1.0, last reviewed 2026-05-11. It
enumerates ~13 domains and hand-written boundary rationale. The live
`.audit-loop/domain-map.json` (which the doc's own intro calls the
enforcement counterpart) now has ~34 domains and 70 rules, including
`dashboard`, `nav-audit`, `visual-audit`, `persona-test`, `ux-lock`,
`model-eval`, `requirements`, `solo-control`, `arm-eval`, `memory-health`,
`security`, `fit-check`, `gate-honesty`, `claudemd-management`, and
`friction` — none of which appear in the doc. The doc's "Known
known-violations (debt)" section is also still empty, despite
`domain-map.json` now carrying two dated adjudication blocks of real,
named debt.

**Fix**: refresh `docs/architecture-intent.md` — regenerate the C4 container
diagram and domain list from current `domain-map.json` rules/allowedDeps,
and either (a) populate "Known known-violations" from
`_comment_allowedDeps`/`_adjudication_2026_07_20`, or (b) replace that
section with a pointer to `domain-map.json` as the single source of truth
for current debt, keeping this doc as historical rationale only.

**Effort**: MEDIUM — mostly content work, no code risk. Best done by someone
with full context on the ~20 newer domains' intent, not mechanically.

---

## Rollback

All three are additive/refactor-only; revert the relevant commit(s) if a
regression surfaces. No schema/data migrations involved.
