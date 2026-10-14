/**
 * @fileoverview Regression pins for the /audit-code round-1 findings on the
 * per-entry debt ledger (docs/plans/debt-ledger-per-entry-files.md). Each test
 * names the defect it holds shut and was seen RED against the code it fixes.
 *
 *  - `__proto__` is a JSON key like any other (silent loss in bytes + equality)
 *  - one sanitised git environment for every repository query
 *  - a bounded synchronous git call under the ledger lock
 *  - a baseline whose own copies disagree is a conflict, not "absent"
 *  - "cannot read the baseline" is an error, not "the path is absent"
 *  - a tracked ledger never leaves a remainder behind in the legacy file
 *  - the CLI's argument parsing: `--`, last-wins, an empty value is an error
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readDebtLedger, serializeLedgerForDisk } from '../scripts/lib/debt-ledger.mjs';
import {
  serializeEntryForDisk, canonicalEqual, legacyTrackingState, runGit,
} from '../scripts/lib/debt-ledger-files.mjs';
import { _internals } from '../scripts/lib/debt-ledger-migration.mjs';
import { gitFixtureEnv, gitInit, makeGitRunner, mkdtemp, rmrfBestEffort } from './helpers/fixtures.mjs';

const CLI = path.resolve(import.meta.dirname, '..', 'scripts', 'debt-ledger-migrate.mjs');
const REINCLUDE = '.audit/*\n!.audit/tech-debt/\n';

let dir;
let git;
let ledgerPath;

function makeEntry(topicId, overrides = {}) {
  return {
    source: 'debt', topicId, semanticHash: `h-${topicId}`, severity: 'MEDIUM', category: 'test',
    section: `src/${topicId}.js:1`, detailSnapshot: `details for ${topicId}`, affectedFiles: [`src/${topicId}.js`],
    affectedPrinciples: [], pass: 'backend', deferredReason: 'out-of-scope', deferredAt: '2026-10-01T10:00:00.000Z',
    deferredRun: 'r1', deferredRationale: `a sufficiently long rationale string for ${topicId}`, contentAliases: [],
    sensitive: false, classificationUnavailableReason: 'not-provided-by-capture-source', ...overrides,
  };
}

function cli(args, { cwd = dir, env = gitFixtureEnv() } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf-8' });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report };
}
function writeLegacy(entries) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, serializeLedgerForDisk({ version: 1, entries }));
}
function commitAll(message) {
  git(['add', '-A']);
  git(['add', '-f', '.audit/tech-debt.json']);
  git(['commit', '-q', '-m', message]);
}

beforeEach(() => {
  dir = mkdtemp('debt-migrate-hardening-');
  gitInit(dir);
  git = makeGitRunner(() => dir);
  git(['checkout', '-q', '-b', 'main']);
  ledgerPath = path.join(dir, '.audit', 'tech-debt.json');
});
afterEach(() => { rmrfBestEffort(dir); });

describe('canonical bytes treat every JSON key as data', () => {
  const withProto = JSON.parse('{"topicId":"t","__proto__":{"polluted":1},"nested":{"__proto__":"x"}}');

  test('a `__proto__` key survives serialisation, at any depth', () => {
    assert.ok(Object.hasOwn(withProto, '__proto__'), 'fixture: JSON.parse made it an own property');
    const round = JSON.parse(serializeEntryForDisk(withProto));
    assert.ok(Object.hasOwn(round, '__proto__'), 'top-level key kept');
    assert.deepEqual(Object.getOwnPropertyDescriptor(round, '__proto__').value, { polluted: 1 });
    assert.ok(Object.hasOwn(round.nested, '__proto__'), 'nested key kept');
    assert.equal(({}).polluted, undefined, 'and nothing leaked onto Object.prototype');
  });

  test('canonical equality tells two entries apart that differ only in a `__proto__` value', () => {
    const other = JSON.parse('{"topicId":"t","__proto__":{"polluted":2},"nested":{"__proto__":"x"}}');
    assert.equal(canonicalEqual(withProto, other), false);
    assert.equal(canonicalEqual(withProto, JSON.parse(JSON.stringify(withProto))), true);
  });
});

describe('one sanitised git environment', () => {
  test('an inherited GIT_INDEX_FILE does not change whether the legacy file is tracked', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), REINCLUDE);
    writeLegacy([makeEntry('topic-0001')]);
    commitAll('legacy ledger');
    assert.equal(legacyTrackingState(ledgerPath), 'tracked', 'control: tracked without the variable');
    const saved = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = path.join(dir, 'no-such-index');
    try {
      assert.equal(legacyTrackingState(ledgerPath), 'tracked', 'a hook\'s temporary index must not flip the answer');
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved;
    }
  });

  test('a wedged git call is bounded, and reported as an error', () => {
    const t0 = Date.now();
    const r = runGit(['-c', 'alias.hang=!node -e "setTimeout(()=>{},8000)"', 'hang'], dir, { timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 5000, 'returned long before the child would have');
    assert.ok(r.error, 'a timeout surfaces as `error`, which every caller maps to unknown/refused');
    assert.equal(runGit(['--version'], dir).status, 0, 'vacuous-pass guard: ordinary calls still succeed');
  });
});

describe('reading the baseline', () => {
  test('absent path -> null; any other git failure throws', () => {
    fs.writeFileSync(path.join(dir, 'present.json'), '{}');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'one']);
    assert.equal(_internals.gitShowJson(dir, 'HEAD', 'missing.json'), null, 'a path the revision lacks is absent');
    assert.equal(_internals.gitShowJson(dir, 'HEAD', 'present.json'), '{}');
    assert.throws(() => _internals.gitShowJson(dir, 'no-such-revision', 'present.json'), /git ls-tree failed/);
    assert.throws(() => _internals.gitShowJson(path.join(dir, 'not-a-repo'), 'HEAD', 'present.json'), /git ls-tree failed/);
  });

  test('a baseline whose own copies of an id disagree is a conflict, never "absent from the baseline"', () => {
    // base: X appears twice with different content. The stale branch collapses it to one copy; main
    // deletes X outright and migrates. Read as "absent from the baseline" the table would see
    // (b absent, d absent) -> apply, and resurrect X. The baseline never said what X was.
    fs.writeFileSync(path.join(dir, '.gitignore'), REINCLUDE);
    writeLegacy([makeEntry('topic-x', { severity: 'HIGH' }), makeEntry('topic-x', { severity: 'LOW' }), makeEntry('topic-a')]);
    commitAll('base: duplicate x');
    git(['checkout', '-q', '-b', 'stale']);
    writeLegacy([makeEntry('topic-x', { severity: 'HIGH' }), makeEntry('topic-a'), makeEntry('topic-c')]);
    commitAll('stale: collapse x, add c');
    git(['checkout', '-q', 'main']);
    writeLegacy([makeEntry('topic-a')]);
    commitAll('main: drop x');
    const m = cli(['--json']);
    assert.equal(m.status, 0, m.stdout + m.stderr);
    spawnSync('sh', ['-c', m.report.stageCommand], { cwd: dir, env: gitFixtureEnv() });
    git(['commit', '-q', '-m', 'migrate the debt ledger']);
    const merge = spawnSync('git', ['merge', '--no-edit', 'stale'], { cwd: dir, env: gitFixtureEnv(), encoding: 'utf-8' });
    assert.equal(merge.status, 1, 'modify/delete on the legacy file');
    git(['add', '-f', '.audit/tech-debt.json']);
    git(['commit', '-q', '--no-edit']);

    const r = cli(['--json', '--stale-ref', 'HEAD^2']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(r.report.conflicts.map((c) => [c.topicId, c.reason]), [['topic-x', 'baseline-duplicate-copies-differ']]);
    const ids = readDebtLedger({ ledgerPath, events: [] }).entries.map((e) => e.topicId);
    assert.ok(!ids.includes('topic-x'), 'X was not resurrected');
    assert.ok(!ids.includes('topic-c'), 'and nothing was applied');
    assert.equal(cli(['--json', '--stale-ref', 'HEAD^2', '--prefer', 'legacy']).status, 1, 'unresolvable even with --prefer');
  });
});

describe('a tracked ledger never leaves entries behind in the legacy file', () => {
  test('an unmigratable id refuses the whole migration; nothing is created or shrunk', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), REINCLUDE);
    writeLegacy([makeEntry('topic-0001'), makeEntry('has a space'), makeEntry('topic-0003')]);
    commitAll('legacy ledger with one id that cannot be a filename');
    const before = fs.readFileSync(ledgerPath, 'utf-8');
    const r = cli(['--json']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.report.reason, /unmigratable-entries/);
    assert.deepEqual(r.report.conflicts.map((c) => c.topicId), ['has a space']);
    assert.equal(fs.readFileSync(ledgerPath, 'utf-8'), before, 'legacy file untouched');
    assert.equal(fs.existsSync(path.join(dir, '.audit', 'tech-debt')), false, 'no directory published');
    assert.deepEqual(readDebtLedger({ ledgerPath, events: [] }).entries.map((e) => e.topicId).sort(),
      ['has a space', 'topic-0001', 'topic-0003'], 'every entry still suppresses');
  });
});

describe('debt-ledger-migrate argument parsing', () => {
  function legacyAt(file, ids) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeLedgerForDisk({ version: 1, entries: ids.map((id) => makeEntry(id)) }));
  }

  test('an explicitly empty value is an error, never the default ledger', () => {
    legacyAt(ledgerPath, ['topic-0001']);
    for (const args of [['--ledger', ''], ['--ledger='], ['--prefer', ''], ['--stale-ref=']]) {
      const r = cli(['--json', ...args]);
      assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /needs a non-empty value/);
    }
    assert.ok(fs.existsSync(ledgerPath), 'the default ledger was not touched');
    assert.equal(cli(['--json', '--ledger', ledgerPath]).status, 0, 'vacuous-pass guard: the same ledger migrates when asked for by name');
  });

  test('the last occurrence wins, whichever spelling it uses', () => {
    const real = path.join(dir, 'real', 'tech-debt.json');
    const other = path.join(dir, 'other', 'tech-debt.json');
    legacyAt(real, ['topic-0001']);
    legacyAt(other, ['topic-0002']);
    const r = cli(['--json', `--ledger=${real}`, '--ledger', other]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(real), 'the earlier `=` spelling did not outrank the later one');
    assert.ok(!fs.existsSync(other), 'the later flag was migrated');
  });

  test('nothing after the `--` terminator is read as an option', () => {
    // dir copy and legacy copy differ -> refused without --prefer; a --prefer AFTER `--` must not resolve it.
    const plain = mkdtemp('debt-migrate-term-');
    try {
      const file = path.join(plain, 'tech-debt.json');
      legacyAt(file, ['topic-0001']);
      const entries = path.join(plain, 'tech-debt', 'entries');
      fs.mkdirSync(entries, { recursive: true });
      fs.writeFileSync(path.join(entries, 'topic-0001.json'), `${JSON.stringify(makeEntry('topic-0001', { severity: 'HIGH' }), null, 2)}\n`);
      const r = cli(['--json', '--ledger', file, '--', '--prefer', 'legacy']);
      assert.equal(r.status, 1, 'refused: the --prefer was a positional');
      assert.deepEqual(r.report.conflicts.map((c) => c.topicId), ['topic-0001']);
      assert.equal(cli(['--json', '--ledger', file, '--prefer', 'legacy']).status, 0, 'vacuous-pass guard: before the terminator it resolves');
    } finally {
      rmrfBestEffort(plain);
    }
  });
});

describe('a link above the ledger directory is refused (audit-code r1 H3)', () => {
  // `.audit/*` ignores the children of `.audit`, not `.audit` itself, so a commit can replace the
  // directory with a tracked link to another checkout's `.audit`. Junctions need no privilege on Windows.
  function linkAuditTo(target) {
    try {
      fs.symlinkSync(target, path.join(dir, '.audit'), process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return false;
      throw err;
    }
  }

  test('reads and every writer refuse; the other checkout\'s ledger is not touched', async (t) => {
    const other = mkdtemp('debt-other-checkout-');
    try {
      fs.mkdirSync(path.join(other, 'tech-debt', 'entries'), { recursive: true });
      const victim = path.join(other, 'tech-debt', 'entries', 'topic-0001.json');
      fs.writeFileSync(victim, `${JSON.stringify(makeEntry('topic-0001'), null, 2)}\n`);
      if (!linkAuditTo(other)) { t.skip('cannot create a link here (no privilege) — not a pass'); return; }
      const { writeDebtEntries, removeDebtEntry } = await import('../scripts/lib/debt-ledger.mjs');
      const before = fs.readFileSync(victim, 'utf-8');
      assert.throws(() => readDebtLedger({ ledgerPath, events: [] }), /symbolic link above the ledger directory/);
      await assert.rejects(writeDebtEntries([makeEntry('topic-0002')], { ledgerPath }), /symbolic link above the ledger directory/);
      await assert.rejects(removeDebtEntry('topic-0001', { ledgerPath }), /symbolic link above the ledger directory/);
      assert.equal(fs.readFileSync(victim, 'utf-8'), before, 'the linked-to ledger was neither rewritten nor deleted');
      assert.equal(fs.readdirSync(path.join(other, 'tech-debt', 'entries')).length, 1, 'and nothing was added to it');
    } finally {
      try { fs.rmSync(path.join(dir, '.audit'), { force: true, recursive: false }); } catch { /* junction */ }
      rmrfBestEffort(other);
    }
  });

  test('vacuous-pass guard: the same ledger is readable through a real .audit directory', () => {
    fs.mkdirSync(path.join(dir, '.audit', 'tech-debt', 'entries'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.audit', 'tech-debt', 'entries', 'topic-0001.json'), `${JSON.stringify(makeEntry('topic-0001'), null, 2)}\n`);
    assert.deepEqual(readDebtLedger({ ledgerPath, events: [] }).entries.map((e) => e.topicId), ['topic-0001']);
  });
});
