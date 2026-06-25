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

## Anchor identity

An anchor string is the exported component/symbol name (from the symbol index),
disambiguated `Name@path.tsx` on collision. The model attributes each edge to
**all** its declared-anchor ancestors via render-containment, so a component
reused under several anchors is reachable from all of them.

## Bootstrap = review queue, never a baseline

`node scripts/nav-audit.mjs --bootstrap` writes a skeleton with every inferred
entry marked `source:inferred` and a side list of inferred-utility routes. It is
a starting point for human review, not a trusted baseline — CI gives inferred
intents lower authority until a human flips them to `declared` (which, because
`source` is part of the contract digest, correctly re-triggers evaluation).
