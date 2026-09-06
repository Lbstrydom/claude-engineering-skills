---
name: ship
description: |
  Sync all project documentation, optionally update a plan, then commit and push to git.
  Updates status.md (session log), syncs CLAUDE.md to AGENTS.md, and handles git workflow.
  Use when the user is ready to commit and push their work.
  Recommend it on: "ship it", "commit and push", "push my changes", "ready to ship".
  DO NOT INVOKE THIS SKILL ON YOUR OWN INITIATIVE — it commits and pushes, which is not
  undoable once the push lands. Run it only when the user asked for it in their own words
  this turn. If they merely approved a design ("looks good, ship it" about a plan), say
  /ship is available and stop. Their invocation IS the approval that lets every step skip
  confirmation, which is exactly why it cannot be self-invoked.
  Full command syntax: see the Usage section in this skill.
disable-model-invocation: true
---

# Ship: Sync Docs → Commit → Push

> **Explicit invocation only — this is a host-neutral requirement, not just a
> frontmatter flag.** `disable-model-invocation: true` above enforces it in
> Claude Code, and **also in VS Code Copilot**, which reads `.claude/skills/`
> and honours that exact key (it is a documented Copilot frontmatter field, not
> a Claude-only one — verified against VS Code's Agent Skills docs 2026-09-02).
> Hosts outside those two are not guaranteed to, and a frontmatter key cannot
> explain *why* anyway, so the rule is stated here too, where every host reads
> it:
>
> **Do not start this skill because a message sounded like approval.** Start it
> only when the user asked, in their own words this turn, for their work to be
> committed and pushed. "Looks good, ship it" said about a plan, a diff or a
> design is assent to the *idea*, not an instruction to push — answer it by
> offering `/ship`, never by running it.
>
> Why the bar is here and not on the individual steps: every step below skips
> confirmation deliberately, and the thing that makes that safe is the user
> having chosen to run this. Self-invoke and the approval those steps rely on
> was never given — the skill would be citing its own execution as consent.
> A push to a shared branch is also the least reversible action in this
> bundle, and in this repo the working tree is shared with concurrent
> sessions.

A single command that ensures all project documentation is current, then
commits and pushes. Follow every step in order.

## Usage

| Invocation | Effect |
|---|---|
| `/ship` | sync docs + commit + push |
| `/ship docs/plans/<name>.md` | also update that plan before committing |
| `/ship --no-tests` | skip pre-push tests (override; logged in `ship_event`) |
| `/ship --ignore-p0` | push despite an unresolved persona-test P0 finding |
| `/ship --skip-ux-lock` | push despite an unlocked recent UI fix |

The three override flags are honoured only when the **user** passes them; see
Step 3's override handling. Never add one on the skill's own initiative to get
past a red gate — that is the gate working.

**Arguments**: `$ARGUMENTS` — optional path to a plan file to update
(e.g., `docs/plans/<name>.md`).

<!-- host-contract: input-acquisition; grammar=path+flags; empty=default -->

**Where `$ARGUMENTS` comes from** — orchestrator-supplied input first, else
the host's verbatim invocation suffix, else the span of the user's **current**
message naming this skill or its subject. Never inferred from surrounding
conversation. This site is `path+flags`; on empty input, ship without updating a plan — that is the documented default. Never adopt a plan path mentioned earlier in the conversation.
Full contract: `references/input-acquisition.md`.


> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first.
>
> If this repo defines no such script, it has not adopted the remedy yet. Add
> this entry to its `package.json` `scripts` and run it — it copies the tooling
> tree in from the main checkout, and leans on nothing but node and git:
>
> "skills:hydrate": "node -e \"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});console.log('[hydrate] copied '+src)\""
>
> Rationale (source repo only — `docs/runbooks/` is not synced to consumers):
> `docs/runbooks/consumer-adoption.md` §"Linked git worktrees".

**Ship-specific, because here the wrong answer is silent instead of loud**: do not
reach the tooling by `cd`-ing to the main checkout. `ship-commit.mjs` and
`cross-skill.mjs` read HEAD, branch and `commit_sha` from cwd — from there they
would commit and attribute the **wrong tree**, with no error. Phase 0's
`detect-stack` is already one of these commands, so resolve this before it.

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

> **`byMode` counts by what a row IS, not by which run recorded it** (upstream
> report `fe1ff38a`, fixed 2026-09-06). A plan-mode run is not the only source of
> a section reference: the write side records `primary_file` as
> `_primaryFile || section`, so a **code**-mode finding lacking a file path of its
> own falls back to prose while `audit_mode` stays `'code'`. Counting on
> `audit_mode` alone therefore reported unlockable rows as actionable work — 2.5x
> overstated in the reporting consumer, and measured at fix time against the
> upstream store: **33 of 233** `unlocked_fixes` code rows and **56 of 227**
> `unremediated_acceptances` code rows were section references. The readers now
> classify on `primary_file`'s shape as well, so `byMode.code` is the count you can
> act on. Rows are unchanged — only the aggregate moved.
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

**First, a capped auto-reconcile pass (best-effort, never blocks, no override
flag).** The live-audit-round lifecycle that would otherwise flip
`remediation_state` to `fixed` is session-scoped, round-diff-scoped, and
14-day-bounded ([`docs/plans/remediation-state-verification-reconciler.md`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/docs/plans/remediation-state-verification-reconciler.md))
— outside that intersection (the common case for a row that survives to reach
this step at all) nothing else will ever re-check it. Run this BEFORE the
query below, so its counts reflect what a machine already closed rather than a
growing pile a human could have been spared:

```bash
node scripts/remediation-reconcile.mjs --apply --cap 5 2>/dev/null
```

Swallow any failure exactly like every other 0.5-step (`try { … } catch { log,
continue }`) — this is advisory infrastructure, not a precondition for
shipping. Files with no code change since acceptance cost nothing (skipped
before any LLM call); a file that was simply deleted resolves mechanically,
no LLM needed. Report its one-line summary alongside the nudge below:
`Auto-reconciled: <resolved> verified (<mechanicallyResolved> of those by
file-deletion, no LLM call), <stillPresent> still open, <uncertain> uncertain`
— note `resolved` already INCLUDES the mechanically-resolved count, it is not
a fifth bucket to add on top. `AUDIT_REMEDIATION_RECONCILE_ENABLED=false`
opts out entirely (kill switch, not a flag on this command); an absent Claude
credential degrades to the free mechanical-resolution path only, never a
failure.

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
[tests/suppression-call-site.test.mjs](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/tests/suppression-call-site.test.mjs),
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

### 0.5g — Migration realization gate (ENFORCED by the binary, checked HERE too)

A commit that ships a migration is only half-shipped until the migration is APPLIED. On
2026-07-31 exactly that happened here: migration + dependent code committed, tests green,
pushed — and the fix was byte-for-byte inert because nobody ran `--migrate`. The drift
checker existed and was wired to nothing.

**Run the read-only preflight now, before Steps 1–6.2's doc work and the pre-push hook's
readiness suite** — not just at Step 6.3:

```bash
node scripts/ship-commit.mjs --check-migrations
```

A consumer reported (2026-08-14) discovering this block only at Step 6.3, after already
running a full local + fresh-clone readiness pass — the block itself is cheap (one indexed
SELECT), but finding out about it late meant redoing validation that unapplied migrations
had nothing to do with. Running it here surfaces the same block before that work happens.

- **The real enforcement stays at Step 6.3** — `ship-commit.mjs` performs the check again
  inside the commit path and exits 2 there regardless of whether this preflight ran. A SKILL
  step is an instruction to an agent and cannot block on its own; this early run is advisory,
  not a substitute gate.
- **Unconditional when the cloud store is on.** Deliberately NOT gated on "the push range
  touches `supabase/migrations/`": a code-only commit can depend on a migration left
  unapplied by an *earlier* push or a branch switch, which is the more dangerous version of
  the same bug.
- **Cloud off / unreachable / no ledger ⇒ silently skipped**, never a block. Blocking on an
  unmeasurable condition is the cried-wolf shape that earns `--no-verify`.
- **On a block**: run `node scripts/setup-postgres.mjs --migrate`, then continue — Step 6.3
  will pass without a retry once the migration is applied.

> **This checks the AMBIENT store only — the consumers get their own read** (added
> 2026-08-30, source-repo only). `--check-migrations` asks whether *this* process's
> `AUDIT_DB_URL` is current. Consumers are not on one store, so a consumer whose store
> falls behind is invisible from here until one of its own writes hits the realization
> guard. Measured: a consumer's store sat **2 migrations behind for a day** — the `.sql`
> files had synced to disk and were never applied, so its code and schema disagreed
> silently and the `annotation` event shipped the day before could not have worked
> there. It surfaced only when a routine upstream-report closure was refused.
>
> ```bash
> npm run stores:drift
> ```
>
> Print its stdout verbatim — it renders the finished card. **Never blocks, no override
> flag**, same reasoning as 0.5h: applying a migration to a consumer's production
> database is an operator decision, and a gate firing on something the commit cannot
> change is what earns `--no-verify`.
>
> **Read the `unqueried` / `no store` lines.** A store nobody could reach and a consumer
> whose DSN could not be resolved are reported explicitly rather than counted as
> current; if NO store answered, the card says `NOTHING WAS CHECKED` instead of
> `all current`.
>
> **The runtime DSN usually cannot apply migrations.** A consumer's `.env` carries its
> *runtime* role; on managed Postgres that role does not own the tables (measured:
> `must be owner of table audit_findings`, 42501). That is the least-privilege boundary
> working — do NOT resolve it by granting the runtime role ownership, or by putting an
> admin DSN in `.env`. Which role to use, and where its credential belongs (a secret
> store, never a file): `references/migration-credentials.md`.

### 0.5h — Upstream issue queue (advisory, source-repo only)

**Source-repo-gated** — run ONLY when `package.json.name === "claude-engineering-skills"`.
Consumers FILE reports (`cross-skill.mjs upstream report`); this repo is where they
get triaged, and nothing prompted anyone to read them. Measured 2026-08-01: two
consumer reports sat unread, one of them already fixed ~45 minutes earlier and
still showing `open`. A queue nobody is prompted to read is a queue that decays.

```bash
npm run upstream:queues 2>/dev/null
```

Print its stdout verbatim — it renders the finished card, so there is nothing to
parse and no formatting decision here.

> **Read EVERY consumer's store, not the ambient one** (fixed 2026-08-29). This
> step used to run `cross-skill.mjs upstream list`, which queries whatever store
> `AUDIT_DB_URL` names in THIS repo. Consumers are not on one store: `storyline`
> files into a corporate Azure Postgres while this repo defaults to the NAS one,
> so the step printed **`0 open`** in the very session that consumer had EIGHT
> genuinely open reports — four of them HIGH, the oldest already a day old. A
> triage nudge blind to an entire consumer was reporting its blindness as a
> clean queue.
>
> `upstream-queues.mjs` resolves each registered consumer's store the way that
> consumer's own tooling does (its `.env`, then the shared `~/.audit-loop.env`),
> dedupes by `storeFingerprint` so repos sharing a store are queried once, and
> asks each one in a child process. It prints a **fingerprint plus the consumer
> names**, never a DSN or hostname — this output gets pasted into a public
> repo's status log and one store is a corporate internal host.

**Never blocks, and there is no override flag** — the queue is CLOUD state, not
repo state, so it can only advise; a check firing on something the commit
cannot change is the cried-wolf shape that earns `--no-verify`. It always exits 0.

**Read the `unqueried` / `no store` lines, and do not treat the count as
complete when either is present.** They are the whole point of the rewrite: a
store nobody could reach and a consumer whose DSN could not be resolved are both
reported explicitly rather than counted as zero. If NO store answered, the card
says `NOTHING WAS CHECKED` instead of `0 open` — that is not a clean queue, it
is an unasked question, and reporting it as clean is the defect this replaced.

Triage against **the store that owns the row** — `upstream ack|fix|wont-fix`
writes to the ambient `AUDIT_DB_URL`, which is only one of them. For a report
belonging to another consumer's store, run the transition with that store's DSN
in the environment:

```bash
node scripts/cross-skill.mjs upstream ack --id <the full uuid>     # or fix --commit / wont-fix
```

Closing a report needs the **FULL uuid**, not a prefix: the store resolves a
prefix but the committed disposition ledger records what you typed, and
`upstream:coverage:gate` rejects a non-uuid key. Full ids:
`node scripts/cross-skill.mjs upstream list --worksheet` (ambient store) or the
card above.

Before triaging, check `freshness` and `priorFixes` on the row: a report can
describe a defect that a LATER commit already fixed, so `fix --commit` may be the
correct verb on a report you have not touched. Do not close one on the strength of
the worksheet's evidence alone — confirm against current code.

### 0.5i — Stalled comparison campaigns (advisory, source-repo only)

**Source-repo-gated** — run ONLY when `package.json.name === "claude-engineering-skills"`.
Campaigns are declared in `.campaigns/`, which exists only here; a consumer has
no campaign to be stalled on, and `campaign.mjs` is deliberately not in the
consumer bundle for that reason.

A campaign short of `targetN` is **not decision-eligible** — the spend is
banked but the evidence cannot answer anything yet. Nothing surfaced that:
`campaign.mjs status` answers when asked, and answering only when asked is how
a campaign goes quiet. Measured 2026-08-23 — `final-review-scoped-2026q3` sat
at 9/12 for three days while 17 unrelated audit runs went past it, noticed only
because someone thought to ask.

```bash
node scripts/campaign.mjs stale 2>/dev/null
```

**Never blocks, no override flag** — same reasoning as 0.5h: collection state
is CLOUD state the commit cannot change, so it can only advise. Silent when no
campaign is stalled, when the store is unreachable, and when a campaign has
never collected at all (never-started is not stalled). Prints its own card; pass
it through verbatim rather than re-rendering it — the counts and the remedy line
belong to the tool, not to this prose.

Do **not** treat a stalled campaign as a reason to collect right now: collection
is spend-bearing and revision-pinned (`npm run fixture:create`), so it is a
deliberate scheduled act, not a pre-push chore. The nudge exists so the decision
is *made*, including the decision to close it out with
`declare-inconclusive`.

### 0.5f — Override flags

If `$ARGUMENTS` contains `--no-tests`, `--ignore-p0`, or `--skip-ux-lock`,

<!-- host-contract: input-acquisition; grammar=path+flags; empty=default -->
_This site: `path+flags` — **no flag means no override.** Each of these disables a gate, so they are read ONLY from the invocation — a conversation that merely mentions skipping tests must never become one._

record which override is active — it goes into the ship_event.

> **Numbering note**: this sub-step is `0.5f`, not `0.5d`, because two H2
> sections below already claim `Step 0.5c` and `Step 0.5d` (a pre-existing
> collision referenced from ~20 other files, so renumbering them is out of
> scope here). The H3 sub-step order is `0.5a → 0.5b → 0.5e → 0.5g → 0.5h → 0.5i → 0.5f`.

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
> `GENERATED_UNTRACKED_TARGETS` in `check-docs-refs.mjs`; a fresh clone of the
> **source repo** regenerates it with `npm run dashboard:setup` — an alias that
> exists here only, since the sync never adds npm scripts. A consumer runs the
> three steps by path: `symbol-index/refresh.mjs`, `symbol-index/render-mermaid.mjs`,
> `build-dashboard.mjs all`. The reasoning lives beside the `.gitignore` entry.
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
Skip silently in consumer repos. The dashboard is not unavailable there, just
opt-in and unwired: the builder syncs, but the sync never adds npm scripts, so
a consumer runs it by path and gets gitignored pages under its own
`dashboard/`:

```bash
node scripts/build-dashboard.mjs all         # reference + telemetry
node scripts/build-dashboard.mjs serve       # build, then serve locally
node scripts/build-dashboard.mjs --help      # every mode and flag
```

Never blocks the ship.

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
builds of one commit can differ). They were reclassified B → A in 2026-06;
this step's staging instruction outlived that change and told the agent to
`git add` a gitignored path, which either fails or force-adds a Category-A
artifact into a commit. (Design rationale, source repo only — `docs/plans/`
is not synced to consumers: `docs/plans/local-dashboard.md` §2.1.)

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

