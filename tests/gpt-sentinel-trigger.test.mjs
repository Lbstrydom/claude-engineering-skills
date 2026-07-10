/**
 * Tier-1 tests for the GPT sentinel trigger (tiered-recall pipeline, Cluster D
 * scoped Phase 6). Plan: docs/plans/tiered-recall-audit-pipeline.md.
 * Covers: the pure deterministic + exploration paths directly, and the
 * bandit-backed sentinel path via a real (temp-file-backed) PromptBandit
 * instance — no live LLM/network calls anywhere in this module.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KEYWORD_GROUPS, shouldTriggerGpt, shouldFireSentinel, isExplorationSample, resolveGptTrigger,
} from '../scripts/lib/audit/gpt-sentinel-trigger.mjs';
import { PromptBandit } from '../scripts/bandit.mjs';

const CONFIG = { gptDiffSizeTriggerChars: 150000, gptExplorationRate: 0.1 };

describe('shouldTriggerGpt — deterministic path', () => {
  it('fires on diff-size threshold', () => {
    const r = shouldTriggerGpt({ diffSize: 200000, changedFiles: ['a.js'] }, CONFIG);
    assert.equal(r.fire, true);
    assert.ok(r.reasonCodes.includes('diff_size_threshold'));
  });
  it('fires on a security keyword match', () => {
    const r = shouldTriggerGpt({ diffSize: 10, changedFiles: ['a.js'], diffText: 'adds a new oauth token validator' }, CONFIG);
    assert.equal(r.fire, true);
    assert.ok(r.reasonCodes.includes('keyword:security'));
  });
  it('does NOT fire on a keyword appearing only as a substring of an unrelated word (audit fix L3)', () => {
    const r = shouldTriggerGpt({ diffSize: 10, changedFiles: ['a.js'], diffText: 'update the author bio and book cover atomically in the CMS' }, CONFIG);
    // "author" contains "auth"; "atomically"/"cover" are unrelated to "atomic"/"race" —
    // none of these should trigger a word-boundary match.
    assert.equal(r.fire, false);
  });
  it('still fires on a real word-boundary keyword match, including multi-word phrases', () => {
    const r = shouldTriggerGpt({ diffSize: 10, changedFiles: ['a.js'], diffText: 'refactor to use Promise.all for the foreign key lookups' }, CONFIG);
    assert.ok(r.reasonCodes.includes('keyword:concurrency'));
    assert.ok(r.reasonCodes.includes('keyword:dataIntegrity'));
  });
  it('a stem keyword matches its inflected forms — sanitize/sanitized/sanitization (audit fix M5/M8, round 2)', () => {
    for (const word of ['sanitize', 'sanitized', 'sanitization', 'sanitizing']) {
      const r = shouldTriggerGpt({ diffSize: 10, changedFiles: [], diffText: `add input ${word} before the query` }, CONFIG);
      assert.ok(r.reasonCodes.includes('keyword:security'), `expected "${word}" to match the sanitiz* stem`);
    }
  });
  it('stem keywords encrypt*/decrypt* match their inflected forms too', () => {
    const r1 = shouldTriggerGpt({ diffSize: 10, changedFiles: [], diffText: 'store the encrypted payload' }, CONFIG);
    assert.ok(r1.reasonCodes.includes('keyword:security'));
    const r2 = shouldTriggerGpt({ diffSize: 10, changedFiles: [], diffText: 'add a decryption helper' }, CONFIG);
    assert.ok(r2.reasonCodes.includes('keyword:security'));
  });
  it('a stem keyword still requires a word-start boundary — does not match mid-word', () => {
    const r = shouldTriggerGpt({ diffSize: 10, changedFiles: [], diffText: 'resanitize the buffer' }, CONFIG);
    assert.equal(r.fire, false); // "resanitize" has no word-boundary immediately before "sanitiz"
  });
  it('a non-stem keyword (auth) still does NOT match inside an unrelated word (regression guard for the stem change)', () => {
    const r = shouldTriggerGpt({ diffSize: 10, changedFiles: [], diffText: 'update the author metadata' }, CONFIG);
    assert.equal(r.fire, false);
  });
  it('fires on portfolioDisagreement alone', () => {
    const r = shouldTriggerGpt({ diffSize: 10, changedFiles: ['a.js'], portfolioDisagreement: true }, CONFIG);
    assert.equal(r.fire, true);
    assert.ok(r.reasonCodes.includes('portfolio_disagreement'));
  });
  it('does not fire when nothing matches', () => {
    const r = shouldTriggerGpt({ diffSize: 10, changedFiles: ['a.js'], diffText: 'fix a typo in a comment' }, CONFIG);
    assert.equal(r.fire, false);
    assert.deepEqual(r.reasonCodes, []);
  });
  it('reports multiple matched keyword groups', () => {
    const r = shouldTriggerGpt({ diffSize: 10, changedFiles: [], diffText: 'add a payment mutex around the charge transaction' }, CONFIG);
    assert.ok(r.reasonCodes.includes('keyword:payment'));
    assert.ok(r.reasonCodes.includes('keyword:concurrency'));
  });
  it('KEYWORD_GROUPS is exported and non-empty for reuse/testing', () => {
    assert.ok(Object.keys(KEYWORD_GROUPS).length > 0);
  });
});

