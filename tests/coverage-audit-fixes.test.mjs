/**
 * Regression tests for defects the Cluster B code audit found in the coverage work itself
 * (docs/plans/file-coverage-contract-and-csharp.md, audit-code cluster B R1). One test per fix, each stating what it
 * would have let through.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { worstToolState, projectCoverageForReview, buildCoverageReport, createCoverageRecorder } from '../scripts/lib/audit/file-coverage.mjs';
import { formatCoverageSuffix, coverageMissingNote } from '../scripts/lib/coverage-format.mjs';
import { coverageBlockFor } from '../scripts/lib/final-review/envelope.mjs';
import { buildAuditTranscript } from '../scripts/lib/audit/transcript.mjs';
import { chunkLargeFile } from '../scripts/lib/code-analysis.mjs';
import { readFilesAsAnnotatedContext, parseDiffText } from '../scripts/lib/diff-annotation.mjs';
import { commentPrefixFor } from '../scripts/lib/file-taxonomy.mjs';
import { countFindings } from '../scripts/audit-loop.mjs';

const stats = (o = {}) => ({ requested: 0, full: [], headTruncated: [], budgetOmitted: [], unreadable: [], sensitiveExcluded: [], redactionShortened: [], charsRendered: 0, charsOnDisk: 0, ...o });

describe('a state outside the closed tool vocabulary is not "not applicable" (R1-M18)', () => {
  it('an unknown state counts as failed, so it can never hide behind an optimistic non-result', () => {
    assert.equal(worstToolState(['made_up']), 'failed');
    assert.equal(worstToolState(['ok', 'made_up']), 'failed');
    assert.equal(worstToolState(['timeout', 'made_up']), 'failed', 'failed outranks timeout');
    assert.equal(worstToolState([]), 'not_applicable', 'nothing at all is still not_applicable');
  });
});

describe('absent / malformed coverage never wears a clean run\'s clothes (R1-H13)', () => {
  it('an object with no recognised status is LEDGER INVALID, not the empty string', () => {
    assert.match(formatCoverageSuffix({}), /LEDGER INVALID — no recognised status/);
    assert.match(formatCoverageSuffix({ status: 'banana' }), /LEDGER INVALID/);
  });

  it('a genuinely absent ledger stays empty (the formatter cannot know) but the banner has its own explicit note', () => {
    assert.equal(formatCoverageSuffix(null), '');
    assert.equal(formatCoverageSuffix(undefined), '');
    assert.match(coverageMissingNote, /no _coverage ledger/);
    // countFindings carries `coverage: null` for a result without one, which is what the banner keys on
    assert.equal(countFindings({ verdict: 'PASS', findings: [] }).coverage, null);
  });
});

describe('the reviewer note counts the REAL number of short files (R1-M19)', () => {
  it('"and N more" comes from the full total, not from the capped projection', () => {
    const changed = Array.from({ length: 120 }, (_, i) => `gap/f${i}.xyz`);
    const cov = buildCoverageReport({ changed, existsOnDisk: () => true });
    const proj = projectCoverageForReview(cov, { maxShown: 40 });
    assert.equal(proj.filesProjection.shortTotal, 120);
    assert.equal(proj.filesProjection.shown.length, 40);
    const block = coverageBlockFor({ rounds: [{ _coverage: proj }] });
    assert.match(block, /and 95 more/, 'listed 25 of 120 short files');
    assert.doesNotMatch(block, /and 15 more/, 'the capped-projection arithmetic (40 - 25) is exactly the bug');
  });
});

describe('the assembler projects coverage itself (R1-M7)', () => {
  it('an in-memory round with a full ledger is projected before it reaches the transcript', () => {
    const cov = buildCoverageReport({ changed: ['a.xyz', 'b.xyz'], existsOnDisk: () => true });
    const t = buildAuditTranscript({ rounds: [{ round: 1, verdict: 'PASS', findings: [], _coverage: cov }], auditMode: 'code', changedFiles: ['a.xyz'] });
    assert.equal(t.rounds[0]._coverage.files, undefined);
    assert.equal(t.rounds[0]._coverage.filesProjection.fullCount, 2);
    assert.equal(cov.files.length, 2, 'the caller\'s own object is not mutated');
  });
});

describe('the line-chunk fallback always advances (R1-H7)', () => {
  it('a tiny token budget floors to one line per chunk instead of looping forever', () => {
    const src = ['a', 'b', 'c', 'd'].join('\n');
    const chunks = chunkLargeFile(src, 'x.unknownext', 10);
    assert.equal(chunks.length, 4);
    assert.deepEqual(chunks.map((c) => c.items[0].source), ['a', 'b', 'c', 'd']);
  });
});

describe('annotation markers use the language\'s own comment syntax (R1-M5 / H11)', () => {
  const prefixes = { 'a.cs': '//', 'a.mjs': '//', 'a.go': '//', 'a.py': '#', 'a.rb': '#', 'a.sh': '#', 'a.ps1': '#', 'a.lua': '--', 'a.bat': 'REM', 'a.vue': null, 'a.svelte': null, 'a.cshtml': null, 'a.json': '//' };
  for (const [file, want] of Object.entries(prefixes)) {
    it(`${file} → ${want === null ? 'no line comment (header-only)' : `\`${want}\``}`, () => {
      assert.equal(commentPrefixFor(file), want);
    });
  }

  it('a changed Python file is annotated with `#` markers — never `//` text inside the code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-'));
    const prev = process.cwd();
    try {
      process.chdir(dir);
      fs.writeFileSync('svc.py', ['import os', 'def a():', '    return 1', 'def b():', '    return 2', ''].join('\n'));
      const diff = parseDiffText(['diff --git a/svc.py b/svc.py', '--- a/svc.py', '+++ b/svc.py', '@@ -4,1 +4,2 @@', '+def b():', '+    return 2'].join('\n'));
      const out = readFilesAsAnnotatedContext(['svc.py'], diff);
      assert.match(out, /# ── CHANGED ──/);
      assert.match(out, /# ━━━━ UNCHANGED CONTEXT — DO NOT FLAG ━━━━/);
      assert.doesNotMatch(out, /^\/\/ /m, 'no `//` marker line in a Python file');
    } finally {
      process.chdir(prev);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a C# file keeps the `//` markers (unchanged behaviour for `//` languages)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-'));
    const prev = process.cwd();
    try {
      process.chdir(dir);
      fs.writeFileSync('A.cs', ['class A', '{', '    int x;', '}', ''].join('\n'));
      const diff = parseDiffText(['diff --git a/A.cs b/A.cs', '--- a/A.cs', '+++ b/A.cs', '@@ -3,1 +3,2 @@', '+    int x;'].join('\n'));
      assert.match(readFilesAsAnnotatedContext(['A.cs'], diff), /\/\/ ── CHANGED ──/);
    } finally {
      process.chdir(prev);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a markup-embedded language gets header-only annotation — no marker injected into markup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-'));
    const prev = process.cwd();
    try {
      process.chdir(dir);
      fs.writeFileSync('Comp.vue', ['<template>', '  <div/>', '</template>', ''].join('\n'));
      const diff = parseDiffText(['diff --git a/Comp.vue b/Comp.vue', '--- a/Comp.vue', '+++ b/Comp.vue', '@@ -2,1 +2,1 @@', '+  <div/>'].join('\n'));
      const out = readFilesAsAnnotatedContext(['Comp.vue'], diff);
      assert.doesNotMatch(out, /CHANGED ──|UNCHANGED CONTEXT/);
      assert.match(out, /REVIEW ONLY THESE LINES/);
    } finally {
      process.chdir(prev);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('a partially completed map-reduce pass vouches for no file (R1-H3)', () => {
  it('the assembly marks a pass with _mapCompletionRate < 1 as not completed, so its render is not evidence', async () => {
    // Exercised through the recorder + builder contract the assembly uses: only completed passes count.
    const r = createCoverageRecorder();
    r.recordRead('backend', stats({ full: ['a.cs'] }));
    r.markPass('backend', false); // what the assembly does for `succeeded` with _mapCompletionRate 0.5
    const cov = buildCoverageReport({ changed: ['a.cs'], recorder: r, existsOnDisk: () => true });
    assert.notEqual(cov.files[0].outcome, 'audited');
    assert.equal(cov.status, 'none');
  });
});
