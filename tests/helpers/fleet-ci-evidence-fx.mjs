/**
 * @fileoverview Evidence fixtures for the fleet suites that inject `deps.assessCi` (docs/plans/ci-evidence-oracle.md §2.1): one
 * factory per evidence tag, and `oracleOf(world)` that derives evidence from the scripted-GitHub worlds the landing suites already
 * keep, so those suites assert the SAME scenarios through the new seam. Test-only: production's default oracle is the PR-1 stub.
 *
 * @module tests/helpers/fleet-ci-evidence-fx
 */
export const ev = Object.freeze({
  passed: (head, required = [{ name: 'ci', conclusion: 'success' }]) => ({ tag: 'passed', head, required }),
  noneRequired: (head) => ({ tag: 'none-required', head, required: [] }),
  failed: (head, names = ['ci']) => ({ tag: 'failed', head, names: { failed: names } }),
  notRun: (head, names = ['ci']) => ({ tag: 'not-run', head, names: { 'not-run': names } }),
  missing: (head, names = ['ci']) => ({ tag: 'missing', head, names: { missing: names } }),
  pending: (head, names = ['ci']) => ({ tag: 'pending', head, names: { pending: names } }),
  ineligible: (code, head = null) => ({ tag: 'ineligible', code, head }),
  unknown: (kind, detail = 'scripted fault') => ({ tag: 'unknown', fault: { kind, detail } }),
});

/** A bucket the landing worlds keep per PR (`pass`, `fail`, `pending`, `skipping`, `missing`) as evidence at `head`. */
export function evidenceFromBucket(bucket, head) {
  switch (bucket) {
    case 'pass': return ev.passed(head);
    case 'fail': return ev.failed(head);
    case 'pending': return ev.pending(head);
    case 'skipping': return ev.notRun(head);
    case 'missing': return ev.missing(head);
    default: return ev.unknown('unknown-conclusion', `scripted bucket ${bucket}`);
  }
}

/**
 * The oracle of a landing world `w`: `w.prs` is a Map of PR number to `{state, head, draft, base, checks, unreadable}`, `w.rules` the
 * ruleset answer, `w.rulesFail` a GitHub that will not answer. Mirrors the read order of the real oracle: eligibility first, then CI.
 */
export function oracleOf(w) {
  return ({ prNumber, expectedBase, expectedHead }) => {
    const p = w.prs.get(prNumber);
    if (!p) return ev.unknown('malformed', `no scripted PR ${prNumber}`);
    if (p.unreadable) return ev.unknown('transport', 'PR view failed');
    if (p.state === 'MERGED') return ev.ineligible('merged');
    if (p.state !== 'OPEN') return ev.ineligible('closed');
    if (p.draft) return ev.ineligible('draft');
    if (p.base !== expectedBase) return ev.ineligible('retargeted');
    if (p.head !== expectedHead) return ev.ineligible('head-moved', p.head);
    if (w.rulesFail) return ev.unknown('transport', 'rules api down');
    const required = (w.rules ?? []).filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters.required_status_checks.map((c) => c.context));
    if (!required.length) return ev.noneRequired(expectedHead);
    return evidenceFromBucket(p.checks, expectedHead);
  };
}
