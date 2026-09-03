/**
 * @fileoverview Guards `.sync-receipt.json`, the sync's in-repo trace.
 *
 * The receipt is a deliberate exception to the generated-artifact policy: it
 * carries a timestamp and a commit sha and is COMMITTED anyway, because its
 * dirtiness IS the information (a gitignored manifest is why the 2026-08-29
 * reversion left no evidence). That exception is only honest if it does not
 * churn on no-op syncs — which is what `receiptShouldWrite` is for.
 *
 * v2 adds the second half: the record is APPEND-ONLY. The sync writes to the
 * working tree and does not commit, so a second sync before a human commits
 * used to erase the first's lists (upstream report `1fb43574`). The suites
 * below therefore assert both directions — that a new entry is additive, and
 * that migrating a v1 file does not spend the record it is migrating.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReceiptEntry, receiptShouldWrite, readSyncReceipt, latestReceiptEntry,
  appendReceiptEntry, RECEIPT_VERSION, RECEIPT_HISTORY_LIMIT,
} from '../scripts/lib/sync-receipt.mjs';

const SOURCE = {
  repo: 'Lbstrydom/claude-engineering-skills',
  branch: 'main',
  commitSha: '667b2488811b347992a7c7f703258ab0f99732ae',
  sourceDirty: false,
};

const base = (over = {}) => buildReceiptEntry({
  syncedAt: '2026-08-29T14:11:25.527Z', source: SOURCE, ...over,
});

/** A v1 file exactly as shipped before 2026-09-03 — the migration input. */
const v1File = (over = {}) => ({
  version: 1,
  _note: 'Written by the claude-engineering-skills sync. Committed on purpose: …',
  ...base(over),
});

