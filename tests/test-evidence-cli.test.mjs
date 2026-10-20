/**
 * @fileoverview The `scripts/test-evidence.mjs` CLI (Cluster C, P-C3b / P-C4 / P-C5): the stdout contract (exactly one
 * JSON value), the exit codes, the child's output going to STDERR, and a real `node --test` run with a real JUnit report.
 * The library's behaviour is pinned in tests/test-evidence.test.mjs; this file pins the shell around it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../scripts/test-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'test-evidence.mjs');
const NODE = process.execPath;

let SCRATCH; let GLOBAL_CFG;
before(() => {
  SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'te-cli-'));
  GLOBAL_CFG = path.join(SCRATCH, 'empty-gitconfig');
  fs.writeFileSync(GLOBAL_CFG, '');
});
after(() => { try { fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } });

function gitEnv() {
  const env = { ...process.env };
  // NODE_TEST_CONTEXT would make the CHILD `node --test` believe it runs inside this runner and skip its own files.
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') || k === 'NODE_TEST_CONTEXT') delete env[k];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL_CFG };
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let seq = 0;
function makeRepo() {
  const dir = path.join(SCRATCH, `repo-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  // describe() on purpose: node's JUnit reporter emits a top-level test as a bare <testcase>, which is uncountable.
  fs.writeFileSync(path.join(dir, 'small.test.mjs'), "import { describe, test } from 'node:test';\ndescribe('s', () => {\n  test('one', () => {});\n  test('two', () => {});\n});\n");
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.xml\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one dirty\n');
  return dir;
}

function cli(cwd, args, env = gitEnv()) {
  const r = spawnSync(NODE, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** stdout must be EXACTLY one JSON value: parse it whole, then check there is nothing else on it. */
function envelopeOf(r) {
  const v = JSON.parse(r.stdout);
  assert.equal(r.stdout.trim().split(/\r?\n/).length, 1, `stdout is not a single line: ${r.stdout}`);
  return v;
}

describe('parseArgs', () => {
  it('reads the verb, repeatable flags, --junit and the command after "--"', () => {
    const p = parseArgs(['record', '--ignore', 'docs/**', '--ignore=dist/**', '--toolchain', 'node --version', '--junit', 'r.xml', '--', 'npm', 'test', '--ignore', 'x']);
    assert.deepEqual(p, { verb: 'record', ignore: ['docs/**', 'dist/**'], toolchain: ['node --version'], junit: 'r.xml', command: ['npm', 'test', '--ignore', 'x'] });
  });
  it('flags AFTER "--" belong to the command and are never read as ours', () => {
    assert.deepEqual(parseArgs(['check', '--', 'pytest', '--junit', 'x']).command, ['pytest', '--junit', 'x']);
    assert.equal(parseArgs(['check', '--', 'pytest', '--junit', 'x']).junit, null);
  });
  for (const [label, args, re] of [
    ['no verb', ['--', 'x'], /record.*check/],
    ['an unknown verb', ['run', '--', 'x'], /record.*check/],
    ['no command', ['record'], /command is required/],
    ['an empty command', ['check', '--'], /command is required/],
    ['a flag with no value', ['record', '--ignore', '--', 'x'], /requires a value/],
    ['a stray positional', ['record', 'extra', '--', 'x'], /unexpected argument/],
    ['--junit on check', ['check', '--junit', 'r.xml', '--', 'x'], /belongs to "record"/],
  ]) it(`refuses ${label}`, () => assert.throws(() => parseArgs(args), re));
});

describe('stdout is one JSON envelope; the child talks to stderr', () => {
  it('record: child stdout AND stderr land on stderr, stdout is only the envelope', () => {
    const dir = makeRepo();
    const r = cli(dir, ['record', '--', NODE, '-e', "console.log('CHILD-OUT'); console.error('CHILD-ERR')"]);
    assert.equal(r.status, 0, r.stderr);
    const env = envelopeOf(r);
    assert.equal(env.ok, true);
    assert.equal(env.verb, 'record');
    assert.match(r.stderr, /CHILD-OUT/);
    assert.match(r.stderr, /CHILD-ERR/);
    assert.doesNotMatch(r.stdout, /CHILD-/);
    assert.match(r.stderr, /gitignored/, 'the known limit is stated on every run');
  });

  it('check: reusable => exit 0; edit => invalidated exit 1; never recorded => unknown exit 3', () => {
    const dir = makeRepo();
    const cmd = [NODE, '-e', 'process.exit(0)'];
    assert.equal(cli(dir, ['check', '--', ...cmd]).status, 3);
    assert.equal(envelopeOf(cli(dir, ['check', '--', ...cmd])).answer, 'unknown');
    assert.equal(cli(dir, ['record', '--', ...cmd]).status, 0);
    const ok = cli(dir, ['check', '--', ...cmd]);
    assert.equal(ok.status, 0);
    assert.equal(envelopeOf(ok).answer, 'reusable');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'edited again\n');
    const bad = cli(dir, ['check', '--', ...cmd]);
    assert.equal(bad.status, 1);
    const env = envelopeOf(bad);
    assert.equal(env.answer, 'invalidated');
    assert.deepEqual(env.changedPaths, ['a.txt']);
  });
});

