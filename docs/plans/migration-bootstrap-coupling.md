# Plan: Migration ↔ compat-bootstrap coupling — assert the surface, don't relocate the DDL

- **Date**: 2026-07-19
- **Status**: Complete (2026-07-19) — implemented; §5 questions settled empirically, and Q2 resolved to an option the plan had not considered
- **Author**: Claude + Louis
- **Scope**: backend
- **Origin**: raised as HIGH/MEDIUM in **three consecutive `/audit-code` runs**
  (2026-07-19 WS-C2, E1, and the WS-package cycle), each time deferred as
  pre-existing-and-independent under the impact test, each time with a note that
  it deserved its own plan. This is that plan.

---

## 1. The finding, and why its recommendation is wrong

The audit's phrasing, consistent across all three runs:

> A versioned Supabase migration depends on a SQL artifact in the
> application-side stores area (`scripts/lib/db/compat-bootstrap.sql`).
> Migrations must be self-contained, ordered database history. **Recommendation:
> move the compatibility DDL into the migration history itself.**

**The diagnosis is half right. The recommendation would break the repo.**

`compat-bootstrap.sql` supplies the *Supabase-specific surface* that the
audit-loop migrations reference and vanilla Postgres lacks: the `auth` schema, a
stub `auth.users(id uuid)` FK target, `auth.uid()` returning NULL, the
`anon`/`authenticated`/`service_role` roles, and the `pgcrypto`/`pg_trgm`/`vector`
extensions.

It is **deliberately conditional**. `setup-postgres.mjs:597` calls
`isSupabaseManaged(pool)` (`:226`), which checks whether the `auth` schema is
owned by `supabase_admin`/`supabase_auth_admin`, and **skips the bootstrap
entirely on a Supabase-hosted database** — because there the platform owns that
surface. Moving those statements into the migration sequence would run them on
managed Supabase too, where creating a stub `auth.users` or a NULL-returning
`auth.uid()` either fails or clobbers the platform's own. The bootstrap sits
outside the ledger *precisely because* its correct behaviour differs by target,
which is the one thing an immutable ordered history cannot express.

So: **do not relocate the DDL.** Reject that branch explicitly, and record why,
so a fourth audit raising the same finding can be answered from here.

## 2. Measured (2026-07-19) — the dependency is real and large

| Fact | Value |
|---|---|
| Migrations referencing the Supabase auth surface | **35 of 73** |
| `TO anon` grants | 14 |
| `auth.uid()` calls | 11 |
| `auth.users` references | 10 |
| `TO service_role` / `TO authenticated` | 3 / 1 |
| `CREATE EXTENSION` (pg_trgm, vector) | 3 |
| Migrations that literally reference `compat-bootstrap.sql` | **0** — the edge is inferred, never textual |
| Code recording that the bootstrap ran | **none** — `grep bootstrapApplied` → 0 hits |

Two things follow. The coupling is **not** a stray edge in one migration — it is
~48% of the history depending on a prerequisite. And nothing anywhere records or
verifies that the prerequisite was satisfied.

## 3. The actual defect (narrower than the finding, and different)

Not "the DDL is in the wrong place". The defect is:

> **The migration sequence has an unstated, unverified environmental
> precondition.** `setup-postgres --migrate` happens to satisfy it. Any other
> path to the same migrations — `supabase db push`, a psql loop, a CI job, a
> consumer following a runbook — does not, and the failure is *late and partial*:
> migrations apply in order until the first one touching `auth.*`, leaving a
> half-migrated database whose ledger says fewer rows than the schema has.

The auditor's stated risk ("fresh provisioning, CI runs, rollback/replay can
produce different schemas or fail depending on whether the bootstrap has run") is
**correct**. Its proposed fix is not.

## 4. Design — assert the SURFACE, not the provenance

The smallest structurally-honest fix is a **preflight assertion on the required
surface**, run before the first migration, that does not care *how* the surface
came to exist:

- On managed Supabase, the platform provides it → assertion passes, bootstrap
  correctly skipped.
- On self-hosted, the bootstrap provides it → assertion passes.
- On any other path where nobody provided it → **fails immediately, before
  migration 1**, with a message naming the missing objects and the command that
  supplies them.

This is the honest reading of "self-contained": the sequence declares and checks
its own preconditions instead of assuming a sibling script ran. It also
generalises — a future migration needing a new extension adds it to the
assertion, and every provisioning path inherits the check.

**Why not the alternatives** (recorded so they are not re-proposed):

