---
description: 'Postgres audit-store tripwires: connecting, jsonb writes, durable writes, schema faults, disposable DBs, RPC bounds.'
applyTo: 'scripts/lib/db/**, scripts/lib/store/**, supabase/migrations/**, scripts/lib/durable-write.mjs, scripts/lib/audit-store-writers.mjs, scripts/lib/audit/legacy-production-audit.mjs, scripts/setup-postgres.mjs, scripts/db-test-container.mjs'
paths:
  - "scripts/lib/db/**"
  - "scripts/lib/store/**"
  - "supabase/migrations/**"
  - "scripts/lib/durable-write.mjs"
  - "scripts/lib/audit-store-writers.mjs"
  - "scripts/lib/audit/legacy-production-audit.mjs"
  - "scripts/setup-postgres.mjs"
  - "scripts/db-test-container.mjs"
---

# Postgres-Parity Store — path-scoped tripwires

Moved from `AGENTS.md` §Postgres-Parity Store (text verbatim, links re-rooted to
this folder), whose resident stub names each one. This file and `.github/instructions/postgres-store.instructions.md` are
byte-identical twins (Claude Code reads the first, the VS Code Copilot harness the
second); `tests/path-scoped-instructions-twins.test.mjs` fails when they differ.

- **Connect**: `AUDIT_DB_URL` + `AUDIT_DB_SSL_MODE=no-verify`, via the Supabase
  **Session pooler (5432)**, **NOT the Transaction pooler (6543)** — 6543 drops
  server-side prepared statements and the `search_path=public` pin the `db/` seam
  needs. A role's credential is the access control (single-tenant, no separate
  read/write keys); the runtime `pg.Pool` ([`db/client.mjs`](../../scripts/lib/db/client.mjs))
  owns `public` or is a `BYPASSRLS` role with DML grants, so it **bypasses RLS** (correct here). In an
  owner + least-privilege split the `ALTER DEFAULT PRIVILEGES FOR ROLE <owner>` line
  is the one that gets forgotten. The schema is **`public`-only** in v1. Setup,
  `--migrate`/`--adopt`/`--check-drift`: [postgres-parity.md](../../docs/runbooks/postgres-parity.md)
  §Connecting, §Two roles, §Setup recipe; moving stores:
  [moving-the-audit-store.md](../../docs/runbooks/moving-the-audit-store.md).
- **jsonb-safe write seam — do NOT hand-`JSON.stringify` a jsonb column.**
  `serializeWriteParam` auto-serializes a plain array bound to ANY column on the
  write path (else node-postgres binds an ARRAY literal: `22P02` or a silent `{}`).
  **Pass jsonb values raw**; a real `text[]`/`int[]` column opts OUT with
  **`pgArray(value)`** — a jsonb writer that forgets is safe, a `text[]` writer that
  forgets fails LOUDLY. [postgres-parity.md](../../docs/runbooks/postgres-parity.md) §jsonb write seam.
- **Every audit-store write in `legacy-production-audit.mjs`'s cloud block goes
  through `durableWrite`** ([durable-write.mjs](../../scripts/lib/durable-write.mjs)),
  registered in [audit-store-writers.mjs](../../scripts/lib/audit-store-writers.mjs).
  Four outcomes, not interchangeable: `written` · `spilled` · `lost` · `skipped`
  (cloud off is a supported mode, not a failure); `lost` **or** `spilled` makes a
  run `incomplete`. A new write-shaped export under `scripts/lib/store/**` must be
  registered or exempted **with a reason** (`npm test` derives the set from the
  filesystem). Semantics: [postgres-parity.md](../../docs/runbooks/postgres-parity.md) ·
  [plan](../../docs/plans/audit-store-write-durability.md).
- **A SCHEMA ERROR IS NOT AN EMPTY RESULT — and a bare `catch { return null }`
  renders it as one.** Ask of any catch around a query: *can a broken query and an
  absent row leave here as the same value?* `isSchemaFaultSqlstate` /
  `describeSchemaFault` ([db/errors.mjs](../../scripts/lib/db/errors.mjs)) make a
  read-path catch **degrade loudly**. Testing the pure decision is not enough:
  **split it out AND put one assertion on a real Postgres** (a freshness cache was
  dead through all-green pure tests, 2026-09-05).
  [postgres-parity.md](../../docs/runbooks/postgres-parity.md).
- **"Disposable" is an ALLOWLIST of loopback hosts, and it fails CLOSED.**
  `isDisposableDbHost` / `assertDisposableDbUrl` ([db/client.mjs](../../scripts/lib/db/client.mjs))
  guard the suites that `DROP SCHEMA public CASCADE` and the schema fixture.
  **Never re-express this as "not $VENDOR"** (a denylist went inert the day the
  store moved). Production identity is compared as host+port+database, never as a
  DSN string; no env escape hatch, deliberately; **regenerate the fixture only from
  a fresh replay** (`npm run db:local:regen`).
  [postgres-parity.md](../../docs/runbooks/postgres-parity.md) §Incident + §Correction.
- **Bound an RPC at the CALLER** — `SET statement_timeout` inside a function is
  decorative. `CREATE OR REPLACE FUNCTION` resets **`proconfig`** (restate `SET
  search_path`) but PRESERVES the ACL; **changing the argument list makes a
  DIFFERENT function**, whose default ACL is `EXECUTE` to `PUBLIC` and which the
  old `REVOKE` does not name. Verify by `has_function_privilege`, never by review
  or by a `proacl` that reads `NULL`.
  [memory-health-gate.md](../../docs/reference/memory-health-gate.md).