describe('the record exit policy through the CLI (P-C3b)', () => {
  it('a failing child: record exits with the child code and says so', () => {
    const dir = makeRepo();
    const r = cli(dir, ['record', '--', NODE, '-e', 'process.exit(5)']);
    assert.equal(r.status, 5);
    assert.deepEqual(envelopeOf(r).outcome, { kind: 'exited', code: 5 });
    assert.equal(envelopeOf(r).ok, false);
  });
  it('a missing executable: exit 2, outcome spawn-error, the message names argv and cwd', () => {
    const dir = makeRepo();
    const r = cli(dir, ['record', '--', 'definitely-not-a-real-binary-xyz']);
    assert.equal(r.status, 2);
    const env = envelopeOf(r);
    assert.equal(env.outcome.kind, 'spawn-error');
    assert.match(env.message, /definitely-not-a-real-binary-xyz/);
    assert.match(env.message, /cwd:/);
  });
  it('outside a git work tree: exit 3, nothing run', () => {
    const plain = fs.mkdtempSync(path.join(SCRATCH, 'plain-'));
    const marker = path.join(plain, 'ran.txt');
    const r = cli(plain, ['record', '--', NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`]);
    assert.equal(r.status, 3);
    assert.equal(envelopeOf(r).ok, false);
    assert.equal(fs.existsSync(marker), false);
  });
  it('a usage error is exit 2 and STILL one JSON envelope on stdout', () => {
    const dir = makeRepo();
    for (const args of [['record'], ['bogus', '--', 'x'], ['record', '--nope', '--', 'x']]) {
      const r = cli(dir, args);
      assert.equal(r.status, 2, args.join(' '));
      assert.equal(envelopeOf(r).ok, false);
    }
    assert.match(envelopeOf(cli(dir, ['record', '--nope', '--', 'x'])).error, /unknown flag "--nope"/);
  });
});

describe('a real node --test run with a real JUnit report (P-C5)', () => {
  it('record -> reusable with counts from the report; touching the tested file -> invalidated', () => {
    const dir = makeRepo();
    const report = path.join(dir, 'report.xml');
    const cmd = [NODE, '--test', '--test-reporter=junit', `--test-reporter-destination=${report}`, 'small.test.mjs'];
    const rec = cli(dir, ['record', '--junit', 'report.xml', '--', ...cmd]);
    assert.equal(rec.status, 0, rec.stderr);
    assert.deepEqual(envelopeOf(rec).counts, { tests: 2, failures: 0, errors: 0, skipped: 0, passed: 2 }, rec.stdout + rec.stderr);

    const ok = cli(dir, ['check', '--', ...cmd]);
    assert.equal(ok.status, 0, ok.stderr);
    const env = envelopeOf(ok);
    assert.equal(env.answer, 'reusable');
    assert.deepEqual(env.recorded.counts, { tests: 2, failures: 0, errors: 0, skipped: 0, passed: 2 });
    assert.match(ok.stderr, /2 tests/);

    fs.appendFileSync(path.join(dir, 'small.test.mjs'), "// edited\n");
    const bad = cli(dir, ['check', '--', ...cmd]);
    assert.equal(bad.status, 1);
    assert.ok(envelopeOf(bad).changedPaths.includes('small.test.mjs'));
  });
});

describe('--selfcheck-relocation (P-C4)', () => {
  it('prints OK and exits 0 without needing a repo, flags or a command', () => {
    const plain = fs.mkdtempSync(path.join(SCRATCH, 'plain-'));
    const r = cli(plain, ['--selfcheck-relocation']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'OK');
  });
});
