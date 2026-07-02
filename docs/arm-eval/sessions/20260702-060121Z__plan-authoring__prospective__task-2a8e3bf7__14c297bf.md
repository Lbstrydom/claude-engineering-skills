# Arm-eval session 14c297bf-c2e5-48d6-8230-5406b832ddb6

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-2a8e3bf7` |
| Seed (presentation-order RNG) | 13 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T06:01:21.539Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

Design a schema migration to add a soft-delete column to audit_findings with a partial index

## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

# Plan: Soft-delete column on `audit_findings` with partial index

## Overview

Add a `deleted_at` timestamp column to the `audit_findings` table in the Supabase database, defaulting to `NULL` for live rows. Implement a partial index on `deleted_at` for rows where `deleted_at IS NULL` to accelerate non‑deleted lookups. Update the findings data‑access module (`scripts/lib/findings.mjs`) to automatically exclude soft‑deleted rows from all standard queries and provide a dedicated soft‑delete function. The change is backward‑compatible: existing code that does not write to `deleted_at` will continue to see only live rows.

## Design decisions

- **Column type**: `TIMESTAMP WITH TIME ZONE` (nullable). A timestamp records *when* the deletion occurred, which is more useful for audit trails than a bare boolean. `NULL` means “not deleted”.
- **Partial index definition**: `CREATE INDEX idx_audit_findings_live ON audit_findings (deleted_at) WHERE deleted_at IS NULL;`. The index is small (only rows that are not deleted) and gives fast access to the most common query pattern.
- **Default filtering**: The findings module (`scripts/lib/findings.mjs`) will always add `AND deleted_at IS NULL` to every `SELECT` query unless an explicit `includeDeleted` option is passed. This preserves the invariant that “deleted” means invisible to normal operations.
- **Soft‑delete function**: A new exported function `softDeleteFinding(id)` sets `deleted_at = NOW()` on the row. No hard delete is exposed in the API.
- **No new dependencies**: The change stays within the `findings` domain, which is allowed to depend on `shared-lib` for database utilities. No architectural rules are violated.
- **Migration file**: Placed in `supabase/migrations/` with a timestamp‑based name, following the existing convention.

## File‑level plan

### Create
- `supabase/migrations/20260630_add_soft_delete_to_audit_findings.sql`  
  *Purpose*: SQL migration that adds the `deleted_at` column, creates the partial index, and sets a default of `NULL` for existing rows (the column is nullable, so no data migration is needed). Includes a comment explaining the purpose.

### Modify
- `scripts/lib/findings.mjs`  
  *Purpose*: Central data‑access module for `audit_findings`. Changes:
  - Add a `SELECT` helper that always appends `WHERE deleted_at IS NULL` to the base query, unless an `options.includeDeleted` flag is truthy.
  - Update `getFindings`, `getFindingById`, and any other query functions to use the helper.
  - Export `async softDeleteFinding(id)` that runs `UPDATE audit_findings SET deleted_at = NOW() WHERE id = $1`.
  - If a `findings` schema type definition exists (e.g., in `shared-lib`), add the `deleted_at` field there as optional.

- `tests/findings.test.mjs` (or equivalent test file)  
  *Purpose*: Add test cases to verify:
  - Creating a finding and fetching it excludes the `deleted_at` column from the result (or returns it as `null`).
  - After soft‑deleting a finding, standard queries no longer return it.
  - Using `includeDeleted: true` returns the soft‑deleted row.
  - The partial index is used by the query planner (e.g., via `EXPLAIN`).

## Risks

- **Existing queries outside the findings module**: If other modules (e.g., `audit-orchestration`) directly query `audit_findings` without using the findings module, they will see soft‑deleted rows until they are updated to filter them out. The mitigation is to audit all direct SQL references to `audit_findings` and add the filter. The allowed dependency graph (audit‑orchestration → findings) encourages using the module, reducing this risk.
- **Data migration**: No backfill needed because the column is nullable. Existing rows remain `NULL` (live).
- **Index size**: The partial index is small and only grows when rows are deleted; it is a read‑optimised B‑tree, unlikely to impact write performance.
- **Migration ordering**: The migration must be applied before the new code references the column. In a CI/CD pipeline, migrations run first; this is a standard Supabase workflow.

## Target Paths
- `supabase/migrations/20260630_add_soft_delete_to_audit_findings.sql`
- `scripts/lib/findings.mjs`
- `tests/findings.test.mjs`

## Section 9 — Acceptance Criteria
1. The migration SQL runs successfully against a development database without errors.
2. The `audit_findings` table has a nullable `deleted_at` column of type `TIMESTAMP WITH TIME ZONE`.
3. A partial index named `idx_audit_findings_live` exists on `deleted_at` with the condition `WHERE deleted_at IS NULL`.
4. All existing rows have `deleted_at = NULL` after migration.
5. The `scripts/lib/findings.mjs` module exports `softDeleteFinding(id)` that sets `deleted_at` to the current timestamp for the given row.
6. Calling `getFindings` or `getFindingById` after a soft delete does not return the soft‑deleted row (unless `includeDeleted` is true).
7. Passing `includeDeleted: true` to `getFindings` or `getFindingById` returns the soft‑deleted row.
8. The module’s existing public API remains unchanged (no breaking signature changes for existing callers).
9. The test file contains at least one passing test for each of the above behaviours.
10. The query planner uses the partial index when querying for non‑deleted rows (verified via `EXPLAIN`).

### output-2

# Implementation Plan — Add Soft-Delete Column to `audit_findings` with Partial Index

## Overview

Add a schema-only migration for `public.audit_findings` that introduces nullable soft-delete metadata and a partial index for active findings. The migration should be small, safe to apply to existing databases, and aligned with Supabase/Postgres migration practices.

The intended data contract is:

- `deleted_at IS NULL` means the audit finding is active.
- `deleted_at IS NOT NULL` means the audit finding has been soft-deleted.
- Existing rows remain active after migration.
- The partial index supports efficient access to active findings without indexing soft-deleted rows.

## Target Paths

- `supabase/migrations/20260702000000_add_deleted_at_to_audit_findings.sql`

## Design Decisions

### 1. Use `deleted_at TIMESTAMPTZ NULL`

**Decision:** Add a nullable `deleted_at` column using `TIMESTAMPTZ`.

**Rationale:**

- A timestamp is more useful than a boolean because it records when deletion occurred.
- `NULL` naturally represents “not deleted.”
- `TIMESTAMPTZ` preserves correct time semantics across environments.
- Existing records should not be backfilled; they remain active with `deleted_at = NULL`.

### 2. Do not add a default value

**Decision:** The column should not have a default.

**Rationale:**

- A default such as `now()` would incorrectly mark all new findings as deleted.
- A default `NULL` is implicit and avoids unnecessary schema noise.
- Avoids possible table rewrites or unnecessary persistence overhead.

### 3. Use an additive migration only

**Decision:** Create a new migration file; do not modify historical migrations.

**Rationale:**

- Preserves migration history integrity.
- Keeps the change deployable to existing databases.
- Matches standard Supabase migration practice.

### 4. Create a partial index for active rows

**Decision:** Add a partial index on active findings with predicate `deleted_at IS NULL`.

Recommended index shape:

- Name: `idx_audit_findings_active`
- Table: `public.audit_findings`
- Indexed column: `id`
- Predicate: `deleted_at IS NULL`

**Rationale:**

- The index excludes soft-deleted rows.
- It supports active-row scans and predicates that include `deleted_at IS NULL`.
- Indexing `id` is conservative and avoids assuming other query columns.
- The predicate is the important part of the contract; it ensures only active rows are represented.

If the existing schema shows a more appropriate established query path, such as frequent filtering by `audit_run_id`, `session_id`, `repository_id`, or ordering by `created_at`, adjust the indexed columns while preserving the partial predicate. Do not introduce speculative multi-column indexes without evidence from existing queries or schema conventions.

### 5. Use `IF NOT EXISTS` where supported

**Decision:** Use defensive migration statements where practical:

- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`

