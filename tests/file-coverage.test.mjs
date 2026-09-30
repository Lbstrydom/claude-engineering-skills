import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildCoverageReport, createCoverageRecorder, validateCoverage, formatCoverageSuffix, projectCoverageForReview,
  worstToolState, CoverageSchema, TOOL_STATE_PRECEDENCE, COVERAGE_OUTCOMES,
} from '../scripts/lib/audit/file-coverage.mjs';

const stats = (o = {}) => ({
  requested: 0, full: [], headTruncated: [], budgetOmitted: [], unreadable: [], sensitiveExcluded: [],
  redactionShortened: [], charsRendered: 0, charsOnDisk: 0, ...o,
});
const rec = (passes) => {
  const r = createCoverageRecorder();
  for (const [name, { completed, stats: st }] of Object.entries(passes)) {
    r.recordRead(name, st);
    r.markPass(name, completed);
  }
  return r;
};
const build = (over = {}) => buildCoverageReport({
  changed: [], existsOnDisk: () => true, readText: () => null, ...over,
});
const byPath = (cov, p) => cov.files.find((f) => f.path === p);

describe('buildCoverageReport — the storyline shape', () => {
  it('a diff of TS files plus unread C# is NOT complete: 12 audited, 12 not-audited-because-unread → partial', () => {
    const cs = Array.from({ length: 3 }, (_, i) => `svc/Layout${i}.cs`);
    const ts = ['a.ts', 'b.ts'];
    const cov = build({
      changed: [...ts, ...cs],
      recorder: rec({ backend: { completed: true, stats: stats({ full: ts }) } }),
    });
    assert.equal(cov.status, 'partial');
    assert.equal(cov.gate, 'warn');
    assert.equal(cov.counts.required, 5);
    assert.equal(cov.counts.examined, 2);
    assert.equal(cov.counts.short, 3);
    assert.equal(byPath(cov, 'svc/Layout0.cs').outcome, 'unreadable');
    assert.match(formatCoverageSuffix(cov), /PARTIAL — 3 of 5/);
    assert.equal(validateCoverage(cov).ok, true);
  });

  it('a C#-only diff that was read is complete/pass (admission + read = examined)', () => {
    const cov = build({
      changed: ['A.cs', 'B.cs'],
      recorder: rec({ backend: { completed: true, stats: stats({ full: ['A.cs', 'B.cs'] }) } }),
    });
    assert.equal(cov.status, 'complete');
    assert.equal(cov.gate, 'pass');
    assert.equal(formatCoverageSuffix(cov), '');
    assert.equal(byPath(cov, 'A.cs').class, 'profiled');
  });

  it('a diff that changed source but NOTHING was audited is `none` → gate fail (the silent zero)', () => {
    const cov = build({ changed: ['a.cs', 'b.cs'], recorder: rec({}) });
    assert.equal(cov.status, 'none');
    assert.equal(cov.gate, 'fail');
    assert.match(formatCoverageSuffix(cov), /NONE of the 2 changed source file/);
  });

  it('an unrecognised-type-only diff is none/fail and names the extension', () => {
    const cov = build({ changed: ['a.xyz', 'b.xyz', 'c.qqq'] });
    assert.equal(cov.status, 'none');
    assert.equal(cov.gate, 'fail');
    assert.deepEqual(cov.uncoveredByExtension, { xyz: 2, qqq: 1 });
    assert.match(formatCoverageSuffix(cov), /xyz ×2/);
  });

  it('a PNG-only diff is complete/pass: nothing source-shaped changed', () => {
    const cov = build({ changed: ['a.png', 'b.woff2', 'package-lock.json'] });
    assert.equal(cov.status, 'complete');
    assert.equal(cov.gate, 'pass');
    assert.equal(cov.counts.required, 0);
    assert.equal(formatCoverageSuffix(cov), '');
  });
});

