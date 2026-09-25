/**
 * Unit tests for scripts/lib/store/finding-identity.mjs — the canonical
 * audit_findings row identity (Root Cause 1 of
 * docs/plans/runs-findings-write-boundary-hardening.md).
 *
 * `selectFindingRow` takes an injectable `manyFn` (mirroring runs-findings.mjs's
 * own columnExists DI pattern) so these stay Tier-1: no live database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coalesceBucket, findingKeyOf, findingKeyString, selectFindingRow } from '../scripts/lib/store/finding-identity.mjs';

describe('coalesceBucket', () => {
  it('coalesces null/undefined to the empty string, matching SQL COALESCE(bucket, \'\')', () => {
    assert.equal(coalesceBucket(null), '');
    assert.equal(coalesceBucket(undefined), '');
  });

  it('passes a real bucket value through unchanged', () => {
    assert.equal(coalesceBucket('shadow-only'), 'shadow-only');
  });
});

describe('findingKeyOf', () => {
  it('omits a field entirely when the value is undefined, even if the property is present', () => {
    const key = findingKeyOf({ fingerprint: 'fp1', bucket: undefined });
    assert.equal(Object.prototype.hasOwnProperty.call(key, 'bucket'), false);
  });

  it('keeps an explicit null bucket as a present, filterable value', () => {
    const key = findingKeyOf({ fingerprint: 'fp1', bucket: null });
    assert.equal(Object.prototype.hasOwnProperty.call(key, 'bucket'), true);
    assert.equal(key.bucket, null);
  });

  it('never coalesces bucket — null stays null, not \'\'', () => {
    const key = findingKeyOf({ fingerprint: 'fp1', bucket: null });
    assert.equal(key.bucket, null);
  });
});

describe('findingKeyString', () => {
  it('produces equal strings for two separately-constructed calls with the same logical key', () => {
    const a = findingKeyString({ fingerprint: 'fp1', bucket: 'primary' });
    const b = findingKeyString({ fingerprint: 'fp1', bucket: 'primary' });
    assert.equal(a, b);
    // The direct regression for the Set-by-reference bug: two objects are
    // never ===, but their findingKeyString output must be.
    assert.notEqual(findingKeyOf({ fingerprint: 'fp1', bucket: 'primary' }), findingKeyOf({ fingerprint: 'fp1', bucket: 'primary' }));
  });

  it('agrees on null vs \'\' bucket the same way SQL COALESCE does', () => {
    const nullBucket = findingKeyString({ fingerprint: 'fp1', bucket: null });
    const emptyBucket = findingKeyString({ fingerprint: 'fp1', bucket: '' });
    assert.equal(nullBucket, emptyBucket);
  });

  it('distinguishes different buckets for the same fingerprint', () => {
    const a = findingKeyString({ fingerprint: 'fp1', bucket: 'primary' });
    const b = findingKeyString({ fingerprint: 'fp1', bucket: 'shadow-only' });
    assert.notEqual(a, b);
  });
});

describe('selectFindingRow', () => {
  it('throws when runId is absent — never a bare fingerprint-only or repo-only query', async () => {
    await assert.rejects(() => selectFindingRow({ fingerprint: 'fp1' }), TypeError);
  });

  it('returns no-match when the query returns zero rows', async () => {
    const manyFn = async () => [];
    const result = await selectFindingRow({ runId: 'run1', fingerprint: 'fp1' }, manyFn);
    assert.deepEqual(result, { ok: false, reason: 'no-match' });
  });

  it('resolves a clean single match, returning the row id', async () => {
    const manyFn = async () => [
      { id: 'find1', run_id: 'run1', finding_fingerprint: 'fp1', pass_name: 'merged', bucket: null, round_raised: 1 },
    ];
    const result = await selectFindingRow({ runId: 'run1', fingerprint: 'fp1' }, manyFn);
    assert.equal(result.ok, true);
    assert.equal(result.id, 'find1');
    assert.equal(result.bucket, null);
  });

  it('refuses to guess when two candidates differ on an UNSUPPLIED field (ambiguous)', async () => {
    // Two rows share (run_id, fingerprint) but differ on pass_name, which the
    // caller did not supply — the original bug this plan fixes.
    const manyFn = async () => [
      { id: 'find1', run_id: 'run1', finding_fingerprint: 'fp1', pass_name: 'merged', bucket: null, round_raised: 1 },
      { id: 'find2', run_id: 'run1', finding_fingerprint: 'fp1', pass_name: 'final-review', bucket: null, round_raised: 1 },
    ];
    const result = await selectFindingRow({ runId: 'run1', fingerprint: 'fp1' }, manyFn);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ambiguous');
    assert.equal(result.candidates.length, 2);
  });

  it('resolves unambiguously when the disambiguating field IS supplied', async () => {
    // Same two candidates as above, but the caller now supplies pass_name —
    // the query itself would only return the one matching row, so a fake
    // manyFn simulating that filter returns a single row here.
    const manyFn = async () => [
      { id: 'find1', run_id: 'run1', finding_fingerprint: 'fp1', pass_name: 'merged', bucket: null, round_raised: 1 },
    ];
    const result = await selectFindingRow({ runId: 'run1', fingerprint: 'fp1', passName: 'merged' }, manyFn);
    assert.equal(result.ok, true);
    assert.equal(result.id, 'find1');
  });

  it('does NOT flag ambiguity when two candidates agree on every unsupplied field (e.g. differ only by created_at)', async () => {
    const manyFn = async () => [
      { id: 'find1', run_id: 'run1', finding_fingerprint: 'fp1', pass_name: 'merged', bucket: null, round_raised: 1 },
      { id: 'find1', run_id: 'run1', finding_fingerprint: 'fp1', pass_name: 'merged', bucket: null, round_raised: 1 },
    ];
    const result = await selectFindingRow({ runId: 'run1', fingerprint: 'fp1' }, manyFn);
    assert.equal(result.ok, true);
    assert.equal(result.id, 'find1');
  });

  it('supports the optional roundRaised disambiguator, preserving recordAdjudicationEvent\'s existing filter', async () => {
    const manyFn = async (sql) => {
      assert.match(sql, /round_raised IS NOT DISTINCT FROM/);
      return [{ id: 'find1', run_id: 'run1', finding_fingerprint: 'fp1', pass_name: 'merged', bucket: null, round_raised: 2 }];
    };
    const result = await selectFindingRow({ runId: 'run1', fingerprint: 'fp1', roundRaised: 2 }, manyFn);
    assert.equal(result.ok, true);
  });
});
