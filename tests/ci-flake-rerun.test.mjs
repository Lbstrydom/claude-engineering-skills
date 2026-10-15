/**
 * @fileoverview One recorded re-run of an unrelated CI failure (fleet p-20261015045129-6c44): the pure classifier as a
 * table, the marker parser, the evidence gatherer through an injected runner, and the reservation through a REAL temp
 * lock directory, including restarts and two interleaved invocations.
 *
 * Plan: docs/plans/fleet-chips-and-merge-friction.md section 2.3.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FAILED_FILES_MARKER, TEST_STEP_NAME, classifyFlakeRerun, flakeExit, flakeKey, gatherFlakeEvidence, parseFailedFilesMarkers, rerunUnrelatedFlake, reservationFile,
} from '../scripts/lib/ci-flake-rerun.mjs';
import { failedFilesLine, finishRun } from '../scripts/run-tests.mjs';
import { GUARD_REPORT_VERSION } from '../scripts/lib/test-guard-reporter.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const NWO = 'owner/repo';
const WF = '.github/workflows/full-suite.yml';

/** A tiny tree: the flaky test imports a lib module; another lib module is unrelated. */
const tree = (() => {
  const src = {
    'tests/flaky.test.mjs': "import { x } from '../scripts/lib/x.mjs';\n",
    'scripts/lib/x.mjs': 'export const x = 1;\n',
    'scripts/lib/y.mjs': 'export const y = 2;\n',
  };
  return { files: new Set(Object.keys(src)), read: (p) => src[p] ?? null };
})();

const job = (over = {}) => ({ name: 'full-suite', conclusion: 'failure', steps: [{ name: 'npm ci', conclusion: 'success' }, { name: TEST_STEP_NAME, conclusion: 'failure' }], ...over });
const markers = (files = ['tests/flaky.test.mjs'], name = 'full-suite') => new Map([[name, [{ kind: 'files', files }]]]);
const evidence = (over = {}) => ({
  verdict: { verdict: 'failed' }, pr: 7,
  run: { id: 99, run_attempt: 1, conclusion: 'failure', head_sha: HEAD },
  prHead: HEAD, jobs: [job()], markers: markers(), changed: ['scripts/lib/y.mjs'], tree, workflowPath: WF, heavy: [], ...over,
});

