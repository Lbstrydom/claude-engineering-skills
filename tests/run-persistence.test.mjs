/**
 * @fileoverview Tier 1 unit tests for scripts/lib/audit/run-persistence.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 4c) — direct
 * coverage of this module's pure, deterministic exports. `runPersistence`
 * itself (the cloud-write stage) is covered end-to-end through
 * tests/finalization-characterization.test.mjs's golden-master harness
 * (cloud OFF, per this repo's no-whole-provider-mock testing doctrine) —
 * this file covers the two pure helpers that can be tested in true
 * isolation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { validateLedgerForR2, buildSuppressionStats } = await import('../scripts/lib/audit/run-persistence.mjs');

describe('validateLedgerForR2 — R2+ ledger preflight', () => {
  function mkTmpLedger(entries, meta = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-persistence-'));
    const filePath = path.join(dir, 'ledger.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, ...meta, entries }), 'utf-8');
    return { filePath, dir };
  }

  it('round < 2 short-circuits to {valid:true} without reading the file', () => {
    assert.deepEqual(validateLedgerForR2('/does/not/exist.json', 1), { valid: true });
  });

  it('no --ledger (null path) on R2+ degrades to suppressionUnavailable', () => {
    assert.deepEqual(validateLedgerForR2(null, 2), { valid: false, suppressionUnavailable: true });
  });

  it('an unreadable/missing ledger file on R2+ degrades to suppressionUnavailable', () => {
    assert.deepEqual(validateLedgerForR2('/definitely/does/not/exist/ledger.json', 2), { valid: false, suppressionUnavailable: true });
  });

  it('a corrupt (non-JSON) ledger file degrades to suppressionUnavailable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-persistence-'));
    const filePath = path.join(dir, 'ledger.json');
    fs.writeFileSync(filePath, 'not json', 'utf-8');
    try {
      assert.deepEqual(validateLedgerForR2(filePath, 2), { valid: false, suppressionUnavailable: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a valid ledger with entries reports entryCount and validEntries', () => {
    const { filePath, dir } = mkTmpLedger([{
      topicId: 't1', semanticHash: 'h1', severity: 'MEDIUM', category: 'c', section: 's',
      detailSnapshot: 'd', affectedFiles: [], affectedPrinciples: [], pass: 'backend',
      source: 'session', adjudicationOutcome: 'dismissed', remediationState: 'pending',
      originalSeverity: 'MEDIUM', ruling: 'sustain', rulingRationale: 'r', resolvedRound: 1,
    }]);
    try {
      const result = validateLedgerForR2(filePath, 2);
      assert.equal(result.valid, true);
      assert.equal(result.entryCount, 1);
      assert.equal(result.validEntries.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('buildSuppressionStats — suppression provenance for audit_runs.suppression_stats', () => {
  const LEDGER = { entryCount: 12, adjudicated: 9, pending: 2, invalid: 1 };
  const SUPP = { keptCount: 20, suppressedCount: 3, reopenedCount: 1, fpSuppressedCount: 0 };

  it('round 1 returns null — suppression has not run, distinct from a measured zero', () => {
    assert.equal(buildSuppressionStats({ round: 1, ledger: LEDGER, suppression: SUPP }), null);
  });

  it('an R2+ round carries the ruling-set size as the denominator', () => {
    const stats = buildSuppressionStats({ round: 2, ledger: LEDGER, suppression: SUPP });
    assert.equal(stats.round, 2);
    assert.deepEqual(stats.ledger, LEDGER);
    assert.equal(stats.suppressed, 3);
    assert.equal(stats.kept, 20);
    assert.equal(stats.reopened, 1);
  });

  it('an unavailable ledger reports {unavailable:true}, never zeroed counts', () => {
    const stats = buildSuppressionStats({ round: 2, ledger: { unavailable: true }, suppression: SUPP });
    assert.deepEqual(stats.ledger, { unavailable: true });
  });

  it('never carries the finding arrays — this is a row, not a payload dump', () => {
    const stats = buildSuppressionStats({
      round: 2, ledger: LEDGER,
      suppression: { ...SUPP, suppressed: [{ finding: { detail: 'x'.repeat(5000) } }], reopened: [{ a: 1 }] },
    });
    assert.equal(stats.suppressed, 3);
    assert.equal('suppressedArray' in stats, false);
  });

  it('a missing suppression payload still records ledger provenance, with absent counters staying absent', () => {
    const stats = buildSuppressionStats({ round: 2, ledger: LEDGER, suppression: undefined });
    assert.deepEqual(stats.ledger, LEDGER);
    assert.equal(stats.suppressed, undefined);
  });
});
