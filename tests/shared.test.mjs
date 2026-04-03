import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  atomicWriteFileSync,
  zodToGeminiSchema,
  FindingSchema,
  FindingJsonSchema,
  LedgerEntrySchema,
  AdjudicationLedgerSchema,
  writeLedgerEntry,
  generateTopicId,
  populateFindingMetadata,
  semanticId,
  jaccardSimilarity,
  normalizePath,
  FalsePositiveTracker,
  computePassEWR,
  applyLazyDecay,
  effectiveSampleSize,
  recordWithDecay,
  extractDimensions,
  buildPatternKey,
  loadOutcomes,
  compactOutcomes,
  createRemediationTask,
  trackEdit,
  verifyTask,
  normalizeLanguage,
  createRNG,
  reservoirSample,
  revisionId,
  saveRevision,
  getActiveRevisionId,
  getActivePrompt,
  promoteRevision,
  abandonRevision,
  bootstrapFromConstants
} from '../scripts/shared.mjs';
import { z } from 'zod';

// ── Test Helpers ────────────────────────────────────────────────────────────

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── atomicWriteFileSync ─────────────────────────────────────────────────────

describe('atomicWriteFileSync', () => {
  it('writes file content correctly', () => {
    const filePath = path.join(tmpDir, 'test.json');
    atomicWriteFileSync(filePath, '{"hello":"world"}');
    assert.equal(fs.readFileSync(filePath, 'utf-8'), '{"hello":"world"}');
  });

  it('creates parent directories', () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'test.json');
    atomicWriteFileSync(filePath, 'data');
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'data');
  });

  it('overwrites existing file atomically', () => {
    const filePath = path.join(tmpDir, 'overwrite.json');
    atomicWriteFileSync(filePath, 'first');
    atomicWriteFileSync(filePath, 'second');
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'second');
  });

  it('does not leave temp files on success', () => {
    const filePath = path.join(tmpDir, 'clean.json');
    atomicWriteFileSync(filePath, 'data');
    const files = fs.readdirSync(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], 'clean.json');
  });
});

// ── zodToGeminiSchema ───────────────────────────────────────────────────────

describe('zodToGeminiSchema', () => {
  it('converts a simple Zod schema to JSON Schema', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number()
    });
    const json = zodToGeminiSchema(schema);
    assert.equal(json.type, 'object');
    assert.ok(json.properties.name);
    assert.ok(json.properties.age);
    assert.equal(json.properties.name.type, 'string');
    assert.equal(json.properties.age.type, 'number');
  });

  it('strips $schema and additionalProperties', () => {
    const schema = z.object({ a: z.string() });
    const json = zodToGeminiSchema(schema);
    assert.equal(json['$schema'], undefined);
    assert.equal(json.additionalProperties, undefined);
  });

  it('preserves enum values', () => {
    const schema = z.object({
      severity: z.enum(['HIGH', 'MEDIUM', 'LOW'])
    });
    const json = zodToGeminiSchema(schema);
    assert.deepEqual(json.properties.severity.enum, ['HIGH', 'MEDIUM', 'LOW']);
  });

  it('preserves maxLength constraints', () => {
    const schema = z.object({ name: z.string().max(50) });
    const json = zodToGeminiSchema(schema);
    assert.equal(json.properties.name.maxLength, 50);
  });
});

// ── FindingJsonSchema ───────────────────────────────────────────────────────

describe('FindingJsonSchema (derived)', () => {
  it('has all FindingSchema fields', () => {
    const zodKeys = Object.keys(FindingSchema.shape).sort();
    const jsonKeys = Object.keys(FindingJsonSchema.properties).sort();
    assert.deepEqual(jsonKeys, zodKeys);
  });

  it('has all fields as required', () => {
    const zodKeys = Object.keys(FindingSchema.shape).sort();
    assert.deepEqual([...FindingJsonSchema.required].sort(), zodKeys);
  });

  it('has correct severity enum', () => {
    assert.deepEqual(FindingJsonSchema.properties.severity.enum, ['HIGH', 'MEDIUM', 'LOW']);
  });
});

// ── writeLedgerEntry ────────────────────────────────────────────────────────

