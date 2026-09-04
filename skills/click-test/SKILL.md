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
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first.
>
> If this repo defines no such script, it has not adopted the remedy yet. Add
> this entry to its `package.json` `scripts` and run it — it copies the tooling
> tree in from the main checkout, and leans on nothing but node and git:
>
> "skills:hydrate": "node -e \"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});console.log('[hydrate] copied '+src)\""
>
> Rationale (source repo only — `docs/runbooks/` is not synced to consumers):
> `docs/runbooks/consumer-adoption.md` §"Linked git worktrees".

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

Walk every interactive element on each target route and assert the structural
HTML contract. **Not a persona test.** This is the mechanical sibling of
`/persona-test`:

| Skill | Catches | Misses |
|---|---|---|
| `/persona-test` | Narrative UX, confusing copy, missed migration glyphs, FAB-modal stacking, broken happy paths | Duplicate IDs (rendered fine), orphan labels (no visible symptom), undersized touch targets the persona's finger happens not to miss |
| `/click-test` | Structural / semantic / a11y contract violations across every interactive element | Whether the flow makes sense for any human |

Run **both**. Findings from each rarely overlap.

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

click-test itself never attempts to log in — credentials are out of scope
for this skill's own logic. But click-test drives the same browser
connection as persona-test (see `references/dom-scanner.md` and the
delegated browser-tool detection below), so the same session-level
pre-authentication applies here: if the target's primary surfaces need a
login, pre-authenticate the shared driver connection via `--storage-state`
BEFORE running click-test — see
[`../persona-test/references/auth-bootstrap.md`](../persona-test/references/auth-bootstrap.md)
for the sanctioned pattern (a per-repo sign-in script writing a
`storageState` file, wired into `.mcp.json`). Without it, `auth-required`
routes are real coverage gaps, not a v1 limitation. The OVERALL verdict
becomes at most `Incomplete` (never `Clean`) when any route is
`auth-required`.

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

Service workers silently serve stale bundles, masking real deploys (the
wine-cellar-app failure mode). The cache-bust is **mandatory for own-app
hostnames** (localhost, `*.local`, `*.railway.app`, `*.vercel.app`,
`*.netlify.app`) where the cost of clearing user state is zero.

**For external URLs**: do NOT cache-bust by default. Clearing
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

### Get the device-pass contract (MANDATORY; do not skip)

Before any browser work, call:

```bash
node scripts/lib/device-presets.mjs prep-matrix \
  [--device <preset>] [--devices "<list>"] [--viewport <WxH>]
```

(Pass the same flag your `$ARGUMENTS` contained — none if neither flag

<!-- host-contract: input-acquisition; grammar=path+flags; empty=default -->
_This site: `path+flags` — neither device flag present means a single `desktop` pass — do not synthesise a matrix._

was supplied; defaults to a single `desktop` pass.)

The CLI returns:

```json
{
  "kind": "click-test-prep",
  "version": 1,
  "matrixMode": true|false,
  "totalPasses": 1 | N,
  "passes": [
    {
      "passIndex": 0,
      "device": { "name": "desktop", "viewport": {"width": 1280, "height": 720}, ... },
      "expectedFirstMcpCall": { "tool": "browser_resize", "args": {"width": 1280, "height": 720} },
      "logLine": "[device-profile] explicit → desktop (1280x720, touch=false) [pass 1/2]"
    },
    ...
  ]
}
```

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

`small-touch-target` deserves special note: this rule is **device-sensitive**
by design. A 24×24 button is acceptable on desktop with a mouse but fails the
44×44 touch-target minimum on mobile. The scanner emits it on every pass, but
the report should downgrade desktop-pass `small-touch-target` findings by one
severity (P2 → P3) when both desktop and mobile passes ran — the mobile pass
is the authoritative read.

If validation fails, classify the route as `coverageStatus: "scanner-error"`
and skip its findings — never persist or report unvalidated output.

**Per-route aggregation** when `--with-modals` produces multiple scan results
(one static + one per opened modal): the per-route record stores the static
scan's `elementsScanned` / `interactiveElementsScanned` as the route totals
(modals are subsets, not additions). For `shadowGapCount` / `iframeGapCount`,
take the **max** observed across passes (NOT sum — each modal pass re-scans
the whole DOM, so the static gaps would be double-counted). The interpretation
is "the worst coverage gap seen on this route", which is what the verdict
cares about. `findings` are unioned and deduped by `{device, route, via, kind, selector}`.
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

**`duplicate-aria-label` FP note**: this rule has high false-positive rates
on grid/card layouts where shared "Edit" / "Delete" buttons are
contextually disambiguated by surrounding text. The scanner downgrades it
to P2 by default and only fires when the duplicates share the same `role`
AND same parent component region (closest `[role="list"]`, `[role="grid"]`,
`<table>`, `<form>` — see scanner impl). If you want it ignored entirely,
use `--scope ids` or `--scope forms`.

