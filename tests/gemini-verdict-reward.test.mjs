/**
 * @fileoverview The final-review verdict reward must reach the bandit on a
 * FRESH checkout (upstream 0aab5c0f).
 *
 * The `gemini-review` arm used to be registered only by the legacy code-audit
 * loop, and bandit state is per checkout, so in a fresh worktree — and on every
 * plan / tiered / standalone review — `update` hit an unknown arm, warned
 * "skipped", returned false, and the false was ignored. The fix registers the
 * arm where the reward is recorded and reports a dropped reward.
 *
 * No provider calls: the "result" is a hand-built review verdict object.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PromptBandit } from '../scripts/bandit.mjs';
import { recordGeminiVerdictReward, recordGeminiOutcomes } from '../scripts/lib/final-review/post-review.mjs';
import { captureStderr } from './helpers/capture-stderr.mjs';

const ARM_KEY = (rev) => `gemini-review:${rev}:global`;

let tmpDir;
let savedCwd;
let savedLearning;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-reward-'));
  savedCwd = process.cwd();
  savedLearning = process.env.LEARNING_DISABLE;
  delete process.env.LEARNING_DISABLE;
});
afterEach(() => {
  process.chdir(savedCwd);
  if (savedLearning === undefined) delete process.env.LEARNING_DISABLE;
  else process.env.LEARNING_DISABLE = savedLearning;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('recordGeminiVerdictReward', () => {
  it('negative control: the PRE-FIX call shape (update without addArm) drops the reward on fresh state', async () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    const { result: value } = await captureStderr(() => bandit.update('gemini-review', 'rev-1', 0.8));
    assert.equal(value, false, 'fresh state has no gemini-review arm — this is the bug the fix closes');
    assert.equal(bandit.arms[ARM_KEY('rev-1')], undefined);
  });

  it('a fresh bandit state records the final-review reward', async () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    const r = recordGeminiVerdictReward(bandit, { verdict: 'APPROVE' }, 'rev-1', { env: {} });
    assert.deepEqual(r, { recorded: true, reason: 'recorded' });
    const arm = bandit.arms[ARM_KEY('rev-1')];
    assert.equal(arm.pulls, 1);
    assert.equal(arm.alpha, 1.8, 'APPROVE reward 0.8 (map moved verbatim)');
    assert.equal(arm.promptRevisionId, 'rev-1');
    // Idempotent registration: a second reward lands on the same arm.
    recordGeminiVerdictReward(bandit, { verdict: 'REJECT' }, 'rev-1', { env: {} });
    assert.equal(bandit.arms[ARM_KEY('rev-1')].pulls, 2);
  });

  it('LEARNING_DISABLE=1 → no arm registered, no pull', async () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    const r = recordGeminiVerdictReward(bandit, { verdict: 'APPROVE' }, 'rev-1', { env: { LEARNING_DISABLE: '1' } });
    assert.deepEqual(r, { recorded: false, reason: 'learning-disabled' });
    assert.deepEqual(bandit.arms, {});
  });

  it('a coverage-gated verdict is not a reward (existing rule preserved)', async () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    const r = recordGeminiVerdictReward(bandit, { verdict: 'CONCERNS', _coverageGate: { downgraded: true } }, 'rev-1', { env: {} });
    assert.equal(r.reason, 'coverage-gated');
    assert.equal(bandit.arms[ARM_KEY('rev-1')], undefined);
  });

  it('update returning false is REPORTED, not ignored', async () => {
    const stub = { addArm() {}, update() { return false; } };
    const { result: value, text: stderr } = await captureStderr(() => recordGeminiVerdictReward(stub, { verdict: 'APPROVE' }, 'rev-1', { env: {} }));
    assert.deepEqual(value, { recorded: false, reason: 'update-rejected' });
    assert.match(stderr, /gemini-review verdict reward NOT recorded/);
  });

  it('a throwing bandit is contained and reported', async () => {
    const stub = { addArm() { throw new Error('EPERM state write'); }, update() { return true; } };
    const { result: value, text: stderr } = await captureStderr(() => recordGeminiVerdictReward(stub, { verdict: 'APPROVE' }, 'rev-1', { env: {} }));
    assert.deepEqual(value, { recorded: false, reason: 'error' });
    assert.match(stderr, /NOT recorded \(EPERM state write\)/);
  });
});

describe('recordGeminiOutcomes wiring (fresh checkout)', () => {
  it('records the verdict reward into a bandit state that did not exist', async () => {
    process.chdir(tmpDir);
    await captureStderr(() => recordGeminiOutcomes({ verdict: 'APPROVE' }, 'gemini-test'));
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, '.audit', 'bandit-state.json'), 'utf-8'));
    const keys = Object.keys(state).filter((k) => k.startsWith('gemini-review:'));
    assert.equal(keys.length, 1, `expected one gemini-review arm, got ${JSON.stringify(Object.keys(state))}`);
    assert.equal(state[keys[0]].pulls, 1);
  });

  it('LEARNING_DISABLE=1 → the bandit is never constructed, no state file written', async () => {
    process.chdir(tmpDir);
    process.env.LEARNING_DISABLE = '1';
    await captureStderr(() => recordGeminiOutcomes({ verdict: 'APPROVE' }, 'gemini-test'));
    assert.equal(fs.existsSync(path.join(tmpDir, '.audit', 'bandit-state.json')), false);
  });
});
