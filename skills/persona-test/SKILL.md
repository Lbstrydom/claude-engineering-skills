---
name: persona-test
description: |
  Persona-driven exploratory browser testing against a live URL.
  Drives a browser as a specific user persona using a Plan → Act → Reflect loop,
  takes screenshots at each step, analyses UX and functional issues with confidence
  scoring, and returns a structured P0–P3 severity report plus a qualitative persona debrief.
  Personas are tracked per app URL — use "list" to see who's registered, "add" to register new ones.
  Use for exploratory QA against deployed apps — not scripted regression tests.
  Works with Playwright MCP (preferred — free, no credentials) or BrightData Scraping Browser (for external/anti-bot sites).
  Triggers on: "persona test", "test as", "explore the app as", "run persona test",
  "test the site as", "browse the app as", "QA as", "list personas", "add persona",
  "who are my personas", "which persona should test".
  Usage:
    /persona-test list [url]                                        — show all personas for an app
    /persona-test add "<name>" "<description>" <url> [app name]     — register a new persona
    /persona-test "<persona or name>" <url> [focus area]            — run a test session
  Examples:
    /persona-test list https://myapp.railway.app
    /persona-test add "Pieter" "wine enthusiast, 40s, drinks daily, mobile-first" https://myapp.railway.app "Wine Cellar App"
    /persona-test "Pieter" https://myapp.railway.app "adding a bottle"
    /persona-test "first-time user on mobile" https://myapp.railway.app
---

# Persona-Driven Browser Testing

Run an exploratory browser test with persona tracking. Check `$ARGUMENTS`
first to pick the sub-command.

---

## Phase 0 — Route the Command

Read the first word of `$ARGUMENTS`:

- `list` → **Sub-command: LIST**
- `add` → **Sub-command: ADD**
- otherwise → **Phase 0b: Parse Test Arguments** (normal test run)

---

## Sub-command: LIST

**Usage**: `list [url]`

Resolve the URL in order: positional argument → `PERSONA_TEST_APP_URL` env →
ask the user.

Fetch personas (graceful no-op when cloud is off):

```bash
node scripts/cross-skill.mjs list-personas --url "<url>"
```

Response shape:
```json
{"ok": true, "cloud": true|false, "rows": [/* persona_dashboard rows */]}
```

