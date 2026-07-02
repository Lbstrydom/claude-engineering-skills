# Arm-eval session b17e5388-72e2-4259-9ede-9d353d51a4ae

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-a950cb21` |
| Seed (presentation-order RNG) | 19 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T06:23:23.280Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

Design a backfill job that recomputes semantic finding IDs for legacy audit_findings rows

## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

## 1. Overview

This plan specifies a backfill job that recomputes semantic finding IDs for legacy `audit_findings` rows whose `id` does not match the current semantic-ID algorithm (or is null/non-conformant). The job is a one-off, idempotent, batched migration tool: pure computation is separated from persistence, every batch is transactional, collisions are detected (not silently merged), and a `--dry-run` mode produces a full report without mutating data. The job honors the repository's existing domain boundaries (`findings`, `stores`, `scripts`, `audit-orchestration`) and reuses any existing semantic-ID symbol rather than duplicating it.

The job is intentionally a focused maintenance script — not a framework. It does one thing: recompute and reconcile semantic IDs safely, with audit-grade observability.

## 2. Problem statement

Legacy `audit_findings` rows predate the current semantic-ID contract (deterministic hash of normalized finding content). As a result:
- Legacy IDs are not reproducible from content, so the same finding emitted in different runs can have different IDs (deduplication fails).
- Cross-run correlation and `learning-store` aggregation keyed on finding ID are unreliable for legacy data.
- Some rows may have `NULL`/placeholder IDs.

The backfill must converge every legacy row to `id = computeSemanticFindingId(row)` without losing referential integrity, without silent deduplication, and without blocking the live audit pipeline longer than a configurable batch window.

## 3. Design decisions (with rationale)

**D1. Pure function as the single source of truth.** The semantic-ID algorithm lives in one symbol, `computeSemanticFindingId(finding)`, in the `findings` domain. Both the live audit pipeline and this backfill import it. Rationale: prevents the classic drift where the backfill uses a slightly different normalization than production, re-creating the very bug it fixes. Honors [REQ-correctness-a8781f0f].

**D2. Right-sizing: script + orchestrator + repo, no framework.** Three responsibilities, three modules: CLI entry (`scripts/`), orchestrator (`findings` domain, pure-ish — takes an injected repo), and persistence (`stores` domain). Rationale: matches the existing domain map (`scripts → findings, stores`; `audit-orchestration → findings`). No new abstractions (no "migration runner" base class), no band-aid inline SQL.

**D3. Idempotency is the primary contract.** A row is a candidate iff `computeSemanticFindingId(row) !== row.id` (or `row.id IS NULL`). The second run produces zero updates. Rationale: makes retries safe and turns "did it work?" into a checkable invariant. Honors [REQ-persistence-6623d196].

**D4. Dry-run first, always.** Default mode is `--dry-run`; mutation requires `--apply`. Dry-run still computes new IDs, runs collision detection, and writes the same report — it just skips the `UPDATE`. Rationale: operational safety; operators must see the diff before committing. Honors [REQ-safety-582db962].

**D5. Collision detection halts, never merges.** If two distinct legacy rows map to the same new semantic ID, the script aborts the batch (transaction rolls back) and emits both row PKs + their normalized content. Deduplication is a human decision. Rationale: silent merging of audit findings would destroy evidence and violate [REQ-correctness-b751155f]. Collisions are also the symptom of a broken normalization — surfacing them is more valuable than hiding them.

**D6. Referential-integrity gate before any write.** Before applying, the script introspects FKs that reference `audit_findings.id`. For each, it requires either `ON UPDATE CASCADE` or it includes that dependent table in the same-batch explicit `UPDATE … WHERE finding_id = $old`. If neither is possible (a dependent in another schema the script can't enumerate), it refuses with exit code ≠ 0. Rationale: changing a PK without cascading orphans dependents. Honors [REQ-persistence-d8f9613d] and [REQ-correctness-5ec9f123].

**D7. Cursor-paginated batches, per-batch transactions, advisory lock.** Rows are streamed by PK cursor (not `LIMIT/OFFSET` — avoids skip/dup under concurrent writes). Each batch is one transaction. A Postgres advisory lock (`pg_try_advisory_lock`) prevents two backfill instances from running concurrently. Rationale: bounded memory, resumable, race-free. `--limit` and `--resume-after-pk` enable staged rollout. Honors [REQ-persistence-6623d196].

**D8. Audit log as an append-only report.** Every applied change is written to a report file (JSONL): `{row_pk, old_id, new_id, normalized_content_hash, batch, ts}`. The report is the source of truth for rollback and post-mortem. Rationale: no in-place destructive update is unobserved. Honors [REQ-security-b6cfe447].

**D9. No string-interpolated SQL.** Every query is parameterized; identifiers (table/column names) come from a constant allow-list, never from args. Rationale: [REQ-security-b0b533cc], [REQ-security-d55680e9].

**D10. Post-run validation invariants.** After `--apply`, the script re-reads and asserts: (a) total row count unchanged (no insert/delete); (b) zero rows still have a non-matching ID; (c) every dependent table's FK references resolve. Failure of any assertion is a hard error with the report path. Rationale: the migration's correctness is checked, not assumed.

## 4. File-level plan

| # | Path | Action | Purpose |
|---|------|--------|---------|
| 1 | `scripts/lib/findings-semantic-id.mjs` | CREATE (or EXTRACT if an inline implementation exists in the audit pipeline) | Pure `computeSemanticFindingId(finding)` + `normalizeFindingContent(finding)` + `isSemanticId(s)` predicate. Deterministic, no I/O. Exports the canonical contract. |
| 2 | `scripts/lib/findings-backfill.mjs` | CREATE | `runBackfill({ repo, computeId, options })` orchestrator: cursor pagination, candidate detection, collision detection (within batch and against already-migrated IDs in this run), per-batch transaction delegation to repo, report writer, post-run validation. Domain: `findings` (depends on `stores` via injected repo, no direct import). |
| 3 | `scripts/lib/store/audit-findings-repo.mjs` | CREATE (or MODIFY if a `scripts/lib/store/audit-findings*.mjs` already exists) | `stores` domain. Parameterized SQL only. Methods: `streamLegacyCandidates({ resumeAfterPk, limit })` (async iterator), `introspectReferencingFks()`, `updateIdBatch(updates, { dependentTables })` (single transaction), `rowCount()`, `assertNoOrphans()`, `tryAdvisoryLock(key)`, `releaseAdvisoryLock(key)`. |
| 4 | `scripts/backfill-finding-ids.mjs` | CREATE | `scripts` domain CLI. Parses args (`--dry-run` default, `--apply`, `--batch-size`, `--limit`, `--resume-after-pk`, `--report-path`, `--source-filter`), wires repo + orchestrator, sets exit codes, prints human-readable summary. |
| 5 | `scripts/lib/audit/<existing-finding-emission>.mjs` | MODIFY | Replaces any inline semantic-ID computation with `import { computeSemanticFindingId } from '../findings-semantic-id.mjs'`. If the pipeline already imports a shared symbol, this is a no-op confirm. (Exact path to be confirmed against repo during implementation; the change is mechanical.) |
| 6 | `tests/findings-semantic-id.test.mjs` | CREATE | Pure-function tests: determinism, normalization idempotence, stability across content reordering, format/length invariants, `NULL`/empty-field handling, distinct-content → distinct-ID property (no collision in a generated corpus of 10k findings). |
| 7 | `tests/backfill-finding-ids.test.mjs` | CREATE | Orchestrator tests with an in-memory mock repo: dry-run mutates nothing; idempotency (second run = 0 updates); collision halts and rolls back batch; FK gate refuses when a non-cascaded dependent exists; advisory-lock contention path; report contains every applied row; post-run validation flags a forced orphan. |

## 5. Failure modes (explicit)

- **F1. FK without CASCADE and not in dependent allow-list** → `--apply` refuses (exit 3); `--dry-run` still runs and reports the blocker.
- **F2. Collision (two legacy rows → same new ID)** → batch rolls back, script aborts (exit 4), both rows printed. Does not proceed to next batch.
- **F3. NULL/empty content field** → candidate is skipped and logged to report with `reason: "unhashable_content"`; does not abort the run.
- **F4. Connection drop mid-batch** → transaction rolls back; advisory lock released in `finally`; resume via `--resume-after-pk` (the last successfully committed PK is the durable cursor — written to the report and stdout).
- **F5. Concurrent live audit writing a new finding during backfill** → advisory lock prevents two backfills; a live writer inserting a row whose computed ID already exists is handled by the live pipeline's own uniqueness constraint, not the backfill. The backfill only touches rows whose `id` already mismatches `computeSemanticFindingId`.
- **F6. Algorithm change after partial backfill** → idempotency invariant means a re-run with the new algorithm simply re-migrates the now-mismatched rows; the audit log records both transitions.
- **F7. Post-run validation failure** → exit 5, full report path printed, no further batches started.
- **F8. Misuse: `--apply` without prior `--dry-run`** → allowed but the CLI prints a confirmation banner and requires `--confirm-apply` to proceed; prevents accidental destructive runs.

## 6. Security & persistence safety

- All SQL parameterized; identifier allow-list is a module constant.
- Advisory lock keyed on a stable int derived from `"audit_findings.id.backfill"`.
- Per-batch transactions; `--batch-size` default 200 (right-sized for an audit table, not a telemetry firehose).
- No `TRUNCATE`, no `DELETE`, no schema DDL anywhere in the job.
- Report file written with `0o600`; path defaults to `./reports/backfill-finding-ids-<iso8601>.jsonl`.
- No secrets in args; DB connection comes from the existing store's config (single source).
- The job never reads or writes the `learning-store` directly; downstream convergence happens naturally once IDs are stable. Honors [REQ-security-b0b533cc], [REQ-security-d55680e9], [REQ-persistence-d8f9613d].

## 7. Testability strategy

- `computeSemanticFindingId` is pure → property-based tests (determinism, injectivity on a generated corpus, normalization idempotence).
- `runBackfill` takes an injected `repo` interface (async methods) → all failure modes (F1–F8) are reproducible with an in-memory mock, no DB required.
- The CLI is a thin wrapper; tested via a smoke test that shells out with `--dry-run --limit 1` against a fixture DB (skipped in CI if no DB available).
- Collision and FK-gate behavior are the two highest-value tests; both must be red-green before merge.

## 8. Risks

- **R1. Hidden FK references in another schema** the introspection can't see → mitigated by the explicit dependent allow-list + refusal to run when `assertNoOrphans` fails post-apply. Residual: requires DBA sign-off on the allow-list.
- **R2. The legacy semantic-ID format may have multiple historical variants**, so "mismatch" must be defined as "not equal to current `computeSemanticFindingId(row)`," not "doesn't match a regex." Risk: re-running after an algorithm bump re-migrates everything. Mitigated by idempotency + audit log.
- **R3. Large legacy table** → cursor pagination bounds memory, but a single advisory lock held for the whole run could block other maintenance jobs. Mitigated by `--limit` staged runs and short per-batch transactions; advisory lock is held across batches by design (a backfill is a critical section).
- **R4. Truncation length of the hash** — if the existing column has a length constraint, truncation must be deterministic and consistent with the live pipeline. Mitigated by D1 (single source of truth) and a unit test asserting the live-format invariant.
- **R5. Existing inline semantic-ID logic in the audit pipeline differs from the extracted symbol** → extracting it changes live behavior. Mitigated by a golden-file test of `computeSemanticFindingId` against known inputs from both the legacy and current pipelines before the MODIFY in file #5 lands.
- **R6. Operator runs `--apply` on the wrong environment** → mitigated by `--confirm-apply` banner showing env/row-count; not a substitute for access controls.

## Target Paths

- `scripts/lib/findings-semantic-id.mjs` — CREATE (or EXTRACT)
- `scripts/lib/findings-backfill.mjs` — CREATE
- `scripts/lib/store/audit-findings-repo.mjs` — CREATE (or MODIFY if existing)
- `scripts/backfill-finding-ids.mjs` — CREATE
- `scripts/lib/audit/<existing-finding-emission>.mjs` — MODIFY (path confirmed at implementation time)
- `tests/findings-semantic-id.test.mjs` — CREATE
- `tests/backfill-finding-ids.test.mjs` — CREATE

## Section 9 — Acceptance Criteria

1. `computeSemanticFindingId` is a pure, deterministic function: for any fixed input it returns the same output across processes, and the function performs no I/O (unit-testable in isolation).
2. The live audit pipeline and the backfill both import `computeSemanticFindingId` from `scripts/lib/findings-semantic-id.mjs` (single source of truth — verified by grep/import graph).
3. Running `node scripts/backfill-finding-ids.mjs` with no flags (or `--dry-run`) exits 0, mutates zero rows, and writes a report listing every candidate row with `{old_id, new_id, normalized_content_hash}`.
4. The CLI refuses to mutate without `--apply --confirm-apply`; missing either exits non-zero before any SQL is issued.
5. The script acquires a Postgres advisory lock before processing; a second concurrent invocation exits non-zero with a clear "backfill already running" message and mutates nothing.
6. Each batch is committed in a single transaction; simulating a failure mid-batch (mock repo throws) leaves the batch uncommitted and the durable cursor (`--resume-after-pk`) at the last committed PK.
7. When two distinct legacy rows compute to the same new ID, the run aborts with non-zero exit, the batch is rolled back, and both rows (PK + normalized content hash) are printed and written to the report.
8. The FK introspection gate refuses `--apply` (exit 3) when a table references `audit_findings.id` without `ON UPDATE CASCADE` and is not in the explicit dependent allow-list; `--dry-run` still completes and surfaces the blocker.
9. After `--apply`, the post-run validation asserts: (a) total `audit_findings` row count is unchanged from pre-run; (b) zero rows satisfy `id != computeSemanticFindingId(row)` and zero rows have `NULL` id; (c) `assertNoOrphans` passes on every dependent table. Any failure exits non-zero (exit 5).
10. Re-running `--apply` immediately after a successful `--apply` produces zero updates (idempotency invariant) and exits 0.
11. Every query in the repo module is parameterized; a CI grep finds no SQL string concatenation of user-controlled values; identifier names only appear from a module-level constant allow-list.
12. `--limit N` processes exactly N candidate rows and exits 0; `--resume-after-pk P` continues strictly after PK `P` (no row skipped, no row duplicated).
13. The unit-test suite for `computeSemanticFindingId` proves injectivity on a generated corpus of ≥10,000 distinct normalized findings (no two distinct inputs share an ID).
14. The orchestrator test suite exercises failure modes F1–F8 with an in-memory mock repo and asserts the documented exit code and side-effect (or absence) for each.
15. The audit-log report file is created with mode `0o600`, is append-only during the run, and contains one JSONL record per applied row including `{row_pk, old_id, new_id, normalized_content_hash, batch, ts}`.

### output-2

## Overview

This plan defines a one-shot backfill script that recomputes the `semantic_finding_id` field for every row in the `audit_findings` table whose value was produced by an older (legacy) algorithm. The new algorithm is already implemented in the `findings` domain as `computeSemanticFindingId`; the backfill reads rows in batches, recomputes the ID using the current function, and writes back only rows whose ID differs from the stored value. The script respects existing invariants around persistence safety (atomic writes, dry-run, idempotency) and security (environment-variable–based database connection, no hard-coded secrets).

## Design Decisions

1. **Batch processing with tamper-evident cursor**  
   The script processes rows in batches of 250, ordered by `id` (primary key). Each batch persists a checkpoint `(last_processed_id, batch_count)` to a side-table or file so that interrupted runs can resume without re-scanning the entire table. The cursor is updated only after a batch commits successfully.

2. **Dry-run mode and idempotency**  
   By default the script runs in `--dry-run` mode: it computes the new ID, compares to the stored value, logs the diff, but performs no writes. A `--commit` flag enables writes. Because the operation is equality-based (`SET semantic_finding_id = new_id WHERE id = $1 AND semantic_finding_id <> new_id`), re-running after a partial commit is safe — already-migrated rows are skipped.

3. **Single responsibility: backfill only**  
   The script does NOT modify the `computeSemanticFindingId` function, the schema, or any production read/write path. It lives in `scripts/` as a standalone job, importable but not invoked by the main audit loop.

4. **Reuse existing symbols and layers**  
   - `computeSemanticFindingId` from `scripts/lib/findings.mjs` (domain: `findings`)  
   - Database connection helper `getDbPool` from `scripts/lib/db.mjs` (domain: `shared-lib`)  
   - Logger from `shared-lib` (if available; otherwise minimal `console` with structured JSON)  
   - Respects the domain map: the script can depend on `findings`, `shared-lib`, and `scripts` (no cross-domain violation).

5. **Acceptance testing via contract**  
   The script will be designed so its core logic (ID diff and batch loop) can be tested with an injected database adapter. A companion unit test file verifies the mapping, dry-run logging, and resume behavior.

6. **Minimal deployment surface**  
   No new npm package, no new infra. The script is a single `.mjs` file run manually or via a cron-like scheduler. It reads the same `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` environment variables used by the rest of the system.

## File-Level Plan

### Create

- **`scripts/backfill-semantic-finding-ids.mjs`**  
  Purpose: Backfill entry point. Parses CLI flags (`--dry-run` / `--commit`, `--batch-size`), imports `computeSemanticFindingId` and `getDbPool`, runs the batch loop with checkpointing, logs summary statistics.

- **`tests/backfill-semantic-finding-ids.test.mjs`**  
  Purpose: Unit + integration tests. Mocks database adapter to verify:
  - Dry-run does not mutate rows.
  - Changed rows are updated in commit mode.
  - Unchanged rows are skipped.
  - Checkpoint resume after simulated crash.
  - Batch-size boundary conditions.

### Modify

None (no existing files changed).

## Section 9 — Acceptance Criteria

1. Running `node scripts/backfill-semantic-finding-ids.mjs --dry-run` scans all `audit_findings` rows, computes the new semantic finding ID for each, and logs every row where the new ID differs from the stored ID, without modifying the database.
2. Running with `--commit` updates only rows where `semantic_finding_id` differs from the recomputed value; rows already matching are left untouched.
3. Processing is batched (default 250 rows per batch) and resumes from the last committed primary key after an interrupted run, without re-processing earlier rows.
4. The script exits with a non-zero code and a clear error message if the database connection fails or required environment variables are missing.
5. A summary is printed at exit containing: total rows scanned, rows updated, rows skipped, batches executed, and elapsed time.
6. The implementation imports `computeSemanticFindingId` from the `findings` domain and `getDbPool` from `shared-lib`; no logic is duplicated.
7. Unit tests in `tests/backfill-semantic-finding-ids.test.mjs` cover dry-run non-mutation, commit mutation, skip of identical rows, resume after interruption, and an edge case of an empty table.

## Target Paths

- `scripts/backfill-semantic-finding-ids.mjs`
- `tests/backfill-semantic-finding-ids.test.mjs`

## Risks

- **Legacy algorithm mismatch**: If the current `computeSemanticFindingId` produces an ID that is already present but the legacy algorithm is unknown, some rows may be left with the legacy ID. Risk is accepted; the backfill clearly distinguishes rows that diverge.
- **Long-running transaction**: Each batch commits inside its own transaction. A very large table may take a long time but will not block writes. Mitigation: batch size is configurable.
- **Concurrent writes**: If another process inserts rows with legacy IDs during the backfill, those rows will be missed. Mitigation: the script documents that it should be run during a maintenance window or after the backfill is repeated.
- **Checkpoint storage**: A simple file-based checkpoint (`/tmp/backfill_sem_id_checkpoint.json`) is used. On stateless container restarts the checkpoint may be lost, causing a full rescan. Acceptable for an infrequent one-shot job.

### output-3

# Implementation Plan — Backfill Semantic Finding IDs for Legacy `audit_findings`

## Overview

Add a safe, idempotent backfill job that scans existing `audit_findings` rows, recomputes each row’s canonical semantic finding ID using the same implementation used by the current findings creation path, and updates only rows whose stored semantic ID differs.

The job should be implemented as a script-level orchestration entry point with testable pure logic in the findings domain. It must default to dry-run mode, support explicit `--apply`, process rows in bounded batches, avoid logging sensitive finding content, and use compare-and-swap style updates so concurrent changes are not overwritten.

The smallest correct solution is:

1. Expose/reuse the canonical semantic finding ID computation from the existing findings module.
2. Add a pure helper that determines whether a row needs a backfill update.
3. Add a CLI backfill script that:
   - loads DB credentials through existing repository mechanisms,
   - scans `audit_findings` in batches,
   - validates required row fields,
   - computes the expected semantic ID,
   - reports dry-run changes,
   - applies updates only when `--apply` is passed,
   - updates rows conditionally against the previously-read value.
4. Add unit tests for the pure backfill decision logic and integration-style tests with a mocked DB adapter for CLI behavior.

## Design Decisions

### 1. Reuse the canonical semantic ID implementation

**Decision:** The backfill must call the same semantic ID computation used when new findings are persisted. If the existing helper is not exported, expose it from the existing findings module rather than duplicating the algorithm.

**Rationale:**

- Prevents future divergence between new writes and backfilled legacy rows.
- Makes the backfill a true repair job rather than a second source of truth.
- Keeps test fixtures focused on contract behavior, not duplicated hashing details.

### 2. Keep database orchestration in `scripts/`, not the findings library

**Decision:** Put the CLI job at `scripts/backfill-semantic-finding-ids.mjs`, and keep pure row/ID decision logic in `scripts/lib/findings-semantic-id-backfill.mjs`.

**Rationale:**

- `scripts/` is allowed to depend on findings, stores, and shared-lib.
- The findings-domain helper stays free of persistence concerns.
- The pure helper is straightforward to unit test without Supabase or network access.

### 3. Default to dry-run; require explicit `--apply`

**Decision:** Running the job without `--apply` must not mutate data.

**Rationale:**

- Backfills are persistence-sensitive.
- Operators can verify row counts, sample old/new IDs, skipped invalid rows, and collision warnings before making changes.
- Prevents accidental production mutation from local or CI usage.

### 4. Idempotent full-table scan with selective updates

**Decision:** The job should scan candidate rows and update only rows where `storedSemanticId !== recomputedSemanticId`.

**Rationale:**

- Handles rows with missing IDs and rows with legacy/wrong-format IDs.
- Safe to rerun after interruption.
- Avoids requiring a brittle legacy-format detector.

### 5. Compare-and-swap updates

**Decision:** Each apply update should include the row primary key and the previously observed semantic ID value as conditions.

Examples:

- If old value was `null`, update with `WHERE id = $id AND semantic_finding_id IS NULL`.
- If old value was non-null, update with `WHERE id = $id AND semantic_finding_id = $oldValue`.

**Rationale:**

- Prevents overwriting concurrent repairs or new writes.
- Makes race conditions visible as skipped/stale rows.
- Avoids needing broad table locks.

### 6. Bounded batching with resumability by rerun

**Decision:** Process rows in configurable batches, defaulting to a conservative size such as `100` or the repository’s existing batch default if one exists.

Supported CLI options should include:

- `--apply`
- `--batch-size <n>`
- `--limit <n>`
- `--audit-id <id>` if `audit_findings` has an audit/run scope column already used elsewhere
- `--only-missing` optional safety filter for rows where semantic ID is null/empty
- `--json` for machine-readable summary output if existing scripts support that convention

**Rationale:**

- Keeps memory and API usage bounded.
- A failed run can be safely rerun because already-correct rows become no-ops.
- Filtering by audit ID supports incremental rollout.

### 7. Explicit validation and failure modes

**Decision:** The pure helper should classify each row into one of:

- `noop` — stored ID already equals recomputed ID.
- `update` — row can be safely updated.
- `invalid` — required semantic ID input fields are missing or malformed.
- `error` — unexpected computation failure.

The CLI should fail the run on invalid rows by default, unless an explicit `--skip-invalid` option is used.

**Rationale:**

- Avoids silently generating unstable or low-quality IDs from incomplete rows.
- Makes operational failure modes observable.
- Prevents accidental partial corruption.

### 8. Do not log sensitive finding content

**Decision:** Logs and summaries should include counts, row primary keys, old/new semantic IDs, and error categories, but must not print raw finding text, evidence bodies, prompts, model outputs, or secrets.

**Rationale:**

- Findings may contain source code, credentials, paths, or proprietary review content.
- Backfill logs may be stored in CI or terminal history.

### 9. No schema migration unless the existing schema lacks the semantic ID column

**Decision:** This task should not add a new column. It should update the existing semantic finding ID column used by current writes.

**Rationale:**

- The task is a backfill of legacy data, not a schema expansion.
- Adding a new persistence contract would be over-engineered and risky.

If implementation discovers the current schema uses a different column name than `semantic_finding_id`, centralize that name as a constant in the findings/backfill module and use the existing schema name.

## Target Paths

- `scripts/backfill-semantic-finding-ids.mjs`
- `scripts/lib/findings-semantic-id-backfill.mjs`
- `scripts/lib/findings.mjs`
- `tests/findings-semantic-id-backfill.test.mjs`
- `tests/backfill-semantic-finding-ids.test.mjs`
- `package.json`

## File-Level Plan

### `scripts/backfill-semantic-finding-ids.mjs` — create

Purpose: CLI entry point for the backfill job.

Responsibilities:

- Parse CLI arguments using existing repository conventions where available.
- Enforce dry-run default; require `--apply` before mutation.
- Load the existing Supabase/store client through current project utilities.
- Query `audit_findings` in deterministic batches.
- Pass each row to the pure backfill helper.
- Print a concise summary:
  - scanned rows,
  - rows already correct,
  - rows needing update,
  - rows updated,
  - stale compare-and-swap skips,
  - invalid rows,
  - failed rows.
- In dry-run mode:
  - do not perform update calls,
  - print representative old/new ID samples without raw finding content.
- In apply mode:
  - update changed rows conditionally by primary key and old semantic ID value.
- Exit non-zero when:
  - credentials/configuration are missing,
  - required schema columns are unavailable,
  - invalid rows are found and `--skip-invalid` was not supplied,
  - any DB update fails unexpectedly,
  - CLI arguments are invalid.

Implementation shape:

- Keep DB access behind small local functions such as:
  - `fetchBatch({ afterCursor, batchSize, filters })`
  - `applySemanticIdUpdate({ id, oldValue, newValue })`
- Use keyset or stable ordering if supported by current schema, otherwise deterministic `created_at, id` ordering.
- Avoid adding new dependencies unless the repository already has a CLI parser/helper.

### `scripts/lib/findings-semantic-id-backfill.mjs` — create

Purpose: Pure, testable backfill decision logic in the findings domain.

Responsibilities:

- Export a function such as `classifySemanticFindingIdBackfill(row, options)`.
- Normalize the DB row into the input contract expected by the canonical semantic ID function.
- Validate required fields before computing the ID.
- Return a structured result object, for example:

  - `{ status: 'noop', id, semanticFindingId }`
  - `{ status: 'update', id, oldSemanticFindingId, newSemanticFindingId }`
  - `{ status: 'invalid', id, reason, missingFields }`

- Treat empty strings as missing legacy semantic IDs.
- Never mutate the input row.
- Never perform I/O.

Rationale:

- Unit tests can cover correctness without Supabase.
- The CLI remains mostly orchestration.
- Future repair jobs can reuse the classification helper.

### `scripts/lib/findings.mjs` — modify

Purpose: Ensure the canonical semantic finding ID computation is exported from the existing findings domain.

Required change:

- Locate the existing function or code path that computes semantic IDs for new findings.
- Export it under a stable name if not already exported, for example:
  - `computeSemanticFindingId`
  - or preserve the existing symbol name and import that from the backfill helper.
- If the semantic ID version/salt/prefix exists, export that too or expose it through the same function result.
- Do not change the algorithm as part of this task unless tests show the current write path is already inconsistent.

Rationale:

- Backfill must match production creation behavior exactly.
- Exporting the existing implementation is safer than copying hash/canonicalization logic.

### `tests/findings-semantic-id-backfill.test.mjs` — create

Purpose: Unit tests for pure row classification.

Test cases:

1. A row whose stored semantic ID equals the recomputed value returns `noop`.
2. A row with `null`, empty, or legacy semantic ID returns `update`.
3. A row with a wrong non-empty semantic ID returns `update`.
4. Missing required fields return `invalid`.
5. The helper does not include volatile DB fields in semantic ID computation.
6. The helper does not mutate the input row.
7. Output result objects do not contain raw finding body/evidence text.

Use fixed fixtures that reflect real `audit_findings` row shape.

### `tests/backfill-semantic-finding-ids.test.mjs` — create

Purpose: Integration-style tests for CLI orchestration using a mocked DB/store adapter.

Test cases:

1. Dry-run scans rows and reports updates but performs zero writes.
2. `--apply` writes only rows classified as `update`.
3. Already-correct rows are not written.
4. Invalid rows cause non-zero exit by default.
5. `--skip-invalid` skips invalid rows and reports them.
6. Compare-and-swap stale updates are reported and do not crash the whole run unless configured as strict.
7. `--limit` and `--batch-size` are honored.
8. Logs do not contain sensitive raw finding content.

### `package.json` — modify

Purpose: Add a discoverable npm script for the backfill.

Add a script such as:

- `backfill:semantic-finding-ids`

Expected usage examples to document in the script help output, not necessarily in package metadata:

- Dry run:
  - `npm run backfill:semantic-finding-ids`
- Apply:
  - `npm run backfill:semantic-finding-ids -- --apply`
- Limited rollout:
  - `npm run backfill:semantic-finding-ids -- --apply --limit 500 --batch-size 100`

## Operational Behavior

### Dry-run output

Dry-run should produce a summary similar to:

```text
semantic finding id backfill dry-run
scanned=1200 noop=900 update=295 invalid=5 errors=0
apply=false
```

For update samples, include only:

- row primary key,
- old semantic ID,
- new semantic ID.

Do not print finding title/body/evidence unless the existing logging policy explicitly allows sanitized titles.

### Apply output

Apply mode should produce:

```text
semantic finding id backfill apply
scanned=1200 noop=900 update_candidates=295 updated=292 stale=3 invalid=0 errors=0
```

`stale` means the row changed between read and write and was not overwritten.

## Data Contract

The backfill helper should use the same row fields currently used to create semantic IDs for new findings. The implementation should verify these fields against the existing creation path before coding.

Expected categories of semantic inputs are likely to include existing normalized finding attributes such as:

- finding/rule type,
- title or summary,
- affected file/path,
- location or symbol when part of the current semantic contract,
- severity/category if already included by current computation.

Fields that must not be used unless already part of the canonical implementation:

- database primary key,
- audit run ID,
- timestamps,
- model/provider names,
- raw prompt text,
- transient retry metadata.

## Persistence Safety

- No writes unless `--apply` is passed.
- Update only the semantic ID column, and only if the row’s old value still matches the value observed during scanning.
- Do not modify unrelated finding metadata.
- Use bounded batches.
- Make the job idempotent.
- Treat schema mismatch as a hard failure.
- Prefer explicit error summaries over silent skipping.

## Security Considerations

- Require the same privileged DB environment variables currently used by other maintenance scripts.
- Do not accept arbitrary SQL fragments from CLI flags.
- Use parameterized queries/client query builders only.
- Never log secrets, raw finding evidence, raw model outputs, or full row JSON.
- Keep dry-run safe for production use.

## Risks

1. **Canonical semantic ID function is not currently exported**
   - Mitigation: export the existing function from `scripts/lib/findings.mjs`; do not duplicate logic.

2. **Legacy rows may be missing required fields**
   - Mitigation: classify as `invalid`, report counts and IDs, fail by default.

3. **Semantic ID collisions**
   - Mitigation: surface DB unique constraint errors clearly; do not retry with alternate IDs because that would violate semantic determinism.

4. **Large table scan may be slow**
   - Mitigation: bounded batches, `--limit`, optional `--audit-id`, idempotent reruns.

5. **Concurrent writers may update rows during backfill**
   - Mitigation: compare-and-swap conditional updates; report stale rows.

6. **Accidental production mutation**
   - Mitigation: dry-run default and explicit `--apply`.

7. **Sensitive content exposure through logs**
   - Mitigation: structured summaries and sanitized samples only.

## Section 9 — Acceptance Criteria

1. Running `npm run backfill:semantic-finding-ids` performs a dry run and makes zero database updates.
2. Running the backfill with `--apply` updates only `audit_findings` rows whose stored semantic finding ID differs from the canonical recomputed value.
3. The backfill uses the same semantic ID computation exported from the existing findings implementation used by new finding writes.
4. The job is idempotent: running it a second time after a successful apply reports the updated rows as no-ops.
5. Each database update is conditional on the row primary key and the previously observed semantic ID value, preventing stale overwrites.
6. Rows missing required semantic ID input fields are reported as invalid and cause a non-zero exit unless `--skip-invalid` is explicitly supplied.
7. The job processes rows in configurable bounded batches and supports a `--limit` option for controlled rollout.
8. Logs and test snapshots do not contain raw finding body, raw evidence, prompt text, secrets, or full row JSON.
9. Unit tests cover `noop`, `update`, and `invalid` classification outcomes for representative `audit_findings` fixtures.
10. CLI tests verify dry-run behavior, apply behavior, batching/limit behavior, invalid-row behavior, and stale compare-and-swap handling with a mocked DB adapter.
11. No database schema migration is introduced for this task unless implementation proves the semantic ID column does not already exist, in which case the task must stop for explicit schema review.
12. The implementation respects the existing domain boundaries: pure semantic/backfill logic remains in findings/shared code, while DB orchestration remains in the top-level `scripts/` entry point.

