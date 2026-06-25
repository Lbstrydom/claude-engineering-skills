---
summary: The two-artifact split — navMeta/docblock grammar, nav-contract.json schema, and the bootstrap review-queue.
---

# Contract & Bootstrap

## The two artifacts

1. **Route-owned facts — in code** (`scripts/lib/nav/contract.mjs::parseNavMeta`).
   They live with the route so they can't drift from it.

   ```ts
   export const navMeta = {
     deepLinkOnly?: boolean,           // suppresses the orphan finding
     utility?: boolean,               // /oauth, /404 class
     terminal?: boolean,              // suppresses the dead-end finding
     navClass?: 'primary'|'secondary'|'utility',
     anchor?: string,                 // the anchor component this route sits under
     abVariant?: string,              // suppresses onboarding-overlap
     roleGated?: string[],            // informational (runtime role→persona is --verify)
   }
   ```

   Docblock equivalent (same fields, same AST pass):
   `/** @nav deepLinkOnly navClass=primary roleGated=admin,owner anchor=PrimarySidebar */`

   An optional TS type annotation (`export const navMeta: NavMeta = {…}`) is
   supported. Unknown keys are ignored with a low-confidence note (forward-
   compatible). Binding: a module-scope claim binds to the file's single
   discovered destination; ambiguous multi-route files drop the claim rather than
   mis-attribute.

2. **Product intent — `nav-contract.json`** (committed, strict schema). Keep it
   small: only declared personas/intents/anchors, never the route long-tail.

   ```jsonc
   {
     "version": 1,
     "appRoots": ["apps/web"],                 // optional; monorepo namespacing
     "navLayers": { "primary": ["PrimarySidebar"], "secondary": ["SettingsContext"] },
     "personas": [
       { "id": "enterprise-admin",
         "intents": [
           { "id": "revoke-user", "destination": "/admin/users/:param",
             "approvedAnchors": ["PrimarySidebar"], "requiredInLayer": "primary",
             "frequency": "high", "source": "declared" }
         ] }
     ]
   }
   ```

   The schema is **strict** — a typo'd key (`approvedAnchor`, `requiredLayer`)
   fails loudly rather than being silently stripped. Human-authored destinations
   are canonicalized to the same id space the extractor produces, so
   `/projects/[id]` matches an observed `/projects/:param`.

## Anchor identity — two modes

- **React/component apps**: an anchor is the exported component/symbol name (from
  the symbol index), disambiguated `Name@path.tsx` on collision. The model
  attributes each edge to **all** its declared-anchor ancestors via render-
  containment, so a component reused under several anchors is reachable from all.
- **Vanilla / template apps**: an anchor is a **DOM-container selector** — `#id`
  or a nav-ish `.class` (e.g. `"navLayers": {"primary": ["#primary-nav"],
  "secondary": [".sub-tabs-row"]}`). Embedded affordances (`<a href>`, inline
  `switchView`, `data-view="…"`) are attributed to their nearest enclosing
  container in the template HTML.

## `exclude` + dynamic-nav reality

- `nav-contract.json` may carry an `"exclude": ["dashboard/**", …]` array to drop
  sibling apps / non-app dirs on top of the built-in tests/fixtures/build excludes.
- `VIEWS = Object.freeze({...})` is read by **value** (`DRINK_SOON: 'drinksoon'`),
  not by kebab-casing the key.
- When nav is **data-driven** (`data-view="${x}"`, `switchView(el.dataset.view)`),
  destinations are discovered (from the `VIEWS` registry) but per-view *anchors*
  are statically undeterminable. The audit then degrades honestly: a reached-but-
  unanchored intent is a **P3 `coverage-unverified`** (not a P1 gate), many
  zero-inbound views roll up into one **`dynamic-nav-detected`** advisory, and the
  scorecard marks those rows **`?` (run --verify)** rather than a false `✗`. For
  these apps, **`--verify <url>` is the authoritative offered-vs-needed signal.**

## Bootstrap from the live app (`--from-url`)

`node scripts/nav-audit.mjs --bootstrap --from-url <url>` crawls the **live** nav
containers (the same multi-state Playwright drive `--verify` uses) and drafts a
`navLayers` map (most-prominent nav container → `primary`, sub-tab rows →
`secondary`) plus an `observedTargets` list (written under a `_note` comment), so a
first-time user **edits a smart baseline instead of a blank page**. Deterministic —
no LLM (cut for egress safety). It **refuses to overwrite an existing
`nav-contract.json`** (pass `--force` to replace) — bootstrap is never destructive.
The draft is a starting point: you'll typically consolidate per-tab ids into your
real `#primary-nav` / `.sub-tabs-row` selectors and map `observedTargets` to
persona intents.

## Bootstrap = review queue, never a baseline

`node scripts/nav-audit.mjs --bootstrap` writes a skeleton with every inferred
entry marked `source:inferred` and a side list of inferred-utility routes. It is
a starting point for human review, not a trusted baseline — CI gives inferred
intents lower authority until a human flips them to `declared` (which, because
`source` is part of the contract digest, correctly re-triggers evaluation).
