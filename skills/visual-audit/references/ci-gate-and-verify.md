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

No merge-base (`changedPaths == null`) → `scopeToChanged` returns **empty** (never
false-*block*). But under `--gate --scope diff` the orchestrator never reaches that
path: a no-merge-base run is UNVERIFIED → **exit 2** (see *Gate honesty* below), not a
silent exit-0 pass. `--scope full`
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

### Gate honesty — a green gate must mean something was checked

The gate refuses to report a clean pass when it didn't actually evaluate anything
(the "looks-protected-but-isn't" class). Hard guards:

- **Static `--gate` / `--update-baseline`** (no `--verify`) → **exit 2**. Static mode
  emits no paint findings, so gating would pass without checking and a baseline would
  be empty.
- **No surfaces declared** in the contract under `--gate` → **exit 2** (UNVERIFIED).
  A gate over an empty contract checks nothing; add surfaces or drop `--gate`.
- **All contracted surfaces unverifiable** (page loaded but every surface stalled/
  empty) under `--gate` → **exit 2** (UNVERIFIED). `--update-baseline` on the same
  refuses to write (won't snapshot a degraded capture).
- **Some surfaces unverifiable** (partial) → loud warning; the gate covers only the
  verified surfaces (never silent).
- **No merge-base** under `--gate --scope diff` (shallow checkout / detached HEAD) →
  **exit 2** (UNVERIFIED): the gate has no changed-set to evaluate, so it cannot
  report a clean pass; use `--scope full` or a full-history checkout. (Previously a
  warn-then-exit-0 — the silent false-green this guard closes.)
- **Zero states captured** (dead server) → exit 2 (above).
- **Partial capture matrix** (a device×theme cell failed — e.g. the dark capture
  timed out while light succeeded) → each missing cell is a structured
  `missingStates` entry + a per-cell warning in the verify result; the theme-pair
  tiers for that device degrade to the captured subset (warned, never silent).
  **Under `--gate` → exit 2** — a blocking gate must not claim a matrix it didn't
  capture.
- **Theme-apply integrity**: a `class`/`attribute` theme whose apply target matches
  nothing is surfaced as a warning (the state's parity evidence is suspect) — a
  silently-unflipped theme would fabricate parity evidence.
- **`--themes` with an unknown name** → **exit 2** (the contract theme list is the
  single source of truth; a silent drop would capture a different matrix than
  requested).

### Theme-safety v2 — `--full-dom` (opt-in, advisory, default-off)

`--verify <url> --full-dom [--full-dom-node-budget <n>]` adds the **full-DOM contrast
parity-delta sweep** (`contrast_parity_delta`, report-only — see
`finding-taxonomy.md`). Design invariants:

- **Verify-only**: `--full-dom` without `--verify` → **exit 2** (a silent no-op would
  read as "full-DOM ran, found nothing").
- **Node isolation (never gates)**: full-DOM nodes carry `scope:'fullDom'` and are
  consumed ONLY by the parity-delta producer; every gate-eligible producer sees
  `scope:'contracted'` nodes only. The two sets are disjoint by construction, so the
  sweep can never gate, and the absolute `contrast_failure` stays contracted-only.
- **Default-off = no behaviour change**: with the flag off, zero `fullDom` nodes are
  captured, the delta is inert, and raw capture output is byte-unchanged (the `scope`
  tag is stamped by a **cloning** assembly normalizer, never onto raw capture).
- **Bounded traversal**: an incremental `TreeWalker` (not `querySelectorAll('*')`),
  pruning already-captured contracted subtrees whole (`FILTER_REJECT` on a
  page-mutation-free `WeakSet`); the budget bounds **emitted text candidates**
  (default 4000; visit ceiling 25×) so empty wrappers don't consume it; clipping sets
  `captureStats.truncated` + a warning. Known limit: `TreeWalker` does not pierce
  shadow roots.
- **Coverage honesty** (all machine-readable in the verify result): requested sweep
  that emitted nothing despite candidates → `unverified(fulldom_capture_empty)`;
  contract must declare exactly 2 distinct themes → else
  `unverified(unsupported_theme_count)`; all joins ambiguous →
  `unverified(all_candidates_ambiguous)`; candidates on both sides but zero
  cross-theme `livePath` joins (structural divergence between themes) →
  `unverified(no_joinable_candidates)`. Never a silent clean.
- **Gate-promotion trigger** (named, not yet done): after one real field run
  confirms an acceptable FP rate AND the empty-capture degrade is proven live,
  promotion is a one-line `GATE_ELIGIBLE_CLASSES` add (drift-only scoping applies
  automatically).

> The no-surfaces / no-merge-base / all-unverifiable cases share one pure decision
> point — `gateUnverifiedReason()` in `scripts/lib/visual/drift.mjs` (tested in
> `tests/visual-drift.test.mjs`) — so the "a green gate evaluated something" contract
> can't silently regress at the exit seam again.

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
