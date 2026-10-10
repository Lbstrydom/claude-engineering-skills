/**
 * Hunk-centred read windows (docs/plans/audit-hunk-window-coverage.md D2-D4; upstream report 58f4e3a5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unionRanges, countLines, countUncovered, changedLineRanges, planHunkWindow, renderRanges,
  gapMarkerFor, charsInRanges, formatRanges, prefixRange, assembleBlocks,
} from '../scripts/lib/hunk-window.mjs';

const fileOf = (n, width = 40) => Array.from({ length: n }, (_, i) => `line ${String(i + 1).padStart(4, '0')} `.padEnd(width, 'x'));

test('unionRanges merges overlapping and adjacent ranges, drops malformed ones', () => {
  assert.deepEqual(unionRanges([[5, 7], [1, 2], [3, 3], [10, 12], [11, 20], [0, 4], [9, 8], 'x']), [[1, 3], [5, 7], [10, 20]]);
  assert.deepEqual(unionRanges([[1, 3], [4, 6]]), [[1, 6]], 'adjacent ranges fuse');
  assert.equal(countLines([[1, 3], [2, 5]]), 5);
});

test('countUncovered counts target lines outside the covered union', () => {
  assert.equal(countUncovered([[1, 10]], [[1, 3], [8, 20]]), 4);
  assert.equal(countUncovered([[5, 6], [30, 31]], [[1, 100]]), 0);
  assert.equal(countUncovered([[5, 6]], []), 2);
});

test('changedLineRanges clips to the file, keeps a deletion site, drops a wholly stale hunk', () => {
  assert.deepEqual(changedLineRanges([{ startLine: 10, lineCount: 5 }, { startLine: 12, lineCount: 10 }], 100), [[10, 21]]);
  assert.deepEqual(changedLineRanges([{ startLine: 40, lineCount: 0 }], 100), [[40, 40]], 'pure deletion keeps its site');
  assert.deepEqual(changedLineRanges([{ startLine: 0, lineCount: 0 }], 100), [[1, 1]]);
  assert.deepEqual(changedLineRanges([{ startLine: 95, lineCount: 20 }], 100), [[95, 100]]);
  assert.deepEqual(changedLineRanges([{ startLine: 150, lineCount: 3 }], 100), [], 'a hunk past the end is not a change here');
  assert.deepEqual(changedLineRanges(null, 100), []);
});

test('planHunkWindow keeps the head, every changed line that fits, then context', () => {
  const lines = fileOf(400);   // 41 chars per line incl. newline
  const changed = [[200, 205], [350, 352]];
  const { base, grown, complete } = planHunkWindow(lines, changed, { maxPerFile: 4000 });
  assert.equal(complete, true);
  assert.equal(grown, null);
  assert.equal(countUncovered(changed, base), 0, 'every changed line is in the window');
  assert.equal(base[0][0], 1, 'the head is kept');
  assert.ok(countUncovered([[197, 208]], base) === 0, 'context either side is kept');
  assert.ok(charsInRanges(lines, base) <= 4000);
});

test('planHunkWindow: changes larger than the budget → base holds what fits, grown holds them all', () => {
  const lines = fileOf(500);
  const changed = [[100, 400]];   // ~12,300 chars of changed text against a 4000 budget
  const { base, grown, complete } = planHunkWindow(lines, changed, { maxPerFile: 4000 });
  assert.equal(complete, false);
  assert.ok(charsInRanges(lines, base) <= 4000);
  assert.ok(countUncovered(changed, base) > 0);
  assert.equal(countUncovered(changed, grown), 0);
  assert.deepEqual(grown.at(-1), [97, 403], 'grown carries full context');
});

test('renderRanges prints kept lines with markers naming the elided original line numbers', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f'];
  const out = renderRanges(lines, [[2, 3], [5, 5]], gapMarkerFor('//'));
  assert.equal(out, ['// ... [lines 1-1 not shown] ...', 'b', 'c', '// ... [lines 4-4 not shown] ...', 'e', '// ... [lines 6-6 not shown] ...'].join('\n'));
  assert.equal(renderRanges(lines, [[1, 6]], gapMarkerFor(null)), lines.join('\n'));
  assert.ok(!gapMarkerFor('//')(1, 2).includes('*/'), 'a marker inside a block comment must stay inert');
  assert.equal(gapMarkerFor(null)(3, 9), '... [lines 3-9 not shown] ...');
});

