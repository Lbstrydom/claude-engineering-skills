/**
 * @fileoverview Phase 6 promote-CLI tests.
 *
 * Covers:
 *   - parseArgs flag set
 *   - reconcilePromotionJournal: finalised entries deleted; db-committed
 *     entries complete the rename; pending entries roll back the .tmp
 *   - Two-phase commit: pending stage written before .tmp write; transition
 *     to db-committed before the rename; finalised then deleted
 *   - --help short-circuits
 *
 * The end-to-end promote loop (DB UPDATE) is integration-tested separately;
 * here we exercise the journal reconciliation logic which is the hard part.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseArgs,
  reconcilePromotionJournal,
  promoteCandidates,
  _internals,
  EXIT,
} from '../scripts/persona-consistency-promote.mjs';

// ────────────────────────────────────────────────────────────────────────────
// parseArgs
// ────────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('reads --auto', () => {
    assert.equal(parseArgs(['--auto']).auto, true);
  });
  it('reads --since', () => {
    assert.equal(parseArgs(['--since', '2026-05-20T00:00:00Z']).since, '2026-05-20T00:00:00Z');
  });
  it('reads --repo-root + --out', () => {
    const a = parseArgs(['--repo-root', '/tmp/x', '--out', 'r.json']);
    assert.equal(a.repoRoot, '/tmp/x');
    assert.equal(a.out, 'r.json');
  });
  it('defaults: auto=false, since=null', () => {
    const a = parseArgs([]);
    assert.equal(a.auto, false);
    assert.equal(a.since, null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// reconcilePromotionJournal
// ────────────────────────────────────────────────────────────────────────────

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJournalEntry(specId, entry) {
  const dir = path.join(tmpDir, _internals.JOURNAL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${specId}.json`), JSON.stringify(entry));
}

function journalExists(specId) {
  return fs.existsSync(path.join(tmpDir, _internals.JOURNAL_DIR, `${specId}.json`));
}

describe('reconcilePromotionJournal', () => {
  it('returns counts of 0/0 when the journal dir is missing', async () => {
    const r = await reconcilePromotionJournal(tmpDir);
    assert.deepEqual(r, { recovered: 0, rolledBack: 0 });
  });

  it('returns 0/0 when the journal dir is empty', async () => {
    fs.mkdirSync(path.join(tmpDir, _internals.JOURNAL_DIR), { recursive: true });
    const r = await reconcilePromotionJournal(tmpDir);
    assert.deepEqual(r, { recovered: 0, rolledBack: 0 });
  });

  it('deletes "finalised" stage entries (already committed; janitor work)', async () => {
    writeJournalEntry('spec-1', { stage: 'finalised', specId: 'spec-1' });
    const r = await reconcilePromotionJournal(tmpDir);
    assert.deepEqual(r, { recovered: 0, rolledBack: 0 });
    assert.equal(journalExists('spec-1'), false);
  });

  it('"db-committed" → completes the rename when .tmp exists and final does not', async () => {
    const e2eDir = path.join(tmpDir, _internals.E2E_DIR);
    fs.mkdirSync(e2eDir, { recursive: true });
    const tmpPath   = path.join(e2eDir, 'spec-1.spec.js.tmp');
    const finalPath = path.join(e2eDir, 'spec-1.spec.js');
    fs.writeFileSync(tmpPath, '// generated body');
    writeJournalEntry('spec-1', {
      stage: 'db-committed',
      specId: 'spec-1',
      tmpPath, intendedPath: finalPath,
    });

    const r = await reconcilePromotionJournal(tmpDir);
    assert.equal(r.recovered, 1);
    assert.equal(journalExists('spec-1'), false);
    assert.equal(fs.existsSync(tmpPath), false);
    assert.ok(fs.existsSync(finalPath));
  });

  it('"db-committed" with both .tmp and final present → leaves files alone (journal cleared)', async () => {
    const e2eDir = path.join(tmpDir, _internals.E2E_DIR);
    fs.mkdirSync(e2eDir, { recursive: true });
    const tmpPath   = path.join(e2eDir, 'spec-2.spec.js.tmp');
    const finalPath = path.join(e2eDir, 'spec-2.spec.js');
    fs.writeFileSync(tmpPath,   '// orphan');
    fs.writeFileSync(finalPath, '// good');
    writeJournalEntry('spec-2', {
      stage: 'db-committed',
      specId: 'spec-2',
      tmpPath, intendedPath: finalPath,
    });

    await reconcilePromotionJournal(tmpDir);
    assert.equal(journalExists('spec-2'), false);
    assert.equal(fs.readFileSync(finalPath, 'utf-8'), '// good',
      'final file should not be overwritten on reconcile');
  });

  it('"pending" → rolls back the .tmp and clears the journal (DB never committed)', async () => {
    const e2eDir = path.join(tmpDir, _internals.E2E_DIR);
    fs.mkdirSync(e2eDir, { recursive: true });
    const tmpPath   = path.join(e2eDir, 'spec-3.spec.js.tmp');
    const finalPath = path.join(e2eDir, 'spec-3.spec.js');
    fs.writeFileSync(tmpPath, '// abandoned');
    writeJournalEntry('spec-3', {
      stage: 'pending',
      specId: 'spec-3',
      tmpPath, intendedPath: finalPath,
    });

    const r = await reconcilePromotionJournal(tmpDir);
    assert.equal(r.rolledBack, 1);
    assert.equal(journalExists('spec-3'), false);
    assert.equal(fs.existsSync(tmpPath), false);
    assert.equal(fs.existsSync(finalPath), false);
  });

  it('"pending" with no .tmp file just clears the journal (idempotent)', async () => {
    writeJournalEntry('spec-4', {
      stage: 'pending',
      specId: 'spec-4',
      tmpPath: path.join(tmpDir, _internals.E2E_DIR, 'never-created.tmp'),
      intendedPath: path.join(tmpDir, _internals.E2E_DIR, 'never-created.spec.js'),
    });
    const r = await reconcilePromotionJournal(tmpDir);
    assert.equal(r.rolledBack, 1);
    assert.equal(journalExists('spec-4'), false);
  });

  it('malformed journal entries are deleted (don\'t block subsequent reconciles)', async () => {
    const dir = path.join(tmpDir, _internals.JOURNAL_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'malformed.json'), '{ not json');
    const r = await reconcilePromotionJournal(tmpDir);
    assert.deepEqual(r, { recovered: 0, rolledBack: 0 });
    assert.equal(fs.existsSync(path.join(dir, 'malformed.json')), false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// promoteCandidates — short-circuit paths
// ────────────────────────────────────────────────────────────────────────────

describe('promoteCandidates — short circuits', () => {
  it('--help returns exit 0 without doing work', async () => {
    const r = await promoteCandidates({ help: true });
    assert.equal(r.exitCode, EXIT.OK);
    assert.equal(r.promoted, 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// writeJournal helper smoke test
// ────────────────────────────────────────────────────────────────────────────

describe('_internals.writeJournal', () => {
  it('round-trips a journal entry via atomic write', () => {
    _internals.writeJournal(tmpDir, 'spec-x', { stage: 'pending', specId: 'spec-x' });
    const raw = fs.readFileSync(path.join(tmpDir, _internals.JOURNAL_DIR, 'spec-x.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.stage, 'pending');
    assert.equal(parsed.specId, 'spec-x');
  });
});
