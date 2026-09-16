---
summary: Step 0.5's pre-ship nudges (0.5a/b/e/g/h/i) — the incident history behind each rule, kept out of the routine flow.
---

# Step 0.5's pre-ship gate queries — incident history and design rationale

The main `SKILL.md` document keeps the operative content for each of these
nudges (the command, the return shape, the one or two rules that change
printed output, the warning-card template). This file carries the "why" —
the specific measured defect each current rule closes, so a future change
does not re-introduce it. Read it when debugging a nudge's behavior, or
before changing one.

## 0.5a — Recent persona-test P0s

**Why `--repo "$PERSONA_TEST_REPO_NAME"` must never be passed as a shell
expansion.** A Claude Code session inherits neither this repo's `.env` nor
`~/.audit-loop.env` — so in every consumer that had not exported the variable
into the shell, the flag arrived empty and the gate refused. The command
resolves the repo itself: `--repo` -> `PERSONA_TEST_REPO_NAME` (read from
`.env` by the CLI, not by your shell) -> the ambient `git remote` identity.
Run it bare; pass `--repo <slug>` only to override.

**Why `pendingVerification*` is tracked separately from open/closed.** A
finding labeled `fixed` from the very session being read carries no newer
evidence either way — the fix is claimed and no persona run has tested it.
Counting it open made the gate unclearable by construction: label the fix,
the same session is still the latest, and the gate re-flags what it was just
told.

## 0.5b — Fixes that lack a /ux-lock regression spec

**`agedOut` is the number to watch, and it should be 0** (added 2026-08-11).
The view's 14-day window used to sit inside the predicate that *defines* the
obligation, so "not shown" and "not owed" were one state: an unlocked HIGH fix
left the backlog by the passage of time and the only trace was a smaller
number. Measured the day this shipped, **94 code findings had aged out against
1 still visible** — a gate whose cheapest clearing strategy was to wait two
weeks. Same defect `shown`/`total` already fixed on the row axis (`rows.length`
once reported 20 against a real 232), one axis over.

The window is KEPT and stays the default — an unbounded ship-time nudge becomes
noise and earns `--no-verify`. What changed is that it now *says* what it
dropped:
- **`agedOut`** — expired **while a locking practice was live**. This is a real
  leak. Non-zero means obligations are being discharged by delay; say so.
- **`prePractice`** — expired before this repo's first audit-sourced lock
  (`practiceStart`, derived from the store, never configured). You cannot lapse
  a practice you had not started, so these are **not** obligations. A repo that
  has never locked anything reports `agedOut: 0` rather than indicting itself.

*This repo's 190 `prePractice` rows (94 code / 96 plan, 2026-07-17..07-27, all
before `practiceStart` 2026-07-29) were written off deliberately on 2026-08-11
— see `status.md`. They are classified, not hidden.*

**Scoping — fixed 2026-07-30, and worth knowing why.** This command used to
read `--repo-id` only. `--repo` was accepted (it is globally valid, since
sibling subcommands read it) and **silently ignored**, and with neither flag
both store queries took their *unscoped* branch — returning **every
repository's** rows. A consumer measured a backlog of **207** that belonged
entirely to a different repo; its own true count was **0**. Scope is now
resolved as: `--all-repos` → `--repo-id` → `--repo <slug>` → ambient git
identity → `measured:false`. Global access must be asked for explicitly, and
`scope.mode` is echoed in the output so a global run is never mistakable for a
scoped one. The `byMode.code` guidance below shipped one day earlier and is
correct — but it was fixing the arithmetic on the wrong *population*, so read
both together.

**Never hand-derive a repo id to pass here.** There are two ids per repo and
they are different columns of the same `audit_repos` row: `id` (v4) is what
these views key on, and `repo_uuid` (v5, cached in `.audit-loop/repo-id`) is
the arch-memory identity. Passing the latter used to be trusted verbatim,
match nothing, and report `measured:true` with **0** — an authoritative empty
backlog for a repo that was never queried. That is how the incident above
reached its final answer, and a `warned` ship event got "corrected" to
`shipped` on the strength of it. `--repo-id` is now verified against
`audit_repos`: a `repo_uuid` is translated, anything unknown is
`reason: unknown-repo-id` + `measured:false`. Prefer no flag at all (ambient
identity) or `--repo <owner/repo>`.

