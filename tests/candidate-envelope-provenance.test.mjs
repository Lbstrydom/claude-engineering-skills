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
import { createEnvelope, mergeIntoEnvelopes, promoteAlternative } from '../scripts/lib/audit/candidate-envelope.mjs';

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

// Moved from tests/evidence-triage.test.mjs (arch-audit-pipeline-observability-
// hardening.md item 13) — these two blocks test candidate-envelope.mjs's
// mergeIntoEnvelopes/promoteAlternative, a separate production module from
// evidence-triage.mjs's Stage-0 triage, which is that file's own scope.

describe('AuditCandidateEnvelope — merge contract (round-2 finding #6)', () => {
  const finding = (overrides) => ({
    id: 'H1', severity: 'MEDIUM', category: 'x', section: 'a.js', detail: 'd', risk: 'r',
    recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'p',
    _fingerprint: 'fp1', _pass: 'backend', ...overrides,
  });

  it('groups findings sharing a fingerprint into ONE envelope', () => {
    const envelopes = mergeIntoEnvelopes([finding({ _sourceModel: 'glm' }), finding({ _sourceModel: 'sonnet' })]);
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].evidenceAlternatives.length, 2);
  });
  it('does NOT group findings with different fingerprints', () => {
    const envelopes = mergeIntoEnvelopes([finding({ _fingerprint: 'fp1' }), finding({ _fingerprint: 'fp2' })]);
    assert.equal(envelopes.length, 2);
  });
  it('envelope severity is the MAXIMUM of contributing severities', () => {
    const envelopes = mergeIntoEnvelopes([
      finding({ severity: 'MEDIUM', _sourceModel: 'a' }),
      finding({ severity: 'HIGH', _sourceModel: 'b' }),
    ]);
    assert.equal(envelopes[0].canonicalFinding.severity, 'HIGH');
  });
  it('preserves ALL contributing evidence, including from the non-canonical (lower-severity) source', () => {
    const envelopes = mergeIntoEnvelopes([
      finding({ severity: 'MEDIUM', _sourceModel: 'a', detail: 'first take' }),
      finding({ severity: 'HIGH', _sourceModel: 'b', detail: 'second take' }),
    ]);
    const details = envelopes[0].evidenceAlternatives.map((e) => e.rawDetail).sort();
    assert.deepEqual(details, ['first take', 'second take']);
  });
  it('keeps evidenceAlternatives[0] pointing at the canonical claim after a severity promotion (consolidated Gemini gate fix G2, round 2)', () => {
    // The module's own JSDoc documents evidenceAlternatives as "Includes the
    // canonical claim too (index 0)" — a later, higher-severity contributor
    // must swap into index 0 when it's promoted, not just get appended.
    const envelopes = mergeIntoEnvelopes([
      finding({ severity: 'MEDIUM', _sourceModel: 'a', detail: 'first take' }),
      finding({ severity: 'HIGH', _sourceModel: 'b', detail: 'second take' }),
    ]);
    assert.equal(envelopes[0].canonicalFinding.severity, 'HIGH');
    assert.equal(envelopes[0].evidenceAlternatives[0].rawDetail, 'second take');
    assert.equal(envelopes[0].evidenceAlternatives[0].sourceModel, 'b');
    // Nothing lost — the demoted lower-severity claim is still present, just not at index 0.
    assert.equal(envelopes[0].evidenceAlternatives[1].rawDetail, 'first take');
  });
  it('keeps index 0 correct across THREE contributors with an intermediate then final promotion', () => {
    const envelopes = mergeIntoEnvelopes([
      finding({ severity: 'LOW', _sourceModel: 'a', detail: 'low take' }),
      finding({ severity: 'MEDIUM', _sourceModel: 'b', detail: 'medium take' }),
      finding({ severity: 'HIGH', _sourceModel: 'c', detail: 'high take' }),
    ]);
    assert.equal(envelopes[0].canonicalFinding.severity, 'HIGH');
    assert.equal(envelopes[0].evidenceAlternatives[0].rawDetail, 'high take');
    const allDetails = envelopes[0].evidenceAlternatives.map((e) => e.rawDetail).sort();
    assert.deepEqual(allDetails, ['high take', 'low take', 'medium take']); // nothing lost across 2 promotions
  });
  it('throws with the offending index rather than silently dropping un-fingerprinted findings (audit fix H4)', () => {
    assert.throws(
      () => mergeIntoEnvelopes([finding(), { ...finding(), _fingerprint: undefined }]),
      /indexes: 1/,
    );
  });
});

