/**
 * @fileoverview The ONE oracle for "may this persona session read `Ready for
 * users`?" — the composed eligibility predicate `skills/persona-test/SKILL.md`
 * Phase 5 states in prose, made deterministic so the stored verdict cannot
 * claim more than the session established.
 *
 * Why it exists (field report, 2026-09-26, Streamlit consumer): a run reported
 * 0 P0/P1 and `Ready for users`; a deeper run of the same app later found two
 * P1 lifecycle defects — a handover that did not open the exact item selected
 * before navigation, and a completed item that vanished from its queue instead
 * of showing as completed. The first run had reached its goal. It had not
 * verified the state the goal passed through. `terminalReason: 'goal-reached'`
 * plus no P0/P1 made those two situations indistinguishable.
 *
 * So a stateful mission now reports a `lifecycle` block — which of the six
 * checklist steps it verified — and this module caps the verdict when the
 * lifecycle is anything but verified or not-applicable. The cap is to
 * `Needs work`, the same cap every other failing conjunct already uses, so the
 * stored three-value vocabulary (a CHECK constraint on two tables) is
 * unchanged; the report's OVERALL line names the reason as
 * `Goal reached — lifecycle unverified`.
 *
 * Pure. No I/O.
 *
 * @module scripts/lib/persona-test/verdict-eligibility
 */
import { z } from 'zod';

/** The three verdicts the store accepts (persona_test_sessions_verdict_check). */
export const PERSONA_VERDICTS = Object.freeze(['Ready for users', 'Needs work', 'Blocked']);

/**
 * The stateful-mission checklist, in the order a mission passes through it.
 * `skills/persona-test/SKILL.md` Phase 3 names the same six steps; a test pins
 * the two lists against each other.
 */
export const LIFECYCLE_STEPS = Object.freeze([
  'initial-state',
  'selected-identity',
  'post-boundary-state',
  'command-outcome',
  'return-to-origin',
  'retained-history',
]);

export const LIFECYCLE_STATUSES = Object.freeze(['verified', 'partial', 'not-applicable']);

/** The `Reason:` label a lifecycle-capped run reports on its OVERALL line. */
export const LIFECYCLE_UNVERIFIED_LABEL = 'Goal reached — lifecycle unverified';

/**
 * `lifecycle` as the session payload carries it. `unchecked` lists the steps
 * NOT verified; it must be empty for `verified`/`not-applicable` and non-empty
 * for `partial` — a `partial` that names nothing unchecked is a contradiction,
 * not a lifecycle.
 */
export const LifecycleSchema = z.object({
  status: z.enum(LIFECYCLE_STATUSES),
  unchecked: z.array(z.enum(LIFECYCLE_STEPS)).default([]),
}).superRefine((v, ctx) => {
  if (v.status === 'partial' && v.unchecked.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['unchecked'], message: "status 'partial' must name at least one unchecked step" });
  }
  if (v.status !== 'partial' && v.unchecked.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['unchecked'], message: `status '${v.status}' cannot carry unchecked steps — use 'partial'` });
  }
});

/**
 * Every conjunct of the `Ready for users` predicate that FAILS for this
 * session. Empty ⇒ eligible.
 *
 * `lifecycle` absent is a failing conjunct (`lifecycle=unreported`), not a
 * pass: an unasked question must never render as a clean answer. The three
 * work-record conjuncts are checked only when the caller supplied them —
 * they are optional on the wire for callers predating this module, and a
 * missing one is not evidence either way.
 *
 * @param {{p0Count?: number, p1Count?: number, lifecycle?: {status: string, unchecked?: string[]},
 *   terminalReason?: string, authState?: string, originPolicyResult?: string}} s
 * @returns {string[]} failing-conjunct descriptions, stable order
 */
export function readyForUsersBlockers(s) {
  const blockers = [];
  const p0 = Number(s?.p0Count) || 0;
  const p1 = Number(s?.p1Count) || 0;
  if (p0 + p1 > 0) blockers.push(`p0p1=${p0 + p1}`);
  const lc = s?.lifecycle;
  if (!lc) blockers.push('lifecycle=unreported');
  else if (lc.status === 'partial') blockers.push(`lifecycle=partial (unchecked: ${(lc.unchecked ?? []).join(', ')})`);
  if (s?.terminalReason != null && s.terminalReason !== 'goal-reached') blockers.push(`terminalReason=${s.terminalReason}`);
  if (s?.authState === 'auth-wall-untested') blockers.push('authState=auth-wall-untested');
  if (s?.originPolicyResult === 'cross-origin-attempted-and-blocked') blockers.push('originPolicyResult=cross-origin-attempted-and-blocked');
  return blockers;
}

/**
 * Cap a claimed verdict to what the session established. Only `Ready for
 * users` is ever changed, and only ever DOWN to `Needs work` — a `Blocked` or
 * `Needs work` claim is already at or below the cap and passes through.
 *
 * @returns {{verdict: string, capped: boolean, blockers: string[], label: string|null}}
 *   `label` is `LIFECYCLE_UNVERIFIED_LABEL` when the lifecycle is the reason
 *   (the goal was reached but its state was not verified), else null.
 */
export function capPersonaVerdict(session) {
  const claimed = session?.verdict;
  if (claimed !== 'Ready for users') return { verdict: claimed, capped: false, blockers: [], label: null };
  const blockers = readyForUsersBlockers(session);
  if (blockers.length === 0) return { verdict: claimed, capped: false, blockers, label: null };
  const lifecycleOnly = blockers.every((b) => b.startsWith('lifecycle='));
  return {
    verdict: 'Needs work',
    capped: true,
    blockers,
    label: lifecycleOnly && session?.lifecycle ? LIFECYCLE_UNVERIFIED_LABEL : null,
  };
}