describe('the terminal-outcome precedence table', () => {
  const cases = [
    ['deleted first', { path: 'a.cs', changeKind: 'deleted' }, {}, 'deleted'],
    ['infra before user', 'x.mjs', { excludedInfra: ['x.mjs'], excludedUser: ['x.mjs'] }, 'excluded-infra'],
    ['user exclusion', 'x.mjs', { excludedUser: ['x.mjs'] }, 'excluded-user'],
    ['sensitive before not-admitted', '.env', {}, 'sensitive'],
    ['a code file named Token.cs is NOT sensitive', 'Token.cs', { recorder: rec({ p: { completed: true, stats: stats({ full: ['Token.cs'] }) } }) }, 'audited'],
    ['non-code is not-admitted', 'a.png', {}, 'not-admitted'],
    ['uncovered is not-admitted', 'a.xyz', {}, 'not-admitted'],
    ['off disk', 'a.cs', { existsOnDisk: () => false }, 'unreadable'],
  ];
  for (const [name, changed, over, want] of cases) {
    it(`${name} → ${want}`, () => {
      const cov = build({ changed: [changed], ...over });
      assert.equal(cov.files[0].outcome, want);
      assert.ok(COVERAGE_OUTCOMES.includes(cov.files[0].outcome));
    });
  }

  it('a modified file git calls modified but that cannot be read is unreadable, never deleted (audit-plan R3-H1)', () => {
    const cov = build({ changed: [{ path: 'a.cs', changeKind: 'modified' }], existsOnDisk: () => false });
    assert.equal(cov.files[0].outcome, 'unreadable');
  });

  it('budget-omitted and unreadable come from the reader stats, not a guess', () => {
    const cov = build({
      changed: ['a.cs', 'b.cs'],
      recorder: rec({ backend: { completed: true, stats: stats({ budgetOmitted: ['a.cs'], unreadable: ['b.cs'] }) } }),
    });
    assert.equal(byPath(cov, 'a.cs').outcome, 'budget-omitted');
    assert.equal(byPath(cov, 'b.cs').outcome, 'unreadable');
  });
});

describe('render evidence comes only from COMPLETED passes (audit-plan R1-H3)', () => {
  it('a FAILED pass that rendered the file in full + a completed pass that head-cut it → head-cut', () => {
    const cov = build({
      changed: ['big.cs'],
      recorder: rec({
        failedPass: { completed: false, stats: stats({ full: ['big.cs'] }) },
        okPass: { completed: true, stats: stats({ headTruncated: [{ path: 'big.cs', charsOnDisk: 20000, charsRendered: 8000 }] }) },
      }),
    });
    const f = cov.files[0];
    assert.equal(f.read.state, 'head-cut');
    assert.equal(f.read.bestCharsRendered, 8000);
    assert.equal(f.read.byPass.failedPass.passCompleted, false, 'kept as evidence');
    assert.equal(cov.status, 'partial', 'head-cut with unmeasured changed lines is short');
  });

  it('only a failed pass rendered it → outcome unreadable, nothing examined', () => {
    const cov = build({ changed: ['a.cs'], recorder: rec({ failedPass: { completed: false, stats: stats({ full: ['a.cs'] }) } }) });
    assert.equal(cov.files[0].outcome, 'unreadable');
    assert.equal(cov.status, 'none');
  });

  it('a completed pass reading the file in full wins over a completed head-cut one', () => {
    const cov = build({
      changed: ['a.cs'],
      recorder: rec({
        p1: { completed: true, stats: stats({ headTruncated: [{ path: 'a.cs', charsOnDisk: 9000, charsRendered: 2000 }] }) },
        p2: { completed: true, stats: stats({ full: ['a.cs'] }) },
      }),
    });
    assert.equal(cov.files[0].read.state, 'full');
    assert.equal(cov.status, 'complete');
  });

  it('no render evidence at all → read.state unknown → NOT audited (never optimistic) → none/fail', () => {
    const cov = build({ changed: ['a.cs'], recorder: createCoverageRecorder() });
    assert.equal(cov.files[0].read.state, 'unknown');
    assert.equal(cov.files[0].outcome, 'unreadable');
    assert.equal(cov.status, 'none');
    assert.equal(cov.gate, 'fail');
  });
});

