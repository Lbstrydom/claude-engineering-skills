# Scheduled-workflow cadence doctor

`scripts/workflow-cadence-doctor.mjs` — did the scheduled workflows this repo
relies on actually run, and did they actually pass?

**What it is**: a per-repo watch list of `(workflow, event, maxAgeDays)` entries,
checked against GitHub's workflow-runs API. **When you need it**: adding a cron
to a repo, reading a `WARNING` it printed, or wondering why a nightly's failure
went unnoticed.

Shipped to consumers at `scripts/.claude-skills/workflow-cadence-doctor.mjs`.

---

## Why a cadence has to be observed, not configured

A cron that does not fire produces no run, no failure and no notification. It
produces *nothing*, which looks exactly like a quiet week. A run queued for a
self-hosted runner that never comes online is cancelled after 24 hours, and a
cancelled run is easy to scroll past. Neither state reaches anyone.

So the workflow that is meant to be your early-warning signal is precisely the
one whose own health nothing is watching.

## The measured defect that produced this tool

The instrument was promoted from a consumer repo, where it was hardcoded to one
workflow and queried `?per_page=20&status=completed` with **no event filter**.

That consumer's `Phase gates` workflow runs on push, PR, dispatch **and** a
nightly cron, the nightly being — in the workflow's own comment — *"the standing
early-warning signal for the runner host"*. Every scheduled run failed for four
consecutive days:

```
2026-09-06  failure  6c4e8dc
2026-09-05  failure  098402d
2026-09-04  failure  081c365
2026-09-03  failure  3ccae57
```

Measured against that repo's live history on 2026-09-06:

```
ALL events      | runs:20  successes:11  | OK         | last successful run 0.1 days ago
event=schedule  | runs:4   successes:0   | NEVER-RAN  | ...
```

Eleven successful push runs drowned four failed scheduled ones, and the watcher
reported **healthy** for the entire outage. A red scheduled run looks identical
whether the host is sick or the workflow never asked it anything — and a watcher
that cannot distinguish *"the scheduled run is failing"* from *"pushes are fine"*
cannot see that class of defect at all.

The outage surfaced only because one commit happened to pass on `push` and fail
on `schedule`.

Both halves of that measurement are pinned as a regression fixture in
`tests/workflow-cadence-doctor.test.mjs` — including the assertion that the
**unfiltered** query still reads `OK` on the same data, because a fixture that
does not reproduce the blindness proves nothing about the fix.

## A second defect, found during the promotion itself

The source instrument gated its own `main()` on:

```js
process.argv[1].replace(/\\/g, '/').endsWith('scripts/<its-own-name>.mjs')
```

True in the repo it was written for. **False** at the consumer path
`scripts/.claude-skills/workflow-cadence-doctor.mjs` — so the promoted copy
would have run nothing, printed nothing and exited **0** in every consumer. A
watcher shipped as a silent no-op: the exact defect it exists to detect, one
layer down.

`--selfcheck-relocation` cannot catch this. Its handler sits at module top level
and returns before the direct-run guard is ever evaluated, so it proves imports
resolve and nothing more. The guard is now
`import.meta.url === pathToFileURL(process.argv[1]).href` — comparing the
resolved file, never a path suffix — and the regression test runs the CLI from a
real `scripts/.claude-skills/` layout and asserts non-empty output. Reintroducing
the original expression fails exactly that one test.

The generalisation: **a smoke test that returns before the code under test is
not a smoke test for that code.**

---

## Configuration

`.workflow-cadence.json` at the repo root, committed:

