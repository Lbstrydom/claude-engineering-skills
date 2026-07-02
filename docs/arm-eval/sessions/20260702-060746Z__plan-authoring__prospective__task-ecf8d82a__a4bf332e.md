# Arm-eval session a4bf332e-8d59-4f52-ba18-3cf304097905

| Field | Value |
|---|---|
| Experiment | plan-authoring |
| Phase | prospective |
| Task id | `task-ecf8d82a` |
| Seed (presentation-order RNG) | 15 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T06:07:46.017Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | FULL (attribution + judgments) |

## Task

Build a health-check command that verifies AUDIT_DB_URL connectivity and reports pool stats

## Arms + outputs

### Arm GPT

- Models: `{"models":["latest-gpt"],"resolved":"latest-gpt"}`
- Conformant: true
- Output hash: `148aa8d1316cdeae`

# Implementation Plan — AUDIT_DB_URL Health Check Command

## Overview

Add a small CLI health-check command that validates `AUDIT_DB_URL` is configured, opens a PostgreSQL connection through the audit DB pool mechanism, executes a lightweight readiness query, reports pool statistics, and exits with machine-usable status codes.

The implementation should be right-sized: one CLI wrapper plus one testable library module. It should avoid schema changes, avoid writes, avoid leaking credentials, and make failure modes explicit for CI/ops usage.

## Target Paths

- `scripts/audit-db-health.mjs`
- `scripts/lib/audit/db-health.mjs`
- `tests/audit-db-health.test.mjs`
- `package.json`
- `package-lock.json`

## Design Decisions

### 1. Provide a dedicated command: `scripts/audit-db-health.mjs`

**Decision:** Create a new executable script named `scripts/audit-db-health.mjs`.

**Rationale:**

- The existing domain map routes `scripts/audit-*.mjs` into `audit-orchestration`, which matches the feature.
- Keeps the command discoverable and consistent with existing script naming.
- Avoids coupling this operational check to unrelated audit execution commands.

The command should be runnable directly:

```bash
node scripts/audit-db-health.mjs
```

And via package script:

```bash
npm run audit:db:health
```

### 2. Put health-check logic in a reusable/testable module

**Decision:** Create `scripts/lib/audit/db-health.mjs` with exported pure-ish functions and dependency injection points.

**Rationale:**

- Keeps CLI parsing/output separate from connection behavior.
- Enables unit tests with fake pool implementations, avoiding live database dependency.
- Fits `scripts/lib/audit/**` domain ownership.

Expected exported responsibilities:

- validate and redact `AUDIT_DB_URL`
- run the health check
- collect pool stats
- normalize errors into a safe contract
- format human-readable and JSON output

### 3. Reuse existing audit DB/pool symbols if present

**Decision:** Before implementing direct `pg.Pool` creation, inspect existing audit persistence/database modules and reuse their pool factory/client helper if one already exists.

**Rationale:**

- The task specifically asks to report pool stats; if the repository already centralizes audit DB pooling, the command should report stats from that implementation rather than duplicating connection behavior.
- Preserves existing invariants around SSL, timeouts, and env parsing.
- Prevents drift between the health check and actual audit DB usage.

Fallback if no existing audit DB pool helper exists:

- Use `pg.Pool` directly.
- Configure it from `AUDIT_DB_URL`.
- Use a minimal health-check pool with `max: 1`.
- Report the local pool stats clearly as command-local pool stats.

### 4. Use a read-only readiness query

**Decision:** Verify connectivity with a lightweight query such as:

```sql
select 1 as ok
```

**Rationale:**

- Confirms connection establishment, authentication, database reachability, and basic query execution.
- Avoids writes and avoids dependence on audit schema existence.
- Safer than checking application tables for this narrow health check.

### 5. Define an explicit result contract

**Decision:** The health check should produce a stable result object.

Recommended JSON shape:

