---
name: click-test
description: |
  Structural DOM audit of a live app — walk every interactive element and
  assert semantic-HTML contracts (duplicate IDs, orphan labels, inputs without
  names, ARIA misuse, heading hierarchy, missing alt text, undersized touch
  targets). Complements /persona-test: persona-test catches narrative UX issues
  a real user would hit; click-test catches structural issues that hide in
  JS-rendered surfaces and silently break assistive tech, form submissions, or
  React reconciliation. Drives a browser via the shared driver contract; optional
  --with-modals opens each modal/dropdown and rescans; device presets and
  matrix mode cover responsive breakpoints.
  Triggers on: "click test", "click-test", "structural audit", "DOM audit",
  "accessibility audit", "duplicate ID check", "walk every element",
  "audit the DOM", "structural QA", "/click-test".
  Full command syntax: see the Usage section in this skill.
---

> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. If this repo defines
> no such script, add it from `references/worktree-preflight.md`.

## Usage

```
Usage:
  /click-test <url>                                         — scan the URL's initial render (default device: desktop)
  /click-test <url> --routes "/a,/b,/c"                     — scan multiple routes
  /click-test <url> --with-modals                           — also open + scan each modal/dropdown
  /click-test <url> --scope a11y|forms|ids|all              — focus the assertion set (default: all)
  /click-test <url> --device <preset>                       — run in a specific device preset
  /click-test <url> --devices "<p1>,<p2>,..."               — matrix mode: run in each preset, merge findings
Device presets: desktop (default) | desktop-large | tablet | mobile | mobile-small
Examples:
  /click-test http://localhost:3000
  /click-test https://myapp.railway.app --routes "/,/cellar,/admin"
  /click-test http://localhost:3000 --with-modals --scope a11y
  /click-test https://myapp.railway.app --device mobile                            — mobile only
  /click-test https://myapp.railway.app --devices "desktop,mobile" --with-modals   — cross-device coverage
```

# Click-Test — Structural DOM Audit

> **This skill's last line is an end marker naming the skill between em-dashes, after
> the Reference files table.** If that last line is not in your context (context
> compaction keeps only the start of a skill), re-read
> `.claude/skills/click-test/SKILL.md` in full before continuing — the later steps still apply.

Walk every interactive element on each target route and assert the structural
HTML contract. **Not a persona test** — the mechanical sibling of
`/persona-test`; run both, their findings rarely overlap.
→ `references/scan-rules-detail.md` §click-test vs /persona-test.

---

## Phase 0 — Parse Arguments

Parse `$ARGUMENTS`:

<!-- host-contract: input-acquisition; grammar=path+flags; empty=ask-and-stop -->

**Where `$ARGUMENTS` comes from** — orchestrator-supplied input first, else
the host's verbatim invocation suffix, else the span of the user's **current**
message naming this skill or its subject. Never inferred from surrounding
conversation. This site is `path+flags`; on empty input, a URL is required — ask for it and stop. Never reuse a URL from earlier in the conversation; scanning the wrong origin is a real action against someone's site.
Full contract: `references/input-acquisition.md`.

1. **url** — first URL-shaped token (or `PERSONA_TEST_APP_URL` env). Validate
   with `new URL(value)` — reject non-URL with usage error.
2. **routes** — `--routes "/a,/b,/c"` (comma-separated). When omitted, the
   default target is **the base URL itself** (preserves any path prefix —
   `https://host/app` is scanned, not `https://host/`). When provided, each
   token is resolved as `new URL(routeToken, base).href` — supports absolute
   routes, root-relative routes (explicit `/` means origin-root), and
   path-relative routes. Empty/whitespace tokens dropped. Duplicates after
   normalisation dropped. Examples:
   - `--routes` omitted, base `https://host/app` → scans `https://host/app`
   - `--routes "/"` against base `https://host/app` → scans `https://host/`
   - `--routes "settings"` against base `https://host/app/` → scans `https://host/app/settings`
3. **with_modals** — `--with-modals` flag (default: off)
4. **scope** — `--scope a11y|forms|ids|all` (default: `all`). Unknown value →
   fail with usage.
