/**
 * @fileoverview `assessRequiredCi` (scripts/lib/fleet/required-checks.mjs; docs/plans/ci-evidence-oracle.md sections 2.1, 2.5): the CI evidence
 * for a PR head, as ONE tag from a closed set, from a scripted GitHub built on RECORDED fixtures. One row per tag and per fault kind, the read
 * ORDER (a later read is never made after an earlier one failed), the config assertion, and the never-throws contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessRequiredCi, CI_EVIDENCE_TAGS, CI_FAULT_KINDS, decideCiAdmission } from '../scripts/lib/fleet/required-checks.mjs';
import { cesScenario, emptyScenario, failed, fixture, githubFake, HEAD, OTHER_HEAD, REPO } from './helpers/fleet-github-fake.mjs';

const APP = 15368;
const run = (id, name, status = 'completed', conclusion = 'success', app = APP) => ({ id, name, status, conclusion: status === 'completed' ? conclusion : null, head_sha: HEAD, app: app === null ? null : { id: app } });
const runs = (...list) => ({ total_count: list.length, check_runs: list });
const assess = (scenario, over = {}) => {
  const g = githubFake(scenario);
  const evidence = assessRequiredCi({ repo: REPO, prNumber: 395, expectedBase: 'main', expectedHead: HEAD, configAssertion: undefined, ...over }, g.deps);
  return { evidence, g };
};
const kinds = (e) => [e.tag, e.fault?.kind ?? e.code ?? null];
const wcaRules = () => fixture('wca-rules-main.json'); // 'Required gate' and 'AI-Models trailer', both app 15368

describe('the permitting tags', () => {
  it('CES: ruleset-only, full-suite from app 15368 succeeded -> passed, naming what passed, after the read order pr, branch, rules, runs, statuses, pr', () => {
    const { evidence, g } = assess(cesScenario());
    assert.deepEqual(evidence, { tag: 'passed', head: HEAD, required: [{ name: 'full-suite', conclusion: 'success', appId: APP }] });
    assert.deepEqual(g.calls.map((c) => (c[0] === 'pr' ? 'pr' : c[1].replace(/^repos\/[^/]+\/[^/]+\//, '').replace(/\?.*/, '').replace(HEAD, 'sha'))), ['pr', 'branches/main', 'rules/branches/main', 'commits/sha/check-runs', 'commits/sha/statuses', 'pr']);
  });
  it('AIO: unprotected branch and an empty rules list is PROVEN empty -> none-required (and the PR is still re-read)', () => {
    const { evidence, g } = assess(emptyScenario());
    assert.equal(evidence.tag, 'none-required');
    assert.deepEqual(evidence.required, []);
    assert.equal(g.calls.filter((c) => c[0] === 'pr').length, 2);
    assert.equal(g.calls.filter((c) => /check-runs/.test(c[1] ?? '')).length, 0, 'nothing required, so no check runs are read');
  });
  it('a ruleset-only branch whose rules hold no status-check rule is none-required too (WCA rule types without the requirement)', () => {
    const rules = wcaRules().filter((r) => r.type !== 'required_status_checks');
    assert.equal(assess(cesScenario({ rules })).evidence.tag, 'none-required');
  });
  it('several required checks all passing are passed, each named with its app', () => {
    const { evidence } = assess(cesScenario({ rules: wcaRules(), checkRuns: runs(run(1, 'Required gate'), run(2, 'AI-Models trailer'), run(3, 'unrelated', 'completed', 'failure')) }));
    assert.deepEqual(evidence.required.map((x) => x.name).sort(), ['AI-Models trailer', 'Required gate']);
    assert.equal(evidence.tag, 'passed');
  });
  it('the same run twice with the SAME conclusion is still passed (a re-run that agreed)', () => {
    assert.equal(assess(cesScenario({ checkRuns: runs(run(1, 'full-suite'), run(2, 'full-suite')) })).evidence.tag, 'passed');
  });
});

