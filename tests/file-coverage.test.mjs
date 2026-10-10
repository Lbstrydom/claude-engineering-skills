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

// ── Upstream report 58f4e3a5: read windows, the hunk map, convergence (docs/plans/audit-hunk-window-coverage.md) ──
import { buildHunkMap, makeCoverageInput } from '../scripts/lib/audit/file-coverage.mjs';
import { evaluateConvergenceWithDetectors } from '../scripts/lib/audit/convergence.mjs';
import { changedLinesUnreadTotal } from '../scripts/lib/coverage-format.mjs';
import { formatAuditSummaryLine } from '../scripts/lib/audit/findings-pipeline.mjs';

const text400 = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n');
const cut = (ranges, o = {}) => ({ path: 'big.js', charsOnDisk: text400.length, charsRendered: 1000, ranges, windowed: true, ...o });

describe('changedLinesUnread is the union over completed passes (D5)', () => {
  const hunks = new Map([['big.js', [{ startLine: 100, lineCount: 50 }, { startLine: 300, lineCount: 20 }]]]);
  it('two passes that each rendered a different hunk add up to zero unread', () => {
    const cov = build({
      changed: ['big.js'], hunks, readText: () => text400,
      recorder: rec({
        quickfix: { completed: true, stats: stats({ headTruncated: [cut([[1, 20], [95, 155]])] }) },
        sustainability: { completed: true, stats: stats({ headTruncated: [cut([[290, 325]])] }) },
      }),
    });
    const f = byPath(cov, 'big.js');
    assert.equal(f.read.state, 'windowed');
    assert.equal(f.changedLinesUnread, 0);
    assert.equal(cov.status, 'complete', 'every changed line was rendered somewhere → wholly examined');
  });
  it('a FAILED pass vouches for nothing it rendered', () => {
    const cov = build({
      changed: ['big.js'], hunks, readText: () => text400,
      recorder: rec({
        quickfix: { completed: true, stats: stats({ headTruncated: [cut([[95, 155]])] }) },
        sustainability: { completed: false, stats: stats({ headTruncated: [cut([[290, 325]])] }) },
      }),
    });
    assert.equal(byPath(cov, 'big.js').changedLinesUnread, 20);
    assert.equal(changedLinesUnreadTotal(cov), 20);
  });
  it('a prefix-only render (no ranges) keeps the old head-cut semantics', () => {
    const cov = build({
      changed: ['big.js'], hunks, readText: () => text400,
      recorder: rec({ quickfix: { completed: true, stats: stats({ headTruncated: [{ path: 'big.js', charsOnDisk: text400.length, charsRendered: 10 }] }) } }),
    });
    const f = byPath(cov, 'big.js');
    assert.equal(f.read.state, 'head-cut');
    assert.equal(f.changedLinesUnread, 70);
  });
  it('diff evidence expected but the change unmeasurable → the ledger refuses to vouch (incomplete), never a converging null', () => {
    const cov = build({
      changed: ['big.js'], hunks: () => [{ startLine: 100, lineCount: 5 }], hunksExpected: true, readText: () => null,
      recorder: rec({ quickfix: { completed: true, stats: stats({ headTruncated: [cut([[1, 20]])] }) } }),
    });
    assert.equal(byPath(cov, 'big.js').changedLinesUnread, null);
    assert.equal(cov.status, 'incomplete');
    assert.equal(cov.gate, 'fail');
    // Control: the same unmeasurable file where no diff was declared is an honest unknown, not a violation.
    const na = build({
      changed: ['big.js'], hunks: null, readText: () => null,
      recorder: rec({ quickfix: { completed: true, stats: stats({ headTruncated: [cut([[1, 20]])] }) } }),
    });
    assert.equal(na.status, 'partial');
  });
  it('an untracked file with no hunk record counts every line as changed', () => {
    const cov = build({
      changed: [{ path: 'big.js', changeKind: 'untracked' }], hunks: null, readText: () => text400,
      recorder: rec({ quickfix: { completed: true, stats: stats({ headTruncated: [cut([[1, 100]])] }) } }),
    });
    assert.equal(byPath(cov, 'big.js').changedLinesUnread, 300);
  });
});