**Rationale:**

- Improves local developer reset/replay resilience.
- Avoids failures if the migration is partially applied during manual testing.
- Does not replace proper migration tracking, but reduces avoidable operational friction.

### 6. Avoid app/query behavior changes in this migration

**Decision:** Do not modify application code, RLS policies, views, or query helpers in this task unless existing schema conventions require it.

**Rationale:**

- The requested scope is schema migration only.
- Adding `deleted_at` does not automatically hide rows from existing reads.
- Any behavioral change to exclude deleted records should be a separate, explicit application/query contract change.

### 7. Avoid `CREATE INDEX CONCURRENTLY` unless the migration runner supports it

**Decision:** Prefer normal `CREATE INDEX` unless existing Supabase migrations already use `CREATE INDEX CONCURRENTLY` safely.

**Rationale:**

- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction.
- Some migration runners wrap migration files in transactions.
- The safer default for a small/simple repository migration is a standard index.
- If production table size is known to be large and Supabase migration execution is confirmed non-transactional, consider `CONCURRENTLY` as an operational adjustment.

## File-Level Plan

### Create: `supabase/migrations/20260702000000_add_deleted_at_to_audit_findings.sql`

Purpose: Add soft-delete support to `public.audit_findings`.

Planned contents:

1. Add nullable column:
   - Table: `public.audit_findings`
   - Column: `deleted_at`
   - Type: `TIMESTAMPTZ`
   - Nullable
   - No default

