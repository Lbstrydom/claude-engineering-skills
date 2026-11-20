# Telemetry export — a consumer whose store CES cannot reach

> **What it is**: how a consumer whose audit store sits behind a private network sends CES a small,
> redacted summary instead of letting CES read the store. Design and decisions:
> [`private-store-telemetry-path.md`](../plans/private-store-telemetry-path.md).
>
> **When you need it**: a consumer's store is reachable only from its own machines (a tunnel, a private
> endpoint) and CES maintainers still want to know whether that consumer is healthy.
>
> **When you don't**: the consumer shares CES's store, or nobody on the CES side needs to see it. This is
> **opt-in on both sides and off by default** — with no `telemetry` block in the registry and no drop
> directory, nothing runs and nothing changes.

## What leaves the consumer's machine

One JSON file, `telemetry-export/v1`: **counts and closed enums only**. No finding text, titles, paths,
repo names, hostnames or DSNs — the schema has no field that could hold them, and the serialised bytes
are re-checked (secrets, sensitive paths, hostnames, IPs, URLs, DSNs, e-mails) and the export is
**refused** if anything trips. It carries: the store-reachability verdict, three migration-drift counts,
audit runs / converged runs / breakdowns by mode, reviewer verdict, finding severity, outcome and pass over
the last 7 days, and the open upstream reports as `{id handle, severity, age}`.

A group that could not be read is `{measured:false, reason}` and **carries no counts** — idle is a
measurement (a real zero), unreadable is a gap, and the file says which.

## Consumer side

1. Pick an alias (`[a-z0-9-]{1,32}`) and a drop directory — see *Provisioning the drop* below.
2. Export, by hand or from a trigger:

```bash
npm run telemetry:export -- --alias work --drop-dir /path/to/drop            # writes <alias>/<date>-<exportId>.json
npm run telemetry:export -- --alias work --drop-dir /path/to/drop --push     # …and git add/commit/push that one file
npm run telemetry:export -- --alias work --print                              # build and print, deliver nothing
```

`TELEMETRY_CONSUMER_ALIAS` and `TELEMETRY_DROP_DIR` are the env equivalents
([`environment-variables.md`](../reference/environment-variables.md)). Files are **immutable and uniquely
named** (full UUID): a repeat is a second file, never an overwrite. `--push` works only when the drop directory
is itself the root of its own Git work tree (never a folder inside another repository), runs exactly
`add`, `commit`, `push`, and never forces.

## Triggers — keeping it current

The exporter is cheap to call from anywhere, because `--if-older-than <hours>` makes a repeat run read and write
nothing when this alias already has a newer valid export. Three ways to run it, none required:

- **Weekly maintenance** (recommended): set `TELEMETRY_CONSUMER_ALIAS` and `TELEMETRY_DROP_DIR` (plus
  `TELEMETRY_EXPORT_PUSH=1` for a Git drop) where the local maintenance runner is enabled
  ([`local-maintenance-checks.md`](local-maintenance-checks.md)). The `telemetry-export` check is skipped unless both
  names are set, so it is invisible to a consumer that never opted in.
- **Opportunistically at push time**, so the file tracks real activity rather than a calendar: one line in the
  consumer-owned `.githooks/pre-push.local` (never the managed hook) —
  `node scripts/.claude-skills/telemetry-export.mjs --if-older-than 24 || echo "telemetry export failed (push not blocked)" >&2`.
  It cannot slow a push on a quiet day (it exits at once) and never blocks one — but a failure is SAID, not
  swallowed. With `TELEMETRY_EXPORT_PUSH=1` a recent file is not enough to skip: anything an earlier failed push
  left uncommitted or unpushed is delivered first.
- **By hand**, whenever.

`doctor` reports freshness: `machine/telemetry-export` is `not_applicable` when nothing is configured, and when
configured it separates *export overdue* (the newest valid export is older than a weekly cadence plus a day),
*never exported*, *only rejected files*, and *could not read the drop* — four different facts, none standing in for
another. It is a `machine` probe: it advises and never gates.

## CES side

Declare the consumer in the **gitignored** local registry (copy `scripts/lib/consumer-repos.local.example.json`), so the
consumer is never named in this public repo:

```json
{ "name": "audit-loop", "alias": "work", "path": "../audit-loop", "telemetry": { "alias": "work", "cadence": "weekly" } }
```

`cadence` is `weekly` (an export older than 14 days is `stale`) or `on-demand` (no freshness promise: shown
with its age, never stale). Then:

```bash
npm run telemetry:exports          # one line per expected exporter
npm run upstream:queues            # the same lines, appended to the queue card
npm run stores:drift               # …and to the drift card
npm run telemetry:exports -- --prune   # explicit retention: newest 8 valid / 20 rejected per alias
```

| State | Meaning | Shown as |
|---|---|---|
| `received` | a valid export within its policy | its figures, **with their age**, labelled "reported by the consumer, unauthenticated" |
| `stale` | the newest valid export is past its policy | the last figures, labelled with their age and "not current" |
| `rejected` | files arrived and none validated | the closed reason (`not-json`, `invalid: …`, `unsupported-version`, `alias-mismatch`, `future-dated`, `oversize`, …) |
| `never received` | a **clean** scan found nothing | **unmeasured — NOT zero** |
| `drop unreadable` / `scan incomplete` | the directory could not be read, or a bound (200 files per alias, 64 MB) was hit | "could not look" — **no** `never received` claim, because absence is unproven |

CES re-validates every file and does not trust the sender: a file is attributed to the alias whose
directory it sits in **and** whose body names the same alias; a future-dated file (more than a day ahead)
is rejected so a forged date cannot read as freshest; a directory that is not an expected exporter is
listed as `unattributed` and never read.

## Provisioning the drop

The exporter and the reader need exactly one thing from a channel: **a directory of files**. Recommended:
a **private Git repository cloned on both machines** — repository permissions are the per-writer access
control, every export is an auditable commit, and publication is atomic. A synced shared folder works the
same (the reader cannot tell), as does a person carrying the file *if the organisation permits it*.
Authentication is whatever the channel provides; CES labels every figure "unauthenticated" accordingly.

On the CES machine set `TELEMETRY_DROP_DIR` to its clone and `git pull` it before reading.
