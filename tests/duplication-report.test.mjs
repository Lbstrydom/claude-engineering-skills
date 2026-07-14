/**
 * @fileoverview Tests for duplication-report.mjs — id assignment, the
 * deterministic fallback/failed-state finding constructors, and the
 * query-exclude glob list. Bouncer-decision mapping is covered separately
 * in tests/duplication-bouncer-mapping.test.mjs.
 * Plan: docs/completed/audit-code-duplication-wave.md §4 Phase 4.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FindingSchema } from '../scripts/lib/schemas.mjs';
import {
  isDuplicationReportClean,
  isDuplicationQueryExcluded,
  DUPLICATION_QUERY_EXCLUDE_GLOBS,
  deriveFindingsFromDuplicationReport,
  buildDetectorFailedFinding,
  finalizeDeterministicFindings,
  _resetDuplicationIdCounter,
} from '../scripts/lib/audit/duplication-report.mjs';

beforeEach(() => _resetDuplicationIdCounter());

function candidate(overrides = {}) {
  return {
    id: 'dup-abc123',
    candidate: { filePath: 'a.mjs', symbolName: 'foo', kind: 'function', startLine: 1, endLine: 5, purposeSummary: 'does foo' },
    topMatch: { filePath: 'canonical.mjs', symbolName: 'foo', kind: 'function', similarity: 0.93 },
    allMatches: [{ filePath: 'canonical.mjs', symbolName: 'foo', kind: 'function', similarity: 0.93 }],
    ...overrides,
  };
}

describe('isDuplicationReportClean', () => {
  it('is true only for state:clean, not merely empty arrays', () => {
    assert.equal(isDuplicationReportClean({ state: 'clean', deterministicFindings: [], semanticCandidates: [] }), true);
    assert.equal(isDuplicationReportClean({ state: 'unavailable', deterministicFindings: [], semanticCandidates: [] }), false);
    assert.equal(isDuplicationReportClean({ state: 'failed', deterministicFindings: [], semanticCandidates: [] }), false);
  });
});

describe('DUPLICATION_QUERY_EXCLUDE_GLOBS / isDuplicationQueryExcluded', () => {
  it('excludes the three arch-intent-adapter test fixtures', () => {
    for (const lang of ['java', 'postgres', 'python']) {
      assert.equal(isDuplicationQueryExcluded(`tests/arch-intent-adapter-${lang}.test.mjs`), true);
    }
  });
  it('does not exclude ordinary source or unrelated test files', () => {
    assert.equal(isDuplicationQueryExcluded('scripts/lib/audit/duplication-detector.mjs'), false);
    assert.equal(isDuplicationQueryExcluded('tests/duplication-detector.test.mjs'), false);
  });
  it('is a frozen array (immutable by convention, mirrors GENERATED_NOISE_PATTERNS)', () => {
    assert.ok(Object.isFrozen(DUPLICATION_QUERY_EXCLUDE_GLOBS));
  });
});

describe('deriveFindingsFromDuplicationReport (deterministic fallback)', () => {
  it('emits one MEDIUM, is_mechanical, is_quick_fix finding per candidate, D-prefixed ids, valid against FindingSchema', () => {
    const findings = deriveFindingsFromDuplicationReport([candidate(), candidate({ id: 'dup-def456', candidate: { filePath: 'b.mjs', symbolName: 'bar', kind: 'function' } })]);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].id, 'D1');
    assert.equal(findings[1].id, 'D2');
    for (const f of findings) {
      assert.equal(f.severity, 'MEDIUM');
      assert.equal(f.is_mechanical, true);
      assert.equal(f.is_quick_fix, true);
      assert.doesNotThrow(() => FindingSchema.parse(f));
    }
  });

  it('never emits HIGH from the deterministic fallback (no LLM judgement)', () => {
    const findings = deriveFindingsFromDuplicationReport([candidate()]);
    assert.equal(findings[0].severity, 'MEDIUM');
  });
});

describe('buildDetectorFailedFinding', () => {
  it('never carries the raw error text (round-3 M1) — only a stable public code', () => {
    const f = buildDetectorFailedFinding('ECONNREFUSED at postgres://user:secretpassword@10.0.0.5/db');
    assert.ok(!f.detail.includes('secretpassword'));
    assert.ok(!f.detail.includes('10.0.0.5'));
    assert.match(f.detail, /^DUPLICATION_DETECTOR_FAILED:/);
    assert.equal(f.severity, 'MEDIUM');
    assert.equal(f.is_quick_fix, true); // reuses the convergence gate — "couldn't run" blocks like a real finding
    assert.doesNotThrow(() => FindingSchema.parse(f));
  });

  it('assigns a D-prefixed id', () => {
    const f = buildDetectorFailedFinding('x');
    assert.match(f.id, /^D\d+$/);
  });
});

describe('finalizeDeterministicFindings', () => {
  it('converts a raw orphaned-pragma record into a FindingSchema-valid finding with a D-id', () => {
    const raw = [{ type: 'orphaned-pragma', filePath: 'a.mjs', symbolName: 'foo', target: { file: 'nowhere.mjs', symbolName: 'foo' }, reason: 'stale' }];
    const findings = finalizeDeterministicFindings(raw);
    assert.equal(findings.length, 1);
    assert.match(findings[0].id, /^D\d+$/);
    assert.equal(findings[0].category, '[Duplication] Orphaned suppression pragma');
    assert.equal(findings[0].is_quick_fix, true);
    assert.doesNotThrow(() => FindingSchema.parse(findings[0]));
  });

  it('throws on an unknown record type (fail loud, not silently drop)', () => {
    assert.throws(() => finalizeDeterministicFindings([{ type: 'unknown-type' }]));
  });

  it('returns [] for an empty/undefined input', () => {
    assert.deepEqual(finalizeDeterministicFindings([]), []);
    assert.deepEqual(finalizeDeterministicFindings(undefined), []);
  });
});

describe('id counter shares state across finding constructors within a pass run', () => {
  it('D-ids are sequential across both deterministic and fallback findings in one report', () => {
    const orphan = finalizeDeterministicFindings([{ type: 'orphaned-pragma', filePath: 'a.mjs', symbolName: 'foo', target: { file: 'x', symbolName: 'y' }, reason: 'r' }]);
    const fallback = deriveFindingsFromDuplicationReport([candidate()]);
    assert.equal(orphan[0].id, 'D1');
    assert.equal(fallback[0].id, 'D2');
  });
});
