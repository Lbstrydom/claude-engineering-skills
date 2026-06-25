---
summary: Drift-only CI gating, changed-surface scoping, cloud-sourced aging, and the v1.1 --verify runtime mode.
---

# CI Gate, Drift & Verify

## Gate = drift, not exceptions

The gate hard-fails (`exit 1`, only with `--gate`) **only** when a gate-eligible
finding (coverage-gap or anchor-regression — a declared-intent regression) lands
on the **changed surface**. Everything else is an advisory PR comment. There is
no `expires:`-dated exception model (a shadow-Jira devs auto-bump); instead the
tool observes divergence and **ages** it.

## Changed-surface scoping

`--scope diff` (default) computes the changed set against the **merge-base with
the default branch** (`git merge-base origin/HEAD HEAD`) — not `HEAD~1`, which is
unsafe on multi-commit branches / merge commits / shallow CI checkouts. A finding
is gate-eligible iff its evidence files intersect the diff (a contract edit makes
all declared intents eligible). When no merge-base exists, diff mode degrades to
advisory-only — never a false block.

Extraction **always builds the complete graph** regardless of scope; `--scope
diff` only narrows what *blocks*, so the scorecard/in-degree/anchor-reachability
are always computed against complete data.

## Base graph for regression

Class-10 regression compares the head graph against a **recomputed base graph**
(extraction re-run on the changed+deleted files at the merge-base via `git show`),
never a committed/gitignored prior envelope — so CI needs nothing in
`.audit-loop/` to exist.

## Cloud-sourced aging

`firstSeen(divergenceKey)` is the earliest `record-nav-audit-run` row carrying
that key (cloud run-history is the durable timeline). A gitignored
`nav-drift-ledger.json` is only a local-dev convenience cache; its absence in CI
is harmless. A >14-day unclassified divergence is a governance smell, surfaced
like the `migration-drift` sticky issue. Cloud-off → aging collapses to
present/absent (no age), never wrong.

## Envelope freshness

The observed envelope's `configDigest = sha256(adapterVersion + contractDigest)`
covers only inputs the reader can recompute (the proven `observed-deps.mjs`
pattern). Source-file staleness is **not** in the digest (a self-referential
file-sha digest can't see a link added in a new file); it's handled by
regenerating the envelope every run + an advisory "may be stale — re-run
/nav-audit" banner when `headSha`/`generatedAt` lags the latest nav-source commit.

## --verify (the authoritative mode)

`--verify <url>` drives the live app with Playwright (headless Chromium) **across
multiple states** (viewports via `--breakpoints`, default `mobile,desktop`; plus an
optional `--storage-state <path>` for auth) and does two things:

**1. Layer attribution → the per-persona scorecard (the headline).** For each live
nav target it records the **DOM container** it sits in (`el.closest()` against your
`navLayers` selectors), unioned across states, then resolves every persona row to a
definitive verdict — replacing the static `?`:
- **pass** — the destination appears in its `requiredInLayer` container in ≥1 state.
- **misplaced** — it's live, but never in the required layer (e.g. found in
  `.sub-tabs-row` when the contract requires `#primary-nav`).
- **missing** — not in the live nav in any fully-collected state.
- **unverified** — a requested state failed (partial coverage); re-run.
This is what makes the skill trustworthy on data-driven nav the static engine can't
attribute. `runVerify` is a library fn (returns `{ok:false}` on a browser failure;
the CLI maps that to exit 2 + a "install chromium" hint). Authenticated runs redact
live labels and print a notice.

Each `--verify` run persists its live attribution to a gitignored
`.audit-loop/nav-verify-result.json` (tied to the contract digest). The **dashboard
Nav Audit tab** reads it and shows the authoritative live verdicts (with a
"Live-verified from `<url>` · `<states>`" banner); it falls back to the static
scorecard when no fresh live result exists.

**2. Static-vs-live reconciliation** — the three buckets:

- **confirmed** — static destinations that appear in the live nav (slug↔path
  tolerant, so a static `wines` matches a live `/wines`).
- **static-only** — static destinations the live landing nav doesn't surface
  (dead-link/deep-link/gated, an extraction false-positive, or a real naming
  inconsistency like static `drink-soon` vs live `/drinksoon`).
- **runtime-only** — live nav targets absent from the static model — the
  role/flag/empty-state-gated nav static analysis fundamentally can't see.

It also reports, per declared persona intent, whether the destination is present
in the landing nav. Live targets are collected from `<a href>` plus vanilla
view-switch handles (`data-view`/`data-target`/`data-nav`/`data-tab`), and query-
param view routing (`?view=today` → `today`) is normalized to the static id space.
Works with or without a committed contract (exploratory). Deeper taps-to-reach
BFS is a future enhancement; v1 reports landing-nav reachability.
