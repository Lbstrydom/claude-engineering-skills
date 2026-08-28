/**
 * @fileoverview Tier 2 tests for scripts/lib/audit/duplication-pass.mjs —
 * relocated from legacy-production-audit.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 3).
 *
 * `runDuplicationPass`'s bouncer-usage accounting is already pinned by
 * tests/audit-wave-usage-accounting.test.mjs, and its detector-report
 * composition by tests/duplication-pipeline.test.mjs — both exercise the
 * relocated function via a direct import, not duplicated here. This file
 * covers the `unavailable` short-circuit: no auditBaseCommit and no test
 * injection seam means there is nothing to compare against.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { runDuplicationPass } = await import('../scripts/lib/audit/duplication-pass.mjs');

describe('runDuplicationPass — unavailable short-circuit', () => {
  it('reports SKIPPED (unavailable) when no auditBaseCommit and no test seam are supplied', async () => {
    const out = await runDuplicationPass({
      openai: null, ctx: {}, passPrompt: (o) => o, changedFiles: [], auditBaseCommit: null,
      focusBlock: '', planContent: null, historyBlock: '', ledgerFile: null, impactSet: null, isR2Plus: false,
    });
    assert.equal(out.result.findings.length, 0);
    assert.match(out.result.summary, /SKIPPED \(unavailable/);
    assert.equal(out.callCount, 0, 'no bouncer call when the detector never ran');
  });
});
