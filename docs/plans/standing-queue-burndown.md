# Plan: Standing Queue Burndown — the three gates that fire on every ship

- **Status**: In Progress — two burndown passes landed 2026-08-28. Pass 1: Q1
  62 code findings locked, Q2 3 code findings closed (§2/§3). Pass 2 (same day,
  separate session): Q1 4 more code findings locked (33→28), Q2 1 more code
  finding closed (91→90) — both queues had already re-grown between passes
  from new audits landing. Both queues are large, actively-growing, shared
  state — these passes made a dent, not a close-out. Q3 stays rescoped out
  (§4).
- **Date**: 2026-08-09 (re-measured 2026-08-28, burndown passes 2026-08-28 x2)
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
**Re-measured 2026-08-28 (before burndown)**: `byMode.total` **225** —
**95 code**, 130 plan. **Re-measured 2026-08-28 (after burndown, same
session)**: `byMode.total` **163** — **33 code**, 130 plan — 62 code rows
locked in this pass (below).

**The plan rows are not work**, unchanged reasoning from 2026-08-09: their
`primary_file` is a plan section reference ("§9 testing strategy"), not a code
artifact, and no lock can exist for them.

**Correction to this doc's prior aging arithmetic — `byMode` and
`agedOutByMode` are DISJOINT populations, not "N of M".** The earlier version
of this section read `agedOutByMode.code` as a subset of `byMode.code` ("70
of the 97 ... ~27 currently actionable"). Reading the view definitions
(`supabase/migrations/20260811040000_unlocked_fixes_aged_visibility.sql`)
shows this is wrong: `byMode` (no `--all-ages`) queries `unlocked_fixes`,
which is `unlocked_fixes_all WHERE is_recent` (fixed within 14 days);
`agedOutByMode` (`countAgedUnlockedFixes`) always queries
`unlocked_fixes_all WHERE NOT is_recent` — the *complement*, split further
into `agedOut` (post-practice) and `prePractice`. The two counts can never
overlap; the correct current-actionable population is simply `byMode.code`
itself (everything the 14-day nudge window is currently showing), not
`byMode.code − agedOutByMode.code`. **Do not repeat the old subtraction** —
the two are read from the same JSON response but describe non-overlapping
finding sets.

**An aging dimension landed since 2026-08-09** (`allAges`, `agedOut`,
`agedOutByMode`, `prePractice`, `practiceStart` —
`scripts/lib/store/ship-nudges.mjs`, `countAgedUnlockedFixes`).
`practiceStart` is this repo's earliest audit-sourced `regression_specs` row;
a finding that aged out of the 14-day window *before* that date is
`prePractice` and was never a live obligation. Pass `--all-ages` only to
audit historical debt, never to size current work — `byMode.code` (default,
no flag) is already the correct current-actionable count.

**Burndown pass, 2026-08-28**: of the 95 code rows measured before this pass,
92 were investigated (parallel read-only agents per distinct `primary_file`,
grouped; 3 were not reached due to a bookkeeping slip in one batch — harmless,
they remain in the queue for the next pass). Of those 92: **62 had a genuine,
already-existing regression test** that specifically asserts the described
fixed behavior (not a same-named-file guess) and were locked via
`lock-with-test`; **~27 had no test found, or only partial/low-confidence
coverage for a `[SYSTEMIC]`/compound finding**, and were deliberately left
unlocked rather than writing a rushed test or stretching a loosely-related one
into "coverage" (see AGENTS.md verification discipline — a false-positive
lock is worse than an open finding); **3 `primary_file` values were bogus**
(plan-section citations like "§2 proposed architecture ...", not real paths)
and are unactionable via this route — likely mis-scoped at audit time, not a
lock gap. The 62 locks are individually resolvable in
`.audit`/the store by finding id if any needs re-review; no fabricated
evidence was recorded.

**Burndown pass 2, 2026-08-28 (same day, separate session)**: re-measured
`byMode.code` at **33** (queue had already re-grown from new audits landing
between the two passes, despite the first pass closing 62). Excluded 5 rows
citing `scripts/lib/audit/legacy-production-audit.mjs` — out of scope while
another session actively works its decomposition plan — and 6 more bogus
`primary_file` rows (section/function-name citations), leaving 22 investigated
via parallel read-only agents grouped by file. Of those: **4 had a genuine,
already-existing regression test** (independently re-verified by reading the
test bodies and, for the DB-gated one, the migration trigger SQL directly)
and were locked via `lock-with-test`; **18 had no real coverage**, including
three `openai-audit.mjs` rows that turned out to be re-raises of a plan claim
the codebase itself had already corrected (commit `82af2301`: the real
`detectEventWiringAsymmetry` call site is `legacy-production-audit.mjs`, not
`openai-audit.mjs`). Post-pass: `byMode.code` **28**.

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
excluded from the criterion by construction. **Not met** — 28 code rows
remain open after pass 2 (95→33→28 across the two 2026-08-28 passes); the
queue also grows between passes as new audits land, so 0 is a moving target,
not a one-time close-out.

## 3. Q2 — accepted findings that were never remediated

**Measure**:

```bash
node scripts/cross-skill.mjs list-unremediated-acceptances
```

**Measured 2026-08-09**: 20 rows returned (capped), all HIGH, no total field
— the reader could not say whether 20 was the whole queue.

**Resolved since 2026-08-09 — the reader now reports a true total.**
**Re-measured 2026-08-28 (before burndown)**: `total` **162** open — `byMode`
94 code / 68 plan; `byDisposition.acceptedPermanent` **42**
(declined-on-the-merits, correctly excluded from `open`); the same aging
split as Q1 applies here too — but see the Q1 correction above:
`agedOutByMode`/`notYetDue` are NOT a subset of `open` to subtract, they are
independently computed cross-cuts reported alongside it (`agedOut` 34, all
code; `notYetDue` 49). The 2026-08-09 note calling this "the first work item"
is stale — the gap it named is closed and the exit criterion below is now
directly evaluable.

**Burndown pass, 2026-08-28**: applied the triage rule below to the 94 open
code rows. 63 were `remediation_state: 'planned'` — skipped as in-flight per
the rule. Of the remaining 31 `pending` rows, 17 had a real `primary_file`
path (14 were bogus plan-section/function-name citations, unactionable via
this route); those 17 were read against current source with git-history
cross-checks. **3 were confirmed genuinely fixed** and closed with
`final-review-record-fix --state fixed`:
- `21dfdc50` (`scripts/lib/audit/findings-pipeline.mjs`) — fingerprint
  collision fix, commit `7ed02805`.
- `5b208484` (`scripts/lib/audit/event-wiring-corpus.mjs`) — ref-anchored
  `git ls-files`→`ls-tree` fix, commit `382790b0`.
- `83c1a5ec` (`scripts/cross-skill.mjs`, code since moved) — the
  `persona-consistency-locked` bypass was closed by *retiring the whole
  state* in migration `20260811150000_retire_consistency_candidate_promotion.sql`
  (commit `e833b2aa`), not by validating it in place as the finding assumed;
  flagged here since the fix lives outside the finding's `primary_file`.

**13 of the 17 real-path rows were confirmed still open** (not fixed) with
specific evidence per row (e.g. `scripts/lib/store/runs-findings.mjs` grew
from ~91K to 114K chars since acceptance — the opposite of the cited
decomposition). One (`6485990d`, citing `tests/audit-base-ancestry.test.mjs`)
looks like a **mis-accepted finding** — the cited test contains none of the
described logic; the actual behavior it names (`ADJACENCY_INCOMPLETE`) is
this repo's own documented control-marker convention
(`scripts/lib/audit/control-markers.mjs`), not a defect. Left open,
flagged here for human triage rather than closed either way.

**Burndown pass 2, 2026-08-28 (same day, separate session)**: re-measured —
91 open code rows (queue had re-grown from new audits between passes despite
pass 1 closing 3). 63 `planned` (skipped, in-flight), 28 `pending`; of those,
13 had bogus `primary_file` citations and 3 cited
`scripts/lib/audit/legacy-production-audit.mjs` (out of scope — another
session owns its decomposition plan), leaving 12 real-path rows investigated.
**1 confirmed genuinely fixed** and closed:
- `04582bd2` (`cmdLearningQuickfixStats` CLI-contract-drift) — the legacy
  dispatch map's flag rejection was closed by the Cluster D command-registry
  migration, commit `ef1220c1`.

**11 of the 12 confirmed still open**, mostly deliberate tradeoffs (e.g. the
same `AUDIT_LOOP_STATE_DIR` lock-scoping seam as Q1's maintenance-checks.mjs
cluster) or genuinely non-trivial (cross-store transaction spanning multiple
exported functions, a SYSTEMIC error-conflation issue only 1-of-3 read paths
fixed). The `6485990d` mis-accepted-finding flag from pass 1 was re-confirmed
and still needs human triage, not a code fix. Post-pass: 90 open code rows.

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
or every remaining row is `planned` against a live plan. **Not met** — 90
code rows remain open after pass 2 (94→91→90 across the two 2026-08-28
passes; 63 `planned`, 27 `pending` with no confirmed fix). Re-measured
post-pass total: 158 open overall.

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

Q1 first — smaller, with a known route (`lock-with-test`) that produces a
durable artifact (a regression test). Q2 second — larger, but its former
blocker (no total) is resolved, so it is a well-scoped population with a
direct closing command.

**Both queues grow between passes** (new audits land continuously in this
repo, run by concurrent sessions) — a burndown pass should re-measure first,
work the currently-actionable set, and stop; it is not a one-time close-out.
Two 2026-08-28 passes (same day, separate sessions) moved Q1 code
95→33→28 and Q2 code 94→91→90, each re-growing between passes despite the
prior pass's closes, using parallel read-only investigation (per distinct
`primary_file`) to find genuine existing test coverage (Q1) or a genuine
already-landed fix (Q2) before writing any lock or closing any row — no test
was written and no fix
was implemented as part of this pass; both are out of this plan's scope
(§0 doctrine: this file routes to real evidence, it doesn't fabricate any).

Nothing here blocks a ship, by design. A gate that fires on state the current
commit cannot change is the cried-wolf shape that earns `--no-verify`.
