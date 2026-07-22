/**
 * @fileoverview The containment-adjacency wave's state factory — the single
 * owner of every status rule, and the module that makes a vacuous green
 * structurally impossible.
 *
 * Plan: docs/plans/adjacency-check-containment.md §D9 / §D9a.
 *
 * **Why a pure factory and not inline `if/else` at the call site**: the
 * duplication wave puts its 4-state dispatch inline in the orchestrator
 * (`legacy-production-audit.mjs` Wave 5), which makes its state rules
 * untestable except by driving a whole audit through a test-injection seam.
 * `buildCloudFpPolicy` (`suppression-policy.mjs`) proved the better shape:
 * a pure function over facts, unit-testable in isolation. This mirrors it.
 *
 * **The load-bearing invariant (D9a): the label NEVER suppresses a fact.**
 * `candidates` and `incompleteness` pass through untouched; `state` is a
 * summary for logs and tests. An earlier design had the detector compute the
 * state and let it gate emission — under which a `capped` return would have
 * *discarded real findings* and a `findings` return would have *hidden
 * incomplete coverage*. Emission reads the arrays, never the label.
 *
 * @module scripts/lib/audit/adjacency-state
 */

/**
 * Every state this wave can report. Frozen, in-module, and exhaustively
 * reachable — deliberately unlike the two sibling waves, whose states are
 * bare string literals with no enum at all (the cloud-FP guard test is even
 * titled "the five documented values" while containing four).
 *
 * The four "nothing to report" states are kept SEPARATE on purpose — conflating
 * them is how a control that never ran reads as a control that found nothing:
 *   - `NOT_APPLICABLE`      — the audit has no diff contract by design. Never askable.
 *   - `NOT_TRIGGERED`       — we looked; no change landed inside a conditional.
 *   - `CLEAN`               — we enumerated real containers and judged real statements; none trapped.
 *   - `CONTROL_UNAVAILABLE` — we WERE asked and could not look. As loud as a failure.
 */
export const ADJACENCY_STATES = Object.freeze({
  NOT_APPLICABLE: 'not-applicable',
  NOT_TRIGGERED: 'not-triggered',
  CLEAN: 'clean',
  FINDINGS: 'findings',
  CAPPED: 'capped',
  CONTROL_UNAVAILABLE: 'control-unavailable',
  FAILED: 'failed',
});

/**
 * Build one incompleteness record — `{kind, scope, detail}`. A tiny factory,
 * but it was independently defined byte-identically in both
 * adjacency-detector.mjs and adjacency-report.mjs (flagged by
 * `arch:duplicates`); consolidated here since both already import
 * `INCOMPLETENESS_KINDS` from this module.
 * @param {string} kind - one of INCOMPLETENESS_KINDS
 * @param {string} scope
 * @param {string} detail
 * @returns {{kind: string, scope: string, detail: string}}
 */
export const incompleteness = (kind, scope, detail) => ({ kind, scope, detail });

/** Every incompleteness kind. Each one emits its own convergence-blocking
 *  control finding — adding a kind without a finding to carry it is not
 *  possible, because `adjacency-report.mjs` maps this set exhaustively. */
export const INCOMPLETENESS_KINDS = Object.freeze({
  INPUT_BOUND: 'input-bound',           // preflight: too many files / lines / bytes
  ENUMERATION_BOUND: 'enumeration-bound', // containers / statements / candidates cap
  PARSE_FAILURE: 'parse-failure',         // unparseable OR recovered-partial source
  EXCERPT_UNRESOLVABLE: 'excerpt-unresolvable', // payload unsafe, or minimum context will not fit
  BOUNCER_DEGRADED: 'bouncer-degraded',   // model call failed → deterministic fallback used
});

/** Summary-label precedence, most severe first. Used ONLY to pick the string;
 *  never to decide what is emitted (D9a). */
const PRECEDENCE = [
  ADJACENCY_STATES.FAILED,
  ADJACENCY_STATES.CONTROL_UNAVAILABLE,
  ADJACENCY_STATES.FINDINGS,
  ADJACENCY_STATES.CAPPED,
  ADJACENCY_STATES.CLEAN,
  ADJACENCY_STATES.NOT_TRIGGERED,
  ADJACENCY_STATES.NOT_APPLICABLE,
];

