import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  PromptBandit, computeReward, deliberationSignal,
  computePassReward, buildContext, contextSizeTier, contextBucketKey
} from '../scripts/bandit.mjs';
import { createRNG } from '../scripts/lib/rng.mjs';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
