import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  PromptBandit, computeReward, computeUserImpactReward, deliberationSignal,
  computePassReward, buildContext, contextSizeTier, contextBucketKey
} from '../scripts/bandit.mjs';
import { createRNG } from '../scripts/lib/rng.mjs';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ── PromptBandit ────────────────────────────────────────────────────────────

describe('PromptBandit', () => {
  it('registers and selects arms', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('backend', 'v1');
    bandit.addArm('backend', 'v2');
    const selected = bandit.select('backend');
    assert.ok(selected);
    assert.equal(selected.passName, 'backend');
  });

  it('returns null for unknown pass', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    assert.equal(bandit.select('nonexistent'), null);
  });

  it('returns single arm when only one exists', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('structure', 'default');
    const arm = bandit.select('structure');
    assert.equal(arm.variantId, 'default');
  });

  it('updates arm with proper Beta posterior', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('test', 'v1');
    bandit.update('test', 'v1', 0.8);
    const arm = bandit.arms['test:v1:global'];
    assert.ok(Math.abs(arm.alpha - 1.8) < 0.001, `alpha should be 1.8, got ${arm.alpha}`);
    assert.ok(Math.abs(arm.beta - 1.2) < 0.001, `beta should be 1.2, got ${arm.beta}`);
    assert.equal(arm.pulls, 1);
  });

  it('clamps reward to [0,1]', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('test', 'v1');
    bandit.update('test', 'v1', 1.5);
    const arm = bandit.arms['test:v1:global'];
    assert.ok(Math.abs(arm.alpha - 2.0) < 0.001);
    assert.ok(Math.abs(arm.beta - 1.0) < 0.001);
  });

  it('update with reward=0 increments only beta', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('test', 'v1');
    bandit.update('test', 'v1', 0);
    const arm = bandit.arms['test:v1:global'];
    assert.ok(Math.abs(arm.alpha - 1.0) < 0.001);
    assert.ok(Math.abs(arm.beta - 2.0) < 0.001);
  });

  it('does not duplicate arms on re-add', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('pass', 'v1');
    bandit.addArm('pass', 'v1');
    assert.equal(Object.keys(bandit.arms).length, 1);
  });

  it('flush writes state to disk', () => {
    const statePath = path.join(tmpDir, 'state.json');
    const b1 = new PromptBandit(statePath);
    b1.addArm('test', 'v1');
    b1.update('test', 'v1', 0.7);
    b1.flush();

    const b2 = new PromptBandit(statePath);
    const arm = b2.arms['test:v1:global'];
    assert.ok(arm);
    assert.equal(arm.pulls, 1);
    assert.ok(Math.abs(arm.alpha - 1.7) < 0.001);
  });

  it('getStats returns sorted by estimated rate', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('test', 'good');
    bandit.addArm('test', 'bad');
    for (let i = 0; i < 5; i++) bandit.update('test', 'good', 0.9);
    for (let i = 0; i < 5; i++) bandit.update('test', 'bad', 0.1);
    bandit.flush();
    const stats = bandit.getStats();
    assert.equal(stats[0].variant, 'good');
  });

  it('hasConverged returns false with too few pulls', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('test', 'v1');
    bandit.addArm('test', 'v2');
    assert.equal(bandit.hasConverged('test'), false);
  });
});

// ── Seedable RNG + Deterministic Selection ──────────────────────────────────

describe('PromptBandit with seedable RNG', () => {
  it('produces deterministic selections with same seed', () => {
    // Set up arms with data, then test selection determinism
    const setup = new PromptBandit(path.join(tmpDir, 's1.json'));
    setup.addArm('test', 'a');
    setup.addArm('test', 'b');
    for (let i = 0; i < 5; i++) {
      setup.update('test', 'a', 0.6);
      setup.update('test', 'b', 0.4);
    }
    setup.flush();

    const rng1 = createRNG(42);
    const b1 = new PromptBandit(path.join(tmpDir, 's1.json'), { rng: rng1 });
    const rng2 = createRNG(42);
    const b2 = new PromptBandit(path.join(tmpDir, 's1.json'), { rng: rng2 });
    const sel1 = b1.select('test');
    const sel2 = b2.select('test');
    assert.ok(sel1, 'sel1 should not be null');
    assert.ok(sel2, 'sel2 should not be null');
    assert.equal(sel1.variantId, sel2.variantId);
  });
});

