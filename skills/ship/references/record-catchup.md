---
summary: Record catch-up — /ship's record half for PRs merged without it: one entry per PR, docs-only commit, human merge.
---

# Record catch-up (`ship-record.mjs`)

Fleet coordinators land PRs with `gh pr merge` or `fleet land`, which bypasses `/ship`, so its **record half** — the
session-log entry, the plan's Implementation Log line, the `Backlog:` line and the `ship_event` — never happens (measured
2026-11-16: storyline's `status.md` untouched for 325 commits, wine-cellar-app's for 394). `ship-record.mjs` does the record
half on its own, **without** `/ship`'s push or merge authority: it only CREATES files under `docs/status/entries/`.

## Who runs it

**One owner per repo: the fleet coordinator.** Chips never run it. Two runs on one machine serialise on a lock; two on two
machines still write the same per-PR files byte-for-byte (the name and content are a pure function of the PR's merge), so git
sees one identical add, not two entries. Only the run entry and the ship_event can duplicate, harmlessly.

## The verbs

| Verb | Writes? | Use |
|---|---|---|
| `node scripts/ship-record.mjs status [--json] [--fetch] [--base <branch>]` | never | how many merged PRs have no record; exit 0 always |
| `node scripts/ship-record.mjs init` | the marker | a repo still on one `status.md`: adopt per-entry files |
| `node scripts/ship-record.mjs floor [--write]` | one entry | once per repo: the summarised backfill, where per-PR recording starts |
| `node scripts/ship-record.mjs catchup [--write] [--max <n>] [--no-events]` | per-PR + run entries | record every unrecorded PR; dry run without `--write` |

Exit: 0 ok · 1 error (including a lost event write) · 2 argv · 3 refused. Every envelope carries `state` and `remedy` — the one
next command. `counts.unrecorded` is `null` whenever the state is not `measured`/`partial`: **unmeasured is never 0**.

## States

| State | Means | Remedy |
|---|---|---|
| `no-marker` | the entries directory's cutover README is absent on the base | `init` |
| `no-floor` | adopted, never floored | `floor --write` |
| `ambiguous-floor` | two floors on the base (two coordinators floored on two branches) | a human removes all but one in a reviewed PR |
| `unmeasured` | gh/git could not answer, `origin/HEAD` unset, an invalid floor | the reason names it |
| `partial` | some merges not local, or a single day overflowed the listing | `status --fetch` |
| `measured` | every PR since the floor classified | `catchup --write` when any are unrecorded |

## What counts as recorded

A PR is recorded iff (1) an entry on the **base tree** carries `<!-- ship-record v1 pr=<N> merge=<sha> -->` with its number
and merge sha, or (2) its own merge commit **added** a /ship-style entry, or (3) its merge added only the catch-up's own files
(it is itself a record PR). A modification, a deletion or another PR's entry is never evidence. A train member whose only
record is the train log gets its own entry — accepted redundancy.

## Rollout, per repo (coordinator)

1. `node scripts/ship-record.mjs init` (repos without the marker), then `floor --write` — both work in the working tree,
   so they go in ONE record PR. The floor needs a **complete** listing and every covered merge local (`--fetch`); it
   refuses otherwise. It never moves.
2. Commit both with `ship-commit.mjs --record` (below), open a docs-only PR. The user approves the merge. Until it
   merges, `status`/`catchup` still read the BASE tree and report `no-marker`/`no-floor` — expected, not a failure.
3. After it merges: `catchup --write` at each cadence point; paste the plan Implementation Log lines it prints (the script
   never writes a plan — PR #87 is why); commit with `--record`; docs-only PR; the user merges.

**Cadence**: after each `fleet land` (it prints the nudge), at every coordinator pass (`fleet status` shows
`records: N merged PR(s) unrecorded`), and at end of day.

## The record commit — and what stays human

Record the standing permission ONCE, at launch, in the user's exact words:

```bash
node scripts/fleet.mjs decision record --scope record-catchup --words-file -
```

(the words on stdin, never argv). Then commit:

```bash
node scripts/ship-commit.mjs --record --decision <dec-id> --gate not-run --no-run-id --skill ship --models claude --message-file - --expect-head <sha> --expect-branch <branch> --path docs/status/entries/<file>.md
```

`--record` refuses (exit 2) unless every path is a NEW entry file, the canonical `init` marker, or a plan change that only
inserts catch-up lines inside its `## Implementation Log`; the gate is `not-run`; and the decision is active (not revoked,
not expired). The commit carries `AI-Ship-Authority: record-catchup` and `AI-Decision: <dec-id>`, so the merge reviewer can
read the words (`fleet decision list`). **The decision is a declaration, not verified authority** — the path check is the
safety, and the user's merge of the record PR is the trusted approval. Nothing here merges, and no decision scope can grant a
merge, a push or an override.

## ship_event

Per recorded PR: outcome `warned`, `blockReasons: ["merged-without-ship"]` — never `shipped`, which would claim /ship's gates
ran. Reconciled every run (a lost write is retried). **At-least-once**: count these by `(repo_id, commit_sha)`; database
uniqueness is the prerequisite before any reader decides on their cardinality.

## Why `/ship --train` stays source-repo-gated

It would not fix the cause: `--train` is still human-typed, and its consumer value was the record half (this) and squash
trailers (now measured per entry: `Squash-commit trailers: …`). Lifting it means syncing ship-train, its store reader and fleet's
serial callback, and a tier classifier with no sync closure — a separate plan, on its own evidence.
