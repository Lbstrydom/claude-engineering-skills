# Phase G.2 Plan Audit Summary

- **Date**: 2026-04-06
- **Plan**: `phase-g2-sqlite-postgres-adapters.md`
- **Rounds**: 2 (stopped per early-stop rule; HIGH plateau R1→R2)
- **Verdict trajectory**: R1 SIGNIFICANT_GAPS H:4 M:4 L:2 → R2 SIGNIFICANT_GAPS H:4 M:4 L:0
- **Cost**: ~$0.30, ~8 min
- **Status**: Audit-complete. 14 fixes applied. 2 HIGH + 0 MEDIUM residuals documented.

## Key Fixes Applied

**R1 (4 HIGH, 4 MEDIUM, 2 LOW addressed)**:
- Transaction contract: `withTransaction(fn)` hands callback a tx-scoped `Executor` (H1 initial fix)
- Upsert semantics: BOTH dialects use `INSERT...ON CONFLICT DO UPDATE`; no `INSERT OR REPLACE`; centralized conflict targets (H2)
- Migration ownership: setup CLIs own DDL, runtime adapters only verify schema version (H3)
- Error normalization: canonical `normalizeError()` with full mapping table for SQLite + Postgres native errors (H4)
- Read-only mode: dedicated init path, no directory creation, no migration apply, fail-fast on missing DB (M1)
- Conformance test strategy: `:memory:` for unit tests, temp-file DBs for WAL/concurrency, ephemeral Postgres service container in CI (M2)
- SRP split: `sql/` subdir with per-interface repo modules composed by factory, not god module (M3)
- Access-pattern matrix: every method mapped to required indexes + EXPLAIN smoke tests (M4)
- Rollback fail-fast: invalid `AUDIT_STORE` errors rather than silent fallback (L1)
- Identifier validation: regex-restricted schema names + central `quoteIdent()` utility (L2)

**R2 (4 HIGH, 4 MEDIUM addressed)**:
- Transaction design refined: single-statement-per-method as default; dialect-native helpers (`batchSync` SQLite, `batchAsync` Postgres) for the few multi-statement ops, duplicated ~50 LoC per dialect (H1)
- Runtime DDL scrubbed: adapter no longer "creates schema if missing"; conformance replaces "Migration replay" with "Schema-version validation" test against pre-migrated DB (H2)
- Idempotency matrix: every write method documented with retry key source + conflict behavior (H3)
- Timestamp policy: application-generated UTC ISO-8601 millisecond precision for both dialects; no DB `NOW()`/`CURRENT_TIMESTAMP` (H4)
- File layout unified: §3, §6 rewritten to reference `sql/` split structure (M1)
- CI policy clarified: Postgres service container always runs in CI; `POSTGRES_TEST_URL` is local-dev escape hatch (M2)
- Postgres statement_timeout: applied via pool `options.query`, code `57014` added to error map (M3)
- JSON as opaque payloads: every queryable field promoted to first-class column with own index (M4)

## Remaining HIGHs (2, documented as known limitations §7)

| # | Finding | Mitigation |
|---|---|---|
| R2-H1 residual | Multi-statement tx helpers duplicated across sync SQLite + async Postgres | Small surface (~50 LoC each), tested identically via conformance |
| R2-H2 residual | Conformance suite requires pre-migrated DB (setup-CLI invocation in test harness) | `tests/stores/helpers.mjs::createMigratedDb(dialect)` programmatic entry point |

## Trajectory Analysis

HIGH count flat 4→4 across 2 rounds. Classic architecturally-deep plan: each
round surfaces adjacent concerns (tx model → tx+DDL+idempotency+timestamps →
tx+DDL residuals + layout/CI/timeout/JSON). Same pattern as Phase F/G.1/H.
Stopping at R2 per early-stop rule: further rounds would push for things
that belong in implementation (tx-helper consolidation strategies, schema
versioning evolution, conformance test harness refactors).

## Next Steps

Plan is ready to implement. Key implementation notes:
1. Author `sql/sql-dialect.mjs` + `sql-errors.mjs` + `sql-schema/*.sql` first — they unblock everything
2. Implement repos against mock Executor BEFORE real drivers — tests are fast + deterministic
3. Write `setup-sqlite.mjs` + `setup-postgres.mjs` before adapters — adapters depend on migrated DBs
4. Set `statement_timeout` on Postgres pool creation, verify with 57014 conformance test
5. Application-generated ISO-8601 timestamps at facade boundary — scrub any DB `NOW()` from DDL