```json
{
  "ok": true,
  "status": "ok",
  "timestamp": "2026-07-02T00:00:00.000Z",
  "target": {
    "protocol": "postgresql:",
    "host": "db.example.com",
    "port": "5432",
    "database": "audit",
    "username": "audit_user"
  },
  "latencyMs": 42,
  "pool": {
    "totalCount": 1,
    "idleCount": 1,
    "waitingCount": 0,
    "max": 1
  }
}
```

Failure shape:

```json
{
  "ok": false,
  "status": "error",
  "timestamp": "2026-07-02T00:00:00.000Z",
  "error": {
    "type": "connection",
    "code": "ECONNREFUSED",
    "message": "connect ECONNREFUSED db.example.com:5432"
  },
  "pool": {
    "totalCount": 0,
    "idleCount": 0,
    "waitingCount": 0,
    "max": 1
  }
}
```

**Rationale:**

- Stable machine-readable contract for CI and monitoring.
- Human output can be derived from the same object.
- Explicit pool stats support the requested operational visibility.

### 6. Support human output by default and JSON output for automation

**Decision:** Default output should be concise human-readable text. Add `--json` for machine-readable output.

Examples:

```bash
node scripts/audit-db-health.mjs
node scripts/audit-db-health.mjs --json
node scripts/audit-db-health.mjs --timeout-ms 10000
```

**Rationale:**

- Human output is useful for local debugging.
- JSON is useful for CI, dashboards, and future automation.
- Keeps command surface small.

### 7. Use deterministic exit codes

**Decision:** Use explicit exit codes:

- `0`: health check succeeded
- `1`: `AUDIT_DB_URL` was configured but connectivity/query failed
- `2`: configuration or invocation error, such as missing/invalid `AUDIT_DB_URL` or invalid CLI args

**Rationale:**

- Lets CI distinguish misconfiguration from a real database connectivity failure.
- Keeps behavior predictable.

### 8. Do not leak secrets

**Decision:** Never print the raw `AUDIT_DB_URL`, password, query stack trace, or full connection string.

Sanitization rules:

- Do not include password in `target`.
- Do not print the full URL.
- If an error message contains the exact raw URL, replace it with `[REDACTED_AUDIT_DB_URL]`.
- If an error message contains the decoded or encoded password, replace it with `[REDACTED_PASSWORD]`.
- Do not print stack traces unless the repository already has a standard debug flag; if adding one, it must still redact secrets.

**Rationale:**

- `AUDIT_DB_URL` likely contains credentials.
- Health checks are often run in CI logs where accidental leakage is high impact.

### 9. Avoid persistence side effects

**Decision:** The command must not create tables, run migrations, insert rows, update rows, or delete rows.

**Rationale:**

- A health check should be safe to run repeatedly.
- Avoids violating persistence safety invariants.

## File-Level Plan

### `scripts/lib/audit/db-health.mjs` — create

Purpose: Testable implementation of the audit DB health check.

Planned responsibilities:

1. Export `runAuditDbHealthCheck(options)`.
2. Export output helpers if useful:
   - `formatAuditDbHealthText(result)`
   - `redactAuditDbUrl(value, rawUrl)`
   - `parseAuditDbTarget(rawUrl)`
3. Accept injected dependencies for testability:
   - `env`
   - `poolFactory`
   - `now`/timer source
   - timeout value
4. Validate `AUDIT_DB_URL`:
   - missing/blank => configuration failure
   - malformed URL => configuration failure
   - unsupported protocol => configuration failure
5. Create or obtain a pool:
   - prefer existing repository audit DB pool helper if present
   - otherwise instantiate `pg.Pool`
6. Execute `select 1 as ok`.
7. Measure elapsed time.
8. Capture pool stats:
   - `totalCount`
   - `idleCount`
   - `waitingCount`
   - `max` where available
9. Always attempt to close command-owned pools in `finally`.
10. Return normalized result object without throwing for expected health-check failures.
11. Throw only for programmer errors, not database health failures.

Important implementation notes:

- If a shared existing pool is reused, do not close it unless its existing contract says the caller owns shutdown.
- If the command creates the pool, it must call `pool.end()`.
- Use a timeout guard so a hung network attempt does not hang the command indefinitely.
- Default timeout should be conservative, e.g. `5000ms`.
- Pool stats should be sampled after the query and before closing the pool.

