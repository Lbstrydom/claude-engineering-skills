# `tests/fixtures/contract/`

Golden contract fixtures for the postgres-parity contract suite (plan
§9 "Golden-fixture contract model"). One JSON file per row in
[`docs/plans/postgres-parity-contract-matrix.md`](../../../docs/plans/postgres-parity-contract-matrix.md).

## What these are

Per-function `(input, return, table mutations)` snapshots recorded by
running the FROZEN legacy supabase-js path
([`tests/fixtures/learning-store.legacy.mjs`](../learning-store.legacy.mjs))
against a **local `supabase start` Docker stack** — never the production
project. The CI contract suite (added in M4) drives the NEW `pg`-driver
path against postgres+pgvector and diffs every function against the
committed fixture; any drift fails the build.

This is the **R1 mitigation** the plan §8 calls out — the entire P3
live-path rewrite gates on the contract suite being green.

## How to (re)record

```bash
# 1. Bring up the local Supabase stack.
supabase start

# 2. Pull the anon + service-role keys.
SUPABASE_LOCAL_ANON_KEY=$(supabase status -o env | sed -nE 's/^ANON_KEY=(.+)/\1/p')
SUPABASE_LOCAL_SERVICE_ROLE_KEY=$(supabase status -o env | sed -nE 's/^SERVICE_ROLE_KEY=(.+)/\1/p')

# 3. Record.
node scripts/postgres-parity/record-golden-fixtures.mjs \
  --legacy tests/fixtures/learning-store.legacy.mjs \
  --supabase-url http://127.0.0.1:54321 \
  --anon-key "$SUPABASE_LOCAL_ANON_KEY" \
  --service-role-key "$SUPABASE_LOCAL_SERVICE_ROLE_KEY" \
  --out tests/fixtures/contract/

# 4. Commit the result.
git add tests/fixtures/contract/*.json
```

A `--only <function>` flag records a single matrix row — useful while
iterating on a per-function input factory inside the recorder.

## Why this is fixed in `git` (not generated on every CI run)

The legacy `supabase-js` path can only talk to a full Supabase stack —
PostgREST is not a plain Postgres connection. Running `supabase start`
in every CI job would multiply CI time by an order of magnitude with
no upside; the fixtures are deterministic and rarely change. They are
captured once, committed, and re-recorded only when:

- A new function is added to `scripts/learning-store.mjs` (M3 split is
  expected to preserve the 93-function surface — re-recording then is
  a forced consistency check, not an additive change).
- A migration changes a return shape (e.g. a view definition gains a
  column). The contract suite will fail first; the human then
  re-records and reviews the diff.

## Determinism rules (plan §9)

The recorder normalises non-deterministic values before writing:

| Source value | Normalised to |
|---|---|
| Server-generated UUID | `<UUID-N>` (first occurrence becomes `<UUID-0>`, second `<UUID-1>`, …) |
| `now()` / `created_at` / `updated_at` timestamps | `<TS-NOW>` |

The contract-suite comparator applies the same normalisation to live
results before deep-equal.

## NEVER do this

- **Do not** point the recorder at the production Supabase project.
  The script enforces this via `assertLocalOnly()`; the env-var-equality
  check refuses any URL matching `SUPABASE_AUDIT_URL`.
- **Do not** hand-edit a fixture to silence a contract-suite failure.
  Fixture drift is the gate's whole purpose — handle it by deciding
  whether the new shape is a bug or a deliberate breaking change.
