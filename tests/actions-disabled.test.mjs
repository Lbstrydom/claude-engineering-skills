/**
 * @fileoverview A repository with GitHub Actions DISABLED is not a repository
 * whose run is "not yet" (Azure work-profile mirror report, 2026-11-02: hosted
 * runners off by policy, and `ci-verdict` read "no run exists" — the shape of a
 * pending PR — forever).
 *
 * The distinction changes the REASON, never the colour: it stays `unverified`,
 * and names the local remedy. A permissions read that FAILS is not evidence and
 * keeps today's generic reason. The `gh` and `fetch` answers are injected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCiVerdict, ciVerdict } from '../scripts/lib/ci-verdict.mjs';
import { actionsEnabledFrom, ACTIONS_DISABLED } from '../scripts/lib/actions-availability.mjs';
import { applyActionsDisabled, assessWatchList, fetchActionsEnabled } from '../scripts/workflow-cadence-doctor.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'a'.repeat(40);
const DEFAULT_SHA = 'b'.repeat(40);
const WF = '.github/workflows/full-suite.yml';
const BLOB = 'd'.repeat(40);
const LIST = JSON.stringify({ version: 1, maxAgeDays: 30, heavyThresholdMs: 60000, ciVerdict: { workflow: WF }, heavy: [{ file: 'tests/fleet-a.test.mjs', why: 'fleet family: spawns the CLI', measuredMs: 61000, measuredAt: '2026-10-13', reach: ['scripts/fleet.mjs'] }] });

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
/** Scripted gh/git; unmatched is a loud non-zero, so a missing case cannot read as success. */
const fake = (overrides = {}) => (cmd, args) => {
  const key = `${cmd} ${args.join(' ')}`;
  for (const [pat, res] of Object.entries({
    'gh repo view': ok(JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } })),
    'git fetch': ok(''),
    'git rev-parse FETCH_HEAD': ok(`${DEFAULT_SHA}\n`),
    'git show': ok(LIST),
    'gh pr view': ok(JSON.stringify({ number: 7, headRefOid: HEAD, baseRefName: 'main', state: 'OPEN' })),
    'gh api repos/o/r/contents': ok(`${BLOB}\n`),
    'gh api repos/o/r/actions/runs': ok(JSON.stringify({ workflow_runs: [] })),
    ...overrides,
  })) if (key.startsWith(pat)) return res;
  return { status: 127, stdout: '', stderr: `unscripted: ${key}` };
};
const PERMS = 'gh api repos/o/r/actions/permissions';
const assertLocalRemedy = (reason) => {
  assert.match(reason, /AUDIT_PREPUSH_TIER=full/);
  assert.match(reason, /AUDIT_LOOP_WEEKLY_MAINTENANCE=1/);
};

describe('actionsEnabledFrom — three answers, never two', () => {
  it('true / false / null', () => {
    assert.equal(actionsEnabledFrom({ enabled: true }), true);
    assert.equal(actionsEnabledFrom({ enabled: false, allowed_actions: 'all' }), false);
    for (const b of [null, {}, { enabled: 'false' }, 'x']) assert.equal(actionsEnabledFrom(b), null);
  });
});

