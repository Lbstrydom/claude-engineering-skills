/**
 * Workflow-command data and property escaping (the Actions toolkit rules), used for every untrusted string that can reach
 * stdout or a ::notice line in CI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeData, escapeProperty } from '../scripts/lib/gate-provenance/actions-escape.mjs';

test('escapeData: percent, CR and LF', () => {
  assert.equal(escapeData('100% a\r\nb'), '100%25 a%0D%0Ab');
  assert.equal(escapeData('a\n::error::x'), 'a%0A::error::x');
  assert.equal(escapeData('plain'), 'plain');
  assert.equal(escapeData(undefined), '');
  assert.equal(escapeData(42), '42');
});

test('escapeProperty: data escapes plus colon and comma', () => {
  assert.equal(escapeProperty('t: a,b%\n'), 't%3A a%2Cb%25%0A');
});

test('percent is escaped FIRST, so an escape is never double-decoded into a newline', () => {
  assert.equal(escapeData('%0A'), '%250A');
});
