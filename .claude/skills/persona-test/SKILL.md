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
---

# Persona-Driven Browser Testing

Run an exploratory browser test with persona tracking. Check `$ARGUMENTS`
first to pick the sub-command.

---

## Phase 0 — Route the Command

Read the first word of `$ARGUMENTS`:

- `list` → **Sub-command: LIST**
- `add` → **Sub-command: ADD**
- contains `--pair` anywhere → **Sub-command: PAIR** (see Phase 7 at the end)
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
3. **focus** — any remaining text after the URL (strip out flag tokens before assigning)
4. **device_override** — value of `--device <preset>` if present (must be one of:
   `desktop`, `desktop-large`, `tablet`, `mobile`, `mobile-small`). Unknown
   preset → fail with usage. Drives Phase 1a's explicit-override branch.

Required: `persona_input` + `url`. If either is missing, output usage and STOP.

### Pre-flight environment check

| Env var | Purpose |
|---|---|
| `PERSONA_TEST_SUPABASE_URL` + `..._ANON_KEY` | Memory enabled — saves sessions, reads history |
| `PERSONA_TEST_REPO_NAME` | Enables audit-loop cross-reference (`audit_link = true`) |
| `SUPABASE_AUDIT_URL` + `SUPABASE_AUDIT_ANON_KEY` | Audit-loop DB — used by Phase 0d pre-test enrichment |

**Do NOT read these from the Claude Code session's `process.env`.** The
consumer repo's `.env` is not loaded into the session, so a bare env check
reports false negatives — the vars look unset even when they exist, and the
session silently runs stateless. `cross-skill.mjs` loads `.env` itself via
`dotenv/config`; the pre-flight probe must do the same.

Run this probe from the consumer-repo root (the same cwd used for every
`node scripts/cross-skill.mjs` call):

```bash
node -e "import('dotenv/config').then(()=>console.log(JSON.stringify({memory_enabled:!!(process.env.PERSONA_TEST_SUPABASE_URL&&process.env.PERSONA_TEST_SUPABASE_ANON_KEY),audit_link:!!(process.env.SUPABASE_AUDIT_URL&&process.env.SUPABASE_AUDIT_ANON_KEY),repo_name:process.env.PERSONA_TEST_REPO_NAME||null})))"
```

Set `memory_enabled` and `audit_link` from the probe's JSON output. `audit_link`
additionally requires a resolved `repo_name` (probe value, or git remote — see
Phase 0c). When both flags are off, the skill runs in "stateless" mode — tests
complete but nothing is saved or cross-referenced.

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

## Phase 1a — Device Profile Resolution (MANDATORY)

A persona who describes themselves as "mobile-first" or "tablet user" must
be tested in that viewport — otherwise responsive bugs, mobile-only CTAs,
narrow-width overflow, and touch-target sizing are silently invisible.
The resolver lives at [`scripts/lib/device-presets.mjs`](../../scripts/lib/device-presets.mjs)
— it keyword-matches the persona's description against five presets
(desktop, desktop-large, tablet, mobile, mobile-small) and falls back to
desktop when no cue is present.

### Step 1a.1 — Get the device contract (MANDATORY; do not skip)

Skip ONLY when `browser_tool = "WebFetch (degraded)"` (no viewport concept).
Otherwise, this is non-negotiable — the LLM does not pick the device.

Run from the consumer-repo root:

```bash
node scripts/lib/device-presets.mjs prep "<persona.description or ad-hoc persona_input>" [--device <override-preset>]
```

Pass `--device <preset>` only when `$ARGUMENTS` contained an explicit
`--device` flag (Phase 0b item 4). The CLI returns a JSON contract:

```json
{
  "kind": "persona-test-prep",
  "version": 1,
  "device": { "name": "mobile", "viewport": {"width": 390, "height": 844}, "isMobile": true, "hasTouch": true, ... },
  "expectedFirstMcpCall": { "tool": "browser_resize", "args": {"width": 390, "height": 844} },
  "personaMentalModelTags": ["mobile-viewport", "thumb-reach", ...],
  "logLine": "[device-profile] mobile-first → mobile (390x844, touch=true)"
}
```

**Echo the `logLine` verbatim to stderr.** This is the audit trail — if
the device choice is later questioned, the line in the transcript proves
which preset was applied.

### Step 1a.2 — Execute `expectedFirstMcpCall` verbatim

Call `browser_resize` with the args from `expectedFirstMcpCall.args` —
**before Phase 1b's first `browser_navigate`**. Do not modify the args;
do not pick your own dimensions. If the contract said `{width: 390,
height: 844}`, that's what you call.

