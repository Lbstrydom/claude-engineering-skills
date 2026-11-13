/**
 * Pre-existing finding scope (8a) and changed-chunk scoping (1c) - docs/plans/audit-out-of-diff-noise.md.
 * The AIO #109 fixture: a 17-finding push where 15 findings were about unchanged code.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyFindingScope, stampFindingScopes, isPreExisting, isInDiff, PRE_EXISTING, IN_DIFF, PRE_EXISTING_WINDOW_LINES,
} from '../scripts/lib/finding-scope.mjs';
import { strictChunkRanges } from '../scripts/lib/finding-scope.mjs';
import { selectChangedChunks, buildAuditUnits, chunkScopeMode } from '../scripts/lib/code-analysis.mjs';
import { classifyAuditOutcome, decideAuditGate, formatFindingTitles } from '../scripts/lib/prepush-audit-gate.mjs';
import { formatFindings } from '../scripts/lib/findings-format.mjs';
import { formatAuditSummaryLine } from '../scripts/lib/audit/findings-pipeline.mjs';
import { countFindings, isConverged } from '../scripts/audit-loop.mjs';

const W = PRE_EXISTING_WINDOW_LINES;
const hunksFor = (map) => (p) => (p in map ? map[p] : null);
const fnd = (id, severity, extra = {}) => ({ id, severity, category: 'c', section: 'src/big.ts', detail: 'd', risk: 'r', recommendation: 'x', ...extra });
const ev = (file, s, e) => ({ file, ranges: [[s, e]] });

describe('classifyFindingScope - mechanical, fail closed', () => {
  const h = hunksFor({ 'src/big.ts': [{ startLine: 100, lineCount: 3 }] });
  test('evidence wholly outside the hunk + window is pre-existing', () => {
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { _scopeEvidence: ev('src/big.ts', 300, 400) }), { hunksFor: h }).scope, PRE_EXISTING);
  });
  test('overlap, and the window edge, are in-diff', () => {
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { _scopeEvidence: ev('src/big.ts', 90, 110) }), { hunksFor: h }).scope, IN_DIFF);
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { _scopeEvidence: ev('src/big.ts', 102 + W + 1, 500) }), { hunksFor: h }).scope, PRE_EXISTING);
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { _scopeEvidence: ev('src/big.ts', 102 + W, 500) }), { hunksFor: h }).scope, IN_DIFF);
  });
  test('NO line evidence is in-diff (the legacy passes emit none)', () => {
    assert.deepEqual(classifyFindingScope(fnd('H1', 'HIGH'), { hunksFor: h }), { scope: IN_DIFF, reason: 'no-line-evidence' });
  });
  test('no hunk map, a file outside the diff, or a malformed range: in-diff', () => {
    const f = fnd('M1', 'MEDIUM', { _scopeEvidence: ev('src/big.ts', 300, 400) });
    assert.equal(classifyFindingScope(f, { hunksFor: null }).scope, IN_DIFF);
    assert.equal(classifyFindingScope(f, {}).scope, IN_DIFF);
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { _scopeEvidence: ev('other.ts', 300, 400) }), { hunksFor: h }).reason, 'no-hunks-for-file');
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { _scopeEvidence: { file: 'src/big.ts', ranges: [[5, 2]] } }), { hunksFor: h }).reason, 'unreadable-line-evidence');
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { _scopeEvidence: { file: 'src/big.ts', ranges: [[300, 400], ['x', 1]] } }), { hunksFor: h }).scope, IN_DIFF);
  });
  test('a hunk list the evidence cannot be trusted against is in-diff: malformed hunk, throwing producer', () => {
    const f = fnd('M1', 'MEDIUM', { _scopeEvidence: ev('src/big.ts', 300, 400) });
    assert.equal(classifyFindingScope(f, { hunksFor: () => [{ lineCount: 2 }] }).scope, IN_DIFF);
    assert.equal(classifyFindingScope(f, { hunksFor: () => { throw new Error('x'); } }).scope, IN_DIFF);
  });
  test('a deletion-only hunk (lineCount 0) anchors at its point', () => {
    const hd = hunksFor({ 'a.ts': [{ startLine: 50, lineCount: 0 }] });
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { _scopeEvidence: ev('a.ts', 50 + W, 80) }), { hunksFor: hd }).scope, IN_DIFF);
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { _scopeEvidence: ev('a.ts', 50 + W + 1, 80) }), { hunksFor: hd }).scope, PRE_EXISTING);
  });
  test('a tiered anchor (newFile/startLine/endLine) is evidence; ALL evidence must be outside', () => {
    const anchor = { newFile: 'src/big.ts', startLine: 400, endLine: 410 };
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { anchor }), { hunksFor: h }).scope, PRE_EXISTING);
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { anchor, triggerAnchor: { newFile: 'src/big.ts', startLine: 101, endLine: 101 } }), { hunksFor: h }).scope, IN_DIFF);
  });
  test('a file in the diff with NO new-side change ([]) has nothing for a finding to be about', () => {
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { _scopeEvidence: ev('a.ts', 1, 9) }), { hunksFor: hunksFor({ 'a.ts': [] }) }).scope, PRE_EXISTING);
  });
  test('model prose never decides: a detail claiming "unchanged" or a line number moves nothing', () => {
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { detail: 'pre-existing code at src/big.ts:900, not in this change' }), { hunksFor: h }).scope, IN_DIFF);
    assert.equal(classifyFindingScope(fnd('M1', 'MEDIUM', { scope: 'pre-existing-ish', line: 900 }), { hunksFor: h }).scope, IN_DIFF);
  });
  test('isPreExisting / isInDiff read the exact marker only', () => {
    assert.equal(isPreExisting({ scope: PRE_EXISTING }), true);
    for (const v of [undefined, null, '', 'Pre-Existing', 'in-diff', 1]) assert.equal(isPreExisting({ scope: v }), false);
    assert.equal(isInDiff(undefined), true);
  });
});

describe('AIO #109 SHAPE (synthetic fixture, not the real findings) - 17 findings, 15 about unchanged code', () => {
  // 1 line in en.ts, 1 in types.ts, 6 in styles.css were changed; every finding was raised from a chunk of one of those files.
  const hunks = hunksFor({
    'en.ts': [{ startLine: 40, lineCount: 1 }],
    'types.ts': [{ startLine: 200, lineCount: 1 }],
    'styles.css': [{ startLine: 1000, lineCount: 6 }],
  });
  const out = (file, n) => Array.from({ length: n }, (_, i) => fnd(`${file}-${i}`, i % 3 === 0 ? 'HIGH' : 'MEDIUM', { _scopeEvidence: ev(file, 2000 + i * 100, 2090 + i * 100) }));
  const findings = [...out('en.ts', 5), ...out('types.ts', 4), ...out('styles.css', 6),
    fnd('IN1', 'MEDIUM', { _scopeEvidence: ev('styles.css', 980, 1020) }), fnd('IN2', 'HIGH')];
  test('15 are tagged pre-existing; the two about the change are not', () => {
    assert.equal(findings.length, 17);
    assert.equal(stampFindingScopes(findings, { hunksFor: hunks }), 15);
    assert.deepEqual(findings.filter(isInDiff).map((f) => f.id), ['IN1', 'IN2']);
  });
  test('the pre-push gate counts only the two; the 15 are listed, not counted, and not shown as titles', () => {
    const report = { verdict: 'NEEDS_FIXES', findings };
    const outcome = classifyAuditOutcome({ exitCode: 0, report });
    assert.equal(outcome.kind, 'findings');
    assert.equal(outcome.counts.high + outcome.counts.medium, 2);
    assert.equal(outcome.preExisting, 15);
    const { lines } = decideAuditGate({ outcome });
    assert.ok(lines.some((l) => /15 pre-existing finding\(s\).*NOT counted/.test(l)), lines.join('\n'));
    assert.equal(formatFindingTitles(findings).length, 2);
  });
  test('/audit-code convergence: only pre-existing findings means converged, not blocked', () => {
    const only = findings.filter(isPreExisting);
    const counts = countFindings({ verdict: 'PASS', findings: only });
    assert.equal(counts.total, 0);
    assert.equal(isConverged(counts), true);
    assert.equal(isConverged(countFindings({ verdict: 'NEEDS_FIXES', findings })), false);
  });
  test('an all-pre-existing PASS gates as clean with the count stated', () => {
    const outcome = classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings: findings.filter(isPreExisting) } });
    assert.equal(outcome.kind, 'clean');
    assert.equal(outcome.preExisting, 15);
  });
});

describe('where the field is absent nothing changes', () => {
  test('a legacy envelope classifies exactly as before, with no preExisting key', () => {
    const outcome = classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings: [fnd('L1', 'LOW')] } });
    assert.equal('preExisting' in outcome, false);
  });
  test('a malformed severity on a pre-existing finding is still an unreadable envelope (shape first)', () => {
    const outcome = classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings: [{ severity: 'WAT', scope: PRE_EXISTING }] } });
    assert.equal(outcome.kind, 'unmeasured');
  });
});

describe('report surfaces', () => {
  test('formatFindings puts pre-existing under its own heading, after the author’s own', () => {
    const md = formatFindings([fnd('H1', 'HIGH'), fnd('M9', 'MEDIUM', { scope: PRE_EXISTING })]);
    const i = md.indexOf('### HIGH Severity');
    const j = md.indexOf('### Pre-existing');
    assert.ok(i >= 0 && j > i);
    assert.ok(md.indexOf('[M9]') > j);
    assert.equal(formatFindings([fnd('H1', 'HIGH')]).includes('Pre-existing'), false);
  });
  test('the summary line keeps its leading shape and appends the pre-existing count', () => {
    const base = { verdict: 'PASS', high: 0, medium: 1, low: 2, latencyMs: 5000 };
    assert.equal(formatAuditSummaryLine(base), 'Verdict: PASS | H:0 M:1 L:2 | 5s');
    assert.match(formatAuditSummaryLine({ ...base, preExisting: 4 }), /^Verdict: PASS \| H:0 M:1 L:2 \| 5s \| pre-existing:4 \(not counted\)$/);
  });
});

describe('1c - selectChangedChunks / buildAuditUnits', () => {
  const mkChunk = (start, body) => ({ imports: '', items: [{ source: body, startLine: start }], tokens: 10 });
  // three chunks: [1-10] helperA, [11-20] changed fn using helperA, [21-30] unrelated
  const body = (start, text) => Array.from({ length: 10 }, (_, i) => (i === 0 ? text : `  // line ${start + i}`)).join('\n');
  const chunks = [mkChunk(1, body(1, 'function helperA() {')), mkChunk(101, body(101, 'function changed() { helperA(); }')), mkChunk(201, body(201, 'function unrelated() {'))];
  const scope = (mode, hunks) => ({ mode, hunksFor: () => hunks });
  test('off / absent scope returns the same array object (byte-identical)', () => {
    assert.equal(selectChangedChunks(chunks, 'f.ts', null), chunks);
    assert.equal(selectChangedChunks(chunks, 'f.ts', scope('off', [{ startLine: 105, lineCount: 1 }])), chunks);
  });
  test('overlap keeps only the touched chunk', () => {
    const got = selectChangedChunks(chunks, 'f.ts', scope('overlap', [{ startLine: 105, lineCount: 1 }]));
    assert.deepEqual(got.map((c) => c.items[0].startLine), [101]);
  });
  test('referenced also keeps the chunk declaring a symbol the changed chunk uses', () => {
    const got = selectChangedChunks(chunks, 'f.ts', scope('referenced', [{ startLine: 105, lineCount: 1 }]));
    assert.deepEqual(got.map((c) => c.items[0].startLine), [1, 101]);
  });
  test('fails closed to every chunk: no/empty hunks, a throwing producer, a chunk with no range, nothing touched', () => {
    for (const s of [{ mode: 'overlap', hunksFor: () => null }, scope('overlap', []), { mode: 'overlap', hunksFor: () => { throw new Error('x'); } }, scope('overlap', [{ startLine: 9999, lineCount: 1 }])]) {
      assert.equal(selectChangedChunks(chunks, 'f.ts', s), chunks);
    }
    const noRange = [...chunks.slice(0, 2), { imports: '', items: [{ source: 'x' }], tokens: 1 }];
    assert.equal(selectChangedChunks(noRange, 'f.ts', scope('overlap', [{ startLine: 105, lineCount: 1 }])), noRange);
  });
  test('chunkScopeMode: only the two named values enable it', () => {
    assert.equal(chunkScopeMode({}), 'off');
    assert.equal(chunkScopeMode({ AUDIT_CHUNK_SCOPE: 'Overlap' }), 'overlap');
    assert.equal(chunkScopeMode({ AUDIT_CHUNK_SCOPE: 'referenced' }), 'referenced');
    assert.equal(chunkScopeMode({ AUDIT_CHUNK_SCOPE: '1' }), 'off');
  });
  test('buildAuditUnits on a real oversized file: scoped sends fewer chunk units than unscoped; off is identical', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-scope-'));
    const file = path.join(dir, 'big.js');
    const fns = Array.from({ length: 60 }, (_, i) => `function fn${i}() {\n${'  const x = 1; // padding padding padding padding\n'.repeat(40)}  return ${i};\n}\n`);
    fs.writeFileSync(file, fns.join('\n'));
    const quiet = process.stderr.write;
    process.stderr.write = () => true;
    try {
      const unscoped = buildAuditUnits([file], 2000);
      const off = buildAuditUnits([file], 2000, Infinity, { mode: 'off', hunksFor: () => [{ startLine: 1, lineCount: 1 }] });
      const scoped = buildAuditUnits([file], 2000, Infinity, { mode: 'overlap', hunksFor: () => [{ startLine: 1, lineCount: 1 }] });
      assert.ok(unscoped.length > 3);
      assert.deepEqual(off.map((u) => u.tokens), unscoped.map((u) => u.tokens));
      assert.ok(scoped.length >= 1 && scoped.length < unscoped.length, `${scoped.length} vs ${unscoped.length}`);
      assert.ok(scoped.every((u) => u.chunk && u.chunk.items.some((it) => it.startLine <= 1 + 40)));
    } finally { process.stderr.write = quiet; fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('audit round 1 fixes - partial and malformed evidence fail closed', () => {
  const mk = (start, text) => ({ imports: '', items: [{ source: text, startLine: start }], tokens: 5 });
  test('a chunk with ANY unlocatable item has no ranges, so scoping sends everything', () => {
    assert.equal(strictChunkRanges({ items: [{ source: 'a', startLine: 1 }, { source: 'b' }] }), null);
    assert.equal(strictChunkRanges({ items: [{ source: 'a', startLine: 0 }] }), null);
    assert.deepEqual(strictChunkRanges({ items: [{ source: 'a\nb', startLine: 3 }] }), [[3, 4]]);
    const chunks = [mk(1, 'x'), { imports: '', items: [{ source: 'y', startLine: 50 }, { source: 'z' }], tokens: 5 }];
    assert.equal(selectChangedChunks(chunks, 'f.ts', { mode: 'overlap', hunksFor: () => [{ startLine: 1, lineCount: 1 }] }), chunks);
  });
  test('a hunk whose lineCount is missing, non-numeric, negative or fractional is malformed: in-diff / send everything', () => {
    const f = fnd('M1', 'MEDIUM', { _scopeEvidence: ev('a.ts', 900, 950) });
    for (const lineCount of [undefined, 'bad', -1, 1.5]) {
      assert.equal(classifyFindingScope(f, { hunksFor: () => [{ startLine: 100, lineCount }] }).scope, IN_DIFF, String(lineCount));
    }
    const chunks = [mk(1, 'x'), mk(500, 'y')];
    assert.equal(selectChangedChunks(chunks, 'f.ts', { mode: 'overlap', hunksFor: () => [{ startLine: 1, lineCount: 'bad' }] }), chunks);
  });
  test('referenced mode keeps a chunk that defines a METHOD the changed chunk calls', () => {
    const chunks = [mk(1, 'class A {\n  helperMethod(x) {\n    return x;\n  }\n}'), mk(101, 'function changed() { return this.helperMethod(1); }'), mk(301, 'function other() {}')];
    const got = selectChangedChunks(chunks, 'f.ts', { mode: 'referenced', hunksFor: () => [{ startLine: 101, lineCount: 1 }] });
    assert.deepEqual(got.map((c) => c.items[0].startLine), [1, 101]);
  });
  test('a NEEDS_FIXES envelope whose only HIGH/MEDIUM findings are pre-existing is clean, with the count stated', () => {
    const outcome = classifyAuditOutcome({ exitCode: 0, report: { verdict: 'NEEDS_FIXES', findings: [fnd('H1', 'HIGH', { scope: PRE_EXISTING })] } });
    assert.equal(outcome.kind, 'clean');
    assert.equal(outcome.preExisting, 1);
  });
});

describe('audit round 2 fixes - the shared import block, TS method modifiers', () => {
  const mk = (start, text, imports = 'import a from "a";\nimport b from "b";') => ({ imports, items: [{ source: text, startLine: start }], tokens: 5 });
  test('the import block is every chunk’s scope EVIDENCE (a changed import line is in-diff for all), and selection keeps the first chunk', () => {
    const chunks = [mk(50, 'function a() {}'), mk(400, 'function b() {}'), mk(900, 'function c() {}')];
    assert.deepEqual(strictChunkRanges(chunks[1]), [[400, 400], [1, 2]]);
    // selection: an import edit is audited once, by the first chunk (not by resending the whole file)
    assert.deepEqual(selectChangedChunks(chunks, 'f.ts', { mode: 'overlap', hunksFor: () => [{ startLine: 2, lineCount: 1 }] }).map((c) => c.items[0].startLine), [50]);
    const f = fnd('M1', 'MEDIUM', { _scopeEvidence: { file: 'f.ts', ranges: strictChunkRanges(chunks[1]) } });
    assert.equal(classifyFindingScope(f, { hunksFor: () => [{ startLine: 2, lineCount: 1 }] }).scope, IN_DIFF);
  });
  test('referenced mode sees TypeScript methods with modifiers and return types', () => {
    const chunks = [mk(1, 'class A {\n  private helper(x: number): number {\n    return x;\n  }\n}'), mk(300, 'function changed() { return helper(1); }'), mk(600, 'function other() {}')];
    const got = selectChangedChunks(chunks, 'f.ts', { mode: 'referenced', hunksFor: () => [{ startLine: 300, lineCount: 1 }] });
    assert.deepEqual(got.map((c) => c.items[0].startLine), [1, 300]);
  });
});
