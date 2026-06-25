---
summary: Affordance detection, the discovery-only adapter interface, destination normalization, and per-stack notes.
---

# Extraction & Adapters

## Behaviour, not framework

`scripts/lib/nav/extract.mjs` owns the **universal** affordance detector. It
recognises nav primitives by shape, identically across stacks:

- `<a href="…">`, `<Link to="…">` (React Router), `<Link href="…">` (Next),
  `<NavLink to="…">`
- `navigate(…)`, `router.push(…)`, `history.push(…)`, `router.replace(…)`,
  `switchView(…)`, `setView(…)`
- `<Navigate to="…">` (redirect)
- `openModal(…)` / `showModal(…)` / `openOverlay(…)` → modal pseudo-destinations,
  namespaced `modal:<key>` so they never collide with routes/views

Each match becomes an edge `{entryPoint, layer, anchor, affordanceType, label,
destination, confidence, sourceLoc}`. `anchor` is left `null` here — it is
attributed later by the model via render-containment.

## Adapters are discovery-only

Framework knowledge is quarantined to thin adapters (`adapters/*.mjs`). The
interface is deliberately minimal so adapters can never re-implement affordance
detection (which would re-create the per-stack plugin explosion):

```
detect(root, sources): boolean                 // is this stack present?
discoverDestinations(sources): [{id, sourceLoc, raw}]   // route inventory
resolveDestination(raw, ctx): string | null     // raw target → canonical id
```

A new framework is **one file** in `adapters/` plus a line in `adapters/index.mjs`.
Multiple matching adapters is normal — destination discovery is **unioned**;
single-target resolution is first-active-wins.

## Canonical normalization

`scripts/lib/nav/normalize.mjs` collapses cosmetic + dynamic variation so
`/projects/[id]`, `/projects/:id`, and `/projects/123` all map to one id
(`/projects/:param`). Rules: strip query/hash, collapse trailing slash, dynamic
segment → `:param`, catch-all/splat → `:rest`, Next route groups `(group)`
removed, optional segment emits both variants, computed `${…}` tails lower
confidence, fully-opaque targets → `<dynamic>` (excluded from hard-gates).

## Per-stack notes & v1 bounds

- **vanilla-switchview** — activates only on a `switchView(`/`setView(` call (a
  bare `VIEWS = {}` map is too weak). Resolves `VIEWS.X` via the parsed map value.
- **react-router** — `<Route path>` + route-object literals (require an
  `element`/`Component`/`loader` sibling so unrelated `path:` props aren't
  captured). **Nested/relative route composition is a v1.1 bound** — relative
  child paths are normalised standalone.
- **next-file** — destinations derived from file paths (`pages/**`, `app/**/page`).
  **Parallel (`@slot`) / intercepting (`(.)`) routes are a v1.1 bound.**

All bounds sit inside the plan's "~80% recall, hypotheses-not-truth" contract.
Recall is reported every run (`extracted` / `lowConfidence` / `opaque`) — nothing
is silently dropped. Sensitive paths are filtered via the symlink-aware
`resolveAndClassify` before any file is read.