**Why `byMode.code`, not `rows.length`.** `rows` is capped at 20 by the query,
so counting it reported "20" when the real total was **232** (measured
2026-07-29). And `byMode.plan` findings come from `/audit-plan` runs: their
`primary_file` is a section reference ("§9 testing strategy"), there is no
code artifact, and **no lock of any kind can ever exist for them** — 113 of
those 232 were plan rows, so a single mixed total makes half the backlog read
as work that cannot be done.

**`byMode` counts by what a row IS, not by which run recorded it** (upstream
report `fe1ff38a`, fixed 2026-09-06). A plan-mode run is not the only source of
a section reference: the write side records `primary_file` as
`_primaryFile || section`, so a **code**-mode finding lacking a file path of its
own falls back to prose while `audit_mode` stays `'code'`. Counting on
`audit_mode` alone therefore reported unlockable rows as actionable work — 2.5x
overstated in the reporting consumer, and measured at fix time against the
upstream store: **33 of 233** `unlocked_fixes` code rows and **56 of 227**
`unremediated_acceptances` code rows were section references. The readers now
classify on `primary_file`'s shape as well, so `byMode.code` is the count you
can act on. Rows are unchanged — only the aggregate moved.

**`danglingLocks` — a recorded lock whose test file is no longer there**
(upstream `b2c9a63f`, 2026-09-06). Recording a spec removes its finding from
`unlocked_fixes` permanently: that view's only lock predicate is
`EXISTS (SELECT 1 FROM regression_specs …)`. So a citation naming a file nobody
can open reads as coverage, and nothing surfaces it again — an obligation
discharged by silence, one axis over from `agedOut`. Measured upstream the day
this shipped: **3 of 235** rows, all three tests deleted by a later refactor,
i.e. TRUE when recorded. That is why this is checked on the READ side: a
citation's truth is not a property of the moment it was written.

`count: null` means the question went unasked (cloud off, unresolved repo, a
read that threw) — distinct from `0`, and not a clean result.

`unlocked_fixes` is a generic "HIGH fix, zero `regression_specs` rows in 14
days" check — it has no UI-relevance filter, so it fires identically for a
DOM-facing fix and a pure backend/CLI one. `/ux-lock` can only ever cover
the former (it drives a live URL via Playwright); recommending it
unconditionally is wrong advice for a backend-only `primary_file` — verified
2026-07-23: 22/22 accumulated rows in this repo were backend/CLI findings
with no live URL for `/ux-lock` to drive, since this repo has no frontend.

**Lead with `agedOutByMode.code`, not `agedOut` — the same split the visible
backlog already applies** (fixed 2026-09-06). This banner used to trigger on
`agedOut` and lead with the mixed total, while the paragraph one screen up had
already established that a plan-mode row has a section reference for a
`primary_file` and **no lock of any kind can ever exist for it**. So the
loudest line in the step — the one that says obligations are being discharged
by delay — was the one still counting unlockable rows as lost obligations.
Measured here the day it was fixed: `agedOut` **218**, of which
`agedOutByMode.code` **24** and `agedOutByMode.plan` **194**. The headline
overstated the leak by **9x**, and a nudge that inflates its own number by an
order of magnitude is the one that earns `--no-verify`. Third instance of one
defect: `shown`/`total` fixed it on the page axis, `rows.length`/`byMode` on
the row axis, this one on the window axis — the data (`agedOutByMode`) was
already in the payload each time, and only the prose had to change.

A plan-only `agedOut` prints nothing — with `agedOutByMode.code == 0` there is
no obligation to report, and a banner reading `0 code fix(es)` would be a
false alarm.

Do **not** print the `prePractice` figure as a backlog — bookkeeping for
findings that predate the practice, not work anybody owes.

## 0.5e — Accepted findings that were never remediated

