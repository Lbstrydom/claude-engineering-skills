# Plan: Standing Queue Burndown — the three gates that fire on every ship

- **Status**: In Progress — re-measured 2026-08-28. Q1: 97 raw code rows, but
  70 have aged out (`agedOutByMode.code`) — **~27 currently actionable**, an
  aging concept added since 2026-08-09 that this doc did not previously
  document (§2). Q2: its stated blocker is **resolved** — the reader now
  reports a true total, **162** open (94 code / 68 plan), 34 aged out, 42
  already `accepted-permanent` (§3). Q3: **rescoped out of this plan's active
  burndown** — it measures the `bucket = 'shadow-only'` credit backlog by
  construction (not a mixed primary+shadow queue), and its growth (68 → 482)
  tracks the still-`In Progress` Final-Review Shadow Bake-Off's own arm
  expansion, not new unworked debt this plan owns (§4).
- **Date**: 2026-08-09 (re-measured 2026-08-28)
- **Origin**: `/ship` Steps 0.5b, 0.5e and 6.7 have surfaced the same three
  non-blocking queues on every push for weeks. They were reported as prose,
  acknowledged, and never worked. This document gives each queue a route and an
  exit criterion so "non-blocking" stops meaning "invisible".
- **Shape**: One document, three queues. It tracks **queues, not rows** — see
  the doctrine below before adding anything to it.

## 0. Doctrine — why the rows are not copied here

Each queue is a live view over the audit store, with its own closing command.
Copying its rows into `.audit/tech-debt.json` was considered and **rejected**:

- The debt ledger has no writer that observes `unlocked_fixes` or
  `unremediated_acceptances` shrinking, so every copied row would be stale the
  moment someone closed the real one — a second source of truth that only ever
  diverges.
- `debt-auto-capture.mjs` is not the tool: its input is an adjudication
  ledger's `ruling: 'defer'` entries. These queues have no ledger, and
  synthesizing one to feed it would be fabricating audit evidence.
- The ledger cannot express "declined on the merits", which is a legitimate
  outcome for several of these rows.

So this file carries **one entry per queue**: the measuring command, the
measured figure with its date, the closing command, an exit criterion, and the
traps that make the raw number misleading. Re-measure before acting; never cite
a figure here without re-running its command.

## 1. Reading these numbers safely

Three traps, all of which have already produced a wrong number in this repo:

- **Readers are capped.** `list-unlocked-fixes` caps `rows` at 20 while
  reporting a true total in `byMode`; `list-unremediated-acceptances` caps at
  20 with no total at all; `final-review-pending` caps `items` at 10 and
  reports `counts.totalActionable`. **Read the count field, never
  `rows.length`.** Counting rows once reported "20" against a real 232.
- **`measured: false` is not zero.** Both 0.5b and 0.5e return
  `measured:false` when repo identity is unresolvable or cloud is off. An empty
  `rows` then means *nothing was measured*, not *nothing is outstanding*.
- **Scope is repo-resolved, and there are two repo ids.** Confirm
  `scope.mode === 'repo'` in the output. Never hand-pass `--repo-id`:
  `audit_repos.id` (v4) and `repo_uuid` (v5) are different columns, and passing
  the latter used to return an authoritative empty result for a repo that was
  never queried.

## 2. Q1 — code fixes with no regression lock

**Measure** (`measured: true`, `scope.mode: repo` required):

```bash
node scripts/cross-skill.mjs list-unlocked-fixes
```

**Measured 2026-08-09**: `byMode.total` 98 — 38 code, 60 plan.
**Re-measured 2026-08-28**: `byMode.total` **227** — **97 code**, 130 plan.

**The plan rows are not work**, unchanged reasoning from 2026-08-09: their
`primary_file` is a plan section reference ("§9 testing strategy"), not a code
artifact, and no lock can exist for them.

**An aging dimension landed since 2026-08-09 and changes what "97" means.**
The reader now also returns `allAges`, `agedOut`, `agedOutByMode`,
`prePractice`, `practiceStart` (`scripts/lib/store/ship-nudges.mjs`,
`countAgedUnlockedFixes`). `practiceStart` is this repo's earliest
audit-sourced `regression_specs` row — the moment regression-locking was
first practised here; a finding older than that is `prePractice` and can
never be locked. **Re-measured 2026-08-28: `agedOutByMode.code` 70 of the 97**
— so the currently-actionable population is **~27**, lower than 2026-08-09's
raw 38, not higher. Citing the raw 97 without the aging split overstates the
live work by roughly 3.5x. Pass `--all-ages` only to audit historical debt,
never to size current work.

**`/ux-lock` is the wrong route for essentially all of them.** It drives a live
URL via Playwright, and this repo has no frontend — a 2026-07-23 census found
22/22 accumulated rows were backend/CLI findings with no URL to drive. The
route is a unit or integration test, recorded with:

```bash
node scripts/cross-skill.mjs lock-with-test --worksheet
```

Read the test before locking. A same-named file is not proof of coverage, and
the writer refuses a missing path or an empty rationale.

**Exit criterion**: `byMode.code` reaches 0, or each remaining row carries a
recorded lock or an explicit declined-on-the-merits note. Plan rows are
excluded from the criterion by construction.

## 3. Q2 — accepted findings that were never remediated

**Measure**:

```bash
node scripts/cross-skill.mjs list-unremediated-acceptances
```

**Measured 2026-08-09**: 20 rows returned (capped), all HIGH, no total field
— the reader could not say whether 20 was the whole queue.

