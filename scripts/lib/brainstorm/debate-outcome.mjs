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
 * Is this round-1 result something a peer can actually react to?
 *
 * **`state === 'success'` is not sufficient, and assuming it was is what
 * round-3 caught.** `ProviderResultSchema` declares `text: z.string().nullable()`
 * for EVERY state, success included — so `{provider:'gemini', state:'success',
 * text:null}` is schema-valid. The old check filtered on the state label alone,
 * authorised the debate, and `buildDebatePrompt` then threw
 * `otherResponse required and non-empty` inside `Promise.all`, crashing the run.
 * The label was a proxy for the thing actually needed — quotable text — and the
 * two came apart.
 *
 * This is the SINGLE eligibility oracle: `runDebateRound` builds its peer map
 * from it too, rather than carrying a second copy of the state test. Two
 * spellings of "did this provider give us something to argue with" is how the
 * classifier and the dispatcher would drift back apart.
 *
 * @param {{state?: string, text?: string|null}|undefined} result
 * @returns {boolean}
 */
export function isDebateEligible(result) {
  return result?.state === 'success' && typeof result.text === 'string' && result.text.trim() !== '';
}

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
  //
  // DISTINCT is part of that, and counting positions was not enough (round-2
  // audit M2/M5). `['openai','openai']` has length 2 and, given one successful
  // openai result, satisfied every check below — so this returned `{ok:true}`
  // and `runDebateRound` went on to evaluate `providers.find(p => p !== speaker)`,
  // which is `undefined` for BOTH speakers. The peer lookup then yielded
  // `undefined` and `peerResp.text` threw a TypeError, crashing the run. The
  // contract was always "two distinct voices"; only the arithmetic half was
  // being checked.
  const distinct = new Set(list);
  if (list.length !== 2 || distinct.size !== 2) {
    const shape = list.length === 2
      ? `the same voice twice (${list.join(', ')})`
      : `${list.length}${list.length ? ` (${list.join(', ')})` : ''}`;
    return {
      ok: false,
      skipped: {
        reason: 'not-a-pair',
        detail: `a debate round needs exactly 2 distinct voices; this run used ${shape}`,
      },
    };
  }

  // `truncated` is deliberately not eligible: the peer prompt quotes the
  // response verbatim as the thing to pressure-test, and half an argument
  // invites a rebuttal of a position its author never finished stating.
  // Eligibility itself is `isDebateEligible` — see why the state label alone
  // was not enough.
  const resultOf = (p) => results.find((r) => r?.provider === p);
  const stateOf = (p) => {
    const r = resultOf(p);
    if (!r) return 'absent';
    // Distinguish "said success but sent nothing" from a plain failure — the
    // operator needs to know which, and they read very differently.
    return isDebateEligible(r) ? r.state : (r.state === 'success' ? 'success-but-empty' : r.state);
  };
  const succeeded = list.filter((p) => isDebateEligible(resultOf(p)));
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