describe('ineligible: decided from the PR alone, before any CI read', () => {
  const pr = (over) => ({ ...fixture('ces-pr-395-view.json'), ...over });
  for (const [name, over, code] of [['closed', { state: 'CLOSED' }, 'closed'], ['merged', { state: 'MERGED' }, 'merged'], ['draft', { isDraft: true }, 'draft'], ['retargeted', { baseRefName: 'develop' }, 'retargeted'], ['head moved', { headRefOid: OTHER_HEAD }, 'head-moved']]) {
    it(`${name} -> ineligible ${code}, with one gh call`, () => {
      const { evidence, g } = assess(cesScenario({ pr: pr(over) }));
      assert.deepEqual(kinds(evidence), ['ineligible', code]);
      assert.equal(g.calls.length, 1);
    });
  }
  it('an absent or non-boolean isDraft is unknown(malformed), never "not a draft"', () => {
    for (const mut of [(d) => { delete d.isDraft; }, (d) => { d.isDraft = 'no'; }]) {
      const d = pr({}); mut(d);
      assert.deepEqual(kinds(assess(cesScenario({ pr: d })).evidence), ['unknown', 'malformed']);
    }
  });
  it('the PR view failing is unknown(transport)', () => {
    assert.deepEqual(kinds(assess(cesScenario({ pr: failed(1, 'HTTP 502') })).evidence), ['unknown', 'transport']);
  });
});

describe('the inventory: GitHub defines it, and an unreadable or ambiguous answer is unknown', () => {
  it('a missing branch: the branch read 404s even though the rules read would say [] (M5: "no rules" proves nothing) -> unknown(transport), no rules read', () => {
    const { evidence, g } = assess(cesScenario({ branch: failed(1, 'gh: Branch not found (HTTP 404)'), rules: [] }));
    assert.deepEqual(kinds(evidence), ['unknown', 'transport']);
    assert.equal(g.calls.filter((c) => /rules\/branches/.test(c[1] ?? '')).length, 0);
  });
  it('a 403 or a 404 on the rules is unknown(transport), never an empty inventory', () => {
    for (const rules of [failed(1, 'HTTP 403'), failed(1, 'HTTP 404')]) assert.deepEqual(kinds(assess(cesScenario({ rules })).evidence), ['unknown', 'transport']);
  });
  it('classic protection ENABLED is unsupported, whatever the rules say', () => {
    const branch = fixture('ces-branch-main.json'); branch.protection.enabled = true; branch.protection.required_status_checks = { contexts: ['x'], checks: [] };
    assert.deepEqual(kinds(assess(cesScenario({ branch })).evidence), ['unknown', 'unsupported-classic-protection']);
  });
  it('protected:true with classic off (a ruleset) is NOT classic protection (the measured CES shape)', () => {
    assert.equal(fixture('ces-branch-main.json').protected, true);
    assert.equal(assess(cesScenario()).evidence.tag, 'passed');
  });
  it('a requirement with no pinned integration is unsupported, because identity cannot be established', () => {
    const rules = fixture('ces-rules-main.json'); delete rules[0].parameters.required_status_checks[0].integration_id;
    assert.deepEqual(kinds(assess(cesScenario({ rules })).evidence), ['unknown', 'unsupported-unpinned-requirement']);
  });
  it('a rule type the oracle does not read (workflows, required_deployments, code_scanning, merge_queue, a future type) is unsupported-rule-type, NEVER none-required', () => {
    for (const type of ['workflows', 'required_deployments', 'code_scanning', 'merge_queue', 'a_type_github_adds_tomorrow']) {
      assert.deepEqual(kinds(assess(emptyScenario({ rules: [{ type, parameters: {} }] })).evidence), ['unknown', 'unsupported-rule-type'], type);
      assert.deepEqual(kinds(assess(cesScenario({ rules: [...fixture('ces-rules-main.json'), { type }] })).evidence), ['unknown', 'unsupported-rule-type'], `${type} beside a status-check rule`);
    }
    assert.equal(assess(cesScenario({ rules: wcaRules() , checkRuns: runs(run(1, 'Required gate'), run(2, 'AI-Models trailer')) })).evidence.tag, 'passed', 'every measured rule type is read');
  });
  it('a full page of rules is too-many-results', () => {
    const rules = Array.from({ length: 100 }, () => ({ type: 'deletion' }));
    assert.deepEqual(kinds(assess(cesScenario({ rules })).evidence), ['unknown', 'too-many-results']);
  });
});

