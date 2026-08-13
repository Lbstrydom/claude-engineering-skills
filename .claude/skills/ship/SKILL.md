---
name: ship
description: |
  Sync all project documentation, optionally update a plan, then commit and push to git.
  Updates status.md (session log), syncs CLAUDE.md to AGENTS.md, and handles git workflow.
  Use when the user is ready to commit and push their work.
  Usage: /ship — sync docs + commit + push
  Usage: /ship docs/plans/<name>.md — also update the plan before committing
  Usage: /ship --no-tests             — skip pre-push tests (override; logged in ship_event)
  Usage: /ship --ignore-p0            — push despite an unresolved persona-test P0 finding
  Usage: /ship --skip-ux-lock         — push despite an unlocked recent UI fix
  Triggers on: "ship it", "commit and push", "push my changes", "ready to ship".
  IMPORTANT: This command runs autonomously — no confirmation prompts. The user invoking
  /ship is their approval to update docs, commit, and push in one uninterrupted flow.
---

# Ship: Sync Docs → Commit → Push

A single command that ensures all project documentation is current, then
commits and pushes. Follow every step in order.

**Arguments**: `$ARGUMENTS` — optional path to a plan file to update
(e.g., `docs/plans/<name>.md`).

---

## Phase 0a — Linked-worktree preflight (run BEFORE anything else)

In a consumer repo the synced tooling tree `scripts/.claude-skills/` is
gitignored, so `git worktree add` never populates it — while `.claude/` (this
skill) *is* copied into the worktree. The instructions arrive, the tooling does
not, and every step below that names `scripts/.claude-skills/…` dies on a bare
`MODULE_NOT_FOUND`. **Phase 0's `detect-stack` is already one of them**, so
check first:

```bash
git rev-parse --path-format=absolute --absolute-git-dir   # differs from below ⇒ linked worktree
git rev-parse --path-format=absolute --git-common-dir     # <main>/.git
```

Equal ⇒ main checkout, proceed. Differ ⇒ linked worktree; if
`scripts/.claude-skills/` is missing, hydrate it before Phase 0:

```bash
npm run skills:hydrate
```

If the consumer has no such script, add it — recipe and rationale in
`docs/runbooks/consumer-adoption.md` §"Linked git worktrees" (in the
claude-engineering-skills source repo). Two moves that look like fixes and are
not:

- **Never `cd` to the main checkout to run these.** `ship-commit.mjs` and
  `cross-skill.mjs` would read the main checkout's HEAD, branch and
  `commit_sha` — committing and attributing the wrong tree. `context:check`
  (Step 4) takes its repo root from cwd, so a clean result from there says
  nothing about the branch you are shipping.
- **Never `npm run sync -- --target-path <worktree>`.** It aborts on unowned
  collisions (the ownership manifest is gitignored, so a worktree reads as a
  fresh repo), and `--adopt-orphans` clears the abort by overwriting tracked
  files.

Not applicable in the source repo (`claude-engineering-skills`), where
`scripts/` is tracked and worktrees hydrate normally.

---

## Phase 0 — Repo Stack Detection

```bash
node scripts/cross-skill.mjs detect-stack --include-env-manager
```

Returns `{ stack, pythonFramework, environmentManager, detectedFrom }`.

| `stack` | Behaviour |
|---|---|
| `js-ts` | Pre-push: `npm test`, linter + type-check + format if configured |
| `python` | Pre-push: see `references/python-environment-discovery.md` — env wrapper + tool probe |
| `mixed` | Run BOTH stacks' checks — required-tool absence in either blocks |
| `unknown` | Skip stack-specific checks; proceed with universal git workflow |

Python framework (if detected) shapes status.md section titles — see
`references/status-md-format.md`.

---

## Step 0.5 — Pre-Ship Gate Queries (non-blocking by default)

Collect signals before proceeding so the ship_event emitted at the end
is accurate. Best-effort — if a query fails, log and proceed.

### 0.5a — Recent persona-test P0s for this repo

If `PERSONA_TEST_REPO_NAME` is set, the PRIMARY source (WS4,
`docs/plans/persona-nav-feedback-recovery.md`) joins the latest
session's raw P0/P1 findings against the durable per-repo outcome ledger —
a finding labeled `dismissed`/`wont_fix` no longer counts as open, but one
labeled `fixed` that STILL appears in the latest session correctly
re-flags as an open regression:

```bash
node scripts/cross-skill.mjs persona-outcomes summary --repo "$PERSONA_TEST_REPO_NAME"
```

Returns `{ok, cloud, sessionId, sessionCreatedAt, persona, verdict, rawP0,
rawP1, labeled: {closed, open_relabeled_fixed, open_relabeled_stale,
unlabeled}, openP0, openP1}`. **Closed failure semantics — never a NEW
blocker**:
- `cloud: false` → proceed without the UX gate, exactly as today.
- `sessionId: null` (no recent session) → gate silent, exactly as today.
- `ok: false` (a real store/query failure) → log one warning line and fall
  back to the legacy raw read (below) — a summary-command regression can
  never make the gate stricter OR blind:
  ```bash
  node scripts/cross-skill.mjs get-persona-sessions-by-repo \
    --repo "$PERSONA_TEST_REPO_NAME" --limit 1 --p0-only \
    --select persona,focus,verdict,p0_count,p1_count,created_at,debrief_md
  ```
  (uses that session's raw `p0_count`/`p1_count` as `open_p0_count`/`open_p1_count`).

Capture `openP0` + `openP1` from the primary read (or the legacy
`p0_count`/`p1_count` from the fallback) as `open_p0_count`/`open_p1_count`.
These feed the ship_event record. If `openP0 > 0` (or the legacy fallback's
`p0_count > 0`):

```
⚠ UX GATE (non-blocking)
  Last persona test: "<persona>" — <N> days ago → <verdict> (P0: <n>, P1: <n>)
  Unresolved P0s detected. These are user-visible broken flows.
  Shipping anyway — consider fixing before next user-facing release.
  Label fixed/dismissed P0s: node scripts/cross-skill.mjs persona-outcomes --worksheet --repo "$PERSONA_TEST_REPO_NAME"
```

The worksheet line only appears when the PRIMARY read succeeded (labeling
requires the outcome ledger — the legacy fallback path has no equivalent).

### 0.5b — Fixes that lack a /ux-lock regression spec

```bash
node scripts/cross-skill.mjs list-unlocked-fixes
```

Returns `{ok, cloud, scope:{mode,repoId,slug}, measured, reason, rows, shown, total,
byMode:{total,code,plan}, allAges, agedOut, agedOutByMode:{code,plan}, prePractice,
practiceStart}`.

**Check `measured` BEFORE reading any count.** `measured:false` means *nothing
was measured* (`reason: repo-identity-unresolvable` / `cloud-off`) — the zeroes
are "not applicable", **not** "no obligations". Report it as unmeasured; never
render it as a clean backlog.

> **`agedOut` is the number to watch, and it should be 0** (added 2026-08-11).
> The view's 14-day window used to sit inside the predicate that *defines* the
> obligation, so "not shown" and "not owed" were one state: an unlocked HIGH fix
> left the backlog by the passage of time and the only trace was a smaller
> number. Measured the day this shipped, **94 code findings had aged out against
> 1 still visible** — a gate whose cheapest clearing strategy was to wait two
> weeks. Same defect `shown`/`total` already fixed on the row axis (`rows.length`
> once reported 20 against a real 232), one axis over.
>
> The window is KEPT and stays the default — an unbounded ship-time nudge becomes
> noise and earns `--no-verify`. What changed is that it now *says* what it
> dropped:
> - **`agedOut`** — expired **while a locking practice was live**. This is a real
>   leak. Non-zero means obligations are being discharged by delay; say so.
> - **`prePractice`** — expired before this repo's first audit-sourced lock
>   (`practiceStart`, derived from the store, never configured). You cannot lapse
>   a practice you had not started, so these are **not** obligations. A repo that
>   has never locked anything reports `agedOut: 0` rather than indicting itself.
>
> *This repo's 190 `prePractice` rows (94 code / 96 plan, 2026-07-17..07-27, all
> before `practiceStart` 2026-07-29) were written off deliberately on 2026-08-11
> — see `status.md`. They are classified, not hidden.*
>
> Read past the window with `--all-ages`; `total` and `byMode` then describe the
> unwindowed set, because a denominator from a different source than the rows is
> how `shown 5 / total 29` gets reported over a 219-row page.

