/**
 * @fileoverview The closed vocabulary for what became of a tool pre-pass run, and how several states aggregate.
 *
 * Dependency-free and in shared-lib because BOTH the tool runner (`linter.mjs`) and the coverage ledger
 * (`audit/file-coverage.mjs`) speak it, and the runner must not import the audit layer to do so.
 *
 * @module scripts/lib/tool-states
 */

/**
 * Tool states, WORST FIRST. A tool's aggregate status across its projects is the first of these that any project has;
 * `ok` and `not_applicable` come last, so any real problem outranks them.
 */
export const TOOL_STATE_PRECEDENCE = Object.freeze([
  'spawn_error', 'failed', 'timeout', 'deadline_exceeded', 'ambiguous_project',
  'skipped_budget', 'no_project', 'no_tool', 'ok', 'not_applicable',
]);
export const TOOL_STATES = TOOL_STATE_PRECEDENCE;

/**
 * Worst tool state in `states` per TOOL_STATE_PRECEDENCE (empty → `not_applicable`). A state OUTSIDE the vocabulary is a
 * producer bug, not "nothing to report": it counts as `failed`.
 */
export function worstToolState(states) {
  const failedRank = TOOL_STATE_PRECEDENCE.indexOf('failed');
  let best = TOOL_STATE_PRECEDENCE.length - 1;
  for (const s of states || []) {
    const i = TOOL_STATE_PRECEDENCE.indexOf(s);
    const rank = i === -1 ? failedRank : i;
    if (rank < best) best = rank;
  }
  return TOOL_STATE_PRECEDENCE[best];
}