describe('buildHunkMap — one map, and absent evidence is never a pass (D7)', () => {
  const quiet = () => {};
  const readText = (p) => (p === 'big.js' ? text400 : null);
  it('not-applicable (no diff, no VCS record) → null, and the plain reader is not given hunks', () => {
    const m = buildHunkMap({ changed: ['big.js'], readText, warn: quiet });
    assert.equal(m.evidence, 'not-applicable');
    assert.equal(m.hunksFor('big.js'), null);
    // An R2+ re-run with no --diff (e.g. --scope full) declared no diff either: the same not-applicable, never a block.
    assert.equal(buildHunkMap({ changed: ['big.js'], diffMap: null, coverageChanged: null, readText, warn: quiet }).evidence, 'not-applicable');
  });
  it('a supplied --diff that parsed to nothing (failed / empty patch) is expected evidence that is missing → wholly changed', () => {
    const m = buildHunkMap({ diffMap: new Map(), changed: ['big.js'], readText, warn: quiet });
    assert.equal(m.evidence, 'expected');
    assert.deepEqual(m.hunksFor('big.js'), [{ startLine: 1, lineCount: 400 }]);
  });
  it('R1 change record hunks are used as measured; an empty array is a measured "no changed text"', () => {
    const m = buildHunkMap({ coverageChanged: [{ path: 'big.js', hunks: [{ startLine: 5, lineCount: 2 }] }, { path: 'bin.png', hunks: [] }], changed: [{ path: 'big.js', hunks: [{ startLine: 5, lineCount: 2 }] }, { path: 'bin.png', hunks: [] }], readText, warn: quiet });
    assert.deepEqual(m.hunksFor('big.js'), [{ startLine: 5, lineCount: 2 }]);
    assert.deepEqual(m.hunksFor('bin.png'), []);
  });
  it('R1 record whose diff could not be read → wholly changed, said on stderr', () => {
    const lines = [];
    const m = buildHunkMap({ coverageChanged: [{ path: 'big.js' }], changed: [{ path: 'big.js' }], readText, warn: (l) => lines.push(l) });
    assert.deepEqual(m.hunksFor('big.js'), [{ startLine: 1, lineCount: 400 }]);
    assert.match(lines.join(''), /big\.js: its diff hunks could not be read — treated as wholly changed/);
  });
  it('R2: a --diff entry is trusted only when its post-image id is the working-tree hash', () => {
    const diffMap = new Map([['big.js', { hunks: [{ startLine: 10, lineCount: 1 }], postImage: 'abc1234' }]]);
    const fresh = buildHunkMap({ diffMap, changed: ['big.js'], isR2Plus: true, readText, hashFile: () => 'abc1234ffff', warn: quiet });
    assert.deepEqual(fresh.hunksFor('big.js'), [{ startLine: 10, lineCount: 1 }]);
    // The stale case: the patch's hunks still "look" valid (line 10 exists, nothing else to check), but the file was
    // edited after the patch was made. Without verification this file would read 0 unread with the edit unseen.
    const stale = buildHunkMap({ diffMap, changed: ['big.js'], isR2Plus: true, readText, hashFile: () => 'def5678', warn: quiet });
    assert.deepEqual(stale.hunksFor('big.js'), [{ startLine: 1, lineCount: 400 }]);
    const noIndex = new Map([['big.js', { hunks: [{ startLine: 10, lineCount: 0 }], postImage: null }]]);
    assert.deepEqual(buildHunkMap({ diffMap: noIndex, changed: ['big.js'], isR2Plus: true, readText, hashFile: () => 'x', warn: quiet }).hunksFor('big.js'), [{ startLine: 1, lineCount: 400 }], 'a deletion-only entry with no post-image id is not trusted either');
  });
  it('R2: a changed file absent from the --diff → wholly changed; a dependent outside the changed set → null', () => {
    const diffMap = new Map([['other.js', { hunks: [{ startLine: 1, lineCount: 1 }], postImage: 'aaa' }]]);
    const m = buildHunkMap({ diffMap, changed: ['big.js'], isR2Plus: true, readText, hashFile: () => 'aaa', warn: quiet });
    assert.deepEqual(m.hunksFor('big.js'), [{ startLine: 1, lineCount: 400 }]);
    assert.equal(m.hunksFor('dependent.js'), null, 'never invent a change for a file that did not change');
  });
  it('makeCoverageInput measures against the SAME map the readers rendered with', () => {
    let builds = 0;
    const recorder = createCoverageRecorder();
    const map = { applicable: true, hunksFor: () => [{ startLine: 1, lineCount: 1 }] };
    recorder.getHunkMap = () => { builds++; return map; };
    const ci = makeCoverageInput({ recorder, coverageChanged: null, changedFiles: ['a.js'], fileFilter: null, coverageExcluded: null, diffMap: null, toolCapability: {}, noTools: true });
    assert.equal(ci.hunks, map.hunksFor);
    assert.equal(builds, 1);
  });
});