```bash
node scripts/cross-skill.mjs list-unlocked-fixes --all-ages
```

> **Scoping — fixed 2026-07-30, and worth knowing why.** This command used to
> read `--repo-id` only. `--repo` was accepted (it is globally valid, since
> sibling subcommands read it) and **silently ignored**, and with neither flag
> both store queries took their *unscoped* branch — returning **every
> repository's** rows. A consumer measured a backlog of **207** that belonged
> entirely to a different repo; its own true count was **0**. Scope is now
> resolved as: `--all-repos` → `--repo-id` → `--repo <slug>` → ambient git
> identity → `measured:false`. Global access must be asked for explicitly, and
> `scope.mode` is echoed in the output so a global run is never mistakable for a
> scoped one. The `byMode.code` guidance below shipped one day earlier and is
> correct — but it was fixing the arithmetic on the wrong *population*, so read
> both together.
>
> **Never hand-derive a repo id to pass here.** There are two ids per repo and
> they are different columns of the same `audit_repos` row: `id` (v4) is what
> these views key on, and `repo_uuid` (v5, cached in `.audit-loop/repo-id`) is
> the arch-memory identity. Passing the latter used to be trusted verbatim,
> match nothing, and report `measured:true` with **0** — an authoritative empty
> backlog for a repo that was never queried. That is how the incident above
> reached its final answer, and a `warned` ship event got "corrected" to
> `shipped` on the strength of it. `--repo-id` is now verified against
> `audit_repos`: a `repo_uuid` is translated, anything unknown is
> `reason: unknown-repo-id` + `measured:false`. Prefer no flag at all (ambient
> identity) or `--repo <owner/repo>`.

**Use `byMode.code` as `missing_spec_count` — NOT `rows.length`.** `rows` is
capped at 20 by the query, so counting it reported "20" when the real total was
**232** (measured 2026-07-29). And `byMode.plan` findings come from `/audit-plan`
runs: their `primary_file` is a section reference ("§9 testing strategy"), there
is no code artifact, and **no lock of any kind can ever exist for them** — 113 of
those 232 were plan rows, so a single mixed total makes half the backlog read as
work that cannot be done.
`unlocked_fixes` is a generic "HIGH fix, zero `regression_specs` rows in 14
days" check — it has no UI-relevance filter, so it fires identically for a
DOM-facing fix and a pure backend/CLI one. `/ux-lock` can only ever cover
the former (it drives a live URL via Playwright); recommending it
unconditionally is wrong advice for a backend-only `primary_file` — verified
2026-07-23: 22/22 accumulated rows in this repo were backend/CLI findings
with no live URL for `/ux-lock` to drive, since this repo has no frontend.
If > 0, judge each row by `primary_file` before suggesting a fix:

```
⚠ REGRESSION LOCK GATE (non-blocking)
  <byMode.code> code fix(es) have no locked regression coverage
  (+ <byMode.plan> plan finding(s), which cannot be locked — not an obligation):
    • <primary_file>: <one-line detail>
  These will silently regress under future refactors.
  Backend/CLI/library fix → a unit or integration test IS the lock. Record it:
    node scripts/cross-skill.mjs lock-with-test --worksheet
  (reviewed queue; read the test before locking — a same-named file is not
  proof of coverage, and the writer refuses a missing path or empty rationale).
  UI/DOM-facing fix → /ux-lock. Note it has a documented bad record on React
  surfaces (wine-cellar-app 2026-07: generated specs proved brittle, several
  reverted, root cause undiagnosed) — prefer a unit test there too unless the
  contract genuinely needs a live DOM.
```

If `agedOut > 0`, print it too — it is a distinct and worse signal than the
backlog size, because those obligations are already past the point where the
nudge will ever mention them again:

```
⚠ OBLIGATIONS LOST TO THE WINDOW (non-blocking)
  <agedOut> fix(es) (<agedOutByMode.code> code / <agedOutByMode.plan> plan) aged out
  of the 14-day window UNLOCKED, after this repo started locking (<practiceStart>).
  Waiting is not a way to clear this gate. Read them:
    node scripts/cross-skill.mjs list-unlocked-fixes --all-ages
  Then either lock them, or write them off in status.md so the decision is on
  the record — an obligation discharged by silence is the thing this counts.
```

Do **not** print the `prePractice` figure as a backlog. It is bookkeeping for
findings that predate the practice, not work anybody owes.

**Re-running existing regression specs before a push** (optional gate): drive
them through the deterministic runner with the ship `run_context` so the
`regression_spec_runs` rows are tagged correctly and written without the model:

```bash
node scripts/ux-lock-run.mjs spec --specs 'tests/e2e/*.spec.js' \
  --commit <sha> --run-context ship-gate [--url <base-url>]
```

