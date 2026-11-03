---
name: persona-test
description: |
  Persona-driven exploratory browser testing against a live URL.
  Drives a browser as a specific user persona using a Plan → Act → Reflect loop,
  takes screenshots at each step, analyses UX and functional issues with
  confidence scoring, and returns a structured P0–P3 severity report plus a
  qualitative persona debrief. Personas are tracked per app URL; pair mode
  runs two opposed personas back-to-back; consistency mode runs a
  deterministic code-driven canary. Use for exploratory QA against deployed
  apps — not scripted regression tests. Invoke on the request's shape; don't
  check for browser tools first and decline — the skill resolves its own
  driver (Playwright MCP, host tools, BrightData, or read-only) once invoked.
  Triggers on: "persona test", "test as", "explore the app as", "run persona
  test", "test the site as", "browse the app as", "QA as", "list personas",
  "add persona", "who are my personas", "which persona should test".
  Full command syntax: see the Usage section in this skill.
---

> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. If this repo defines
> no such script, `references/worktree-preflight.md` holds the entry to add — ask
> the user first, since it edits their `package.json`.

## Usage

```
Usage:
  /persona-test list [url]                                                       — show all personas for an app
  /persona-test add "<name>" "<description>" <url> [app name]                    — register a new persona
  /persona-test "<persona or name>" <url> [focus] [--device <preset>]            — run an exploratory test (device auto-resolved from persona description)
  /persona-test --pair "<p1>" "<p2>" <url> [focus] [--device <preset>]           — pair mode (--device overrides both personas)
  /persona-test --mode consistency --canary <name> <url>                         — deterministic consistency canary (code-driven Playwright)
Device presets: desktop (default fallback) | desktop-large | tablet | mobile | mobile-small
Examples:
  /persona-test list https://myapp.railway.app
  /persona-test add "Pieter" "wine enthusiast, 40s, drinks daily, mobile-first" https://myapp.railway.app "Wine Cellar App"
  /persona-test "Pieter" https://myapp.railway.app "adding a bottle"
  /persona-test "first-time user on mobile" https://myapp.railway.app
  /persona-test "Pieter" https://myapp.railway.app --device mobile-small      — override resolved device
  /persona-test --pair "Elena (sommelier)" "Martha (newer drinker)" https://myapp.railway.app "browsing the cellar"
  /persona-test --mode consistency --canary oliver-infeasible-reorg http://localhost:3000
```

# Persona-Driven Browser Testing

> **This skill's last line is an end marker naming the skill between em-dashes, after
> the Reference files table.** If that last line is not in your context (context
> compaction keeps only the start of a skill), re-read
> `.claude/skills/persona-test/SKILL.md` in full before continuing — the later steps still apply.

Run an exploratory browser test with persona tracking. Check `$ARGUMENTS`
first to pick the sub-command.

<!-- host-contract: input-acquisition; grammar=subcommand; empty=ask-and-stop -->

**Where `$ARGUMENTS` comes from** — orchestrator-supplied input first, else
the host's verbatim invocation suffix, else the span of the user's **current**
message naming this skill or its subject. Never inferred from surrounding
conversation. This site is `subcommand`; on empty input, print usage and stop — a persona and a URL are both required, and there is no safe default target to browse.
Full contract: `references/input-acquisition.md`.


---

## Phase 0 — Route the Command

Read the first word of `$ARGUMENTS`:

<!-- host-contract: input-acquisition; grammar=subcommand; empty=ask-and-stop -->
_This site: `subcommand` — no first word means no sub-command; fall through to the test-argument parse, which stops with usage if a persona or URL is missing._


- `list` → **Sub-command: LIST**
- `add` → **Sub-command: ADD**
- contains `--mode consistency` anywhere → **Phase 3b: Consistency Mode** (deterministic canary run; skips Phases 0b–3a entirely — it needs only `--canary <name>` + URL, no persona resolution)
- contains `--pair` anywhere → **Sub-command: PAIR** (see Phase 7 at the end)
- otherwise → **Phase 0b: Parse Test Arguments** (normal test run)

---

## Sub-command: LIST

**Usage**: `list [url]`

Resolve the URL in order: positional argument → `PERSONA_TEST_APP_URL` env →
ask the user.