// ── Hierarchical Context Backoff ────────────────────────────────────────────

describe('select() with context', () => {
  it('falls back to global when exact bucket has no data', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'ctx.json'));
    bandit.addArm('backend', 'default');
    // Give global arm enough pulls
    for (let i = 0; i < 10; i++) bandit.update('backend', 'default', 0.7);
    bandit.flush();

    const ctx = { sizeTier: 'small', dominantLanguage: 'js' };
    const arm = bandit.select('backend', ctx);
    assert.ok(arm);
    assert.equal(arm.variantId, 'default');
  });
});

// ── UCB Cold-Start ──────────────────────────────────────────────────────────

describe('UCB cold-start exploration', () => {
  it('selects underexplored arms first', () => {
    const rng = createRNG(42);
    const bandit = new PromptBandit(path.join(tmpDir, 'ucb.json'), { rng });
    bandit.addArm('test', 'explored');
    bandit.addArm('test', 'fresh');
    // Give 'explored' many pulls
    for (let i = 0; i < 10; i++) bandit.update('test', 'explored', 0.9);
    // 'fresh' has 0 pulls — should be selected via UCB

    const arm = bandit.select('test');
    assert.equal(arm.variantId, 'fresh');
  });
});

// ── armsReferencingRevision ─────────────────────────────────────────────────

describe('armsReferencingRevision', () => {
  it('finds arms with matching promptRevisionId', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'ref.json'));
    bandit.addArm('backend', 'rev-abc123456789', null, { promptRevisionId: 'rev-abc123456789' });
    bandit.addArm('backend', 'rev-def456789012', null, { promptRevisionId: 'rev-def456789012' });
    const refs = bandit.armsReferencingRevision('backend', 'rev-abc123456789');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].variantId, 'rev-abc123456789');
  });
});

// ── Context Helpers ─────────────────────────────────────────────────────────

describe('contextSizeTier', () => {
  it('classifies sizes correctly', () => {
    assert.equal(contextSizeTier(5000), 'small');
    assert.equal(contextSizeTier(50000), 'medium');
    assert.equal(contextSizeTier(200000), 'large');
    assert.equal(contextSizeTier(500000), 'xlarge');
  });
});

describe('buildContext', () => {
  it('returns null for null profile', () => {
    assert.equal(buildContext(null), null);
  });

  it('builds context from profile', () => {
    const ctx = buildContext({ totalChars: 50000, dominantLanguage: 'javascript' });
    assert.equal(ctx.sizeTier, 'medium');
    assert.equal(ctx.dominantLanguage, 'js');
  });
});

// ── Canonical Reward Formula (v2) ───────────────────────────────────────────