describe('classifyFlakeRerun', () => {
  test('an unrelated failure with full coverage is eligible, naming its files', () => {
    assert.deepEqual(classifyFlakeRerun(evidence()), { eligible: true, failingFiles: ['tests/flaky.test.mjs'] });
  });

  for (const [why, over, re] of [
    ['a bare head (no PR)', { pr: null }, /for a PR/],
    ['a verdict that is not failed', { verdict: { verdict: 'pending' } }, /pending, not failed/],
    ['attempt 2 (already re-run once)', { run: { id: 99, run_attempt: 2, conclusion: 'failure', head_sha: HEAD } }, /already re-run once/],
    ['a run of another head', { prHead: 'c'.repeat(40) }, /not the PR's current head/],
    ['a cancelled job', { jobs: [job({ conclusion: 'cancelled' })] }, /not explained/],
    ['a second failed step besides the tests', { jobs: [job({ steps: [{ name: 'npm ci', conclusion: 'failure' }, { name: TEST_STEP_NAME, conclusion: 'failure' }] })] }, /also failed step "npm ci"/],
    ['a job that failed before the tests', { jobs: [job({ steps: [{ name: 'npm ci', conclusion: 'failure' }] })] }, /also failed step|without its/],
    ['two failed jobs with one marker', { jobs: [job(), job({ name: 'other' })] }, /"other" carries 0 failed-files marker/],
    ['a marker that says unknown', { markers: new Map([['full-suite', [{ kind: 'unknown' }]]]) }, /could not name/],
    ['two markers in one job', { markers: new Map([['full-suite', [{ kind: 'files', files: ['a'] }, { kind: 'files', files: ['b'] }]]]) }, /2 failed-files marker/],
    ['an unreadable job list', { jobs: null }, /jobs of attempt 1/],
    ['an unreadable log', { markers: null }, /failed log/],
    ['an incomplete changed set', { changed: null }, /changed-file set/],
    ['a changed shared input', { changed: ['package-lock.json'] }, /shared input/],
    ['a changed workflow', { changed: [WF] }, /shared input/],
    ['a changed selector dependency', { changed: ['scripts/run-tests.mjs'] }, /shared input/],
    ['the failing file itself changed', { changed: ['tests/flaky.test.mjs'] }, /the diff changes it/],
    ['a failing file the diff reaches', { changed: ['scripts/lib/x.mjs'] }, /reaches it/],
    ['a failing file absent from the tested tree', { markers: markers(['tests/gone.test.mjs']) }, /not in the tested tree/],
    ['an unreadable tree', { tree: null }, /tree at the tested head/],
    ['an unreadable heavy list (an empty one would hide a declared reach)', { heavy: null }, /heavy list/],
  ]) {
    test(`ineligible: ${why}`, () => {
      const r = classifyFlakeRerun(evidence(over));
      assert.equal(r.eligible, false);
      assert.match(r.reason, re);
    });
  }

  test('a declared heavy-list reach counts as reached', () => {
    const r = classifyFlakeRerun(evidence({ heavy: [{ file: 'tests/flaky.test.mjs', reach: ['scripts/lib/y.mjs'] }] }));
    assert.equal(r.eligible, false);
    assert.match(r.reason, /declared reach/);
  });

  test('a computed import() in the test layer counts as reached', () => {
    const t = { files: tree.files, read: (p) => (p === 'tests/flaky.test.mjs' ? 'await import(name);\n' : tree.read(p)) };
    assert.equal(classifyFlakeRerun(evidence({ tree: t })).eligible, false);
  });
});

describe('the failed-files marker, end to end', () => {
  test('run-tests writes what the classifier parses back, per job', () => {
    const root = path.resolve('/repo');
    const report = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [{ file: path.join(root, 'tests', 'b.test.mjs') }, { file: path.join(root, 'tests', 'a.test.mjs') }] });
    const line = failedFilesLine(report, root);
    assert.equal(line, `${FAILED_FILES_MARKER} ["tests/a.test.mjs","tests/b.test.mjs"]`);
    const parsed = parseFailedFilesMarkers(`full-suite\tnpm test\t2026-10-15T20:00:00.0000000Z ${line}\nother\tnpm ci\tnoise\n`);
    assert.deepEqual(parsed.get('full-suite'), [{ kind: 'files', files: ['tests/a.test.mjs', 'tests/b.test.mjs'] }]);
    assert.equal(parsed.has('other'), false);
  });

  for (const [why, report] of [
    ['no report', null],
    ['an unparseable report', '{'],
    ['a failure without a file', JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [{ file: null }] })],
    ['a failing run whose report lists nothing', JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [] })],
    ['a file outside the root', JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [{ file: path.resolve('/elsewhere/t.test.mjs') }] })],
  ]) {
    test(`unknown, never [], for ${why}`, () => assert.equal(failedFilesLine(report, path.resolve('/repo')), `${FAILED_FILES_MARKER} unknown`));
  }

  test('finishRun prints the line on a failing run only, and never moves the exit code', () => {
    const root = path.resolve('/repo');
    const report = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [{ file: path.join(root, 'tests', 'a.test.mjs') }] });
    const failing = finishRun({ status: 1, reportText: report, root });
    assert.equal(failing.exitCode, 1);
    assert.ok(failing.lines.includes(`${FAILED_FILES_MARKER} ["tests/a.test.mjs"]`));
    const green = finishRun({ status: 0, reportText: JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [] }), root });
    assert.equal(green.exitCode, 0);
    assert.ok(!green.lines.some((l) => l.startsWith(FAILED_FILES_MARKER)));
    const closed = finishRun({ status: 0, reportText: null, root });
    assert.ok(closed.lines.includes(`${FAILED_FILES_MARKER} unknown`), 'a fail-closed run names nothing it cannot prove');
  });

  test('a malformed payload is named, not dropped', () => {
    assert.equal(parseFailedFilesMarkers(`j\ts\t${FAILED_FILES_MARKER} [1,2]`).get('j')[0].kind, 'malformed');
  });
});

