/**
 * @fileoverview The consumer sync's migration contract (incident 2026-11-22).
 *
 * A mirror checkout held three UNTRACKED migration files; the sync copied them into six consumers, which committed them;
 * retiring them upstream then made every consumer audit refuse and advise a `--migrate` that would re-apply them. Four seams:
 *   (1) the source set is what git TRACKS, never the directory listing, and fails closed when git cannot answer;
 *   (2) a manifest-owned migration upstream stopped tracking is retired VISIBLY: unedited -> removed, edited -> held,
 *       override-declared -> held even under --overwrite-diverged;
 *   (3) the "store behind" refusal never advises `--migrate` for an orphaned file.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { listShippableMigrations } from '../scripts/lib/migration-ownership.mjs';
import { syncMigrationsReport, describeUntrackedMigrations } from '../scripts/lib/sync-inventory.mjs';
import { planGarbageCollection, renderGcReport, retiredForReceipt } from '../scripts/lib/sync-gc.mjs';
import { adviseForMissingMigrations, readRetiredMigrationNames } from '../scripts/lib/db/orphaned-migrations.mjs';
import { decideSchemaPrecondition } from '../scripts/lib/audit/schema-precondition.mjs';

const ROOT = path.resolve('/repo');
const DIR = path.join(ROOT, 'supabase', 'migrations');
const gitLists = (...files) => () => ({ status: 0, stdout: files.map((f) => `supabase/migrations/${f}`).join('\0') + '\0' });

describe('the sync ships only what git tracks', () => {
  it('an untracked source migration is never shipped, and is named', () => {
    const r = listShippableMigrations({
      repoRoot: ROOT, migrationsDir: DIR, spawn: gitLists('001_a.sql'), listDir: () => ['001_a.sql', '20260821_reconcile_local_schema_drift_1.sql'],
    });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.shippable, ['001_a.sql']);
    assert.deepEqual(r.untracked, ['20260821_reconcile_local_schema_drift_1.sql']);
  });

  it('a tracked migration is shipped', () => {
    const r = listShippableMigrations({ repoRoot: ROOT, migrationsDir: DIR, spawn: gitLists('001_a.sql', '002_b.sql'), listDir: () => ['002_b.sql', '001_a.sql'] });
    assert.deepEqual(r.shippable, ['001_a.sql', '002_b.sql']);
    assert.deepEqual(r.untracked, []);
  });

  it('a file tracked in the index but gone from disk is an INCOMPLETE inventory: reported, and the sync refuses', () => {
    const io = { repoRoot: ROOT, spawn: gitLists('001_a.sql', '002_gone.sql'), listDir: () => ['001_a.sql'] };
    const r = listShippableMigrations({ migrationsDir: DIR, ...io });
    assert.deepEqual(r.shippable, ['001_a.sql']);
    assert.deepEqual(r.missingOnDisk, ['002_gone.sql']);
    assert.throws(() => syncMigrationsReport(io), /tracked by git but absent from .*002_gone.sql/);
  });

  it('a MISSING directory is "no migrations" only if git was asked first and answered', () => {
    const enoent = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    const ok = listShippableMigrations({ repoRoot: ROOT, migrationsDir: DIR, listDir: enoent, spawn: gitLists() });
    assert.deepEqual([ok.status, ok.shippable], ['ok', []]);
    const blind = listShippableMigrations({ repoRoot: ROOT, migrationsDir: DIR, listDir: enoent, spawn: () => ({ status: 128, stdout: '' }) });
    assert.equal(blind.status, 'unverified', 'git unavailable must not read as an empty, verified set');
  });

  it('git runs with the repository-scoped variables stripped (an inherited GIT_INDEX_FILE cannot redirect the oracle)', () => {
    const saved = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = path.join(os.tmpdir(), 'some-other-index');
    let seen;
    try {
      listShippableMigrations({ repoRoot: ROOT, migrationsDir: DIR, listDir: () => [], spawn: (cmd, args, opts) => { seen = opts.env; return { status: 0, stdout: '' }; } });
    } finally { if (saved === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved; }
    assert.ok(seen && typeof seen === 'object', 'an explicit env must be passed');
    assert.equal(Object.keys(seen).some((k) => k.toUpperCase() === 'GIT_INDEX_FILE'), false);
  });

  it('git unavailable fails CLOSED: unverified, never the directory listing', () => {
    const r = listShippableMigrations({
      repoRoot: ROOT, migrationsDir: DIR, listDir: () => ['001_a.sql'], spawn: () => ({ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }),
    });
    assert.equal(r.status, 'unverified');
    assert.equal(r.shippable, undefined, 'no shippable list may accompany an unverified verdict');
    const notRepo = listShippableMigrations({ repoRoot: ROOT, migrationsDir: DIR, listDir: () => ['001_a.sql'], spawn: () => ({ status: 128, stdout: '' }) });
    assert.equal(notRepo.status, 'unverified');
  });

  it('syncMigrationsReport throws when git cannot answer', () => {
    assert.throws(
      () => syncMigrationsReport({ repoRoot: ROOT, listDir: () => ['001_a.sql'], spawn: () => ({ status: 128, stdout: '' }) }),
      /cannot establish the tracked migration set/,
    );
  });

  it('syncMigrationsReport returns source-relative paths and the untracked set', () => {
    const r = syncMigrationsReport({ repoRoot: ROOT, listDir: () => ['001_a.sql', '009_x.sql'], spawn: gitLists('001_a.sql') });
    assert.deepEqual(r.files, ['supabase/migrations/001_a.sql']);
    assert.deepEqual(r.untracked, ['supabase/migrations/009_x.sql']);
  });

  describe('against a REAL git repository (the oracle, not a stub)', () => {
    let tmp;
    before(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-mig-'));
      const git = (...a) => assert.equal(spawnSync('git', a, { cwd: tmp, encoding: 'utf-8' }).status, 0, `git ${a.join(' ')}`);
      git('init', '-q');
      fs.mkdirSync(path.join(tmp, 'supabase', 'migrations'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'supabase', 'migrations', '001_tracked.sql'), 'select 1;\n');
      git('add', 'supabase/migrations/001_tracked.sql');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'x');
      // Untracked AND hidden by .git/info/exclude: exactly the incident's shape.
      fs.writeFileSync(path.join(tmp, 'supabase', 'migrations', '20260821_hidden.sql'), 'drop index x;\n');
      fs.mkdirSync(path.join(tmp, '.git', 'info'), { recursive: true });
      fs.appendFileSync(path.join(tmp, '.git', 'info', 'exclude'), 'supabase/migrations/20260821_hidden.sql\n');
    });
    after(() => fs.rmSync(tmp, { recursive: true, maxRetries: 3, retryDelay: 50 }));

    it('ships the tracked file and refuses the excluded untracked one', () => {
      const r = syncMigrationsReport({ repoRoot: tmp });
      assert.deepEqual(r.files, ['supabase/migrations/001_tracked.sql']);
      assert.deepEqual(r.untracked, ['supabase/migrations/20260821_hidden.sql']);
    });
  });
});

describe('retiring a manifest-owned migration upstream no longer tracks', () => {
  const PREFIX = '.audit-loop/migrations/';
  const base = `sha256:${'a'.repeat(64)}`;
  const edited = `sha256:${'b'.repeat(64)}`;
  const plan = (disk, extra = {}) => planGarbageCollection({
    priorFiles: { [`${PREFIX}20260821_x.sql`]: base },
    intendedDests: new Set(),
    toolingDir: 'scripts/.claude-skills',
    exists: () => true,
    probe: () => ({ state: 'present', hash: disk }),
    retirePrefixes: [PREFIX],
    ...extra,
  });

  it('unedited (hash equals the manifest base) -> removed', () => {
    assert.deepEqual(plan(base).deletions, [`${PREFIX}20260821_x.sql`]);
  });

  it('edited -> held and reported, never deleted', () => {
    const p = plan(edited);
    assert.deepEqual(p.deletions, []);
    assert.deepEqual(p.divergedHeld, [`${PREFIX}20260821_x.sql`]);
  });

  it('declared in .sync-overrides.json -> held as declared divergence, even when unedited', () => {
    const p = plan(base, { isDeclaredDivergence: (k) => k.startsWith(PREFIX) });
    assert.deepEqual(p.deletions, []);
    assert.deepEqual(p.declaredHeld, [`${PREFIX}20260821_x.sql`]);
  });

  it('still-shipped migrations are never retired', () => {
    const p = plan(base, { intendedDests: new Set([`${PREFIX}20260821_x.sql`]) });
    assert.deepEqual(p.deletions, []);
  });

  it('without a probe a tracked migration stays advisory (never a blind delete)', () => {
    const p = plan(base, { probe: undefined });
    assert.deepEqual(p.deletions, []);
    assert.deepEqual(p.orphanedTracked, [`${PREFIX}20260821_x.sql`]);
  });

  it('a consumer-own file under a different directory is untouched by the new rule', () => {
    const p = planGarbageCollection({
      priorFiles: { 'supabase/migrations/001.sql': base }, intendedDests: new Set(), toolingDir: 'scripts/.claude-skills',
      exists: () => true, probe: () => ({ state: 'present', hash: base }), retirePrefixes: [PREFIX],
    });
    assert.deepEqual(p.deletions, []);
  });
});

describe('the "store behind this revision" refusal never advises --migrate for an orphan', () => {
  const CMD = 'node scripts/.claude-skills/setup-postgres.mjs --migrate';
  const dir = path.join(ROOT, '.audit-loop', 'migrations');
  const receipt = (held) => JSON.stringify({ recentSyncs: [{ retiredHeld: held }] });

  it('orphaned file: names it as orphaned, points at the sync, omits the command as advice', () => {
    const a = adviseForMissingMigrations({ missing: ['20260821_x.sql'], dir, command: CMD, retired: ['20260821_x.sql'] });
    assert.equal(a.advisesMigrate, false);
    assert.match(a.advice, /ORPHANED/);
    assert.match(a.advice, /re-run the consumer sync/);
    assert.match(a.advice, /Do NOT run/);
    assert.doesNotMatch(a.advice, /^Run:/m);
  });

  it('the full refusal for an orphan carries no "Run: ... --migrate" line', () => {
    const d = decideSchemaPrecondition({
      realization: { behind: true, missing: ['20260821_x.sql'], dir, db: null, command: CMD, retired: ['20260821_x.sql'] }, override: false,
    });
    assert.equal(d.proceed, false);
    assert.doesNotMatch(d.message, /^Run: /m);
    assert.match(d.message, /ORPHANED/);
  });

  it('a genuinely new file in a plain directory keeps the unchanged advice', () => {
    const d = decideSchemaPrecondition({
      realization: { behind: true, missing: ['030_new.sql'], dir: DIR, db: null, command: CMD }, override: false,
    });
    assert.match(d.message, /^Run: node scripts\/\.claude-skills\/setup-postgres\.mjs --migrate {6}then re-run this audit\./m);
  });

  it('unclassified file in a synced copy keeps the command but adds the retirement caution', () => {
    const a = adviseForMissingMigrations({ missing: ['030_new.sql'], dir, command: CMD, retired: [] });
    assert.equal(a.advisesMigrate, true);
    assert.match(a.advice, /^Run: /);
    assert.match(a.advice, /RETIRED upstream/);
  });

  it('reads the orphan set from the latest sync receipt, and only for a synced copy', () => {
    const read = () => receipt(['.audit-loop/migrations/20260821_x.sql', 'scripts/.claude-skills/other.mjs']);
    assert.deepEqual(readRetiredMigrationNames(dir, { read }), ['20260821_x.sql']);
    assert.deepEqual(readRetiredMigrationNames(DIR, { read }), [], 'the source checkout has no synced copy');
    assert.deepEqual(readRetiredMigrationNames(dir, { read: () => { throw new Error('ENOENT'); } }), [], 'unreadable receipt claims nothing');
    assert.deepEqual(readRetiredMigrationNames(dir, { read: () => '{not json' }), []);
  });
});

describe('the sync report names what it refused and what it held', () => {
  const c = { R: '', Y: '', D: '', X: '' };
  it('untracked source migrations are named, not failed; git unable to answer FAILS the target', () => {
    const named = describeUntrackedMigrations('gdr', c, () => ({ untracked: ['supabase/migrations/20260821_x.sql'] }));
    assert.equal(named.failed, false);
    assert.match(named.lines.join('\n'), /UNTRACKED source migration\(s\) not shipped to gdr[\s\S]*20260821_x\.sql/);
    assert.deepEqual(describeUntrackedMigrations('gdr', c, () => ({ untracked: [] })), { lines: [], failed: false });
    const broken = describeUntrackedMigrations('gdr', c, () => { throw new Error('git could not answer'); });
    assert.equal(broken.failed, true);
  });

  it('an override-declared retired migration is reported as a hold, naming the overrides file', () => {
    const none = { deletions: [], divergedHeld: [], unknownBaseHeld: [], probeFailed: [], unsafeKeys: [] };
    const lines = renderGcReport({
      gcPlan: { ...none, declaredHeld: ['.audit-loop/migrations/x.sql'] }, gcResult: { held: [], failed: [] },
      retiredHeld: ['.audit-loop/migrations/x.sql'], overridesPath: '.sync-overrides.json', colors: c,
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /hold .*x\.sql.*\.sync-overrides\.json declares this path as divergence/);
  });
});

describe('the receipt records every retired path that may still be on disk', () => {
  const none = { deletions: [], divergedHeld: [], declaredHeld: [], unknownBaseHeld: [], probeFailed: [] };
  it('a failed deletion is recorded, not only the held ones', () => {
    const r = retiredForReceipt({ gcPlan: none, gcResult: { failed: [{ path: '.audit-loop/migrations/b.sql', reason: 'EBUSY' }] }, retiredHeld: ['.audit-loop/migrations/a.sql'], gcSkipped: false });
    assert.deepEqual(r, ['.audit-loop/migrations/a.sql', '.audit-loop/migrations/b.sql']);
  });
  it('a gc skipped for the whole target still records every candidate', () => {
    const r = retiredForReceipt({
      gcPlan: { ...none, deletions: ['.audit-loop/migrations/a.sql'], probeFailed: [{ path: '.audit-loop/migrations/b.sql', reason: 'refused' }] },
      gcResult: { failed: [] }, retiredHeld: [], gcSkipped: true,
    });
    assert.deepEqual(r, ['.audit-loop/migrations/a.sql', '.audit-loop/migrations/b.sql']);
  });
});
