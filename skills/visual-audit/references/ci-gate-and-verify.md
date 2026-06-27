---
summary: Drift-only changed-surface gate, the `ChangedScopeResolver` rules, capture-honesty, exit codes.
---

# CI gate & verify

The gate is **drift-only on the changed contracted surface** — it never blocks on
the whole app's visual state, only on a gate-eligible finding whose surface the
current change actually touches.

## The canonical `ChangedScopeResolver` (one source of truth)

`scripts/lib/visual/changed-scope.mjs::resolveChangedScope` is the single gate
contract. A gate-eligible finding blocks iff:

- **(a)** its `surfaceId`'s `sourceGlobs` ∩ `changedPaths` ≠ ∅, OR
- **(b)** `contractChanged` and the finding's surface is among the changed surfaces, OR
- **(c)** the finding's property family is served by a **changed token source** (the
  token global-blast-radius case), OR
- **(d)** `changedPaths` ∩ `globalStyleGlobs` ≠ ∅ — a global stylesheet / shared-`ui`
  component edit cascades into surfaces it doesn't textually live in ("scope by
  impact, not authorship").

No merge-base (`changedPaths == null`) → **empty** (never false-block). `--scope full`
under `--gate` passes an explicit **`allSurfaces`** sentinel — distinct from
`changedPaths == null` — so it gates **every** gate-eligible finding on a declared
surface (then the baseline ratchet filters it). The two were once conflated, which
made `--gate --scope full` silently evaluate nothing; they are now separate.

## Novelty baseline (the accepted-findings ratchet)

Visual findings are **absolute** (this value is off-scale), not relative-to-a-base
like nav's regressions — so a changed-surface gate would otherwise block on every
pre-existing defensible finding (off-scale type, alpha-derived colors). The committed
**`visual-audit-baseline.json`** is the ratchet: `--gate` blocks only on gate-eligible
changed-surface findings whose `divergenceKey` (`class:surfaceId:nodeKey:property`)
is **not** in the baseline.

- **Adopt a blocking gate on a noisy app**: `visual-audit --verify <url> --update-baseline`
  snapshots all current gate-eligible findings as accepted; thereafter `--gate` fires
  only on NEW findings. Commit the baseline.
- **No baseline file** → `--gate` blocks on ALL changed-surface findings (backward
  compatible) and prints a hint to create one.
- A finding that's fixed simply stops appearing; a finding that's newly introduced
  isn't in the baseline → blocks. Re-run `--update-baseline` to re-accept after a
  deliberate, reviewed change.

## Capture honesty (degrade, never false-fire)

- A declared surface that is absent OR **present-but-empty** (a CSR skeleton that never
  hydrated) is marked **`unverified`** — the scorecard shows 🟡 and no authoritative
  finding fires for it.
- A gradient/image/unresolvable backdrop → contrast is `unverified`, not `contrast_failure`.
- CDP unavailable → the signifier tier degrades to `unverified`, never crashes.
- `nodeBudget`/`interactiveBudget` exceeded → `unverified_due_to_budget` warning (no
  silent truncation).

## Determinism

Transitions/animations are frozen (`* { transition:none!important; animation:none!important }`
via `addInitScript`) before any capture, so `getComputedStyle` never reads an
interpolated mid-transition value. Two `--verify` runs of the same DOM yield the same
findings.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | clean, or advisory-only (no `--gate`, or no changed-surface blocker) |
| `1` | a gate-eligible finding survived `ChangedScopeResolver` (`--gate` only) |
| `2` | tool error (no Chromium, malformed contract, extract failure) |
| `3` | needs-bootstrap (no `visual-contract.json`) |

## Persistence

The verify-result (`.audit-loop/visual-verify-result.json`, gitignored) is keyed on the
contract digest + `VISUAL_VERIFY_TOOL_VERSION`; a contract edit or tool-version bump
invalidates a stale result. The dashboard "Visual Audit" tab reads it locally.
