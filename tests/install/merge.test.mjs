import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBlock, extractBlock, START_MARKER, END_MARKER } from '../../scripts/lib/install/merge.mjs';

describe('block-marker merge', () => {
  it('creates file with block when no existing content', () => {
    const result = mergeBlock(null);
    assert.ok(result.includes(START_MARKER));
    assert.ok(result.includes(END_MARKER));
    assert.ok(result.includes('Engineering Skills Bundle'));
  });

  it('appends block to existing content without markers', () => {
    const existing = '# My Project\n\nSome instructions here.';
    const result = mergeBlock(existing);
    assert.ok(result.startsWith('# My Project'));
    assert.ok(result.includes(START_MARKER));
    assert.ok(result.includes('Some instructions here.'));
  });

  it('replaces only content between markers', () => {
    const existing = `Before content\n\n${START_MARKER}\nOLD CONTENT\n${END_MARKER}\n\nAfter content`;
    const result = mergeBlock(existing);
    assert.ok(result.includes('Before content'));
    assert.ok(result.includes('After content'));
    assert.ok(!result.includes('OLD CONTENT'));
    assert.ok(result.includes('Engineering Skills Bundle'));
  });

  it('preserves operator content outside markers', () => {
    const existing = `# Custom\n\nMy rules.\n\n${START_MARKER}\nold\n${END_MARKER}\n\n## More rules`;
    const result = mergeBlock(existing);
    assert.ok(result.includes('# Custom'));
    assert.ok(result.includes('My rules.'));
    assert.ok(result.includes('## More rules'));
  });
});

describe('extractBlock', () => {
  it('extracts block from content', () => {
    const content = `before\n${START_MARKER}\nmanaged\n${END_MARKER}\nafter`;
    const block = extractBlock(content);
    assert.ok(block.startsWith(START_MARKER));
    assert.ok(block.endsWith(END_MARKER));
  });

  it('returns null when no markers', () => {
    assert.equal(extractBlock('no markers here'), null);
  });
});
