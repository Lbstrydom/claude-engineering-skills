/**
 * @fileoverview The merge-verdict reader (scripts/lib/ci-verdict.mjs, docs/plans/ci-full-suite-actions.md D6-D8, Q6).
 *
 * The invariant under test is one sentence: ONLY a completed success of the trusted workflow, on exactly this head, for
 * this PR, into the default branch, is a verdict; absence of any kind is `unverified`, never green. Every row of the
 * classifier's map is exercised, and the fixture is a run record in the shape the Actions REST API returns (the fields
 * `path`, `event`, `head_sha`, `head_branch`, `run_attempt`, `status`, `conclusion`, `pull_requests[].base`, `html_url`
 * are the API's own names).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyCiVerdict, ciVerdict, gatherCiEvidence, parseVerdictTarget } from '../scripts/lib/ci-verdict.mjs';
import { parseSummary, parseHeavyList, selectTier } from '../scripts/lib/test-tier.mjs';
import { getSyncClosure } from '../scripts/lib/sync-inventory.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'a'.repeat(40);
const DEFAULT_SHA = 'b'.repeat(40);
const OLD_BASE = 'c'.repeat(40);
const WF = '.github/workflows/full-suite.yml';
const BLOB = 'd'.repeat(40);

const run = (over = {}) => ({
  id: 4242, path: WF, event: 'pull_request', head_sha: HEAD, head_branch: 'feature', run_attempt: 1,
  status: 'completed', conclusion: 'success', created_at: '2026-10-14T10:00:00Z', html_url: 'https://github.com/o/r/actions/runs/4242',
  pull_requests: [{ number: 7, base: { ref: 'main', sha: DEFAULT_SHA } }],
  ...over,
});
// The workflow a pull_request run EXECUTED is the merge of the head with the base it was tested against, so the evidence also
// carries the workflow blob at each tested base (the default's own sha and an older base here).
const evidence = (over = {}) => ({
  head: HEAD, pr: 7, defaultBranch: 'main', defaultSha: DEFAULT_SHA, workflowPath: WF,
  workflowBlobHead: BLOB, workflowBlobDefault: BLOB, workflowBlobErrors: {},
  workflowBlobAtBase: { [DEFAULT_SHA]: { blob: BLOB, why: null }, [OLD_BASE]: { blob: BLOB, why: null } },
  runs: [run()], ...over,
});

describe('classifyCiVerdict — only a completed success on ACCEPTED evidence is a verdict', () => {
  it('a success for this head, this PR, into the default branch is `full`, and the summary parses unchanged', () => {
    const r = classifyCiVerdict(evidence());
    assert.equal(r.verdict, 'full');
    const p = parseSummary(r.summary, HEAD);
    assert.equal(p.ok, true, p.reason);
    assert.equal(p.tier, 'full');
    assert.equal(p.skipped, 0);
    assert.equal(p.reason, 'ci:4242');
    assert.equal(p.base, DEFAULT_SHA, 'the tested base is recorded');
    assert.equal(r.staleBase, null);
  });

  it('a tested base behind the current default still verifies, and the staleness is REPORTED (accepted risk, never hidden)', () => {
    const r = classifyCiVerdict(evidence({ runs: [run({ pull_requests: [{ number: 7, base: { ref: 'main', sha: OLD_BASE } }] })] }));
    assert.equal(r.verdict, 'full');
    assert.deepEqual(r.staleBase, { tested: OLD_BASE, current: DEFAULT_SHA });
  });

  for (const [what, over, verdict] of [
    ['queued', { status: 'queued', conclusion: null }, 'pending'],
    ['in_progress', { status: 'in_progress', conclusion: null }, 'pending'],
    ['waiting', { status: 'waiting', conclusion: null }, 'pending'],
    ['requested', { status: 'requested', conclusion: null }, 'pending'],
    ['failure', { conclusion: 'failure' }, 'failed'],
    ['timed_out', { conclusion: 'timed_out' }, 'failed'],
    ['startup_failure', { conclusion: 'startup_failure' }, 'failed'],
    ['cancelled', { conclusion: 'cancelled' }, 'unverified'],
    ['skipped', { conclusion: 'skipped' }, 'unverified'],
    ['neutral', { conclusion: 'neutral' }, 'unverified'],
    ['stale', { conclusion: 'stale' }, 'unverified'],
    ['action_required', { conclusion: 'action_required' }, 'unverified'],
    ['completed with a null conclusion', { conclusion: null }, 'unverified'],
    ['an unrecognised status', { status: 'teleporting', conclusion: null }, 'unverified'],
  ]) {
    it(`${what} -> ${verdict}, and prints no test-tier line`, () => {
      const r = classifyCiVerdict(evidence({ runs: [run(over)] }));
      assert.equal(r.verdict, verdict);
      assert.equal(r.summary, undefined, 'only a success may carry the full-verdict line');
    });
  }

  it('the LATEST accepted run decides: an old success does not outvote a newer failure, and a re-run that failed is `failed`', () => {
    const older = run({ id: 1, conclusion: 'success', created_at: '2026-10-14T09:00:00Z' });
    const newer = run({ id: 2, conclusion: 'failure', created_at: '2026-10-14T10:00:00Z' });
    assert.equal(classifyCiVerdict(evidence({ runs: [older, newer] })).verdict, 'failed');
    assert.equal(classifyCiVerdict(evidence({ runs: [newer, older] })).verdict, 'failed', 'order in the response must not matter');
    const rerunFailed = run({ id: 3, run_attempt: 2, conclusion: 'failure' });
    assert.equal(classifyCiVerdict(evidence({ runs: [rerunFailed] })).verdict, 'failed');
  });

  describe('evidence binding (R1 H1): a green run that is not THIS question\'s evidence is `unverified`', () => {
    const cases = [
      ['no runs at all', { runs: [] }],
      ['runs is not an array (malformed response)', { runs: null }],
      ['a run for a different head sha', { runs: [run({ head_sha: 'e'.repeat(40) })] }],
      ['a run of a different workflow path', { runs: [run({ path: '.github/workflows/other.yml' })] }],
      ['the same head, but a run from ANOTHER PR', { runs: [run({ pull_requests: [{ number: 99, base: { ref: 'main', sha: DEFAULT_SHA } }] })] }],
      ['a PR run into a NON-default base', { runs: [run({ pull_requests: [{ number: 7, base: { ref: 'release', sha: DEFAULT_SHA } }] })] }],
      ['a run with no PR association (e.g. a fork)', { runs: [run({ pull_requests: [] })] }],
      ['a push event when a PR was asked about', { runs: [run({ event: 'push', head_branch: 'main' })] }],
      ['a workflow_dispatch run', { runs: [run({ event: 'workflow_dispatch' })] }],
    ];
    for (const [what, over] of cases) {
      it(what, () => {
        const r = classifyCiVerdict(evidence(over));
        assert.equal(r.verdict, 'unverified', r.reason);
        assert.equal(r.summary, undefined);
        assert.ok(r.reason.length > 10, 'the reason is named');
      });
    }
    it('a path with an @ref suffix still matches its workflow', () => {
      assert.equal(classifyCiVerdict(evidence({ runs: [run({ path: `${WF}@refs/pull/7/merge` })] })).verdict, 'full');
    });
  });

  describe('the workflow a run EXECUTED is the trusted one (R1 H1/H4): matching CURRENT files are not enough', () => {
    const OTHER = '9'.repeat(40);
    it('a pull_request run tested against a base whose workflow differs executed a different merged workflow: unverified', () => {
      const r = classifyCiVerdict(evidence({ workflowBlobAtBase: { [DEFAULT_SHA]: { blob: OTHER, why: null } } }));
      assert.equal(r.verdict, 'unverified');
      assert.match(r.reason, /executed the merge of this head with base .* differs from the trusted one/);
      assert.equal(r.summary, undefined);
    });
    it('control: the SAME evidence with the base copy equal to the trusted one verifies', () => {
      assert.equal(classifyCiVerdict(evidence()).verdict, 'full');
    });
    it('the base copy could not be read (not merely absent): unverified, and the cause is kept', () => {
      const r = classifyCiVerdict(evidence({ workflowBlobAtBase: { [DEFAULT_SHA]: { blob: null, why: 'gh api exited 1: HTTP 403' } } }));
      assert.equal(r.verdict, 'unverified');
      assert.match(r.reason, /HTTP 403/);
    });
    it('no record of the base at all, or a run that does not name its base: unverified', () => {
      assert.equal(classifyCiVerdict(evidence({ workflowBlobAtBase: {} })).verdict, 'unverified');
      assert.equal(classifyCiVerdict(evidence({ runs: [run({ pull_requests: [{ number: 7, base: { ref: 'main' } }] })] })).verdict, 'unverified');
    });
    it('a push run executed the head own copy, already proven trusted: no base lookup needed', () => {
      const r = classifyCiVerdict(evidence({ pr: null, workflowBlobAtBase: {}, runs: [run({ event: 'push', head_branch: 'main', pull_requests: [] })] }));
      assert.equal(r.verdict, 'full');
    });
    it('a FAILED or PENDING run needs no provenance: it is not a pass either way', () => {
      assert.equal(classifyCiVerdict(evidence({ workflowBlobAtBase: {}, runs: [run({ conclusion: 'failure' })] })).verdict, 'failed');
      assert.equal(classifyCiVerdict(evidence({ workflowBlobAtBase: {}, runs: [run({ status: 'in_progress', conclusion: null })] })).verdict, 'pending');
    });
  });

  describe('--head mode (a landed or pinned sha, no PR)', () => {
    it('a push to the default branch counts', () => {
      assert.equal(classifyCiVerdict(evidence({ pr: null, runs: [run({ event: 'push', head_branch: 'main', pull_requests: [] })] })).verdict, 'full');
    });
    it('a push to ANOTHER branch does not', () => {
      assert.equal(classifyCiVerdict(evidence({ pr: null, runs: [run({ event: 'push', head_branch: 'feature', pull_requests: [] })] })).verdict, 'unverified');
    });
    it('a PR run into the default branch counts', () => {
      assert.equal(classifyCiVerdict(evidence({ pr: null })).verdict, 'full');
    });
  });

  describe('a PR cannot grade itself (D8) and the trusted copy must exist', () => {
    it('the workflow differs at the head', () => {
      const r = classifyCiVerdict(evidence({ workflowBlobHead: 'f'.repeat(40) }));
      assert.equal(r.verdict, 'unverified');
      assert.match(r.reason, /changes .*full-suite\.yml/);
    });
    it('the workflow is absent at the head', () => {
      assert.equal(classifyCiVerdict(evidence({ workflowBlobHead: null })).verdict, 'unverified');
    });
    it('the workflow does not exist on the default branch (this very plan PR): there is no trusted copy', () => {
      const r = classifyCiVerdict(evidence({ workflowBlobDefault: null, workflowBlobHead: BLOB }));
      assert.equal(r.verdict, 'unverified');
      assert.match(r.reason, /does not exist on main/);
    });
    it('a READ failure is not an absence (R1 M6): the cause survives into the reason', () => {
      const d = classifyCiVerdict(evidence({ workflowBlobDefault: null, workflowBlobErrors: { default: 'gh api exited 1: HTTP 403 rate limit' } }));
      assert.match(d.reason, /cannot read .* on main: .*HTTP 403 rate limit/);
      const h = classifyCiVerdict(evidence({ workflowBlobHead: null, workflowBlobErrors: { head: 'gh api exited 1: HTTP 502' } }));
      assert.match(h.reason, /cannot read .* at aaaaaaaa: .*HTTP 502/);
    });
    it('no ciVerdict is declared on the default branch', () => {
      assert.equal(classifyCiVerdict(evidence({ workflowPath: null })).verdict, 'unverified');
    });
  });

  it('a malformed head or default is unverified, not a throw', () => {
    assert.equal(classifyCiVerdict(evidence({ head: 'abc' })).verdict, 'unverified');
    assert.equal(classifyCiVerdict(evidence({ defaultSha: null })).verdict, 'unverified');
    assert.equal(classifyCiVerdict(undefined).verdict, 'unverified');
  });
});

describe('gatherCiEvidence / ciVerdict — every failed step is `unverified` with its reason, never a throw, never a pass', () => {
  const LIST = JSON.stringify({
    version: 1, maxAgeDays: 30, heavyThresholdMs: 60000, defaultTier: 'branch', ciVerdict: { workflow: WF },
    heavy: [{ file: 'tests/fleet-a.test.mjs', why: 'fleet family: spawns the CLI', measuredMs: 61000, measuredAt: '2026-10-13', reach: ['scripts/fleet.mjs'] }],
  });
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
  /** A scripted `gh`/`git`: matched by the leading args; anything unmatched is a loud failure so a missing case cannot read as success. */
  const fake = (overrides = {}) => (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pat, res] of Object.entries({
      'gh repo view': ok(JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } })),
      'git fetch': ok(''),
      'git rev-parse FETCH_HEAD': ok(`${DEFAULT_SHA}\n`),
      'git show': ok(LIST),
      'gh pr view': ok(JSON.stringify({ number: 7, headRefOid: HEAD, baseRefName: 'main', state: 'OPEN' })),
      'gh api repos/o/r/contents': ok(`${BLOB}\n`),
      'gh api repos/o/r/actions/runs': ok(JSON.stringify({ workflow_runs: [run()] })),
      ...overrides,
    })) if (key.startsWith(pat)) return res;
    return { status: 127, stdout: '', stderr: `unscripted: ${key}` };
  };

  it('the happy path reaches `full` through the real acquisition order', () => {
    const calls = [];
    const r = ciVerdict({ run: (c, a) => { calls.push(`${c} ${a.slice(0, 2).join(' ')}`); return fake()(c, a); }, pr: 7 });
    assert.equal(r.verdict, 'full', r.reason);
    assert.ok(calls.findIndex((c) => c.startsWith('git fetch')) < calls.findIndex((c) => c.startsWith('git show')), 'a fresh fetch happens BEFORE the trusted list is read');
  });

  for (const [what, over] of [
    ['gh is missing or fails (repo view)', { 'gh repo view': { status: null, error: new Error('spawn gh ENOENT') } }],
    ['gh is not authenticated', { 'gh repo view': { status: 4, stdout: '', stderr: 'gh auth login' } }],
    ['gh returns non-JSON', { 'gh repo view': ok('not json') }],
    ['git fetch of the default fails', { 'git fetch': { status: 128, stdout: '', stderr: 'could not resolve host' } }],
    ['FETCH_HEAD does not resolve', { 'git rev-parse FETCH_HEAD': ok('garbage') }],
    ['.test-tiers.json is unreadable on the default', { 'git show': { status: 128, stdout: '', stderr: 'path missing' } }],
    ['.test-tiers.json on the default is invalid', { 'git show': ok('{"version":2}') }],
    ['the PR cannot be read', { 'gh pr view': { status: 1, stdout: '', stderr: 'not found' } }],
    ['the PR targets another base', { 'gh pr view': ok(JSON.stringify({ number: 7, headRefOid: HEAD, baseRefName: 'release', state: 'OPEN' })) }],
    ['the Actions runs cannot be read', { 'gh api repos/o/r/actions/runs': { status: 1, stdout: '', stderr: 'HTTP 502' } }],
    ['the Actions response is malformed JSON', { 'gh api repos/o/r/actions/runs': ok('<html>') }],
    ['the Actions response has no workflow_runs array', { 'gh api repos/o/r/actions/runs': ok('{}') }],
    ['the workflow blob cannot be read', { 'gh api repos/o/r/contents': { status: 1, stdout: '', stderr: 'HTTP 404' } }],
    ['the workflow blob read fails for a non-404 reason', { 'gh api repos/o/r/contents': { status: 1, stdout: '', stderr: 'HTTP 403 rate limit exceeded' } }],
  ]) {
    it(`${what} -> unverified`, () => {
      const r = ciVerdict({ run: fake(over), pr: 7 });
      assert.equal(r.verdict, 'unverified', `${what}: ${JSON.stringify(r)}`);
      assert.equal(r.summary, undefined);
      assert.ok(r.reason && r.reason.length > 10);
    });
  }

  it('a runner that THROWS is unverified, not a crash', () => {
    const r = ciVerdict({ run: () => { throw new Error('boom'); }, pr: 7 });
    assert.equal(r.verdict, 'unverified');
  });

  it('a ciVerdict-less list on the default branch is unverified (the repo declares no CI verdict)', () => {
    const bare = JSON.stringify({ version: 1, maxAgeDays: 30, heavyThresholdMs: 60000, heavy: JSON.parse(LIST).heavy });
    const r = ciVerdict({ run: fake({ 'git show': ok(bare) }), pr: 7 });
    assert.equal(r.verdict, 'unverified');
    assert.match(r.reason, /no ciVerdict workflow is declared/);
  });

  it('a non-404 blob failure keeps its cause; a 404 reads as absence (R1 M6)', () => {
    const denied = ciVerdict({ run: fake({ 'gh api repos/o/r/contents': { status: 1, stdout: '', stderr: 'gh: HTTP 403 rate limit exceeded' } }), pr: 7 });
    assert.match(denied.reason, /cannot read .*full-suite\.yml.*403/);
    const absent = ciVerdict({ run: fake({ 'gh api repos/o/r/contents': { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } }), pr: 7 });
    assert.match(absent.reason, /does not exist on main/);
  });

  it('the tested bases workflow copies are fetched, so a pull_request run is judged on what it executed', () => {
    const asked = [];
    const r = ciVerdict({ run: (c, a) => { asked.push(`${c} ${a.join(' ')}`); return fake()(c, a); }, pr: 7 });
    assert.equal(r.verdict, 'full', r.reason);
    assert.ok(asked.some((q) => q.includes(`contents/${WF}?ref=${DEFAULT_SHA}`)), 'the tested base copy was read');
  });

  it('the tested base of the JUDGED run is read even when many newer runs of other workflows exist (R2 H1/M1: no fixed window)', () => {
    const noise = Array.from({ length: 12 }, (_, i) => run({ id: 100 + i, path: '.github/workflows/other.yml', created_at: `2026-10-14T1${i % 10}:30:00Z`, pull_requests: [{ number: 7, base: { ref: 'main', sha: `${i}`.repeat(40).slice(0, 40) } }] }));
    const target = run({ id: 4242, created_at: '2026-10-14T09:00:00Z' });
    const asked = [];
    const runner = (c, a) => {
      const key = `${c} ${a.join(' ')}`;
      asked.push(key);
      if (key.startsWith('gh api repos/o/r/actions/runs')) return { status: 0, stdout: JSON.stringify({ workflow_runs: [...noise, target] }), stderr: '' };
      return fake()(c, a);
    };
    const r = ciVerdict({ run: runner, pr: 7 });
    assert.equal(r.verdict, 'full', r.reason);
    assert.ok(asked.some((q) => q.includes(`contents/${WF}?ref=${DEFAULT_SHA}`)), 'the judged run base was read');
    assert.ok(!asked.some((q) => q.includes('contents/') && /ref=(\d)\1{39}/.test(q)), 'the noise runs bases were not');
  });

  it('--head mode resolves the sha locally and judges push evidence', () => {
    const r = gatherCiEvidence({ run: fake({ 'git rev-parse --verify': ok(`${HEAD}\n`) }), pr: null, head: 'HEAD' });
    assert.equal(r.ok, true);
    assert.equal(r.evidence.head, HEAD);
  });
});

