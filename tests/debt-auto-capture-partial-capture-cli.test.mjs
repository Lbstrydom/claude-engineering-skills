/**
 * @fileoverview Regression tests for the two defects behind the 2026-09-04
 * measurement: an /audit-code run captured 9 of 15 `ruling: defer` entries and
 * exited 0.
 *
 *   (1) `PersistedDebtEntrySchema.deferredRationale` capped at 400 chars while
 *       its producer — /audit-code Step 3's honest-deferral check — requires a
 *       defer to name the root cause, the rejected minimal in-scope fix, the
 *       residual risk AND (out-of-scope) the independence argument. The cap
 *       therefore rejected the BEST-reasoned deferrals first, and debt memory
 *       kept the least-reasoned ones. Measured over 2,116 historical ledger
 *       rulings: max 1945 chars overall; 22.5% of HIGH defers over 400 against
 *       4.3% of LOW.
 *   (2) `debt-auto-capture.mjs` exited 0 unless EVERY entry was rejected, so a
 *       partial capture was indistinguishable from a complete one to any caller
 *       checking `$?`.
 *
 * Each test below fails on the pre-fix code. The clean-capture case is the
 * negative control: it pins the direction the new non-zero exit must NOT fire.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PersistedDebtEntrySchema } from '../scripts/lib/schemas.mjs';

let tmpDir;
let auditDir;
const scriptPath = path.resolve('scripts/debt-auto-capture.mjs');

/**
 * A rationale shaped like the real thing: the four components Step 3 demands,
 * padded to `len` so the length — not the wording — is what is under test.
 */
function realisticRationale(len) {
  const head =
    'Root cause: the resolver reads the alias map before the domain retag lands. '
    + 'Minimal in-scope fix considered and rejected: re-ordering the two reads inside '
    + 'this PR would require re-baselining every inbound edge, which is a separate change. '
    + 'Residual risk: a retag between the two reads still yields a stale from-domain. '
    + 'Independence: the code shipped here never calls the resolver on that path; it '
    + 'fails identically with or without this change. ';
  return head.repeat(Math.ceil(len / head.length)).slice(0, len);
}

function writeRoundLedger(name, entries) {
  const p = path.join(auditDir, name);
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries }));
  return p;
}

function makeDeferEntry(topicId, rulingRationale, extra = {}) {
  return {
    topicId,
    ruling: 'defer',
    severity: 'HIGH',
    category: 'god-module',
    section: 'src/x.js:1',
    detailSnapshot: 'a sufficiently descriptive detail snapshot',
    rulingRationale,
    affectedFiles: ['src/x.js'],
    ...extra,
  };
}

function runCli(args) {
  return spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf-8',
    cwd: tmpDir,
    // Cloud deliberately disabled — syncToCloud() is non-blocking either way and
    // these assertions are about the LOCAL ledger and the exit code.
    env: { ...process.env, AUDIT_DB_URL: '' },
  });
}

function readCapturedTopicIds() {
  const p = path.join(auditDir, 'tech-debt.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8')).entries.map((e) => e.topicId);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-auto-capture-partial-'));
  auditDir = path.join(tmpDir, '.audit');
  fs.mkdirSync(auditDir, { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

describe('PersistedDebtEntrySchema.deferredRationale — cap accommodates its producer', () => {
  function entryWithRationale(rationale) {
    return {
      topicId: 't1',
      semanticHash: 'h1',
      severity: 'HIGH',
      category: 'god-module',
      section: 'src/x.js:1',
      detailSnapshot: 'detail',
      affectedFiles: ['src/x.js'],
      affectedPrinciples: [],
      pass: 'structure',
      source: 'debt',
      deferredReason: 'out-of-scope',
      deferredAt: new Date().toISOString(),
      deferredRun: 'sid1',
      deferredRationale: rationale,
    };
  }

  test('accepts a 1602-char rationale — the longest `ruling: defer` text measured in this repo', () => {
    const r = PersistedDebtEntrySchema.safeParse(entryWithRationale(realisticRationale(1602)));
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  });

  test('accepts a 1945-char rationale — the longest ruling text of ANY ruling measured', () => {
    const r = PersistedDebtEntrySchema.safeParse(entryWithRationale(realisticRationale(1945)));
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  });

  test('still bounds the footprint: rejects over 4000 chars', () => {
    const r = PersistedDebtEntrySchema.safeParse(entryWithRationale(realisticRationale(4001)));
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error.issues), /too_big/);
  });

  test('still rejects a rubber-stamp rationale under 20 chars', () => {
    const r = PersistedDebtEntrySchema.safeParse(entryWithRationale('pre-existing'));
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error.issues), /too_small/);
  });
});

describe('debt-auto-capture.mjs — a partial capture must not read as a complete one', () => {
  test('captures a HIGH defer whose rationale states all four Step 3 components', () => {
    // Pre-fix: rejected with Zod `too_big`, absent from the ledger, exit 0.
    const ledger = writeRoundLedger('sid1-ledger.json', [
      makeDeferEntry('well-reasoned-high', realisticRationale(900)),
    ]);
    const r = runCli(['--ledger', ledger, '--run', 'sid1']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(readCapturedTopicIds(), ['well-reasoned-high']);
  });

  test('exits non-zero and says PARTIAL CAPTURE when only some entries land', () => {
    // Pre-fix: exit 0, because not ALL entries were rejected.
    const ledger = writeRoundLedger('sid2-ledger.json', [
      makeDeferEntry('lands', realisticRationale(500)),
      makeDeferEntry('rejected-too-long', realisticRationale(4500)),
    ]);
    const r = runCli(['--ledger', ledger, '--run', 'sid2']);

    assert.equal(r.status, 1, 'a capture that dropped an entry must not report success');
    assert.match(r.stderr, /PARTIAL CAPTURE: 1 of 2/);
    assert.match(r.stdout, /Rejected: 1/);
    assert.match(r.stdout, /rejected-too-long/);
    // The entries that DID validate are still written — the exit code reports
    // incompleteness, it does not roll the write back.
    assert.deepEqual(readCapturedTopicIds(), ['lands']);
  });

  test('negative control — a fully clean multi-entry capture still exits 0', () => {
    // The direction the new non-zero exit must NOT fire.
    const ledger = writeRoundLedger('sid3-ledger.json', [
      makeDeferEntry('a', realisticRationale(120)),
      makeDeferEntry('b', realisticRationale(1400)),
      makeDeferEntry('c', realisticRationale(60)),
    ]);
    const r = runCli(['--ledger', ledger, '--run', 'sid3']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /PARTIAL CAPTURE/);
    assert.deepEqual(readCapturedTopicIds().sort(), ['a', 'b', 'c']);
  });

  test('re-running after fixing the cause is idempotent and then exits 0', () => {
    const bad = writeRoundLedger('sid4-ledger.json', [
      makeDeferEntry('lands', realisticRationale(500)),
      makeDeferEntry('over-cap', realisticRationale(4500)),
    ]);
    assert.equal(runCli(['--ledger', bad, '--run', 'sid4']).status, 1);

    // Operator shortens the offending rationale (still well over the 400 the
    // old cap allowed) and re-runs the same command.
    writeRoundLedger('sid4-ledger.json', [
      makeDeferEntry('lands', realisticRationale(500)),
      makeDeferEntry('over-cap', realisticRationale(1500)),
    ]);
    const r = runCli(['--ledger', bad, '--run', 'sid4']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(readCapturedTopicIds().sort(), ['lands', 'over-cap']);
  });
});