describe('gatherFlakeEvidence', () => {
  const judged = { id: 99, head_sha: HEAD, pull_requests: [{ number: 7, base: { sha: BASE } }] };
  const runner = (answers) => (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    for (const [k, v] of answers) if (key.startsWith(k)) return v;
    return { status: 1, stderr: `unexpected: ${key}` };
  };
  const ok = (stdout) => ({ status: 0, stdout });

  test('reads jobs, markers, the changed set at base...head and the tree at the TESTED head', () => {
    const seen = [];
    const ev = gatherFlakeEvidence({
      run: runner([
        ['gh api repos/owner/repo/actions/runs/99/attempts/1/jobs', ok(JSON.stringify({ total_count: 1, jobs: [job()] }))],
        ['gh run view 99', ok(`full-suite\tnpm test\tt ${FAILED_FILES_MARKER} ["tests/flaky.test.mjs"]\n`)],
        ['git fetch', ok('')],
        [`git diff --name-only --no-renames -z --no-ext-diff --no-textconv ${BASE}...${HEAD}`, ok('scripts/lib/y.mjs\0')],
      ]),
      nwo: NWO, judged, pr: 7, readTree: (h) => { seen.push(h); return { ok: true, tree }; }, readHeavy: () => ({ ok: true, heavy: [] }),
    });
    assert.deepEqual(ev.changed, ['scripts/lib/y.mjs']);
    assert.deepEqual(seen, [HEAD], 'the tree is read at the run\'s head, never the working tree');
    assert.equal(classifyFlakeRerun(evidence({ ...ev })).eligible, true);
  });

  test('a paginated (incomplete) job list and a failed fetch leave fields null with notes', () => {
    const ev = gatherFlakeEvidence({
      run: runner([
        ['gh api', ok(JSON.stringify({ total_count: 150, jobs: [job()] }))],
        ['gh run view', { status: 1, stderr: 'HTTP 404' }],
        ['git fetch', { status: 128, stderr: 'fatal: no such ref' }],
      ]),
      nwo: NWO, judged, pr: 7, readTree: () => assert.fail('no tree read after a failed fetch'), readHeavy: () => assert.fail('no list read either'),
    });
    assert.equal(ev.jobs, null);
    assert.equal(ev.markers, null);
    assert.equal(ev.changed, null);
    assert.ok(ev.notes.length >= 3);
  });
});

