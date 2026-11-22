/**
 * @fileoverview `debt-auto-capture.mjs --add` — a hand-authored debt entry that
 * goes through the SAME build/validate/persist path as a ledger capture
 * (a chip once had to fake a finding in a copied result file to file debt).
 *
 * Negative controls: every refusal asserts NOTHING landed in the ledger, and the
 * happy path asserts the entry is the one a ledger capture of the same finding
 * would produce (same schema, same topicId derivation).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PersistedDebtEntrySchema } from '../scripts/lib/schemas.mjs';
import { readDebtLedger } from '../scripts/lib/debt-ledger.mjs';
import { manualToLedgerEntries, manualTopicId } from '../scripts/lib/debt-manual-entry.mjs';
import { makeRunCli } from './helpers/run-cli.mjs';

let tmpDir;
const scriptPath = path.resolve('scripts/debt-auto-capture.mjs');
const runCli = makeRunCli(scriptPath, { cwd: () => tmpDir, buildEnv: () => ({ ...process.env, AUDIT_DB_URL: '' }) });
const ledgerEntries = () => readDebtLedger({ ledgerPath: path.join(tmpDir, '.audit', 'tech-debt.json'), events: [] }).entries;

const GOOD = [
  '--add', '--severity', 'MEDIUM', '--category', 'cost-ledger', '--file', 'scripts/lib/solo-control/ledger.mjs', '--line', '26',
  '--detail', 'callId reuses the cell identity so a forced rerun is deduped by the budget read',
  '--rationale', 'Independent of this change: the budget read is untouched here; tracked for the spend-identity follow-up.',
];

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-add-')); fs.mkdirSync(path.join(tmpDir, '.audit'), { recursive: true }); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ } });

describe('manualToLedgerEntries (pure validation)', () => {
  const base = { severity: 'high', category: 'c', file: './a\\b.mjs', detail: 'a long enough detail', rationale: 'a rationale that is long enough to count' };
  test('paths that differ only in case are DIFFERENT entries (case-sensitive filesystems)', () => {
    const a = manualToLedgerEntries({ ...base, file: 'src/Foo.mjs' }).entries[0].topicId;
    const b = manualToLedgerEntries({ ...base, file: 'src/foo.mjs' }).entries[0].topicId;
    assert.notEqual(a, b);
  });
  test('projects onto the ledger-entry shape, normalising severity and path, keying by a deterministic manual topic id', () => {
    const r = manualToLedgerEntries({ ...base, line: 7 });
    assert.equal(r.ok, true);
    const [e] = r.entries;
    assert.equal(e.ruling, 'defer');
    assert.equal(e.severity, 'HIGH');
    assert.deepEqual(e.affectedFiles, ['a/b.mjs']);
    assert.equal(e.section, 'a/b.mjs:7');
    assert.equal(e.topicId, manualTopicId({ category: 'c', section: 'a/b.mjs:7', detail: 'a long enough detail' }));
    assert.match(e.topicId, /^m[0-9a-f]{8}$/);
  });
  for (const [name, patch, re] of [
    ['bad severity', { severity: 'URGENT' }, /severity/],
    ['no category', { category: ' ' }, /category/],
    ['no file', { file: '' }, /file/],
    ['short detail', { detail: 'short' }, /detail/],
    ['short rationale is refused, never padded', { rationale: 'too short' }, /rationale/],
    ['non-numeric line', { line: 'x' }, /line/],
    ['line zero', { line: '0' }, /line/],
  ]) {
    test(`refuses: ${name}`, () => {
      const r = manualToLedgerEntries({ ...base, ...patch });
      assert.equal(r.ok, false);
      assert.match(r.error, re);
    });
  }
});

describe('debt-auto-capture --add (CLI)', () => {
  test('captures one entry that PersistedDebtEntrySchema accepts, exit 0', () => {
    const r = runCli(GOOD);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const entries = ledgerEntries();
    assert.equal(entries.length, 1);
    assert.doesNotThrow(() => PersistedDebtEntrySchema.parse(entries[0]));
    assert.equal(entries[0].pass, 'manual');
    assert.equal(entries[0].severity, 'MEDIUM');
    assert.deepEqual(entries[0].affectedFiles, ['scripts/lib/solo-control/ledger.mjs']);
    assert.match(r.stdout, /Cloud sync: skipped/, 'the cloud path ran (and was declined: no DSN), not bypassed');
  });

  test('idempotent: the same add twice updates in place, never duplicates', () => {
    assert.equal(runCli(GOOD).status, 0);
    assert.equal(runCli(GOOD).status, 0);
    assert.equal(ledgerEntries().length, 1);
  });

  test('a secret in the detail is redacted by the shared builder and the entry is marked sensitive', () => {
    const args = [...GOOD]; args[args.indexOf('--detail') + 1] = 'token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD leaked into the ledger row';
    const r = runCli(args);
    assert.equal(r.status, 0, r.stderr);
    const [e] = ledgerEntries();
    assert.doesNotMatch(e.detailSnapshot, /sk-abcdefghijklmnopqrstuvwxyz/);
    assert.equal(e.sensitive, true);
  });

  test('reason-specific fields are still enforced (blocked-by needs --blocked-by) and nothing lands', () => {
    const r = runCli([...GOOD, '--reason', 'blocked-by']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /blocked-by/);
    assert.equal(ledgerEntries().length, 0);
  });

  test('a short rationale is refused with a non-zero exit and nothing lands (no silent padding)', () => {
    const args = [...GOOD]; args[args.indexOf('--rationale') + 1] = 'later';
    const r = runCli(args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /rationale/);
    assert.equal(ledgerEntries().length, 0);
  });

  test('--add together with --ledger is refused (exactly one source)', () => {
    const r = runCli([...GOOD, '--ledger', 'x.json']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exactly one of/);
    assert.equal(ledgerEntries().length, 0);
  });
});
