/**
 * @fileoverview `debt-ledger-migrate.mjs` and the migration it drives — on real
 * git repositories (docs/plans/debt-ledger-per-entry-files.md §2.5, §9).
 *
 * What is pinned here, and why each matters:
 *  - A COMMITTED ledger is only ever moved when every destination it would move
 *    to is trackable. Deleting a tracked file and creating ignored replacements
 *    would make entries vanish from the repository while looking fine on disk —
 *    so the check runs over the real destination manifest, not a probe path.
 *  - A stale branch's legacy file, merged back after the migration, is
 *    reconciled THREE-WAY against its own merge-base — absence from the
 *    per-entry directory cannot say "deleted after migration" vs "never
 *    migrated", and treating it as either resurrects or loses entries.
 *  - Every refusal changes nothing.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readDebtLedger, writeDebtEntries, removeDebtEntry, serializeLedgerForDisk } from '../scripts/lib/debt-ledger.mjs';
import { migrateLegacyLedger } from '../scripts/lib/debt-ledger-migration.mjs';
import { gitFixtureEnv, gitInit, makeGitRunner, mkdtemp, rmrfBestEffort } from './helpers/fixtures.mjs';

const CLI = path.resolve(import.meta.dirname, '..', 'scripts', 'debt-ledger-migrate.mjs');
const REINCLUDE = '.audit/*\n!.audit/tech-debt/\n';

let dir;
let git;
let ledgerPath;

function makeEntry(topicId, overrides = {}) {
  return {
    source: 'debt',
    topicId,
    semanticHash: `h-${topicId}`,
    severity: 'MEDIUM',
    category: 'test',
    section: `src/${topicId}.js:1`,
    detailSnapshot: `details for ${topicId}`,
    affectedFiles: [`src/${topicId}.js`],
    affectedPrinciples: [],
    pass: 'backend',
    deferredReason: 'out-of-scope',
    deferredAt: '2026-10-01T10:00:00.000Z',
    deferredRun: 'r1',
    deferredRationale: `a sufficiently long rationale string for ${topicId}`,
    contentAliases: [],
    sensitive: false,
    classificationUnavailableReason: 'not-provided-by-capture-source',
    ...overrides,
  };
}

function cli(args, { cwd = dir, env = gitFixtureEnv() } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report: tryJson(r.stdout) };
}
function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

function writeLegacy(entries, extra = {}) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, serializeLedgerForDisk({ version: 1, ...extra, entries }));
}
function commitAll(message) {
  git(['add', '-A']);
  git(['add', '-f', '.audit/tech-debt.json']);
  git(['commit', '-q', '-m', message]);
}
const ids = () => readDebtLedger({ ledgerPath, events: [] }).entries.map((e) => e.topicId).sort();

beforeEach(() => {
  dir = mkdtemp('debt-migrate-cli-');
  gitInit(dir);
  git = makeGitRunner(() => dir);
  git(['checkout', '-q', '-b', 'main']);
  ledgerPath = path.join(dir, '.audit', 'tech-debt.json');
});
afterEach(() => { rmrfBestEffort(dir); });

/** A committed legacy ledger under the given ignore rules. */
function trackedLegacy(gitignore, entries = ['topic-0001', 'topic-0002', 'topic-0003'].map((id) => makeEntry(id)), extra = {}) {
  fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
  writeLegacy(entries, extra);
  commitAll('legacy ledger');
}

