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

Two equivalent paths — pick the one that matches your access:

### Path A — Maintainer with Supabase credentials (no Docker needed)

```bash
# 1. Create a dedicated fixture sandbox project (free tier is fine).
supabase projects create postgres-parity-fixtures --org-id <your-org>

# 2. Link + apply the audit-loop migrations to the sandbox.
supabase link --project-ref <ref-from-step-1>
supabase db push   # applies supabase/migrations/*.sql

# 3. Read the anon + service-role keys from the dashboard
#    (Project Settings → API). Export as env vars:
export SUPABASE_LOCAL_URL=https://<ref>.supabase.co
export SUPABASE_LOCAL_ANON_KEY=...
export SUPABASE_LOCAL_SERVICE_ROLE_KEY=...

# 4. Record.
node scripts/postgres-parity/record-golden-fixtures.mjs \
  --legacy tests/fixtures/learning-store.legacy.mjs \
  --supabase-url "$SUPABASE_LOCAL_URL" \
  --anon-key "$SUPABASE_LOCAL_ANON_KEY" \
  --service-role-key "$SUPABASE_LOCAL_SERVICE_ROLE_KEY" \
  --out tests/fixtures/contract/

# 5. Commit + (optional) tear the sandbox project down.
git add tests/fixtures/contract/*.json
supabase projects delete <ref>   # cleanup; keep it long-term if you re-record often
```

> **The recorder's `assertLocalOnly()` will refuse a `*.supabase.co` URL**
> for safety. To target a sandbox Supabase project, either temporarily relax
> that guard with a `--allow-remote <project-ref>` flag we add when this
> path is first exercised, or run the recorder behind a forwarding proxy at
> `127.0.0.1:<port>`. Today the recorder is wired only for path B; path A
> needs the small `--allow-remote` extension before it's actually usable.

### Path B — No Supabase credentials → local Docker stack

```bash
# 1. Bring up the local Supabase stack (Docker required).
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
