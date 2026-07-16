import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { executeTransaction, recoverFromJournal } from '../../scripts/lib/install/transaction.mjs';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-lifecycle-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function sha12(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12); }
const journalPath = () => path.join(tmp, '.audit-loop-install-txn.json');

describe('executeTransaction — multi-file writes', () => {
  it('writes all files and cleans up the journal', () => {
    const a = path.join(tmp, 'a.md');
    const b = path.join(tmp, 'nested', 'b.md');
    const r = executeTransaction({
      writes: [
        { absPath: a, content: Buffer.from('A') },
        { absPath: b, content: Buffer.from('B') },
      ],
      journalPath: journalPath(),
    });
    assert.equal(r.success, true);
    assert.equal(r.written, 2);
    assert.equal(fs.readFileSync(a, 'utf8'), 'A');
    assert.equal(fs.readFileSync(b, 'utf8'), 'B');
    assert.equal(fs.existsSync(journalPath()), false, 'journal should be cleaned up on success');
  });

  it('overwrites existing files atomically', () => {
    const a = path.join(tmp, 'a.md');
    fs.writeFileSync(a, 'old');
    const r = executeTransaction({
      writes: [{ absPath: a, content: Buffer.from('new') }],
      journalPath: journalPath(),
    });
    assert.equal(r.success, true);
    assert.equal(fs.readFileSync(a, 'utf8'), 'new');
  });
});

describe('executeTransaction — deletes with orphan protection', () => {
  it('deletes files whose expectedSha matches', () => {
    const a = path.join(tmp, 'stale.md');
    fs.writeFileSync(a, 'content');
    const expected = sha12(fs.readFileSync(a));
    const r = executeTransaction({
      writes: [],
      deletes: [{ absPath: a, expectedSha: expected }],
      journalPath: journalPath(),
    });
    assert.equal(r.success, true);
    assert.equal(r.deleted, 1);
    assert.equal(fs.existsSync(a), false);
    assert.equal(r.skippedDeletes.length, 0);
  });

  it('skips user-modified files via CONFLICT_DELETION_SKIPPED', () => {
    const a = path.join(tmp, 'modified.md');
    fs.writeFileSync(a, 'user changed it');
    const r = executeTransaction({
      writes: [],
      deletes: [{ absPath: a, expectedSha: 'deadbeefdead' }],
      journalPath: journalPath(),
    });
    assert.equal(r.success, true);
    assert.equal(r.deleted, 0);
    assert.equal(r.skippedDeletes.length, 1);
    assert.ok(r.skippedDeletes[0].reason.includes('CONFLICT_DELETION_SKIPPED'));
    assert.equal(fs.existsSync(a), true, 'user-modified file must remain');
  });

  it('no-op when delete target does not exist', () => {
    const a = path.join(tmp, 'missing.md');
    const r = executeTransaction({
      writes: [],
      deletes: [{ absPath: a, expectedSha: 'x' }],
      journalPath: journalPath(),
    });
    assert.equal(r.success, true);
    assert.equal(r.deleted, 0);
  });
});

describe('executeTransaction — crash-safe WAL journal', () => {
  it('leaves no .tmp files on successful commit', () => {
    const a = path.join(tmp, 'a.md');
    executeTransaction({
      writes: [{ absPath: a, content: Buffer.from('A') }],
      journalPath: journalPath(),
    });
    const remnants = fs.readdirSync(tmp).filter(f => f.includes('.tmp.'));
    assert.deepEqual(remnants, []);
  });

  it('writes journal during transaction and removes on success', () => {
    // We can't easily interpose the journal check mid-call, but success path
    // must end with no journal.
    const a = path.join(tmp, 'a.md');
    executeTransaction({
      writes: [{ absPath: a, content: Buffer.from('A') }],
      journalPath: journalPath(),
    });
    assert.equal(fs.existsSync(journalPath()), false);
  });
});

