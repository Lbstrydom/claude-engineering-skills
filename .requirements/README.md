# `.requirements/` — the de-facto requirements ledger

A **materialized view** of the codebase's de-facto requirements
(behavioural / safety / security / correctness / persistence invariants).
Generated + reconciled by `scripts/requirements.mjs`; do not hand-edit the
generated files. Plan: [`docs/plans/requirements-layer.md`](../docs/plans/requirements-layer.md).

| File | Origin | Committed? | Purpose |
|---|---|---|---|
| `candidates.json` | generated (`requirements extract`) | no — gitignored | raw 2×-merged extraction output; a transient input to `reconcile` |
| `gaps.json` | generated (`requirements extract`) | no — gitignored | gap-challenge assessments; a transient input to `reconcile` |
| `ledger.json` | generated (`requirements reconcile`) | **yes** | the reconciled requirements at every status (`active`, `needs-review`, `inferred-only`, `superseded`) — the single source of truth; the index is derived from it in-memory. Only `active` requirements enter the enforced `/audit-code` rubric. **Committed** so the rubric travels with the repo |
| `overrides.json` | **hand-curated** | **yes** (when present) | per-id `accept` / `reject` / edited `assertion` — the human's deltas-only refine surface |

> `candidates.json` + `gaps.json` are **gitignored extraction intermediates**
> — regenerable, noisy, absent from a fresh checkout; they exist only between
> `extract` and `reconcile`. `ledger.json` (and `overrides.json` when present)
> **are committed** — the ledger is the shared, diffable materialized view.
> A repo with no `ledger.json` yet simply has `/audit-code` run without a
> requirements rubric until the first `extract` → `reconcile`.

Workflow:

```bash
node scripts/requirements.mjs extract --files <a,b,...>   # → candidates.json + gaps.json
# (optionally edit .requirements/overrides.json to accept/reject/edit)
node scripts/requirements.mjs reconcile                   # → ledger.json
node scripts/requirements.mjs index                       # print the active index
```

Requirements are surfaced to `/audit-code` as an invariant rubric via
`scripts/lib/requirements/context.mjs`.