describe('ci-verdict: actions-disabled is its own unverified reason', () => {
  it('Actions disabled + no run -> unverified, blocker actions-disabled, the local remedy named', () => {
    const r = ciVerdict({ run: fake({ [PERMS]: ok(JSON.stringify({ enabled: false })) }), pr: 7 });
    assert.equal(r.verdict, 'unverified');
    assert.equal(r.blocker, ACTIONS_DISABLED);
    assert.match(r.reason, /^actions-disabled: /);
    assertLocalRemedy(r.reason);
    assert.equal(r.summary, undefined, 'never green');
  });

  it('a permissions-API ERROR keeps the generic reason (unknown is not evidence)', () => {
    for (const perms of [{ status: 1, stdout: '', stderr: 'gh: HTTP 403 Must have admin rights' }, ok('<html>'), ok('{}')]) {
      const r = ciVerdict({ run: fake({ [PERMS]: perms }), pr: 7 });
      assert.equal(r.verdict, 'unverified');
      assert.equal(r.blocker, undefined);
      assert.match(r.reason, /^no .*full-suite\.yml run exists/);
    }
  });

  it('CONTROL: Actions enabled + no run is the generic reason too', () => {
    const r = ciVerdict({ run: fake({ [PERMS]: ok(JSON.stringify({ enabled: true })) }), pr: 7 });
    assert.match(r.reason, /^no .*run exists/);
    assert.equal(r.blocker, undefined);
  });

  it('Actions disabled outranks "conflicting" — nothing would run even after a merge of the base', () => {
    const r = classifyCiVerdict({
      head: HEAD, pr: 7, defaultBranch: 'main', defaultSha: DEFAULT_SHA, workflowPath: WF,
      workflowBlobHead: BLOB, workflowBlobDefault: BLOB, runs: [], mergeable: 'CONFLICTING', actionsEnabled: false,
    });
    assert.equal(r.blocker, ACTIONS_DISABLED);
  });

  it('a QUEUED run on a repo with Actions disabled is not "pending": it will never start', () => {
    const queued = { id: 9, path: WF, event: 'pull_request', head_sha: HEAD, status: 'queued', conclusion: null, pull_requests: [{ number: 7, base: { ref: 'main', sha: DEFAULT_SHA } }] };
    const ev = { head: HEAD, pr: 7, defaultBranch: 'main', defaultSha: DEFAULT_SHA, workflowPath: WF, workflowBlobHead: BLOB, workflowBlobDefault: BLOB, runs: [queued] };
    assert.equal(classifyCiVerdict({ ...ev, actionsEnabled: null }).verdict, 'pending');
    const off = classifyCiVerdict({ ...ev, actionsEnabled: false });
    assert.equal(off.verdict, 'unverified');
    assert.equal(off.blocker, ACTIONS_DISABLED);
  });

  it('Actions disabled never reads green — even over a completed success, whose run is kept as evidence', () => {
    const success = { id: 77, path: WF, event: 'pull_request', head_sha: HEAD, status: 'completed', conclusion: 'success', html_url: 'u', pull_requests: [{ number: 7, base: { ref: 'main', sha: DEFAULT_SHA } }] };
    const ev = { head: HEAD, pr: 7, defaultBranch: 'main', defaultSha: DEFAULT_SHA, workflowPath: WF, workflowBlobHead: BLOB, workflowBlobDefault: BLOB, workflowBlobAtBase: { [DEFAULT_SHA]: { blob: BLOB, why: null } }, runs: [success] };
    assert.equal(classifyCiVerdict({ ...ev, actionsEnabled: null }).verdict, 'full', 'control: unknown permissions keep the evidence-based verdict');
    const off = classifyCiVerdict({ ...ev, actionsEnabled: false });
    assert.equal(off.verdict, 'unverified');
    assert.equal(off.blocker, ACTIONS_DISABLED);
    assert.equal(off.summary, undefined);
    assert.equal(off.runId, 77);
  });

  it('a runs endpoint that refuses on a disabled repo still names the cause', () => {
    const r = ciVerdict({ run: fake({ [PERMS]: ok(JSON.stringify({ enabled: false })), 'gh api repos/o/r/actions/runs': { status: 1, stdout: '', stderr: 'HTTP 404' } }), pr: 7 });
    assert.equal(r.verdict, 'unverified');
    assert.equal(r.blocker, ACTIONS_DISABLED);
    assertLocalRemedy(r.reason);
  });

  it('the fixture list is a valid .test-tiers.json shape (the real one parses the same way)', () => {
    assert.ok(JSON.parse(fs.readFileSync(path.join(REPO, '.test-tiers.json'), 'utf8')).ciVerdict?.workflow);
  });
});

describe('cadence:doctor: never-ran / stale on a repo with Actions disabled carry the cause', () => {
  const NOW = new Date('2026-11-02T12:00:00Z');
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fetchFor = (perms) => async (url) => {
    if (url.includes('/actions/permissions')) return typeof perms === 'function' ? perms() : perms;
    return res(200, { workflow_runs: [] });
  };
  const watches = [{ workflow: 'weekly.yml', event: 'schedule', maxAgeDays: 10 }];

  it('disabled -> same never-ran status, cause actions-disabled, the weekly remedy named', async () => {
    const rep = await assessWatchList({ watches, repo: 'o/r', token: 't', now: NOW, fetchImpl: fetchFor(res(200, { enabled: false })) });
    assert.equal(rep.status, 'never-ran', 'still warns: the checks are still not running');
    assert.equal(rep.watches[0].verdict.cause, ACTIONS_DISABLED);
    assert.match(rep.watches[0].verdict.message, /AUDIT_LOOP_WEEKLY_MAINTENANCE=1/);
  });

  it('a permissions error (or a throw) keeps the generic never-ran message', async () => {
    for (const perms of [res(403, {}), () => { throw new Error('ENOTFOUND'); }]) {
      const rep = await assessWatchList({ watches, repo: 'o/r', token: 't', now: NOW, fetchImpl: fetchFor(perms) });
      assert.equal(rep.watches[0].verdict.cause, undefined);
      assert.match(rep.watches[0].verdict.message, /NO completed runs/);
    }
  });

  it('a healthy watch never asks (no extra call), and an ok verdict is never rewritten', async () => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      return res(200, { workflow_runs: [{ conclusion: 'success', updated_at: '2026-11-01T00:00:00Z' }] });
    };
    const rep = await assessWatchList({ watches, repo: 'o/r', token: 't', now: NOW, fetchImpl });
    assert.equal(rep.status, 'ok');
    assert.ok(!asked.some((u) => u.includes('/actions/permissions')));
    assert.equal(applyActionsDisabled({ status: 'ok', message: 'm' }, { actionsEnabled: false }).cause, undefined);
  });

  it('a 404 workflow keeps its own, more specific cause', () => {
    const v = applyActionsDisabled({ status: 'never-ran', message: 'not registered' }, { actionsEnabled: false, notFound: true });
    assert.equal(v.cause, undefined);
  });

  it('fetchActionsEnabled never throws', async () => {
    assert.equal(await fetchActionsEnabled({ repo: 'o/r', token: 't', fetchImpl: async () => { throw new Error('x'); } }), null);
    assert.equal(await fetchActionsEnabled({ repo: 'o/r', token: 't', fetchImpl: async () => res(200, { enabled: false }) }), false);
  });
});