**Resolved since 2026-08-09 — the reader now reports a true total.**
**Re-measured 2026-08-28**: `total` **162** open — `byMode` 94 code / 68 plan;
`byDisposition.acceptedPermanent` **42** (declined-on-the-merits, correctly
excluded from `open`); the same aging split as Q1 applies here too: `agedOut`
34 (all code), `notYetDue` 49. The 2026-08-09 note calling this "the first
work item" is stale — the gap it named is closed and the exit criterion below
is now directly evaluable.

**Close a row** — both keys are projected by the view (the fingerprint only
since migration `20260808200000`; if yours predates it, run
`node scripts/setup-postgres.mjs --migrate` rather than hand-deriving one):

```bash
node scripts/cross-skill.mjs final-review-record-fix --run-id RUN --fingerprint FP --commit SHA --state fixed
```

**Do not reach for `finalize-outcomes`** — it needs one round's `--ledger` and
`--result`, which a weeks-old acceptance in a since-deleted run does not have.

**Triage rule before acting**: `audit_mode: 'code'` means `primary_file` is a
real path and the defect is in the code now. `audit_mode: 'plan'` means it is a
plan *section* that was never amended — equally real, but do not print it as a
file path. A row at `remediation_state: 'planned'` with a live plan is
in-flight, not forgotten; drop it from the list.

**Exit criterion**: the reader reports a true total, and that total reaches 0
or every remaining row is `planned` against a live plan.

## 4. Q3 — final-review shadow-only credit backlog (rescoped 2026-08-28)

**Measure**:

```bash
node scripts/cross-skill.mjs final-review-pending --repo Lbstrydom/claude-engineering-skills
```

**Measured 2026-08-09**: `counts.totalActionable` **68** — 40 unadjudicated,
28 accepted-unfixed, 0 fixed-unlabelled, 0 regressed.
**Re-measured 2026-08-28**: `counts.totalActionable` **482** — 445
unadjudicated, 34 accepted-unfixed, 3 fixed-unlabelled, 0 regressed.

> Measured 2026-08-09 at 61 by reading the rendered card's "57 more not
> shown" line instead of `counts`. The card is bounded at 10 items and its
> overflow line is not the queue size. Read `counts.totalActionable`.

**Corrected 2026-08-28 — there is no "primary" variant of this queue to
switch to.** `counts.totalActionable` is computed from `actionablePairs`
(`scripts/lib/store/runs-findings.mjs`), whose SQL is hardcoded
`WHERE ... f.bucket = 'shadow-only'`. This was never a mixed
primary+shadow queue reading as shadow-heavy — it measures the shadow-only
credit backlog exclusively, by construction, and always has. The 68→482
growth is therefore not new *unworked debt this plan owns* — it tracks the
**Final-Review Shadow Bake-Off** plan's own arm expansion (still
`In Progress`; opus/deepseek/grok/gemini all now run as shadow arms against
gemini-primary, versus a smaller set on 2026-08-09). Bucket census
2026-08-28: shadow-only 532 rows vs. primary-only 246 vs. legacy
bucket-`NULL` 90, across all severities — confirming shadow-only is the
dominant, not incidental, population here.

**Rescoped out of this plan's active burndown.** Burning down a number that
tracks another still-active plan's own data-collection rate is bailing water
with the tap open — the count will keep climbing for as long as the Bake-Off
keeps collecting, regardless of adjudication effort spent here. This queue's
route and closing command (below) stay documented for whoever adjudicates it,
but **Q3 is no longer one of this plan's tracked burndown targets**; ownership
moves to `docs/plans/final-review-shadow-bakeoff.md`, whose own spot-check
worksheet (`final-review-stats --repo <name> --worksheet`, `--bucket
shadow-only` on the closing command) already exists for exactly this queue.
Revisit inclusion here only once that plan closes and this backlog stops
growing out from under any burndown effort.

**Why this queue exists at all**: the shadow A/B closed KEEP, but
`user_action` stayed null because the loop fixes the best catches *before*
adjudication — credit lands in a source comment and the tail reads as noise.
`/ship` Step 6.7 is the caller that was missing; this is its backlog.

**Close a row** (route retained for the Bake-Off plan, not this one's active
scope) — `accepted`/`dismissed` for an unadjudicated finding, `record-fix` for
an accepted-but-unfixed one. **You choose which commit fixed which finding**;
the card infers nothing from "a file changed".

## 5. Deliberately NOT tracked here

Measured 2026-08-09 and clean — recorded so a future reader does not re-open
them as if they were outstanding:

- **Upstream consumer queue** — `cross-skill.mjs upstream list` returned
  `rows: []`.
- **Friction notes** — `cross-skill.mjs quality session-review` returned
  `pending: []`.
- **Security memory** — `npm run security:refresh` parsed and upserted 2
  incidents, `refused: 0`, `redacted: 0`, `embedFailures: 0`.

A clean queue is a measurement, not an obligation. Do not create a burndown
entry for it.

## 6. Sequencing (revised 2026-08-28 — two active targets, not three)

**Q3 is out of active sequencing** (§4) — it tracks another plan's live
collection rate, not debt this plan can close. Between the two remaining:

Q1 first — its aging-adjusted population (~27) is now the smaller,
better-bounded one, with a known route (`lock-with-test`) that produces a
durable artifact (a regression test). Q2 second — 162 open rows, but its
former blocker (no total) is resolved, so it is a well-scoped, if larger,
population with a direct closing command.

Nothing here blocks a ship, by design. A gate that fires on state the current
commit cannot change is the cried-wolf shape that earns `--no-verify`.
