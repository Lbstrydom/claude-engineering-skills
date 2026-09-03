import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractStatusDetail } from '../scripts/generate-plans-index.mjs';
import { parsePlanStatus } from '../scripts/lib/plan-status.mjs';

/**
 * `docs/plans/README.md` is a committed, freshness-gated artefact, so a
 * rendering defect here is not cosmetic-and-local: it ships to every clone and
 * regenerates faithfully, which is why the orphan bracket below went unnoticed
 * for as long as the rows existed.
 *
 * Every case runs the REAL pipeline — `parsePlanStatus` produces the `raw` the
 * index actually renders — rather than handing `extractStatusDetail` a value
 * assembled by the test. A test that builds its own input can only confirm the
 * reader against the shape the reader expects.
 */
const plan = (status) => `# Plan: Example\n\n- **Status**: ${status}\n\n## 1. Context\n`;

const detailOf = (status) => {
  const parsed = parsePlanStatus(plan(status));
  assert.equal(parsed.ok, true, `status did not parse: ${status}`);
  return extractStatusDetail(parsed.raw, parsed.token);
};

describe('extractStatusDetail — parenthetical handling', () => {
  it('keeps a parenthetical that closes early intact (orphan `)` regression)', () => {
    const detail = detailOf('Complete (cross-host unverified) — E1–E6 in §9 are NOT yet run');
    assert.equal(detail, '(cross-host unverified) — E1–E6 in §9 are NOT yet run');
    assert.ok(!/^[^(]*\)/.test(detail), `orphan close bracket rendered: ${detail}`);
  });

  it('keeps a trailing parenthetical intact (orphan `(` regression)', () => {
    assert.equal(detailOf('Complete — shipped (partly)'), 'shipped (partly)');
  });

  it('still unwraps a detail that is wholly parenthesised', () => {
    assert.equal(detailOf('Complete (superseded by Y)'), 'superseded by Y');
  });

  it('measures nested pairs by balance, not by the first `)`', () => {
    assert.equal(detailOf('Complete (see (2) below)'), 'see (2) below');
  });

  it('leaves an unbalanced status untouched rather than guessing', () => {
    assert.equal(detailOf('Complete (unbalanced — oops'), '(unbalanced — oops');
  });

  it('strips a plain separator detail, and yields empty for a bare token', () => {
    assert.equal(detailOf('In Progress — Cluster B pending'), 'Cluster B pending');
    assert.equal(detailOf('Complete'), '');
  });

  it('escapes a pipe so a detail cannot break the markdown table', () => {
    assert.equal(detailOf('Complete — a | b'), String.raw`a \| b`);
  });
});

describe('extractStatusDetail — wrapped Status lines', () => {
  it('carries an indented continuation into the detail', () => {
    const content = [
      '# Plan: Example',
      '',
      '- **Status**: Complete — first line of the reason,',
      '  continued on a second line,',
      '  and a third.',
      '- **Author**: Someone',
      '',
      '## 1. Context',
    ].join('\n');
    const parsed = parsePlanStatus(content);
    assert.equal(parsed.ok, true);
    assert.equal(
      extractStatusDetail(parsed.raw, parsed.token),
      'first line of the reason, continued on a second line, and a third.',
    );
  });

  it('does NOT fold an unindented following metadata field', () => {
    // 7 plans in this corpus put `Date:` / `**Owner**:` / `**Scope**:` on the
    // next line, unindented. Folding those would attribute one field to another.
    const content = [
      '# Plan: Example',
      '',
      '- **Status**: Complete — the real reason',
      'Date: 2026-07-13',
      '',
      '## 1. Context',
    ].join('\n');
    const parsed = parsePlanStatus(content);
    assert.equal(parsed.ok, true);
    assert.equal(extractStatusDetail(parsed.raw, parsed.token), 'the real reason');
  });

  it('leaves a nested sub-bullet as its own item', () => {
    const content = [
      '# Plan: Example',
      '',
      '- **Status**: Complete — top level only',
      '  - a nested bullet',
      '',
      '## 1. Context',
    ].join('\n');
    const parsed = parsePlanStatus(content);
    assert.equal(parsed.ok, true);
    assert.equal(extractStatusDetail(parsed.raw, parsed.token), 'top level only');
  });
  it('still reports a duplicate Status line even when the second is indented', () => {
    // Folding must not swallow a second Status line: check-plan-status FAILS on
    // `duplicate`, so absorbing one would convert a hard failure into a pass.
    const content = [
      '# Plan: Example',
      '',
      '- **Status**: Complete — one',
      '  **Status**: In Progress — two',
      '',
      '## 1. Context',
    ].join('\n');
    const parsed = parsePlanStatus(content);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'duplicate');
    assert.deepEqual(parsed.rawStatusValues, ['Complete — one', 'In Progress — two']);
  });

  it('still folds a continuation that merely starts with bold', () => {
    const content = [
      '# Plan: Example',
      '',
      '- **Status**: Complete — one',
      '  **Round 2**: a later audit round',
      '',
      '## 1. Context',
    ].join('\n');
    const parsed = parsePlanStatus(content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.raw, 'Complete — one **Round 2**: a later audit round');
  });
});
