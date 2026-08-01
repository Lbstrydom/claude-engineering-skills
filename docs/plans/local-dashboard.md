# Plan: Local Navigable Dashboard Subsystem

- **Date**: 2026-05-19
- **Status**: Complete — shipped as 8f98d46 (initial), follow-ups 53d1413, 94a1668, 63f5e70, 371142d, 0da1881
- **Author**: Claude + Louis
- **Scope**: full-stack

> Origin: 4-round `/brainstorm` session (sids `1779166552535` →
> `1779170719848`). The design forks below were settled there; this plan
> records the resolution and the engineering detail.

---

## 1. Context Summary

- **Scope / stack**: full-stack · `js-ts` · no Python. A Node generator
  (backend) + a self-contained browser UI (frontend).
- **Problem**: everything a human needs to understand this bundle —
  skill flows, triggers, the architecture map, plans, audit/learning
  telemetry — lives in scattered `.md` / `.json`. There is no single
  navigable surface.
- **What exists today** (reused, not rebuilt):
  - `scripts/lib/skills-index.mjs` — exports `loadAllSkills()` / `parseSkill()`;
    already parses every `skills/*/SKILL.md` frontmatter into
    `{name, oneLiner, triggers, usage, ...}`. **Reference collector reuses this.**
    (Lived in `scripts/skills-help.mjs` until 2026-08-01; extracted to `shared-lib`
    so the collector stopped importing a root CLI entry point — see
    `dashboard-skills-index-layering.md`.)
  - `scripts/audit-metrics.mjs` — has `fetchCloudMetrics()` (Supabase audit
    runs/passes/findings) + `computeLocalMetrics()` (`.audit/outcomes.jsonl`).
    Currently module-private. **Telemetry collector reuses these after a
    minimal export refactor.**
  - `scripts/lib/secret-patterns.mjs` + `scripts/lib/sanitizer.mjs` —
    existing redaction primitives (in `CORE_SCRIPTS`). **Redaction reuses
    these — no new redactor.**
  - `scripts/lib/file-io.mjs` — `atomicWriteFileSync()` (crash-safe writes).
  - `scripts/lib/cli-io.mjs` — `ArgvError` (the project's CLI arg-error type).
  - `.requirements/ledger.json` — committed requirements ledger; already a
    structured artefact.
  - `docs/architecture-map.md` — generated; stable `## Contents` + per-domain
    structure.
- **Patterns reused vs new**: CLI shape (`--out` + stderr progress, `{result,
  usage, latencyMs}` is N/A — no LLM calls here), atomic writes, graceful
  degradation, ESM. **New**: the `scripts/lib/dashboard/` module group and a
  browser-side rendering layer (first UI artefact in this repo).
- **Neighbourhood considered**: arch-memory returned 50 candidates, **all
  `review` band** (top similarity 0.67, well under the 0.75 `justify-divergence`
  floor). No near-duplicate generator exists — greenfield is correct. The
  closest *relatives* (and how this plan relates to them):
  - `scripts/lib/skills-index.mjs` → **reuse** its exports (data source).
  - `scripts/audit-metrics.mjs` → **reuse** its fetchers (data source).
  - `scripts/lib/arch-render.mjs` `renderArchitectureMap` / `render-mermaid.mjs`
    → *markdown* renderers for a different consumer; the dashboard renders
    *HTML* — divergence justified (different output target, different audience).
  - `scripts/build-manifest.mjs` → similar "scan repo → emit artefact" shape;
    followed as a structural template, not extended.
- **Target domain(s)**: `scripts`, `shared-lib`. ⚠ Cross-domain (generator
  in `scripts`, lib modules in `shared-lib`) — intentional and matches the
  existing repo layout (`scripts/*.mjs` entry + `scripts/lib/*` modules).
  ⚠ `dashboard/index.html` is an untagged path — it is a new top-level
  artefact directory; a `dashboard/**` rule should be added to
  `.audit-loop/domain-map.json` during implementation (suggest tag
  `dashboard`).
- **Security incidents**: none returned for the target paths.

---

## 2. Proposed Architecture

### 2.1 Resolved design forks

| Fork | Resolution | Why |
|---|---|---|
| **A — one file w/ tabs vs two pages** | **Two pages**, each self-contained, each with *internal* tabs for its sub-sections. | The asymmetric commit policy is the deciding constraint: the reference page is **committed**, the telemetry page is **gitignored**. One file cannot be half-committed. Two files is forced — it is not a free choice. |
| **B — inline at build vs live `fetch()`** | **Inline at build time.** | Inlining is the *only* strategy that works under **both** entry points. `fetch()` of sibling files fails under `file://` (browser sandbox). Inlined data works double-clicked *and* served. Reference staleness is handled by regeneration on `/ship`, not by live fetch. |

**Consequence**: the two "entry points" are two *ways to open the same two
artefacts*, not two builds:

1. **`file://`** — double-click `dashboard/index.html`. Zero setup. Inlined
   data renders immediately.
2. **`http://`** — `npm run dashboard` rebuilds **both** pages (a coherent
   fresh snapshot), starts a localhost static server, opens the browser.
   Same files; clean URLs; the cross-page link is robust (no `file://`
   quirks).

> **Addendum (2026-06) — asymmetric commit policy RETIRED.** Fork A's
> "reference page is committed" resolution was reversed. In practice nobody
> read the committed copy (no GitHub Pages / public showcase; the owner views
> exclusively via `npm run dashboard`), and the committed page embeds a
> `built from <SHA>` provenance banner — so the pre-push rebuild that kept the
> banner current re-dirtied the tracked file on **every** push and it could
> never be clean. A generated view of repo+cloud state is not source. Both
> pages are now **gitignored, local-only artifacts** (Category A — same as
> `domain-deps-observed.json`), rebuilt on demand by `npm run dashboard`
> (serve rebuilds both). The pre-push rebuild step in `sync-to-repos.mjs` was
> removed. Fork A's "one file cannot be half-committed" reasoning is moot now
> that neither page is committed; the two-page split still stands on its other
> merit (self-contained pages, robust cross-links). Entry point (1) becomes
> "double-click a locally-built file" rather than a committed one; a fresh
> clone has no dashboard until the first `npm run dashboard`.

### 2.2 Component diagram

```
                       scripts/build-dashboard.mjs   ← CLI entry
                        modes: reference | telemetry | all | serve
                                   │
              ┌────────────────────┼─────────────────────┐
              ▼                    ▼                     ▼
   lib/dashboard/             lib/dashboard/        lib/dashboard/
   collect-reference.mjs      collect-telemetry.mjs serve.mjs
   • loadAllSkills() ⟵reuse   • fetchCloudMetrics() • static http server
   • parse docs/plans +         ⟵reuse (exported)     127.0.0.1 only,
     docs/completed headers   • computeLocalMetrics() path-contained to
   • parse architecture-map     ⟵reuse                dashboard/
   • skill-chain flow         • .requirements/        • opens browser
                                ledger.json
              │                • redact ⟵ sanitizer  │
              │                  + secret-patterns   │
              └─────────┬──────────────┘             │
                        ▼                            │
              lib/dashboard/render.mjs               │
              • pure (data, kind) → HTML string      │
              • inlines assets/dashboard.css + .js   │
                        │                            │
              ┌─────────┴──────────┐                 │
              ▼                    ▼                 ▼
   dashboard/index.html   dashboard/telemetry.html   serves dashboard/
   GITIGNORED             GITIGNORED                 over http://
   (per-user, local-only) (per-user, per-machine)
```

> Diagram updated per the **2026-06 addendum above** — `index.html` was
> originally COMMITTED; both pages are now Category-A local artifacts.

### 2.3 Data flow

- **`build-dashboard.mjs reference`** → `loadAssets()` + `collectReference()`
  → `renderDocument(data, 'reference', assets)` →
  `atomicWriteFileSync('dashboard/index.html')` (always written, even when
  degraded — but a degraded build exits non-zero and is not staged by
  `/ship`; §7.1).
- **`build-dashboard.mjs telemetry`** → `loadAssets()` + `collectTelemetry()`
  (async; Supabase optional) → redact → `renderDocument(data, 'telemetry',
  assets)` → `atomicWriteFileSync('dashboard/telemetry.html')`.
- **`build-dashboard.mjs all`** → both (independent — see §Execution Model).
- **`build-dashboard.mjs serve`** → build `all` (both pages), then `serve.mjs`
  (serial: the server must see freshly-built pages).

No browser-side network calls. No Supabase client in the browser. Telemetry
HTML carries a **redacted aggregate snapshot** inlined by Node, which alone
holds the keys (read via `dotenv/config`, same as `audit-metrics.mjs`).

### 2.4 Key design decisions

| Decision | Principle |
|---|---|
| Generator (Node) owns all ingestion; browser never reads the filesystem. | Modularity #3; the browser sandbox makes any other split fragile. |
| `render.mjs` is a **pure function** `(data, kind) → string` — no I/O. | Testability #11; Single Responsibility (SOLID #2). |
| One renderer, two `kind`s, composable section builders. | DRY #1; long-term flexibility #20 (a third page = one new `kind`). |
| Reuse `loadAllSkills` / `fetchCloudMetrics` rather than re-query. | DRY #1; Single Source of Truth #5. |
| Reuse `secret-patterns.mjs` / `sanitizer.mjs` for redaction. | DRY #1 — no second redaction implementation to drift. |
| CSS/JS live in `assets/*.css` / `*.js`, read + inlined at build. | Modularity #3 — avoids 1000-line template literals; assets are lint-able/testable. |
| Server binds `127.0.0.1`, path-contained to `dashboard/`. | Validation #12; least privilege — no LAN exposure, no traversal. |
| Every hook (`/ship`, `/audit-code`) is **advisory, never blocking**. | Graceful degradation #16 — mirrors the arch-map refresh step. |
| ~~Asymmetric commit: `index.html` committed, `telemetry.html` gitignored.~~ **RETIRED 2026-06** — both pages are gitignored (see addendum §2.2). | Avoids per-user/per-machine data in git history + cross-sync merge conflicts (brainstorm round 4). |

### 2.5 Telemetry data sources + source-status model

**Telemetry tab sources** (each tab's source-of-truth is fixed up front so
the UI → collector → storage path is traceable end-to-end):

| Tab | Source of truth | Collector path | Empty/absent state |
|---|---|---|---|
| Audit Runs | `audit_runs` / `audit_pass_stats` / `audit_findings` (Supabase) via `fetchCloudMetrics()`; `.audit/outcomes.jsonl` via `computeLocalMetrics()` | reuse `audit-metrics.mjs` exports | cloud off → local-only badge; both empty → "no audits yet" panel |
| Requirements | `.requirements/ledger.json` (committed) | direct `JSON.parse` | file absent → "no requirements ledger — run `requirements.mjs`" |
| Learning | `learning_decisions` aggregate counts (pending-triage / no-brainer / stale); local `.audit/quickfix-pattern-stats.json` if present | **import** `getLearningStats()` from `lib/learning/stats.mjs` (in-process, structured `{stats,status}`); read the local file directly | cloud off / no service-role key → status `missing-optional`, panel "learning telemetry needs cloud + service-role key"; counts all 0 → "no decisions recorded yet" |

**Empty states are per-section, not per-page.** Each of the three telemetry
tabs has its own independent empty / error / success state (the three
sources are unrelated — Requirements comes from a committed file, Learning
from cloud/local counts, Audit Runs can be empty on its own). A *page-level*
placeholder is shown **only** in the strict case where all three sections
are simultaneously absent/invalid. The `telemetry-empty` test id (§10)
belongs to the **Audit Runs** section's empty panel specifically.

The Learning tab is intentionally **counts-only in v1** — no per-decision
drill-down. It reuses the `getLearningStats()` accessor (the same logic the
`learning-stats` CLI wraps) rather than issuing raw Supabase queries or
spawning a subprocess (DRY #1; M2).

**Source-status model** — every collector input is classified, so expected
absence and unexpected corruption are never conflated (replaces the earlier
"missing → empty array" language; honours the repo's validate-at-boundaries
invariant #12):

| Status | Meaning | UI effect | Build effect |
|---|---|---|---|
| `ok` | source present + parsed | render normally | — |
| `missing-optional` | source legitimately absent (e.g. no `architecture-map.md`, cloud off) | section shows its documented empty state | build still `ok` |
| `invalid` | source present but malformed/failed schema | section shows a **visible warning panel** with a safe inline excerpt of the source + its filesystem path *as plain text* (NOT a hyperlink — the server is path-contained to `dashboard/` and must not serve repo files; §7 H3) | build target marked `degraded`, exit code non-zero |
| `unexpected-error` | I/O or runtime fault | visible warning panel | build target `degraded`, non-zero exit |

Each collected object carries a `sources: { <name>: {status, detail} }` map.
`render.mjs` turns non-`ok` statuses into visible warnings; `build-dashboard.mjs`
exits non-zero if any *commanded* target is `degraded` (a side build — the
auto-telemetry build that `reference` mode triggers — is reported but does
not fail the commanded target). Both pages are always written even when
degraded, so the warning panels are visible; `/ship` gates *staging* on a
non-degraded build (§7.1).

**Two documented exceptions to "malformed → `invalid`"** — deliberate, so a
fragile parse cannot degrade an otherwise-fine build:

1. **`architecture-map.md`** — a `## Contents` parse failure →
   `missing-optional`, not `invalid` (markdown scraping is inherently
   fragile — §7 collect-reference / Gemini-G2).
2. **An individual plan with a loose metadata header** → the *row* is
   flagged `malformed` and rendered minimally; the `plans` source stays
   `ok` (archived-plan header variance is cosmetic — §7.2).

Every other "present but malformed" source (corrupt `flows.json`,
`ledger.json`) is `invalid` per the table.

---

## 3. UX Design Decisions

- **Two-page model, internal tabs** — `index.html` tabs: *Skills*,
  *Process Flows*, *Architecture*, *Plans*. `telemetry.html` tabs: *Audit
  Runs*, *Requirements*, *Learning*. Tabs are a `display` swap — no fetch,
  works under `file://` (round-2 constraint).
- **Persistent top nav** links the two pages (*Reference* ⇄ *Telemetry*).
  Cognitive load: the user always knows which half they're in (Gestalt
  *common region*; Nielsen *visibility of system status*).
- **Telemetry is always a real, navigable page — one contract, no probes**
  (resolves the `file://` navigation gap). The Reference→Telemetry nav is a
  **plain `<a href="./telemetry.html">`** — there is *no* runtime existence
  probe anywhere, in any mode, so behaviour is identical under `file://` and
  `http://` (and the "no browser-side network calls" rule holds). The link
  always resolves because **every** `build-dashboard` invocation guarantees
  `dashboard/telemetry.html` exists: the telemetry build always writes it
  (a valid self-contained **placeholder** page — "run `/audit-code` or
  `/ship`" — when no data was collected), and `reference` mode triggers a
  telemetry build when the file is absent (§7.1). The placeholder is
  gitignored exactly like a populated telemetry page. The *only*
  un-navigable state is a never-built fresh clone; `index.html` carries a
  statically-rendered one-line hint ("run `npm run dashboard:build`") right
  in the telemetry nav area for that case — no probe, just always-present
  text. There is no acceptance test for an absent-file click path (it
  cannot occur after any build).
- **Stale-data banner** — provenance is *truthful at generation time* and
  differs by page so the committed artefact stays deterministic (§8 / M3):
  - `index.html` (gitignored since the 2026-06 addendum; the determinism
    rationale below was written when it was committed) → *"built from `<base-HEAD short sha>`<+local
    if working tree dirty> · source `<8-char data hash>`"* — **no human
    timestamp and no claimed artefact-commit SHA** (the generator runs
    *before* the commit that will contain it exists; it can only honestly
    cite the base HEAD it was built from).
  - `telemetry.html` (gitignored) → full *"Generated <ISO> · base
    `<short sha>`"* plus *"Supabase snapshot"* or *"local-only"*.
  The user is never misled about freshness (visibility of system status).
- **Progressive disclosure** — architecture map lists domains with symbol
  counts; expand a domain for its summary blurb (symbol-level detail is out
  of scope — see §6). Plans show one row each; expand for detail. Manages
  cognitive load on a large repo.
- **Search/filter** on the Skills tab (client-side substring over
  name/oneLiner/triggers — mirrors `filterBySearch` semantics).
- **Accessibility**: tabs use `role="tab"`/`role="tabpanel"` +
  `aria-selected` + arrow-key navigation; one `<h1>` per page, ordered
  headings; visible focus rings; colour is never the sole signal (status
  uses text + icon); target ≥ WCAG AA contrast.
- **Responsive**: single-column < 720px; nav collapses to a stacked list.
  No horizontal scroll on mobile.

### ASCII wireframe — `index.html`

```
┌──────────────────────────────────────────────────────────┐
│ Claude Engineering Skills          [Reference] [Telemetry]│
│ Generated 2026-05-19T10:00Z · commit a1b2c3d              │
├──────────────────────────────────────────────────────────┤
│ [ Skills ] [ Process Flows ] [ Architecture ] [ Plans ]   │
├──────────────────────────────────────────────────────────┤
│  Search: [ audit________ ]                                │
│  ┌────────────────┐ ┌────────────────┐ ┌───────────────┐  │
│  │ /audit-code    │ │ /audit-plan    │ │ /ship         │  │
│  │ multi-pass …   │ │ iterative …    │ │ sync+commit … │  │
│  │ triggers: …    │ │ triggers: …    │ │ triggers: …   │  │
│  └────────────────┘ └────────────────┘ └───────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 4. Technical Architecture (frontend)

- **No framework, no build step, no dependencies** in the browser layer
  (#27 — right-sized component model; #43 — no toolchain to rot). Plain
  ES modules inlined into the page.
- **`assets/dashboard.js`** — one IIFE: tab controller, search filter,
  collapse/expand. **No network calls of any kind** — no presence/HEAD probe
  (the Telemetry nav is a plain anchor; §3). State is the DOM + a single
  `activeTab` variable per page (#32 — minimal state; #34 — no global store
  needed for a read-only view).
- **Event handling** — one delegated `click` listener on the tab strip and
  one on the card grid (#38 — event delegation, not per-node listeners).
- **CSS** — `assets/dashboard.css`, CSS custom properties for the palette
  (#40 — design tokens; #42 — theme-swappable), BEM-ish class names, no
  inline styles in generated markup (#41).
- **Data contract** — `render.mjs` embeds the collected object as
  `<script type="application/json" id="dashboard-data">…</script>`; the
  inlined JS reads + `JSON.parse`s it on load. Single in-page data source
  (#5). The object is validated against a **Zod schema**
  (`lib/dashboard/schema.mjs`) before embedding — boundary validation (#12),
  consistent with the repo's "Zod at boundaries" rule.
- **Output encoding (mandatory)** — all dashboard data is repo-derived and
  untrusted for HTML purposes: skill names, triggers, plan titles, finding
  titles, requirement text can legally contain `<`, `>`, `&`, quotes, and
  even literal `</script>`. `render.mjs` MUST pass *every* interpolated
  value through one of two encoders, with no exceptions:
  - **HTML text/attribute** → `escapeHtml()` (`& < > " '` → entities) for any
    value placed in element content or an attribute.
  - **Embedded JSON block** → a script-safe serializer that escapes `<`, `>`,
    `&`, U+2028, U+2029 to `\uXXXX` (so the literal string `</script>` can
    never close the block, and the JSON survives HTML parsing).
  The renderer builds markup only via these two helpers — never raw string
  concatenation of a data value into HTML. Encoding correctness is a
  first-class test (§9: hostile-string fixtures incl. `</script>`, emoji,
  CRLF, RTL). This is the security boundary of the whole subsystem.

---

## 5. State Map

| Component | Empty | Loading | Error | Success | Edge |
|---|---|---|---|---|---|
| Skills tab | "No skills found" panel | n/a (inlined) | n/a | card grid | 1 skill → single card, grid still valid |
| Process Flows | "Flow data unavailable" (flows.json absent) | n/a | manifest malformed OR a node/edge references an unknown skill → warning panel, flow source `invalid` | chain diagram | — |
| Architecture tab | "No architecture-map.md — run `npm run arch:render`" | n/a | `## Contents` parse fail → `missing-optional`: "see `docs/architecture-map.md`" (no build degrade) | collapsed domain list (Contents block) | 0 domains → empty-state copy |
| Plans tab | "No plans found" | n/a | header parse fail → show filename only | active + completed lists | plan w/o metadata header → minimal row |
| Telemetry — Audit Runs tab | `getByTestId('telemetry-empty')` panel + how-to | n/a | source `invalid` → warning panel | run/pass/finding tables | Supabase off → "local-only" badge, local metrics only |
| Telemetry — Requirements tab | "no requirements ledger" panel | n/a | malformed `ledger.json` → warning panel | invariant table | ledger present, 0 active → "ledger empty" copy |
| Telemetry — Learning tab | "no decisions recorded yet" panel | n/a | `getLearningStats` error → warning panel | counts | cloud off / no service-role → `missing-optional` panel |
| Telemetry — whole page | page-level placeholder **only** when all three sections are absent/invalid | n/a | n/a | ≥1 section renders → no page-level placeholder | mixed: per-section states are independent |
| Telemetry nav link (from index) | static "run `npm run dashboard:build`" hint (never-built clone only) | n/a | n/a | plain anchor → navigates to `telemetry.html` | no probe in any mode (§3) |

---

## 6. Sustainability Notes

- **Assumptions that could change**: SKILL.md frontmatter shape (mitigated —
  `loadAllSkills` already owns that parse; we depend on its *output*, not
  the format); plan metadata-header shape; `architecture-map.md` structure.
  Each collector isolates one source — a format change touches one file.
- **Out of scope / v2** — *symbol-level* architecture detail. v1 parses only
  the `architecture-map.md` `## Contents` block (§7 collect-reference). The
  durable fix Gemini-G2 recommends — have `scripts/symbol-index/render-mermaid.mjs`
  emit a deterministic `docs/architecture-map.json` alongside the markdown,
  and have `collect-reference` `JSON.parse` that — is deferred: it reaches
  into the `arch-memory` domain and is a separate change. v1's shallow parse
  is the bounded interim; the JSON artefact is the clean v2 upgrade.
- **6-month change test**: a new data source (e.g. `ship_events`) = one new
  section builder + one `collect-*` addition; no renderer rewrite. A new
  page = one new `kind`.
- **Coupling**: collectors depend on existing exports, not on each other.
  `render.mjs` depends on nothing (pure). The server depends on nothing in
  the dashboard lib. Loose coupling throughout.
- **Extension seam deliberately built**: `render.mjs` section registry —
  sections are an array of `{id, title, build(data)}`; reorder/add without
  touching the shell.
- **Scale**: card grid + collapsible lists scale 6→60 skills and 16→160
  domains without layout rework.
- **Migration path**: if a live BFF is ever wanted, `serve.mjs` gains
  `/api/*` routes and the browser swaps inlined data for `fetch` — the
  collectors are already the right seam (they become route handlers).

---

## 7. File-Level Plan

### New files

| File | Purpose | Key exports | Depends on |
|---|---|---|---|
| `scripts/build-dashboard.mjs` | CLI entry. Subcommand `reference\|telemetry\|all\|serve` + `--port <n>` (serve only). **No `--out`** — output paths are fixed (see §7.1). Orchestrates collect→render→write; exits non-zero if any target is `degraded`. | `main()` | `cli-io.mjs`, all `lib/dashboard/*` |
| `scripts/lib/dashboard/collect-reference.mjs` | Gather skills, plans, architecture map, skill-chain flow into one object + a `sources` status map. Exports `discoverPlans()` — the plan-discovery contract (§7.2). **Architecture-map parsing is deliberately shallow** (Gemini-G2): it parses **only** the stable `## Contents` block of `docs/architecture-map.md` — the `- [domain](#anchor) — N symbols` list + each domain's `>` summary blurb. It does **not** scrape mermaid blocks or symbol tables. A `## Contents` parse failure → `missing-optional` (Architecture tab shows "see `docs/architecture-map.md`"), never `invalid` — markdown-scraping fragility must not degrade the whole reference build. | `collectReference()`, `discoverPlans()` | `skills-help.mjs` (`loadAllSkills`), `flows.json`, `node:fs` |
| `scripts/lib/dashboard/flows.json` | **Committed flow manifest** — the skill-chain process-flow graph: `{nodes:[{id,skill,label}], edges:[{from,to,label?}]}`. The single source for the Process Flows tab; the renderer consumes this normalised graph only (never infers edges from prose). Validated by `FlowManifestSchema`. `collectReference()` additionally **cross-validates** every node `skill` id and every edge endpoint against the live `loadAllSkills()` set — any unresolved reference marks the flow source `invalid` (degrades the reference build), surfacing manifest drift rather than silently greying a node. | (data) | — |
| `scripts/lib/dashboard/collect-telemetry.mjs` | Gather audit metrics + requirements ledger + learning counts (§2.5); **redact**; return data + `sources` map. | `collectTelemetry()` | `audit-metrics.mjs` (new exports), `lib/learning/stats.mjs` (`getLearningStats` — imported, **not** spawned), `secret-patterns.mjs`, `sanitizer.mjs` |
| `scripts/lib/dashboard/schema.mjs` | Zod schemas for the reference + telemetry data objects + the flow manifest (boundary validation). | `ReferenceDataSchema`, `TelemetryDataSchema`, `FlowManifestSchema` | `zod` |
| `scripts/lib/learning/stats.mjs` | Shared learning-stats accessor extracted from `cross-skill.mjs cmdLearningStats` — returns `{stats, status}` structured data, no stdout/argv concerns. | `getLearningStats()` | `learning-store.mjs` |
| `scripts/lib/dashboard/render.mjs` | **Pure** `renderDocument(data, kind, assets) → html` — no I/O whatsoever. Section registry; escaping; HTML assembly. `assets` (the css/js strings) is passed in by the caller. | `renderDocument()`, `__test__` | `schema.mjs` only |
| `scripts/lib/dashboard/load-assets.mjs` | Reads `assets/dashboard.css` + `dashboard.js` from disk, returns `{css, js}`. The single I/O boundary for assets — keeps `render.mjs` pure. | `loadAssets()` | `node:fs` |
| `scripts/lib/dashboard/serve.mjs` | Localhost static server, `127.0.0.1`, path-contained to `dashboard/`; opens browser. **Host-header allowlist** (Gemini-G(v2)-2 — DNS-rebinding defence): every request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` is rejected `403`, so a malicious page rebinding its domain to `127.0.0.1` cannot read local telemetry. Sends `Cache-Control: no-store, must-revalidate` + `Expires: 0` on every response (Gemini-G4 — a re-run of `npm run dashboard` never serves a browser-cached stale page). | `serve({port, dir})` | `node:http`, `node:path` |
| `scripts/lib/dashboard/assets/dashboard.css` | Dashboard styles (tokens, layout, responsive). | — | — |
| `scripts/lib/dashboard/assets/dashboard.js` | Browser controller (tabs, search, collapse, telemetry check). | — | — |
| `dashboard/index.html` | Generated reference dashboard. ~~Committed release artefact~~ → **gitignored, local-only** (Category A) per the 2026-06 addendum. | — | generated |
| `tests/dashboard.test.mjs` | Unit tests (see §9). | — | `node:test` |

### Modified files

| File | Change | Why |
|---|---|---|
| `scripts/audit-metrics.mjs` | Add `export` to `fetchCloudMetrics` + `computeLocalMetrics` (take `sb`/`DAYS` as args, not module globals). **Also fix the silent-failure bug** (Gemini-G1): Supabase `.select()` returns `{data, error}` and does **not** throw — `fetchCloudMetrics` currently does `runsRes.data || []`, swallowing network/credential errors as an empty result. The exported version must check `runsRes.error` / `passRes.error` / `findingsRes.error` and throw (or return a failure wrapper) so `collect-telemetry.mjs` can classify the source as `unexpected-error` rather than a false-empty `ok`. CLI behaviour otherwise unchanged. | DRY #1 — telemetry collector reuses them. Validation #12 — errors must not be silently swallowed. Backward compat #18 — `main()` still works. |
| `package.json` | Add scripts: `"dashboard": "node scripts/build-dashboard.mjs serve"`, `"dashboard:build": "node scripts/build-dashboard.mjs all"`. | Entry points. |
| `.gitignore` | ~~Add a single line `dashboard/telemetry.html`; `dashboard/index.html` stays tracked.~~ **Superseded 2026-06**: BOTH pages are gitignored. (No `telemetry-data.json` — the design inlines data into the HTML; there is no separate data file.) | ~~Asymmetric commit policy~~ → Category-A generated artifacts. |
| `scripts/sync-to-repos.mjs` | Add to `CORE_SCRIPTS`: `scripts/build-dashboard.mjs`, **the entire `scripts/lib/dashboard/**` subtree** (6 `.mjs` + `flows.json` + 2 `assets/` files), and `scripts/lib/learning/stats.mjs`. NOT `dashboard/index.html` (per-repo generated artefact). A test (§9) asserts every transitive import of `build-dashboard.mjs` under `scripts/` is in `CORE_SCRIPTS`, so the list cannot silently drift. | `feedback_new_lib_modules_need_core_scripts` — a synced script importing an un-synced module breaks consumer repos. |
| `scripts/cross-skill.mjs` | `cmdLearningStats` becomes a thin wrapper over the new `lib/learning/stats.mjs` `getLearningStats()` — same CLI output, logic extracted for reuse. | M2 — a lib collector must not depend on a CLI's stdout contract. |
| `skills/ship/SKILL.md` | New advisory step (after Step 0.5c), **source-repo-gated** (`package.json.name === "claude-engineering-skills"` — same gate as Step 6.0): run `build-dashboard.mjs reference`; on a non-degraded build `git add dashboard/index.html`; also build telemetry locally (not staged). Non-blocking; skipped entirely in consumer repos (§7.3). | "commits update reference automatically" — in the bundle repo. |
| `skills/audit-code/SKILL.md` | New advisory step at Step 6, **source-repo-gated**: run `build-dashboard.mjs telemetry`, print the `file://` link. Non-blocking; skipped in consumer repos (§7.3). | "audit updates telemetry automatically" — in the bundle repo. |
| `.claude/skills/ship/SKILL.md`, `.claude/skills/audit-code/SKILL.md` | Regenerated via `npm run skills:regenerate` after the SKILL.md edits. | Generated mirror must match source. |
| `.audit-loop/domain-map.json` | Add a dedicated **`dashboard` domain** with three `pattern` rules — `scripts/build-dashboard.mjs`, `scripts/lib/dashboard/**`, `dashboard/**` — placed **before** any broad `scripts/**` / `scripts/lib/**` catch-all (first-match-wins). Keeps the generator out of `shared-lib`/`scripts`/`audit-orchestration` so its cross-module imports read as one cohesive domain, not layering violations. If a separate arch-intent allowed-deps baseline exists, add the `dashboard` domain's permitted deps there too. | Gemini-G(v2)-1 — cohesive domain boundary; resolves the Phase 0.5b untagged-path warning. |

### 7.1 CLI contract (`build-dashboard.mjs`)

Output paths are **fixed**, never user-supplied — there is no `--out` flag
(removing the ambiguity of file-vs-directory and per-mode validity):

| Subcommand | Writes | Notes |
|---|---|---|
| `reference` | `dashboard/index.html` | if `dashboard/telemetry.html` is **absent**, then *sequentially* (after `index.html`) runs the telemetry build to create it — so the nav link always resolves (§3). Never writes `telemetry.html` itself. |
| `telemetry` | `dashboard/telemetry.html` | populated page, or placeholder when no data collected |
| `all` | both | reference build (`index.html`) ∥ telemetry build (`telemetry.html`) — concurrent and safe: **disjoint output files** |
| `serve` | both, then serves | runs `all`, then starts the server (a coherent fresh snapshot — not a stale committed `index.html`) |

**Single-writer rule** — exactly one code path may write any given output
file in any invocation. `index.html` is written **only** by the reference
build; `telemetry.html` **only** by the telemetry build. `reference` mode
never writes `telemetry.html` directly — when the file is missing it
*invokes the telemetry build* (sequentially), so the telemetry build
remains the sole writer. `all`/`serve` write two disjoint files, so the
concurrency in §11 introduces no shared-target race.

**Degraded-build write/stage matrix** — a build target is `degraded` when
any source is `invalid`/`unexpected-error` (§2.5):

| Target | Tracked? | On `degraded` build |
|---|---|---|
| `dashboard/index.html` | yes (committed) | **always written** to the working tree with visible in-page warning panels — the dev must see *what* degraded, in the browser. But the build exits non-zero, and `/ship` **stages `index.html` only when the reference build was non-degraded** — so a degraded page never reaches a commit. The previously-*committed* good version stays intact in git until a clean build replaces it. |
| `dashboard/telemetry.html` | no (gitignored) | **always written** with visible in-page warning panels; exit code non-zero so the `/audit-code` hook can log it. |

Rationale (Gemini-G3): the protection that matters for the committed
artefact is **"never *commit* a degraded page"**, not "never *write* one" —
if a degraded build refused to write `index.html`, the in-page warning
panels (Process Flows / Architecture / Plans) could never render and the
dev would never see the problem. So both pages are always written for
*visibility*; the git boundary (`/ship` staging gate) is what keeps a
degraded page out of history. Atomic rename still prevents torn files.

**Serve contract** (automation-grade, for `/ux-lock verify`):
- `--port <n>` — explicit port. In serve mode, if the port is busy the
  process **fails fast** (non-zero exit, clear message) — it does **not**
  hop to another port. Port hopping only applies when `--port` is omitted
  (interactive convenience).
- On successful bind, the **first line of stdout** is a machine-readable
  readiness signal: `DASHBOARD_URL=http://127.0.0.1:<port>`. All progress
  and the "press Ctrl+C to stop" line go to **stderr**. A harness reads one
  stdout line to get the URL; a human sees the friendly text on stderr.
- `SIGINT`/`SIGTERM` → close the server and exit 0 (clean shutdown for test
  harnesses).

Argument validation (unknown subcommand, `--port` outside 1024–65535,
`--port` passed to a non-serve subcommand) throws `ArgvError` → exit 1 with
the help text. Covered by §9 arg-validation tests.

### 7.2 Plan-discovery contract (`discoverPlans()`)

`docs/completed/` holds many non-plan documents (audit summaries,
architecture notes). Discovery is explicit and testable:

- **Inclusion** (single, strict marker — no loose `Status:` heuristic): a
  `.md` file directly under `docs/plans/` or `docs/completed/` whose **first
  `#` heading matches `^#\s+Plan:\s`**. This is the established convention
  for every plan in this repo (e.g. this file's `# Plan: Local …`), so no
  back-fill migration is needed. A `Status:`/`Date:` line alone does **not**
  qualify a file — architecture notes and learning docs carry those too.
- **Exclusion**: filenames matching `*-audit-summary*.md`, and any file
  failing the heading test — never listed.
- **Bucket**: file under `docs/plans/` → *active*; under `docs/completed/`
  → *completed*.
- **Sort**: by parsed `Date:` descending; files with no parsable date sort
  last, then by filename.
- **Malformed-but-eligible** (included by heading, but `Date`/`Status`
  unparsable — common for older archived plans with loose headers):
  rendered as a **minimal row** (title + path, `malformed` flag set). This
  is cosmetic per-row degradation — it does **not** mark the `plans` source
  `invalid` or degrade the build. Only a thrown discovery error is
  `unexpected-error`. (Refinement of the first-draft §2.5 wording: archived
  header variance must not fail today's build.)

`discoverPlans()` is exported from `collect-reference.mjs` and unit-tested
against current-repo fixtures (§9).

### 7.3 Distribution scope (v1 vs v2)

The brainstorm's "ship to other users" goal has two distinct audiences;
v1 deliberately serves only the first cleanly:

- **Audience A — users who clone `claude-engineering-skills` itself.** They
  get the committed `dashboard/index.html` immediately — zero setup, the
  primary v1 deliverable. ✅ v1.
- **Audience B — repos that *sync* the skill bundle into their own repo**
  (e.g. `wine-cellar-app`, `ai-organiser`). The generator code reaches them
  because `build-dashboard.mjs` + its libs are in `CORE_SCRIPTS`, so they
  *can* run `node scripts/build-dashboard.mjs all` manually. But:
  - The `/ship` + `/audit-code` hook steps are **source-repo-gated** — they
    fire only when `package.json.name === "claude-engineering-skills"`
    (mirrors `/ship` Step 6.0). Consumer repos get **no auto-regeneration**
    and **no `package.json` mutation**.
  - Consumer repos with a different layout degrade gracefully *for free* —
    the §2.5 source-status model turns a missing `docs/architecture-map.md`,
    `.requirements/ledger.json`, or telemetry source into `missing-optional`
    (empty-state UI), never an error.
  - **Out of scope (v2)**: auto-provisioning consumer `package.json` scripts
    + `.gitignore` entries, a `build-dashboard.mjs init` command, and
    per-consumer capability detection. Until then, Audience B is
    "works if you run the command", not "zero-setup".

This keeps v1 bounded: one repo commits one artefact; the generator is
*available* everywhere it syncs but *automated* only in the bundle repo.

---

## 8. Risk & Trade-off Register

| Risk / trade-off | Decision | Mitigation |
|---|---|---|
| Inlined reference data goes stale between `/ship`s. | Accepted. | `/ship` regenerates + commits it; reference content only changes when skills change — a deliberate, low-frequency event. Stale banner makes age visible. |
| Committed `dashboard/index.html` adds a generated file to git history. | Accepted (brainstorm round 4: it is a *release artefact*, like a committed README, and changes rarely + deterministically). | **Resolved (M3):** the committed page carries **no human timestamp** and **no claimed artefact-commit SHA** (the generator runs before that commit exists — citing it would be systematically wrong). Its banner is truthful-at-generation: base-HEAD short SHA + `+local` dirty marker + an 8-char hash of the collected source data. Generation is otherwise deterministic (stable key ordering, pretty-printed). Result: `index.html` changes only when *content* changes — a real line diff. |
| A `degraded` reference build could land in a commit. | Must not happen. | §7.1 write/stage matrix: a `degraded` reference build *is* written to the working tree (so the dev sees the in-page warnings) but exits non-zero, and `/ship` stages `index.html` **only** on a non-degraded build — so the degraded page never reaches history; the last *committed* good version stays intact. |
| `audit-metrics.mjs` refactor could break its CLI. | Low. | Keep `main()` calling the now-exported fns; `tests/dashboard.test.mjs` + a manual `node scripts/audit-metrics.mjs` smoke check. |
| Local static server = a process + a port. | Accepted — it is opt-in (`npm run dashboard`); `file://` needs nothing. | `127.0.0.1` only; port-in-use → try next; clear "press Ctrl+C to stop" line. |
| Path traversal via the static server. | Must not happen. | Resolve every request path, reject anything not contained in `dashboard/` (symlink-resolved) — same egress discipline as `requirements.mjs`. |
| DNS-rebinding read of local telemetry via the static server. | Must not happen. | `serve.mjs` Host-header allowlist — only `127.0.0.1:<port>` / `localhost:<port>` accepted, all else `403` (§7 serve.mjs). A rebound malicious origin cannot read the page. |
| Telemetry HTML leaks finding text / paths. | Mitigated. | Gitignored (never committed); finding text run through `secret-patterns` redaction; no raw file contents inlined; only aggregates + finding titles. |
| Pre-existing uncommitted edits in `skills/audit-code/SKILL.md` (+ its `.claude` mirror). | Heads-up — out of scope. | Implementation must add the new step *around* the existing uncommitted changes and stage only the dashboard-related hunks; confirm with the user before touching that file. |
| Deliberately deferred | A live BFF / auto-refresh-on-serve / GitHub Pages mirror. | v1 is generate-and-open. §6 documents the migration seam. |
| Telemetry Audit-Runs is **project-wide**, not per-repo. | Accepted for v1 — `fetchCloudMetrics` (reused from `audit-metrics.mjs`) filters by date only. The Audit Runs section is labelled "Supabase (project-wide)" so the user is not misled. Per-repo filtering = v2. | Audit R1/H1 — the dashboard makes the inherited unscoped query a user-facing contract; honest labelling now, real filtering later. |
| `collectRequirements` parses `ledger.json` directly, not via the `lib/requirements` schema. | Accepted — a defensive `JSON.parse` + `try/catch→invalid` is sufficient for a read-only display; reusing the requirements lib pulls a heavier dependency for marginal gain. | Audit R1/M1 — revisit if the ledger schema grows or the dashboard needs deeper requirements detail. |

---

## 9. Testing Strategy

**Unit (`tests/dashboard.test.mjs`, `node --test`)**:
- `collectReference()` — temp skills/plans/arch-map fixture → expected shape;
  a `missing-optional` source (no arch-map) → that section's status is
  `missing-optional`, build still `ok`; a malformed arch-map → status
  `invalid`, target `degraded`.
- `discoverPlans()` — fixture `docs/completed/` with a real plan, an
  `x-audit-summary.md`, and a non-plan note → only the real plan is
  returned, bucketed `completed`; a plan with an unparsable `Date:` → still
  included with its `malformed` flag set (source stays `ok`).
- `collectTelemetry()` — Supabase off → `cloud:false`, local-only metrics,
  Learning source `missing-optional`; redaction strips a planted fake
  secret from finding text.
- **Output encoding** — `render()` over a hostile-string fixture
  (`</script>`, `<img onerror>`, `&`, quotes, U+2028, emoji, CRLF, RTL):
  no value escapes its encoder — the embedded JSON block cannot be closed
  early, and no raw `<` reaches element content. This is the security test.
- `render()` — pure: same input → byte-identical output (determinism); the
  committed `kind:'reference'` page contains **no ISO timestamp**; both
  `kind`s produce well-formed single-root HTML; output validates against
  the Zod schema; schema rejects a malformed data object.
- `serve.mjs` path containment — a request for `../../.env` (plus
  URL-encoded and symlinked variants) → 403, never served; bind is
  `127.0.0.1` only; `--port` busy → fail-fast non-zero exit.
- `serve.mjs` Host-header allowlist — a request with `Host: evil.example`
  → 403; `Host: 127.0.0.1:<port>` and `localhost:<port>` → 200. Every
  response carries `Cache-Control: no-store`.
- **CLI args** — unknown subcommand, out-of-range `--port`, `--port` on a
  non-serve subcommand → `ArgvError` exit 1.
- **Sync completeness** — every transitive `scripts/`-relative import of
  `build-dashboard.mjs` is present in `CORE_SCRIPTS` (guards H6 from
  silently regressing).

**Integration**:
- `node scripts/build-dashboard.mjs all` on this repo → both files exist,
  parse as HTML, contain the expected tab markup.
- `node scripts/audit-metrics.mjs` still runs unchanged (refactor smoke).

**Manual / visual checklist**:
- Double-click `dashboard/index.html` (`file://`) after a build: tabs
  switch, search filters, no console errors, the Telemetry anchor navigates
  to the (placeholder-or-populated) `telemetry.html`. No network calls in
  the Network panel.
- `npm run dashboard` (`http://`): browser opens, both pages reachable,
  cross-link works, Ctrl+C stops the server cleanly.
- Responsive: 360px and 1280px — no horizontal scroll, nav collapses.
- a11y: keyboard-only tab navigation; axe-core clean; visible focus.

---

## 10. Acceptance Criteria (Playwright-verifiable)

> Verified by `/ux-lock verify` against `dashboard/index.html` (served via
> `npm run dashboard`, base URL `http://127.0.0.1:<port>`). Implementation
> must add the `data-testid`s named below.

- [P0] [navigation] Reference dashboard loads with a single top-level heading.
  - Setup: open `/index.html`.
  - Assert: exactly one `getByRole('heading', { level: 1 })` is visible.
- [P0] [interaction] Skill tabs switch panels.
  - Setup: open `/index.html`; click the tab `getByRole('tab', { name: /process flows/i })`.
  - Assert: the *Process Flows* `getByRole('tabpanel')` is visible and the
    *Skills* tabpanel is hidden.
- [P0] [navigation] The Telemetry page is reachable and shows its empty
  state when no audit data exists.
  - Setup: `npm run dashboard` (builds both pages — telemetry is a valid
    placeholder when no data); open `/index.html`; click the *Telemetry*
    nav link.
  - Assert: navigation lands on `telemetry.html`; `getByTestId('telemetry-empty')`
    is visible and contains text matching `/run .*audit/i`.
- [P1] [interaction] Skill search filters the card grid.
  - Setup: open `/index.html`; type `ship` into `getByRole('searchbox')`.
  - Assert: `getByRole('article', { name: /ship/i })` stays visible; at
    least one non-matching skill card is no longer visible.
- [P1] [a11y] Tab strip is keyboard navigable.
  - Setup: open `/index.html`; focus the first `role="tab"`; press `ArrowRight`.
  - Assert: the next tab has `aria-selected="true"` and DOM focus.
- [P1] [a11y] No detectable axe-core violations on the reference page.
  - Setup: open `/index.html`.
  - Assert: axe-core scan reports 0 violations of impact `serious`/`critical`.
- [P2] [state] Architecture tab degrades when the map is missing.
  - Setup: build with no `docs/architecture-map.md`; open the *Architecture* tab.
  - Assert: `getByTestId('arch-empty')` is visible with run-`arch:render` guidance.
- [P2] [responsive] No horizontal overflow at 360px.
  - Setup: set viewport 360×780; open `/index.html`.
  - Assert: `document.documentElement.scrollWidth <= 360`.
- [P2] [text] Freshness banner states truthful generation provenance.
  - Setup: open `/index.html`.
  - Assert: `getByTestId('freshness-banner')` contains a 7+-char base-HEAD
    short SHA and an 8-char source-data hash; it does **not** contain an
    ISO-8601 timestamp (the committed page is timestamp-free).

---

## 11. Execution Model

- `collectReference()` and `collectTelemetry()` are **independent** — `all`
  mode runs them concurrently (`Promise.all`); a failure in one must not
  abort the other. Each collector classifies *every* input per the §2.5
  source-status model: `missing-optional` degrades that one section to its
  empty state; `invalid` / `unexpected-error` mark the build target
  `degraded` (visible warning + non-zero exit) but still emit a valid page.
  A thrown collector error is itself caught and recorded as
  `unexpected-error` for that target — never a silent partial.
- **Single-writer**: `index.html` is written only by the reference build,
  `telemetry.html` only by the telemetry build (§7.1). `all`/`serve` run the
  two concurrently — safe because the targets are disjoint. `reference` mode
  creating a missing `telemetry.html` does so by invoking the telemetry
  build *sequentially*, not by writing the file itself.
- `render` → `atomicWriteFileSync` prevents *torn* files. Both pages are
  always written (degraded builds included — so warning panels are visible
  in the browser); the §7.1 write/stage matrix keeps a degraded page out of
  git by gating `/ship` *staging* on a non-degraded build, not by skipping
  the *write*.
- `serve` mode is **serial**: build `all` (both pages) → *then* start the
  server, so the first request sees freshly-built pages.
- Hooks (`/ship`, `/audit-code`) are independent of each other and advisory;
  failure logs a warning and never blocks the host skill.
