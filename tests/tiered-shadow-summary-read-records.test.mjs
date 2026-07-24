/**
 * Tier-1 tests for readRecords()'s record-shape validation.
 * Plan: docs/plans/arch-audit-pipeline-observability-hardening.md item 10.
 *
 * readRecords previously only rejected JSON.parse failures — a syntactically
 * valid but semantically wrong value (a scalar, an array, `{}`-shaped noise)
 * passed through silently and corrupted summarize()'s aggregate counts (a
 * bare string reads as "no legacyOk", counted as a legacyFailure with no
 * error printed). This file pins the fix directly against real file I/O,
 * matching the module's own doc comment ("Read + parse the local JSONL log").
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readRecords } from '../scripts/lib/audit/tiered-shadow-summary.mjs';

let tmpFile;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `readrecords-test-${process.pid}-${Date.now()}.jsonl`);
});

afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
});

describe('readRecords — record-shape validation', () => {
  test('a valid record line survives', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ legacyOk: true, shadowOk: true }) + '\n');
    const records = readRecords(tmpFile);
    assert.equal(records.length, 1);
    assert.equal(records[0].legacyOk, true);
  });

  test('a bare string value is rejected, not silently treated as a blank record', () => {
    fs.writeFileSync(tmpFile, JSON.stringify('hello') + '\n');
    const records = readRecords(tmpFile);
    assert.equal(records.length, 0, 'a scalar must not survive as a phantom all-undefined record');
  });

  test('a bare number value is rejected', () => {
    fs.writeFileSync(tmpFile, '42\n');
    assert.equal(readRecords(tmpFile).length, 0);
  });

  test('an array value is rejected (not an object record)', () => {
    fs.writeFileSync(tmpFile, JSON.stringify([1, 2, 3]) + '\n');
    assert.equal(readRecords(tmpFile).length, 0);
  });

  test('a literal null line is rejected (JSON.parse succeeds, value is null)', () => {
    fs.writeFileSync(tmpFile, 'null\n');
    assert.equal(readRecords(tmpFile).length, 0);
  });

  test('mixed valid + invalid lines: only the valid record survives, others logged and skipped', () => {
    const lines = [
      JSON.stringify({ legacyOk: true, shadowOk: false, shadowError: 'x' }),
      JSON.stringify('garbage'),
      'not json at all {{{',
      JSON.stringify([1, 2]),
      JSON.stringify({ legacyOk: false }),
    ];
    fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
    const records = readRecords(tmpFile);
    assert.equal(records.length, 2, 'the two genuine object records survive; the scalar/array/unparseable lines do not');
    assert.deepEqual(records.map((r) => r.legacyOk), [true, false]);
  });

  test('an empty object {} is now rejected — legacyOk is the one field every real record carries (round-2 audit H2, tightened from the original item-10 scope)', () => {
    fs.writeFileSync(tmpFile, '{}\n');
    const records = readRecords(tmpFile);
    assert.equal(records.length, 0, '{} has no legacyOk, so it is exactly as uninformative/miscounting-prone as a scalar or array');
  });

  test('legacyOk present but not a boolean is rejected (round-2 audit H2 exact example: {legacyOk:"yes"})', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ legacyOk: 'yes' }) + '\n');
    assert.equal(readRecords(tmpFile).length, 0);
  });

  test('a record with legacyOk but a null comparison still survives — partial shape is legitimate, only legacyOk is required (round-2 audit H2 exact example: {comparison:null})', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ legacyOk: false, comparison: null }) + '\n');
    const records = readRecords(tmpFile);
    assert.equal(records.length, 1, 'a legacy-only failure legitimately has no comparison object');
  });

  test('a missing file returns an empty array without throwing', () => {
    assert.deepEqual(readRecords(path.join(os.tmpdir(), 'definitely-does-not-exist.jsonl')), []);
  });
});