### `scripts/audit-db-health.mjs` — create

Purpose: CLI entry point.

Planned responsibilities:

1. Parse supported args:
   - `--json`
   - `--timeout-ms <number>`
   - `--help`
2. Reject unknown args with exit code `2`.
3. Call `runAuditDbHealthCheck({ env: process.env, timeoutMs })`.
4. Print result:
   - JSON to stdout when `--json` is present
   - human-readable text otherwise
5. Print unexpected invocation/runtime errors to stderr after sanitization.
6. Set `process.exitCode` based on result:
   - `0` on success
   - `1` on connectivity/query failure
   - `2` on config or CLI failure

CLI human output should include:

- status
- redacted target host/database/user
- latency
- pool stats
- sanitized error summary on failure

It must not print the raw `AUDIT_DB_URL`.

### `package.json` — modify

Purpose: Add a discoverable package script.

Planned change:

```json
{
  "scripts": {
    "audit:db:health": "node scripts/audit-db-health.mjs"
  }
}
```

If the repository already has a naming convention for health scripts, use the closest existing convention, but keep the direct script path valid.

Dependency handling:

- If `pg` is already present, do not add a new dependency.
- If no PostgreSQL client dependency exists and no existing audit DB helper abstracts it, add `pg` as the minimal runtime dependency needed to connect to `AUDIT_DB_URL`.

### `package-lock.json` — modify if needed

Purpose: Keep dependency lockfile consistent.

Planned change:

- Only update if adding `pg` or if the repository’s package manager requires lockfile changes after modifying package scripts.
- Do not manually edit beyond package manager generated changes.

### `tests/audit-db-health.test.mjs` — create

Purpose: Unit tests for the health-check module and CLI behavior where practical.

Test coverage:

1. Missing `AUDIT_DB_URL`:
   - returns `ok: false`
   - error type is configuration-related
   - pool factory is not called
   - exit code mapping is `2`
2. Invalid URL:
   - returns configuration failure
   - does not attempt DB connection
3. Successful check using fake pool:
   - executes readiness query
   - returns `ok: true`
   - includes latency
   - includes pool stats
   - closes command-owned pool
4. Query failure using fake pool:
   - returns `ok: false`
   - error type is connection/query-related
   - includes sanitized message
   - closes command-owned pool
5. Secret redaction:
   - password in `AUDIT_DB_URL` is not present in formatted text
   - password is not present in JSON result
   - raw URL is not present in error output
6. Timeout behavior:
   - hanging fake query returns timeout failure
   - command does not hang indefinitely
7. CLI JSON mode:
   - stdout is valid JSON
   - exit code matches health result

Avoid requiring a live database in unit tests. If an integration test is desired, gate it explicitly behind an environment variable such as `RUN_AUDIT_DB_INTEGRATION=1`.

## Failure Modes and Handling

| Failure mode | Behavior |
|---|---|
| `AUDIT_DB_URL` missing or blank | Return config error, exit `2` |
| `AUDIT_DB_URL` malformed | Return config error, exit `2` |
| Unsupported URL protocol | Return config error, exit `2` |
| PostgreSQL client dependency missing | Return implementation/runtime error with safe message, exit `1`, or prevent via dependency update |
| DNS/network/auth failure | Return connectivity error, exit `1` |
| Query timeout | Return timeout error, exit `1` |
| Readiness query fails | Return query error, exit `1` |
| Pool stats unavailable | Still report connectivity result; include `null` or omit unavailable stat fields |
| Pool cleanup fails | Report warning/cleanup status without leaking secrets; ensure process can terminate |
| Unknown CLI arg | Print usage, exit `2` |

## Security and Persistence Safety

- Do not print raw database URLs.
- Do not print passwords in text or JSON.
- Do not print stack traces by default.
- Run only a read-only constant query.
- Do not introspect tables or schema.
- Do not write files.
- Do not mutate environment variables.
- Do not leave command-owned pools open.

## Testability Strategy

