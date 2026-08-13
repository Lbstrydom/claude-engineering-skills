---
name: persona-test
description: |
  Persona-driven exploratory browser testing against a live URL.
  Drives a browser as a specific user persona using a Plan → Act → Reflect loop,
  takes screenshots at each step, analyses UX and functional issues with
  confidence scoring, and returns a structured P0–P3 severity report plus a
  qualitative persona debrief. Personas are tracked per app URL (list/add
  subcommands); pair mode runs two opposed personas back-to-back; consistency
  mode runs a deterministic code-driven canary. Use for exploratory QA against
  deployed apps — not scripted regression tests. Works with Playwright MCP
  (preferred — free, no credentials) or BrightData Scraping Browser (for external/anti-bot sites).
  Triggers on: "persona test", "test as", "explore the app as", "run persona
  test", "test the site as", "browse the app as", "QA as", "list personas",
  "add persona", "who are my personas", "which persona should test".
  Full command syntax: see the Usage section in this skill.
---

> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. Detail:
> `docs/runbooks/consumer-adoption.md` §"Linked git worktrees".

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
| `AUDIT_DB_URL` | Cloud store on — saves sessions, reads history, and (with a repo name) cross-references audit findings. One Postgres store backs every feature post-M4. |
| `PERSONA_TEST_REPO_NAME` | Enables audit-loop cross-reference (`audit_link = true`) |

**Do NOT read `AUDIT_DB_URL` from the Claude Code session's `process.env`.** The
consumer repo's `.env` (and the shared `~/.audit-loop.env`) are not loaded into
the session, so a bare env check reports false negatives — the var looks unset
even when cloud is fully configured, and the session silently runs stateless.
`cross-skill.mjs` resolves config itself (it loads `.env` + the shared file via
`config.mjs`); the pre-flight probe must go through it rather than reading
`process.env` directly.

Run this probe from the consumer-repo root (the same cwd used for every
`node scripts/cross-skill.mjs` call) — `whoami` reports the real cloud state
via `isCloudEnabled()` (an actual pool-presence check, not an env guess):

```bash
node scripts/cross-skill.mjs whoami
```

Set `memory_enabled = .cloud` from the probe's JSON output. `audit_link =
.cloud && repo_name` — it additionally requires a resolved `repo_name` (the
`PERSONA_TEST_REPO_NAME` env value, or git remote — see Phase 0c). When `cloud`
is false the skill runs in "stateless" mode — tests complete but nothing is
saved or cross-referenced.

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

**If the target requires login for its primary surfaces** (not just an
optional account page), check whether the MCP session is already
authenticated (e.g., landing on a logged-in view instead of a login
form) before assuming a login wall will block the run. If it isn't, and
this is a repeat session against the same app, ask whether a
`--storage-state` bootstrap has been set up for it — see
`references/auth-bootstrap.md`. This is a **one-time per-session setup
step**, not something to attempt mid-exploration (see Phase 3's login-wall
special case for what happens when no bootstrap exists).

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

`browser_resize` (the per-call MCP tool used in Step 1a.2) changes only
the visual viewport. It does **not**:

- Inject a mobile user-agent at the network layer.
- Fire real touch events — synthesised clicks may remain mouse events;
  touch-only handlers (`touchstart` without `click` fallback) may not trigger.
- Change `navigator.maxTouchPoints` or pointer-type media queries.
- Apply device-pixel-ratio scaling that affects `@media (resolution: ...)`.

**Note this is a per-tool-call limit, not a hard ceiling on the MCP
session.** The Playwright MCP *server* itself accepts `--device <name>`,
`--mobile`, and `--user-agent <string>` launch flags (`npx @playwright/mcp
--help`), which apply Playwright's real device descriptor (UA string, DPR,
`hasTouch`) for the whole session via `.mcp.json` — a heavier, session-wide
lever that doesn't require switching modes. It has real limits of its own,
though: it's static once the server connects (can't switch devices between
Plan→Act→Reflect steps, and pair mode's two personas share one connection —
see "Pair-mode interaction" below), and whether the MCP's click/tap tool
implementations actually dispatch genuine touch events under `hasTouch:
true` is worth verifying empirically before relying on it, not assumed from
the flag's existence.

For per-step device switching, geolocation, or network throttling — or
if the empirical check above shows synthesised events still aren't real —
use `--mode consistency` (code-driven Playwright with launch context) and
write a consistency canary instead.

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

**`severity` is load-bearing, not a label** — it must be the literal string
`"P0"`, `"P1"`, `"P2"` or `"P3"`, and it is the field the auto-correlator
(Phase 6b) filters on to decide what reaches `persona_audit_correlations`.
A finding that spells it anything else is silently uncorrelatable; the
correlator reports `p0p1-shape-mismatch` when your declared counts and this
field disagree.

### Special cases

- **404 / page-not-found** → 1 retry after 5s; if still 404, emit P0 "Target URL unreachable" and stop
- **Login wall** → if an auth bootstrap was expected but the session still
  landed on a login form (misconfigured/expired `storageState` —
  `references/auth-bootstrap.md`), emit **P1** "Auth bootstrap did not
  authenticate the session" (this is a setup regression, not a normal
  gap). Otherwise (no bootstrap was ever configured for this app), emit P3
  "App requires login; test scope limited to public surface", continue
  with public pages only, and set `authWallUntested = true` for Phase 4 —
  this run did **not** cover the app's primary authenticated surfaces, and
  the report must say so even when it finds 0 P0s there.
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
Authoritative spec: [docs/reference/consistency-contract.md](../../docs/reference/consistency-contract.md).

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

**Gate-honesty rule for `authWallUntested`**: 0 P0 findings on an
`authWallUntested` run means "0 P0s on the public shell", not "0 P0s on
the app". OVERALL must never read `Ready for users` in this case — cap it
at `Needs work` (see Phase 5) so a downstream consumer (`/cycle` Step 5)
can't read this run as a clean pass on a surface it never reached. This
mirrors click-test's rule that the OVERALL verdict caps at `Incomplete`
when any route is `auth-required` — same failure mode, same fix.

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

If `authWallUntested = true` (Phase 3 special cases), OVERALL is capped at
`Needs work` regardless of finding count, with a reason naming the gap
explicitly, e.g.:

```
OVERALL: Needs work
  Reason: Primary authenticated surfaces untested — login wall hit, no
          auth bootstrap configured (see references/auth-bootstrap.md).
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

