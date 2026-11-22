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
 * @param {(commit:string, arm:string) => number|null} expectedCellCountFor the
 *   expected cell count for (commit, arm) — it differs per ARM (a ×3 arm has
 *   three times the cells of a ×1 arm on the same commit; the apparatus adds
 *   a gate cell). `null` means the runner never recorded a denominator for
 *   that pair, which is treated as partial: completeness cannot be derived
 *   against an unknown total, and guessing one would be asserting it.
 */
export function commitsCompleteForAllArms(rows, arms, commits, expectedCellCountFor) {
  const kept = [];
  const dropped = [];
  for (const commit of commits) {
    const states = arms.map((arm) => {
      const expected = expectedCellCountFor(commit, arm);
      if (expected == null) return { arm, state: 'partial', reason: 'no-expected-cell-count' };
      return { arm, state: commitArmCompletion(rows, { arm, commit, expectedCellCount: expected }) };
    });
    const bad = states.filter((s) => s.state === 'partial');
    if (bad.length > 0) dropped.push({ commit, causes: bad });
    else kept.push(commit);
  }
  return { kept, dropped };
}

/** A gate or review result's cell state: any runner's `skipped` (e.g. Gemini
 * no-key, a caught provider error) measured nothing, so it is never `ok`. */
export const gateCellState = (r) => r.state ?? (r.skipped ? 'provider-error' : 'ok');

/**
 * Per-commit state of a run whose review stage (the Gemini net-new review in
 * `apparatus-bc` / `sonnet-gemini-retro`) did not produce a measurement. Not
 * `ran`: resume re-runs it, and `merge` refuses it (see unmeasuredCommits).
 */
export const UNMEASURED_REVIEW_STATE = 'review-unmeasured';

/**
 * Run one review call and say whether it MEASURED anything. A throw, a skip,
 * or an unparseable reply (`conformance-miss`) is unmeasured — its empty list
 * is an absence of evidence, and treating it as "found nothing" is exactly the
 * clean-round-clothes defect. Only a returned `ok` review keeps its findings.
 * @param {() => Promise<{findings?: object[], state?: string, skipped?: string, error?: string}>} run
 * @returns {Promise<{findings: object[], measured: boolean, error: string|null}>}
 */
export async function runMeasuredReview(run) {
  let r;
  try { r = await run(); } catch (err) { return { findings: [], measured: false, error: String(err?.message || err).slice(0, 160) }; }
  const state = gateCellState(r);
  if (state === 'ok') return { findings: r.findings || [], measured: true, error: null };
  return { findings: [], measured: false, error: r.error || r.skipped || state };
}

/** The perCommit state fields for a run whose review stage returned `rev`. */
export function reviewCommitState(rev) {
  return rev.measured ? { state: 'ran' } : { state: UNMEASURED_REVIEW_STATE, error: rev.error };
}

/**
 * Commits among `commits` whose LATEST perCommit entry in some run is an
 * unmeasured review. Latest wins because resume appends: a successful re-run
 * of the same commit supersedes the failure. Legitimate exclusions
 * (no-clean-files, diff-too-large, …) are not reviews and are not returned.
 * @param {Array<{armLabel?: string, perCommit?: Array<{sha: string, state: string, error?: string}>}>} runs
 * @param {string[]} commits
 * @returns {Array<{arm: string, commit: string, error: string|null}>}
 */
export function unmeasuredCommits(runs, commits) {
  const want = new Set(commits);
  const out = [];
  for (const run of runs) {
    const latest = new Map();
    for (const c of run.perCommit || []) if (want.has(c.sha)) latest.set(c.sha, c);
    for (const [sha, c] of latest) {
      if (c.state === UNMEASURED_REVIEW_STATE) out.push({ arm: run.armLabel || 'S', commit: sha, error: c.error ?? null });
    }
  }
  return out;
}

/**
 * Commits a resumed run may skip: those whose LATEST perCommit entry is `ran`
 * in EVERY given run file (null = no prior file, constrains nothing). One
 * subcommand writes several arm files (apparatus-bc: B and C); reading only
 * the first let a commit whose C review never ran count as covered for both.
 * @param {Array<{perCommit?: Array<{sha: string, state: string}>}|null>} runs
 * @returns {Set<string>}
 */
export function coveredCommits(runs) {
  const latestByRun = runs.filter(Boolean).map((run) => {
    const latest = new Map();
    for (const c of run.perCommit || []) latest.set(c.sha, c.state);
    return latest;
  });
  const shas = new Set(latestByRun.flatMap((m) => [...m.keys()]));
  return new Set([...shas].filter((sha) => latestByRun.every((m) => m.get(sha) === 'ran')));
}

/**
 * A RESUME INHERITS THE EARLIER RUN'S TRANSPORT, AND THE TRANSPORT IS PART OF
 * THE MEASUREMENT.
 *
 * Rows produced through `claude -p` and rows produced through the API differ in
 * prompt prefix, in whether `max_tokens` bound (accepted-and-ignored vs
 * enforced) and in which meter paid. `solo-control-audit`'s client construction
 * is now unconditionally pinned to sdk, so resuming an arm whose
 * `provenance.backend` says `cli` appends sdk rows to cli rows in one file —
 * and the arm file is the thing compared ACROSS arms, where nothing downstream
 * can separate them again.
 *
 * Refused, not warned: a warning on a long run is read after the spend. An arm
 * with NO recorded provenance still resumes — an unknown transport is not a
 * known-different one, and refusing on absence would strand every arm written
 * before `provenance` existed.
 *
 * @param {object|null} prior - the parsed arm file, or null
 * @param {string|null} backend - the transport this run will use, in the same
 *   spelling `provenance.backend` records
 * @param {boolean} force - --force starts the arm over, so no mixing occurs
 * @throws {Error} naming both transports and the two ways forward
 */
export function assertResumableBackend(prior, backend, force) {
  const was = prior?.provenance?.backend;
  if (force || !backend || !was || was === backend) return;
  throw new Error(`this arm file was produced with backend "${was}" and this run uses "${backend}" — `
    + 'resuming would mix two transports into one arm, and the rows are compared across arms. '
    + 'Re-run with --force to start the arm over, or keep the old file and run the new transport under its own --label.');
}

/**
 * The output object a resumed run appends to. `fresh` under --force or with no
 * prior file; otherwise a copy of the prior file minus the findings of the
 * commits about to be re-run (an unmeasured commit kept its upstream findings,
 * and re-running it would otherwise append them a second time). perCommit
 * history is kept: the re-run's entry is appended and wins as the latest.
 */
export function resumeArmFile(prior, { force, rerun, fresh }) {
  if (!prior || force) return fresh;
  const again = new Set(rerun);
  return { ...prior, findings: prior.findings.filter((f) => !again.has(f.commit)), perCommit: [...prior.perCommit] };
}

/**
 * Did the review that produced `sha`'s findings in this run COMPLETE? The LATEST perCommit entry for the sha must be `ran`
 * (resume appends, so a later success supersedes an earlier failure). Having findings is not completion: a run that billed
 * three of five passes and then hit a provider error holds findings AND a non-`ran` state, and a baseline built on it is a
 * partial one. No entry at all reads as not-completed — absence of a record is not a completed review.
 * @param {{perCommit?: Array<{sha: string, state: string}>}|null} run
 * @param {string} sha
 * @returns {{completed: boolean, state: string|null}}
 */
export function baselineReviewCompleted(run, sha) {
  let latest = null;
  for (const c of run?.perCommit || []) if (c.sha === sha) latest = c;
  return { completed: latest?.state === 'ran', state: latest?.state ?? null };
}