- Keep health check logic independent from `process`.
- Inject fake pools for deterministic tests.
- Inject timers or timeout values for fast timeout tests.
- Keep formatting functions deterministic.
- Test redaction directly with URLs containing:
  - plain passwords
  - URL-encoded passwords
  - special characters
- Do not require external network access in default test suite.

## Risks

1. **Pool stats may be command-local rather than application-global.**  
   If no existing shared audit DB pool exists, the command-created pool stats will describe the health-check pool only. Mitigation: label output clearly or reuse the existing audit pool helper if present.

2. **SSL behavior may differ from production audit DB usage.**  
   Mitigation: reuse existing connection helper if available; otherwise rely on the standard PostgreSQL URL/client behavior and document expected env configuration.

3. **Secret leakage through driver error messages.**  
   Mitigation: sanitize raw URL, decoded password, and encoded password from all emitted error fields.

4. **Hanging connections in degraded networks.**  
   Mitigation: enforce timeout via pool/client settings plus an outer promise timeout guard.

5. **Dependency drift if adding `pg`.**  
   Mitigation: add only if not already available and update lockfile through the repository’s package manager.

## Section 9 — Acceptance Criteria

1. Running `node scripts/audit-db-health.mjs` with a valid `AUDIT_DB_URL` exits with code `0`.
2. A successful run executes a read-only readiness query and reports `ok`/success status.
3. A successful run reports pool stats including at least `totalCount`, `idleCount`, and `waitingCount` when available.
4. Running with `--json` prints valid JSON to stdout.
5. JSON output contains a stable top-level `ok` boolean.
6. JSON output includes sanitized target metadata but does not include the raw `AUDIT_DB_URL`.
7. Human-readable output does not include the raw `AUDIT_DB_URL`.
8. Passwords from `AUDIT_DB_URL`, including URL-encoded passwords, are not present in stdout or stderr.
9. Missing `AUDIT_DB_URL` exits with code `2`.
10. Invalid `AUDIT_DB_URL` exits with code `2`.
11. Connectivity, authentication, timeout, or query failures exit with code `1`.
12. The command always attempts to close any pool it creates.
13. The health check performs no database writes and does not require audit schema tables to exist.
14. `npm run audit:db:health` invokes the health-check command.
15. Unit tests cover success, missing config, invalid config, query failure, timeout, pool cleanup, JSON output, and secret redaction.
16. Default tests do not require a live database connection.

### Arm OSS-DS

- Models: `{"models":["deepseek/deepseek-v4-pro"],"resolved":"deepseek/deepseek-v4-pro"}`
- Conformant: true
- Output hash: `53350604fd02716f`

## Overview
Build a standalone CLI health-check command (`scripts/audit-health.mjs`) that validates connectivity to the database referenced by `AUDIT_DB_URL` and reports the connection pool statistics of the temporary pool it creates. The command is designed for operational monitoring (e.g., Kubernetes readiness probes, CI smoke tests). It uses the existing database utility from `shared-lib` to create a pool, runs a lightweight query, and outputs human-readable or JSON stats. The script is placed in a new architectural domain `audit-health` to avoid polluting `audit-orchestration` and to follow the existing pattern of isolated health-check domains (e.g., `memory-health`).

## Design Decisions

1. **Standalone temporary pool**  
   The command creates its own ephemeral pool (max 1 connection) rather than tapping into the long-lived pool of the audit orchestration. This avoids coupling to the application’s lifecycle, keeps the health check self-contained, and eliminates the risk of disturbing production connections. The pool stats reported are the statistics of this temporary pool, which is sufficient to prove that the environment variable is valid and that the database accepts connections.

2. **Reuse existing `shared-lib` database utility**  
   The script imports `getPool` (or `createPool`) from `scripts/lib/db.mjs` – the existing module that is already responsible for creating pools for audit and other subsystems. This avoids duplicating connection logic, respects the single source of truth, and keeps the health check aligned with how the application itself connects.

3. **Output format**  
   Default output is human-readable text, suitable for manual inspection. A `--json` flag switches to a JSON document with keys `status`, `poolStats`, and an optional `error`. This makes the command consumable by both humans and automation.

