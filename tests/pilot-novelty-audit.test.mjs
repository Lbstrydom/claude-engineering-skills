/**
 * Amendment 2's audit arithmetic and the signed amendment file (docs/experiments/seeded-bench/amendment-2-novelty-audit.json).
 * Controls: the one-sided Clopper-Pearson bound is checked against closed forms and against an independent binomial sum; the real
 * amendment file's `passesWhenFalseSuppressionsAtMost` must equal what the code derives (a doc that drifts from the code fails).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clopperPearsonUpper, auditVerdict, maxFalseSuppressions, pickAuditSample, readAmendment, isSuppressed, isCovered } from '../scripts/lib/audit/pilot-novelty-audit.mjs';

const AMENDMENT = path.resolve('docs/experiments/seeded-bench/amendment-2-novelty-audit.json');

test('Clopper-Pearson upper bound: f=0 has the closed form 1-(1-c)^(1/n); the bound is monotone in f; edge cases', () => {
  for (const n of [10, 40, 80]) assert.ok(Math.abs(clopperPearsonUpper(0, n) - (1 - 0.05 ** (1 / n))) < 1e-6, `n=${n}`);
  assert.ok(clopperPearsonUpper(1, 60) > clopperPearsonUpper(0, 60) && clopperPearsonUpper(2, 60) > clopperPearsonUpper(1, 60));
  assert.equal(clopperPearsonUpper(0, 0), 1); assert.equal(clopperPearsonUpper(5, 5), 1);
  assert.throws(() => clopperPearsonUpper(-1, 5), /invalid/); assert.throws(() => clopperPearsonUpper(6, 5), /invalid/);
  // independent check: at the returned bound p, P(X <= f) must equal alpha
  const f = 3; const n = 80; const p = clopperPearsonUpper(f, n);
  let cdf = 0; let c = 1; for (let i = 0; i <= f; i++) { if (i) c = (c * (n - i + 1)) / i; cdf += c * p ** i * (1 - p) ** (n - i); }
  assert.ok(Math.abs(cdf - 0.05) < 1e-6, `cdf ${cdf}`);
});

test('the amendment tolerance: 80 audited and an upper bound of 0.15 pass with at most 6 false suppressions, never 7', () => {
  assert.equal(maxFalseSuppressions({ n: 80, upperBoundMax: 0.15 }), 6);
  assert.equal(auditVerdict({ n: 80, f: 6, upperBoundMax: 0.15 }).pass, true);
  assert.equal(auditVerdict({ n: 80, f: 7, upperBoundMax: 0.15 }).pass, false);
  assert.equal(auditVerdict({ n: 0, f: 0, upperBoundMax: 0.15 }).pass, false, 'nothing audited proves nothing');
});

test('the signed amendment file validates and agrees with the code (a drifted number in the document fails here)', () => {
  const a = readAmendment(AMENDMENT);
  assert.equal(a.epoch, 'seeded-bench-v2');
  assert.equal(a.audit.passesWhenFalseSuppressionsAtMost, maxFalseSuppressions({ n: a.audit.sample, upperBoundMax: a.audit.upperBoundMax, confidence: a.audit.confidence }));
  for (const bad of [{ epoch: 'seeded-bench-v1' }, { approvedBy: '' }, { suppression: 'either-judge' }, { audit: { ...a.audit, sample: 0 } }, { audit: { ...a.audit, upperBoundMax: 1 } }]) {
    assert.throws(() => readAmendment('x', { readText: () => JSON.stringify({ ...a, ...bad }) }), /not valid/, JSON.stringify(bad).slice(0, 40));
  }
});

test('the hidden sample is seeded, input-order independent, capped, and all-of-them under "all"', () => {
  const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
  const a = pickAuditSample({ suppressedKeys: keys, size: 10, seed: 's' });
  assert.equal(a.length, 10);
  assert.deepEqual(pickAuditSample({ suppressedKeys: [...keys].reverse(), size: 10, seed: 's' }), a);
  assert.notDeepEqual(pickAuditSample({ suppressedKeys: keys, size: 10, seed: 'other' }), a);
  assert.equal(pickAuditSample({ suppressedKeys: keys, size: 'all', seed: 's' }).length, 50);
  assert.equal(pickAuditSample({ suppressedKeys: keys, size: 500, seed: 's' }).length, 50);
});

test('a finding is hidden only when BOTH judges are present, judged, and said same', () => {
  const J = (novel, notJudged = false) => ({ novel, notJudged });
  assert.equal(isSuppressed({ opus: J(false), pro: J(false) }), true);
  for (const e of [{ opus: J(false), pro: J(true) }, { opus: J(true), pro: J(false) }, { opus: J(false), pro: J(false, true) }, { opus: J(false) }, {}]) assert.equal(isSuppressed(e), false, JSON.stringify(e));
  assert.equal(isCovered({ opus: J(false), pro: J(false, true) }), true); assert.equal(isCovered({ opus: J(false) }), false);
});
