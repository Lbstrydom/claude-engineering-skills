/**
 * @fileoverview Guards `.sync-receipt.json`, the sync's in-repo trace.
 *
 * The receipt is a deliberate exception to the generated-artifact policy: it
 * carries a timestamp and a commit sha and is COMMITTED anyway, because its
 * dirtiness IS the information (a gitignored manifest is why the 2026-08-29
 * reversion left no evidence). That exception is only honest if it does not
 * churn on no-op syncs — which is what `receiptShouldWrite` is for, and what
 * most of this file asserts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildReceipt, receiptShouldWrite, RECEIPT_VERSION } from '../scripts/lib/sync-receipt.mjs';

const SOURCE = {
  repo: 'Lbstrydom/claude-engineering-skills',
  branch: 'main',
  commitSha: '667b2488811b347992a7c7f703258ab0f99732ae',
  sourceDirty: false,
};

const base = (over = {}) => buildReceipt({
  syncedAt: '2026-08-29T14:11:25.527Z', source: SOURCE, ...over,
});

describe('buildReceipt', () => {
  test('carries the source stamp a reviewer needs to place the sync', () => {
    const r = base();
    assert.equal(r.version, RECEIPT_VERSION);
    assert.equal(r.source.commitSha, SOURCE.commitSha);
    assert.equal(r.syncedAt, '2026-08-29T14:11:25.527Z');
  });

  test('a non-boolean sourceDirty becomes null — "unknown" never reads as clean', () => {
    // Same contract buildConsumerManifest holds: absence must not be mistaken
    // for a clean source tree when triaging what a consumer received.
    for (const v of [undefined, null, 'false', 0]) {
      assert.equal(base({ source: { ...SOURCE, sourceDirty: v } }).source.sourceDirty, null);
    }
    assert.equal(base({ source: { ...SOURCE, sourceDirty: true } }).source.sourceDirty, true);
  });

  test('lists are sorted, so two syncs over the same set are byte-identical', () => {
    const a = base({ created: ['b', 'a'], updated: ['z', 'y'] });
    const b = base({ created: ['a', 'b'], updated: ['y', 'z'] });
    assert.deepEqual(a.created, b.created);
    assert.deepEqual(a.updated, b.updated);
  });

  test('counts match the lists they summarise', () => {
    const r = base({
      created: ['a'], updated: ['b', 'c'], gcDeleted: ['d'],
      overridesHeld: [{ path: 'e', reason: 'r', upstreamMoved: false }],
      divergedOverwritten: [{ path: 'f', reason: 'diverged-overwrite-flag' }],
      divergenceRefused: [{ path: 'g', reason: 'diverged-committed' }],
      unchanged: 700,
    });
    assert.deepEqual(r.counts, {
      created: 1, updated: 2, unchanged: 700, gcDeleted: 1,
      overridesHeld: 1, divergedOverwritten: 1, divergenceRefused: 1,
    });
  });

  test('refusals are recorded — a partial sync must be visible from the repo alone', () => {
    const r = base({ divergenceRefused: [{ path: '.vscode/mcp.json', reason: 'diverged-committed' }] });
    assert.equal(r.divergenceRefused[0].path, '.vscode/mcp.json');
  });

  test('does not mutate its inputs', () => {
    const created = ['b', 'a'];
    base({ created });
    assert.deepEqual(created, ['b', 'a']);
  });
});

describe('receiptShouldWrite', () => {
  test('a no-op sync against an identical prior receipt does NOT rewrite', () => {
    // The whole justification for committing a timestamped artifact: it must
    // not churn when nothing happened.
    const prev = base();
    const next = buildReceipt({ syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE });
    assert.equal(receiptShouldWrite(prev, next), false);
  });

  test('a run that propagated anything rewrites, even over an identical set', () => {
    // Syncing the same file twice is two events. A stale timestamp would make
    // the second invisible.
    const prev = base({ updated: ['a'] });
    const next = buildReceipt({ syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE, updated: ['a'] });
    assert.equal(receiptShouldWrite(prev, next), true);
  });

  test('the first receipt is always written', () => {
    assert.equal(receiptShouldWrite(null, base()), true);
  });

  test('a no-op run after a busy one still writes — the lists must be reset', () => {
    const prev = base({ updated: ['a'] });
    const next = buildReceipt({ syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE });
    assert.equal(receiptShouldWrite(prev, next), true);
  });

  test('an override whose upstream content moved rewrites, even on a no-op run', () => {
    // This is the notification mechanism for a stale override: the diff IS the
    // report. If it did not write, the consumer would never learn.
    const prev = base({ overridesHeld: [{ path: 'x', reason: 'r', upstreamSha: 'aaa', upstreamMoved: false }] });
    const next = buildReceipt({
      syncedAt: '2026-09-01T00:00:00.000Z',
      source: SOURCE,
      overridesHeld: [{ path: 'x', reason: 'r', upstreamSha: 'bbb', upstreamMoved: true }],
    });
    assert.equal(receiptShouldWrite(prev, next), true);
  });

  test('an unchanged held override on a no-op run does NOT rewrite', () => {
    const held = [{ path: 'x', reason: 'r', upstreamSha: 'aaa', upstreamMoved: false }];
    const prev = base({ overridesHeld: held });
    const next = buildReceipt({ syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE, overridesHeld: held });
    assert.equal(receiptShouldWrite(prev, next), false);
  });

  test('a refusal appearing rewrites', () => {
    const prev = base();
    const next = buildReceipt({
      syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE,
      divergenceRefused: [{ path: 'x', reason: 'diverged-committed' }],
    });
    assert.equal(receiptShouldWrite(prev, next), true);
  });
});
