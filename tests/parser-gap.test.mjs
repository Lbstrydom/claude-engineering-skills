/**
 * The parser-gap diagnosis (scripts/lib/symbol-index/parser-gap.mjs): it must
 * name the missing parser AND the remedy for that extension.
 * Plan: docs/plans/python-arch-memory-indexing.md §2.4.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeParserGap, remedyFor } from '../scripts/lib/symbol-index/parser-gap.mjs';

describe('describeParserGap', () => {
  it('is silent when nothing is missing', () => {
    assert.deepEqual(describeParserGap(null), []);
    assert.deepEqual(describeParserGap({ known: true, unparseable: 0, byExtension: {} }), []);
  });

  it('says it could not ask, rather than reporting clean, when availability is unknown', () => {
    const [line] = describeParserGap({ known: false, unparseable: null, byExtension: {} });
    assert.match(line, /could not ask/);
  });

  it('names a missing Python interpreter and its remedy', () => {
    const [line] = describeParserGap({ known: true, unparseable: 3, byExtension: { '.py': 3 } });
    assert.match(line, /\.py \(3\)/);
    assert.match(line, /UNMEASURED, not clean/);
    assert.match(line, /ARCH_INDEX_PYTHON/);
  });

  it('keeps the TypeScript remedy for .ts, and lists both when both are missing', () => {
    const [line] = describeParserGap({ known: true, unparseable: 5, byExtension: { '.ts': 4, '.py': 1 } });
    assert.match(line, /\.ts \(4\), \.py \(1\)/);
    assert.match(line, /typescript/);
    assert.match(line, /Python >= 3\.9/);
  });

  it('never emits the `from "<word>"` shape the import scanner misreads', () => {
    for (const ext of ['.py', '.ts', '.vue']) assert.doesNotMatch(remedyFor(ext), /from\s+["']/);
  });
});