function makeLedgerEntry(overrides = {}) {
  return {
    topicId: 'abc123def456',
    semanticHash: 'deadbeef',
    adjudicationOutcome: 'accepted',
    remediationState: 'pending',
    severity: 'HIGH',
    originalSeverity: 'HIGH',
    category: 'Missing Error Handling',
    section: 'scripts/shared.mjs',
    detailSnapshot: 'No validation on write path',
    affectedFiles: ['scripts/shared.mjs'],
    affectedPrinciples: ['DRY'],
    ruling: 'sustain',
    rulingRationale: 'Valid finding',
    resolvedRound: 1,
    pass: 'backend',
    ...overrides
  };
}

describe('writeLedgerEntry', () => {
  it('creates a new ledger file with valid entry', () => {
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    writeLedgerEntry(ledgerPath, makeLedgerEntry());
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.equal(ledger.version, 1);
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].topicId, 'abc123def456');
  });

  it('upserts by topicId', () => {
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    writeLedgerEntry(ledgerPath, makeLedgerEntry());
    writeLedgerEntry(ledgerPath, makeLedgerEntry({ remediationState: 'fixed' }));
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].remediationState, 'fixed');
  });

  it('appends entries with different topicIds', () => {
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    writeLedgerEntry(ledgerPath, makeLedgerEntry({ topicId: 'aaa' }));
    writeLedgerEntry(ledgerPath, makeLedgerEntry({ topicId: 'bbb' }));
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.equal(ledger.entries.length, 2);
  });

  it('rejects invalid entries (bad enum value)', () => {
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    writeLedgerEntry(ledgerPath, makeLedgerEntry({ adjudicationOutcome: 'invalid_value' }));
    assert.equal(fs.existsSync(ledgerPath), false);
  });

  it('backs up corrupted ledger files', () => {
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    fs.writeFileSync(ledgerPath, 'not json', 'utf-8');
    writeLedgerEntry(ledgerPath, makeLedgerEntry());
    assert.ok(fs.existsSync(`${ledgerPath}.bak`));
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.equal(ledger.entries.length, 1);
  });
});

// ── generateTopicId ─────────────────────────────────────────────────────────

describe('generateTopicId', () => {
  it('returns a 12-char hex string', () => {
    const finding = {
      _primaryFile: 'scripts/shared.mjs',
      principle: 'DRY',
      category: 'Duplication',
      _pass: 'backend',
      _hash: 'abcd1234'
    };
    const id = generateTopicId(finding);
    assert.match(id, /^[a-f0-9]{12}$/);
  });

  it('different hashes produce different topicIds', () => {
    const base = {
      _primaryFile: 'scripts/shared.mjs',
      principle: 'DRY',
      category: 'Duplication',
      _pass: 'backend'
    };
    const id1 = generateTopicId({ ...base, _hash: 'hash1111' });
    const id2 = generateTopicId({ ...base, _hash: 'hash2222' });
    assert.notEqual(id1, id2);
  });

  it('same inputs produce stable output', () => {
    const finding = {
      _primaryFile: 'a.mjs',
      principle: 'SRP',
      category: 'God Module',
      _pass: 'sustainability',
      _hash: 'deadbeef'
    };
    assert.equal(generateTopicId(finding), generateTopicId(finding));
  });
});

// ── populateFindingMetadata ─────────────────────────────────────────────────

describe('populateFindingMetadata', () => {
  it('extracts file paths from section', () => {
    const finding = { section: 'scripts/shared.mjs::writeLedgerEntry', category: 'test', detail: 'test' };
    populateFindingMetadata(finding, 'backend');
    assert.ok(finding._primaryFile);
    assert.ok(finding.affectedFiles.length > 0);
    assert.equal(finding._pass, 'backend');
  });

  it('assigns _hash if missing', () => {
    const finding = { section: 'file.mjs', category: 'test', detail: 'detail' };
    populateFindingMetadata(finding, 'backend');
    assert.ok(finding._hash);
    assert.match(finding._hash, /^[a-f0-9]{8}$/);
  });

  it('preserves existing _hash', () => {
    const finding = { section: 'file.mjs', category: 'test', detail: 'detail', _hash: 'custom12' };
    populateFindingMetadata(finding, 'backend');
    assert.equal(finding._hash, 'custom12');
  });
});

// ── semanticId ──────────────────────────────────────────────────────────────