describe('tracked legacy ledger — trackability of every destination', () => {
  test('refuses, changing nothing, when the per-entry directory would be ignored', () => {
    trackedLegacy('.audit/*\n');
    const before = fs.readFileSync(ledgerPath, 'utf-8');
    const r = cli(['--json']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.report.reason, /destination-ignored/);
    assert.ok(r.report.ignored.length >= 3);
    assert.equal(fs.readFileSync(ledgerPath, 'utf-8'), before, 'legacy intact');
    assert.equal(fs.existsSync(path.join(dir, '.audit', 'tech-debt')), false, 'nothing created');
  });

  test('migrates when the directory is re-included, and the printed staging command stages exactly the move', () => {
    trackedLegacy(REINCLUDE);
    const r = cli(['--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.report.mode, 'initial');
    assert.equal(r.report.written.length, 3);
    assert.equal(fs.existsSync(ledgerPath), false, 'legacy file removed');
    assert.deepEqual(ids(), ['topic-0001', 'topic-0002', 'topic-0003']);
    const st = spawnSync('sh', ['-c', r.report.stageCommand], { cwd: dir, env: gitFixtureEnv(), encoding: 'utf-8' });
    assert.equal(st.status, 0, st.stderr);
    const staged = git(['diff', '--cached', '--name-status']).trim().split('\n').sort();
    assert.deepEqual(staged, [
      'A\t.audit/tech-debt/entries/topic-0001.json',
      'A\t.audit/tech-debt/entries/topic-0002.json',
      'A\t.audit/tech-debt/entries/topic-0003.json',
      'D\t.audit/tech-debt.json',
    ]);
  });

  test('an id-specific ignore rule refuses the whole migration and names the path', () => {
    trackedLegacy(`${REINCLUDE}.audit/tech-debt/entries/topic-0002.json\n`);
    const r = cli(['--json']);
    assert.equal(r.status, 1);
    assert.deepEqual(r.report.ignored, ['.audit/tech-debt/entries/topic-0002.json']);
    assert.ok(fs.existsSync(ledgerPath));
    assert.equal(fs.existsSync(path.join(dir, '.audit', 'tech-debt')), false);
  });

  test('a budgets.json-only ignore rule refuses too', () => {
    trackedLegacy(`${REINCLUDE}.audit/tech-debt/budgets.json\n`, undefined, { budgets: { 'src/**': 3 } });
    const r = cli(['--json']);
    assert.equal(r.status, 1);
    assert.deepEqual(r.report.ignored, ['.audit/tech-debt/budgets.json']);
    assert.ok(fs.existsSync(ledgerPath));
  });

  test('an interrupted migration retried after an ignore rule appeared refuses — legacy NOT deleted', () => {
    trackedLegacy(REINCLUDE);
    // Simulate: the copy was published, the process died before deleting the legacy file.
    assert.equal(cli(['--json', '--dry-run']).status, 0);
    for (const id of ['topic-0001', 'topic-0002', 'topic-0003']) {
      const f = path.join(dir, '.audit', 'tech-debt', 'entries', `${id}.json`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `${JSON.stringify(Object.fromEntries(Object.entries(makeEntry(id)).sort()), null, 2)}\n`);
    }
    fs.appendFileSync(path.join(dir, '.gitignore'), '.audit/tech-debt/entries/topic-0003.json\n');
    const r = cli(['--json']);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.report.mode, 'resumed');
    assert.deepEqual(r.report.ignored, ['.audit/tech-debt/entries/topic-0003.json'], 'checked although nothing remains to write');
    assert.ok(fs.existsSync(ledgerPath), 'legacy kept');
  });

  test('a custom --ledger with a space in its path, run from another cwd, gets a staging command that works', () => {
    const sub = path.join(dir, 'my ledgers');
    fs.mkdirSync(sub);
    ledgerPath = path.join(sub, 'debt.json');
    fs.writeFileSync(path.join(dir, '.gitignore'), '');
    writeLegacy([makeEntry('topic-0001')]);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'custom ledger']);
    const elsewhere = mkdtemp('debt-migrate-cwd-');
    try {
      const r = cli(['--json', '--ledger', ledgerPath], { cwd: elsewhere });
      assert.equal(r.status, 0, r.stderr);
      const st = spawnSync('sh', ['-c', r.report.stageCommand], { cwd: elsewhere, env: gitFixtureEnv(), encoding: 'utf-8' });
      assert.equal(st.status, 0, st.stderr);
      const staged = git(['diff', '--cached', '--name-status']).trim().split('\n').sort();
      assert.deepEqual(staged, ['A\tmy ledgers/debt/entries/topic-0001.json', 'D\tmy ledgers/debt.json']);
    } finally {
      rmrfBestEffort(elsewhere);
    }
  });

  test('git unavailable → refused, nothing changed', () => {
    trackedLegacy(REINCLUDE);
    const env = { ...gitFixtureEnv(), PATH: path.dirname(process.execPath), Path: path.dirname(process.execPath) };
    const r = cli(['--json'], { env });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.report.reason, /tracking-unknown/);
    assert.ok(fs.existsSync(ledgerPath));
  });

  test('--dry-run writes nothing', () => {
    trackedLegacy(REINCLUDE);
    const r = cli(['--json', '--dry-run']);
    assert.equal(r.status, 0);
    assert.equal(r.report.dryRun, true);
    assert.equal(r.report.written.length, 3);
    assert.equal(fs.existsSync(path.join(dir, '.audit', 'tech-debt')), false);
    assert.ok(fs.existsSync(ledgerPath));
  });
});

