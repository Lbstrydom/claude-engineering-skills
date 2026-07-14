# Plan: Domain-Map Reconciliation (architecture-intent backlog)

- **Date**: 2026-07-14
- **Status**: Draft (maintenance backlog — NOT part of the provenance/gate-honesty plan)
- **Author**: Claude + Louis
- **Scope**: backend (pure `.audit-loop/domain-map.json` + intent bookkeeping; no runtime behaviour)

## Origin

The Cluster A code audit of
[provenance-trailers-and-gate-honesty](provenance-trailers-and-gate-honesty.md)
(run `839c7842`, 2026-07-14) surfaced the same ~9 pre-existing
architecture-intent findings in every round. All were adjudicated
out-of-scope for that cluster (deliberation precedent: independent of the
shipped path) — but they re-raised verbatim each round, and they are real
drift between `.audit-loop/domain-map.json` and the observed import graph.
This plan is the durable capture so the backlog stops being re-litigated
per-audit and gets one deliberate reconciliation pass.

## The backlog (deduplicated across rounds R1-R5)

| # | Drift | Audit recommendation (condensed) |
|---|---|---|
| 1 | `learning-store → stores` (12 edges) | Map `scripts/lib/store/**` INTO `learning-store` (or declare `stores` a persistence subdomain with an explicit allow) — no per-module allowlist entries |
| 2 | `dashboard → stores, nav-audit, visual-audit, audit-orchestration` (26 edges) | Declare `dashboard` a read-only aggregation domain with one-way `allowedDeps` on the producers' query/presenter surfaces |
| 3 | `tests → 7 production domains` (129 edges) | Declare `tests` a verification domain allowed one-way into everything; keep the inverse prohibition (prod never imports tests) |
| 4 | `shared-lib → learning-store/stores/brainstorm/audit-orchestration/arch-memory/nav-audit/claude-hooks` (~26 edges) | Reclassify feature-specific coordinators out of `shared-lib` into owning domains; shared-lib keeps only domain-neutral primitives |
| 5 | `cross-skill-bridge → stores/findings/nav-audit` | Keep the bridge a thin façade; either allow the named narrow deps or move feature ops behind owner-domain APIs |
| 6 | `audit-orchestration → stores` (3 edges) | Route through a learning-store API rather than `lib/store/*` imports |
| 7 | `persona-test → shared-lib/learning-store/ux-lock` (8 edges) | Add persona-test to the intent with named one-way deps |
| 8 | `scripts → persona-test/brainstorm/audit-orchestration/ux-lock` (5 edges) | Model top-level CLIs as an entry-point/composition-root domain with one-way deps |
| 9 | **Dead intents**: `ship`, `skills-content` (declared, own no paths) | Map `skills/**` to `skills-content` (with `.claude/skills/**` explicitly generated output) and map or remove `ship`; add a validation that a declared domain cannot silently own zero paths |
| 10 | `supabase/migrations/*.sql → scripts/lib/db/compat-bootstrap.sql` reference | Decide migration-vs-runtime SQL ownership; either colocate or add a byte-identical regeneration check |

## Execution sketch (one sitting, ~2-3 h)

1. Edit [.audit-loop/domain-map.json](../../.audit-loop/domain-map.json):
   path-rule + `allowedDeps` changes per the table (items 1-9; item 10 is a
   file move decision, not a map edit).
2. **Bootstrap order is load-bearing** (AGENTS.md): `npm run dashboard:setup`
   (`arch:refresh` → `arch:render` → `dashboard:build`) — editing
   `domain-map.json` alone does not retag existing DB rows.
3. Verify: the Architecture tab's observed-vs-manual merge shows the edges as
   `both`/`manual`; re-run any audit and confirm the family no longer fires.
4. Add the item-9 guard: a small test asserting every declared domain owns ≥1
   path (dead-intent prevention).

## Non-goals

- No runtime code moves in the first pass (items 4-6 name candidate
  *refactors*; the reconciliation pass only encodes current reality + intent.
  Actual module moves are separate, individually-audited changes).
- Not a blocker for the provenance/gate-honesty plan's Cluster B.