describe('semanticId', () => {
  it('returns 8-char hex', () => {
    const id = semanticId({ category: 'A', section: 'B', detail: 'C' });
    assert.match(id, /^[a-f0-9]{8}$/);
  });

  it('is stable for same input', () => {
    const f = { category: 'Bug', section: 'file.js', detail: 'Missing check' };
    assert.equal(semanticId(f), semanticId(f));
  });

  it('differs for different input', () => {
    const a = semanticId({ category: 'Bug', section: 'file.js', detail: 'A' });
    const b = semanticId({ category: 'Bug', section: 'file.js', detail: 'B' });
    assert.notEqual(a, b);
  });
});

// ── jaccardSimilarity ───────────────────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('returns 1 for identical strings', () => {
    assert.equal(jaccardSimilarity('hello world', 'hello world'), 1);
  });

  it('returns 0 for completely different strings', () => {
    assert.equal(jaccardSimilarity('aaa', 'bbb'), 0);
  });

  it('handles empty strings', () => {
    assert.equal(jaccardSimilarity('', ''), 0);
    assert.equal(jaccardSimilarity('hello', ''), 0);
  });

  it('returns partial overlap score', () => {
    const score = jaccardSimilarity('hello world foo', 'hello world bar');
    assert.ok(score > 0.3 && score < 1);
  });
});

// ── FalsePositiveTracker ────────────────────────────────────────────────────

describe('FalsePositiveTracker', () => {
  it('records and tracks patterns', () => {
    const tracker = new FalsePositiveTracker(path.join(tmpDir, 'fp.json'));
    const finding = { category: 'DRY Violation', severity: 'MEDIUM', principle: 'DRY' };
    tracker.record(finding, false);
    tracker.record(finding, false);
    const report = tracker.getReport();
    assert.equal(report.length, 1);
    assert.equal(report[0].total, 2);
  });

  it('suppresses after 5+ dismissals with low EMA', () => {
    const tracker = new FalsePositiveTracker(path.join(tmpDir, 'fp.json'));
    const finding = { category: 'Noise', severity: 'LOW', principle: 'misc' };
    for (let i = 0; i < 6; i++) tracker.record(finding, false);
    assert.ok(tracker.shouldSuppress(finding));
  });

  it('does not suppress patterns with high accept rate', () => {
    const tracker = new FalsePositiveTracker(path.join(tmpDir, 'fp.json'));
    const finding = { category: 'Real Bug', severity: 'HIGH', principle: 'correctness' };
    for (let i = 0; i < 6; i++) tracker.record(finding, true);
    assert.equal(tracker.shouldSuppress(finding), false);
  });

  it('persists state to disk', () => {
    const fpPath = path.join(tmpDir, 'fp.json');
    const t1 = new FalsePositiveTracker(fpPath);
    t1.record({ category: 'A', severity: 'LOW', principle: 'x' }, false);
    // Load fresh from disk
    const t2 = new FalsePositiveTracker(fpPath);
    assert.equal(t2.getReport().length, 1);
  });

  it('records at multiple scopes with repo context', () => {
    const tracker = new FalsePositiveTracker(path.join(tmpDir, 'fp-v2.json'));
    const finding = { category: 'DRY Violation', severity: 'MEDIUM', principle: 'DRY' };
    tracker.record(finding, false, 'repo-123', 'src/app.mjs');
    const report = tracker.getReport();
    // Should have 3 scope entries: repo+fileType, repo, global
    assert.ok(report.length >= 3, `Expected >= 3 scopes, got ${report.length}`);
  });
});

// ── Lazy-Decay Model ──────────────────────────────────────────────────────

describe('applyLazyDecay', () => {
  it('is a pure function (does not mutate input)', () => {
    const pattern = {
      decayedAccepted: 5, decayedDismissed: 3,
      lastDecayTs: Date.now() - 10 * 24 * 60 * 60 * 1000 // 10 days ago
    };
    const original = { ...pattern };
    applyLazyDecay(pattern);
    assert.deepEqual(pattern, original);
  });

  it('applies exponential decay', () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const pattern = {
      decayedAccepted: 10, decayedDismissed: 5,
      lastDecayTs: tenDaysAgo
    };
    const decayed = applyLazyDecay(pattern);
    assert.ok(decayed.decayedAccepted < 10, 'Should decay accepted');
    assert.ok(decayed.decayedDismissed < 5, 'Should decay dismissed');
    assert.ok(decayed.lastDecayTs > tenDaysAgo, 'Should update timestamp');
  });

  it('derives EMA from decayed weights', () => {
    const pattern = {
      decayedAccepted: 8, decayedDismissed: 2,
      lastDecayTs: Date.now()
    };
    const decayed = applyLazyDecay(pattern);
    assert.ok(Math.abs(decayed.ema - 0.8) < 0.01, `EMA should be ~0.8, got ${decayed.ema}`);
  });

  it('defaults EMA to 0.5 when total is zero', () => {
    const pattern = { decayedAccepted: 0, decayedDismissed: 0, lastDecayTs: Date.now() };
    const decayed = applyLazyDecay(pattern);
    assert.equal(decayed.ema, 0.5);
  });
});

