import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { _internals } from '../scripts/memory-health.mjs';

const tmpDirs = [];
function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-health-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

describe('memory-health.mjs — atomicWrite (atomic-write-adoption plan)', () => {
  it('writes content atomically and creates parent directories', () => {
    const tmpDir = mkTmp();
    const target = path.join(tmpDir, 'nested', 'report.md');

    _internals.atomicWrite(target, '# Memory Health\n\nGREEN\n');

    assert.equal(fs.readFileSync(target, 'utf-8'), '# Memory Health\n\nGREEN\n');
  });

  it('overwrites existing content', () => {
    const tmpDir = mkTmp();
    const target = path.join(tmpDir, 'report.md');
    _internals.atomicWrite(target, 'first');
    _internals.atomicWrite(target, 'second');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'second');
  });
});

// ── evaluateClusterDensity: semantic primary + coverage honesty + fallback ──
describe('evaluateClusterDensity (semantic migration)', () => {
  const { evaluateClusterDensity, THRESHOLDS } = _internals;
  const trigram = { median_similar_pairs: 30, per_repo: [] };

  it('uses the SEMANTIC median as the trigger when the RPC is present', () => {
    const m = { cluster_density: trigram, semantic_cluster: {
      median_similar_pairs: 8, coverage: { pct: 90 } } };
    const t = evaluateClusterDensity(m, false);
    assert.equal(t.actual, 8, 'semantic median, not the trigram 30');
    assert.equal(t.fired, 8 >= THRESHOLDS.clusterMedianPairs);
    assert.match(t.similarity, /semantic/);
  });

  it('falls back to trigram (byte-identical to pre-migration) when the RPC is absent', () => {
    const m = { cluster_density: trigram, semantic_cluster: null };
    const t = evaluateClusterDensity(m, false);
    assert.equal(t.actual, 30);
    assert.match(t.similarity, /trigram/);
    assert.equal(t.fired, true);
  });

  it('COVERAGE HONESTY: below the floor → unknown, NOT a false green', () => {
    const m = { cluster_density: trigram, semantic_cluster: {
      median_similar_pairs: 1, coverage: { pct: 20 } } }; // low median but low coverage
    const t = evaluateClusterDensity(m, false);
    assert.equal(t.unknown, true);
    assert.equal(t.fired, false, 'low coverage never FIRES, but...');
    assert.match(t.reading, /UNKNOWN/, '...it must NOT read as a clean green either');
  });

  it('good coverage + low median = a real green', () => {
    const m = { cluster_density: trigram, semantic_cluster: {
      median_similar_pairs: 2, coverage: { pct: 95 } } };
    const t = evaluateClusterDensity(m, false);
    assert.ok(!t.unknown, 'good coverage is not unknown');
    assert.equal(t.fired, false);
  });

  it('insufficient data never fires regardless of median', () => {
    const m = { cluster_density: trigram, semantic_cluster: {
      median_similar_pairs: 50, coverage: { pct: 99 } } };
    assert.equal(evaluateClusterDensity(m, true).fired, false);
  });
});
