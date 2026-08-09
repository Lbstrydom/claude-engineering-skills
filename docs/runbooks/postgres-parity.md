# Postgres-Parity Store — Operations Runbook

> Operational detail for the `pg`-direct cloud learning store. The **design**
> rationale (the no-adapter decision, schema scope, privilege model, file plan)
> lives in [`docs/plans/postgres-parity.md`](../plans/postgres-parity.md);
> this file is the how-to. Stubbed from AGENTS.md to keep that file an invariant
> ledger, not a runbook.
>
> **Running the server yourself?** This file still owns connection strings,
> privileges, migrations and drift. For the container, the secret, the backup
> sidecar and the self-hosting traps, see
> [`self-hosted-store.md`](self-hosted-store.md).

The store talks to **Postgres directly via the `pg` driver** — no
`@supabase/supabase-js` / PostgREST layer. "Supabase-hosted vs self-hosted" is just
a connection string.

## Connecting

**Supabase-hosted:**

```
AUDIT_DB_URL=postgresql://postgres.<ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres
AUDIT_DB_SSL_MODE=no-verify       # Supabase poolers use an internal CA
```

- **Supabase Connect → Session pooler** (port 5432). Use Direct only if your network
  is IPv6-capable; the shared Session pooler is IPv4-friendly.
- Plan §2 R9 / §8 R9: do NOT use the Transaction pooler (port 6543) — it doesn't
  preserve server-side prepared statements and the `options=-c search_path=public`
  startup pin the `db/` seam relies on.

**Plain / self-hosted Postgres** (localhost, Docker, RDS, Neon, Railway, …):

```
AUDIT_DB_URL=postgresql://postgres:<password>@localhost:5432/audit_loop
AUDIT_DB_SSL_MODE=disable         # localhost without TLS; `require` for TLS hosts
```

- Any Postgres 13+ works — Supabase-hosted vs self-hosted is just a connection
  string (the compat bootstrap manufactures the `auth` schema stub, the three
  Supabase roles, and the extensions the migrations reference; see below).
- Prerequisites: the **pgvector** package installed on the server (`vector` is
  the one extension that does NOT ship with stock Postgres — `pgcrypto` and
  `pg_trgm` come from `postgresql-contrib`), and a setup role with `CREATEROLE`
  + `CREATE EXTENSION` (the preflight aborts with a precise install hint when
  either is missing).
- Then bootstrap once: `node scripts/setup-postgres.mjs --migrate`.

## Privilege model (plan §2 / R2 H4 + R3 H3)

Two distinct roles, both single-tenant by design (the DSN's password IS the secret —
no separate read/write keys):

- **Setup role** (`scripts/setup-postgres.mjs`, one-time per fresh self-hosted DB) —
  needs `CREATEROLE` (to create the `anon`/`authenticated`/`service_role` stub roles)
  + `CREATE EXTENSION` on `pgcrypto`, `pg_trgm`, `vector`. The setup CLI preflights
  both and aborts with a precise message when absent. Managed-Postgres-without-
  `CREATEROLE` is an explicit v1-unsupported case (plan §10).
- **Runtime role** (the `pg.Pool` in [`scripts/lib/db/client.mjs`](../../scripts/lib/db/client.mjs))
  — owns the audit-loop objects, OR holds full DML + `EXECUTE` on the 9 RPCs +
  schema/sequence `USAGE`. Ownership **bypasses RLS** — correct for the single-tenant
  store. On a Supabase project, `AUDIT_DB_URL` is the `postgres`-role string and
  naturally owns `public`.

## Setup recipe

| What | Command |
|---|---|
| Fresh self-hosted Postgres → ready for the audit-loop | `AUDIT_DB_URL=… node scripts/setup-postgres.mjs --migrate` |
| Pre-provisioned Supabase project → seed the migration ledger without replay | `AUDIT_DB_URL=… node scripts/setup-postgres.mjs --adopt` |
| Privilege preflight only (no DDL) | `AUDIT_DB_URL=… node scripts/setup-postgres.mjs --preflight-only` |
| Compat-bootstrap only (no migrations) | `AUDIT_DB_URL=… node scripts/setup-postgres.mjs --bootstrap-only` |