describe('recordWithDecay', () => {
  it('adds observation and updates EMA', () => {
    const pattern = {
      decayedAccepted: 0, decayedDismissed: 0,
      lastDecayTs: Date.now(), accepted: 0, dismissed: 0
    };
    recordWithDecay(pattern, true);
    assert.equal(pattern.accepted, 1);
    assert.ok(pattern.decayedAccepted > 0);
    assert.equal(pattern.ema, 1.0); // Only one accepted observation
  });
});

describe('effectiveSampleSize', () => {
  it('sums decayed weights', () => {
    assert.equal(effectiveSampleSize({ decayedAccepted: 3.5, decayedDismissed: 1.5 }), 5);
  });
});

// ── EWR ─────────────────────────────────────────────────────────────────────

describe('computePassEWR', () => {
  it('returns zero for empty outcomes', () => {
    const result = computePassEWR([], 'backend');
    assert.equal(result.ewr, 0);
    assert.equal(result.n, 0);
  });

  it('computes weighted reward', () => {
    const now = Date.now();
    const outcomes = [
      { pass: 'backend', reward: 0.8, timestamp: now - 1000 },
      { pass: 'backend', reward: 0.6, timestamp: now - 2000 },
      { pass: 'frontend', reward: 0.9, timestamp: now }
    ];
    const result = computePassEWR(outcomes, 'backend');
    assert.ok(result.ewr > 0.5);
    assert.equal(result.n, 2);
  });

  it('ignores outcomes without reward', () => {
    const outcomes = [
      { pass: 'backend', timestamp: Date.now() },
      { pass: 'backend', reward: 0.5, timestamp: Date.now() }
    ];
    const result = computePassEWR(outcomes, 'backend');
    assert.equal(result.n, 1);
  });
});

// ── loadOutcomes ────────────────────────────────────────────────────────────

describe('loadOutcomes (v2)', () => {
  it('assigns _importedAt in memory for legacy entries', () => {
    const logPath = path.join(tmpDir, 'outcomes.jsonl');
    fs.writeFileSync(logPath, '{"pass":"backend","accepted":true}\n');
    const outcomes = loadOutcomes(logPath);
    assert.equal(outcomes.length, 1);
    assert.ok(outcomes[0]._importedAt, 'Should have _importedAt');
  });

  it('does not write to disk (pure read)', () => {
    const logPath = path.join(tmpDir, 'outcomes.jsonl');
    fs.writeFileSync(logPath, '{"pass":"backend","accepted":true}\n');
    const mtimeBefore = fs.statSync(logPath).mtimeMs;
    loadOutcomes(logPath);
    const mtimeAfter = fs.statSync(logPath).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter, 'File should not be modified by loadOutcomes');
  });
});

// ── Remediation Tasks ───────────────────────────────────────────────────────

describe('RemediationTask', () => {
  it('creates task with deterministic ID', () => {
    const task = createRemediationTask('run-1', 'backend', {
      id: 'H1', severity: 'HIGH', semanticHash: 'abc12345',
      category: 'test', section: 'file.js', detail: 'test'
    });
    assert.equal(task.taskId, 'run-1-backend-abc12345');
    assert.equal(task.remediationState, 'pending');
    assert.equal(task.edits.length, 0);
  });

  it('trackEdit updates state to fixed', () => {
    const task = createRemediationTask('run-1', 'backend', {
      id: 'H1', severity: 'HIGH', semanticHash: 'abc12345',
      category: 'test', section: 'file.js', detail: 'test'
    });
    trackEdit(task, { file: 'src/app.js', type: 'edit' });
    assert.equal(task.remediationState, 'fixed');
    assert.equal(task.edits.length, 1);
    assert.ok(task.edits[0].timestamp);
  });

  it('verifyTask sets verified or regressed', () => {
    const task = createRemediationTask('run-1', 'backend', {
      id: 'H1', severity: 'HIGH', semanticHash: 'abc12345',
      category: 'test', section: 'file.js', detail: 'test'
    });
    verifyTask(task, 'gemini', true);
    assert.equal(task.remediationState, 'verified');
    assert.equal(task.verifiedBy, 'gemini');
    assert.ok(task.verifiedAt);

    verifyTask(task, 'gpt', false);
    assert.equal(task.remediationState, 'regressed');
  });
});