describe('promoteAlternative', () => {
  it('promotes an alternative to canonical, demoting the original (never discarding it)', () => {
    const envelope = createEnvelope(
      { detail: 'canonical', evidenceType: 'commission', anchor: { quote: 'bad' }, _fingerprint: 'fp' },
      { sourceModel: 'gpt', pass: 'backend' },
    );
    envelope.evidenceAlternatives.push({ sourceModel: 'gemini', evidenceType: 'commission', anchor: { quote: 'good' }, rawDetail: 'alt' });
    const promoted = promoteAlternative(envelope, 1);
    assert.equal(promoted.canonicalFinding.anchor.quote, 'good');
    assert.equal(promoted.evidenceAlternatives[0].detail, undefined); // original entry shape unchanged (index 0 was never touched)
    assert.equal(promoted.evidenceAlternatives.length, 2); // nothing discarded
  });
  it('is a no-op (returns the same envelope) for an out-of-range index', () => {
    const envelope = createEnvelope({ detail: 'x', _fingerprint: 'fp' }, { sourceModel: 'gpt', pass: 'backend' });
    assert.equal(promoteAlternative(envelope, 99), envelope);
  });
  it('remaps the promoted alt\'s rawDetail onto canonicalFinding.detail — never pairs the FAILED claim\'s prose with the promoted claim\'s anchor (consolidated Gemini gate fix G2)', () => {
    const envelope = createEnvelope(
      { detail: 'the failed model said X is broken', evidenceType: 'commission', anchor: { quote: 'bad' }, _fingerprint: 'fp' },
      { sourceModel: 'gpt', pass: 'backend' },
    );
    envelope.evidenceAlternatives.push({ sourceModel: 'gemini', evidenceType: 'commission', anchor: { quote: 'good' }, rawDetail: 'the successful model says Y is broken' });
    const promoted = promoteAlternative(envelope, 1);
    assert.equal(promoted.canonicalFinding.detail, 'the successful model says Y is broken');
    assert.equal(promoted.canonicalFinding.anchor.quote, 'good');
  });
  it('demotes the ORIGINAL (failed) claim\'s data into the promoted slot — never the successful alt\'s own data (consolidated Gemini gate fix G2)', () => {
    const envelope = createEnvelope(
      { detail: 'the failed model said X is broken', evidenceType: 'commission', anchor: { quote: 'bad-anchor' }, _fingerprint: 'fp' },
      { sourceModel: 'gpt', pass: 'backend' },
    );
    envelope.evidenceAlternatives.push({ sourceModel: 'gemini', evidenceType: 'commission', anchor: { quote: 'good-anchor' }, rawDetail: 'alt detail' });
    const promoted = promoteAlternative(envelope, 1);
    // The promoted alt's OWN slot (index 1, the altIndex) is overwritten with a
    // record representing the OLD (failed) canonical — never the successful
    // alt's own anchor/detail, which is the exact mix-up G2 flagged.
    const demotedEntry = promoted.evidenceAlternatives[1];
    assert.equal(demotedEntry.anchor.quote, 'bad-anchor'); // the FAILED claim's own anchor, not the successful one's
    assert.equal(demotedEntry.rawDetail, 'the failed model said X is broken'); // the FAILED claim's own prose
    assert.equal(demotedEntry.verificationFailed, true);
    // index 0 (the original canonical's own untouched evidenceAlternatives entry,
    // pushed by createEnvelope before promotion) is preserved unchanged — nothing discarded.
    assert.equal(promoted.evidenceAlternatives[0].anchor.quote, 'bad-anchor');
  });
});
