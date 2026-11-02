---
summary: Duplication wave (Wave 5) — what it scans, the @duplicate-justification pragma, test-dir and orphan rules.
---

# Duplication wave (Wave 5, automatic)

Alongside the 5 core passes, `/audit-code` always attempts a mechanical
**duplication** check: for each new/changed symbol in the diff, it queries
the architectural-memory index (read-only — never mutates it) for a
near-duplicate already indexed elsewhere. A genuine match becomes a
`[Duplication] Near-duplicate of existing symbol` finding that gates
convergence exactly like a `quickfix` finding does (reusing `is_quick_fix`).
Detection is pure Git (diffs the symbol against its base-revision content),
not the Postgres snapshot — so it's unaffected by a stale `arch:refresh`.
**Scope**: symbol extraction only covers JS/TS-family files
(`.js .jsx .mjs .cjs .ts .tsx`, ts-morph's parser) — a changed file in
another language isn't scanned and doesn't produce a "clean" verdict for
that file specifically; it's simply outside this wave's coverage today
(round-1 code-audit M8: an earlier draft overclaimed multi-language scanning).

## Suppressing an intentional duplicate

If the duplication is intentional (e.g. a CLI script deliberately staying
self-contained rather than taking a cross-module dependency), suppress it
in place with a pragma immediately above the declaration:

```js
// @duplicate-justification: target=scripts/lib/nav/schema.mjs:sha256 reason=nav-audit and visual-audit are deliberately independent sister lenses (AGENTS.md), not accidental duplication
```

The pragma's own MATCHING logic recognizes any comment syntax (`//`, `#`,
`/* */`, `<!-- -->`), for when JS/TS-family extraction eventually widens —
today it only ever fires on the JS/TS files the detector actually scans.

**A pragma under `tests/` is not read.** The repo-wide sweep excludes
`*.md` and `tests/*`, so put the pragma on the declarations OUTSIDE
`tests/`. For a cluster that spans both, that is enough: a cluster stops
being reported once fewer than two of its files remain unjustified, so
justifying the non-test members clears it. Reported by a consumer
2026-09-04, who had to derive both facts from the migration SQL.
A pragma whose `target` doesn't actually match the detected near-duplicate
surfaces its own `[Duplication] Orphaned suppression pragma` finding
rather than being silently honoured or ignored.

## Opting out

Opt out for a single run with `--passes <csv>` omitting `duplication`. No `.env`
var needed; it degrades to a silent, non-blocking `unavailable` state when the
architectural-memory store isn't configured for this repo.

Plan: `docs/plans/audit-code-duplication-wave.md`.