`--adopt` mode diffs the live schema against
[`tests/fixtures/expected-schema.json`](../../tests/fixtures/expected-schema.json) across
10 catalog categories (tables / functions / views / policies / constraints / indexes
/ triggers / sequences / extensions / grants). Any drift aborts with a per-category
diff so the operator decides.

## Local disposable test container

`scripts/db-test-container.mjs` runs an ephemeral local Docker Postgres
(`pgvector/pgvector:pg16`, mirroring `.github/workflows/postgres-parity.yml`'s
`db-suite` service container) so the destructive DB integration suites and
`tests/fixtures/expected-schema.json` regeneration are runnable locally —
not just in CI. Root cause: after the 2026-07-14 production wipe (INC-002),
`assertDisposableDbUrl` refuses to run these suites against anything but a
genuinely disposable DSN, so in practice they only ran in CI before this
existed. See the `local-db-test-container` plan under `docs/plans/` or
`docs/completed/` for the full design and audit trail.

```
npm run db:local              # full CI-mirror suite run (migrate → schema-diff → drift-justification → destructive trio → contract)
npm run db:local:regen        # migrate → regenerate tests/fixtures/expected-schema.json in place
node scripts/db-test-container.mjs up    # start + migrate, leave running (prints both DSN forms) — for manual psql/debugging
node scripts/db-test-container.mjs down  # idempotent teardown
```

Flags: `--keep` (skip teardown after `suites`/`regen-schema`), `--port <n>`
(default `5433` — escape hatch for a local port conflict).

**Why `AUDIT_DB_URL` is absent from the destructive step.** The container's
DSN (`postgresql://postgres:postgres@127.0.0.1:<port>/postgres`) always
passes `assertDisposableDbUrl` on its own merits (loopback host, never a
Supabase host). But the guard *also* rejects a test URL identical to the
real `AUDIT_DB_URL` — so if an operator-exported `AUDIT_DB_URL` were
inherited into the destructive-suite child process, it could accidentally
equal the container DSN and false-positive the guard. The CLI actively
**deletes** `AUDIT_DB_URL` from that step's env (not merely omits it) so
the guard's equality check stays meaningful, exactly mirroring the CI
workflow's own env split (see the comment at
`.github/workflows/postgres-parity.yml:106-114`).

**Docker unavailable / wedged.** The CLI fails loud on a bad `docker
version` preflight rather than attempting any repair — see the WSL/Docker
wedge recovery recipe in project memory (`taskkill wsl.exe` zombies, cycle
the `WSLService` Windows service, restart `com.docker.service`) if
`docker version` itself hangs or errors.

## Migration-drift detection

The `audit_loop_migrations` ledger (created on first `--migrate` or `--adopt`) records
which `supabase/migrations/*.sql` files have been applied to the live DB. Drift =
source files committed but not applied (or applied but later edited). Detect via:

```
AUDIT_DB_URL=… node scripts/setup-postgres.mjs --check-drift              # human report
AUDIT_DB_URL=… node scripts/setup-postgres.mjs --check-drift --format json # CI/script
```

Exit codes: `0` clean (no drift OR `AUDIT_DB_URL` unset), `1` drift, `2` hard error,
`3` needs bootstrap (ledger table missing).

### Drift categories — `eol-legacy` vs `shaMismatch`

A ledger hash that doesn't match its source file is one of two very different
things, and the report separates them:

| Category | Meaning | Fix |
|---|---|---|
| `eol-legacy` | The row holds the **pre-canonicalization CRLF hash of the same committed content**. Benign line-ending artifact, not an edit. | `--repair-eol` (below) |
| `shaMismatch` | Anything else — a committed migration really was edited after apply. | Hard failure. Investigate; migrations are append-only. |

**Why this split exists.** Migration hashes are computed over
**LF-canonicalized bytes** (`canonicalizeMigrationBytes` — folds `0x0D 0x0A` to
`0x0A`, touching no other byte, not even a lone `CR`). Before that, hashing raw
bytes made the tamper guard *also* a checkout-mode guard: a migration applied
from a CRLF working tree recorded a CRLF hash, so **every clean LF clone
false-aborted** with "previously applied with a different SHA256". Observed
2026-07-14 on `20260521120000_persona_test_candidates.sql`, whose file was
never edited — the `.gitattributes eol=lf` pin simply landed after it was first
checked out. Canonicalizing makes checkout mode permanently irrelevant while
leaving the guard exactly as strict for real content edits.