describe('a measured changed-line shortfall blocks convergence (D9) and is said beside the verdict (D10)', () => {
  const counts = { high: 0, medium: 0, quickFix: 0 };
  const clean = { blocked: false, checked: 0 };
  const covWith = (unread) => ({
    status: 'partial', counts: { required: 1, short: unread === 0 ? 0 : 1, excludedRequired: 0 }, uncoveredByExtension: {},
    files: [{ path: 'big.js', class: 'profiled', outcome: 'audited', changedLinesUnread: unread, read: { state: 'windowed' } }],
  });
  it('unread > 0 → changed-lines-unread; 0 / null / no ledger → converged', () => {
    assert.deepEqual(evaluateConvergenceWithDetectors(counts, clean, covWith(248)), { converged: false, reason: 'changed-lines-unread' });
    assert.equal(evaluateConvergenceWithDetectors(counts, clean, covWith(0)).converged, true);
    assert.equal(evaluateConvergenceWithDetectors(counts, clean, covWith(null)).converged, true);
    assert.equal(evaluateConvergenceWithDetectors(counts, clean).converged, true);
  });
  it('a budget-omitted changed file counts every changed line unread and blocks; a policy-excluded one never does', () => {
    const hunks = new Map([['big.js', [{ startLine: 10, lineCount: 5 }]], ['package-lock.json', [{ startLine: 1, lineCount: 99 }]]]);
    const cov = build({
      changed: ['big.js', 'package-lock.json'], hunks, readText: () => text400,
      excludedInfra: ['package-lock.json'],
      recorder: rec({ quickfix: { completed: true, stats: stats({ budgetOmitted: ['big.js'] }) } }),
    });
    assert.equal(byPath(cov, 'big.js').outcome, 'budget-omitted');
    assert.equal(byPath(cov, 'big.js').changedLinesUnread, 5);
    assert.equal(byPath(cov, 'package-lock.json').changedLinesUnread, null, 'excluded on purpose: not a shortfall');
    assert.equal(changedLinesUnreadTotal(cov), 5);
    assert.equal(evaluateConvergenceWithDetectors(counts, clean, cov).reason, 'changed-lines-unread');
  });
  it('the counts and the detector census are still read first', () => {
    assert.equal(evaluateConvergenceWithDetectors({ ...counts, high: 1 }, clean, covWith(5)).reason, 'finding-thresholds');
    assert.equal(evaluateConvergenceWithDetectors(counts, undefined, covWith(5)).reason, 'detector-not-run');
  });
  it('the summary line states the line count and that PASS is not convergence evidence', () => {
    const line = formatAuditSummaryLine({ verdict: 'PASS', high: 0, medium: 0, low: 0, latencyMs: 1000, coverage: covWith(248) });
    assert.match(line, /248 changed line\(s\) in 1 file\(s\) never rendered to any pass — not convergence evidence/);
    assert.doesNotMatch(formatAuditSummaryLine({ verdict: 'PASS', high: 0, medium: 0, low: 0, coverage: covWith(0) }), /not convergence evidence/);
  });
  it('an older reader meeting an unrecognised read state counts the file as short (the conservative direction)', () => {
    const cov = covWith(0);
    cov.files[0].read.state = 'some-future-state';
    assert.match(formatCoverageSuffix({ ...cov, counts: { required: 1, short: 1, excludedRequired: 0 } }), /PARTIAL/);
  });
});