2. Add partial index:
   - Index name: `idx_audit_findings_active`
   - Table: `public.audit_findings`
   - Indexed column: `id`, unless existing query/schema conventions clearly justify another column set
   - Predicate: `deleted_at IS NULL`

3. Keep comments minimal but useful:
   - Clarify that `NULL` means active.
   - Clarify that non-`NULL` means soft-deleted.

## Validation Plan

1. Run the project’s normal Supabase migration validation, such as:
   - `supabase db reset`
   - or the repository’s documented DB migration test command.

2. Inspect resulting schema:
   - Confirm `public.audit_findings.deleted_at` exists.
   - Confirm type is `timestamp with time zone`.
   - Confirm the column is nullable.
   - Confirm no default value exists.

3. Inspect resulting index:
   - Confirm `idx_audit_findings_active` exists.
   - Confirm it is partial.
   - Confirm predicate is equivalent to `deleted_at IS NULL`.

4. Verify existing data behavior:
   - Existing rows have `deleted_at = NULL`.
   - No rows are marked deleted by the migration.

5. Verify migration ordering:
   - The new timestamped migration appears after existing migrations.
   - If the chosen timestamp conflicts with an existing file, use the next chronological timestamp while preserving the same descriptive suffix.

## Failure Modes and Handling

### Migration fails because `audit_findings` is not in `public`

Handling:

- Inspect existing migrations for the table schema.
- Use the schema-qualified table name already used by the repository.
- Do not create a duplicate table.

### Migration fails because index name already exists

Handling:

- Use `CREATE INDEX IF NOT EXISTS`.
- If an existing index has the same name but incompatible definition, stop and rename the new index only after confirming the existing index’s purpose.

### Migration applies but deleted rows are still visible

Handling:

- This is expected for a schema-only migration.
- Visibility changes require explicit query, view, or RLS updates outside this task.

### Index is not used by the planner

Handling:

- Acceptable unless query performance is part of this task.
- The partial index establishes the persistence contract.
- If performance testing shows a better access path, adjust the indexed columns while keeping `WHERE deleted_at IS NULL`.

### Large table lock during index creation

Handling:

- For large production tables, evaluate `CREATE INDEX CONCURRENTLY`.
- Only use it if the Supabase migration execution mode supports non-transactional statements.

## Risks

1. **Behavioral ambiguity:** Adding `deleted_at` does not automatically exclude records from existing reads.
2. **Index usefulness depends on queries:** A generic active-row partial index may not be optimal for all access patterns.
3. **Migration runner transaction mode:** `CREATE INDEX CONCURRENTLY` may be unsafe if the runner wraps migrations.
4. **Schema drift:** The architecture map has a RED drift status, so verify current migration conventions directly before implementing.
5. **Naming convention mismatch:** Existing migrations may use a different index naming style; prefer the repository’s convention if clearly established.

## Section 9 — Acceptance Criteria

