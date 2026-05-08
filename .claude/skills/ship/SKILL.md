---
name: ship
description: |
  Sync all project documentation, optionally update a plan, then commit and push to git.
  Updates status.md (session log), syncs CLAUDE.md to AGENTS.md, and handles git workflow.
  Use when the user is ready to commit and push their work.
  Usage: /ship — sync docs + commit + push
  Usage: /ship docs/plans/feature.md — also update the plan before committing
  Triggers on: "ship it", "commit and push", "push my changes", "ready to ship".
  IMPORTANT: This command runs autonomously — no confirmation prompts. The user invoking
  /ship is their approval to update docs, commit, and push in one uninterrupted flow.
disable-model-invocation: true
---

# Ship: Sync Docs → Commit → Push

A single command that ensures all project documentation is current, then
commits and pushes. Follow every step in order.

**Arguments**: `$ARGUMENTS` — optional path to a plan file to update
(e.g., `docs/plans/feature.md`).

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

If `PERSONA_TEST_REPO_NAME` is set, query via cross-skill (service-role
required after the 20260507 RLS hardening — anon reads are now blocked):

```bash
node scripts/cross-skill.mjs get-persona-sessions-by-repo \
  --repo "$PERSONA_TEST_REPO_NAME" --limit 1 --p0-only \
  --select persona,focus,verdict,p0_count,p1_count,created_at,debrief_md
```

Returns `{ok: true, cloud: true|false, rows: [...]}`. When `cloud:false`,
no persona-test database is configured — proceed without the UX gate.

Capture `open_p0_count` + `open_p1_count` from the latest session (within
the last 14 days). These feed the ship_event record. If a session has P0s:

```
⚠ UX GATE (non-blocking)
  Last persona test: "<persona>" — <N> days ago → <verdict> (P0: <n>, P1: <n>)
  Unresolved P0s detected. These are user-visible broken flows.
  Shipping anyway — consider fixing before next user-facing release.
```

### 0.5b — Fixes that lack a /ux-lock regression spec

```bash
node scripts/cross-skill.mjs list-unlocked-fixes
```

Returns `{ok, cloud, rows: [...]}`. Count the rows as `missing_spec_count`.
If > 0:

```
⚠ REGRESSION LOCK GATE (non-blocking)
  <n> recent HIGH-severity fix(es) have no /ux-lock spec:
    • <primary_file>: <one-line detail>
  These will silently regress under future refactors.
  Consider: /ux-lock <commit-hash> for each.
```

### 0.5c — Override flags

If `$ARGUMENTS` contains `--no-tests`, `--ignore-p0`, or `--skip-ux-lock`,
record which override is active — it goes into the ship_event.

---

## Step 0.5c — Architectural Memory Refresh (advisory)

If the architectural memory is configured for this repo (per the
`docs/plans/architectural-memory.md` rollout), refresh the per-repo
symbol-index and regenerate `docs/architecture-map.md` so the committed
artefact stays current with what's about to ship.

```bash
# Determine since-commit (last shipped). Use upstream/origin HEAD as a proxy
# when no /ship event has been recorded yet.
LAST=$(git rev-parse "@{upstream}" 2>/dev/null || git rev-parse "HEAD~1")
node scripts/symbol-index/refresh.mjs --since-commit "$LAST" || true
node scripts/symbol-index/render-mermaid.mjs || true
# Stage the regenerated map if it changed (pure additive; never blocks ship)
git add docs/architecture-map.md 2>/dev/null || true
```

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

If `docs/architecture-map.md` has changed, it's staged and included in
the ship commit. The drift sticky-issue is only updated by the weekly
GH workflow, never by /ship directly.

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

## Step 4 — Sync AGENTS.md

AGENTS.md mirrors CLAUDE.md exactly. After any CLAUDE.md changes:

1. Read CLAUDE.md
2. Write identical content to AGENTS.md
3. Verify in sync

If CLAUDE.md wasn't modified in Step 3, check if AGENTS.md is already
identical. If so, skip. If drifted, re-sync.

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

## Step 5.5 — Archive Completed Plans (always, unless `--no-archive`)

After Step 5 may have flipped a plan's `Status` to `Complete`, sweep
`docs/plans/` and move any completed plans (plus their sibling
`*-audit-summary*.md` files left by `/audit-code` Step 6) into
`docs/completed/`.  Run this BEFORE Step 6 commit so the move is part
of the shipped commit — no dangling working-tree changes after `/ship`.

```bash
npm run plans:archive
```

Idempotent + silent when nothing matches.  Skip with `--no-archive`
flag to keep a `Complete`-status plan in `docs/plans/` (rare — usually a
v2 draft that shouldn't move yet).  Preview with
`npm run plans:archive:dry`.

If anything moves, include the renamed paths in the Step 6 stage list
(git tracks them as renames automatically).

---

## Step 6 — Stage, Commit, Push

### 6.1 Stage

Stage relevant files by name (be specific):

```bash
git add <list of changed source files>
git add status.md
git add CLAUDE.md AGENTS.md    # only if modified
git add docs/plans/<plan>.md   # only if plan was updated
```

**Do NOT stage**: `.env`, credentials, `node_modules/`, temp/generated files.

If untracked files look unintentional (temp, OS files), skip silently.
Include all source, docs, tests, and config.

### 6.2 Commit message

Follow project convention:

```
<type>: <concise description>

<optional body with WHY if significant>
```

Types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`.

Keep first line under 72 chars. Body explains WHY, not WHAT.

### 6.3 Commit and push

**The `/ship` command IS the user's approval.** Proceed directly — no
confirmation prompts:

```bash
git commit -m "<message>"
git push origin <current-branch>
```

If push fails (behind remote, etc.), inform the user and suggest the
fix. Do NOT force push.

---

## Step 6.5 — Security Memory Refresh + Capture Hint (after successful push)

If push succeeded AND `docs/security-strategy.md` exists in the repo,
run `npm run security:refresh` to keep the Supabase index in sync with
markdown (only ever publishes pushed state — R3-H3 design constraint).
Surface the result line briefly.

After refresh, regex-match the HEAD commit subject against
`/fix.*security|cve|vuln|leak|injection|auth|xss|csrf|rce/i`. If matched,
emit a single passive log line (NOT an interactive prompt — `/ship` is
`disable-model-invocation: true`):

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

## Step 8 — Archive Completed Plans

> **Note**: see Step 5.5 above — archive runs BEFORE commit so the
> rename is part of the shipped commit.



## Quick Reference

| Syntax | What happens |
|---|---|
| `/ship` | Update status.md → sync CLAUDE.md/AGENTS.md → commit → push |
| `/ship docs/plans/feature.md` | All of the above + update the plan file |

## Reminders

- **Always check git diff first** — understand what changed before documenting
- **status.md is a log** — append, never rewrite history
- **CLAUDE.md only changes when needed** — no cosmetic edits
- **AGENTS.md is a mirror** — always identical to CLAUDE.md
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
