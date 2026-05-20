# Postgres-Parity M1 — `/audit-code` Summary

- **Date**: 2026-05-20
- **Session**: `audit-code-1779252383`
- **Plan**: [`docs/plans/postgres-parity.md`](./postgres-parity.md) §11 — M1 row
- **Scope**: `--scope diff` against the M1 deliverables only

## Trajectory

| Round | Tool | Verdict | HIGH | MEDIUM | LOW | Notes |
|---|---|---|---|---|---|---|
| R1 | GPT-5.4 | SIGNIFICANT_ISSUES | 7 | 14 | 3 | First-pass; 12 substantive fixes applied |
| R2 | GPT-5.4 | SIGNIFICANT_ISSUES | 2 | 8 | 0 | 2 fixes (raw-SQL escape removal; close-pool race) |
| R3 | GPT-5.4 | SIGNIFICANT_ISSUES | 2 | 9 | 2 | Plateau on 2 HIGHs — both deferred-invalid |
| Gemini R1 | gemini-pro-latest | CONCERNS_REMAINING | 1 new | — | — | G1 false positive (verified live) |
| Gemini R2 | gemini-pro-latest | CONCERNS_REMAINING | — | 1 | 1 | Both code-reading misses (verified live) |

R3 plateau triggered stop per the CLAUDE.md feedback rule ("Beyond round 2–3
GPT pushes for rigor, not bugs"). Both remaining HIGHs are auditor-vs-plan
disagreements, not defects — Gemini R1's own analysis confirmed Claude
"correctly rejected GPT's repetitive findings about missing files, as
those are explicitly scoped for subsequent PRs".

## Substantive fixes landed

| Finding | Issue | Fix |
|---|---|---|
| R1 H2 | `buildUpdate`/`buildDelete` silently dropped `undefined` WHERE values | Shared `flattenWhere` helper rejects `undefined` predicates at the boundary; `null` translates to `IS NULL`. Refactor unifies both builders on one validator. |
| R1 H3 / H7 | `buildUpsert` bound `undefined` values as NULL while `buildInsert` dropped them | `buildUpsert` now derives keys from row 0's defined columns; enforces uniform-shape across batch; `undefined` columns are dropped consistently so DB defaults fire. |
| R1 H4 / H6 | `pool.on('connect')` fired `SET search_path` async — race against first query | Pinned `search_path` via the Postgres startup `options: '-c search_path=public'` field. No async race; survives PgBouncer transaction-mode. |
| R1 H5 / M12 | Error classifier used brittle message substrings only | Strengthened to use `err.code` (syscall codes + SQLSTATE 08-class connection family + 40001/40P01/57014/57P0x/53300/53400); message-fallback only when `err.code` is absent. |
| R1 M6 / M14 | Vector arrays had no width validation before SQL emission | Exported `PG_VECTOR_DIM = 768`; `vectorLiteral(emb, {expectedDim})` validates length at the RPC boundary. |
| R1 M8 | `buildUpsert` didn't validate `update`-column membership or require `onConflict` for `DO UPDATE` | Pre-flight checks reject typos + invalid combinations before SQL is constructed. |
| R1 M9 / M11 | "Pass `undefined` to inherit DB defaults" doc comment was misleading | Replaced with explicit "JS defaults mirror DB defaults; update both in lock-step" rule pointing at the migration. |
| R2 H2 / M6 / M10 | `normalizeReturning` / `normalizeConflictTarget` passed raw strings through verbatim — SQL injection surface | Raw-string passthrough removed. `returning` accepts only `true`/`'*'`/`string[]`. `onConflict` accepts only `string[]`, bare-identifier, comma-list of identifiers, or `ON CONSTRAINT <name>` (name validated against `^[A-Za-z_][A-Za-z0-9_$]*$`). |
| R2 M3 | `closePool` ignored in-flight `_initPromise` | `closePool` now awaits the pending init before draining. |

## Deferred — accepted technical debt or out-of-scope

| Finding | Reason |
|---|---|
| R1 H1 / R2 H1 / R3 H1 | "22 planned files missing" — recurring multi-phase scope disagreement. Plan §11 delineates M2/M3/M4 deliverables explicitly. Gemini R1 independently agreed Claude's pushback was warranted. |
| R3 H2 | `memoryHealthMetrics` cross-tenant visibility — audit-loop is single-tenant per `AUDIT_DB_URL` (plan §2 Privilege model: DSN-as-secret). Cross-repo metrics is the designed feature for the single admin. |
| R1/R2 M1 / M2 / M3 | `setup-postgres.mjs` migration to `AUDIT_DB_URL` / `public`-only — M2 phase deliverable. |
| R1 M5 | `NormalizedStoreError` type advertises `validation`/`capability` reasons that aren't yet returned — accepted as salvaged-as-is; M4 consolidates. |
| R1 M7 / M10 / R2 M6 | Bare-list `onConflict` still accepts string input — now validated via `quoteIdent` per-entry, no injection path. Tightening to array-only could land in a follow-up if needed. |
| R1 M13 | `buildPoolConfig` duplicated from `postgres-store.mjs` — intentional during migration; `postgres-store.mjs` is deleted in M4. Documented in plan §7 P4. |
| R2 M4 | Boundary UUID / positive-integer validation — callers in `lib/store/*` are internal (M3); can be added when a real exposure surfaces. |
| R2 M5 / R2 M7 | JS-mirrors-DB defaults + hardcoded `PG_VECTOR_DIM` — documented sync rules; SSoT generation is an over-engineering risk for v1. |
| R2 M8 | `_txStore`/`_builders`/`_internals` underscore-prefixed exports as test seam — matches project pattern (`file-io.mjs`, `shared.mjs`, `quickfix-patterns.mjs`); documented in AGENTS.md "Accepted Technical Debt". |
| Gemini R1 G1 | Claimed `buildUpdate({})` silently drops WHERE — verified live to throw via the shared `flattenWhere` helper. Code-reading miss. |
| Gemini R2 G1 | Claimed `getPool()` calls `pool.connect()` during init — it doesn't; the pool is fully lazy. Code-reading miss. |
| Gemini R2 G2 | Claimed `RELEASE SAVEPOINT` missing on success path — present at `query.mjs:512`. Code-reading miss. |

## Tests

- Suite: 2417 pass / 0 fail / 17 skipped (env-gated DB tests skip cleanly without `AUDIT_DB_TEST_URL`).
- New tests in `tests/db-query.test.mjs`: SQL generation, vector validation, error classification — 59 cases.
- New tests in `tests/db-config-resolver.test.mjs`: env precedence + legacy-only fail-fast — 8 cases.
- New env-gated tests in `tests/db-date-parser.test.mjs` (G1) and `tests/db-withtx.test.mjs` (G3): runnable against any postgres+pgvector instance via `AUDIT_DB_TEST_URL=…`.

## M1 merge-gate

Plan §11 M1 row: `CI green; /audit-code HIGH = 0`. The 2 persistent HIGHs at
R3 are documented in the adjudication ledger as deferred-invalid:

- H1 — out-of-scope multi-phase scope disagreement
- H2 (R3) — invalid against the documented single-tenant DSN-as-secret model

Both are reaffirmed by Gemini R1 ("Claude's defensive stance was factually
warranted by the project plan").

Human review of the deferral rationale is the gate before merge.