describe('staged publication', () => {
  test('a half-built migration is never visible: readers see the complete legacy ledger until the rename', async () => {
    trackedLegacy(REINCLUDE);
    let seen = null;
    const report = await migrateLegacyLedger(ledgerPath, {
      onStaged: () => {
        assert.equal(fs.existsSync(path.join(dir, '.audit', 'tech-debt')), false, 'not published yet');
        seen = ids();
      },
    });
    assert.equal(report.ok, true);
    assert.deepEqual(seen, ['topic-0001', 'topic-0002', 'topic-0003'], 'the reader mid-migration got everything');
    assert.deepEqual(ids(), ['topic-0001', 'topic-0002', 'topic-0003']);
  });

  test('a leftover staging directory is discarded and rebuilt; readers never list it', async () => {
    trackedLegacy(REINCLUDE);
    const staging = path.join(dir, '.audit', 'tech-debt.migrating', 'entries');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'junk.json'), '{"topicId":"junk"}\n');
    assert.deepEqual(ids(), ['topic-0001', 'topic-0002', 'topic-0003']);
    const report = await migrateLegacyLedger(ledgerPath);
    assert.equal(report.ok, true);
    assert.deepEqual(ids(), ['topic-0001', 'topic-0002', 'topic-0003'], 'junk from the dead run did not leak in');
    assert.equal(fs.existsSync(path.join(dir, '.audit', 'tech-debt.migrating')), false);
  });
});

