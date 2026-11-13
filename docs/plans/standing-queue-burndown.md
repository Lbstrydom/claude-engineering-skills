# Plan: Standing Queue Burndown — the three gates that fire on every ship

- **Status**: In Progress — **Q3 RE-ADOPTED 2026-09-04**; its own stated revisit
  condition (§4) is now met on both halves, so this plan tracks **three** queues
  again. Two burndown passes landed 2026-08-28. Pass 1: Q1 62 code findings
  locked, Q2 3 code findings closed (§2/§3). Pass 2 (same day, separate
  session): Q1 4 more code findings locked (33→28), Q2 1 more code finding
  closed (91→90) — both queues had already re-grown between passes from new
  audits landing. Both queues are large, actively-growing, shared state — these
  passes made a dent, not a close-out.
- **Re-measured 2026-10-11** (`node scripts/backlog-snapshot.mjs`, measured,
  `scope.mode: repo`): Q1 **95 code** / 17 plan (+420 aged), Q2 **116 code** /
  76 plan (54 accepted-permanent), Q3 35. Both code queues are back above their
  pre-burndown 2026-08-28 levels (Q1 95, Q2 91). Q2's out-of-band reconciler
  (`node scripts/remediation-reconcile.mjs`, dry run) examined **2** of 640
  eligible rows: it fetches 200, and 192 of those cite no diffable file.
