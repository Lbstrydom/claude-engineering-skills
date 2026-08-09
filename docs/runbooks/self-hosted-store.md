# Self-Hosting the Audit-Loop Store — Docker Recipe

> **What it is**: one worked, copy-pasteable recipe for running the audit-loop
> Postgres store on a machine you own — a NAS, a home server, a spare VM.
>
> **When you need it**: you want the cloud learning store (cross-repo findings,
> architectural memory, the learning tables) without a managed Postgres bill, or
> your network can't reach one.
>
> **When you don't**: any managed Postgres works and needs no recipe — set
> `AUDIT_DB_URL` and run the migrations. Start at
> [`postgres-parity.md`](postgres-parity.md), which owns connection strings,
> the privilege model, migrations, and drift checking. **This file does not
> repeat them.** It covers only what's specific to running the server yourself:
> the container, the secret, the backups, and the traps.

**The store is plain Postgres 13+ with pgvector.** Nothing in this codebase
knows where it runs — `AUDIT_DB_URL` is the entire abstraction, and
"Supabase-hosted vs self-hosted" is a connection string. So treat the compose
file below as *a* reference implementation, not *the* supported topology. If
your host does Postgres differently, that is fine; only the DSN has to be true.

---

## 1. Prerequisites

- Docker with Compose v2.
- An image carrying **pgvector**. `vector` is the one extension that does not
  ship with stock Postgres, and building it on a low-power box is unpleasant —
  use a prebuilt image: `pgvector/pgvector:pg17` (multi-arch, includes arm64).
- Roughly 1 GB RAM. The tuning below assumes that; raise it if you have more.
- A directory on persistent storage for the data volume, the secret, and the
  backups.

Set `STACK_DIR` to that directory for the rest of this runbook. Examples use
`/srv/audit-pg`.

## 2. Generate the password before you write anything

Generate once, store once, reuse. Regenerating on a re-provision orphans the
data volume: the new password will not match the one baked into the existing
database, and the container will come up refusing every connection.

```bash
openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 40 > /srv/audit-pg/.dbpass
```

Alphanumeric only, deliberately — it keeps the DSN free of percent-encoding
hazards. A `@`, `/`, or `#` in a password silently truncates the URL.

## 3. The secret file and its directory

```bash
install -d -m 750 -o root -g root /srv/audit-pg
printf 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=audit_loop\nPOSTGRES_INITDB_ARGS=--data-checksums\n' \
  "$(cat /srv/audit-pg/.dbpass)" > /srv/audit-pg/db.env
chmod 600 /srv/audit-pg/db.env
```

**The directory mode matters as much as the file mode**, and this is the part
that is easy to get wrong. POSIX delete and rename permission comes from the
*directory*, not the file. A `600 root:root` secret sitting in a `0777`
directory cannot be read by others — but it can be deleted and replaced, as can
`backup.sh`, which runs as root inside a container holding your database
credentials. If your platform creates shared folders world-writable by default
(Synology does), fix the directory, not just the file.

**`--data-checksums` is set at init and cannot be added later.** It is cheap
insurance against silent corruption on consumer disks. Skipping it means a
rebuild to get it.

## 4. `docker-compose.yml`

```yaml
services:
  audit-pg:
    image: pgvector/pgvector:pg17
    container_name: audit-pg
    restart: unless-stopped
    env_file:
      - ./db.env
    # Pick a host port that is genuinely free — see the port trap in §9.
    ports:
      - "5433:5432"
    volumes:
      - /srv/audit-pg/data:/var/lib/postgresql/data
      - /srv/audit-pg/backup:/backup
    stop_grace_period: 2m
    command:
      - postgres
      - -c
      - listen_addresses=*
      # Sized for ~1 GB RAM shared with other services. shared_buffers plus
      # maintenance_work_mem is the resident floor; the rest stays small.
      - -c
      - shared_buffers=128MB
      - -c
      - effective_cache_size=384MB
      - -c
      - maintenance_work_mem=128MB
      - -c
      - work_mem=4MB
      - -c
      - max_connections=25
      - -c
      - wal_compression=on
      - -c
      - checkpoint_completion_target=0.9
      # Managed Postgres usually kills a runaway query for you. Vanilla does
      # not, and an unbounded query will pin a small box for as long as it
      # takes. Generous enough for bulk work (arch:refresh, pg_restore COPY).
      - -c
      - statement_timeout=600s
      - -c
      - log_min_duration_statement=5000
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d audit_loop"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s

  # A sidecar rather than a host cron entry, so the whole stack is described by
  # this one file and survives a rebuild of the host.
  audit-pg-backup:
    image: pgvector/pgvector:pg17
    container_name: audit-pg-backup
    restart: unless-stopped
    depends_on:
      - audit-pg
    env_file:
      - ./db.env
    volumes:
      - /srv/audit-pg/backup:/backup
      - /srv/audit-pg/backup.sh:/backup.sh:ro
    entrypoint: ["/bin/sh", "/backup.sh"]
```

## 5. `backup.sh` — a dump only counts once it reads back

```sh
#!/bin/sh
set -u
BACKUP_DIR=/backup
KEEP=14
INTERVAL=86400

# Stagger the first run so a host reboot doesn't dump while services start.
sleep 300

while true; do
  TS=$(date +%Y%m%d-%H%M%S)
  OUT="$BACKUP_DIR/audit_loop-$TS.dump"
  if PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h audit-pg -U "$POSTGRES_USER" \
       -d "$POSTGRES_DB" -Fc -f "$OUT" 2>/tmp/err; then
    # Verify before counting it. An unverified dump is not a backup.
    if pg_restore --list "$OUT" >/dev/null 2>&1; then
      echo "[backup] ok $TS ($(du -h "$OUT" | cut -f1))"
    else
      echo "[backup] CORRUPT $TS - discarding"
      rm -f "$OUT"
    fi
  else
    echo "[backup] FAILED $TS: $(cat /tmp/err)"
    rm -f "$OUT"
  fi

  ls -1t "$BACKUP_DIR"/audit_loop-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) \
    | while read -r f; do rm -f "$f"; done

  sleep "$INTERVAL"
done
```

