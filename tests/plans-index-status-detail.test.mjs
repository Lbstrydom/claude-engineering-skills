import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractStatusDetail } from '../scripts/generate-plans-index.mjs';

/**
 * `docs/plans/README.md` is a committed, freshness-gated artefact, so a
 * rendering defect here is not cosmetic-and-local: it ships to every clone and
 * regenerates faithfully, which is exactly why the orphan bracket below
 * survived unnoticed in the index for as long as the row existed.
 *
 * The two `orphan` cases are the negative controls — both FAIL against the
 * pre-fix implementation, which stripped `(` with the leading separators and
 * `)` with a trailing-anchored replace, as two independent decisions.
 */
const plan = (status) => `# Plan: Example\n\n- **Status**: ${status}\n\n## 1. Context\n`;

describe('extractStatusDetail — parenthetical handling', () => {
  it('keeps a parenthetical that closes early intact (orphan `)` regression)', () => {
    const detail = extractStatusDetail(
      plan('Complete (cross-host unverified) — E1–E6 in §9 are NOT yet run'),
      'Complete',
    );
    assert.equal(detail, '(cross-host unverified) — E1–E6 in §9 are NOT yet run');
    assert.ok(!/^[^(]*\)/.test(detail), `orphan close bracket rendered: ${detail}`);
  });

  it('keeps a trailing parenthetical intact (orphan `(` regression)', () => {
    const detail = extractStatusDetail(plan('Complete — shipped (partly)'), 'Complete');
    assert.equal(detail, 'shipped (partly)');
  });

  it('still unwraps a detail that is wholly parenthesised', () => {
    assert.equal(
      extractStatusDetail(plan('Complete (superseded by Y)'), 'Complete'),
      'superseded by Y',
    );
  });

  it('measures nested pairs by balance, not by the first `)`', () => {
    assert.equal(
      extractStatusDetail(plan('Complete (see (2) below)'), 'Complete'),
      'see (2) below',
    );
  });

  it('leaves an unbalanced status untouched rather than guessing', () => {
    assert.equal(
      extractStatusDetail(plan('Complete (unbalanced — oops'), 'Complete'),
      '(unbalanced — oops',
    );
  });

  it('strips a plain separator detail, and yields empty for a bare token', () => {
    assert.equal(
      extractStatusDetail(plan('In Progress — Cluster B pending'), 'In Progress'),
      'Cluster B pending',
    );
    assert.equal(extractStatusDetail(plan('Complete'), 'Complete'), '');
  });

  it('escapes a pipe so a detail cannot break the markdown table', () => {
    assert.equal(
      extractStatusDetail(plan('Complete — a | b'), 'Complete'),
      String.raw`a \| b`,
    );
  });
});
