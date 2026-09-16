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
import { seedLedger as seedLedgerAt } from './helpers/fixtures.mjs';

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
  seedLedgerAt(ledgerPath, entries, budgets);
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
  test('a MISSING ledger reports unverifiable — never "0 open entries"', () => {
    // This assertion used to require /0 open entries/ from an absent ledger,
    // which pinned the false green rather than the contract: `.audit/` is
    // gitignored, so a fresh clone, CI, or a linked worktree took that path by
    // default and read as a clean bill of health. Exit stays 0 because this is
    // an advisory maintenance nudge, not a gate — the fix is honesty in the
    // report, not a new push blocker.
    // See docs/plans/backlog-and-drift-reduction.md §2 availability contract.
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 0, 'advisory: an unverifiable input must not start gating');
    assert.match(r.stdout, /UNVERIFIABLE/);
    assert.doesNotMatch(r.stdout, /0 open entries/, 'the count must not be fabricated');
  });

  test('a missing ledger emits ok:false in JSON — a machine must not read a green', () => {
    const r = runCli(['--ledger', ledgerPath, '--json']);
    assert.equal(r.status, 0);
    const env = JSON.parse(r.stdout);
    assert.equal(env.ok, false);
    assert.equal(env.verdict, 'unverifiable');
    assert.equal(env.totalEntries, null, 'a count is never rendered for an unread ledger');
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

  test('exit 1 when a topicId is duplicated', () => {
    seedLedger([makeEntry('dup'), makeEntry('dup'), makeEntry('unique')]);
    const r = runCli(['--ledger', ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Duplicate topicIds: 1/);
    assert.match(r.stdout, /dup: 2 copies/);
  });

  test('--json mode reports duplicate topicIds on an unhealthy ledger', () => {
    seedLedger([makeEntry('dup'), makeEntry('dup')]);
    const r = runCli(['--ledger', ledgerPath, '--json']);
    assert.equal(r.status, 1);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false);
    assert.deepEqual(data.duplicates, [{ topicId: 'dup', count: 2 }]);
  });

  describe('--fail-on-duplicates (CI gate mode)', () => {
    // Hermetic against the operator's real shell env — `runCli` spreads
    // `process.env` before its own overrides, so an operator with
    // DEBT_HEALTH_TTL_DAYS/RECURRENCE_THRESHOLD already exported would
    // otherwise leak into these assertions. Empty string is `numEnv`'s
    // "use default" sentinel (debt-health-check.mjs), not a parse failure.
    const DEFAULT_ENV = { DEBT_HEALTH_TTL_DAYS: '', DEBT_HEALTH_RECURRENCE_THRESHOLD: '' };

    test('exit 1 when duplicates are present, even with no other attention triggers', () => {
      // deferredAt explicit: makeEntry's fixed default date is a ticking time
      // bomb against the 180-day TTL — this test's own claim ("no other
      // attention triggers") would silently go false once real time passes it.
      const now = new Date().toISOString();
      seedLedger([makeEntry('dup', { deferredAt: now }), makeEntry('dup', { deferredAt: now })]);
      const r = runCli(['--ledger', ledgerPath, '--fail-on-duplicates'], DEFAULT_ENV);
      assert.equal(r.status, 1);
    });

    test('exit 0 when duplicates are absent, EVEN IF stale/budget would trigger default mode', () => {
      // Exercises stale + budget specifically (both cheap to seed directly).
      // Recurrence is deliberately NOT exercised here: `distinctRunCount` is
      // hydrated from the event log (debt-events.mjs), not the raw seeded
      // ledger — proving it would need a second fixture (a matching events
      // file), disproportionate to what this test needs to establish. The
      // production code's narrowing (debt-health-check.mjs's `escalationTrigger`)
      // reads `summary.duplicates.length` alone regardless of which of the
      // three dimensions triggered `summary.triggered`, so stale+budget
      // already demonstrates the narrowing logic; recurrence is the same
      // code path, not a separate branch to prove separately.
      const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
      seedLedger(
        [makeEntry('a', { file: 'src/big.js', deferredAt: old }),
          makeEntry('b', { file: 'src/big.js', deferredAt: new Date().toISOString() })],
        { 'src/big.js': 1 },
      );
      // Sanity: default mode DOES trigger on this ledger (proves the two modes differ).
      const defaultRun = runCli(['--ledger', ledgerPath], DEFAULT_ENV);
      assert.equal(defaultRun.status, 1, 'sanity check: default mode should flag stale+budget');

      const r = runCli(['--ledger', ledgerPath, '--fail-on-duplicates'], DEFAULT_ENV);
      assert.equal(r.status, 0, '--fail-on-duplicates must ignore stale/budget for its exit code');
    });

    test('exit 0 on an unavailable (missing) ledger — never gates on a measurement that did not happen', () => {
      const r = runCli(['--ledger', ledgerPath, '--fail-on-duplicates'], DEFAULT_ENV);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /UNVERIFIABLE/);
    });

    test('exit 2 on corrupt ledger — op-error is unchanged by the flag', () => {
      fs.writeFileSync(ledgerPath, '{not json');
      const r = runCli(['--ledger', ledgerPath, '--fail-on-duplicates'], DEFAULT_ENV);
      assert.equal(r.status, 2);
    });
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

  describe('the POSIX -- terminator narrows boolean flags too', () => {
    // jsonMode/help used to be read via a bare `args.includes('--json')`,
    // which scans the ENTIRE argv — unlike ledgerPath/outFile, which go
    // through argOption and correctly stop at `--`. A literal `--json` after
    // `--` is a positional, not a flag; it must not turn JSON mode on.
    test('a literal --json after -- does not enable JSON mode', () => {
      seedLedger([makeEntry('a', { deferredAt: new Date().toISOString() })]);
      const r = runCli(['--ledger', ledgerPath, '--', '--json']);
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stdout, /^\{/, 'must render human text, not a JSON envelope');
      assert.match(r.stdout, /1 open entries/);
    });

    test('a literal --help after -- does not print usage', () => {
      seedLedger([makeEntry('a', { deferredAt: new Date().toISOString() })]);
      const r = runCli(['--ledger', ledgerPath, '--', '--help']);
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /Usage:/);
    });

    test('a literal -h after -- does not print usage', () => {
      seedLedger([makeEntry('a', { deferredAt: new Date().toISOString() })]);
      const r = runCli(['--ledger', ledgerPath, '--', '-h']);
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /Usage:/);
    });
  });
});
