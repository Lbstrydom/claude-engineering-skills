/**
 * @fileoverview The pure decision behind `--debate`: given the requested voices
 * and round 1's results, does a debate round have a peer pair to work with, and
 * if not, WHY not.
 *
 * **Why this is its own function.** The decision used to be an inline predicate
 * inside `runDebateRound` in `scripts/brainstorm-round.mjs`, which exports
 * nothing — so the classification had no boundary a test could reach, and the
 * bug it carried survived undetected: a skip returned a bare `[]`, the caller
 * emitted `debate: []`, and that is byte-identical to what a run WITHOUT
 * `--debate` emits. A skill-following agent therefore rendered no debate block
 * and no explanation, after the user had already paid for round 1. The
 * one-provider case was worse than silent-in-the-envelope — it produced no
 * stderr warning either, because the old warning was itself nested inside an
 * `if (providers.length === 2)`.
 *
 * Same pure-decide / impure-shell split as `gate-honesty/verb-pattern.mjs` and
 * the db-suite gate: this module decides, `runDebateRound` dispatches.
 *
 * @module scripts/lib/brainstorm/debate-outcome
 */

/**
 * Why a requested debate round could not run. A closed set — the renderer in
 * `skills/brainstorm/SKILL.md` has a row per reason, so adding one here means
 * adding one there.
 */
export const DEBATE_SKIP_REASONS = Object.freeze(['not-a-pair', 'round-1-incomplete']);

/**
 * Decide whether a debate round can run.
 *
 * @param {object} input
 * @param {string[]} input.providers the voices this run requested, in order
 * @param {Array<{provider: string, state: string}>} input.round1 round-1 results
 * @returns {{ok: true, skipped: null} | {ok: false, skipped: {reason: string, detail: string}}}
 *   `ok` means a peer pair exists. `skipped` is null exactly when `ok` is true.
 */
export function classifyDebateOutcome({ providers, round1 }) {
  const list = Array.isArray(providers) ? providers : [];
  const results = Array.isArray(round1) ? round1 : [];

  // A debate is one voice reacting to ONE other. Three voices have no canonical
  // pairing and one has no peer, so the round is defined only for exactly two.
  if (list.length !== 2) {
    return {
      ok: false,
      skipped: {
        reason: 'not-a-pair',
        detail: `a debate round needs exactly 2 voices; this run used ${list.length}`
          + `${list.length ? ` (${list.join(', ')})` : ''}`,
      },
    };
  }

  // `success` is the only state carrying text worth reacting to. `truncated`
  // is deliberately NOT accepted: the peer prompt quotes the response verbatim
  // as the thing to pressure-test, and half an argument invites a rebuttal of a
  // position its author never finished stating.
  const stateOf = (p) => results.find((r) => r?.provider === p)?.state ?? 'absent';
  const succeeded = list.filter((p) => stateOf(p) === 'success');
  if (succeeded.length !== list.length) {
    return {
      ok: false,
      skipped: {
        reason: 'round-1-incomplete',
        detail: `only ${succeeded.length}/2 providers succeeded in round 1 `
          + `(${list.map((p) => `${p}=${stateOf(p)}`).join(', ')}), `
          + 'so there is no peer response to react to',
      },
    };
  }

  return { ok: true, skipped: null };
}
