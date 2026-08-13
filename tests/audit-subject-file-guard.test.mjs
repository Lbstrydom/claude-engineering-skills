/**
 * @fileoverview A1 — "audit your success paths" applied to the auditor itself.
 * `auditSubjectFileGuard` refuses to emit a verdict when 0 implementation files would
 * reach the prompt (the hollow-but-confident verdict bug: a code auditor that never
 * read the code). Deterministic seam → unit-tested.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSubjectFileGuard } from '../scripts/lib/audit-scope.mjs';

test('refuses when a scoped audit reads 0 subject files (the field-test #A1 case)', () => {
  const msg = auditSubjectFileGuard({ scopeMode: 'diff', subjectFileCount: 0, hasFileFilter: true, foundCount: 5, referencedCount: 7 });
  assert.ok(msg, 'returns a refusal message');
  assert.match(msg, /0 implementation files/);
  // The hint must name `--files`, the allowlist that actually bounds the audited
  // set. It said `--changed` until 2026-08-13 — the R2+ impact flag, which cannot
  // fix a scope problem, offered at the exact moment an operator is fixing one.
  // See docs/plans/cycle-cluster-audit-scope.md KD-1b.
  assert.match(msg, /--files/);              // actionable hint for the scoped case
  assert.doesNotMatch(msg, /Pass `--changed/);
  assert.match(msg, /5 referenced/);
});

test('refuses when the plan referenced no files that exist (no filter)', () => {
  const msg = auditSubjectFileGuard({ scopeMode: 'plan', subjectFileCount: 0, hasFileFilter: false, foundCount: 0, referencedCount: 4 });
  assert.ok(msg);
  assert.match(msg, /0 of 4 resolved/);      // names how many plan paths failed to resolve
});

test('allows the audit when subject files are present', () => {
  assert.equal(auditSubjectFileGuard({ scopeMode: 'diff', subjectFileCount: 3, hasFileFilter: true, foundCount: 5, referencedCount: 5 }), null);
});

test('full-repo scope is exempt (reads broadly even with 0 plan-resolved subject files)', () => {
  assert.equal(auditSubjectFileGuard({ scopeMode: 'full', subjectFileCount: 0, hasFileFilter: false, foundCount: 0, referencedCount: 0 }), null);
});
