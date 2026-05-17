# `.requirements/` — the de-facto requirements ledger

A **materialized view** of the codebase's de-facto requirements
(behavioural / safety / security / correctness / persistence invariants).
Generated + reconciled by `scripts/requirements.mjs`; do not hand-edit the
generated files. Plan: [`docs/plans/requirements-layer.md`](../docs/plans/requirements-layer.md).

| File | Origin | Purpose |
|---|---|---|
| `candidates.json` | generated (`requirements extract`) | raw 2×-merged extraction output |
| `gaps.json` | generated (`requirements extract`) | gap-challenge assessments |
| `ledger.json` | generated (`requirements reconcile`) | the reconciled requirements at every status (`active`, `needs-review`, `inferred-only`, `superseded`) — the single source of truth; the index is derived from it in-memory. Only `active` requirements enter the enforced `/audit-code` rubric |
| `overrides.json` | **hand-curated** | per-id `accept` / `reject` / edited `assertion` — the human's deltas-only refine surface |

> The three generated files are **runtime-produced and intentionally absent
> from a fresh checkout** — they appear on the first `extract` / `reconcile`.
> A repo with no `ledger.json` is the expected initial state; `/audit-code`
> simply runs without a requirements rubric until one is generated.

Workflow:

```bash
node scripts/requirements.mjs extract --files <a,b,...>   # → candidates.json + gaps.json
# (optionally edit .requirements/overrides.json to accept/reject/edit)
node scripts/requirements.mjs reconcile                   # → ledger.json
node scripts/requirements.mjs index                       # print the active index
```

Requirements are surfaced to `/audit-code` as an invariant rubric via
`scripts/lib/requirements/context.mjs`.