| Branch | Rejected because |
|---|---|
| Move the DDL into migrations (the audit's recommendation) | Runs stub-auth DDL on managed Supabase, where it fails or clobbers the platform's own objects. The conditionality is the whole point. |
| A `bootstrapApplied` ledger row | Records *provenance*, not *state*. It would pass on a DB where the bootstrap ran and was later partially dropped, and fail on a managed Supabase that never needed it — precisely inverted. |
| Make every migration defensively `IF NOT EXISTS` its own auth surface | 35 migrations × repeated conditional DDL; and the managed-Supabase clobber risk returns, distributed. |

## 5. Open questions to settle before implementation

1. **Where does the assertion live?** A `--preflight`-adjacent function in
   `scripts/setup-postgres.mjs` is the obvious home, but the value is highest if it also
   guards paths that *bypass* that script — which by definition it cannot. Decide
   honestly whether this closes the whole hole or only the supported path, and
   say which in the doc rather than implying the former.
2. **Is the assertion list derived or hand-maintained?** Deriving it by scanning
   `supabase/migrations/*.sql` for `auth.*` / `TO <role>` / `CREATE EXTENSION`
   keeps it honest as migrations are added; hand-maintaining it is simpler but
   rots. Prefer derived **only if** the scan is exact enough not to produce false
   preconditions — measure before choosing.
3. **What does `--adopt` do here?** It seeds the ledger without replaying. If the
   surface is missing on an adopted DB, the assertion should still fire.

## 5b. Questions settled (2026-07-19) — Q2's answer was neither option offered

**Q2 — derived or hand-maintained? NEITHER. Derived from the BOOTSTRAP.**
The plan offered "scan the migrations" vs "hand-maintain a list" and said measure
first. Measuring killed the first outright: scanning `supabase/migrations/*.sql`
for `TO <role>` matched **70+ English words** out of SQL comment prose — `TO the`,
`TO avoid`, `TO make` — against only 3 real roles, and *simultaneously* **missed
`pgcrypto`**, which no migration declares because the bootstrap creates it.
Over-inclusive and under-inclusive at once.

Parsing `compat-bootstrap.sql` instead yields exactly the documented inventory
with zero noise — 1 schema, 3 roles, 3 extensions, `auth.uid()`, `auth.users` —
and cannot rot, because the bootstrap *is* the definition of this surface: if it
gains an object, the precondition gains it in the same edit. Both measurements are
encoded as tests (`tests/setup-postgres-surface-precondition.test.mjs`) so the rejected
option stays evidence-backed rather than becoming folklore.

**Q1 — where does it live, and what does it NOT cover?** In `scripts/setup-postgres.mjs`,
run in **both** `--migrate` and `--adopt` before any migration or ledger write.
Stated plainly rather than implied: **it guards the supported path only.** A route
that bypasses this script — `supabase db push`, a psql loop — never calls it, so
it cannot be guarded from here. What it does buy is converting a late, partial
failure into an immediate named one for everyone who uses the script.

Worth noting what it turned out to catch on `--migrate`: since the bootstrap runs
first on self-hosted, the assertion there verifies **the bootstrap actually
worked** — the repo's own "a migration that reports success without the schema
existing" guard, now mechanical rather than assumed.

**Q3 — `--adopt`?** It fires there too, and that is the path where it bites
hardest: adopt seeds the ledger *without replaying*, so a missing surface would
record 74 files as applied against a database that cannot support them, with the
discrepancy surfacing later on the first query touching `auth.*`. Verified on the
disposable container: `--adopt` against a DB with the `auth` schema removed exits
1 naming `schema "auth"`, before any ledger write.

**Verification** — both directions, disposable container only, never `AUDIT_DB_URL`:
- bootstrapped DB → `✓ required surface present (1 schema, 3 roles, 3 extensions)`, migrate proceeds
- surface removed → `--adopt` exits **1** with the missing object named and the fix command
- comment-stripping mutation-tested (removing it fails the test)
- `npm run check` 7926 pass / 0 fail; live `--check-drift` 74/74, no drift

## 6. Acceptance

- A fresh **self-hosted** Postgres with no bootstrap applied **fails preflight
  with a named missing-object list**, before any migration runs — verified
  against the disposable container, not argued.
- A fresh self-hosted Postgres *with* the bootstrap migrates cleanly (73/73), and
  a managed-Supabase profile is unaffected (bootstrap still skipped).
- The half-migrated failure mode is demonstrated **before** the fix (to prove the
  test is not vacuous) and gone after — the mutation-test discipline this repo
  now applies to every gate.
- `docs/runbooks/postgres-parity.md` states the precondition explicitly.
- This document's §1 rejection is linked from wherever the finding recurs, so a
  fourth audit is answered rather than re-litigated.

## 7. Explicitly out of scope

The other recurring `[Architecture]` domain-map findings deferred alongside this
one — `prompt-seeds.mjs` brainstorm→requirements, dashboard/install→plan-status,
and `check-plan-status.mjs` placement. They share only the "recurring architecture
finding" label, not a root cause, and folding them in would repeat the
scope-creep this repo's doctrine warns against.