**Do NOT build a session ID yourself.** Omit `sessionId` and the CLI mints a
collision-resistant one (`buildPersonaSessionId` — unix seconds + a
`crypto.randomUUID()` suffix) and returns it as `sessionKey`. The old hand-built
`persona-test-<unix timestamp>` shape collided across repos in the same second
and silently overwrote the other repo's session. Pass `sessionId` explicitly
ONLY to re-post an existing session (it is the idempotency key).

Record the session + trigger secondary persona stats update in one call:

```bash
node scripts/cross-skill.mjs record-persona-session --json '{
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
  "personaId": "<persona_id or null>",
  "clickPath": <JSON array — the path you walked; see "Building clickPath" below>
}'
```

### Building `clickPath` (reachability evidence for `/nav-audit`)

Across the Plan → **Act** → Reflect loop, accumulate **one entry per Act step** that
*moved or activated something* (click / navigate / open / submit) — this is the
path the persona actually reached, which `/nav-audit --bootstrap` seeds its contract
from. Each entry:

```json
{ "step": <1-based step number>,
  "action": "click|navigate|type|fill|select|hover|scroll|press|submit|wait",
  "url": "<the page URL AFTER the step settled>",
  "targetText": "<visible label of the control you acted on, ≤80 chars, or null>" }
```

- **NEVER include typed input values.** `targetText` is the control's *visible
  label* (e.g. "Add bottle", "Cellar"), never what you typed. The store rejects any
  entry carrying a `value`/`input` key and sanitizes the URL + redacts `targetText`
  server-side — but don't send secrets in the first place.