**Validate the URL before it reaches a shell.** It is user- or env-derived, and
double quotes do **not** neutralise `$(…)` or backticks — the same defect class
as the ADD payload below. Parse it with `new URL(value)` and reject it outright
if the parse fails or the string contains any of `` $ ` ; | & < > ( ) `` or a
newline. Only a value that survived that check is substituted below:

```bash
node scripts/cross-skill.mjs list-personas --url "<validated url>"
```

Response `{"ok": true, "cloud": true|false, "rows": [/* persona_dashboard rows */]}`
(graceful no-op when cloud is off). Render a `PERSONA ROSTER — <app_name or url>`
table (NAME · LAST TESTED · VERDICT · SESSIONS) sorted **never-tested first,
then oldest last-tested**, then one `SUGGESTION:` line naming who to run next.

STOP — do not proceed to the test phases.

---

## Sub-command: ADD

**Usage**: `add "<name>" "<description>" <url> [app name]`

Parse from `$ARGUMENTS` after `add`:

<!-- host-contract: input-acquisition; grammar=subcommand; empty=ask-and-stop -->
_This site: `subcommand` — name, description and url are required; a missing one prints usage and stops rather than registering a partial persona._

1. **name** — first quoted string
2. **description** — second quoted string
3. **url** — URL following the quoted strings
4. **app_name** — everything after the URL (optional)

If name, description, or url is missing, output usage and STOP.

Upsert (idempotent on `name + app_url`). **Write the payload to a file with the
editor, then pass the file — never interpolate the user's strings into a
single-quoted shell argument:**

```bash
# 1. Write .audit/add-persona.json with the Write tool (NOT a shell heredoc):
#    {"name":"…","description":"…","appUrl":"…","appName":null}
# 2. Pipe it on stdin — a pipe passes bytes, never shell-parsed text, and
#    (unlike `<` redirection, which PowerShell does not support) `cat | …`
#    parses the same way in bash and PowerShell (`cat` is a built-in
#    PowerShell alias for `Get-Content`):
cat .audit/add-persona.json | node scripts/cross-skill.mjs add-persona --stdin
```

Do not substitute `--name`/`--description`/`--url` flags — they put the free
text back on the command line. → `references/shell-safe-payloads.md` §ADD — read
when asked why a file, or tempted to inline the strings.

Response `{"ok": true, "cloud": ..., "personaId": ..., "existed": bool}`.
Report success with `personaId`. STOP.

---

## Phase 0b — Parse Test Arguments (normal test run)

Parse `$ARGUMENTS`:

<!-- host-contract: input-acquisition; grammar=subcommand; empty=ask-and-stop -->
_This site: `subcommand` — persona and url are required; never substitute a previously-tested URL from earlier in the conversation._

1. **persona_input** — first quoted string or first unparsed token
2. **url** — URL in the remaining args (or `PERSONA_TEST_APP_URL` env)
3. **focus** — any remaining text after the URL (strip out flag tokens before assigning)
4. **device_override** — value of `--device <preset>` if present (must be one of:
   `desktop`, `desktop-large`, `tablet`, `mobile`, `mobile-small`). Unknown
   preset → fail with usage. Drives Phase 1a's explicit-override branch.

Required: `persona_input` + `url`. If either is missing, output usage and STOP.

### Pre-flight environment check

| Env var | Purpose |
|---|---|
| `AUDIT_DB_URL` | Cloud store on — saves sessions, reads history, and (with a repo name) cross-references audit findings. One Postgres store backs every feature post-M4. |
| `PERSONA_TEST_REPO_NAME` | Enables audit-loop cross-reference (`audit_link = true`) |

Do not read `AUDIT_DB_URL` from the session's `process.env` — the consumer's
`.env` is not loaded there, so it reads unset and the run silently goes
stateless. Probe through the CLI, from the consumer-repo root:

```bash
node scripts/cross-skill.mjs whoami
```

→ `references/run-loop-detail.md` §Pre-flight — read when the probe and the env disagree.

Set `memory_enabled = .cloud` from the probe's JSON output. When `cloud`
is false the skill runs in "stateless" mode — tests complete but nothing is
saved or cross-referenced. `audit_link` is NOT computed here — it needs
`repo_name`, which isn't resolved until Phase 0c below; see there.

---

## Phase 0c — Resolve Persona

If `persona_input` matches a registered persona name (for this `url`):
- `persona = matched.description`, `persona_id = matched.id`, `persona_name = matched.name`, `repo_name = matched.repo_name`

Otherwise treat `persona_input` as an ad-hoc persona description;
`persona_id = null`.

If `repo_name` is not on the persona, detect from `PERSONA_TEST_REPO_NAME` env,
or `git remote get-url origin`, or leave null.

Now that `repo_name` is resolved (or confirmed null), compute
`audit_link = memory_enabled && repo_name` — cross-referencing needs both
cloud storage AND a resolved repo identity to look findings up against.

---

## Phase 0d — Audit-Loop Pre-Test Enrichment

Skip if `audit_link = false`. When on, fetch recent HIGH + MEDIUM audit
findings (with `id` + `run_id` for Phase 6b correlations) and add a
**Known Code Fragilities** section to the persona mental model in Phase 2.

Full rules + query shape: `references/audit-correlation.md`.

---

## Phase 1 — Detect Browser Tool

Resolve the driver through the **one detection oracle** —
`references/browser-tool-detection.md`. Do not restate its ladder here; this
step only declares what persona-test needs from it.

**Minimum capability sets** (§4 of the oracle):

- **Full journey**: `navigate`, `click`, `type`, `evaluate`, `screenshot`,
  `wait`, `currentUrl`.
- **Read-only degraded**: `readText` alone (it takes a URL, so it needs no
  `navigate`). Below that → `blocked`.

Set `browser_driver` to the selected driver id (`playwright-mcp`,
`copilot-browser`, `brightdata`, `static-fetch`) and `browser_status` to `ok`,
`degraded` or `blocked`, then keep both for the whole session — never mix
driver families mid-run.

**A `degraded` run is reported as degraded.** Name the missing capabilities,
print the `[DEGRADED MODE]` banner at the top of the report, and mark every
interaction, flow and state-change stage **not-run** rather than passed. A
partial capture degrades to `unverified`; it never becomes "verified / 0
findings".

Full contract — capability vocabulary, driver table, selection order, status
evidence, Windows spawn caveats: `references/browser-tool-detection.md`.

**Login-gated target** (primary surfaces behind login): first check whether
the MCP session is already authenticated; if not and this is a repeat
session, ask whether a `--storage-state` bootstrap exists. Seed it **before
the MCP server connects** — `.mcp.json` is read once, so a mid-session seed is
never re-read. → `references/run-loop-detail.md` §Phase 1 + `references/auth-bootstrap.md`
— read when the target is login-gated.

---

## Phase 1a — Device Profile Resolution (required)

Skip ONLY when `browser_status = "degraded"` and the driver has no viewport concept.
Otherwise, this is non-negotiable — the LLM does not pick the device.

### Step 1a.1 — Get the device contract (required)

Run from the consumer-repo root:

```bash
node scripts/lib/device-presets.mjs prep "the persona's description, or ad-hoc persona_input text"
```

Add `--device PRESET` only when `$ARGUMENTS` contained an explicit override preset (Phase 0b item 4).

<!-- host-contract: input-acquisition; grammar=subcommand; empty=default -->
_This site: `subcommand` — no explicit `--device` means the device is resolved from the persona description, never guessed from context._

The CLI returns a JSON contract (`device`, `expectedFirstMcpCall`,
`personaMentalModelTags`, `logLine`). **Echo the `logLine` verbatim to stderr**
— it is the audit trail of which preset was applied.

### Step 1a.2 — Execute `expectedFirstMcpCall` verbatim

Call `browser_resize` with the args from `expectedFirstMcpCall.args` —
**before Phase 1b's first `browser_navigate`**. Do not modify the args;
do not pick your own dimensions. If the contract said `{width: 390,
height: 844}`, that's what you call.

### Step 1a.3 — Apply `personaMentalModelTags` to Phase 2

When `device.isMobile === true`, apply the tags to Phase 2's mental model
**silently** — they shape Reflect scoring, never the Phase 5b persona voice.

→ `references/device-profile.md` — read when you need the full contract shape,
the tag semantics, what viewport-only emulation does not cover (UA, touch
events, DPR — use `--mode consistency` for those), or the pair-mode device rule.

---

## Phase 1b — Service-worker cache-bust (MANDATORY for own apps)

Service workers silently serve stale bundles, so a deployed fix reads as "not
deployed". → `references/run-loop-detail.md` §Phase 1b.

Skip when `browser_status = "degraded"` (no `evaluate` capability). Skip when
the URL is a static-hosted page with no service worker (`*.github.io`, etc.).
Otherwise, **run this before Phase 2**:

```js
// browser_evaluate
(async () => {
  const regs = await navigator.serviceWorker?.getRegistrations() ?? [];
  await Promise.all(regs.map(r => r.unregister().catch(() => {})));
  const keys = await caches?.keys() ?? [];
  await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
  return { unregistered: regs.length, cachesDeleted: keys.length };
})()
```

Then `browser_navigate({url})` again to force a fresh fetch. If the evaluate
returns `{unregistered: 0, cachesDeleted: 0}`, the page had no SW — proceed
without the reload. Log the result one-line:
`[cache-bust] unregistered <n> SW, cleared <n> caches`.

**Don't** treat a non-zero `cachesDeleted` as a finding — caches are normal.
The finding-worthy event is when a fix doesn't appear after cache-bust;
that's a real deploy failure, not a caching artefact.

---

## Phase 2 — Build the Persona's Mental Model

Before driving, articulate the persona's profile in 5 dimensions:

| Dimension | Prompt |
|---|---|
| **Background** | Age range, tech comfort, relevant domain knowledge, attitudes |
| **Intent** | What are they trying to accomplish? What success looks like to them |
| **First actions** | The 3 things they'd naturally try within 30 seconds of landing |
| **Patience budget** | Low (phone, distracted) / Medium (desktop, curious) / High (research mode) |
| **Abandonment threshold** | What would make them close the tab / uninstall |

If `audit_link = true` and Phase 0d returned candidates, append the
**Known Code Fragilities** list (silently sharpens Reflect — do not leak
to the persona's "voice").

---

## Phase 3 — Safety Policy + Plan→Act→Reflect Loop

### Safety policy (origin boundary)

- **Never navigate away** from the target hostname
- **Never submit real payment info, real credentials, or PII**
- **Destructive actions** (delete accounts, delete data) require a fake
  test-only context; if unavailable, SKIP the action and log it as "deferred"
- Always call `browser_close` at the end, even if the session aborts

### Exploration loop (8–12 steps)

Each step is **Plan → Act → Reflect → Record**:

1. **Plan** — one sentence: "This persona would next try X because Y."
2. **Act** — take the action (click, type, navigate); screenshot immediately after.
3. **Reflect** — answer:
   - Did the observed state match the expectation? (Yes / No / Partial)
   - Does anything visible suggest a P0–P3 finding? (cite the element)
   - What does this persona try next?
4. **Record** — append to the session work-record below. This is not
   optional bookkeeping: Phase 5's COVERAGE block renders **only** from this
   record, never composed fresh at report time (`references/verification-discipline.md`
   §7's reciprocal warning).

Record a finding only when confidence ≥0.6. Below that, note it as
"uncertain — did not report". Every finding needs `element`, `observed`,
`fix`, `severity`, `confidence` — and `step`, the 1-based Act step it was
observed on. `step` is how the auto-correlator (Phase 6b) finds the page URL
the finding happened on (via `clickPath`) and compares it with the audited
file that serves that page; a finding without it correlates on its text alone.

### Stateful mission checklist (REQUIRED when the goal changes state)

A goal that **creates, submits, approves, completes, or selects an item and
hands it to another screen** is a stateful mission: reaching the goal is not
verifying it. → `references/run-loop-detail.md` §Phase 3 — the incident behind this.

For a stateful mission, verify each of these six steps, by screenshot, and
record which you could not:

| Step id | Verify |
|---|---|
| `initial-state` | The state before acting — the queue/list/count as it stands |
| `selected-identity` | The immutable identity of what was selected (id, name, row) — note it before acting |
| `post-boundary-state` | After a rerender or a navigation boundary, the SAME identity is still the one in play |
| `command-outcome` | The command's own outcome — the success state, not just the absence of an error |
| `return-to-origin` | Back at the origin screen, it reflects the change |
| `retained-history` | History/progress survives: completed items stay visible as completed, counts agree |

Record the outcome as the work-record's `lifecycle`:
`{"status": "verified" | "partial" | "not-applicable", "unchecked": [<step ids>]}` —
`verified` (all six checked, `unchecked: []`), `partial` (at least one not
checked — list exactly which), or `not-applicable` (the goal changes no state:
reading, browsing, searching). Spend step budget on the checklist before
exploring sideways — an unverified lifecycle caps the verdict (Phase 5).

### Session work-record (append-only; Phase 5 renders from this, never composes fresh)

| Field | Definition |
|---|---|
| `visitedSurfaces` | ordered list of `{path, action}`, appended after each Act step. Identity = normalized pathname (query/hash stripped, redirect followed to final URL); the list is a **chronological transition log**, not a deduped set — a reload is a repeat entry, not a new reach. Phase 5's "N screens" figure is `unique(pathname)` over this list, computed at render time |
| `stepCount` | `{completed, cap}` — `cap` is this loop's configured budget (8–12, or an explicit override); `completed` is the number of Act steps actually executed |
| `declaredFocus` | the `--focus` argument verbatim, or the literal string `"none — exploratory"` |
| `originPolicyResult` | one of `same-origin-only` (default; nothing cross-origin attempted) / `cross-origin-attempted-and-blocked` (the persona tried; the safety policy above refused) / `n/a` |
| `terminalReason` | **exhaustive, closed enum** — set once, when the loop stops: `goal-reached` / `step-budget-exhausted` / `abandonment-threshold-hit` / `auth-wall-blocked` / `tool-error` / `safety-refusal` |
| `authState` | `n/a-no-auth-encountered` / `authenticated-via-bootstrap` / `auth-wall-untested` (the last aligns with `authWallUntested` below) |
| `lifecycle` | `{status, unchecked}` from the stateful mission checklist above — `verified` / `partial` (+ the unchecked step ids) / `not-applicable` |

**`severity` is load-bearing, not a label** — it must be the literal string
`"P0"`, `"P1"`, `"P2"` or `"P3"`, and it is the field the auto-correlator
(Phase 6b) filters on to decide what reaches `persona_audit_correlations`.
A finding that spells it anything else is silently uncorrelatable; the
correlator reports `p0p1-shape-mismatch` when your declared counts and this
field disagree.

### Special cases

- **404 / page-not-found** → 1 retry after 5s; if still 404, emit P0 "Target URL unreachable" and stop
- **Login wall** → branches three ways, in this order:
  1. **No bootstrap was ever configured for this app** → emit P3 "App
     requires login; test scope limited to public surface", continue with
     public pages only, and set `authWallUntested = true` for Phase 4 (and
     the session work-record's `authState = 'auth-wall-untested'`) — this
     run did **not** cover the app's primary authenticated surfaces, and
     the report must say so even when it finds 0 P0s there.
  2. **A bootstrap was configured, and this looks like the connect-time
     race** (short-lived token, session has been running a while, a
     `storageState` file exists on disk) → this is a rig problem, not
     signal about the product. Attempt the escape hatch in
     `references/auth-bootstrap.md` (re-seed, then inject the refreshed
     `storageState` via `browser_evaluate` and reload). If it clears the
     login wall, continue the run normally — do **not** emit a finding for
     the recovery; the report's Auth coverage line may note the
     mid-session refresh as context, but it is not a P0-P3 item.
  3. **The escape hatch fails after a fresh re-seed** (or the app's
     session is HttpOnly-cookie-based and unrecoverable in-session) → this
     is a genuine setup regression. Emit **P1** "Auth bootstrap did not
     authenticate the session" (misconfigured/expired `storageState` —
     `references/auth-bootstrap.md`).
- **Page-load timeout** → retry once with viewport reset; if it still times out, emit P1 "Slow initial load (>15s)" and continue
- **Visible JS errors / console errors** → emit P1 or higher with the exact error text

---

## Phase 3b — Consistency Mode (deterministic, code-driven)

> Triggered by `--mode consistency`. **This is a completely different
> execution model from the exploratory loop above.** When `--mode consistency`
> is set, the LLM does NOT drive the browser — you delegate to the
> deterministic runner which owns Playwright directly. Skip Phases 1-3 and
> Phases 4-6 above; consistency mode has its own flow below.

Authoritative spec: [docs/reference/consistency-contract.md](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/docs/reference/consistency-contract.md).

### Step C1 — Validate inputs

Required: `--mode consistency` + `--canary <name>` + URL. If any missing,
print usage and STOP.

### Step C2 — Delegate to the runner

```bash
node scripts/persona-consistency-run.mjs --canary CANARY_NAME --url "https://your-app.example.com"
```

Optional: `--out .persona-test/sessions/$SID.json` to write the session artifact to a specific path.

The runner resolves the manifest + canary, drives `canary.journeySteps[]` with
no LLM in the loop, diffs DOM vs network ground truth, and checks
`expectedContradictions`. → `references/consistency-runner-and-report.md` §What the runner does.

### Step C3 — Read the verdict from the exit code (do NOT parse stdout)

| Exit | Verdict | Action |
|---|---|---|
| `0` | healthy — canary expectations met | Report success; surface contradictions count + any pending candidates |
| `2` | rig-broken — canary expected ≥N contradictions, got fewer | **Stop the pipeline.** Surface the failureReason from the ledger; investigate manifest drift or attribute regression before running again |
| `3` | fatal-rig — manifest missing / canary schema invalid / Playwright disconnected | Surface failureReason; the rig itself needs fixing |
| `4` | ledger-persist-failed — couldn't write session JSON | Surface stderr; disk full / permission issue, distinct from rig findings |
| `5` | playwright-missing | Suggest `npx playwright install chromium`; the runner emits this hint to stderr too |
| `6` | app-error — a journey action threw (e.g. TimeoutError on click) | This is an APP regression, NOT a rig issue. Surface the failing step + selector from the ledger |

### Step C4 — Report

Render the `CONSISTENCY MODE REPORT` fence (Canary, URL, Verdict, Exit,
counts; FINDINGS sorted P0 first, tie-break by surfaceId; OVERALL). On a
`broken` verdict, lead with the `⚠ RIG BROKEN` callout.
→ `references/consistency-runner-and-report.md` §Report fence — read before rendering it.

### Step C5 — Skip the persona debrief

Consistency mode does NOT produce a Phase 5b debrief. The exit code + the
findings fence is the entire report — rig output, not persona perception.

Full grammar + manifest schema + canary schema + flow details:
[references/consistency-mode.md](references/consistency-mode.md).

---

## Phase 4 — Severity Model

| Code | Label | Rule |
|---|---|---|
| **P0** | BROKEN | Primary flow fails; user cannot complete their intent |
| **P1** | DEGRADED | Flow completes but is confusing, slow, or missing clear feedback |
| **P2** | COSMETIC | Visual / layout / polish issue; flow works |
| **P3** | OBSERVATION | Not a bug — preference, suggestion, or informational note |

Confidence threshold: ≥0.6 to report, ≥0.7 for P0, ≥0.8 when calling a
recurring P0 from history.

**`authWallUntested` rule**: 0 P0s on such a run means "0 P0s on the public
shell", not on the app — OVERALL reads `Needs work` at best, never `Ready for
users` (it is one conjunct of Phase 5's predicate).
→ `references/run-loop-detail.md` §Phase 4 — read when the verdict is contested.

---

## Phase 5 — Structured Report

Emit the report inside this fence. Sort findings P0 first, ties by
confidence descending:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PERSONA TEST REPORT
  Persona: <persona>
  URL: <url>
  Focus: <focus or "exploratory">
  Device: <preset_name> <WxH> (touch=<bool>, resolved-from=<description|explicit|fallback>)
  Driver: <browser_driver> (<browser_status>) — <N> steps — <duration>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINDINGS
────────────────────────────────────────────────────
  [P<n>] <title> (confidence: <n>)
     Element:  <selector>
     Observed: <what happened>
     Fix:      <specific recommendation>
  ...

COVERAGE (relative to this persona's own session — not an inventory scan)
────────────────────────────────────────────────────
  Reached:        /  →  /cellar  →  /cellar/add   (3 unique screens, 9/12 steps)
  Loop ended:     <terminalReason>
  Focus:          <declaredFocus>
  Origin:         <originPolicyResult>
  Auth:           <authState>
  Lifecycle:      <verified | partial (unchecked: <step ids>) | not-applicable>

  Not a surface-complete scan: this persona explored as it naturally would,
  not exhaustively. For surface-complete coverage, run /nav-audit or
  /click-test against the same URL.

OVERALL: <Ready for users | Needs work | Blocked>
  Reason: <one sentence>
```

