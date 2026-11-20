# Moving the audit store to a different Postgres

> **What it is**: the checklist for pointing every consumer at a *new* database —
> a provider change, a public → private endpoint move, a tunnel, a new tenant.
> It exists because a fresh store silently costs you things you only discover one
> at a time (a consumer's own report, 2026-11-20: every repo's architecture
> snapshot gone, the store fingerprint changed, windowed metrics back at zero).
>
> **When you need it**: any change to the database `AUDIT_DB_URL` names, for one
> consumer or all of them.
>
> **When you don't**: a password rotation or a TLS-mode change against the *same*
> database changes nothing below. Connection strings, roles and migrations live in
> [`postgres-parity.md`](postgres-parity.md); this page does not repeat them.
>
> **Status of the commands**: the `setup-postgres.mjs` and `npm run` steps are the
> repo's own. The `pg_dump` / `pg_restore` lines are the standard PostgreSQL
> recipe, **not exercised end to end by this repo** — rehearse them on a scratch
> database before the real move, and treat the verification step as the contract.

## 0. Decide: copy the history, or start fresh

| | Copy history (`pg_dump` → `pg_restore`) | Fresh store (migrate only) |
|---|---|---|
| Audit runs, findings, ledgers, debt, learning decisions | kept | **gone** |
| Architecture snapshots + embeddings | kept (same embedding profile) | **gone** — `arch:refresh` per consumer |
| Windowed metrics / bandit arms | continue | **restart from zero** |
| Cost | an hour of care, a dump file to handle | embedding spend per consumer, a quiet period |

A fresh store is a legitimate choice (the old history may be exactly what you are
leaving). It is a *decision*, not a side effect: say it out loud to every consumer
owner before you flip the first DSN.

**A dump contains stored findings, which can quote code.** Treat the dump file as
sensitive: encrypt it at rest, keep it off shared drives, delete it after the
restore is verified.

## 1. Prepare the target

1. **Meet the requirements** in [`provisioning-postgres.md`](provisioning-postgres.md)
   §1 — Postgres 13+, `vector`, `pg_trgm`, `pgcrypto`, and a setup role with
   `CREATEROLE` + `CREATE EXTENSION`. For a history copy the target's `vector` must
   be the same major version as the source's or newer.
2. **Create the database and the roles.** Use the two-role split described in
   [`postgres-parity.md`](postgres-parity.md) §*Two roles: an owner and a
   least-privilege runtime role* if your policy forbids handing developers an
   owner credential. Do this *before* restoring, so default privileges exist.
3. **Reach it.** On a private network that means whatever tunnel your
   organisation uses; on a tunnel set `AUDIT_DB_SSL_SERVERNAME` (and
   `AUDIT_DB_SSL_CA`) so `AUDIT_DB_SSL_MODE=require` still verifies the real
   server — see [`environment-variables.md`](../reference/environment-variables.md).
   A team can commit `.audit-loop/store-setup.json` so `doctor` tells every new
   developer how ([`consumer-adoption.md`](consumer-adoption.md) §*Store
   reachability*).

## 2a. Fresh store

```bash
# Owner/admin DSN only for this command — the runtime role cannot apply migrations.
AUDIT_DB_URL="postgres://<owner>:<password>@<host>:<port>/<database>" \
AUDIT_DB_SSL_MODE=require \
node scripts/setup-postgres.mjs --migrate
```

Every migration applies in order. Then go to §3.

## 2b. Copy the history

```bash
# 1. Dump ONLY the `public` schema (the store is public-only), no ownership or ACLs.
pg_dump "<source admin DSN>" --schema=public --format=custom --no-owner --no-acl --file=audit_store.dump

# 2. Extensions + the compat stub roles on the target, without migrating.
AUDIT_DB_URL="<target owner DSN>" node scripts/setup-postgres.mjs --bootstrap-only

# 3. Restore. --no-owner makes the connecting (owner) role own everything.
pg_restore --dbname="<target owner DSN>" --no-owner --no-acl --exit-on-error audit_store.dump
```

Then reconcile the restored schema with this checkout's migration set:

```bash
AUDIT_DB_URL="<target owner DSN>" node scripts/setup-postgres.mjs --check-drift --live
```

`--migrate` applies anything the dump predates. A dump that did not carry the
`audit_loop_migrations` ledger is a pre-ledger database: run `--adopt` instead
([`postgres-parity.md`](postgres-parity.md) §*Setup recipe*), which diffs the live
schema first and aborts on real drift.

**Re-grant to the runtime role after the restore** (`--no-acl` dropped every
grant): the grants and `ALTER DEFAULT PRIVILEGES` block in the two-role section.

**Verify before cutting over — this is the contract, not a formality.** Compare
per-table row counts source vs target; run `--check-drift --live` clean; run one
real read as the *runtime* role (a missing `BYPASSRLS` returns **zero rows**, not
an error). The embeddings carried over only if the embedding profile did not
change — a different deployment or provider is a different vector space, and
`arch:refresh` then re-embeds on its own.

## 3. Point the consumers at it

Per consumer, in this order:

1. Set `AUDIT_DB_URL` (and `AUDIT_DB_SSL_MODE` — they travel as one bundle — plus
   `AUDIT_DB_SSL_SERVERNAME` / `AUDIT_DB_SSL_CA` on a tunnel) in that repo's `.env`
   or the shared `~/.audit-loop.env`.
2. `node scripts/doctor.mjs` — `machine/store-reachability` must read
   `reachable`. `configured-but-unreachable` prints the setup pointer if the repo
   committed one.
3. **Fresh store only**: `npm run arch:refresh:full` in that consumer. This is
   paid embedding work, so it is a deliberate step; until it runs,
   `get-neighbourhood` reports the repo as **unregistered** (`cloud:true`,
   `repoRegistered:false`) or as having no snapshot — not "no similar code". Also
   `npm run security:refresh` if the repo uses security-incident memory.
4. From this repo: `npm run stores:drift` and `npm run upstream:queues`.

## 4. What changes, and what restarts

- **The store fingerprint changes.** It is a hash of `host:port/database` with
  every loopback spelling folded to one (`127.0.0.1`, `localhost`, `::1`). So
  `stores:drift`, `upstream:queues` and the committed disposition ledger see a
  *new* store. **Gotcha on a tunnel**: two different private stores reached through
  local ports are told apart only by that local port and the database name — give
  them different ones, or their fingerprints collide.
- **Windowed metrics restart** on a fresh store (seven-to-thirty-day windows over
  `created_at` are empty), so a figure compared across the move is two populations,
  not a trend. Note the move date next to any such comparison.
- **Nothing long-running needs restarting** — the tooling is one process per
  command and reads the DSN at start. What *does* hold the old value: a shell that
  exported `AUDIT_DB_URL` (shell beats `.env`), a scheduled task or local
  maintenance runner, CI secrets, and any dashboard you generated before the move.
- **Keep the old store, read-only, until the new one has carried a normal week.**
  Rollback is setting the old DSN back; nothing in the old database was touched.
