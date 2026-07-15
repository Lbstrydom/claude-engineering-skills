/**
 * @fileoverview Unit tests for the shared OSS-call policy module — the single
 * source of truth for per-operation timeout/retry policy and worst-case-
 * duration math (docs/plans/oss-call-reliability-hardening.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getOssOperationPolicy,
  getStage1TriageBudget,
  calculateWorstCaseAttemptDuration,
  createOssCallPolicyResolver,
  RETRY_BACKOFF_BASE_MS,
} from '../scripts/lib/oss-call-policy.mjs';

describe('getOssOperationPolicy (production singleton, real committed file)', () => {
  it('resolves a known operation', () => {
    const policy = getOssOperationPolicy('stage1_triage');
    assert.equal(policy.timeoutMs, 45000);
    assert.equal(policy.maxRetries, 1);
  });

  it('resolves the other known operation', () => {
    const policy = getOssOperationPolicy('discovery_generation');
    assert.equal(policy.timeoutMs, 120000);
    assert.equal(policy.maxRetries, 1);
  });

  it('omitted operation returns today\'s literal defaults', () => {
    const policy = getOssOperationPolicy(undefined);
    assert.deepEqual(policy, { timeoutMs: 300000, maxRetries: 2 });
  });

  it('unrecognized operation throws immediately (round-1 M2 — never silently falls back)', () => {
    assert.throws(() => getOssOperationPolicy('bogus_operation'), /unrecognized operation "bogus_operation"/);
  });

  it('getStage1TriageBudget returns the committed totalMs', () => {
    assert.equal(getStage1TriageBudget(), 600000);
  });
});

describe('calculateWorstCaseAttemptDuration', () => {
  it('matches the Execution Model formula for stage1_triage (45s timeout, 1 retry)', () => {
    const policy = getOssOperationPolicy('stage1_triage');
    // 45000*2 + 800*1 = 90800
    assert.equal(calculateWorstCaseAttemptDuration(policy), 90800);
  });

  it('matches the Execution Model formula for discovery_generation (120s timeout, 1 retry)', () => {
    const policy = getOssOperationPolicy('discovery_generation');
    // 120000*2 + 800*1 = 240800
    assert.equal(calculateWorstCaseAttemptDuration(policy), 240800);
  });

  it('zero retries has zero backoff sum', () => {
    assert.equal(calculateWorstCaseAttemptDuration({ timeoutMs: 1000, maxRetries: 0 }), 1000);
  });

  it('uses the single exported RETRY_BACKOFF_BASE_MS constant, not a re-typed literal (round-3 M2)', () => {
    const policy = { timeoutMs: 1000, maxRetries: 2 };
    const expected = 1000 * 3 + RETRY_BACKOFF_BASE_MS * (1 + 2);
    assert.equal(calculateWorstCaseAttemptDuration(policy), expected);
  });
});

describe('createOssCallPolicyResolver — injectable, cached-once (round-2 M2)', () => {
  it('a fresh instance with an injected malformed reader fails fast at first use', () => {
    const resolver = createOssCallPolicyResolver({ readFile: () => 'not valid json' });
    assert.throws(() => resolver.getOssOperationPolicy('stage1_triage'), /not valid JSON/);
  });

  it('a fresh instance with a schema-invalid file fails fast naming the invalid field', () => {
    const resolver = createOssCallPolicyResolver({
      readFile: () => JSON.stringify({ version: 1, operations: { stage1_triage: { timeoutMs: -5, maxRetries: 1 } }, stage1TriageBudget: { totalMs: 1000 } }),
    });
    assert.throws(() => resolver.getOssOperationPolicy('stage1_triage'), /failed schema validation/);
  });

  it('does not mutate or depend on the production singleton\'s cache', () => {
    let readCount = 0;
    const resolver = createOssCallPolicyResolver({
      readFile: () => {
        readCount++;
        return JSON.stringify({ version: 1, operations: { x: { timeoutMs: 1000, maxRetries: 0 } }, stage1TriageBudget: { totalMs: 5000 } });
      },
    });
    resolver.getOssOperationPolicy('x');
    resolver.getOssOperationPolicy('x');
    resolver.getStage1TriageBudget();
    assert.equal(readCount, 1, 'file must be read once and cached — no per-call I/O on the Stage-1 hot path');
    // Production singleton is unaffected (still resolves the real committed file).
    assert.equal(getOssOperationPolicy('stage1_triage').timeoutMs, 45000);
  });

  it('an unrecognized operation on a fresh instance still throws (round-1 M2, same on any instance)', () => {
    const resolver = createOssCallPolicyResolver({
      readFile: () => JSON.stringify({ version: 1, operations: {}, stage1TriageBudget: { totalMs: 5000 } }),
    });
    assert.throws(() => resolver.getOssOperationPolicy('anything'), /unrecognized operation/);
  });
});

describe('getOssOperationPolicy — inherited-property bypass fixed (audit-code round-1 M1)', () => {
  it('a prototype-inherited name like "toString" is rejected, not silently resolved', () => {
    assert.throws(() => getOssOperationPolicy('toString'), /unrecognized operation "toString"/);
  });

  it('"constructor" is rejected too', () => {
    assert.throws(() => getOssOperationPolicy('constructor'), /unrecognized operation "constructor"/);
  });

  it('a fresh instance with a sparse operations map also rejects inherited names', () => {
    const resolver = createOssCallPolicyResolver({
      readFile: () => JSON.stringify({ version: 1, operations: { real_op: { timeoutMs: 1000, maxRetries: 0 } }, stage1TriageBudget: { totalMs: 5000 } }),
    });
    assert.throws(() => resolver.getOssOperationPolicy('hasOwnProperty'), /unrecognized operation/);
    assert.doesNotThrow(() => resolver.getOssOperationPolicy('real_op'));
  });
});

describe('getOssOperationPolicy — returned policy is immutable (audit-code round-1 M3)', () => {
  it('the returned object is frozen', () => {
    const policy = getOssOperationPolicy('stage1_triage');
    assert.equal(Object.isFrozen(policy), true);
  });

  it('a caller mutating the returned object cannot corrupt what a later caller sees', () => {
    const first = getOssOperationPolicy('stage1_triage');
    assert.throws(() => { first.timeoutMs = 1; }, /Cannot assign to read only property|not extensible/);
    const second = getOssOperationPolicy('stage1_triage');
    assert.equal(second.timeoutMs, 45000, 'a later call must be unaffected by any attempted mutation of an earlier returned object');
  });

  it('two calls for the same operation return distinct object instances (defensive copies, not the same live reference)', () => {
    const a = getOssOperationPolicy('stage1_triage');
    const b = getOssOperationPolicy('stage1_triage');
    assert.notEqual(a, b, 'must be distinct copies — sharing one mutable reference is exactly the bug being fixed');
    assert.deepEqual(a, b);
  });
});

describe('PolicyFileSchema — cross-field budget/retry-envelope validation (audit-code round-1 M5)', () => {
  it('rejects a policy whose stage1TriageBudget cannot fit even one stage1_triage retry envelope', () => {
    const resolver = createOssCallPolicyResolver({
      readFile: () => JSON.stringify({
        version: 1,
        operations: { stage1_triage: { timeoutMs: 45000, maxRetries: 1 } }, // worst case 90800ms
        stage1TriageBudget: { totalMs: 50000 }, // less than one candidate's worst case
      }),
    });
    assert.throws(() => resolver.getStage1TriageBudget(), /cannot accommodate even one stage1_triage retry envelope/);
  });

  it('accepts a policy whose budget exactly fits one worst-case retry envelope', () => {
    const resolver = createOssCallPolicyResolver({
      readFile: () => JSON.stringify({
        version: 1,
        operations: { stage1_triage: { timeoutMs: 1000, maxRetries: 0 } }, // worst case 1000ms
        stage1TriageBudget: { totalMs: 1000 },
      }),
    });
    assert.doesNotThrow(() => resolver.getStage1TriageBudget());
  });

  it('the real committed oss-call-policy.json passes this cross-field check', () => {
    // If this throws, the committed config itself is misconfigured.
    assert.doesNotThrow(() => getStage1TriageBudget());
  });
});
