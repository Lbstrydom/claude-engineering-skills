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
> "skills:hydrate": "node -e \"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});const prune=(s,d)=>{if(!f.existsSync(d))return;for(const e of f.readdirSync(d,{withFileTypes:true})){const sp=p.join(s,e.name),dp=p.join(d,e.name);if(e.isDirectory()){if(!f.existsSync(sp)){f.rmSync(dp,{recursive:true,force:true});continue}prune(sp,dp);if(f.readdirSync(dp).length===0)f.rmSync(dp,{recursive:true,force:true})}else if(!f.existsSync(sp))f.rmSync(dp,{force:true})}};prune(src,dir);const man='scripts/.sync-manifest.json',ms=p.join(main,man),ok=f.existsSync(ms);if(ok){f.copyFileSync(ms,man)}console.log('[hydrate] copied '+(ok?2:1)+'/2 items from '+main+(ok?'':' - but NOT '+man+' (absent there): this tree has no bundle stamp'))\""
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

Run bare — the command resolves the repo itself (`--repo` -> `PERSONA_TEST_REPO_NAME` -> ambient `git remote`).
**Never pass `--repo "$PERSONA_TEST_REPO_NAME"` as a shell expansion** — see
`references/pre-ship-gate-queries.md` §0.5a for why.

```bash
node scripts/cross-skill.mjs persona-outcomes summary
```

Returns `{ok, cloud, measured, scope:{mode,repoId,slug}, sessionId,
sessionCreatedAt, persona, verdict, rawP0, rawP1, labeled: {closed,
open_relabeled_fixed, open_relabeled_stale, unlabeled, pending_verification},
openP0, openP1, pendingVerificationP0, pendingVerificationP1}`.

**Check `measured` BEFORE reading any count** (same rule as Step 0.5b).
`measured: false` means the gate asked nothing — report it as UNMEASURED,
naming the resolution it attempted, and NEVER as "gate silent":

```
⚠ UX GATE — UNMEASURED (<reason>)
  No repo slug resolved (tried: --repo, PERSONA_TEST_REPO_NAME, git remote).
  This is NOT "no open P0s" — nothing was read.
  Scope it: node scripts/cross-skill.mjs persona-outcomes summary --repo owner/name
```

**Closed failure semantics — never a NEW blocker**:
- `cloud: false` → proceed without the UX gate, exactly as today.
- `measured: false` → print the UNMEASURED card above, then proceed.
- `sessionId: null` **with `measured: true`** → the gate is genuinely silent —
  name the repo it resolved (`scope.slug`, `scope.mode`).