// ── Language Normalization ───────────────────────────────────────────────────

describe('normalizeLanguage', () => {
  it('normalizes common aliases', () => {
    assert.equal(normalizeLanguage('javascript'), 'js');
    assert.equal(normalizeLanguage('typescript'), 'ts');
    assert.equal(normalizeLanguage('python'), 'py');
    assert.equal(normalizeLanguage('golang'), 'go');
  });

  it('maps unknown languages to other', () => {
    assert.equal(normalizeLanguage('fortran'), 'other');
    assert.equal(normalizeLanguage(null), 'other');
    assert.equal(normalizeLanguage(''), 'other');
  });

  it('is case-insensitive', () => {
    assert.equal(normalizeLanguage('JavaScript'), 'js');
    assert.equal(normalizeLanguage('PYTHON'), 'py');
  });
});

// ── Seedable RNG ────────────────────────────────────────────────────────────

describe('createRNG', () => {
  it('produces deterministic output with seed', () => {
    const rng1 = createRNG(42);
    const rng2 = createRNG(42);
    assert.equal(rng1.random(), rng2.random());
    assert.equal(rng1.random(), rng2.random());
  });

  it('produces different output with different seeds', () => {
    const rng1 = createRNG(42);
    const rng2 = createRNG(99);
    assert.notEqual(rng1.random(), rng2.random());
  });

  it('beta produces values in [0, 1]', () => {
    const rng = createRNG(42);
    for (let i = 0; i < 100; i++) {
      const val = rng.beta(2, 3);
      assert.ok(val >= 0 && val <= 1, `Beta sample out of range: ${val}`);
    }
  });
});

describe('reservoirSample', () => {
  it('returns at most k items', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const sampled = reservoirSample(items, 3, createRNG(42));
    assert.equal(sampled.length, 3);
  });

  it('returns all items when k >= array length', () => {
    const items = [1, 2, 3];
    const sampled = reservoirSample(items, 5);
    assert.equal(sampled.length, 3);
  });

  it('is deterministic with seeded RNG', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const s1 = reservoirSample(items, 5, createRNG(42));
    const s2 = reservoirSample(items, 5, createRNG(42));
    assert.deepEqual(s1, s2);
  });
});

// ── Prompt Registry ─────────────────────────────────────────────────────────

describe('Prompt Registry', () => {
  it('revisionId produces stable content-hash', () => {
    const id1 = revisionId('hello world');
    const id2 = revisionId('hello world');
    assert.equal(id1, id2);
    assert.match(id1, /^rev-[a-f0-9]{12}$/);
  });

  it('different content produces different IDs', () => {
    assert.notEqual(revisionId('prompt A'), revisionId('prompt B'));
  });

  it('bootstrap creates default revisions', () => {
    const origDir = process.cwd();
    process.chdir(tmpDir);
    try {
      bootstrapFromConstants({ test: 'This is a test prompt for bootstrapping' });
      const activeId = getActiveRevisionId('test');
      assert.ok(activeId, 'Should have active revision');
      assert.match(activeId, /^rev-/);
      const prompt = getActivePrompt('test');
      assert.equal(prompt, 'This is a test prompt for bootstrapping');
    } finally {
      process.chdir(origDir);
    }
  });

  it('bootstrap is idempotent', () => {
    const origDir = process.cwd();
    process.chdir(tmpDir);
    try {
      const prompts = { test: 'Same prompt content' };
      bootstrapFromConstants(prompts);
      const id1 = getActiveRevisionId('test');
      bootstrapFromConstants(prompts);
      const id2 = getActiveRevisionId('test');
      assert.equal(id1, id2);
    } finally {
      process.chdir(origDir);
    }
  });
});
