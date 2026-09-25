/**
 * @fileoverview CLI black-box coverage for the same-file-batch nudge added
 * to `debt-auto-capture.mjs` (docs/plans/triage-independence-test-and-
 * write-boundary-fixes.md). Follows the same pattern as
 * tests/debt-auto-capture-trail-warn-cli.test.mjs — advisory WARN, never
 * changes the exit code.
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

const runCli = makeRunCli(scriptPath, { cwd: () => tmpDir, buildEnv: () => ({ ...process.env, AUDIT_DB_URL: '' }) });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-auto-capture-samefile-'));
  auditDir = path.join(tmpDir, '.audit');
  fs.mkdirSync(auditDir, { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

describe('debt-auto-capture.mjs — same-file-batch nudge', () => {
  test('5 same-file out-of-scope defers → WARN naming the file and count', () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeDeferEntry(`t${i}`));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARN: 5 out-of-scope defers in this batch cite src\/x\.js/);
  });

  test('4 same-file entries (under threshold) → no WARN', () => {
    const entries = Array.from({ length: 4 }, (_, i) => makeDeferEntry(`t${i}`));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /out-of-scope defers in this batch cite/);
  });

  test('5 same-file entries but --reason blocked-by → no WARN (reason gate)', () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeDeferEntry(`t${i}`));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1', '--reason', 'blocked-by', '--blocked-by', 'owner/repo#1']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /out-of-scope defers in this batch cite/);
  });

  test('5 entries across 5 different files → no WARN (grouping, not just count)', () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeDeferEntry(`t${i}`, {
      affectedFiles: [`src/file-${i}.js`], section: `src/file-${i}.js:1`,
    }));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /out-of-scope defers in this batch cite/);
  });

  test('5 entries citing the shared file as their SECOND affectedFiles entry → WARN still fires (locks the affectedFiles[0]-only false negative)', () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeDeferEntry(`t${i}`, {
      affectedFiles: [`src/unique-${i}.js`, 'src/shared.js'],
      section: `src/unique-${i}.js:1`,
    }));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARN: 5 out-of-scope defers in this batch cite src\/shared\.js/);
  });

  test('--changed given and the file is NOT in it → no WARN', () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeDeferEntry(`t${i}`));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1', '--changed', 'src/unrelated.js,src/other.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /out-of-scope defers in this batch cite/);
  });

  test('--changed given and the file IS in it → WARN fires with assertive (not hedged) wording, distinct from the no-`--changed` case', () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeDeferEntry(`t${i}`));
    const ledgerPathA = writeRoundLedger('sidA-ledger.json', entries);
    const withChanged = runCli(['--ledger', ledgerPathA, '--run', 'sidA', '--changed', 'src/x.js']);
    assert.equal(withChanged.status, 0, withChanged.stderr);
    assert.match(withChanged.stderr, /which is in your diff/);
    assert.doesNotMatch(withChanged.stderr, /may be in your diff/);

    const entries2 = Array.from({ length: 5 }, (_, i) => makeDeferEntry(`u${i}`));
    const ledgerPathB = writeRoundLedger('sidB-ledger.json', entries2);
    const noChanged = runCli(['--ledger', ledgerPathB, '--run', 'sidB']);
    assert.equal(noChanged.status, 0, noChanged.stderr);
    assert.match(noChanged.stderr, /may be in your diff — verify/);
    assert.doesNotMatch(noChanged.stderr, /which is in your diff/);
  });
});

describe('debt-auto-capture.mjs — template-rationale nudge', () => {
  test('3 defers with the same boilerplate template (only the identifier differs) → WARN naming the topic ids', () => {
    const entries = ['getRunMeta', 'recordFindings', 'markFindingsRemediation'].map((fn, i) => makeDeferEntry(`t${i}`, {
      affectedFiles: [`src/file-${i}.js`], section: `src/file-${i}.js:1`,
      rulingRationale: `unrelated to \`${fn}\` — verified zero coupling to \`${fn}\`, the only function this plan modifies in this file.`,
    }));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARN: 3 out-of-scope defers in this batch share near-identical rationale wording/);
    assert.match(r.stderr, /topics: t0, t1, t2/);
  });

  test('2 defers with the same template (under threshold) → no template WARN', () => {
    const entries = ['getRunMeta', 'recordFindings'].map((fn, i) => makeDeferEntry(`t${i}`, {
      affectedFiles: [`src/file-${i}.js`], section: `src/file-${i}.js:1`,
      rulingRationale: `unrelated to \`${fn}\` — verified zero coupling to \`${fn}\`.`,
    }));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /near-identical rationale wording/);
  });

  test('3 defers with genuinely different rationale prose → no template WARN', () => {
    const rationales = [
      'the dedup step operates on a different column than the guard this plan added, and neither depends on the other\'s correctness.',
      'this is a documentation-only fix in a section the plan never edits, unrelated to the write-path change.',
      'the final-review credit flow uses its own transaction, entirely separate from the remediation-verification path this plan touched.',
    ];
    const entries = rationales.map((rationale, i) => makeDeferEntry(`t${i}`, {
      affectedFiles: [`src/file-${i}.js`], section: `src/file-${i}.js:1`, rulingRationale: rationale,
    }));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /near-identical rationale wording/);
  });

  test('a template split across files still fires (catches ducking the same-file threshold)', () => {
    // 3 entries, 3 different files — none would trip the same-file WARN (needs
    // 5 in ONE file), but they share the exact same rationale template.
    const entries = ['a', 'b', 'c'].map((fn, i) => makeDeferEntry(`t${i}`, {
      affectedFiles: [`src/totally-different-${i}.js`], section: `src/totally-different-${i}.js:1`,
      rulingRationale: `unrelated to \`${fn}\` — verified zero coupling to \`${fn}\`, the only function this plan modifies in this file.`,
    }));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /out-of-scope defers in this batch cite/, 'same-file WARN must NOT fire — different files');
    assert.match(r.stderr, /near-identical rationale wording/, 'template WARN must fire regardless');
  });

  test('5 same-file entries but --reason blocked-by → no template WARN (reason gate)', () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeDeferEntry(`t${i}`, {
      rulingRationale: 'unrelated to `x` — verified zero coupling to `x`, the only function this plan modifies in this file.',
    }));
    const ledgerPath = writeRoundLedger('sid1-ledger.json', entries);
    const r = runCli(['--ledger', ledgerPath, '--run', 'sid1', '--reason', 'blocked-by', '--blocked-by', 'owner/repo#1']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /near-identical rationale wording/);
  });
});
