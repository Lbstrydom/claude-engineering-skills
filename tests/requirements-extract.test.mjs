/**
 * Tests for scripts/lib/requirements/extract.mjs — the pure merge + id logic.
 * (The LLM call itself is exercised by a live `requirements extract` run,
 * not unit-tested.) Plan: docs/plans/requirements-layer.md — Plan-Phase A.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assignId, mergeRequirements, extractRequirements } from '../scripts/lib/requirements/extract.mjs';

function raw(over = {}) {
  return {
    assertion: 'The inventory excludes sensitive paths.', kind: 'security',
    checkable: true, provenance: [{ file: 'a.mjs', anchor: 'fn' }],
    appliesTo: [], evidence: { code: [], tests: [] }, ...over,
  };
}

describe('assignId', () => {
  it('is content-derived and deterministic', () => {
    const a = assignId({ kind: 'security', assertion: 'X must hold.', provenance: [{ file: 'a.mjs' }] });
    const b = assignId({ kind: 'security', assertion: 'X must hold.', provenance: [{ file: 'a.mjs' }] });
    assert.equal(a, b);
    assert.match(a, /^REQ-security-[0-9a-f]{8}$/);
  });
  it('differs when content differs', () => {
    const a = assignId({ kind: 'security', assertion: 'X must hold.', provenance: [{ file: 'a.mjs' }] });
    const b = assignId({ kind: 'security', assertion: 'Y must hold.', provenance: [{ file: 'a.mjs' }] });
    assert.notEqual(a, b);
  });
  it('is insensitive to trivial whitespace/punctuation', () => {
    const a = assignId({ kind: 'safety', assertion: 'X holds', provenance: [{ file: 'a.mjs' }] });
    const b = assignId({ kind: 'safety', assertion: '  X   holds.  ', provenance: [{ file: 'a.mjs' }] });
    assert.equal(a, b);
  });
});

describe('mergeRequirements', () => {
  it('merges an identical assertion across 2 runs → seenInRuns:2, confidence:high', () => {
    const merged = mergeRequirements([[raw()], [raw()]], 2);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].seenInRuns, 2);
    assert.equal(merged[0].confidence, 'high');
    assert.match(merged[0].id, /^REQ-security-/);
  });
  it('keeps a run-1-only assertion as seenInRuns:1, confidence:low', () => {
    const merged = mergeRequirements([[raw()], [raw({ assertion: 'A totally different unrelated correctness invariant about parsing.' })]], 2);
    assert.equal(merged.length, 2);
    const solo = merged.find((m) => m.assertion.includes('parsing'));
    assert.equal(solo.seenInRuns, 1);
    assert.equal(solo.confidence, 'low');
  });
  it('never merges across different kinds even with similar text', () => {
    const merged = mergeRequirements([
      [raw({ kind: 'security' })],
      [raw({ kind: 'correctness' })],
    ], 2);
    assert.equal(merged.length, 2);
  });
  it('unions provenance / appliesTo / evidence across the cluster', () => {
    const merged = mergeRequirements([
      [raw({ provenance: [{ file: 'a.mjs', anchor: 'f1' }], appliesTo: ['a/**'] })],
      [raw({ provenance: [{ file: 'b.mjs', anchor: 'f2' }], appliesTo: ['b/**'] })],
    ], 2);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].provenance.length, 2);
    assert.deepEqual(merged[0].appliesTo.sort(), ['a/**', 'b/**']);
  });
});

// The sensitive-egress + repo-containment guards run BEFORE any file read or
// LLM call, so they are unit-testable without the network (audit M8 — these
// security paths previously had no direct regression coverage).
describe('extractRequirements — input guards (audit H2/H4/M8)', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-extract-'));

  it('rejects a path that escapes the repo root', async () => {
    await assert.rejects(
      extractRequirements({ files: ['../../etc/passwd'], baseDir, runs: 1 }),
      /escapes the repo root/,
    );
  });
  it('rejects a sensitive path before reading or sending it', async () => {
    await assert.rejects(
      extractRequirements({ files: ['.env'], baseDir, runs: 1 }),
      /sensitive path/,
    );
  });
  it('rejects a non-existent in-repo file with a clear error', async () => {
    await assert.rejects(
      extractRequirements({ files: ['does-not-exist.mjs'], baseDir, runs: 1 }),
      /file not found/,
    );
  });
  it('rejects an empty file set', async () => {
    await assert.rejects(extractRequirements({ files: [], baseDir, runs: 1 }), /files required/);
  });
});
