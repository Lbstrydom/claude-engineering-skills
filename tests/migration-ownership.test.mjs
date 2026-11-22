/**
 * @fileoverview setup-postgres refuses a migration file git does not track (2026-11-20 incident: three untracked,
 * exclude-hidden migrations replaced unique keys on a mirror's store). Real git in a temp repo; no database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  ALLOW_UNTRACKED_FLAG, assessMigrationOwnership, enforceMigrationOwnership,
} from '../scripts/lib/migration-ownership.mjs';
import { _internals } from '../scripts/setup-postgres.mjs';

const { runMigrate, runAdopt, runCheckDrift } = _internals;
const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf-8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
};

/** A git repo with tracked 001 + 002 and (when `untracked`) an exclude-hidden 003 - the incident shape. */
function mkRepo({ untracked = true, init = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-own-'));
  const dir = path.join(root, 'supabase', 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '001_a.sql'), 'select 1;');
  fs.writeFileSync(path.join(dir, '002_b.sql'), 'select 2;');
  if (init) {
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  }
  if (untracked) {
    fs.writeFileSync(path.join(dir, '003_reconcile_local_schema_drift.sql'), 'select 3;');
    if (init) fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
    if (init) fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), 'supabase/migrations/003_*.sql\n');
  }
  return { root, dir };
}
const sink = () => {
  const c = [];
  return { c, s: new Writable({ write(x, _e, cb) { c.push(String(x)); cb(); } }) };
};

describe('assessMigrationOwnership', () => {
  it('names an untracked file even when .git/info/exclude hides it from status', () => {
    const { root, dir } = mkRepo();
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf-8' }).stdout.trim(), '', 'precondition: git status is silent');
    assert.deepEqual(assessMigrationOwnership({ repoRoot: root, migrationsDir: dir }),
      { status: 'untracked', untracked: ['003_reconcile_local_schema_drift.sql'] });
  });
  it('a tracked file in a subdirectory does not vouch for an untracked same-named root file', () => {
    const { root, dir } = mkRepo({ untracked: false });
    fs.mkdirSync(path.join(dir, 'archive'));
    fs.writeFileSync(path.join(dir, 'archive', '003_x.sql'), 'select 9;');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'archive');
    fs.writeFileSync(path.join(dir, '003_x.sql'), 'select 3;');
    assert.deepEqual(assessMigrationOwnership({ repoRoot: root, migrationsDir: dir }), { status: 'untracked', untracked: ['003_x.sql'] });
  });
  it('a fully tracked set is tracked', () => {
    const { root, dir } = mkRepo({ untracked: false });
    assert.deepEqual(assessMigrationOwnership({ repoRoot: root, migrationsDir: dir }), { status: 'tracked' });
  });
  it('fails closed when git is unavailable (spawn error)', () => {
    const { root, dir } = mkRepo({ untracked: false });
    const v = assessMigrationOwnership({ repoRoot: root, migrationsDir: dir, spawn: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) });
    assert.equal(v.status, 'unverified');
    assert.match(v.reason, /ENOENT/);
  });
  it('fails closed outside a git work tree', () => {
    const { root, dir } = mkRepo({ untracked: false, init: false });
    const v = assessMigrationOwnership({ repoRoot: root, migrationsDir: dir });
    assert.equal(v.status, 'unverified');
  });
  it('a synced consumer copy (.audit-loop/migrations) is not-applicable, never refused', () => {
    const { root } = mkRepo({ untracked: false });
    const priv = path.join(root, '.audit-loop', 'migrations');
    fs.mkdirSync(priv, { recursive: true });
    fs.writeFileSync(path.join(priv, '001_a.sql'), 'select 1;');
    assert.deepEqual(assessMigrationOwnership({ repoRoot: root, migrationsDir: priv }), { status: 'not-applicable' });
  });
});