Every field in the COVERAGE block is rendered directly from the session
work-record (Phase 3) — never recomposed here. `Reached` is `unique(pathname)`
over `visitedSurfaces`; the step fraction is `stepCount.completed/cap`.

**`Ready for users` requires a composed eligibility predicate, not a single
check** — a clean run (no P0/P1 findings) AND **every one** of:

```
terminalReason      === 'goal-reached'
authState           !== 'auth-wall-untested'
originPolicyResult  !== 'cross-origin-attempted-and-blocked'
lifecycle.status    in ('verified', 'not-applicable')
```

**A reached goal with an unverified lifecycle is not a clean pass.** When
`lifecycle.status` is `partial` (and nothing else fails), OVERALL is
`Needs work` and the Reason line opens `Goal reached — lifecycle unverified`,
then lists the unchecked steps. The cap is enforced in code too:
`record-persona-session` stores `Needs work` for a claimed `Ready for users`
whose payload fails any conjunct — including a MISSING `lifecycle`, which is
unreported, not verified — and says so in the response's `verdictCap`.

Any failing conjunct → OVERALL `Needs work`, and the Reason line names
**every** failing conjunct. → `references/run-loop-detail.md` §Phase 5 — why
`terminalReason` alone is not enough, plus a worked Reason line.

If `audit_link = true` and Phase 0d candidates match the persona findings,
append an **AUDIT CORRELATIONS** section mapping each P0/P1 to a possible
root-cause audit finding. Keyword-matched — tag as "verify before assuming
causation".