Resizing mid-session does not retroactively change media queries that
fired on the initial render — order matters.

### Step 1a.3 — Apply `personaMentalModelTags` to Phase 2

When `device.isMobile === true`, the contract's `personaMentalModelTags`
array carries implicit constraints (`thumb-reach`, `one-handed`,
`distracted-attention`, `slow-network-assumption`). Apply these to
Phase 2's persona mental model **silently** — they shape Reflect
scoring (downgrade desktop-hover findings, upgrade thumb-reach
findings), but do NOT leak into Phase 5b's first-person persona voice.
A real mobile user doesn't narrate "I'm on mobile so I…" — they just
behave that way. The device is a runner-side fact, not persona dialogue.

### Limits — what viewport-only emulation does NOT cover

`browser_resize` changes the visual viewport. It does **not**:

- Inject a mobile user-agent at the network layer (server-side UA
  sniffing still sees Chromium desktop).
- Fire real touch events — synthesised clicks remain mouse events;
  touch-only handlers (`touchstart` without `click` fallback) won't trigger.
- Change `navigator.maxTouchPoints` or pointer-type media queries.
- Apply device-pixel-ratio scaling that affects `@media (resolution: ...)`.

For full emulation — proper touch events, UA injection, DPR-correct
rendering, geolocation, network throttling — use `--mode consistency`
(code-driven Playwright with launch context). The exploratory loop
trades fidelity for narrative coverage; if a bug depends on real touch
events or UA-sniffed server responses, write a consistency canary.

### Pair-mode interaction

In `--pair` mode (Phase 7), each persona gets its own device resolution.
Persona A may run in mobile while persona B runs in desktop — that's
intentional cross-device coverage. The pair report (Step P5) records
both devices in the header.

---

## Phase 1b — Service-worker cache-bust (MANDATORY for own apps)

Service workers silently serve stale bundles. A fix that *is* deployed
appears to "not be deployed" because the SW handed the persona last week's
JS. This was a real failure mode in wine-cellar-app — burned ~30min of
verification before we realised. Always cache-bust before the first action.

Skip when `browser_tool = "WebFetch (degraded)"` (no JS context). Skip when
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

## Phase 3b — Consistency Mode (deterministic, code-driven)

> Triggered by `--mode consistency`. **This is a completely different
> execution model from the exploratory loop above.** When `--mode consistency`
> is set, the LLM does NOT drive the browser — you delegate to the
> deterministic runner which owns Playwright directly. Skip Phases 1-3 and
> Phases 4-6 above; consistency mode has its own flow below.

Use this mode to detect cross-step UI/state contradictions (the engine says
"infeasible" but a CTA says "Reorganise") against a registered canary journey.
Authoritative spec: [docs/consistency-contract.md](../../docs/consistency-contract.md).

### Step C1 — Validate inputs

Required: `--mode consistency` + `--canary <name>` + URL. If any missing,
print usage and STOP.

### Step C2 — Delegate to the runner

```bash
node scripts/persona-consistency-run.mjs \
  --canary <name> \
  --url <url> \
  [--out .persona-test/sessions/<SID>.json]
```

The runner:
1. Resolves `surfaces.json` from `.persona-test/` → `<repo-root>/` → `src/` (first match wins).
2. Loads `.persona-test/canaries/<name>.json` and validates against `CanaryDefinitionSchema`.
3. Drives Playwright through `canary.journeySteps[]` deterministically (no LLM in the loop).
4. Captures `{surfaceClaims, networkClaims}` synchronously per step via `scripts/lib/ux-lock/capture.mjs`.
5. Diffs DOM vs network ground truth via `scripts/lib/persona-test/consistency.mjs`.
6. Emits candidate `regression_specs` rows for P1+ contradictions (fingerprint-upserted).
7. Verifies the canary's `expectedContradictions` and decides the exit code.

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

Render this fence to stdout:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CONSISTENCY MODE REPORT
  Canary: <name>
  URL: <url>
  Verdict: <healthy | broken | partial | fatal | app-error>
  Exit: <code>
  Contradictions: <n>   Candidates emitted: <n>   Warnings: <n>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINDINGS
────────────────────────────────────────────────────
  [<severity>] <kind> at <surfaceId>.<engineField>
     DOM:      <value>   (data-freshness="<freshness>")
     Engine:   <value>
     Selector: <selector>
     Detail:   <one-line>
  ...

OVERALL: <one-line verdict>
```

Sort findings by severity (P0 first), tie-break by surfaceId. If the canary
verdict is `broken`, lead with a one-line callout above the report:

```
⚠ RIG BROKEN — canary expected min:N contradictions, found M.
  Manifest drift or attribute regression suspected — fix before next run.