describe('enforceMigrationOwnership', () => {
  const untracked = { status: 'untracked', untracked: ['003_x.sql'] };
  it('refuses, naming the file and the remedy', () => {
    assert.throws(() => enforceMigrationOwnership(untracked, { migrationsDir: 'd' }),
      (e) => e.code === 'MIGRATIONS_NOT_GIT_OWNED' && /003_x\.sql/.test(e.message) && /delete the file/.test(e.message) && e.message.includes(ALLOW_UNTRACKED_FLAG));
  });
  it('refuses an unverifiable set the same way', () => {
    assert.throws(() => enforceMigrationOwnership({ status: 'unverified', reason: 'git exit 128' }, { migrationsDir: 'd' }), /Failing closed/);
  });
  it('the override proceeds and warns', () => {
    const { c, s } = sink();
    enforceMigrationOwnership(untracked, { migrationsDir: 'd', allowUntracked: true, stderr: s });
    assert.match(c.join(''), /WARNING .*allow-untracked-migrations/);
  });
  it('tracked passes silently', () => {
    enforceMigrationOwnership({ status: 'tracked' }, { migrationsDir: 'd' });
  });
});

describe('setup-postgres wiring', () => {
  const boom = new Error('SENTINEL: reached the database');
  const pool = () => {
    const calls = [];
    return { calls, query: async (t) => { calls.push(t); throw boom; } };
  };
  const untracked = () => ({ status: 'untracked', untracked: ['003_x.sql'] });
  const runners = [
    ['--migrate', (p, o) => runMigrate(p, { dryRun: false, ...o })],
    ['--adopt', (p, o) => runAdopt(p, o)],
  ];
  for (const [name, run] of runners) {
    it(`${name} refuses an untracked file before any query`, async () => {
      const p = pool();
      await assert.rejects(run(p, { ownership: untracked }), /003_x\.sql/);
      assert.equal(p.calls.length, 0);
    });
    it(`${name} fails closed when ownership is unverifiable`, async () => {
      const p = pool();
      await assert.rejects(run(p, { ownership: () => ({ status: 'unverified', reason: 'git exit 128' }) }), /Failing closed/);
      assert.equal(p.calls.length, 0);
    });
    it(`${name} with a tracked set proceeds to the database`, async () => {
      await assert.rejects(run(pool(), { ownership: () => ({ status: 'tracked' }) }), /SENTINEL/);
    });
    it(`${name} with ${ALLOW_UNTRACKED_FLAG} proceeds to the database`, async () => {
      await assert.rejects(run(pool(), { ownership: untracked, allowUntracked: true }), /SENTINEL/);
    });
  }

  it('--check-drift reports an untracked migration distinctly: drift, exit 1, never clean', async () => {
    const { root, dir } = mkRepo();
    const out = sink();
    const err = sink();
    const p = {
      async query(t) {
        if (t.includes('to_regclass')) return { rows: [{ t: 'x' }] };
        return { rows: ['001_a.sql', '002_b.sql', '003_reconcile_local_schema_drift.sql'].map((f) => ({ filename: f, sha256: 'z' })) };
      },
    };
    const r = await runCheckDrift(p, { migrationsDir: dir, repoRoot: root, stdout: out.s, stderr: err.s, format: 'json' });
    assert.equal(r.hasDrift, true);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(r.drift.untrackedMigrations, ['003_reconcile_local_schema_drift.sql']);
    const human = sink();
    _internals.renderHumanDriftReport({ ...r, hasDrift: true }, human.s);
    assert.match(human.c.join(''), /untracked migration file present/);
  });

  it('parseArgs accepts the flag only with a migrating mode', () => {
    assert.equal(_internals.parseArgs(['--migrate', ALLOW_UNTRACKED_FLAG]).allowUntracked, true);
    assert.equal(_internals.parseArgs(['--migrate']).allowUntracked, false);
    const r = spawnSync(process.execPath, ['scripts/setup-postgres.mjs', '--check-drift', ALLOW_UNTRACKED_FLAG], { encoding: 'utf-8' });
    assert.equal(r.status, 2);
  });
});
