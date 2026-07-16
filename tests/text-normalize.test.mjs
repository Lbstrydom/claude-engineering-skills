import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeWhitespace } from '../scripts/lib/text-normalize.mjs';

describe('normalizeWhitespace', () => {
  it('collapses whitespace runs to a single space', () => {
    assert.equal(normalizeWhitespace('foo   bar\t\tbaz'), 'foo bar baz');
  });

  it('collapses newlines', () => {
    assert.equal(normalizeWhitespace('foo\n  bar\n\nbaz'), 'foo bar baz');
  });

  it('trims leading/trailing whitespace', () => {
    assert.equal(normalizeWhitespace('  foo bar  '), 'foo bar');
  });

  it('handles null/undefined/empty as empty string', () => {
    assert.equal(normalizeWhitespace(null), '');
    assert.equal(normalizeWhitespace(undefined), '');
    assert.equal(normalizeWhitespace(''), '');
  });

  it('coerces non-string input', () => {
    assert.equal(normalizeWhitespace(42), '42');
  });

  it('coerces falsy non-nullish values (0, false) to their string form, not empty string (audit-code round-1 L2/L4)', () => {
    assert.equal(normalizeWhitespace(0), '0');
    assert.equal(normalizeWhitespace(false), 'false');
  });
});