```

### Step C5 — Skip the persona debrief

Consistency mode does NOT produce a Phase 5b debrief. The exit code + the
findings fence is the entire report. Don't generate first-person narrative
— consistency mode is rig output, not persona perception.

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

## Phase 7 — Pair Mode (--pair)

Triggered by `--pair "<p1>" "<p2>"` anywhere in `$ARGUMENTS`. Skip Phases
0b–6c above and follow the flow below.

**Why pair mode exists**: two personas of opposed expertise surface disjoint
findings — in the wine-cellar-app session that motivated this feature,
Elena (sommelier) and Martha (newer drinker) overlapped on exactly 1 of
~12 findings. Solo runs miss half the issues an opposed-expertise pair
catches. Pair mode formalises that.

### Step P1 — Parse pair arguments

Parse from `$ARGUMENTS`:
1. **persona_a** — first quoted string after `--pair`
2. **persona_b** — second quoted string
3. **url** — URL in remaining args (or `PERSONA_TEST_APP_URL` env)
4. **focus** — anything after the URL

Required: both personas + url. If missing, output usage and STOP.

### Step P2 — Run persona A end-to-end

Run **Phases 0c → 6c** for persona A as if it were a solo run. Capture:
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

After both solo reports (printed in full so the reader sees per-persona
context), append:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PAIR DIFF — <persona_a> ∥ <persona_b>
  URL: <url>
  Focus: <focus or "exploratory">
  A device: <preset_a> <WxH>   B device: <preset_b> <WxH>
  A verdict: <verdict_a>   B verdict: <verdict_b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CONSENSUS (<n>) — both personas saw these
────────────────────────────────────────────────────
  [P<n>] <title>
     A's framing: <observed_a — first 80 chars>
     B's framing: <observed_b — first 80 chars>
     Fix: <merged fix or A's if identical>

A-ONLY (<n>) — caught by <persona_a>'s expertise
────────────────────────────────────────────────────
  [P<n>] <title> — <observed_a — first 100 chars>
  ...

B-ONLY (<n>) — caught by <persona_b>'s expertise
────────────────────────────────────────────────────
  [P<n>] <title> — <observed_b — first 100 chars>
  ...

COVERAGE METRIC
────────────────────────────────────────────────────
  Overlap rate: <consensus / (consensus + a_only + b_only)>
  Interpretation:
    < 0.20  — Strong disjoint coverage. Both personas were the right call.
    0.20–0.50 — Healthy mix of consensus + coverage.
    > 0.50 — High overlap. Consider picking more dissimilar personas next time.

OVERALL: <Ship | Needs work | Blocked>
  Reason: <one sentence — usually driven by max(verdict_a, verdict_b)>
```

### Step P6 — Skip the secondary debrief

Each solo run already produced a Phase 5b debrief. Don't generate a third
"pair debrief" — the two debriefs side-by-side are the artefact. Pair mode
is about finding-level diff, not narrative synthesis.

### Step P7 — Session linkage

When both `session_id_a` and `session_id_b` are non-null (memory enabled),
record the pairing:

```bash
node scripts/cross-skill.mjs link-persona-pair --json '{
  "sessionA": "<session_id_a>",
  "sessionB": "<session_id_b>",
  "consensusCount": <n>,
  "aOnlyCount": <n>,
  "bOnlyCount": <n>,
  "overlapRate": <0-1>
}'
```

Graceful no-op if the subcommand doesn't exist yet — log one stderr line
and continue. The pair report on stdout is the authoritative artefact.

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
| `references/consistency-mode.md` | Full consistency-mode grammar, manifest schema, canary schema, runner exit codes, contradiction kinds. | Phase 3b runs (i.e., `--mode consistency` was passed) and you need the full grammar reference; OR the user asks how the rig decides severity / coercion / negative-space. |
| `references/persona-debrief-format.md` | Full persona debrief generation rules, tone guide, and output wrapper. | About to write the Phase 5b debrief. |
| `references/session-history.md` | Post-session history readback — recurring-issue surface + cross-session pattern detection. | Phase 6c runs AND Supabase is configured. |
| `references/interop.md` | How persona-test interacts with /ship, /plan-*, and /audit-loop — integration contracts. | User asks about cross-skill effects, OR a sibling skill needs to reference persona-test data. |
| `examples/report-and-debrief.md` | Sample full persona-test output — structured report + debrief fences and example content. | About to emit Phase 5 + 5b output and unsure of the exact fence format. |
