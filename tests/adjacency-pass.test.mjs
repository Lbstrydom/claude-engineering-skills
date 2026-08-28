/**
 * @fileoverview Tier 2 tests for scripts/lib/audit/adjacency-pass.mjs —
 * relocated from legacy-production-audit.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 3).
 *
 * `runAdjacencyPass`'s bouncer-usage accounting is already pinned by
 * tests/audit-wave-usage-accounting.test.mjs, and its detector-report
 * composition by tests/adjacency-pipeline.test.mjs — both exercise the
 * relocated function via a direct import, not duplicated here. This file
 * covers the NOT-APPLICABLE short-circuit: no diff contract available means
 * the wave has nothing to judge, which must not read as a failure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { runAdjacencyPass } = await import('../scripts/lib/audit/adjacency-pass.mjs');

describe('runAdjacencyPass — no-diff-contract short-circuit', () => {
  it('is NOT-APPLICABLE (not a failure) when no auditBaseCommit and no test seam are supplied', async () => {
    const out = await runAdjacencyPass({
      openai: null, ctx: {}, passPrompt: (o) => o, auditBaseCommit: null,
      focusBlock: '', planContent: null, historyBlock: '', ledgerFile: null, impactSet: null, isR2Plus: false,
    });
    assert.equal(out.result.findings.length, 0);
    assert.equal(out.callCount, 0, 'no bouncer call when there is nothing eligible to judge');
    // Pins the STATE WORD composeAdjacencyResult classifies this as, not just
    // an empty-result shape an ERROR/SKIPPED path could also produce
    // (audit-code Cluster B M11) — runAdjacencyPass has no structured `state`
    // field on its return (a contract change out of this plan's pure-
    // relocation scope), so the state classification is only readable from
    // this exact summary prefix; a substring match on "0 container(s)" alone
    // cannot distinguish NOT_APPLICABLE from a failure that also found none.
    assert.match(out.result.summary, /^Adjacency: not-applicable — 0 container\(s\), 0 statement\(s\) judged, 0 candidate\(s\)\.$/);
  });
});
