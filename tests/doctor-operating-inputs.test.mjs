import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  classifyRunsOn, runsTests, splitCommands, parseWorkflowJobs, censusOf, medianRunMs, tierCapability, createRemote,
  operatingInputs, TIER_MARKER, STANDARD_HOSTED_LABELS, REMOTE_TOTAL_MS,
} from '../scripts/lib/doctor/operating-inputs.mjs';
import { TIER_PROTOCOL_MARKER } from '../scripts/lib/test-tier.mjs';
import { writeSuiteRunRecord, gitCommonDir } from '../scripts/lib/suite-run-record.mjs';

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const tmp = (p = 'op-inputs-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
const NOW = new Date('2026-10-14T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();
const HOUR = 3_600_000;

describe('classifyRunsOn: one label policy, no prefix guessing', () => {
  const cases = [
    ['ubuntu-latest', 'standard-hosted'],
    ['windows-2022', 'standard-hosted'],
    ['macos-14', 'standard-hosted'],
    ['Ubuntu-Latest', 'standard-hosted'],
    ['macos-14-large', 'larger-hosted'],
    ['macos-latest-xlarge', 'larger-hosted'],
    ['ubuntu-latest-8-cores', 'larger-hosted'],
    ['ubuntu-99.04', 'unresolved'],
    ['macos-14-medium', 'unresolved'],
    ['my-runner', 'unresolved'],
    ['${{ matrix.os }}', 'unresolved'],
    ["${{ fromJSON(needs.scope.outputs.runner || '\"ubuntu-latest\"') }}", 'unresolved'],
    ['self-hosted', 'self-hosted'],
    [['self-hosted', 'linux'], 'self-hosted'],
    [['self-hosted', '${{ matrix.os }}'], 'self-hosted'],
    [['ubuntu-latest', 'gpu'], 'unresolved'],
    [['ubuntu-latest'], 'standard-hosted'],
    [{ group: 'internal-linux' }, 'unresolved'],
    [{ group: 'g', labels: ['self-hosted'] }, 'self-hosted'],
    [{ group: 'g', labels: 'ubuntu-latest' }, 'unresolved'],
    [{ group: 'g', labels: ['macos-14-large'] }, 'unresolved'],
    [{ labels: ['macos-14-large'] }, 'larger-hosted'],
    [undefined, 'unresolved'],
    [null, 'unresolved'],
    [[], 'unresolved'],
    [42, 'unresolved'],
  ];
  for (const [input, want] of cases) {
    it(`${JSON.stringify(input)} -> ${want}`, () => assert.equal(classifyRunsOn(input), want));
  }
  it('the standard allowlist holds no larger-runner label', () => {
    for (const l of STANDARD_HOSTED_LABELS) assert.doesNotMatch(l, /large|cores?$/);
  });
});

describe('runsTests: discovery evidence', () => {
  const YES = [
    'npm test', 'npm run test', 'pnpm test -- --ci', 'yarn test', 'node --test tests/', 'npx vitest run', 'npx jest', 'npx playwright test',
    'cd app && npm test', 'CI=1 npm run test -- --ci', 'timeout 10m npx vitest run', 'npm ci\nnpm test', 'echo hi; jest --ci',
  ];
  for (const yes of YES) {
    it(`matches ${yes}`, () => assert.equal(runsTests(yes), true));
  }
  const NOT_TESTS = [
    'npm run build',
    'npm ci',
    'echo testing',
    'git status',
    'echo "npm test is run locally"',
    '# npm test',
    'printf "%s" "node --test"',
    'make check',
    'npm run lint',
    '',
    undefined,
    5,
  ];
  for (const no of NOT_TESTS) {
    it(`does not match ${JSON.stringify(no)}`, () => assert.equal(runsTests(no), false));
  }
});

describe('splitCommands: quote- and comment-aware', () => {
  it('splits on unquoted separators only', () => {
    assert.deepEqual(splitCommands('a && b || c; d | e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(splitCommands('echo "x; y && z" ; ls'), ['echo "x; y && z"', 'ls']);
    assert.deepEqual(splitCommands("echo 'a | b' && true"), ["echo 'a | b'", 'true']);
  });
  it('drops a comment to the end of its line, but only when # starts a word', () => {
    assert.deepEqual(splitCommands('# docs; npm test'), []);
    assert.deepEqual(splitCommands('ls # then; npm test\nnpm ci'), ['ls', 'npm ci']);
    assert.deepEqual(splitCommands('echo a#b'), ['echo a#b']);
    assert.deepEqual(splitCommands('echo "#not a comment"'), ['echo "#not a comment"']);
  });
  it('an escaped quote inside double quotes does not end the quote', () => {
    assert.deepEqual(splitCommands('echo "a \\" ; b" ; c'), ['echo "a \\" ; b"', 'c']);
  });
  it('REGRESSION (audit): quoted separators and commented test commands are not test jobs; genuine ones still are', () => {
    assert.equal(runsTests('echo "note; npm test"'), false);
    assert.equal(runsTests('# documentation; npm test'), false);
    assert.equal(runsTests("echo 'a && npm test'"), false);
    assert.equal(runsTests('echo hi # && npm test'), false);
    assert.equal(runsTests('echo "done"; npm test'), true);
    assert.equal(runsTests('# note\nnpm test'), true);
  });
});

describe('parseWorkflowJobs and censusOf', () => {
  const wf = (jobs) => `name: x\non: push\njobs:\n${jobs}`;
  it('classifies each job and finds the test steps', () => {
    const jobs = parseWorkflowJobs(wf([
      '  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci',
      '  unit:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: npm test',
      '  call:\n    uses: ./.github/workflows/other.yml',
      '  scoped:\n    runs-on: ${{ fromJSON(needs.scope.outputs.runner || \'"ubuntu-latest"\') }}\n    steps:\n      - run: npx vitest run',
      '  big:\n    runs-on: macos-14-large\n    steps:\n      - run: npm run test',
    ].join('\n')), 'ci.yml');
    assert.deepEqual(jobs.map((j) => [j.id, j.runner, j.runsTests]), [
      ['build', 'standard-hosted', false], ['unit', 'self-hosted', true], ['call', 'unresolved', false], ['scoped', 'unresolved', true], ['big', 'larger-hosted', true],
    ]);
  });
  it('a mapping-form runs-on with a group and no decisive label is unresolved', () => {
    const [j] = parseWorkflowJobs(wf('  a:\n    runs-on:\n      group: internal\n    steps:\n      - run: npm test'), 'a.yml');
    assert.equal(j.runner, 'unresolved');
    assert.equal(j.runsTests, true);
  });
  it('throws on unparseable YAML and on a file with no jobs mapping', () => {
    assert.throws(() => parseWorkflowJobs('jobs: [unclosed', 'bad.yml'));
    assert.throws(() => parseWorkflowJobs('name: only\non: push\n', 'nojobs.yml'), /no jobs mapping/);
  });
  it('censusOf carries coverage: a failed file or an unresolved test job makes it incomplete', () => {
    const a = parseWorkflowJobs(wf('  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test'), 'a.yml');
    const clean = censusOf([a], []);
    assert.equal(clean.complete, true);
    assert.equal(clean.testTotal, 1);
    assert.deepEqual(clean.testWorkflows.map((w) => [w.file, w.testJobs]), [['a.yml', 1]]);
    assert.equal(censusOf([a], [{ file: 'b.yml', why: 'bad' }]).complete, false);
    const u = parseWorkflowJobs(wf('  t:\n    runs-on: ${{ matrix.os }}\n    steps:\n      - run: npm test'), 'u.yml');
    assert.equal(censusOf([u], []).complete, false);
    assert.equal(censusOf([u], []).testJobs.unresolved, 1);
  });
  it('a reusable-workflow call is OPAQUE: its steps were never read, so the census is incomplete (not "no test job")', () => {
    const jobs = parseWorkflowJobs(wf('  c:\n    uses: ./.github/workflows/x.yml'), 'c.yml');
    assert.equal(jobs[0].opaque, true);
    const c = censusOf([jobs], []);
    assert.equal(c.opaqueJobs, 1);
    assert.equal(c.testTotal, 0);
    assert.equal(c.complete, false);
  });
  it('a job with an unresolved runner whose steps are read and run no test does NOT make the census incomplete', () => {
    const jobs = parseWorkflowJobs(wf('  d:\n    runs-on: ${{ matrix.os }}\n    steps:\n      - run: npm run build'), 'd.yml');
    assert.equal(jobs[0].opaque, false);
    assert.equal(censusOf([jobs], []).complete, true);
  });
  it('an echoed or commented test command is not a test job', () => {
    const jobs = parseWorkflowJobs(wf('  e:\n    runs-on: self-hosted\n    steps:\n      - run: echo "npm test runs locally"'), 'e.yml');
    assert.equal(jobs[0].runsTests, false);
    assert.equal(censusOf([jobs], []).testJobs.selfHosted, 0);
  });
});

describe('medianRunMs', () => {
  it('odd, even, stale and malformed runs', () => {
    const run = (startAgo, ms) => ({ startedAt: iso(startAgo), updatedAt: iso(startAgo - ms) });
    assert.deepEqual(medianRunMs([run(3 * HOUR, 60_000), run(4 * HOUR, 300_000), run(5 * HOUR, 120_000)], NOW), { ms: 120_000, runs: 3 });
    assert.deepEqual(medianRunMs([run(3 * HOUR, 60_000), run(4 * HOUR, 120_000)], NOW), { ms: 90_000, runs: 2 });
    assert.equal(medianRunMs([run(40 * 86_400_000, 60_000)], NOW), null);
    assert.equal(medianRunMs([{ startedAt: 'x', updatedAt: 'y' }, {}, null], NOW), null);
    assert.equal(medianRunMs([{ startedAt: iso(HOUR), updatedAt: iso(2 * HOUR) }], NOW), null);
  });
});

describe('tierCapability: both halves or neither', () => {
  const repo = (files) => { const d = tmp(); for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); } return d; };
  const list = JSON.stringify({ version: 1, heavy: [{ file: 'tests/a.test.mjs' }] });
  it('no .test-tiers.json is a MEASURED absence', () => {
    const r = tierCapability(repo({}));
    assert.equal(r.measured, true);
    assert.equal(r.value.state, 'absent');
  });
  it('a valid list AND a runner with the protocol marker is present', () => {
    const r = tierCapability(repo({ '.test-tiers.json': list, 'scripts/run-tests.mjs': `${TIER_MARKER} = 'x';` }));
    assert.equal(r.measured, true);
    assert.equal(r.value.state, 'present');
  });
  it('a list with no runner, or a runner without the marker, is unverifiable', () => {
    assert.equal(tierCapability(repo({ '.test-tiers.json': list })).measured, false);
    const r = tierCapability(repo({ '.test-tiers.json': list, 'scripts/run-tests.mjs': 'export const x = 1;' }));
    assert.equal(r.measured, false);
    assert.match(r.why, /lacks the tier protocol/);
  });
  it('a heavy list with a malformed entry is unverifiable', () => {
    for (const heavy of [[null], [{}], [{ file: '' }], [{ file: 7 }], [{ file: 'tests/a.test.mjs' }, 'x']]) {
      const r = tierCapability(repo({ '.test-tiers.json': JSON.stringify({ version: 1, heavy }), 'scripts/run-tests.mjs': TIER_MARKER }));
      assert.equal(r.measured, false, JSON.stringify(heavy));
    }
  });
  it('bad JSON, wrong version, empty heavy list are unverifiable', () => {
    assert.match(tierCapability(repo({ '.test-tiers.json': '{nope' })).why, /not JSON/);
    assert.equal(tierCapability(repo({ '.test-tiers.json': JSON.stringify({ version: 2, heavy: [{}] }) })).measured, false);
    assert.equal(tierCapability(repo({ '.test-tiers.json': JSON.stringify({ version: 1, heavy: [] }) })).measured, false);
  });
  it('DRIFT: the marker doctor looks for is the one test-tier.mjs defines (and run-tests.mjs really contains it)', () => {
    assert.equal(TIER_MARKER, TIER_PROTOCOL_MARKER);
    assert.ok(fs.readFileSync(new URL('../scripts/run-tests.mjs', import.meta.url), 'utf8').includes(TIER_MARKER));
  });
});

describe('createRemote: one budget, one short-circuit', () => {
  const clockOf = (t) => () => t.now;
  it('passes a per-call timeout clamped to the remaining budget (the last call cannot overrun)', () => {
    const t = { now: 0 }; const seen = [];
    const remote = createRemote((c, a, o) => { seen.push(o.timeout); t.now += 9_000; return '{}'; }, { perCallMs: 10_000, totalMs: 20_000, clock: clockOf(t) });
    remote(['a']); remote(['b']); remote(['c']);
    assert.deepEqual(seen, [10_000, 10_000, 2_000]);
  });
  it('every timeout handed to the subprocess is an INTEGER (node rejects a fractional one), including near expiry', () => {
    const t = { now: 0 }; const seen = [];
    const remote = createRemote((c, a, o) => { seen.push(o.timeout); t.now += 9_000.7; return '{}'; }, { perCallMs: 10_000, totalMs: 20_000, clock: clockOf(t) });
    remote(['a']); remote(['b']); remote(['c']);
    assert.equal(seen.length, 3);
    for (const x of seen) assert.ok(Number.isInteger(x) && x >= 1, String(x));
    assert.equal(seen[2], 1998);
  });
  it('REAL BOUNDARY: a fractional budget through the real execFileSync does not throw ERR_OUT_OF_RANGE', () => {
    const t = { now: 0.4 };
    const exec = (cmd, args, opts) => execFileSync(process.execPath, ['-e', '0'], { ...opts, encoding: 'utf8' });
    const remote = createRemote(exec, { perCallMs: 10_000, totalMs: 5_000, clock: () => { t.now += 0.37; return t.now; } });
    const r = remote(['anything']);
    assert.equal(r.ok, true, r.why);
  });
  it('once the budget is spent no further call is made, and the reason says so', () => {
    const t = { now: 0 }; let calls = 0;
    const remote = createRemote(() => { calls += 1; t.now += 25_000; return '{}'; }, { clock: clockOf(t) });
    assert.equal(remote(['a']).ok, true);
    const r = remote(['b']);
    assert.equal(r.ok, false);
    assert.match(r.why, /remote budget of 20 s spent/);
    assert.equal(remote(['c']).ok, false);
    assert.equal(calls, 1);
  });
  it('gh missing marks it unavailable after ONE call; later calls reuse the reason', () => {
    let calls = 0;
    const remote = createRemote(() => { calls += 1; throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); });
    assert.match(remote(['a']).why, /gh is not installed/);
    assert.match(remote(['b']).why, /gh is not installed/);
    assert.equal(calls, 1);
  });
  it('an auth or network failure also short-circuits; an ordinary per-call failure does not', () => {
    let calls = 0;
    const auth = createRemote(() => { calls += 1; throw Object.assign(new Error('x'), { stderr: 'To get started with GitHub CLI, please run: gh auth login' }); });
    auth(['a']); auth(['b']);
    assert.equal(calls, 1);
    calls = 0;
    const plain = createRemote(() => { calls += 1; throw Object.assign(new Error('x'), { stderr: 'workflow not found' }); });
    plain(['a']); plain(['b']);
    assert.equal(calls, 2);
  });
  it('a timeout is named and short-circuits', () => {
    let calls = 0;
    const remote = createRemote(() => { calls += 1; throw Object.assign(new Error('t'), { code: 'ETIMEDOUT' }); });
    assert.match(remote(['run', 'list']).why, /gh timed out/);
    remote(['x']);
    assert.equal(calls, 1);
  });
  it('the total budget constant is the documented 20 s', () => assert.equal(REMOTE_TOTAL_MS, 20_000));
});

describe('operatingInputs: lazy, memoised, every unknown reads unmeasured', () => {
  const ctxFor = (root, exec) => ({ subjectRoot: root, exec, fs });
  const ghDouble = (answers) => { const calls = []; return { calls, exec: (cmd, args) => { calls.push([cmd, ...args].join(' ')); const hit = answers(args); if (hit instanceof Error) throw hit; return hit; } }; };
  const writeWf = (root, name, body) => { const d = path.join(root, '.github', 'workflows'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name), body); };
  const TESTWF = 'name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';

  it('LAZINESS: reading only local inputs makes zero gh calls', () => {
    const root = tmp(); const gh = ghDouble(() => '{}');
    const inp = operatingInputs(ctxFor(root, gh.exec), { now: () => NOW, commonDir: null, machineDir: () => tmp() });
    void inp.tierCapability; void inp.cores; void inp.ciJobs; void inp.localSuiteWall; void inp.localHeavyWall; void inp.slotWait;
    assert.deepEqual(gh.calls, []);
  });
  it('each remote input is computed at most once however often it is read, across all four probes', () => {
    const root = tmp(); writeWf(root, 'ci.yml', TESTWF);
    const gh = ghDouble((args) => (args[0] === 'repo' ? '{"visibility":"PUBLIC"}' : JSON.stringify([{ startedAt: iso(2 * HOUR), updatedAt: iso(2 * HOUR - 120_000) }])));
    const inp = operatingInputs(ctxFor(root, gh.exec), { now: () => NOW, commonDir: null, machineDir: () => tmp() });
    for (let i = 0; i < 3; i += 1) { void inp.visibility; void inp.ciTestWalls; void inp.ciJobs; }
    assert.equal(gh.calls.filter((c) => c.includes('repo view')).length, 1);
    assert.equal(gh.calls.filter((c) => c.includes('run list')).length, 1);
    assert.equal(inp.visibility.value, 'PUBLIC');
    assert.equal(inp.ciTestWalls.value[0].ms, 120_000);
    assert.equal(inp.ciTestWalls.value[0].origin, 'ci-hosted');
    assert.equal(inp.ciTestWalls.value[0].workloadKind, 'ci-workflow');
  });
  it('the same ctx object returns the same memoised inputs', () => {
    const ctx = ctxFor(tmp(), () => '{}');
    assert.equal(operatingInputs(ctx, { commonDir: null }), operatingInputs(ctx));
  });
  it('gh missing: visibility and CI walls are unmeasured naming gh, after ONE call', () => {
    const root = tmp(); writeWf(root, 'ci.yml', TESTWF);
    const gh = ghDouble(() => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const inp = operatingInputs(ctxFor(root, gh.exec), { now: () => NOW, commonDir: null, machineDir: () => tmp() });
    assert.match(inp.visibility.why, /gh is not installed/);
    assert.equal(inp.ciTestWalls.measured, false);
    assert.match(inp.ciTestWalls.why, /gh is not installed/);
    assert.equal(gh.calls.length, 1);
  });
  it('a self-hosted test workflow is reported as ci-self-hosted-unattributed, never as a local measurement', () => {
    const root = tmp();
    writeWf(root, 'self.yml', 'name: s\non: push\njobs:\n  t:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: npm test\n');
    const gh = ghDouble(() => JSON.stringify([{ startedAt: iso(2 * HOUR), updatedAt: iso(2 * HOUR - 40 * 60_000) }]));
    const inp = operatingInputs(ctxFor(root, gh.exec), { now: () => NOW, commonDir: null, machineDir: () => tmp() });
    assert.equal(inp.ciTestWalls.value[0].origin, 'ci-self-hosted-unattributed');
    assert.equal(inp.localSuiteWall.measured, false);
    assert.equal(inp.localHeavyWall.measured, false);
  });
  it('workflow directory states: absent is coded, an unparseable file lands in failed with the others counted', () => {
    const none = operatingInputs(ctxFor(tmp(), () => '{}'), { commonDir: null, fresh: true }).ciJobs;
    assert.equal(none.measured, false);
    assert.equal(none.code, 'absent');
    const root = tmp(); writeWf(root, 'good.yml', TESTWF); writeWf(root, 'bad.yaml', 'jobs: [unclosed'); writeWf(root, 'notes.txt', 'ignored');
    const c = operatingInputs(ctxFor(root, () => '{}'), { commonDir: null }).ciJobs;
    assert.equal(c.measured, true);
    assert.equal(c.value.complete, false);
    assert.deepEqual(c.value.files.failed.map((f) => f.file), ['bad.yaml']);
    assert.equal(c.value.files.inspected, 1);
    assert.equal(c.value.testTotal, 1);
  });
  it('a workflow name that is not a plain basename is never passed to gh', () => {
    const root = tmp(); const gh = ghDouble(() => '[]');
    const d = path.join(root, '.github', 'workflows'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'a b;c.yml'), TESTWF);
    const w = operatingInputs(ctxFor(root, gh.exec), { commonDir: null }).ciTestWalls;
    assert.equal(w.measured, false);
    assert.match(w.why, /unsafe workflow name/);
    assert.deepEqual(gh.calls, []);
  });
  it('local suite wall comes ONLY from the suite-run record; heavy wall is the FULL record when there is one', () => {
    const root = tmp(); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    const cd = gitCommonDir(root);
    const rec = (kind, msAgo, wallMs) => ({ schema: 'suite-run/v1', kind, wallMs, files: 9, finishedAt: iso(msAgo), head: null, cores: 8, platform: 'linux' });
    writeSuiteRunRecord(cd, rec('full', 5 * HOUR, 900_000));
    writeSuiteRunRecord(cd, rec('branch', 1 * HOUR, 500_000));
    const inp = operatingInputs(ctxFor(root, () => '{}'), { now: () => NOW });
    assert.equal(inp.localSuiteWall.value.ms, 900_000);
    assert.equal(inp.localHeavyWall.value.ms, 900_000, 'the newer BRANCH record must not displace the older full one');
    assert.equal(inp.localHeavyWall.value.workloadKind, 'full-suite');
  });
  it('with only a branch record the heavy wall falls back to it and says so in its workload identity', () => {
    const root = tmp(); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeSuiteRunRecord(gitCommonDir(root), { schema: 'suite-run/v1', kind: 'branch', wallMs: 500_000, files: 9, finishedAt: iso(HOUR), head: null, cores: 8, platform: 'linux' });
    const inp = operatingInputs(ctxFor(root, () => '{}'), { now: () => NOW });
    assert.equal(inp.localSuiteWall.measured, false);
    assert.equal(inp.localHeavyWall.value.workloadKind, 'branch-tier');
  });
  it('no record where a writer exists: unmeasured WITH the remedy', () => {
    const root = tmp(); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    fs.mkdirSync(path.join(root, 'scripts')); fs.writeFileSync(path.join(root, 'scripts', 'run-tests.mjs'), '// writer');
    const inp = operatingInputs(ctxFor(root, () => '{}'), { now: () => NOW });
    assert.match(inp.localSuiteWall.why, /run the suite once with scripts\/run-tests\.mjs/);
    assert.equal(inp.localHeavyWall.measured, false);
  });
  it('no record in a repo with NO scripts/run-tests.mjs (every consumer): the remedy that cannot work is not offered', () => {
    const root = tmp(); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    const inp = operatingInputs(ctxFor(root, () => '{}'), { now: () => NOW });
    assert.match(inp.localSuiteWall.why, /this repo has no scripts\/run-tests\.mjs, the only writer of one/);
    assert.doesNotMatch(inp.localSuiteWall.why, /run the suite once/);
    assert.doesNotMatch(inp.localHeavyWall.why, /run the suite once/);
  });
  it('fleet-backed inputs come ONLY through ctx.fleetEvidence; without it they are unmeasured, never empty', () => {
    const bare = operatingInputs(ctxFor(tmp(), () => ''), { commonDir: null });
    assert.match(bare.peakSessions.why, /fleet evidence is not wired/);
    assert.match(bare.leaseSharing.why, /fleet evidence is not wired/);
    const seen = [];
    const ctx = { ...ctxFor(tmp(), () => ''), fleetEvidence: {
      peakSessions: (a) => { seen.push(['peak', a.now.toISOString()]); return { measured: true, value: { peak: 2 }, source: 'fake' }; },
      leaseSharing: (a) => { seen.push(['lease', typeof a.exec, a.commonDir]); return { measured: true, value: { otherRepos: ['x/y'] }, source: 'fake' }; },
    } };
    const inp = operatingInputs(ctx, { now: () => NOW, commonDir: '/cd' });
    assert.equal(inp.peakSessions.value.peak, 2);
    assert.deepEqual(inp.leaseSharing.value.otherRepos, ['x/y']);
    void inp.peakSessions; void inp.leaseSharing;
    assert.deepEqual(seen, [['peak', NOW.toISOString()], ['lease', 'function', '/cd']], 'each provider is asked exactly once');
  });
  it('LAYERING: operating-inputs.mjs imports nothing from fleet', () => {
    const src = fs.readFileSync(new URL('../scripts/lib/doctor/operating-inputs.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from\s+['"][^'"]*\/fleet\//);
  });
  it('slotWait is ALWAYS unmeasured', () => {
    const inp = operatingInputs(ctxFor(tmp(), () => ''), { commonDir: null });
    assert.equal(inp.slotWait.measured, false);
    assert.match(inp.slotWait.why, /no request or acquire events/);
  });
});

describe('doctor.mjs end to end: --only reaches the network, and never narrows --gate', () => {
  const DOCTOR = path.resolve(import.meta.dirname, '..', 'scripts', 'doctor.mjs');
  const root = tmp('op-cli-');
  const fixture = path.join(root, 'repo'); fs.mkdirSync(fixture);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixture });
  fs.writeFileSync(path.join(fixture, 'package-lock.json'), '{}');
  // A counting fake `gh`: a copy of the node binary named gh, whose preload logs and exits when it is the one running.
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const ghName = process.platform === 'win32' ? 'gh.exe' : 'gh';
  let fakeOk = true;
  try { fs.copyFileSync(process.execPath, path.join(bin, ghName)); fs.chmodSync(path.join(bin, ghName), 0o755); } catch { fakeOk = false; }
  const log = path.join(root, 'gh.log');
  const preload = path.join(root, 'ghlog.cjs');
  fs.writeFileSync(preload, `if (/^gh(\\.exe)?$/i.test(require('node:path').basename(process.execPath))) { require('node:fs').appendFileSync(${JSON.stringify(log)}, 'call\\n'); process.exit(1); }\n`);
  const env = (extra = {}) => {
    const e = { CI: '1', NO_COLOR: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}`, NODE_OPTIONS: `--require ${preload.replace(/\\/g, '/')}`, ...extra };
    for (const k of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k] != null) e[k] = process.env[k];
    return e;
  };
  const doctor = (...args) => {
    const r = spawnSync(process.execPath, [DOCTOR, '--consumer-root', fixture, '--json', ...args], { encoding: 'utf8', env: env(), timeout: 120_000 });
    // The whole of stdout is the JSON result: diagnostics belong on stderr, and a prefixed line must fail this parse.
    return { status: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);

  it('POSITIVE CONTROL: the fake gh counts a real remote probe', { skip: !fakeOk && 'cannot copy the node binary here' }, () => {
    fs.rmSync(log, { force: true });
    const { json } = doctor('--only', 'operating/ci-location');
    assert.ok(calls() >= 1, 'the counting gh must see the call, or the zero below proves nothing');
    assert.equal(json.results.length, 1);
    assert.equal(json.results[0].status, 'unknown');
    assert.match(json.results[0].detail, /unmeasured/);
  });
  it('--only operating/test-tier makes ZERO gh calls: probes nobody asked for do not run', { skip: !fakeOk && 'cannot copy the node binary here' }, () => {
    fs.rmSync(log, { force: true });
    const { json } = doctor('--only', 'operating/test-tier');
    assert.equal(calls(), 0);
    assert.equal(json.results[0].id, 'operating/test-tier');
    assert.equal(json.results[0].status, 'not_applicable');
  });
  it('--only never narrows the --gate set: the gating findings are the same with and without it', { skip: !fakeOk && 'cannot copy the node binary here' }, () => {
    const narrow = doctor('--gate', '--only', 'operating/test-tier');
    const full = doctor('--gate');
    const ids = (j) => j.gatingFindings.map((f) => f.id).sort();
    assert.deepEqual(ids(narrow.json), ids(full.json));
    assert.ok(ids(full.json).length > 0, 'precondition: the fixture must have gating findings for this comparison to mean anything');
    assert.equal(narrow.status, full.status);
  });
  it('stdout is strictly the JSON result (a prefixed diagnostic would break the machine contract)', () => {
    const r = spawnSync(process.execPath, [DOCTOR, '--consumer-root', fixture, '--json', '--only', 'operating/test-tier'], { encoding: 'utf8', env: env(), timeout: 120_000 });
    assert.doesNotThrow(() => JSON.parse(r.stdout));
    assert.ok(r.stdout.startsWith('{'));
    assert.throws(() => JSON.parse(`[config] loaded\n${r.stdout}`), 'control: a prefixed diagnostic must fail the strict parse');
  });
  it('no operating probe ever appears among the gating findings, whatever its status', () => {
    const { json } = doctor();
    assert.ok(json.results.some((r) => r.id.startsWith('operating/')));
    assert.ok(!json.gatingFindings.some((f) => f.id.startsWith('operating/')));
  });
});
