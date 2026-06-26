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
| `content_clipping` | P1 | ✅ | `scrollWidth>clientWidth`, no ellipsis/wrap/scroll escape, AND box ≥4px (a collapsed/empty 1px label is a visibility concern, not text-overflow) |
| `unexpected_overlap` | P2 | ✅ | excludes ancestor-descendant containment AND cross-stacking-layer pairs (a fixed/absolute overlay covering page content is intentional — layer read from the surface's overlay ancestor); `allowOverlapWith` respected |
| `image_distortion` | P2 | ✅ | only with a distorting `object-fit` (`fill`/`none`) and >2% aspect mismatch |
| `missing_visible_focus` | P1 | ✅ | any visible focus indicator passes (outline OR box-shadow ring OR border OR bg) — not just `outline` |
| `disabled_not_signified` | P2 | ✅ | passes on `opacity<1` OR grayscale `filter` OR `cursor:not-allowed` |
| `state_has_no_visual_delta` | P2 | ✗ | report-only (hover-delta is advisory, not a regression gate); SVG-internal decorative tags skipped |
| `component_inconsistency` | info | ✗ | report-only unless a component is declared |
| `token_unreferenced` | info | ✗ | source-coherence (static, report-only) |
| `token_undefined_reference` | info | ✗ | source-coherence (static, report-only) |
| `token_duplicate_definition` | info | ✗ | source-coherence (static, report-only) |

**Inferred-cluster outliers** reuse the `token_violation` class but are always
`reportOnly: true` (never gate). The static run emits only the three
`token_*` coherence diagnostics — no paint findings.

## Accepted limitation — cross-layer overlap suppression

`unexpected_overlap` suppresses pairs in different stacking layers because an
overlay (fixed/absolute) covering page content is intentional ~always (modals,
dropdowns, tooltips). The narrow cost: a *genuine* overlap that legitimately spans
a stacking boundary would be missed. This is the right low-noise default — flagging
every overlay is the worse failure — and it's partial: only `fixed`/`absolute`
establish a layer here, **not `sticky`**, so the common real case (a sticky header
overlapping content on scroll) stays in-flow and still fires. Validated on
wine-cellar-app (pass 4): the 40 auth-overlay + 42 in-flow-header overlaps it
cleared were confirmed FPs by live pairwise geometry at desktop+mobile.