- **Re-measured 2026-11-13** (each queue's own command, measured, `scope.mode:
  repo`; Q3 reports `state: ready`): Q1 **82 code** / 26 plan (+1012 aged) before
  pass 3 and **65 code** / 26 plan after it; Q2 **47 code** / 36 plan
  (`total` 83, 54 accepted-permanent); Q3 **35** actionable (0 unadjudicated,
  35 accepted-unfixed). Q1 and Q2 code halves both read *below* the 2026-10-11
  figures (95, 116); this pass did not touch Q2/Q3.
- **Correction, same day (§7) — that "below" is NOT a burndown, and the
  attribution above was wrong.** Q1 and Q2 are windowed views over
  `audit_runs.created_at` (Q1 14 days, Q2 7–30 days), so two measurements five
  weeks apart describe **disjoint cohorts of runs** — measured overlap between
  the 10-11 and 11-13 Q2 windows: **0 rows**. Of the 116 Q2 code rows reported
  on 10-11, **110 are still open and unremediated today**; of the 95 Q1 code
  rows, **96 are still unlocked**. Essentially nothing closed; the rows aged
  out. Q3's 449→0 *is* real (435 single-row adjudications on 2026-09-14). §7
  carries each measurement.
- **A fourth queue is now measurable and is NOT tracked here** (see §5): the
  local-vs-store debt divergence, closed 2026-09-04 by
  `docs/plans/backlog-and-drift-reduction.md`. It had **37 debt entries existing
  on one machine and nowhere else**; all 37 were pushed into the private store
  and the route is now `npm run debt:reconcile`. A clean queue is a measurement,
  not an obligation — recorded so nobody re-opens it.
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

**Re-measured 2026-09-04**: `byMode.total` **51** — **26 code**, 25 plan;
`agedOut` 190. The code half fell 28→26 since the 2026-08-28 passes without a
burndown pass in between, so ordinary work is closing a few; the aged-out
population grew 185→190 over the same window.

**Burndown pass 3, 2026-11-13** (one session, bounded at 25 rows). Re-measured
first: `byMode.total` **108** — **82 code**, 26 plan (the CLI's `byMode.code` is
the count; the 20-row pages listed 83 code rows — one more than the count.
**Reconciled 2026-11-13 (§7.3): an instrument defect, now fixed.** The views
project the RECORDED `audit_mode`; the counts bucket by `EFFECTIVE_MODE_SQL`,
which demotes an `audit_mode='code'` row whose `primary_file` is prose to
`plan`. One such row was in the page, so folding the listing by `audit_mode`
gave count+1. `getUnlockedFixes`/`getUnremediatedAcceptances` now project
`effective_mode`, so the listing folds to the count. Read the count field;
where you must fold a listing, fold by `effective_mode`.)
The queue had re-grown 26→82 since 2026-09-04. All 83 listed code rows
are `HIGH` and were fixed between 2026-11-02 and 2026-11-13 (34 on 11-02, 29 on
11-08, 8 on 11-09, 11 on 11-11, 1 on 11-13) — i.e. the whole count sits inside
the 14-day nudge window, so it is a flow of recent fixes, not an old backlog; the
old backlog is the separate `agedOutByMode` population (code 610, plan 402).
Worked **25 rows** — all 13 on `scripts/lib/audit/canary.mjs` and all 12 on the
two run-heartbeat files (`scripts/run-heartbeat.mjs`, `scripts/lib/run-heartbeat.mjs`),
chosen because each pair has one colocated test file written with the fix. The
other 57 code rows were **not examined** (bound reached, not a verdict).

- **17 locked** via `lock-with-test` (12 canary → `tests/audit-canary.test.mjs`,
  5 heartbeat → `tests/run-heartbeat.test.mjs`). Before locking, each claim was
  checked three ways: the test body was read and the asserting line identified;
  the test file was run green (47 tests, 0 fail); and a **negative control** was
  run per behavior — the fix was reverted in the source (one mutation each, 10
  in all, restored with the tree clean) and the cited test had to fail, which it
  did every time. The mutation script is not committed; it is a one-shot
  instrument, not a promoted check.
- **8 left open**, each for a stated reason:
  - `0467782f` (`Math.max(...times)` over a long journal) — the code **is** fixed
    (a loop, with a comment), but no test pins it. The >1 MB journal test has
    ~18,000 entries, well under the argument limit, and reverting the loop to
    `Math.max(...times)` **leaves the suite green** (mutation H5). A same-named
    test that cannot fail is not a lock. Needs a >130k-entry journal, or a
    test of `assessJournal` on a synthetic array.
  - `555a5400`, `e35fb293`, `eb199896`, `d231020c`, `d276e881` — the
    `run` wrapper's failure paths (pid not recorded → child killed and exit
    forced non-zero; end record not durable → exit forced non-zero) are fixed in
    the code (`untracked`, `finish`) but **no test injects an append failure**.
    A small test is feasible (a child that removes its own journal) and is the
    natural next step; it was out of this pass's scope as written.
  - `0be0d59e` — backpressure is now handled by `pipe()`; nothing tests it.
  - `a64b461f` — **not a lock candidate, and arguably wrong as a finding**: it
    asks that a finding citing the canary path only in `detail`/`recommendation`
    be stripped, while the adopted design (and `c165e79e`, locked above) keeps
    real-file findings that merely mention the canary. The two findings
    contradict; the test asserts the latter. This is a declined-on-the-merits
    candidate, left as such because the queue still has no writer for it.
- **Not examined** (57 by the count; the 83-vs-82 discrepancy is reconciled in
  §7.3 — the 83rd row is `2e68fc2f`, recorded `code` with a prose
  `primary_file`, and is effectively a plan row): prepush
  snapshot/audit-gate/installer cluster 11, `campaign-contract` 7,
  `skills/audit-plan/SKILL.md` 7, `skill-frontmatter-layout` 5,
  `pinned-worktree` 4, `ci-verdict` 4, `check-setup` 4, `azure-doctor` 3, and
  singletons. Several are skill-prose rows (SKILL.md / reference docs), which
  `lock-with-test` fits poorly; that is a question for the next pass.
- **Post-pass**: `byMode.code` **65** (82→65, −17), `byMode.total` 91, re-read
  with the same command after the locks were recorded.

**Exit criterion**: `byMode.code` reaches 0, or each remaining row carries a
recorded lock or an explicit declined-on-the-merits note. Plan rows are
excluded from the criterion by construction. **Not met** — **65 code rows** at
the 2026-11-13 re-measure (95→33→28→26→82→65); the queue also grows between
passes as new audits land (26→82 in ten weeks), so 0 is a moving target, not a
one-time close-out.

> **The `declined-on-the-merits` outcome this criterion names has no writer.**
> `lock-with-test` records a lock; nothing records a reasoned decline, so the
> ~27 rows pass 1 deliberately left unlocked are indistinguishable from rows
> nobody looked at. Until that exists, a decline is recorded here in prose or
> not at all — which is why the criterion says "or ... an explicit
> declined-on-the-merits note" rather than pointing at a command.

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

**Re-measured 2026-09-04**: `total` **168** open — `byMode` **80 code** / 88
plan; `byDisposition.acceptedPermanent` **50**; `agedOut` 17 (HIGH 3, MEDIUM
14); `notYetDue` 75. The code half fell 90→80 since 2026-08-28.

**Re-measured 2026-11-13**: `total` **83** open — `byMode` **47 code** / 36
plan; `byDisposition.acceptedPermanent` **54**; `agedOut` 740; `notYetDue` 19.
Code half 80 (09-04) → 116 (10-11) → 47. Not worked in pass 3.

> **116 → 47 is window rotation, not closure (measured 2026-11-13, §7.1).**
> `unremediated_acceptances` is `…_all WHERE is_mature AND is_recent AND
> is_open_disposition` — a rolling **7–30 day** window on
> `audit_runs.created_at`. The 10-11 window (runs created 09-11…10-04) and the
> 11-13 window (10-14…11-06) share **0 rows**. Of the 116 code rows reported on
> 10-11, **110 are still open and unremediated now**; at most 6 closed in five
> weeks. The queue did not shrink — the view moved. `agedOut` 740 is where they
> went. **Never read a fall in this number as progress without naming the
> cohort.**

**Exit criterion**: the reader reports a true total, and that total reaches 0
or every remaining row is `planned` against a live plan. **Not met** — **80
code rows** at the 2026-09-04 re-measure (94→91→90→80).

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

**Rescoped out on 2026-08-28 — and RE-ADOPTED on 2026-09-04, because the
condition that sentence set has been met.** The original reasoning stands as
written: burning down a number that tracks another still-active plan's own
data-collection rate is bailing water with the tap open. The revisit condition
was *"once that plan closes and this backlog stops growing out from under any
burndown effort"*. Both halves now hold, measured 2026-09-04:

- **The owning plan closed.** `docs/plans/final-review-shadow-bakeoff.md` is
  `Status: Complete` — **VERDICT: KEEP opus**.
- **The tap is closed.** `FINAL_REVIEW_SHADOW` is **unset** in the resolved
  environment (commit `f79f6870`, "turn off the shadow").
- **Collection has actually stopped**, which is the observation that matters
  rather than the config: `audit_findings` rows with `bucket='shadow-only'`, by
  week — `2026-07-20` 15 · `07-27` 96 · `08-03` 48 · `08-10` 88 · `08-17` 285 ·
  `08-24` 39 · **nothing after 2026-08-24**, i.e. ~10 days with zero new rows.

  ```sql
  select date_trunc('week', created_at)::date wk, count(*)
  from audit_findings where bucket = 'shadow-only' group by 1 order by 1 desc;
  ```

So Q3 is now a **fixed, non-growing population of 486** and was ownerless: the
Bake-Off plan that inherited it is Complete. It returns here.

**Ownership**: this plan. The closing route is unchanged — `accepted`/`dismissed`
for an unadjudicated finding, `record-fix` for an accepted-but-unfixed one, and
the Bake-Off's `final-review-stats --repo <name> --worksheet --bucket
shadow-only` worksheet remains the ergonomic way to work a batch.

**Re-measured 2026-11-13**: `counts.totalActionable` **35** (`state: ready`) —
0 unadjudicated, 35 accepted-unfixed, 0 fixed-unlabelled, 0 regressed
(486 at re-adoption, 449 of them unadjudicated). Not worked in pass 3.

> **The 449 → 0 is REAL, and §7.2 names what closed it.** On **2026-09-14**,
> 435 shadow-only findings were adjudicated — 282 `dismissed`, 153
> `accepted-permanent` — with **435 distinct `decided_at` values** spread
> 07:17–20:15 UTC, i.e. 435 separate single-row writes through
> `adjudicateFinalReviewFinding`, not one bulk `UPDATE`. A further 4 landed on
> 09-15 and 23 on 09-16. The shadow-only population is **still 536 rows** —
> nothing was pruned or deleted — and **0** of them now lack a ruling on both
> axes. That route writes no `finding_adjudication_events` row, which is why
> the event table shows nothing that day and why the sweep left no trace
> anywhere but the findings themselves.

**Exit criterion**: `counts.totalActionable` reaches 0, or each remaining row
carries a recorded adjudication. **Not met** — 486 actionable at re-adoption
(449 unadjudicated, 34 accepted-unfixed, 3 fixed-unlabelled, 0 regressed).
Unlike Q1/Q2 this population does **not** re-grow while the shadow stays off, so
it is the one queue here that a sustained pass can actually finish.

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
  `rows: []`. Re-confirmed empty 2026-09-04.
- **Local-vs-store debt divergence** — measured and CLOSED 2026-09-04 by
  `docs/plans/backlog-and-drift-reduction.md`: 37 entries existed only in this
  machine's gitignored cache and were pushed into the private store (136→173
  rows), leaving 0 orphans. The standing route is `npm run debt:reconcile`
  (dry run) and it now reports on every ship via the backlog snapshot. Recorded
  here so the closed queue is not re-opened as if outstanding.
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

## 7. Reconciliation of the 2026-11-13 figures (investigation, 2026-11-13)

Pass 3 (§2) reported three numbers it could not account for and correctly left
them unreconciled. This section settles all three. Every figure below is
**measured**; each carries the command that produced it. Store
`d5a9d07b91225a93` (`audit_loop`), repo id
`6461a693-6690-4bf3-98ee-14c0385cc357`, slug
`Lbstrydom/claude-engineering-skills`. Source read at `d16039bf`.

> **Falsified first, before anything else.** `audit_repos` holds exactly ONE
> row named `Lbstrydom/claude-engineering-skills`
> (`select id, repo_uuid, name from audit_repos order by name`), so the
> two-repo-ids false-zero shape is not present in this store and explains none
> of the three. No reader returned `measured: false`; every one reported
> `scope.mode: repo` with the id above.

### 7.1 Q2 116 → 47 — the figure is real, the ATTRIBUTION was false

**Verdict: real reading, wrong story.** Nothing was burned down. The rows aged
out of a rolling window, and the obligations are still open.

`unremediated_acceptances` is `unremediated_acceptances_all WHERE is_mature AND
is_recent AND is_open_disposition`, where `is_mature` is
`created_at < now() - 7 days` and `is_recent` is `created_at > now() - 30 days`
— read from `pg_views` on the live store, not from a migration file. The view
is therefore a **7–30 day window on `audit_runs.created_at`**, and two reads
five weeks apart cannot describe the same rows.

| Question | Measured |
|---|---|
| Rows shared by the 2026-10-11 and 2026-11-13 Q2 windows | **0** |
| Code rows of the 10-11 cohort still open + unremediated today | **110** (116 reported then) |
| Code rows in the current window | **47** |
| `agedOut` reported by the same reader | **740** |

```sql
-- overlap between the two windows: 0
select count(*) from audit_findings f join audit_runs r on r.id = f.run_id
 where r.repo_id = :repo
   and r.created_at <  timestamptz '2026-10-11' - interval '7 days'
   and r.created_at >  timestamptz '2026-10-11' - interval '30 days'
   and r.created_at <  now() - interval '7 days'
   and r.created_at >  now() - interval '30 days';

-- the 10-11 cohort, still open today: 110
select count(*) from unremediated_acceptances_all a
 where a.repo_id = :repo and a.is_open_disposition
   and a.audit_mode = 'code'
   and a.primary_file ~ '^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$'
   and a.accepted_at < timestamptz '2026-10-11' - interval '7 days'
   and a.accepted_at > timestamptz '2026-10-11' - interval '30 days';
```

So at most **6** of the 116 were genuinely closed in five weeks; **110 (95%)
are still open** and merely left the view.

**Q1 behaves the same way** (its window is 14 days): of the 95 code rows
reported on 2026-10-11, **96 are still unlocked today** — one *more*, not
fewer. None were locked.

```sql
select count(*) from unlocked_fixes_all u
 where u.repo_id = :repo and u.audit_mode = 'code'
   and u.primary_file ~ '^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$'
   and u.fixed_at >  timestamptz '2026-10-11' - interval '14 days'
   and u.fixed_at <= timestamptz '2026-10-11';   -- 96
```

**Independent cross-check.** The pass-3 figures came from the CLI; these come
from SQL against the same store:
`select count(*) from unremediated_acceptances where repo_id = :repo and
audit_mode = 'code' and primary_file ~ '<code-path pattern>'` → **47**, equal to
`list-unremediated-acceptances`'s `byMode.code`. The same shape over
`unlocked_fixes` → **65**, equal to `list-unlocked-fixes`'s `byMode.code`.

**Positive control.** Both readers return non-zero on this scope, and the
110-row cohort query returns rows the window excludes — the instrument can still
see what the view hides, so the 47 is a measurement and not an empty read.

**Operational consequence.** A fall in Q1's or Q2's code half is **not** evidence
of work. Name the cohort, or compare `byMode.code + agedOutByMode.code`, which
aging cannot reduce.

### 7.2 Q3 449 unadjudicated → 0 — real, and here is what closed it

**Verdict: real.** A genuine adjudication sweep, done one row at a time.

| Question | Measured |
|---|---|
| Shadow-only rows in this repo today | **536** (532 censused 2026-08-28 — nothing pruned) |
| Of those, with no ruling on either axis | **0** |
| Rows adjudicated on 2026-09-14 | **435** — 282 `dismissed`, 153 `accepted-permanent` |
| Distinct `decided_at` values among those 435 | **435** |
| `decided_at` span that day | 07:17:03 → 20:15:15 UTC |
| Tail | 4 on 09-15, 23 on 09-16 |

435 rows carrying 435 distinct timestamps over thirteen hours is not a bulk
`UPDATE` — it is 435 separate single-row writes through
`adjudicateFinalReviewFinding` (`scripts/lib/store/runs-findings.mjs` at
`d16039bf`), the route §4 names. That writer touches
`audit_findings.user_action`, `.adjudication_outcome` and `.decided_at` and
records **no `finding_adjudication_events` row**, which is why the event table
shows nothing for shadow-only findings after 2026-08-24 and why the sweep left
no trace outside the findings themselves. No migration ran on 2026-09-14.

**Hypotheses tested and falsified**: *pruning* — the population is still 536
rows, so `UNRULED_WHERE`'s prune path did not delete them; *predicate change* —
the credit-population predicates widened on 2026-09-04 and 2026-09-14, but
widening cannot empty a class, and the shadow branch
(`CREDIT_BRANCH_SHADOW_WHERE` = `r.repo_id = $1 AND f.bucket = 'shadow-only'`)
carries **no disposition filter at all**, so no unadjudicated row can be
excluded before counting; *schema fault rendered as empty* —
`getFinalReviewStats` returns `{ok:false, error}` on a failed query and the
reader reported `state: ready`, `ok: true`.

**Independent cross-check.** Running `actionablePairs`'s own SQL directly and
folding it through `summariseCounts` reproduces the CLI exactly:

```
population size: 536
  accepted-permanent/accepted/fixed = 171 -> closed
  accepted-permanent/accepted/null  =  35 -> accepted-unfixed
  dismissed/dismissed/fixed         =   2 -> closed
  dismissed/dismissed/null          = 328 -> closed
counts: {unadjudicated: 0, fixedUnlabelled: 0, acceptedUnfixed: 35, totalActionable: 35}
```

**Positive control.** Injecting one synthetic `NULL/NULL/NULL` group with `n: 7`
into the same fold yields `{unadjudicated: 7, acceptedUnfixed: 35,
totalActionable: 42}`. The class is live; the 0 is a measurement, not a dead
branch. (`classifyFinalReviewOutcome({user_action: null,
adjudication_outcome: null, remediation_state: null})` → `'unadjudicated'`,
actionable.)

A store-level positive control by flipping one real row was **not** run: that is
a write to the shared production store, and the structural argument above is
stronger — a population with no disposition filter cannot hide a row.

### 7.3 Q1 "83 listed vs a count of 82" — an instrument defect, fixed here

**Verdict: instrument defect.** Reproduced the same day, fixed, and pinned with
a test proven red by reverting the fix.

Paging the whole listing today gives the same shape:

```bash
for o in 0 20 40 60 80; do node scripts/cross-skill.mjs list-unlocked-fixes --limit 20 --offset $o; done
# rows listed: 91   distinct ids: 91
# rows with audit_mode === 'code' : 66
# byMode reported                 : {"total":91,"code":65,"plan":26}
```

**Not a paging artifact**: 91 rows, 91 distinct `audit_finding_id`s, and 91 is
exactly `byMode.total`. Nothing was duplicated or skipped.

The cause is a mode disagreement the row could not express. `countUnlockedFixes`
buckets by `EFFECTIVE_MODE_SQL` (`scripts/lib/store/finding-mode.mjs` at
`d16039bf`) — a read-side correction that demotes an `audit_mode = 'code'` row
whose `primary_file` does not match `^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$` to
`plan`. The view projects only the **recorded** `audit_mode`, and the readers
passed it through, so a consumer folding the listing had the wrong column and no
way to know it.

```sql
select audit_mode,
       case when audit_mode = 'code'
             and primary_file ~ '^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$'
            then 'code' else 'plan' end as effective_mode,
       count(*) from unlocked_fixes where repo_id = :repo group by 1, 2;
-- code/code 65 | code/plan 1 | plan/plan 25
```

The one disagreeing row is `2e68fc2f-6a81-47cc-bb22-cb83935bdfdf`, HIGH, fixed
2026-11-02, `primary_file` = a comma-and-em-dash prose phrase naming six skills.
It was inside the 14-day window on 2026-11-13, which is exactly the 83rd row
pass 3 could not place.

`ship-nudges.mjs` already warned that the count and the `--mode` FILTER "must
move together or not at all". The row PROJECTION was the third place and was
left behind — and the CLI exposes no `--mode` flag, so the projection is the
*only* axis a CLI consumer has.

**Fix**: `getUnlockedFixes` and `getUnremediatedAcceptances` now project
`${EFFECTIVE_MODE_SQL} AS effective_mode` (six SQL literals, one oracle).
Verified against the live store: folding the listing by `effective_mode` gives
**65**, equal to `byMode.code`.

**Test**: `tests/nudge-row-effective-mode-db.test.mjs` (disposable Postgres,
enrolled in `db-test-container.mjs` AND `postgres-parity.yml`). It seeds a
prose-`primary_file` row beside a real-path one and asserts the listing folds to
the card's counts, for both readers and both age windows. Each case carries a
negative control — the seeded row must still read `audit_mode === 'code'`, and
folding by that column must NOT reconcile — so a fixture whose columns happened
to agree cannot pass vacuously. **Proven red**: reverting the six projections
fails all 5 cases (`every row projects an effective_mode`); restoring them
returns 5/5 green.

### 7.4 Follow-ups found but not taken here

- `upsertRepoByUuid` renders a connection fault (`The server does not support
  SSL connections`) as `null`, i.e. the same value as "no repo" — the
  `catch { return null }` shape AGENTS.md names. Out of this investigation's
  bound; not fixed.
- Nothing records *when* a Q1/Q2 row left its window, so the cohort arithmetic
  in §7.1 has to be reconstructed from `created_at` each time. A recorded
  `aged_out_at`, or a snapshot of each measurement, would make it a lookup.
