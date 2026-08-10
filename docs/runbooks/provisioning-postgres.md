# Getting a Postgres for the Audit-Loop Store — Chooser

> **What it is**: the decision step before every other database doc — *"I want
> the learning store, I don't have a Postgres yet, where do I get one and will
> it actually work?"* It picks a route and hands you off. It is deliberately
> short.
>
> **When you need it**: you chose `2) Postgres` in `node setup.mjs`, or you are
> weighing whether the database-backed features are worth provisioning anything.
>
> **When you don't**: you already have a DSN. Go straight to
> [`postgres-parity.md`](postgres-parity.md) — it owns connection strings, the
> privilege model, migrations and drift checking. **This file does not repeat
> them**, and it does not repeat the self-hosting recipe in
> [`self-hosted-store.md`](self-hosted-store.md) either.

**No database is required.** Every skill runs without one; plans, audit reports,
adjudication ledgers and generated specs are local files. A database adds
cross-run learning and bandit arms, architectural memory, security-incident
memory, semantic + cloud FP suppression, the memory-health gate, and
persona/audit correlations. If none of those are worth a provisioning step
today, choose `1) None` and revisit later — switching is setting one env var and
running one command, and nothing local is lost.

**Nothing here installs database software for you.** Every route below is
something you decide to do.

---

## 1. Will a given Postgres work? — check before you commit to a provider

Four hard requirements. The first three are ordinary; the fourth is the one that
actually eliminates candidates.

| Requirement | Notes |
|---|---|
| **Postgres 13+** | Uses `gen_random_uuid()`; `pgcrypto` is the fallback on older versions. |
| **`vector` (pgvector) installed on the server** | The one extension that does *not* ship with stock Postgres. Needed for embeddings + semantic suppression. |
| **`pg_trgm` + `pgcrypto` installed** | Both come from `postgresql-contrib`. `pg_trgm` backs the memory-health gate. |
| **A setup role with `CREATEROLE` *and* `CREATE EXTENSION`** | ⚠️ **This is the disqualifier.** Setup creates three stub roles (`anon`, `authenticated`, `service_role`). Managed Postgres that withholds `CREATEROLE` is an **explicitly unsupported case in v1** — see `docs/plans/postgres-parity.md` §10. |

"Installed on the server" means the extension *package* is physically present so
`CREATE EXTENSION` can succeed. A provider listing an extension as *available*
is what you want; one that has never heard of pgvector is out.

**Test a candidate before you commit to it** — this connects, reports every
requirement, and exits before writing any DDL:

```bash
AUDIT_DB_URL=<candidate dsn> node scripts/setup-postgres.mjs --migrate --preflight-only
```

Exit `0` means the requirements are met. Exit `2` prints exactly which of them
failed, with an install hint. Nothing has been created either way, so this is
safe to run against a trial instance you may throw away.

> Supabase-managed instances are detected and skip the strict gate — they
> already carry the roles and extensions.

## 2. The four routes

Pick by what you already have, not by what is cheapest — the cost differences
here are small next to the time differences.

| Route | Good when | Watch out for | Then read |
|---|---|---|---|
| **Managed Supabase** | You want the shortest path and no server to own. Best-trodden route in this repo. | Use the **Session pooler (port 5432)**, never the Transaction pooler (6543) — it drops prepared statements and the `search_path` pin. Needs `AUDIT_DB_SSL_MODE=no-verify` (internal CA). | [`postgres-parity.md` §Connecting](postgres-parity.md) |
| **Another managed Postgres** (Neon, RDS, Railway, Cloud SQL, …) | You or your org already runs one, or you want to stay on a provider you trust. | **Run the §1 preflight first.** This is where `CREATEROLE` bites — several managed tiers do not grant it, and that is unsupported rather than merely awkward. Also confirm pgvector is offered. | [`postgres-parity.md` §Connecting](postgres-parity.md) |
| **Docker on the machine you code on** | Solo use, or you just want the features working this afternoon. | It is only up when your machine is. Fine for one developer; it will not serve a second repo on another host. | [`postgres-parity.md` §Local disposable test container](postgres-parity.md) for a throwaway; [`self-hosted-store.md`](self-hosted-store.md) if you want it to persist |
| **A box you own** (NAS, home server, VPS) | You want cross-repo persistence, no bill, and control of the data. | You now own backups and restores. The recipe covers both — the backup script is only trusted once it reads back. | [`self-hosted-store.md`](self-hosted-store.md) — full worked recipe, Synology appendix included |

**Not documented here: prices, free-tier limits, signup flows.** They change
faster than this file can be re-verified, and a stale number here would be worse
than no number. Check the provider's current terms.

## 3. Once you have a DSN

```bash
# 1. Put it in .env (setup.mjs writes these for you if you re-run it)
AUDIT_DB_URL=postgresql://user:password@host:5432/dbname
AUDIT_DB_SSL_MODE=require        # no-verify for managed poolers; disable for local non-TLS

# 2. Create the schema — idempotent, safe to re-run
node scripts/setup-postgres.mjs --migrate

# 3. Confirm the tables and views the skills expect are really there
node scripts/check-setup.mjs
```

Sharing one store across several repos: `npm run setup:cloud` writes
`~/.audit-loop.env` once and the consumers read it. See
[`postgres-parity.md` §Shared cloud config](postgres-parity.md).

## 4. When connecting fails

The DSN is the entire abstraction, so failures are ordinary connection failures.
`setup-postgres.mjs` classifies them rather than printing a stack trace — the
three onboarding classes are *nothing answered* (host/port/firewall), *TLS
verification failed* (set `AUDIT_DB_SSL_MODE=no-verify`), and *credentials
rejected*.

One thing that is **not** a failure mode: silently falling back to local-only. A
DSN that is set but unreachable is a hard error by design. If you want local
mode, unset `AUDIT_DB_URL` — the tools will never make that choice for you.