Full example output (report + debrief): `examples/report-and-debrief.md`.

---

## Phase 5b — Persona Debrief

After the structured report, emit a **Persona Debrief** — 400–700 words
in first person as the persona. Product discovery artefact, not a bug list.
Grounded in session observations, not generic user opinions.

Full tone rules, structure, and wrapper: `references/persona-debrief-format.md`.

---

## Phase 6 — Save Session to Memory

Skip if `memory_enabled = false`. Output `[Session not saved — memory disabled]` and stop.

Omit `sessionId` — the CLI mints a collision-resistant one and returns it as
`sessionKey`; pass `sessionId` only to re-post an existing session.

Record the session + trigger secondary persona stats update in one call:

```bash
node scripts/cross-skill.mjs record-persona-session --json '{
  "persona": "<persona>",
  "url": "<url>",
  "focus": "<focus or null>",
  "browserTool": "<browser_driver> (<ok|degraded|blocked>)",
  "stepsTaken": <N>,
  "verdict": "<verdict>",
  "lifecycle": {"status": "<verified|partial|not-applicable>", "unchecked": [<step ids>]},
  "terminalReason": "<terminalReason>",
  "authState": "<authState>",
  "originPolicyResult": "<originPolicyResult>",
  "p0Count": <n>, "p1Count": <n>, "p2Count": <n>, "p3Count": <n>,
  "avgConfidence": <0-1>,
  "findings": <JSON array>,
  "reportMd": "<report text>",
  "debriefMd": "<debrief text>",
  "commitSha": "<auto-detected if omitted>",
  "deploymentId": "<optional>",
  "repoName": "<repo_name or null>",
  "personaId": "<persona_id or null>",
  "clickPath": <JSON array — the path you walked; see "Building clickPath" below>
}'
```