describe('buildReceiptEntry', () => {
  test('carries the source stamp a reviewer needs to place the sync', () => {
    const r = base();
    assert.equal(r.source.commitSha, SOURCE.commitSha);
    assert.equal(r.syncedAt, '2026-08-29T14:11:25.527Z');
  });

  test('an entry carries no version — the FILE is versioned, not the entry', () => {
    // Two spellings of the version would drift, and a reader that trusted the
    // entry's copy would judge a v2 file by a v1 claim inside it.
    assert.equal('version' in base(), false);
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

describe('readSyncReceipt', () => {
  test('absent reads as absent, not as an empty history', () => {
    for (const raw of [null, undefined]) {
      const r = readSyncReceipt(raw);
      assert.equal(r.status, 'absent');
      assert.equal(latestReceiptEntry(r), null);
    }
  });

  test('a v1 single object normalises to ONE entry, version/_note stripped', () => {
    const r = readSyncReceipt(v1File({ created: ['a'] }));
    assert.equal(r.status, 'ok');
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].syncedAt, '2026-08-29T14:11:25.527Z');
    assert.deepEqual(r.entries[0].created, ['a']);
    // The file's envelope must not survive INTO an entry, or a v2 file would
    // carry a nested `version: 1` claiming to describe the shape around it.
    assert.equal('version' in r.entries[0], false);
    assert.equal('_note' in r.entries[0], false);
  });

  test('a v2 file returns its list newest-first, with the dropped count', () => {
    const file = appendReceiptEntry({ entries: [base({ created: ['old'] })], dropped: 3 },
      base({ syncedAt: '2026-09-03T00:00:00.000Z', updated: ['new'] }));
    const r = readSyncReceipt(file);
    assert.equal(r.status, 'ok');
    assert.equal(r.entries.length, 2);
    assert.equal(latestReceiptEntry(r).syncedAt, '2026-09-03T00:00:00.000Z');
    assert.equal(r.dropped, 3);
  });

  test('a FUTURE version is `unsupported`, never merged or read as empty', () => {
    // The caller declines to write on this. Reading it as empty would let an
    // older bundle replace a newer one's history — the loss this shape ends.
    const r = readSyncReceipt({ version: RECEIPT_VERSION + 1, somethingNew: [] });
    assert.equal(r.status, 'unsupported');
    assert.equal(r.version, RECEIPT_VERSION + 1);
    assert.deepEqual(r.entries, []);
  });

  test('shapes conveying nothing read `unreadable`, distinctly from `absent`', () => {
    // Distinct because the caller treats them the same way but an operator must
    // not be told a file it can see does not exist.
    for (const raw of ['{}', 42, [], { version: 2 }, { version: 2, recentSyncs: [] },
      { version: 2, recentSyncs: [{ nope: true }] }, { hello: 'world' }]) {
      assert.equal(readSyncReceipt(raw).status, 'unreadable', JSON.stringify(raw));
    }
  });

  test('a v2 file with a garbled entry keeps the entries it CAN read', () => {
    const good = base({ created: ['a'] });
    const r = readSyncReceipt({ version: 2, recentSyncs: [null, good, 'nope'], olderSyncsDropped: -1 });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.entries, [good]);
    assert.equal(r.dropped, 0, 'a nonsense dropped count must not propagate');
  });
});

describe('appendReceiptEntry', () => {
  test('a second sync PREPENDS — the first record survives uncommitted', () => {
    // The reported defect, at unit scale: under v1 this second write replaced
    // the first outright, and nothing anywhere recorded the loss.
    const first = base({ syncedAt: '2026-09-02T11:40:53.438Z', created: ['a', 'b'] });
    const afterFirst = appendReceiptEntry(readSyncReceipt(null), first);
    const second = base({ syncedAt: '2026-09-02T17:38:25.772Z', updated: ['c'] });
    const afterSecond = appendReceiptEntry(readSyncReceipt(afterFirst), second);

    assert.equal(afterSecond.version, RECEIPT_VERSION);
    assert.equal(afterSecond.recentSyncs.length, 2);
    assert.equal(afterSecond.recentSyncs[0].syncedAt, '2026-09-02T17:38:25.772Z');
    assert.deepEqual(afterSecond.recentSyncs[1].created, ['a', 'b'],
      "the earlier sync's created list must still be readable");
  });

  test('migrating a v1 file keeps the v1 record as the second entry', () => {
    // The migration must not itself destroy the record it is migrating — that
    // would spend the defect's cost once more on the way out of it.
    const out = appendReceiptEntry(readSyncReceipt(v1File({ created: ['legacy'] })),
      base({ syncedAt: '2026-09-03T00:00:00.000Z', updated: ['x'] }));
    assert.equal(out.version, RECEIPT_VERSION);
    assert.equal(out.recentSyncs.length, 2);
    assert.deepEqual(out.recentSyncs[1].created, ['legacy']);
    assert.equal(out.recentSyncs[1].syncedAt, '2026-08-29T14:11:25.527Z');
  });

  test('the history is bounded, and what left is COUNTED, never silent', () => {
    let file = null;
    for (let i = 0; i < RECEIPT_HISTORY_LIMIT + 3; i++) {
      file = appendReceiptEntry(readSyncReceipt(file),
        base({ syncedAt: `2026-09-03T00:00:0${i}.000Z`, updated: [`f${i}`] }));
    }
    assert.equal(file.recentSyncs.length, RECEIPT_HISTORY_LIMIT);
    assert.equal(file.olderSyncsDropped, 3);
    // Newest first, oldest gone: entries leave by AGE, a property of the file,
    // not by whoever synced last.
    assert.equal(file.recentSyncs[0].updated[0], `f${RECEIPT_HISTORY_LIMIT + 2}`);
  });

  test('carries the explanatory note the reader meeting it in a diff needs', () => {
    const out = appendReceiptEntry(readSyncReceipt(null), base());
    assert.match(out._note, /newest first/);
    assert.match(out._note, /do not hand-edit/);
  });
});

describe('receiptShouldWrite', () => {
  test('a no-op sync against an identical prior entry does NOT rewrite', () => {
    // The whole justification for committing a timestamped artifact: it must
    // not churn when nothing happened. Append-only would otherwise grow the
    // file on every run that did nothing.
    const prev = base();
    const next = buildReceiptEntry({ syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE });
    assert.equal(receiptShouldWrite(prev, next), false);
  });

  test('a no-op sync compares against the NEWEST entry, not the whole file', () => {
    const file = appendReceiptEntry(
      { entries: [base({ updated: ['busy'] })], dropped: 0 },
      base(),
    );
    const next = buildReceiptEntry({ syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE });
    assert.equal(receiptShouldWrite(latestReceiptEntry(readSyncReceipt(file)), next), false);
  });

  test('a run that propagated anything rewrites, even over an identical set', () => {
    // Syncing the same file twice is two events. A stale timestamp would make
    // the second invisible.
    const prev = base({ updated: ['a'] });
    const next = buildReceiptEntry({ syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE, updated: ['a'] });
    assert.equal(receiptShouldWrite(prev, next), true);
  });

  test('the first receipt is always written', () => {
    assert.equal(receiptShouldWrite(null, base()), true);
  });

  test('a no-op run after a busy one still writes — the record must show it', () => {
    const prev = base({ updated: ['a'] });
    const next = buildReceiptEntry({ syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE });
    assert.equal(receiptShouldWrite(prev, next), true);
  });

  test('an override whose upstream content moved rewrites, even on a no-op run', () => {
    // This is the notification mechanism for a stale override: the diff IS the
    // report. If it did not write, the consumer would never learn.
    const prev = base({ overridesHeld: [{ path: 'x', reason: 'r', upstreamSha: 'aaa', upstreamMoved: false }] });
    const next = buildReceiptEntry({
      syncedAt: '2026-09-01T00:00:00.000Z',
      source: SOURCE,
      overridesHeld: [{ path: 'x', reason: 'r', upstreamSha: 'bbb', upstreamMoved: true }],
    });
    assert.equal(receiptShouldWrite(prev, next), true);
  });

  test('an unchanged held override on a no-op run does NOT rewrite', () => {
    const held = [{ path: 'x', reason: 'r', upstreamSha: 'aaa', upstreamMoved: false }];
    const prev = base({ overridesHeld: held });
    const next = buildReceiptEntry({ syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE, overridesHeld: held });
    assert.equal(receiptShouldWrite(prev, next), false);
  });

  test('a refusal appearing rewrites', () => {
    const prev = base();
    const next = buildReceiptEntry({
      syncedAt: '2026-09-01T00:00:00.000Z', source: SOURCE,
      divergenceRefused: [{ path: 'x', reason: 'diverged-committed' }],
    });
    assert.equal(receiptShouldWrite(prev, next), true);
  });
});
