# Plan: Miscellaneous Small-Cluster Debt (2026-07-26 triage)

- **Date**: 2026-07-26 (re-traced 2026-08-17)
- **Status**: Draft — **narrowed to 8 items (10 topicIds), re-verified open
  2026-08-17.** Of the original 17 entries: 1 done directly under this plan
  (2026-07-27), 4 closed by other work (2026-08-03/07-28), 1 corrected
  (was already fixed pre-plan). Items resolved individually as picked up,
  not implemented as one batch.
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). This
> is the leftover bucket — originally 17 entries across 13 files, each a
> standalone 1-2-entry issue not sharing enough theme with another cluster
> to warrant its own plan doc. Verified against current source 2026-07-26;
> re-verified 2026-08-17 (see Progress notes below). Grouped here by file,
> no cross-cutting theme implied.

**Progress (2026-07-27)**: `duplicate-justification-pragma.mjs` (`67f8f414`/
`fbd71c9a`) — **done**. `^\s*` anchor added to `PRAGMA_RE`; 4 regression
tests added. Also fixed a related bug found while verifying: a real pragma
in `scripts/setup-postgres.mjs` was written as a JSDoc continuation line
(no comment-marker prefix), so it never actually matched at all — moved to
a standalone `//` comment line.

**Progress (2026-08-17, re-traced against current source, none via this
plan)**: 4 more topicIds closed, 1 entry corrected, **8 distinct items (10
topicIds) remain genuinely open**:
- `139dc8c30859` (gemini-review.mjs `thinkingBudget` literal) — **fixed**
  `05858e20` (2026-08-03): now `GEMINI_THINKING_BUDGET_BY_EFFORT` lookup.
- `19659d7a`/`0e18b00d`/`3f0e3fe7` (on-conflict.mjs `isNullableExpr` +
  atomic-write-adoption-guard.test.mjs identifier matching) — **fixed by
  one commit**, `869f69ca` (2026-07-28): `isNullableExpr` replaced by a
  three-valued `classifyNullability` lattice, and the guard now resolves
  real lexical bindings via `scripts/lib/import-binding.mjs` instead of
  matching identifier spelling.
- `1ff42c81c4f7` (schemas.mjs `FindingSchema` alias) — **claim was already
  stale when this plan was written**: the distinguishing comment landed in
  `afbcd022` (2026-04-05), 3.5 months before this plan's 2026-07-26
  authoring commit. Nothing to fix.

The remaining 8 items (10 topicIds) below are unchanged from 2026-07-26 —
re-verified against current source 2026-08-17, not re-read off this text.

---

- **`gemini-review.mjs`** — `139dc8c30859` (bare `thinkingBudget: 16384`
  literal, no named constant). **Fixed `05858e20` (2026-08-03)** — a
  `GEMINI_THINKING_BUDGET_BY_EFFORT` lookup replaced the literal.
  `86b51ca4ba56` (file has grown to 2157 lines, still mixes
  CLI/provider/shadow-compare/formatting/watchdog in one file — worth a
  decomposition pass if this file gets touched again for another reason,
  not urgent enough to justify one on its own) — **still open**; the file
  has since grown further, to 3082 lines (checked 2026-08-17), still
  undecomposed.
- **`lint/on-conflict.mjs`** — `19659d7a` (`isNullableExpr` misclassifies
  both its own documented `||`/`&&` examples as non-nullable — a genuine
  logic bug in the lint rule itself, worth a quick fix + regression test).
  **Fixed `869f69ca` (2026-07-28)** — replaced by `classifyNullability`, a
  three-valued `nullable|non-null|unknown` lattice; `isNullableExpr`
  survives only as a thin back-compat wrapper. `9a7c7263` (`SCOPE_COLUMNS`
  is a hardcoded set with no fallback diagnostic for an un-listed tenancy
  column) — **still open**; `docs/plans/refactor-static-analysis.md:868`
  records auto-detection of missing entries as a deliberately deferred
  residual, not a forgotten one.
- **`duplicate-justification-pragma.mjs`** — `67f8f414`/`fbd71c9a`: the
  pragma regex has no `^` start anchor, so pragma-looking text inside a
  string/template literal (not a real comment) still matches. One-line
  anchor fix. **Done (2026-07-27)** — `^\s*` (permits leading whitespace/
  indentation, verified against every real pragma in this repo).
- **`linter.mjs`** — `6a74fc5a892d` (external lint tools run with
  `cwd: process.cwd()` against the whole repo, filtered only after the
  fact) and `b99706f9393b` (the documented `AUDIT_LOOP_ALLOW_TOOLS` env gate
  is referenced in comments/docs but never actually implemented — tools run
  by default regardless).
- **`atomic-write-adoption-guard.test.mjs`** — `0e18b00d`/`3f0e3fe7`: the
  guard matches `atomicWriteFileSync` calls by identifier *name* only, no
  lexical-scope/binding resolution, so a shadowing local with the same name
  would satisfy the guard incorrectly. **Fixed `869f69ca` (2026-07-28)** —
  same commit as `19659d7a` above; the guard now resolves real lexical
  bindings via `scripts/lib/import-binding.mjs`'s
  `resolvesToNamedImport`/`resolveNamedImportBinding` instead of
  `Set.has(name)`.