1. A new migration file exists at `supabase/migrations/20260702000000_add_deleted_at_to_audit_findings.sql`.
2. The migration adds `deleted_at` to `public.audit_findings`.
3. `deleted_at` is nullable.
4. `deleted_at` uses `TIMESTAMPTZ` / `timestamp with time zone`.
5. `deleted_at` has no non-null default.
6. Existing `audit_findings` rows remain active after migration, with `deleted_at IS NULL`.
7. A partial index named `idx_audit_findings_active` exists on `public.audit_findings`.
8. The partial index predicate is equivalent to `deleted_at IS NULL`.
9. The migration does not modify historical migration files.
10. The migration applies successfully during a clean Supabase database reset or equivalent project migration validation.
11. The migration does not add application-layer filtering, RLS changes, or view changes outside the schema migration scope.
12. Re-running the migration statements manually in a development database does not fail due solely to the column or index already existing.

### output-3

## Overview

Add a nullable `deleted_at TIMESTAMPTZ` column to the `audit_findings` table and create a partial index scoped to non-deleted rows (`WHERE deleted_at IS NULL`). The column is the canonical soft-delete signal: `NULL` = active, non-null = deleted at the given instant. The partial index keeps the hot read path (active findings per audit) fast without bloating the index with tombstoned rows. The migration is forward-only, idempotent (`IF NOT EXISTS` guards), and transactional per Postgres DDL semantics. RLS policy adjustments are explicitly out of scope for this change (the column does not affect existing row-level checks) but are flagged as a follow-up.

## Design Decisions

1. **`deleted_at TIMESTAMPTZ` over a boolean `is_deleted`.**
   Rationale: A timestamp encodes *when* deletion occurred, which audit findings domain demands (traceability). It also doubles as the nullability sentinel, removing a redundant boolean and avoiding a state where `is_deleted = true` but `deleted_at IS NULL`. ZonedDateTime over `TIMESTAMP` for cross-region consistency (existing tables in the store layer use `TIMESTAMPTZ` per [REQ-persistence-6623d196]).

2. **Default `NULL`, no backfill needed.**
   Adding a nullable column with no default is an O(1) metadata operation in Postgres (no table rewrite). Existing rows are implicitly "not deleted". A `DEFAULT now()` would be wrong — it would mark all existing rows as deleted at migration time.

3. **Partial index `idx_audit_findings_active WHERE deleted_at IS NULL`.**
   The dominant read query for findings is "list active findings for an audit, newest first". Indexing `(audit_id, created_at DESC)` with the partial predicate keeps the index small (excludes tombstones) and directly serves that path. A full index would waste space and write amplification on soft-deleted rows that are never queried.

