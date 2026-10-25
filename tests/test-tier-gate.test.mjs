/**
 * @fileoverview The tiered gate END TO END (docs/plans/gate-cost-slice-2.md section 9, Tier 2): the REAL
 * `scripts/prepush-check.mjs` (and the real selector, runner and oracle: a byte copy of this repo's `scripts/`) in a
 * throwaway repository with a stub `check:static` and a three-file fixture suite, so each case is seconds. What the
 * fixture tests do is the observable: each one appends its name to a marker file, so "was the heavy file skipped" is
 * read from what RAN, not from what the selector claimed.
 *
 * The shipped hook's success label is tested separately, on the shipped bytes (tests/pre-push-tier-label.test.mjs).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hermeticGitEnv } from './helpers/git-bash.mjs';
import { parseSummary } from '../scripts/lib/test-tier.mjs';
import { writeFileIn as write } from './helpers/write-file.mjs';

const REAL = path.resolve(import.meta.dirname, '..');
const IS_WIN = process.platform === 'win32';
const roots = [];

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, env: hermeticGitEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (repo, msg) => { git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', msg]); return git(repo, ['rev-parse', 'HEAD']); };

const marker = (name) => `import { test } from 'node:test';\nimport fs from 'node:fs';\nimport path from 'node:path';\n__IMPORT__test('${name}', () => { fs.appendFileSync(path.join(process.env.TIER_MARKER_DIR, 'ran.txt'), '${name}\\n'); });\n`;
const STATIC_OK = 'node -e "console.log(\'static gates ok\')"';
const heavyList = (measuredAt) => `${JSON.stringify({
  version: 1, maxAgeDays: 30, heavyThresholdMs: 1000,
  heavy: [
    { file: 'tests/fleet-a.test.mjs', why: 'a heavy family member', measuredMs: 5, measuredAt, reach: ['lib/a-declared/**'] },
    { file: 'tests/fleet-b.test.mjs', why: 'a heavy family member', measuredMs: 5, measuredAt, reach: ['lib/b-declared/**'] },
  ],
})}\n`;

let fx;

before(() => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tier-gate-')));
  roots.push(root);
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(root, ['init', '-q', '--bare', origin]);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@example.com']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['remote', 'add', 'origin', origin]);
  // The REAL machinery, byte for byte: scripts/ (prepush-check, the runner, the oracle and its libraries).
  fs.cpSync(path.join(REAL, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  // Dependencies come from the real checkout (the sandbox links node_modules when the dependency set is unchanged).
  const realPkg = JSON.parse(fs.readFileSync(path.join(REAL, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({
    name: 'tier-fixture', version: '1.0.0', type: 'module', dependencies: realPkg.dependencies, devDependencies: realPkg.devDependencies, optionalDependencies: realPkg.optionalDependencies, overrides: realPkg.overrides,
    scripts: { check: 'npm run check:static && npm test', 'check:static': STATIC_OK, test: 'node scripts/run-tests.mjs' },
  })}\n`);
  fs.copyFileSync(path.join(REAL, 'package-lock.json'), path.join(repo, 'package-lock.json'));
  fs.symlinkSync(path.join(REAL, 'node_modules'), path.join(repo, 'node_modules'), IS_WIN ? 'junction' : 'dir');
  write(repo, '.gitignore', 'node_modules\n.audit-loop/domain-deps-observed.json\n');
  write(repo, '.audit-loop/domain-deps-observed.json', '{}\n');
  write(repo, 'lib/a.mjs', 'export const a = 1;\n');
  write(repo, 'lib/b.mjs', 'export const b = 1;\n');
  write(repo, 'tests/fleet-a.test.mjs', marker('fleet-a').replace('__IMPORT__', "import { a } from '../lib/a.mjs';\nvoid a;\n"));
  write(repo, 'tests/fleet-b.test.mjs', marker('fleet-b').replace('__IMPORT__', "import { b } from '../lib/b.mjs';\nvoid b;\n"));
  write(repo, 'tests/light.test.mjs', marker('light').replace('__IMPORT__', ''));
  write(repo, 'tests/claudemd/c.test.mjs', marker('claudemd').replace('__IMPORT__', ''));
  write(repo, 'tests/install/i.test.mjs', marker('install').replace('__IMPORT__', ''));
  write(repo, 'docs/readme.md', '# x\n');
  write(repo, '.test-tiers.json', heavyList(new Date().toISOString().slice(0, 10)));
  commit(repo, 'base');
  git(repo, ['push', '-q', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  fx = { root, repo, origin };
});

after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/** A file as it is on main, whatever branch a previous case left checked out (each case starts from the same baseline). */
const onMain = (rel) => git(fx.repo, ['show', `main:${rel}`]);

