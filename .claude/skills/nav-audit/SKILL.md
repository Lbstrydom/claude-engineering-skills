---
name: nav-audit
description: |
  Static, code-derived navigation / information-architecture audit — the
  system-level third lens complementing /persona-test (journey-level) and
  /click-test (page-level). Builds the whole nav graph from source, checks
  whether what's OFFERED matches what's NEEDED (grounded in the persona
  registry), and gates CI only on declared-intent regressions. A verify mode
  drives the live app to reconcile static-vs-live (per-persona scorecard +
  live findings); a bootstrap mode emits a review-queue nav-contract.json
  skeleton on first run.
  Triggers on: "map the nav flow", "navigation audit", "IA audit",
  "is the menu coherent", "nav map", "information architecture",
  "offered vs needed", "/nav-audit", "/ia-map".
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
  /nav-audit                         — static map + analysis of the repo's nav surface (--scope diff default)
  /nav-audit --scope full            — analyse the whole nav graph, not just the changed surface
  /nav-audit --bootstrap             — emit a review-queue nav-contract.json skeleton (first run)
  /nav-audit --gate                  — exit non-zero on a declared-intent regression on the changed surface
  /nav-audit --verify <url>          — live-verify: multi-state DOM layer attribution → scorecard pass/misplaced/missing + LIVE FINDINGS
  /nav-audit --verify <url> --breakpoints mobile,desktop --storage-state auth.json   — states to capture (default mobile,desktop) + auth
  /nav-audit --verify <url> --no-activate   — skip the collapsed-menu activation pass (faster; single-state capture only)
  /nav-audit --bootstrap --from-url <url>   — draft nav-contract.json navLayers from the live app (refuses to clobber; --force to replace)
```

# /nav-audit — Contract-backed Navigation Verifier (with static assists)

The third UX-quality lens. **persona-test is journey-first, click-test is
page-first, nav-audit is system-first.**

## Three modes (know which one you're in)

1. **static-only** (`/nav-audit`, no URL) — route/destination **inventory** + the
   pre-deploy **CI drift-gate** on declared-intent edges. Runs on a PR with no
   deployed URL. **Low confidence on data-driven nav** (the persona scorecard
   shows `?` and the audit says "run --verify"); honest by design.
2. **live-verified** (`/nav-audit --verify <url>`) — drives the live app across
   viewports and **authoritatively attributes each destination to its nav layer**,
   resolving the scorecard to `pass` / `misplaced` / `missing`. This is the
   trustworthy mode for dynamic/server-rendered nav. It ALSO runs the
   layer-attribution finding classes (competing-models, over-exposure/redundancy,
   sequencing) over the **live** evidence and emits them as **Live findings**
   (`source:'live'`) — so the system-level findings fire on data-driven apps the
   static taxonomy can't model (v1.3 #4). Findings are state-scoped: a destination
   in `primary@mobile` and `secondary@desktop` is responsive duplication, NOT
   over-exposure. To surface destinations hidden behind collapsed menus, a bounded
   **activation pass** opens hamburgers / collapsed sub-tab rows and re-snapshots
   (single-level, navigation-guarded, ≤8 per viewport; disable with `--no-activate`).
3. **contract-backed live** (a committed `nav-contract.json` + `--verify`) — the
   full IA audit: per-persona offered-vs-needed verdicts grounded in live DOM
   evidence. `--bootstrap --from-url <url>` drafts the contract's `navLayers` from
   the live app so you edit a smart baseline instead of a blank page.

Static analysis cannot model arbitrary data-driven nav (`data-view="${x}"`,
`switchView(el.dataset.view)`) — `--verify` is where the authority lives. The
static engine is kept for what live can't do: the pre-deploy gate + completeness
(orphans/unreachable a live crawl never clicks into). Its unit of analysis is the whole
navigation graph — all entry points × all destinations — and it answers: *is
the information architecture coherent — is what's offered what's needed, and
is it sequenced right?* A finding here (e.g. "two nav models coexist") is
literally invisible to a journey test; a journey finding ("this form is dense")
is invisible to a structural map.

It is **static / code-derived, not browser-driven** — for completeness (the
code contains every entry point and destination, including the rarely-hit ones
where orphans and redundancy hide), determinism, and near-zero cost. The static
graph is a set of **hypotheses, not truth** (~80% recall); `--verify` (v1.1)
raises confidence against the live app.

## The two-artifact split (the core idea)

Route-owned facts colocate **in code** (`export const navMeta = {...}` or a
`/** @nav … */` docblock) — they can't drift from the route. Cross-cutting
product intent lives in a tiny committed **`nav-contract.json`** (personas →
intents → expected anchors → nav-layer definitions). The observed nav graph is
**tool-generated every run** (gitignored). This split is what stops the contract
from rotting into a 200-route allowlist.

## Flow

### Phase 0 — First run: bootstrap the contract
If `nav-contract.json` is absent, run `node scripts/nav-audit.mjs --bootstrap`.
It emits a **review-queue** skeleton: obvious utility routes (`/oauth`, `/auth`,
`/404`) flagged, persona-intent candidates seeded from the registry, every
inferred entry marked `source:inferred` (lower CI authority until a human
confirms). **Never a trusted baseline** — review it, fill in real persona
intents + approved anchors, commit it.

**Persona-reachability seeding (when `PERSONA_TEST_REPO_NAME` is set).** Bootstrap
also seeds `personaIntents` from the REAL path each persona walked in `/persona-test`
(the `click_path` evidence): it calls `get-reachability-evidence`, normalizes each
reached URL to a destination, and emits intents with `source:"persona-test-evidence"`
(a higher authority than `inferred`, still human-reviewable — confirm + set
`requiredInLayer`). A URL that doesn't normalize is dropped (no false destination);
any reader failure (cloud off, no evidence) just seeds nothing and bootstrap proceeds.
The `--from-url` `navLayers` drafter prefers a sticky multi-target **bar** over a
hamburger/drawer **toggle** for `primary` (a role-less JS-built bottom bar still wins).
**Auth-gated apps: pass `--storage-state <auth.json>`.** An app whose primary nav renders
only after login will draft from the logged-out shell and mis-pick `primary`. The run warns:
generically when no auth state was given (`unauthenticatedDraft`), and **specifically when it
detects an EMPTY visible nav container** (`emptyNavShells`, e.g. `#primary-nav` rendered with
0 items) — that fires even WITH `--storage-state`, so an expired/invalid token is caught too.
The drafted `navLayers` is always a hypothesis to review before committing, never trusted.