If `ship-verification-pending.md` exists in the MAIN checkout's `.claude/tmp/`
(Step 6.8 of a prior ship wrote it instead of force-pushing a status.md-only
commit), read it, prepend its content now as a
`### Consumer Verification (previous ship)` subsection above the new entry —
see `references/status-md-format.md` — then delete the file. This is how that
note ever reaches git without a second push. The file is gitignored scratch
state (same directory the commit-message file uses), so it survives a session
boundary but never ships as-is.

**Resolve the MAIN checkout, not the tree you are standing in** — `.claude/tmp/`
is per-worktree, and Step 6.8 deliberately writes to the durable one (a worktree
is routinely deleted at session end, taking the note with it):

```bash
node -e "const{execFileSync}=require('node:child_process'),p=require('node:path');console.log(p.join(p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim()),'.claude','tmp','ship-verification-pending.md'))"
```

Append a new session log entry to `status.md`. If file doesn't exist,
create with the standard header. Always append at the TOP (below the
header) so the most recent session is first.

Full template + rules + optional sections (UX Status, Persona Test Status,
Regression Lock Status, Plan Verify Status, Consumer Verification):
`references/status-md-format.md`.

### Step 2b — Backlog snapshot line (one command, advisory)

Include a **`Backlog:`** line in the entry, so the standing queues are trended
in the log instead of being rediscovered every few weeks:

```bash
node scripts/backlog-snapshot.mjs
```

Paste its single stdout line into the entry. It reads every queue itself, at one
instant, read-only, and **writes nothing** — you insert the line as part of the
entry you are already authoring. Never let a script write `status.md`: PR #87
destroyed 19,257 lines of it that way.

A queue it could not read renders **`unmeasured`**, never `0`. That distinction
is the point — `0` reads as good news, and an unasked question is not good news.
The command always exits 0; it is a nudge, never a gate.

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
- Then run **`node scripts/check-context-drift.mjs --strict`** — it enforces the topology (CLAUDE.md
  `@`-imports AGENTS.md, stays ≤ the line cap, only allowlisted Claude-only
  headings, no shared-section drift). Fix any findings by moving shared content
  to AGENTS.md — **never** by mirroring.
- If a repo is still in the legacy full-mirror state (CLAUDE.md == AGENTS.md),
  migrate it with **`/ai-context-management migrate`** (flips to AGENTS.md-canonical
  + thin CLAUDE.md); do not hand-resolve.

---

## Step 5 — Update Plan (if plan path in arguments)

Only when `$ARGUMENTS` contains a plan file path:

<!-- host-contract: input-acquisition; grammar=path+flags; empty=default -->
_This site: `path+flags` — no path means skip the plan update entirely; do not search for a plausible plan to update._


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
- `--gate` — four values. The first two are **verified** (the helper queries the
  run's `audit_runs` row); the last two are **declared**.
  - `passed` — fresh evidence, the store says the run converged, **and the
    committed tree IS the audited tree**.
  - `converged` — the same evidence and the same store verdict, but the
    **committed tree DIFFERS from the audited tree**. This is the
    audited-then-remediated ship: the audit ran, its findings were accepted and
    **fixed**, so the tree moved *because of the gate*. Not a bypass, and it must
    not be labelled as one.
  - `waived` — a declared disposition with no verified verdict: shipped past a
    gate via `--ignore-p0`/`--no-tests`/etc., OR verification unavailable (cloud
    off / run not found / run did not converge).
  - `not-run` — no fresh evidence at all (docs-only ships).

> **`passed` and `converged` are mutually exclusive halves of ONE comparison**,
> so each refusal names the other: asking for `passed` on a moved tree points at
> `converged`, and asking for `converged` on an unchanged tree points at `passed`
> — you may not under-claim. Both clear the identical store bar, so cloud off or
> a non-converged run refuses either and leaves `waived`. A partial commit of an
> audited worktree differs from the audited tree, so it is `converged` territory,
> never `passed`.
>
> **`passed` is rare BY DESIGN, and its rarity is not a defect to engineer
> around.** `/ship`'s own Steps 2–5 write `status.md`, sometimes CLAUDE.md, and
> the plan's Implementation Log *after* the audit and *before* the commit — so
> even a zero-finding, converged, otherwise-untouched audit moves the tree and
> lands on `converged`. Measured over this repo's history when `converged` was
> added: 647 `not-run`, 86 `waived`, 2 `passed`. Do NOT hand-write
> `.audit/last-audit-run.json`, re-run a review purely to populate the column, or
> reorder your ship to chase `passed`. **The value worth investigating is a
> `passed` that should not be there.**
>
> **`--no-run-id` exists, and it means "that audit was unrelated to this
> commit".** Fresh evidence makes `not-run` illegal, so a docs-only follow-up
> commit after an audited ship inherits the previous commit's marker and must
> disclaim it: `--no-run-id --gate not-run`. It omits `AI-Run-ID` entirely. Use
> it **only** when the claim is true — on a fix-heavy ship the audit was very
> much related, and the honest value there is `converged`, not a disclaimed
> `not-run`.
>
> **Freshness is `evidenceMs > headCommitTs`, so someone ELSE's commit ages out
> your evidence.** In a repo with a concurrent session, a foreign commit landing
> between your audit and your ship makes the marker stale — which also removes
> `waived` (it requires `fresh`) and leaves `not-run` as the only legal value.
> If you need the trailer to reflect your audit, don't ship across another
> session's commits. Note the converse is NOT guaranteed: committer timestamps
> are user-controlled and non-monotonic, so freshness does not prove that no
> commit intervened, and `converged` claims no such thing.
>
> **`--no-tests` caps the gate.** With hooks skipped the helper forces `waived`
> (fresh evidence) or `not-run` (otherwise), loudly, whatever you asked for.
> Skipping hooks can never buy a stronger verdict.

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
run the refresher to keep the Supabase index in sync with markdown (only ever
publishes pushed state — R3-H3 design constraint). Surface the result line
briefly.

```bash
node scripts/security-memory/refresh-incidents.mjs
```

**Call the script by path, never `npm run security:refresh`.** The sync never
merges npm scripts into a consumer's `package.json`, so that alias exists in
the source repo and nowhere else. From 2026-08-14 this step used that alias
with `--if-present` appended, which silenced the `Missing script` error a
consumer reported — and, because that flag exits **0** having run nothing,
turned every consumer refresh into a silent no-op with a success exit code.
The refresher itself **is** synced
(`scripts/.claude-skills/security-memory/refresh-incidents.mjs`), so naming the
path makes the step actually run where it was always meant to. Do not "fix" a
missing alias by writing to a consumer's script table from a SKILL step.

After refresh, regex-match the HEAD commit subject against
`/fix.*\bsecurity\b|\bcve\b|\bvuln\b|\bleak\b|\binjection\b|\bauth\b|\bxss\b|\bcsrf\b|\brce\b/i`
(word-boundary-anchored — the unanchored form matched "leak" inside
"leaking", "auth" inside "author/authoring", and "rce" inside
"source/force/interface", false-flagging ~6% of commits in a 200-commit
sample; confirmed 2026-07-22). If matched, emit a single passive log line
(NOT an interactive prompt — `/ship` runs to completion without asking, which
is the whole contract in its `description`; a prompt here would strand the
push mid-flight):

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
C10). This step surfaces friction notes that the just-pushed commit may have
resolved, so a recurring papercut gets marked closed instead of recurring forever.