test('formatRanges / prefixRange', () => {
  assert.equal(formatRanges([[1, 40], [120, 120]]), '1-40, 120');
  assert.deepEqual(prefixRange('a\nb\nc\nd', 3), [1, 2], 'a partly shown line counts as shown');
  assert.deepEqual(prefixRange('abc', 100), [1, 1]);
  // Boundaries (code audit R1 M4): a cut ending ON a newline shows nothing of the next line.
  assert.deepEqual(prefixRange('a\nchanged();', 1), [1, 1], 'before the newline');
  assert.deepEqual(prefixRange('a\nchanged();', 2), [1, 1], 'on the newline: line 2 was not shown');
  assert.deepEqual(prefixRange('a\nchanged();', 3), [1, 2], 'one character of line 2 shown');
  assert.deepEqual(unionRanges([prefixRange('abc', 0)]), [], 'an empty cut shows no line');
});

test('assembleBlocks is byte-identical to the old loop when nothing grows', () => {
  const entries = [{ base: 'aaaa' }, { base: 'bbbbbbbb' }, { base: 'cc' }];
  const r = assembleBlocks(entries, 7);
  assert.deepEqual(r.placement, ['base', 'omitted', 'base']);
  assert.equal(r.text, 'aaaacc');
});

test('assembleBlocks is breadth-first: no file is omitted so another can grow', () => {
  const entries = [{ base: 'AAAA', grown: 'AAAAAAAAAAAAAAAA' }, { base: 'BBBB' }];
  const r = assembleBlocks(entries, 12);
  assert.deepEqual(r.placement, ['base', 'base'], 'growth (+12) does not fit the 4 left after both bases');
  const roomy = assembleBlocks(entries, 30);
  assert.deepEqual(roomy.placement, ['grown', 'base']);
  assert.equal(roomy.text, 'AAAAAAAAAAAAAAAABBBB');
});

// ── The readers (D2-D4): the reporter's shape ────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { readFilesAsContextDetailed } from '../scripts/lib/audit-scope.mjs';
import { readFilesAsAnnotatedContextDetailed } from '../scripts/lib/diff-annotation.mjs';
import { mkdtemp } from './helpers/fixtures.mjs';
import { fenceLanguageFor } from '../scripts/lib/file-taxonomy.mjs';

/** A ~17 KB JS file whose line N reads `const vN = N; // MARK_N`. */
function bigFile(lines = 420) {
  return Array.from({ length: lines }, (_, i) => `const v${i + 1} = ${i + 1}; // MARK_${i + 1} ${'p'.repeat(14)}`).join('\n') + '\n';
}

