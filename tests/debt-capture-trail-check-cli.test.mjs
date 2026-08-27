/**
 * @fileoverview debt-capture-trail-check CLI integration tests, mirroring
 * tests/debt-health-check.test.mjs and tests/debt-ledger-claims-check.test.mjs's
 * harness shape.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir;
let ledgerPath;
const scriptPath = path.resolve('scripts/debt-capture-trail-check.mjs');

function writeRoundLedger(name, entries) {
  fs.writeFileSync(path.join(tmpDir, name), JSON.stringify({ version: 1, entries }));
}

function seedDebtLedger(entries) {
  fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, entries }));
}

function makeDebtEntry(topicId) {
  return {
    source: 'debt', topicId, semanticHash: 'h-' + topicId,
    severity: 'MEDIUM', category: 'c', section: 'x:1', detailSnapshot: 'd',
    affectedFiles: ['src/x.js'], affectedPrinciples: [], pass: 'backend',
    deferredReason: 'out-of-scope',
    deferredAt: new Date().toISOString(),
    deferredRun: 'r1',
    deferredRationale: 'a sufficiently long testing rationale',
    contentAliases: [], sensitive: false,
  };
}

function runCli(args, env = {}) {
  return spawnSync('node', [scriptPath, '--audit-dir', tmpDir, '--ledger', ledgerPath, ...args], {
    encoding: 'utf-8', cwd: path.resolve('.'), env: { ...process.env, ...env },
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-capture-trail-cli-'));
  ledgerPath = path.join(tmpDir, 'tech-debt.json');
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

describe('debt-capture-trail-check CLI', () => {
  test('exit 0 when no round ledgers exist', () => {
    const r = runCli([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing to verify/);
  });

  test('exit 0 when every defer entry is captured', () => {
    writeRoundLedger('sid1-ledger.json', [{ topicId: 'a', ruling: 'defer', severity: 'HIGH' }]);
    seedDebtLedger([makeDebtEntry('a')]);
    const r = runCli([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 deferred entry/);
    assert.match(r.stdout, /0 uncaptured/);
  });

  test('exit 1 when a defer entry has no matching debt-ledger entry', () => {
    writeRoundLedger('sid1-ledger.json', [
      { topicId: 'a', ruling: 'defer', severity: 'HIGH' },
      { topicId: 'b', ruling: 'defer', severity: 'LOW' },
    ]);
    seedDebtLedger([makeDebtEntry('a')]); // b is missing
    const r = runCli([]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /2 deferred entr/);
    assert.match(r.stdout, /1 uncaptured/);
    assert.match(r.stdout, /\bb\b/);
  });

  test('exit 1 when the debt ledger is entirely absent but deferrals exist', () => {
    writeRoundLedger('sid1-ledger.json', [{ topicId: 'a', ruling: 'defer' }]);
    // no seedDebtLedger call — tech-debt.json never created
    const r = runCli([]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /itself is absent/);
  });

  test('exit 1 when a round ledger fails to parse', () => {
    fs.writeFileSync(path.join(tmpDir, 'sid1-ledger.json'), '{not json');
    seedDebtLedger([]);
    const r = runCli([]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /could not be parsed/);
  });

  test('non-defer rulings are ignored', () => {
    writeRoundLedger('sid1-ledger.json', [{ topicId: 'a', ruling: 'dismiss' }]);
    const r = runCli([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing to verify/);
  });

  test('--json mode reports a machine-readable envelope', () => {
    writeRoundLedger('sid1-ledger.json', [{ topicId: 'a', ruling: 'defer', severity: 'HIGH' }]);
    const r = runCli(['--json']);
    assert.equal(r.status, 1);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.deferredTotal, 1);
    assert.equal(data.uncaptured.length, 1);
    assert.equal(data.uncaptured[0].topicId, 'a');
    assert.equal(data.exitCode, 1);
  });

  test('exit 2 on corrupt debt ledger', () => {
    fs.writeFileSync(ledgerPath, '{not json');
    writeRoundLedger('sid1-ledger.json', [{ topicId: 'a', ruling: 'defer' }]);
    const r = runCli([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /debt ledger corrupt/);
  });

  test('exit 2 on unknown flag', () => {
    const r = runCli(['--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag/);
  });

  test('--help exits 0 and prints usage', () => {
    const r = runCli(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /Usage:/);
  });
});
