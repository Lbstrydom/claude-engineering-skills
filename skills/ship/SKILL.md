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
allowed-tools: Bash(node scripts/cross-skill.mjs detect-stack --include-env-manager)
---

# Ship: Sync Docs → Commit → Push

> **This skill's last line is an end marker naming the skill between em-dashes, after
> the Reference files table.** If that last line is not in your context (context
> compaction keeps only the start of a skill), re-read
> `.claude/skills/ship/SKILL.md` in full before continuing — the later steps still apply.

> **Explicit invocation only — this is a host-neutral requirement, not just a
> frontmatter flag.** `disable-model-invocation: true` enforces it in Claude Code
> and VS Code Copilot; other hosts are not guaranteed to, so it is stated here too:
>
> **Do not start this skill because a message sounded like approval.** Start it
> only when the user asked, in their own words this turn, for their work to be
> committed and pushed. "Looks good, ship it" said about a plan, a diff or a
> design is assent to the *idea*, not an instruction to push — answer it by
> offering `/ship`, never by running it.
>
> Every step below skips confirmation because the user chose to run this; a
> self-invoked run would cite its own execution as consent.
> → `references/flow-rationale.md` §Explicit invocation — read when deciding
> whether a message is an invocation, or before changing this rule.

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
| `/ship --train [--waive n,…] [--allow-unaudited n,…] [--end-of-day]` | land a batch of ship-ready PRs in one action (see **Train mode**) |

The three override flags are honoured only when the **user** passes them; see
Step 0.5f's override handling. Never add one on the skill's own initiative to get
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
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. If this repo defines
> no such script, `references/worktree-preflight.md` holds the entry to add — ask
> the user first, since it edits their `package.json`.

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

**Source repo, before the full push check:** `npm run guards:preflight` (about 1-2 min) runs the whole-suite guard tests and static checks that a targeted test run cannot reach, as the real checks and not copies. It is an early look, and the pre-push run still covers everything; a result marked INCOMPLETE is not a pass. Rationale: the source repo's test-cost runbook, section 0.

Python framework (if detected) shapes status.md section titles — see
`references/status-md-format.md`.

---

## Step 0.5 — Pre-Ship Gate Queries (non-blocking by default)

Collect signals before proceeding so the ship_event emitted at the end
is accurate. Best-effort — if a query fails, log and proceed. Sub-step order:
`0.5a → 0.5b → 0.5e → 0.5g → 0.5h → 0.5i → 0.5f`, then the H2 Steps 0.5c and 0.5d.
Incident history behind every rule below: `references/pre-ship-gate-queries.md`
— read when debugging a nudge's behaviour, or before changing one.

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

**Watch `agedOut` — it should be 0**: non-zero means obligations expired from the
14-day window while a locking practice was live (a real leak). `prePractice`
expired before this repo's first lock (`practiceStart`) — not an obligation. Read
past the window with `--all-ages`; `total`/`byMode` then describe the unwindowed
set:

```bash
node scripts/cross-skill.mjs list-unlocked-fixes --all-ages
```

**Never hand-derive a repo id** — pass no flag (ambient identity) or
`--repo <owner/repo>`; `--repo-id` is verified against `audit_repos`, and an
unresolvable one reports `measured:false` rather than an authoritative empty
backlog.

**Use `byMode.code` as `missing_spec_count` — NOT `rows.length`.** `rows` is
capped at 20, and `byMode.plan` rows are section references for which **no lock
of any kind can ever exist**.

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
  UI/DOM-facing fix → /ux-lock; on React surfaces prefer a unit test unless
  the contract genuinely needs a live DOM.