5. **ready_selector** — `--ready-selector "<css>"` (optional). Default:
   `[data-testid=app-ready], [data-click-test-ready=true]`. If neither
   attribute exists in the app, **pass an explicit selector** that
   uniquely identifies the loaded state — do not fall back to generic
   `main` / `#root` (those match on skeleton DOMs and produce false
   "scanned" verdicts on still-loading pages).
6. **ready_timeout_ms** — `--ready-timeout 8000` (default 8000).
7. **force_cache_bust** — `--force-cache-bust` flag (default: off, see Phase 2).
8. **max_triggers_per_route** — `--max-triggers 50` (default 50, Phase 4b only).
9. **device / viewport** — three mutually-exclusive ways to pick the viewport
   (and adjacent emulation flags). Specify at most one; supplying two → fail
   with usage:
   - `--device <preset>` — one of `desktop`, `desktop-large`, `tablet`,
     `mobile`, `mobile-small` (canonical registry:
     [`scripts/lib/device-presets.mjs`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/scripts/lib/device-presets.mjs)).
     Sets viewport + `isMobile` + `hasTouch` flags. Unknown name → fail.
   - `--devices "<p1>,<p2>,...">` — **matrix mode**. Each preset runs the full
     route crawl independently; findings are tagged with `device` and merged.
     Cost is multiplicative — be explicit, this is opt-in.
   - `--viewport <W>x<H>` — legacy direct viewport (W and H in `[320, 4096]`).
     Synthesises a `custom` device record with `isMobile/hasTouch` inferred
     from width (`<768 → mobile/touch`). Kept for back-compat; prefer `--device`.
   - None of the above → default device = `desktop` (1280×720). Identical to
     today's behaviour for callers passing nothing.

   The selected device is applied via a single `browser_resize` call before
   the first `browser_navigate` of each route (matrix mode resizes once per
   device-pass). UA emulation, real touch events, and DPR scaling are NOT
   provided — MCP browser drivers don't expose context-level launch options. For
   full emulation, use `/persona-test --mode consistency` (code-driven Playwright).

Required: `url`. If missing, output usage and STOP. Unknown flags → fail
with usage. Duplicate flags → last wins, log a stderr warning.

---

## Phase 0b — Run Contract (recorded in report)

Capture these defaults at the start of each session and include them
verbatim in the Phase 6 report so two runs against the same commit can be
compared:

| Field | Default | Override |
|---|---|---|
| Device | `desktop` (1280×720, touch=false) | `--device <preset>` / `--devices "<list>"` (matrix) / `--viewport WxH` (legacy) |
| Browser | whatever the selected driver provides (Playwright MCP = Chromium) | — |
| Locale / timezone | tool default (do NOT randomise) | — |
| Auth | none by default — public surface only | pre-authenticate the shared MCP session; see "Auth-gated routes" below |
| Network idle | wait for `load` + ready-selector or 8000ms | `--ready-timeout` |

**Auth-gated routes**: after each navigation, BEFORE running the static
scan, check:

1. **Cross-origin redirect** (OAuth / SSO): if `new URL(location.href).origin !==
   new URL(targetUrl).origin`, classify as `coverageStatus: "auth-required"`
   regardless of DOM content. Catches OAuth providers (Google, Okta, Auth0)
   that redirect to a third-party domain — never scan accessibility of those
   pages and attribute findings to the audited app.
2. **Same-origin password form**: if URL is same-origin AND DOM contains
   `[type=password]`, classify as `coverageStatus: "auth-required"`. Catches
   first-party login walls.

click-test does not log in itself. If primary surfaces need a login,
pre-authenticate the shared driver connection via `--storage-state` before
running — see [`references/auth-bootstrap.md`](references/auth-bootstrap.md).
The OVERALL verdict
becomes at most `Incomplete` (never `Clean`) when any route is
`auth-required`.
→ `references/scan-rules-detail.md` §Auth-gated routes — read when a target is login-gated.

---

## Phase 1 — Detect Browser Tool

Resolve the driver through the **one detection oracle** —
[`references/browser-tool-detection.md`](references/browser-tool-detection.md).
Do not restate its ladder here; click-test declares only what it needs.

**Minimum capability set**: `navigate`, `evaluate`, `click`, `keyboard`
(Escape press), `wait`, `currentUrl`. Verify each before the first scan and log
the chosen driver plus the capabilities matched.