```bash
chmod 755 /srv/audit-pg/backup.sh
cd /srv/audit-pg && docker compose up -d
```

## 6. Get a second copy off the box

On-box backups protect against a bad migration or an accidental delete. They do
not protect against losing the machine, and on a single-volume box there is
nowhere on-box worth backing up *to*. Copy the newest dump somewhere else on a
schedule, and re-verify it there with `pg_restore --list` — a copy you have
never opened is a hope, not a backup.

Treat this as required, not optional, the moment this store stops having an
upstream you could re-sync from.

## 7. Bootstrap the schema

```bash
AUDIT_DB_URL=postgresql://postgres:PASSWORD@192.0.2.10:5433/audit_loop
AUDIT_DB_SSL_MODE=disable
```

`disable` is for a LAN host with no TLS. Use `require` for anything crossing a
network you do not control.

Then, from a clone of this repo:

```bash
node scripts/setup-postgres.mjs --migrate
```

Verify, and make the verification the thing you trust:

```bash
node scripts/setup-postgres.mjs --check-drift
```

Migration mechanics, the `--adopt` path for a pre-provisioned database, exit
codes, and the privilege model all live in
[`postgres-parity.md`](postgres-parity.md).

## 8. Restore

```bash
docker exec -i audit-pg sh -c \
  'PGPASSWORD=$POSTGRES_PASSWORD pg_restore -U $POSTGRES_USER -d $POSTGRES_DB \
   --no-owner --single-transaction /backup/audit_loop-TIMESTAMP.dump'
```

**Run `ANALYZE` afterwards.** `pg_restore` does not compute statistics, and
without them the planner picks pathological plans — a query that normally
returns in milliseconds has been measured never finishing. This looks exactly
like a corrupt restore and is not one.

Then re-run `--check-drift` and compare row counts against whatever you took
the dump from.

## 9. Traps that cost real time

**The host port may already be taken, invisibly.** Many appliance OSes run
their own Postgres bound to `127.0.0.1:5432` for internal services. An external
port scan reports 5432 *closed*, because it is loopback-bound — so the
collision stays invisible until `docker compose up` fails with "address already
in use". Pick a distinct host port (5433 above) and move on; there is nothing
to fix.

**The database role must be named `postgres`.**
[`tests/fixtures/expected-schema.json`](../../tests/fixtures/expected-schema.json)
records object owners and grantees by role *name*. Any other name produces
~150 owner and grant diffs that are purely cosmetic and permanently red, which
trains you to ignore a gate that exists to be trusted.

**`POSTGRES_PASSWORD` is consumed only by `initdb`, on first boot.** Three
consequences, all of which have bitten:

- Changing it in `db.env` and recreating the container **rotates nothing**. A
  real rotation is `ALTER ROLE postgres PASSWORD ...` against the live
  database, followed by updating `db.env` and every DSN.
- On an initialised volume the server ignores the variable entirely, and
  `pg_isready` does not authenticate. So a wrong or missing value still yields
  a *healthy-looking* container while the backup sidecar — which genuinely
  needs the password for `pg_dump` — silently fails.
- Therefore **verify any change to this variable by confirming a fresh dump
  appears and passes `pg_restore --list`**, never by observing that the
  containers are up. "Green stack, dead backups" is the failure this prevents,
  and on a store with no upstream it is discovered at the worst moment.

**Do not regenerate `expected-schema.json` from a dump/restore store.** A
restore compacts the `ordinal_position` gaps that `DROP COLUMN` tombstones
leave behind, so a fixture generated from a restored database disagrees with
one built by replaying migrations. Use `node scripts/db-test-container.mjs
regen-schema`.

**Container env vars are visible to anyone who administers the host.** `env_file`
is load-time sugar: Docker copies the values into the container's `Config.Env`,
so `docker inspect` and any management GUI display them. Moving the password
between env files changes nothing here. If that visibility matters, the only
thing that removes it is not using an environment variable — a Compose
`secrets:` entry plus `POSTGRES_PASSWORD_FILE`, with the sidecar reading a
`PGPASSFILE` instead. Weigh it honestly: an administrator can read the secret
file anyway, so this buys "not on screen, not in a screenshot, not in a support
bundle", not access control. On a single-admin box that is a small gain, and
per the trap above it is a change that can fail silently.

## 10. Synology appendix

The recipe above is generic. Synology specifics, in case that is your host:

- **DSM runs its own PostgreSQL** on `127.0.0.1:5432` for Drive and Photos, and
  will not give it up. This is the concrete instance of the port trap.
- **Shared folders are created world-writable** at the POSIX layer, with access
  enforced by Synology ACLs above it. Verify by actually writing a probe file as
  a non-privileged account rather than reading the mode bits — and set the stack
  directory to `750` regardless.
- **Container Manager displays container environment variables** to any DSM
  administrator, which is the visibility discussed in §9.
- **Hyper Backup needs a target that survives the box.** On a single-volume unit
  with no external disk there is nowhere on-box worth backing up to, so §6's
  off-box copy is the real protection rather than a supplement.