```

(The React caveat's history → `references/flow-rationale.md` §0.5b — read when
deciding whether /ux-lock fits a React surface.)

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

**Two bounds, and only one of them forgets**: `notYetDue` (under the 7-day
floor) is in flight — **never add it to `agedOut`, never report it as a
backlog**; mention it only if `total` is 0 and `notYetDue` is not. `agedOut`
(over the 30-day ceiling, after `practiceStart`) is a real leak. `prePractice`
is not an obligation. `--all-ages` drops both bounds; `total`/`byMode` then
describe the unwindowed set:

```bash
node scripts/cross-skill.mjs list-unremediated-acceptances --all-ages
```

**Use `byMode.total` as `unremediated_count` — NEVER `rows.length`** (capped
at 20). `byMode.plan` rows depend on the plan's status:
- **Plan still in flight** → real work; treat it as an obligation.
- **Plan marked Complete** → write the class off: record it as `dismissed`
  (the store has no "written off" state) with the real reasoning in
  `status.md`. A write-off covers the *document* obligation only.

`accepted` is not evidence of a fix, and a row can also be already fixed with
nobody having written it down. Treat each row as a
hypothesis about current code, verify it, then close it in the right
direction (`--state fixed` or a dismissal) rather than assuming either.

If `> 0`, print — never blocks, no override flag. **Show the first 5 rows as
returned** (HIGH first, then oldest first — do not re-sort). To read past the
default 20-row page, pass the payload's `nextCursor` back as `--after` (a keyset
cursor — never `--offset`); `nextCursor: null` is the end
(→ `references/flow-rationale.md` §0.5e — read when paging while closing rows):

```bash
node scripts/cross-skill.mjs list-unremediated-acceptances --limit 20 --after eyJ2IjoxLCJraW5kIjoidW5yZW1lZGlhdGVkIiwic2V2ZXJpdHlSYW5rIjowLCJhY2NlcHRlZEF0IjoiMjAyNi0wOS0xMyAxMDowMDowMC4wMDAwMDErMDAiLCJmaW5kaW5nSWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEifQ
```

The payload echoes the resolved `limit` (store clamps to 200), so a short page
can be told from an exhausted one. `list-unlocked-fixes` pages the same way.

```
⚠ UNREMEDIATED ACCEPTANCES (non-blocking)
  <byDisposition.open> open · <byDisposition.acceptedPermanent> permanently accepted
  <n> finding(s) you accepted were never marked fixed (showing <=5):
    • [<severity>] <primary_file> — accepted <days_open>d ago
  Either remediate them, or close the loop honestly — per row:
    node scripts/cross-skill.mjs close-finding --finding <audit_finding_id> \
      --as fixed --commit <sha that fixed it>
    (or --as dismissed / --as accepted-permanent, each with --reason "...")
  Leaving them open is fine — leaving them open SILENTLY is what this catches.
```

**`byDisposition.acceptedPermanent` is a decision, not a backlog — print it,
do not chase it.** Those rows are excluded from `open`/`total`; `open === total`
always.

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
  Then remediate, or close the loop with close-finding, or write them off
  (close-finding --as dismissed, reasoning in status.md) — an obligation
  discharged by silence is what this counts.
```

**Close rows with `close-finding`, by the row's `audit_finding_id`** — not
`finalize-outcomes` (it needs a live round's `--ledger`/`--result`) and not
`final-review-record-fix`, which only resolves final-review-pass rows and so
answers `no-match` for an ordinary audit finding. `--as fixed` takes `--commit`;
`--as dismissed` (not a defect, or
a written-off plan section) and `--as accepted-permanent` (real, declined on
the merits) take `--reason`. A finding outside this repo is refused.

Judge the list before echoing it: an `audit_mode = 'plan'` row's `primary_file`
is a plan SECTION reference, not a file — say so rather than printing it as a
code path; a `remediation_state = 'planned'` row with a live plan is in flight —
drop it from the printed list.

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

**The runtime DSN usually cannot apply migrations** — do NOT grant the runtime
role ownership or put an admin DSN in `.env`. → `references/migration-credentials.md`
— read when `--migrate` is refused with `42501`.

### 0.5h — Upstream issue queue (advisory, source-repo only)

**Source-repo-gated** — run ONLY when `package.json.name === "claude-engineering-skills"`.
Consumers FILE reports (`cross-skill.mjs upstream report`); this repo is where
they get triaged, and nothing else prompts anyone to read them.

```bash
npm run upstream:queues 2>/dev/null
```

Print its stdout verbatim — it renders the finished card, reading **every
registered consumer's own store** (fingerprint plus consumer names, never a DSN
or hostname).

**Never blocks, and there is no override flag** — the queue is cloud state,
not repo state; it always exits 0. **Read the `unqueried` / `no store` lines,
and do not treat the count as complete when either is present** —
`NOTHING WAS CHECKED` means an unasked question, not a clean queue.

Triaging a report is a separate act from shipping: run `ack|fix|wont-fix` only
against **the store that owns the row**, by the **FULL uuid**, after checking
`freshness`/`priorFixes` → `references/upstream-triage.md` — read before closing
any report. Incident history: `references/pre-ship-gate-queries.md` §0.5h.

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
stalled). Prints its own card; pass it through verbatim. Do **not** collect now
because of it — collection is spend-bearing and revision-pinned, a deliberate
scheduled act (`references/pre-ship-gate-queries.md` §0.5i).

### 0.5f — Override flags

If `$ARGUMENTS` contains `--no-tests`, `--ignore-p0`, or `--skip-ux-lock`,

