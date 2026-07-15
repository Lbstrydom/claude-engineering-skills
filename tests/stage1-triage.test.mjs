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
import fs from 'node:fs';
import path from 'node:path';
import { runStage1CheapTriage } from '../scripts/lib/audit/stage1-triage.mjs';
import { Stage1DecisionSchema } from '../scripts/lib/schemas.mjs';

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

// ── Admission guard (docs/plans/oss-call-reliability-hardening.md) ─────────
// Round-1 H1's compromise ruling, round-2 H1's separate-bucket fix, round-3
// M1's caller-owned budget, round-3 M3 + Gemini-round-1 G1's monotonic clock.

describe('runStage1CheapTriage — admission guard', () => {
  it('default clock (ledgerOpts.clock omitted) does not crash — Gemini-round-1 G1 regression guard', async () => {
    // The plan's own first draft, `(ledgerOpts?.clock ?? performance.now)()`,
    // passed performance.now UNBOUND — TypeError: Illegal invocation. This
    // exercises the real default with no admissionBudgetMs (so admissionClock
    // is never even invoked) AND with one set (so it genuinely is invoked).
    const envelope = mkEnvelope('LOW');
    await assert.doesNotReject(() => runStage1CheapTriage([envelope], {
      triagerCall: async () => ({ dismissalAttempted: false, disproof: null }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT, admissionBudgetMs: 999999999, candidateWorstCaseMs: 1 }));
  });

  it('stops the loop once elapsed + worst-case would exceed the budget, marking remaining envelopes budget_exhausted', async () => {
    const envelopes = [mkEnvelope('LOW'), mkEnvelope('LOW'), mkEnvelope('LOW')];
    let elapsed = 0;
    const fakeClock = () => elapsed;
    const result = await runStage1CheapTriage(envelopes, {
      triagerCall: async () => { elapsed += 100000; return { dismissalAttempted: false, disproof: null }; },
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT, admissionBudgetMs: 150000, candidateWorstCaseMs: 100000, clock: fakeClock });

    assert.equal(result.confirmedSurvivor.length, 1, 'only the first candidate fits the budget');
    assert.equal(result.budgetExhausted.length, 2);
    assert.equal(result.skippedBudgetExhaustedCount, 2);
    assert.equal(result.escalated.length, 0, 'budget-exhausted envelopes must NOT be in escalated (round-2 H1)');
    for (const e of result.budgetExhausted) {
      const decision = e.stageDecisions.at(-1);
      assert.equal(decision.outcome, 'budget_exhausted');
      assert.equal(decision.reasonCode, 'skipped_budget_exhausted');
      assert.notEqual(decision.reasonCode, 'stage1_call_failed', 'must never be conflated with a real triager failure');
    }
  });

  it('candidateWorstCaseMs accepted as a callback, not just a plain number', async () => {
    const envelopes = [mkEnvelope('LOW'), mkEnvelope('LOW')];
    let elapsed = 0;
    let callbackInvocations = 0;
    const fakeClock = () => elapsed;
    const result = await runStage1CheapTriage(envelopes, {
      triagerCall: async () => { elapsed += 200000; return { dismissalAttempted: false, disproof: null }; },
      clock: CLOCK,
    }, {
      repoRoot: REPO_ROOT, admissionBudgetMs: 150000, clock: fakeClock,
      candidateWorstCaseMs: () => { callbackInvocations++; return 200000; },
    });
    assert.ok(callbackInvocations >= 1);
    assert.equal(result.confirmedSurvivor.length, 0, 'first candidate already exceeds budget on its own');
    assert.equal(result.budgetExhausted.length, 2);
  });

  it('ample budget processes all candidates unaffected', async () => {
    const envelopes = [mkEnvelope('LOW'), mkEnvelope('LOW'), mkEnvelope('LOW')];
    let elapsed = 0;
    const fakeClock = () => elapsed;
    const result = await runStage1CheapTriage(envelopes, {
      triagerCall: async () => { elapsed += 1000; return { dismissalAttempted: false, disproof: null }; },
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT, admissionBudgetMs: 1000000, candidateWorstCaseMs: 1000, clock: fakeClock });
    assert.equal(result.confirmedSurvivor.length, 3);
    assert.equal(result.budgetExhausted.length, 0);
  });

  it('admissionBudgetMs omitted opts out entirely — every envelope processed exactly as before this feature (regression guard)', async () => {
    const envelopes = [mkEnvelope('LOW'), mkEnvelope('LOW')];
    const result = await runStage1CheapTriage(envelopes, {
      triagerCall: async () => ({ dismissalAttempted: false, disproof: null }),
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT }); // no admissionBudgetMs, no candidateWorstCaseMs, no clock
    assert.equal(result.confirmedSurvivor.length, 2);
    assert.equal(result.budgetExhausted.length, 0);
    assert.equal(result.skippedBudgetExhaustedCount, 0);
    assert.deepEqual(result.failureCategories, {});
  });

  it('a budget-exhausted envelope is NOT written to the mechanical-dismissal ledger (round-2 H2 — never marked resolved, naturally resurfaces)', async () => {
    const ledgerPath = path.join(os.tmpdir(), `stage1-admission-ledger-${Date.now()}.json`);
    const envelope = mkEnvelope('LOW');
    let elapsed = 0;
    await runStage1CheapTriage([envelope], {
      triagerCall: async () => { elapsed += 100000; return { dismissalAttempted: false, disproof: null }; },
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT, admissionBudgetMs: 50000, candidateWorstCaseMs: 100000, clock: () => elapsed, ledgerPath });
    assert.equal(fs.existsSync(ledgerPath), false, 'writeMechanicalDismissalToLedger must never fire for a budget_exhausted outcome');
  });

  it('Stage1DecisionSchema accepts the new budget_exhausted outcome (schema-shape regression guard)', () => {
    const parsed = Stage1DecisionSchema.safeParse({
      stage: 'stage1', outcome: 'budget_exhausted', reasonCode: 'skipped_budget_exhausted',
      hasDeterministicDisproof: false, createdAt: CLOCK(), category: null,
    });
    assert.equal(parsed.success, true);
  });
});

// ── Failure-category persistence (round-3 H1) ───────────────────────────────

describe('runStage1CheapTriage — classified-failure category persistence', () => {
  it('a classified triagerCall failure\'s category survives into the schema-validated stageDecision record', async () => {
    const envelope = mkEnvelope('MEDIUM');
    const err = new Error('OSS timeout');
    err.category = 'timeout';
    const result = await runStage1CheapTriage([envelope], {
      triagerCall: async () => { throw err; },
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    const decision = envelope.stageDecisions.at(-1);
    assert.equal(decision.outcome, 'escalated');
    assert.equal(decision.reasonCode, 'stage1_call_failed');
    assert.equal(decision.category, 'timeout');
    assert.equal(Stage1DecisionSchema.safeParse(decision).success, true);
    assert.deepEqual(result.failureCategories, { timeout: 1 });
  });

  it('an unclassified failure (no err.category) persists category: null, not a fabricated value', async () => {
    const envelope = mkEnvelope('MEDIUM');
    const result = await runStage1CheapTriage([envelope], {
      triagerCall: async () => { throw new Error('plain error, no category'); },
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    const decision = envelope.stageDecisions.at(-1);
    assert.equal(decision.category, null);
    assert.deepEqual(result.failureCategories, {}, 'an uncategorized failure must not appear in the tally');
  });

  it('aggregates multiple classified failures across envelopes by category', async () => {
    const e1 = mkEnvelope('MEDIUM');
    const e2 = mkEnvelope('MEDIUM');
    const e3 = mkEnvelope('MEDIUM');
    const mkErr = (category) => { const e = new Error('x'); e.category = category; return e; };
    let callIdx = 0;
    const cats = ['timeout', 'timeout', 'network'];
    const result = await runStage1CheapTriage([e1, e2, e3], {
      triagerCall: async () => { throw mkErr(cats[callIdx++]); },
      clock: CLOCK,
    }, { repoRoot: REPO_ROOT });
    assert.deepEqual(result.failureCategories, { timeout: 2, network: 1 });
  });
});