#### Declare an `authSentinel` so `--verify` can prove the session is live

`--storage-state` alone does **not** prove you captured an authenticated app. A
committed `auth.json` expires, and an expired token yields a perfectly plausible
scorecard of the **logged-out shell** — which was the normal failure mode before
v1.5. Declare in `nav-contract.json` something that must be observable when a
session is genuinely live:

```json
{
  "version": 1,
  "_comment": "authSentinel: proves --storage-state actually authenticated. Optional.",
  "authSentinel": { "selector": "[data-testid=\"account-menu\"]", "expectText": "sign out" }
}
```

- `selector` (required) — any CSS selector. `expectText` (optional) — a
  substring, compared whitespace-collapsed and case-insensitively.
- **A match only counts if it is actually RENDERED** — the same predicate
  `/click-test` uses (`scripts/lib/browser/perceivable.mjs`). A `<template>`-resident,
  `display:none`, `visibility:hidden`, `opacity:0` or `[inert]` match does **not**
  qualify, so a stale account-menu left in the DOM cannot certify a dead session.
- Observed in **every** captured state and after the activation pass — `live` if
  it qualifies in any. That matters: the default breakpoints start with `mobile`,
  where an account menu usually sits inside a collapsed drawer.
- Pick something **only an authenticated user sees** (account menu, sign-out
  control). A nav item that also renders logged-out proves nothing.

Resulting `authLiveness`, and what it does:

| `--storage-state` | `authSentinel` | Observed | `authLiveness` | Effect |
|---|---|---|---|---|
| no | any | — | `n/a` | Normal unauthenticated run — **no degradation** |
| yes | absent | — | `unverified` | Cannot confirm ⇒ degraded to `unverified` |
| yes | declared | yes | `live` | Full authoritative verdicts |
| yes | declared | no | `dead` | Degraded; refresh the token and re-run |
| yes | declared | selector error | `unverified` | Authoring bug — never reported as `dead` |

**Degradation** replaces authoritative `misplaced`/`missing` verdicts with
`unverified` (reusing the v1.4 `unverifiableLayers` path) — the run reports that
it could not tell, rather than asserting a scorecard for the wrong surface.
Adding or changing `authSentinel` changes the contract digest, so a previously
persisted verify result correctly reads stale and must be re-run.

### Phase 1 — Extract the nav surface (automatic)
`node scripts/nav-audit.mjs [--scope diff|full]` detects nav affordances by
**behaviour, not framework** — `<a href>`/`<Link to>`/`<NavLink>`/Next
`<Link href>`, `navigate()/router.push()/switchView()`, `<Navigate>`, modal
triggers. Thin adapters (React Router / Next file-routing / vanilla switchView)
resolve raw targets to canonical destination ids. Output: a normalized edge list
+ the discovered route inventory. See `references/extraction-and-adapters.md`.