/** A case branch off main with the given edits; returns its head. */
let n = 0;
function branch(edits, { message = 'case' } = {}) {
  n += 1;
  git(fx.repo, ['switch', '-q', '-C', `case-${n}`, 'main']);
  for (const [rel, body] of Object.entries(edits)) { if (body === null) fs.rmSync(path.join(fx.repo, rel), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); else write(fx.repo, rel, body); }
  return commit(fx.repo, message);
}

/** Run the real prepush-check against `head`; read what RAN from the markers and the summary from the file. */
function gate(head, extraArgs = [], env = {}) {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-markers-'));
  roots.push(markerDir);
  const summary = path.join(markerDir, 'summary.txt');
  const r = spawnSync(process.execPath, ['scripts/prepush-check.mjs', '--head', head, '--base', git(fx.repo, ['merge-base', 'origin/main', head]), '--summary-file', summary, ...extraArgs], {
    cwd: fx.repo, encoding: 'utf8', timeout: 240_000, env: { ...hermeticGitEnv(), TIER_MARKER_DIR: markerDir, AUDIT_PREPUSH_TIER: '', ...env },
  });
  const ran = fs.existsSync(path.join(markerDir, 'ran.txt')) ? fs.readFileSync(path.join(markerDir, 'ran.txt'), 'utf8').split('\n').filter(Boolean).sort() : [];
  const out = `${r.stdout}\n${r.stderr}`;
  return { status: r.status, out, ran, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : null };
}
const ALL = ['claudemd', 'fleet-a', 'fleet-b', 'install', 'light'];

describe('stage 0 (shadow): the default is the FULL suite, with the branch tier\'s verdict printed beside it', () => {
  it('a docs-only push runs every file, prints what the branch tier would have skipped, and the summary says full', () => {
    const head = branch({ 'docs/readme.md': '# changed\n' });
    const r = gate(head);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.ran, ALL, 'nothing was skipped');
    assert.match(r.out, /test-tier\/v1 shadow: would skip 2 of 2 heavy file\(s\) \(0 reached by this diff\)/);
    assert.match(r.out, /static gates ok/);
    assert.deepEqual({ ...parseSummary(r.summary, head), base: 'x' }, { ok: true, tier: 'full', head, skipped: 0, base: 'x', reason: 'default' });
  });
});

describe('stage 1 (opt-in): --tier branch skips exactly the unreached heavy files', () => {
  it('a docs-only push skips both heavy files; the light files, claudemd and install all run; the output says it is not the full suite', () => {
    const head = branch({ 'docs/readme.md': '# changed\n' });
    const r = gate(head, ['--tier', 'branch']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.ran, ['claudemd', 'install', 'light']);
    assert.match(r.out, /BRANCH TIER — not the full suite\. Skipped 2 heavy file\(s\)/);
    assert.match(r.out, /BRANCH TIER — this was NOT the full suite/);
    assert.deepEqual(parseSummary(r.summary, head).skipped, 2);
    assert.equal(parseSummary(r.summary, head).tier, 'branch');
  });
  it('the AUDIT_PREPUSH_TIER environment variable is the same request', () => {
    const head = branch({ 'docs/readme.md': '# env\n' });
    const r = gate(head, [], { AUDIT_PREPUSH_TIER: 'branch' });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.ran, ['claudemd', 'install', 'light']);
  });
  it('a diff that reaches one heavy file runs that file and skips the other', () => {
    const head = branch({ 'lib/a.mjs': 'export const a = 2;\n' });
    const r = gate(head, ['--tier', 'branch']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.ran, ['claudemd', 'fleet-a', 'install', 'light']);
    assert.equal(parseSummary(r.summary, head).skipped, 1);
  });
  it('a declared-reach change (no import shows it) also runs the declaring file', () => {
    const head = branch({ 'lib/b-declared/x.json': '{}\n' });
    assert.deepEqual(gate(head, ['--tier', 'branch']).ran, ['claudemd', 'fleet-b', 'install', 'light']);
  });
  it('a re-push after a fix keeps the earlier commits\' reach: the base is the fork point, not the incremental range', () => {
    branch({ 'lib/a.mjs': 'export const a = 3;\n' });
    write(fx.repo, 'docs/readme.md', '# only the fix\n');
    const head = commit(fx.repo, 'the fix');
    const r = gate(head, ['--tier', 'branch']);
    assert.deepEqual(r.ran, ['claudemd', 'fleet-a', 'install', 'light'], 'the first commit\'s reach survived the second');
  });
});

