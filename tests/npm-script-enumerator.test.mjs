/**
 * @fileoverview Unit tests for the npm-script enumerator.
 * Plan §7 R1 M4 + R2 H4.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateNpmRunRefs } from '../scripts/lib/npm-script-enumerator.mjs';

test('extracts simple npm run X reference', () => {
  assert.deepEqual(enumerateNpmRunRefs('Run `npm run audit` first'), ['audit']);
});

test('extracts colon-namespaced refs (npm run arch:refresh)', () => {
  assert.deepEqual(enumerateNpmRunRefs('npm run arch:refresh'), ['arch:refresh']);
});

test('extracts multiple refs deduplicated and sorted', () => {
  const input = `
    npm run audit-loop
    npm run audit
    npm run audit
    npm run arch:refresh
  `;
  assert.deepEqual(enumerateNpmRunRefs(input), ['arch:refresh', 'audit', 'audit-loop']);
});

test('handles hyphenated and dotted script names', () => {
  assert.deepEqual(
    enumerateNpmRunRefs('npm run db.check.drift\nnpm run skills-regenerate'),
    ['db.check.drift', 'skills-regenerate'],
  );
});

test('returns empty array on non-string input', () => {
  assert.deepEqual(enumerateNpmRunRefs(null), []);
  assert.deepEqual(enumerateNpmRunRefs(undefined), []);
  assert.deepEqual(enumerateNpmRunRefs(42), []);
});

test('returns empty array when no matches', () => {
  assert.deepEqual(enumerateNpmRunRefs('Just some prose with no npm commands.'), []);
});

test('handles tabs and varied whitespace', () => {
  assert.deepEqual(enumerateNpmRunRefs('npm\trun\tfoo'), ['foo']);
  assert.deepEqual(enumerateNpmRunRefs('npm  run  bar'), ['bar']);
});

test('R1 M1: trailing prose punctuation excluded (no `audit.`)', () => {
  // Prose end-of-sentence dot must NOT be captured.
  assert.deepEqual(enumerateNpmRunRefs('Run `npm run audit`.'), ['audit']);
  assert.deepEqual(enumerateNpmRunRefs('Run npm run audit.'), ['audit']);
  assert.deepEqual(enumerateNpmRunRefs('Run npm run audit-loop.'), ['audit-loop']);
});
