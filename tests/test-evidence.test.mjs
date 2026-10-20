/**
 * @fileoverview Cluster C of docs/plans/copilot-feedback-item4.md (P-C1 .. P-C3b): hash-bound test evidence.
 * `record` runs a command between two content-identity captures; `check` answers reusable / invalidated / unknown.
 *
 * Every repo here is a real temp git repo that starts DIRTY (an uncommitted edit and an untracked file), so HEAD is
 * never the tested baseline. Git is isolated from the machine's config (the operator's autocrlf must not decide a
 * test). The two JUnit fixtures: `junit-node.xml` is a real `node --test --test-reporter=junit` capture (hostname and
 * temp paths scrubbed); `junit-pytest.xml` is shaped by pytest 8's documented output (a wrapper-only `<testsuites>`
 * root over two suites) -- pytest was not installed where this was written, so it is NOT a capture.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  TEST_EVIDENCE_SCHEMA,
  recordKey,
  captureIdentity,
  parseJunitCounts,
  decideReuse,
  recordRun,
  checkRun,
  splitCommand,
} from '../scripts/lib/test-evidence.mjs';
import { gitWorktreeTree } from '../scripts/lib/vcs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'test-evidence');
const NODE = process.execPath;

let SCRATCH;
let GLOBAL_CFG;
before(() => {
  SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'te-lib-'));
  GLOBAL_CFG = path.join(SCRATCH, 'empty-gitconfig');
  fs.writeFileSync(GLOBAL_CFG, '');
});
after(() => { try { fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } });

/** Git sees only the repo under test: no ambient GIT_* (a pre-push hook sets them), no system or global config. */
function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL_CFG, ...extra };
}
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let seq = 0;
/** A committed repo, then dirtied: `a.txt` edited (tracked), `new.txt` untracked, gitignored `probe.txt` / `ignored.txt`. */
function makeRepo({ dirty = true } = {}) {
  const dir = path.join(SCRATCH, `repo-${seq++}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'src', 'x.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'docs', 'd.md'), '# d\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\nprobe.txt\nreport.xml\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(dir, 'probe.txt'), 'v1\n');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'i1\n');
  if (dirty) {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one dirty\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
  }
  return dir;
}

const OK_CHILD = [NODE, '-e', 'process.exit(0)'];
const opts = (dir, extra = {}) => ({ cwd: dir, env: gitEnv(), ...extra });
const deps = (extra = {}) => ({ childStdio: 'ignore', ...extra });

describe('recordKey: the invocation identity', () => {
  const base = { argv: ['npm', 'test'], cwdRel: '', ignore: [], toolchain: [], platform: 'win32', arch: 'x64' };
  it('is deterministic and order-insensitive for ignore globs and probes', () => {
    const a = recordKey({ ...base, ignore: ['b/**', 'a/**'], toolchain: ['y', 'x'] });
    const b = recordKey({ ...base, ignore: ['a/**', 'b/**'], toolchain: ['x', 'y'] });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
  it('differs by argv, repo-relative cwd, ignore set, probes, platform and arch (P-C1b)', () => {
    const k = recordKey(base);
    for (const change of [
      { argv: ['npm', 'run', 'test'] }, { cwdRel: 'sub' }, { ignore: ['docs/**'] },
      { toolchain: ['node --version'] }, { platform: 'linux' }, { arch: 'arm64' },
    ]) assert.notEqual(recordKey({ ...base, ...change }), k, JSON.stringify(change));
  });
  it('does not confuse argv boundaries (["a b"] vs ["a","b"])', () => {
    assert.notEqual(recordKey({ ...base, argv: ['a b'] }), recordKey({ ...base, argv: ['a', 'b'] }));
  });
});

describe('splitCommand: a probe is argv, never a shell line', () => {
  it('splits on whitespace and honours quotes', () => {
    assert.deepEqual(splitCommand('node --version'), ['node', '--version']);
    assert.deepEqual(splitCommand(`node -e "console.log('a b')"`), ['node', '-e', "console.log('a b')"]);
  });
  it('refuses an unterminated quote or an empty command', () => {
    assert.throws(() => splitCommand('node -e "oops'), /unterminated/i);
    assert.throws(() => splitCommand('   '), /empty/i);
  });
});

describe('gitWorktreeTree: the option is additive', () => {
  it('without options the result is exactly {ok, tree} (the AI-Audited-Tree callers rely on it)', () => {
    const dir = makeRepo();
    const r = gitWorktreeTree(dir, { env: gitEnv() });
    assert.deepEqual(Object.keys(r).sort(), ['ok', 'tree']);
  });
});

describe('captureIdentity: git-normalised content of the whole worktree', () => {
  it('sees an uncommitted edit AND an untracked file (HEAD is not the baseline)', () => {
    const dir = makeRepo();
    const a = captureIdentity(opts(dir));
    assert.equal(a.ok, true, a.reason);
    assert.notEqual(a.identity.fullTree, git(dir, 'rev-parse', 'HEAD^{tree}'));
    fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked, edited\n');
    const b = captureIdentity(opts(dir));
    assert.notEqual(b.identity.filteredTree, a.identity.filteredTree);
  });

  it('with no ignore globs the reuse identity IS the full tree: any change invalidates', () => {
    const a = captureIdentity(opts(makeRepo()));
    assert.equal(a.identity.filteredTree, a.identity.fullTree);
  });

  it('--ignore removes a path from the reuse identity but not from the full tree', () => {
    const dir = makeRepo();
    const a = captureIdentity(opts(dir, { ignore: ['docs/**'] }));
    fs.writeFileSync(path.join(dir, 'docs', 'd.md'), '# changed\n');
    const b = captureIdentity(opts(dir, { ignore: ['docs/**'] }));
    assert.equal(b.identity.filteredTree, a.identity.filteredTree);
    assert.notEqual(b.identity.fullTree, a.identity.fullTree);
  });

  it('a gitignored file is invisible: the documented limit (P-C2)', () => {
    const dir = makeRepo();
    const a = captureIdentity(opts(dir));
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'i2 changed\n');
    const b = captureIdentity(opts(dir));
    assert.deepEqual(b.identity, a.identity);
  });

  it('a toolchain probe binds what git cannot see, and its stdout is hashed, never stored', () => {
    const dir = makeRepo();
    const probe = `${JSON.stringify(NODE)} -e "process.stdout.write(require('fs').readFileSync('probe.txt','utf8'))"`;
    const a = captureIdentity(opts(dir, { toolchain: [probe] }));
    assert.equal(a.ok, true, a.reason);
    assert.match(a.identity.toolchain[probe], /^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(dir, 'probe.txt'), 'v2\n');
    const b = captureIdentity(opts(dir, { toolchain: [probe] }));
    assert.notEqual(b.identity.toolchain[probe], a.identity.toolchain[probe]);
    assert.equal(b.identity.filteredTree, a.identity.filteredTree, 'the tree did not move: only the probe did');
  });

  it('a probe that cannot run is "not computable", never an empty digest', () => {
    const a = captureIdentity(opts(makeRepo(), { toolchain: ['definitely-not-a-real-binary-xyz --version'] }));
    assert.equal(a.ok, false);
    assert.match(a.reason, /probe/i);
  });

  it('a probe that exits non-zero is "not computable"', () => {
    const a = captureIdentity(opts(makeRepo(), { toolchain: [`${JSON.stringify(NODE)} -e "process.exit(4)"`] }));
    assert.equal(a.ok, false);
    assert.match(a.reason, /probe/i);
  });

  it('outside a git work tree it is not computable', () => {
    const plain = fs.mkdtempSync(path.join(SCRATCH, 'plain-'));
    const a = captureIdentity(opts(plain));
    assert.equal(a.ok, false);
  });

  it('records the line-ending settings, and a changed core.autocrlf moves them', () => {
    const dir = makeRepo();
    const a = captureIdentity(opts(dir));
    git(dir, 'config', 'core.autocrlf', 'true');
    const b = captureIdentity(opts(dir));
    assert.notDeepEqual(b.identity.lineEndings, a.identity.lineEndings);
    assert.equal(b.identity.lineEndings.autocrlf, 'true');
  });

  it('a CRLF-only rewrite under text=auto is the same normalised content (the documented contract)', () => {
    const dir = makeRepo({ dirty: false });
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* text=auto\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'attrs');
    const a = captureIdentity(opts(dir));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\r\n');
    const b = captureIdentity(opts(dir));
    assert.equal(b.identity.filteredTree, a.identity.filteredTree);
  });

  it('a filter attribute reaching an UNTRACKED input is reported (a real-index check would miss it)', () => {
    const dir = makeRepo({ dirty: false });
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.dat filter=lfs\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'attrs matching no tracked file');
    fs.writeFileSync(path.join(dir, 'blob.dat'), 'payload\n');
    const a = captureIdentity(opts(dir));
    assert.equal(a.ok, true, a.reason);
    assert.deepEqual(a.filterPaths, ['blob.dat']);
  });

  it('no filter attribute anywhere => filterPaths is empty', () => {
    assert.deepEqual(captureIdentity(opts(makeRepo())).filterPaths, []);
  });

  it('vacuous guard: when every file is ignored the tested content is EMPTY and says so', () => {
    const dir = makeRepo();
    const a = captureIdentity(opts(dir, { ignore: ['**'] }));
    assert.equal(a.ok, true, a.reason);
    assert.equal(a.empty, true);
    assert.equal(captureIdentity(opts(dir)).empty, false);
  });

  it('reports the repo-relative cwd and the git common dir', () => {
    const dir = makeRepo();
    const a = captureIdentity(opts(path.join(dir, 'src')));
    assert.equal(a.cwdRel, 'src');
    assert.equal(captureIdentity(opts(dir)).cwdRel, '');
    assert.ok(fs.existsSync(a.commonDir));
  });
});

describe('parseJunitCounts: counts come from the report, validated, never invented (P-C3)', () => {
  const fx = (n) => fs.readFileSync(path.join(FIXTURES, n), 'utf8');

  it('real node --test output: no root counts, so the leaf suites are summed', () => {
    const r = parseJunitCounts(fx('junit-node.xml'));
    assert.deepEqual(r.counts, { tests: 5, failures: 1, errors: 0, skipped: 1, passed: 3 });
    assert.equal(r.diagnostic, null);
  });
  it('real node --test output for TOP-LEVEL tests (bare <testcase>, no suite) is uncountable, with the cause named', () => {
    const r = parseJunitCounts(fx('junit-node-flat.xml'));
    assert.equal(r.counts, null);
    assert.match(r.diagnostic, /2 <testcase> element\(s\) sit outside any <testsuite>/);
  });
  it('a report MIXING suites and bare testcases is never partly counted (summing only the suites would under-count)', () => {
    const xml = '<testsuites><testsuite name="s" tests="3" failures="0" errors="0" skipped="0"><testcase name="a"/></testsuite><testcase name="top-level"/></testsuites>';
    const r = parseJunitCounts(xml);
    assert.equal(r.counts, null);
    assert.match(r.diagnostic, /1 <testcase> element\(s\) sit outside/);
  });
  it('testcases INSIDE their suite (the normal shape) are not orphans', () => {
    const xml = '<testsuites><testsuite name="s" tests="1" failures="0" errors="0" skipped="0"><testcase name="a"><skipped/></testcase></testsuite></testsuites>';
    assert.equal(parseJunitCounts(xml).counts.tests, 1);
  });
  it('pytest-shaped wrapper-only root over two suites sums the suites', () => {
    assert.deepEqual(parseJunitCounts(fx('junit-pytest.xml')).counts, { tests: 6, failures: 1, errors: 0, skipped: 1, passed: 4 });
  });
  it('a valid root aggregate is used as is (and not added to the children)', () => {
    const xml = '<testsuites tests="7" failures="1" errors="0" skipped="2"><testsuite name="a" tests="3" failures="0" errors="0" skipped="0"/><testsuite name="b" tests="4" failures="1" errors="0" skipped="2"/></testsuites>';
    assert.deepEqual(parseJunitCounts(xml).counts, { tests: 7, failures: 1, errors: 0, skipped: 2, passed: 4 });
  });
  it('nested suites are counted at the leaves only, never double-counted', () => {
    const xml = '<testsuites><testsuite name="outer" tests="5" failures="1"><testsuite name="i1" tests="2" failures="0" errors="0" skipped="0"/><testsuite name="i2" tests="3" failures="1" errors="0" skipped="0"/></testsuite></testsuites>';
    assert.deepEqual(parseJunitCounts(xml).counts, { tests: 5, failures: 1, errors: 0, skipped: 0, passed: 4 });
  });
  it('a lone <testsuite> root (no wrapper) works', () => {
    assert.deepEqual(parseJunitCounts('<testsuite name="s" tests="2" failures="0" errors="0" skipped="0"/>').counts,
      { tests: 2, failures: 0, errors: 0, skipped: 0, passed: 2 });
  });
  it('markup inside CDATA and comments is not a suite', () => {
    const xml = '<testsuites><!-- <testsuite tests="99"/> --><testsuite name="s" tests="1" failures="0" errors="0" skipped="0"><system-out><![CDATA[<testsuite tests="50" failures="0"/>]]></system-out></testsuite></testsuites>';
    assert.equal(parseJunitCounts(xml).counts.tests, 1);
  });
  it('a ">" inside an attribute value does not end the tag', () => {
    const xml = '<testsuites><testsuite name="a>b" tests="2" failures="0" errors="0" skipped="0"/></testsuites>';
    assert.equal(parseJunitCounts(xml).counts.tests, 2);
  });
  for (const [label, xml] of [
    ['a negative attribute', '<testsuite tests="3" failures="-1" errors="0" skipped="0"/>'],
    ['a non-integer attribute', '<testsuite tests="3.5" failures="0" errors="0" skipped="0"/>'],
    ['a non-numeric attribute', '<testsuite tests="three" failures="0" errors="0" skipped="0"/>'],
    ['contradictory leaf counts (failures + errors + skipped > tests)', '<testsuite tests="2" failures="2" errors="1" skipped="0"/>'],
    ['contradictory ROOT counts', '<testsuites tests="2" failures="3" errors="0" skipped="0"><testsuite tests="2" failures="0" errors="0" skipped="0"/></testsuites>'],
    ['a leaf sum past the safe-integer range', `<testsuites><testsuite tests="${Number.MAX_SAFE_INTEGER}" failures="0" errors="0" skipped="0"/><testsuite tests="5" failures="0" errors="0" skipped="0"/></testsuites>`],
    ['an attribute past the safe-integer range', '<testsuite tests="9007199254740993" failures="0" errors="0" skipped="0"/>'],
    ['a leaf with no tests attribute', '<testsuites><testsuite name="s"/></testsuites>'],
    ['no suite at all', '<root/>'],
    ['not XML', 'this is not a report'],
    ['an empty string', ''],
    ['an unclosed nested suite', '<testsuites><testsuite name="a" tests="1" failures="0" errors="0" skipped="0">'],
  ]) {
    it(`${label} => counts null with a named diagnostic`, () => {
      const r = parseJunitCounts(xml);
      assert.equal(r.counts, null);
      assert.equal(typeof r.diagnostic, 'string');
      assert.ok(r.diagnostic.length > 5);
    });
  }
  it('the result never carries NaN or a negative passed', () => {
    const r = parseJunitCounts('<testsuite tests="1" failures="0" errors="0" skipped="1"/>');
    assert.deepEqual(r.counts, { tests: 1, failures: 0, errors: 0, skipped: 1, passed: 0 });
  });
});

describe('decideReuse: the three answers', () => {
  const identity = (o = {}) => ({
    fullTree: 'f'.repeat(40), filteredTree: 'a'.repeat(40), toolchain: { p: 'd1' }, lineEndings: { autocrlf: null, eol: null }, ...o,
  });
  const record = (o = {}) => ({
    schema: TEST_EVIDENCE_SCHEMA, outcome: { kind: 'exited', code: 0 }, stable: true, unstableReason: null,
    identity: identity(), wallMs: 1234, finishedAt: '2026-10-20T05:00:00.000Z', counts: { tests: 3, failures: 0, errors: 0, skipped: 0, passed: 3 }, ...o,
  });
  const current = (o = {}) => ({ ok: true, identity: identity(), filterPaths: [], empty: false, ...o });
  const helpers = { changedPaths: (a, b) => (a === b ? [] : ['src/x.mjs']) };

  it('everything equal => reusable, carrying the recorded cost and counts', () => {
    const d = decideReuse(record(), current(), helpers);
    assert.equal(d.answer, 'reusable');
    assert.equal(d.recorded.wallMs, 1234);
    assert.deepEqual(d.recorded.counts, record().counts);
  });
  it('a moved reuse tree => invalidated, listing the changed paths', () => {
    const d = decideReuse(record(), current({ identity: identity({ filteredTree: 'b'.repeat(40) }) }), helpers);
    assert.equal(d.answer, 'invalidated');
    assert.deepEqual(d.changedPaths, ['src/x.mjs']);
  });
  it('a pruned recorded tree degrades the LISTING, not the answer', () => {
    const d = decideReuse(record(), current({ identity: identity({ filteredTree: 'b'.repeat(40) }) }), { changedPaths: () => null });
    assert.equal(d.answer, 'invalidated');
    assert.equal(d.changedPaths, null);
    assert.match(d.reasons.join(' '), /paths unavailable/);
  });
  it('a moved probe => invalidated, naming the probe', () => {
    const d = decideReuse(record(), current({ identity: identity({ toolchain: { p: 'd2' } }) }), helpers);
    assert.equal(d.answer, 'invalidated');
    assert.deepEqual(d.moved, ['toolchain probe: p']);
  });
  it('moved line-ending settings => invalidated, naming the setting', () => {
    const d = decideReuse(record(), current({ identity: identity({ lineEndings: { autocrlf: 'true', eol: null } }) }), helpers);
    assert.equal(d.answer, 'invalidated');
    assert.match(d.moved.join(' '), /core\.autocrlf/);
  });
  it('a change only under the ignore globs => reusable, with the ignored change NAMED', () => {
    const d = decideReuse(record(), current({ identity: identity({ fullTree: 'c'.repeat(40) }) }), { changedPaths: (a, b) => (a === b ? [] : ['docs/d.md']) });
    assert.equal(d.answer, 'reusable');
    assert.deepEqual(d.ignoredChanges, ['docs/d.md']);
  });
  it('ignored-change listing unavailable (pruned) is stated, not omitted', () => {
    const d = decideReuse(record(), current({ identity: identity({ fullTree: 'c'.repeat(40) }) }), { changedPaths: () => null });
    assert.equal(d.answer, 'reusable');
    assert.equal(d.ignoredChanges, null);
    assert.match(d.reasons.join(' '), /ignored changes unavailable/);
  });

  describe('unknown always means rerun', () => {
    const cases = {
      'no record': [null, current()],
      'a current identity that could not be computed': [record(), { ok: false, reason: 'git failed' }],
      'a filter attribute configured now': [record(), current({ filterPaths: ['blob.dat'] })],
      'a recorded run that did not exit 0': [record({ outcome: { kind: 'exited', code: 1 } }), current()],
      'a recorded signal death': [record({ outcome: { kind: 'signal', signal: 'SIGTERM' } }), current()],
      'a recorded spawn error': [record({ outcome: { kind: 'spawn-error', code: 'ENOENT' } }), current()],
      'an unstable recorded run': [record({ stable: false, unstableReason: 'input-changed-during-run' }), current()],
      'an EMPTY tested content (vacuous)': [record(), current({ empty: true })],
      'a recorded run that executed ZERO tests (vacuous)': [record({ counts: { tests: 0, failures: 0, errors: 0, skipped: 0, passed: 0 } }), current()],
      'a recorded exit 0 whose report shows failures': [record({ counts: { tests: 3, failures: 1, errors: 0, skipped: 0, passed: 2 } }), current()],
      'a recorded exit 0 whose report shows errors': [record({ counts: { tests: 3, failures: 0, errors: 1, skipped: 0, passed: 2 } }), current()],
    };
    for (const [label, [rec, cur]] of Object.entries(cases)) {
      it(`${label} => unknown, with a reason`, () => {
        const d = decideReuse(rec, cur, helpers);
        assert.equal(d.answer, 'unknown');
        assert.ok(d.reasons.length > 0 && d.reasons.every((r) => typeof r === 'string' && r.length > 3));
      });
    }
    it('a failed recorded run is unknown even when the tree also moved (there is no green to invalidate)', () => {
      const d = decideReuse(record({ outcome: { kind: 'exited', code: 1 } }), current({ identity: identity({ filteredTree: 'b'.repeat(40) }) }), helpers);
      assert.equal(d.answer, 'unknown');
    });
    it('counts: null (no --junit) is NOT a failure: exit 0 + stable + equal is still reusable, "counts unmeasured"', () => {
      const d = decideReuse(record({ counts: null }), current(), helpers);
      assert.equal(d.answer, 'reusable');
      assert.equal(d.recorded.counts, null);
    });
  });
});

describe('record / check end to end on a dirty temp repo (P-C1)', () => {
  it('record -> reusable; edit a tracked file -> invalidated naming it; revert -> reusable again', async () => {
    const dir = makeRepo();
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    assert.equal(rec.exitCode, 0, JSON.stringify(rec.envelope));
    assert.equal(rec.envelope.stable, true);
    assert.deepEqual(rec.envelope.outcome, { kind: 'exited', code: 0 });

    const ok = await checkRun({ argv: OK_CHILD, ...opts(dir) });
    assert.equal(ok.envelope.answer, 'reusable');
    assert.equal(ok.exitCode, 0);

    fs.writeFileSync(path.join(dir, 'src', 'x.mjs'), 'export const x = 2;\n');
    const bad = await checkRun({ argv: OK_CHILD, ...opts(dir) });
    assert.equal(bad.envelope.answer, 'invalidated');
    assert.equal(bad.exitCode, 1);
    assert.ok(bad.envelope.changedPaths.includes('src/x.mjs'), JSON.stringify(bad.envelope));

    fs.writeFileSync(path.join(dir, 'src', 'x.mjs'), 'export const x = 1;\n');
    assert.equal((await checkRun({ argv: OK_CHILD, ...opts(dir) })).envelope.answer, 'reusable');
  });

  it('an untracked file appearing invalidates (it is part of what was tested)', async () => {
    const dir = makeRepo();
    await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    fs.writeFileSync(path.join(dir, 'late.txt'), 'x\n');
    const r = await checkRun({ argv: OK_CHILD, ...opts(dir) });
    assert.equal(r.envelope.answer, 'invalidated');
    assert.ok(r.envelope.changedPaths.includes('late.txt'));
  });

  it('a change under --ignore stays reusable and the ignored path is named', async () => {
    const dir = makeRepo();
    const o = opts(dir, { ignore: ['docs/**'] });
    await recordRun({ argv: OK_CHILD, ...o }, deps());
    fs.writeFileSync(path.join(dir, 'docs', 'd.md'), '# changed\n');
    const r = await checkRun({ argv: OK_CHILD, ...o });
    assert.equal(r.envelope.answer, 'reusable');
    assert.deepEqual(r.envelope.ignoredChanges, ['docs/d.md']);
  });

  it('--ignore is part of the key: checking without it finds no record => unknown', async () => {
    const dir = makeRepo();
    await recordRun({ argv: OK_CHILD, ...opts(dir, { ignore: ['docs/**'] }) }, deps());
    const r = await checkRun({ argv: OK_CHILD, ...opts(dir) });
    assert.equal(r.envelope.answer, 'unknown');
    assert.equal(r.exitCode, 3);
  });

  it('the known limit is pinned: a changed gitignored file stays reusable, and the output says so (P-C2)', async () => {
    const dir = makeRepo();
    await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'changed under .gitignore\n');
    const r = await checkRun({ argv: OK_CHILD, ...opts(dir) });
    assert.equal(r.envelope.answer, 'reusable');
    assert.match(r.envelope.limit, /gitignored/i);
    assert.match(r.envelope.limit, /--toolchain/);
  });

  it('a probe bound with --toolchain catches what git cannot see => invalidated naming the probe', async () => {
    const dir = makeRepo();
    const probe = `${JSON.stringify(NODE)} -e "process.stdout.write(require('fs').readFileSync('probe.txt','utf8'))"`;
    const o = opts(dir, { toolchain: [probe] });
    await recordRun({ argv: OK_CHILD, ...o }, deps());
    assert.equal((await checkRun({ argv: OK_CHILD, ...o })).envelope.answer, 'reusable');
    fs.writeFileSync(path.join(dir, 'probe.txt'), 'v2\n');
    const r = await checkRun({ argv: OK_CHILD, ...o });
    assert.equal(r.envelope.answer, 'invalidated');
    assert.match(r.envelope.moved.join(' '), /toolchain probe/);
  });

  it('a probe that stops working at check time => unknown, never reusable', async () => {
    const dir = makeRepo();
    const probe = `${JSON.stringify(NODE)} -e "require('fs').readFileSync('probe.txt','utf8')"`;
    const o = opts(dir, { toolchain: [probe] });
    await recordRun({ argv: OK_CHILD, ...o }, deps());
    fs.rmSync(path.join(dir, 'probe.txt'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const r = await checkRun({ argv: OK_CHILD, ...o });
    assert.equal(r.envelope.answer, 'unknown');
    assert.match(r.envelope.reasons.join(' '), /probe/i);
  });

  it('a clean/smudge filter reaching an untracked input => unknown even with a green, stable, equal record (P-C1d)', async () => {
    const dir = makeRepo({ dirty: false });
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.dat filter=lfs\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'attrs matching no tracked file');
    fs.writeFileSync(path.join(dir, 'blob.dat'), 'payload\n');
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    assert.equal(rec.exitCode, 0);
    const r = await checkRun({ argv: OK_CHILD, ...opts(dir) });
    assert.equal(r.envelope.answer, 'unknown');
    assert.match(r.envelope.reasons.join(' '), /clean\/smudge filter.*blob\.dat/);
  });

  it('no record, a malformed record, a wrong schema version => unknown', async () => {
    const dir = makeRepo();
    assert.equal((await checkRun({ argv: OK_CHILD, ...opts(dir) })).envelope.answer, 'unknown');
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    fs.writeFileSync(rec.envelope.recordPath, '{ not json');
    const mal = await checkRun({ argv: OK_CHILD, ...opts(dir) });
    assert.equal(mal.envelope.answer, 'unknown');
    assert.match(mal.envelope.reasons.join(' '), /unreadable|malformed/i);
    const good = JSON.parse(JSON.stringify({ x: 1 }));
    fs.writeFileSync(rec.envelope.recordPath, JSON.stringify({ ...good, schema: 'test-evidence/v0' }));
    assert.equal((await checkRun({ argv: OK_CHILD, ...opts(dir) })).envelope.answer, 'unknown');
  });

  it('a record with an extra key (strict schema) is not trusted', async () => {
    const dir = makeRepo();
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    const body = JSON.parse(fs.readFileSync(rec.envelope.recordPath, 'utf8'));
    fs.writeFileSync(rec.envelope.recordPath, JSON.stringify({ ...body, reusable: true }));
    assert.equal((await checkRun({ argv: OK_CHILD, ...opts(dir) })).envelope.answer, 'unknown');
  });

  it('a record whose stored key disagrees with its file name is not trusted', async () => {
    const dir = makeRepo();
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    const body = JSON.parse(fs.readFileSync(rec.envelope.recordPath, 'utf8'));
    fs.writeFileSync(rec.envelope.recordPath, JSON.stringify({ ...body, key: '0'.repeat(64) }));
    assert.equal((await checkRun({ argv: OK_CHILD, ...opts(dir) })).envelope.answer, 'unknown');
  });

  it('a failed run is recorded but never reusable: record exits with the child code, check says unknown', async () => {
    const dir = makeRepo();
    const argv = [NODE, '-e', 'process.exit(1)'];
    const rec = await recordRun({ argv, ...opts(dir) }, deps());
    assert.equal(rec.exitCode, 1);
    assert.deepEqual(rec.envelope.outcome, { kind: 'exited', code: 1 });
    const r = await checkRun({ argv, ...opts(dir) });
    assert.equal(r.envelope.answer, 'unknown');
    assert.equal(r.exitCode, 3);
  });

  it('the record lives under the git common dir, shared with linked worktrees (C4)', async () => {
    const dir = makeRepo();
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    assert.ok(rec.envelope.recordPath.startsWith(path.join(fs.realpathSync(dir), '.git')) || rec.envelope.recordPath.includes(`${path.sep}.git${path.sep}test-evidence${path.sep}`));
    // a linked worktree of the same repo, at the same content, finds the record
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'dirty state committed');
    // content identity is the TREE, so the committed tree equals the earlier dirty tree and a clean checkout can reuse it
    const wt = path.join(SCRATCH, `wt-${seq++}`);
    git(dir, 'worktree', 'add', '-q', wt, 'HEAD', '--detach');
    const r = await checkRun({ argv: OK_CHILD, ...opts(wt) });
    assert.equal(r.envelope.answer, 'reusable', JSON.stringify(r.envelope));
  });
});

describe('invocation identity (P-C1b)', () => {
  it('the same argv from a subdirectory is a different key => unknown, not invalidated', async () => {
    const dir = makeRepo();
    await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    const r = await checkRun({ argv: OK_CHILD, ...opts(path.join(dir, 'src')) });
    assert.equal(r.envelope.answer, 'unknown');
    assert.match(r.envelope.reasons.join(' '), /no record/i);
  });
  it('a record written for another platform/arch cannot be found under this key', async () => {
    const dir = makeRepo();
    await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps({ platform: 'linux', arch: 'arm64' }));
    const r = await checkRun({ argv: OK_CHILD, ...opts(dir) });
    assert.equal(r.envelope.answer, 'unknown');
  });
});

describe('stability: the tested bytes are the bytes recorded (P-C1c)', () => {
  const REWRITE = [NODE, '-e', "require('fs').writeFileSync('a.txt','rewritten by the suite\\n')"];

  it('a command that rewrites a tracked input => record written with stable:false; check => unknown', async () => {
    const dir = makeRepo();
    const rec = await recordRun({ argv: REWRITE, ...opts(dir) }, deps());
    assert.equal(rec.exitCode, 0, 'the child passed; the record still tells the truth about stability');
    assert.equal(rec.envelope.stable, false);
    assert.equal(rec.envelope.unstableReason, 'input-changed-during-run');
    assert.ok(rec.envelope.unstablePaths.includes('a.txt'));
    const r = await checkRun({ argv: REWRITE, ...opts(dir) });
    assert.equal(r.envelope.answer, 'unknown');
    assert.match(r.envelope.reasons.join(' '), /input-changed-during-run/);
  });

  it('a controlled edit BETWEEN the two captures (a file changed mid-run) is never reusable', async () => {
    const dir = makeRepo();
    const midRunEdit = async () => {
      fs.writeFileSync(path.join(dir, 'src', 'x.mjs'), 'export const x = "edited by another process";\n');
      return { outcome: { kind: 'exited', code: 0 } };
    };
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps({ runChild: midRunEdit }));
    assert.equal(rec.envelope.stable, false);
    const r = await checkRun({ argv: OK_CHILD, ...opts(dir) });
    assert.notEqual(r.envelope.answer, 'reusable');
    assert.equal(r.envelope.answer, 'unknown');
  });

  it('the same rewrite under a declared --ignore is stable and reusable', async () => {
    const dir = makeRepo();
    const argv = [NODE, '-e', "require('fs').writeFileSync('docs/d.md','# rewritten by the suite\\n')"];
    const o = opts(dir, { ignore: ['docs/**'] });
    const rec = await recordRun({ argv, ...o }, deps());
    assert.equal(rec.envelope.stable, true);
    assert.equal((await checkRun({ argv, ...o })).envelope.answer, 'reusable');
  });

  it('a probe that moves during the run makes the record unstable', async () => {
    const dir = makeRepo();
    const probe = `${JSON.stringify(NODE)} -e "process.stdout.write(require('fs').readFileSync('probe.txt','utf8'))"`;
    const argv = [NODE, '-e', "require('fs').writeFileSync('probe.txt','moved\\n')"];
    const rec = await recordRun({ argv, ...opts(dir, { toolchain: [probe] }) }, deps());
    assert.equal(rec.envelope.stable, false);
    assert.match(rec.envelope.unstableReason, /input-changed-during-run/);
  });
});

describe('vacuous passes are not reusable', () => {
  it('a command whose JUnit report shows ZERO tests => unknown', async () => {
    const dir = makeRepo();
    const report = path.join(dir, 'report.xml');
    const argv = [NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(report)}, '<testsuites><testsuite name="s" tests="0" failures="0" errors="0" skipped="0"/></testsuites>')`];
    const o = opts(dir, { junit: report });
    const rec = await recordRun({ argv, ...o }, deps());
    assert.equal(rec.exitCode, 0);
    assert.equal(rec.envelope.counts.tests, 0);
    const r = await checkRun({ argv, ...o });
    assert.equal(r.envelope.answer, 'unknown');
    assert.match(r.envelope.reasons.join(' '), /zero tests|0 tests/i);
  });

  it('an EMPTY tested content set (everything ignored) => unknown, even though nothing changed', async () => {
    const dir = makeRepo();
    const o = opts(dir, { ignore: ['**'] });
    const rec = await recordRun({ argv: OK_CHILD, ...o }, deps());
    assert.equal(rec.exitCode, 0);
    const r = await checkRun({ argv: OK_CHILD, ...o });
    assert.equal(r.envelope.answer, 'unknown');
    assert.match(r.envelope.reasons.join(' '), /empty/i);
  });

  it('a repo with no files at all => unknown', async () => {
    const dir = path.join(SCRATCH, `bare-${seq++}`);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    assert.equal(rec.exitCode, 0);
    assert.equal((await checkRun({ argv: OK_CHILD, ...opts(dir) })).envelope.answer, 'unknown');
  });
});