### Building `clickPath` (reachability evidence for `/nav-audit`)

One entry per Act step that *moved or activated something* (click / navigate /
open / submit):

```json
{ "step": <1-based step number>,
  "action": "click|navigate|type|fill|select|hover|scroll|press|submit|wait",
  "url": "<the page URL AFTER the step settled>",
  "targetText": "<visible label of the control you acted on, ≤80 chars, or null>" }
```

`targetText` is the control's visible label — typed input values stay out of
the payload. Omit the field (not `[]`) if you tracked no path.
→ `references/session-save-detail.md` §clickPath edges.

**Response** — keep `sessionId` (the row uuid; later phases pass it as
`personaSessionId`), not `sessionKey`. `statsUpdated: false` means the
persona's `last_tested_at`/`last_verdict` were not updated — report
`statsReason` (`no-persona-id` / `stats-write-failed` / `persona-not-found`);
nothing back-fills them. → `references/session-save-detail.md` §Response fields.

If `verdictCap` is present, the store did NOT record the verdict you claimed:
`{"claimed": "Ready for users", "stored": "Needs work", "blockers": [...],
"label": ...}`. Correct the report's OVERALL line to match — the report and
the stored session must never disagree.

---

## Phase 6b — Verify the Correlation Summary (automatic — do NOT re-emit)

