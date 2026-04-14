---
name: persona-test
description: |
  Persona-driven exploratory browser testing against a live URL.
  Drives a browser as a specific user persona using a Plan → Act → Reflect loop,
  takes screenshots at each step, analyses UX and functional issues with confidence
  scoring, and returns a structured P0–P3 severity report plus a qualitative persona debrief.
  Personas are tracked per app URL — use "list" to see who's registered, "add" to register new ones.
  Use for exploratory QA against deployed apps — not scripted regression tests.
  Works with BrightData MCP scraping browser (preferred) or Playwright MCP (fallback).
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
  disable-model-invocation: true
---

# Persona-Driven Browser Testing

You are running an exploratory browser test with persona tracking. Check `$ARGUMENTS`
first to determine which sub-command to run.

**Input**: `$ARGUMENTS`

---

## Phase 0 — Route the Command

Read the first word of `$ARGUMENTS`:

- If it is `list` → go to **Sub-command: LIST**
- If it is `add` → go to **Sub-command: ADD**
- Otherwise → go to **Phase 0b: Parse Test Arguments** (normal test run)

---

## Sub-command: LIST

**Usage**: `list [url]`

Detect the app URL:
1. If a URL follows `list`, use it
2. Else check `PERSONA_TEST_APP_URL` env var
3. Else ask: "Which app URL should I list personas for?"

Fetch personas for that URL:

```bash
curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/persona_dashboard?app_url=eq.<url>&select=*" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
```

Output the persona roster:

```
PERSONA ROSTER — <app_name or url>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  <N> personas registered

  NAME                      LAST TESTED    VERDICT        SESSIONS
  ──────────────────────    ─────────────  ─────────────  ────────
  Pieter (wine enthusiast)  3 days ago     Needs work     4
  Sarah (first-time user)   12 days ago    Blocked        2
  Admin (power user)        Never          —              0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SUGGESTION: Run Admin next — never tested. Then Sarah (12 days, last blocked).

To test: /persona-test "Admin" <url> [focus]
To add:  /persona-test add "<name>" "<description>" <url>
```

Sort order: never-tested first, then by oldest last-tested. This surfaces who's most overdue.

The SUGGESTION line picks the highest-priority untested or stale persona and explains why.

STOP here — do not proceed to the test phases.

---

## Sub-command: ADD

**Usage**: `add "<name>" "<description>" <url> [app name]`

Parse from `$ARGUMENTS` (after `add`):
1. **name** — first quoted string (short label, e.g. `"Pieter"`)
2. **description** — second quoted string (full persona text for /persona-test)
3. **url** — URL following the quoted strings
4. **app_name** — everything after the URL (optional)

If name, description, or url is missing, output usage and STOP:
```
[ERROR] Usage: /persona-test add "<name>" "<description>" <url> [app name]
Example: /persona-test add "Pieter" "wine enthusiast, 40s, mobile-first" https://myapp.railway.app "Wine Cellar App"
```

Upsert the persona (insert or update if name+url already exists):

```bash
curl -s -X POST "$PERSONA_TEST_SUPABASE_URL/rest/v1/personas" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates,return=representation" \
  -d '{
    "name": "<name>",
    "description": "<description>",
    "app_url": "<url>",
    "app_name": "<app_name or null>"
  }'
```

Output confirmation:

```
✓ Persona registered
  Name:   Pieter
  App:    Wine Cellar App (https://myapp.railway.app)
  Desc:   wine enthusiast, 40s, mobile-first

To test: /persona-test "Pieter" https://myapp.railway.app [focus area]
To list: /persona-test list https://myapp.railway.app
```

STOP here — do not proceed to the test phases.

---

## Phase 0b — Parse Test Arguments

Extract from `$ARGUMENTS`:

1. **persona_input** — if it starts with a quote, everything inside quotes. If it matches a registered persona name (checked in Phase 0c), use that persona's full description. Otherwise treat the whole input as an ad-hoc persona description.
2. **url** — the URL following the persona
3. **focus** — everything after the URL (optional)

If `persona_input` or `url` is missing, STOP and output:
```
[ERROR] Usage: /persona-test "<persona or name>" <url> [focus area]

Registered personas for this app:
  /persona-test list <url>

Register a new one:
  /persona-test add "<name>" "<description>" <url>
```

### Environment Pre-Flight Check