**Two bounds, and only one of them forgets** (added 2026-08-11, the sibling of
0.5b's `agedOut`):
- **`notYetDue`** — under the 7-day **maturity floor**. A finding accepted
  three days ago is in flight, not forgotten, and it appears on its own once it
  matures. **Never add this to `agedOut`, and never report it as a backlog.**
- **`agedOut`** — over the 30-day **ceiling**, accepted after this repo started
  recording remediations (`practiceStart`). A real leak: never shown again.
- **`prePractice`** — over the ceiling but older than `practiceStart`. Not an
  obligation this repo ever had.

Measured the day this shipped: `agedOut` **0**, but **201 live obligations**
(50 HIGH / 151 MEDIUM) with the first **31 due to expire five days later**, and
146 gone inside a fortnight. Unlike 0.5b — where 94 rows had already been lost
before anyone looked — this one was instrumented *before* the first row went.
There is no pre-practice escape here either: remediations have been recorded
since 2026-07-17, which predates every live row.

**Why `byMode.total`, not `rows.length`.** `rows` is capped at 20 by the
query. This step told you to count the rows until 2026-08-09, three days after
the CLI started reporting the real total: measured live, the instruction
produced **20** against an actual **201** for this repo. Identical defect to
0.5b's `rows.length` undercount — fixed in the tool for both views, fixed in
the prose for only one.

**Plan-mode rows depend on the plan's status.** A plan-mode row is a plan
section that was accepted and then not amended:
- **Plan still in flight** → real work. Treat it as an obligation.
- **Plan marked Complete** → the obligation is to edit a shipped design
  document, close to worthless. Write the class off with the reasoning on the
  record.

Measured 2026-08-11: all 39 plan-mode rows in this repo belonged to seven
plans, **every one Complete**. Sampling three of them, the under-specification
each row named had been settled by the implementation — most explicitly by
[tests/suppression-call-site.test.mjs](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/tests/suppression-call-site.test.mjs),
whose header cites that plan and those finding IDs. The row that looked most
dangerous (a data-destroying `alpha = sum(alpha) − (n−1)` recovery procedure) is
annotated as verified-false *inside the plan document itself*. All 39 were
written off; the backlog went 199 → 160, and every survivor is code-mode.

**What a write-off here does not cover**: the code-level defect an ambiguity
may have produced. That is a code finding, it lives in the code-mode rows, and
code audits raise it. Writing off the document obligation does not write off
the risk.

**Representation gap, worth knowing before you write one off.** The store has
no "written off / declined on the merits" state — `remediation_state` runs
pending/planned/fixed/verified/regressed, and adjudication offers only
accepted/dismissed. So a class write-off has to be recorded as `dismissed`,
which reads as "this was not a real finding" when the truth is "this was real
and is no longer worth acting on". Put the reasoning in `status.md`; the store
alone cannot carry it.

**Scoping — fixed 2026-07-30, same defect as 0.5b, three days later.** This
command read `--repo-id` only, and this step invokes it with **no flags**, so
both the CLI and the store took their *unscoped* branch: a live run returned
rows spanning two repositories, which this step then told you to record as
*this* repo's `unremediated_count`. The 0.5b fix had introduced a data-access
fence for exactly this, but only the two `unlocked_fixes` readers were routed
through it — `getUnremediatedAcceptances` queried a sibling view and kept the
old shape. Scope now resolves identically for both steps (`--all-repos` →
`--repo-id` → `--repo <slug>` → ambient git identity → `measured:false`), and
`tests/cross-skill-unlocked-scope.test.mjs` enumerates the view family
mechanically so a *third* reader cannot repeat it.

One step EARLIER in the lifecycle than 0.5b: `unlocked_fixes` asks *"this was
fixed — is the fix locked?"*; this asks *"this was accepted — was it ever
fixed at all?"*. The `unremediated_acceptances` view lists HIGH/MEDIUM findings
whose `adjudication_outcome` is `accepted`/`severity_adjusted` but whose
`remediation_state` is still NULL/`pending`/`planned` after 7+ days.

**Why this exists**: measured 2026-07-27 on the 10 accepted final-review-shadow
findings in this repo, only 3 had a confirmed targeted code fix. One — the bare
`catch { result = null; }` in `stage0-relevance-context.mjs` — was accepted,
shipped, and is still in the code today. **`accepted` is not evidence of a
fix.**

**And nothing is chasing them — this step is the only thing that will.** The
line here used to read *"the audit loop is already designed to re-raise these
(`suppressReRaises` suppresses only `dismissed` or `fixed`/`verified`)"*, which
is true of the suppressor and false of the outcome. Measured 2026-08-11 over
this repo's 201 windowed rows: **200 appear exactly once in the entire store,
and zero were ever fixed or dismissed on a sibling row** — against a positive
control of 707 findings marked fixed/verified and 462 dismissed, so the query
could see a re-raise if one existed. Audits default to `--scope diff`, so a
finding is re-raised only if a later audit happens to cover the same file, and
mostly none does. An unremediated acceptance is an open obligation that no
other mechanism will surface again.

That also means the backlog decays the *other* way: a finding gets genuinely
fixed and nobody writes that down, because the loop does not re-raise it to
notice. Sampling four HIGH code rows the same day found three still-live
defects and one already fixed — `duplicate-justification-pragma.mjs`, whose
own source comment documents the `git grep -z` fix while the store still said
`pending`. So treat a row as a *hypothesis about current code*, verify it, and
then close it in the right direction rather than assuming either.

**"HIGH first" was unsatisfiable until 2026-08-10** (upstream report 96a829f8,
filed HIGH from a consumer). The reader capped its page with **no ORDER BY of
its own**, so this step was asking you to show the highest-severity rows out
of a page that carried no guarantee of containing any. It *looked* right —
measured on the live store, `unremediated_acceptances` happens to define an
inner `ORDER BY CASE severity …`, the planner keeps that sort under the outer
cap, and all 15 HIGH rows of 44 landed on page 1. That was a property of the
view's text, not of the read: Postgres does not guarantee a subquery's ORDER BY
survives into an outer query, and the sibling `unlocked_fixes` view carries no
inner sort at all. A `CREATE OR REPLACE VIEW` dropping the inner clause — a
pure formatting change — would have silently started hiding HIGH rows with no
signal. The order is now asserted where the cap is applied, so today's output
is unchanged and the instruction is deliverable rather than lucky.

**`byDisposition.acceptedPermanent` is a decision, not a backlog.** Those rows
carry `user_action = 'accepted-permanent'`: weighed and declined on the
merits, stamped with `decided_at`, and excluded from `open`/`total` by the nag
view since migration `20260811160000_unremediated_acceptances_disposition`.
Measured at that migration: 36 of 231 rows in this repo were already decided
and still being reported as open work. It is reported for one reason — a
disposition you cannot see is indistinguishable from a leak. If that number
climbs while `open` does not, `accepted-permanent` is being used as a silence
button, and THAT is the thing to investigate. `open === total` always; they
are one number under two names.

**Why the mode split here is NOT 0.5b's** (both fixed 2026-09-06, from the
same census). This reader returns the same `agedOutByMode:{code,plan}` and had
the same defect — one mixed total under a leak headline — but the correct
wording is different, and copying 0.5b's would be wrong. A plan row is
unlockable *by construction* in 0.5b, so it is never an obligation. Here it is
an **unamended plan section**, which is real work while the plan is in flight
and near-worthless once the plan is Complete: the disposition is the plan's
status, not the row's mode, so this step names the test instead of the
verdict. `agedOutBySeverity.HIGH` spans both modes and is reported as such —
it is not a code-only figure, and reading it as one over-counts the same way
the mixed total did. Measured here at fix time: `agedOut` **18** = **5** code
/ **13** plan, of which **9** HIGH.