describe('the config assertion: exact agreement with GitHub, never a substitute and never a union', () => {
  const cfg = (requiredChecks, error = null) => ({ requiredChecks, error });
  it('absent asserts nothing; an exact match passes; order does not matter', () => {
    assert.equal(assess(cesScenario(), { configAssertion: undefined }).evidence.tag, 'passed');
    assert.equal(assess(cesScenario(), { configAssertion: cfg(undefined) }).evidence.tag, 'passed');
    assert.equal(assess(cesScenario(), { configAssertion: cfg(['full-suite']) }).evidence.tag, 'passed');
    assert.equal(assess(cesScenario({ rules: wcaRules(), checkRuns: runs(run(1, 'Required gate'), run(2, 'AI-Models trailer')) }), { configAssertion: cfg(['AI-Models trailer', 'Required gate']) }).evidence.tag, 'passed');
  });
  it('drift in either direction is config-drift naming BOTH differences', () => {
    const extra = assess(cesScenario(), { configAssertion: cfg(['full-suite', 'lint']) }).evidence;
    assert.deepEqual(kinds(extra), ['unknown', 'config-drift']);
    assert.match(extra.fault.detail, /configured but not required by GitHub \[lint\]/);
    const fewer = assess(cesScenario(), { configAssertion: cfg([]) }).evidence;
    assert.match(fewer.fault.detail, /required by GitHub but not configured \[full-suite\]/);
    assert.deepEqual(kinds(assess(cesScenario(), { configAssertion: cfg(['other']) }).evidence), ['unknown', 'config-drift']);
  });
  it('[] against a proven-empty inventory agrees (none-required); [] against a requirement drifts; a non-empty config against empty drifts', () => {
    assert.equal(assess(emptyScenario(), { configAssertion: cfg([]) }).evidence.tag, 'none-required');
    assert.deepEqual(kinds(assess(emptyScenario(), { configAssertion: cfg(['full-suite']) }).evidence), ['unknown', 'config-drift']);
  });
  it('a config error, or a config that is not a list of names, is config-error', () => {
    assert.deepEqual(kinds(assess(cesScenario(), { configAssertion: cfg(undefined, 'bad json') }).evidence), ['unknown', 'config-error']);
    for (const bad of ['full-suite', [1], [''], {}]) assert.deepEqual(kinds(assess(cesScenario(), { configAssertion: cfg(bad) }).evidence), ['unknown', 'config-error'], JSON.stringify(bad));
  });
  it('config NEVER substitutes for an unreadable inventory: the same config that agrees with GitHub cannot rescue a failed read (the 90c60bf2 hole)', () => {
    for (const over of [{ rules: failed(1, 'HTTP 502') }, { branch: failed(1, 'HTTP 502') }]) {
      assert.deepEqual(kinds(assess(cesScenario(over), { configAssertion: cfg(['full-suite']) }).evidence), ['unknown', 'transport']);
    }
  });
});

