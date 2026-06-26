---
summary: A sample human + JSON visual-audit report for reference.
---

# Example report

## Human (`--format human`)

```
═══════════════════════════════════════
  /visual-audit — LIVE VERIFY
  URL: https://app.example.com/pricing
  States: desktop/light, desktop/dark, mobile/light, mobile/dark
═══════════════════════════════════════

Contracted-surface scorecard:
  🔴 pricing-cards — 2 violation(s)
  🟢 header — 0 violation(s)
  🟡 testimonials — UNVERIFIED (capture stall/empty)

Findings: 4 (2 gate-eligible)
  ⛔ [P1] theme_unmapped_token — pricing-cards/vid:plan-price-2/desktop {color}
      expected: value should adapt across themes (token-mapped) | actual: literal 34,34,34 identical in light & dark
  ⛔ [P1] missing_visible_focus — pricing-cards/button[button]:2/desktop {focus}
      expected: visible focus indicator (outline/ring/border/bg) on :focus-visible | actual: no visible delta vs default
  · [P2] state_has_no_visual_delta — header/a[link]:3/desktop {hover}
      expected: a visible default→:hover paint change | actual: no :hover delta
  · [info] token_violation — pricing-cards/…/mobile {radius}
      expected: dominant inferred cluster | actual: 11px (used by 8% — inferred outlier)

⚠ Unverifiable surfaces (degraded, not gated): testimonials

⛔ 2 gate-blocking finding(s) on the changed surface
```

## JSON (`--out report.json`)

```jsonc
{
  "mode": "verify",
  "url": "https://app.example.com/pricing",
  "statesCollected": ["desktop/light", "desktop/dark", "mobile/light", "mobile/dark"],
  "scorecard": [
    { "surfaceId": "pricing-cards", "status": "verified", "violations": 2 },
    { "surfaceId": "testimonials", "status": "unverified", "violations": 0 }
  ],
  "findings": [
    {
      "class": "theme_unmapped_token", "severity": "P1",
      "surfaceId": "pricing-cards", "nodeKey": "vid:plan-price-2",
      "device": "desktop", "theme": "light", "property": "color",
      "expected": "value should adapt across themes (token-mapped)",
      "actual": "literal 34,34,34 identical in light & dark",
      "gateEligible": true, "source": "live"
    }
  ],
  "unverifiableSurfaces": ["testimonials"],
  "gateBlockers": 2
}
```