### Phase 2 — Build the model + attribute anchors
Collapse edges by destination (in-degree, affordance-type histogram). Attribute
each edge to its declared-anchor ancestors via **render-containment** (not exact
match — real nav composes `PrimarySidebar → NavGroup → NavItem → <a>`). Anchor
reachability is the static metric — **NOT** taps-to-reach (which static analysis
cannot measure; that's `--verify`'s job).

### Phase 3 — Run the findings taxonomy
10 classes, each P0–P3 with a one-line "offered vs needed" verdict and FP guards:
redundancy, coverage-gap, orphan, dead-end, label-inconsistency, surprising-
mapping, competing-models, sequencing, onboarding-overlap, anchor-regression.
Only **coverage-gap** and **anchor-regression** (declared-intent regressions) are
gate-eligible; everything else is advisory. See `references/finding-taxonomy.md`.

### Phase 4 — Report + (optional) gate
Output: (1) findings list, (2) destination × in-degree × affordance × anchor ×
verdict table, (3) a mermaid drilldown (capped, never the headline), (4) the
gitignored observed edge-list JSON. With `--gate`, exit `1` **only** when a
declared-intent divergence lands on the changed surface (merge-base diff).
Drift is **aged from cloud run-history** (a >14-day unclassified divergence is a
governance smell), not a local file. See `references/ci-gate-and-verify.md`.

## Output surfaces
- **PR comment** is the operational surface (advisory divergences).
- **Dashboard** (REGISTRY.reference) shows the accumulated state: a Per-Persona
  Reachability Scorecard + a Nav Drift indicator. Two panels only — the full
  graph is a drilldown, never the homepage.

## Exit codes
`0` clean / advisory-only · `1` hard-gate divergence (with `--gate`) · `2` tool
error · `3` needs-bootstrap (no contract).

## Honest limits
- The static graph sees **declared** structure, not **runtime-gated** (roles /
  flags / empty-state) — run `--verify <url>` to confirm against the live app and
  surface runtime-only nav.
- Judges **coherence**, not **desirability** — it surfaces and classifies
  redundancy; whether it's justified is product judgment.
- Extraction is AST-based (`@babel/parser`) with nested/relative route
  composition and monorepo app-root namespacing; vanilla apps' template-string
  HTML is recovered by scanning string/template literals. Recall is still
  hypotheses-not-truth (~80%) — `--verify` raises confidence.
- Per-screen quality + feel are click-test's and persona-test's job.
- **Coverage honesty, and what is deliberately not (yet) here**
  (`references/verification-discipline.md` §7): two existing mechanisms are
  already instances of the kernel's obligations — the `coverage-gap` finding
  kind above (a surface the model can't confirm is reachable is *reported*,
  not silently dropped) and the `authLiveness` degradation table (a run
  without a live auth sentinel degrades authoritative `misplaced`/`missing`
  verdicts to `unverified`, "rather than asserting a scorecard for the wrong
  surface"). A full per-run subject-line and per-edge taxonomy-classified
  rendering is **deferred, by name**: nav-audit's structured output is
  rendered by `scripts/nav-audit.mjs`, not composed from this file, so
  closing that gap is a code change outside this doc's own scope.

## Reference files

| File | Summary | Read when |
|---|---|---|
| `references/extraction-and-adapters.md` | Affordance detection, the discovery-only adapter interface, destination normalization, and per-stack notes. | Phase 1 — adding a stack adapter or debugging why an affordance/route was missed. |
| `references/finding-taxonomy.md` | The 10 finding classes with predicate, required evidence, FP guard, and gate-eligibility. | Phase 3 — interpreting a finding or tuning a false positive. |
| `references/contract-and-bootstrap.md` | The two-artifact split — navMeta/docblock grammar, nav-contract.json schema, and the bootstrap review-queue. | Phase 0 — authoring or bootstrapping the contract and route metadata. |
| `references/ci-gate-and-verify.md` | Drift-only CI gating, changed-surface scoping, cloud-sourced aging, and the v1.1 --verify runtime mode. | Phase 4 — wiring CI or reasoning about what blocks vs advises. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Reading the "Honest limits" section, to see which existing mechanisms already serve §7's obligations. |
| `examples/example-report.md` | A sample /nav-audit run: findings, destination table, mermaid drilldown, and the gate-vs-advisory split. | Want to see the shape of the output before running it. |