<!-- host-contract: input-acquisition; grammar=path+flags; empty=default -->
_This site: `path+flags` — **no flag means no override.** Each of these disables a gate, so they are read ONLY from the invocation — a conversation that merely mentions skipping tests must never become one._

record which override is active — it goes into the ship_event.

(Why this is `0.5f`, not `0.5d`: `references/flow-rationale.md` §0.5f — read
before renumbering any Step 0.5 sub-step.)

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

**Nothing from this step is ever staged** (`docs/architecture-map.md` is Category A),
and it **never blocks a ship**: every failure mode skips under `|| true`. →
`references/architecture-and-dashboard-refresh.md` §0.5c — read when debugging it.

---

## Step 0.5d — Regenerate the Local Dashboard (advisory, source-repo only)

**Source-repo-gated** — run this ONLY when
`package.json.name === "claude-engineering-skills"` (same gate as Step 6.0).
Skip silently in consumer repos (→ `references/architecture-and-dashboard-refresh.md`
§0.5d — read when a consumer asks to build its dashboard). Never blocks the ship.

```bash
node scripts/build-dashboard.mjs reference 2>&1
```

Run it WITHOUT `|| true` — read the exit code, never mask it. It regenerates the
gitignored (Category A, never staged) `dashboard/index.html` + `telemetry.html`;
non-zero means a degraded build → print a one-line heads-up and continue.

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

## Step 1.5 — Close-out claims check (write-ups and status reports)

When the change carries a write-up or status report — `docs/research/**`, a results
doc, a `status.md` entry, a plan's status or audit trail with figures — every figure
must trace to an artifact and carry `measured` / `derived` / `expected` with its
command; every line citation is pinned (`node scripts/check-doc-citations.mjs <doc>`).
An untraceable figure is fixed, or settled with `/investigate`, before the commit.
Procedure: `references/claims-check.md`; repeat it over the status.md entry and plan
update Steps 2 and 5 write. No write-up in the change → skip, and say so.

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
everything it happens to find. (Where the notes live and why:
`references/flow-rationale.md` §Step 2 — read when a note seems missing.)

Write the session log entry. **If `docs/status/entries/README.md` exists, the
entry is a NEW file there** (`<YYYY-MM-DD>-<HHMMSS>-<slug>.md`, UTC; `status.md`
takes no new entry). Otherwise add it at the TOP of `status.md` (create the
standard header if absent), newest first. Template, rules and optional sections
(UX, Persona, Regression Lock, Plan Verify, Consumer Verification):
`references/status-md-format.md`.

### Step 2b — Backlog snapshot line (one command, advisory)

Include a **`Backlog:`** line in the entry, so the standing queues are trended
in the log instead of being rediscovered every few weeks:

```bash
node scripts/backlog-snapshot.mjs
```

Paste its single stdout line into the entry. It reads every queue itself, at one
instant, read-only, and **writes nothing** — you insert the line as part of the
entry you are already authoring. Never let a script write `status.md`.

A queue it could not read renders **`unmeasured`**, never `0`. The command always
exits 0; it is a nudge, never a gate. (Incident: `references/flow-rationale.md`
§Step 2b.)

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
  and destroy the canonical file.
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

**There is no archive step** — a completed plan stays in `docs/plans/` and
carries `Status: Complete`; never move it. → `references/flow-rationale.md`
§Step 5.5 — read before reintroducing any plan move.

---

## Step 5.8 — Pre-push staleness check (shared-repo overlap)

Skip when the current branch is the repo's default branch (this bundle's own
main-only convention — nothing to compare against) or when Step 5 found no
plan path in `$ARGUMENTS` (no plan means no declared file scope to diff
against).

A different PR may have merged to the default branch first, touching files this
run also touched — which surfaces later as `mergeable: CONFLICTING` and can read
like a CI flake. Catch it here (→ `references/flow-rationale.md` §Step 5.8 —
read when a PR shows CONFLICTING or no CI run):

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
is not proof of correctness.

---

## Step 6 — Stage, Commit, Push

### 6.0 Sync manifest — no action (source repo)

**Do not `git add` `scripts/.sync-manifest.json` in the source repo** — it is
gitignored Category A (timestamp + HEAD sha). Consumers track their **own**
manifest. → `references/flow-rationale.md` §Step 6.0 — read when the manifest
shows up as a change.

### 6.1 Stage

Stage relevant files by name (be specific):

