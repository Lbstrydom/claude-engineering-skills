/**
 * @fileoverview Tier 1 unit tests for scripts/lib/audit/map-reduce-scheduler.mjs
 * — relocated from legacy-production-audit.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 2).
 *
 * `decideSeed`'s eligibility-before-env-flag policy already has dedicated
 * coverage in tests/cache-seed-eligibility.test.mjs (relocated import, same
 * assertions) — not duplicated here. This file gives `shouldMapReduce` /
 * `shouldMapReduceHighReasoning` their first direct unit coverage: neither
 * was in `__testExports` nor exercised by any existing test file before this
 * plan (confirmed by grep, per Phase 2's own "confirm before assuming a
 * fresh test is needed" instruction) — the map-reduce path was previously
 * reached only indirectly, end-to-end, via tests/reduce-status-run-level.test.mjs.
 *
 * Thresholds are PINNED via env vars set before the first import (config.mjs
 * is a module-load snapshot — see reduce-status-run-level.test.mjs's own
 * comment on why this has to happen before import), not read from ambient
 * config. Fixed after Cluster A's own /audit-code round (M11/M12): the first
 * draft asserted against the config.mjs *defaults* without pinning them, so a
 * differently-configured shell/CI environment could silently test the wrong
 * boundary.
 *
 * The count threshold is deterministic and IO-free (short-circuits before
 * any file read), so it is what this file pins directly. The token
 * threshold is exercised end-to-end by reduce-status-run-level.test.mjs.
 * `nonexistent-file-N.mjs` paths are used deliberately — not incidentally —
 * to force the token-side measurement to 0 (measureContextChars in
 * code-analysis.mjs skips any path failing fs.existsSync), which keeps every
 * assertion here scoped strictly to the count-only boundary this file claims
 * to pin, with no dependency on real file content.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_AUDIT_MAP_REDUCE_THRESHOLD = '15';
process.env.OPENAI_AUDIT_HIGH_REASONING_MAP_REDUCE_THRESHOLD = '8';

const { shouldMapReduce, shouldMapReduceHighReasoning } = await import('../scripts/lib/audit/map-reduce-scheduler.mjs');

// Deliberately nonexistent — see file docblock. Pinned count threshold: 15 / 8.
const filesOfCount = (n) => Array.from({ length: n }, (_, i) => `nonexistent-file-${i}.mjs`);

describe('shouldMapReduce — file-count threshold (pinned to 15)', () => {
  it('false at exactly the pinned threshold (15 files)', () => {
    assert.equal(shouldMapReduce(filesOfCount(15)), false);
  });

  it('true just over the pinned threshold (16 files)', () => {
    assert.equal(shouldMapReduce(filesOfCount(16)), true);
  });

  it('false for a small file set', () => {
    assert.equal(shouldMapReduce(filesOfCount(1)), false);
  });
});

describe('shouldMapReduceHighReasoning — lower file-count threshold for reasoning:high passes (pinned to 8)', () => {
  it('false at exactly the pinned threshold (8 files)', () => {
    assert.equal(shouldMapReduceHighReasoning(filesOfCount(8)), false);
  });

  it('true just over the pinned threshold (9 files)', () => {
    assert.equal(shouldMapReduceHighReasoning(filesOfCount(9)), true);
  });

  it('is stricter than shouldMapReduce at the same file count (12 files: high-reasoning yes, plain no)', () => {
    const files = filesOfCount(12);
    assert.equal(shouldMapReduceHighReasoning(files), true);
    assert.equal(shouldMapReduce(files), false);
  });
});
