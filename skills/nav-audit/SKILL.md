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
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. If this repo defines
> no such script, add it from `references/worktree-preflight.md`.

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

> **This skill's last line is an end marker naming the skill between em-dashes, after
> the Reference files table.** If that last line is not in your context (context
> compaction keeps only the start of a skill), re-read
> `.claude/skills/nav-audit/SKILL.md` in full before continuing — the later steps still apply.

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

Static analysis cannot model arbitrary data-driven nav — `--verify` is where the
authority lives; the static engine is kept for the pre-deploy gate + completeness
(orphans/unreachable a live crawl never clicks into), and its graph is a set of
**hypotheses, not truth** (~80% recall). → `references/design-rationale.md` §Why a
static engine at all — read when asked why static analysis is kept beside `--verify`.

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

With `PERSONA_TEST_REPO_NAME` set, bootstrap also seeds `personaIntents` from
`/persona-test` click-path evidence (`source:"persona-test-evidence"`, still
human-reviewable); a reader failure seeds nothing and bootstrap proceeds.
**Auth-gated apps: pass `--storage-state <auth.json>`** — otherwise `--from-url`
drafts from the logged-out shell and mis-picks `primary`. The drafted `navLayers`
is always a hypothesis to review before committing, never trusted.
→ `references/bootstrap-and-auth.md` §Persona-reachability seeding / §Auth-gated
`--from-url` drafting — read when running `--bootstrap`, or a draft warned
`unauthenticatedDraft` / `emptyNavShells`.

#### Declare an `authSentinel` so `--verify` can prove the session is live

`--storage-state` alone does **not** prove you captured an authenticated app — an
expired token yields a plausible scorecard of the **logged-out shell**. Declare an
`authSentinel` (`selector` + optional `expectText`) in `nav-contract.json`: something
**only an authenticated user sees**, counted only if actually RENDERED.
→ `references/bootstrap-and-auth.md` §Declare an `authSentinel` — read when using
`--verify --storage-state`, or authoring/debugging the sentinel.

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
- **Coverage honesty**: `coverage-gap` reports (never drops) an unconfirmable
  surface, and `authLiveness` degrades unproven verdicts to `unverified`; a
  per-run subject-line rendering is **deferred, by name**.
  → `references/design-rationale.md` §Coverage honesty — read when asked which
  §7 (`references/verification-discipline.md`) obligations are met or deferred.

## Reference files

| File | Summary | Read when |
|---|---|---|
| `references/extraction-and-adapters.md` | Affordance detection, the discovery-only adapter interface, destination normalization, and per-stack notes. | Phase 1 — adding a stack adapter or debugging why an affordance/route was missed. |
| `references/finding-taxonomy.md` | The 10 finding classes with predicate, required evidence, FP guard, and gate-eligibility. | Phase 3 — interpreting a finding or tuning a false positive. |
| `references/contract-and-bootstrap.md` | The two-artifact split — navMeta/docblock grammar, nav-contract.json schema, and the bootstrap review-queue. | Phase 0 — authoring or bootstrapping the contract and route metadata. |
| `references/bootstrap-and-auth.md` | Bootstrap persona-reachability seeding, auth-gated --from-url drafting, and the authSentinel declaration rules. | Phase 0 — running `--bootstrap`, a draft warned `unauthenticatedDraft`/`emptyNavShells`, OR using `--verify --storage-state`. |
| `references/ci-gate-and-verify.md` | Drift-only CI gating, changed-surface scoping, cloud-sourced aging, and the v1.1 --verify runtime mode. | Phase 4 — wiring CI or reasoning about what blocks vs advises. |
| `references/design-rationale.md` | Why nav-audit keeps a static engine beside --verify, and which existing mechanisms already serve coverage honesty. | Asked why static analysis is kept beside `--verify`, OR which coverage-honesty obligations are met or deferred. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Reading the "Honest limits" section, to see which existing mechanisms already serve §7's obligations. |
| `examples/example-report.md` | A sample /nav-audit run: findings, destination table, mermaid drilldown, and the gate-vs-advisory split. | Want to see the shape of the output before running it. |
| `references/worktree-preflight.md` | Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree. | A command dies with `MODULE_NOT_FOUND` in a linked worktree AND this repo has no `skills:hydrate` script. |

— end of /nav-audit —