4. **Exit codes**  
   Exit 0 on success, 1 on any failure (missing env var, connection error, query error). This is the standard contract for health-check probes.

5. **New domain `audit-health`**  
   The domain map is updated to include a rule `"scripts/audit-health.mjs" → "audit-health"` and an `allowedDeps` entry granting `audit-health` access to `shared-lib`. This follows the precedent set by `memory-health` and keeps the architectural boundaries clean.

6. **No persistence nor mutation**  
   The command only reads `AUDIT_DB_URL`, creates a transient pool, runs a read-only query, and then closes the pool. It does not store any state, satisfying all active safety and persistence invariants.

## File-Level Plan

| File | Action | Purpose |
|------|--------|---------|
| `scripts/audit-health.mjs` | **Create** | The main CLI script. It parses arguments (`--json`), reads `AUDIT_DB_URL`, imports `getPool` from `scripts/lib/db.mjs`, creates a pool, runs `SELECT 1`, harvests `pool.totalCount`, `pool.idleCount`, `pool.waitingCount`, `pool.options.max`, and formats output. On error it prints the error message and exits 1. |
| `domain-map.json` | **Modify** | Add `"audit-health"` to `allowedDeps` with `["shared-lib"]`. Insert a rule `{"pattern": "scripts/audit-health.mjs", "domain": "audit-health"}` early in the `rules` array (before the catch-all `"scripts/audit-*.mjs"` pattern) to correctly classify the new file. |
| `scripts/lib/db.mjs` | **No change** (assumed existing) | The existing shared database utility, expected to export a function like `getPool` or `createPool`. If absent, the plan adapts to create a minimal wrapper in the same file, but the architecture map strongly suggests it already exists. |

## Risks

- **Missing `AUDIT_DB_URL`**: The script will exit with code 1 and a clear message. This is an expected operational failure.
- **Database unreachable**: Connection timeout or refusal will be captured by the pool creation or query, producing a non-zero exit and a descriptive error.
- **Pool stat accuracy**: The temporary pool has at most 1 connection; `totalCount` and `idleCount` will reflect that. This is acceptable for a connectivity check; if the requirement evolves to report the application’s true pool state, the health check would need to import the long-lived pool, which introduces coupling and startup dependency.
- **Domain map conflict**: The new rule `scripts/audit-health.mjs` must be placed before `scripts/audit-*.mjs` in the rules array (first-match wins). Failure to do so would classify the script under `audit-orchestration`, violating the intended domain boundary. The plan explicitly includes this ordering step.

## Target Paths
- `scripts/audit-health.mjs`
- `domain-map.json`

## Section 9 — Acceptance Criteria
1. Running `node scripts/audit-health.mjs` with a valid `AUDIT_DB_URL` prints a human-readable summary including “Status: OK” and pool stats (total, idle, waiting, max) and exits with code 0.
2. Running with `--json` outputs a JSON object with keys `status`, `poolStats`, and `error` (null on success), and exits with code 0.
3. When `AUDIT_DB_URL` is unset or empty, the script prints a clear error message and exits with code 1.
4. When the database is unreachable or the query fails, the script prints the error details, exits with code 1, and in JSON mode includes the error message in the `error` field.
5. The script creates a temporary pool that does not remain open after the command finishes (no leaked connections).
6. The domain map correctly classifies `scripts/audit-health.mjs` under `audit-health` and allows it to depend on `shared-lib`.

### Arm OSS-GLM

- Models: `{"models":["z-ai/glm-5.2"],"resolved":"z-ai/glm-5.2"}`
- Conformant: true
- Output hash: `3262286da4c9fd03`

# Implementation Plan: AUDIT_DB_URL Health-Check Command

## Overview

Add a focused CLI command (`scripts/audit-db-health.mjs`) that verifies connectivity to the database identified by `AUDIT_DB_URL` and reports connection-pool statistics. The command reuses the existing audit-orchestration DB helpers where available, performs a lightweight `SELECT 1` probe, queries the `pg` pool for live stats, prints a structured report to stdout, and exits non-zero on failure so it can be wired into CI or cron.