`record-persona-session` (Phase 6) runs the correlator itself and writes the
`persona_audit_correlations` rows. **Do not call `record-correlation` per
finding** — it exists only for manual repair (below).
→ `references/session-save-detail.md` §Phase 6b.

Your only job this phase: **read `correlationSummary` from the Phase 6
response and report it** (echo the counts — `candidates`, `route`, `fuzzy`,
`missed`, `skippedExisting`, `malformed`, `writeFailed` — into the report).
→ `references/session-save-detail.md` §correlationSummary — read when a field's meaning is unclear.

`attempted: false` means the correlator didn't run at all — `reason` says why
(`disabled-by-flag`, `no-repo-identity`, `no-p0p1-findings`,
`p0p1-shape-mismatch`, `session-write-failed`). **`p0p1-shape-mismatch` is
never benign**: you declared `p0Count`/`p1Count` above zero but not one entry
in `findings` carried a `severity` of `P0`/`P1`, so nothing could be
correlated. Fix the payload and re-post — every finding needs `severity`
(see Phase 3), not a differently-named field. `attempted: true` with a `reason` still set
(`no-candidate-runs`, `candidate-read-failed`, `existence-check-failed`) means
it tried but couldn't compare against anything real — in BOTH cases, **zero
correlation rows were written**, which is correct (an empty candidate set is
not evidence of an audit miss — never treat it as one). `malformed > 0`
(findings missing `element`/`observed`) were quarantined, correctly.
`writeFailed > 0` is the one state
worth flagging loudly in the debrief (a real DB write failed for some
findings; already logged to stderr by the correlator).

