/**
 * @fileoverview Cluster A / Phase 1 — an ABSENT debt ledger must be
 * representable, not indistinguishable from an empty one.
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 "availability contract",
 * Phase 1. Defect this locks: `readDebtLedger` returned `{version:1,entries:[]}`
 * on ENOENT, so five scripts reported "0 open entries / clean / no debt"
 * having read nothing — including `debt-pr-comment.mjs`, which posts that claim
 * onto a pull request, and which in CI (a fresh clone, `.audit/` gitignored)
 * hit that path by DEFAULT.
 *
 * The vocabulary is not invented here: `scripts/check-stale-skill-surface.mjs`
 * already emits `status:'unverifiable', reason:'clean-checkout-sandbox'` for the
 * identical class, and two sibling debt checks already distinguish absent from
 * empty in their human output (`debt-ledger-claims-check.mjs:86-89`,
 * `debt-capture-trail-check.mjs:133-136`) while crediting the discipline to
 * `debt-health-check.mjs`, which did not implement it.
 *
 * The rule the table generalises: NO read failure of any kind may produce an
 * empty-but-valid ledger. Enumerating only ENOENT would leave the same bug
 * reachable through four other doors, which is why every door gets a case.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readDebtLedger, LEDGER_UNAVAILABLE_REASONS } from '../scripts/lib/debt-ledger.mjs';

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `debt-avail-${label}-`));
}

function rmrf(dir) {
  // `maxRetries`/`retryDelay` rather than a hand-rolled loop: Windows holds
  // EPERM/EBUSY briefly after a write, and the repo pins this shape so the
  // hardening is greppable (tests/rmsync-retry-guard.test.mjs).
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch { /* best-effort cleanup */ }
}

describe('readDebtLedger — absence is representable', () => {
  test('ABSENT ledger reports available:false with a reason, not an empty ledger', () => {
    const dir = tmpdir('enoent');
    try {
      const ledgerPath = path.join(dir, 'tech-debt.json');
      const r = readDebtLedger({ ledgerPath, events: [] });

      assert.equal(r.available, false, 'an absent ledger must report available:false');
      assert.equal(r.reason, 'clean-checkout-sandbox');
      assert.deepEqual(r.entries, [], 'entries stays [] so existing callers are unaffected');
      assert.ok(
        LEDGER_UNAVAILABLE_REASONS.includes(r.reason),
        'reason must come from the closed enum',
      );
    } finally { rmrf(dir); }
  });

  test('PRESENT but empty ledger reports available:true — the distinction that was missing', () => {
    const dir = tmpdir('empty');
    try {
      const ledgerPath = path.join(dir, 'tech-debt.json');
      fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, entries: [] }), 'utf-8');
      const r = readDebtLedger({ ledgerPath, events: [] });

      assert.equal(r.available, true, 'a real empty ledger IS a measurement');
      assert.equal(r.reason, null);
      assert.deepEqual(r.entries, []);
    } finally { rmrf(dir); }
  });

  test('PRESENT with entries reports available:true and hydrates as before', () => {
    const dir = tmpdir('populated');
    try {
      const ledgerPath = path.join(dir, 'tech-debt.json');
      fs.writeFileSync(ledgerPath, JSON.stringify({
        version: 1,
        entries: [{ topicId: 'aaaa1111', severity: 'HIGH', category: 'x', section: 'y' }],
      }), 'utf-8');
      const r = readDebtLedger({ ledgerPath, events: [] });

      assert.equal(r.available, true);
      assert.equal(r.entries.length, 1);
      assert.equal(r.entries[0].topicId, 'aaaa1111');
      assert.equal(r.entries[0].distinctRunCount, 0, 'hydration still happens');
    } finally { rmrf(dir); }
  });

  test('UNREADABLE path (a directory where a file is expected) is unavailable, never empty', () => {
    const dir = tmpdir('eisdir');
    try {
      const ledgerPath = path.join(dir, 'tech-debt.json');
      fs.mkdirSync(ledgerPath); // exists, but reading it throws EISDIR
      const r = readDebtLedger({ ledgerPath, events: [] });

      assert.equal(r.available, false, 'an unreadable ledger must not read as clean');
      assert.equal(r.reason, 'ledger-unreadable');
      assert.deepEqual(r.entries, []);
    } finally { rmrf(dir); }
  });

  test('MALFORMED JSON still throws — corruption is fail-loud, not unavailable', () => {
    const dir = tmpdir('malformed');
    try {
      const ledgerPath = path.join(dir, 'tech-debt.json');
      fs.writeFileSync(ledgerPath, '{ this is not json', 'utf-8');
      assert.throws(
        () => readDebtLedger({ ledgerPath, events: [] }),
        (err) => /corrupt/i.test(err.message),
        'a corrupt ledger is a louder failure than an unavailable one; it must not be softened',
      );
    } finally { rmrf(dir); }
  });

  test('SCHEMA-INVALID content still throws rather than degrading to empty', () => {
    const dir = tmpdir('schema');
    try {
      const ledgerPath = path.join(dir, 'tech-debt.json');
      fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, notEntries: [] }), 'utf-8');
      assert.throws(
        () => readDebtLedger({ ledgerPath, events: [] }),
        (err) => /corrupt/i.test(err.message),
      );
    } finally { rmrf(dir); }
  });

  test('the unchanged-caller direction: a caller ignoring `available` behaves exactly as before', () => {
    // R9 in the plan's risk register. `entries` keeps its meaning, so the six+
    // existing importers that destructure only `{ entries }` are unaffected.
    const dir = tmpdir('compat');
    try {
      const ledgerPath = path.join(dir, 'tech-debt.json');
      const { entries } = readDebtLedger({ ledgerPath, events: [] });
      assert.deepEqual(entries, [], 'destructuring `entries` alone still works on an absent ledger');
    } finally { rmrf(dir); }
  });
});