After parsing arguments, silently check which optional capabilities are available.
Set internal flags — do NOT ask the user to set anything:

```
memory_enabled   = PERSONA_TEST_SUPABASE_URL is set AND non-empty
                   AND PERSONA_TEST_SUPABASE_ANON_KEY is set AND non-empty

audit_link       = SUPABASE_AUDIT_URL is set AND non-empty
                   AND SUPABASE_AUDIT_ANON_KEY is set AND non-empty
```

Output ONE status line showing what's active (not what's missing):

```
[PERSONA SESSION] Memory: ✓ enabled | Audit link: ✓ enabled
   — or —
[PERSONA SESSION] Memory: ✗ off (set PERSONA_TEST_SUPABASE_URL + PERSONA_TEST_SUPABASE_ANON_KEY to persist sessions)
   — or —
[PERSONA SESSION] Memory: ✓ enabled | Audit link: ✗ off
```

Behaviour when flags are off:
- `memory_enabled = false` → skip Phase 0c persona lookup, skip Phase 6 session save, skip SESSION HISTORY section in report. Test runs and reports normally — results just aren't persisted.
- `audit_link = false` → skip Phase 0d enrichment. Test runs without "Known Code Fragilities" context.

Never block the test on missing optional env vars. Never prompt the user to set them mid-session.

---

## Phase 0c — Resolve Persona

Skip this phase entirely if `memory_enabled = false`.

If `memory_enabled = true`, check if `persona_input` matches a registered persona name for this URL:

```bash
curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/personas?name=ilike.<persona_input>&app_url=eq.<url>&select=id,name,description,notes,repo_name" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
```

- If a match is found: `persona = matched.description`, `persona_id = matched.id`, `persona_name = matched.name`, `repo_name = matched.repo_name`
- If no match: treat `persona_input` as the full ad-hoc persona description, `persona_id = null`
- If `repo_name` not on persona: detect from `PERSONA_TEST_REPO_NAME` env var, or `git remote get-url origin` (extract repo name), or null

If `persona_id` is set and `notes` is non-empty, append notes to the persona mental model
in Phase 2 as additional backstory context.

---

## Phase 0d — Audit-Loop Pre-Test Enrichment (optional)

Skip this phase entirely if `audit_link = false`.

If `audit_link = true` and `repo_name` is set, fetch recent unresolved HIGH findings
from the audit-loop database for this repo:

```bash
curl -s "$SUPABASE_AUDIT_URL/rest/v1/audit_findings?severity=eq.HIGH&order=created_at.desc&limit=10&select=category,primary_file,detail_snapshot,created_at" \
  -H "apikey: $SUPABASE_AUDIT_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_AUDIT_ANON_KEY"
```

If any findings are returned, add a **Known Code Fragilities** section to the persona mental
model in Phase 2 (after the main profile):

```
Known code fragilities (from recent audit):
  • src/routes/wines.js — missing error handling on POST (audit HIGH, Apr 13)
  • src/services/wine/sourceEnrichment.js — incorrect db.prepare() usage (audit HIGH, Apr 13)
  [etc.]
```

**How this enriches exploration**: the persona doesn't mechanically target these files —
but knowing the code is fragile in certain areas biases the Reflect step to look harder
for symptoms in those flows. A persona exploring "add a wine" naturally hits wines.js;
knowing it has a recent HIGH means a hang or silent failure should be flagged with higher
confidence.

**Important**: do not mention "the code has a bug here" to the persona — they wouldn't know
that. Instead, let the fragility knowledge sharpen your Reflect judgement silently.

---

## Phase 1 — Detect Browser Tool

Try tools in this order. Use the FIRST one that responds.

**Tier 1: BrightData Scraping Browser** (preferred — handles anti-bot, CAPTCHA)
- Attempt `mcp__brightdata__scraping_browser_navigate` with the target URL
- If it responds: `browser_tool = "BrightData Scraping Browser"`
- Note: BrightData requires KYC approval from compliance@brightdata.com for password
  fields. If login is blocked, flag as a known limitation and continue unauthenticated.

**Tier 2: BrightData Browser AI** (lighter serverless alternative)
- Attempt `mcp__brightdata__browser_navigate` (browserai-mcp variant)
- If it responds: `browser_tool = "BrightData Browser AI"`