**Why not `finalize-outcomes` (it used to say that, and it was unactionable).**
`finalize-outcomes` needs one round's `--ledger` + `--result`; a finding
accepted weeks ago in a since-deleted run has neither, so the advice could not
be followed for exactly the rows this step lists. Worse, a finding fixed in a
LATER session is unreachable by a fresh `/audit-code` too — the remediation
transition is driven by the finding appearing in the ledger, and the defect no
longer reproduces, so "fixed" was unreachable *because the fix worked*.
Reported from a consumer as `da67a8c1` after two HIGH findings sat `pending`
for 10 days having been genuinely fixed and merged. `final-review-record-fix`
is generic despite its name — it takes `--run-id` + `--fingerprint` with an
OPTIONAL `--bucket`, so it is not shadow-only. Both keys come from the row:
`audit_run_id` and `finding_fingerprint` are projected by the
`unremediated_acceptances` view — the fingerprint only since migration
`20260808200000`, which exists because this step told you to close rows the
read gave you no key for (upstream `23544fca`). If your store predates that
migration the fingerprint is absent: run
`node scripts/setup-postgres.mjs --migrate` rather than hand-deriving it.

Judge the list before echoing it — two rows look identical but are not:
- `audit_mode = 'code'` → `primary_file` is a real path; the defect is in the
  code right now.
- `audit_mode = 'plan'` → `primary_file` is a plan SECTION reference (e.g.
  `§7 ws-a migration; close-out`), not a file. Equally a real obligation (the
  plan was never amended), but say so rather than printing it as a code path.
