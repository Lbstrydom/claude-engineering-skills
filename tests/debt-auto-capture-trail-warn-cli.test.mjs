/**
 * @fileoverview Integration test for the capture-trail WARN
 * `debt-auto-capture.mjs` now prints after a successful write — covers the
 * advisory backstop added alongside `debt-capture-trail-check.mjs`. Not a
 * full re-test of debt-auto-capture's existing capture flow (untested
 * before this change); scoped to the new behaviour only.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir;
let auditDir;
const scriptPath = path.resolve('scripts/debt-auto-capture.mjs');

function writeRoundLedger(name, entries) {
  const p = path.join(auditDir, name);
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries }));
  return p;
}

function makeDeferEntry(topicId, extra = {}) {
  return {
    topicId,
    ruling: 'defer',
    severity: 'MEDIUM',
    category: 'god-module',
    section: 'src/x.js:1',
    detailSnapshot: 'a sufficiently descriptive detail snapshot',
    rulingRationale: 'independent of this change — out of scope for the current fix',
    affectedFiles: ['src/x.js'],
    ...extra,
  };
}

function runCli(args) {
  return spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf-8',
    cwd: tmpDir,
    // Cloud disabled deliberately (no AUDIT_DB_URL) — syncToCloud() is
    // non-blocking on failure, matching the CLI's own graceful-degradation
    // contract; this test only cares about the local capture-trail WARN.
    env: { ...process.env, AUDIT_DB_URL: '' },
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-auto-capture-trail-'));
  auditDir = path.join(tmpDir, '.audit');
  fs.mkdirSync(auditDir, { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

describe('debt-auto-capture.mjs — capture-trail WARN', () => {
  test('no WARN when this is the only round ledger and it captures cleanly', () => {
    const ledgerPath = writeRoundLedger('sid1-ledger.json', [makeDeferEntry('a')]);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /WARN:/);
  });

  test('WARNs about an earlier ledger\'s uncaptured deferral without affecting this run\'s exit code', () => {
    // Simulates the reported failure mode: an EARLIER round's debt-auto-capture
    // invocation never ran, so 'earlier-topic' was never written to
    // tech-debt.json. THIS run only processes sid2's ledger.
    writeRoundLedger('sid1-ledger.json', [makeDeferEntry('earlier-topic')]);
    const sid2Ledger = writeRoundLedger('sid2-ledger.json', [makeDeferEntry('this-run-topic')]);

    const r = runCli(['--ledger', sid2Ledger, '--run', 'sid2']);
    assert.equal(r.status, 0, r.stderr); // this run's own capture succeeded — must not fail on the OTHER gap
    assert.match(r.stderr, /WARN:.*uncaptured/i);
    assert.match(r.stderr, /earlier-topic/);
    assert.doesNotMatch(r.stderr, /\[this-run-topic\]/); // the entry THIS run just captured must not also be flagged

    const debtLedger = JSON.parse(fs.readFileSync(path.join(auditDir, 'tech-debt.json'), 'utf-8'));
    assert.deepEqual(debtLedger.entries.map((e) => e.topicId), ['this-run-topic']);
  });

  test('WARNs about a round ledger that failed to parse', () => {
    fs.writeFileSync(path.join(auditDir, 'sid-bad-ledger.json'), '{not json');
    const sidLedger = writeRoundLedger('sid-good-ledger.json', [makeDeferEntry('a')]);
    const r = runCli(['--ledger', sidLedger, '--run', 'sid-good']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARN:.*could not be parsed/i);
  });
});