Render the roster. Sort: **never-tested first, then oldest last-tested**
(surfaces who's most overdue):

```
PERSONA ROSTER — <app_name or url>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  <N> personas registered

  NAME                      LAST TESTED    VERDICT        SESSIONS
  ──────────────────────    ─────────────  ─────────────  ────────
  Pieter (wine enthusiast)  3 days ago     Needs work     4
  Sarah (first-time user)   12 days ago    Blocked        2
  Admin (power user)        Never          —              0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SUGGESTION: Run Admin next — never tested. Then Sarah (12 days, last blocked).
```

STOP — do not proceed to the test phases.

---

## Sub-command: ADD

**Usage**: `add "<name>" "<description>" <url> [app name]`

Parse from `$ARGUMENTS` after `add`:
1. **name** — first quoted string
2. **description** — second quoted string
3. **url** — URL following the quoted strings
4. **app_name** — everything after the URL (optional)

If name, description, or url is missing, output usage and STOP.

Upsert (idempotent on `name + app_url`):

```bash
node scripts/cross-skill.mjs add-persona --json '{
  "name": "<name>",
  "description": "<description>",
  "appUrl": "<url>",
  "appName": "<app_name or null>"
}'
```

Response `{"ok": true, "cloud": ..., "personaId": ..., "existed": bool}`.
Report success with `personaId`. STOP.

---

## Phase 0b — Parse Test Arguments (normal test run)

Parse `$ARGUMENTS`:
1. **persona_input** — first quoted string or first unparsed token
2. **url** — URL in the remaining args (or `PERSONA_TEST_APP_URL` env)
3. **focus** — any remaining text after the URL

Required: `persona_input` + `url`. If either is missing, output usage and STOP.

### Pre-flight environment check

| Env var | Purpose |
|---|---|
| `PERSONA_TEST_SUPABASE_URL` + `..._ANON_KEY` | Memory enabled — saves sessions, reads history |
| `PERSONA_TEST_REPO_NAME` | Enables audit-loop cross-reference (`audit_link = true`) |
| `SUPABASE_AUDIT_URL` + `SUPABASE_AUDIT_ANON_KEY` | Audit-loop DB — used by Phase 0d pre-test enrichment |

Set boolean flags `memory_enabled`, `audit_link` based on what's present.
When both are off, the skill runs in "stateless" mode — tests complete
but nothing is saved or cross-referenced.

---

## Phase 0c — Resolve Persona

If `persona_input` matches a registered persona name (for this `url`):
- `persona = matched.description`, `persona_id = matched.id`, `persona_name = matched.name`, `repo_name = matched.repo_name`

Otherwise treat `persona_input` as an ad-hoc persona description;
`persona_id = null`.

If `repo_name` is not on the persona, detect from `PERSONA_TEST_REPO_NAME` env,
or `git remote get-url origin`, or leave null.

---

## Phase 0d — Audit-Loop Pre-Test Enrichment

Skip if `audit_link = false`. When on, fetch recent HIGH + MEDIUM audit
findings (with `id` + `run_id` for Phase 6b correlations) and add a
**Known Code Fragilities** section to the persona mental model in Phase 2.

Full rules + query shape: `references/audit-correlation.md`.

---

## Phase 1 — Detect Browser Tool

Check the URL hostname. Own-app domains (localhost, `*.railway.app`,
`*.vercel.app`, `*.netlify.app`) → Playwright MCP. External URLs →
try Playwright first, then BrightData for anti-bot sites.

Set `browser_tool = "Playwright MCP" | "BrightData" | "WebFetch (degraded)"`
and stick with it for the whole session.

Full tier-fallback protocol + Windows MCP caveats: `references/browser-tool-detection.md`.

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

Each step is **Plan → Act → Reflect**:

1. **Plan** — one sentence: "This persona would next try X because Y."
2. **Act** — take the action (click, type, navigate); screenshot immediately after.
3. **Reflect** — answer:
   - Did the observed state match the expectation? (Yes / No / Partial)
   - Does anything visible suggest a P0–P3 finding? (cite the element)
   - What does this persona try next?

Record a finding only when confidence ≥0.6. Below that, note it as
"uncertain — did not report". Every finding needs `element`, `observed`,
`fix`, `severity`, `confidence`.

### Special cases

- **404 / page-not-found** → 1 retry after 5s; if still 404, emit P0 "Target URL unreachable" and stop
- **Login wall** → emit P3 "App requires login; test scope limited to public surface" and continue with public pages only
- **Page-load timeout** → retry once with viewport reset; if it still times out, emit P1 "Slow initial load (>15s)" and continue
- **Visible JS errors / console errors** → emit P1 or higher with the exact error text

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
  Tool: <browser_tool> — <N> steps — <duration>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINDINGS
────────────────────────────────────────────────────
  [P<n>] <title> (confidence: <n>)
     Element:  <selector>
     Observed: <what happened>
     Fix:      <specific recommendation>
  ...

OVERALL: <Ready for users | Needs work | Blocked>
  Reason: <one sentence>
```

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

Build the session ID: `SID = persona-test-<unix timestamp>`.

Record the session + trigger secondary persona stats update in one call:

```bash
node scripts/cross-skill.mjs record-persona-session --json '{
  "sessionId": "<SID>",
  "persona": "<persona>",
  "url": "<url>",
  "focus": "<focus or null>",
  "browserTool": "<browser_tool>",
  "stepsTaken": <N>,
  "verdict": "<verdict>",
  "p0Count": <n>, "p1Count": <n>, "p2Count": <n>, "p3Count": <n>,
  "avgConfidence": <0-1>,
  "findings": <JSON array>,
  "reportMd": "<report text>",
  "debriefMd": "<debrief text>",
  "commitSha": "<auto-detected if omitted>",
  "deploymentId": "<optional>",
  "repoName": "<repo_name or null>",
  "personaId": "<persona_id or null>"
}'
```

Response `{"ok": true, "cloud": ..., "sessionId": "<uuid>", "existed": bool, "statsUpdated": bool}`.
**Capture `sessionId`** for Phase 6b. If `statsUpdated: false`, log a stderr
warning — session is preserved; stats self-heal on the next reconciler run.

---

## Phase 6b — Emit Audit-Loop Correlations

Skip if `audit_link = false` OR Phase 0d candidates are empty OR no P0/P1
findings produced in this session.

For every P0/P1 finding, emit one correlation row via
`cross-skill.mjs record-correlation` classified per the rules table.

Full classification rules, hashing, reverse-direction (audit false positives)
protocol: `references/audit-correlation.md`.

---

## Phase 6c — Session History Readback

After saving, surface patterns across prior sessions: recent runs, recurring
issues (≥2 occurrences), persistent P0s (via the `persistent_p0s` view).

Skip silently when Supabase vars are not set.

Full query shapes + output format: `references/session-history.md`.

---

## Reminders

- **You are the persona** — every click and judgement from their perspective
- **Plan before every action** — impulsive clicking misses the persona's flow
- **Reflect after every screenshot** — that's where findings are born
- **Confidence <0.6 = don't report** — uncertainty is noise
- **Screenshot every step** — never analyse what you cannot see
- **Be specific** — "button looks bad" is useless; "CTA [7] has no hover state on mobile 390px" is actionable
- **The verdict matters** — it drives whether the user ships or fixes

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/audit-correlation.md` | Pre-test audit enrichment + post-test persona↔audit correlation emission — full rules. | `audit_link = true` AND (Phase 0d fetches audit candidates OR Phase 6b emits correlations). |
| `references/browser-tool-detection.md` | Full browser-tool detection algorithm with tier priority, fallback rules, and Windows caveats. | Phase 1 tool selection fails on first try, OR the user is on Windows and Playwright MCP tools aren't appearing. |
| `references/persona-debrief-format.md` | Full persona debrief generation rules, tone guide, and output wrapper. | About to write the Phase 5b debrief. |
| `references/session-history.md` | Post-session history readback — recurring-issue surface + cross-session pattern detection. | Phase 6c runs AND Supabase is configured. |
| `references/interop.md` | How persona-test interacts with /ship, /plan-*, and /audit-loop — integration contracts. | User asks about cross-skill effects, OR a sibling skill needs to reference persona-test data. |
| `examples/report-and-debrief.md` | Sample full persona-test output — structured report + debrief fences and example content. | About to emit Phase 5 + 5b output and unsure of the exact fence format. |