describe('rerunUnrelatedFlake: the reservation', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ci-flake-'));
  const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  const ELIGIBLE = { eligible: true, failingFiles: ['tests/flaky.test.mjs'] };

  /** A fake GitHub: a counter for the attempt, and every side effect logged. */
  function github({ attempt = 1, dispatch = 'ok', visible = true } = {}) {
    const g = { attempt, dispatches: 0, proposals: [], log: [] };
    g.readAttempt = () => ({ ok: true, attempt: g.attempt });
    g.dispatch = () => {
      g.dispatches += 1;
      if (dispatch === 'ok') { if (visible) g.attempt = 2; return { ok: true }; }
      if (dispatch === 'rejected') return { ok: false, rejected: true, why: 'HTTP 403' };
      if (dispatch === 'timeout-accepted') { g.attempt = 2; return { ok: false, rejected: false, why: 'ETIMEDOUT' }; }
      return { ok: false, rejected: false, why: 'ETIMEDOUT' };
    };
    g.findProposal = (key) => ({ ok: true, id: g.proposals.find((p) => p.evidence.includes(key))?.id ?? null });
    g.propose = (f) => { const id = `p-${g.proposals.length + 1}`; g.proposals.push({ id, ...f }); return { ok: true, id }; };
    return g;
  }
  const call = (dir, g, extra = {}) => rerunUnrelatedFlake({ stateDir: dir, nwo: NWO, runId: 99, classification: ELIGIBLE, ...g, ...extra });

  test('eligible: dispatches once, reads attempt 2 back, records one proposal keyed by the run', async () => {
    const d = tmp();
    try {
      const g = github();
      const r = await call(d, g);
      assert.equal(r.rerun, 'accepted');
      assert.match(r.proposal, /^recorded p-1$/);
      assert.equal(g.dispatches, 1);
      assert.match(g.proposals[0].evidence, new RegExp(flakeKey(NWO, 99)));
      const again = await call(d, g);
      assert.equal(g.dispatches, 1, 'a second call never sends again');
      assert.equal(again.proposal, 'already recorded p-1');
    } finally { rm(d); }
  });

  test('ineligible: no record, no dispatch', async () => {
    const d = tmp();
    try {
      const g = github();
      const r = await call(d, g, { classification: { eligible: false, reason: 'the diff reaches it' } });
      assert.equal(r.rerun, 'ineligible');
      assert.equal(g.dispatches, 0);
      assert.deepEqual(fs.readdirSync(d).filter((f) => f.endsWith('.json')), []);
    } finally { rm(d); }
  });

  test('a definitive refusal is rejected and never retried', async () => {
    const d = tmp();
    try {
      const g = github({ dispatch: 'rejected' });
      assert.equal((await call(d, g)).rerun, 'rejected');
      assert.equal((await call(d, g)).rerun, 'rejected');
      assert.equal(g.dispatches, 1);
    } finally { rm(d); }
  });

  test('a timeout is indeterminate; a later call that sees attempt 2 accepts it without a second dispatch', async () => {
    const d = tmp();
    try {
      const g = github({ dispatch: 'timeout' });
      assert.equal((await call(d, g)).rerun, 'indeterminate');
      assert.equal((await call(d, g)).rerun, 'indeterminate', 'still attempt 1: a negative read never authorises a second send');
      g.attempt = 2; // the request had been accepted after all
      const r = await call(d, g);
      assert.equal(r.rerun, 'accepted');
      assert.equal(g.dispatches, 1);
      assert.equal(g.proposals.length, 1);
    } finally { rm(d); }
  });

  test('a run already at attempt 2 that this tool never touched is left alone', async () => {
    const d = tmp();
    try {
      const g = github({ attempt: 2 });
      const r = await call(d, g, { classification: null });
      assert.equal(r.rerun, 'ineligible');
      assert.match(r.detail, /did not re-run it/);
      assert.equal(g.proposals.length, 0);
    } finally { rm(d); }
  });

  test('a proposal failure after accept is a partial outcome, and a later call files it exactly once', async () => {
    const d = tmp();
    try {
      const g = github();
      const failing = { ...g, propose: () => ({ ok: false, why: 'registry lock busy' }) };
      const r = await call(d, g, { propose: failing.propose });
      assert.equal(r.rerun, 'accepted');
      assert.match(r.proposal, /NOT recorded \(registry lock busy\)/);
      await call(d, g);
      await call(d, g);
      assert.equal(g.proposals.length, 1);
      assert.equal(g.dispatches, 1);
    } finally { rm(d); }
  });

  test('restart after "reserved" (a crash before dispatching) takes it forward, dispatching once', async () => {
    const d = tmp();
    try {
      const g = github();
      fs.writeFileSync(path.join(d, 'owner__repo__99.json'), JSON.stringify({ version: 'ci-flake/v1', nwo: NWO, runId: 99, key: flakeKey(NWO, 99), state: 'reserved' }));
      assert.equal((await call(d, g)).rerun, 'accepted');
      assert.equal(g.dispatches, 1);
    } finally { rm(d); }
  });

  test('restart after "dispatching" (a crash around the call) never dispatches again', async () => {
    const d = tmp();
    try {
      const g = github();
      fs.writeFileSync(path.join(d, 'owner__repo__99.json'), JSON.stringify({ version: 'ci-flake/v1', nwo: NWO, runId: 99, key: flakeKey(NWO, 99), state: 'dispatching' }));
      assert.equal((await call(d, g)).rerun, 'indeterminate');
      g.attempt = 2;
      assert.equal((await call(d, g)).rerun, 'accepted');
      assert.equal(g.dispatches, 0);
      assert.equal(g.proposals.length, 1);
    } finally { rm(d); }
  });

  test('restart after "accepted" without a proposal id files it once', async () => {
    const d = tmp();
    try {
      const g = github({ attempt: 2 });
      fs.writeFileSync(path.join(d, 'owner__repo__99.json'), JSON.stringify({ version: 'ci-flake/v1', nwo: NWO, runId: 99, key: flakeKey(NWO, 99), state: 'accepted' }));
      await call(d, g);
      await call(d, g);
      assert.equal(g.proposals.length, 1);
      assert.equal(g.dispatches, 0);
    } finally { rm(d); }
  });

  test('an unreadable record is indeterminate, never a fresh dispatch', async () => {
    const d = tmp();
    try {
      const g = github();
      fs.writeFileSync(path.join(d, 'owner__repo__99.json'), '{ not json');
      assert.equal((await call(d, g)).rerun, 'indeterminate');
      assert.equal(g.dispatches, 0);
    } finally { rm(d); }
  });

  test('two interleaved invocations: only one dispatches and one proposal is filed', async () => {
    const d = tmp();
    try {
      const g = github();
      // A dispatch that yields to the event loop while it holds the lock: the second invocation genuinely contends.
      let entered = 0;
      const slow = async () => { entered += 1; await new Promise((r) => setTimeout(r, 200)); return g.dispatch(); };
      const [a, b] = await Promise.all([call(d, g, { dispatch: slow }), call(d, g)]);
      assert.deepEqual([a.rerun, b.rerun].sort(), ['accepted', 'accepted']);
      assert.equal(entered, 1, 'the second invocation waited on the lock and saw the record, never reaching dispatch');
      assert.equal(g.dispatches, 1);
      assert.equal(g.proposals.length, 1);
    } finally { rm(d); }
  });
});

