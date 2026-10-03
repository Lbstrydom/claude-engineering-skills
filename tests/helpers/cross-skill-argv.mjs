/**
 * @fileoverview Shared `cross-skill.mjs` dispatch-test helpers: the
 * `process.argv`-shaped builder, and the stub store-deps object the dispatcher
 * is driven with. Consolidated here (arch:drift duplication cleanup) —
 * `argv`: `cross-skill-payload-parse.test.mjs`, `cross-skill-store-calls.test.mjs`
 * and `cross-skill-write-outcome-contract.test.mjs` each had their own
 * identical copy; `stubDeps`: `cross-skill-write-outcome-contract.test.mjs` and
 * `persona-session-lifecycle-contract.test.mjs` each had their own identical
 * copy.
 *
 * @module tests/helpers/cross-skill-argv
 */

export const argv = (...a) => ['node', 'cross-skill.mjs', ...a];

/**
 * The minimum store surface the write-outcome / persona-session commands
 * touch, with `overrides` spread last so a case can replace any one writer.
 */
export function stubDeps(overrides = {}) {
  return {
    initLearningStore: async () => true,
    isCloudEnabled: async () => true,
    // record-persona-session gates on its OWN cloud check, not the shared one.
    // Omitting it silently routed every persona case to the degrade envelope,
    // where `reason` is absent — a stub gap that reads exactly like a handler
    // that stopped reporting.
    isPersonaCloudEnabled: async () => true,
    resolveRepoForStoreResult: async () => ({ kind: 'resolved', repoRowId: 'repo-1', repoUuid: 'uuid-1', name: 'o/r' }),
    getRepoIdByName: async () => 'repo-1',
    getRepoIdByUuid: async () => ({ id: 'repo-1', name: 'o/r' }),
    listRepoIds: async () => ['repo-1'],
    ...overrides,
  };
}