describe('counts are bound to THIS invocation (P-C3)', () => {
  const writeReport = (report, xml) => [NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(report)}, ${JSON.stringify(xml)})`];
  const XML = '<testsuites><testsuite name="s" tests="4" failures="0" errors="0" skipped="1"/></testsuites>';

  it('a report written by the run is counted', async () => {
    const dir = makeRepo();
    const report = path.join(dir, 'report.xml');
    const rec = await recordRun({ argv: writeReport(report, XML), ...opts(dir, { junit: report }) }, deps());
    assert.deepEqual(rec.envelope.counts, { tests: 4, failures: 0, errors: 0, skipped: 1, passed: 3 });
    assert.equal(rec.envelope.countsDiagnostic, null);
  });

  it('a pre-existing VALID report + a green command that writes none => counts null, "report not produced by this run"', async () => {
    const dir = makeRepo();
    const report = path.join(dir, 'report.xml');
    fs.writeFileSync(report, XML);
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir, { junit: report }) }, deps());
    assert.equal(rec.exitCode, 0);
    assert.equal(rec.envelope.counts, null);
    assert.equal(rec.envelope.countsDiagnostic, 'report not produced by this run');
    assert.equal(fs.readFileSync(report, 'utf8'), XML, 'the wrapper never moves or deletes the operator\'s file');
  });

  it('a pre-existing report REWRITTEN by the run with new content is accepted (fresh mtime AND changed digest)', async () => {
    const dir = makeRepo();
    const report = path.join(dir, 'report.xml');
    fs.writeFileSync(report, XML);
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(report, old, old);
    const rec = await recordRun({ argv: writeReport(report, XML.replace('tests="4"', 'tests="5"')), ...opts(dir, { junit: report }) }, deps());
    assert.equal(rec.envelope.counts.tests, 5);
  });

  it('an unchanged pre-existing report whose mtime was touched is still "not produced by this run"', async () => {
    const dir = makeRepo();
    const report = path.join(dir, 'report.xml');
    fs.writeFileSync(report, XML);
    const touch = [NODE, '-e', `const t=new Date();require('fs').utimesSync(${JSON.stringify(report)},t,t)`];
    const rec = await recordRun({ argv: touch, ...opts(dir, { junit: report }) }, deps());
    assert.equal(rec.envelope.counts, null);
    assert.equal(rec.envelope.countsDiagnostic, 'report not produced by this run');
  });

  it('no --junit => counts null and the summary says "counts unmeasured", never 0', async () => {
    const dir = makeRepo();
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    assert.equal(rec.envelope.counts, null);
    assert.match(rec.envelope.summary, /counts unmeasured/);
    assert.doesNotMatch(rec.envelope.summary, /\b0 tests\b/);
    const c = await checkRun({ argv: OK_CHILD, ...opts(dir) });
    assert.match(c.envelope.summary, /counts unmeasured/);
  });

  it('a corrupt report is counts null with the parser\'s diagnostic; the command outcome is still recorded', async () => {
    const dir = makeRepo();
    const report = path.join(dir, 'report.xml');
    const rec = await recordRun({ argv: writeReport(report, '<not a report'), ...opts(dir, { junit: report }) }, deps());
    assert.equal(rec.exitCode, 0);
    assert.equal(rec.envelope.counts, null);
    assert.ok(rec.envelope.countsDiagnostic.length > 5);
    assert.deepEqual(rec.envelope.outcome, { kind: 'exited', code: 0 });
  });
});

describe('the record exit policy (P-C3b)', () => {
  it('a missing executable => exit 2, outcome spawn-error, message names the argv and the cwd', async () => {
    const dir = makeRepo();
    const rec = await recordRun({ argv: ['definitely-not-a-real-binary-xyz', '--flag'], ...opts(dir) }, deps());
    assert.equal(rec.exitCode, 2);
    assert.equal(rec.envelope.outcome.kind, 'spawn-error');
    assert.match(rec.envelope.message, /definitely-not-a-real-binary-xyz/);
    assert.ok(rec.envelope.message.includes(fs.realpathSync(dir)) || rec.envelope.message.includes(dir));
    assert.equal((await checkRun({ argv: ['definitely-not-a-real-binary-xyz', '--flag'], ...opts(dir) })).envelope.answer, 'unknown');
  });

  it('identity not computable before the run => exit 3, NOTHING run, nothing written', async () => {
    const plain = fs.mkdtempSync(path.join(SCRATCH, 'plain-'));
    const marker = path.join(plain, 'ran.txt');
    const argv = [NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`];
    const rec = await recordRun({ argv, ...opts(plain) }, deps());
    assert.equal(rec.exitCode, 3);
    assert.equal(rec.envelope.ok, false);
    assert.equal(fs.existsSync(marker), false, 'the command must not run when its identity cannot be bound');
  });

  it('a probe that cannot run before the run => exit 3, nothing run', async () => {
    const dir = makeRepo();
    const marker = path.join(dir, 'ran.txt');
    const argv = [NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`];
    const rec = await recordRun({ argv, ...opts(dir, { toolchain: ['definitely-not-a-real-binary-xyz'] }) }, deps());
    assert.equal(rec.exitCode, 3);
    assert.equal(fs.existsSync(marker), false);
  });

  it('green child but the record cannot be written => exit 3 ("ran green, recorded nothing"), never 0', async () => {
    const dir = makeRepo();
    const probeKeyRun = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    const recDir = path.dirname(probeKeyRun.envelope.recordPath);
    fs.rmSync(recDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.writeFileSync(recDir, 'a FILE where the directory must go');
    const rec = await recordRun({ argv: OK_CHILD, ...opts(dir) }, deps());
    assert.equal(rec.exitCode, 3);
    assert.equal(rec.envelope.ok, false);
    assert.match(rec.envelope.message, /recorded nothing/);
  });

  it('a failing child whose record cannot be written still exits with the CHILD code', async () => {
    const dir = makeRepo();
    const argv = [NODE, '-e', 'process.exit(7)'];
    const first = await recordRun({ argv, ...opts(dir) }, deps());
    const recDir = path.dirname(first.envelope.recordPath);
    fs.rmSync(recDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.writeFileSync(recDir, 'a FILE where the directory must go');
    const rec = await recordRun({ argv, ...opts(dir) }, deps());
    assert.equal(rec.exitCode, 7);
  });

  it('a child killed by a signal => exit 1, outcome signal (POSIX only)', { skip: process.platform === 'win32' ? 'POSIX signals: Windows has no signal death to observe' : false }, async () => {
    const dir = makeRepo();
    const rec = await recordRun({ argv: [NODE, '-e', "process.kill(process.pid, 'SIGKILL')"], ...opts(dir) }, deps());
    assert.equal(rec.exitCode, 1);
    assert.equal(rec.envelope.outcome.kind, 'signal');
  });

  it('an empty command is a usage error, not a run', async () => {
    await assert.rejects(() => recordRun({ argv: [], ...opts(makeRepo()) }, deps()), /command/i);
    await assert.rejects(() => checkRun({ argv: [], ...opts(makeRepo()) }), /command/i);
  });
});
