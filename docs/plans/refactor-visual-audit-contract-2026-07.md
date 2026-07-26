# Plan: Visual-Audit Contract Validation Debt (2026-07-26 triage)

- **Date**: 2026-07-26
- **Status**: Draft
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). This
> cluster (8 entries) is one coherent defect: `visual-contract.json`
> read/write validation is asymmetric. Verified against current source
> 2026-07-26.

---

## The core issue

`readContract()` (`scripts/lib/visual/contract.mjs:44-53`) cross-checks
`tokenSources[].theme` against the declared `themes[]` array — but it never
validates that `surfaces[].sourceGlobs` is non-empty, and
`bootstrapContract()` (line 83) happily creates surfaces with
`sourceGlobs: []`. Meanwhile `writeContract()` (lines 107-119) only calls
`VisualContractSchema.safeParse` — no cross-field semantic check at all —
so it's possible to *persist* a contract that `readContract()` will later
reject. Six of the seven entries in this cluster (`0df0b70f`, `23bb6ea7`,
`2610ad91`, `32499d7a`, `54b9b2b0`, `f261562c`) are restatements of this one
asymmetry from different audit rounds; `20d465d7` additionally notes
`SurfaceSchema` (`scripts/lib/visual/schema.mjs:98`) has no `.min(1)` on
`sourceGlobs`, so a schema-valid contract can still have zero sources per
surface.

**Fix** (single change closes all 7): extract the cross-field checks
`readContract()` already does (theme membership, and the missing
`sourceGlobs` non-emptiness check) into one `validateContractSemantics(contract)`
function, and call it from *both* `readContract()` and `writeContract()` —
so a contract that fails semantic validation can never be written in the
first place, rather than being caught only on next read. Add `.min(1)` to
`SurfaceSchema.sourceGlobs` as a first line of defense at the schema level
too.

## Related: `visual/drift.mjs`

`fa6e120c` — `ageDivergences` checks `Number.isFinite(head)` but never
validates `Date.parse(firstSeen)`, so a malformed `firstSeen` timestamp
produces `ageDays = NaN` silently. Same "can this fail without looking like
it failed" class as the visual-audit skill's own documented empirical-verify
doctrine (AGENTS.md's pre-ship-empirical-verify section names this exact
failure mode).

---

## Full entry table


**`scripts/lib/visual/contract.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `0df0b70f` | HIGH | visual/contract.mjs:44-53 readContract only checks tokenSources theme, never surfaces sourceGlobs |
| `20d465d7` | MEDIUM | visual/contract.mjs:44-53 + schema.mjs:98 no min(1) on sourceGlobs |
| `23bb6ea7` | HIGH | visual/contract.mjs:107-119 writeContract no cross-field theme check |
| `2610ad91` | HIGH | visual/contract.mjs read/write asymmetry duplicate |
| `32499d7a` | HIGH | visual/contract.mjs read/write asymmetry duplicate |
| `54b9b2b0` | MEDIUM | visual/contract.mjs read/write asymmetry duplicate |
| `f261562c` | MEDIUM | visual/contract.mjs read/write asymmetry duplicate |

**`scripts/lib/visual/drift.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `fa6e120c` | MEDIUM | visual/drift.mjs:44-49 no Date.parse validation on firstSeen |

## Rollback

Additive validation only — a stricter `writeContract()` could reject
previously-accepted (and previously-silently-broken) contracts, so run
`npm run visual-audit -- --verify <one known-good deployed url>` after the
change to confirm no false rejection of the committed `visual-contract.json`.
