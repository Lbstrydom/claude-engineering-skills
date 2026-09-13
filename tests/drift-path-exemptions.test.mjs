/**
 * @fileoverview Unit tests (Tier 1, pure module) for `isDriftPathExempt` —
 * the structural, path-based counterpart to the `@duplicate-justification`
 * pragma for directories the pragma sweep can never reach (tests/*).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DRIFT_PATH_EXEMPT_PREFIXES, isDriftPathExempt } from '../scripts/lib/symbol-index/drift-path-exemptions.mjs';

describe('isDriftPathExempt', () => {
  test('matches a file inside the declared exempt directory', () => {
    assert.equal(
      isDriftPathExempt('tests/fixtures/anchor-contract/files/scripts/lib/vcs.mjs'),
      true,
    );
  });

  test('does not match the real source file the fixture mirrors', () => {
    assert.equal(isDriftPathExempt('scripts/lib/vcs.mjs'), false);
  });

  test('does not match a sibling fixture directory with a similar prefix', () => {
    // `tests/fixtures/anchor-contract-other/` shares a text prefix with the
    // real exempt path up to "anchor-contract" but is NOT the same directory
    // — a naive substring check would wrongly admit it.
    assert.equal(
      isDriftPathExempt('tests/fixtures/anchor-contract-other/files/x.mjs'),
      false,
    );
  });

  test('does not match a bare prefix with no trailing content', () => {
    assert.equal(isDriftPathExempt('tests/fixtures/anchor-contract/files'), false);
  });

  test('normalises Windows-style backslash separators before matching', () => {
    assert.equal(
      isDriftPathExempt('tests\\fixtures\\anchor-contract\\files\\scripts\\lib\\ast.mjs'),
      true,
    );
  });

  test('is false for null/undefined/empty input, never throws', () => {
    for (const v of [null, undefined, '']) {
      assert.equal(isDriftPathExempt(v), false);
    }
  });

  test('DRIFT_PATH_EXEMPT_PREFIXES is frozen — an accidental mutation cannot silently widen the exemption', () => {
    assert.ok(Object.isFrozen(DRIFT_PATH_EXEMPT_PREFIXES));
  });
});
