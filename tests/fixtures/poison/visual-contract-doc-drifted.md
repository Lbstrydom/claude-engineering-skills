---
summary: `visual-contract.json` schema + `--bootstrap` recipe, `data-visual-id` opt-in, theme-apply protocol.
---

# Contract & bootstrap

The committed **`visual-contract.json`** is the product-intent artifact (the observed
allowed-set + live findings are gitignored). Schema is **strict** — a typo on a
meaningful key fails loudly (`scripts/lib/visual/schema.mjs`).

## Schema (v1)

```jsonc
{
  "version": 1,
  "appRoots": ["apps/web"],                 // optional monorepo namespacing
  "exclude": ["**/*.stories.*"],            // optional
  "surfaces": [{
    "id": "pricing-cards",                  // stable; the attribution + drift key root
    "selector": ".pricing-grid",            // contracted root; audited subtree
    "sourceGlobs": ["apps/web/src/pricing/**"], // surface → owner files for the gate
    "component": "PlanCard",                // optional; enables intra-component checks
    "excludeSelectors": [".promo-hero"],    // intentional-variation escape hatch
    "allowOverlapWith": [".tooltip"],       // layout-physics allowlist
    "nodeBudget": 400,                      // cap; exceeding → unverified_due_to_budget
    "interactiveBudget": 120                // cap on CDP-per-node pseudo-state probing
  }],
  "tokenSources": [{ "type": "css-vars", "path": "src/tokens.css", "theme": null }],
  "themes": [
    { "name": "light", "apply": { "mode": "class", "target": "html", "value": "light" } },
    { "name": "dark",  "apply": { "mode": "class", "target": "html", "value": "dark" } }
  ],
  "globalStyleGlobs": ["apps/web/src/styles/**", "apps/web/src/components/ui/**"],
  "tolerances": { "geometryPx": 1, "contrastRatio": 4.5 },
  "propertyPolicy": {
    "tokenAudited": ["colors","spacing","radius","borderWidth","fontSize","lineHeight","fontWeight","shadow"],
    "mustMatchGeometry": ["width","height","flex-basis","grid-template","padding","margin"]
  }
}
```

## Theme-apply protocol (discriminated union on `mode`)

- `class` — `{ target, value, settleSelector? }` — adds a class on `target`.
- `attribute` — `{ target, attribute, value }` — sets an attribute.
- `localStorage` — `{ key, value }` — seeded via `addInitScript` **before** app init, then reload.
- `media` — `{ colorScheme: 'light'|'dark' }` — applied via context `colorScheme` emulation.

extract.mjs verifies the theme took; an absent toggle → that theme is `unverified`.

## `data-visual-id` opt-in

For apps with unstable DOM, pin a critical node with `data-visual-id="pay-cta"`. The
stable node-key becomes `vid:pay-cta`, surviving DOM reshuffles across themes/runs.

## Bootstrap

```bash
node scripts/visual-audit.mjs --bootstrap          # writes a review-queue skeleton
node scripts/visual-audit.mjs --bootstrap --force  # replace an existing contract
```

Fill `surfaces[].sourceGlobs`, declare `tokenSources` + `themes`, then remove the
`_note`. The skeleton never overwrites an existing contract without `--force`.

An un-edited skeleton (empty `sourceGlobs`) is intentionally left invalid: the
next normal (non-`--bootstrap`) `visual-audit` run fails with an error naming
the surface and the missing field, rather than silently auditing a contract
with no gate-attributable surfaces.
