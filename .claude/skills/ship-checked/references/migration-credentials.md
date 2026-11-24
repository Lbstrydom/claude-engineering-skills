---
summary: Which role applies migrations, why the runtime DSN cannot, and where its credential belongs (never in .env).
---

# Applying migrations: which role, and where its credential lives

**This page never contains a credential.** It records *which role* applies
migrations and *where its secret is kept*, so the next person to hit a blocked
migration does not have to rediscover it.

## The runtime DSN usually cannot apply migrations

`AUDIT_DB_URL` in a repo's `.env` is the **runtime** role. On a managed Postgres
(Azure Flexible Server, RDS, Cloud SQL) that role deliberately does not own the
schema, so DDL is refused:

```
42501  must be owner of table audit_findings
42501  permission denied for schema public
```

**That is the least-privilege boundary working, not a fault.** Do not fix it by
granting the runtime role ownership, and do not fix it by putting an
administrative DSN into `.env` — either one makes *every* tool invocation in
that repo run with rights it does not need, which is the thing the split exists
to prevent.

Measured 2026-08-30 in a consumer's Azure store: `public` owned by
`azure_pg_admin`, tables by `psqladmin`, `has_schema_privilege(runtime_role,
'public', 'CREATE')` false. Its store sat **2 migrations behind for a day** —
the `.sql` files had synced to disk and were never applied, so its code and
schema disagreed silently — because the documented remedy could not be run with
the DSN that repo had.

## Where the admin credential belongs

**In your password manager or secret store. Not in any file in the repo.**

Shell environment beats `.env` in the loader, so a migration run overrides it for
one command and touches nothing on disk:

```bash
AUDIT_DB_URL="postgres://<admin-role>:<password>@<host>:5432/<database>" AUDIT_DB_SSL_MODE=require node scripts/.claude-skills/setup-postgres.mjs --migrate
```

(In the source repo the path is `scripts/setup-postgres.mjs`.)

`AUDIT_DB_URL` and `AUDIT_DB_SSL_MODE` are resolved as ONE bundle — set both or
neither. Setting only the URL leaves the SSL mode coming from a different layer,
which is how one host ends up addressed with another's connection policy.

## What to write down, per repo

Record these three facts somewhere durable and non-secret — this file, your
runbook, or a `docs/security-strategy.md` entry. Without them the store drifts
again on the next migration and the next person repeats the whole diagnosis:

| Fact | Example |
|---|---|
| Which role owns the schema | `psqladmin` |
| Where its credential is kept | vault entry name / secret-store path — **never the value** |
| Who can retrieve it | the operator or team, by name |

## Checking whether you are behind

From the SOURCE repo, across every consumer store at once:

```bash
npm run stores:drift
```

Advisory, never blocks. It distinguishes a store that answered from one that
could not be reached — zero stores answering reports `NOTHING WAS CHECKED`, never
`all current`. In a single repo, `node scripts/.claude-skills/setup-postgres.mjs
--check-drift` answers for that store alone.

## Do not work around it

- **Do not** grant the runtime role table ownership to make `--migrate` succeed.
- **Do not** commit an admin DSN, or add one to `.env`, `~/.audit-loop.env`, or
  CI variables that every job can read.
- **Do not** hand-apply DDL in a console and leave `audit_loop_migrations`
  unaware — the ledger is what every later drift check reads, and a schema change
  it never recorded reads as drift forever after.
