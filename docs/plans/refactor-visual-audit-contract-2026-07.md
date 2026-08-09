# Plan: Visual-Audit Contract Validation Debt (2026-07-26 triage)

- **Date**: 2026-07-26
- **Status**: Complete — all 8 entries closed (7 via `visual-contract-semantic-validation.md`; `fa6e120c` 2026-08-09, see Closing Note)
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). This
> cluster (8 entries) is one coherent defect: `visual-contract.json`
> read/write validation is asymmetric. Verified against current source
> 2026-07-26.

> **The `scripts/lib/visual/contract.mjs` cluster (7 entries) is IMPLEMENTED
> — discovered at rebase time by a concurrent session that independently
> picked the same cluster off the same tech-debt backlog.** See
> [visual-contract-semantic-validation.md](visual-contract-semantic-validation.md)
> — the fix shape matches this plan's proposed `validateContractSemantics()`
> extraction, with one deliberate deviation: `SurfaceSchema.sourceGlobs`
> was NOT given a schema-level `.min(1)` (this plan's second suggested line
> of defense) — the `--bootstrap` review-queue draft legitimately needs to
> persist an empty `sourceGlobs` array, and schema validation in
> `writeContract()` isn't skippable per-caller the way semantic validation
> is; a `.min(1)` would break `--bootstrap` outright. See that plan's §2
> "Why not a Zod-schema-level constraint" for the full reasoning. The
> `scripts/lib/visual/drift.mjs` entry below (`fa6e120c`) is **unrelated to
> that cluster** and was this plan's remaining scope — **CLOSED 2026-08-09**;
> see the Closing Note.

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


**`scripts/lib/visual/contract.mjs`** — RESOLVED, see the note above

| topicId | severity | evidence | status |
|---|---|---|---|
| `0df0b70f` | HIGH | visual/contract.mjs:44-53 readContract only checks tokenSources theme, never surfaces sourceGlobs | fixed |
| `20d465d7` | MEDIUM | visual/contract.mjs:44-53 + schema.mjs:98 no min(1) on sourceGlobs | fixed (semantic-layer, not schema-level — see note above) |
| `23bb6ea7` | HIGH | visual/contract.mjs:107-119 writeContract no cross-field theme check | fixed |
| `2610ad91` | HIGH | visual/contract.mjs read/write asymmetry duplicate | fixed |
| `32499d7a` | HIGH | visual/contract.mjs read/write asymmetry duplicate | fixed |
| `54b9b2b0` | MEDIUM | visual/contract.mjs read/write asymmetry duplicate | fixed |
| `f261562c` | MEDIUM | visual/contract.mjs read/write asymmetry duplicate | fixed |

**`scripts/lib/visual/drift.mjs`** — RESOLVED 2026-08-09 (and the byte-identical `nav/drift.mjs` copy the entry did not name), see Closing Note

| topicId | severity | evidence |
|---|---|---|
| `fa6e120c` | MEDIUM | visual/drift.mjs no Date.parse validation on firstSeen (also present in nav/drift.mjs) | fixed |

## Rollback

Additive validation only — a stricter `writeContract()` could reject
previously-accepted (and previously-silently-broken) contracts, so run
`npm run visual-audit -- --verify <one known-good deployed url>` after the
change to confirm no false rejection of the committed `visual-contract.json`.

---

## Closing Note (2026-08-09)

`fa6e120c` is fixed, and the fix is larger than the entry described in one
respect worth recording.

**The entry named `visual/drift.mjs`; the defect was in two files.**
`scripts/lib/nav/drift.mjs` carries a byte-identical `ageDivergences` — the two
lenses are deliberately separate modules — and it is the *nav* copy that has a
live consumer (`scripts/lib/dashboard/collect-nav.mjs` renders `ageDays` into
the drift panel). Fixing only the file the ticket named would have left the
reachable instance broken. Both are fixed.

**Two silent failures, not one.** The entry described the unparseable
`firstSeen` → `NaN` path. Tracing it surfaced a second, worse one in the same
expression: an unparseable `headCommitDate` returned **0**, reporting every
finding as brand new. `NaN` at least refuses to serialise; `0` is a plausible
value that hides the failure completely. Both now return **`null`** — unknown —
while a genuine `0` (first seen AT head) keeps meaning what it says. Same
unknown-is-not-zero rule as [`observed-graph-coverage-honesty.md`](./observed-graph-coverage-honesty.md).

**No shared helper, deliberately.** Extracting one date function across two
intentionally-separate lens modules is the over-built option for three lines,
and `nav/drift.mjs` is synced to consumer repos, so a new shared dependency
would widen the bundle for no current requirement. Instead
[`tests/visual-drift.test.mjs`](../../tests/visual-drift.test.mjs) asserts BOTH
copies agree — cheaper than the abstraction and it catches divergence directly,
which is the failure that let one ticket describe a two-file bug.

Verified against the original expression: it produced `NaN` and `0` on exactly
the inputs the new tests forbid, and `0` on the genuine same-day case the tests
require to stay `0`.

The other 7 entries were closed earlier by a concurrent session via
[`visual-contract-semantic-validation.md`](./visual-contract-semantic-validation.md);
confirmed in code — `validateContractSemantics` exists and is called from both
`readContract` and `writeContract`, which is what the read/write asymmetry
needed.
