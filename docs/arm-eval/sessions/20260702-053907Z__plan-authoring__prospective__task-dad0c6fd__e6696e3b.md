# Arm-eval session e6696e3b-7c8b-42c1-9209-b3d06f237a9b

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-dad0c6fd` |
| Seed (presentation-order RNG) | 10 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T05:39:07.569Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

Add a --dry-run flag to setup-postgres that prints pending migrations without applying them

## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

# Implementation Plan — Add `--dry-run` to `setup-postgres`

## Overview

Add a `--dry-run` CLI flag to the existing `setup-postgres` command so operators can see which migrations would be applied without changing the database.

The implementation should reuse the current migration discovery and migration-state logic as much as possible, while introducing a dry-run execution path that:

1. Parses `--dry-run`.
2. Connects only as needed to determine already-applied migrations.
3. Computes the pending migration list using the same ordering/identity rules as the real migration path.
4. Prints the pending migrations deterministically.
5. Exits successfully without applying migrations or performing schema/data writes.

This should be a small, local change to the existing setup script plus focused tests. No new architectural layer or external dependency is needed.

## Target Paths

- `scripts/setup-postgres.mjs`
- `tests/setup-postgres.test.mjs`

## Design Decisions

### 1. Implement dry-run in the existing `setup-postgres` command

**Decision:** Modify the existing setup script rather than adding a separate command.

**Rationale:**

- The requested interface is explicitly `setup-postgres --dry-run`.
- Migration discovery, connection setup, and applied-migration detection should remain consistent with the existing setup flow.
- A separate script would duplicate logic and increase the chance that dry-run and real execution drift.

### 2. Extend argument parsing with a boolean `dryRun`

**Decision:** Add `--dry-run` support to the script’s existing argument parser, returning an options object that includes `dryRun: true | false`.

**Rationale:**

- Keeps behavior explicit and testable.
- Avoids implicit behavior from environment variables.
- Provides a stable location for future CLI options if the script already has argument parsing.

Expected behavior:

- `setup-postgres --dry-run` enables dry-run mode.
- Existing flags continue to work.
- Unknown-flag handling should remain consistent with current behavior.
- If the script has `--help`, include `--dry-run` in the help text.

### 3. Compute pending migrations using the same identity and order as real migration application

**Decision:** Refactor only if necessary so both normal mode and dry-run mode call the same migration-planning logic.

A small internal shape is preferred:

```text
discover local migrations
read applied migration versions
compute pending migrations
if dryRun: print plan and return
else: apply pending migrations
```

**Rationale:**

- The most important correctness property is that dry-run reports the same set the real command would apply.
- Shared planning logic prevents dry-run-specific migration bugs.
- This is right-sized: do not introduce a full migration framework.

### 4. Dry-run must not apply migrations or perform persistence writes

**Decision:** The dry-run branch must happen before any migration application, schema creation, migration-table mutation, seed operation, or other database write.

**Rationale:**

- The core safety requirement is “prints pending migrations without applying them.”
- Dry-run should be safe to run repeatedly in production-like environments.

Implementation guidance:

- If the existing script has setup steps before migration application, explicitly classify them:
  - **Read-only steps required to determine pending migrations** may run.
  - **Write/setup steps** must be skipped in dry-run.
- If the current script creates a migrations table before reading applied migrations, dry-run should not create it. Instead:
  - If the migrations table does not exist, treat that as “no migrations recorded” only if that matches normal setup semantics and can be determined read-only.
  - Otherwise, fail with a clear message explaining that applied migration state cannot be read.

### 5. Output should be deterministic and human-readable

**Decision:** Print pending migrations in application order, one per line, with enough information to identify each migration.

Recommended output format:

```text
Pending migrations:
- 20240101000000_create_users.sql
- 20240102000000_add_indexes.sql
```

If none are pending:

```text
No pending migrations.
```

**Rationale:**

- Deterministic output is easy to verify in tests and useful in CI.
- Filenames are usually the clearest migration identity for humans.
- Avoid printing credentials, connection strings, SQL bodies, or secrets.

### 6. Preserve existing exit-code semantics

**Decision:**

- Dry-run exits `0` when pending migrations are successfully computed and printed, regardless of whether the list is empty or non-empty.
- Dry-run exits non-zero for the same classes of planning failures as normal mode:
  - invalid configuration,
  - missing/unreadable migrations directory,
  - malformed migration filenames if the current implementation treats those as errors,
  - database connection failure,
  - inability to read applied migration state.

**Rationale:**

- A dry-run is an inspection command, not a policy gate.
- CI can decide separately whether “pending migrations exist” should fail.
- Failure modes should remain explicit and not silently produce an incomplete list.

### 7. Keep dependency and architecture impact minimal

**Decision:** Do not add new runtime dependencies. Use existing filesystem, database, logging, and test utilities already present in the repository.

**Rationale:**

- The task is small and localized.
- Additional dependencies would add security and maintenance overhead.
- The architecture map places `scripts/**` in the `scripts` domain; this change can stay there.

### 8. Make behavior testable by isolating side effects

**Decision:** If `scripts/setup-postgres.mjs` currently performs all logic directly inside `main()`, extract minimal pure or injectable helpers as needed.

Suggested helper boundaries:

- `parseArgs(argv)`
- `computePendingMigrations(localMigrations, appliedVersions)`
- `formatPendingMigrations(pendingMigrations)`
- `run(options, deps)` or equivalent injectable entrypoint for tests

**Rationale:**

- The dry-run behavior needs to be verified without touching a real database.
- Tests should assert that migration application is not called.
- This refactor should be minimal and local; avoid redesigning the whole script.

## File-Level Plan

### `scripts/setup-postgres.mjs` — modify

Purpose: Add dry-run CLI behavior to the existing setup command.

Planned changes:

1. Locate the existing argument parsing.
2. Add `--dry-run` handling.
3. If help text exists, document:
   ```text
   --dry-run    Print pending migrations without applying them
   ```
4. Identify the current migration flow:
   - local migration discovery,
   - applied migration discovery,
   - pending migration computation,
   - migration application.
5. Ensure pending migration computation is shared by normal and dry-run paths.
6. Add dry-run branch after pending migrations are known and before any write/apply operation.
7. Print:
   - `No pending migrations.` when the pending list is empty.
   - `Pending migrations:` followed by ordered filenames when non-empty.
8. Ensure dry-run does not:
   - execute migration SQL,
   - insert migration records,
   - create/alter/drop database objects,
   - run seed data,
   - perform setup writes.
9. Preserve existing normal-mode behavior when `--dry-run` is absent.
10. Export or expose only the minimum internals needed for tests, following existing repository test conventions.

### `tests/setup-postgres.test.mjs` — create or modify

Purpose: Add focused tests for the dry-run behavior.

Planned tests:

1. **Argument parsing**
   - Given `['--dry-run']`, parsed options include `dryRun: true`.
   - Given no flag, `dryRun` is false/undefined according to existing style.

2. **Pending migration formatting**
   - Given two pending migrations, output lists them in deterministic application order.
   - Given zero pending migrations, output is `No pending migrations.` or the exact chosen message.

3. **Dry-run does not apply migrations**
   - Arrange local migrations and applied migration state so one or more migrations are pending.
   - Run with `dryRun: true`.
   - Assert migration-apply function/stub was not called.
   - Assert no write-like function/stub was called if the script exposes separate write steps.

4. **Dry-run prints pending migrations**
   - Capture stdout.
   - Assert output includes pending migration filenames.
   - Assert output does not include SQL bodies or connection details.

5. **Normal mode remains unchanged**
   - Run equivalent setup with `dryRun: false`.
   - Assert pending migrations are passed to the existing apply path.

6. **No pending migrations**
   - Arrange local migration versions all marked applied.
   - Run with dry-run.
   - Assert output says no pending migrations.
   - Assert apply path is not called.

Testing approach:

- Prefer existing test runner and style in the repository.
- Use temporary directories or in-memory stubs for migration files.
- Mock/inject database access instead of requiring a live Postgres instance.
- Avoid brittle assertions on unrelated log lines; assert the dry-run contract.

## Failure Modes and Handling

### Database connection cannot be established

Behavior:

- Dry-run exits non-zero.
- Error message indicates that applied migration state could not be read.
- Do not print credentials or full connection strings.

Rationale:

- Pending migrations cannot be known accurately without applied migration state.

### Applied migration table cannot be read

Behavior:

- If existing normal setup has a defined safe interpretation for this state, reuse it.
- Otherwise, dry-run fails clearly and does not create the table.

Rationale:

- Creating or mutating database objects would violate dry-run expectations.

### Migration directory missing or unreadable

Behavior:

- Preserve current behavior.
- Usually this should be a non-zero failure with a clear path-specific message.

Rationale:

- A successful dry-run with incomplete local migration data would be misleading.

### Malformed or duplicate migration identifiers

Behavior:

- Preserve current validation behavior.
- If no validation exists, do not add broad new validation unless necessary for the flag.
- Ensure dry-run and normal mode handle the same migration identity rules.

Rationale:

- Avoid expanding scope while keeping dry-run truthful.

### Pending list is empty

Behavior:

- Print `No pending migrations.`
- Exit `0`.
- Do not call apply path.

Rationale:

- Empty plans are valid dry-runs.

## Security and Persistence Safety

- Do not log database passwords, URLs, tokens, or environment variable values.
- Do not print full SQL migration contents by default.
- Avoid shelling out with interpolated user input for dry-run.
- Ensure the dry-run branch is before all write operations.
- If the script uses transactions for migrations, dry-run should not open write transactions.
- Keep output limited to migration identifiers/filenames and summary text.

## Testability Notes

The cleanest test seam is to separate planning from applying:

```text
planMigrations(deps) -> pendingMigrations
applyMigrations(pendingMigrations, deps)
printDryRun(pendingMigrations, deps)
```

Tests can then stub:

- local migration discovery,
- applied migration read,
- migration application,
- stdout/stderr.

If the current script does not expose helpers, add minimal named exports guarded so CLI execution remains unchanged.

## Risks

1. **Existing setup performs writes before migration application**
   - Risk: Dry-run could still mutate the database if the branch is placed too late.
   - Mitigation: Audit the setup flow and branch immediately after read-only planning.

2. **Migration state requires initialization**
   - Risk: The script may currently create a migrations table before it can read applied versions.
   - Mitigation: In dry-run, avoid creating it; either use a read-only existence check or fail clearly.

3. **Different migration identity formats**
   - Risk: Local filenames and database-stored versions may not match directly.
   - Mitigation: Reuse existing normalization/comparison logic exactly.

4. **Tests accidentally rely on a real database**
   - Risk: Tests become slow/flaky and unsafe.
   - Mitigation: Use dependency injection/stubs for database reads and migration applies.

5. **Output format becomes a hidden API**
   - Risk: Downstream scripts may parse the output.
   - Mitigation: Keep output simple and deterministic. Document exact expectations in tests.

## Section 9 — Acceptance Criteria

1. Running `setup-postgres --dry-run` prints the migrations that are pending in the same order normal setup would apply them.
2. Running `setup-postgres --dry-run` does not apply migration SQL.
3. Running `setup-postgres --dry-run` does not insert, update, or delete migration records.
4. Running `setup-postgres --dry-run` does not perform schema/data setup writes before printing the migration plan.
5. Running `setup-postgres --dry-run` with no pending migrations prints a clear no-pending-migrations message and exits `0`.
6. Running `setup-postgres` without `--dry-run` preserves the existing migration-application behavior.
7. Dry-run output includes migration identifiers or filenames, but does not include database credentials, connection strings, tokens, or full SQL bodies.
8. Invalid configuration, database connection failure, or inability to read applied migration state causes dry-run to exit non-zero with a clear error.
9. Automated tests verify that dry-run prints pending migrations and that the migration apply path is not called.
10. Automated tests verify that normal non-dry-run execution still calls the migration apply path for pending migrations.

### output-2

## Overview

Add a `--dry-run` flag to the `setup-postgres.mjs` script that detects and prints any pending migrations without applying them to the database. The implementation will:

1. Parse `--dry-run` from command-line arguments
2. Load the migrations manager (already used in the existing script for applying migrations)
3. Query which migrations have not yet been applied
4. Print a human-readable summary of pending migrations (name, path, and optionally the SQL preview)
5. Exit cleanly with a non-zero exit code if migrations are pending (enabling CI/CD gating)
6. Log nothing to the database and make no state changes

The change is minimal: a single flag addition to the existing entrypoint, leveraging the existing migration infrastructure without introducing new abstractions.

## Design Decisions

| Decision | Rationale |
|---|---|
| Add `--dry-run` as a boolean flag parsed by the existing argument parser in `setup-postgres.mjs` | Reuses the existing `parseArgs` pattern; avoids pulling in a CLI framework for one flag |
| Use the existing `migrate` module's `status()` or `listPending()` function to determine pending migrations | The migration manager already tracks applied vs. pending migrations; no reinvention needed |
| Print pending migration names and file paths in a consistent, machine-parseable format (e.g., `[PENDING] filename.sql`) | Enables both human inspection and downstream scripting (grep, jq) |
| Exit code `1` when migrations are pending, `0` when none | Standard Unix semantics for CI/CD gate checks |
| Do NOT print the actual SQL by default; add an optional `--dry-run-verbose` or `-v` to include SQL content | Avoids overwhelming the terminal with large migration SQL; still provides inspection capability when needed |
| Do NOT modify any database state under `--dry-run` | Core correctness invariant; this is the whole point of the flag |

## File-level Plan

| File | Action | Purpose |
|---|---|---|
| `scripts/setup-postgres.mjs` | Modify | Add argument parsing for `--dry-run` and optionally `--dry-run-verbose`/`-v`. Insert conditional branch: when `--dry-run` is truthy, call the migration manager's status/list function and print results. Do NOT apply migrations. Set exit code appropriately. |
| `scripts/lib/migrate.mjs` (assuming path; adjust based on actual migration manager location) | Inspect (no changes expected) | Verify that `listPendingMigrations()` or equivalent function exists and returns an array of migration metadata (name, file path). If not, this plan will need to add a minimal public-API function. |
| `tests/setup-postgres.test.mjs` (if exists) | Modify or Create | Add test cases: (a) `--dry-run` with pending migrations prints them and exits 1; (b) `--dry-run` with no pending migrations exits 0; (c) `--dry-run --verbose` includes SQL content; (d) `--dry-run` does not modify the database. |
| `docs/` (optional) | Modify | If a man page or CLI reference exists, document the new flag. |

## Detailed Plan (setup-postgres.mjs modifications)

### 1. Argument Parsing Enhancement
- In the `parseArgs` or argument-handling section near the top of `setup-postgres.mjs`, add:
  ```js
  const dryRun = args.includes('--dry-run');
  const dryRunVerbose = dryRun && (args.includes('--dry-run-verbose') || args.includes('-v'));
  ```
- Remove `--dry-run`, `--dry-run-verbose`, and `-v` from `args` before passing them to downstream operations, so they don't pollute other argument parsers.

### 2. Dry-run Branch
- After parsing all arguments and initializing the migration manager (but BEFORE the call that applies migrations), insert:
  ```js
  if (dryRun) {
    const pending = await migrationManager.listPendingMigrations(); // or .status(), or .getPending()
    if (pending.length === 0) {
      console.log('No pending migrations.');
      process.exit(0);
    }
    for (const m of pending) {
      console.log(`[PENDING] ${m.name} (${m.filePath})`);
      if (dryRunVerbose && m.sql) {
        console.log(m.sql);
        console.log('---');
      }
    }
    console.log(`\n${pending.length} pending migration(s) found.`);
    process.exit(1);
  }
  ```

### 3. Platform-neutral Path Printing
- Always convert file paths to POSIX-style or use `path.relative(process.cwd(), m.filePath)` for readability.

### 4. Testability Considerations
- The migration manager's `listPendingMigrations()` (or equivalent) should be mockable in tests. If it's not already exported as a separate function, extract it minimally.
- The dry-run branch should be structured so it can be unit-tested by calling the underlying function with a mocked manager, but integrating that into the existing test file is the primary goal.

## Risks

| Risk | Mitigation |
|---|---|
| Migration manager does not expose a `listPendingMigrations()` function | Before finalizing, inspect `scripts/lib/migrate.mjs` (or equivalent). If missing, add a small, focused public function that returns pending migrations from the tracking table. This is a minimal, backward-compatible addition. |
| `--dry-run` argument might conflict with existing `parseArgs` logic | Review the current argument handling carefully. If the script uses a library like `minimist` or `commander`, integrate the flag using that library's mechanism. If it uses manual `process.argv` parsing, follow the existing pattern. |
| Verbose SQL output could be huge | Only enabled when explicit `--dry-run-verbose` is passed; default is name+path only. |
| CI/CD might fail on `--dry-run` if there are pending migrations that cannot be applied by design (e.g., irreversible) | Document this behavior clearly. The flag is meant for gating; repositories with known pending migrations should exclude the check. |
| Drift between the migration tracking table and actual applied state | This is a pre-existing risk not introduced by this change. If the tracking is unreliable, `--dry-run` will only report tracked state, which is the existing behavior. |

## Target Paths

- `scripts/setup-postgres.mjs`
- `scripts/lib/migrate.mjs` (inspect only; modify only if `listPendingMigrations` is missing)
- `tests/setup-postgres.test.mjs` (create if absent, modify if present)

## Section 9 — Acceptance Criteria

1. Running `node scripts/setup-postgres.mjs --dry-run` with pending migrations prints each migration's name and file path and exits with code 1.
2. Running `node scripts/setup-postgres.mjs --dry-run` with no pending migrations prints "No pending migrations." and exits with code 0.
3. Running `node scripts/setup-postgres.mjs --dry-run --dry-run-verbose` (or `-v`) prints the SQL content of each pending migration in addition to the name and path.
4. Running `node scripts/setup-postgres.mjs --dry-run` does NOT alter the database, the migrations tracking table, or any other persistent state.
5. Running `node scripts/setup-postgres.mjs` without `--dry-run` continues to apply migrations as before (backward compatibility).
6. The `--dry-run` flag works correctly even when other flags (e.g., connection strings, environment variables) are passed.
7. A unit test confirms the exit code and output for the three scenarios (no pending, pending, verbose pending).

### output-3

# Implementation Plan: `--dry-run` flag for `setup-postgres`

## Overview

Add a `--dry-run` CLI flag to the `setup-postgres` script that computes and prints the list of pending database migrations **without applying them or making any other database modifications**. The implementation extracts the "compute pending migrations" step from the existing apply loop into a reusable pure-ish function, so both the normal and dry-run code paths share identical logic for determining what is pending. Dry-run connects to the database in read-only mode (to query the migrations tracking table); if the database or tracking table is unreachable, all discovered migrations are reported as pending with a warning.

---

## Design Decisions

### D1 — Extract `computePendingMigrations` as a standalone function

**Rationale:** The current migration logic likely interleaves discovery, filtering, and application in a single loop. By extracting the "which migrations are pending?" computation into a function that returns an ordered list, dry-run becomes a trivial consumer of the same logic the real path uses. This is the smallest change that is a true function of the problem — not a band-aid that re-implements discovery, and not an over-engineered separate dry-run subsystem.

**Contract:**
```
computePendingMigrations({ client, migrationsDir })
  → { pending: MigrationInfo[], appliedCount: number, totalDiscovered: number, trackingTableExists: boolean }
```
`MigrationInfo` = `{ id: string, filename: string, path: string }`, ordered by migration sort order (lexicographic by filename, matching existing convention).

### D2 — Dry-run is read-only at the database level

**Rationale:** To accurately report pending migrations, the script must know which migrations have already been applied. This requires a `SELECT` against the migrations tracking table (e.g., `schema_migrations`). No `CREATE`, `INSERT`, `UPDATE`, `DELETE`, or `ALTER` is executed in dry-run mode. If the tracking table does not exist (fresh database), all migrations are reported as pending and `trackingTableExists` is `false` — this is the correct and useful behavior because a brand-new database would indeed need all migrations applied.

### D3 — Early short-circuit before any writes

**Rationale:** The `--dry-run` flag is checked immediately after argument parsing and database connection. If set, the script runs `computePendingMigrations`, prints results, closes the connection, and exits before reaching any schema-creation or migration-application code. This guarantees no side effects even if other flags (e.g., `--force`, `--reset`) are present alongside `--dry-run`.

### D4 — Output format

**Rationale:** One migration per line, prefixed with a clear status marker, followed by a summary line. This is both human-scannable and trivially machine-parseable (grep, awk).

```
Dry run — no migrations will be applied.

  [pending] 0001_create_extensions.sql
  [pending] 0002_create_users_table.sql
  [pending] 0003_add_rls_policies.sql

3 pending migration(s) out of 3 discovered (0 already applied).
```

When there are no pending migrations:
```
Dry run — no migrations will be applied.

No pending migrations. All 3 migration(s) already applied.
```

When the tracking table is missing:
```
Dry run — no migrations will be applied.

Warning: migrations tracking table not found. Assuming all migrations are pending.

  [pending] 0001_create_extensions.sql
  ...

3 pending migration(s) out of 3 discovered (tracking table not initialized).
```

### D5 — Exit code 0 for dry-run regardless of pending count

**Rationale:** Dry-run is an informational operation. "There are pending migrations" is not an error condition — it is the expected and useful output. Exit 0 lets CI pipelines and scripts chain dry-run output through pipes without treating informational output as failure. If a caller wants to detect pending migrations programmatically, they parse the summary line.

### D6 — Reuse existing argument-parsing pattern

**Rationale:** The codebase has `parseArgs` functions in scripts like `drift.mjs` and `duplicates.mjs`. The `--dry-run` flag follows the same pattern: a boolean flag parsed from `process.argv.slice(2)`, stored as `args.dryRun`, defaulting to `false`.

### D7 — Dependency injection for testability

**Rationale:** `computePendingMigrations` accepts a `client` object with a `query(sql)` method (matching the `pg` Client interface). Tests inject a mock client that returns canned results for `SELECT * FROM schema_migrations` and a fixture `migrationsDir`. No real Postgres instance is needed for unit tests.

---

## Failure Modes (explicit)

| Failure | Behavior in dry-run |
|---|---|
| Database unreachable | Print warning, treat all discovered migrations as pending, exit 0. This is correct because dry-run should be useful even before the DB exists. |
| Migrations directory missing | Print error: `Migrations directory not found: <path>`, exit 1. This is a configuration error, not an informational result. |
| Tracking table missing | Print warning, all migrations pending, exit 0. |
| Invalid migration filename (doesn't match expected pattern) | Skip with a warning line: `[skip] <filename> — does not match migration naming convention`. |
| `--dry-run` combined with `--force`/`--reset` | Dry-run takes precedence; no destructive operations performed. A notice is printed: `Note: --force ignored in dry-run mode.` |

---

## File-Level Plan

### 1. `scripts/setup-postgres.mjs` — **modify**

**Purpose:** Main entry point. Add `--dry-run` to argument parsing. After connecting to the database, if `dryRun` is true, call `computePendingMigrations`, render the output (D4), close the connection, and exit 0 before any schema or migration application code.

**Changes:**
- Add `dryRun: false` to the `parseArgs` default object and a `--dry-run` case in the flag loop.
- Insert a dry-run branch immediately after the database connection is established and before any `CREATE TABLE` / migration application logic.
- The dry-run branch calls `computePendingMigrations({ client, migrationsDir })`, formats output per D4, prints to stdout, calls `client.end()`, and `process.exit(0)`.
- If other destructive flags are set alongside `--dry-run`, print the "ignored" notice (D6).

### 2. `scripts/lib/store/migrations.mjs` — **modify** (or create if migration logic is currently inline in `setup-postgres.mjs`)

**Purpose:** Houses the migration discovery, pending-computation, and application logic. The key extraction is `computePendingMigrations`.

**Changes:**
- **`discoverMigrations(migrationsDir)`** — reads the migrations directory, filters files matching the naming convention (e.g., `NNNN_description.sql`), returns an ordered list of `MigrationInfo`. If this function already exists, reuse it unchanged.
- **`getAppliedMigrations(client)`** — queries the tracking table. Returns `{ applied: Set<string>, tableExists: boolean }`. Catches the "table does not exist" error and returns `{ applied: new Set(), tableExists: false }`.
- **`computePendingMigrations({ client, migrationsDir })`** — orchestrates the above two: discovers all, queries applied, returns pending = discovered − applied. This is the function both dry-run and the real path call before applying.
- **Existing apply logic** — refactored to call `computePendingMigrations` first, then iterate the `pending` array to apply each. This ensures the real path and dry-run path use identical filtering logic.

**Architectural compliance:** `stores` domain → may depend on `shared-lib`. No new cross-domain dependencies introduced.

### 3. `tests/setup-postgres.dry-run.test.mjs` — **create**

**Purpose:** Unit tests for the dry-run behavior.

**Test cases:**
1. **Prints pending migrations, applies nothing** — mock client tracks all queries; assert no `INSERT`/`CREATE`/`ALTER` queries were issued; assert pending migration filenames appear in stdout.
2. **All migrations pending when tracking table missing** — mock client throws on `SELECT FROM schema_migrations`; assert all migrations listed as pending and warning printed.
3. **No pending migrations when all applied** — mock client returns all migration IDs as applied; assert "No pending migrations" output and exit 0.
4. **Dry-run takes precedence over `--force`** — pass both `--dry-run` and `--force`; assert no destructive queries, assert "ignored" notice printed.
5. **Missing migrations directory** — point to non-existent directory; assert error message and exit code 1.
6. **Exit code 0 with pending migrations** — assert `process.exit` is called with 0 when there are pending migrations.

**Approach:** Use the existing test harness patterns from the `tests` domain. Mock the `pg` client via dependency injection (the `computePendingMigrations` function accepts a `client` object). Use a fixture migrations directory under `tests/fixtures/migrations/` with 2–3 sample `.sql` files.

### 4. `tests/fixtures/migrations/` — **create** (directory + sample files)

**Purpose:** Fixture migration files for the test cases.

**Contents:**
- `0001_create_extensions.sql` — trivial SQL comment
- `0002_create_users_table.sql` — trivial SQL comment
- `0003_add_rls_policies.sql` — trivial SQL comment

These are test-only fixtures, never applied to a real database.

---

## Target Paths

- `scripts/setup-postgres.mjs`
- `scripts/lib/store/migrations.mjs`
- `tests/setup-postgres.dry-run.test.mjs`
- `tests/fixtures/migrations/0001_create_extensions.sql`
- `tests/fixtures/migrations/0002_create_users_table.sql`
- `tests/fixtures/migrations/0003_add_rls_policies.sql`

---

## Risks

1. **Migration logic may be entirely inline in `setup-postgres.mjs`** — If there is no existing `scripts/lib/store/migrations.mjs`, the extraction described in file #2 creates a new module. This is slightly larger than a purely inline modification but is justified: it makes the pending-computation logic testable without spinning up a database, and it ensures dry-run and real-run share identical logic. Mitigation: if the logic is small (< 30 lines), it can remain in `setup-postgres.mjs` as a local function and be exported for testing.

2. **Migration naming convention assumption** — The plan assumes migrations follow a `NNNN_description.sql` pattern sorted lexicographically. If the project uses timestamp-based names or a manifest file, `discoverMigrations` must match the actual convention. Mitigation: inspect the existing `supabase/migrations/` directory (or wherever migrations live) before implementation and adjust the sort/glob accordingly.

3. **Database connection required for accurate dry-run** — If the database is unreachable, the plan falls back to "all migrations pending." This is correct behavior but could mislead a user who has applied some migrations to a database that is temporarily down. Mitigation: the warning message makes this state explicit.

4. **Output format stability** — If any existing CI or tooling parses `setup-postgres` stdout, adding dry-run output lines could break parsers. Mitigation: dry-run output goes to stdout only when `--dry-run` is passed; the normal path's output is unchanged.

5. **Tracking table name** — The plan assumes a table name like `schema_migrations`. If the project uses a different name (e.g., `migrations`, `_migrations`), `getAppliedMigrations` must use the correct name. Mitigation: reuse the existing constant or query from the current code rather than hardcoding.

---

## Section 9 — Acceptance Criteria

1. Running `node scripts/setup-postgres.mjs --dry-run` prints a list of pending migrations to stdout and exits with code 0, without applying any migration or creating any database object (no `CREATE`, `INSERT`, `UPDATE`, `DELETE`, `ALTER`, or `DROP` statements are executed).
2. When all migrations are already applied, `--dry-run` prints "No pending migrations" (or equivalent) and exits 0.
3. When the migrations tracking table does not exist (fresh database), `--dry-run` prints a warning, lists all discovered migrations as pending, and exits 0.
4. When the database is unreachable, `--dry-run` prints a warning, lists all discovered migrations as pending, and exits 0 (does not crash).
5. When the migrations directory does not exist, `--dry-run` prints an error message and exits 1.
6. When `--dry-run` is combined with other flags (e.g., `--force`), dry-run behavior takes precedence — no destructive operations are performed, and a notice is printed indicating the other flags were ignored.
7. The pending-migration list is computed by a `computePendingMigrations` function that is shared between the dry-run path and the normal apply path (no duplicated discovery logic).
8. `computePendingMigrations` accepts an injected database client, enabling unit tests without a real Postgres instance.
9. A test file at `tests/setup-postgres.dry-run.test.mjs` exists and covers: (a) pending migrations printed with no writes, (b) all pending when tracking table missing, (c) none pending when all applied, (d) dry-run precedence over `--force`, (e) missing migrations directory exits 1, (f) exit code 0 when pending migrations exist.
10. The change introduces no new cross-domain dependency violations per the architecture map (the `scripts` domain importing from `stores` is already allowed).

