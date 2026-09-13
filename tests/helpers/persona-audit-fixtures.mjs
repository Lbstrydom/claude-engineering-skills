/**
 * @fileoverview Shared fixture builders for persona/audit-correlation tests.
 * Consolidated here (arch:drift duplication cleanup) —
 * `persona-audit-correlator.test.mjs` and
 * `persona-finding-severity-contract.test.mjs` each had their own identical
 * copy of both.
 *
 * @module tests/helpers/persona-audit-fixtures
 */

/** An empty step→URL lookup, for tests that don't need route resolution. */
export const noRoute = () => new Map();

/** A minimal audit_findings row, in the shape decideCorrelations reads. */
export const auditFinding = (over = {}) => ({
  id: 'audit-1', run_id: 'run-1', finding_fingerprint: 'ffffffff',
  severity: 'HIGH', category: 'crash', primary_file: 'src/pages/checkout.tsx',
  detail_snapshot: 'Checkout page throws on click event.',
  run_created_at: '2026-07-13T00:00:00Z',
  ...over,
});
