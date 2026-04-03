import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  GeneratedVariantSchema, ExperimentRecordSchema,
  reviewExperiments, showStats
} from '../scripts/evolve-prompts.mjs';
import { PromptBandit } from '../scripts/bandit.mjs';
import { createRNG } from '../scripts/lib/rng.mjs';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Schema Validation ───────────────────────────────────────────────────────

describe('GeneratedVariantSchema', () => {
  it('accepts valid variant', () => {
    const result = GeneratedVariantSchema.safeParse({
      promptText: 'x'.repeat(100),
      diff: '- old\n+ new',
      rationale: 'Reduces false positives in error handling category',
      targetedPatterns: ['missing error handling::MEDIUM::robustness']
    });
    assert.ok(result.success, `Should pass: ${result.error?.message}`);
  });

  it('rejects promptText shorter than 100 chars', () => {
    const result = GeneratedVariantSchema.safeParse({
      promptText: 'too short',
      diff: 'diff',
      rationale: 'reason',
      targetedPatterns: []
    });
    assert.ok(!result.success);
  });
});

describe('ExperimentRecordSchema', () => {
  it('accepts valid experiment', () => {
    const result = ExperimentRecordSchema.safeParse({
      experimentId: 'backend-rev-abc123456789',
      timestamp: Date.now(),
      pass: 'backend',
      revisionId: 'rev-abc123456789',
      parentRevisionId: 'rev-def456789012',
      parentEWR: 0.45,
      parentConfidence: 0.8,
      parentEffectiveSampleSize: 25,
      status: 'active'
    });
    assert.ok(result.success, `Should pass: ${result.error?.message}`);
  });

  it('validates status enum', () => {
    const result = ExperimentRecordSchema.safeParse({
      experimentId: 'test-1',
      timestamp: Date.now(),
      pass: 'test',
      revisionId: 'rev-1',
      parentRevisionId: 'rev-0',
      parentEWR: 0.5,
      parentConfidence: 0.5,
      parentEffectiveSampleSize: 10,
      status: 'invalid_status'
    });
    assert.ok(!result.success);
  });
});

// ── Review ──────────────────────────────────────────────────────────────────

describe('reviewExperiments', () => {
  it('returns NO_ACTION when no experiments exist', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'bandit.json'));
    const result = reviewExperiments(bandit);
    assert.equal(result.status, 'NO_ACTION');
    assert.equal(result.experiments.length, 0);
  });
});

// ── Stats ───────────────────────────────────────────────────────────────────

describe('showStats', () => {
  it('returns pass stats even with empty outcomes', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'bandit.json'));
    const outcomesPath = path.join(tmpDir, 'outcomes.jsonl');
    const result = showStats(outcomesPath, bandit);
    assert.ok(result.passStats.length === 5);
    assert.ok(result.activeExperiments.length === 0);
  });
});