```bash
git add scripts/lib/*.mjs tests/*.test.mjs   # your changed source files
git add status.md                    # or the new docs/status/entries/<file>.md
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
MODELS="claude-opus-5-5,gpt-6.1-terra"   # the models that actually did the work this ship
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
override flag, deliberately. Add one `--path <file>` per file you
are shipping:

```bash
node scripts/ship-commit.mjs --message-file ".claude/tmp/ship-commit-msg-$EPOCH.txt" --skill ship --models "$MODELS" --gate "$GATE" --expect-head "$SHIP_HEAD" --expect-branch "$SHIP_BRANCH" --path scripts/foo.mjs --path tests/foo.test.mjs
```

This commits those paths' worktree contents and leaves every other index
entry staged and untouched. Untracked paths are handled (marked
intent-to-add, rolled back if the run is rejected). Do **not** fall back to a
bare `git commit -- <paths>` — it scopes correctly but drops the `AI-*`
provenance trailers, which is exactly what this helper exists to prevent.

**A directory is refused, not expanded** — pass each file, including for a
deleted directory. (Why, and the TOCTOU reasoning behind `--path`:
`references/commit-provenance-deep-dive.md` §Step 6.3 scoping detail — read
when a `--path` refusal surprises you.)

**On `post-commit-drift`** (the new commit's parent or branch is not the one `ship-commit` verified) it exits 1 with a recovery command: **do not push.**

Exit contract: `0` = committed (trailers appended). `2` = input rejected —
fix exactly what the `AGENT FIX:` stderr lines say and re-invoke (max 2
retries, then report). `1` = operational failure — report it; do not
loop. **Fallback (stale consumer sync only)**: if the helper script does
not exist on disk, fall back to `git commit -F <message-file>` and print
one line: `provenance trailers skipped (helper unavailable — re-run npm
run sync)`.

If push fails (behind remote, etc.), inform the user and suggest the
fix. Do NOT force push.

**CI on the pushed head**: `node scripts/ci-merge.mjs --pr <n> --wait-only` reports every check; add `--merge` only when the user said to merge (`references/ci-merge.md`).

**Continuing work in the same worktree after a squash merge: rebase, never
merge** — check mergeability before assuming a CI trigger is broken. Why, and
the multi-commit caveat: `references/commit-provenance-deep-dive.md` §Continuing
work after a squash merge.

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
(word-boundary-anchored on purpose). If matched, emit a single passive log line
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
> On a host with no hooks the session-review call is usually empty — a correct
> empty, never evidence that no friction existed. Why:
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

The missing caller of `final-review-adjudicate` / `final-review-record-fix`
(why: `references/post-push-advisories.md` §6.7).

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

**Walking the whole queue** (JSON form) pages by a **keyset cursor** on
`nextCursor`, never an offset → `references/post-push-advisories.md` §6.7 — read
when you need more than the card's one page.

**A ruling on EITHER axis is a label** — `adjudication_outcome` (triage) or
`user_action` (this step's durable override). When the card prints a
`⚠ N finding(s) where the ship-time disposition and the triage ruling disagree
in direction` line (`axisConflicts`), reconcile those by hand; everything else
needs no special handling. Re-running the final reviewer does not erase prior
rulings (`references/post-push-advisories.md` §6.7).

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

**A feature-branch push publishes nothing to consumers** (since 2026-10-10 the
pre-push hook syncs only when the default branch is updated, so unmerged tooling
never reaches them). For a branch/PR ship, the synced-bundle row is `unverified
(blocked: not merged)` until the PR merges and the source repo re-syncs its
consumers from an up-to-date default branch.

Pick the row(s) this push actually produced:

| Artifact | Consumer-side retrieval | Subject check |
|---|---|---|
| the pushed commit | `git fetch`, then `git worktree add --detach "$VERIFY_DIR" "$PUSHED_SHA"`; in it, a frozen clean install (`npm ci`, or the repo's own package manager's equivalent), then `skills:hydrate` (the Worktree preflight above — it copies the gitignored tooling tree in, as the pre-push run had it), then **exactly the command the pre-push hook runs**. Do not inject the main checkout's `.env` into the test process (e.g. `NODE_OPTIONS="-r dotenv/config"`): children spawned with a cwd outside the tree inherit the preload and die on `MODULE_NOT_FOUND`. A bare `git clone` is valid only when no test reads the tooling tree — otherwise tests that need it skip, and the run reads green having run less. Remove the worktree afterwards | green **in the worktree**, with **both the passed and the skipped count equal to the pre-push run's** — a different skip count is a different suite, not a confirmation. Catches tracked-vs-ignored and case-only path faults invisible locally |
| the synced consumer bundle | **authoritative**: `node scripts/.claude-skills/lib/sync-isolation-verify.mjs`, run *in the consumer's MAIN checkout* — note the `lib/` segment, it is a module rather than a top-level script. A linked worktree cannot answer this (`runGates` refuses one at `preflight` with exit 2 — why: `references/flow-rationale.md` §Step 6.8). `npm run sync:dry` from here is the pre-check, not the verdict | zero unexpected diffs; no orphans |
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

It resolves the MAIN checkout itself (never hand-write the path) and stamps the
filename with the shipped sha and the time; the **next** `/ship`'s Step 2 drains
it. If no further `/ship` happens, the notes simply sit there unread — an
acceptable loss for advisory documentation (never a gate), not a reason to force
a push now. Incident history behind each of these rules:
`references/post-push-advisories.md` §6.8.

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

**Close-out** (read-only): `references/post-push-advisories.md` §Close-out.

---

## Train mode (`/ship --train`)

**Source-repo-gated** (`package.json.name === "claude-engineering-skills"`); consumers skip this (no sync closure to classify
against, no sync tools to publish with). One human invocation lands several already-audited, `fleet ready` PRs: one status entry,
per-PR provenance in each squash commit, one combined test run, one consumer sync. **Human-only, like the rest of this skill** — `--train` does not relax the
explicit-invocation rule above. Its three flags are read only from this invocation. Runbook,
refusals, overrides, recovery: `references/train-mode.md` (read it before running any verb of
`node scripts/ship-train.mjs plan | message | land | verify | sync`).

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/architecture-and-dashboard-refresh.md` | Why the arch-map and dashboard pages are Category A, 0.5c's failure-mode matrix, and 0.5c/0.5d history. | Debugging Step 0.5c/0.5d (staging, a refresh that did not run), or a consumer asks to build its dashboard. |
| `references/commit-provenance-deep-dive.md` | Step 6.2/6.3's AI-Gate and worktree-identity deep-dive — why each value/flag exists and the incidents behind them. | Debugging `--gate`/`--expect-head`/`--expect-branch`/`--path` behaviour, or before changing one. |
| `references/flow-rationale.md` | Why /ship's own flow is shaped as it is — the explicit-invocation bar, numbering, and Steps 0.5b-6.8 rationale. | A step's one-liner points here, or before changing that step's rule or its numbering. |
| `references/input-acquisition.md` | Where a skill's arguments come from on any host, and what to do when there are none. | Reading $ARGUMENTS on a host that does not substitute it, or deciding what empty input means at a site. |
| `references/migration-credentials.md` | Which role applies migrations, why the runtime DSN cannot, and where its credential belongs (never in .env). | Step 0.5g — a store is behind and `--migrate` is refused with `42501` (`must be owner of table …` / `permission denied for schema public`). |
| `references/post-push-advisories.md` | Steps 6.5-6.8's post-push advisories and the Step 7 close-out - incident history, kept out of the routine flow. | Debugging Step 6.5-6.8's behaviour, changing one, walking Step 6.7's whole queue, or writing the close-out. |
| `references/pre-ship-gate-queries.md` | Step 0.5's pre-ship nudges (0.5a/b/e/g/h/i) — the incident history behind each rule, kept out of the routine flow. | Debugging a Step 0.5 nudge's behaviour, or before changing one. |
| `references/python-environment-discovery.md` | Python pre-push command discovery — env wrapper detection + per-tool probe order. | detect-stack returned `python` or `mixed` with Python files in the diff. |
| `references/status-md-format.md` | status.md session-log template + update rules + persona / UX status sections. | Step 2 — creating status.md for the first time, OR appending UX / Persona / Regression-Lock / Plan-Verify sections. |
| `references/train-mode.md` | /ship --train runbook — plan, land, verify, sync a batch of ship-ready PRs; refusals, overrides, recovery. | `/ship --train` was invoked, or the user asked to land several ready PRs together. |
| `references/upstream-triage.md` | Step 0.5h — triaging a consumer's upstream report: the owning store, the FULL uuid, and the freshness check. | Step 0.5h's card lists a report you are about to `ack`, `fix` or `wont-fix`. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Step 6.8 — the push succeeded and the artifact must be verified from the consumer side. |
| `references/ci-merge.md` | ci-merge.mjs - wait on every check of the pushed head, refuse red or UNSTABLE, update BEHIND, squash-merge. | A push opened or updated a PR: waiting on CI, or merging. |
| `references/claims-check.md` | Step 1.5 claims check — every figure in a write-up traces to an artifact and carries its provenance label. | Step 1.5 — the change carries a write-up, results doc or status report. |
| `references/worktree-preflight.md` | Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree. | A command dies with `MODULE_NOT_FOUND` in a linked worktree AND this repo has no `skills:hydrate` script. |

— end of /ship —
