import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCoverageReport, createCoverageRecorder, validateCoverage, formatCoverageSuffix, projectCoverageForReview,
} from '../scripts/lib/audit/file-coverage.mjs';
import { evaluateConvergenceWithDetectors } from '../scripts/lib/audit/convergence.mjs';

// Cluster A (docs/plans/prepush-convergence-cluster-a.md, Phase 1): an EMPTY measurement universe must not read as a
// complete, passing one. 5c16 (plan/full scope: changed=[] by design) and 70b5 (a diff with no implementation files).
const stats = (o = {}) => ({
  requested: 0, full: [], headTruncated: [], budgetOmitted: [], unreadable: [], sensitiveExcluded: [],
  redactionShortened: [], charsRendered: 0, charsOnDisk: 0, ...o,
});
const rec = (passes) => {
  const r = createCoverageRecorder();
  for (const [name, { completed, stats: st }] of Object.entries(passes)) { r.recordRead(name, st); r.markPass(name, completed); }
  return r;
};
const build = (over = {}) => buildCoverageReport({ changed: [], existsOnDisk: () => true, readText: () => null, ...over });
const CLEAN = { high: 0, medium: 0, quickFix: 0 };
const DETECTORS = { blocked: false, checked: 0 };

describe('scopeOutcome - the three universes', () => {
  it('no change set (plan/full scope): complete status but gate warn, and the suffix says it was not measured', () => {
    const cov = build({ changed: [] });
    assert.equal(cov.changedTotal, 0);
    assert.equal(cov.scopeOutcome, 'no-change-set');
    assert.equal(cov.status, 'complete');
    assert.equal(cov.gate, 'warn', 'an empty universe must never carry gate:pass');
    assert.match(formatCoverageSuffix(cov), /not measured.*no change set/i);
  });

  it('only non-code files changed (70b5): no-code-in-scope, gate warn, suffix names NO_CODE_IN_SCOPE', () => {
    const cov = build({ changed: ['package-lock.json', 'logo.png'] });
    assert.equal(cov.scopeOutcome, 'no-code-in-scope');
    assert.equal(cov.gate, 'warn');
    assert.match(formatCoverageSuffix(cov), /NO_CODE_IN_SCOPE/);
  });

  it('a reviewable file read in full is `code` and keeps today\'s complete/pass and an empty suffix', () => {
    const cov = build({ changed: ['a.ts'], recorder: rec({ backend: { completed: true, stats: stats({ full: ['a.ts'] }) } }) });
    assert.equal(cov.scopeOutcome, 'code');
    assert.equal(cov.status, 'complete');
    assert.equal(cov.gate, 'pass');
    assert.equal(formatCoverageSuffix(cov), '');
  });

  it('NEGATIVE CONTROL: a reviewable file nobody read is still `none`/fail, never relabelled by the new field', () => {
    const cov = build({ changed: ['a.ts'] });
    assert.equal(cov.scopeOutcome, 'code');
    assert.equal(cov.status, 'none');
    assert.equal(cov.gate, 'fail');
  });

  it('a reviewable file excluded by policy is still `code` (the exclusion is reported, not hidden as empty)', () => {
    const cov = build({ changed: ['a.ts'], excludedUser: ['a.ts'] });
    assert.equal(cov.scopeOutcome, 'code');
    assert.equal(cov.gate, 'warn');
  });
});

describe('scopeOutcome - persistence compatibility (a legacy serialized ledger)', () => {
  const legacy = () => {
    const cov = build({ changed: ['a.ts'], recorder: rec({ backend: { completed: true, stats: stats({ full: ['a.ts'] }) } }) });
    const copy = JSON.parse(JSON.stringify(cov));
    delete copy.scopeOutcome; // what every ledger written before this change looks like
    return copy;
  };

  it('validates unchanged and formats exactly as before', () => {
    const old = legacy();
    assert.deepEqual(validateCoverage(old), { ok: true });
    assert.equal(formatCoverageSuffix(old), '');
  });

  it('a freshly built ledger validates with the field present and survives a JSON round trip', () => {
    const cov = build({ changed: [] });
    assert.deepEqual(validateCoverage(JSON.parse(JSON.stringify(cov))), { ok: true });
  });

  it('a hand-forged scopeOutcome that disagrees with files[]/counts is rejected, not trusted', () => {
    const cov = JSON.parse(JSON.stringify(build({ changed: [] })));
    cov.scopeOutcome = 'code';
    const v = validateCoverage(cov);
    assert.equal(v.ok, false);
    assert.match(v.problems.join(';'), /scopeOutcome/);
  });

  it('an unknown value fails the strict schema', () => {
    const cov = JSON.parse(JSON.stringify(build({ changed: [] })));
    cov.scopeOutcome = 'whatever';
    assert.equal(validateCoverage(cov).ok, false);
  });

  it('the reviewer projection carries the field so the reviewer reads the same words', () => {
    const proj = projectCoverageForReview(build({ changed: [] }));
    assert.equal(proj.scopeOutcome, 'no-change-set');
    assert.match(formatCoverageSuffix(proj), /not measured/i);
  });
});

describe('gate propagation (decision table in the plan): the new `warn` changes wording, not convergence', () => {
  it('a plan/full-scope ledger with zero findings still converges - findings decide', () => {
    const cov = build({ changed: [] });
    assert.deepEqual(evaluateConvergenceWithDetectors(CLEAN, DETECTORS, cov), { converged: true, reason: 'converged' });
  });

  it('a ledger that reports unread changed lines still blocks convergence whatever the scopeOutcome says', () => {
    const cov = { ...build({ changed: [] }), files: [{ path: 'a.ts', outcome: 'audited', changedLinesUnread: 5, class: 'profiled', read: { state: 'head-cut' } }] };
    assert.equal(evaluateConvergenceWithDetectors(CLEAN, DETECTORS, cov).reason, 'changed-lines-unread');
  });
});
