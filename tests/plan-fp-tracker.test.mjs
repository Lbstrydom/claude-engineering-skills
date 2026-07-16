import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PlanFpTracker } from '../scripts/lib/plan-fp-tracker.mjs';

// ── Test fixtures ───────────────────────────────────────────────────────────

const SCOPE_TEXT = 'Insufficient test coverage — unit tests missing for all service functions';
const SCOPE_SIMILAR = 'Insufficient test coverage — missing unit tests for service layer functions';
const UNRELATED_TEXT = 'Missing authentication guard on /api/admin endpoint';

// ── Basic record / suppress ─────────────────────────────────────────────────

describe('PlanFpTracker — basic dismiss accumulation', () => {
  let tmpDir;
  let dataPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-fp-'));
    dataPath = path.join(tmpDir, 'plan-fp-patterns.json');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('does not suppress on first dismiss', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    assert.equal(tracker.shouldSuppress(SCOPE_TEXT), false);
  });

  it('does not suppress after two dismissals', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    assert.equal(tracker.shouldSuppress(SCOPE_TEXT), false);
  });

  it('suppresses after three consecutive dismissals with sufficient EMA', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    // Three consecutive dismissals needed — EMA: 0.2, 0.36, 0.488 (below 0.7)
    // Need more to hit 0.7 threshold: keep dismissing
    for (let i = 0; i < 10; i++) tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    assert.equal(tracker.shouldSuppress(SCOPE_TEXT), true);
  });

  it('resets consecutive count on acceptance', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    for (let i = 0; i < 10; i++) tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    tracker.recordOutcome(SCOPE_TEXT, 'accepted');
    assert.equal(tracker.shouldSuppress(SCOPE_TEXT), false);
  });

  it('does not suppress unrelated text even after many dismissals of other text', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    for (let i = 0; i < 10; i++) tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    assert.equal(tracker.shouldSuppress(UNRELATED_TEXT), false);
  });
});

// ── Jaccard similarity matching ─────────────────────────────────────────────

describe('PlanFpTracker — similarity-based matching', () => {
  let tmpDir;
  let dataPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-fp-'));
    dataPath = path.join(tmpDir, 'plan-fp-patterns.json');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('matches similar (but not identical) text', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    for (let i = 0; i < 10; i++) tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    // SCOPE_SIMILAR shares enough tokens with SCOPE_TEXT to match above 0.4 threshold
    assert.equal(tracker.shouldSuppress(SCOPE_SIMILAR), true);
  });

  it('does not match short disconnected text', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    for (let i = 0; i < 10; i++) tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    assert.equal(tracker.shouldSuppress('Authentication missing'), false);
  });
});

// ── Persistence ─────────────────────────────────────────────────────────────

describe('PlanFpTracker — save/load persistence', () => {
  let tmpDir;
  let dataPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-fp-'));
    dataPath = path.join(tmpDir, 'plan-fp-patterns.json');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('persists patterns across tracker instances', () => {
    const t1 = new PlanFpTracker(dataPath).load();
    for (let i = 0; i < 10; i++) t1.recordOutcome(SCOPE_TEXT, 'dismissed');
    t1.save();

    const t2 = new PlanFpTracker(dataPath).load();
    assert.equal(t2.shouldSuppress(SCOPE_TEXT), true);
  });

  it('file contains valid JSON after save', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    tracker.save();

    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    assert.ok(Array.isArray(raw.patterns));
    assert.equal(raw.patterns.length, 1);
    assert.ok(raw.patterns[0].text);
    assert.ok(typeof raw.patterns[0].emaScore === 'number');
    assert.ok(typeof raw.patterns[0].consecutiveCount === 'number');
  });

  it('load() is idempotent — calling twice does not duplicate patterns', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    for (let i = 0; i < 3; i++) tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    tracker.save();
    tracker.load(); // second load — should not add duplicates
    tracker.save();

    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    assert.equal(raw.patterns.length, 1);
  });

  it('handles missing file gracefully — starts fresh', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    assert.equal(tracker.shouldSuppress(SCOPE_TEXT), false);
  });

  it('handles corrupt file gracefully — starts fresh', () => {
    fs.writeFileSync(dataPath, '{ broken json !!');
    const tracker = new PlanFpTracker(dataPath).load();
    // Should not throw; starts with empty patterns
    assert.equal(tracker.shouldSuppress(SCOPE_TEXT), false);
  });

  it('creates parent directory if missing', () => {
    const nested = path.join(tmpDir, 'sub', 'dir', 'plan-fp.json');
    const tracker = new PlanFpTracker(nested).load();
    tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
    tracker.save();
    assert.ok(fs.existsSync(nested));
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('PlanFpTracker — edge cases', () => {
  let tmpDir;
  let dataPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-fp-'));
    dataPath = path.join(tmpDir, 'plan-fp-patterns.json');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('ignores empty string input', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    tracker.recordOutcome('', 'dismissed'); // should not throw
    assert.equal(tracker.shouldSuppress(''), false);
  });

  it('shouldSuppress returns false on empty pattern list', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    assert.equal(tracker.shouldSuppress(SCOPE_TEXT), false);
  });

  it('EMA score increases monotonically with consecutive dismissals', () => {
    const tracker = new PlanFpTracker(dataPath).load();
    const scores = [];
    for (let i = 0; i < 5; i++) {
      tracker.recordOutcome(SCOPE_TEXT, 'dismissed');
      // Access internal state to verify EMA increasing
      const pattern = tracker._patterns.find(p => p.text === SCOPE_TEXT);
      if (pattern) scores.push(pattern.emaScore);
    }
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] > scores[i - 1], `EMA should increase: ${scores}`);
    }
  });
});
