/**
 * @fileoverview Tier 1 regression tests for Phase 9 of
 * docs/plans/audit-orchestrator-hardening.md — `createEnvelope` and
 * `mergeIntoEnvelopes` (scripts/lib/audit/candidate-envelope.mjs) must
 * preserve every original field on a contributing finding via
 * `evidenceAlternatives[].fullClaim` (a `structuredClone`, so mutation-safe),
 * even for a LOSING alternative whose reduced `evidenceEntry` projection
 * (`{sourceModel, evidenceType, anchor, triggerAnchor, causalChain,
 * rawDetail}`) would otherwise drop fields like `_hash`/`principle`/
 * `classification`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelope, mergeIntoEnvelopes } from '../scripts/lib/audit/candidate-envelope.mjs';

function mkFinding(overrides = {}) {
  return {
    id: 'H1', severity: 'MEDIUM', category: 'Cat', section: 'a.mjs:1', detail: 'detail text',
    risk: 'risk text', recommendation: 'rec text', is_quick_fix: false, is_mechanical: false,
    principle: 'Principle X',
    classification: { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'gpt' },
    _hash: 'hash123', _fingerprint: 'fp-abc', _pass: 'backend', _sourceModel: 'gpt-5',
    ...overrides,
  };
}

describe('createEnvelope — fullClaim provenance', () => {
  it('every original field on the finding is recoverable from evidenceAlternatives[0].fullClaim', () => {
    const finding = mkFinding();
    const envelope = createEnvelope(finding, { sourceModel: 'gpt-5', pass: 'backend', timestamp: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(envelope.evidenceAlternatives[0].fullClaim, finding);
  });

  it('fullClaim is a deep clone (structuredClone), not a reference — later mutation of the original does not leak through', () => {
    const finding = mkFinding();
    const envelope = createEnvelope(finding, { sourceModel: 'gpt-5', pass: 'backend' });
    finding.detail = 'MUTATED-AFTER-ENVELOPE-BUILT';
    finding.classification.sonarType = 'BUG';
    assert.equal(envelope.evidenceAlternatives[0].fullClaim.detail, 'detail text');
    assert.equal(envelope.evidenceAlternatives[0].fullClaim.classification.sonarType, 'CODE_SMELL');
  });

  it('fullClaim carries fields the reduced evidenceEntry projection does not (e.g. _hash, principle, classification)', () => {
    const finding = mkFinding({ _hash: 'a1b2c3d4', principle: 'Long-Term Sustainability (#20)' });
    const envelope = createEnvelope(finding, { sourceModel: 'gpt-5', pass: 'backend' });
    const entry = envelope.evidenceAlternatives[0];
    // The reduced projection itself never carried these — confirms fullClaim
    // is genuinely additive, not just duplicating what was already there.
    assert.equal(entry._hash, undefined);
    assert.equal(entry.principle, undefined);
    assert.equal(entry.fullClaim._hash, 'a1b2c3d4');
    assert.equal(entry.fullClaim.principle, 'Long-Term Sustainability (#20)');
  });
});

describe('mergeIntoEnvelopes — fullClaim provenance for the LOSING alternative', () => {
  it('a lower-severity contributor merged under the same fingerprint keeps its full original claim recoverable via fullClaim, even though it never becomes canonical', () => {
    const winner = mkFinding({ id: 'H1', severity: 'HIGH', _fingerprint: 'fp-shared', _sourceModel: 'gpt-5', detail: 'winner detail', _hash: 'hash-winner' });
    const loser = mkFinding({ id: 'H2', severity: 'MEDIUM', _fingerprint: 'fp-shared', _sourceModel: 'claude', detail: 'loser detail', _hash: 'hash-loser', principle: 'Loser Principle' });
    const [envelope] = mergeIntoEnvelopes([winner, loser]);

    assert.equal(envelope.canonicalFinding.detail, 'winner detail', 'HIGH stays canonical over a later-merged MEDIUM');
    const losingEntry = envelope.evidenceAlternatives.find(a => a.sourceModel === 'claude');
    assert.ok(losingEntry, 'the losing contributor must still have an evidenceAlternatives entry');
    assert.deepEqual(losingEntry.fullClaim, loser, 'the losing entry\'s fullClaim must round-trip the ORIGINAL finding exactly');
  });

  it('a HIGHER-severity later contributor is promoted to canonical, and the original canonical (now demoted) keeps its fullClaim recoverable', () => {
    const first = mkFinding({ id: 'H1', severity: 'LOW', _fingerprint: 'fp-shared2', _sourceModel: 'gpt-5', detail: 'first detail', _hash: 'hash-first' });
    const second = mkFinding({ id: 'H2', severity: 'HIGH', _fingerprint: 'fp-shared2', _sourceModel: 'claude', detail: 'second detail', _hash: 'hash-second' });
    const [envelope] = mergeIntoEnvelopes([first, second]);

    assert.equal(envelope.canonicalFinding.detail, 'second detail', 'HIGH promotes over the earlier-merged LOW');
    const demotedEntry = envelope.evidenceAlternatives.find(a => a.sourceModel === 'gpt-5');
    assert.ok(demotedEntry, 'the demoted original canonical must still have an evidenceAlternatives entry');
    assert.deepEqual(demotedEntry.fullClaim, first, 'the demoted entry\'s fullClaim must round-trip the ORIGINAL first finding exactly');
  });

  it('three-way merge: every contributor\'s fullClaim is independently recoverable regardless of merge order', () => {
    const a = mkFinding({ id: 'H1', severity: 'LOW', _fingerprint: 'fp-3way', _sourceModel: 'model-a', detail: 'a detail', _hash: 'hash-a' });
    const b = mkFinding({ id: 'H2', severity: 'HIGH', _fingerprint: 'fp-3way', _sourceModel: 'model-b', detail: 'b detail', _hash: 'hash-b' });
    const c = mkFinding({ id: 'H3', severity: 'MEDIUM', _fingerprint: 'fp-3way', _sourceModel: 'model-c', detail: 'c detail', _hash: 'hash-c' });
    const [envelope] = mergeIntoEnvelopes([a, b, c]);

    assert.equal(envelope.evidenceAlternatives.length, 3);
    for (const [original, sourceModel] of [[a, 'model-a'], [b, 'model-b'], [c, 'model-c']]) {
      const entry = envelope.evidenceAlternatives.find(e => e.sourceModel === sourceModel);
      assert.ok(entry, `expected an evidenceAlternatives entry for ${sourceModel}`);
      assert.deepEqual(entry.fullClaim, original);
    }
  });
});
