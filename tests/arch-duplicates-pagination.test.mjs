/**
 * @fileoverview `arch:duplicates --json` must let a caller assert EXHAUSTIVITY.
 *
 * The envelope was `{repoName, refreshId, clusters}` and the default `--limit`
 * is 20, so a consumer with 44 clusters got less than half of them with no
 * indication (2026-09-04). A policy gate over "all clusters" could only infer
 * truncation from `clusters.length === limit` — correct, but unable to tell a
 * complete result from an exactly-full page.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { paginate } from '../scripts/symbol-index/duplicates.mjs';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));

describe('paginate — truncation is detected, never inferred', () => {
  it('reports a complete result with a real total', () => {
    const r = paginate(rows(5), 20);
    assert.equal(r.truncated, false);
    assert.equal(r.total, 5);
    assert.equal(r.clusters.length, 5);
  });

  it('detects truncation via the over-fetched row and drops it', () => {
    // The RPC is asked for limit + 1; the extra row IS the signal.
    const r = paginate(rows(21), 20);
    assert.equal(r.truncated, true);
    assert.equal(r.clusters.length, 20, 'the caller gets exactly the page it asked for');
  });

  it('reports total NULL when truncated — never the page size', () => {
    // Reporting 20 as the total would be the fabrication this exists to stop.
    assert.equal(paginate(rows(21), 20).total, null);
  });

  it('an EXACTLY-full page is complete, not truncated', () => {
    // The case `clusters.length === limit` could not distinguish. This is the
    // direction that must NOT fire.
    const r = paginate(rows(20), 20);
    assert.equal(r.truncated, false);
    assert.equal(r.total, 20);
  });

  it('handles an empty result', () => {
    const r = paginate([], 20);
    assert.deepEqual(r, { clusters: [], truncated: false, total: 0 });
  });
});