---

## Design Decisions

1. **Placement in `audit-orchestration` domain.** The glob rule `scripts/audit-*.mjs → audit-orchestration` already captures audit-related entry points. Naming the file `audit-db-health.mjs` keeps it within that domain and avoids the `check-*.mjs` → `install` rule that would misclassify it.

2. **Reuse existing pool/client factory.** If `scripts/lib/audit/` or `scripts/lib/store/` already exports a pool factory keyed on `AUDIT_DB_URL`, the health check imports it rather than constructing a second `pg.Pool`. A second pool would mask real connection-count issues and double the max-connection budget. If no such factory exists, the script creates a short-lived `pg.Pool` with conservative defaults (`max: 2`, `connectionTimeoutMillis: 5000`) and closes it before exit.

3. **Probe strategy: `SELECT 1` + pool stats.** `SELECT 1` is the cheapest round-trip that exercises authentication, TLS negotiation, and query execution. Pool stats (`totalCount`, `idleCount`, `waitingCount`) are read directly from the `pg.Pool` instance. We also issue `SELECT count(*) FROM pg_stat_activity WHERE state = 'active'` when the user is a superuser/owner, but degrade gracefully (ignore permission errors) since not all deployments grant `pg_stat_activity` access.

4. **Structured output, machine-parseable.** Default output is human-readable text. A `--json` flag emits a JSON object on stdout for programmatic consumption. Exit code 0 = healthy, 1 = connectivity failure, 2 = configuration error (missing/invalid `AUDIT_DB_URL`).

5. **No secrets in output.** The connection string is never printed; only host and database name are surfaced (parsed from the URL). This satisfies `[REQ-security-b0b533cc]` / `[REQ-security-d55680e9]` style invariants around secret redaction.

6. **Timeout-bounded.** Both the connection probe and the pool-stats query are bounded by `connectionTimeoutMillis` (5 s) and a `Promise.race` watchdog (10 s) so the command never hangs in CI.

7. **Right-sized scope.** This is a read-only diagnostic — no migrations, no writes, no schema introspection beyond the optional `pg_stat_activity` count. Over-engineering (full DB dashboard, latency histograms, multi-target probes) is deliberately rejected.

---

## File-Level Plan

### New files

| File | Create | Purpose |
|---|---|---|
| `scripts/audit-db-health.mjs` | Create | CLI entry point. Parses `--json` flag, loads `AUDIT_DB_URL` from env, delegates to the health-check lib, prints results, sets exit code. |
| `scripts/lib/audit/db-health.mjs` | Create | Pure function module: `checkAuditDbHealth(url, options)` → returns `{ ok, latencyMs, pool: { total, idle, waiting }, activeSessions, error }`. No I/O side-effects beyond the DB probe; no `console.log` (caller handles output). |
| `tests/audit-db-health.test.mjs` | Create | Unit tests for `checkAuditDbHealth`: mock `pg.Pool`, assert exit-code logic, assert redaction of secrets, assert timeout behaviour, assert `--json` output shape. |

### Modified files

| File | Modify | Purpose |
|---|---|---|
| `package.json` | Modify | Add `"audit-db-health"` to the `scripts` section (e.g. `"audit-db-health": "node scripts/audit-db-health.mjs"`) and add test entry if a test runner script convention exists. |

---

## Detailed Design

### `scripts/lib/audit/db-health.mjs`

**Exported function:**

```
checkAuditDbHealth(connectionString, { timeoutMs = 5000, poolMax = 2 } = {}) → Promise<HealthResult>
```

**HealthResult contract:**

```typescript
{
  ok: boolean,
  latencyMs: number | null,
  pool: { total: number, idle: number, waiting: number } | null,
  activeSessions: number | null,   // null if permission denied
  host: string,                     // safe-to-print host
  database: string,                 // safe-to-print db name
  error: string | null,
  timedOut: boolean
}
```

**Internal flow:**