- `remediation_state = 'planned'` with a live plan is genuinely in-flight, not
  forgotten — drop it from the printed list.

## 0.5g — Migration realization gate

A commit that ships a migration is only half-shipped until the migration is
APPLIED. On 2026-07-31 exactly that happened here: migration + dependent code
committed, tests green, pushed — and the fix was byte-for-byte inert because
nobody ran `--migrate`. The drift checker existed and was wired to nothing.

**Run the read-only preflight before Steps 1–6.2's doc work, not just at Step
6.3** — the real enforcement stays at 6.3 (`ship-commit.mjs` exits 2 there
regardless of whether the preflight ran; this early run is advisory, not a
substitute gate). A consumer reported (2026-08-14) discovering this block only
at Step 6.3, after already running a full local + fresh-clone readiness pass —
finding out about it late meant redoing validation that unapplied migrations
had nothing to do with.

Unconditional when the cloud store is on — deliberately NOT gated on "the push
range touches `supabase/migrations/`": a code-only commit can depend on a
migration left unapplied by an *earlier* push or a branch switch, which is the
more dangerous version of the same bug.

**This checks the AMBIENT store only — the consumers get their own read**
(added 2026-08-30, source-repo only). `--check-migrations` asks whether *this*
process's `AUDIT_DB_URL` is current. Consumers are not on one store, so a
consumer whose store falls behind is invisible from here until one of its own
writes hits the realization guard. Measured: a consumer's store sat **2
migrations behind for a day** — the `.sql` files had synced to disk and were
never applied, so its code and schema disagreed silently and the `annotation`
event shipped the day before could not have worked there. It surfaced only
when a routine upstream-report closure was refused.

**The runtime DSN usually cannot apply migrations.** A consumer's `.env`
carries its *runtime* role; on managed Postgres that role does not own the
tables (measured: `must be owner of table audit_findings`, 42501). That is the
least-privilege boundary working — do NOT resolve it by granting the runtime
role ownership, or by putting an admin DSN in `.env`. Which role to use, and
where its credential belongs: `references/migration-credentials.md`.

## 0.5h — Upstream issue queue

**Source-repo-gated.** Consumers FILE reports (`cross-skill.mjs upstream
report`); this repo is where they get triaged, and nothing prompted anyone to
read them. Measured 2026-08-01: two consumer reports sat unread, one of them
already fixed ~45 minutes earlier and still showing `open`. A queue nobody is
prompted to read is a queue that decays.

**Read EVERY consumer's store, not the ambient one** (fixed 2026-08-29). This
step used to run `cross-skill.mjs upstream list`, which queries whatever store
`AUDIT_DB_URL` names in THIS repo. Consumers are not on one store: `storyline`
files into a corporate Azure Postgres while this repo defaults to the NAS one,
so the step printed **`0 open`** in the very session that consumer had EIGHT
genuinely open reports — four of them HIGH, the oldest already a day old. A
triage nudge blind to an entire consumer was reporting its blindness as a
clean queue.

`upstream-queues.mjs` resolves each registered consumer's store the way that
consumer's own tooling does (its `.env`, then the shared `~/.audit-loop.env`),
dedupes by `storeFingerprint` so repos sharing a store are queried once, and
asks each one in a child process. It prints a fingerprint plus the consumer
names, never a DSN or hostname — this output gets pasted into a public repo's
status log and one store is a corporate internal host.

## 0.5i — Stalled comparison campaigns

**Source-repo-gated.** Campaigns are declared in `.campaigns/`, which exists
only here; a consumer has no campaign to be stalled on, and `campaign.mjs` is
deliberately not in the consumer bundle for that reason.

A campaign short of `targetN` is **not decision-eligible** — the spend is
banked but the evidence cannot answer anything yet. Nothing surfaced that:
`campaign.mjs status` answers when asked, and answering only when asked is how
a campaign goes quiet. Measured 2026-08-23 — `final-review-scoped-2026q3` sat
at 9/12 for three days while 17 unrelated audit runs went past it, noticed only
because someone thought to ask.

Do **not** treat a stalled campaign as a reason to collect right now:
collection is spend-bearing and revision-pinned (`npm run fixture:create`), so
it is a deliberate scheduled act, not a pre-push chore. The nudge exists so
the decision is *made*, including the decision to close it out with
`declare-inconclusive`.