describe('the observation: failed, not-run, missing, pending, and every doubt unknown', () => {
  const one = (...rs) => assess(cesScenario({ checkRuns: runs(...rs) })).evidence;
  it('failure, cancelled, timed_out and startup_failure are failed', () => {
    for (const c of ['failure', 'cancelled', 'timed_out', 'startup_failure']) assert.deepEqual(kinds(one(run(1, 'full-suite', 'completed', c))), ['failed', null], c);
  });
  it('skipped, neutral, stale and action_required are not-run, never success', () => {
    for (const c of ['skipped', 'neutral', 'stale', 'action_required']) assert.deepEqual(kinds(one(run(1, 'full-suite', 'completed', c))), ['not-run', null], c);
  });
  it('no run of that name is missing; a same-name run from ANOTHER app is missing and names the wrong app; a run with no app is missing', () => {
    assert.deepEqual(kinds(one(run(1, 'some-other-check'))), ['missing', null]);
    const wrong = one(run(1, 'full-suite', 'completed', 'success', 999));
    assert.deepEqual(kinds(wrong), ['missing', null]);
    assert.deepEqual(wrong.wrongApp, { 'full-suite': [999] });
    assert.equal(one(run(1, 'full-suite', 'completed', 'success', null)).tag, 'missing');
    assert.equal(one().tag, 'missing');
  });
  it('a required context named like an object prototype key is an ordinary name (wrongApp keeps it as an own property)', () => {
    const rules = fixture('ces-rules-main.json'); rules[0].parameters.required_status_checks[0].context = '__proto__';
    const e = assess(cesScenario({ rules, checkRuns: runs(run(1, '__proto__', 'completed', 'success', 999)) })).evidence;
    assert.equal(e.tag, 'missing');
    assert.deepEqual(Object.keys(e.wrongApp), ['__proto__']);
    assert.deepEqual(e.names.missing, ['__proto__']);
  });
  it('queued, in_progress, waiting, requested and pending are pending', () => {
    for (const s of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) assert.equal(one(run(1, 'full-suite', s)).tag, 'pending', s);
  });
  it('a re-run in flight beside an old failure is pending (the failure is listed nowhere as the answer)', () => {
    assert.equal(one(run(1, 'full-suite', 'completed', 'failure'), run(2, 'full-suite', 'in_progress')).tag, 'pending');
  });
  it('a pending run beside MALFORMED or unrecognised completed evidence is unknown: a fault wins over pending', () => {
    assert.deepEqual(kinds(one(run(1, 'full-suite', 'in_progress'), run(2, 'full-suite', 'completed', 'exploded'))), ['unknown', 'unknown-conclusion']);
    const bad = run(2, 'full-suite', 'completed', 'success'); bad.conclusion = null;
    assert.deepEqual(kinds(one(run(1, 'full-suite', 'in_progress'), bad)), ['unknown', 'malformed']);
  });
  it('success + failure from the pinned app (M11) is duplicate-conflict, success + skipped too', () => {
    assert.deepEqual(kinds(one(run(1, 'full-suite', 'completed', 'success'), run(2, 'full-suite', 'completed', 'failure'))), ['unknown', 'duplicate-conflict']);
    assert.deepEqual(kinds(one(run(1, 'full-suite', 'completed', 'success'), run(2, 'full-suite', 'completed', 'skipped'))), ['unknown', 'duplicate-conflict']);
  });
  it('an unrecognised conclusion, an unrecognised status and an illegal status/conclusion pair are typed faults', () => {
    assert.deepEqual(kinds(one(run(1, 'full-suite', 'completed', 'exploded'))), ['unknown', 'unknown-conclusion']);
    assert.deepEqual(kinds(one(run(1, 'full-suite', 'teleporting'))), ['unknown', 'unknown-conclusion']);
    const unfinishedWithConclusion = run(1, 'full-suite', 'in_progress'); unfinishedWithConclusion.conclusion = 'success';
    assert.deepEqual(kinds(one(unfinishedWithConclusion)), ['unknown', 'malformed']);
  });
  it('a page that is not the whole set, a repeated run id and a run on another head are typed faults, never a partial observation', () => {
    const short = runs(run(1, 'full-suite')); short.total_count = 2;
    assert.deepEqual(kinds(assess(cesScenario({ checkRuns: short })).evidence), ['unknown', 'too-many-results']);
    assert.deepEqual(kinds(one(run(1, 'full-suite'), run(1, 'full-suite'))), ['unknown', 'malformed']);
    const other = run(1, 'full-suite'); other.head_sha = OTHER_HEAD;
    assert.deepEqual(kinds(one(other)), ['unknown', 'malformed']);
  });
  it('a status context differing only in case is still a collision', () => {
    assert.deepEqual(kinds(assess(cesScenario({ statuses: [{ id: 1, context: 'Full-Suite', state: 'success' }] })).evidence), ['unknown', 'status-context-present']);
  });
  it('inherited property names are not conclusions: constructor, __proto__ and toString are unknown-conclusion', () => {
    for (const c of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.deepEqual(kinds(one(run(1, 'full-suite', 'completed', c))), ['unknown', 'unknown-conclusion'], c);
  });
  it('a commit status sharing a required context is unknown(status-context-present); a status with another context is ignored; a statuses failure is transport', () => {
    const st = (context) => [{ id: 1, context, state: 'success' }];
    assert.deepEqual(kinds(assess(cesScenario({ statuses: st('full-suite') })).evidence), ['unknown', 'status-context-present']);
    assert.equal(assess(cesScenario({ statuses: st('some/other') })).evidence.tag, 'passed');
    assert.deepEqual(kinds(assess(cesScenario({ statuses: failed(1, 'HTTP 502') })).evidence), ['unknown', 'transport']);
  });
  it('the check-runs read failing is unknown(transport)', () => {
    assert.deepEqual(kinds(assess(cesScenario({ checkRuns: failed(1, 'HTTP 403') })).evidence), ['unknown', 'transport']);
  });
  it('PRECEDENCE with two requirements: failed beats not-run beats missing beats pending, every name is listed, and any fault beats them all', () => {
    const sc = (...rs) => assess(cesScenario({ rules: wcaRules(), checkRuns: runs(...rs) })).evidence;
    const e1 = sc(run(1, 'Required gate', 'completed', 'failure'));
    assert.deepEqual([e1.tag, e1.names.failed, e1.names.missing], ['failed', ['Required gate'], ['AI-Models trailer']]);
    assert.equal(sc(run(1, 'Required gate', 'completed', 'skipped'), run(2, 'AI-Models trailer', 'in_progress')).tag, 'not-run');
    assert.equal(sc(run(1, 'Required gate', 'in_progress')).tag, 'missing');
    assert.equal(sc(run(1, 'Required gate', 'in_progress'), run(2, 'AI-Models trailer', 'queued')).tag, 'pending');
    assert.deepEqual(kinds(sc(run(1, 'Required gate', 'completed', 'failure'), run(2, 'AI-Models trailer', 'completed', 'exploded'))), ['unknown', 'unknown-conclusion']);
  });
});

describe('the head is re-read at the END, for every outcome', () => {
  const pr = fixture('ces-pr-395-view.json');
  it('a head that moves during the observation is ineligible head-moved, even when every check passed', () => {
    const { evidence } = assess(cesScenario({ pr: [pr, { ...pr, headRefOid: OTHER_HEAD }] }));
    assert.deepEqual(kinds(evidence), ['ineligible', 'head-moved']);
  });
  it('a draft or retarget appearing between the reads is ineligible, on the passing path AND the proven-empty path', () => {
    for (const mk of [cesScenario, emptyScenario]) {
      for (const [over, code] of [[{ isDraft: true }, 'draft'], [{ baseRefName: 'develop' }, 'retargeted'], [{ state: 'CLOSED' }, 'closed'], [{ state: 'MERGED' }, 'merged']]) {
        assert.deepEqual(kinds(assess(mk({ pr: [pr, { ...pr, ...over }] })).evidence), ['ineligible', code], `${mk.name} ${code}`);
      }
    }
  });
  it('the final read failing, or answering a malformed isDraft, is unknown', () => {
    assert.deepEqual(kinds(assess(cesScenario({ pr: (n) => (n === 1 ? pr : failed(1, 'HTTP 502')) })).evidence), ['unknown', 'transport']);
    const noDraft = { ...pr }; delete noDraft.isDraft;
    assert.deepEqual(kinds(assess(emptyScenario({ pr: [pr, noDraft] })).evidence), ['unknown', 'malformed']);
  });
  it('a CI problem found before the re-read does not need the re-read: failed stays failed only when the head still matches', () => {
    const failing = cesScenario({ checkRuns: runs(run(1, 'full-suite', 'completed', 'failure')) });
    assert.equal(assess(failing).evidence.tag, 'failed');
    assert.deepEqual(kinds(assess({ ...failing, pr: [pr, { ...pr, headRefOid: OTHER_HEAD }] }).evidence), ['ineligible', 'head-moved']);
  });
});

describe('the contract: a closed set, no action, no throw', () => {
  it('every tag and fault kind it returns is in the closed sets (a census over every scenario above)', () => {
    const rows = [cesScenario(), emptyScenario(), cesScenario({ pr: failed() }), cesScenario({ rules: failed() }), cesScenario({ checkRuns: runs() }), cesScenario({ checkRuns: runs(run(1, 'full-suite', 'completed', 'failure')) }),
      cesScenario({ checkRuns: runs(run(1, 'full-suite', 'completed', 'skipped')) }), cesScenario({ checkRuns: runs(run(1, 'full-suite', 'queued')) }), cesScenario({ statuses: [{ id: 1, context: 'full-suite', state: 'success' }] })];
    for (const sc of rows) {
      const { evidence } = assess(sc);
      assert.ok(CI_EVIDENCE_TAGS.includes(evidence.tag), evidence.tag);
      if (evidence.tag === 'unknown') assert.ok(CI_FAULT_KINDS.includes(evidence.fault.kind), evidence.fault.kind);
      assert.ok(!('disposition' in evidence) && !('action' in evidence), 'evidence never carries an action');
      assert.ok(decideCiAdmission(evidence).disposition);
    }
  });
  it('a gh that throws, a deps with no gh and hostile arguments return unknown, never throw', () => {
    const throwing = { gh: () => { throw new Error('spawn EPERM'); }, cwd: '.' };
    assert.equal(assessRequiredCi({ repo: REPO, prNumber: 395, expectedBase: 'main', expectedHead: HEAD }, throwing).tag, 'unknown');
    assert.equal(assessRequiredCi({ repo: REPO, prNumber: 395, expectedBase: 'main', expectedHead: HEAD }, {}).tag, 'unknown');
    assert.equal(assessRequiredCi({ repo: 'nope', prNumber: -1, expectedBase: 'main', expectedHead: HEAD }, githubFake(cesScenario()).deps).tag, 'unknown');
    assert.equal(assessRequiredCi({}, undefined).tag, 'unknown');
    for (const bad of [null, undefined, 7, 'x']) assert.equal(assessRequiredCi(bad, githubFake(cesScenario()).deps).tag, 'unknown', String(bad));
  });
  it('positive and negative controls together: the passing scenario permits, and each single mutation of it does not (an always-refuse or always-permit oracle fails one side)', () => {
    assert.equal(decideCiAdmission(assess(cesScenario()).evidence).disposition, 'permit');
    const mutations = [{ checkRuns: runs(run(1, 'full-suite', 'completed', 'failure')) }, { checkRuns: runs(run(1, 'full-suite', 'completed', 'skipped')) }, { checkRuns: runs() },
      { checkRuns: runs(run(1, 'full-suite', 'completed', 'success', 999)) }, { checkRuns: runs(run(1, 'full-suite', 'queued')) }, { rules: failed() }, { branch: failed() }, { pr: { ...fixture('ces-pr-395-view.json'), isDraft: true } }];
    for (const m of mutations) assert.notEqual(decideCiAdmission(assess(cesScenario(m)).evidence).disposition, 'permit', JSON.stringify(Object.keys(m)));
  });
});