function inTempRepo(t, files) {
  const dir = mkdtemp('hunk-window-readers-');
  const prev = process.cwd();
  t.after(() => { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  process.chdir(dir);
}

test('plain reader: changed lines past maxPerFile are rendered (windowed), not head-cut away', (t) => {
  inTempRepo(t, { 'big.js': bigFile() });
  const hunks = [{ startLine: 300, lineCount: 4 }, { startLine: 400, lineCount: 2 }];
  const { context, stats } = readFilesAsContextDetailed(['big.js'], { maxPerFile: 4000, maxTotal: 60000, hunksFor: () => hunks });
  for (const n of [300, 301, 302, 303, 400, 401]) assert.ok(context.includes(`// MARK_${n} `), `changed line ${n} rendered`);
  assert.ok(context.includes('// MARK_1 '), 'the head is kept');
  assert.match(context, /\.\.\. \[lines \d+-\d+ not shown\] \.\.\./);
  const cut = stats.headTruncated[0];
  assert.equal(cut.windowed, true);
  assert.equal(countUncovered([[300, 303], [400, 401]], cut.ranges), 0);
});

test('plain reader: with no hunks the render is today\'s head cut, byte for byte', (t) => {
  inTempRepo(t, { 'big.js': bigFile() });
  const a = readFilesAsContextDetailed(['big.js'], { maxPerFile: 4000, maxTotal: 60000 });
  const b = readFilesAsContextDetailed(['big.js'], { maxPerFile: 4000, maxTotal: 60000, hunksFor: () => null });
  assert.equal(a.context, b.context);
  const raw = bigFile();
  const fence = '`'.repeat(3);
  const expected = `### big.js\n${fence}${fenceLanguageFor('big.js')}\n${raw.slice(0, 4000)}\n... [TRUNCATED — ${raw.length} chars total]\n${fence}\n`;
  assert.equal(a.context, expected, 'the pre-window head-cut shape, literally');
  assert.deepEqual(a.stats.headTruncated[0].ranges, [prefixRange(raw, 4000)]);
});

test('plain reader: a change bigger than the window grows into the unused total budget', (t) => {
  inTempRepo(t, { 'big.js': bigFile() });
  const hunks = [{ startLine: 100, lineCount: 250 }];   // ~10,500 chars of changed text vs a 4000 window
  const { context, stats } = readFilesAsContextDetailed(['big.js'], { maxPerFile: 4000, maxTotal: 60000, hunksFor: () => hunks });
  for (const n of [100, 225, 349]) assert.ok(context.includes(`// MARK_${n} `), `changed line ${n} rendered`);
  assert.equal(countUncovered([[100, 349]], stats.headTruncated[0].ranges), 0);
});

test('plain reader: growth never omits another file (breadth first)', (t) => {
  inTempRepo(t, { 'big.js': bigFile(), 'small.js': 'export const s = 1; // SMALL\n' });
  const hunks = new Map([['big.js', [{ startLine: 100, lineCount: 250 }]]]);
  const { context, stats } = readFilesAsContextDetailed(['big.js', 'small.js'], { maxPerFile: 4000, maxTotal: 5000, hunksFor: (p) => hunks.get(p) ?? null });
  assert.ok(context.includes('// SMALL'), 'the small file still fits');
  assert.deepEqual(stats.budgetOmitted, []);
});

test('annotated reader: the BASE window, markers included, stays within maxPerFile (code audit R2 M1)', (t) => {
  inTempRepo(t, { 'big.js': bigFile() });
  const hunks = Array.from({ length: 30 }, (_, k) => ({ startLine: 20 + k * 13, lineCount: 2 }));
  const diffMap = new Map([['big.js', { hunks }]]);
  // maxTotal leaves no room to grow, so the base window is what renders.
  const { context, stats } = readFilesAsAnnotatedContextDetailed(['big.js'], diffMap, { maxPerFile: 4000, maxTotal: 4600 });
  assert.equal(stats.headTruncated[0]?.windowed, true, JSON.stringify(stats));
  const body = context.slice(context.indexOf('\n```') + 1).split('\n').slice(1, -2).join('\n');
  assert.ok(body.length <= 4000, `rendered body ${body.length} chars exceeds maxPerFile 4000`);
  // ...and not by rendering nothing (code audit R3 M1): the first changed lines are there.
  assert.ok(context.includes('// MARK_20 ') && context.includes('// MARK_21 '), 'the base window shows changed source lines');
});

test('planHunkWindow: many hunks with render overhead still show changed lines (overhead is paid per SHOWN range)', () => {
  const lines = fileOf(2000);
  const changed = Array.from({ length: 200 }, (_, k) => [10 + k * 9, 10 + k * 9]);
  const { base } = planHunkWindow(lines, changed, { maxPerFile: 4000, rangeOverhead: 200 });
  assert.ok(countUncovered(changed, base) < countLines(changed), 'at least one changed line is in the base window');
  assert.ok(countUncovered([[10, 10]], base) === 0, 'the first changed range is shown');
});

test('annotated reader (R2+): an oversized changed file renders its hunks, annotated, with real line numbers', (t) => {
  inTempRepo(t, { 'big.js': bigFile() });
  const diffMap = new Map([['big.js', { hunks: [{ startLine: 300, lineCount: 3 }] }]]);
  const { context, stats } = readFilesAsAnnotatedContextDetailed(['big.js'], diffMap, { maxPerFile: 4000, maxTotal: 60000 });
  for (const n of [300, 301, 302]) assert.ok(context.includes(`// MARK_${n} `), `changed line ${n} rendered`);
  assert.ok(context.includes('// ── CHANGED ──'));
  assert.match(context, /\.\.\. \[lines \d+-\d+ not shown\] \.\.\./);
  const cut = stats.headTruncated[0];
  assert.equal(cut.windowed, true);
  assert.equal(countUncovered([[300, 302]], cut.ranges), 0);
});
