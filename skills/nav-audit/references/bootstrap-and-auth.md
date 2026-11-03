---
summary: Bootstrap persona-reachability seeding, auth-gated --from-url drafting, and the authSentinel declaration rules.
---

# Bootstrap seeding and auth liveness

SKILL.md Phase 0 keeps the bootstrap command, the `--storage-state` rule for
auth-gated apps, and the `authLiveness` table. This file holds the detail.

## Persona-reachability seeding

**Persona-reachability seeding (when `PERSONA_TEST_REPO_NAME` is set).** Bootstrap
also seeds `personaIntents` from the REAL path each persona walked in `/persona-test`
(the `click_path` evidence): it calls `get-reachability-evidence`, normalizes each
reached URL to a destination, and emits intents with `source:"persona-test-evidence"`
(a higher authority than `inferred`, still human-reviewable — confirm + set
`requiredInLayer`). A URL that doesn't normalize is dropped (no false destination);
any reader failure (cloud off, no evidence) just seeds nothing and bootstrap proceeds.

## Auth-gated `--from-url` drafting

The `--from-url` `navLayers` drafter prefers a sticky multi-target **bar** over a
hamburger/drawer **toggle** for `primary` (a role-less JS-built bottom bar still wins).
**Auth-gated apps: pass `--storage-state <auth.json>`.** An app whose primary nav renders
only after login will draft from the logged-out shell and mis-pick `primary`. The run warns:
generically when no auth state was given (`unauthenticatedDraft`), and **specifically when it
detects an EMPTY visible nav container** (`emptyNavShells`, e.g. `#primary-nav` rendered with
0 items) — that fires even WITH `--storage-state`, so an expired/invalid token is caught too.
The drafted `navLayers` is always a hypothesis to review before committing, never trusted.

## Declare an `authSentinel` so `--verify` can prove the session is live

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