**`evaluate` is non-negotiable and it is what excludes static drivers.** The DOM
scan *is* a `page.evaluate` call, so a fetch-and-parse driver can never serve
click-test however well it parses HTML. There is no degraded mode here: an unmet
set means abort before scanning with
`[BLOCKED] <driver> missing capability: <cap>` — never a clean empty pass, which
would report "no findings" from a page nobody scanned.

---

## Phase 2 — Pre-flight Cache-bust (own-app only by default)

Service workers silently serve stale bundles, masking real deploys. The
cache-bust is **mandatory for own-app hostnames**, where clearing user state
costs nothing. **For external URLs**: do NOT cache-bust by default — clearing
`serviceWorker` + `caches` on a third-party origin can log out the operator,
remove offline data, or alter the very state being measured. Require the
explicit `--force-cache-bust` flag — and even then, warn loudly on stderr.

| Hostname class | Default behaviour |
|---|---|
| Own-app (localhost / `*.railway.app` / `*.vercel.app` / `*.netlify.app` / `*.local`) | Cache-bust runs unconditionally |
| External | Skip cache-bust. `--force-cache-bust` overrides with stderr warning |
| Any driver without `evaluate` | Unreachable — click-test aborts `blocked` before this point (Phase 1) |

Cache-bust script (when it runs). Both APIs (`serviceWorker`, `caches`) can
be undefined globally in non-secure contexts (HTTP-only test URLs) —
referencing them throws `ReferenceError` BEFORE optional chaining is
evaluated. Always check `typeof` first:

```js
// browser_evaluate
(async () => {
  let unregistered = 0, cachesDeleted = 0;
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(regs.map(r => r.unregister().catch(() => {})));
    unregistered = regs.length;
  }
  if (typeof caches !== 'undefined') {
    const keys = await caches.keys().catch(() => []);
    await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
    cachesDeleted = keys.length;
  }
  return { unregistered, cachesDeleted };
})()
```

Then `browser_navigate(url)` again to force a fresh fetch. Log result:
`[cache-bust] unregistered <n> SW, cleared <n> caches (own-app)` or
`[cache-bust] skipped (external host; pass --force-cache-bust to override)`.

Record `cacheBustMode: "own-app" | "forced" | "skipped-external" | "n/a"`
in the run contract for the Phase 6 report.

---

## Phase 3 — Crawl Routes

### Get the device-pass contract (required; do not skip)

Before any browser work, call:

```bash
node scripts/lib/device-presets.mjs prep-matrix
```

Optional flags — add at most one, matching what your `$ARGUMENTS` contained (none if neither flag was passed): `--device PRESET`, `--devices "LIST"`, `--viewport WxH`.

<!-- host-contract: input-acquisition; grammar=path+flags; empty=default -->
_This site: `path+flags` — neither device flag present means a single `desktop` pass — do not synthesise a matrix._

The CLI returns `{kind: "click-test-prep", matrixMode, totalPasses, passes[]}`,
each pass carrying `device`, `expectedFirstMcpCall` and `logLine`
(→ `references/scan-rules-detail.md` §Device prep contract for the full shape).

The LLM does NOT pick device order, dimensions, or pass count — it walks
`passes` in array order, executing each `expectedFirstMcpCall` verbatim.
Mutual-exclusion conflicts (e.g. `--device` + `--devices`) cause the CLI
to exit non-zero with the error on stderr; surface that, do not proceed.

### Device pass loop

For each `pass` in `contract.passes` (in array order):

1. Echo `pass.logLine` to stderr.
2. Call `browser_resize` with `pass.expectedFirstMcpCall.args` verbatim
   — once per device-pass, BEFORE the first navigate.
3. Tag every finding from this pass with `device: pass.device.name`.
4. Run the per-route loop below.

Cache-bust (Phase 2) runs **once at session start**, not per device-pass —
service-worker state is global to the browser context.

### Per-route loop (within a device pass)

For each route in `routes`:

1. `browser_navigate({url: new URL(route, base).href})` — never string-concat
2. **Readiness protocol** (replaces vague "stable string" wait):
   a. Wait for `load` event (most MCPs do this implicitly on navigate).
   b. Poll: ready-selector matches AND `document.querySelector('[aria-busy="true"], [role="progressbar"]')` returns null.
   c. Timeout after `--ready-timeout` ms (default 8000).
   d. If timeout fires, classify the route as `coverageStatus: "readiness-timeout"`
      and skip its scan — do NOT scan a skeleton DOM.
