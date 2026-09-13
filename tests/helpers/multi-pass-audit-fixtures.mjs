/**
 * @fileoverview Shared canned-response fixtures for the multi-pass code-audit
 * harness tests. Consolidated here (arch:drift duplication cleanup) —
 * `finalization-characterization.test.mjs` and
 * `run-multi-pass-code-audit-harness.test.mjs` each had their own identical
 * copy of all of this.
 *
 * @module tests/helpers/multi-pass-audit-fixtures
 */

export const FIXTURE_DIR = 'tests/fixtures/harness-plan';
export const BACKEND_FILE = `${FIXTURE_DIR}/src/service.mjs`;

export const CLASSIFICATION = { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'test-stub' };

export function mkFinding(overrides = {}) {
  return {
    id: 'H1', severity: 'HIGH', category: 'Test Category', section: `${BACKEND_FILE}:1`,
    detail: 'canned test finding detail', risk: 'canned risk', recommendation: 'canned recommendation',
    is_quick_fix: false, is_mechanical: false, principle: 'Test Principle',
    classification: CLASSIFICATION,
    ...overrides,
  };
}

export const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 2, files_found: 2, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'structure ok' };
export const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'wiring ok' };
export const EMPTY_BACKEND = { pass_name: 'backend', findings: [], quick_fix_warnings: [], summary: 'backend ok' };
export const EMPTY_FRONTEND = { pass_name: 'frontend', findings: [], quick_fix_warnings: [], summary: 'frontend ok' };
export const EMPTY_SUSTAIN = { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'sustainability ok' };
export const EMPTY_QUICKFIX = { pass_name: 'quickfix', findings: [], summary: 'quickfix ok' };

export function defaultResponses(overrides = {}) {
  return {
    structure_pass: EMPTY_STRUCTURE,
    wiring_pass: EMPTY_WIRING,
    backend_pass: EMPTY_BACKEND,
    frontend_pass: EMPTY_FRONTEND,
    sustainability_pass: EMPTY_SUSTAIN,
    quickfix_pass: EMPTY_QUICKFIX,
    ...overrides,
  };
}
