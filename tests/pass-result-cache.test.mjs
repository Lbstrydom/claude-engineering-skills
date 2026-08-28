/**
 * @fileoverview Tier 1 unit tests for scripts/lib/audit/pass-result-cache.mjs
 * — relocated from legacy-production-audit.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 1).
 *
 * Atomic-write and crash-mid-rename coverage for `cachePassResult` already
 * lives in tests/legacy-production-audit-hardening.test.mjs (Phase 1 describe
 * block) and continues to exercise the relocated module via its updated
 * import — not duplicated here. This file covers the two functions with no
 * prior direct coverage anywhere: `cacheWaveResults` and
 * `collectReducePassStatuses`'s omit-vs-empty contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  initResultCache, cachePassResult, cacheWaveResults, cleanupCache, collectReducePassStatuses,
} = await import('../scripts/lib/audit/pass-result-cache.mjs');

describe('cacheWaveResults', () => {
  it('caches only the truthy results, skipping null/undefined slots by index', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-wave-'));
    try {
      initResultCache(path.join(tmpDir, 'result.json'));
      cacheWaveResults(['structure', 'wiring'], [{ ok: true }, null]);
      const cacheDirEntries = fs.readdirSync(tmpDir).filter(f => f.startsWith('.audit-cache-'));
      assert.equal(cacheDirEntries.length, 1);
      const cacheDir = path.join(tmpDir, cacheDirEntries[0]);
      assert.ok(fs.existsSync(path.join(cacheDir, 'structure.json')), 'structure result must be cached');
      assert.equal(fs.existsSync(path.join(cacheDir, 'wiring.json')), false, 'a null result must not be cached');
    } finally {
      cleanupCache();
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('does not throw when the cache is disabled (no _cacheDir), and reports the outcome honestly', () => {
    // Force cache-disabled by pointing at a base that cannot be created as a dir.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-disabled-'));
    try {
      const blockerFile = path.join(tmpDir, 'blocker');
      fs.writeFileSync(blockerFile, 'x');
      // Using a file as the "outFile" base makes mkdirSync target a path
      // component that is a file, which fails.
      initResultCache(path.join(blockerFile, 'nested', 'result.json'));
      assert.doesNotThrow(() => cacheWaveResults(['structure'], [{ ok: true }]));
      // The write-honesty contract itself (audit L1/H7): a disabled cache
      // must not silently report success.
      assert.equal(cachePassResult('structure', { ok: true }), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('cachePassResult returns true on a real successful write, false on failure', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-outcome-'));
    try {
      initResultCache(path.join(tmpDir, 'result.json'));
      assert.equal(cachePassResult('ok-pass', { ok: true }), true);

      t.mock.method(fs, 'renameSync', () => { throw new Error('simulated crash mid-rename'); });
      assert.equal(cachePassResult('failing-pass', { ok: true }), false);
    } finally {
      cleanupCache();
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('collectReducePassStatuses — omit-vs-empty convention', () => {
  it('returns undefined (not {}) when no pass degraded', () => {
    const registry = [
      { name: 'structure', _result: { result: {} } },
      { name: 'wiring', _result: null },
    ];
    assert.equal(collectReducePassStatuses(registry), undefined);
  });

  it('returns a map keyed by pass name for degraded passes only', () => {
    const registry = [
      { name: 'structure', _result: { result: { _executionMeta: { reduceStatus: 'skipped' } } } },
      { name: 'wiring', _result: { result: {} } },
    ];
    const statuses = collectReducePassStatuses(registry);
    assert.deepEqual(statuses, { structure: 'skipped' });
  });

  it('handles an empty/undefined passRegistry without throwing', () => {
    assert.equal(collectReducePassStatuses(undefined), undefined);
    assert.equal(collectReducePassStatuses([]), undefined);
  });
});