- Omit the field entirely (don't send `[]`) if you didn't track a path — re-posting
  a session with `clickPath` omitted preserves any path already recorded.
- The store caps the stored path at 40 steps and drops malformed entries; you don't
  need to pre-trim, but keep it to the meaningful navigation steps.

Response `{"ok": true, "cloud": ..., "sessionId": "<uuid>", "sessionKey":
"<persona-test-…>", "existed": bool, "statsUpdated": bool,
"correlationSummary": {...}}`. `sessionId` is the row's uuid PK — that is the
one later phases pass as `personaSessionId`. `sessionKey` is the minted
`session_id` text, needed only to re-post this same session.
If `statsUpdated: false`,
log a stderr warning — session is preserved; stats self-heal on the next
reconciler run.

---

## Phase 6b — Verify the Correlation Summary (automatic — do NOT re-emit)

**As of 2026-07-13 this step is deterministic, not agent-discretionary.**
`record-persona-session` (Phase 6) runs the correlator automatically —
immediately after the session commits, matching every P0/P1 finding against
recent audit findings for the repo and writing `persona_audit_correlations`
rows itself. There is nothing to emit here; **do not call `record-correlation`
per finding** — that CLI now exists only for manual repair (see below), and
calling it redundantly for a finding the auto-correlator already wrote will
just leave a second, identical row (or, for a genuinely different
`auditFindingId`, a legitimate additional manual correlation — see the
schema's multi-row-per-pair note in `references/audit-correlation.md`).

Your only job this phase: **read `correlationSummary` from the Phase 6
response and report it** (echo the counts into the session's debrief/report —
this is the visibility the mechanism depends on). Shape:

```json
{
  "attempted": true,
  "reason": null,
  "candidates": 4,
  "exact": 0, "fuzzy": 2, "missed": 1,
  "skippedExisting": 0,
  "malformed": 0,
  "writeFailed": 0,
  "matcherVersion": 1
}
```

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
not evidence of an audit miss — never treat it as one). `malformed > 0` means
some P0/P1 findings were missing `element`/`observed` and were quarantined —
never hashed or matched (a missing-field finding degrading to a shared empty
identity would collide with every other malformed finding, corrupting ground
truth — quarantine is correct, not a bug). `writeFailed > 0` is the one state
worth flagging loudly in the debrief (a real DB write failed for some
findings; already logged to stderr by the correlator).

### Manual repair — only for genuine corrections

Use `record-correlation` **only** to:
1. **Repair a false auto-emitted `audit_missed`** into a real match (the
   auto-correlator's keyword matcher has real recall limits — a paraphrased
   symptom description can miss a real audit finding it should have
   matched). The store automatically retires the stale `audit_missed` row
   when you supply a real `auditFindingId` — you never need to clean it up
   yourself.
2. **Emit `audit_false_positive` or `severity_overstated`** — these require
   human judgment (a flagged issue that couldn't be reproduced) and are
   never auto-emitted.

The finding-hash contract is unchanged in spirit but the ALGORITHM changed
(2026-07-13): `personaFindingHash()` now lives in
`scripts/lib/persona/audit-correlator.mjs` — see the updated formula in
`references/audit-correlation.md` (the old `sha256(element+observed+code)`
inline formula is retired; compute it the same way the auto-correlator does
so a manual repair's hash matches the auto-emitted row it's correcting).

**When one of the two repair cases above applies, run exactly one command per
finding being corrected** (canonical contract, so the hash matches the audit
side byte-for-byte — `personaFindingHash()` is the single source). **Never
inline free text into a shell-quoted `--json '...'` string** — `matchRationale`
and other text fields come from model-composed or persona-observed prose that
can contain quotes or shell metacharacters. Always write the payload to a
temp JSON file and pipe it via `--stdin` (same convention as `/brainstorm`):

```bash
cat > /tmp/correlation-repair.json <<'EOF'
{
  "personaSessionId": "<sessionId from Phase 6>",
  "personaFindingHash": "<personaFindingHash() of the persona finding>",
  "personaSeverity": "P0|P1",
  "auditFindingId": "<matching audit_findings.id, or omit if none>",
  "auditRunId": "<the matched run id, or omit>",
  "correlationType": "confirmed_hit | audit_missed | severity_understated | audit_false_positive | severity_overstated",
  "matchScore": 0.0,
  "matchRationale": "<one line>"
}
EOF
node scripts/cross-skill.mjs record-correlation --stdin < /tmp/correlation-repair.json
```

- Idempotent: the writer dedupes on `(persona_session_id, persona_finding_hash,
  audit_finding_id)`, so re-running is safe. Supplying a real `auditFindingId`
  for a hash that previously auto-emitted `audit_missed` automatically retires
  that stale NULL-match row — no separate cleanup step.
- Do **not** loop this over every P0/P1 finding — the automatic correlator
  (Phase 6) already covers the normal case. Only run this for a finding that
  needs one of the two repair cases above.

Full classification rules + reverse-direction (audit false positives) protocol:
`references/audit-correlation.md`.

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
| `references/audit-correlation.md` | Pre-test audit enrichment + post-test persona↔audit correlation emission — full rules. | `audit_link = true` AND (Phase 0d fetches audit candidates OR Phase 6b's manual-repair path is needed). |
| `references/browser-tool-detection.md` | Full browser-tool detection algorithm with tier priority, fallback rules, and Windows caveats. | Phase 1 tool selection fails on first try, OR the user is on Windows and Playwright MCP tools aren't appearing. |
| `references/auth-bootstrap.md` | Sanctioned pattern for auth-gated exploratory testing via MCP-server storageState, not in-session injection. | Phase 1 detects a login-gated target, OR Phase 3 hits a login wall and no auth bootstrap is configured. |
| `references/consistency-mode.md` | Full consistency-mode grammar, manifest schema, canary schema, runner exit codes, contradiction kinds. | Phase 3b runs (i.e., `--mode consistency` was passed) and you need the full grammar reference; OR the user asks how the rig decides severity / coercion / negative-space. |
| `references/persona-debrief-format.md` | Full persona debrief generation rules, tone guide, and output wrapper. | About to write the Phase 5b debrief. |
| `references/session-history.md` | Post-session history readback — recurring-issue surface + cross-session pattern detection. | Phase 6c runs AND Supabase is configured. |
| `references/interop.md` | How persona-test interacts with /ship, /plan, and /audit-code/audit-plan — integration contracts. | User asks about cross-skill effects, OR a sibling skill needs to reference persona-test data. |
| `examples/report-and-debrief.md` | Sample full persona-test output — structured report + debrief fences and example content. | About to emit Phase 5 + 5b output and unsure of the exact fence format. |