**Tier 3: Playwright MCP** (free, no anti-bot — good for own apps)
- Attempt `browser_navigate` from Playwright MCP (`@playwright/mcp`)
- If it responds: `browser_tool = "Playwright MCP"`

**Tier 4: None available — STOP**
```
[ERROR] No browser tool available.
Install BrightData MCP or Playwright MCP to run persona tests.

  Playwright MCP (free — works for own apps, no anti-bot):
    Claude Code: add to ~/.claude/settings.json
      "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--headless"] } }
    VSCode Copilot Chat: add to .vscode/mcp.json in your repo
      { "servers": { "playwright": { "type": "stdio", "command": "npx", "args": ["@playwright/mcp@latest", "--headless"] } } }
    Then restart your editor / reload the MCP server list.

  BrightData MCP (handles anti-bot & CAPTCHA — for external sites):
    Configure in Claude Code settings (MCP servers) per BrightData docs.

Note: If running in a sub-agent context, MCP tools may not be exposed.
Run /persona-test directly in your main Claude Code session.
```

---

## Phase 2 — Build Persona Mental Model

Before navigating, construct a structured persona profile from the description.
Output this block:

```
[PERSONA SESSION STARTING]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Persona:  <persona>
URL:      <url>
Focus:    <focus or "Free exploration">
Browser:  <browser_tool>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Persona profile:
  background:         [who this person is — role, context, life situation]
  general_intent:     [what they want to achieve in plain language]
  technical_comfort:  [consumer / intermediate / expert]
  device_implied:     [mobile 390px / desktop 1280px / unknown — infer from description]
  patience_level:     [low / medium / high]
  first_actions:      [what they would do in the first 30 seconds]
  abandonment_threshold: [what would make them leave without completing the task]
  key_watch_areas:    [navigation clarity, CTA visibility, form usability, error states, mobile layout]
```

This profile governs EVERY navigation decision. You are not testing generically —
you are this specific person with these specific goals.

---

## Phase 3 — Safety-First Policy (Read Before Acting)

**Default mode: read-only exploration.** This skill operates on live production URLs.

### Permitted without restriction
- Navigating to URLs
- Clicking navigation links, tabs, accordions, filters, sort controls, search inputs
- Typing in search bars and demo/filter fields
- Scrolling, hovering, observing

### Safety Gate — language-neutral semantic intent check (G2)

Do NOT rely on English keywords. Before acting, ask: "Would this action CREATE, UPDATE, DELETE, PURCHASE, SEND, or otherwise mutate data or trigger external systems — in any language?"

Block any action whose **semantic purpose** is:
- Destructive: delete, remove, archive, close account (in any language)
- Transactional: purchase, subscribe, pay, checkout (in any language)
- Confirmatory in a destructive context: OK/Confirm/Yes in a modal following a risky CTA
- State-mutating submit: any non-search form submission

If the action is ambiguous but context implies mutation → treat as blocked. Never bypass based on label alone.

**When you encounter a denylist action:**
1. Screenshot it (evidence for report)
2. Log: `[SKIPPED — safe-mode] Action '<name>' not attempted — would mutate live data`
3. Add to findings as: `P3 OBSERVATION — Mutation flow not tested (safe mode). Use --unsafe-mutations to enable.`
4. Continue exploration — do not abort

**Localhost/internal URL check (G1)**: Before selecting a provider, check the URL hostname. If it is `localhost`, `127.0.0.1`, `0.0.0.0`, or ends in `.local` or `.internal` — skip BrightData (cloud proxy cannot reach internal servers) and go directly to Playwright MCP. Log: `[LOCAL URL] Using Playwright — BrightData skipped for internal hostname`.

**Origin boundary**: Stay within the starting URL's origin by default. If navigation leads to a third-party domain (external auth, payment, CDN), screenshot the boundary, log `[BOUNDARY] External domain — not testing third-party services`, navigate back to primary origin, and continue. Do not follow cross-origin redirects into external services.

**Always close the browser at end of session** using the tool's close/disconnect operation, whether the session completes normally or fails mid-run.

---

## Phase 3 — Exploration Loop (Plan → Act → Reflect)

**Session length**: Aim for 10 steps. Cap at 12. Stop early only if:
- URL returns HTTP error on step 1 (→ P0, stop)
- Page blank/unresponsive after 2 retries (→ P0, stop)
- Focus task completed successfully AND all key states observed