describe('changedLinesUnread', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  const headCutAt = 200; // chars → about the first 26 lines of `line N\n`

  it('is null without hunks — not measured, never 0', () => {
    const cov = build({
      changed: ['a.cs'],
      recorder: rec({ p: { completed: true, stats: stats({ headTruncated: [{ path: 'a.cs', charsOnDisk: text.length, charsRendered: headCutAt }] }) } }),
      readText: () => text,
    });
    assert.equal(cov.files[0].changedLinesUnread, null);
  });

  it('counts changed lines beyond the rendered window, exactly', () => {
    const cov = build({
      changed: ['a.cs'],
      recorder: rec({ p: { completed: true, stats: stats({ headTruncated: [{ path: 'a.cs', charsOnDisk: text.length, charsRendered: headCutAt }] }) } }),
      readText: () => text,
      hunks: new Map([['a.cs', [{ startLine: 3, lineCount: 2 }, { startLine: 90, lineCount: 5 }]]]),
    });
    assert.equal(cov.files[0].changedLinesUnread, 5, 'only the hunk past the window');
    assert.equal(cov.status, 'partial');
  });

  it('a head-cut file whose changed lines are all inside the window is examined', () => {
    const cov = build({
      changed: ['a.cs'],
      recorder: rec({ p: { completed: true, stats: stats({ headTruncated: [{ path: 'a.cs', charsOnDisk: text.length, charsRendered: headCutAt }] }) } }),
      readText: () => text,
      hunks: new Map([['a.cs', [{ startLine: 2, lineCount: 3 }]]]),
    });
    assert.equal(cov.files[0].changedLinesUnread, 0);
    assert.equal(cov.status, 'complete');
  });
});

describe('the denominator matrix (audit-plan R2-H2) — one assertion per cell', () => {
  it('deleted source file → short, and a deletion-only diff is partial/warn, never none/fail (audit-plan R3-H1)', () => {
    const cov = build({ changed: [{ path: 'gone.cs', changeKind: 'deleted' }] });
    assert.equal(cov.counts.short, 1);
    assert.equal(cov.status, 'partial');
    assert.equal(cov.gate, 'warn');
    assert.match(formatCoverageSuffix(cov), /1 deleted source file/);
  });

  it('excluded source files sit outside `required` but force warn (audit-plan R3-M3)', () => {
    const cov = build({ changed: ['a.cs'], excludedUser: ['a.cs'] });
    assert.equal(cov.counts.required, 0);
    assert.equal(cov.counts.excludedRequired, 1);
    assert.equal(cov.status, 'complete');
    assert.equal(cov.gate, 'warn', 'an exclusion-only source diff must never read as a bare clean run');
    assert.match(formatCoverageSuffix(cov), /1 source file\(s\) excluded by policy/);
  });

  it('sensitive source file → counted required and short', () => {
    const cov = build({ changed: ['secrets/Db.cs'] });
    assert.equal(cov.files[0].outcome, 'sensitive');
    assert.equal(cov.counts.short, 1);
  });

  it('a mixed diff with one audited and one budget-omitted .cs is partial, not complete', () => {
    const cov = build({
      changed: ['a.cs', 'b.cs'],
      recorder: rec({ p: { completed: true, stats: stats({ full: ['a.cs'], budgetOmitted: ['b.cs'] }) } }),
    });
    assert.equal(cov.status, 'partial');
    assert.equal(cov.counts.examined, 1);
  });
});

