# wine-cellar-app event-wiring oracle — snapshot provenance

**Pinned commit**: `274ad342` (`wine-cellar-app`, "feat(models): Opus 4.8 + Sonnet 5
flip + real eval gate + cache fix (#97)") — the commit immediately **before**
PR #98 (`e01a49a6`) wired the two real bugs this oracle exists to reproduce.

## Why this commit, and not `docs/migration/frontend-inventory.md`

`docs/plans/event-wiring-symmetry.md` originally cited "all 7 events... transcribed
from `frontend-inventory.md:21-35`". That citation does not resolve: PR #98's own
commit message references an "Orphan-CustomEvent investigation... 2026-07-03", and
`frontend-inventory.md` did not exist in the repo until **after** that investigation
(it is absent from `e01a49a6^`). There is no committed file that shows the 7-event
state by that name. This pack was rebuilt from the actual historical source instead
of trusting the uncheckable citation — see `docs/plans/event-wiring-symmetry.md`'s
audit trail (Phase 0, `/cycle --autonomous` session, 2026-08-18) for the discovery.

## Reconstruction method

A throwaway scan (adapted from `wine-cellar-app`'s own
`docs/migration/tools/frontend-inventory-scan.mjs` detection regexes) was run
against a detached worktree at `274ad342`, filtered to kebab/colon-shaped event
names (unambiguously custom, sidestepping the need to replicate the native-event
blocklist exactly). It found exactly 7 dispatch-only custom events — matching the
plan's cited count independently.

## The 7 events and their verified dispositions

Each disposition is verified against the actual fix commit, not asserted:

| Event | Dispatcher (at `274ad342`) | Disposition | Verified by |
|---|---|---|---|
| `cellar:mutation` | `shared/undoToast.js:108` | **REAL-BUG** (confirmed defect) | `e01a49a6` wired `refreshInventoryViews` — commit message: "the designed fan-out was never wired" |
| `wineShop:coldStartAction` | `wineShop/index.js:1356` | **REAL-BUG** (confirmed defect) | `e01a49a6` wired routing "through tier-gated switchView / add-bottle modal (was a console-only no-op)" |
| `agent-chat:ready` | `agentChat/panel.js:138` | **DELETED** | `e01a49a6`: "delete redundant agent-chat:ready / restaurant-pairing:ready dispatches" |
| `restaurant-pairing:ready` | `restaurantPairing.js:497` | **DELETED** | same commit, same line |
| `walkthrough:cta-event` | `cellarAnalysis/layoutDiffOrchestrator.js:233` | **DELETED** | `a4ec98da` "delete the last orphan dispatch (walkthrough:cta-event) (#99)" |
| `wine-shop:navigate` | `wineShop/currencyHintBanner.js:94` | **FP** — external consumer (legacy DOM fallback) | still dispatch-only in `frontend-inventory.md` as of 2026-08-11 — never fixed because it isn't a bug |
| `wineapp:sources-changed` | `shared/wineSearch.js:59` | **FP** — external consumer (browser-extension content script) | same — still present, unfixed, in the current inventory |

**Actionable** (`disposition ∈ {DELETED, REAL-BUG}`) = 5 of 7 (71%), **confirmed
defect** (`REAL-BUG`) = 2 of 7 — both numbers match the plan's originally-cited
evidence table exactly, now on a verified basis instead of an uncheckable one.

## Fixtures

Minimised, single-purpose `.js` files under this directory — the dispatch site and
its immediate enclosing function only, not the source files wholesale (per §7b's
"reviewable, carries no consumer source" requirement). The two FP fixtures carry a
`// @event-consumer-external: <reason>` pragma matching D5's escape hatch, citing
the real external-consumer reason from the table above.
