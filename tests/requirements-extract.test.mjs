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
import { assignId, mergeRequirements, extractRequirements, splitOversizedFile, computeCovered } from '../scripts/lib/requirements/extract.mjs';
import { estimateTokens } from '../scripts/lib/repo-context.mjs';

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

// ── Oversized files: split, never refuse, never partially cover ─────────────
//
// The budget refused any single file over 18K tokens with "split or exclude
// them". Refusing beat truncating, but it made FILE SIZE decide whether a
// module's invariants could exist in the ledger at all — and size correlates
// with invariant density. Measured 2026-08-12: store/runs-findings.mjs (~23.6K)
// and store/plans-ship.mjs (~20.0K), which between them own the findings
// upsert, the write receipts, the fingerprint oracle and the upsertPlan result
// contract, were absent from a 269-entry ledger for that reason alone.
describe('splitOversizedFile', () => {
  const build = (decls) => decls.map((d, i) => `export function f${i}() {\n${d}\n}`).join('\n');

  it('is LOSSLESS — rejoining the parts reproduces the file exactly', () => {
    // The assertion that matters most: a lossy split silently drops code, and
    // the invariants in the dropped region simply never appear. Nothing
    // downstream could detect that.
    const body = build(Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i}; // ${'pad '.repeat(40)}`));
    const parts = splitOversizedFile({ file: 'a.mjs', body }, 500);
    assert.ok(parts.length > 1, 'the fixture must actually split');
    assert.equal(parts.map((p) => p.body).join('\n'), body);
  });

  it('every part fits the budget, which is the point of splitting', () => {
    const body = build(Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i}; // ${'pad '.repeat(40)}`));
    const parts = splitOversizedFile({ file: 'a.mjs', body }, 500);
    for (const p of parts) assert.ok(estimateTokens(p.body) <= 500, `part ${p.part} still over budget`);
  });

  it('parts keep the REAL file path, so provenance is unaffected', () => {
    const body = build(Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i}; // ${'pad '.repeat(40)}`));
    const parts = splitOversizedFile({ file: 'scripts/lib/store/big.mjs', body }, 500);
    for (const p of parts) assert.equal(p.file, 'scripts/lib/store/big.mjs');
    assert.deepEqual([...new Set(parts.map((p) => p.parts))], [parts.length]);
  });

  it('splits AT declaration boundaries, not mid-construct', () => {
    // A fragment cut through a function body carries no invariant, so the
    // extractor would be reading noise. Each part must start at a top-level
    // declaration (or be the first part).
    const body = build(Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i}; // ${'pad '.repeat(40)}`));
    const parts = splitOversizedFile({ file: 'a.mjs', body }, 500);
    for (const p of parts.slice(1)) {
      assert.match(p.body.split('\n')[0], /^(export|function|const|class|\/\*\*)/,
        `part ${p.part} starts mid-construct`);
    }
  });
});

describe('computeCovered — all-or-nothing per file', () => {
  it('a file whose parts ALL succeeded is covered', () => {
    const covered = computeCovered(new Map([['a.mjs', 3]]), new Map([['a.mjs', 3]]));
    assert.deepEqual(covered, ['a.mjs']);
  });

  it('a PARTIALLY extracted file is NOT covered — that is silent data loss', () => {
    // reconcile scoped-REPLACES a covered file's requirements, so marking this
    // covered would delete the invariants the missing part carries.
    const covered = computeCovered(new Map([['a.mjs', 3]]), new Map([['a.mjs', 2]]));
    assert.deepEqual(covered, [], 'a 2-of-3 extraction must not replace the file\'s requirements');
  });

  it('one file failing does not un-cover an unrelated file that succeeded', () => {
    const covered = computeCovered(
      new Map([['a.mjs', 2], ['b.mjs', 1]]),
      new Map([['a.mjs', 1], ['b.mjs', 1]]),
    );
    assert.deepEqual(covered, ['b.mjs']);
  });
});