describe('differing copies are refused, never picked', () => {
  // Untracked both-forms state (no git repo needed): an interrupted automatic migration.
  function untrackedBoth({ legacy, dirEntries, legacyBudgets, dirBudgets }) {
    const plain = mkdtemp('debt-migrate-nogit-');
    ledgerPath = path.join(plain, 'tech-debt.json');
    writeLegacy(legacy, legacyBudgets === undefined ? {} : { budgets: legacyBudgets });
    const entriesDir = path.join(plain, 'tech-debt', 'entries');
    fs.mkdirSync(entriesDir, { recursive: true });
    for (const e of dirEntries) fs.writeFileSync(path.join(entriesDir, `${e.topicId}.json`), `${JSON.stringify(e, null, 2)}\n`);
    if (dirBudgets !== undefined) fs.writeFileSync(path.join(plain, 'tech-debt', 'budgets.json'), JSON.stringify(dirBudgets));
    return plain;
  }

  test('a differing copy is listed, kept visible, refused by writers, and resolved only by --prefer', async () => {
    const plain = untrackedBoth({
      legacy: [makeEntry('topic-0001', { deferredRationale: 'the legacy copy says this rationale' }), makeEntry('topic-0002')],
      dirEntries: [makeEntry('topic-0001', { deferredRationale: 'the directory copy says that rationale' })],
    });
    try {
      const read = readDebtLedger({ ledgerPath, events: [] });
      assert.deepEqual(read.conflicts.map((c) => c.topicId), ['topic-0001']);
      assert.ok(read.entries.some((e) => e.topicId === 'topic-0001'), 'conflicted id stays visible (its directory copy)');
      const w = await writeDebtEntries([makeEntry('topic-0001')], { ledgerPath });
      assert.deepEqual(w.rejected.map((x) => x.reason), ['topicId-unresolved-conflict']);
      await assert.rejects(removeDebtEntry('topic-0001', { ledgerPath }), /unresolved conflict/);
      const refused = cli(['--json', '--ledger', ledgerPath]);
      assert.equal(refused.status, 1);
      assert.deepEqual(refused.report.conflicts.map((c) => c.topicId), ['topic-0001']);
      const ok = cli(['--json', '--ledger', ledgerPath, '--prefer', 'legacy']);
      assert.equal(ok.status, 0, ok.stdout);
      const after = readDebtLedger({ ledgerPath, events: [] });
      assert.deepEqual(after.conflicts, []);
      assert.equal(after.entries.find((e) => e.topicId === 'topic-0001').deferredRationale, 'the legacy copy says this rationale');
      assert.equal(fs.existsSync(ledgerPath), false);
    } finally {
      rmrfBestEffort(plain);
    }
  });

  test('duplicate legacy copies that differ are never resolved by --prefer', () => {
    const plain = untrackedBoth({
      legacy: [makeEntry('topic-0001', { severity: 'HIGH' }), makeEntry('topic-0001', { severity: 'LOW' })],
      dirEntries: [],
    });
    try {
      const r = cli(['--json', '--ledger', ledgerPath, '--prefer', 'legacy']);
      assert.equal(r.status, 1);
      assert.equal(r.report.conflicts[0].reason, 'legacy-duplicate-copies-differ');
      assert.ok(fs.existsSync(ledgerPath), 'remainder kept');
    } finally {
      rmrfBestEffort(plain);
    }
  });

  test('budgets: absent and empty differ; a real difference needs --prefer', () => {
    let plain = untrackedBoth({ legacy: [], dirEntries: [], legacyBudgets: {} });
    try {
      assert.equal(cli(['--json', '--ledger', ledgerPath]).status, 0);
      assert.deepEqual(readDebtLedger({ ledgerPath, events: [] }).budgets, {});
      assert.ok(fs.existsSync(path.join(plain, 'tech-debt', 'budgets.json')), 'an empty policy is still a policy');
    } finally { rmrfBestEffort(plain); }

    plain = untrackedBoth({ legacy: [], dirEntries: [], dirBudgets: { 'a/**': 1 } });
    try {
      assert.equal(cli(['--json', '--ledger', ledgerPath]).status, 0);
      assert.deepEqual(readDebtLedger({ ledgerPath, events: [] }).budgets, { 'a/**': 1 }, 'absent legacy budgets leave budgets.json alone');
    } finally { rmrfBestEffort(plain); }

    plain = untrackedBoth({ legacy: [], dirEntries: [], legacyBudgets: { 'a/**': 2 }, dirBudgets: { 'a/**': 1 } });
    try {
      const r = cli(['--json', '--ledger', ledgerPath]);
      assert.equal(r.status, 1);
      assert.deepEqual(r.report.conflicts.map((c) => c.topicId), ['budgets']);
      assert.equal(cli(['--json', '--ledger', ledgerPath, '--prefer', 'legacy']).status, 0);
      assert.deepEqual(readDebtLedger({ ledgerPath, events: [] }).budgets, { 'a/**': 2 });
    } finally { rmrfBestEffort(plain); }
  });
});