- **`schemas.mjs`** — `1ff42c81c4f7`: `FindingSchema` is a bare alias of
  `PersistedFindingSchema` with no distinguishing name/comment — naming
  clarity only, no behavior risk. **Not actually open**: the distinguishing
  comment ("Backward-compatible alias — existing imports of `FindingSchema`
  use the permissive persisted schema. Enforcement happens at producer
  boundaries via `ProducerFindingSchema`.") already existed in `afbcd022`
  (2026-04-05), 3.5 months before this entry was written 2026-07-26 — the
  original triage read stale/pre-fix source.
- **`tests/install/receipt.test.mjs`** — `5cf9d863` (LOW): shared
  PID-based tmp path across tests, cleanup only runs as the final statement
  after assertions — an assertion failure mid-test skips cleanup. Move
  cleanup into `afterEach`/`t.after()`.
- **`postgres-parity/generate-expected-schema.mjs`** — `8c95c520`: the
  schema-introspection query selects `column_default` but not
  `is_identity`/`identity_generation`, despite the file's own header
  comment claiming identity sequences are captured.
- **`tests/sensitive-paths-canonical.test.mjs`** — `9fce2220`: Windows-skip
  logic uses a bare `if (skipOnWin) return;` instead of node:test's real
  `skip()`/`{skip}`, so these report as *passing* on Windows CI rather than
  skipped — silently reduces coverage without saying so.
- **`tests/tiered-shadow-compare.test.mjs`** — `a5f8c94f`: the test only
  clears `AUDIT_DB_URL`, but `client.mjs`'s `resolveDbUrl()` falls back to
  `AUDIT_POSTGRES_URL` when that's empty — so ambient config in the test
  environment could still select a real DB. Given this repo's own
  `assertDisposableDbUrl` incident history (the 2026-07-14 wipe), this is
  worth closing even though it's LOW-labeled — clear both env vars, or use
  `assertDisposableDbUrl` directly in the test setup.
- **`memory-health.mjs`** — `aad83769`: `numEnv()` checks `Number.isFinite`
  but not non-negativity, so `MEMORY_HEALTH_MIN_FINDINGS=-1` makes the
  insufficient-data guard always false.
- **`tests/shared.test.mjs`** — `eff197286a47`: one large catch-all
  destructured import of ~35 names from `shared.mjs` — a test-hygiene
  observation given `shared.mjs` is documented as a backwards-compat
  barrel already being split; not urgent on its own.

---

## Full entry table


**`scripts/gemini-review.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `139dc8c30859` | MEDIUM | gemini-review.mjs:484 thinkingBudget bare literal no named constant |
| `86b51ca4ba56` | MEDIUM | gemini-review.mjs now 2157 lines grown, still mixes many concerns |

**`scripts/lib/lint/on-conflict.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `19659d7a` | MEDIUM | lint/on-conflict.mjs:130-151 isNullableExpr misclassifies \|\| / && examples as non-nullable |
| `9a7c7263` | MEDIUM | lint/on-conflict.mjs:57,109-118 SCOPE_COLUMNS hardcoded set no diagnostic fallback |

**`scripts/lib/duplicate-justification-pragma.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `67f8f414` | MEDIUM | duplicate-justification-pragma.mjs:45 PRAGMA_RE no start anchor |
| `fbd71c9a` | MEDIUM | duplicate-justification-pragma.mjs:45 same unanchored regex duplicate |

**`scripts/lib/linter.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `6a74fc5a892d` | HIGH | linter.mjs:120-125 execFileSync cwd=repo root not scoped, post-filtered only |
| `b99706f9393b` | HIGH | linter.mjs:14 AUDIT_LOOP_ALLOW_TOOLS documented but never implemented |

**`tests/atomic-write-adoption-guard.test.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `0e18b00d` | MEDIUM | atomic-write-adoption-guard.test.mjs:150-160 identifier-name match no lexical-scope resolution |
| `3f0e3fe7` | MEDIUM | atomic-write-adoption-guard.test.mjs:150-160 same, no binding resolution |

**`scripts/lib/schemas.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `1ff42c81c4f7` | MEDIUM | schemas.mjs:376-380 FindingSchema bare alias of PersistedFindingSchema no rename |

**`tests/install/receipt.test.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `5cf9d863` | LOW | tests/install/receipt.test.mjs:8,18-31 shared pid-based tmp path, cleanup skipped on assertion throw |

**`scripts/postgres-parity/generate-expected-schema.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `8c95c520` | HIGH | postgres-parity/generate-expected-schema.mjs:52-66 no is_identity/identity_generation despite header claim |

**`tests/sensitive-paths-canonical.test.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `9fce2220` | LOW | sensitive-paths-canonical.test.mjs:70,86,106,123 skipOnWin return not real skip(), Windows reports as passing |

**`tests/tiered-shadow-compare.test.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `a5f8c94f` | HIGH | tests/tiered-shadow-compare.test.mjs:18-19 only sets AUDIT_DB_URL='', client.mjs resolveDbUrl still falls back to AUDIT_POSTGRES_URL |

**`scripts/memory-health.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `aad83769` | MEDIUM | memory-health.mjs:31-40 numEnv no non-negativity bound |

**`tests/shared.test.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `eff197286a47` | LOW | tests/shared.test.mjs:6-39 still one large catch-all destructured import |

## Rollback

All additive/test-hygiene changes; no schema/data migrations. The
`tiered-shadow-compare.test.mjs` env-clearing fix is the one item here
worth prioritizing given the prior wipe-incident history in this repo.
