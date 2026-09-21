/**
 * @fileoverview Execution-completion contract for experiment 5
 * (docs/plans/reviewer-cost-value-experiment.md §3, Gemini R1-H4). Every
 * (arm, commit) cell the runner attempts lands in exactly one terminal
 * state; completion is DERIVED from the ledger, never asserted by the
 * runner finishing without an exception — a crashed run that silently wrote
 * fewer rows than expected must read as `partial`, not `complete`.
 *
 * @module scripts/lib/solo-control/completion
 */

/** A cell's terminal state, one of the four the ledger records. */
export const CELL_STATES = Object.freeze(['ok', 'conformance-miss', 'provider-error', 'excluded']);

/**
 * Derive one (arm, commit)'s completion from its ledger rows. A `retry`
 * purpose row does not add a cell — it supersedes an earlier attempt at the
 * SAME `callId`, so cells are deduplicated by `callId` before judging.
 *
 * @param {Array<{callId:string, arm:string, sharedBy?:string[]|null, commit:string, state:string}>} rows
 *   every ledger row (any arm/commit — this function filters).
 * @param {{arm:string, commit:string, expectedCellCount:number}} target
 *   `expectedCellCount` = passes × chunks × repeats for THIS commit — the
 *   runner knows it (diff-size-dependent); this function cannot compute it.
 * @returns {'complete'|'partial'|'excluded'}
 */
export function commitArmCompletion(rows, { arm, commit, expectedCellCount }) {
  if (!Number.isInteger(expectedCellCount) || expectedCellCount < 1) {
    throw new Error(`commitArmCompletion: expectedCellCount must be a positive integer, got ${JSON.stringify(expectedCellCount)}`);
  }
  const mine = rows.filter((r) => r.commit === commit && (r.arm === arm || (r.sharedBy || []).includes(arm)));
  // Last row wins per callId — a retry's outcome supersedes its own earlier
  // attempt at the identical cell, but two DIFFERENT cells never collapse
  // (their callIds differ by chunk/repeat/pass).
  const byCallId = new Map();
  for (const r of mine) byCallId.set(r.callId, r);
  const cells = [...byCallId.values()];

  if (cells.length === 0) return 'partial'; // nothing attempted yet — not complete by vacuous absence
  if (cells.some((c) => c.state === 'excluded')) return 'excluded'; // transport not allowed for this repo — never attempted, distinct from a failure
  if (cells.length < expectedCellCount) return 'partial'; // fewer cells recorded than the run should have attempted
  if (cells.some((c) => c.state === 'provider-error')) return 'partial'; // a real failure occurred on at least one cell
  return 'complete'; // every expected cell landed on ok or conformance-miss (a real, countable outcome of the model, not a gap)
}

/**
 * A comparison across arms is only honest on commits where EVERY arm being
 * compared is `complete` for that commit (§3: "score refuses to compute a
 * comparison that includes a partial (arm, commit); it drops that commit
 * from EVERY arm in the cohort"). Returns the commits to keep and, for
 * transparency, which commit/arm pairs caused a drop.
 *
 * @param {Array<{callId:string, arm:string, sharedBy?:string[]|null, commit:string, state:string}>} rows
 * @param {string[]} arms the configurations being compared this decision
 * @param {string[]} commits the full commit set under consideration
 * @param {(commit:string) => number} expectedCellCountFor per-commit expected cell count
 */
export function commitsCompleteForAllArms(rows, arms, commits, expectedCellCountFor) {
  const kept = [];
  const dropped = [];
  for (const commit of commits) {
    const expected = expectedCellCountFor(commit);
    const states = arms.map((arm) => ({ arm, state: commitArmCompletion(rows, { arm, commit, expectedCellCount: expected }) }));
    const bad = states.filter((s) => s.state === 'partial');
    if (bad.length > 0) dropped.push({ commit, causes: bad });
    else kept.push(commit);
  }
  return { kept, dropped };
}
