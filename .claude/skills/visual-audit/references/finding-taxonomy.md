---
summary: The 15 finding classes — severity, gate-eligibility, guards that prevent false positives.
---

# Finding taxonomy

Every finding carries `{class, severity, surfaceId, nodeKey, device, theme, property,
expected, actual, evidence, gateEligible, source}`. Severity defaults live in
`findings.mjs::SEVERITY_BY_CLASS`. Gate-eligibility = the class is in
`GATE_ELIGIBLE_CLASSES` **and** the finding isn't `reportOnly`.

| Class | Sev | Gate? | Guard that prevents false positives |
|---|---|---|---|
| `token_violation` | P1 | ✅ | skipped in inferredMode; neutral defaults (`0px`/`none`/`transparent`) ignored; absolved if the *winning* declaration uses a token var |
| `theme_geometry_drift` | P2 | ✅ | only compared for nodes rendered (displayed, non-zero box) in **both** themes — a theme-conditional `display:none` element is excluded |
| `theme_unmapped_token` | P1 | ✅ | only an **untokened literal** identical across themes; a tokened theme-agnostic value is fine |
| `contrast_failure` | P1 | ✅ | only fires over a **resolved opaque** backdrop (gradient/image/unresolvable → `unverified`, no finding) |
| `layout_overflow` | P2 | ✅ | needs the viewport width; 1px tolerance |
| `content_clipping` | P1 | ✅ | only when `scrollWidth>clientWidth` AND no ellipsis/wrap/scroll escape |
| `unexpected_overlap` | P2 | ✅ | ancestor-descendant pairs excluded (a child always intersects its parent); `allowOverlapWith` respected |
| `image_distortion` | P2 | ✅ | only with a distorting `object-fit` (`fill`/`none`) and >2% aspect mismatch |
| `missing_visible_focus` | P1 | ✅ | any visible focus indicator passes (outline OR box-shadow ring OR border OR bg) — not just `outline` |
| `disabled_not_signified` | P2 | ✅ | passes on `opacity<1` OR grayscale `filter` OR `cursor:not-allowed` |
| `state_has_no_visual_delta` | P2 | ✗ | report-only (hover-delta is advisory, not a regression gate) |
| `component_inconsistency` | info | ✗ | report-only unless a component is declared |
| `token_unreferenced` | info | ✗ | source-coherence (static, report-only) |
| `token_undefined_reference` | info | ✗ | source-coherence (static, report-only) |
| `token_duplicate_definition` | info | ✗ | source-coherence (static, report-only) |

**Inferred-cluster outliers** reuse the `token_violation` class but are always
`reportOnly: true` (never gate). The static run emits only the three
`token_*` coherence diagnostics — no paint findings.
