/**
 * @fileoverview The `upstream_issue_events` vocabulary — the ONE oracle for
 * which event values exist and which of them advance an issue's state.
 *
 * **Why a module of its own, and why it is pure.** The event set is declared in
 * three places that cannot see each other: the SQL CHECK, the write path
 * (`store/upstream-issues.mjs`), and every reader that folds the log back into
 * a state. A second spelling of "which events are lifecycle events" is exactly
 * the prose↔code drift AGENTS.md keeps closing, so both the store and the
 * renderer import THIS, and `tests/upstream-issue-triage.test.mjs` pins it
 * against the live SQL CHECK. It does no I/O so the store (which does) can
 * depend on it without a layering inversion — `upstream/commands.mjs` is the
 * wrong home for the same reason: it reads the filesystem and shells out to git.
 *
 * @module scripts/lib/upstream/events
 */

/**
 * Events that MOVE the issue through `LEGAL_TRANSITIONS`. Each one is written
 * in the same transaction as the row UPDATE it records, so the value is
 * always identical to the `upstream_issues.state` that write produced —
 * except `reported`, which records the row's creation at the `open` default.
 */
export const LIFECYCLE_EVENTS = Object.freeze(['reported', 'acknowledged', 'fixed', 'wont_fix']);

/**
 * Events that carry information ABOUT the log without changing where the issue
 * is in its lifecycle.
 *
 * `annotation` exists because the log is append-only by trigger and the state
 * column is CHECK'd to four values, so a note written with a mistake in it had
 * exactly two repairs available and both were wrong: mutate an append-only row
 * (refused, correctly), or emit a SECOND terminal event, which corrupts the
 * lifecycle record in order to fix a typo. The concrete case (2026-08-30):
 * closing report `0f5d87a2`, an unescaped backtick in `--note` ran as shell
 * command substitution and silently elided a sentence from the stored text.
 * A correction is a new fact about an old note — appending is the honest
 * shape; it just must not pretend to be a transition.
 */
export const NON_LIFECYCLE_EVENTS = Object.freeze(['annotation']);

/** Every legal `upstream_issue_events.event` value. Mirrors the SQL CHECK. */
export const EVENT_KINDS = Object.freeze([...LIFECYCLE_EVENTS, ...NON_LIFECYCLE_EVENTS]);

/** The one non-lifecycle event, named rather than spelled at each call site. */
export const ANNOTATION_EVENT = 'annotation';

/** @param {string} event @returns {boolean} */
export function isLifecycleEvent(event) {
  return LIFECYCLE_EVENTS.includes(event);
}

/**
 * Fold an issue's event stream back into the state it implies.
 *
 * **A non-lifecycle event is skipped, never treated as unknown.** The
 * distinction matters: an unrecognised event value returns `null` for the
 * whole fold (the log says something this code does not understand, and
 * guessing would be worse), whereas an `annotation` is understood *and*
 * deliberately state-neutral. Collapsing the two would make every annotated
 * issue read as unfoldable.
 *
 * `reported` folds to `open` — it records the row's creation at the column
 * default, and there is no `reported` state.
 *
 * Used by the history renderer to cross-check the stored `upstream_issues.state`
 * against what the log actually says. A disagreement is evidence of an
 * out-of-band write, which is the one thing the append-only log exists to make
 * visible, so it is REPORTED rather than reconciled.
 *
 * @param {Array<{event: string}>} events in chronological order
 * @returns {{state: string|null, unknown: string[]}} `state` is null when the
 *   stream carries no lifecycle event at all (or only unrecognised ones);
 *   `unknown` lists every event value this vocabulary does not declare.
 */
export function foldEventsToState(events) {
  let state = null;
  const unknown = [];
  for (const e of events ?? []) {
    const value = e?.event;
    if (NON_LIFECYCLE_EVENTS.includes(value)) continue;
    if (!LIFECYCLE_EVENTS.includes(value)) {
      unknown.push(String(value));
      continue;
    }
    state = value === 'reported' ? 'open' : value;
  }
  return { state, unknown };
}
