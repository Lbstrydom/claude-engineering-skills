/**
 * @fileoverview D2a's dependency contract as DATA, not prose (plan:
 * comparison-tooling-consolidation.md D2b, post-gate fix M2).
 *
 * `arm-vocabulary-layering` enforces DOMAIN-level edges; D2a is a MODULE-level
 * contract inside the single `shared-lib` domain both `bakeoff/**` and
 * `campaign/**` resolve to, so the domain-level checker cannot substitute for
 * it. `tests/bakeoff-module-contract.test.mjs` is the graph checker that
 * reads this module directly — it never parses this file's own Markdown
 * table (§D2a in the plan), and the Markdown table is asserted equal to
 * this module's own data (never re-typed, never the other way around).
 *
 * One entry per D2a row. Module paths are repo-relative, matching how the
 * graph checker resolves import specifiers.
 *
 * @module scripts/lib/bakeoff/module-contract
 */

/**
 * @typedef {'pure'|'reads-log'|'writes-store'|'spawns'|'writes-stdout'} SideEffect
 * @typedef {{mayImport: string[], mustNotImport: string[], sideEffects: SideEffect}} ModuleContract
 */

/** @type {Record<string, ModuleContract>} */
export const MODULE_CONTRACT = Object.freeze({
  'scripts/lib/bakeoff/scope.mjs': Object.freeze({
    mayImport: [],
    mustNotImport: ['*'], // pure — imports nothing in this repo, full stop
    sideEffects: 'pure',
  }),
  'scripts/lib/bakeoff/arms.mjs': Object.freeze({
    // `campaign/lock.mjs` added — round-4 finding M1: `computeCollectLock`
    // (moved here from bakeoff-collect.mjs verbatim in Phase 2) genuinely
    // needs `computeLockDigest`, and the original D2a table under-specified
    // this module's own real dependency. The code was already correct; the
    // table (and this data module, its machine-readable form) were not.
    mayImport: ['scripts/lib/bakeoff/scope.mjs', 'scripts/lib/campaign/config.mjs', 'scripts/lib/campaign/lock.mjs', 'scripts/lib/comparison/'],
    mustNotImport: ['scripts/*.mjs', 'scripts/lib/bakeoff/spawn.mjs', 'scripts/lib/bakeoff/log.mjs'],
    sideEffects: 'reads-log', // reads .campaigns/ — filesystem read, not the bake-off log itself
  }),
  'scripts/lib/bakeoff/log.mjs': Object.freeze({
    mayImport: ['scripts/lib/file-io.mjs'],
    mustNotImport: ['scripts/*.mjs', 'scripts/lib/bakeoff/spawn.mjs', 'scripts/lib/bakeoff/summary.mjs'],
    sideEffects: 'reads-log',
  }),
  'scripts/lib/bakeoff/spawn.mjs': Object.freeze({
    mayImport: ['scripts/lib/bakeoff/scope.mjs'],
    mustNotImport: ['scripts/*.mjs', 'scripts/lib/bakeoff/arms.mjs', 'scripts/lib/bakeoff/summary.mjs', 'scripts/lib/bakeoff/progress.mjs'],
    sideEffects: 'spawns',
  }),
  'scripts/lib/bakeoff/summary.mjs': Object.freeze({
    mayImport: ['scripts/lib/bakeoff/scope.mjs', 'scripts/lib/comparison/spend.mjs'],
    mustNotImport: ['scripts/*.mjs', 'scripts/lib/bakeoff/arms.mjs', 'scripts/lib/bakeoff/spawn.mjs', 'scripts/lib/bakeoff/log.mjs'],
    sideEffects: 'pure',
  }),
  'scripts/lib/bakeoff/progress.mjs': Object.freeze({
    mayImport: ['scripts/lib/bakeoff/summary.mjs', 'scripts/lib/bakeoff/log.mjs'],
    mustNotImport: ['scripts/*.mjs', 'scripts/lib/bakeoff/spawn.mjs'],
    sideEffects: 'writes-stdout',
  }),
  'scripts/lib/campaign/cited-source.mjs': Object.freeze({
    mayImport: ['scripts/lib/comparison/paths.mjs'],
    mustNotImport: ['scripts/*.mjs'],
    sideEffects: 'reads-log', // reads repo files at a revision
  }),
  'scripts/lib/campaign/adjudicate.mjs': Object.freeze({
    mayImport: ['scripts/lib/campaign/cited-source.mjs', 'scripts/lib/campaign/config.mjs'],
    mustNotImport: ['scripts/*.mjs', 'scripts/lib/campaign/promote.mjs'],
    sideEffects: 'pure', // the provider call itself stays in the CLI
  }),
  'scripts/lib/campaign/promote.mjs': Object.freeze({
    mayImport: ['scripts/lib/store/campaign.mjs'],
    mustNotImport: ['scripts/*.mjs', 'scripts/lib/bakeoff/', 'scripts/lib/campaign/adjudicate.mjs'],
    sideEffects: 'writes-store', // takes log entries as a PARAMETER — does not read the log itself
  }),
});