Each step follows a strict **Plan → Act → Reflect** cycle:

### PLAN
Before each action, state your plan:
```
Step [N]/[max] — PLAN
  Persona would: [what the persona would naturally do next and why]
  Action type:   [navigate / click / type / scroll / observe]
  Target:        [element description or URL]
```

### ACT
Execute exactly one action using the browser tool. Then take a screenshot immediately.

**Tool commands**:

| Action | BrightData Scraping Browser | Playwright MCP |
|--------|-----------------------------|----------------|
| Navigate | `mcp__brightdata__scraping_browser_navigate` | `browser_navigate` |
| Screenshot | `mcp__brightdata__scraping_browser_screenshot` | `browser_screenshot` |
| Click | `mcp__brightdata__scraping_browser_click` | `browser_click` |
| Type | `mcp__brightdata__scraping_browser_type` | `browser_type` |
| Scroll | `mcp__brightdata__scraping_browser_scroll` | `browser_scroll` |
| Get DOM text | `mcp__brightdata__scraping_browser_get_text` | `browser_get_text` |

**No sleep/wait tool exists** — to observe page settle, take a second screenshot immediately after the action. If still loading in screenshot 2, note "still loading" and proceed.

**No goBack() tool** — to return from an external origin, use `navigate(previous_url)`. This does a fresh GET and loses form state; note this in narration.

**Hover** — no cross-browser hover tool. Narrate what you would check on hover in the REFLECT step instead of attempting a hover call.