describe('the argument grammar (R1 H2/M4): valid values pass, malformed ones are refused, through the pure parser AND the CLI', () => {
  const ok = [['7', null], ['241', null], ['1', null], ['999999999', null], [null, 'HEAD'], [null, 'abc1234'], [null, 'origin/main'], [null, 'feature/x-1.2'], [null, 'a'.repeat(40)]];
  for (const [pr, head] of ok) {
    it(`accepts --pr ${pr} --head ${head}`, () => {
      assert.deepEqual(parseVerdictTarget(pr, head), pr === null ? { pr: null, head } : { pr: Number(pr), head: null });
    });
  }
  const bad = [['0', null], ['00', null], ['007', null], ['1d', null], ['1dd', null], ['seven', null], ['-5', null], ['1e3', null], ['1000000000', null], ['', null], [null, ''], [null, '-x'], [null, '--upload-pack=x'], [null, 'a b'], [null, 'a;b'], [null, '$(x)'], ['7', 'HEAD'], [null, null]];
  for (const [pr, head] of bad) {
    it(`refuses --pr ${JSON.stringify(pr)} --head ${JSON.stringify(head)}`, () => {
      assert.throws(() => parseVerdictTarget(pr, head), /--pr|--head|exactly one/);
    });
  }
  it('a multi-digit PR number reaches the acquisition step (it is NOT a usage error): exit 3 when gh is unreachable, never 2', (t) => {
    const nodeDir = path.dirname(process.execPath);
    if (['gh', 'gh.exe', 'gh.cmd'].some((n) => fs.existsSync(path.join(nodeDir, n)))) return t.skip('node and gh share a directory on this machine');
    const r = spawnSync(process.execPath, ['scripts/test-tier.mjs', 'ci-verdict', '--pr', '241'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, PATH: nodeDir, Path: nodeDir } });
    assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  });
});

