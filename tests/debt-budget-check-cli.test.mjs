/**
 * @fileoverview Phase D.5 — debt-budget-check CLI integration tests.
 * Verifies exit codes + output format against seeded ledgers.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir;
let ledgerPath;
const scriptPath = path.resolve('scripts/debt-budget-check.mjs');

function makeEntry(topicId, file) {
  return {
    source: 'debt', topicId, semanticHash: 'h-' + topicId,
    severity: 'MEDIUM', category: 'c', section: file + ':1', detailSnapshot: 'd',
    affectedFiles: [file], affectedPrinciples: [], pass: 'backend',
    deferredReason: 'out-of-scope',
    deferredAt: '2026-04-05T10:00:00.000Z',
    deferredRun: 'r1',
    deferredRationale: 'a sufficiently long testing rationale',
    contentAliases: [], sensitive: false,
  };
}

function seedLedger(entries, budgets = {}) {
  const ledger = { version: 1, entries, ...(Object.keys(budgets).length ? { budgets } : {}) };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function runCli(args) {
  return spawnSync('node', [scriptPath, ...args], { encoding: 'utf-8', cwd: path.resolve('.') });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-budget-cli-'));
  ledgerPath = path.join(tmpDir, 'tech-debt.json');
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('debt-budget-check CLI', () => {
  test('exit 0 with no budgets configured', () => {
    seedLedger([makeEntry('a', 'src/x.js')], {});
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No budgets configured/);
  });

  test('exit 0 when within budget', () => {
    seedLedger(
      [makeEntry('a', 'src/x.js'), makeEntry('b', 'src/y.js')],
      { 'src/**': 5 }
    );
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /All 1 budget/);
  });

  test('exit 2 when glob budget exceeded', () => {
    seedLedger(
      [
        makeEntry('a', 'src/x.js'),
        makeEntry('b', 'src/y.js'),
        makeEntry('c', 'src/z.js'),
      ],
      { 'src/**': 2 }
    );
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /budget violation/);
    assert.match(r.stdout, /src\/\*\*.*glob.*3 entries.*2 budget/);
  });

  test('exit 2 when exact path budget exceeded', () => {
    seedLedger(
      [makeEntry('a', 'src/big.js'), makeEntry('b', 'src/big.js')],
      { 'src/big.js': 1 }
    );
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /src\/big\.js.*exact.*2 entries.*1 budget/);
  });

  test('--json mode outputs machine-readable JSON on violation', () => {
    seedLedger(
      [makeEntry('a', 'src/x.js'), makeEntry('b', 'src/y.js')],
      { 'src/**': 0 }
    );
    const r = runCli(['--ledger', ledgerPath, '--json']);
    assert.equal(r.status, 2);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.budgetsChecked, 1);
    assert.equal(data.entriesChecked, 2);
    assert.equal(data.violations.length, 1);
    assert.equal(data.violations[0].path, 'src/**');
  });

  test('--json mode on clean ledger', () => {
    seedLedger([makeEntry('a', 'src/x.js')], { 'src/**': 10 });
    const r = runCli(['--ledger', ledgerPath, '--json']);
    assert.equal(r.status, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.violations.length, 0);
  });

  test('--budgets-file overrides ledger budgets', () => {
    seedLedger(
      [makeEntry('a', 'src/x.js'), makeEntry('b', 'src/y.js')],
      { 'src/**': 10 }  // ledger says OK
    );
    const budgetsFile = path.join(tmpDir, 'budgets.json');
    fs.writeFileSync(budgetsFile, JSON.stringify({ 'src/**': 1 }));  // external file says over
    const r = runCli(['--ledger', ledgerPath, '--budgets-file', budgetsFile]);
    assert.equal(r.status, 2);
  });

  test('exit 1 on missing budgets file', () => {
    seedLedger([makeEntry('a', 'src/x.js')]);
    const r = runCli([
      '--ledger', ledgerPath,
      '--budgets-file', path.join(tmpDir, 'missing.json'),
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not found/);
  });

  test('exit 0 when ledger file missing + no budgets', () => {
    // Ledger that doesn't exist yet + no budgets file → treated as empty
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 0);
  });

  test('--help exits 0 and prints usage', () => {
    const r = runCli(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /Usage:/);
  });
});
