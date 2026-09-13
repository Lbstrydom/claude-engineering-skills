/**
 * @fileoverview Shared `process.argv`-shaped builder for `cross-skill.mjs`
 * dispatch tests. Consolidated here (arch:drift duplication cleanup) —
 * `cross-skill-payload-parse.test.mjs`, `cross-skill-store-calls.test.mjs`
 * and `cross-skill-write-outcome-contract.test.mjs` each had their own
 * identical copy.
 *
 * @module tests/helpers/cross-skill-argv
 */

export const argv = (...a) => ['node', 'cross-skill.mjs', ...a];