---

## Phase 4b — Dynamic-surface Scan (`--with-modals` only)

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

**Why this matters**: React/Vue/Svelte mount duplicate IDs *into* the live
DOM when a modal opens. Static scan won't see them — they only exist while
the modal is mounted. This is exactly what static template audits miss.

---

## Phase 5 — Severity Model

The authoritative severity-per-kind mapping is the table in Phase 4 ("Finding
taxonomy"). The intuition behind those assignments:

| Code | Rule |
|---|---|
| **P0** | Breaks core function: React reconciliation (duplicate IDs), form submission (no name on field — wait, that's P1; let me explain), screen-reader announcement (input/button with no accessible name), click-to-focus (orphan `<label for>`) |
| **P1** | Degrades experience but flow still works: aria-hidden focusable (non-`inert` subtrees only), empty `<a href="#">`, form-field-no-name — **only when the form has an `action`** (the browser natively submits and that field's value is dropped). An action-less form has no native submission path, so the same finding is **P3 advisory**: in a JS-driven form the missing `name` is often deliberate, and pressing to add one without `method="post"` would arm a credentials-in-URL leak on native fallback (found live 2026-07-30). |
| **P2** | Polish / a11y suggestion: heading-skip, img-no-alt (decorative needs `alt=""`), small-touch-target, positive-tabindex, duplicate-aria-label (high FP rate) |
| **P3** | Findings whose element was **not perceivable** in the captured state (severity capped here from `declaredSeverity`), plus reserved future suggestions (redundant ARIA, decorative-near-interactive) |

### Perceivability cap (2026-07-30)

`push()` runs every finding through `__isPerceivable(el)` — one call site, so all
13 kinds get it. A finding on an element that is not **rendered** in the captured
state (`display:none`, `visibility:hidden`, `opacity:0`,
`content-visibility:hidden`, `[inert]`, detached, or zero-size) is **demoted to
P3** and tagged `perceivable:false`; `declaredSeverity` preserves what the kind
would otherwise have been.

**Why this matters.** A `<input type="file" hidden>` — the standard
custom-upload-button pattern — has `type === 'file'`, so it slips past the
`type === 'hidden'` filter and was reported **P0 `input-no-name`**. A field run
produced 704 findings of which ~6 were real: all 31 `aria-hidden-focusable`
findings sat inside one `visibility:hidden` subtree, and 4 of 5 P0s were hidden
file inputs.

**Demote, do not drop.** A hidden element may become visible — that is exactly
what `--with-modals` re-scans for — so dropping the finding destroys signal. The
tag is **state-relative**: it says "not perceivable in *this* capture", never
"never perceivable".

> **Scope note — this is NOT a release-gate fix.** `/ship` does **not** gate on
> click-test P0s: persistence to the shared store is deferred (Phase 7 below), so
> no `record-click-test` subcommand, table or `/ship` read path exists, and
> `/ship --ignore-p0` refers to **persona-test** P0s only. The harm being fixed
> is a human reading a P0 list and treating it as blocking, plus the noise ratio.
> Correcting severity *now* is preventive: it means the deferred v2 persistence
> cannot turn a cosmetic wrong into a real false gate.

**Filter the headline on `perceivable`,** and report capped findings separately
so the count stays honest — 704 findings with 6 perceivable is a very different
report from 704 undifferentiated ones.

The predicate's canonical source is
[`scripts/lib/browser/perceivable.mjs`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/scripts/lib/browser/perceivable.mjs);
the copy inside `references/dom-scanner.md` is drift-checked by
`tests/click-test-perceivability.test.mjs`. `/nav-audit --verify` injects the same
function to qualify its `authSentinel`, which is why it is a module rather than
scanner-local.

### Touch targets are measured over activating regions (2026-07-31)

`small-touch-target` measures **every region that activates the control**, not
just the control's own border box. A wrapping `<label>` — or one associated via
`label[for=…]`, both covered by the spec's `el.labels` — is part of the tap
target, because clicking it activates the control.

**Why this matters.** The visually-hidden-input + styled-label pattern is
ubiquitous, and measuring only the input reports a *guaranteed* false positive.
Field data from a consumer run (2026-07-31):

| Element | Input's own box | Real tap target (its `<label>`) |
|---|---|---|
| `#filter-reduce-now` | 1×1 | **74×44** |
| `#wine-grouped-select-all` | 13×13 | **75×24** |

The perceivability cap above cannot reach this class: these inputs are
`visibility: visible` and genuinely **painted** at 1×1 — they are simply not the
thing the user touches. Without this rule, any codebase using the standard
styled-checkbox pattern carries a permanent floor of false positives that each
need manual DOM verification to dismiss.

**Contiguous regions, not a bounding-box union.** A `label[for]` may sit anywhere
in the document, so a union spanning the gap between two far-apart boxes would
describe an activating region that does not exist — trading the false positive
for a false *negative*. WCAG 2.5.8 is satisfied when **some single** activating
region is ≥24×24, so the rule passes on the first adequate region and reports the
largest one (that is the number a verifier will measure).

**Not a "has a label ⇒ exempt" escape hatch.** A control whose every activating
region is undersized still fires, and a label that is not perceivable does not
rescue one. Both are pinned in `tests/click-test-perceivability.test.mjs`.

Confidence is not a click-test concept — assertions are deterministic. Either
the DOM violates the contract or it doesn't. If runs vary across same
URL + commit, something non-deterministic (A/B test, random ID generator,
load-order race) is involved; flag that meta-finding itself.

---

## Phase 6 — Structured Report

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

FINDINGS (<total>)
────────────────────────────────────────────────────
  [P0] duplicate-id "wine-card-3" (4 occurrences)
     Device:   mobile
     Route:    /cellar
     Via:      static
     Selector: #wine-card-3
     Detail:   Repeated by the wine grid renderer when filter is active;
               React will reconcile the wrong nodes on next render
     Snippet:  <div id="wine-card-3" class="..."> [redacted if needed]

  [P0] input-no-name <input type="text">
     Device:   mobile
     Route:    /cellar
     Via:      modal:"Add bottle"
     Selector: form.add-bottle > input[type=text]:nth-child(2)
     Detail:   No label, aria-label, aria-labelledby, or placeholder.
               Screen readers announce this as "edit text" with no context.
     Snippet:  <input type="text" class="form-control">

  ...

ROUTE COVERAGE  (single-device run)
────────────────────────────────────────────────────
  /          — scanned          — 47 elements — 0 findings
  /cellar    — scanned          — 312 elements — 8 findings (P0:2, P1:1, P2:5)
  /admin     — auth-required    — 0 elements — skipped (login wall)
  /reports   — readiness-timeout — 0 elements — skipped (ready-selector never matched)

ROUTE COVERAGE  (per-device matrix — only when --devices used)
────────────────────────────────────────────────────
  device=desktop (1280x720)
    /          — scanned — 47 elements — 0 findings
    /cellar    — scanned — 312 elements — 4 findings (P0:1, P2:3)
  device=mobile (390x844)
    /          — scanned — 47 elements — 1 finding (P2:1 small-touch-target)
    /cellar    — scanned — 308 elements — 9 findings (P0:2, P1:2, P2:5)

  CROSS-DEVICE
    Shared (both):     4 findings — duplicate-id × 2, orphan-label × 2
    Desktop-only:      0
    Mobile-only:       6 findings — small-touch-target × 4, input-no-name × 2
    Interpretation: 6 issues only surface on mobile — typical responsive-CSS gap.

DYNAMIC SURFACES (--with-modals)
────────────────────────────────────────────────────
  device=mobile  /cellar: 12 triggers — 8 scanned, 2 skipped-destructive, 2 modal-stuck
  device=mobile  /admin:  — (route skipped)

OVERALL: <Broken | Broken+Incomplete | Has issues | Incomplete | Clean>
  Reason: <one sentence>

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

Persisting click-test findings to the shared cross-skill store (so `/ship`
can surface P0s as pre-push warnings) is **deferred to v2**. The v1 skill
is authoritative purely from its local report — print, read, fix, re-run.

Why deferred:
- The required `scripts/cross-skill.mjs record-click-test` subcommand
  doesn't exist yet, nor does the typed payload schema, table mapping,
  or `/ship` read path.
- Declaring "graceful no-op when subcommand missing" would ship a dead
  integration path that silently never works — worse than no integration.
- The local Phase 6 report covers the immediate use case (run, fix, ship).

**v2 work item** (when the integration matters): add a new
`record-click-test` subcommand with Zod-validated payload, decide table
strategy (new `click_test_runs` table vs reusing `regression_specs` with
a discriminator), update `/ship` to surface unresolved P0s, add tests.
Tracked in docs/plans/click-test-v2-persistence.md (planned) — file to be
created when v2 starts; not a v1 blocker.

---

## Integration (skill deployment)

This skill ships through the same auto-sync as every other skill in the
bundle. No manual file list needed:

- `scripts/sync-to-repos.mjs::buildSkillFiles()` enumerates `skills/*/` and
  picks up `skills/click-test/` automatically.
- The `.claude/skills/click-test/` mirror is regenerated on
  `npm run skills:regenerate`. Copilot discovers it natively (Agent Skills) —
  no separate prompt-shim surface (retired 2026-07-21).

Deployment recipe:

```bash
npm run skills:regenerate     # update .claude/skills/click-test/ mirror
npm run sync                  # push to every consumer repo in the registry
```

Both commands are idempotent and report drift / changed files in stderr.

### Deployment acceptance criteria

After running the recipe, verify ALL of these before declaring deployment complete:

1. `.claude/skills/click-test/SKILL.md` exists and matches `skills/click-test/SKILL.md`
   byte-for-byte (the generator copies, not re-formats).
2. `.claude/skills/click-test/references/dom-scanner.md` exists.
3. `npm run skills:check` passes (validates each reference file's `summary:`
   frontmatter byte-matches the parent SKILL.md's reference-index row).
4. For each consumer repo synced: `.claude/skills/click-test/SKILL.md`
   present at the consumer repo root.

If any of these fail, the deployment did NOT complete — fix the failure
and re-run rather than declaring partial success.

---

## Out of Scope (v2) — deferred from R3 audit

These were raised by the GPT plan-auditor in R3. Each is a real concern,
but v1 ships without them because (a) the local Phase 6 report still
flags coverage gaps and (b) addressing them would require runner code
that doesn't exist yet (this is a skill spec, not a CLI).

| Concern | Why deferred | v2 mitigation |
|---|---|---|
| Dynamic-trigger classifier doesn't skip `Save/Submit/Publish/Apply` controls — could mutate state in `--with-modals` mode | The current safety regex catches obviously destructive labels (`delete`, `sign out`, etc.); state-changing labels are harder to enumerate without false positives. v1 is opt-in via `--with-modals` and users testing their own apps know which buttons are safe. | Extend regex + form-association classifier. Add a `--dry-run-dynamic` mode that lists triggers without clicking. |
| `routeStatus` vs `dynamicStatus` aggregation not fully specified — a route can be `scanned` while modal coverage failed | The Phase 6 verdict rules cover the headline case (any P0+gap → Broken+Incomplete). The deep ROUTE COVERAGE block can report both fields per route. | Split the model formally when implementing — `RouteResult = { routeStatus, findings, dynamicCoverage: { triggersTotal, triggersScanned, failureReasons[] } }` |
| Scanner-returned `severity` is trusted across the browser boundary — page could lie | Browser-side scanner is repo-controlled JS injected fresh each scan; a hostile page can't override it. If we run against attacker-controlled pages in v2, the runner should re-derive severity from `kind` (the kind → severity map is canonical in SKILL.md). | Re-derive `severity` runner-side using the taxonomy table; ignore the scanner's emitted severity. |
| Lossy handling of finding sets at 999-cap | Capping silently truncates evidence. v1 returns `scanner-error` for >999 to fail loudly; counts above the cap suggest the scanner needs a separate per-rule cap or the page has runaway templates worth investigating manually. | Per-rule caps (e.g. max 50 duplicate-id rows from one ID collision) + total cap. |
| Own-app classifier matches `*.local` which is reserved for mDNS — false positive risk | mDNS overlap is theoretical; in practice `*.local` in browser context means dev environments where cache-bust is safe. | Tighten classifier if we ever see a real collision. |
| `auth-required` detection runs after readiness gate — login-only routes may readiness-timeout first | Both classifications correctly indicate "could not scan", so the OVERALL verdict still becomes Incomplete. The reason differs but the outcome doesn't. | Run a quick `[type=password]` check immediately after `load`, before readiness polling. |
| Redaction boundary too narrow — only redacts `snippet`, not `selector` / `detail` | `selector` is structural (no PII expected); `detail` is composed by the scanner from rule descriptions (no user content). Genuine leakage path is `snippet`. | Audit each field; redact `detail` if/when the scanner starts interpolating page content. |
| `ready-selector` not validated for CSS-correctness | An invalid selector throws when used; we surface the error as `scanner-error` with the message. Pre-validation would duplicate the engine's selector parser. | Wrap user selector in try/catch with a clearer error message. |

---

## Reminders

- **Cache-bust first, always** — stale SW will hand you yesterday's DOM.
- **Don't click destructive triggers** in `--with-modals` mode.
- **Run alongside `/persona-test`, not instead of it** — disjoint coverage.
- **Findings are deterministic** — same URL + commit = same findings. If
  they vary, something non-deterministic (load order, A/B test, random ID)
  is involved — flag that as a finding itself.
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
| `references/dom-scanner.md` | The full browser_evaluate scanner JS — every assertion's implementation, selector-stringifier helpers, severity mapping. | About to run Phase 4 or Phase 4b. |

Phase 1 resolves its driver from `references/browser-tool-detection.md`, listed
in the table above. That file is a **generated copy** — its own header names the
canonical it came from (source repo only; the canonical is not synced to
consumers). Edit the canonical, never a copy. It used to be cited across skill
boundaries as
`../persona-test/references/…`, which a packaged click-test would ship without:
`enumerateSkillFiles` walks a skill's OWN directory only, so the contract this
skill is told to obey could travel separately from the skill.
