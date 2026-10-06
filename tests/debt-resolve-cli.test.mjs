/**
 * @fileoverview Phase D — debt-resolve CLI integration test.
 * Seeds a temp ledger, invokes the CLI via spawn, verifies exit codes + output.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { writeDebtEntries } from '../scripts/lib/debt-ledger.mjs';
import { makeRunCli } from './helpers/run-cli.mjs';

let tmpDir;
let ledgerPath;
let eventsPath;
const scriptPath = path.resolve('scripts/debt-resolve.mjs');

function makeEntry(topicId) {
  return {
    source: 'debt', topicId, semanticHash: 'h-' + topicId,
    severity: 'MEDIUM', category: 'test-category', section: 'src/x.js:1', detailSnapshot: 'd',
    affectedFiles: ['src/x.js'], affectedPrinciples: [], pass: 'backend',
    deferredReason: 'out-of-scope', deferredAt: '2026-04-05T10:00:00.000Z',
    deferredRun: 'r1', deferredRationale: 'a sufficiently long testing rationale',
    contentAliases: [], sensitive: false,
  };
}

const runCli = makeRunCli(scriptPath);

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-resolve-cli-'));
  ledgerPath = path.join(tmpDir, 'tech-debt.json');
  eventsPath = path.join(tmpDir, 'debt-events.jsonl');
  await writeDebtEntries([makeEntry('existing1'), makeEntry('existing2')], { ledgerPath });
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

describe('debt-resolve CLI', () => {
  test('exit 0 + removes existing entry (local-only mode)', () => {
    const r = runCli([
      'existing1',
      '--rationale', 'fixed in commit abc1234 as part of refactor pass',
      '--ledger', ledgerPath,
      '--events', eventsPath,
      '--no-cloud',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.topicId, 'existing1');
    assert.equal(json.removedLocal, true);
    assert.equal(json.removedCloud, false);
    assert.equal(json.eventWritten, true);
    assert.equal(json.eventSource, 'local');
    // Verify entry removed
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].topicId, 'existing2');
    // Verify resolved event written
    const events = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.event === 'resolved' && e.topicId === 'existing1'));
  });

  test('exit 2 when topicId not found', () => {
    const r = runCli([
      'nonexistent',
      '--rationale', 'this is a long enough rationale for testing',
      '--ledger', ledgerPath,
      '--events', eventsPath,
      '--no-cloud',
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no debt entry/);
  });

  test('exit 1 when rationale too short', () => {
    const r = runCli([
      'existing1',
      '--rationale', 'too short',
      '--ledger', ledgerPath,
      '--no-cloud',
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, />= 20 chars/);
  });

  test('exit 1 when rationale missing', () => {
    const r = runCli([
      'existing1',
      '--ledger', ledgerPath,
      '--no-cloud',
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--rationale is required/);
  });

  test('exit 1 when topicId missing', () => {
    const r = runCli(['--rationale', 'this is a long enough rationale for testing', '--no-cloud']);
    assert.equal(r.status, 1);
  });

  test('--help prints usage and exits 0', () => {
    const r = runCli(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /Usage:/);
  });

  describe('--accept-permanent (in-place disposition, keeps debt memory)', () => {
    const accept = (extra = []) => runCli([
      'existing1',
      '--accept-permanent',
      '--rationale', 'deliberate: the override seam is announced and pinned by a test',
      '--ledger', ledgerPath,
      '--events', eventsPath,
      '--no-cloud',
      ...extra,
    ]);
    const readLedger = () => JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));

    test('upserts the entry IN PLACE to accepted-permanent — never removes it', () => {
      const r = accept(['--approver', '@owner (documented decision)']);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).action, 'accepted-permanent');

      const ledger = readLedger();
      assert.equal(ledger.entries.length, 2, 'accepting must not remove a row — that would drop it from debt memory');
      const e = ledger.entries.find((x) => x.topicId === 'existing1');
      assert.equal(e.deferredReason, 'accepted-permanent');
      assert.equal(e.approver, '@owner (documented decision)');
      assert.match(e.approvedAt, /^\d{4}-\d\d-\d\dT/);
      // The original deferral is history, not rewritten.
      assert.equal(e.deferredAt, '2026-04-05T10:00:00.000Z');
      assert.equal(e.deferredRun, 'r1');
      assert.match(e.deferredRationale, /^deliberate: the override seam/);
      assert.match(e.deferredRationale, /Prior deferral \(out-of-scope\): a sufficiently long testing rationale/);
      // Negative control: the sibling row is untouched.
      assert.equal(ledger.entries.find((x) => x.topicId === 'existing2').deferredReason, 'out-of-scope');
      // No event is written: there is no "accepted" event kind, the entry is the record.
      assert.equal(fs.existsSync(eventsPath), false);
    });

    test('exit 1 and the ledger is untouched when --approver is missing', () => {
      const before = fs.readFileSync(ledgerPath, 'utf-8');
      const r = accept();
      assert.equal(r.status, 1);
      assert.match(r.stderr, /requires --approver/);
      assert.equal(fs.readFileSync(ledgerPath, 'utf-8'), before);
    });

    test('exit 2 when the topicId is not in the ledger', () => {
      const r = runCli([
        'nonexistent', '--accept-permanent', '--approver', '@owner',
        '--rationale', 'this is a long enough rationale for testing',
        '--ledger', ledgerPath, '--no-cloud',
      ]);
      assert.equal(r.status, 2);
    });
  });

  test('a literal --help after -- does not print usage — the resolve proceeds normally', () => {
    // help/noCloud used to be read via a bare `args.includes(...)`, which
    // scans the ENTIRE argv. A literal `--help` after the POSIX `--`
    // terminator is a positional, not a flag; it must not short-circuit to
    // printUsage() before the resolve logic runs.
    const r = runCli([
      'existing1',
      '--rationale', 'fixed in commit abc1234 as part of refactor pass',
      '--ledger', ledgerPath,
      '--events', eventsPath,
      '--no-cloud',
      '--', '--help',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Usage:/);
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, true, 'the resolve must actually run, not short-circuit to usage');
  });
});