1. Validate `connectionString` is a parseable URL; throw a typed `ConfigError` if missing/malformed.
2. Extract `host` and `database` from the URL for safe reporting.
3. Construct (or reuse) `pg.Pool` with `max: poolMax`, `connectionTimeoutMillis: timeoutMs`.
4. `Promise.race` between `pool.query('SELECT 1')` and a `timeoutMs` watchdog.
5. On success, read `pool.totalCount`, `pool.idleCount`, `pool.waitingCount`.
6. Attempt `pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active'")`; catch permission errors and set `activeSessions = null`.
7. `await pool.end()` — always, in a `finally`.
8. Return `HealthResult`.

### `scripts/audit-db-health.mjs`

**Flow:**

1. `parseArgs(process.argv.slice(2))` → `{ json: boolean }`.
2. Read `process.env.AUDIT_DB_URL`. If absent → print error, `process.exit(2)`.
3. `await checkAuditDbHealth(url, { timeoutMs: 5000 })`.
4. If `--json`: `console.log(JSON.stringify(result, null, 2))`.
5. Else: human-readable multi-line report.
6. `process.exit(result.ok ? 0 : 1)`.

### `tests/audit-db-health.test.mjs`

- **happy path:** mock `pg.Pool` to return `{ rows: [{ '?column?': 1 }] }`, assert `ok === true`, `latencyMs >= 0`, pool stats present.
- **connection failure:** mock `pool.query` to reject with a connection error, assert `ok === false`, `error` is set, exit code 1.
- **timeout:** mock `pool.query` to hang, assert `timedOut === true`, `ok === false`.
- **missing env:** assert exit code 2 when `AUDIT_DB_URL` is unset.
- **secret redaction:** assert output never contains password or full connection string.
- **`pg_stat_activity` permission denial:** mock rejection with `permission denied`, assert `activeSessions === null`, `ok` still true.

---

## Failure Modes

| Failure | Detection | Behaviour |
|---|---|---|
| `AUDIT_DB_URL` unset | Env check before any I/O | Exit 2, clear message |
| `AUDIT_DB_URL` malformed | `new URL()` throws | Exit 2, message includes parse error |
| Network unreachable / DB down | `pool.query` rejects | Exit 1, `error` contains safe message |
| Auth failure | `pool.query` rejects with auth error | Exit 1, password never surfaced |
| Query hangs | `Promise.race` watchdog fires | Exit 1, `timedOut: true` |
| `pg_stat_activity` denied | Query rejects with permission error | `activeSessions: null`, overall health unaffected |
| `pg` not installed | Import throws | Caught at top-level, exit 2 with install hint |

---

## Security & Persistence Safety

- **Read-only:** No `INSERT`/`UPDATE`/`DELETE`/`DDL` issued. The only queries are `SELECT 1` and a `SELECT count(*)` from a system view.
- **No persistence:** Nothing is written to disk, no state files, no DB rows modified.
- **Secret redaction:** Connection string is parsed via `URL` API; only `host` and `pathname` (database name) are surfaced. Password component is never logged, even in `--json` mode.
- **Pool cleanup:** `pool.end()` is guaranteed in a `finally` block to avoid leaking connections.
- **Minimal privileges:** The command works with a read-only DB role; superuser is only needed for `pg_stat_activity` and degrades gracefully.

---

## Risks

1. **Existing pool factory mismatch.** If `scripts/lib/audit/` already has a shared `pg.Pool` singleton, importing it here means the health check shares that pool's stats (which is desirable) but also its lifecycle (the script must not call `pool.end()` on a shared pool). *Mitigation:* detect whether the factory returns a singleton vs. a disposable instance; only call `end()` on pools the script created.

2. **`pg` dependency availability.** If `pg` is not a direct dependency (only transitive via another package), a future dedupe could break the import. *Mitigation:* verify `pg` is a direct dependency in `package.json`; if not, add it.

3. **Postgres-specific assumptions.** `pg_stat_activity` is Postgres-specific. If `AUDIT_DB_URL` ever points to a non-Postgres engine, the active-sessions query will fail. *Mitigation:* degrade gracefully (already planned); consider detecting engine from URL scheme in a future iteration if needed.