A non-zero exit means a locked contract broke — treat as a `test-failure`
block reason. Cloud off → it still runs + prints; Playwright missing → exit 5
(skip the gate, don't fail the ship on a missing optional dep).

### 0.5e — Accepted findings that were never remediated

```bash
node scripts/cross-skill.mjs list-unremediated-acceptances
```

Returns `{ok, cloud, scope:{mode,repoId,slug}, measured, reason, rows, shown,
total, byMode:{total,code,plan}, allAges, agedOut, agedOutByMode:{code,plan},
agedOutBySeverity:{HIGH,MEDIUM}, notYetDue, prePractice, practiceStart}`.

> **This view has TWO bounds, and only one of them forgets** (added 2026-08-11,
> the sibling of 0.5b's `agedOut`). Do not read them as one thing — both present
> as "not shown", and they are opposite states:
>
> - **`notYetDue`** — under the 7-day **maturity floor**. A finding accepted
>   three days ago is in flight, not forgotten, and it appears on its own once it
>   matures. **Never add this to `agedOut`, and never report it as a backlog.**
>   It is here so an empty page can be told from one whose rows have not ripened.
> - **`agedOut`** — over the 30-day **ceiling**, accepted after this repo started
>   recording remediations (`practiceStart`). A real leak: never shown again.
> - **`prePractice`** — over the ceiling but older than `practiceStart`. Not an
>   obligation this repo ever had.
>
> Measured the day this shipped: `agedOut` **0**, but **201 live obligations**
> (50 HIGH / 151 MEDIUM) with the first **31 due to expire five days later**, and
> 146 gone inside a fortnight. Unlike 0.5b — where 94 rows had already been lost
> before anyone looked — this one was instrumented *before* the first row went.
> There is no pre-practice escape here either: remediations have been recorded
> since 2026-07-17, which predates every live row.
>
> `--all-ages` drops both bounds, and `total`/`byMode` then describe the
> unwindowed set, because a denominator from a different source than the rows is
> how a short page reads as an exhausted one.

```bash
node scripts/cross-skill.mjs list-unremediated-acceptances --all-ages
```

**Use `byMode.total` as `unremediated_count` — NEVER `rows.length`.** `rows` is
capped at 20 by the query, and `shown` vs `total` exists to make that cap
visible. This step told you to count the rows until 2026-08-09, three days after
the CLI started reporting the real total: measured live, the instruction
produced **20** against an actual **201** for this repo. A nudge whose entire
job is to convey scale reported a tenth of it, and the figure was repeated back
to the operator as the size of the backlog they were deciding whether to work.
Identical defect to 0.5b's `rows.length` undercount — fixed in the tool for both
views, fixed in the prose for only one.

`byMode.plan` rows are counted separately, and **what they are worth depends on
the plan's status** — a distinction this text used to miss. A plan-mode row is a
plan section that was accepted and then not amended:

- **Plan still in flight** → real work. Amending the section changes what gets
  built. Treat it as an obligation.
- **Plan marked Complete** → the obligation is to edit a shipped design
  document, which is a historical record by then. That is close to worthless,
  and it is not what anyone does. Write the class off with the reasoning on the
  record; do not let it sit as a permanent count.

Measured 2026-08-11: all 39 plan-mode rows in this repo belonged to seven plans,
**every one Complete**. Sampling three of them, the under-specification each row
named had been settled by the implementation — most explicitly by
[tests/suppression-call-site.test.mjs](../../tests/suppression-call-site.test.mjs),
whose header cites that plan and those finding IDs. The row that looked most
dangerous (a data-destroying `alpha = sum(alpha) − (n−1)` recovery procedure) is
annotated as verified-false *inside the plan document itself*. All 39 were
written off; the backlog went 199 → 160, and every survivor is code-mode.

**What a write-off here does not cover**: the code-level defect an ambiguity may
have produced. That is a code finding, it lives in the code-mode rows, and code
audits raise it. Writing off the document obligation does not write off the risk.

> **Representation gap, worth knowing before you do this.** The store has no
> "written off / declined on the merits" state — `remediation_state` runs
> pending/planned/fixed/verified/regressed, and adjudication offers only
> accepted/dismissed. So a class write-off has to be recorded as `dismissed`,
> which reads as "this was not a real finding" when the truth is "this was real
> and is no longer worth acting on". Put the reasoning in `status.md`; the store
> alone cannot carry it.

**Check `measured` BEFORE reading the count** — identical contract to 0.5b.
`measured:false` (`reason: repo-identity-unresolvable` / `cloud-off`) means
*nothing was measured*; an empty `rows` then means "not applicable", **not**
"no unremediated acceptances". Report it as unmeasured.

> **Scoping — fixed 2026-07-30, same defect as 0.5b, three days later.** This
> command read `--repo-id` only, and this step invokes it with **no flags**, so
> both the CLI and the store took their *unscoped* branch: a live run returned
> rows spanning two repositories, which this step then told you to record as
> *this* repo's `unremediated_count`. The 0.5b fix had introduced a data-access
> fence for exactly this, but only the two `unlocked_fixes` readers were routed
> through it — `getUnremediatedAcceptances` queried a sibling view and kept the
> old shape. Scope now resolves identically for both steps (`--all-repos` →
> `--repo-id` → `--repo <slug>` → ambient git identity → `measured:false`), and
> `tests/cross-skill-unlocked-scope.test.mjs` enumerates the view family
> mechanically so a *third* reader cannot repeat it.

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
notice.
Sampling four HIGH code rows the same day found three still-live defects and one
already fixed — `duplicate-justification-pragma.mjs`, whose own source comment
documents the `git grep -z` fix while the store still says `pending`. So treat a
row as a *hypothesis about current code*, verify it, and then close it in the
right direction (`--state fixed` or a dismissal) rather than assuming either.

If > 0, print — **never blocks, and there is no override flag for it** (nudge,
not gate; the same philosophy as quick-fix detection). **Show the first 5 rows
as returned** — the reader now orders HIGH first, then oldest first, so the top
of the page *is* the top of the backlog. Take them in order; do not re-sort.

> **"HIGH first" was unsatisfiable until 2026-08-10** (upstream report 96a829f8,
> filed HIGH from a consumer). The reader capped its page with **no ORDER BY of
> its own**, so this step was asking you to show the highest-severity rows out
> of a page that carried no guarantee of containing any. It *looked* right —
> measured on the live store, `unremediated_acceptances` happens to define an
> inner `ORDER BY CASE severity …`, the planner keeps that sort under the outer
> cap, and all 15 HIGH rows of 44 landed on page 1. That was a property of the
> view's text, not of the read: Postgres does not guarantee a subquery's ORDER BY
> survives into an outer query, and the sibling `unlocked_fixes` view carries no
> inner sort at all. A `CREATE OR REPLACE VIEW` dropping the inner clause — a
> pure formatting change — would have silently started hiding HIGH rows with no
> signal. The order is now asserted where the cap is applied, so today's output
> is unchanged and the instruction is deliverable rather than lucky.

The page is capped (default 20) and the point is the signal, not the backlog. To
read past it — the consumer measured 44 obligations of which 24 were unreachable
by any invocation — page with `--limit` / `--offset`; the order is total, so
pages neither repeat nor skip a row:

```bash
node scripts/cross-skill.mjs list-unremediated-acceptances --limit 20 --offset 20
```

The payload echoes the **resolved** `limit`/`offset` (the store clamps to 200),
so a short page can be told from an exhausted one.

```
⚠ UNREMEDIATED ACCEPTANCES (non-blocking)
  <byDisposition.open> open · <byDisposition.acceptedPermanent> permanently accepted
  <n> finding(s) you accepted were never marked fixed (showing <=5):
    • [<severity>] <primary_file> — accepted <days_open>d ago
  Either remediate them, or close the loop honestly — per row:
    node scripts/cross-skill.mjs final-review-record-fix \
      --run-id <audit_run_id> --fingerprint <finding_fingerprint> \
      --commit <sha that fixed it> --state fixed
  Leaving them open is fine — leaving them open SILENTLY is what this catches.
```

**`byDisposition.acceptedPermanent` is a decision, not a backlog — print it, do
not chase it.** Those rows carry `user_action = 'accepted-permanent'`: weighed
and declined on the merits, stamped with `decided_at`, and excluded from
`open`/`total` by the nag view since migration
`20260811160000_unremediated_acceptances_disposition`. Measured at that
migration: 36 of 231 rows in this repo were already decided and still being
reported as open work.

It is reported for one reason — **a disposition you cannot see is
indistinguishable from a leak.** If that number climbs while `open` does not,
`accepted-permanent` is being used as a silence button, and THAT is the thing to
investigate. `open === total` always; they are one number under two names.

If `agedOut > 0`, print it separately. It is a worse signal than the backlog
size, because those rows are already past the point where this step will ever
mention them again:

```
⚠ ACCEPTANCES LOST TO THE CEILING (non-blocking)
  <agedOut> accepted finding(s) (<agedOutBySeverity.HIGH> HIGH) passed the 30-day
  ceiling still unremediated, after this repo started recording remediations
  (<practiceStart>). They will not appear above again. Read them:
    node scripts/cross-skill.mjs list-unremediated-acceptances --all-ages
  Then remediate, or close the loop with final-review-record-fix, or write them
  off in status.md — an obligation discharged by silence is what this counts.
```

**Do not print `notYetDue` as a backlog** — those rows are under the 7-day floor
and will surface here on their own. Mention it only if `total` is 0 and
`notYetDue` is not, where it is the difference between "nothing owed" and
"nothing owed *yet*".

> **Why not `finalize-outcomes` (it used to say that, and it was unactionable).**
> `finalize-outcomes` needs one round's `--ledger` + `--result`; a finding
> accepted weeks ago in a since-deleted run has neither, so the advice could
> could not be followed for exactly the rows this step lists. Worse, a finding fixed
> in a LATER session is unreachable by a fresh `/audit-code` too — the
> remediation transition is driven by the finding appearing in the ledger, and
> the defect no longer reproduces, so "fixed" was unreachable *because the fix
> worked*. Reported from a consumer as `da67a8c1` after two HIGH findings sat
> `pending` for 10 days having been genuinely fixed and merged.
>
> `final-review-record-fix` is generic despite its name — it takes `--run-id` +
> `--fingerprint` with an OPTIONAL `--bucket`, so it is not shadow-only. It was
> already the right command when `dd4cbae1` (2026-08-01) reworked this step; the
> substitution simply did not happen here, and the row above kept naming a
> command that cannot close these rows.
>
> **Both keys come from the row.** `audit_run_id` and `finding_fingerprint` are
> projected by the `unremediated_acceptances` view — the fingerprint only since
> migration `20260808200000`, which exists because this step told you to close
> rows the read gave you no key for (upstream `23544fca`). If your store
> predates that migration the fingerprint is absent: run
> `node scripts/setup-postgres.mjs --migrate` rather than hand-deriving it.

Judge the list before echoing it — two rows look identical but are not:

- `audit_mode = 'code'` → `primary_file` is a real path; the defect is in the
  code right now.
- `audit_mode = 'plan'` → `primary_file` is a plan SECTION reference (e.g.
  `§7 ws-a migration; close-out`), not a file. Equally a real obligation (the
  plan was never amended), but say so rather than printing it as a code path.
- `remediation_state = 'planned'` with a live plan is genuinely in-flight, not
  forgotten — drop it from the printed list.

### 0.5g — Migration realization gate (ENFORCED by the binary)

A commit that ships a migration is only half-shipped until the migration is APPLIED. On
2026-07-31 exactly that happened here: migration + dependent code committed, tests green,
pushed — and the fix was byte-for-byte inert because nobody ran `--migrate`. The drift
checker existed and was wired to nothing.

**You do not need to run anything for this step.** `ship-commit.mjs` performs the check
itself (Step 6.3) and exits 2 with an `AGENT FIX:` line naming the unapplied migrations and
the exact remedy. It is documented here so the block is not a surprise — the binary
enforces, this text explains.

- **Unconditional when the cloud store is on.** Deliberately NOT gated on "the push range
  touches `supabase/migrations/`": a code-only commit can depend on a migration left
  unapplied by an *earlier* push or a branch switch, which is the more dangerous version of
  the same bug.
- **Cloud off / unreachable / no ledger ⇒ silently skipped**, never a block. Blocking on an
  unmeasurable condition is the cried-wolf shape that earns `--no-verify`.
- **On a block**: run `node scripts/setup-postgres.mjs --migrate`, then re-invoke
  `ship-commit.mjs`. Do NOT work around it by dropping the migration from the commit.

### 0.5h — Upstream issue queue (advisory, source-repo only)

**Source-repo-gated** — run ONLY when `package.json.name === "claude-engineering-skills"`.
Consumers FILE reports (`cross-skill.mjs upstream report`); this repo is where they
get triaged, and nothing prompted anyone to read them. Measured 2026-08-01: two
consumer reports sat unread, one of them already fixed ~45 minutes earlier and
still showing `open`. A queue nobody is prompted to read is a queue that decays.

```bash
node scripts/cross-skill.mjs upstream list 2>/dev/null
```

**Never blocks, and there is no override flag** — the queue is CLOUD state, not
repo state, so it can only advise; a check firing on something the commit
cannot change is the cried-wolf shape that earns `--no-verify`. Cloud off or
unreachable ⇒ silently skipped. If `rows` is non-empty, print at most 3, HIGH first:

```
ⓘ UPSTREAM REPORTS OPEN (non-blocking)
  <n> consumer report(s) awaiting triage (showing <=3):
    • [<severity>] <title> — from <repo_name>
  node scripts/cross-skill.mjs upstream ack --id <the id>     # or fix --commit / wont-fix
  Full worksheet with freshness + prior-fix evidence: npm run upstream:issues
```

Before triaging, check `freshness` and `priorFixes` on the row: a report can
describe a defect that a LATER commit already fixed, so `fix --commit` may be the
correct verb on a report you have not touched. Do not close one on the strength of
the worksheet's evidence alone — confirm against current code.

### 0.5f — Override flags

If `$ARGUMENTS` contains `--no-tests`, `--ignore-p0`, or `--skip-ux-lock`,
record which override is active — it goes into the ship_event.

> **Numbering note**: this sub-step is `0.5f`, not `0.5d`, because two H2
> sections below already claim `Step 0.5c` and `Step 0.5d` (a pre-existing
> collision referenced from ~20 other files, so renumbering them is out of
> scope here). The H3 sub-step order is `0.5a → 0.5b → 0.5e → 0.5g → 0.5h → 0.5f`.

---

## Step 0.5c — Architectural Memory Refresh (advisory)

If the architectural memory is configured for this repo (per the
`docs/plans/architectural-memory.md` rollout), refresh the per-repo
symbol-index and regenerate `docs/architecture-map.md` so the LOCAL map matches
what's about to ship. The map itself is **never committed** — see below.

```bash
# Determine since-commit (last shipped). Use upstream/origin HEAD as a proxy
# when no /ship event has been recorded yet.
LAST=$(git rev-parse "@{upstream}" 2>/dev/null || git rev-parse "HEAD~1")
node scripts/symbol-index/refresh.mjs --since-commit "$LAST" || true
node scripts/symbol-index/render-mermaid.mjs || true
# NOTE: do NOT `git add docs/architecture-map.md` — it is gitignored (Category A).
```

> **`docs/architecture-map.md` is Category A and is NEVER staged.** This step
> used to end with `git add docs/architecture-map.md 2>/dev/null || true`, which
> outlived the file's B → A reclassification (2026-07-20) — the same stale-staging
> instruction that Step 0.5d below already documents for the dashboard, and it
> survived two steps away from that note. `git add` on a gitignored path *fails*,
> and the `2>/dev/null || true` swallowed the failure, so an agent following the
> instruction was told nothing while believing the map had shipped.
>
> It fails the byte-identical Category B test three independent ways: the header
> embeds a timestamp + commit sha + refresh_id; the body carries LLM-written
> per-domain summaries (two renders of one commit differ in wording); and it
> renders from the **cloud** `symbol_index`, i.e. external mutable state, not from
> committed source. Citations to it in AGENTS.md stay legal via
> `GENERATED_UNTRACKED_TARGETS` in `check-docs-refs.mjs`; a fresh clone
> regenerates it with `npm run dashboard:setup`. The reasoning lives beside the
> `.gitignore` entry.
>
> So this step's value is a current LOCAL map plus a fresh cloud symbol-index for
> future arch-memory consultations — not a commit artifact.

**This step is ALWAYS advisory — it never blocks a ship.** Per the
plan's failure matrix:

- Cloud off (no `SUPABASE_AUDIT_URL`) → skip silently, ship continues.
- `SERVICE_ROLE_REQUIRED` → print warning explaining how to enable
  refresh, ship continues.
- RPC error / embedding error → print warning, ship continues.
- Incremental refresh uses `git diff --name-status <since>`
  (NO `..HEAD`) UNION `git ls-files --others --exclude-standard` so
  the working-tree edits about to be committed are visible
  (per Gemini-G1 fix).

Nothing from this step is ever staged. The drift sticky-issue is only updated by
the weekly GH workflow, never by /ship directly.

---

## Step 0.5d — Regenerate the Local Dashboard (advisory, source-repo only)

**Source-repo-gated** — run this ONLY when
`package.json.name === "claude-engineering-skills"` (same gate as Step 6.0).
Skip silently in consumer repos: there the dashboard is opt-in via
`node scripts/build-dashboard.mjs all` (see `docs/plans/local-dashboard.md`
§7.3). Never blocks the ship.

```bash
node scripts/build-dashboard.mjs reference 2>&1
```

Run it WITHOUT `|| true` — the **exit code is the signal** and must be
read, not masked. A non-zero exit must not abort the ship (this step is
advisory): treat a failure as "skip staging, print a heads-up, continue".

`reference` mode regenerates `dashboard/index.html` + `dashboard/telemetry.html`.
The CLI exits non-zero on a **degraded** build (a source was invalid/errored).

**Nothing here is ever staged.** Both pages are **gitignored** — Category A per
the generated-artifact policy (they derive from mutable store state, so two
builds of one commit can differ). They were reclassified B → A in 2026-06
(`docs/plans/local-dashboard.md` §2.1); this step's staging instruction outlived
that change and told the agent to `git add` a gitignored path, which either
fails or force-adds a Category-A artifact into a commit.

So the exit code is a **reporting** signal, not a staging one:

- Exit 0 → the local page is current; say nothing.
- Exit non-zero → print a one-line heads-up that the dashboard build degraded;
  ship continues.

This keeps the LOCAL reference dashboard current with the skills/plans
being shipped.

> **This is the only dashboard build.** There was a second one at "Step 5.5b"
> that rebuilt AFTER plan archiving so the Plans tab reflected the final
> active/completed split. Plans no longer move (Step 5.5), so nothing can change
> between the two points and Step 5.5b was deleted along with the archiver — but
> this note outlived it and still said "if you only run one, run 5.5b", naming a
> step that does not exist.

---

## Step 1 — Assess What Changed

Before updating docs, understand the current state:

1. `git status` — modified, added, untracked files
2. `git diff --stat` — change summary
3. `git diff` on key changed files — what was actually done
4. `git log -5 --oneline` — recent commit style and context

Build a mental model of: what features/fixes were implemented, which
files were created vs modified, which area was affected, whether new
patterns were established.

---

## Step 2 — Update status.md

Append a new session log entry to `status.md`. If file doesn't exist,
create with the standard header. Always append at the TOP (below the
header) so the most recent session is first.

Full template + rules + optional sections (UX Status, Persona Test Status,
Regression Lock Status, Plan Verify Status): `references/status-md-format.md`.

---

## Step 3 — Update CLAUDE.md (if needed)

Review whether the current session introduced anything that should be
captured:

- [ ] New route files or API endpoints? → Backend Structure
- [ ] New frontend modules? → Frontend Structure
- [ ] New service patterns? → document the pattern
- [ ] New env vars? → Environment Variables table
- [ ] New conventions or rules? → Do / Do NOT sections
- [ ] New test files or patterns? → Testing section

Also check for outdated info — file structure descriptions, code
examples, config values.

**If changes needed**: edit CLAUDE.md, keeping existing style.
**If no changes needed**: skip — do not make cosmetic edits.

---

## Step 4 — Verify AGENTS.md ↔ CLAUDE.md alignment (do NOT mirror)

**`AGENTS.md` is the canonical shared context** (every agent — Claude Code,
Copilot, Cursor, Codex, Windsurf — reads it). **`CLAUDE.md` is a thin addendum**
that `@./AGENTS.md`-imports it and holds only Claude-Code-only notes. They are
**not** byte-mirrors.

- **NEVER copy `CLAUDE.md` over `AGENTS.md`** — a thin CLAUDE.md would overwrite
  and destroy the canonical file. (This step used to say "mirror exactly"; that
  was a landmine — removed.)
- Put **shared** content in `AGENTS.md`; **Claude-only** notes in `CLAUDE.md`.
- Then run **`npm run context:check`** — it enforces the topology (CLAUDE.md
  `@`-imports AGENTS.md, stays ≤ the line cap, only allowlisted Claude-only
  headings, no shared-section drift). Fix any findings by moving shared content
  to AGENTS.md — **never** by mirroring.
- If a repo is still in the legacy full-mirror state (CLAUDE.md == AGENTS.md),
  migrate it with **`/ai-context-management migrate`** (flips to AGENTS.md-canonical
  + thin CLAUDE.md); do not hand-resolve.

---

## Step 5 — Update Plan (if plan path in arguments)

Only when `$ARGUMENTS` contains a plan file path:

1. **Read the plan**
2. **Compare against git diff** — which planned items were implemented?
3. **Update plan metadata**: `Status: Draft` → `In Progress` → `Complete`
4. **Mark completed items** in the file-level table
5. **Add implementation log entry** at the bottom:

```markdown
## Implementation Log

### <Today's Date>
- Completed: <what was built>
- Remaining: <what is left>
- Deviations: <any changes from the original plan and why>
```

6. **Flag deviations** — if implementation diverged, note what changed and why.

---

## Step 5.5 — Plans no longer move on completion (removed)

**There is no archive step.** Plans live in `docs/plans/` for their whole
lifecycle; a completed plan simply carries `Status: Complete`. The
`docs/plans/` → `docs/completed/` archiver was deleted by
`docs/plans/reference-integrity-gate.md` Cluster C — moving a completed plan
silently broke every reference to it (the failure that plan exists to kill).
Status is metadata, never a path; the dashboard rebuild at Step 0.5d is
sufficient (no post-archive rebuild is needed because nothing moves).

*(The dashboard's Plans tab historically bucketed by directory; bucketing by
`Status:` instead is a small follow-up, tracked separately — out of this
plan's scope.)*

---

## Step 6 — Stage, Commit, Push

### 6.0 Sync manifest — no action (source repo)

The source repo's `scripts/.sync-manifest.json` is **gitignored** (it's
regenerated on every `npm run sync`, which the pre-push hook runs, and carries
volatile provenance — a timestamp + HEAD sha — so committing it is pure churn;
Category A per the generated-artifact policy). **Do not `git add` it.** The
pre-push sync regenerates it on disk for readers; it is never committed here.

Consumers are unaffected: they track their **own** manifest (synced + eol-pinned
via `.gitattributes`; the isolation verifier needs it). The source `.gitignore`
entry is source-only and does not propagate to the consumer managed block.

### 6.1 Stage

Stage relevant files by name (be specific):

```bash
git add <list of changed source files>
git add status.md
git add CLAUDE.md AGENTS.md    # only if modified
git add docs/plans/<plan>.md   # only if plan was updated
# NOTE: do NOT `git add scripts/.sync-manifest.json` in the source repo — it's
# gitignored here (Category A; regenerated every sync). Consumers track their own.
# NOTE: do NOT `git add dashboard/index.html` — it and dashboard/telemetry.html
# are gitignored (Category A; rebuilt by Step 0.5d, never committed).
```

**Do NOT stage**: `.env`, credentials, `node_modules/`, temp/generated files.

If untracked files look unintentional (temp, OS files), skip silently.
Include all source, docs, tests, and config.

### 6.2 Commit message + provenance values

Follow project convention:

```
<type>: <concise description>

<optional body with WHY if significant>
```

Types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`.
Keep first line under 72 chars. Body explains WHY, not WHAT.

**Pass the message as a file or on stdin** (not `-m`, no shell interpolation) —
two routes, both fine:

- **A file** — Write tool → `.claude/tmp/ship-commit-msg-<epoch>.txt`, then
  `--message-file <that path>`. Delete it once the commit lands.
- **Stdin** — `--message-file -` reads the message from stdin, so a heredoc
  works and leaves nothing behind. Use `-`, not `/dev/stdin`: Git-Bash resolves
  the latter to `/proc/self/fd/0`, which is not a regular file, so it looked to
  the helper like a path that simply was not there (upstream `575256de`).

Prefer stdin for a one-shot message. The file route is what filled
`.claude/tmp` with 658 files / 39MB by 2026-08-10, nearly all of them spent
commit messages nobody deleted — the directory is gitignored, so nothing ever
prompted anyone to notice.

Do NOT include any `AI-*` lines — the helper is their only writer and rejects
them (`reserved-trailer`).

Decide the provenance values (full convention: `docs/reference/commit-provenance.md`):
- `--models` — comma list of models that participated this session
  (e.g. `claude` alone; `claude,gemini,gpt` when the audit loop ran).
- `--gate` — `passed` (audit ran this cycle AND its convergence verdict
  is **verified against the cloud store** — the helper queries the run's
  `audit_runs` row; unverifiable → `passed` is refused) · `waived`
  (declared disposition without a verified verdict: shipped past a gate
  via `--ignore-p0`/`--no-tests`/etc., OR verification unavailable —
  cloud off / run not found) · `not-run` (no audit this cycle —
  docs-only ships). The helper also enforces `.audit/last-audit-run.json`
  freshness; an unevidenced or unverified `passed` is rejected.

> **To earn `passed`: converge the audit loop, then commit that tree
> UNCHANGED.** The helper compares the committed tree against the audited one
> (`committedTree === evidence.auditedTree`) *before* any store lookup, so
> hand-fixing findings after the last audit round makes `passed` unavailable —
> by design, because those fixes are themselves unaudited. That is the
> 2-stable-rounds convergence rule showing up at the commit boundary, not a
> tooling limitation. A partial commit of an audited worktree also differs, and
> is refused for the same reason.
>
> **`not-run` on a fix-heavy ship is the honest answer, not a failure.** The
> value worth investigating is a `passed` that should not be there. Do NOT
> hand-write `.audit/last-audit-run.json` or re-run a review purely to populate
> the column — that is forging the receipt rather than earning it.
>
> **Freshness is `evidenceMs > headCommitTs`, so someone ELSE's commit ages out
> your evidence.** In a repo with a concurrent session, a foreign commit landing
> between your audit and your ship makes the marker stale — which also removes
> `waived` (it requires `fresh`) and leaves `not-run` as the only legal value.
> If you need the trailer to reflect your audit, don't ship across another
> session's commits.

### 6.3 Commit and push

**The `/ship` command IS the user's approval.** Proceed directly — no
confirmation prompts.

**Both of these are now REQUIRED, and `ship-commit` refuses without them.**

```bash
# Capture the worktree identity ONCE, at the start of the ship (Step 0 if you
# ran one), and pass that exact pair to every ship-commit invocation in the run.
SHIP_HEAD=$(git rev-parse HEAD)
SHIP_BRANCH=$(git symbolic-ref --quiet --short HEAD)   # empty ⇒ detached

node scripts/ship-commit.mjs \
  --message-file .claude/tmp/ship-commit-msg-<epoch>.txt \
  --skill ship --models <csv> --gate <value> \
  --expect-head "$SHIP_HEAD" --expect-branch "$SHIP_BRANCH" \
  --path <file> --path <file>          # one per file you are shipping
git push origin <current-branch>
```

> **Why identity is a precondition and not a warning.** A concurrent session can
> amend, rebase or check out between your first command and your commit — this
> repo saw HEAD move six times in one session. An amend changes NO working-tree
> file, so a content-hash check sails past it; only a sha comparison catches it.
> And the pair is ATOMIC: a head-only check passes whenever two refs sit on the
> same commit — a feature branch freshly cut from `main` is exactly that — and
> the commit then lands on the wrong branch.
>
> **On a detached HEAD** pass `--expect-detached` instead of `--expect-branch`.
> A head with no ref disposition is `incomplete-expectation` → exit 2, never a
> silent degrade to a sha-only check.
>
> **You may omit the flags only when a FRESH audit ran in this session**: the
> evidence marker carries `auditedSha` + `auditedBranch` and supplies the bundle
> for you. A marker written before that field existed reports
> `pre-bundle-evidence` and you must pass the flags explicitly — it can never
> half-match.

**Shared working tree — `--path` is MANDATORY, not conditional.** `ship-commit`
refuses an unscoped commit outright: it cannot know whose staged entries the
index holds, so it requires you to declare what you are shipping. There is no
override flag, deliberately — an unscoped commit is a TOCTOU by construction
(the index is checked at one moment and consumed by `git commit` at another),
and HEAD verification cannot cover it because index mutations do not move HEAD.
Add one `--path <file>` per file you
are shipping:

```bash
node scripts/ship-commit.mjs \
  --message-file .claude/tmp/ship-commit-msg-<epoch>.txt \
  --skill ship --models <csv> --gate <value> \
  --expect-head "$SHIP_HEAD" --expect-branch "$SHIP_BRANCH" \
  --path scripts/foo.mjs --path tests/foo.test.mjs
```

This commits those paths' worktree contents and leaves every other index
entry staged and untouched. Untracked paths are handled (marked
intent-to-add, rolled back if the run is rejected). Do **not** fall back to a
bare `git commit -- <paths>` — it scopes correctly but drops the `AI-*`
provenance trailers, which is exactly what this helper exists to prevent.

**A directory is refused, not expanded.** `--path <dir>` would let git commit
everything beneath it — measured: naming `sub/` committed a file the caller
never named. Pass each file. A DELETED directory is refused for the same reason
(and needs `cat-file -t`, not `-e`, to detect: `-e` exits 0 for a tree).

**After a successful commit, `ship-commit` re-verifies that the new commit's
parent and branch are the ones it checked.** That DETECTS drift; it does not
prevent it — `git commit` has already moved the ref by then. On
`post-commit-drift` it exits 1 and prints a recovery command: **do not push.**
The commit exists but was not built on the base you verified, and an unpushed
wrong-parent commit is recoverable in seconds whereas a pushed one needed a
human to notice a 12-line change with a 2,324-line diff. The transactional
boundary that would prevent it is `docs/plans/ship-commit-transaction.md`.

(Consumer repos: the synced copy of this file already carries the
rewritten `scripts/.claude-skills/ship-commit.mjs` path.)

Exit contract: `0` = committed (trailers appended). `2` = input rejected —
fix exactly what the `AGENT FIX:` stderr lines say and re-invoke (max 2
retries, then report). `1` = operational failure — report it; do not
loop. **Fallback (stale consumer sync only)**: if the helper script does
not exist on disk, fall back to `git commit -F <message-file>` and print
one line: `provenance trailers skipped (helper unavailable — re-run npm
run sync)`.

If push fails (behind remote, etc.), inform the user and suggest the
fix. Do NOT force push.

---

## Step 6.5 — Security Memory Refresh + Capture Hint (after successful push)

If push succeeded AND `docs/security-strategy.md` exists in the repo,
run `npm run security:refresh` to keep the Supabase index in sync with
markdown (only ever publishes pushed state — R3-H3 design constraint).
Surface the result line briefly.

After refresh, regex-match the HEAD commit subject against
`/fix.*\bsecurity\b|\bcve\b|\bvuln\b|\bleak\b|\binjection\b|\bauth\b|\bxss\b|\bcsrf\b|\brce\b/i`
(word-boundary-anchored — the unanchored form matched "leak" inside
"leaking", "auth" inside "author/authoring", and "rce" inside
"source/force/interface", false-flagging ~6% of commits in a 200-commit
sample; confirmed 2026-07-22). If matched, emit a single passive log line
(NOT an interactive prompt — `/ship` is `disable-model-invocation: true`):

```
⚠ Security-relevant commit detected: "<subject>".
  Run `/security-strategy add-incident from-commit <sha>` to draft an
  incident memory entry from this fix.
```

The user reads this and decides whether to invoke `/security-strategy`
themselves. No blocking, no prompt, no input.

If `docs/security-strategy.md` doesn't exist → no-op (don't suggest
bootstrap on every push; that's noise).

---

## Step 6.6 — Friction closure (after successful push, advisory)

Completes the friction-feedback loop (plan: `docs/plans/friction-feedback-loop.md`
C10). The `UserPromptSubmit` hook injects `> Relevant prior friction` callouts and
records a breadcrumb; this step surfaces notes that the just-pushed commit may have
resolved, so a recurring papercut gets marked closed instead of recurring forever.

If push succeeded, list pending injected-but-unlinked friction:

```bash
node scripts/cross-skill.mjs quality session-review
```

For each pending note, emit a single passive line with the ready link command
(NOT an interactive prompt — `/ship` is `disable-model-invocation: true`, same as
the Step 6.5 security hint):

```
⚠ Prior friction you were warned about: "<title>" (<memory_name>).
  If this commit fixed it: node scripts/cross-skill.mjs quality link \
    --memory <memory_name> --kind commit --ref <HEAD sha>
```

Cloud-off, no breadcrumb, or no pending notes → **no-op (silent)** — never noise.
`quality link` is idempotent + local-first; the user decides whether to run it.
Advisory; never blocks the ship.

---

## Step 6.7 — Final-review credit (after successful push, advisory)

Closes the loop the shadow A/B could not measure. `final-review-adjudicate` and
`final-review-record-fix` have existed and been tested since that experiment
closed — and **nothing called them**, so `user_action` stayed null, credit landed
only in source comments, and the resulting tail read as noise until a manual
sweep recovered it (2026-07-28). This step is the missing caller.

**Run AFTER the commit lands**, so the sha handed to `--commit` is the real one.
`$REPO` is the `owner/repo` slug (same value `LEARNING_REPO_NAME` uses — the
bare repo name silently misses the lookup):

```bash
node scripts/cross-skill.mjs final-review-pending --repo "$REPO" --render --commit "$(git rev-parse --short HEAD)"
```

Print its stdout verbatim. That is the whole integration — the command renders
the finished card, so there is nothing to parse and no formatting decision here.
Omit `--render` to get the versioned JSON instead (`schemaVersion`, `state`,
`counts`, `items`) if you need it programmatically.

**Advisory only — the reader always exits 0** across its three result states
(`ready` / `disabled` / `unavailable`), emitting empty output when cloud is off
or nothing is pending, and a single line carrying just a diagnostic CODE when
the store is unreachable. A missing label is not a reason to stop a ship.

Treat a stale sha as a reason to skip the card, not to re-render it: the
`--commit` value should be the commit you just made.

The card offers `accepted`/`dismissed` for unadjudicated findings, `accepted`
only for a fixed-but-unlabelled one (a shipped fix implies the finding was
real), and a complete `record-fix` line for an accepted-but-unfixed one. **You
choose which finding a commit fixed** — the card lists candidates and their
commands, and infers no attribution from "a file changed". Output is bounded
(10 items) with a pointer to `final-review-stats --worksheet` for the full
queue.

---

## Step 6.8 — Consumer-side verification (after successful push, advisory)

`git push` exiting 0 proves the transfer completed. **It proves nothing about
the receiver's view** — and a generated artifact can pass every check against
its *source* while the built output carries real defects. So fetch the thing
back the way a consumer gets it, and check **that**.

Pick the row(s) this push actually produced:

| Artifact | Consumer-side retrieval | Subject check |
|---|---|---|
| the pushed commit | clone/fetch into a temp dir at the pushed sha | the repo's battery runs green **in the clone** — catches tracked-vs-ignored and case-only path faults invisible locally |
| the synced consumer bundle | **authoritative**: `node scripts/.claude-skills/lib/sync-isolation-verify.mjs`, run *in the consumer* — note the `lib/` segment, it is a module rather than a top-level script. `npm run sync:dry` from here is the pre-check, not the verdict | zero unexpected diffs; no orphans |
| the skill manifest | re-derive from the pushed sha, not the working tree | regenerated bytes identical |

**Record the outcome in the `status.md` session line** (Step 2) — it is prose,
no schema needed. Required in it: the immutable locator (full sha / digest /
bundle version), the retrieval command actually run, and the observed result.

**Three terminal states, and only three**: `verified`, `failed`, `unverified`.
**`unverified` must name a concrete blocked prerequisite** — "no network in this
environment", "no consumer checkout on this machine" — never a bare "not
applicable". A missing prerequisite is a fact; an undefined *impossible* is an
excuse. **Never inherit the producer-side green.**

Advisory by construction: the push already happened, so this cannot block it —
and per the gate-level rule, machine and remote state may advise where repo
state may block. → `references/verification-discipline.md` §6.

---

## Step 7 — Emit Ship Event (always)

After commit + push completes (or is blocked), record the outcome:

```bash
node scripts/cross-skill.mjs record-ship-event --json '{
  "outcome": "shipped" | "blocked" | "warned" | "overridden" | "aborted",
  "blockReasons": ["test-failure","lint-failure","type-check-failure","format-failure","open-p0","missing-regression-spec","secrets-detected"],
  "openP0Count": <from Step 0.5a>,
  "openP1Count": <from Step 0.5a>,
  "missingSpecCount": <from Step 0.5b>,
  "overriddenByUser": <true if any override flag was used>,
  "overrideFlag": "<e.g. --no-tests or null>",
  "stackDetected": "js-ts" | "python" | "mixed" | "unknown",
  "framework": "<fastapi|django|flask|null>",
  "durationMs": <wall-clock ms from step 0.5 to now>
}'
```

**Outcome semantics**:
- `shipped` — everything passed, commit pushed
- `warned` — shipped despite non-blocking warnings
- `overridden` — user passed `--no-tests` or similar
- `blocked` — blocking check failed, push did not occur
- `aborted` — Claude aborted (secrets detected, nothing to commit, etc.)

`blockReasons` is always an array — empty on `shipped`, populated otherwise.

Fire-and-forget — do not block on output. If cloud mode is off, CLI
prints `{"ok":true,"cloud":false}` and returns 0.

---

## Quick Reference

| Syntax | What happens |
|---|---|
| `/ship` | Update status.md → sync CLAUDE.md/AGENTS.md → commit → push |
| `/ship docs/plans/<name>.md` | All of the above + update the plan file |

## Reminders

- **Always check git diff first** — understand what changed before documenting
- **status.md is a log** — append, never rewrite history
- **CLAUDE.md only changes when needed** — no cosmetic edits
- **AGENTS.md is canonical; CLAUDE.md is a thin `@`-import addendum** — never
  mirror/overwrite AGENTS.md from CLAUDE.md; verify with `npm run context:check`
- **No confirmation needed** — `/ship` is the approval. Execute autonomously
- **Be specific in the log** — name files, functions, endpoints
- **The commit message matters** — it's the permanent record in git history

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/python-environment-discovery.md` | Python pre-push command discovery — env wrapper detection + per-tool probe order. | detect-stack returned `python` or `mixed` with Python files in the diff. |
| `references/status-md-format.md` | status.md session-log template + update rules + persona / UX status sections. | Step 2 — creating status.md for the first time, OR appending UX / Persona / Regression-Lock / Plan-Verify sections. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Step 6.8 — the push succeeded and the artifact must be verified from the consumer side. |
