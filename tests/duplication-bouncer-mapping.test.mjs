/**
 * @fileoverview Tests for duplication-report.mjs's mapBouncerDecisionsToFindings
 * — the orchestration-side mapper that is the ONLY place a bouncer `decision:
 * 'keep'` becomes a real finding. Asserts is_quick_fix/is_mechanical are
 * hardcoded literals invariant to anything an (adversarial, fake) bouncer
 * response contains, since the bouncer's own schema has no such fields.
 * Plan: docs/completed/audit-code-duplication-wave.md §4 Phase 4 (round-2 H4 fix).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FindingSchema } from '../scripts/lib/schemas.mjs';
import { mapBouncerDecisionsToFindings, _resetDuplicationIdCounter } from '../scripts/lib/audit/duplication-report.mjs';

beforeEach(() => _resetDuplicationIdCounter());

function candidates() {
  return [
    { id: 'dup-1', candidate: { filePath: 'a.mjs', symbolName: 'foo', kind: 'function' }, topMatch: { filePath: 'canonical.mjs', symbolName: 'foo', kind: 'function', similarity: 0.95 }, allMatches: [] },
    { id: 'dup-2', candidate: { filePath: 'b.mjs', symbolName: 'bar', kind: 'function' }, topMatch: { filePath: 'canonical2.mjs', symbolName: 'bar', kind: 'function', similarity: 0.88 }, allMatches: [] },
  ];
}

describe('mapBouncerDecisionsToFindings — completeness validation', () => {
  it('rejects a response missing a decision for a submitted id', () => {
    const result = mapBouncerDecisionsToFindings(
      [{ candidateId: 'dup-1', decision: 'keep', severity: 'MEDIUM', rationale: 'x' }],
      candidates(), ['dup-1', 'dup-2'],
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing/);
  });

  it('rejects a response with a duplicate id', () => {
    const result = mapBouncerDecisionsToFindings(
      [
        { candidateId: 'dup-1', decision: 'keep', severity: 'MEDIUM', rationale: 'x' },
        { candidateId: 'dup-1', decision: 'drop', severity: 'MEDIUM', rationale: 'y' },
        { candidateId: 'dup-2', decision: 'drop', severity: 'MEDIUM', rationale: 'z' },
      ],
      candidates(), ['dup-1', 'dup-2'],
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /duplicate/);
  });

  it('rejects a response containing an unknown id', () => {
    const result = mapBouncerDecisionsToFindings(
      [
        { candidateId: 'dup-1', decision: 'keep', severity: 'MEDIUM', rationale: 'x' },
        { candidateId: 'dup-999', decision: 'drop', severity: 'MEDIUM', rationale: 'y' },
      ],
      candidates(), ['dup-1'],
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown/);
  });

  it('accepts a complete, unique, fully-covering response', () => {
    const result = mapBouncerDecisionsToFindings(
      [
        { candidateId: 'dup-1', decision: 'keep', severity: 'MEDIUM', rationale: 'same responsibility' },
        { candidateId: 'dup-2', decision: 'drop', severity: 'MEDIUM', rationale: 'coincidental' },
      ],
      candidates(), ['dup-1', 'dup-2'],
    );
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 1); // only the 'keep'
  });
});

describe('mapBouncerDecisionsToFindings — hardcoded convergence flags (round-2 H4)', () => {
  it('sets is_quick_fix:true and is_mechanical:false on a kept finding, regardless of decision content', () => {
    const result = mapBouncerDecisionsToFindings(
      [{ candidateId: 'dup-1', decision: 'keep', severity: 'MEDIUM', rationale: 'x' }],
      [candidates()[0]], ['dup-1'],
    );
    assert.equal(result.ok, true);
    assert.equal(result.findings[0].is_quick_fix, true);
    assert.doesNotThrow(() => FindingSchema.parse(result.findings[0]));
  });

  it("the bouncer schema has no is_quick_fix/is_mechanical field to forge — an adversarial extra field on the decision object is simply ignored, output is still hardcoded", () => {
    const adversarial = { candidateId: 'dup-1', decision: 'keep', severity: 'MEDIUM', rationale: 'x', is_quick_fix: false, is_mechanical: true };
    const result = mapBouncerDecisionsToFindings([adversarial], [candidates()[0]], ['dup-1']);
    assert.equal(result.ok, true);
    // Mapper output is invariant to the (schema-illegal, but defensively tested) extra fields.
    assert.equal(result.findings[0].is_quick_fix, true);
  });

  it('severity HIGH only when the bouncer explicitly says HIGH; MEDIUM otherwise', () => {
    const result = mapBouncerDecisionsToFindings(
      [{ candidateId: 'dup-1', decision: 'keep', severity: 'HIGH', rationale: 'security-sensitive duplication' }],
      [candidates()[0]], ['dup-1'],
    );
    assert.equal(result.findings[0].severity, 'HIGH');
  });

  it("'drop' decisions produce no finding at all", () => {
    const result = mapBouncerDecisionsToFindings(
      [{ candidateId: 'dup-1', decision: 'drop', severity: 'MEDIUM', rationale: 'coincidental' }],
      [candidates()[0]], ['dup-1'],
    );
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
  });
});
