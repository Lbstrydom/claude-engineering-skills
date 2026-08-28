/**
 * @fileoverview Tier 1/2 tests for scripts/lib/audit/architecture-pass.mjs
 * — relocated from legacy-production-audit.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 3).
 *
 * `groundArchFindingsToReport` already has dedicated, thorough coverage in
 * tests/arch-bouncer-grounding.test.mjs (relocated import, same assertions)
 * — not duplicated here. `runArchitecturePass` is exercised end-to-end via
 * tests/run-multi-pass-code-audit-harness.test.mjs. This file gives
 * `deriveFindingsFromReport` — the deterministic LLM-bouncer-failure
 * fallback — its own direct unit coverage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { deriveFindingsFromReport } = await import('../scripts/lib/audit/architecture-pass.mjs');

const emptyReport = { violations: [], unmappedFiles: [], deadIntent: [], perStackResults: [] };

describe('deriveFindingsFromReport — deterministic fallback rubric', () => {
  it('emits a MEDIUM finding per mechanical violation, never HIGH', () => {
    const report = { ...emptyReport, violations: [{ fromFile: 'a.mjs', toFile: 'b.mjs', fromDomain: 'x', toDomain: 'y' }] };
    const findings = deriveFindingsFromReport(report);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'MEDIUM');
    assert.equal(findings[0].id, 'A1');
  });

  it('only flags unmapped files under src/ or scripts/ (heuristic)', () => {
    const report = { ...emptyReport, unmappedFiles: ['docs/readme.md', 'src/foo.mjs', 'scripts/bar.mjs'] };
    const findings = deriveFindingsFromReport(report);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings.map(f => f.section), ['src/foo.mjs', 'scripts/bar.mjs']);
  });

  it('emits a LOW finding for each dead-intent domain', () => {
    const report = { ...emptyReport, deadIntent: ['orphaned-domain'] };
    const findings = deriveFindingsFromReport(report);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'LOW');
    assert.match(findings[0].detail, /orphaned-domain/);
  });

  it('emits a MEDIUM finding for each per-stack analyzer failure', () => {
    const report = { ...emptyReport, perStackResults: [{ stackKind: 'js-ts', status: 'error', error: { message: 'boom' } }] };
    const findings = deriveFindingsFromReport(report);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'MEDIUM');
    assert.match(findings[0].detail, /boom/);
  });

  it('IDs are monotonically increasing across mixed violation types', () => {
    const report = {
      violations: [{ fromFile: 'a.mjs', toFile: 'b.mjs', fromDomain: 'x', toDomain: 'y' }],
      unmappedFiles: ['src/foo.mjs'],
      deadIntent: ['stale'],
      perStackResults: [],
    };
    const findings = deriveFindingsFromReport(report);
    assert.deepEqual(findings.map(f => f.id), ['A1', 'A2', 'A3']);
  });

  it('returns no findings for a clean report', () => {
    assert.deepEqual(deriveFindingsFromReport(emptyReport), []);
  });
});