/**
 * Compose the final adjacency result from the facts gathered across ALL stages
 * (mechanical analysis, prompt formatting/egress, bouncer). Call this exactly
 * once, at the end — see `adjacency-compose.mjs`, which is its only caller.
 *
 * **Coverage is passed as the nested `coverage` object the detector actually
 * returns — deliberately NOT as flat counters.** An earlier signature took
 * `containersEnumerated`/`statementsJudged` at the top level while
 * `runAdjacencyAnalysis` returned them inside `coverage`, so
 * `buildAdjacencyState(facts)` silently defaulted both to 0 and reported
 * "0 containers, 0 statements" alongside real candidates — a self-contradicting
 * result. Every unit test passed, because each side was tested in isolation
 * against its own assumption; only a live end-to-end run exposed it. One shape,
 * used by producer and consumer, is what makes that class unrepresentable.
 *
 * @param {object} facts
 * @param {boolean} [facts.selected=true] - was the adjacency wave selected for this run?
 * @param {boolean} [facts.diffContractAvailable=true] - does this audit have a diff contract at all?
 * @param {{containersEnumerated?:number, statementsJudged?:number}} [facts.coverage={}]
 * @param {object[]} [facts.candidates=[]] - trapped-statement candidates that survived judgement
 * @param {{kind:string, scope:string, detail:string}[]} [facts.incompleteness=[]]
 * @param {string|null} [facts.threw=null] - a stable reason code if an internal step threw
 * @returns {{state:string, coverage:{containersEnumerated:number,statementsJudged:number},
 *            candidates:object[], incompleteness:object[], reason:string|null}}
 */
export function buildAdjacencyState({
  selected = true,
  diffContractAvailable = true,
  coverage: rawCoverage = {},
  candidates = [],
  incompleteness = [],
  threw = null,
} = {}) {
  const containersEnumerated = rawCoverage.containersEnumerated ?? 0;
  const statementsJudged = rawCoverage.statementsJudged ?? 0;
  const coverage = { containersEnumerated, statementsJudged };
  const result = (state, reason = null) => ({
    state,
    coverage,
    // Pass through UNTOUCHED — the label must never be able to drop a fact.
    candidates,
    incompleteness,
    reason,
  });

  if (threw) return result(ADJACENCY_STATES.FAILED, threw);

  // "Never askable" — no diff contract by design, or the wave wasn't selected.
  // This is the ONLY silent non-finding path, and it is honest: nothing was
  // ever expected of the control here.
  if (!selected || !diffContractAvailable) {
    return result(ADJACENCY_STATES.NOT_APPLICABLE, !selected ? 'wave not selected' : 'no diff contract for this audit');
  }

  // We were asked and could not look. Distinguished from NOT_APPLICABLE because
  // this one is a failure of a required control, and must be as loud as FAILED.
  const couldNotLook = containersEnumerated === 0
    && statementsJudged === 0
    && incompleteness.some((i) => i.kind === INCOMPLETENESS_KINDS.INPUT_BOUND || i.kind === INCOMPLETENESS_KINDS.PARSE_FAILURE);
  if (couldNotLook) {
    return result(ADJACENCY_STATES.CONTROL_UNAVAILABLE, 'required control could not obtain or parse its input');
  }

  if (candidates.length > 0) return result(ADJACENCY_STATES.FINDINGS);
  if (incompleteness.length > 0) return result(ADJACENCY_STATES.CAPPED, incompleteness[0].detail ?? null);

  // CLEAN is the assertion, not the default. It means: we enumerated real
  // containers, judged real statements, nothing was trapped, and nothing was
  // skipped. Anything less must not be able to wear this label.
  if (containersEnumerated > 0 && statementsJudged > 0) {
    return result(ADJACENCY_STATES.CLEAN);
  }

  // Looked, but no change landed inside a conditional. Distinct from CLEAN
  // because no container was ever enumerated — there was nothing to judge.
  return result(ADJACENCY_STATES.NOT_TRIGGERED);
}

/**
 * The vacuous-green guard, as an assertion a caller (or a test) can run against
 * any result. `buildAdjacencyState` cannot itself produce a violating result —
 * this exists so a future refactor that hand-builds a result object still gets
 * caught, and so the invariant is stated once, executably.
 *
 * @param {object} result
 * @throws {Error} if `clean` is claimed without the coverage that earns it
 */
export function assertCleanIsEarned(result) {
  if (result?.state !== ADJACENCY_STATES.CLEAN) return;
  const { containersEnumerated = 0, statementsJudged = 0 } = result.coverage ?? {};
  if (containersEnumerated === 0 || statementsJudged === 0) {
    throw new Error(
      `adjacency: 'clean' claimed with zero coverage (containers=${containersEnumerated}, statements=${statementsJudged}) — ` +
      'a control that enumerated nothing has not found nothing; it did not run.',
    );
  }
  if ((result.incompleteness ?? []).length > 0) {
    throw new Error(
      `adjacency: 'clean' claimed alongside ${result.incompleteness.length} incompleteness record(s) — ` +
      'partial coverage is not a clean result.',
    );
  }
}

/** True if this result must block convergence: real candidates, or any
 *  incompleteness, or an outright failure. Used by the report layer to decide
 *  which control findings to emit — reading the ARRAYS, never the label. */
export function blocksConvergence(result) {
  if (!result) return false;
  if (result.state === ADJACENCY_STATES.FAILED || result.state === ADJACENCY_STATES.CONTROL_UNAVAILABLE) return true;
  return (result.candidates?.length ?? 0) > 0 || (result.incompleteness?.length ?? 0) > 0;
}