describe('computeReward (v2)', () => {
  it('returns high reward for accepted + sustained HIGH finding', () => {
    const reward = computeReward({
      claude_position: 'accept',
      gpt_ruling: 'sustain',
      final_severity: 'HIGH'
    });
    assert.ok(reward > 0.5, `Expected > 0.5, got ${reward}`);
  });

  it('includes substantive signal when evaluationRecord provided', () => {
    const rewardWithout = computeReward({
      claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH'
    });
    const rewardWith = computeReward({
      claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH',
      semanticHash: 'abc123'
    }, {
      findingEditLinks: [{
        semanticHash: 'abc123', remediationState: 'verified'
      }]
    });
    assert.ok(rewardWith > rewardWithout, `With substantive (${rewardWith}) should > without (${rewardWithout})`);
  });

  it('returns zero for challenged + overruled', () => {
    const reward = computeReward({
      claude_position: 'challenge', gpt_ruling: 'overrule', final_severity: 'HIGH'
    });
    // Deliberation signal still provides base 0.5, so total won't be exactly 0
    // But procedural + substantive should be 0
    assert.ok(reward < 0.3, `Expected < 0.3, got ${reward}`);
  });

  it('LOW severity reduces reward', () => {
    const high = computeReward({ claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH' });
    const low = computeReward({ claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'LOW' });
    assert.ok(low < high);
  });

  it('user-impact confirmed_hit on P0 increases reward above baseline', () => {
    const baseline = computeReward({
      claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH',
    });
    const withConfirmedHit = computeReward(
      { claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH' },
      null,
      { correlationType: 'confirmed_hit', personaSeverity: 'P0' }
    );
    assert.ok(withConfirmedHit > baseline,
      `confirmed_hit (${withConfirmedHit}) should exceed baseline (${baseline})`);
  });

  it('user-impact audit_false_positive on P0 drags reward below baseline', () => {
    const baseline = computeReward({
      claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH',
    });
    const withFP = computeReward(
      { claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH' },
      null,
      { correlationType: 'audit_false_positive', personaSeverity: 'P0' }
    );
    assert.ok(withFP < baseline,
      `audit_false_positive (${withFP}) should be below baseline (${baseline})`);
  });

  it('user-impact null leaves reward at legacy 40/30/30 weights', () => {
    const withNull = computeReward(
      { claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH' },
      null,
      null
    );
    const withUndef = computeReward(
      { claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH' }
    );
    assert.equal(withNull, withUndef);
  });

  it('user-impact reward stays in [0, 1]', () => {
    for (const type of ['confirmed_hit', 'severity_understated', 'severity_overstated', 'audit_false_positive', 'audit_missed']) {
      for (const sev of ['P0', 'P1', 'P2', 'P3']) {
        const r = computeReward(
          { claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH' },
          null,
          { correlationType: type, personaSeverity: sev }
        );
        assert.ok(r >= 0 && r <= 1, `${type}/${sev} → ${r} out of range`);
      }
    }
  });
});

describe('computeUserImpactReward', () => {
  it('returns null when no impact supplied', () => {
    assert.equal(computeUserImpactReward(null), null);
    assert.equal(computeUserImpactReward({}), null);
    assert.equal(computeUserImpactReward({ personaSeverity: 'P0' }), null);
  });

  it('confirmed_hit ranks higher than severity_understated', () => {
    const hit = computeUserImpactReward({ correlationType: 'confirmed_hit', personaSeverity: 'P0' });
    const under = computeUserImpactReward({ correlationType: 'severity_understated', personaSeverity: 'P0' });
    assert.ok(hit > under, `confirmed_hit (${hit}) should exceed severity_understated (${under})`);
  });

  it('audit_false_positive gives the lowest reward', () => {
    const fp = computeUserImpactReward({ correlationType: 'audit_false_positive', personaSeverity: 'P0' });
    const hit = computeUserImpactReward({ correlationType: 'confirmed_hit', personaSeverity: 'P0' });
    assert.ok(fp < hit);
    assert.ok(fp >= 0);
  });

  it('P3 severity compresses reward toward neutral', () => {
    const p0 = computeUserImpactReward({ correlationType: 'confirmed_hit', personaSeverity: 'P0' });
    const p3 = computeUserImpactReward({ correlationType: 'confirmed_hit', personaSeverity: 'P3' });
    // P3 should be closer to 0.5 neutral than P0
    assert.ok(Math.abs(p3 - 0.5) < Math.abs(p0 - 0.5),
      `P3 (${p3}) should be closer to 0.5 than P0 (${p0})`);
  });

  it('unknown persona severity still produces a finite reward', () => {
    const r = computeUserImpactReward({ correlationType: 'confirmed_hit', personaSeverity: 'unknown' });
    assert.ok(Number.isFinite(r));
    assert.ok(r >= 0 && r <= 1);
  });
});

// ── Deliberation Signal ─────────────────────────────────────────────────────

describe('deliberationSignal', () => {
  it('highest for challenged + sustained', () => {
    const signal = deliberationSignal({ claude_position: 'challenge', gpt_ruling: 'sustain' });
    assert.ok(signal >= 0.8, `Expected >= 0.8, got ${signal}`);
  });

  it('lowest for trivially accepted + sustained', () => {
    const signal = deliberationSignal({ claude_position: 'accept', gpt_ruling: 'sustain' });
    assert.ok(signal < 0.5, `Expected < 0.5, got ${signal}`);
  });

  it('compromise adds bonus', () => {
    const noCompromise = deliberationSignal({ claude_position: 'accept', gpt_ruling: 'sustain' });
    const withCompromise = deliberationSignal({ claude_position: 'accept', gpt_ruling: 'compromise' });
    assert.ok(withCompromise > noCompromise);
  });

  it('long rationale adds bonus', () => {
    const short = deliberationSignal({ claude_position: 'accept', gpt_ruling: 'sustain', ruling_rationale: 'ok' });
    const long = deliberationSignal({ claude_position: 'accept', gpt_ruling: 'sustain', ruling_rationale: 'x'.repeat(300) });
    assert.ok(long > short);
  });
});

// ── computePassReward ───────────────────────────────────────────────────────

describe('computePassReward', () => {
  it('returns mean of per-finding rewards', () => {
    const record = {
      findingEditLinks: [
        { reward: 0.8 },
        { reward: 0.4 },
        { reward: 0.6 }
      ]
    };
    const result = computePassReward(record);
    assert.ok(Math.abs(result - 0.6) < 0.001);
  });

  it('returns 0 for empty links', () => {
    assert.equal(computePassReward({ findingEditLinks: [] }), 0);
  });
});

// ── nonPersistingView (shadow-write-gate plan, Phase 1 — test-first) ────────
//
// An observation-only run (noCloudRecording) must be able to READ the bandit
// (arm registration + selection keep its suppression behaviour faithful) but
// must never persist: addArm() on a not-yet-registered key calls _save(), so
// for the standalone verify-anchor-contract caller the shared instance was a
// real local-persistence channel. The view closes it: cloned arms, no-op
// store, sentinel path, own RNG.
describe('PromptBandit.nonPersistingView', () => {
  it('preserves the parent arms + posteriors at snapshot time', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('backend', 'v1');
    bandit.recordOutcome?.('backend', 'v1', 1) ?? null; // posterior nudge if API exists
    const view = bandit.nonPersistingView();
    assert.deepEqual(Object.keys(view.arms).sort(), Object.keys(bandit.arms).sort());
    const key = Object.keys(bandit.arms)[0];
    assert.equal(view.arms[key].alpha, bandit.arms[key].alpha);
    assert.equal(view.arms[key].beta, bandit.arms[key].beta);
  });

  it('a view mutation never appears in the parent map (clone isolation)', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('backend', 'v1');
    const view = bandit.nonPersistingView();
    view.addArm('frontend', 'vNEW');
    assert.ok(!('frontend:vNEW:global' in bandit.arms), 'parent must not gain the view arm');
    assert.ok(Object.keys(view.arms).some(k => k.startsWith('frontend:vNEW')), 'view has it');
  });

  it('view addArm + flush never touch the parent state file on disk', () => {
    const statePath = path.join(tmpDir, 'state.json');
    const bandit = new PromptBandit(statePath);
    bandit.addArm('backend', 'v1');
    bandit.flush(); // parent persists once — baseline
    const before = fs.readFileSync(statePath, 'utf8');
    const view = bandit.nonPersistingView();
    view.addArm('frontend', 'vNEW'); // would _save() on a real store
    view.flush();                    // would write the file on a real store
    const after = fs.readFileSync(statePath, 'utf8');
    assert.equal(after, before, 'state file must be byte-identical after view mutations');
  });

  it('the view does not share the parent RNG (a stateful seeded closure must not advance)', () => {
    const rng = createRNG(42);
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'), { rng });
    const view = bandit.nonPersistingView();
    assert.notEqual(view._rng, bandit._rng, 'view must have its own RNG');
  });

  it('the view carries a sentinel path, not the parent statePath', () => {
    const statePath = path.join(tmpDir, 'state.json');
    const bandit = new PromptBandit(statePath);
    const view = bandit.nonPersistingView();
    assert.notEqual(view.statePath, bandit.statePath, 'a real path in the view is a latent write channel');
  });
});