describe('every escape is the full suite, and says why', () => {
  it('--pushes-default (the push updates the default branch)', () => {
    const head = branch({ 'docs/readme.md': '# d\n' });
    const r = gate(head, ['--tier', 'branch', '--pushes-default']);
    assert.deepEqual(r.ran, ALL);
    assert.equal(parseSummary(r.summary, head).reason, 'pushes-default');
  });
  it('--tier full', () => {
    const head = branch({ 'docs/readme.md': '# f\n' });
    const r = gate(head, ['--tier', 'full']);
    assert.deepEqual(r.ran, ALL);
    assert.equal(parseSummary(r.summary, head).reason, 'forced-full');
  });
  it('a diff touching the selector (the oracle must not select its own tests) or package.json', () => {
    for (const edits of [{ 'scripts/lib/test-tier.mjs': `${fs.readFileSync(path.join(REAL, 'scripts/lib/test-tier.mjs'), 'utf8')}\n// edited\n` }, { 'package.json': `${JSON.stringify({ ...JSON.parse(onMain('package.json')), version: '1.0.1' })}
` }]) {
      const head = branch(edits);
      const r = gate(head, ['--tier', 'branch']);
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(r.ran, ALL, Object.keys(edits)[0]);
    }
  });
  it('a stale heavy list (a timing older than maxAgeDays) forces full', () => {
    const head = branch({ '.test-tiers.json': heavyList('2020-01-01') });
    assert.deepEqual(gate(head, ['--tier', 'branch']).ran, ALL);
  });
});

describe('failure of the cheap path costs time, never coverage (guard 4)', () => {
  it('an unusable heavy list: the FULL suite runs, the reason is printed, the summary says selector-failed', () => {
    const head = branch({ '.test-tiers.json': '{ not json' });
    const r = gate(head, ['--tier', 'branch']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.ran, ALL);
    assert.match(r.out, /selector failed, so the FULL suite runs/);
    assert.equal(parseSummary(r.summary, head).reason, 'selector-failed');
  });
  it('a missing selector script is also full', () => {
    const head = branch({ 'scripts/test-tier.mjs': null });
    const r = gate(head, ['--tier', 'branch']);
    // The sandbox sees no scripts/test-tier.mjs, so the head is treated as one that predates the tier: legacy full check.
    assert.deepEqual(r.ran, ALL);
    assert.equal(parseSummary(r.summary, head).reason, 'head-predates-tier');
  });
});

describe('ordering and blocking', () => {
  it('a failing static gate blocks BEFORE any test runs', () => {
    const pkg = JSON.parse(onMain('package.json'));
    pkg.scripts['check:static'] = 'node -e "process.exit(7)"';
    const head = branch({ 'package.json': `${JSON.stringify(pkg)}\n` });
    const r = gate(head, ['--tier', 'branch']);
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.ran, [], 'no test ran');
    assert.equal(r.summary, null, 'a blocked push claims no tier');
  });
  it('a failing test blocks under the tier too', () => {
    const head = branch({ 'tests/light.test.mjs': "import { test } from 'node:test';\ntest('red', () => { throw new Error('boom'); });\n" });
    const r = gate(head, ['--tier', 'branch']);
    assert.notEqual(r.status, 0);
    assert.equal(r.summary, null);
  });
});

describe('a head that predates the tier (D7b) runs the legacy `npm run check` and passes', () => {
  it('no .test-tiers.json, no check:static: every test runs and the reason is printed', () => {
    const pkg = JSON.parse(onMain('package.json'));
    delete pkg.scripts['check:static'];
    pkg.scripts.check = `${STATIC_OK} && npm test`;
    const head = branch({ 'package.json': `${JSON.stringify(pkg)}\n`, '.test-tiers.json': null });
    const r = gate(head, ['--tier', 'branch']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.ran, ALL);
    assert.match(r.out, /predates the test tier/);
    assert.deepEqual(parseSummary(r.summary, head).reason, 'head-predates-tier');
  });
});

describe('verifying an already-pushed candidate (section 2.6b): --tier full --head, no push needed', () => {
  it('runs the full suite on exactly that sha and ends with a test-tier/v1 full verdict for it', () => {
    const head = branch({ 'docs/readme.md': '# candidate\n' });
    const r = gate(head, ['--tier', 'full']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`^test-tier/v1 full ${head} skipped=0 `, 'm'));
    assert.deepEqual(r.ran, ALL);
  });
});
