/**
 * @fileoverview Phase D — debt-resolve CLI integration test.
 * Seeds a temp ledger, invokes the CLI via spawn, verifies exit codes + output.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { writeDebtEntries } from '../scripts/lib/debt-ledger.mjs';

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

function runCli(args) {
  return spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf-8',
    cwd: path.resolve('.'),
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-resolve-cli-'));
  ledgerPath = path.join(tmpDir, 'tech-debt.json');
  eventsPath = path.join(tmpDir, 'debt-events.jsonl');
  await writeDebtEntries([makeEntry('existing1'), makeEntry('existing2')], { ledgerPath });
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
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
});