describe('isExplorationSample — deterministic seeded draw', () => {
  it('is deterministic for a fixed seed', () => {
    const a = isExplorationSample({ seed: 42, rate: 0.5 });
    const b = isExplorationSample({ seed: 42, rate: 0.5 });
    assert.equal(a, b);
  });
  it('never samples at rate 0', () => {
    for (let seed = 0; seed < 20; seed++) {
      assert.equal(isExplorationSample({ seed, rate: 0 }), false);
    }
  });
  it('always samples at rate 1', () => {
    for (let seed = 0; seed < 20; seed++) {
      assert.equal(isExplorationSample({ seed, rate: 1 }), true);
    }
  });
});

describe('shouldFireSentinel — real PromptBandit, no live calls', () => {
  let statePath;
  before(() => { statePath = path.join(os.tmpdir(), `bandit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`); });
  after(() => { try { fs.unlinkSync(statePath); } catch { /* ignore */ } });

  it('registers both arms and returns a valid variantId', () => {
    const bandit = new PromptBandit(statePath);
    const result = shouldFireSentinel(bandit);
    assert.ok(['fire', 'skip'].includes(result.variantId));
    assert.equal(result.fire, result.variantId === 'fire');
  });
  it('is idempotent to call repeatedly (arms are not re-created)', () => {
    const bandit = new PromptBandit(statePath);
    shouldFireSentinel(bandit);
    shouldFireSentinel(bandit);
    const stats = bandit.getStats(); // array of {pass, variant, contextBucket, ...}
    const fireArms = stats.filter((s) => s.pass === 'gpt-sentinel-trigger' && s.variant === 'fire');
    assert.equal(fireArms.length, 1);
  });
});

describe('resolveGptTrigger — three-path composition', () => {
  it('prefers the deterministic path over exploration/sentinel', () => {
    const r = resolveGptTrigger({ diffSize: 200000, changedFiles: [] }, { seed: 1 }, null, CONFIG);
    assert.equal(r.firedBy, 'deterministic');
  });
  it('falls through to exploration when deterministic does not fire and the seed lands in-sample', () => {
    const highRateConfig = { ...CONFIG, gptExplorationRate: 1 };
    const r = resolveGptTrigger({ diffSize: 10, changedFiles: [] }, { seed: 5 }, null, highRateConfig);
    assert.equal(r.firedBy, 'exploration');
  });
  it('returns no-fire when neither deterministic nor exploration fires and no bandit is injected', () => {
    const zeroRateConfig = { ...CONFIG, gptExplorationRate: 0 };
    const r = resolveGptTrigger({ diffSize: 10, changedFiles: [] }, { seed: 5 }, null, zeroRateConfig);
    assert.equal(r.fire, false);
    assert.equal(r.firedBy, null);
  });
});
