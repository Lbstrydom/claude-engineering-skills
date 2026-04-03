import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeOutcomes, sanitizePath, redactSecrets, recencyBucket
} from '../scripts/lib/sanitizer.mjs';

// ── sanitizePath ────────────────────────────────────────────────────────────

describe('sanitizePath', () => {
  it('returns directory/basename for deep paths', () => {
    assert.equal(sanitizePath('/home/user/project/src/app.js'), 'src/app.js');
  });

  it('handles Windows-style paths', () => {
    assert.equal(sanitizePath('C:\\Users\\me\\code\\file.ts'), 'code/file.ts');
  });

  it('returns basename for single-segment paths', () => {
    assert.equal(sanitizePath('file.mjs'), 'file.mjs');
  });

  it('returns unknown for empty string', () => {
    assert.equal(sanitizePath(''), 'unknown');
  });
});

// ── redactSecrets ───────────────────────────────────────────────────────────

describe('redactSecrets', () => {
  it('redacts API key patterns', () => {
    const result = redactSecrets('Use api_key=sk-1234567890abcdef to auth');
    assert.ok(result.includes('[REDACTED]'), `Should redact: ${result}`);
    assert.ok(!result.includes('sk-1234567890abcdef'));
  });

  it('redacts long tokens', () => {
    const result = redactSecrets('Token: abcdefghijklmnopqrstuvwxyz');
    assert.ok(result.includes('[REDACTED]'), `Should contain [REDACTED], got: ${result}`);
    assert.ok(!result.includes('abcdefghijklmnopqrstuvwxyz'), 'Should not contain the token');
  });

  it('redacts PEM keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
    const result = redactSecrets(pem);
    assert.ok(result.includes('[REDACTED_KEY]'));
  });

  it('preserves short normal text', () => {
    const text = 'Check the error handling in routes.js';
    assert.equal(redactSecrets(text), text);
  });
});

// ── recencyBucket ───────────────────────────────────────────────────────────

describe('recencyBucket', () => {
  it('classifies recent items (< 7 days)', () => {
    assert.equal(recencyBucket(Date.now() - 1000), 'recent');
  });

  it('classifies mid-age items (7-30 days)', () => {
    assert.equal(recencyBucket(Date.now() - 15 * 24 * 60 * 60 * 1000), 'mid');
  });

  it('classifies old items (> 30 days)', () => {
    assert.equal(recencyBucket(Date.now() - 60 * 24 * 60 * 60 * 1000), 'old');
  });

  it('returns old for null/undefined', () => {
    assert.equal(recencyBucket(null), 'old');
    assert.equal(recencyBucket(undefined), 'old');
  });
});

// ── sanitizeOutcomes ────────────────────────────────────────────────────────

describe('sanitizeOutcomes', () => {
  it('filters outcomes without primaryFile', () => {
    const outcomes = [
      { category: 'test', accepted: true, detail: 'detail', pass: 'backend' },
      { category: 'test', accepted: true, detail: 'detail', pass: 'backend', primaryFile: 'src/app.js' }
    ];
    const result = sanitizeOutcomes(outcomes);
    assert.equal(result.length, 1);
    assert.equal(result[0].primaryFile, 'src/app.js');
  });

  it('filters sensitive files', () => {
    const outcomes = [
      { category: 'test', accepted: true, detail: 'detail', primaryFile: '.env', pass: 'backend' },
      { category: 'test', accepted: true, detail: 'detail', primaryFile: 'src/app.js', pass: 'backend' }
    ];
    const result = sanitizeOutcomes(outcomes);
    assert.equal(result.length, 1);
  });

  it('sanitizes paths to two-level', () => {
    const outcomes = [{
      category: 'test', accepted: true, detail: 'test detail',
      primaryFile: '/home/user/project/src/routes/api.js', pass: 'backend'
    }];
    const result = sanitizeOutcomes(outcomes);
    assert.equal(result[0].primaryFile, 'routes/api.js');
  });

  it('truncates detail to 300 chars', () => {
    const outcomes = [{
      category: 'test', accepted: true,
      detail: 'x'.repeat(500),
      primaryFile: 'src/app.js', pass: 'backend'
    }];
    const result = sanitizeOutcomes(outcomes);
    assert.ok(result[0].detail.length <= 300);
  });

  it('adds recency bucket', () => {
    const outcomes = [{
      category: 'test', accepted: true, detail: 'test',
      primaryFile: 'src/app.js', pass: 'backend',
      timestamp: Date.now() - 1000
    }];
    const result = sanitizeOutcomes(outcomes);
    assert.equal(result[0]._recencyBucket, 'recent');
  });
});