A historical file with **mixed** endings cannot be reconstructed to the single
all-CRLF representation and is therefore classified `shaMismatch`, requiring
manual investigation — deliberately fail-closed.

### Repairing `eol-legacy` rows

```
AUDIT_DB_URL=… node scripts/setup-postgres.mjs --repair-eol --dry-run   # list candidates
AUDIT_DB_URL=… node scripts/setup-postgres.mjs --repair-eol             # rewrite them
```

Rewrites **only** `eol-legacy` rows to the canonical hash. Safety properties:
holds the migration advisory lock (a concurrent `--migrate` cannot interleave);
runs in **one transaction**; each row is a **compare-and-swap** on the exact hash
observed at classification, so a row that changed underneath aborts the whole
transaction rather than overwriting a hash the tool never inspected; idempotent.
A true `shaMismatch` is never touched.

> This replaces the old advice to hand-`UPDATE audit_loop_migrations.sha256` for
> this class. A manual UPDATE cannot distinguish a line-ending artifact from a
> real edit, so it trained operators to override the tamper guard by reflex.

Surfaced two ways:

- **Weekly CI + push-on-migration** (`.github/workflows/migration-drift.yml`): cron
  Mondays 09:45 UTC + immediately on any commit landing `supabase/migrations/**`.
  Opens a sticky GitHub issue with label `migration-drift` on drift; auto-closes when
  clean.
- **Pre-push (operator self-service)**: optional, requires you to paste the snippet
  below into your source-repo `.git/hooks/pre-push`. CI is the primary gate; this is
  just a faster local-feedback loop.

**One-time bootstrap** when the live DB hasn't been ledger-tracked before:

| Step | Command | Effect |
|---|---|---|
| 1 | Manually apply any outstanding migrations through the Supabase dashboard SQL editor. | Brings live schema to parity with `tests/fixtures/expected-schema.json`. One-time pain. |
| 2 | `AUDIT_DB_URL=… node scripts/setup-postgres.mjs --adopt` | Strict full diff. On match → ledger is seeded with all source migrations. On drift → aborts with a per-category diff. |
| 3 | `AUDIT_DB_URL=… node scripts/setup-postgres.mjs --check-drift` | Confirm clean. Exit 0 = ledger == source. |

**Going forward** — use `node scripts/setup-postgres.mjs --migrate` for every new
migration. It's idempotent (sha256-skip) and keeps the ledger current. The dashboard
becomes a break-glass tool, not the default path.

**Pre-push self-service snippet** — paste into source-repo `.git/hooks/pre-push`:

```bash
# managed-by: migration-drift-detector — operator self-service drift check
# Only fires when AUDIT_DB_URL is set; advisory only, never blocks.
# Git hooks already cwd to the repo root, so no cd or $REPO_ROOT needed.
if [ -f "package.json" ] && [ -n "$AUDIT_DB_URL" ]; then
  echo "→ Migration-drift check..."
  DRIFT_EXIT=0
  node scripts/setup-postgres.mjs --check-drift || DRIFT_EXIT=$?
  case "$DRIFT_EXIT" in
    0) ;;  # clean — silent pass
    1) echo "⚠  migration-drift detected — push continues, but recover with:"
       echo "     node scripts/setup-postgres.mjs --migrate" ;;
    3) echo "⚠  audit_loop_migrations ledger missing — bootstrap with:"
       echo "     node scripts/setup-postgres.mjs --adopt" ;;
    *) echo "⚠  drift check infra error (exit $DRIFT_EXIT) — push continues" ;;
  esac
fi
```

**Break-glass** — if `--migrate` fails on a non-idempotent migration, the fix is to
make the source file idempotent (`IF NOT EXISTS` / `DROP ... IF EXISTS`), commit,
retry. Do NOT use the dashboard as a routine fallback — that re-introduces the
silent-drift bypass this detector exists to eliminate.

If a hot-fix genuinely requires the dashboard, record the apply atomically to
preserve the ledger contract:

```bash
# Step 1: compute the canonical sha (cross-platform — uses the same
# implementation as scripts/setup-postgres.mjs::sha256).
SHA="$(node -e "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" supabase/migrations/<filename>.sql)"

# Step 2: dashboard SQL editor — migration body + ledger insert in the
# SAME transaction. Both succeed or both roll back.
BEGIN;
  -- paste the migration SQL here
  INSERT INTO audit_loop_migrations (filename, sha256)
    VALUES ('<filename>.sql', '<PASTE $SHA FROM STEP 1>')
    ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now();
COMMIT;

# Step 3: verify clean
AUDIT_DB_URL=… node scripts/setup-postgres.mjs --check-drift
```

## Shared cloud config for consumer repos

`AUDIT_DB_URL` and the LLM API keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`,
`ANTHROPIC_API_KEY`) are **shared across all consumer repos** using this bundle — same
Supabase project, same accounts. Rather than duplicating them in each repo's `.env`,
the loader supports a per-user shared file at **`~/.audit-loop.env`** that consumers
auto-inherit.

**Loader precedence** (configured in [scripts/lib/config.mjs](../../scripts/lib/config.mjs)):
1. cwd / git-root `.env` — wins on overrides. Repo-specific values live here.
2. `~/.audit-loop.env` — fallback for any var not set above. Shared secrets.

Loader is silent when the shared file is absent. First time it loads variables you'll
see one stderr line: `[config] loaded shared cloud config from ~/.audit-loop.env
(sets: AUDIT_DB_URL, OPENAI_API_KEY)`.

**Setup**:

```bash
# From your source claude-engineering-skills repo (where .env has the canonical DSN):
npm run setup:cloud
#  → prompts "Create ~/.audit-loop.env from this repo's .env? (Y/n)"
#  → writes the file with chmod 0600 (POSIX) atomically

