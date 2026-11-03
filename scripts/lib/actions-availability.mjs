/**
 * @fileoverview Is GitHub Actions enabled for a repository at all — and what to
 * say when it is not.
 *
 * Absence of a run has two causes that read identically: a run not yet
 * scheduled, and a repository where none ever will be. Reported 2026-11-02 by an
 * enterprise mirror whose hosted runners are disabled by policy: `ci-verdict`
 * read "no run exists", which is the shape of a pending PR, forever. The
 * permissions endpoint names the second cause. Asked only where it can change a
 * verdict's REASON — never its colour: a repository without Actions is still
 * unverified, and the remedy is to measure locally.
 *
 * Three answers, never two: `true`, `false`, or `null` when the question could
 * not be asked (no admin read on the token, network, a malformed body). `null`
 * keeps every caller's existing generic reason — it is not evidence of anything.
 *
 * @module scripts/lib/actions-availability
 */

/** The REST path that answers the question, for `gh api` or `fetch`. */
export const actionsPermissionsPath = (nwo) => `repos/${nwo}/actions/permissions`;

/** Machine-readable reason code shared by every surface that reports it. */
export const ACTIONS_DISABLED = 'actions-disabled';

/**
 * `{enabled: boolean, ...}` from the permissions endpoint → true | false | null.
 * @param {unknown} body
 * @returns {boolean|null}
 */
export function actionsEnabledFrom(body) {
  return body && typeof body === 'object' && typeof body.enabled === 'boolean' ? body.enabled : null;
}

/** The local remedy for the merge verdict: the full suite runs at push instead. */
export const ACTIONS_DISABLED_SUITE_REMEDY = 'GitHub Actions is disabled for this repository, so no CI run will '
  + 'ever grade this head. Verify locally: AUDIT_PREPUSH_TIER=full runs the full suite at push, and '
  + 'AUDIT_LOOP_WEEKLY_MAINTENANCE=1 runs the weekly checks from the pre-push hook';

/** The local remedy for a scheduled workflow that cannot fire here. */
export const ACTIONS_DISABLED_SCHEDULE_REMEDY = 'GitHub Actions is disabled for this repository, so no scheduled '
  + 'workflow can run here. Run the weekly checks locally instead: AUDIT_LOOP_WEEKLY_MAINTENANCE=1 runs them '
  + 'from the pre-push hook when overdue';