4. **Idempotent DDL with `IF NOT EXISTS`.**
   Re-running the migration (e.g., local dev reset to a checkpoint) must not hard-fail. `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are used. This respects [REQ-safety-582db962].

5. **No `NOT NULL` constraint initially.**
   A `NOT NULL` constraint would require a backfill and table rewrite, and is unnecessary — the sentinel semantics are enforced at the application/query layer (`WHERE deleted_at IS NULL`). Adding `NOT NULL` later is a non-breaking follow-up if desired.

6. **RLS policies left untouched.**
   The existing policies on `audit_findings` (per [REQ-security-b0b533cc] / [REQ-security-d55680e9]) gate row visibility on ownership/audit membership, not on deletion status. The soft-delete column does not widen or narrow the policy surface. Updating queries to filter `deleted_at IS NULL` is an application-layer concern, tracked separately.

7. **No down-migration file.**
   This repo's Supabase migration set is forward-only (no `down.sql` convention observed). Rollback is handled by restoring a pre-migration snapshot. Right-sizing: do not invent a new convention.

8. **Comment on column for discoverability.**
   `COMMENT ON COLUMN` documents the soft-delete contract inline in `\d+`, supporting [REQ-correctness-a8781f0f] (schema self-description).

## Failure Modes

- **Migration applied but application not updated:** Queries that don't filter `deleted_at IS NULL` will return tombstoned rows. Mitigation: the migration is additive; the old behavior is preserved until the application layer is updated in a follow-up. This is an intentional, bounded transient.
- **Partial index name collision across environments:** `IF NOT EXISTS` prevents hard failure; the index name is stable and descriptive.
- **Clock skew on `deleted_at`:** Uses DB-side `now()` at UPDATE time, not client time, eliminating client-clock skew. Consistent with [REQ-persistence-d8f9613d].
- **Large table DDL lock:** `ADD COLUMN ... NULL` acquires only a brief `ACCESS EXCLUSIVE` lock for metadata; no long lock expected. Partial index creation will scan the table — run during a low-write window if the table is large. Flagged in the migration header comment.

## File-Level Plan

## Target Paths

- `supabase/migrations/<timestamp>_audit_findings_soft_delete.sql` — **create** — Forward migration: adds `deleted_at`, creates partial index, sets column comment.
- `tests/stores/audit-findings-soft-delete.test.mjs` — **create** — Integration test asserting: column exists, default is NULL, partial index exists with correct predicate, inserting a tombstoned row does not appear in the active-reads path.

(Existing application query files in `scripts/lib/findings*.mjs` and `scripts/lib/audit/**` will be updated in a follow-up plan to add `WHERE deleted_at IS NULL` filters; not in scope for this schema-only change.)

## Migration SQL Structure (for the created file)

```
BEGIN;

-- Add soft-delete sentinel. NULL = active; non-null = deleted_at instant.
ALTER TABLE audit_findings
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index serving the active-findings read path.
-- Excludes tombstoned rows to keep index compact.
CREATE INDEX IF NOT EXISTS idx_audit_findings_active
  ON audit_findings (audit_id, created_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN audit_findings.deleted_at IS
  'Soft-delete sentinel. NULL = active. Set to transaction time() at deletion. Queries for active findings MUST filter deleted_at IS NULL.';

COMMIT;
```

## Test Plan (for the created test file)

The test uses the repo's existing test harness against a disposable Postgres/Supabase-local instance (or the existing `tests/stores/` fixture pattern). Assertions:

1. After applying the migration, `information_schema.columns` contains `audit_findings.deleted_at` with data type `timestamp with time zone` and `is_nullable = 'YES'`.
2. `pg_indexes` contains `idx_audit_findings_active` with `WHERE deleted_at IS NULL` in the index definition (`pg_get_indexdef`).
3. Inserting a row with `deleted_at = now()` and querying via the partial-indexed path (`SELECT ... WHERE audit_id = $1 AND deleted_at IS NULL`) returns zero rows for that tombstone — proving the index predicate aligns with the query.
4. Inserting a row with `deleted_at = NULL` is returned by the same query.
5. Re-running the migration does not error (idempotency).

## Risks

- **Read-path regression risk (medium):** Until application queries add the `deleted_at IS NULL` filter, tombstoned rows leak into results. This is a known, bounded transient gated by a follow-up task; the migration alone does not change query results because no rows have `deleted_at` set yet.
- **Index build cost on large `audit_findings` (low–medium):** `CREATE INDEX` is non-blocking for writes only if `CONCURRENTLY` is used; Supabase migrations run in a transaction, which precludes `CONCURRENTLY`. If the table is large, this migration should be applied during a maintenance window. Right-sized trade-off: the repo's migration convention is transactional; introducing `CONCURRENTLY` would break the `BEGIN/COMMIT` wrapper and the migration runner's expectations.
- **Naming collision with a future index (low):** `idx_audit_findings_active` is descriptive and unlikely to collide; `IF NOT EXISTS` de-risks regardless.
- **Soft-delete semantics drift (low):** Multiple places may set `deleted_at` in future. Mitigated by column comment and the follow-up application-layer plan enforcing a single `softDeleteFinding()` helper.

## Section 9 — Acceptance Criteria

1. A migration file exists under `supabase/migrations/` with a forward-only, transactional DDL block.
2. After migration, `audit_findings` has a column `deleted_at` of type `TIMESTAMPTZ`, nullable, with no default.
3. Existing rows in `audit_findings` have `deleted_at IS NULL` after migration (no backfill mutation).
4. A partial index `idx_audit_findings_active` exists on `(audit_id, created_at DESC)` with predicate `WHERE deleted_at IS NULL`.
5. `pg_get_indexdef('idx_audit_findings_active')` includes the `WHERE deleted_at IS NULL` clause.
6. `COMMENT ON COLUMN audit_findings.deleted_at` is set and retrievable via `col_description`.
7. Re-applying the migration (second run) completes without error — `IF NOT EXISTS` guards hold.
8. A row inserted with `deleted_at = now()` is excluded by a query filtering `deleted_at IS NULL`; a row with `deleted_at = NULL` is included.
9. The test file `tests/stores/audit-findings-soft-delete.test.mjs` passes against a migrated database instance.
10. No existing RLS policy on `audit_findings` is altered by this migration (diff of `pg_policies` before/after is empty for the table).