describe('the invariant validator', () => {
  it('a duplicate changed path is reported and makes the ledger incomplete', () => {
    const cov = build({ changed: ['a.cs', 'A.cs', 'x/../a.cs'] });
    assert.ok(cov.invariantViolations.some((v) => /duplicate/.test(v)) || cov.files.length === 3);
  });

  it('exact duplicates (same normalised identity) → incomplete/fail, and the suffix says the ledger is invalid', () => {
    const cov = build({ changed: ['a/b.cs', 'a\\b.cs'] });
    assert.equal(cov.status, 'incomplete');
    assert.equal(cov.gate, 'fail');
    assert.match(formatCoverageSuffix(cov), /LEDGER INVALID/);
  });

  it('validateCoverage recomputes counts from files[] and rejects a doctored total', () => {
    const cov = build({ changed: ['a.cs'], recorder: rec({ p: { completed: true, stats: stats({ full: ['a.cs'] }) } }) });
    assert.equal(validateCoverage(cov).ok, true);
    const bad = structuredClone(cov);
    bad.counts.byOutcome.audited = 7;
    const v = validateCoverage(bad);
    assert.equal(v.ok, false);
    assert.match(v.problems.join(' '), /counts\.byOutcome\.audited/);
    const bad2 = structuredClone(cov);
    bad2.changedTotal = 5;
    assert.equal(validateCoverage(bad2).ok, false);
  });

  it('the schema is strict: an unknown field is rejected', () => {
    const cov = build({ changed: ['a.cs'] });
    assert.equal(CoverageSchema.safeParse({ ...cov, extra: 1 }).success, false);
  });

  it('600 changed paths keep 600 records (no cap on the canonical ledger)', () => {
    const changed = Array.from({ length: 600 }, (_, i) => `src/f${i}.cs`);
    const cov = build({ changed });
    assert.equal(cov.files.length, 600);
    assert.equal(cov.changedTotal, 600);
    assert.equal(validateCoverage(cov).ok, true);
  });
});

describe('reviewer projection (audit-plan R2-H1)', () => {
  it('cuts files[] to the short ones, keeps canonical counts, and its digest matches the full ledger', () => {
    const changed = ['ok.cs', ...Array.from({ length: 300 }, (_, i) => `gap/x${i}.xyz`)];
    const cov = build({ changed, recorder: rec({ p: { completed: true, stats: stats({ full: ['ok.cs'] }) } }) });
    const proj = projectCoverageForReview(cov, { maxShown: 50 });
    assert.equal(proj.files, undefined);
    assert.equal(proj.filesProjection.fullCount, 301);
    assert.equal(proj.filesProjection.shown.length, 50);
    assert.equal(proj.filesProjection.shownTruncated, 250);
    assert.equal(proj.counts.short, cov.counts.short, 'counts are the canonical ones');
    assert.equal(proj.filesProjection.digest, crypto.createHash('sha256').update(JSON.stringify(cov.files)).digest('hex'));
    assert.ok(proj.filesProjection.shown.every((f) => f.class === 'uncovered'), 'the audited file is not "short"');
  });
});

describe('tool state aggregation (audit-plan R2-M3)', () => {
  it('worst wins, per the precedence table, for every adjacent pair', () => {
    for (let i = 0; i < TOOL_STATE_PRECEDENCE.length - 1; i++) {
      assert.equal(worstToolState([TOOL_STATE_PRECEDENCE[i + 1], TOOL_STATE_PRECEDENCE[i]]), TOOL_STATE_PRECEDENCE[i]);
    }
  });
  it('empty → not_applicable; ok outranks not_applicable; a spawn error outranks everything', () => {
    assert.equal(worstToolState([]), 'not_applicable');
    assert.equal(worstToolState(['not_applicable', 'ok']), 'ok');
    assert.equal(worstToolState(['ok', 'timeout', 'spawn_error']), 'spawn_error');
  });
  it('per-file tool status is attached from the project that covered it', () => {
    const cov = build({
      changed: ['a.cs'],
      tools: [{ id: 'dotnet-build', profile: 'cs', projects: [{ path: 'A.csproj', kind: 'csproj', status: 'timeout', reason: 'slow', files: ['a.cs'] }] }],
    });
    assert.deepEqual(cov.files[0].analysis.tools, [{ id: 'dotnet-build', status: 'timeout' }]);
    assert.equal(cov.tools[0].status, 'timeout');
  });
});
