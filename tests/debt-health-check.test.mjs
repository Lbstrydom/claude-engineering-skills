/**
 * @fileoverview debt-health-check CLI integration tests.
 * Verifies exit codes + summary fields against seeded ledgers, mirroring
 * tests/debt-budget-check-cli.test.mjs's harness shape.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir;
let ledgerPath;
const scriptPath = path.resolve('scripts/debt-health-check.mjs');

function makeEntry(topicId, { file = 'src/x.js', severity = 'MEDIUM', deferredAt = '2026-04-05T10:00:00.000Z' } = {}) {
  return {
    source: 'debt', topicId, semanticHash: 'h-' + topicId,
    severity, category: 'c', section: file + ':1', detailSnapshot: 'd',
    affectedFiles: [file], affectedPrinciples: [], pass: 'backend',
    deferredReason: 'out-of-scope',
    deferredAt,
    deferredRun: 'r1',
    deferredRationale: 'a sufficiently long testing rationale',
    contentAliases: [], sensitive: false,
  };
}

function seedLedger(entries, budgets = {}) {
  const ledger = { version: 1, entries, ...(Object.keys(budgets).length ? { budgets } : {}) };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function runCli(args, env = {}) {
  return spawnSync('node', [scriptPath, ...args], { encoding: 'utf-8', cwd: path.resolve('.'), env: { ...process.env, ...env } });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-health-cli-'));
  ledgerPath = path.join(tmpDir, 'tech-debt.json');
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

describe('debt-health-check CLI', () => {
  test('exit 0 when ledger file missing', () => {
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /0 open entries/);
  });

  test('exit 0 when ledger has entries but nothing stale/recurring/over-budget', () => {
    seedLedger([makeEntry('a', { deferredAt: new Date().toISOString() })]);
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 open entries/);
  });

  test('exit 1 when a stale entry is present', () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    seedLedger([makeEntry('a', { deferredAt: old })]);
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Stale \(>180d\): 1/);
  });

  test('DEBT_HEALTH_TTL_DAYS overrides the staleness threshold', () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    seedLedger([makeEntry('a', { deferredAt: old })]);
    const r = runCli(['--ledger', ledgerPath], { DEBT_HEALTH_TTL_DAYS: '5' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Stale \(>5d\): 1/);
  });

  test('exit 1 when a budget is violated', () => {
    seedLedger(
      [makeEntry('a', { file: 'src/big.js', deferredAt: new Date().toISOString() }),
        makeEntry('b', { file: 'src/big.js', deferredAt: new Date().toISOString() })],
      { 'src/big.js': 1 },
    );
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Budget violations: 1/);
  });

  test('--json mode reports triggered=false on a healthy ledger', () => {
    seedLedger([makeEntry('a', { deferredAt: new Date().toISOString() })]);
    const r = runCli(['--ledger', ledgerPath, '--json']);
    assert.equal(r.status, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.totalEntries, 1);
    assert.equal(data.triggered, false);
  });

  test('--json mode reports stale topicIds on an unhealthy ledger', () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    seedLedger([makeEntry('a', { deferredAt: old })]);
    const r = runCli(['--ledger', ledgerPath, '--json']);
    assert.equal(r.status, 1);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.deepEqual(data.stale, ['a']);
  });

  test('exit 2 on corrupt ledger', () => {
    fs.writeFileSync(ledgerPath, '{not json');
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /corrupt ledger/);
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
