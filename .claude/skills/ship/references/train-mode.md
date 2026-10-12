---
summary: /ship --train runbook — plan, land, verify, sync a batch of ship-ready PRs; refusals, overrides, recovery.
---

# `/ship --train` — landing a batch of ship-ready PRs

**Source-repo-gated** — use this ONLY when `package.json.name === "claude-engineering-skills"`;
in any other repository say so and stop. `ship-train` is not part of the synced consumer
tooling: it classifies PRs against the sync closure and publishes through the source
repository's own sync tools, neither of which exists in a consumer.

One human `/ship --train` lands several already-audited PRs together: one
`status.md` entry, per-PR provenance written into each squash commit, ONE
combined test run (fleet), and ONE consumer sync. Without it, each PR needs its
own `/ship`, and GitHub's squash replaces the commit message — so the `AI-*`
block is lost (measured 2026-10-11: of 80 merged PRs, 54 never ran `/ship` and
9 lost the trailer on the squash).

## Who runs what

Sessions stop at **ship-ready**: audited, PR open, `fleet ready`. They do **not**
run `/ship` and do **not** write `status.md`. When a train is due, the user types
`/ship --train` **once**, in the coordinator session, and that session runs the
steps below.

**This is a human-only gate, never self-invoked.** `/ship` keeps
`disable-model-invocation`, and `--train` does not relax it: a train merges PRs
and publishes to consumers, so an agent holding that authority standing would be
exactly the laundering path the gate exists to close. If the user only said a
train "sounds good", offer `/ship --train` and stop.

## Overrides: read only from the invocation

`--waive <n,…>` (declare a gate for a PR whose evidence is only partial),
`--allow-unaudited <n,…>` (land a PR no audit run covers) and `--end-of-day`
(make a small train due). They are honoured **only** when the user typed them on
this `/ship --train` invocation. Pass the **same** flags to `plan` and `land`;
nothing carries them between steps, and a conversation that merely mentions
skipping a gate is never one. Adding one on your own initiative to get past a
refusal is the gate working, not a defect.

`--composer <line>` is required on `plan`, `message` and `land`: the model line
composing the squash messages (for example `claude`). There is no default,
because an omitted flag would publish a guess as a participant.

## Runbook

`ship-train` persists **no state of its own**. Every verb recomputes from owned
state: fleet's train manifest, GitHub, git and the audit store.

| Step | Do | Command |
|---|---|---|
| T0 | Pre-ship nudges, once per train (not per PR) | SKILL.md Step 0.5 |
| T1 | **Plan** (read-only): per ready PR its tier, the audit run bound by content, the planned gate or the refusal, and whether a train is due. Not due: stop and name the missing trigger | `node scripts/ship-train.mjs plan --composer claude --json` (add `--pr 202,203` to name PRs) |
| T2 | **Refusals** stop the train (table below) | invocation flags only |
| T3 | **Train log**: on branch `ship/train-<YYYYMMDD>-<lowest PR>` write ONE `status.md` entry (template in `status-md-format.md`, gate column says *planned*), run the AGENTS drift check (Step 4), commit with `ship-commit.mjs --gate not-run`, push, open the PR, then `fleet claim` and `fleet ready`. The log is an ordinary ride-along source | Steps 2, 4, 6 |
| T4 | **Build**: the existing train build with one combined test run. Fleet writes an immutable manifest pinning each source's PR number and head. Not approvable: stop | `node scripts/fleet.mjs land --select <sources…,log>` |
| T5 | **Land** (merges): serial landing; at each merge fleet asks for that PR's message, decided fresh on the exact head. A fresh refusal stops the run **before** that merge | `node scripts/ship-train.mjs land --train <id> --composer claude` |
| T6 | **Verify**: every landed claim must be TRUE (trailers parse; git and the store support each one); derives the final merge OID and any interleaved foreign commits; `--write-note` files the actual gates for the next entry | `node scripts/ship-train.mjs verify --train <id> --write-note` |
| T7 | Post-land advisories, once per train | SKILL.md Steps 6.5–6.7 |
| T8 | **Consumer sync**: re-verifies in the same invocation, then publishes the final merge OID from a clean detached worktree (`sync-to-repos`, then `sync-pr`) | `node scripts/ship-train.mjs sync --train <id>` |
| T9 | Ship event: ONE `record-ship-event` per `/ship --train` invocation (a train finished across two invocations records two, each true of its own) | SKILL.md Step 7 |

## Refusals in `plan` and `land`

| Code | Meaning | Override |
|---|---|---|
| `unaudited` | no audit run's content matches any commit of a non-ride-along PR | `--allow-unaudited <n>` |
| `run-not-converged` | a run audited this content but did not converge | `--waive <n>` |
| `ancestry-only` | a run audited a commit on the branch, but its audited tree matches no PR commit | `--waive <n>` |
| `store-unavailable` | the audit store could not be read (a ride-along then lands `not-run`) | none |
| `unbindable` / `no-head-tree` | the PR could not be bound or its tree resolved: nothing was checked | none |
| not fleet-ready, draft, wrong base, head moved | fleet or GitHub says the PR is not landable | fix the PR |
| not due | only ride-alongs wait, or no trigger fired | `--end-of-day`, or wait |

A PR is **urgent** if it reaches consumers (the sync closure), **standard** if it
is other code, **ride-along** if it is only tests, docs or config. A train is due
when at least one PR is not a ride-along AND (an urgent PR waits, or at least 3
PRs wait, or it is end of day). Ride-alongs never trigger a train alone.

## What gate lands

The entry written at T3 records the **planned** gate; T6's note records the
**actual** one. `AI-Gate: passed` on a squash needs the destination to require
branches to be up to date (a ruleset or classic protection with strict status
checks, no bypass), because only then does GitHub itself guarantee the squash
tree equals the audited tree. On an unpinned destination the same audited PR
lands as `converged`: "a store-verified converged run, and the committed tree is
not asserted equal to the audited tree". `plan` reports the pinning verdict up
front. Do not hand-write evidence to chase `passed`.

## Recovery: from owned state only

| Interrupted at | Do |
|---|---|
| T5 landing (stopped, or the process died) | `land --train <id> --resume` with the same overrides. A PR GitHub already merged is observed, never resubmitted; an open PR is decided fresh on its current head, so a stale message is never replayed |
| T6 verify | re-run it; it is read-only apart from the note |
| T8 sync | re-run it; a consumer already current is left alone. A second concurrent sync of the same train is refused while the first holds its lease |

`land --resume` must be run through `ship-train`, not raw `fleet land --resume`:
a run started by `ship-train land` records that it requires a message, and a
resume without one stops before any merge.

`sync` refuses unless verification is clean, or every remaining block is
acknowledged on THIS invocation: `--accept-interleaved` (a foreign commit landed
between the train's merges) and `--accept-provenance-mismatch` (a landed claim
does not hold). A PR merged at a head the train did not test, an unmerged source
and a merge off the destination's first-parent chain have **no** override. Newer
commits on the destination are reported as **not** part of the publication.
