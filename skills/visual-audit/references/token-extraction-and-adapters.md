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

### `light-dark()` colours (css-vars only)

A `--x: light-dark(<light>, <dark>)` declaration is ONE property carrying BOTH
themes — the per-source `theme` model can't express that, so the adapter splits
it into two theme-scoped tokens (`{value: light, theme: 'light'}` +
`{value: dark, theme: 'dark'}`) sharing one `varName`. If the *source* also
declares a `theme` (a per-theme stylesheet), only the matching half is kept and
the source emits one aggregated `token_light_dark_theme_scoped` warning naming
how many declarations lost a half — never a silent drop of the other half.
Found 2026-09-21: a 22-colour `light-dark()` tokens.css extracted as
`colors: absent, warnings: []` before this existed, because `normalizeColor`
doesn't parse `light-dark(...)` and the (then colour-blind) `familyForVar`
name-matcher found nothing to classify it by either.

### Unparseable colour values

`normalizeColor` only recognises hex and `rgb()`/`rgba()` — a `hsl()`, `oklch()`
or `color-mix()` value is legitimately out of scope for it. A variable whose
NAME still reads as a colour (`--color-*` / `--*-color(-*)`) but whose value
the normaliser can't parse emits `token_unparsed_color` and is dropped from the
scale, rather than falling through `familyForVar`'s value-only color check and
vanishing as an unclassified, unwarned token. Applies to every adapter (the
warning fires in the shared `extractAllowedSet` normalization step, not per
adapter).

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