### Manual repair — only for genuine corrections

Use `record-correlation` **only** to:
1. **Repair a false auto-emitted `audit_missed`** into a real match (supplying
   a real `auditFindingId` retires the stale row automatically).
2. **Emit `audit_false_positive` or `severity_overstated`** — human-judgment
   types, never auto-emitted.

Compute `personaFindingHash()` the same way the auto-correlator does
(`references/audit-correlation.md`) so the repair matches the row it corrects.
**When one of the two repair cases applies, run exactly one command per
finding being corrected** — payload via a Write-tool file under `.audit/`
piped on `--stdin`, not a shell-quoted `--json` string or heredoc
(`references/shell-safe-payloads.md` §Manual correlation repair):

1. Write `.audit/correlation-repair.json` with the Write tool:
   ```json
   {
     "personaSessionId": "the sessionId from Phase 6",
     "personaFindingHash": "personaFindingHash() of the persona finding",
     "personaSeverity": "P0|P1",
     "auditFindingId": "the matching audit_findings.id, or omit if none",
     "auditRunId": "the matched run id, or omit",
     "correlationType": "confirmed_hit | audit_missed | severity_understated | audit_false_positive | severity_overstated",
     "matchScore": 0.0,
     "matchRationale": "one line"
   }
   ```
2. Pipe it in:
   ```bash
   cat .audit/correlation-repair.json | node scripts/cross-skill.mjs record-correlation --stdin
   ```

Idempotent (dedupes on session + hash + audit finding). Do **not** loop this
over every P0/P1 finding. → `references/session-save-detail.md` §Manual repair,
and `references/audit-correlation.md` for the classification rules.

---

## Phase 6c — Session History Readback

After saving, surface patterns across prior sessions: recent runs, recurring
issues (≥2 occurrences), persistent P0s (via the `persistent_p0s` view).

Skip silently when Supabase vars are not set.

Full query shapes + output format: `references/session-history.md`.

---

## Phase 7 — Pair Mode (--pair)

Triggered by `--pair "<p1>" "<p2>"` anywhere in `$ARGUMENTS`. Skip Phases

<!-- host-contract: input-acquisition; grammar=subcommand; empty=default -->
_This site: `subcommand` — absence of `--pair` is a normal single-persona run — do not infer pair mode from two persona names being mentioned._

0b–6c above and follow the flow below.

Two opposed personas surface disjoint findings. → `references/pair-mode.md` §Why.

### Step P1 — Parse pair arguments

Parse from `$ARGUMENTS`:

<!-- host-contract: input-acquisition; grammar=subcommand; empty=ask-and-stop -->
_This site: `subcommand` — both personas must be quoted after `--pair`; one missing prints usage and stops._

1. **persona_a** — first quoted string after `--pair`
2. **persona_b** — second quoted string
3. **url** — URL in remaining args (or `PERSONA_TEST_APP_URL` env)
4. **focus** — anything after the URL

Required: both personas + url. If missing, output usage and STOP.

### Step P2 — Run persona A end-to-end

Run **Phases 0c → 6c** for persona A as if it were a solo run (its own Phase 1a
device resolution). Capture:
- `report_a` (Phase 5 report text)
- `findings_a` (the structured findings array used in Phase 5)
- `verdict_a`
- `session_id_a` (from Phase 6, may be null if memory disabled)

Then close the browser session (`browser_close`) — persona B gets a fresh
context, including a fresh cache-bust in Phase 1b. **Do not skip the
cache-bust for persona B** — it's not redundant; the browser context was
torn down.

### Step P3 — Run persona B end-to-end

Same flow for persona B. Capture `report_b`, `findings_b`, `verdict_b`,
`session_id_b`.

### Step P4 — Diff the findings

Two findings overlap if **either**:
- Same `element` selector AND same `severity`, OR
- Jaccard similarity of `observed` text ≥ 0.6 (token-level after lowercasing
  + stripping punctuation; ignore stopwords)

