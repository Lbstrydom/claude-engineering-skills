/**
 * @fileoverview Cross-skill data-loop domain — plans, regression specs,
 * /ship nudges, persona↔audit correlations, plan verification, ship events.
 *
 * **This file is a re-export barrel** since cross-skill-command-registry
 * Phase 6. It was a 1,572-line module owning six unrelated tables; the code
 * now lives in six siblings and this name stays because it is the import every
 * consumer already uses (`scripts/learning-store.mjs` re-exports it, and a
 * dozen suites import from it by name). Deleting it would be a rename of the
 * public surface, which is not what a mechanical split is for.
 *
 * | module | owns |
 * |---|---|
 * | [`plans.mjs`](./plans.mjs) | `plans` — path validation, upsert, id lookup, status |
 * | [`regression-specs.mjs`](./regression-specs.mjs) | `regression_specs`, `regression_spec_runs` |
 * | [`run-row-fallback.mjs`](./run-row-fallback.mjs) | the optional-column insert retry shared by the two `*_runs` writers — it belongs to neither domain |
 * | [`ship-nudges.mjs`](./ship-nudges.mjs) | the `unlocked_fixes` / `unremediated_acceptances` view families + their shared repo fence |
 * | [`persona-correlations.mjs`](./persona-correlations.mjs) | `persona_audit_correlations` |
 * | [`plan-verification.mjs`](./plan-verification.mjs) | `plan_verification_runs`, `plan_verification_items` |
 * | [`ship-events.mjs`](./ship-events.mjs) | `ship_events` |
 *
 * **A barrel is invisible to a static source scan.** Several suites assert
 * properties of this domain by READING the source — the nudge readers' repo
 * fence and order-before-cap, `upsertPlan`'s discriminated returns, the
 * regression-spec partial-arbiter predicates. Those scans now read the sibling
 * that owns the code, and the nudge scan enumerates the store DIRECTORY rather
 * than any one filename, so the next move cannot blind it. A `export * from`
 * line contains no SQL: adding a re-export here does not extend any of them.
 *
 * @module scripts/lib/store/plans-ship
 */

export * from './plans.mjs';
export * from './regression-specs.mjs';
export * from './run-row-fallback.mjs';
export * from './ship-nudges.mjs';
export * from './persona-correlations.mjs';
export * from './plan-verification.mjs';
export * from './ship-events.mjs';
