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
import { seedLedger as seedLedgerAt } from './helpers/fixtures.mjs';

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
  seedLedgerAt(ledgerPath, entries, budgets);
}

function runCli(args) {
  return spawnSync('node', [scriptPath, ...args], { encoding: 'utf-8', cwd: path.resolve('.') });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-budget-cli-'));
  ledgerPath = path.join(tmpDir, 'tech-debt.json');
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
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

  test('exit 1 when the ledger file is missing — never a false pass (round-1 audit H3)', () => {
    // This used to assert exit 0 ("treated as empty"), pinning a fail-open
    // bug: an UNAVAILABLE ledger (never read) and a genuinely EMPTY one (read,
    // zero entries/budgets) are different facts, and this is an ENFORCEMENT
    // gate, not the advisory debt-health-check.mjs — CI consumes the exit
    // code, so "policy never evaluated" must not exit the same as "policy
    // passed". A missing ledger is still reported clearly (UNVERIFIABLE), but
    // the exit code now matches this CLI's own documented operational-error
    // contract instead of contradicting it.
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /UNVERIFIABLE/);
  });

  test('exit 1 when the ledger is missing, even with --budgets-file supplied', () => {
    // Budgets can come from an external file, but the ENTRIES to check them
    // against always come from the ledger (`ledger.entries`) — an unavailable
    // ledger means there's nothing to count regardless of budget source, so
    // this branch fires unconditionally, before budgetCount is even examined.
    const budgetsFile = path.join(tmpDir, 'budgets.json');
    fs.writeFileSync(budgetsFile, JSON.stringify({ 'src/**': 0 }));
    const r = runCli(['--ledger', ledgerPath, '--budgets-file', budgetsFile]);
    assert.equal(r.status, 1);
  });

  test('--help exits 0 and prints usage', () => {
    const r = runCli(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /Usage:/);
  });

  test('a literal --json after -- does not enable JSON mode', () => {
    // jsonMode/help used to be read via a bare `args.includes('--json')`,
    // which scans the ENTIRE argv unlike the value-flag `get()` helper — a
    // literal `--json` after the POSIX `--` terminator is a positional, not
    // a flag, and must not turn JSON mode on.
    seedLedger([makeEntry('a', 'src/x.js')], {});
    const r = runCli(['--ledger', ledgerPath, '--', '--json']);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /^\{/, 'must render human text, not a JSON envelope');
    assert.match(r.stdout, /No budgets configured/);
  });
});
