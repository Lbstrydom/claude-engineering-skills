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
  Usage: /ship --no-promote           — keep consistency candidates pending; don't materialise locks this ship
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

Returns `{ok, cloud, rows, shown, total, byMode:{total,code,plan}}`.

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

Returns `{ok, cloud, rows: [...]}`. Count the rows as `unremediated_count`.

One step EARLIER in the lifecycle than 0.5b: `unlocked_fixes` asks *"this was
fixed — is the fix locked?"*; this asks *"this was accepted — was it ever
fixed at all?"*. The `unremediated_acceptances` view lists HIGH/MEDIUM findings
whose `adjudication_outcome` is `accepted`/`severity_adjusted` but whose
`remediation_state` is still NULL/`pending`/`planned` after 7+ days.

**Why this exists**: measured 2026-07-27 on the 10 accepted final-review-shadow
findings in this repo, only 3 had a confirmed targeted code fix. One — the bare
`catch { result = null; }` in `stage0-relevance-context.mjs` — was accepted,
shipped, and is still in the code today. **`accepted` is not evidence of a
fix.** The audit loop is already designed to re-raise these (`suppressReRaises`
suppresses only `dismissed` or `fixed`/`verified`), so an unremediated
acceptance is an open obligation, not a closed one.

If > 0, print — **never blocks, and there is no override flag for it** (nudge,
not gate; the same philosophy as quick-fix detection). **Show at most 5 rows**,
HIGH first; the reader is capped at 20 and the point is the signal, not the
backlog:

```
⚠ UNREMEDIATED ACCEPTANCES (non-blocking)
  <n> finding(s) you accepted were never marked fixed (showing <=5):
    • [<severity>] <primary_file> — accepted <days_open>d ago
  Either remediate them, or close the loop honestly:
    node scripts/cross-skill.mjs finalize-outcomes    # transition to fixed/verified
  Leaving them open is fine — leaving them open SILENTLY is what this catches.
```

Judge the list before echoing it — two rows look identical but are not:

- `audit_mode = 'code'` → `primary_file` is a real path; the defect is in the
  code right now.
- `audit_mode = 'plan'` → `primary_file` is a plan SECTION reference (e.g.
  `§7 ws-a migration; close-out`), not a file. Equally a real obligation (the
  plan was never amended), but say so rather than printing it as a code path.
- `remediation_state = 'planned'` with a live plan is genuinely in-flight, not
  forgotten — drop it from the printed list.

### 0.5f — Override flags

If `$ARGUMENTS` contains `--no-tests`, `--ignore-p0`, or `--skip-ux-lock`,
record which override is active — it goes into the ship_event.

> **Numbering note**: this sub-step is `0.5f`, not `0.5d`, because two H2
> sections below already claim `Step 0.5c` and `Step 0.5d` (a pre-existing
> collision referenced from ~20 other files, so renumbering them is out of
> scope here). The H3 sub-step order is `0.5a → 0.5b → 0.5e → 0.5f`.

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

## Step 5.6 — Promote Consistency Candidates (when present)

If `.persona-test/canaries/` exists in this repo (consistency mode is
adopted), check for pending `regression_specs` rows in the
`persona-consistency-candidate` source_kind. These are evidence
snapshots that `/persona-test --mode consistency` captured during prior
runs; `/ship` is the boundary where the user decides whether to
materialise them as enforceable Playwright specs.

```bash
# Reconcile any incomplete promotions left by a prior crash; this is
# safe to run unconditionally (no-op when the journal is empty).
node scripts/persona-consistency-promote.mjs --auto=false
```

Skip silently if:
- `.persona-test/canaries/` does NOT exist (consistency mode is opt-in)
- the audit-store is offline (no candidates to promote)
- the resolved repoId is null (run `cross-skill.mjs resolve-repo-identity --persist` first)

When candidates ARE pending, the script prints them and prompts y/N per
row. Approve → it renders the deterministic Playwright spec via
`renderCandidateSpec`, atomic-writes to `tests/e2e/<filename>.spec.js`,
flips the DB row to `persona-consistency-locked`, and records one
`ship_event` per promotion. The two-phase journal at
`.persona-test/promotion-journal/<specId>.json` lets a crash mid-flight
be reconciled on next invocation — never a stranded file or DB row.

Output appears inline in `/ship`'s stdout. Failures do NOT block the
ship (a candidate that fails to materialise stays as a candidate; the
operator can retry later). Promoted spec files become part of the same
commit Step 6 builds.

**Skip with `--no-promote`** (rare — when you want to defer promotion
until a follow-up PR; the candidates remain in the queue).

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

**Write the message to a file** (never `-m`, never shell interpolation):
use the Write tool → `.claude/tmp/ship-commit-msg-<epoch>.txt`. Do NOT
include any `AI-*` lines — the helper is their only writer and rejects
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
confirmation prompts:

```bash
node scripts/ship-commit.mjs \
  --message-file .claude/tmp/ship-commit-msg-<epoch>.txt \
  --skill ship --models <csv> --gate <value>
git push origin <current-branch>
```

**Shared working tree — use `--path`.** If `git status` shows staged changes
that are NOT yours (another agent or a parallel session working in the same
checkout), do NOT commit the index: that bundles their in-flight work into
your commit and corrupts blame for both. Add one `--path <file>` per file you
are shipping:

```bash
node scripts/ship-commit.mjs \
  --message-file .claude/tmp/ship-commit-msg-<epoch>.txt \
  --skill ship --models <csv> --gate <value> \
  --path scripts/foo.mjs --path tests/foo.test.mjs
```

This commits those paths' worktree contents and leaves every other index
entry staged and untouched. Untracked paths are handled (marked
intent-to-add, rolled back if the run is rejected). Do **not** fall back to a
bare `git commit -- <paths>` — it scopes correctly but drops the `AI-*`
provenance trailers, which is exactly what this helper exists to prevent.

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
