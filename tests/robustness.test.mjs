import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  LlmError, classifyLlmError, buildReducePayload,
  normalizeFindingsForOutput, resolveLedgerPath
} from '../scripts/lib/robustness.mjs';

// ── LlmError ──────────────────────────────────────────────────────────────────

describe('LlmError', () => {
  it('carries category and usage', () => {
    const usage = { input_tokens: 100, output_tokens: 50, reasoning_tokens: 30 };
    const err = new LlmError('test', { category: 'truncated', usage, retryable: true });
    assert.equal(err.name, 'LlmError');
    assert.equal(err.llmCategory, 'truncated');
    assert.deepEqual(err.llmUsage, usage);
    assert.equal(err.llmRetryable, true);
    assert.equal(err.message, 'test');
  });

  it('defaults to non-retryable with no usage', () => {
    const err = new LlmError('test', { category: 'schema' });
    assert.equal(err.llmRetryable, false);
    assert.equal(err.llmUsage, null);
  });
});

// ── classifyLlmError ──────────────────────────────────────────────────────────

describe('classifyLlmError', () => {
  it('classifies LlmError by structured fields', () => {
    const err = new LlmError('truncated', { category: 'truncated', retryable: true });
    const { retryable, category } = classifyLlmError(err);
    assert.equal(retryable, true);
    assert.equal(category, 'truncated');
  });

  it('classifies HTTP 429 as retryable', () => {
    const err = new Error('rate limit');
    err.status = 429;
    assert.deepEqual(classifyLlmError(err), { retryable: true, category: 'http-429' });
  });

  it('classifies HTTP 500 as retryable', () => {
    const err = new Error('server error');
    err.status = 500;
    assert.deepEqual(classifyLlmError(err), { retryable: true, category: 'http-500' });
  });

  it('classifies HTTP 400 as permanent', () => {
    const err = new Error('bad request');
    err.status = 400;
    assert.deepEqual(classifyLlmError(err), { retryable: false, category: 'http-400' });
  });

  it('classifies AbortError as timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    assert.deepEqual(classifyLlmError(err), { retryable: true, category: 'timeout' });
  });

  it('classifies ECONNRESET as network', () => {
    const err = new Error('reset');
    err.cause = { code: 'ECONNRESET' };
    assert.deepEqual(classifyLlmError(err), { retryable: true, category: 'network' });
  });

  it('classifies ENOTFOUND as network', () => {
    const err = new Error('dns');
    err.cause = { code: 'ENOTFOUND' };
    assert.deepEqual(classifyLlmError(err), { retryable: true, category: 'network' });
  });

  it('classifies unknown error as permanent', () => {
    assert.deepEqual(classifyLlmError(new Error('unknown')), { retryable: false, category: 'permanent' });
  });
});

// ── buildReducePayload ────────────────────────────────────────────────────────

describe('buildReducePayload', () => {
  const makeFinding = (id, severity, detail = 'test detail') => ({
    id, severity, category: 'test', section: 'test.js', detail, is_quick_fix: false, _mapUnit: 0
  });

  it('produces valid JSON for any input', () => {
    const findings = [makeFinding('H1', 'HIGH'), makeFinding('M1', 'MEDIUM'), makeFinding('L1', 'LOW')];
    const { json, degraded } = buildReducePayload(findings);
    assert.equal(degraded, false);
    assert.doesNotThrow(() => JSON.parse(json));
  });

  it('enforces severity sort regardless of input order', () => {
    const findings = [makeFinding('L1', 'LOW'), makeFinding('H1', 'HIGH'), makeFinding('M1', 'MEDIUM')];
    const parsed = JSON.parse(buildReducePayload(findings).json);
    assert.equal(parsed[0].severity, 'HIGH');
    assert.equal(parsed[1].severity, 'MEDIUM');
    assert.equal(parsed[2].severity, 'LOW');
  });

  it('drops LOW findings first when over budget', () => {
    const findings = [
      makeFinding('H1', 'HIGH', 'x'.repeat(200)),
      makeFinding('L1', 'LOW', 'y'.repeat(200)),
      makeFinding('L2', 'LOW', 'z'.repeat(200))
    ];
    const { json, includedCount } = buildReducePayload(findings, 500);
    assert.ok(json.length <= 500);
    const parsed = JSON.parse(json);
    assert.equal(parsed[0].severity, 'HIGH');
    assert.ok(includedCount < 3);
  });

  it('handles empty input', () => {
    const { json, includedCount, degraded } = buildReducePayload([]);
    assert.equal(json, '[]');
    assert.equal(includedCount, 0);
    assert.equal(degraded, false);
  });

  it('returns degraded when budget is impossible', () => {
    const findings = [makeFinding('H1', 'HIGH', 'x'.repeat(500))];
    const { degraded, includedCount } = buildReducePayload(findings, 10);
    assert.equal(degraded, true);
    assert.equal(includedCount, 0);
  });

  it('shrinks single oversized finding to fit budget', () => {
    const findings = [makeFinding('H1', 'HIGH', 'x'.repeat(200))];
    const { json, degraded, includedCount } = buildReducePayload(findings, 300);
    assert.equal(degraded, false);
    assert.equal(includedCount, 1);
    assert.ok(json.length <= 300);
    assert.doesNotThrow(() => JSON.parse(json));
  });

  it('caps detail length at MAX_DETAIL_CHARS', () => {
    const findings = [makeFinding('H1', 'HIGH', 'x'.repeat(1000))];
    const { json } = buildReducePayload(findings);
    const parsed = JSON.parse(json);
    assert.ok(parsed[0].detail.length <= 200);
  });
});

