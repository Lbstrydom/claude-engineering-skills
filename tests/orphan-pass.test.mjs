/**
 * @fileoverview Tier 1/2 tests for scripts/lib/audit/orphan-pass.mjs —
 * relocated from legacy-production-audit.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 3).
 *
 * `resolveOrphanScopeRefs` already has dedicated, thorough coverage in
 * tests/orphan-scope-refs.test.mjs (relocated import, same assertions) —
 * not duplicated here. `runOrphanIntroducedPass` is exercised end-to-end via
 * tests/run-multi-pass-code-audit-harness.test.mjs and the writeLearningState
 * gating on its two emitOrphanRunMetrics call sites is pinned by
 * tests/suppression-call-site.test.mjs. This file covers the short-circuit
 * states `runOrphanIntroducedPass` returns before reaching the detector.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { runOrphanIntroducedPass } = await import('../scripts/lib/audit/orphan-pass.mjs');

describe('runOrphanIntroducedPass — short-circuit states', () => {
  it('SKIPPED_NO_GRAPH when no archReport was supplied (arch pass skipped/errored)', async () => {
    const out = await runOrphanIntroducedPass({ archReport: null, repoRoot: process.cwd(), runId: 'r1', learningWritesAllowed: false });
    assert.equal(out.state, 'SKIPPED_NO_GRAPH');
    assert.deepEqual(out.result.result.findings, []);
  });

  it('SKIPPED_NO_GRAPH when the arch report carries no usable js-ts graph', async () => {
    const out = await runOrphanIntroducedPass({
      archReport: { _meta: {} }, repoRoot: process.cwd(), runId: 'r1', learningWritesAllowed: false,
    });
    assert.equal(out.state, 'SKIPPED_NO_GRAPH');
  });

  it('SKIPPED_NO_GRAPH when js-ts allFiles is empty', async () => {
    const out = await runOrphanIntroducedPass({
      archReport: { _meta: { 'js-ts': { allFiles: [] } } }, repoRoot: process.cwd(), runId: 'r1', learningWritesAllowed: false,
    });
    assert.equal(out.state, 'SKIPPED_NO_GRAPH');
  });
});
