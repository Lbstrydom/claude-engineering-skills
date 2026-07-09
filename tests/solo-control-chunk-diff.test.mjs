/**
 * Regression test for the split-misread-as-deletion / phantom-missing-file
 * confound found in the 2026-07 solo-control run (docs/experiments/audit-effectiveness):
 * chunkDiff's hard-split branch used to slice a large file's diff into raw
 * maxChars-sized fragments with NO file-identifying header on any fragment
 * after the first — an audit pass reading fragment 2+ in isolation could see
 * only deletion lines (their matching additions landed in a different chunk)
 * and misreport the whole file as deleted/missing. Every hard-split fragment
 * after the first must now carry a synthetic continuation marker naming the
 * file so it can never be mistaken for a deletion.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _internals } from '../scripts/solo-control-audit.mjs';

const { chunkDiff } = _internals;

function fileDiff(name, hunkLines) {
  return `diff --git a/${name} b/${name}\n`
    + `index 0000000..1111111 100644\n`
    + `--- a/${name}\n`
    + `+++ b/${name}\n`
    + `@@ -1,${hunkLines.length} +1,${hunkLines.length} @@\n`
    + hunkLines.join('\n') + '\n';
}

describe('chunkDiff — small diffs pass through unchanged', () => {
  it('a diff at or under maxChars returns as a single chunk', () => {
    const diff = fileDiff('a.js', ['-old', '+new']);
    assert.deepEqual(chunkDiff(diff, diff.length), [diff]);
    assert.deepEqual(chunkDiff(diff, diff.length + 1000), [diff]);
  });
});

describe('chunkDiff — multiple small files pack together untouched', () => {
  it('files that fit within maxChars combined keep their own real headers, no markers', () => {
    const a = fileDiff('a.js', ['-1', '+1']);
    const b = fileDiff('b.js', ['-2', '+2']);
    const combined = a + b;
    const chunks = chunkDiff(combined, combined.length);
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].includes('diff --git a/a.js b/a.js'));
    assert.ok(chunks[0].includes('diff --git a/b.js b/b.js'));
    assert.ok(!chunks[0].includes('diff continuation'));
  });
});

describe('chunkDiff — hard-split preserves file identity (the confound fix)', () => {
  it('a single file larger than maxChars is split, and every fragment after the first is labelled', () => {
    const hunkLines = Array.from({ length: 200 }, (_, i) => `-line${i}`);
    const diff = fileDiff('big-file.js', hunkLines);
    const maxChars = 400; // small enough to force several hard-split fragments
    assert.ok(diff.length > maxChars * 3, 'fixture must force at least 3 fragments');

    const chunks = chunkDiff(diff, maxChars);
    assert.ok(chunks.length >= 3, `expected several hard-split fragments, got ${chunks.length}`);

    // Fragment 1 keeps the REAL diff header — no marker needed, it's self-identifying.
    assert.ok(chunks[0].startsWith('diff --git a/big-file.js b/big-file.js'));
    assert.ok(!chunks[0].includes('diff continuation'));

    // Every subsequent fragment must name the file and explicitly disclaim deletion,
    // even though it contains ONLY deletion (`-`) lines with no matching `+` lines.
    for (const frag of chunks.slice(1)) {
      assert.match(frag, /# \[diff continuation: big-file\.js, part \d+/);
      assert.match(frag, /NOT evidence the file was deleted or is missing/);
    }
  });

  it('fragment part numbers are sequential and unique', () => {
    const hunkLines = Array.from({ length: 300 }, (_, i) => `-line${i}`);
    const diff = fileDiff('another.js', hunkLines);
    const chunks = chunkDiff(diff, 300);
    const partNumbers = chunks.slice(1).map((f) => Number(f.match(/part (\d+)/)[1]));
    assert.deepEqual(partNumbers, [...partNumbers].sort((a, b) => a - b));
    assert.equal(new Set(partNumbers).size, partNumbers.length, 'part numbers must be unique');
  });

  it('a hard-split file followed by a small file: the small file keeps its own real header untouched', () => {
    const hunkLines = Array.from({ length: 200 }, (_, i) => `-line${i}`);
    const big = fileDiff('big-file.js', hunkLines);
    const small = fileDiff('small.js', ['-x', '+y']);
    const chunks = chunkDiff(big + small, 400);
    const last = chunks[chunks.length - 1];
    assert.ok(last.includes('diff --git a/small.js b/small.js'), 'small.js keeps its real header, unmangled by the prior hard-split');
  });
});
