/**
 * @fileoverview Unit tests for the managed-block manager.
 * Plan §2 KD #5 — closed marker-state table; malformed states ABORT.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { updateManagedBlock, parseGitignoreState, _internals } from '../scripts/lib/sync-gitignore.mjs';

const { BEGIN, END } = _internals;
const PATTERN = 'scripts/.claude-skills/';

test('parseGitignoreState: empty input returns no markers, orderValid:true', () => {
  assert.deepEqual(parseGitignoreState(''), { beginIndices: [], endIndices: [], orderValid: true, blockSpan: null });
});

test('parseGitignoreState: null input returns empty state', () => {
  assert.deepEqual(parseGitignoreState(null), { beginIndices: [], endIndices: [], orderValid: true, blockSpan: null });
});

test('parseGitignoreState: valid block returns blockSpan', () => {
  const content = `# header\n${BEGIN}\nfoo/\n${END}\n# footer`;
  const s = parseGitignoreState(content);
  assert.equal(s.beginIndices.length, 1);
  assert.equal(s.endIndices.length, 1);
  assert.equal(s.orderValid, true);
  assert.ok(s.blockSpan);
});

test('updateManagedBlock: null content → creates new file', () => {
  const r = updateManagedBlock(null, [PATTERN]);
  assert.equal(r.action, 'create');
  assert.match(r.content, new RegExp(BEGIN.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
  assert.match(r.content, new RegExp(PATTERN));
});

test('updateManagedBlock: empty content → append block', () => {
  const r = updateManagedBlock('', [PATTERN]);
  assert.equal(r.action, 'create');
  assert.match(r.content, new RegExp(PATTERN));
});

test('updateManagedBlock: existing content without markers → append at EOF', () => {
  const r = updateManagedBlock('node_modules/\n*.log\n', [PATTERN]);
  assert.equal(r.action, 'create');
  assert.match(r.content, /node_modules\//);
  assert.match(r.content, new RegExp(PATTERN));
});

test('updateManagedBlock: existing valid block → replace contents', () => {
  const before = `# header\n${BEGIN}\nold-pattern/\n${END}\n# footer\n`;
  const r = updateManagedBlock(before, [PATTERN]);
  assert.equal(r.action, 'replace');
  assert.match(r.content, new RegExp(PATTERN));
  assert.doesNotMatch(r.content, /old-pattern/);
  assert.match(r.content, /^# header/);
  assert.match(r.content, /# footer/);
});

test('updateManagedBlock: idempotent (re-run on already-valid block)', () => {
  const before = `${BEGIN}\n${PATTERN}\n${END}\n`;
  const r1 = updateManagedBlock(before, [PATTERN]);
  assert.equal(r1.action, 'noop');
  assert.equal(r1.content, before);
});

test('updateManagedBlock: orphan begin marker → ABORT', () => {
  const before = `${BEGIN}\nfoo/\n# stuff without end marker\n`;
  const r = updateManagedBlock(before, [PATTERN]);
  assert.equal(r.action, 'abort');
  assert.match(r.error, /orphan begin marker/);
});

test('updateManagedBlock: orphan end marker → ABORT', () => {
  const before = `# stuff without begin marker\n${END}\n`;
  const r = updateManagedBlock(before, [PATTERN]);
  assert.equal(r.action, 'abort');
  assert.match(r.error, /orphan end marker/);
});

test('updateManagedBlock: duplicate begin markers → ABORT', () => {
  const before = `${BEGIN}\nfoo/\n${END}\n${BEGIN}\nbar/\n${END}\n`;
  const r = updateManagedBlock(before, [PATTERN]);
  assert.equal(r.action, 'abort');
  assert.match(r.error, /duplicate managed block/);
});

test('updateManagedBlock: markers out of order → ABORT', () => {
  const before = `${END}\nfoo/\n${BEGIN}\n`;
  const r = updateManagedBlock(before, [PATTERN]);
  assert.equal(r.action, 'abort');
  assert.match(r.error, /out of order/);
});

test('updateManagedBlock: empty patterns array → ABORT', () => {
  const r = updateManagedBlock('', []);
  assert.equal(r.action, 'abort');
});

test('updateManagedBlock: idempotency holds after replace', () => {
  const before = `${BEGIN}\nold/\n${END}\n`;
  const r1 = updateManagedBlock(before, [PATTERN]);
  assert.equal(r1.action, 'replace');
  const r2 = updateManagedBlock(r1.content, [PATTERN]);
  assert.equal(r2.action, 'noop');
});

test('updateManagedBlock: preserves user content outside markers', () => {
  const before = `# user header\nnode_modules/\n${BEGIN}\nold/\n${END}\n*.log\n# user footer\n`;
  const r = updateManagedBlock(before, [PATTERN]);
  assert.equal(r.action, 'replace');
  assert.match(r.content, /# user header/);
  assert.match(r.content, /node_modules\//);
  assert.match(r.content, /\*\.log/);
  assert.match(r.content, /# user footer/);
});

// --- EOL preservation -------------------------------------------------------
// The sync owns a marked BLOCK inside a file the consumer owns. Rewriting the
// whole file's line endings is a side effect beyond that ownership, and on a
// Windows consumer (`core.autocrlf=true`, no `.gitattributes` pin) it leaves
// the file permanently stat-dirty: `git status` reports ` M` while `git diff`
// is empty, because the normalized blob still matches. Found in a consumer
// repo 2026-08-03. Every pre-existing case above uses LF fixtures, which is
// why this survived.

const CRLF_HEADER = `# user header\r\nnode_modules/\r\n`;

test('updateManagedBlock: CRLF file stays CRLF on replace', () => {
  const before = `${CRLF_HEADER}${BEGIN}\r\nold/\r\n${END}\r\n*.log\r\n`;
  const r = updateManagedBlock(before, [PATTERN]);
  assert.equal(r.action, 'replace');
  assert.ok(r.content.includes(PATTERN));
  assert.equal(/(?<!\r)\n/.test(r.content), false, 'emitted a bare LF into a CRLF file');
});

test('updateManagedBlock: CRLF file with no markers appends a CRLF block', () => {
  const r = updateManagedBlock(CRLF_HEADER, [PATTERN]);
  assert.equal(r.action, 'create');
  assert.ok(r.content.includes(PATTERN));
  assert.equal(/(?<!\r)\n/.test(r.content), false, 'appended block used bare LF');
});

test('updateManagedBlock: LF file stays LF (no CR introduced)', () => {
  const before = `# user header\n${BEGIN}\nold/\n${END}\n*.log\n`;
  const r = updateManagedBlock(before, [PATTERN]);
  assert.equal(r.action, 'replace');
  assert.equal(r.content.includes('\r'), false);
});

test('updateManagedBlock: null content defaults to LF', () => {
  const r = updateManagedBlock(null, [PATTERN]);
  assert.equal(r.action, 'create');
  assert.equal(r.content.includes('\r'), false);
});

test('updateManagedBlock: unchanged CRLF block reports noop, not replace', () => {
  // The renormalizing version could never return `noop` for a CRLF file — every
  // EOL differed — so each sync rewrote the file and re-dirtied the worktree.
  const before = `${CRLF_HEADER}${BEGIN}\r\n${PATTERN}\r\n${END}\r\n`;
  const r = updateManagedBlock(before, [PATTERN]);
  assert.equal(r.action, 'noop');
  assert.equal(r.content, before);
});

test('updateManagedBlock: idempotency holds across a CRLF round-trip', () => {
  const before = `${CRLF_HEADER}${BEGIN}\r\nold/\r\n${END}\r\n`;
  const r1 = updateManagedBlock(before, [PATTERN]);
  assert.equal(r1.action, 'replace');
  const r2 = updateManagedBlock(r1.content, [PATTERN]);
  assert.equal(r2.action, 'noop');
  assert.equal(r2.content, r1.content);
});

test('updateManagedBlock: mixed EOLs follow the dominant convention', () => {
  // Majority CRLF wins; a stray LF must not flip the whole file to LF.
  const before = `# a\r\n# b\r\n# c\r\n# stray\n${BEGIN}\r\nold/\r\n${END}\r\n`;
  const r = updateManagedBlock(before, [PATTERN]);
  assert.equal(r.action, 'replace');
  assert.ok(r.content.startsWith('# a\r\n'));
  assert.ok(r.content.includes(`${BEGIN}\r\n${PATTERN}\r\n${END}`));
});