# Subsequent runs (idempotent; reconciles against source .env):
npm run setup:cloud
#  → "shared cloud config: ~/.audit-loop.env — in sync with source repo .env"
#    OR "Update ~/.audit-loop.env? (with delta preview)"
npm run setup:cloud -- --yes        # non-interactive (CI)
npm run setup:cloud -- --dry-run    # preview, no write
```

**Updating after rotation**: when you edit `AUDIT_DB_URL` (or any shared var) in
source `.env`, the next `npm run sync` detects the divergence and prompts with the
specific delta (e.g. `AUDIT_DB_URL host: aws-1-eu-west-2 → aws-1-us-east-1`). Skip
with `npm run sync -- --no-prompt` (CI). The prompt also skips when not running in a
TTY.

**From a consumer repo**: any cloud-aware command (arch:refresh, audit-loop,
persona-test) automatically inherits the shared config. When `[learning] Cloud store
not configured` warns, the message itself points at `npm run setup:cloud` for
recovery.

**What lives where**:

| File | Holds | Wins on conflict |
|---|---|---|
| consumer repo `.env` | repo-specific (`PERSONA_TEST_REPO_NAME`, custom overrides) | Yes (override:false) |
| `~/.audit-loop.env` | shared secrets (DSN, LLM keys) | Fallback only |
| source repo `.env` | canonical for shared secrets (the file `setup:cloud` reads from) | n/a (consumers don't load it) |

**Opt-out**: don't run `setup:cloud`. The file never gets created; consumer repos that
need cloud just set `AUDIT_DB_URL` in their own `.env` directly. Public-repo safety —
the file lives in `os.homedir()`, never in any git tree.

## Prerequisites

- Postgres 13+ (uses `gen_random_uuid()` built-in; `pgcrypto` is the fallback for
  older versions, installed by the compat-bootstrap).
- Extensions installed at the OS level: `vector` (pgvector), `pg_trgm`, `pgcrypto`.
  The setup-CLI preflight reports missing packages with an install hint
  (`apt-get install postgresql-<ver>-pgvector` etc.).

## Why the schema is `public`-only

v1 hard-wires `public`. Plan §2 "Schema scope" + the audit at
[`docs/plans/postgres-parity-schema-coupling.md`](../completed/postgres-parity-schema-coupling.md):
4 migrations qualify `public.<table>` inside `publish_refresh_run` and 11
`SECURITY DEFINER` functions pin `search_path = pg_catalog, public`. Arbitrary-schema
support is §10 Out of Scope until that audit pass is re-run.

## Incident: `AUDIT_DB_TEST_URL` safety gate (2026-07-14)

**What happened**: `tests/db-setup.test.mjs` and `tests/db-withtx.test.mjs`'s
integration suites (env-gated on `AUDIT_DB_TEST_URL`) swap `AUDIT_DB_URL =
AUDIT_DB_TEST_URL` for their duration and run `DROP SCHEMA public CASCADE` in
`beforeEach` to reset between test cases. The only gate was "is
`AUDIT_DB_TEST_URL` **set**" — never "is it actually a disposable database".
Whoever ran these tests had `AUDIT_DB_TEST_URL` resolving to the real
production DSN (exact process never pinned down). Result: the shared
Supabase project (`uahjjdelnnpfmaqjrwoz`, "Audit-loop" — the store behind all
three repos: claude-engineering-skills, wine-cellar-app, ai-organiser) was
wiped from ~30 tables down to one leftover `drift_test` table.

**Root-caused, not guessed**: pulled the raw Postgres logs (Supabase
`get_logs` service=postgres) and found the exact statement sequence —
`DROP SCHEMA IF EXISTS public CASCADE` → `CREATE SCHEMA public` → `GRANT ALL`
→ rebuild, repeated once per integration test case (matching
`db-setup.test.mjs`'s own documented test list: fresh-apply, idempotent
re-apply, sha256-mismatch, adopt-mode ×2), cut off right after the LAST test
(`"detects when live has a table the manifest does not"`) created
`CREATE TABLE drift_test (id int PRIMARY KEY)` — the run stopped there,
before any later step could restore the schema. A confirmed direct `pg`
query (bypassing all tooling) showed exactly 1 table (`drift_test`) in
`public` at discovery time — not a connection/tooling artifact.

**Impact — data is gone, schema is not**: the schema is fully recoverable
(migrations are deterministic and committed — restored same-day via
`node scripts/setup-postgres.mjs --migrate`, 61/61 applied cleanly, back to
69 tables). The **data** — every `audit_runs`/`audit_findings`/
`bandit_arms`/`false_positive_patterns`/`debt_entries`/persona/
tiered-shadow-observation/`model_eval_runs`/`learning_decisions` row across
all three repos — is permanently lost unless Supabase Point-in-Time Recovery
is later used (the operator explicitly chose "restore schema now, accept the
data loss" over checking PITR first).

**Fixed same day**: `scripts/lib/db/client.mjs::assertDisposableDbUrl(testUrl,
{productionUrl})` — both suites' `before()` hooks now call it BEFORE any pool
reset or connection. Rejects (a) any Supabase-hosted host
(`*.supabase.co`/`*.supabase.com` — a genuine disposable test DB is never
Supabase-hosted in this repo's design, it's a local/container Postgres) and
(b) a test URL identical to the real `AUDIT_DB_URL`, even on a non-Supabase
host (catches a same-database copy-paste that isn't Supabase at all).
Regression-guarded in
[`tests/db-dsn-validation.test.mjs`](../../tests/db-dsn-validation.test.mjs).
**Live-repro-verified, not just unit-tested**: exporting `AUDIT_DB_TEST_URL`
to the real production DSN and re-running `db-setup.test.mjs` now fails the
`before()` hook immediately — all 5 subtests in that describe block show
`cancelled` (never ran), zero destructive queries issued. Full suite green
(5274 tests, 0 fail) after the fix.

**A stray `drift_test` table remains in production** (harmless leftover from
the incident) — not dropped without separate explicit confirmation.

**Follow-on consequence — the architectural-memory symbol index is also
empty.** `symbol_index`/embeddings live in the same wiped database. An
incremental `npm run arch:refresh` after the restore only rebuilds files
touched since the last commit (10 symbols), which would shrink the committed
`docs/architecture-map.md` from ~4,460 lines to ~36 if staged — reverted,
not shipped. **`npm run arch:refresh:full` is needed as a separate follow-up**
(a full repo re-index, non-trivial embedding/summarisation cost) before
`get-neighbourhood`/`compute-target-domains`/the architecture map are
trustworthy again.
