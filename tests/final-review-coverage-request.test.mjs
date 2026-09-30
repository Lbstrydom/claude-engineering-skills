/**
 * @fileoverview The final reviewer must SEE the changed C# — and be told what the audit did not examine.
 *
 * The defect (storyline, 2026-09-30): twelve `.cs` files were changed, none audited, and the reviewer approved
 * a transcript that said nothing about them. Two things have to be true of the REQUEST that leaves the process
 * (not of an intermediate result, which is where a contract like this usually goes green while still broken):
 *
 *   1. an admitted `.cs` file in `code_files` has its content in the request body;
 *   2. the last round's `_coverage` is in the request, as an explicit "Audit Coverage" note naming what was NOT
 *      examined, and the note is absent when coverage is complete (a clean run's request is unchanged).
 *
 * docs/plans/file-coverage-contract-and-csharp.md (audit-plan R1-H5).
 */
process.env.FINAL_REVIEW_MODEL = 'test-model';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runFinalReview } = await import('../scripts/gemini-review.mjs');
const { buildCoverageReport, createCoverageRecorder, projectCoverageForReview } = await import('../scripts/lib/audit/file-coverage.mjs');
const { coverageBlockFor } = await import('../scripts/lib/final-review/envelope.mjs');

const VALID_REVIEW = JSON.stringify({
  verdict: 'APPROVE',
  deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'ok' },
  new_findings: [], wrongly_dismissed: [], over_engineering_flags: [],
  architectural_coherence: 'Strong', overall_reasoning: 'ok',
});

const stats = (o = {}) => ({
  requested: 0, full: [], headTruncated: [], budgetOmitted: [], unreadable: [], sensitiveExcluded: [],
  redactionShortened: [], charsRendered: 0, charsOnDisk: 0, ...o,
});

function coverageFor(changed, read) {
  const r = createCoverageRecorder();
  r.recordRead('backend', stats({ full: read }));
  r.markPass('backend', true);
  return buildCoverageReport({ changed, recorder: r, existsOnDisk: () => true });
}

function fakeClient(sink) {
  return {
    chat: { completions: { create: async (body) => {
      sink.request = body.messages.find((m) => m.role === 'user')?.content ?? '';
      return { choices: [{ message: { content: VALID_REVIEW }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } } },
  };
}

describe('the request that reaches the reviewer', () => {
  let dir; let prevCwd;
  before(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'fr-coverage-request-'));
    mkdirSync(join(dir, 'svc'), { recursive: true });
    writeFileSync(join(dir, 'svc', 'Layout.cs'), '// CSHARP_LAYOUT_MARKER\npublic sealed class Layout { }\n');
    process.chdir(dir);
  });
  after(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('a C#-only change: the .cs content AND the partial-coverage note are in the request body', async () => {
    const sink = {};
    // Two files changed; only Layout.cs was audited, the .xyz file was never recognised.
    const cov = coverageFor(['svc/Layout.cs', 'svc/notes.xyz'], ['svc/Layout.cs']);
    assert.equal(cov.status, 'partial');
    const transcript = JSON.stringify({
      audit_mode: 'code',
      rounds: [{ round: 1, verdict: 'PASS', findings: [], _coverage: projectCoverageForReview(cov) }],
      code_files: ['svc/Layout.cs'],
      changed_files: ['svc/Layout.cs', 'svc/notes.xyz'],
    });
    const { result } = await runFinalReview('openai-compatible', fakeClient(sink), 'Plan text.', transcript, 'ctx', 'code');
    assert.equal(result.verdict, 'APPROVE');
    assert.ok(sink.request, 'the adapter received the envelope');
    assert.match(sink.request, /CSHARP_LAYOUT_MARKER/, 'the admitted .cs file content is in the request');
    assert.match(sink.request, /## Audit Coverage/, 'the coverage note is in the request');
    assert.match(sink.request, /svc\/notes\.xyz — not-admitted \[unrecognised file type\]/, 'and it NAMES the unexamined file');
    assert.match(sink.request, /do not describe unexamined code as verified/);
  });

  test('negative control: a fully covered run adds NO coverage note — the request is unchanged', async () => {
    const sink = {};
    const cov = coverageFor(['svc/Layout.cs'], ['svc/Layout.cs']);
    assert.equal(cov.status, 'complete');
    const transcript = JSON.stringify({
      audit_mode: 'code',
      rounds: [{ round: 1, verdict: 'PASS', findings: [], _coverage: projectCoverageForReview(cov) }],
      code_files: ['svc/Layout.cs'], changed_files: ['svc/Layout.cs'],
    });
    await runFinalReview('openai-compatible', fakeClient(sink), 'Plan text.', transcript, 'ctx', 'code');
    assert.match(sink.request, /CSHARP_LAYOUT_MARKER/);
    assert.doesNotMatch(sink.request, /## Audit Coverage/);
  });

  test('a transcript with no _coverage at all (a pre-contract run) adds no note either', async () => {
    const sink = {};
    const transcript = JSON.stringify({ audit_mode: 'code', rounds: [{ round: 1, findings: [] }], code_files: ['svc/Layout.cs'], changed_files: ['svc/Layout.cs'] });
    await runFinalReview('openai-compatible', fakeClient(sink), 'Plan text.', transcript, 'ctx', 'code');
    assert.doesNotMatch(sink.request, /## Audit Coverage/);
  });
});

describe('coverageBlockFor', () => {
  test('uses the LATEST round that carries a _coverage', () => {
    const early = coverageFor(['a.cs'], []);
    const late = coverageFor(['a.cs'], ['a.cs']);
    const block = coverageBlockFor({ rounds: [{ _coverage: early }, { findings: [] }, { _coverage: late }] });
    assert.equal(block, '', 'the later, complete coverage wins over the earlier gap');
    assert.match(coverageBlockFor({ rounds: [{ _coverage: late }, { _coverage: early }] }), /NONE of the 1 changed source/);
  });

  test('a gate `fail` names the round as INCOMPLETE territory and lists the file', () => {
    const cov = coverageFor(['a.cs', 'b.cs'], []);
    const block = coverageBlockFor({ rounds: [{ _coverage: cov }] });
    assert.match(block, /gate: fail/);
    assert.match(block, /- a\.cs — unreadable/);
  });

  test('an incomplete (invalid) ledger is surfaced, never swallowed', () => {
    const cov = buildCoverageReport({ changed: ['a/b.cs', 'a\\b.cs'] });
    assert.equal(cov.status, 'incomplete');
    assert.match(coverageBlockFor({ rounds: [{ _coverage: cov }] }), /LEDGER INVALID/);
  });
});
