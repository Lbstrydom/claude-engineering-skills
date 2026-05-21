# Postgres-Parity M3 + M4 — `/audit-code` Summary

- **Date**: 2026-05-21
- **Session**: `audit-code-m3m4-1779341875`
- **Plan**: [`docs/plans/postgres-parity.md`](./postgres-parity.md) §11 — M3 + M4 rows
- **Scope**: `--scope diff` against `HEAD~2..HEAD` — i.e. M3 part 2 (`63fba17`,
  the atomic barrel + caller migrations) + M4 (`47a1368`, the cutover +
  legacy-stores deletion). +562 / –3077 LOC net.

## Trajectory

| Round | Tool | Verdict | HIGH | MEDIUM | LOW |
|---|---|---|---|---|---|
| R1 | GPT-5.4 | SIGNIFICANT_ISSUES | 1 | 11 | 4 |
| R2 | GPT-5.4 | NEEDS_FIXES | **0** | 5 | 1 |
| R3 | Gemini 3.1 Pro (final gate) | **APPROVE** | — | — | +1 LOW (fixed) |

**First time Gemini issued APPROVE on a postgres-parity milestone audit.**

Gemini's overall reasoning:

> The codebase achieves the Postgres-parity objective exceptionally well.
> The transition from an adapter-based model to a single native Postgres
> path reduces complexity and eliminates drift. The implementation is
> highly robust: it introduces an elegant `AsyncLocalStorage` solution
> for transaction pooling (avoiding client-passing sprawl), enforces
> robust SQL injection defenses in the pure query builders, carefully
> manages PG type parsing without mutating global state, and safely
> handles Supabase compatibility via the schema-guarded compat-bootstrap.
> The remaining finding is a trivial test-suite magic number. Ready for
> production.

## Substantive fixes landed (R1 → R2)

| Finding | Issue | Fix |
|---|---|---|
| R1 H1 / M4 | Migration-ordering assertion was tautological — `files.sort()` compared to `[...files].sort()` would always pass | Replaced with contractual naming check: every migration filename must match `YYYYMMDDHHMMSS_<slug>.sql` (the format `setup-postgres.mjs::listMigrations` relies on for deterministic lex-sort) |
| R1 M5 / M9 | Hardcoded `files.length >= 30` couples the test to current migration count (29 then, brittle on rebase) | Replaced with `REQUIRED_MIGRATIONS` allowlist — explicit, intentional, doesn't churn on every migration add |
| R1 M6 / M10 | Loose regexes against `sync-to-repos.mjs` would match strings in comments | Switched to array-entry-anchored regex: `[\[,\s]['"]<path>['"]` — only matches actual array literal entries |
| R1 M7 | `assert.match(src, /--migrate\|--adopt/)` passed if either flag appeared | Split into two independent assertions, one per flag |
| R1 M8 | Import-removal scan only covered `scripts/` | Broadened to scripts/ + tests/ + install.mjs; added ESM-pattern variants (static, `await import`, `require`); skips the frozen contract fixture + the test file itself |
| Gemini G1 | Same hardcoded `>= 30` migration count duplicated in `tests/db-setup.test.mjs` (both GPT rounds missed it) | Replaced with non-empty + sorted + .sql-only invariants |

## Deferred (with ledger reasoning)

| Finding | Reason |
|---|---|
| R1/R2 M1 / R1/R2 M2 / R1 M3 | Recurring multi-phase scope misreading — **4th time across M1/M2/M3+M4 audits**. The auditor reads the plan's abbreviated `db/client.mjs` as a path (it's a label for `scripts/lib/db/client.mjs` which DOES exist) AND flags M4 deletions (`setup-github-store.mjs`, `setup-sqlite.mjs`) as "missing" when they're deliberately deleted per §7 P4. Plan §11 milestone table makes both clear. |
| R2 M3 / R2 M4 | "Tests still use source-text regexes" — accepted trade-off. Alternative is to import + run the CLIs with `--migrate` / `--adopt` which has side effects, or to import sync-to-repos.mjs which evaluates main() at import time. Regex-against-text with array-anchored patterns is the simpler, safer choice. |
| R2 M5 | "REQUIRED_MIGRATIONS hardcodes a second compatibility inventory" — DRY-vs-clear trade-off. The list IS intentional contract-pinning (a hand-curated subset that the compat-bootstrap was sized against); deriving it from migrations would defeat that. |

## Tests

- Suite: 2706 pass / 0 fail / 17 skipped (env-gated DB tests).
- 8 new in `tests/sync-packaging.test.mjs` (covers M4's setup-postgres
  routing + compat-bootstrap presence + supabase-js cutover).
- 6 hardened in the same file (the R1 fix-now batch).
- 1 hardened in `tests/db-setup.test.mjs` (Gemini G1).

## M3 + M4 merge-gate status (per plan §11)

| Gate | Status | Notes |
|---|---|---|
| M3 contract-equivalence suite green in remote CI | ⏳ blocked on M0 #4 | Golden fixtures still need recording against a sandbox Supabase project. `--allow-remote` is now wired (see below). |
| M3 `/audit-code` HIGH = 0 | ✅ (this audit) | R2 reached H:0; Gemini APPROVE |
| M3 manual e2e | ✅ (live smoke) | `audit-metrics --days 7` shows 144 runs flowing through the new pg path; `getRepoIdByName` + `listPersonasForApp` + `getPassEffectiveness` all return real data |
| M4 `/audit-code` HIGH = 0 | ✅ (this audit) | Same audit covered M4 (47a1368 was in the diff window) |
| M4 final validation smoke | ✅ (this audit) | The audit itself IS the smoke — it runs through `learning-store.mjs` barrel → `lib/store/*` → `lib/db/*` → `pg.Pool` end-to-end |
| Maintainer `.env` cutover to `AUDIT_DB_URL` | ✅ (earlier this session) | Replaced legacy `SUPABASE_AUDIT_*` triplet |

## Side-effect: `--allow-remote` for the recorder

Same session built the `--allow-remote <project-ref>` flag on
`scripts/postgres-parity/record-golden-fixtures.mjs` — the M0 #4
fixture-recording flow needed it before any sandbox-Supabase path could
work. Three safety guards verified live:

```
$ record-golden-fixtures --allow-remote uahjjdelnnpfmaqjrwoz       → refused (prod ref)
$ record-golden-fixtures --allow-remote def456 --url …abc123…       → refused (ref mismatch)
$ record-golden-fixtures --url https://abc.supabase.co (no flag)    → refused (default policy)
```

Once a sandbox is provisioned (`supabase projects create
postgres-parity-fixtures …`) and the recorder's `INPUT_FACTORY[]` is
fleshed out for the remaining 90 functions, the contract suite gate
can run green in CI.