describe('recoverFromJournal', () => {
  it('returns recovered:false when no journal exists', () => {
    const r = recoverFromJournal(journalPath());
    assert.equal(r.recovered, false);
    assert.equal(r.rolledForward, 0);
    assert.equal(r.rolledBack, 0);
  });

  it('rolls back staged .tmp files from a crash in "staged" stage', () => {
    const target = path.join(tmp, 'a.md');
    const tmpStaged = path.join(tmp, 'a.md.tmp.999999');
    fs.writeFileSync(tmpStaged, 'staged content');
    // Simulate crash during staging — journal says staged, rename never happened
    fs.writeFileSync(journalPath(), JSON.stringify({
      stage: 'staged',
      staged: [{ absPath: target, tmpPath: tmpStaged }],
      deletes: [],
    }));

    const r = recoverFromJournal(journalPath());
    assert.equal(r.recovered, true);
    assert.equal(r.rolledBack, 1);
    assert.equal(fs.existsSync(tmpStaged), false, 'staged file should be removed');
    assert.equal(fs.existsSync(target), false, 'target should never have been created');
    assert.equal(fs.existsSync(journalPath()), false, 'journal should be cleaned');
  });

  it('rolls forward pending renames from a crash in "renaming" stage', () => {
    const targetA = path.join(tmp, 'a.md');
    const targetB = path.join(tmp, 'b.md');
    const stagedB = path.join(tmp, 'b.md.tmp.77777');

    // A already renamed (no tmp); B still in tmp form
    fs.writeFileSync(targetA, 'committed');
    fs.writeFileSync(stagedB, 'pending');
    fs.writeFileSync(journalPath(), JSON.stringify({
      stage: 'renaming',
      staged: [
        { absPath: targetA, tmpPath: path.join(tmp, 'a.md.tmp.77777') }, // tmp already gone
        { absPath: targetB, tmpPath: stagedB },
      ],
      deletes: [],
    }));

    const r = recoverFromJournal(journalPath());
    assert.equal(r.recovered, true);
    assert.equal(r.rolledForward, 1);
    assert.equal(fs.readFileSync(targetB, 'utf8'), 'pending');
    assert.equal(fs.existsSync(stagedB), false, 'staged file renamed into target');
    assert.equal(fs.existsSync(journalPath()), false);
  });

  it('handles corrupt journal gracefully', () => {
    fs.writeFileSync(journalPath(), '{not valid json');
    const r = recoverFromJournal(journalPath());
    assert.equal(r.recovered, false);
    assert.ok(r.error);
    assert.equal(fs.existsSync(journalPath()), false, 'corrupt journal removed to avoid loop');
  });
});

describe('executeTransaction — legacy array signature (backward compat)', () => {
  it('accepts Array<{absPath,content}> directly', () => {
    // The legacy array signature has no journalPath param, so
    // executeTransaction falls back to defaultJournalPath() =
    // path.resolve('.audit-loop-install-txn.json') — resolved against
    // process.cwd(). Every other test in this file isolates via an
    // explicit journalPath into `tmp`; this one can't, so it chdir's into
    // `tmp` instead — otherwise it writes+renames a REAL file at the repo
    // root on every run, which intermittently collided with a transient
    // Windows file-lock (antivirus real-time scan, Explorer indexing) and
    // produced a flaky EPERM on fs.renameSync under full-suite I/O load.
    //
    // Restored via try/finally, NOT t.after() — the suite-level afterEach
    // (line 11) rmSync's `tmp` right after this test returns, and Windows
    // refuses to remove a directory that is still the process cwd; the
    // restore must complete synchronously before the test function exits,
    // which try/finally guarantees and a t.after() callback (a separate,
    // later-queued hook) does not.
    const prevCwd = process.cwd();
    process.chdir(tmp);
    try {
      const a = path.join(tmp, 'a.md');
      const r = executeTransaction([{ absPath: a, content: Buffer.from('A') }]);
      assert.equal(r.success, true);
      assert.equal(r.written, 1);
      assert.equal(fs.readFileSync(a, 'utf8'), 'A');
    } finally {
      process.chdir(prevCwd);
    }
  });
});
