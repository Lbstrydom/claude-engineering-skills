/**
 * Path-scoping of `gates:poison` (gate census L-3): the gate runs only when the push range touches what the pills read,
 * derived from the contracts themselves, and runs in full on any uncertainty. The shared decision logic is covered by
 * tests/gate-path-scope.test.mjs; this file covers what is specific to this gate's triggers and its CLI wiring.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACKNOWLEDGED_COMPUTED_IMPORTS, loadContracts, poisonPillTriggers } from '../scripts/check-gate-poison-pills.mjs';
import { GATE_SCOPE_ENV, GATE_SCOPE_PATH } from '../scripts/lib/gate-path-scope.mjs';
import { readTreeAt } from '../scripts/lib/test-tier-git.mjs';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'scripts', 'check-gate-poison-pills.mjs');

describe('poisonPillTriggers, derived from the real contracts and tree', () => {
  const tree = readTreeAt(ROOT, 'HEAD');
  it('are derived (not hand-listed), fully followable, and not vacuous', () => {
    assert.equal(tree.ok, true, tree.error);
    const r = poisonPillTriggers(tree.tree);
    assert.deepEqual(r.uncertain, [], 'an unfollowable edge would make the gate always run');
    assert.ok(r.files.size > 100, `a closure of ${r.files.size} files is vacuous`);
    assert.ok(r.prefixes.includes('scripts/gate-contracts/'));
  });
  it('POSITIVE: covers a pilled gate script, its fixture, the artifact it tampers with, the runner and the registry', () => {
    const r = poisonPillTriggers(tree.tree);
    for (const f of [
      'scripts/check-gate-poison-pills.mjs', 'scripts/file-size-ratchet.mjs',
      'tests/fixtures/poison/file-size-baseline-understated.json', '.file-size-baseline.json',
      'scripts/gate-contracts/_exemptions.json', 'scripts/lib/gate-honesty/loader.mjs',
    ]) assert.ok(r.files.has(f), `${f} is read by gates:poison`);
  });
  it('NEGATIVE: unrelated paths are not inputs', () => {
    const r = poisonPillTriggers(tree.tree);
    for (const f of ['tests/db-withtx.test.mjs', 'scripts/fleet.mjs']) assert.equal(r.files.has(f), false, f);
  });
  it('is derived FROM the contracts: a pill added for a new gate script widens the set by itself', () => {
    const synthetic = [{ script: 'x', file: 'gate-contracts/x.json', id: 'x', poisonPill: { argv: ['scripts/brand-new-gate.mjs'], overlay: { 'a.json': 'tests/fixtures/poison/new.json' }, mutate: { 'b.json': { path: 'k', value: 1 } } } }];
    const t = { files: new Set(['scripts/check-gate-poison-pills.mjs', 'scripts/lib/gate-path-scope.mjs', 'scripts/brand-new-gate.mjs']), read: () => '' };
    const r = poisonPillTriggers(t, { contracts: synthetic });
    for (const f of ['scripts/brand-new-gate.mjs', 'a.json', 'tests/fixtures/poison/new.json', 'b.json']) assert.ok(r.files.has(f), f);
  });
  it('a pill whose argv carries a node option BEFORE the gate still contributes the gate script (not the option value)', () => {
    const synthetic = [{ script: 'x', file: 'gate-contracts/x.json', id: 'x', poisonPill: { argv: ['--conditions', 'scripts/lib/cli-entry.mjs', 'scripts/new-gate.mjs'] } }];
    const t = { files: new Set(['scripts/check-gate-poison-pills.mjs', 'scripts/lib/gate-path-scope.mjs', 'scripts/lib/cli-entry.mjs', 'scripts/new-gate.mjs']), read: () => '' };
    assert.ok(poisonPillTriggers(t, { contracts: synthetic }).files.has('scripts/new-gate.mjs'));
  });
  it('a node option in `--flag=./script.mjs` form contributes its script (a bootstrap module executes before the gate)', () => {
    const synthetic = [{ script: 'x', file: 'gate-contracts/x.json', id: 'x', poisonPill: { argv: ['--import=./scripts/poison-bootstrap.mjs', 'scripts/example-gate.mjs'] } }];
    const t = { files: new Set(['scripts/check-gate-poison-pills.mjs', 'scripts/lib/gate-path-scope.mjs', 'scripts/poison-bootstrap.mjs', 'scripts/example-gate.mjs']), read: () => '' };
    const r = poisonPillTriggers(t, { contracts: synthetic });
    assert.ok(r.files.has('scripts/poison-bootstrap.mjs') && r.files.has('scripts/example-gate.mjs'));
  });
  it('the acknowledged installer import is followed to its named target', () => {
    assert.ok(poisonPillTriggers(tree.tree).files.has('scripts/lib/install/legacy-surfaces.mjs'));
  });
  it('every acknowledged computed import still matches a live one (a stale acknowledgement is a defect)', () => {
    const live = new Set(poisonPillTriggers(tree.tree).blind.map((b) => b.split(' ')[0]));
    for (const f of Object.keys(ACKNOWLEDGED_COMPUTED_IMPORTS)) assert.ok(live.has(f), `${f} is acknowledged but has no computed dynamic import in the closure`);
    assert.equal(live.size, Object.keys(ACKNOWLEDGED_COMPUTED_IMPORTS).length);
  });
  it('the contracts load (so a loader failure would make the trigger derivation throw, which runs the gate)', () => {
    assert.ok(loadContracts().length >= 20);
  });
});

describe('gates:poison CLI under the scoped env (real git ranges)', () => {
  const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', env: sanitizeGitEnv(ROOT) });
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const emptyTree = spawnSync('git', ['mktree'], { cwd: ROOT, encoding: 'utf8', input: '', env: sanitizeGitEnv(ROOT) }).stdout.trim();
  const commitEnv = { ...sanitizeGitEnv(ROOT), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const emptyBase = spawnSync('git', ['commit-tree', emptyTree, '-m', 'empty base for gate-poison-scope test'], { cwd: ROOT, encoding: 'utf8', env: commitEnv }).stdout.trim();
  // The pushed head must DESCEND from the base: the range is anchored at merge-base(base, head), and an unrelated root has none. So the
  // head is HEAD's own tree committed on top of the empty base, which still makes every file differ.
  const headOnEmpty = spawnSync('git', ['commit-tree', `${head}^{tree}`, '-p', emptyBase, '-m', 'HEAD tree on the empty base'], { cwd: ROOT, encoding: 'utf8', env: commitEnv }).stdout.trim();
  const envFor = (base, extra = {}, rangeHead = head) => {
    const env = { ...process.env, [GATE_SCOPE_ENV]: GATE_SCOPE_PATH, AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: rangeHead, AUDIT_PUSH_RANGE_REQUIRED: '1', ...extra };
    return env;
  };
  /** Start the gate and stop it as soon as its scope line appears: the full gate takes about a minute and is not what is under test. */
  const firstScopeLine = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const done = (v) => { try { child.kill(); } catch { /* already gone */ } resolve(v); };
    const timer = setTimeout(() => done({ out, status: null, timedOut: true }), 60_000);
    child.stderr.on('data', (d) => { out += d; if (/gates:poison: (running|SKIPPED)/.test(out)) { clearTimeout(timer); done({ out, status: null }); } });
    child.on('exit', (status) => { clearTimeout(timer); resolve({ out, status }); });
  });

  it('HARNESS CONTROL: the fixture base is a real commit', () => { assert.match(emptyBase, /^[0-9a-f]{40}$/); assert.match(headOnEmpty, /^[0-9a-f]{40}$/); assert.match(head, /^[0-9a-f]{40}$/); });
  it('POSITIVE: a range that touches the gate\'s inputs runs it (the scope line says so)', async () => {
    const r = await firstScopeLine(envFor(emptyBase, {}, headOnEmpty));
    assert.match(r.out, /gates:poison: running \(path-scoped\) — .* is an input of gates:poison and changed/);
  });
  it('NEGATIVE: an empty range skips with a visible SKIPPED line and exits 0 without running a pill', async () => {
    const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8', env: envFor(head), timeout: 60_000 });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.match(out, /gates:poison: SKIPPED \(path-scoped\) — none of the/);
    assert.match(out, /did NOT run for this push/);
    assert.doesNotMatch(out, /✓ gates:poison|check-chain command/, 'no pill result was produced');
  });
  it('UNRESOLVED RANGE: an unresolvable base runs the gate in full', async () => {
    const r = await firstScopeLine(envFor('f'.repeat(40)));
    assert.match(r.out, /gates:poison: running in full — full: the push range is unresolved/);
  });
  it('NOT SCOPED without the env: runs in full', async () => {
    const env = { ...process.env };
    delete env[GATE_SCOPE_ENV];
    const r = await firstScopeLine(env);
    assert.match(r.out, /gates:poison: running in full — full: not a path-scoped push/);
  });
});