describe('the CLI — usage errors and absence, end to end', () => {
  const cli = (args, env = {}) => spawnSync(process.execPath, ['scripts/test-tier.mjs', 'ci-verdict', ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env } });

  it('needs exactly one of --pr / --head (exit 2)', () => {
    assert.equal(cli([]).status, 2);
    assert.equal(cli(['--pr', '7', '--head', 'HEAD']).status, 2);
  });
  it('rejects a non-numeric PR and a flag-shaped revision (exit 2)', () => {
    assert.equal(cli(['--pr', 'seven']).status, 2);
    assert.equal(cli(['--head', '--upload-pack=x']).status, 2);
  });
  it('with `gh` unreachable it is UNVERIFIED (exit 3) and prints no test-tier line — absence is never green', (t) => {
    // A PATH holding only node's own directory has no `gh`, so the first acquisition step fails.
    const nodeDir = path.dirname(process.execPath);
    const hasGh = ['gh', 'gh.exe', 'gh.cmd'].some((n) => fs.existsSync(path.join(nodeDir, n)));
    if (hasGh) return t.skip('node and gh share a directory on this machine: the instrument cannot hide gh here');
    const r = cli(['--pr', '7'], { PATH: nodeDir, Path: nodeDir });
    assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /^test-tier\/v1 /m);
    assert.match(r.stdout, /unverified/);
  });
});

