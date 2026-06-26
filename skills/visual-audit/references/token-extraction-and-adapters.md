---
summary: Token-source adapters (Tailwind/CSS-vars/JSON), allowed-set normalization, inferred-cluster fallback.
---

# Token extraction & adapters

`scripts/lib/visual/tokens.mjs` parses the app's *declared* design scale into an
allowed-set + a `TokenIndex`, so the live layer reconciles computed values against
intent instead of guessing.

## Adapter registry (strategy-over-switch)

A new token source = one new adapter `{ type, detect(path), extract(absPath, theme) }`.
v1 ships three:

| `type` | Source | Notes |
|---|---|---|
| `css-vars` | `:root { --x: v }` custom properties (any scoped block) | family inferred from var-name + value shape; `var()` aliases skipped |
| `json` | plain or Style-Dictionary `tokens.json` | family from the key path (`colors`, `spacing`, …) or `{ value }` leaves |
| `tailwind` | `tailwind.config.{js,cjs,mjs}` **only** | a `.ts` config is **not executed** by this plain-ESM tool → warning; point at a generated `tokens.json` (`tailwindcss --dump` / Style-Dictionary) |

Conflicting definitions across sources are emitted as **diagnostics, not silent
overrides**; precedence is the `tokenSources` order in the contract. Arbitrary-value
/ plugin-generated Tailwind classes that can't be resolved statically become
`warnings`, never false allowed-set entries.

## Normalization (shared canonical-value space)

`normalizeColor` → `r,g,b[,a]`; `normalizeLength` → px (rem×16, rounded 0.1px);
`normalizeByFamily` handles fontWeight keywords (`bold`→`700`) and unitless
lineHeight. Reconcile-tokens + theme-parity reuse these so the comparison space is
identical to extraction.

## Inferred-cluster fallback (token-less apps)

`inferClusters(observedValues)` flags a minority value only when a **dominant cluster
exists** (≥60% share) — e.g. "95% of paddings are 8px, this one is 11px". This path
is **report-only, never gate-eligible** (`reportOnly: true`, severity `info`). It's
the noisy fallback; the declared-token path is the trustworthy one.