describe('stale-branch reconcile — three-way against the merge-base', () => {
  /**
   * fork {A}; stale branch adds C; main adds B AND edits A (after the fork,
   * before migrating — the case an M^ baseline gets wrong), migrates (M), then
   * deletes A. The stale branch is merged back, keeping its legacy file.
   */
  async function staleMerge({ staleEdits } = {}) {
    trackedLegacy(REINCLUDE, [makeEntry('topic-a')]);
    git(['checkout', '-q', '-b', 'stale']);
    await writeDebtEntries([makeEntry('topic-c')], { ledgerPath });
    if (staleEdits) await staleEdits();
    commitAll('stale: legacy edits');
    git(['checkout', '-q', 'main']);
    await writeDebtEntries([makeEntry('topic-b'), makeEntry('topic-a', { severity: 'HIGH' })], { ledgerPath });
    commitAll('main: add b, edit a');
    const m = cli(['--json']);
    assert.equal(m.status, 0, m.stdout + m.stderr);
    spawnSync('sh', ['-c', m.report.stageCommand], { cwd: dir, env: gitFixtureEnv() });
    git(['commit', '-q', '-m', 'migrate the debt ledger']);
    assert.equal(await removeDebtEntry('topic-a', { ledgerPath }), true);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'main: resolve a']);
    const merge = spawnSync('git', ['merge', '--no-edit', 'stale'], { cwd: dir, env: gitFixtureEnv(), encoding: 'utf-8' });
    assert.equal(merge.status, 1, 'modify/delete on the legacy file');
    git(['add', '-f', '.audit/tech-debt.json']); // keep it, per the runbook
    git(['commit', '-q', '--no-edit']);
  }

  test('the kept legacy file is ignored by readers; reconcile applies only the stale branch\'s own changes', async () => {
    await staleMerge();
    const before = readDebtLedger({ ledgerPath, events: [] });
    assert.deepEqual(before.entries.map((e) => e.topicId), ['topic-b'], 'A not resurrected, C not yet visible');
    assert.deepEqual(before.pendingReconcile.legacyOnly.sort(), ['topic-a', 'topic-c']);

    const noRef = cli(['--json']);
    assert.equal(noRef.status, 1);
    assert.match(noRef.report.reason, /stale-ref-required/);

    // The runbook's spelling: the stale branch was merged INTO main, so its
    // pre-merge tip is the merge commit's second parent. The first parent is
    // main's side, which contains the migration commit — refused.
    const wrongSide = cli(['--json', '--stale-ref', 'HEAD^1']);
    assert.equal(wrongSide.status, 1);
    assert.match(wrongSide.report.reason, /stale-ref-contains-migration/);

    const r = cli(['--json', '--stale-ref', 'HEAD^2']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.report.mode, 'stale-reconcile');
    assert.deepEqual(ids(), ['topic-b', 'topic-c'], 'B kept (the stale branch never had it), A stays deleted, C arrives');
    assert.equal(fs.existsSync(ledgerPath), false);
    assert.equal(cli(['--json', '--stale-ref', 'stale']).report.action, 'nothing-to-do', 'idempotent');
  });

  test('a stale-side deletion of an untouched id deletes it; a two-sided edit applies nothing until --prefer', async () => {
    trackedLegacy(REINCLUDE, [makeEntry('topic-a'), makeEntry('topic-d'), makeEntry('topic-e')]);
    git(['checkout', '-q', '-b', 'stale']);
    assert.equal(await removeDebtEntry('topic-d', { ledgerPath }), true);
    await writeDebtEntries([makeEntry('topic-e', { deferredRationale: 'stale rewrote the rationale of e' })], { ledgerPath });
    commitAll('stale: delete d, edit e');
    git(['checkout', '-q', 'main']);
    const m = cli(['--json']);
    spawnSync('sh', ['-c', m.report.stageCommand], { cwd: dir, env: gitFixtureEnv() });
    git(['commit', '-q', '-m', 'migrate']);
    await writeDebtEntries([makeEntry('topic-e', { deferredRationale: 'main rewrote the rationale of e' })], { ledgerPath });
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'main: edit e']);
    spawnSync('git', ['merge', '--no-edit', 'stale'], { cwd: dir, env: gitFixtureEnv() });
    git(['add', '-f', '.audit/tech-debt.json']);
    git(['commit', '-q', '--no-edit']);

    const refused = cli(['--json', '--stale-ref', 'stale']);
    assert.equal(refused.status, 1);
    assert.deepEqual(refused.report.conflicts.map((c) => c.topicId), ['topic-e']);
    assert.deepEqual(ids(), ['topic-a', 'topic-d', 'topic-e'], 'nothing applied — not even the uncontested deletion of d');

    const ok = cli(['--json', '--stale-ref', 'stale', '--prefer', 'legacy']);
    assert.equal(ok.status, 0, ok.stdout);
    assert.deepEqual(ids(), ['topic-a', 'topic-e']);
    const e = readDebtLedger({ ledgerPath, events: [] }).entries.find((x) => x.topicId === 'topic-e');
    assert.equal(e.deferredRationale, 'stale rewrote the rationale of e');
  });

  test('a retry after a partial apply converges on the same result', async () => {
    await staleMerge();
    // As if a previous run wrote C and then died.
    const cFile = path.join(dir, '.audit', 'tech-debt', 'entries', 'topic-c.json');
    const legacyC = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries.find((e) => e.topicId === 'topic-c');
    fs.writeFileSync(cFile, `${JSON.stringify(Object.fromEntries(Object.entries(legacyC).sort()), null, 2)}\n`);
    const r = cli(['--json', '--stale-ref', 'stale']);
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(ids(), ['topic-b', 'topic-c']);
  });

  test('provenance: a hand-edited legacy file is refused; a CRLF checkout of the same file is not', async () => {
    await staleMerge();
    const original = fs.readFileSync(ledgerPath, 'utf-8');
    fs.writeFileSync(ledgerPath, original.replace('details for topic-c', 'hand edited'));
    const edited = cli(['--json', '--stale-ref', 'stale']);
    assert.equal(edited.status, 1);
    assert.match(edited.report.reason, /provenance-mismatch/);

    git(['config', 'core.autocrlf', 'true']);
    fs.writeFileSync(ledgerPath, original.replace(/\r?\n/g, '\r\n'));
    const crlf = cli(['--json', '--stale-ref', 'stale']);
    assert.equal(crlf.status, 0, crlf.stdout + crlf.stderr);
  });

  test('superseding with a legacy-only id is refused until the reconcile makes it authoritative', async () => {
    await staleMerge();
    const { markSuperseded } = await import('../scripts/lib/debt-ledger.mjs');
    assert.deepEqual(await markSuperseded('topic-b', 'topic-c', { ledgerPath }), { ok: false, error: 'new-topic-not-found' });
    assert.equal(cli(['--json', '--stale-ref', 'stale']).status, 0);
    assert.deepEqual(await markSuperseded('topic-b', 'topic-c', { ledgerPath }), { ok: true });
  });

  test('a shallow clone cannot locate the migration commit — refuse rather than fold', async () => {
    await staleMerge();
    const shallow = mkdtemp('debt-migrate-shallow-');
    try {
      const c = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${dir.split(path.sep).join('/')}`, shallow], { env: gitFixtureEnv(), encoding: 'utf-8' });
      assert.equal(c.status, 0, c.stderr);
      const r = cli(['--json', '--ledger', path.join(shallow, '.audit', 'tech-debt.json')], { cwd: shallow });
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.report.reason, /shallow clone/);
      assert.ok(fs.existsSync(path.join(shallow, '.audit', 'tech-debt.json')));
    } finally {
      rmrfBestEffort(shallow);
    }
  });
});