describe('audit round 1 regressions', () => {
  test('an unreadable heavy list is null with a note, never an empty list', () => {
    const judged = { id: 99, head_sha: HEAD, pull_requests: [{ number: 7, base: { sha: BASE } }] };
    const run = (cmd, args) => {
      const k = `${cmd} ${args.join(' ')}`;
      if (k.startsWith('gh api')) return { status: 0, stdout: JSON.stringify({ total_count: 1, jobs: [job()] }) };
      if (k.startsWith('gh run view')) return { status: 0, stdout: `full-suite\tnpm test\tt ${FAILED_FILES_MARKER} ["tests/flaky.test.mjs"]\n` };
      if (k.startsWith('git fetch')) return { status: 0, stdout: '' };
      if (k.startsWith('git diff')) return { status: 0, stdout: 'scripts/lib/y.mjs\0' };
      return { status: 1, stderr: k };
    };
    const ev = gatherFlakeEvidence({ run, nwo: NWO, judged, pr: 7, readTree: () => ({ ok: true, tree }), readHeavy: () => ({ ok: false, why: 'no readable .test-tiers.json' }) });
    assert.equal(ev.heavy, null);
    assert.ok(ev.notes.some((n) => /heavy list: no readable/.test(n)));
    assert.match(classifyFlakeRerun(evidence({ ...ev })).reason, /heavy list/);
    const thrown = gatherFlakeEvidence({ run, nwo: NWO, judged, pr: 7, readTree: () => ({ ok: true, tree }), readHeavy: () => { throw new Error('EIO'); } });
    assert.equal(thrown.heavy, null);
  });

  test('a file URL that cannot be decoded is unknown, not a crash', () => {
    const report = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [{ file: 'file:///tmp/%ZZ.test.mjs' }] });
    assert.equal(failedFilesLine(report, path.resolve('/repo')), `${FAILED_FILES_MARKER} unknown`);
  });

  test('flakeExit: a passing verdict stays green whatever the reservation reports; only a failed verdict maps the outcome', () => {
    const X = { full: 0, notYet: 3, failed: 4, error: 1 };
    assert.equal(flakeExit('full', { rerun: 'accepted' }, X), 0, 'the re-run passed: green, not "pending"');
    assert.equal(flakeExit('full', { rerun: 'indeterminate' }, X), 0, 'a reservation that could not be processed never costs a green verdict');
    assert.equal(flakeExit('pending', { rerun: 'accepted' }, X), 3);
    assert.equal(flakeExit('unverified', null, X), 3);
    assert.equal(flakeExit('failed', null, X), 4);
    assert.equal(flakeExit('failed', { rerun: 'accepted' }, X), 3);
    assert.equal(flakeExit('failed', { rerun: 'rejected' }, X), 4);
    assert.equal(flakeExit('failed', { rerun: 'ineligible' }, X), 4);
    assert.equal(flakeExit('failed', { rerun: 'indeterminate' }, X), 1);
    assert.equal(flakeExit('failed', { rerun: 'accepted' }, X, 2), 4, 'a failed RE-RUN is terminal: failed, never pending');
    assert.equal(flakeExit('failed', { rerun: 'indeterminate' }, X, 2), 4);
  });

  test('the real transition: "dispatching" is on disk BEFORE the GitHub call, and a crash during it never re-sends', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-flake-'));
    try {
      const file = reservationFile(d, NWO, 99);
      let attempt = 1;
      let sends = 0;
      const base = { stateDir: d, nwo: NWO, runId: 99, classification: { eligible: true, failingFiles: ['tests/flaky.test.mjs'] }, readAttempt: () => ({ ok: true, attempt }), findProposal: () => ({ ok: true, id: null }), propose: () => ({ ok: true, id: 'p-1' }) };
      const crashing = () => {
        sends += 1;
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'dispatching', 'persisted before the side effect');
        attempt = 2; // GitHub accepted it ...
        throw new Error('process died'); // ... and the process died before writing the outcome
      };
      await assert.rejects(rerunUnrelatedFlake({ ...base, dispatch: crashing }), /process died/);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'dispatching', 'the crash left the honest state');
      const r = await rerunUnrelatedFlake({ ...base, dispatch: () => { sends += 1; return { ok: true }; } });
      assert.equal(r.rerun, 'accepted');
      assert.equal(sends, 1, 'the restart reconciled by reading, never by sending again');
    } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});