Classify each finding into:
- **CONSENSUS** — overlapping pair from A and B (high signal — both saw it)
- **A-ONLY** — finding from A with no overlap in B (coverage signal — A's expertise caught it)
- **B-ONLY** — finding from B with no overlap in A (coverage signal — B's expertise caught it)

### Step P5 — Emit pair report

Print both solo reports in full, then the `PAIR DIFF` fence (both devices and
verdicts in the header; CONSENSUS / A-ONLY / B-ONLY; overlap rate
`consensus / (consensus + a_only + b_only)`). → `references/pair-mode.md`
§Step P5 — read before rendering it.

OVERALL uses the solo vocabulary, and is the worse of the two solo verdicts
(`Blocked` > `Needs work` > `Ready for users`): the pair is ready for users
only when both personas' runs independently are — including each one's
lifecycle conjunct.

### Step P6 — Skip the secondary debrief

Each solo run already produced a Phase 5b debrief; do not write a pair debrief.

### Step P7 — Session linkage

When both solo runs were saved (memory enabled), record the pairing. The ids
are each Phase 6 response's `sessionId` (the row uuid), **not** `sessionKey`:

```bash
node scripts/cross-skill.mjs link-persona-pair --json '{
  "sessionA": "<sessionId from persona A's Phase 6>",
  "sessionB": "<sessionId from persona B's Phase 6>",
  "consensusCount": <n>,
  "aOnlyCount": <n>,
  "bOnlyCount": <n>,
  "overlapRate": <0-1>
}'
```

Send the counts you printed in Step P5 (`overlapRate` is optional and refused
if it disagrees). A refusal exits 1 naming `PARENT_NOT_FOUND` or
`PARENT_NOT_OWNED`. With the cloud store off (`"cloud": false, "pairId": null`)
say in the report that the pairing was not persisted.
→ `references/pair-mode.md` §Step P7.

---

## Reminders

- **You are the persona** — every click and judgement from their perspective
- **Be specific** — "button looks bad" is useless; "CTA [7] has no hover state on mobile 390px" is actionable
- **The verdict matters** — it drives whether the user ships or fixes

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/input-acquisition.md` | Where a skill's arguments come from on any host, and what to do when there are none. | Reading $ARGUMENTS on a host that does not substitute it, or deciding what empty input means at a site. |
| `references/audit-correlation.md` | Pre-test audit enrichment + post-test persona↔audit correlation emission — full rules. | `audit_link = true` AND (Phase 0d fetches audit candidates OR Phase 6b's manual-repair path is needed). |
| `references/browser-tool-detection.md` | The browser-driver contract — capabilities, driver table, selection order, minimum sets, degraded/blocked evidence. | Phase 1 tool selection fails on first try, OR the user is on Windows and Playwright MCP tools aren't appearing. |
| `references/auth-bootstrap.md` | Sanctioned auth-gated exploratory-testing pattern via MCP-server storageState, plus its connect-time-race escape hatch. | Phase 1 detects a login-gated target, OR Phase 3 hits a login wall (bootstrap configured or not). |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Phase 3 Record step / Phase 5 — rendering the COVERAGE block, to apply §7's reciprocal warning (it renders only from the session work-record). |
| `references/consistency-mode.md` | Full consistency-mode grammar, manifest schema, canary schema, runner exit codes, contradiction kinds. | Phase 3b runs (i.e., `--mode consistency` was passed) and you need the full grammar reference; OR the user asks how the rig decides severity / coercion / negative-space. |
| `references/consistency-runner-and-report.md` | Consistency-mode runner steps (Step C2) and the Step C4 report fence, including the RIG BROKEN callout. | Phase 3b — about to run the consistency runner (Step C2) or render its report (Step C4). |
| `references/persona-debrief-format.md` | Full persona debrief generation rules, tone guide, and output wrapper. | About to write the Phase 5b debrief. |
| `references/session-history.md` | Post-session history readback — recurring-issue surface + cross-session pattern detection. | Phase 6c runs AND Supabase is configured. |
| `references/interop.md` | How persona-test interacts with /ship, /plan, and /audit-code/audit-plan — integration contracts. | User asks about cross-skill effects, OR a sibling skill needs to reference persona-test data. |
| `references/shell-safe-payloads.md` | Why ADD and record-correlation payloads go through a Write-tool file on stdin, never a shell-quoted --json string. | Running `add` or a Phase 6b manual repair and tempted to inline the strings, OR asked why a file is used. |
| `references/device-profile.md` | Phase 1a detail — device prep contract shape, mobile tag semantics, viewport-only limits, MCP launch flags, pair mode. | Phase 1a — the prep contract is unclear, a touch/UA/DPR bug is suspected, OR a pair run resolves two devices. |
| `references/run-loop-detail.md` | Why the run-loop rules exist — cloud probe, auth at connect, cache-bust, stateful missions, Ready-for-users. | The cloud probe disagrees with env, the target is login-gated, OR a capped verdict is contested. |
| `references/session-save-detail.md` | Phase 6/6b detail — session-id minting, clickPath edges, response fields, correlationSummary, manual repair. | Phase 6/6b — a response field (statsReason, correlationSummary count) is unclear, OR a manual repair is needed. |
| `references/pair-mode.md` | Pair mode detail — why opposed personas, the Step P5 PAIR DIFF fence, overlap interpretation, Step P7 responses. | `--pair` was passed — before rendering Step P5, OR Step P7 returned a refusal. |
| `examples/report-and-debrief.md` | Sample full persona-test output — structured report + debrief fences and example content. | About to emit Phase 5 + 5b output and unsure of the exact fence format. |
| `references/worktree-preflight.md` | Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree. | A command dies with `MODULE_NOT_FOUND` in a linked worktree AND this repo has no `skills:hydrate` script. |

— end of /persona-test —
