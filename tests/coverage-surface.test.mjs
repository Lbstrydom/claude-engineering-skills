/**
 * The surfaces that turn a `_coverage` ledger into something an operator, the convergence loop and the final
 * reviewer cannot miss (docs/plans/file-coverage-contract-and-csharp.md, Phase 4). Each test states what
 * would have let the storyline defect through: a summary line that printed a bare verdict over changed source
 * nobody had read.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatAuditSummaryLine } from '../scripts/lib/audit/findings-pipeline.mjs';
import { buildCoverageReport, createCoverageRecorder, parseNameStatusZ, projectCoverageForReview } from '../scripts/lib/audit/file-coverage.mjs';
import { formatCoverageSuffix } from '../scripts/lib/coverage-format.mjs';
import { readRoundResult } from '../scripts/lib/audit/transcript.mjs';
import { countFindings, isConverged } from '../scripts/audit-loop.mjs';

const stats = (o = {}) => ({
  requested: 0, full: [], headTruncated: [], budgetOmitted: [], unreadable: [], sensitiveExcluded: [],
  redactionShortened: [], charsRendered: 0, charsOnDisk: 0, ...o,
});
const covOf = (changed, full = [], extra = {}) => {
  const r = createCoverageRecorder();
  r.recordRead('backend', stats({ full }));
  r.markPass('backend', true);
  return buildCoverageReport({ changed, recorder: r, existsOnDisk: () => true, ...extra });
};
const base = { high: 0, medium: 0, low: 0, latencyMs: 12000 };

describe('formatAuditSummaryLine + coverage', () => {
  it('complete coverage prints byte-identical to a run with no coverage record at all', () => {
    const cov = covOf(['a.cs'], ['a.cs']);
    assert.equal(
      formatAuditSummaryLine({ ...base, verdict: 'PASS', coverage: cov }),
      formatAuditSummaryLine({ ...base, verdict: 'PASS' }),
    );
    assert.equal(formatAuditSummaryLine({ ...base, verdict: 'PASS' }), 'Verdict: PASS | H:0 M:0 L:0 | 12s');
  });

  it('partial coverage: the verdict is NEVER bare — the suffix names the unexamined files', () => {
    const cov = covOf(['a.cs', 'b.xyz'], ['a.cs']);
    const line = formatAuditSummaryLine({ ...base, verdict: 'PASS', coverage: cov });
    assert.match(line, /^Verdict: PASS \| H:0 M:0 L:0 \| 12s \| coverage: /);
    assert.match(line, /xyz ×1/);
  });

  it('a `fail` gate with every pass healthy prints INCOMPLETE and says the CHANGE was not measured', () => {
    const cov = covOf(['a.cs', 'b.cs'], []);
    assert.equal(cov.gate, 'fail');
    const line = formatAuditSummaryLine({ ...base, verdict: 'INCOMPLETE', failedPasses: [], passesTotal: 5, coverage: cov });
    assert.match(line, /^Verdict: INCOMPLETE — coverage: NONE of the 2 changed source file/);
    assert.match(line, /this round did not measure the change/);
    assert.match(line, /not evidence of cleanliness/);
    assert.doesNotMatch(line, /pass\(es\) produced output/, 'no failed passes, so it must not blame them');
  });

  it('INCOMPLETE from failed passes still says so, and carries the coverage note when there is one', () => {
    const cov = covOf(['a.cs', 'b.xyz'], ['a.cs']);
    const line = formatAuditSummaryLine({ ...base, verdict: 'INCOMPLETE', failedPasses: ['x'], passesTotal: 5, coverage: cov });
    assert.match(line, /4 of 5 pass\(es\) produced output/);
    assert.match(line, /coverage: PARTIAL/);
  });

  it('negative control: with the coverage code removed the partial case WOULD print bare (the test can fail)', () => {
    const cov = covOf(['a.cs', 'b.xyz'], ['a.cs']);
    assert.notEqual(formatAuditSummaryLine({ ...base, verdict: 'PASS', coverage: cov }), formatAuditSummaryLine({ ...base, verdict: 'PASS' }));
  });
});

describe('audit-loop convergence', () => {
  it('a round whose coverage gate failed arrives as INCOMPLETE and can never read as converged', () => {
    const counts = countFindings({ verdict: 'INCOMPLETE', findings: [], _coverage: covOf(['a.cs'], []) });
    assert.equal(counts.failed, true);
    assert.equal(isConverged(counts), false);
  });

  it('a converged round keeps its coverage, so the banner can say what was not audited', () => {
    const counts = countFindings({ verdict: 'PASS', findings: [], _coverage: covOf(['a.cs', 'b.xyz'], ['a.cs']) });
    assert.equal(isConverged(counts), true, 'partial coverage warns; it does not block convergence');
    assert.match(formatCoverageSuffix(counts.coverage), /unrecognised file type/);
  });
});

describe('the transcript hands the reviewer a projection, not the full ledger', () => {
  it('readRoundResult projects a large _coverage and keeps the canonical counts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-transcript-'));
    try {
      const changed = ['ok.cs', ...Array.from({ length: 400 }, (_, i) => `gap/f${i}.xyz`)];
      const cov = covOf(changed, ['ok.cs']);
      const file = path.join(dir, 'audit-code-1-r1-result.json');
      fs.writeFileSync(file, JSON.stringify({ verdict: 'PASS', findings: [], _coverage: cov }));
      const round = readRoundResult(file);
      assert.equal(round._coverage.files, undefined);
      assert.equal(round._coverage.filesProjection.fullCount, 401);
      assert.ok(round._coverage.filesProjection.shown.length <= 200);
      assert.equal(round._coverage.counts.short, cov.counts.short);
      assert.equal(round._coverage.gate, cov.gate);
      assert.ok(JSON.stringify(round).length < JSON.stringify({ _coverage: cov }).length * 0.6, 'and it is actually smaller (200 of 401 records kept)');
      assert.equal(projectCoverageForReview(round._coverage), round._coverage, 'projecting a projection is a no-op');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a result with no _coverage passes through untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-transcript-'));
    try {
      const file = path.join(dir, 'audit-code-1-r1-result.json');
      fs.writeFileSync(file, JSON.stringify({ verdict: 'PASS', findings: [] }));
      assert.equal(readRoundResult(file)._coverage, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('parseNameStatusZ (the VCS change record; audit-plan R3-H1)', () => {
  const z = (...tokens) => tokens.join('\0') + '\0';

  it('modify, add, delete', () => {
    assert.deepEqual(parseNameStatusZ(z('M', 'a.cs', 'A', 'b.cs', 'D', 'c.cs')), [
      { path: 'a.cs', changeKind: 'modified', renamedFrom: null },
      { path: 'b.cs', changeKind: 'added', renamedFrom: null },
      { path: 'c.cs', changeKind: 'deleted', renamedFrom: null },
    ]);
  });

  it('a rename carries BOTH endpoints; the record is the new path (the file that exists)', () => {
    assert.deepEqual(parseNameStatusZ(z('R100', 'old/Name.cs', 'new/Name.cs', 'M', 'x.cs')), [
      { path: 'new/Name.cs', changeKind: 'renamed', renamedFrom: 'old/Name.cs' },
      { path: 'x.cs', changeKind: 'modified', renamedFrom: null },
    ]);
  });

  it('paths with spaces, quotes and newlines survive (a newline-split --name-only parse loses them)', () => {
    const out = parseNameStatusZ(z('M', 'dir with space/a "q".cs', 'M', 'weird\nname.cs'));
    assert.deepEqual(out.map((r) => r.path), ['dir with space/a "q".cs', 'weird\nname.cs']);
  });

  it('empty input is an empty list; a truncated or mis-arity stream THROWS (a short list must not read as complete)', () => {
    assert.deepEqual(parseNameStatusZ(''), []);
    assert.deepEqual(parseNameStatusZ(null), []);
    assert.throws(() => parseNameStatusZ('M'), /NUL-terminated/);
    assert.throws(() => parseNameStatusZ('M\0a.cs'), /NUL-terminated/);
    assert.throws(() => parseNameStatusZ('R100\0old.cs\0'), /missing path/);
    assert.throws(() => parseNameStatusZ('M\0\0'), /empty path/);
    assert.throws(() => parseNameStatusZ('\0M\0a.cs\0'), /no status code/);
  });
});
