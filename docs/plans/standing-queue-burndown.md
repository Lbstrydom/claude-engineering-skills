# Plan: Standing Queue Burndown — the three gates that fire on every ship

- **Status**: In Progress — Q1 38 code rows, Q2 unknown (reader reports no total), Q3 68 actionable; measured 2026-08-09
- **Date**: 2026-08-09
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

**Measured 2026-08-09**: `byMode.total` 98 — **38 code**, 60 plan.

**The 60 plan rows are not work.** Their `primary_file` is a plan section
reference ("§9 testing strategy"); there is no code artifact and no lock of any
kind can exist for them. Reporting a single total of 98 makes two-thirds of the
queue read as work that cannot be done. The number to burn down is **38**.

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

**Measured 2026-08-09**: **20 rows returned, all HIGH** — 11 plan-mode, 9
code-mode, oldest 23 days. **This is a floor, not a total**: the reader caps at
20 and this queue reports no separate count, so the true figure is unknown and
"20" must never be quoted as complete.

> **A count this queue cannot give you is itself the first work item.** Q1 and
> Q3 both report a true total alongside capped rows; this one does not. Until
> that is fixed the exit criterion below cannot be evaluated.

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

## 4. Q3 — final-review findings awaiting a verdict

**Measure**:

```bash
node scripts/cross-skill.mjs final-review-pending --repo Lbstrydom/claude-engineering-skills
```

**Measured 2026-08-09**: `counts.totalActionable` **68** — 40 unadjudicated,
28 accepted-unfixed, 0 fixed-unlabelled, 0 regressed.

> Measured the same day at 61 by reading the rendered card's "57 more not
> shown" line instead of `counts`. The card is bounded at 10 items and its
> overflow line is not the queue size. Read `counts.totalActionable`.

**Why this queue exists at all**: the shadow A/B closed KEEP, but
`user_action` stayed null because the loop fixes the best catches *before*
adjudication — credit lands in a source comment and the tail reads as noise.
`/ship` Step 6.7 is the caller that was missing; this is its backlog.

**Close a row** — `accepted`/`dismissed` for an unadjudicated finding,
`record-fix` for an accepted-but-unfixed one. **You choose which commit fixed
which finding**; the card infers nothing from "a file changed".

**Exit criterion**: `counts.totalActionable` reaches 0, or the remainder is a
documented decision to stop labelling this population.

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

## 6. Sequencing

Q2 first, because it cannot currently be *evaluated* — a queue whose size is
unknowable is worse than a large one. Q1 second, since 38 is a bounded,
well-understood population with a known route. Q3 last: it is the largest but
the least urgent, being a labelling backlog rather than unfixed defects.

Nothing here blocks a ship, by design. A gate that fires on state the current
commit cannot change is the cried-wolf shape that earns `--no-verify`.
