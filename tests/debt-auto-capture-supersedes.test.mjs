/**
 * @fileoverview docs/plans/debt-ledger-persisted-record-contract.md §2 Fix D
 * — `debt-auto-capture.mjs --supersedes <old> --supersedes-with <new>`.
 *
 * Cloud disabled deliberately (no AUDIT_DB_URL) — this suite covers the
 * LOCAL half end to end; `markSupersededCloud`'s existence-verification is
 * covered by tests/store-debt-cloud-validation.test.mjs (DB-gated).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeRoundLedger as writeRoundLedgerAt } from './helpers/fixtures.mjs';
import { makeRunCli } from './helpers/run-cli.mjs';

let tmpDir;
let auditDir;
const scriptPath = path.resolve('scripts/debt-auto-capture.mjs');

function writeRoundLedger(name, entries) {
  return writeRoundLedgerAt(auditDir, name, entries);
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

function readTechDebt() {
  return JSON.parse(fs.readFileSync(path.join(auditDir, 'tech-debt.json'), 'utf-8'));
}

const runCli = makeRunCli(scriptPath, { cwd: () => tmpDir, buildEnv: () => ({ ...process.env, AUDIT_DB_URL: '' }) });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-auto-capture-supersedes-'));
  auditDir = path.join(tmpDir, '.audit');
  fs.mkdirSync(auditDir, { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

describe('debt-auto-capture.mjs — --supersedes/--supersedes-with', () => {
  test('--supersedes without --supersedes-with is refused (round-3 GPT audit H6)', () => {
    const ledgerPath = writeRoundLedger('sid1-ledger.json', [makeDeferEntry('new1')]);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1', '--supersedes', 'old1']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--supersedes.*--supersedes-with/);
  });

  test('--supersedes-with without --supersedes is refused', () => {
    const ledgerPath = writeRoundLedger('sid1-ledger.json', [makeDeferEntry('new1')]);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1', '--supersedes-with', 'new1']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--supersedes.*--supersedes-with/);
  });

  test('naming the same topicId for both flags is refused', () => {
    const ledgerPath = writeRoundLedger('sid1-ledger.json', [makeDeferEntry('t1')]);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1', '--supersedes', 't1', '--supersedes-with', 't1']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /different topicIds/);
  });

  test('links an existing entry to a newly-captured one, end to end', () => {
    // First capture: seed the "old" entry.
    const seedLedger = writeRoundLedger('seed-ledger.json', [makeDeferEntry('old1')]);
    const seed = runCli(['--ledger', seedLedger, '--run', 'seed']);
    assert.equal(seed.status, 0, seed.stderr);

    // Second capture: the "new" entry, explicitly superseding the old one.
    const newLedger = writeRoundLedger('new-ledger.json', [makeDeferEntry('new1')]);
    const r = runCli(['--ledger', newLedger, '--run', 'sid2', '--supersedes', 'old1', '--supersedes-with', 'new1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Local: ok/);

    const ledger = readTechDebt();
    const old = ledger.entries.find(e => e.topicId === 'old1');
    assert.equal(old.supersededBy, 'new1');
  });

  test('a non-existent old topicId is refused non-fatally — the capture itself still succeeds', () => {
    const newLedger = writeRoundLedger('new-ledger.json', [makeDeferEntry('new1')]);
    const r = runCli(['--ledger', newLedger, '--run', 'sid1', '--supersedes', 'missing-old', '--supersedes-with', 'new1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Local: failed \(old-topic-not-found\)/);
    // The capture itself must have landed despite the supersede failure.
    const ledger = readTechDebt();
    assert.ok(ledger.entries.find(e => e.topicId === 'new1'));
  });

  test('the round-2 counting bug does NOT resurface: --supersedes-with never silently falls back to whatever else persisted (round-3 GPT audit H6 regression)', () => {
    // Round 2's abandoned design inferred the successor from "the one entry
    // that persisted this batch" — a batch with two captured entries would
    // have picked the SURVIVOR even when it was not the one intended. This
    // suite has no such inference left (only explicit --supersedes-with), so
    // pin the absence: naming a topicId that is NOT in this batch at all
    // must fail on existence, never silently link to whichever entry
    // actually did persist.
    const seedLedger = writeRoundLedger('seed-ledger.json', [makeDeferEntry('old1')]);
    runCli(['--ledger', seedLedger, '--run', 'seed']);

    const newLedger = writeRoundLedger('new-ledger.json', [makeDeferEntry('unrelated-survivor')]);
    const r = runCli(['--ledger', newLedger, '--run', 'sid2', '--supersedes', 'old1', '--supersedes-with', 'never-captured']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Local: failed \(new-topic-not-found\)/);

    const ledger = readTechDebt();
    const old = ledger.entries.find(e => e.topicId === 'old1');
    assert.equal(old.supersededBy, undefined, 'must NOT link to the unrelated survivor that happened to persist');
  });
});