// ── normalizeFindingsForOutput ────────────────────────────────────────────────

describe('normalizeFindingsForOutput', () => {
  it('deduplicates by _hash', () => {
    const findings = [
      { id: 'H1', severity: 'HIGH', _hash: 'abc123' },
      { id: 'H2', severity: 'HIGH', _hash: 'abc123' }
    ];
    assert.equal(normalizeFindingsForOutput(findings).length, 1);
  });

  it('sorts by severity', () => {
    const findings = [
      { id: 'L1', severity: 'LOW', _hash: 'a' },
      { id: 'H1', severity: 'HIGH', _hash: 'b' }
    ];
    const result = normalizeFindingsForOutput(findings);
    assert.equal(result[0].severity, 'HIGH');
    assert.equal(result[1].severity, 'LOW');
  });

  it('preserves _hash on output', () => {
    const findings = [{ id: 'H1', severity: 'HIGH', _hash: 'xyz' }];
    assert.equal(normalizeFindingsForOutput(findings)[0]._hash, 'xyz');
  });

  it('uses semanticIdFn when no _hash present', () => {
    const findings = [
      { id: 'H1', severity: 'HIGH', detail: 'same' },
      { id: 'H2', severity: 'HIGH', detail: 'same' }
    ];
    const hashFn = (f) => f.detail; // dedup by detail
    const result = normalizeFindingsForOutput(findings, hashFn);
    assert.equal(result.length, 1);
  });
});

// ── resolveLedgerPath ─────────────────────────────────────────────────────────

describe('resolveLedgerPath', () => {
  it('returns null when noLedger is true', () => {
    assert.equal(resolveLedgerPath({ explicitLedger: '/tmp/l.json', outFile: '/tmp/o.json', round: 1, noLedger: true }), null);
  });

  it('returns explicit ledger path when provided', () => {
    const result = resolveLedgerPath({ explicitLedger: '/tmp/my-ledger.json', round: 1, noLedger: false });
    assert.equal(result, path.resolve('/tmp/my-ledger.json'));
  });

  it('derives ledger path from --out on round 1', () => {
    const result = resolveLedgerPath({ explicitLedger: null, outFile: '/tmp/sid-r1-result.json', round: 1, noLedger: false });
    assert.ok(result.endsWith('sid-r1-ledger.json'), `Expected ledger suffix, got: ${result}`);
  });

  it('defaults to .audit/session-ledger.json when no --out and no --ledger on round 1', () => {
    const result = resolveLedgerPath({ explicitLedger: null, outFile: null, round: 1, noLedger: false });
    assert.ok(result.endsWith('session-ledger.json'), `Expected .audit/session-ledger.json, got: ${result}`);
  });

  it('returns null on round 2+ without explicit ledger (caller should fail-fast)', () => {
    assert.equal(resolveLedgerPath({ explicitLedger: null, outFile: '/tmp/o.json', round: 2, noLedger: false }), null);
  });

  it('does not produce double -ledger suffix', () => {
    const result = resolveLedgerPath({ explicitLedger: null, outFile: '/tmp/foo.json', round: 1, noLedger: false });
    assert.ok(!result.includes('ledger-ledger'), `Double suffix detected: ${result}`);
  });

  it('handles non-result json names', () => {
    const result = resolveLedgerPath({ explicitLedger: null, outFile: '/tmp/audit-out.json', round: 1, noLedger: false });
    assert.ok(result.endsWith('audit-out-ledger.json'), `Expected: audit-out-ledger.json, got: ${result}`);
  });
});