<!-- host-contract: hook-rule; rule=friction-closure-after-push; portable=node scripts/cross-skill.mjs quality session-review; accelerator=.claude/hooks/UserPromptSubmit -->

> **Rule (all hosts)** — after a successful push, pending friction notes are
> surfaced once, and the step is accepted when the session-review command has
> run and its output reported. **Portable path**: the command below, which is
> in the sync closure and works everywhere. **Accelerator (Claude Code only)**:
> a `UserPromptSubmit` hook injects `> Relevant prior friction` callouts during
> the session and records a breadcrumb, so the notes are already in view.
>
> **The cadence differs and that is worth knowing.** With the hook, friction is
> surfaced *as you work*; without it, only here, once per ship. On a host with
> no hooks the session-review call returns whatever the store holds — which,
> with nothing injected during the session, is usually empty. That is a correct
> empty, not a broken one, and this step must not read an empty list as
> evidence that no friction existed. Earlier wording asserted the hook "injects"
> callouts as plain fact, which is false outside Claude Code.

If push succeeded, list pending injected-but-unlinked friction:

```bash
node scripts/cross-skill.mjs quality session-review
```

For each pending note, emit a single passive line with the ready link command
(NOT an interactive prompt — `/ship` runs to completion without asking, same as
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

**Widened to the primary bucket (docs/plans/skill-efficacy-census.md Phase 1,
2026-08-22)**: the 2026-07-28 fix only reached the shadow-only bucket — the
READ side (`final-review-pending`) was hard-scoped to `shadowOnlyQueue`, so a
primary GPT/Gemini-round finding was never surfaced here at all, however long
it sat fixed with `user_action` still null (a live-store audit found 1,615
such rows). `final-review-pending` now reads a merged `pendingQueue`
(shadow-only ∪ primary-bucket fixed-but-unlabelled), and the card threads
each item's own `bucket` through to its printed command instead of
hardcoding `shadow-only` — a bug that would have silently mis-scoped every
primary-bucket item even after the read side was widened. No change to this
step's own invocation: the same command below now surfaces both buckets.

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
| the synced consumer bundle | **authoritative**: `node scripts/.claude-skills/lib/sync-isolation-verify.mjs`, run *in the consumer's MAIN checkout* — note the `lib/` segment, it is a module rather than a top-level script. A linked worktree cannot answer this: `skills:hydrate` copies the tooling tree, and `scripts/.sync-manifest.json` is gitignored too, so the run stops at `manifest missing at …` with exit 2. Hydrating the manifest as well would not help — the manifest records what the last sync wrote to the MAIN checkout's disk, so a worktree comparison re-reads the files hydrate itself just copied and reports agreement it manufactured. `npm run sync:dry` from here is the pre-check, not the verdict | zero unexpected diffs; no orphans |
| the skill manifest | re-derive from the pushed sha, not the working tree | regenerated bytes identical |

**Write the outcome to the MAIN checkout's `.claude/tmp/ship-verification-pending.md`
— never by re-opening the status.md entry you just pushed.** status.md is append-only
(Reminders, below), and this step runs AFTER that entry's commit already
landed: writing into it now means a second commit and a second push, which
re-triggers the same pre-push readiness suite Step 6.8 exists to verify —
doubling the workflow's cost for one status line. A consumer hit exactly this
2026-08-14 and reported it as friction. Include in the file: the immutable
locator (full sha / digest / bundle version), the retrieval command actually
run, and the observed result. The **next** `/ship` invocation's Step 2 reads
this file, prepends it as a `### Consumer Verification (previous ship)`
subsection above that session's own entry, then deletes it (template:
`references/status-md-format.md`). If no further `/ship` happens, the file
simply sits there unread — an acceptable loss for advisory documentation
(never a gate), not a reason to force a push now.

