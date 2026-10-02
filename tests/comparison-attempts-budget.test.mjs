/**
 * @fileoverview Tier 1 — the D5a attempt cap and the D6 per-arm budget, as
 * pure decisions (plan: docs/plans/role-agnostic-comparison-core.md D5a, D6).
 *
 * The DB half (the rows these decisions read actually come back from
 * model_eval_runs, superseded attempts and their cost included; the
 * `stopped_budget` status is accepted by the CHECK) lives in the enrolled
 * DB suite tests/model-eval-comparison-store.test.mjs.
 *
 * @module tests/comparison-attempts-budget
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_ATTEMPTS_PER_ARM, summarizeArmAttempts, decideArmAttempt,
} from '../scripts/lib/comparison/attempts.mjs';
import { createArmBudgetMeter, BUDGET_UNIT_BY_ROLE } from '../scripts/lib/comparison/spend.mjs';
import { parseComparisonManifest } from '../scripts/lib/comparison/manifest.mjs';
import { configDigest } from '../scripts/lib/comparison/lock.mjs';
import { AUDITOR_TIER_C_PROMPT_IDS, AUDITOR_TIER_C_SCHEMA_IDS } from '../scripts/lib/comparison/controls.mjs';

const row = (attempt, status, { superseded = false, costUsd = null } = {}) => ({
  attempt, status, supersededAt: superseded ? '2026-10-02T00:00:00Z' : null, costUsd,
});
const history = (rows) => ({ ok: true, rows });

describe('comparison/attempts — summarizeArmAttempts', () => {
  it('counts EVERY recorded attempt, superseded included — a superseded attempt was still paid for', () => {
    const s = summarizeArmAttempts([row(1, 'failed_provider', { superseded: true }), row(2, 'failed_provider')]);
    assert.equal(s.attempts, 2);
    assert.equal(s.hasLiveSuccess, false);
  });

  it('a superseded success is NOT a live success; only a live completed row is', () => {
    assert.equal(summarizeArmAttempts([row(1, 'completed', { superseded: true })]).hasLiveSuccess, false);
    assert.equal(summarizeArmAttempts([row(1, 'completed', { costUsd: 1 })]).hasLiveSuccess, true);
  });

  it('a live stopped_budget row is not a success — raising the budget must be able to resume it', () => {
    assert.equal(summarizeArmAttempts([row(1, 'stopped_budget', { costUsd: 3 })]).hasLiveSuccess, false);
  });

  it('spend sums ALL attempts via armSpend; one cost-less attempt makes the evidence unknown, never $0', () => {
    const known = summarizeArmAttempts([row(1, 'stopped_budget', { superseded: true, costUsd: 1.5 }), row(2, 'completed', { costUsd: 2.25 })]);
    assert.deepEqual(known.spend, { spendUsd: 3.75, costEvidence: 'known', unpricedAttempts: 0 });
    const unknown = summarizeArmAttempts([row(1, 'failed_provider', { superseded: true }), row(2, 'completed', { costUsd: 2 })]);
    assert.equal(unknown.spend.costEvidence, 'unknown');
    assert.equal(unknown.spend.unpricedAttempts, 1);
  });

  it('NEGATIVE CONTROL: no rows → 0 attempts, known $0 (nothing was recorded, so nothing was spent in this cohort)', () => {
    assert.deepEqual(summarizeArmAttempts([]), { attempts: 0, hasLiveSuccess: false, spend: { spendUsd: 0, costEvidence: 'known', unpricedAttempts: 0 } });
  });
});

describe('comparison/attempts — decideArmAttempt (D5a cap)', () => {
  it('default cap is 2 — one retry', () => {
    assert.equal(DEFAULT_MAX_ATTEMPTS_PER_ARM, 2);
  });

  it('first run: attempt 1, nothing to supersede', () => {
    assert.deepEqual(decideArmAttempt({ history: history([]) }), { action: 'run', attempt: 1, supersedePrior: false, remainingBudgetUsd: null });
  });

  it('one failed attempt under the default cap → retry as attempt 2, superseding the failure', () => {
    assert.deepEqual(decideArmAttempt({ history: history([row(1, 'failed_provider')]) }), { action: 'run', attempt: 2, supersedePrior: true, remainingBudgetUsd: null });
  });

  it('THE HEADLINE CASE: a deterministically failing arm at the cap is skipped as permanently-failed, not re-run', () => {
    const d = decideArmAttempt({ history: history([row(1, 'failed_provider', { superseded: true }), row(2, 'failed_provider')]) });
    assert.equal(d.action, 'skip');
    assert.equal(d.outcome, 'permanently-failed');
    assert.equal(d.reason, 'max-attempts-exhausted');
    assert.equal(d.attempts, 2);
    assert.equal(d.maxAttemptsPerArm, 2);
  });

  it('a crashed attempt (still `running`, no cost) counts toward the cap — it was claimed and may have been paid', () => {
    const d = decideArmAttempt({ history: history([row(1, 'running')]), maxAttemptsPerArm: 1 });
    assert.equal(d.reason, 'max-attempts-exhausted');
  });

  it('the cap is analysis-time: raising it lets the same history retry', () => {
    const rows = [row(1, 'failed_provider', { superseded: true }), row(2, 'failed_provider')];
    assert.equal(decideArmAttempt({ history: history(rows), maxAttemptsPerArm: 2 }).action, 'skip');
    assert.deepEqual(decideArmAttempt({ history: history(rows), maxAttemptsPerArm: 3 }), { action: 'run', attempt: 3, supersedePrior: true, remainingBudgetUsd: null });
  });

  it('a live success is skipped as ok (resume) even when the cap is also reached', () => {
    const d = decideArmAttempt({ history: history([row(1, 'failed_provider', { superseded: true }), row(2, 'completed', { costUsd: 1 })]), maxAttemptsPerArm: 2 });
    assert.equal(d.action, 'skip');
    assert.equal(d.outcome, 'ok');
    assert.equal(d.reason, 'live-success');
  });

  it('an unreadable history REFUSES the arm — the cap cannot be evaluated, and guessing attempt 1 would re-spend', () => {
    const d = decideArmAttempt({ history: { ok: false, error: 'connection reset' } });
    assert.equal(d.action, 'skip');
    assert.equal(d.outcome, 'refused');
    assert.equal(d.reason, 'attempt-history-unreadable');
    assert.match(d.detail, /connection reset/);
  });

  it('cloud off (history null): runs attempt 1 and says the cap is enforced for this invocation only', () => {
    const d = decideArmAttempt({ history: null, budgetUsdPerArm: 5 });
    assert.equal(d.action, 'run');
    assert.equal(d.attempt, 1);
    assert.equal(d.remainingBudgetUsd, 5);
    assert.equal(d.enforcement, 'this-invocation-only');
  });

  it('refuses a malformed cap rather than treating it as unlimited', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => decideArmAttempt({ history: history([]), maxAttemptsPerArm: bad }), /maxAttemptsPerArm/);
    }
  });
});

describe('comparison/attempts — decideArmAttempt (D6 budget, across attempts)', () => {
  it('retries count against the same budget: prior spend at/over the budget stops the arm before another attempt', () => {
    const d = decideArmAttempt({ history: history([row(1, 'stopped_budget', { costUsd: 5 })]), maxAttemptsPerArm: 3, budgetUsdPerArm: 5 });
    assert.equal(d.action, 'skip');
    assert.equal(d.outcome, 'budget-stopped');
    assert.equal(d.reason, 'budget-exhausted');
    assert.equal(d.spendUsd, 5);
  });

  it('under budget: the child is handed the REMAINING budget, not the whole budget', () => {
    const d = decideArmAttempt({ history: history([row(1, 'stopped_budget', { costUsd: 1.25 })]), maxAttemptsPerArm: 3, budgetUsdPerArm: 5 });
    assert.equal(d.action, 'run');
    assert.equal(d.remainingBudgetUsd, 3.75);
  });

  it('a prior attempt with no recorded cost makes the budget unenforceable — stop, never assume it was free', () => {
    const d = decideArmAttempt({ history: history([row(1, 'failed_provider')]), budgetUsdPerArm: 5 });
    assert.equal(d.action, 'skip');
    assert.equal(d.outcome, 'budget-stopped');
    assert.equal(d.reason, 'budget-unenforceable-unpriced');
  });

  it('NEGATIVE CONTROL: the same cost-less history with NO budget retries normally', () => {
    assert.equal(decideArmAttempt({ history: history([row(1, 'failed_provider')]) }).action, 'run');
  });
});

describe('comparison/spend — createArmBudgetMeter (D6 between-units stop)', () => {
  it('no budget: never stops, whatever is recorded', () => {
    const m = createArmBudgetMeter({ budgetUsdPerArm: null });
    m.record(1e6); m.record(null);
    assert.equal(m.check().stop, false);
  });

  it('stops AT the budget, not after it', () => {
    const m = createArmBudgetMeter({ budgetUsdPerArm: 1 });
    m.record(0.4);
    assert.equal(m.check().stop, false);
    m.record(0.6);
    const c = m.check();
    assert.equal(c.stop, true);
    assert.equal(c.reason, 'budget-exhausted');
    assert.equal(m.spentUsd, 1);
  });

  it('an unpriced unit under a budget stops with the unenforceable reason — a ceiling that cannot be measured is not enforced', () => {
    const m = createArmBudgetMeter({ budgetUsdPerArm: 100 });
    m.record(0.01);
    m.record(null);
    const c = m.check();
    assert.equal(c.stop, true);
    assert.equal(c.reason, 'budget-unenforceable-unpriced');
    assert.equal(m.costEvidence, 'unknown');
  });

  it('a negative or non-finite unit cost degrades to unknown, never reduces spend', () => {
    for (const bad of [-1, Number.NaN, Infinity]) {
      const m = createArmBudgetMeter({ budgetUsdPerArm: 10 });
      m.record(bad);
      assert.equal(m.check().reason, 'budget-unenforceable-unpriced');
    }
  });

  it('the enforced-roles table names only roles with a real check site', () => {
    assert.deepEqual(Object.keys(BUDGET_UNIT_BY_ROLE), ['auditor']);
    assert.equal(BUDGET_UNIT_BY_ROLE.toString, undefined, 'null-prototype: a role lookup must not answer for toString');
  });
});

describe('comparison/manifest — maxAttemptsPerArm + budgetUsdPerArm are analysis-time fields', () => {
  const AUDITOR_CONTROLS = {
    reasoningEffort: 'medium', promptTemplateId: AUDITOR_TIER_C_PROMPT_IDS.at(-1), outputSchemaId: AUDITOR_TIER_C_SCHEMA_IDS.at(-1),
    maxOutputTokens: 4096, toolPolicy: 'none', temperature: 0, passes: ['structure'], scope: 'diff', rounds: 1,
  };
  const auditor = (extra = {}) => ({
    schemaVersion: 1, id: 'budget-test', role: 'auditor',
    decision: { type: 'select_default', incumbent: 'latest-gpt' },
    arms: [{ id: 'gpt', model: 'latest-gpt', mode: 'primary' }, { id: 'other', model: 'latest-sonnet', mode: 'shadow' }],
    controls: AUDITOR_CONTROLS, ...extra,
  });

  it('both parse on an auditor manifest', () => {
    const { manifest } = parseComparisonManifest(auditor({ maxAttemptsPerArm: 3, budgetUsdPerArm: 2.5 }));
    assert.equal(manifest.maxAttemptsPerArm, 3);
    assert.equal(manifest.budgetUsdPerArm, 2.5);
  });

  it('NEITHER is in the lock: changing them leaves configDigest byte-identical (raising a ceiling must not orphan a paid cohort)', () => {
    const base = configDigest(parseComparisonManifest(auditor()).manifest);
    assert.equal(configDigest(parseComparisonManifest(auditor({ maxAttemptsPerArm: 5 })).manifest), base);
    assert.equal(configDigest(parseComparisonManifest(auditor({ budgetUsdPerArm: 9 })).manifest), base);
  });

  it('refuses a malformed cap or budget at load', () => {
    for (const bad of [{ maxAttemptsPerArm: 0 }, { maxAttemptsPerArm: 1.5 }, { maxAttemptsPerArm: 11 }, { budgetUsdPerArm: 0 }, { budgetUsdPerArm: -1 }]) {
      assert.throws(() => parseComparisonManifest(auditor(bad)), undefined, JSON.stringify(bad));
    }
  });

  it('a budget on a role with no billable-unit check site is REFUSED, not silently unenforced (INC-002)', () => {
    const adjudicator = {
      ...auditor({ budgetUsdPerArm: 1 }), role: 'adjudicator',
      controls: { tier: 'screen', reasoningEffort: 'medium', promptTemplateId: 'x', outputSchemaId: 'x', maxOutputTokens: 100, toolPolicy: 'none', temperature: 0 },
    };
    assert.throws(() => parseComparisonManifest(adjudicator), /budgetUsdPerArm/);
    const { budgetUsdPerArm: _omit, ...withoutBudget } = adjudicator;
    assert.doesNotThrow(() => parseComparisonManifest(withoutBudget), 'precondition: the refusal must come from the budget, not a malformed fixture');
  });

  it('NEGATIVE CONTROL: the same non-auditor manifest without a budget is not refused for budget reasons', () => {
    const shadow = {
      ...auditor(), role: 'final_review_shadow',
      arms: [{ id: 'a', model: 'claude-opus', mode: 'shadow' }, { id: 'b', model: 'gemini-pro-latest', mode: 'shadow' }],
      decision: { type: 'select_default', incumbent: 'claude-opus' },
      controls: { reasoningEffort: 'medium', promptTemplateId: 'x', outputSchemaId: 'x', maxOutputTokens: 100, toolPolicy: 'none', temperature: 0, envelopeScope: 'thin' },
    };
    assert.doesNotThrow(() => parseComparisonManifest(shadow));
    assert.throws(() => parseComparisonManifest({ ...shadow, budgetUsdPerArm: 1 }), /budgetUsdPerArm/);
  });
});
