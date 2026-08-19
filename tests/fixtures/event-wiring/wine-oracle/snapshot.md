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

## Independent verification (audit-code R2/M7, escalated R3/H1 — RESOLVED)

`raw-scan-274ad342.json` is the captured output of the reconstruction scan —
durable evidence that each of the 7 events had **zero** listeners anywhere in
the 356-file `public/js/` tree at this commit, and that no other kebab/colon-
named dispatch-only event existed there beyond these 7. The minimised
fixtures below prove the EXTRACTOR reproduces these 7 records; this file is
the independent confirmation that the 7 records themselves are real, not
merely internally consistent with each other.

**R3/H1 escalation, resolved**: a static JSON alone still left "was this
re-derivable" unanswered — so `historical-scan-274ad342.mjs` (the ACTUAL
script, not a description of one) is committed alongside it, and was
re-run for real during this fix (fresh `git worktree add --detach` at
274ad342, script execution, `git worktree remove`) — reproducing the
identical 356-file / 7-event output byte-for-byte. Re-verify it yourself:

```bash
cd <a local clone of wine-cellar-app>
git worktree add --detach /tmp/wine-oracle-274ad342 274ad342
node <this repo>/tests/fixtures/event-wiring/wine-oracle/historical-scan-274ad342.mjs /tmp/wine-oracle-274ad342
git worktree remove --force /tmp/wine-oracle-274ad342
```

## Fixtures

Minimised, single-purpose `.js` files under this directory — the dispatch site and
its immediate enclosing function only, not the source files wholesale (per §7b's
"reviewable, carries no consumer source" requirement). The two FP fixtures carry a
`// @event-consumer-external: <reason>` pragma matching D5's escape hatch, citing
the real external-consumer reason from the table above.