When analysing the screenshot: treat numbered `[N]` references as interactive element
indices. Reference elements by their index when describing findings (e.g. "element [3]
— the Submit button — has no visible hover state").

Screenshot IMMEDIATELY after EVERY action — states are transient (spinners, flash
errors, hover states disappear within seconds).

### REFLECT
After every screenshot, reason explicitly before moving on:
```
Step [N] — REFLECT
  What I see:     [describe the current page state from the persona's perspective]
  Expected:       [what a well-designed app would show at this point]
  Delta:          [anything surprising, broken, missing, or confusing]
  Persona reaction: [how this persona would feel / react — frustrated? confused? delighted?]
  Finding:        [P0/P1/P2/P3 — description] OR [✓ No issue]
  Confidence:     [0.0–1.0 — how certain am I this is a real issue vs. me misreading the page]
```

**Severity-specific confidence thresholds** — only log if confidence meets the minimum:

| Severity | Min confidence to log |
|----------|-----------------------|
| P0 BROKEN | ≥ 0.70 |
| P1 DEGRADED | ≥ 0.65 |
| P2 COSMETIC | ≥ 0.60 |
| P3 OBSERVATION | ≥ 0.50 |

Below minimum: note uncertainty in narration, do not add to findings log. If confidence is borderline, downgrade one severity level rather than excluding.

**Per-step observation checklist** — for each meaningful interaction, check:
- Loading state: did a spinner/skeleton appear within ~300ms? (No → P2 candidate)
- Success signal: was success clearly communicated? (No → P1 candidate)
- Error path: if an error occurred, was it explained with recovery guidance? (No → P1)
- Empty state: if result is empty, is there a helpful message or CTA? (No → P2)
- Recovery: can the user go back / undo? (No → P1 candidate)

**Finding log** (maintained internally across all steps):
```
findings = [
  {
    id: "F1",
    semanticId: "<LLM-constructable slug — NOT a hash. Format: page-slug_element-slug_issue-slug, e.g. add-wine_submit-btn_no-response>",
    severity: "P0",
    confidence: 0.9,
    title: "<short description, < 80 chars>",
    page: "<url at time of observation>",
    step: 4,
    element: "<role + visible label, e.g. button 'Add Wine' or nav item 3>",
    observed: "<exactly what happened>",
    expected: "<what should have happened>",
    userImpact: "<effect on persona's task>",
    status: "open",  // or "skipped-safe-mode" | "uncertain"
  },
  ...
]
```

**Before building the report**: group findings by `semanticId`. Merge duplicates (same issue seen multiple steps) into one finding with earliest `step` as `evidenceStep`.

---

## Phase 3 Exploration Strategy

**If `focus` is provided** (10 steps total):
- Steps 1–4: Free persona exploration — navigate as the persona naturally would.
  Do NOT jump directly to the focus area. Discovery friction is where real users fail.
- Steps 5–10: Deliberately attempt the focus area and its sub-tasks.
- If focus is completed early (step 8 or 9): use remaining steps on adjacent flows.

**If no `focus`** (10 steps total):
- All steps: Persona-guided free exploration
- Prioritise: first-run experience, primary feature, main navigation, a key form

**Special cases**:
- **404 / error page**: Flag P0, note URL, stop if stuck
- **Login wall (unauthenticated)**: Attempt login; if BrightData KYC blocks password → note limitation, continue unauthenticated
- **Page load > 10 seconds**: Flag P1 — performance
- **Visible JS errors**: Flag P1 — include the error text
- **Empty state with no CTA**: Flag P2 if no onboarding guidance visible
- **CAPTCHA**: BrightData handles automatically; Playwright MCP cannot — flag if blocked

---

## Phase 4 — Severity Model

| Code | Label | Confidence threshold | Criteria |
|------|-------|---------------------|---------|
| P0 | BROKEN | ≥ 0.7 | Non-functional, crash, data loss, flow completely blocked |
| P1 | DEGRADED | ≥ 0.6 | Works but with significant friction, missing feedback, unexpected behaviour |
| P2 | COSMETIC | ≥ 0.6 | Visual issue, minor confusion, inconsistency — does not block task |
| P3 | OBSERVATION | ≥ 0.5 | Noted for awareness — not an issue, but tracked |

**OVERALL verdict** — determined by severity profile (not average confidence):

| Verdict | Condition |
|---------|-----------|
| `Ready for users` | 0 P0s AND ≤ 1 P1 (P2s and P3s are acceptable) |
| `Needs work` | 0 confirmed P0s AND 2+ P1s, OR 1 P0 skipped in safe mode |
| `Blocked` | 1+ confirmed P0s that prevented task completion |

Average confidence appears in the SUMMARY as a signal of report certainty — it does NOT determine the verdict. P3 observations are excluded from P0/P1/P2 issue counts.

---

## Phase 5 — Output Report

```
═══════════════════════════════════════════════════════
  PERSONA TEST REPORT
═══════════════════════════════════════════════════════
  Persona:  <persona>
  URL:      <url>
  Focus:    <focus or "Free exploration">
  Date:     <today's date>
  Browser:  <browser_tool>
  Steps:    <N completed>
═══════════════════════════════════════════════════════

FINDINGS
────────────────────────────────────────────────────────
<If no findings:>
  ✓ No issues found during this session.

<For each finding, P0 first through P3 last, sorted by confidence descending within each tier:>

[P<n>] <SEVERITY LABEL> — <Element / Area>: <Short description>
      Element:   <element [N] or area — be specific>
      Observed:  <what happened — exact, not vague>
      Expected:  <what should have happened>
      Fix:       <suggested direction — not an implementation, just the right area>
      Confidence: <0.0–1.0>

────────────────────────────────────────────────────────

SUMMARY
  Total findings: <N>  (P0: <n> | P1: <n> | P2: <n> | P3: <n>)
  Avg confidence: <mean across all findings>

TOP 3 PRIORITIES
  1. [P<n>] <finding description> (confidence: <n>)
  2. [P<n>] <finding description> (confidence: <n>)
  3. [P<n>] <finding description> (confidence: <n>)

OVERALL: <Ready for users | Needs work | Blocked>
  Reason: <One sentence — cite the specific blocker or give the clean bill of health>

<If repo_name is set and SUPABASE_AUDIT_URL is set, and P0 or P1 findings exist:>

AUDIT CORRELATIONS
────────────────────────────────────────────────────────
<For each P0/P1 finding, check if any audit HIGH/MEDIUM finding mentions similar
 files or keywords. Surface matches as possible root causes:>

  Persona P0: "Add Wine form submit unresponsive"
  → Possible root cause: [audit HIGH] src/routes/wines.js — missing error handling
    on POST. If the handler throws silently, the form would appear to hang.
    Detail: "addWine() has no try/catch; unhandled promise rejection swallows errors"

  Persona P1: "Search results take 3+ seconds with no feedback"
  → Possible root cause: [audit MEDIUM] src/services/search.js — N+1 query pattern.
    Each result triggers a separate DB lookup instead of a batched join.

  Persona P2: "Mobile nav clips at 390px"
  → No matching audit finding (this is a CSS/layout issue, not a code logic issue)

Note: correlations are keyword-matched — verify before assuming causation.
────────────────────────────────────────────────────────
```

If no audit DB is configured or no P0/P1 findings exist, omit the AUDIT CORRELATIONS section.

---

## Phase 5b — Persona Debrief (product discovery output)

After the structured report, generate a **Persona Debrief** — a first-person narrative
written entirely in the persona's voice. This is the product discovery artefact: not a
bug list, but an honest reaction from a real-feeling user.

**Tone rules**:
- Write in first person as the persona — their vocabulary, their frame of reference
- Be specific about what they actually encountered during the session (draw from your Reflect notes)
- No bullet-point lists of features — this is a stream of thought, not a spec
- Include texture: emotional reactions, hesitations, moments of delight, pet peeves
- Mention what they would and wouldn't use, and why
- End with a clear priority ranking — what they'd build first if it were their call
- Length: 400–700 words. Long enough to be substantive, short enough to be readable

**Structure** (write as flowing prose, not headers):

1. **Opening context** — what the persona was trying to do, their state of mind going in
2. **Feature-by-feature honest take** — what worked, what confused them, what was missing
3. **What would drive them crazy** — the specific things that would erode trust or cause them to leave
4. **What would delight them** — specific, in-context moments of "yes, this gets me"
5. **What they wouldn't use** — and why, without judgment
6. **Bottom line** — their top 3 priorities in plain language

Output the debrief in this wrapper:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PERSONA DEBRIEF — <persona>
  [Written in first person as the persona]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<400–700 word first-person narrative here>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**What the debrief is for**: The structured report (Phase 5) tells the developer *what to fix*.
The debrief tells the product team *what to build next*. They serve different readers.

**Important**: The debrief must be grounded in what actually happened during the session —
not a generic user opinion. Every point should trace back to something observed in a step.

---

## Phase 6 — Save Session to Memory (optional but recommended)

Skip this phase entirely if `memory_enabled = false` (already determined in Phase 0b pre-flight).
When skipped, output: `[Session not saved — memory disabled]` and stop.

If `memory_enabled = true`, POST the session to Supabase using a `curl` call:

```bash
curl -s -X POST "$PERSONA_TEST_SUPABASE_URL/rest/v1/persona_test_sessions" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d '{
    "session_id": "<SID>",
    "persona": "<persona>",
    "url": "<url>",
    "focus": "<focus or null>",
    "browser_tool": "<browser_tool>",
    "steps_taken": <N>,
    "verdict": "<verdict>",
    "p0_count": <n>,
    "p1_count": <n>,
    "p2_count": <n>,
    "p3_count": <n>,
    "avg_confidence": <avg>,
    "findings": <findings JSON array>,
    "report_md": "<escaped full report markdown>",
    "debrief_md": "<escaped persona debrief narrative>"
  }'
```

Where `<SID>` = `persona-test-<unix timestamp>` (e.g. `persona-test-1744123456`).
Include `"persona_id": "<persona_id>"` in the POST body if a registered persona was used (from Phase 0c); omit or set to `null` for ad-hoc personas.

If `persona_id` is set, update the persona's running stats:

```bash
curl -s -X PATCH "$PERSONA_TEST_SUPABASE_URL/rest/v1/personas?id=eq.<persona_id>" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d '{
    "last_tested_at": "<now ISO timestamp>",
    "last_verdict": "<verdict>",
    "last_focus": "<focus or null>",
    "test_count": <previous_count + 1>
  }'
```

After saving, check for prior sessions on the same URL:

```bash
curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/persona_test_sessions?url=eq.<url>&order=created_at.desc&limit=3" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
```

If prior sessions exist, output a brief **SESSION HISTORY** note:

```
SESSION HISTORY (last 3 runs on this URL)
  2026-04-10 — "new user on desktop" → Needs work (P0:2 P1:3)
  2026-04-12 — "power user" → Needs work (P0:1 P1:2)
  2026-04-14 — "first-time user on mobile" → Blocked (P0:3 P1:1)  ← this session

RECURRING ISSUES (appeared in 2+ sessions):
  • [P1] .search-results — no loading state (3 sessions)
  • [P0] #submit-btn — unresponsive on mobile (2 sessions)
```

This surfaces patterns the user may not have noticed across separate test sessions.

If Supabase vars are not set, skip Phase 6 silently — do not warn the user.

---

## Engineering Skills Interplay

This skill is designed to work alongside the skills in `Lbstrydom/claude-engineering-skills`.
Each integration point is optional — the skill degrades gracefully when sibling skills aren't present.

### /ship — Pre-Push UX Gate

Before committing and pushing, `/ship` can surface unresolved persona P0s as a non-blocking
warning. If `PERSONA_TEST_SUPABASE_URL` and `PERSONA_TEST_REPO_NAME` are set, `/ship` should:

1. Query for P0s from the last 7 days for this repo:
   ```bash
   curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/persona_test_sessions?repo_name=eq.<repo>&p0_count=gt.0&order=created_at.desc&limit=1" \
     -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
     -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
   ```
2. If recent P0s exist, add to `status.md` session log:
   ```markdown
   ### UX Status
   ⚠ 2 unresolved P0s from persona test 3 days ago (Pieter, "adding a bottle")
   Resolve before next user-facing release.
   ```
3. This is **non-blocking** — `/ship` continues. P0s are a signal, not a gate.

The persona debrief (`debrief_md`) from the most recent session can also be appended
to `status.md` as a "User Perspective" section, giving the commit history a qualitative
layer alongside the technical change log.

### /plan-backend + /plan-frontend — Pre-Plan Context

When planning a new feature, both plan skills benefit from knowing what persona tests
have already found in that area. At the start of Phase 1 (codebase exploration), if
`PERSONA_TEST_SUPABASE_URL` is set, they should query:

```bash
# Get findings related to the feature area being planned
curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/persona_test_sessions?repo_name=eq.<repo>&order=created_at.desc&limit=5&select=persona,focus,verdict,findings,debrief_md" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
```

Filter for sessions whose `focus` overlaps with the feature being planned. Inject matching
P0/P1 findings into the "Context Summary" section as **known user-visible pain points**.

This prevents the plan from re-solving already-discovered UX problems, and raises
priority on code paths that persona testing has flagged as fragile.

### /audit-loop — Gemini Arbiter Context

In the final review step (Step 7), the Gemini arbiter receives a transcript of all
Claude-GPT deliberations. If `PERSONA_TEST_SUPABASE_URL` is set, append to that transcript:

```json
{
  "persona_test_context": {
    "recent_p0s": [...],
    "recurring_issues": [...],
    "last_verdict": "Needs work"
  }
}
```

This gives Gemini the signal that certain code findings have **confirmed user-visible
symptoms** — not just theoretical concerns. A code finding that maps to a persona P0
should be treated as higher-priority than one that has never surfaced in user testing.

Conversely, a dismissed audit finding that has a persona P0 counterpart should be
**re-examined** — the dismissal may have been premature.

### /ship → status.md Persona Section Template

When `/ship` detects a recent persona session, append this block to `status.md`:

```markdown
### Persona Test Status — <date>
- **Last run**: <persona> on <url> (<N> days ago)
- **Verdict**: <verdict>
- **P0s**: <n> | **P1s**: <n>
- **Top finding**: <P0 or P1 description>
- **Debrief**: <first 100 words of debrief_md>...
```

### skills.manifest.json Registration

When this skill is added to `Lbstrydom/claude-engineering-skills`, add to `skills`:

```json
"persona-test": {
  "path": "skills/persona-test/SKILL.md",
  "summary": "Persona-driven exploratory browser testing. Plan→Act→Reflect loop, P0-P3 findings with confidence scoring, qualitative debrief, Supabase session memory, cross-references audit-loop findings."
}
```

---

## Reminders

- **You are the persona** — every click, every judgement comes from their perspective and
  goals, not from a developer's knowledge of the codebase
- **Plan before every action** — impulsive clicking misses the persona's natural flow
- **Reflect after every screenshot** — the Reflect step is where findings are born
- **Confidence score every finding** — below 0.6 means you're not sure enough to report it
- **Screenshot every step** — never analyse what you cannot see
- **Be specific in findings** — "button looks bad" is useless; "CTA [7] has no hover state on mobile 390px" is actionable
- **Narrate while exploring** — the user needs progress visibility during the session
- **The verdict matters** — be honest about OVERALL; it drives whether the user ships or fixes
