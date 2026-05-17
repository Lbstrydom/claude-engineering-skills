/**
 * Tests for scripts/lib/requirements/ledger.mjs
 * Plan: docs/plans/requirements-layer.md — Plan-Phase A.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLedger, writeLedger, reconcile, deriveIndex } from '../scripts/lib/requirements/ledger.mjs';

function cand(over = {}) {
  return {
    id: 'REQ-correctness-aaaaaaaa', assertion: 'The reconcile step is idempotent.',
    kind: 'correctness', checkable: true,
    provenance: [{ file: 'scripts/lib/requirements/ledger.mjs', anchor: 'reconcile' }],
    appliesTo: [], evidence: { code: [], tests: [] }, seenInRuns: 2, confidence: 'high', ...over,
  };
}
const gap = (id, g = 'none') => ({ requirementId: id, gap: g, conflictsWith: [], rationale: 't' });
const COVERED = ['scripts/lib/requirements/ledger.mjs'];

describe('reconcile — status lifecycle', () => {
  it('a seenInRuns:2, gap-none candidate → active', () => {
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [gap('REQ-correctness-aaaaaaaa')] });
    assert.equal(l.requirements[0].status, 'active');
  });
  it('a contradictory gap → needs-review (audit H4)', () => {
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [gap('REQ-correctness-aaaaaaaa', 'contradictory')] });
    assert.equal(l.requirements[0].status, 'needs-review');
  });
  it('an observed-but-unintended gap → needs-review, kept out of the rubric (audit G1)', () => {
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [gap('REQ-correctness-aaaaaaaa', 'observed-but-unintended')] });
    assert.equal(l.requirements[0].status, 'needs-review');
  });
  it('a seenInRuns:1 candidate → inferred-only', () => {
    const l = reconcile({ candidates: [cand({ seenInRuns: 1, confidence: 'low' })], coveredFiles: COVERED, gapAssessments: [] });
    assert.equal(l.requirements[0].status, 'inferred-only');
  });
  it('an override accept forces active even for seenInRuns:1', () => {
    const l = reconcile({
      candidates: [cand({ seenInRuns: 1, confidence: 'low' })], coveredFiles: COVERED,
      gapAssessments: [], overrides: { 'REQ-correctness-aaaaaaaa': { decision: 'accept' } },
    });
    assert.equal(l.requirements[0].status, 'active');
  });
  it('an override reject drops the requirement', () => {
    const l = reconcile({
      candidates: [cand()], coveredFiles: COVERED, gapAssessments: [],
      overrides: { 'REQ-correctness-aaaaaaaa': { decision: 'reject' } },
    });
    assert.equal(l.requirements.length, 0);
  });
});

describe('reconcile — idempotency + identity', () => {
  it('reconcile is idempotent — re-run yields identical requirements', () => {
    const args = { candidates: [cand()], coveredFiles: COVERED, gapAssessments: [gap('REQ-correctness-aaaaaaaa')] };
    const first = reconcile(args);
    const second = reconcile({ ...args, priorLedger: first });
    assert.deepEqual(second.requirements, first.requirements);
  });
  it('an override-edited assertion is applied but the frozen id is kept (audit R2-M1)', () => {
    const l = reconcile({
      candidates: [cand()], coveredFiles: COVERED, gapAssessments: [],
      overrides: { 'REQ-correctness-aaaaaaaa': { assertion: 'A human-reworded assertion of the same invariant.' } },
    });
    assert.equal(l.requirements[0].id, 'REQ-correctness-aaaaaaaa');
    assert.match(l.requirements[0].assertion, /human-reworded/);
  });
  it('seenInRuns is a high-water mark — a degraded 1-run re-run does not downgrade (audit G2)', () => {
    const prior = reconcile({ candidates: [cand({ seenInRuns: 2 })], coveredFiles: COVERED, gapAssessments: [] });
    const degraded = reconcile({
      candidates: [cand({ seenInRuns: 1, confidence: 'low' })], coveredFiles: COVERED,
      gapAssessments: [], priorLedger: prior,
    });
    assert.equal(degraded.requirements[0].seenInRuns, 2);
    assert.equal(degraded.requirements[0].status, 'active', 'not downgraded to inferred-only');
  });
});

describe('reconcile — scoped partial merge (audit G1)', () => {
  it('a prior requirement outside the new coveredFiles is retained untouched', () => {
    const priorReq = { ...cand({ id: 'REQ-safety-bbbbbbbb', assertion: 'An invariant about another file.' }),
      provenance: [{ file: 'scripts/other.mjs', anchor: 'x' }], status: 'active', gap: null };
    const prior = { requirements: [priorReq], coveredFiles: ['scripts/other.mjs'], identityAliases: {} };
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [], priorLedger: prior });
    assert.ok(l.requirements.find((r) => r.id === 'REQ-safety-bbbbbbbb'), 'b-file requirement retained');
    assert.ok(l.requirements.find((r) => r.id === 'REQ-correctness-aaaaaaaa'), 'new requirement added');
    assert.deepEqual(l.coveredFiles, ['scripts/lib/requirements/ledger.mjs', 'scripts/other.mjs']);
  });
});

describe('loadLedger / writeLedger / deriveIndex', () => {
  it('round-trips through an atomic write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-ledger-'));
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [], commitSha: 'abc' });
    writeLedger(l, { baseDir: dir });
    const loaded = loadLedger({ baseDir: dir });
    assert.equal(loaded.requirements.length, 1);
    assert.equal(loaded.commitSha, 'abc');
  });
  it('loadLedger returns an empty ledger when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-ledger-'));
    assert.deepEqual(loadLedger({ baseDir: dir }).requirements, []);
  });
  it('deriveIndex projects id/assertion/kind/status only', () => {
    const l = reconcile({ candidates: [cand()], coveredFiles: COVERED, gapAssessments: [] });
    const idx = deriveIndex(l);
    assert.deepEqual(Object.keys(idx[0]).sort(), ['assertion', 'id', 'kind', 'status']);
  });
});
