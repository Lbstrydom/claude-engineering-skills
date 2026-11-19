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
 * The evidence of a world's REQUIRED checks at `head`. The world scripts ONE observed check, named `observedName` (default `ci`), with
 * one bucket: a required context it does not name was NEVER observed (`missing`), and a world with no rules answer at all (`rules` not an
 * array) is unknown, never a proven-empty inventory. `rulesFail` is a GitHub that will not answer.
 */
export function requiredEvidence({ rules, rulesFail = false, bucket, head, observedName = 'ci' }) {
  if (rulesFail) return ev.unknown('transport', 'rules api down');
  if (!Array.isArray(rules)) return ev.unknown('malformed', 'the world scripts no rules answer');
  const required = rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters.required_status_checks.map((c) => c.context));
  if (!required.length) return ev.noneRequired(head);
  const unobserved = required.filter((c) => c !== observedName);
  const own = required.includes(observedName) ? evidenceFromBucket(bucket, head) : null;
  if (own && own.tag !== 'passed') return own; // the observed check's own bad news first
  if (unobserved.length) return ev.missing(head, unobserved);
  return own;
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
    if (typeof p.draft !== 'boolean') return ev.unknown('malformed', 'the scripted PR has no boolean isDraft');
    if (p.draft) return ev.ineligible('draft');
    if (p.base !== expectedBase) return ev.ineligible('retargeted');
    if (p.head !== expectedHead) return ev.ineligible('head-moved', p.head);
    return requiredEvidence({ rules: w.rules, rulesFail: w.rulesFail, bucket: p.checks, head: expectedHead });
  };
}
