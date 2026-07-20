/**
 * Tier-1 tests for the shared arch-memory JSON disk cache.
 * Consolidates the near-duplicate cache trios from normalize-intent.mjs and
 * neighbourhood-query.mjs, and adds the load-time validation + pruning neither
 * of them had.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normaliseCacheShape,
  isUsableEntry,
  pruneEntries,
  loadCache,
  getCached,
  putCached,
  MAX_ENTRIES,
} from '../scripts/lib/arch-memory/json-cache.mjs';

const TTL = 60_000;
const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'json-cache-')), 'c.json');

describe('json-cache / load-time shape validation', () => {
  // The pre-consolidation loadCache() accepted any syntactically valid JSON,
  // so these all parsed fine and then blew up on `cache.entries[key]` — on the
  // prompt-submit hook path.
  for (const [label, payload] of [
    ['an array', '[]'],
    ['null', 'null'],
    ['a bare object with no entries', '{}'],
    ['entries as an array', '{"entries":[]}'],
    ['entries as a string', '{"entries":"nope"}'],
    ['a legacy shape', '{"cache":{"a":1}}'],
  ]) {
    it(`treats ${label} as an empty cache, not a crash`, () => {
      const f = tmpFile();
      fs.writeFileSync(f, payload);
      const c = loadCache(f);
      assert.deepEqual(c, { entries: {} });
      assert.equal(getCached(f, 'anything', TTL), null);
    });
  }

  it('treats malformed JSON as a recoverable miss', () => {
    const f = tmpFile();
    fs.writeFileSync(f, '{not json');
    assert.deepEqual(loadCache(f), { entries: {} });
  });

  it('a missing file is an empty cache', () => {
    assert.deepEqual(loadCache(path.join(os.tmpdir(), 'definitely-absent-xyz.json')), { entries: {} });
  });
});

describe('json-cache / entry usability', () => {
  const now = 1_000_000;
  it('rejects entries with no finite timestamp', () => {
    assert.equal(isUsableEntry({ value: 'x' }, TTL, now), false);
    assert.equal(isUsableEntry({ value: 'x', savedAt: 'soon' }, TTL, now), false);
  });
  it('rejects expired entries', () => {
    assert.equal(isUsableEntry({ value: 'x', savedAt: now - TTL - 1 }, TTL, now), false);
  });
  it('rejects null/undefined values — an absent value is not a hit', () => {
    assert.equal(isUsableEntry({ value: null, savedAt: now }, TTL, now), false);
    assert.equal(isUsableEntry({ savedAt: now }, TTL, now), false);
  });
  it('rejects when ttl is absent or non-positive (a caller that forgot it)', () => {
    assert.equal(isUsableEntry({ value: 'x', savedAt: now }, undefined, now), false);
    assert.equal(isUsableEntry({ value: 'x', savedAt: now }, 0, now), false);
  });
  it('accepts a live, well-formed entry', () => {
    assert.equal(isUsableEntry({ value: 'x', savedAt: now }, TTL, now), true);
  });
});

describe('json-cache / bounded growth', () => {
  it('drops expired entries on prune', () => {
    const now = 1_000_000;
    const entries = {
      live: { value: 'a', savedAt: now },
      dead: { value: 'b', savedAt: now - TTL - 1 },
    };
    assert.deepEqual(Object.keys(pruneEntries(entries, TTL, now)), ['live']);
  });

  it('caps at MAX_ENTRIES, keeping the newest', () => {
    const now = 1_000_000;
    const entries = {};
    for (let i = 0; i < MAX_ENTRIES + 50; i++) entries[`k${i}`] = { value: i, savedAt: now - i };
    const pruned = pruneEntries(entries, TTL * 1000, now);
    assert.equal(Object.keys(pruned).length, MAX_ENTRIES);
    assert.ok('k0' in pruned, 'newest must survive');
    assert.equal(`k${MAX_ENTRIES + 49}` in pruned, false, 'oldest must be dropped');
  });

  it('prunes on write so the file cannot grow without bound', () => {
    const f = tmpFile();
    const now = Date.now();
    putCached(f, 'fresh', 'v', TTL, now);
    putCached(f, 'stale', 'v', TTL, now - TTL - 1000);
    // Writing again at `now` must evict the stale entry written in the past.
    putCached(f, 'another', 'v', TTL, now);
    const keys = Object.keys(loadCache(f).entries);
    assert.ok(keys.includes('fresh') && keys.includes('another'));
    assert.equal(keys.includes('stale'), false);
  });
});

describe('json-cache / round trip', () => {
  it('stores and retrieves a value', () => {
    const f = tmpFile();
    putCached(f, 'k', { hello: 'world' }, TTL);
    assert.deepEqual(getCached(f, 'k', TTL), { hello: 'world' });
  });

  it('stores an embedding array intact', () => {
    const f = tmpFile();
    const vec = [0.1, 0.2, 0.3];
    putCached(f, 'k', vec, TTL);
    assert.deepEqual(getCached(f, 'k', TTL), vec);
  });

  it('a miss returns null rather than throwing', () => {
    assert.equal(getCached(tmpFile(), 'absent', TTL), null);
  });
});
