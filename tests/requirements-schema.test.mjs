/**
 * Tests for scripts/lib/requirements/schema.mjs
 * Plan: docs/plans/requirements-layer.md — Plan-Phase A.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RequirementCandidateSchema, GapAssessmentSchema, RequirementSchema,
  RequirementsLedgerSchema, OverridesSchema,
} from '../scripts/lib/requirements/schema.mjs';

const candidate = {
  id: 'REQ-security-deadbeef', assertion: 'Sensitive paths are excluded from the inventory.',
  kind: 'security', checkable: true,
  provenance: [{ file: 'scripts/lib/repo-inventory.mjs', anchor: 'listRepoFiles' }],
  appliesTo: ['scripts/lib/**'], evidence: { code: [], tests: [] },
  seenInRuns: 2, confidence: 'high',
};

describe('RequirementCandidateSchema', () => {
  it('accepts a valid candidate', () => {
    assert.equal(RequirementCandidateSchema.safeParse(candidate).success, true);
  });
  it('rejects a bad kind', () => {
    assert.equal(RequirementCandidateSchema.safeParse({ ...candidate, kind: 'nonsense' }).success, false);
  });
  it('rejects a malformed id', () => {
    assert.equal(RequirementCandidateSchema.safeParse({ ...candidate, id: 'R1' }).success, false);
  });
  it('rejects an id whose kind is not a REQUIREMENT_KIND (audit M6)', () => {
    assert.equal(RequirementCandidateSchema.safeParse({ ...candidate, id: 'REQ-banana-0a1b2c3d' }).success, false);
  });
  it('requires at least one provenance entry', () => {
    assert.equal(RequirementCandidateSchema.safeParse({ ...candidate, provenance: [] }).success, false);
  });
});

describe('GapAssessmentSchema', () => {
  const VALID_ID = 'REQ-correctness-0a1b2c3d';
  const OTHER_ID = 'REQ-safety-1234abcd';
  it('accepts the four gap classes', () => {
    const conflicts = { none: [], 'observed-but-unintended': [], untested: [], contradictory: [OTHER_ID] };
    for (const gap of ['none', 'observed-but-unintended', 'untested', 'contradictory']) {
      assert.equal(GapAssessmentSchema.safeParse({ requirementId: VALID_ID, gap, conflictsWith: conflicts[gap], rationale: 'x' }).success, true);
    }
  });
  it('rejects intended-but-unobserved (not a candidate gap class — audit H2)', () => {
    assert.equal(GapAssessmentSchema.safeParse({ requirementId: VALID_ID, gap: 'intended-but-unobserved', conflictsWith: [], rationale: 'x' }).success, false);
  });
  it('rejects a malformed requirementId — shared RequirementIdSchema (audit M5)', () => {
    assert.equal(GapAssessmentSchema.safeParse({ requirementId: 'REQ-x-1', gap: 'none', conflictsWith: [], rationale: 'x' }).success, false);
  });
  it('rejects a malformed id in conflictsWith — shared RequirementIdSchema (audit M5)', () => {
    assert.equal(GapAssessmentSchema.safeParse({ requirementId: VALID_ID, gap: 'contradictory', conflictsWith: ['not-an-id'], rationale: 'x' }).success, false);
  });
  it('rejects a contradictory gap with empty conflictsWith (audit M7)', () => {
    assert.equal(GapAssessmentSchema.safeParse({ requirementId: VALID_ID, gap: 'contradictory', conflictsWith: [], rationale: 'x' }).success, false);
  });
});

describe('RequirementSchema / RequirementsLedgerSchema', () => {
  it('a reconciled requirement carries status + gap', () => {
    const r = RequirementSchema.safeParse({ ...candidate, status: 'active', gap: null });
    assert.equal(r.success, true);
  });
  it('rejects a bad status', () => {
    assert.equal(RequirementSchema.safeParse({ ...candidate, status: 'shipped', gap: null }).success, false);
  });
  it('a valid ledger parses', () => {
    const ledger = {
      generatedAt: new Date().toISOString(), commitSha: null, extractionSourceSha: null,
      coveredFiles: [], requirements: [{ ...candidate, status: 'active', gap: null }],
      identityAliases: {},
    };
    assert.equal(RequirementsLedgerSchema.safeParse(ledger).success, true);
  });
});

describe('OverridesSchema', () => {
  it('accepts accept/reject/edited-assertion entries', () => {
    const ov = {
      'REQ-security-0a1b2c3d': { decision: 'accept' },
      'REQ-safety-1234abcd': { decision: 'reject', note: 'a bug, not an invariant' },
      'REQ-correctness-deadbeef': { assertion: 'A reworded, human-edited assertion of the invariant.' },
    };
    assert.equal(OverridesSchema.safeParse(ov).success, true);
  });
  it('rejects a no-op entry — neither decision nor assertion (audit L4)', () => {
    assert.equal(OverridesSchema.safeParse({ 'REQ-security-0a1b2c3d': {} }).success, false);
    assert.equal(OverridesSchema.safeParse({ 'REQ-security-0a1b2c3d': { note: 'just a thought' } }).success, false);
  });
  it('rejects a malformed override key — must be a frozen requirement id (audit M5)', () => {
    assert.equal(OverridesSchema.safeParse({ 'REQ-a-1': { decision: 'accept' } }).success, false);
  });
});