- `ok: false` (a real store/query failure) → log one warning line and fall
  back to the legacy raw read, same `measured`/`scope` fields:
  ```bash
  node scripts/cross-skill.mjs get-persona-sessions-by-repo     --limit 1 --p0-only     --select persona,focus,verdict,p0_count,p1_count,created_at,debrief_md
  ```
  (uses that session's raw `p0_count`/`p1_count` as `open_p0_count`/`open_p1_count`).

**`pendingVerification*` is neither open nor clear** — a `fixed` label from the
very session being read has no newer evidence either way. When
`pendingVerificationP0 > 0`, print one line and proceed:

```
  <n> P0 fix(es) awaiting verification — re-run /persona-test to confirm.
```

Capture `openP0` + `openP1` (or the legacy fallback's `p0_count`/`p1_count`)
as `open_p0_count`/`open_p1_count` for the ship_event record. If `openP0 > 0`
(or the legacy fallback's `p0_count > 0`):

```
⚠ UX GATE (non-blocking)
  Last persona test: "<persona>" — <N> days ago → <verdict> (P0: <n>, P1: <n>)
  Unresolved P0s detected. These are user-visible broken flows.
  Shipping anyway — consider fixing before next user-facing release.
  Label fixed/dismissed P0s: node scripts/cross-skill.mjs persona-outcomes --worksheet
```

The worksheet line only appears when the PRIMARY read succeeded (the legacy
fallback path has no outcome ledger to label against).

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

**Watch `agedOut` — it should be 0.** The 14-day window stays the default (an
unbounded ship-time nudge becomes noise), split into what it dropped:
- **`agedOut`** — expired while a locking practice was live. A real leak;
  non-zero means obligations are being discharged by delay.
- **`prePractice`** — expired before this repo's first lock (`practiceStart`).
  Not an obligation — a repo that has never locked anything reports `agedOut: 0`.

Read past the window with `--all-ages`; `total`/`byMode` then describe the
unwindowed set:

```bash
node scripts/cross-skill.mjs list-unlocked-fixes --all-ages
```

**Never hand-derive a repo id** — pass no flag (ambient identity) or
`--repo <owner/repo>`; `--repo-id` is verified against `audit_repos`, and an
unresolvable one reports `measured:false` rather than an authoritative empty
backlog.

**Use `byMode.code` as `missing_spec_count` — NOT `rows.length`.** `rows` is
capped at 20. `byMode.plan` findings have a section reference, not a file —
**no lock of any kind can ever exist for them** — so a single mixed total
makes part of the backlog read as work that cannot be done. `byMode` counts by
what a row IS (`primary_file`'s shape), not by which run recorded it.

**`danglingLocks` — a recorded lock whose test file is no longer there.**
`count: null` means the question went unasked (cloud off, unresolved repo, a
read that threw) — distinct from `0`. When `count > 0`, print the sampled rows
and act on each:

```bash
node scripts/cross-skill.mjs repoint-regression-spec --finding FINDING_UUID --test tests/dangling-regression-lock.test.mjs --description "why the old artefact went away"
```

`--delete` instead of `--test` where no test discharges the finding at all —
that is the honest outcome, not a lesser one: the finding returns to
`unlocked_fixes` and gets raised again. The command refuses a missing target
path, an unresolvable repo, and an ambiguous `(repo, finding)`. Incident
history + why each of these rules exists: `references/pre-ship-gate-queries.md`
§0.5b.

`unlocked_fixes` has no UI-relevance filter — it fires identically for a
DOM-facing fix and a pure backend/CLI one, and `/ux-lock` can only ever cover
the former. Judge each row by `primary_file` before suggesting a fix, if
`byMode.code > 0`:

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

If `agedOutByMode.code > 0`, print it too — lead with the CODE split, not the
mixed `agedOut` total (a plan row can never be locked, so it is never a lost
obligation):

```
⚠ OBLIGATIONS LOST TO THE WINDOW (non-blocking)
  <agedOutByMode.code> code fix(es) aged out of the 14-day window UNLOCKED,
  after this repo started locking (<practiceStart>)
  (+ <agedOutByMode.plan> plan finding(s), which cannot be locked — not an obligation).
  Waiting is not a way to clear this gate. Read them:
    node scripts/cross-skill.mjs list-unlocked-fixes --all-ages
  Then either lock them, or write them off in status.md so the decision is on
  the record — an obligation discharged by silence is the thing this counts.
```

A plan-only `agedOut` (`agedOutByMode.code == 0`) prints nothing — that banner
would be a false alarm. Do **not** print `prePractice` as a backlog — it is
bookkeeping for findings that predate the practice, not work anybody owes.

**Re-running existing regression specs before a push** (optional gate): drive
them through the deterministic runner with the ship `run_context` so the
`regression_spec_runs` rows are tagged correctly and written without the model:

```bash
node scripts/ux-lock-run.mjs spec --specs 'tests/e2e/*.spec.js' --commit "$(git rev-parse HEAD)" --run-context ship-gate
```

Optional: `--url BASE_URL` when the specs need a non-default base URL.

A non-zero exit means a locked contract broke — treat as a `test-failure`
block reason. Cloud off → it still runs + prints; Playwright missing → exit 5
(skip the gate, don't fail the ship on a missing optional dep).

### 0.5e — Accepted findings that were never remediated

**First, a capped auto-reconcile pass** (best-effort, never blocks, no
override flag) — closes what the live-audit lifecycle's session/round/14-day
bounds will never revisit on their own:

```bash
node scripts/remediation-reconcile.mjs --apply --cap 5 2>/dev/null
```

Swallow any failure like every other 0.5-step. Report its one-line summary
alongside the nudge below: `Auto-reconciled: <resolved> verified
(<mechanicallyResolved> of those by file-deletion, no LLM call), <stillPresent>
still open, <uncertain> uncertain` — `resolved` already includes the
mechanically-resolved count. `AUDIT_REMEDIATION_RECONCILE_ENABLED=false` opts
out entirely; an absent Claude credential degrades to the free
mechanical-resolution path only, never a failure.

```bash
node scripts/cross-skill.mjs list-unremediated-acceptances
```

Returns `{ok, cloud, scope:{mode,repoId,slug}, measured, reason, rows, shown,
total, byMode:{total,code,plan}, allAges, agedOut, agedOutByMode:{code,plan},
agedOutBySeverity:{HIGH,MEDIUM}, notYetDue, prePractice, practiceStart}`.

**Check `measured` BEFORE reading the count** — identical contract to 0.5b.
`measured:false` means *nothing was measured*; an empty `rows` then means "not
applicable", **not** "no unremediated acceptances".

**Two bounds, and only one of them forgets** — both present as "not shown",
opposite states:
- **`notYetDue`** — under the 7-day maturity floor. In flight, not forgotten.
  **Never add this to `agedOut`, and never report it as a backlog** — mention
  it only if `total` is 0 and `notYetDue` is not, where it is the difference
  between "nothing owed" and "nothing owed *yet*".
- **`agedOut`** — over the 30-day ceiling, accepted after `practiceStart`. A
  real leak: never shown again.
- **`prePractice`** — over the ceiling but older than `practiceStart`. Not an
  obligation this repo ever had.

`--all-ages` drops both bounds; `total`/`byMode` then describe the unwindowed
set:

```bash
node scripts/cross-skill.mjs list-unremediated-acceptances --all-ages
```

**Use `byMode.total` as `unremediated_count` — NEVER `rows.length`** (capped
at 20). `byMode.plan` rows depend on the plan's status:
- **Plan still in flight** → real work; treat it as an obligation.
- **Plan marked Complete** → the obligation is to edit a shipped design
  document — close to worthless. Write the class off with the reasoning on
  the record rather than let it sit as a permanent count.

Write-offs cover the *document* obligation only — a code-level defect the
ambiguity may have produced is a separate code finding, raised by code
audits. The store has no "written off" state, so record a class write-off as
`dismissed` and put the real reasoning in `status.md`.

One step EARLIER in the lifecycle than 0.5b: `unlocked_fixes` asks *"this was
fixed — is the fix locked?"*; this asks *"this was accepted — was it ever
fixed at all?"*. The `unremediated_acceptances` view lists HIGH/MEDIUM findings
whose `adjudication_outcome` is `accepted`/`severity_adjusted` but whose
`remediation_state` is still NULL/`pending`/`planned` after 7+ days —
`accepted` is not evidence of a fix, and no other mechanism re-raises these
(audits default to `--scope diff`, so a finding is re-raised only if a later
audit happens to cover the same file). **That cuts both ways** — a row can
also be already fixed with nobody having written it down. Treat each row as a
hypothesis about current code, verify it, then close it in the right
direction (`--state fixed` or a dismissal) rather than assuming either.

If `> 0`, print — never blocks, no override flag. **Show the first 5 rows as
returned** (HIGH first, then oldest first — do not re-sort). To read past the
default 20-row page (order is total; pages neither repeat nor skip a row):

```bash
node scripts/cross-skill.mjs list-unremediated-acceptances --limit 20 --offset 20
```

The payload echoes the resolved `limit`/`offset` (store clamps to 200), so a
short page can be told from an exhausted one.

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

**`byDisposition.acceptedPermanent` is a decision, not a backlog — print it,
do not chase it.** Those rows are weighed and declined on the merits, and
excluded from `open`/`total`. Reported for one reason: a disposition you
cannot see is indistinguishable from a leak. `open === total` always — one
number under two names.

If `agedOut > 0`, print it separately — split by mode, since the two halves
close by different acts (a code row needs a fix; a plan row is an obligation
only while its plan is still in flight):

```
⚠ ACCEPTANCES LOST TO THE CEILING (non-blocking)
  <agedOutByMode.code> code finding(s) passed the 30-day ceiling still unremediated,
  after this repo started recording remediations (<practiceStart>)
  (+ <agedOutByMode.plan> plan section(s) — an obligation only while that plan is
  still in flight; on a Complete plan it is a shipped design doc, write it off).
  <agedOutBySeverity.HIGH> of the <agedOut> are HIGH, across both modes.
  They will not appear above again. Read them:
    node scripts/cross-skill.mjs list-unremediated-acceptances --all-ages
  Then remediate, or close the loop with final-review-record-fix, or write them
  off in status.md — an obligation discharged by silence is what this counts.
```

**Close rows with `final-review-record-fix`, not `finalize-outcomes`** — the
latter needs a live round's `--ledger`/`--result`, which a finding accepted
weeks ago has neither. `final-review-record-fix` takes `--run-id` +
`--fingerprint` (optional `--bucket`) — both keys come from the row
(`audit_run_id`, `finding_fingerprint`). If your store predates migration
`20260808200000` the fingerprint is absent: run
`node scripts/setup-postgres.mjs --migrate` rather than hand-deriving it.

Judge the list before echoing it — two rows look identical but are not:

- `audit_mode = 'code'` → `primary_file` is a real path; the defect is in the
  code right now.
- `audit_mode = 'plan'` → `primary_file` is a plan SECTION reference (e.g.
  `§7 ws-a migration; close-out`), not a file. Equally a real obligation (the
  plan was never amended), but say so rather than printing it as a code path.
- `remediation_state = 'planned'` with a live plan is genuinely in-flight, not
  forgotten — drop it from the printed list.

Incident history behind each rule above (the scoping fix, the mode-split
rationale, the HIGH-first ordering bug, why `finalize-outcomes` was wrong):
`references/pre-ship-gate-queries.md` §0.5e.

### 0.5g — Migration realization gate (ENFORCED by the binary, checked HERE too)

A commit that ships a migration is only half-shipped until the migration is
APPLIED — a migration can be committed, tests green, pushed, and still be
byte-for-byte inert if nobody ran `--migrate`.

**Run the read-only preflight now, before Steps 1–6.2's doc work and the
pre-push hook's readiness suite** — not just at Step 6.3:

```bash
node scripts/ship-commit.mjs --check-migrations
```

- **The real enforcement stays at Step 6.3** — `ship-commit.mjs` performs the
  check again inside the commit path and exits 2 there regardless of whether
  this preflight ran. This early run is advisory, not a substitute gate.
- **Unconditional when the cloud store is on** — deliberately NOT gated on
  "the push range touches `supabase/migrations/`": a code-only commit can
  depend on a migration left unapplied by an *earlier* push or a branch switch.
- **Cloud off / unreachable / no ledger ⇒ silently skipped**, never a block.
- **On a block**: run `node scripts/setup-postgres.mjs --migrate`, then
  continue — Step 6.3 will pass without a retry once applied.

**Consumers are on their own stores — check theirs too** (source-repo only,
`--check-migrations` above asks only about the AMBIENT store):

```bash
npm run stores:drift
```

Print its stdout verbatim — it renders the finished card. **Never blocks, no
override flag** — applying a migration to a consumer's production database is
an operator decision. **Read the `unqueried` / `no store` lines** — a store
nobody could reach is reported explicitly, never counted as current; if NO
store answered, the card says `NOTHING WAS CHECKED` instead of `all current`.

**The runtime DSN usually cannot apply migrations** — a consumer's `.env`
carries its *runtime* role, which does not own the tables on managed Postgres.
Do NOT resolve this by granting the runtime role ownership, or by putting an
admin DSN in `.env`. Which role to use, and where its credential belongs (a
secret store, never a file): `references/migration-credentials.md`. Incident
history behind the rules above: `references/pre-ship-gate-queries.md` §0.5g.

### 0.5h — Upstream issue queue (advisory, source-repo only)

**Source-repo-gated** — run ONLY when `package.json.name === "claude-engineering-skills"`.
Consumers FILE reports (`cross-skill.mjs upstream report`); this repo is where
they get triaged, and nothing else prompts anyone to read them.

```bash
npm run upstream:queues 2>/dev/null
```

Print its stdout verbatim — it renders the finished card. It reads **every
registered consumer's own store** (never a single ambient one — consumers are
not all on the same DSN), printing a fingerprint plus the consumer names,
never a DSN or hostname.

**Never blocks, and there is no override flag** — the queue is cloud state,
not repo state; it always exits 0. **Read the `unqueried` / `no store` lines,
and do not treat the count as complete when either is present** —
`NOTHING WAS CHECKED` means an unasked question, not a clean queue.

Triage against **the store that owns the row** — `upstream ack|fix|wont-fix`
writes to the ambient `AUDIT_DB_URL`, which is only one of them. For a report
belonging to another consumer's store, run the transition with that store's
DSN in the environment:

```bash
node scripts/cross-skill.mjs upstream ack --id ISSUE_UUID     # or fix --commit / wont-fix
```

Closing a report needs the **FULL uuid**, not a prefix — the committed
disposition ledger records what you typed, and `upstream:coverage:gate`
rejects a non-uuid key. Full ids: `node scripts/cross-skill.mjs upstream list
--worksheet` (ambient store) or the card above.

Before triaging, check `freshness` and `priorFixes` on the row: a report can
describe a defect that a LATER commit already fixed, so `fix --commit` may be
the correct verb on a report you have not touched. Confirm against current
code before closing one on the worksheet's evidence alone. Incident history:
`references/pre-ship-gate-queries.md` §0.5h.

### 0.5i — Stalled comparison campaigns (advisory, source-repo only)

**Source-repo-gated** — run ONLY when `package.json.name === "claude-engineering-skills"`.
Campaigns are declared in `.campaigns/`, which exists only here; a consumer
has no campaign to be stalled on.

A campaign short of `targetN` is **not decision-eligible** — the spend is
banked but the evidence cannot answer anything yet.

```bash
node scripts/campaign.mjs stale 2>/dev/null
```

**Never blocks, no override flag** — collection state is cloud state the
commit cannot change. Silent when no campaign is stalled, the store is
unreachable, or a campaign has never collected at all (never-started is not
stalled). Prints its own card; pass it through verbatim.

Do **not** treat a stalled campaign as a reason to collect right now:
collection is spend-bearing and revision-pinned (`npm run fixture:create`), a
deliberate scheduled act, not a pre-push chore. The nudge exists so the
decision is *made*, including closing it out with `declare-inconclusive`.
Incident history: `references/pre-ship-gate-queries.md` §0.5i.

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

**`docs/architecture-map.md` is Category A and is NEVER staged** — it embeds a
timestamp + commit sha, carries LLM-written summaries, and renders from the
cloud `symbol_index`, so two renders of one commit differ. A fresh clone of
the **source repo** regenerates it with `npm run dashboard:setup`; a consumer
runs the three steps by path: `symbol-index/refresh.mjs`,
`symbol-index/render-mermaid.mjs`, `build-dashboard.mjs all`. This step's
value is a current LOCAL map plus a fresh cloud symbol-index for future
arch-memory consultations — not a commit artifact. Why it is classified this
way and the staging bug this replaced:
`references/architecture-and-dashboard-refresh.md` §0.5c.

**This step is ALWAYS advisory — it never blocks a ship.** Verified against
the current `pg`-direct implementation (`scripts/lib/db/client.mjs`'s
`resolveDbUrl()` and `scripts/symbol-index/refresh.mjs`) — the
`SERVICE_ROLE_REQUIRED` / RPC vocabulary below predates the postgres-parity
migration and no longer matches the code:

- Cloud off (no `AUDIT_DB_URL`, and no legacy `SUPABASE_AUDIT_*` set) →
  skip silently, ship continues.
- Legacy-only `SUPABASE_AUDIT_*` present without `AUDIT_DB_URL` → `resolveDbUrl()`
  throws (swallowed by this step's `|| true`), ship continues but the refresh
  does not run.
- Non-JS/TS stack → skips silently (`reason: 'unsupported-stack'`), exit 0,
  ship continues.
- Any other failure (DB error, embedding-provider error, repo-registration
  or refresh-lock conflict) → `refresh.mjs` exits 1 or 2 and writes a message
  to stderr; this step's own `|| true` swallows the non-zero exit so the ship
  is never blocked, but the stderr line still prints — read it if the local
  map looks stale.
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
Skip silently in consumer repos — the dashboard is opt-in and unwired there
(the sync never adds npm scripts), so a consumer runs it by path and gets
gitignored pages under its own `dashboard/`:

```bash
node scripts/build-dashboard.mjs all         # reference + telemetry
node scripts/build-dashboard.mjs serve       # build, then serve locally
node scripts/build-dashboard.mjs --help      # every mode and flag
```

Never blocks the ship.

```bash
node scripts/build-dashboard.mjs reference 2>&1
```

Run it WITHOUT `|| true` — the **exit code is the signal** and must be read,
not masked. A non-zero exit must not abort the ship (this step is advisory):
treat a failure as "skip staging, print a heads-up, continue".

`reference` mode regenerates `dashboard/index.html` + `dashboard/telemetry.html`.
The CLI exits non-zero on a **degraded** build (a source was invalid/errored).

**Nothing here is ever staged** — both pages are gitignored Category A (they
derive from mutable store state, so two builds of one commit can differ). The
exit code is a **reporting** signal, not a staging one:

- Exit 0 → the local page is current; say nothing.
- Exit non-zero → print a one-line heads-up that the dashboard build degraded;
  ship continues.

This keeps the LOCAL reference dashboard current with the skills/plans being
shipped. Why the pages are Category A, and the deleted second dashboard
build this step's note used to reference:
`references/architecture-and-dashboard-refresh.md` §0.5d.

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

Drain any consumer-verification notes a PRIOR ship left (Step 6.8 writes one
instead of force-pushing a status.md-only commit). This is how such a note ever
reaches git without a second push:

```bash
node scripts/lib/worktree-preflight.mjs pending-note read
```

It prints EVERY pending note, oldest first, each under an HTML comment naming
its file — there can be more than one, because a ship does not happen after
every note. Prepend them, in that order, as a single
`### Consumer Verification (previous ship)` subsection above the new entry —
see `references/status-md-format.md`. Then delete exactly the notes you just
prepended, with the `pending-note clear --notes …` line the read printed for
you. Pass those names verbatim: a note that arrived between the read and the
clear must survive to the next drain, which is why `clear` refuses to delete
everything it happens to find.

The command resolves the MAIN checkout itself — `.claude/tmp/` is per-worktree
and Step 6.8 deliberately writes to the durable one (a worktree is routinely
deleted at session end, taking the note with it). The notes are gitignored
scratch state (same directory the commit-message file uses), so they survive a
session boundary but never ship as-is.

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

**Resuming after a blocked `/cycle --autonomous` run?** Treat the plan path as
required, not optional — `/cycle`'s Step 7 handoff card names it explicitly
(`/ship docs/plans/<name>.md`) for exactly this reason: a bare `/ship` here
skips this step entirely, and the plan's `Status:`/Implementation Log never
picks up what the autonomous run did.

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

## Step 5.8 — Pre-push staleness check (shared-repo overlap)

Skip when the current branch is the repo's default branch (this bundle's own
main-only convention — nothing to compare against) or when Step 5 found no
plan path in `$ARGUMENTS` (no plan means no declared file scope to diff
against).

A long `/cycle --autonomous` run — many audit rounds, multiple clusters — can
take long enough for a **different** PR to merge to the default branch first,
touching files this run also touched. What that produces downstream is
confusing rather than obvious: `gh pr create` reports `mergeable:
CONFLICTING`, and GitHub can additionally skip dispatching a `pull_request`
CI run for it entirely — reading exactly like a CI-infrastructure flake (a
self-hosted runner not picking up the job) and costing real diagnostic time
before anyone checks mergeability and finds a plain merge conflict
underneath. Catch it here instead:

```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo main)
git fetch origin "$DEFAULT_BRANCH"
BASE=$(git merge-base HEAD "origin/$DEFAULT_BRANCH")
git diff --name-only "$BASE" "origin/$DEFAULT_BRANCH"   # touched upstream since this branch's base
```

Intersect that list with the plan's declared scope — §7's File-Level Plan,
plus §7b/§11 `Files:` bullets when present (reuse the paths Step 5 already
read from the plan). An empty intersection: proceed silently, nothing to
report.

A non-empty intersection is worth a pause, not an automatic stop — name the
overlapping files and the upstream commit(s) that touched them, and let the
operator pick: rebase now (the squash-merge note below already prefers
`rebase` over `merge` on a `/ship`-created branch, for the same reason) or
push and resolve on GitHub. Either way, don't decide it silently — a
confusing CI investigation later costs more than one question now.

If a rebase or merge resolves real overlap, re-run the full test suite
before continuing to Step 6 — a clean 3-way merge with zero conflict markers
is not proof of correctness. git's own auto-merge can fold two independent
additions of the same import line and the same component mount into one
file with no conflict markers at all, producing a real duplicate-render bug
that only a type-check or test failure catches. This applies to any merge
touching files a `/cycle` run modified, not only the ones flagged with
visible conflicts.

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
git add scripts/lib/*.mjs tests/*.test.mjs   # your changed source files
git add status.md
git add CLAUDE.md AGENTS.md          # only if modified
git add docs/plans/*.md              # only if plan was updated
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

**Pass the message as a file or on stdin** (not `-m`, no shell interpolation).
**Prefer stdin** — `--message-file -` reads from stdin (a heredoc works,
leaves nothing behind; use `-`, not `/dev/stdin`, which Git-Bash resolves to
a non-regular file). The file route (Write tool →
`.claude/tmp/ship-commit-msg-<epoch>.txt`, then `--message-file <that
path>`, deleted once the commit lands) works too, but never your session
scratchpad dir — `--message-file` refuses any path outside `repoRoot`. Why
stdin is preferred: `references/commit-provenance-deep-dive.md`.

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

`passed` and `converged` clear the identical store bar and are mutually
exclusive halves of one comparison — asking for one on the wrong tree state
points at the other, and `--no-tests` always caps the verdict downward
(`waived` or `not-run`), never up. `passed` is rare **by design** (Steps 2-5
write status.md/CLAUDE.md between audit and commit, so even a clean audit
usually lands on `converged`) — do not hand-write evidence or reorder a ship
to chase it. `--no-run-id --gate not-run` disclaims a marker inherited from
an unrelated prior audit. Full rationale for each value, `--no-run-id`, and
the freshness rule: `references/commit-provenance-deep-dive.md`.

### 6.3 Commit and push

**The `/ship` command IS the user's approval.** Proceed directly — no
confirmation prompts.

**Both of these are now REQUIRED, and `ship-commit` refuses without them.**

```bash
# Capture the worktree identity ONCE, at the start of the ship (Step 0 if you
# ran one), and pass that exact pair to every ship-commit invocation in the run.
SHIP_HEAD=$(git rev-parse HEAD)
SHIP_BRANCH=$(git symbolic-ref --quiet --short HEAD)   # empty ⇒ detached
EPOCH=$(date +%s)
MODELS="claude-sonnet-5,gpt-5.6"   # the models that actually did the work this ship
GATE=not-run                     # passed | converged | waived | not-run — see AI-Gate above

node scripts/ship-commit.mjs --message-file ".claude/tmp/ship-commit-msg-$EPOCH.txt" --skill ship --models "$MODELS" --gate "$GATE" --expect-head "$SHIP_HEAD" --expect-branch "$SHIP_BRANCH" --path scripts/lib/*.mjs --path tests/*.test.mjs
git push origin "$SHIP_BRANCH"
```

Identity is a precondition, not a warning, because a concurrent session can
amend/rebase/checkout between your first command and your commit, and only a
sha+branch pair (not a content hash) catches it. **On a detached HEAD** pass
`--expect-detached` instead of `--expect-branch` — a head with no ref
disposition is `incomplete-expectation` → exit 2. You may omit both flags
only when a FRESH audit ran this session (the evidence marker supplies the
bundle); an older marker reports `pre-bundle-evidence` and needs them passed
explicitly. Full rationale: `references/commit-provenance-deep-dive.md`.

**Shared working tree — `--path` is MANDATORY, not conditional.** `ship-commit`
refuses an unscoped commit outright: it cannot know whose staged entries the
index holds, so it requires you to declare what you are shipping. There is no
override flag, deliberately — an unscoped commit is a TOCTOU by construction
(the index is checked at one moment and consumed by `git commit` at another),
and HEAD verification cannot cover it because index mutations do not move HEAD.
Add one `--path <file>` per file you
are shipping:

```bash
node scripts/ship-commit.mjs --message-file ".claude/tmp/ship-commit-msg-$EPOCH.txt" --skill ship --models "$MODELS" --gate "$GATE" --expect-head "$SHIP_HEAD" --expect-branch "$SHIP_BRANCH" --path scripts/foo.mjs --path tests/foo.test.mjs
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

**Continuing work in the same worktree after a squash merge: rebase, never
merge** — `git merge origin/<base>` reports a false conflict on an unchanged
file after a squash-merged PR (no shared parent), while `git rebase
origin/<base>` cleanly drops an already-landed SINGLE-commit PR's patch (a
multi-commit squash needs each commit resolved/`--skip`ped by hand — see
reference). A PR stuck at `mergeable: CONFLICTING` can also correlate with
zero CI runs firing — check mergeability before assuming the CI trigger is
broken. Why: `references/commit-provenance-deep-dive.md`.

---

## Step 6.5 — Security Memory Refresh + Capture Hint (after successful push)

If push succeeded AND `docs/security-strategy.md` exists in the repo,
run the refresher to keep the Supabase index in sync with markdown (only ever
publishes pushed state — R3-H3 design constraint). Surface the result line
briefly.

```bash
node scripts/security-memory/refresh-incidents.mjs
```

**Call the script by path, never `npm run security:refresh`** — that alias
exists in the source repo only (the sync never merges npm scripts into a
consumer's `package.json`); the refresher itself **is** synced
(`scripts/.claude-skills/security-memory/refresh-incidents.mjs`). Why:
`references/post-push-advisories.md` §6.5.

After refresh, regex-match the HEAD commit subject against
`/fix.*\bsecurity\b|\bcve\b|\bvuln\b|\bleak\b|\binjection\b|\bauth\b|\bxss\b|\bcsrf\b|\brce\b/i`
(word-boundary-anchored — the unanchored form false-flagged ~6% of commits in
a 200-commit sample). If matched, emit a single passive log line
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
> no hooks the session-review call returns whatever the store holds — usually
> empty. That is a correct empty, not a broken one: this step must not read an
> empty list as evidence that no friction existed. Why:
> `references/post-push-advisories.md` §6.6.

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

Closes the loop the shadow A/B could not measure — this step is the missing
caller of `final-review-adjudicate` / `final-review-record-fix`, both of
which existed and were tested for months with nothing calling them (why:
`references/post-push-advisories.md` §6.7).

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

**Walking the whole queue.** The card shows one page. The JSON form pages by a
**keyset cursor**, never an offset — the queue is drained by the very
adjudication that walks it, so an offset would skip one row per adjudication.
Loop on `nextCursor`, **not** on `shownCount`, and keep going through pages
whose `items` is empty (`pageFilteredOut` says how many raw rows were fetched
but not actionable); `nextCursor: null` is the end:

```bash
node scripts/cross-skill.mjs final-review-pending --repo owner/repo --page-size 50
```

```bash
node scripts/cross-skill.mjs final-review-pending --repo owner/repo --page-size 50 --after eyJ2IjoxLC4uLn0
```

`--page-size` is the alias of `--limit` (default 20, cap 200); `--offset` is
**not supported**, by design. `--group-by work-unit` (and `--work-unit <key>`,
`--no-llm-labels`) groups a page's actionable rows into refactor-sized units
through the same grouper `list-unlocked-fixes` and `list-unremediated-acceptances`
share.

**A ruling on EITHER axis is a label.** A finding's adjudication lives on two
columns: `adjudication_outcome` (the triage ruling — written automatically by
the audit loop's own deliberation) and `user_action` (the ship-time
disposition this step's `final-review-adjudicate` writes). `user_action` is a
**durable override**: once set to anything but `needs_triage` it wins
outright, so recording a ruling here is never undone by a later triage pass.
The card surfaces a `⚠ N finding(s) where the ship-time disposition and the
triage ruling disagree in direction` line (`axisConflicts`) when the two axes
point opposite ways — reconcile those by hand; everything else needs no
special handling.

**Re-running the final reviewer does not erase prior rulings** — a re-run
round or a consolidated union-diff gate upserts the new snapshot and prunes
only rows the snapshot dropped that carry no ruling and no recorded
remediation on either axis.

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
| the synced consumer bundle | **authoritative**: `node scripts/.claude-skills/lib/sync-isolation-verify.mjs`, run *in the consumer's MAIN checkout* — note the `lib/` segment, it is a module rather than a top-level script. A linked worktree cannot answer this, and since 2026-09-07 it SAYS so: `runGates` refuses a proven linked worktree at `preflight` with exit 2. The manifest records what the last sync wrote to the MAIN checkout's disk, and `skills:hydrate` populates a worktree by copying those same files — so a run there would re-read bytes hydrate just copied and report agreement it manufactured. Hydrate now carries the manifest as well as the tooling tree (upstream 5bc7ff30), so that refusal is explicit rather than the accident of a missing file. `npm run sync:dry` from here is the pre-check, not the verdict | zero unexpected diffs; no orphans |
| the skill manifest | re-derive from the pushed sha, not the working tree | regenerated bytes identical |

**Write the outcome with `pending-note write` (body on stdin) — never by
re-opening the status.md entry you just pushed** (status.md is append-only;
this step runs AFTER that entry's commit already landed, so re-opening it
means a second commit and a second push). Include in the file: the immutable
locator (full sha / digest / bundle version), the retrieval command actually
run, and the observed result. Write it with:

```bash
node scripts/lib/worktree-preflight.mjs pending-note write
```

It resolves the MAIN checkout (not the worktree you may be standing in —
`.claude/tmp/` resolves per-tree, so a hand-written path would land in the
wrong place; both reader and writer share one implementation of the durable
lookup), stamps the filename with the shipped sha and the time, and writes
there. The **next** `/ship` invocation's Step 2 drains every pending note,
prepends them as a `### Consumer Verification (previous ship)` subsection
above that session's own entry, then deletes exactly those (template:
`references/status-md-format.md`). If no further `/ship` happens, the notes
simply sit there unread — an acceptable loss for advisory documentation
(never a gate), not a reason to force a push now. Incident history behind
each of these rules: `references/post-push-advisories.md` §6.8.

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
| `references/architecture-and-dashboard-refresh.md` | Why the arch-map and dashboard pages are Category A, and deleted-step history for 0.5c/0.5d. | Debugging Step 0.5c/0.5d's staging behaviour, or before changing either. |
| `references/commit-provenance-deep-dive.md` | Step 6.2/6.3's AI-Gate and worktree-identity deep-dive — why each value/flag exists and the incidents behind them. | Debugging `--gate`/`--expect-head`/`--expect-branch` behaviour, or before changing one. |
| `references/input-acquisition.md` | Where a skill's arguments come from on any host, and what to do when there are none. | Reading $ARGUMENTS on a host that does not substitute it, or deciding what empty input means at a site. |
| `references/migration-credentials.md` | Which role applies migrations, why the runtime DSN cannot, and where its credential belongs (never in .env). | Step 0.5g — a store is behind and `--migrate` is refused with `42501` (`must be owner of table …` / `permission denied for schema public`). |
| `references/post-push-advisories.md` | Steps 6.5-6.8's post-push advisories — the incident history behind each rule, kept out of the routine flow. | Debugging Step 6.5/6.6/6.7/6.8's behaviour, or before changing one. |
| `references/pre-ship-gate-queries.md` | Step 0.5's pre-ship nudges (0.5a/b/e/g/h/i) — the incident history behind each rule, kept out of the routine flow. | Debugging a Step 0.5 nudge's behaviour, or before changing one. |
| `references/python-environment-discovery.md` | Python pre-push command discovery — env wrapper detection + per-tool probe order. | detect-stack returned `python` or `mixed` with Python files in the diff. |
| `references/status-md-format.md` | status.md session-log template + update rules + persona / UX status sections. | Step 2 — creating status.md for the first time, OR appending UX / Persona / Regression-Lock / Plan-Verify sections. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Step 6.8 — the push succeeded and the artifact must be verified from the consumer side. |
