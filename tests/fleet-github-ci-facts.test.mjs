/**
 * @fileoverview The GitHub-facts adapter (scripts/lib/fleet/github-ci-facts.mjs; docs/plans/ci-evidence-oracle.md section 2.4) over RECORDED
 * fixtures (tests/fixtures/fleet/github-ci/, recorded 2026-11-19 from Lbstrydom/claude-engineering-skills, wine-cellar-app and ai-organiser).
 * Every reader decodes its fixture to the expected facts; each mutation (a field removed, a wrong type, a short or repeated page, a non-zero
 * exit carrying a plausible body) yields the NAMED fault; and no branch reads stderr.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PAGE_SIZE, readBranchProtection, readBranchRules, readCheckRuns, readCommitStatuses, readPrCandidate,
} from '../scripts/lib/fleet/github-ci-facts.mjs';

const DIR = path.join(import.meta.dirname, 'fixtures', 'fleet', 'github-ci');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const body = (name) => structuredClone(load(name).body);
const REPO = 'Lbstrydom/claude-engineering-skills';
const HEAD = '90c60bf286f891ad6fe2168321a30fbe843921a6';
const WCA_HEAD = '1f0a5263f779267f1f3cf0a555da667099f092c8';

const answer = (doc) => ({ ok: true, status: 0, stdout: JSON.stringify(doc), stderr: '' });
const fail = (status, stderr, stdout = '') => ({ ok: false, status, stdout, stderr, reason: 'x' });
const deps = (res) => ({ gh: () => (typeof res === 'function' ? res() : res) });

describe('every fixture carries its provenance', () => {
  for (const name of fs.readdirSync(DIR)) {
    it(name, () => {
      const f = load(name);
      assert.deepEqual(Object.keys(f).sort(), ['body', 'provenance']);
      for (const k of ['repo', 'endpoint', 'command', 'recordedAt', 'tool', 'note']) assert.ok(f.provenance[k], `${name} provenance.${k}`);
      assert.match(f.provenance.recordedAt, /^2026-11-19$/);
    });
  }
});

describe('transport: any failed run is `transport`, and NO branch reads stderr', () => {
  const readers = [
    ['readPrCandidate', (d) => readPrCandidate(d, '.', { repo: REPO, prNumber: 395 })],
    ['readBranchProtection', (d) => readBranchProtection(d, '.', { repo: REPO, base: 'main' })],
    ['readBranchRules', (d) => readBranchRules(d, '.', { repo: REPO, base: 'main' })],
    ['readCheckRuns', (d) => readCheckRuns(d, '.', { repo: REPO, head: HEAD })],
    ['readCommitStatuses', (d) => readCommitStatuses(d, '.', { repo: REPO, head: HEAD })],
  ];
  for (const [name, read] of readers) {
    it(`${name}: exit 1 with a 404 body, a 403, a timeout and a thrown gh are all transport`, () => {
      for (const res of [fail(1, 'gh: Not Found (HTTP 404)'), fail(1, 'gh: Forbidden (HTTP 403)'), fail(null, '', ''), () => { throw new Error('spawn failed'); }]) {
        const r = read(deps(res));
        assert.deepEqual([r.ok, r.fault?.kind], [false, 'transport'], name);
      }
    });
    it(`${name}: identical stderr with exit 0 and exit 1 differ only by the exit (stderr is never read)`, () => {
      const doc = { ok: true, status: 0, stdout: 'not json', stderr: 'gh: Not Found (HTTP 404)' };
      assert.equal(read(deps(doc)).fault.kind, 'malformed', 'exit 0 + 404 text on stderr is decoded as output, not as "empty"');
      assert.equal(read(deps({ ...doc, ok: false, status: 1 })).fault.kind, 'transport');
    });
    it(`${name}: an empty stdout and a non-JSON stdout are malformed`, () => {
      assert.equal(read(deps({ ok: true, status: 0, stdout: '', stderr: '' })).fault.kind, 'malformed');
      assert.equal(read(deps({ ok: true, status: 0, stdout: '<html>', stderr: '' })).fault.kind, 'malformed');
    });
  }
  it('a hostile detail (control characters, a huge stderr) is one short line', () => {
    const r = readPrCandidate(deps(fail(1, `boom\n\u001b[31m${'x'.repeat(5000)}`)), '.', { repo: REPO, prNumber: 1 });
    assert.ok(r.fault.detail.length <= 300 && !/[\u0000-\u001f]/.test(r.fault.detail));
  });
  it('a bad repo or argument is malformed and runs no gh at all', () => {
    let calls = 0;
    const d = { gh: () => { calls += 1; return answer({}); } };
    for (const r of [readPrCandidate(d, '.', { repo: 'nope', prNumber: 1 }), readPrCandidate(d, '.', { repo: REPO, prNumber: 0 }), readBranchProtection(d, '.', { repo: REPO, base: '' }),
      readBranchRules(d, '.', { repo: 'a b/c', base: 'main' }), readCheckRuns(d, '.', { repo: REPO, head: 'abc' }), readCommitStatuses(d, '.', { repo: REPO, head: '' })]) {
      assert.equal(r.fault.kind, 'malformed');
    }
    assert.equal(calls, 0);
  });
});

describe('readPrCandidate', () => {
  it('decodes the recorded PR view, and unrelated keys are tolerated', () => {
    const r = readPrCandidate(deps(answer(body('ces-pr-395-view.json'))), '.', { repo: REPO, prNumber: 395 });
    assert.deepEqual(r.value, { state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefName: 'main' });
  });
  it('a missing or non-boolean isDraft is malformed, never "not a draft" (the 90c60bf2 hole)', () => {
    for (const mut of [(d) => { delete d.isDraft; }, (d) => { d.isDraft = 'false'; }, (d) => { d.isDraft = null; }, (d) => { d.isDraft = 0; }]) {
      const d = body('ces-pr-395-view.json'); mut(d);
      assert.equal(readPrCandidate(deps(answer(d)), '.', { repo: REPO, prNumber: 395 }).fault.kind, 'malformed');
    }
  });
  it('a missing or mistyped decision field is malformed, naming the path', () => {
    for (const [mut, path_] of [[(d) => { delete d.headRefOid; }, 'headRefOid'], [(d) => { d.headRefOid = 'abc123'; }, 'headRefOid'], [(d) => { d.state = 7; }, 'state'], [(d) => { delete d.baseRefName; }, 'baseRefName']]) {
      const d = body('ces-pr-395-view.json'); mut(d);
      const r = readPrCandidate(deps(answer(d)), '.', { repo: REPO, prNumber: 395 });
      assert.equal(r.fault.kind, 'malformed');
      assert.ok(r.fault.detail.includes(path_), r.fault.detail);
    }
  });
});

describe('readBranchProtection: classic protection is `protection.enabled`, never `protected`', () => {
  it('CES and WCA: protected by a RULESET, classic off', () => {
    for (const f of ['ces-branch-main.json', 'wca-branch-main.json']) {
      assert.deepEqual(readBranchProtection(deps(answer(body(f))), '.', { repo: REPO, base: 'main' }).value, { protected: true, classicEnabled: false, contexts: [] }, f);
    }
  });
  it('AIO: unprotected', () => {
    assert.deepEqual(readBranchProtection(deps(answer(body('aio-branch-main.json'))), '.', { repo: REPO, base: 'main' }).value, { protected: false, classicEnabled: false, contexts: [] });
  });
  it('classic ON with contexts is reported (the oracle calls it unsupported), and contexts and checks are unioned', () => {
    const d = body('ces-branch-main.json'); d.protection.enabled = true; d.protection.required_status_checks = { enforcement_level: 'everyone', contexts: ['a'], checks: [{ context: 'a' }, { context: 'b' }] };
    assert.deepEqual(readBranchProtection(deps(answer(d)), '.', { repo: REPO, base: 'main' }).value, { protected: true, classicEnabled: true, contexts: ['a', 'b'] });
  });
  it('classic OFF yet listing required contexts is a contradiction: malformed', () => {
    const d = body('ces-branch-main.json'); d.protection.required_status_checks.contexts = ['x'];
    assert.equal(readBranchProtection(deps(answer(d)), '.', { repo: REPO, base: 'main' }).fault.kind, 'malformed');
  });
  it('a missing protection block or a non-boolean protected is malformed', () => {
    for (const mut of [(d) => { delete d.protection; }, (d) => { d.protected = 'true'; }, (d) => { delete d.protected; }, (d) => { delete d.protection.enabled; }]) {
      const d = body('ces-branch-main.json'); mut(d);
      assert.equal(readBranchProtection(deps(answer(d)), '.', { repo: REPO, base: 'main' }).fault.kind, 'malformed');
    }
  });
  it('the branch name is URL-encoded (a slash does not become a path)', () => {
    let seen = null;
    readBranchProtection({ gh: (a) => { seen = a; return answer(body('ces-branch-main.json')); } }, '.', { repo: REPO, base: 'release/1' });
    assert.deepEqual(seen, ['api', `repos/${REPO}/branches/release%2F1`]);
  });
});

describe('readBranchRules: ONE page of the rules that apply', () => {
  it('CES: full-suite pinned to app 15368; WCA: two pinned contexts among four rule types; AIO: none', () => {
    assert.deepEqual(readBranchRules(deps(answer(body('ces-rules-main.json'))), '.', { repo: REPO, base: 'main' }).value.pairs, [{ context: 'full-suite', integrationId: 15368 }]);
    const w = readBranchRules(deps(answer(body('wca-rules-main.json'))), '.', { repo: REPO, base: 'main' }).value;
    assert.deepEqual(w.pairs, [{ context: 'Required gate', integrationId: 15368 }, { context: 'AI-Models trailer', integrationId: 15368 }]);
    assert.deepEqual(w.types, ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);
    assert.deepEqual(readBranchRules(deps(answer(body('aio-rules-main.json'))), '.', { repo: REPO, base: 'main' }).value, { pairs: [], types: [] });
  });
  it('a requirement with no integration_id is reported as unpinned (integrationId null) for the oracle to refuse', () => {
    const d = body('ces-rules-main.json'); delete d[0].parameters.required_status_checks[0].integration_id;
    assert.equal(readBranchRules(deps(answer(d)), '.', { repo: REPO, base: 'main' }).value.pairs[0].integrationId, null);
  });
  it('asks for one page of 100 and never follows pagination', () => {
    let seen = null;
    readBranchRules({ gh: (a) => { seen = a; return answer([]); } }, '.', { repo: REPO, base: 'main' });
    assert.deepEqual(seen, ['api', `repos/${REPO}/rules/branches/main?per_page=${PAGE_SIZE}`]);
    assert.ok(!seen.includes('--paginate') && !seen.includes('--slurp'));
  });
  it('a FULL page (100 rules) is too-many-results, whatever it holds', () => {
    const full = Array.from({ length: PAGE_SIZE }, () => ({ type: 'deletion' }));
    assert.equal(readBranchRules(deps(answer(full)), '.', { repo: REPO, base: 'main' }).fault.kind, 'too-many-results');
  });
  it('malformed rules: a non-list answer, a rule without a type, a required_status_checks rule without a list or with a context-less entry', () => {
    for (const doc of [{ message: 'Not Found' }, [{ nope: 1 }], [{ type: 'required_status_checks', parameters: {} }], [{ type: 'required_status_checks' }],
      [{ type: 'required_status_checks', parameters: { required_status_checks: [{ integration_id: 1 }] } }],
      [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'x', integration_id: '15368' }] } }]]) {
      assert.equal(readBranchRules(deps(answer(doc)), '.', { repo: REPO, base: 'main' }).fault.kind, 'malformed', JSON.stringify(doc));
    }
  });
});

describe('readCheckRuns: ONE page, complete by construction', () => {
  it('CES #395 head: full-suite success and auto-merge skipped, both app 15368', () => {
    const r = readCheckRuns(deps(answer(body('ces-check-runs-395.json'))), '.', { repo: REPO, head: HEAD }).value;
    assert.deepEqual(r.map((x) => [x.name, x.status, x.conclusion, x.appId]).sort(), [['auto-merge', 'completed', 'skipped', 15368], ['full-suite', 'completed', 'success', 15368]]);
  });
  it('WCA: 31 runs on one page, the same name repeated across suites is kept (the oracle resolves it, the reader does not)', () => {
    const r = readCheckRuns(deps(answer(body('wca-check-runs-duplicate.json'))), '.', { repo: 'Lbstrydom/wine-cellar-app', head: WCA_HEAD }).value;
    assert.equal(r.length, 31);
    assert.deepEqual(r.filter((x) => x.name === 'Dependency audit').map((x) => x.conclusion).sort(), ['failure', 'success']);
  });
  it('a page that is not the whole set (length !== total_count) is too-many-results, never a partial observation', () => {
    const d = body('wca-check-runs-duplicate.json'); d.check_runs.pop();
    assert.equal(readCheckRuns(deps(answer(d)), '.', { repo: REPO, head: WCA_HEAD }).fault.kind, 'too-many-results');
    const e = body('wca-check-runs-duplicate.json'); e.total_count = 32;
    assert.equal(readCheckRuns(deps(answer(e)), '.', { repo: REPO, head: WCA_HEAD }).fault.kind, 'too-many-results');
  });
  it('one run duplicated while another is omitted, with total_count unchanged, is caught by the repeated id', () => {
    const d = body('wca-check-runs-duplicate.json'); d.check_runs[0] = structuredClone(d.check_runs[1]);
    assert.equal(readCheckRuns(deps(answer(d)), '.', { repo: REPO, head: WCA_HEAD }).fault.kind, 'malformed');
  });
  it('a run on another head, a missing field, or a non-numeric app id is malformed', () => {
    for (const mut of [(d) => { d.check_runs[0].head_sha = 'f'.repeat(40); }, (d) => { delete d.check_runs[0].name; }, (d) => { d.check_runs[0].app = { id: 'x' }; }, (d) => { delete d.total_count; }, (d) => { d.check_runs[0].conclusion = ''; }]) {
      const d = body('ces-check-runs-395.json'); mut(d);
      assert.equal(readCheckRuns(deps(answer(d)), '.', { repo: REPO, head: HEAD }).fault.kind, 'malformed');
    }
  });
  it('a run with no app is kept with appId null (it can match no pin)', () => {
    const d = body('ces-check-runs-395.json'); d.check_runs[0].app = null;
    assert.equal(readCheckRuns(deps(answer(d)), '.', { repo: REPO, head: HEAD }).value[0].appId, null);
  });
  it('asks for one page of 100 on the immutable head sha', () => {
    let seen = null;
    readCheckRuns({ gh: (a) => { seen = a; return answer(body('ces-check-runs-395.json')); } }, '.', { repo: REPO, head: HEAD });
    assert.deepEqual(seen, ['api', `repos/${REPO}/commits/${HEAD}/check-runs?per_page=${PAGE_SIZE}`]);
  });
});

describe('readCommitStatuses: ONE page', () => {
  it('CES #395 head: none', () => {
    assert.deepEqual(readCommitStatuses(deps(answer(body('ces-statuses-395.json'))), '.', { repo: REPO, head: HEAD }).value, []);
  });
  it('statuses decode; a missing context, a repeated id, a non-list and a FULL page are the named faults', () => {
    const st = (id, context = 'ci') => ({ id, context, state: 'success', description: 'ignored' });
    assert.deepEqual(readCommitStatuses(deps(answer([st(1), st(2, 'lint')])), '.', { repo: REPO, head: HEAD }).value.map((x) => x.context), ['ci', 'lint']);
    assert.equal(readCommitStatuses(deps(answer([{ id: 1, state: 'success' }])), '.', { repo: REPO, head: HEAD }).fault.kind, 'malformed');
    assert.equal(readCommitStatuses(deps(answer([st(1), st(1)])), '.', { repo: REPO, head: HEAD }).fault.kind, 'malformed');
    assert.equal(readCommitStatuses(deps(answer({ state: 'pending' })), '.', { repo: REPO, head: HEAD }).fault.kind, 'malformed');
    assert.equal(readCommitStatuses(deps(answer(Array.from({ length: PAGE_SIZE }, (_, i) => st(i + 1)))), '.', { repo: REPO, head: HEAD }).fault.kind, 'too-many-results');
  });
});
