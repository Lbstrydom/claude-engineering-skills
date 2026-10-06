/**
 * @fileoverview /fleet Phase 3 — config validation (pure) and resolution
 * against throwaway repos. Tier-1: §2b rules exactly as written.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import {
  parseFleetConfig, resolveConfig, ConfigError, stringToTier, validateScriptPath, validateWorktreeRoot, defaultWorktreeRoot,
} from '../scripts/lib/fleet/config.mjs';

const roots = [];
const mk = (p) => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p))); roots.push(d); return d; };
after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const ok = (raw, ctx) => { const r = parseFleetConfig(raw, ctx); assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
const bad = (raw, ctx) => { const r = parseFleetConfig(raw, ctx); assert.equal(r.ok, false, 'expected a config error'); return r.errors.join(' | '); };

describe('parseFleetConfig — defaults', () => {
  it('empty config: npm test from package.json, or none', () => {
    const withPkg = ok({}, { hasPackageTest: true });
    assert.deepEqual(withPkg.testCommand, [{ name: 'default', stage: 'pre-land', command: ['npm', 'test'] }]);
    assert.equal(withPkg.testCommandSource, 'package.json');
    const without = ok({});
    assert.deepEqual(without.testCommand, []);
    assert.equal(without.testCommandSource, 'unset');
    assert.equal(without.mergeMethod, 'pr');
    assert.equal(without.mergeMethodSource, 'default');
    assert.deepEqual(without.checks, []);
    assert.equal(without.baseBranch, null);
  });
});

describe('parseFleetConfig — tiered testCommand (§2b)', () => {
  it('a string is one pre-land tier named default; plain words become argv', () => {
    const v = ok({ testCommand: 'npm run test:unit' });
    assert.deepEqual(v.testCommand, [{ name: 'default', stage: 'pre-land', command: ['npm', 'run', 'test:unit'] }]);
    assert.equal(v.testCommandSource, 'config');
  });
  it('a string with shell syntax is kept whole and flagged shell:true', () => {
    assert.deepEqual(stringToTier('npm run a && npm run b'), { name: 'default', stage: 'pre-land', command: ['npm run a && npm run b'], shell: true });
  });
  it('an ordered tier list with stage defaulting to pre-land', () => {
    const v = ok({ testCommand: { tiers: [
      { name: 'fast', command: ['npm', 'run', 'test:unit'], timeoutMs: 900000 },
      { name: 'packaged', command: ['npm', 'run', 'test:packaged'], stage: 'post-merge' },
    ] } });
    assert.deepEqual(v.testCommand.map((t) => [t.name, t.stage]), [['fast', 'pre-land'], ['packaged', 'post-merge']]);
    assert.equal(v.testCommand[0].timeoutMs, 900000);
  });
  it('a tier command that is a shell string is a config error naming the key', () => {
    const e = bad({ testCommand: { tiers: [{ name: 'fast', command: 'npm test' }] } });
    assert.match(e, /testCommand\.tiers\.0\.command/);
    assert.match(e, /argv array/);
  });
  it('no pre-land tier / duplicate names / bad names / empty tiers are errors', () => {
    assert.match(bad({ testCommand: { tiers: [{ name: 'p', command: ['x'], stage: 'post-merge' }] } }), /pre-land/);
    assert.match(bad({ testCommand: { tiers: [{ name: 'a', command: ['x'] }, { name: 'a', command: ['y'] }] } }), /duplicate tier name "a"/);
    assert.match(bad({ testCommand: { tiers: [{ name: 'Bad Name', command: ['x'] }] } }), /name/);
    assert.match(bad({ testCommand: { tiers: [] } }), /tiers/);
    assert.match(bad({ testCommand: { tiers: [{ name: 'a', command: [] }] } }), /command/);
    assert.match(bad({ testCommand: { tiers: [{ name: 'a', command: ['x'], timeoutMs: -1 }] } }), /timeoutMs/);
    assert.match(bad({ testCommand: { tiers: [{ name: 'a', command: ['x'], stage: 'later' }] } }), /stage/);
  });
});

describe('parseFleetConfig — strictness and checks (§2b)', () => {
  it('an unknown key is an error naming it (root, tier, check)', () => {
    assert.match(bad({ colour: 'red' }), /unknown key "colour"/);
    assert.match(bad({ testCommand: { tiers: [{ name: 'a', command: ['x'], retries: 3 }] } }), /unknown key "retries"/);
    assert.match(bad({ checks: [{ name: 'c', script: 's.mjs', sevrity: 'block' }] }), /unknown key "sevrity"/);
  });
  it('mergeMethod and baseBranch validate', () => {
    assert.equal(ok({ mergeMethod: 'direct-squash' }).mergeMethodSource, 'config');
    assert.match(bad({ mergeMethod: 'rebase' }), /mergeMethod/);
    assert.match(bad({ baseBranch: '--evil' }), /baseBranch/);
    assert.match(bad({ baseBranch: 'has space' }), /baseBranch/);
  });
  it('a check with defaults: runIn both, severity warn, 60s timeout', () => {
    const [c] = ok({ checks: [{ name: 'sem', script: 'scripts/fleet-semantic-check.mjs' }] }).checks;
    assert.deepEqual([c.runIn, c.severity, c.timeoutMs], [['status', 'land'], 'warn', 60000]);
  });
  it('a full check from the plan parses', () => {
    const [c] = ok({ checks: [{ name: 'semantic-collisions', script: 'scripts/fleet-semantic-check.mjs', runner: ['node'], args: [], runIn: ['status', 'land'], severity: 'block', timeoutMs: 60000 }] }).checks;
    assert.equal(c.severity, 'block');
    assert.deepEqual(c.runner, ['node']);
  });
  it('missing script, absolute script, escaping script', () => {
    assert.match(bad({ checks: [{ name: 'c' }] }), /checks\.0\.script/);
    assert.match(bad({ checks: [{ name: 'c', script: '/etc/x.mjs' }] }), /absolute/);
    assert.match(bad({ checks: [{ name: 'c', script: 'C:\\x\\y.mjs' }] }), /absolute/);
    assert.match(bad({ checks: [{ name: 'c', script: '../x.mjs' }] }), /escape/);
    assert.match(bad({ checks: [{ name: 'c', script: 'a\\..\\..\\x.mjs' }] }), /escape/);
    assert.equal(validateScriptPath('scripts/ok.mjs'), null);
  });
  it('runner/args not arrays of strings, runIn outside status|land, duplicate names', () => {
    assert.match(bad({ checks: [{ name: 'c', script: 's.mjs', runner: 'node' }] }), /checks\.0\.runner/);
    assert.match(bad({ checks: [{ name: 'c', script: 's.mjs', args: ['a', 1] }] }), /checks\.0\.args/);
    assert.match(bad({ checks: [{ name: 'c', script: 's.mjs', runIn: ['land', 'deploy'] }] }), /runIn/);
    assert.match(bad({ checks: [{ name: 'c', script: 's.mjs', runIn: [] }] }), /runIn/);
    assert.match(bad({ checks: [{ name: 'c', script: 'a.mjs' }, { name: 'c', script: 'b.mjs' }] }), /duplicate check name/);
    assert.match(bad({ checks: [{ name: 'c', script: 's.mjs', severity: 'fatal' }] }), /severity/);
  });
  it('a check script path is normalised to forward slashes', () => {
    assert.equal(ok({ checks: [{ name: 'c', script: 'scripts\\x.mjs' }] }).checks[0].script, 'scripts/x.mjs');
  });
});

describe('worktree root rules', () => {
  it('default root is a sibling of the repo, outside it', () => {
    const r = defaultWorktreeRoot(path.join(os.tmpdir(), 'myrepo'));
    assert.equal(r, path.join(os.tmpdir(), '.fleet-wt', 'myrepo'));
  });
  it('refuses a root inside .git or inside the working tree', () => {
    const repo = path.join(os.tmpdir(), 'r');
    const where = { repoRoots: [repo], gitDirs: [path.join(repo, '.git')] };
    assert.match(validateWorktreeRoot(path.join(repo, '.git', 'fleet', 'wt'), where), /inside the git directory/);
    assert.match(validateWorktreeRoot(path.join(repo, 'build', 'wt'), where), /inside the repo's working tree/);
    assert.equal(validateWorktreeRoot(path.join(os.tmpdir(), 'elsewhere'), where), null);
    assert.equal(validateWorktreeRoot(path.join(os.tmpdir(), 'r-sibling'), where), null, 'prefix-sharing sibling is not inside');
  });
});

describe('resolveConfig (throwaway repos)', () => {
  function repo(files = {}) {
    const dir = mk('fleet-cfg-');
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 't@example.com'], dir);
    git(['config', 'user.name', 'T'], dir);
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', 'init'], dir);
    return dir;
  }

  it('bare repo: fallback main, no test command, default worktree root outside the repo', () => {
    const dir = repo();
    const c = resolveConfig(dir, { env: {} });
    assert.equal(c.baseBranch, 'main');
    assert.equal(c.sources.baseBranch, 'fallback');
    assert.deepEqual(c.testCommand, []);
    assert.equal(c.sources.testCommand, 'unset');
    assert.equal(c.mergeMethod, 'pr');
    assert.equal(c.sources.mergeMethod, 'default');
    assert.equal(c.worktreeRoot, path.join(path.dirname(dir), '.fleet-wt', path.basename(dir)));
    assert.equal(c.sources.worktreeRoot, 'default');
  });
  it('package.json scripts.test => npm test; the npm placeholder does not count', () => {
    const real = resolveConfig(repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }), { env: {} });
    assert.deepEqual(real.testCommand[0].command, ['npm', 'test']);
    assert.equal(real.sources.testCommand, 'package.json');
    const placeholder = resolveConfig(repo({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), { env: {} });
    assert.deepEqual(placeholder.testCommand, []);
  });
  it('.fleet.json wins and is reported as config', () => {
    const dir = repo({ '.fleet.json': JSON.stringify({ baseBranch: 'develop', mergeMethod: 'direct-merge', testCommand: 'make check' }) });
    const c = resolveConfig(dir, { env: {} });
    assert.equal(c.baseBranch, 'develop');
    assert.equal(c.mergeMethod, 'direct-merge');
    assert.deepEqual(c.testCommand[0].command, ['make', 'check']);
    assert.deepEqual([c.sources.baseBranch, c.sources.mergeMethod, c.sources.testCommand], ['config', 'config', 'config']);
  });
  it('origin/HEAD names the base branch when no config does', () => {
    const remote = mk('fleet-cfg-origin-');
    git(['init', '-q', '--bare', '-b', 'trunk'], remote);
    const dir = repo();
    git(['branch', '-m', 'trunk'], dir);
    git(['remote', 'add', 'origin', remote], dir);
    git(['push', '-q', 'origin', 'trunk'], dir);
    git(['remote', 'set-head', 'origin', 'trunk'], dir);
    const c = resolveConfig(dir, { env: {} });
    assert.equal(c.baseBranch, 'trunk');
    assert.equal(c.sources.baseBranch, 'origin/HEAD');
  });
  it('invalid config throws ConfigError listing every problem, prefixed with the file', () => {
    const dir = repo({ '.fleet.json': JSON.stringify({ nope: 1, mergeMethod: 'rebase' }) });
    assert.throws(() => resolveConfig(dir, { env: {} }), (e) => e instanceof ConfigError && e.errors.length === 2 && e.errors.every((m) => m.startsWith('.fleet.json ')));
    assert.throws(() => resolveConfig(repo({ '.fleet.json': '{ not json' }), { env: {} }), (e) => e instanceof ConfigError && /not valid JSON/.test(e.message));
    assert.throws(() => resolveConfig(mk('fleet-cfg-notrepo-'), { env: {} }), ConfigError);
  });
  it('FLEET_WORKTREE_ROOT overrides; a root inside .git or the working tree is refused', () => {
    const dir = repo();
    const elsewhere = mk('fleet-cfg-root-');
    const c = resolveConfig(dir, { env: { FLEET_WORKTREE_ROOT: elsewhere } });
    assert.equal(c.worktreeRoot, elsewhere);
    assert.equal(c.sources.worktreeRoot, 'env');
    assert.throws(() => resolveConfig(dir, { env: { FLEET_WORKTREE_ROOT: path.join(dir, '.git', 'fleet', 'wt') } }), (e) => /inside the git directory/.test(e.message));
    assert.throws(() => resolveConfig(dir, { env: { FLEET_WORKTREE_ROOT: path.join(dir, 'wt') } }), (e) => /inside the repo's working tree/.test(e.message));
  });
  it('a linked worktree resolves the same default root as its main checkout', () => {
    const dir = repo();
    const wt = path.join(mk('fleet-cfg-link-'), 'linked');
    git(['worktree', 'add', '-q', '-b', 'feat/x', wt], dir);
    assert.equal(resolveConfig(wt, { env: {} }).worktreeRoot, resolveConfig(dir, { env: {} }).worktreeRoot);
  });
});

describe('executable element must be non-blank; ..fleet is inside', () => {
  it('rejects [""] and ["  "] for tiers, runners and scripts', () => {
    assert.match(bad({ testCommand: { tiers: [{ name: 'a', command: [''] }] } }), /testCommand\.tiers\.0\.command.*executable/);
    assert.match(bad({ testCommand: { tiers: [{ name: 'a', command: ['  ', 'x'] }] } }), /executable/);
    assert.match(bad({ checks: [{ name: 'c', script: 's.mjs', runner: [''] }] }), /checks\.0\.runner.*executable/);
    assert.match(bad({ checks: [{ name: 'c', script: 's.mjs', runner: ['\t'] }] }), /executable/);
    assert.match(bad({ checks: [{ name: 'c', script: '   ' }] }), /checks\.0\.script/);
    // the executable is checked, later argv elements may be anything
    assert.equal(parseFleetConfig({ testCommand: { tiers: [{ name: 'a', command: ['node', ''] }] } }).ok, true);
    assert.equal(parseFleetConfig({ checks: [{ name: 'c', script: 's.mjs', runner: [] }] }).ok, true);
  });
  it('user-facing tiers cannot set shell', () => {
    assert.match(bad({ testCommand: { tiers: [{ name: 'a', command: ['x'], shell: true }] } }), /unknown key "shell"/);
  });
  it('a worktree root under a child named "..fleet" inside the repo is refused (old startsWith("..") read it as outside)', () => {
    const repo = path.join(os.tmpdir(), 'r2');
    const where = { repoRoots: [repo], gitDirs: [path.join(repo, '.git')] };
    assert.match(validateWorktreeRoot(path.join(repo, '..fleet', 'wt'), where), /inside the repo's working tree/);
    assert.match(validateWorktreeRoot(path.join(repo, '.git', '..fleet'), where), /inside the git directory/);
    assert.equal(validateWorktreeRoot(path.join(os.tmpdir(), '..fleet-sibling'), where), null);
  });
});