> **The MAIN checkout, not the worktree you are standing in** (2026-08-14). A
> ship run from a linked worktree that is then deleted — the normal end of a
> Claude Code session — destroys this note before any later `/ship` can read it,
> so the handoff silently never happens and the only symptom is a note that
> never appears. `.claude/tmp/` resolves per-tree, so "write it to
> `.claude/tmp/`" means a different directory depending on where you are
> standing. Resolve the durable one explicitly:
>
> ```bash
> node -e "const{execFileSync}=require('node:child_process'),p=require('node:path');console.log(p.join(p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim()),'.claude','tmp','ship-verification-pending.md'))"
> ```
>
> Same `--git-common-dir` trick `skills:hydrate` uses, and for the same reason:
> in a linked worktree the common dir's parent IS the main checkout, and the
> main checkout is the one tree guaranteed to outlive the session. Step 2 reads
> the same resolved path, so a note written from a worktree is still found by a
> later ship run from anywhere.

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
  mirror/overwrite AGENTS.md from CLAUDE.md; verify with
  `node scripts/check-context-drift.mjs --strict`
- **No confirmation needed** — `/ship` is the approval. Execute autonomously
- **Be specific in the log** — name files, functions, endpoints
- **The commit message matters** — it's the permanent record in git history

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/input-acquisition.md` | Where a skill's arguments come from on any host, and what to do when there are none. | Reading $ARGUMENTS on a host that does not substitute it, or deciding what empty input means at a site. |
| `references/migration-credentials.md` | Which role applies migrations, why the runtime DSN cannot, and where its credential belongs (never in .env). | Step 0.5g — a store is behind and `--migrate` is refused with `42501` (`must be owner of table …` / `permission denied for schema public`). |
| `references/python-environment-discovery.md` | Python pre-push command discovery — env wrapper detection + per-tool probe order. | detect-stack returned `python` or `mixed` with Python files in the diff. |
| `references/status-md-format.md` | status.md session-log template + update rules + persona / UX status sections. | Step 2 — creating status.md for the first time, OR appending UX / Persona / Regression-Lock / Plan-Verify sections. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Step 6.8 — the push succeeded and the artifact must be verified from the consumer side. |
