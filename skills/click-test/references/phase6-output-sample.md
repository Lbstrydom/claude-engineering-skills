---
summary: Full Phase 6 output sample — finding entries, single-device and matrix ROUTE COVERAGE, CROSS-DEVICE, DYNAMIC SURFACES.
---

# Phase 6 output — full sample

The header, block order and OVERALL VERDICT RULES stay resident in SKILL.md.
This is the full illustrative body.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CLICK-TEST REPORT
  URL: <base>
  Routes: <list>
  Devices: <name(s)>   (e.g. "mobile (390x844)" or "desktop, mobile" for matrix)
  Scope: <scope>   Modals: <on|off>   Cache-bust: <own-app|forced|skipped-external|n/a>
  Ready-selector: <css>   Ready-timeout: <ms>
  Tool: <browser_tool> — <N> elements scanned (across all device passes) — <duration>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINDINGS (<total>)
────────────────────────────────────────────────────
  [P0] duplicate-id "wine-card-3" (4 occurrences)
     Device:   mobile
     Route:    /cellar
     Via:      static
     Selector: #wine-card-3
     Detail:   Repeated by the wine grid renderer when filter is active;
               React will reconcile the wrong nodes on next render
     Snippet:  <div id="wine-card-3" class="..."> [redacted if needed]

  [P0] input-no-name <input type="text">
     Device:   mobile
     Route:    /cellar
     Via:      modal:"Add bottle"
     Selector: form.add-bottle > input[type=text]:nth-child(2)
     Detail:   No label, aria-label, aria-labelledby, or placeholder.
               Screen readers announce this as "edit text" with no context.
     Snippet:  <input type="text" class="form-control">

  ...

ROUTE COVERAGE  (single-device run)
────────────────────────────────────────────────────
  /          — scanned          — 47 elements — 0 findings
  /cellar    — scanned          — 312 elements — 8 findings (P0:2, P1:1, P2:5)
  /admin     — auth-required    — 0 elements — skipped (login wall)
  /reports   — readiness-timeout — 0 elements — skipped (ready-selector never matched)

ROUTE COVERAGE  (per-device matrix — only when --devices used)
────────────────────────────────────────────────────
  device=desktop (1280x720)
    /          — scanned — 47 elements — 0 findings
    /cellar    — scanned — 312 elements — 4 findings (P0:1, P2:3)
  device=mobile (390x844)
    /          — scanned — 47 elements — 1 finding (P2:1 small-touch-target)
    /cellar    — scanned — 308 elements — 9 findings (P0:2, P1:2, P2:5)

  CROSS-DEVICE
    Shared (both):     4 findings — duplicate-id × 2, orphan-label × 2
    Desktop-only:      0
    Mobile-only:       6 findings — small-touch-target × 4, input-no-name × 2
    Interpretation: 6 issues only surface on mobile — typical responsive-CSS gap.

DYNAMIC SURFACES (--with-modals)
────────────────────────────────────────────────────
  device=mobile  /cellar: 12 triggers — 8 scanned, 2 skipped-destructive, 2 modal-stuck
  device=mobile  /admin:  — (route skipped)

OVERALL: <Broken | Broken+Incomplete | Has issues | Incomplete | Clean>
  Reason: <one sentence>
```
