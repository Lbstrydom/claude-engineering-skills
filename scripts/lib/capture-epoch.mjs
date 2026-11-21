/**
 * @fileoverview The capture epoch the audit-capture writers stamp on a run row, as a LEAF constant.
 *
 * It lives apart from `store/capture-identity.mjs` (which re-exports it, so every existing importer is unchanged) because two
 * layers need the SAME value: the store writer that stamps rows, and `telemetry/capture-queries.mjs`, whose statements select
 * the cohort by it. A shared-lib module may not import the store, so the writer's constant cannot be reached from there;
 * a second spelling of the string would let the two drift apart silently — a query reading a cohort nothing writes.
 *
 * Bumping this changes the eligible cohort of every capture query (they take the epoch set as a parameter).
 *
 * @module scripts/lib/capture-epoch
 */
export const CAPTURE_EPOCH = 'capture-v1';