3. **Route execution status** — independent of finding count. Record one of:
   - `scanned` — readiness met AND scanner output validated. (May still have findings.)
   - `auth-required` — landed on login (URL changed AND `[type=password]` present)
   - `navigation-error` — `browser_navigate` threw (rendered app-level 404/500 pages
     count as `scanned` unless the tool exposes a real response status and it's 4xx/5xx)
   - `readiness-timeout` — readiness selector never matched within timeout
   - `scanner-error` — `browser_evaluate` threw or returned schema-invalid shape
   - `skipped-external-anchor` — route resolved to a different origin
4. If state is `scanned`, run **Phase 4 — Static scan** (one pass per settled DOM state — see Reminders)
5. If `with_modals` AND state is `scanned`, run **Phase 4b — Dynamic-surface scan**
6. Record findings tagged with `{device, route, coverageStatus, via}`; record per-route
   element counts and dynamic-surface counts in the run metrics (Phase 4 schema).

---

## Phase 4 — Static Scan

`browser_evaluate` with the scanner from
[`references/dom-scanner.md`](references/dom-scanner.md). The scanner returns
a single result object — **validate before use** (a hostile or malformed
page could return anything from `browser_evaluate`):

```js
// pseudo-Zod (canonical contract — runner enforces, report consumes)
ClickTestFinding = {
  kind: enum("duplicate-id", "orphan-label", "input-no-name",
             "button-no-name", "link-no-name", "form-field-no-name",
             "duplicate-aria-label", "aria-hidden-focusable",
             "empty-link", "heading-skip", "img-no-alt",
             "small-touch-target", "positive-tabindex"),  // 13 kinds
  severity: enum("P0","P1","P2","P3"),   // EFFECTIVE severity — capped to P3 when !perceivable
  declaredSeverity: enum("P0","P1","P2","P3"),  // the kind's intrinsic severity, pre-cap
  perceivable: boolean,      // was the element RENDERED in the captured state?
  selector: string.max(500),
  snippet: string.max(200),  // outerHTML truncated; redact before persist
  detail: string.max(500),
  device: string,            // preset name ("desktop", "mobile", …) or "custom"
}
ClickTestScanResult = {
  schemaVersion: literal(1),
  routeUrl: string,                  // the final navigated URL
  device: string,                    // matches each finding's device tag
  elementsScanned: number,           // document.querySelectorAll('*').length at scan time
  interactiveElementsScanned: number, // count of button/a/input/select/textarea/[role=button|link]
  findings: ClickTestFinding[].max(999),  // reject >999 — flags scanner-error
  shadowGapCount: number,            // open shadow roots not traversed
  iframeGapCount: number,            // iframes not traversed
}
```

**Device-pass aggregation** (when `--devices` produces multiple device passes):
each finding's `device` field is set by the runner from the active pass — the
scanner does not need to know. Findings dedupe by `{device, route, via, kind, selector}` —
the same duplicate-id on `mobile` AND `desktop` is reported twice (correctly:
it's two regressions that may have different fix sites if responsive CSS
hides one). The Phase 6 report's PER-DEVICE COVERAGE table surfaces which
device flagged which.

`small-touch-target` is **device-sensitive**: when both desktop and mobile
passes ran, downgrade desktop-pass `small-touch-target` findings by one
severity (P2 → P3) — the mobile pass is the authoritative read.

If validation fails, classify the route as `coverageStatus: "scanner-error"`
and skip its findings — never persist or report unvalidated output.

**Per-route aggregation** when `--with-modals` produces multiple scan results
(one static + one per opened modal): the per-route record stores the static
scan's `elementsScanned` / `interactiveElementsScanned` as the route totals
(modals are subsets, not additions). For `shadowGapCount` / `iframeGapCount`,
take the **max** observed across passes (NOT sum — each modal pass re-scans
the whole DOM, so the static gaps would be double-counted). `findings` are
unioned and deduped by `{device, route, via, kind, selector}`.
Each finding's `via` field records its origin (`static` or `modal:<accessible-name>`).

**Redaction**: before printing or persisting any `snippet`, run it through
the existing redactor (`scripts/lib/redact.mjs::redact` for string-typed
content; use `redactObject` if the runner ever boxes the snippet inside a
larger payload). DOM `outerHTML` can contain emails, tokens in `data-*`
attributes, hidden form values, customer content. The default scanner
already truncates to 200 chars; redaction is the second layer.

### Finding taxonomy (canonical rule registry)

13 rules, 1:1 with the `kind` enum above:

| Kind | Default severity | In `ids` | In `forms` | In `a11y` |
|---|---|---|---|---|
| `duplicate-id` | P0 | ✓ | ✓ | ✓ |
| `orphan-label` | P0 | — | ✓ | ✓ |
| `input-no-name` | P0 | — | ✓ | ✓ |
| `button-no-name` | P0 | — | — | ✓ |
| `link-no-name` | P1 | — | — | ✓ |
| `form-field-no-name` | P1 / **P3 when the form has no `action`** | ✓ | ✓ | — |
| `duplicate-aria-label` | P2 *(see note)* | — | — | ✓ |
| `aria-hidden-focusable` | P1 | — | — | ✓ |
| `empty-link` | P1 | — | — | ✓ |
| `heading-skip` | P2 | — | — | ✓ |
| `img-no-alt` | P2 | — | — | ✓ |
| `small-touch-target` | P2 | — | — | ✓ |
| `positive-tabindex` | P2 | — | — | ✓ |

`button-no-name` and `link-no-name` are separate kinds (one rule per kind)
so the severity is unambiguous in the enum. The scanner emits one or the
other based on element type — never both for the same node.

`--scope all` → keep everything. `--scope <name>` → keep rows with `✓` in
that column. Invalid scope → fail with usage.

`duplicate-aria-label` note: high false-positive rate on grid/card layouts,
so the scanner only fires it within the same `role` + parent region.
→ `references/scan-rules-detail.md` §duplicate-aria-label FP note.

---

## Phase 4b — Dynamic-surface Scan (`--with-modals` only)

Modals mount duplicate IDs only while open, which the static scan cannot see
(→ `references/scan-rules-detail.md` §Why `--with-modals` exists).

### Trigger discovery (one evaluate per route, before clicking)

```js
// browser_evaluate — returns DiscoveredTrigger[]
// DiscoveredTrigger = { idx, selector, role, accessibleName, regionKey,
//                       destructiveReason: string|null, disabled: bool,
//                       href: string|null, formAction: string|null }
```

The runner stores this array, then iterates by `idx`. Before each click:

1. `browser_evaluate` re-queries by the stored `selector` — if it returns
   null or a different element (compared by `idx → selector → accessibleName`
   triple), skip with `coverageStatus: "trigger-stale"`.
2. If `destructiveReason` is non-null → skip with that reason.
3. If `disabled === true` → skip with `"disabled"`.
4. Otherwise proceed to click.

The trigger candidate set: `[aria-haspopup="true"], [data-modal-trigger],
button[aria-controls], [role="combobox"]`.

### Per-trigger flow

1. **Safety classifier** — skip if the trigger is destructive (see below)
2. **URL snapshot** — record `currentUrl` before click
3. `browser_click(<trigger>)`
4. Wait for modal mount: poll for `[role="dialog"]`, `<dialog[open]>`, or
   `aria-expanded="true"` on the trigger, up to 1000ms. Timeout → log
   "trigger opened nothing" and skip.
5. Re-run the scanner — tag findings with `via: "modal:<accessible-name>"`
6. Close: `Escape` key → if dialog still mounted, click `[aria-label="Close"]`
   inside it → if still mounted, click outside the dialog at `(8, 8)`.
7. **Verify closed AND URL unchanged** — if URL changed, treat as
   navigation side-effect: re-navigate to the route's URL **then re-run
   the Phase 3 readiness protocol** (don't assume the page is ready
   immediately after navigation). Resume the trigger loop only once
   readiness is met. If dialog still mounted after all 3 close attempts,
   log `coverageStatus: "modal-stuck"` for this route and stop the
   dynamic scan for that route.
8. Continue to next trigger until **`--max-triggers`** (default 50) reached.
   Excess triggers logged as `skipped: budget-exceeded`.

### Safety classifier — destructive-trigger filter

Skip a trigger if **any** of these match (case-insensitive, accent-folded):

- Accessible name (computed: `aria-label`, `aria-labelledby`, visible text,
  `title` — in that order) matches `/^(delete|destroy|remove|purge|reset|sign\s*out|log\s*out|cancel\s*subscription|deactivate|close\s*account|drop|truncate|wipe)/i`
- `data-destructive="true"` or `data-action` value matches the regex above
- `role="link"` with `href` pointing to a different origin or matching
  `/logout|signout|delete/i`
- Inside a form whose `action` matches the destructive regex
- `aria-disabled="true"` or `[disabled]` (don't click disabled controls)

Log each skipped trigger with reason: `skipped-destructive: <accessible-name> (matched: <pattern>)`.

**Deduplication**: two triggers are dupes when they share `(accessibleName, role, closest [role="dialog"]/section ancestor)`. Skip dupes after the first.

---

## Phase 5 — Severity Model

The authoritative severity-per-kind mapping is the Phase 4 taxonomy table.
→ `references/scan-rules-detail.md` §Severity intuition — read when a kind's
severity is disputed (incl. the `form-field-no-name` P1-vs-P3 action rule).

### Perceivability cap (2026-07-30)

`push()` runs every finding through `__isPerceivable(el)` — one call site, so all
13 kinds get it. A finding on an element that is not **rendered** in the captured
state (`display:none`, `visibility:hidden`, `opacity:0`,
`content-visibility:hidden`, `[inert]`, detached, or zero-size) is **demoted to
P3** and tagged `perceivable:false`; `declaredSeverity` preserves what the kind
would otherwise have been.

**Demote, do not drop.** A hidden element may become visible — that is exactly
what `--with-modals` re-scans for — so dropping the finding destroys signal. The
tag is **state-relative**: it says "not perceivable in *this* capture", never
"never perceivable".

**Filter the headline on `perceivable`,** and report capped findings separately
so the count stays honest — 704 findings with 6 perceivable is a very different
report from 704 undifferentiated ones.

→ `references/scan-rules-detail.md` §Perceivability — the field incident,
the release-scope note, and the canonical predicate source.

### Touch targets are measured over activating regions

`small-touch-target` measures **every region that activates the control**, not
just the control's own border box. A wrapping `<label>` — or one associated via
`label[for=…]`, both covered by the spec's `el.labels` — is part of the tap
target, because clicking it activates the control. Regions are contiguous (no
bounding-box union); the rule passes on the first region ≥24×24 and reports the
largest; a control whose every region is undersized still fires.
→ `references/scan-rules-detail.md` §Touch targets — field data and why.

Confidence is not a click-test concept — assertions are deterministic. Either
the DOM violates the contract or it doesn't. If runs vary across same
URL + commit, something non-deterministic (A/B test, random ID generator,
load-order race) is involved; flag that meta-finding itself.

---

## Phase 6 — Structured Report

Header (the Phase 0b run contract, verbatim):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CLICK-TEST REPORT
  URL: <base>
  Routes: <list>
  Devices: <name(s)>   (e.g. "mobile (390x844)" or "desktop, mobile" for matrix)
  Scope: <scope>   Modals: <on|off>   Cache-bust: <own-app|forced|skipped-external|n/a>
  Ready-selector: <css>   Ready-timeout: <ms>
  Tool: <browser_tool> — <N> elements scanned (across all device passes) — <duration>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then, in order:
- **FINDINGS (<total>)** — per finding `[P<n>] <kind> <subject>` then Device,
  Route, Via, Selector, Detail, Snippet (redacted).
- **ROUTE COVERAGE** — one line per route: `<route> — <coverageStatus> —
  <n> elements — <n> findings (P0:n, …)` or `skipped (<reason>)`; under
  `--devices`, grouped per `device=<name> (<WxH>)` plus a **CROSS-DEVICE**
  section (shared / desktop-only / mobile-only counts + one interpretation line).
- **DYNAMIC SURFACES** (`--with-modals`) — per device+route: triggers total,
  scanned, skipped-destructive, modal-stuck.
- **OVERALL** — `<Broken | Broken+Incomplete | Has issues | Incomplete | Clean>`
  plus a one-sentence Reason.

→ `references/phase6-output-sample.md` — read before rendering, for the full sample.

```
OVERALL VERDICT RULES (deterministic precedence — first match wins):
  Coverage condition (referenced below):
    "covered"     = every route coverageStatus="scanned" AND
                    shadowGapCount == 0 AND iframeGapCount == 0 AND
                    no dynamic-scan failure
                    (failure = modal-stuck/budget-exceeded OR trigger-stale > 25% of triggers)
    "gaps"        = NOT covered

  1. Broken+Incomplete → any P0 finding AND gaps
  2. Has issues+Incomplete → any P1/P2 finding (no P0) AND gaps
  3. Broken             → any P0 finding AND covered
  4. Has issues         → any P1/P2 finding (no P0) AND covered
  5. Incomplete         → zero findings AND gaps
  6. Clean              → zero findings AND covered

  Issues are NEVER masked by coverage gaps — verdict 2 explicitly surfaces
  the P1/P2 + gap combination rather than letting it fall through to
  "Incomplete" (which would hide the discovered defects).

  Notes:
    - "Has issues" applies regardless of P1 vs P2; the count distinction lives
      in the FINDINGS block, not the verdict.
    - The verdict precedence is independent of coverage — a Broken+Incomplete
      run with one P0 and one auth-required route is more severe than either
      alone and gets its own label so /ship can gate appropriately.
```

Sort findings P0 first, then by `kind` alphabetical so similar issues group.

---

## Phase 7 — Persistence (Out of Scope for v1)

v1 does not persist findings: no `record-click-test` subcommand exists, so do
not invent one or claim a store write. The local Phase 6 report is the whole
output — print, read, fix, re-run.
→ `references/v1-scope-and-deployment.md` — read when asked why, what v2 adds,
which R3 audit concerns were deferred, or how this skill is deployed.

---

## Reminders

- **One scanner pass per settled DOM state** — one static pass per route per
  device, plus one pass per successfully opened dynamic surface in
  `--with-modals` mode. Aggregate findings in JS using
  `{device, route, via, kind, selector}` as the dedup key so a finding
  present in both static + modal states (on the same device) is reported
  once, but the same finding on two different devices is reported twice
  (responsive CSS can cause a duplicate-id to surface on only one viewport).

---

## Reference files

| File | Summary | Read when |
|---|---|---|
| `references/input-acquisition.md` | Where a skill's arguments come from on any host, and what to do when there are none. | Reading $ARGUMENTS on a host that does not substitute it, or deciding what empty input means at a site. |
| `references/browser-tool-detection.md` | The browser-driver contract — capabilities, driver table, selection order, minimum sets, degraded/blocked evidence. | Phase 1 driver selection — resolving which driver to use, or diagnosing a `blocked` result. |
| `references/auth-bootstrap.md` | Sanctioned auth-gated exploratory-testing pattern via MCP-server storageState, plus its connect-time-race escape hatch. | The target's primary surfaces need a login — pre-authenticate the shared driver connection before scanning, so `auth-required` routes are not coverage gaps. |
| `references/dom-scanner.md` | The full browser_evaluate scanner JS — every assertion's implementation, selector-stringifier helpers, severity mapping. | About to run Phase 4 or Phase 4b. |
| `references/scan-rules-detail.md` | Why the scan rules are what they are — perceivability, touch-target regions, severity intuition, FP notes, prep JSON. | A finding's severity or perceivability is disputed, a touch-target finding looks false, OR the prep contract shape is unclear. |
| `references/phase6-output-sample.md` | Full Phase 6 output sample — finding entries, single-device and matrix ROUTE COVERAGE, CROSS-DEVICE, DYNAMIC SURFACES. | About to render the Phase 6 report. |
| `references/v1-scope-and-deployment.md` | Why v1 has no persistence, the R3-deferred v2 concerns, and the maintainer deployment recipe + acceptance checks. | Asked about persistence, /ship integration or v2 scope, OR deploying/syncing this skill. |
| `references/worktree-preflight.md` | Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree. | A command dies with `MODULE_NOT_FOUND` in a linked worktree AND this repo has no `skills:hydrate` script. |

— end of /click-test —
