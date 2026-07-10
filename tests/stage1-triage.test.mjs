/**
 * Tier-1 tests for Stage 1 cheap-model triage (tiered-recall pipeline,
 * Cluster D scoped Phase 7). Plan: docs/plans/tiered-recall-audit-pipeline.md.
 * Covers the severity-gated escalation rule (Gemini gate round-2 finding #G2)
 * and the failure-escalates-never-dismisses invariant. Adapters are stubs —
 * no live LLM/network calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runStage1CheapTriage } from '../scripts/lib/audit/stage1-triage.mjs';

const CLOCK = () => '2026-01-01T00:00:00.000Z';

// audit-orchestrator-hardening Phase 8: runStage1CheapTriage now REQUIRES
// ledgerOpts.repoRoot (threaded to buildStageOneTriageInput, which throws
// loudly rather than defaulting to process.cwd() — the INC-001 symlink-
// bypass class). A real, resolvable directory (not a fake path) so
// resolveAndClassify's realpathSync calls succeed for the fixture findings
// below, none of which reference a real file (section is always absent).
const REPO_ROOT = os.tmpdir();

function mkEnvelope(severity, evidenceType = 'commission') {
  return { canonicalFinding: { severity, evidenceType }, stageDecisions: [] };
}

describe('runStage1CheapTriage — severity-gated escalation', () => {
  it('a valid dismissal of a MEDIUM commission candidate becomes mechanical_dismissed', async () => {
    const envelope = mkEnvelope('MEDIUM');
    const { mechanicalDismissed, escalated, confirmedSurvivor } = await runStage1CheapTriage([envelope], {
      triagerCall: async () => ({ dismissalAttempted: true, disproof: 'the function is never called anywhere in the diff' }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(mechanicalDismissed.length, 1);
    assert.equal(escalated.length, 0);
    assert.equal(confirmedSurvivor.length, 0);
    assert.equal(envelope.stageDecisions[0].outcome, 'mechanical_dismissed');
    assert.equal(envelope.stageDecisions[0].hasDeterministicDisproof, true);
  });

  it('a valid dismissal of a HIGH candidate escalates instead of being trusted outright', async () => {
    const envelope = mkEnvelope('HIGH');
    const { escalated, mechanicalDismissed } = await runStage1CheapTriage([envelope], {
      triagerCall: async () => ({ dismissalAttempted: true, disproof: 'real disproof' }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(escalated.length, 1);
    assert.equal(mechanicalDismissed.length, 0);
    assert.equal(envelope.stageDecisions[0].reasonCode, 'valid_dismissal_high_or_omission_escalated');
  });

  it('a valid dismissal of an omission-type MEDIUM candidate escalates (severity-independent trigger)', async () => {
    const envelope = mkEnvelope('MEDIUM', 'omission');
    const { escalated } = await runStage1CheapTriage([envelope], {
      triagerCall: async () => ({ dismissalAttempted: true, disproof: 'real disproof' }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(escalated.length, 1);
  });

  it('an invalid dismissal attempt (no disproof cited) on a MEDIUM candidate reverts to confirmed_survivor, never mechanical_dismissed', async () => {
    const envelope = mkEnvelope('MEDIUM');
    const { confirmedSurvivor, mechanicalDismissed } = await runStage1CheapTriage([envelope], {
      triagerCall: async () => ({ dismissalAttempted: true, disproof: null }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(confirmedSurvivor.length, 1);
    assert.equal(mechanicalDismissed.length, 0);
    assert.equal(envelope.stageDecisions[0].reasonCode, 'invalid_dismissal_no_disproof');
  });

  it('an invalid dismissal attempt on a HIGH candidate ALSO reverts to confirmed_survivor, not escalated (severity-independent validity)', async () => {
    const envelope = mkEnvelope('HIGH');
    const { confirmedSurvivor, escalated } = await runStage1CheapTriage([envelope], {
      triagerCall: async () => ({ dismissalAttempted: true, disproof: '   ' }), // whitespace-only, not a real disproof
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(confirmedSurvivor.length, 1);
    assert.equal(escalated.length, 0);
  });

  it('no dismissal attempted becomes confirmed_survivor', async () => {
    const envelope = mkEnvelope('LOW');
    const { confirmedSurvivor } = await runStage1CheapTriage([envelope], {
      triagerCall: async () => ({ dismissalAttempted: false, disproof: null }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(confirmedSurvivor.length, 1);
    assert.equal(confirmedSurvivor[0].stageDecisions[0].reasonCode, 'no_dismissal_attempted');
  });

  it('a triagerCall throw escalates the candidate — never treated as an implicit dismissal', async () => {
    const envelope = mkEnvelope('MEDIUM');
    const { escalated, mechanicalDismissed, confirmedSurvivor } = await runStage1CheapTriage([envelope], {
      triagerCall: async () => { throw new Error('API timeout'); },
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(escalated.length, 1);
    assert.equal(mechanicalDismissed.length, 0);
    assert.equal(confirmedSurvivor.length, 0);
    assert.equal(envelope.stageDecisions[0].reasonCode, 'stage1_call_failed');
  });

  it('appends to stageDecisions rather than replacing it (append-only decision log)', async () => {
    const envelope = mkEnvelope('MEDIUM');
    envelope.stageDecisions.push({ stage: 'stage0', outcome: 'verified', reasonCode: 'x', evidenceRef: 'y', createdAt: CLOCK() });
    await runStage1CheapTriage([envelope], {
      triagerCall: async () => ({ dismissalAttempted: false, disproof: null }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(envelope.stageDecisions.length, 2);
    assert.equal(envelope.stageDecisions[0].stage, 'stage0');
    assert.equal(envelope.stageDecisions[1].stage, 'stage1');
  });

  it('processes multiple envelopes independently', async () => {
    const e1 = mkEnvelope('MEDIUM');
    const e2 = mkEnvelope('HIGH');
    const { mechanicalDismissed, escalated } = await runStage1CheapTriage([e1, e2], {
      triagerCall: async (env) => ({ dismissalAttempted: true, disproof: 'x' }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(mechanicalDismissed.length, 1);
    assert.equal(escalated.length, 1);
  });

  it('a non-boolean truthy dismissalAttempted (e.g. a string) does NOT count as an attempt (audit fix H2)', async () => {
    const envelope = mkEnvelope('MEDIUM');
    const { confirmedSurvivor, mechanicalDismissed } = await runStage1CheapTriage([envelope], {
      triagerCall: async () => ({ dismissalAttempted: 'yes', disproof: 'real disproof' }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(confirmedSurvivor.length, 1);
    assert.equal(mechanicalDismissed.length, 0);
    assert.equal(envelope.stageDecisions[0].reasonCode, 'no_dismissal_attempted');
  });

  it('a non-string disproof (e.g. an object) is treated as no valid disproof', async () => {
    const envelope = mkEnvelope('MEDIUM');
    const { confirmedSurvivor } = await runStage1CheapTriage([envelope], {
      triagerCall: async () => ({ dismissalAttempted: true, disproof: { reason: 'x' } }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.equal(confirmedSurvivor.length, 1);
    assert.equal(confirmedSurvivor[0].stageDecisions[0].reasonCode, 'invalid_dismissal_no_disproof');
  });
});