describe('the CES default is committed data that no consumer can receive', () => {
  it('this repo\'s .test-tiers.json declares the branch default AND the workflow that supplies the verdict, and the workflow exists', () => {
    const list = parseHeavyList(fs.readFileSync(path.join(REPO, '.test-tiers.json'), 'utf8'));
    assert.equal(list.ok, true, list.reason);
    assert.equal(list.list.defaultTier, 'branch');
    assert.equal(list.list.ciVerdict.workflow, WF);
    assert.ok(fs.existsSync(path.join(REPO, WF)), 'the declared verdict workflow must exist in this tree');
  });

  it('the schema refuses a branch default without a ciVerdict workflow', () => {
    const base = JSON.parse(fs.readFileSync(path.join(REPO, '.test-tiers.json'), 'utf8'));
    delete base.ciVerdict;
    const r = parseHeavyList(JSON.stringify(base));
    assert.equal(r.ok, false);
    assert.match(r.reason, /requires ciVerdict/);
  });

  it('the consumer sync closure carries none of the tier machinery (positive control: it does carry fleet)', async () => {
    const files = [...((await getSyncClosure()).files)].map(String);
    assert.ok(files.some((f) => f.endsWith('fleet.mjs')), 'positive control: the closure must contain a synced CLI, or this test reads nothing');
    for (const needle of ['.test-tiers.json', 'test-tier.mjs', 'ci-verdict.mjs', 'prepush-tier.mjs', 'prepush-check.mjs', '.githooks']) {
      assert.deepEqual(files.filter((f) => f.includes(needle)), [], `${needle} must not reach a consumer: the CES-only default would follow it`);
    }
  });

  it('a tree WITHOUT the field behaves exactly as before: the code default stays full', () => {
    const base = JSON.parse(fs.readFileSync(path.join(REPO, '.test-tiers.json'), 'utf8'));
    delete base.defaultTier; delete base.ciVerdict;
    const list = parseHeavyList(JSON.stringify(base)).list;
    const tree = { files: new Set(base.heavy.map((h) => h.file)), read: () => '' };
    const e = selectTier({ tree, list, changed: ['docs/x.md'], head: HEAD, base: OLD_BASE, asOf: '2026-10-14T00:00:00Z', requested: null });
    assert.equal(e.tier, 'full');
    assert.equal(e.defaultSource, 'code');
  });
});