4. **Pool stats accuracy.** `pg.Pool`'s `totalCount`/`idleCount`/`waitingCount` reflect only this process's pool, not server-side totals. The report should label them as "client-side pool stats" to avoid confusion with server-side `max_connections`.

---

## Target Paths

- `scripts/audit-db-health.mjs` (create)
- `scripts/lib/audit/db-health.mjs` (create)
- `tests/audit-db-health.test.mjs` (create)
- `package.json` (modify — add script entry)

## Section 9 — Acceptance Criteria

1. Running `node scripts/audit-db-health.mjs` with a valid `AUDIT_DB_URL` env var exits with code 0 and prints a report containing connection status, latency, and pool stats (`total`, `idle`, `waiting`).
2. Running the command with `AUDIT_DB_URL` unset exits with code 2 and prints a clear configuration error message.
3. Running the command with an unreachable/invalid `AUDIT_DB_URL` exits with code 1 and prints an error message that does **not** contain the password or full connection string.
4. The `--json` flag produces valid, parseable JSON on stdout matching the `HealthResult` contract (`ok`, `latencyMs`, `pool`, `activeSessions`, `host`, `database`, `error`, `timedOut`).
5. A query that hangs beyond the timeout threshold (5 s default) results in exit code 1 with `timedOut: true` in the output.
6. If `pg_stat_activity` access is denied, `activeSessions` is `null` and the overall health result is still `ok: true` (connectivity passed).
7. The command issues no writes (no `INSERT`/`UPDATE`/`DELETE`/`DDL`) — verifiable by query log inspection during a test run.
8. All `pg.Pool` instances created by the command are closed via `pool.end()` before the process exits, verifiable by asserting zero open handles in the test suite.
9. Unit tests in `tests/audit-db-health.test.mjs` cover: happy path, connection failure, timeout, missing env, secret redaction, and `pg_stat_activity` permission denial — all passing.
10. The file `scripts/audit-db-health.mjs` is classified under the `audit-orchestration` domain by the existing `domain-map.json` glob rules (no new domain-map entry required).

## Judge scores (blinded at judge time; unblinded here post-ranking)

| Pass | Label | Arm | Scores |
|---|---|---|---|
| 1 | output-1 | OSS-GLM | `{"reuse":4,"clarity":5,"correctness":5,"completeness":5,"right_sizing":5,"risk_handling":5,"implementability":5,"repo_intent_fidelity":5,"architectural_coherence":5,"acceptance_criteria_quality":5}` |
| 1 | output-2 | OSS-DS | `{"reuse":4,"clarity":4,"correctness":3,"completeness":3,"right_sizing":4,"risk_handling":3,"implementability":3,"repo_intent_fidelity":3,"architectural_coherence":3,"acceptance_criteria_quality":3}` |
| 1 | output-3 | GPT | `{"reuse":5,"clarity":5,"correctness":5,"completeness":5,"right_sizing":4,"risk_handling":5,"implementability":5,"repo_intent_fidelity":5,"architectural_coherence":5,"acceptance_criteria_quality":5}` |
| 2 | output-1 | OSS-GLM | `{"reuse":4,"clarity":5,"correctness":5,"completeness":5,"right_sizing":5,"risk_handling":5,"implementability":5,"repo_intent_fidelity":5,"architectural_coherence":5,"acceptance_criteria_quality":5}` |
| 2 | output-2 | OSS-DS | `{"reuse":3,"clarity":4,"correctness":3,"completeness":3,"right_sizing":4,"risk_handling":3,"implementability":3,"repo_intent_fidelity":3,"architectural_coherence":3,"acceptance_criteria_quality":3}` |
| 2 | output-3 | GPT | `{"reuse":5,"clarity":5,"correctness":5,"completeness":5,"right_sizing":4,"risk_handling":5,"implementability":5,"repo_intent_fidelity":5,"architectural_coherence":5,"acceptance_criteria_quality":5}` |

## Human ranking (best → worst)

- output-3 > output-1 > output-2 — review-mode (2026-07-02T08:04:53.917Z)