```json
{
  "watch": [
    { "workflow": "phase-gates.yml", "event": "schedule", "maxAgeDays": 2 },
    { "workflow": "live-smoke.yml",  "event": "schedule", "maxAgeDays": 2 }
  ]
}
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `workflow` | yes | — | Workflow **filename**, as GitHub's API addresses it (`phase-gates.yml`), not its `name:`. |
| `event` | no | *(all events)* | A GitHub trigger name. **Set this to `schedule` for anything cron-driven** — that is the whole point of the tool. Omitting it reproduces the defect above. |
| `maxAgeDays` | no | `10` | Staleness budget. `10` suits a weekly cron (~1.5 cycles before complaining); a nightly should say `2`. |
| `label` | no | `<workflow>@<event>` | Overrides the name used in messages. |
| `requireMeasurement` | no | `false` | A success counts only if the run did not declare [no-measurement](#a-third-defect-green-runs-that-measured-nothing). Boolean only — `"yes"` aborts. Costs ~2 API calls per in-budget success and needs `checks: read`. |

A malformed file **aborts** with exit 2 rather than being skipped. A watch list
the tool silently drops half of is a watch list whose author believes it is in
force — silence, from the file that exists to prevent silence.

## Verdicts

| Status | Meaning | Warns? |
|---|---|---|
| `ok` | A successful run inside the budget. **Means "the run did not fail"** — not "the thing it measures is current". With `requireMeasurement`, additionally: that run did not declare no-measurement. | no |
| `unmeasured` | `requireMeasurement` only. Every success inside the budget carried the [no-measurement marker](#a-third-defect-green-runs-that-measured-nothing): the cron fires and exits green, and has measured nothing for the whole window. | yes |
| `stale` | Last success is older than `maxAgeDays`. Wins over `unmeasured` — a cron that is not firing is the louder fact. | yes |
| `never-ran` | No successful run in the examined window. | yes |
| `undetermined` | The tool could not tell — API error, no token, unresolvable repo. | yes |
| `unconfigured` | The repo has cron workflows and no watch list, so nothing was checked. | yes |
| `nothing-to-watch` | No cron-triggered workflows in the repo at all. | no |

The rollup takes the worst across watches, with `undetermined` outranking a real
finding: not knowing is worse than a known-bad, because a known-bad is measured.
Order: `undetermined` > `never-ran` > `unmeasured` > `stale` > `unconfigured` > `ok`.

### Silence means exactly one thing

Every non-OK outcome warns, **including the tool's own API call failing**. A
checker that goes quiet when it cannot tell reproduces, one level up, the defect
it exists to detect. Silence here means "every watched workflow had a recent
successful run", and nothing else.

That is also why an absent watch list is not a pass. If the repo has crons and
no `.workflow-cadence.json`, the doctor warns `unconfigured` and prints the JSON
to paste. Only a repo with genuinely no scheduled workflows is quiet.

### The vacuity guard

`never-ran` has causes that read identically to a human:

- the workflow genuinely never succeeded — **evidence-backed**;
- the query matched nothing at all (wrong filename, an `event` that workflow
  never fires on) — **a broken instrument wearing a finding's clothes**;
- the workflow is not on the default branch — a **404**, a named cause.

Every verdict therefore carries `runsExamined` and a boolean `vacuous`, and the
three cases get different prose. A cadence checker that silently fetches zero
runs and reports `never-ran` is indistinguishable from a real finding, which is
how a watcher stops being trustworthy.

**`vacuous` covers exactly one shape: zero runs to examine.** It says nothing
about a run that exists, exited 0, and did nothing. That is the next section.

## A third defect: green runs that measured nothing

The run conclusion is all GitHub offers, and it has no third value. A job that
hits a fail-open branch — no credential, no snapshot, nothing to compare — and
exits 0 concludes `success`, byte-identical to a job that did its work. So
**`ok` means "the run did not fail"**, and has never meant more.

Measured 2026-09-13, in this repo, via the workflow-runs and check-run
annotations APIs:

```
architectural-drift.yml@schedule    success 2026-09-07  AUDIT_DB_URL not set — skipping architectural-drift
cache-seed-check.yml@schedule       success 2026-09-10  AUDIT_DB_URL not set — cannot query audit_runs; skipping check
learning-weekly-review.yml@schedule success 2026-09-07  AUDIT_DB_URL not set — skipping review
memory-health.yml@schedule          success 2026-09-07  AUDIT_DB_URL not set — skipping health check
migration-drift.yml@schedule        success 2026-09-07  AUDIT_DB_URL not set — skipping migration-drift check
model-freshness.yml@schedule        success 2026-09-07  (no annotation — it ran)
```

Five of the six watched crons were green-and-skipping — the store moved off
Supabase and GitHub-hosted runners have no `AUDIT_DB_URL` — and `memory-health.yml`
had carried that annotation on **every** scheduled run since at least 2026-06-22
(the oldest of twelve runs read). `npm run cadence:doctor` reported `ok` on all
six. A consumer found the same shape by hand ([wine-cellar-app #507](https://github.com/Lbstrydom/wine-cellar-app/pull/507)):
a wrapper returning 0 on `no active snapshot` kept a workflow reading a dead
credential green four times a day for ~26 days, and its PR body said outright
that *"a cadence doctor cannot catch this"*. It could not; now it can, if told.

### The convention

The step that **decides** not to measure emits a check-run annotation with a
fixed title:

```bash
echo "::notice title=audit-loop-no-measurement::AUDIT_DB_URL not set — skipping health check"
```

The title is the contract; the level (`notice` / `warning`) is the emitter's
choice and the reader ignores it. From Node, `scripts/lib/measurement-marker.mjs`
(shipped in the bundle) exports `emitNoMeasurement(reason)` — the workflow
command on stdout under `GITHUB_ACTIONS`, a plain `[no-measurement]` line on
stderr elsewhere — plus `NO_MEASUREMENT_TITLE` and the predicate the doctor
uses, so writer and reader cannot drift apart.

A watch entry with `"requireMeasurement": true` then has the doctor walk the
successful runs inside the budget, newest first, reading each run's jobs and
each job's annotations, and stopping at the first run **without** the marker:
that is the run the verdict rests on, and its age is the reported age. If every
success inside the budget carries the marker, the verdict is `unmeasured`.

Three properties worth knowing:

- **Opt-in, and byte-identical when not taken.** A watch without
  `requireMeasurement` makes no annotation calls and reads exactly as before.
  A workflow that never emits the marker reads as measured — which is what `ok`
  always meant, now stated. The five workflows above opt in; `model-freshness.yml`
  has no skip branch and does not.
- **An unread run is never a clean run.** If the annotations of an in-budget
  success cannot be read (network, a 403), the verdict is `undetermined`, not
  `ok`. The 403 message names the remedy: a workflow that pins `permissions:`
  needs **`checks: read`** in addition to `actions: read` (a fine-grained PAT
  needs "Checks: read"). The local `gh` keyring token has it.
- **Annotations, not the job log, deliberately.** The log was the obvious
  instrument and it is a trap: Actions prints the full `run:` script body before
  executing it, so a grep for the marker matches the echoed source of the branch
  that did **not** fire. Annotations exist only for commands that ran.

Both halves of the memory-health history above are pinned in
`tests/workflow-cadence-doctor.test.mjs`: as emitted before the convention
(untitled), the fixture reads `ok`; with the title, `unmeasured`. A positive
control asserts the five workflows still emit the title and are still opted in.

**What it still cannot see**: a run that measured the *wrong* thing and said
nothing — a stale snapshot compared against itself, a credential that connects
to a store nobody writes to. The marker only carries what the emitting step
knew. The honest check for any workflow remains its own output; this closes the
case where the workflow *knew* it had none.

## Advisory, and the one exception

The default exit is **0 on every verdict**. A cron that missed its slot is a
reason to tell someone, not a reason to block an unrelated push — a gate that
red-lights every push because a cron slipped on a workstation is the cried-wolf
shape that earns `--no-verify`.

`--strict` (exit 1 when the rollup is not `ok`) exists for exactly one caller:
`maintenance-checks.mjs`'s `runCheck` derives a check's status from the spawned
process's **exit code**, so an always-exit-0 doctor registered there would report
`ok` forever. It changes no verdict, and no push-time caller uses it.

## Usage

```bash
npm run cadence:doctor
```

```bash
node scripts/workflow-cadence-doctor.mjs --repo owner/name --workflow ci.yml --event schedule --max-age-days 2
```

| Flag | Purpose |
|---|---|
| `--repo owner/name` | Defaults to `GITHUB_REPOSITORY`, then the `origin` remote. |
| `--config <path>` | Defaults to `.workflow-cadence.json` at the repo root. |
| `--workflow` / `--event` / `--max-age-days` / `--require-measurement` | A one-off probe. **Replaces** the watch list rather than merging into it. |
| `--json` | One envelope on stdout. `ok` reports whether the *doctor ran*, not repo health — the verdict is `status`. |
| `--strict` | Exit 1 when the rollup is not `ok`. See above. |

Exit codes: `0` reported · `1` `--strict` and not `ok` · `2` usage error
(unknown flag, malformed watch list).

**Credentials**: `GITHUB_TOKEN` or `GH_TOKEN`, needing workflow-run read access
(`actions: read`), plus `checks: read` for any watch with `requireMeasurement`.
Inside Actions, the job's own `GITHUB_TOKEN` is enough **only if the workflow's
`permissions:` block grants both** — a block naming `actions: read` alone makes
every `requireMeasurement` watch `undetermined`, with the message saying which
scope to add. Locally, `gh auth token` reads both APIs (verified 2026-09-13).

## Where to run it

- **A push-triggered workflow.** Where the source instrument lived, and where it
  is read most often. Under `GITHUB_ACTIONS` the output uses `::warning::`
  annotations so it surfaces in the run summary.
- **The local weekly-maintenance replica** — registered as `workflow-cadence`,
  see [local-maintenance-checks.md](../runbooks/local-maintenance-checks.md).

## What this is not

**It is not a notification.** It tells whoever reads CI output. Nothing here
pages a human, and that gap is what let four red nightlies pass unnoticed in the
incident above — the tool would have printed a warning on every push from
3 September, but somebody still has to read it.

**It does not prove a workflow's effect is fresh.** The honest check for any
given workflow is its own output — a snapshot's age, a smoke test's last green.
That is per-workflow, needs that workflow's credentials, and does not generalise.
The workflow-run timestamp is the available proxy, and it answers the question
actually being asked: did the thing run, and did it pass. `requireMeasurement`
narrows the gap by one named case — the run *itself* declaring it measured
nothing — and no further.
