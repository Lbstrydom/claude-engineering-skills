/**
 * @fileoverview Does the final reviewer actually receive the changed code, and
 * does the telemetry tell the truth when it does not?
 *
 * Guards the 2026-09-02 defect pair (audit SID audit-code-1788374248, store run
 * 081547a7): the `full` envelope reported `truncated: {}` — a hardcoded literal,
 * not a measurement — while `readFilesAsContext` head-cut both changed files at
 * 8,000 chars, and the gate returned APPROVE over a diff it had never seen.
 *
 * Every assertion here has a NEGATIVE CONTROL: a check that only ever fires in
 * the failing direction cannot distinguish a working gate from an inert one,
 * and a coverage gate that silently stops firing re-opens the exact hole.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readFilesAsContextDetailed, readFilesAsContext, mergeCodeRenderStats } from '../scripts/lib/audit-scope.mjs';
import { buildReviewEnvelope, codeRenderTruncation } from '../scripts/lib/final-review/envelope.mjs';
import { summariseCodeCoverage, applyCoverageGate } from '../scripts/lib/final-review/code-coverage.mjs';
import { makeTieredCodeRenderer, CHANGED_FILE_MAX_PER_FILE } from '../scripts/lib/final-review/code-render.mjs';

// ── Fixture ─────────────────────────────────────────────────────────────────
// A real on-disk file shaped like the one that triggered the incident: the
// interesting symbol sits PAST the 8,000-char head cut. Written under the repo
// root because `readFilesAsContextDetailed` refuses paths outside cwd (by
// design — that containment check is the egress guard).

const FIXTURE_DIR = path.join('.audit', 'test-fixtures', `code-coverage-${process.pid}`);
const BIG = path.join(FIXTURE_DIR, 'big-changed-file.mjs');
const SMALL = path.join(FIXTURE_DIR, 'small-ambient.mjs');
/** The needle lives past 8,000 chars — exactly the incident's shape. */
const NEEDLE = 'AUTOCRLF_PROBE_SENTINEL';

function setup() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const filler = '// padding line to push the change past the head cut\n'.repeat(300);
  assert.ok(filler.length > 8000, 'fixture must exceed the 8,000-char head cut to be representative');
  fs.writeFileSync(BIG, `${filler}export const ${NEEDLE} = 1;\n`);
  fs.writeFileSync(SMALL, 'export const ambient = 2;\n');
}
function teardown() {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

describe('readFilesAsContextDetailed — reports what it dropped', () => {
  it('records a head cut, and the wrapper stays byte-identical', () => {
    setup();
    try {
      const opts = { maxPerFile: 8000, maxTotal: 100000 };
      const { context, stats } = readFilesAsContextDetailed([BIG], opts);

      // Subject probe: the defect reproduces — the needle is NOT in the render.
      assert.equal(context.includes(NEEDLE), false, 'fixture must reproduce the head cut');
      assert.equal(stats.headTruncated.length, 1, 'the cut must be RECORDED, not just performed');
      assert.equal(stats.full.length, 0);
      assert.ok(stats.charsOnDisk > stats.charsRendered, 'chars on disk must exceed chars rendered');

      // The string contract is unchanged: one implementation, one render.
      assert.equal(readFilesAsContext([BIG], opts), context);
    } finally { teardown(); }
  });

  it('NEGATIVE CONTROL: a cap that fits reports zero cuts and carries the needle', () => {
    setup();
    try {
      const { context, stats } = readFilesAsContextDetailed([BIG], { maxPerFile: 100000, maxTotal: 200000 });
      assert.ok(context.includes(NEEDLE), 'an uncut render must contain the change');
      assert.equal(stats.headTruncated.length, 0, 'must NOT report a cut that did not happen');
      assert.equal(stats.full.length, 1);
    } finally { teardown(); }
  });

  it('separates budget omission from unreadable paths', () => {
    setup();
    try {
      const { stats } = readFilesAsContextDetailed([BIG, SMALL, 'does/not/exist.mjs'], { maxPerFile: 200, maxTotal: 260 });
      assert.equal(stats.unreadable.length, 1, 'a missing file is unreadable, not budget-omitted');
      assert.ok(stats.budgetOmitted.length >= 1, 'the second file must not fit in a 260-char budget');
      assert.equal(stats.requested, 3);
    } finally { teardown(); }
  });

  it('mergeCodeRenderStats keeps an unmeasured render unmeasured', () => {
    assert.equal(mergeCodeRenderStats(null, null), null);
    const a = readFilesAsContextDetailed([], {}).stats;
    assert.equal(mergeCodeRenderStats(a, null), a);
    assert.equal(mergeCodeRenderStats(null, a), a);
  });
});

describe('envelope — the full branch reports a measurement, not a literal', () => {
  const BLOCKS = {
    projectContext: 'ctx', planContent: 'plan', repoContextBlock: '## Repository Context\nrc',
    scopeBlock: '', transcript: { raw: 'tx' }, debtBlock: '',
  };

  it('full: a head-cut render surfaces in accounting.truncated', () => {
    const stats = {
      requested: 2, maxPerFile: 8000, maxTotal: 100000,
      full: [], headTruncated: [{ path: 'a.mjs', charsOnDisk: 22162, charsRendered: 8000 }],
      budgetOmitted: ['b.mjs'], unreadable: [], sensitiveExcluded: [], redactionShortened: [],
      charsRendered: 8000, charsOnDisk: 22162,
    };
    const { accounting } = buildReviewEnvelope({
      scope: 'full', ...BLOCKS, codePaths: ['a.mjs', 'b.mjs'],
      renderCode: () => ({ text: 'code', stats }),
    });
    assert.equal(accounting.truncated.codeFilesHeadCut, 1);
    assert.equal(accounting.truncated.codeFilesBudgetOmitted, 1);
    assert.equal(accounting.truncated.codeCharsDropped, 14162);
    assert.equal(accounting.budgeted, false, 'the envelope itself is still unbudgeted');
  });

  it('full: an UNMEASURED render says so — it never reads as clean', () => {
    const { accounting } = buildReviewEnvelope({
      scope: 'full', ...BLOCKS, codePaths: ['a.mjs'], renderCode: () => 'legacy string',
    });
    // The old code returned `{}` here, which is indistinguishable from
    // "measured, nothing dropped". It must not.
    assert.equal(accounting.truncated.code, 'unmeasured');
    assert.notDeepEqual(accounting.truncated, {});
    assert.equal(codeRenderTruncation(null).code, 'unmeasured');
  });

  it('thin: envelope-level and render-level drops are both reported', () => {
    const stats = {
      requested: 1, maxPerFile: 8000, maxTotal: 30000,
      full: [], headTruncated: [{ path: 'a.mjs', charsOnDisk: 9000, charsRendered: 8000 }],
      budgetOmitted: [], unreadable: [], sensitiveExcluded: [], redactionShortened: [],
      charsRendered: 8000, charsOnDisk: 9000,
    };
    const { accounting } = buildReviewEnvelope({
      scope: 'thin', ...BLOCKS, codePaths: ['a.mjs'],
      renderCode: () => ({ text: 'code', stats }),
    });
    assert.equal(accounting.truncated.transcriptRounds, 0, 'envelope vocabulary survives');
    assert.equal(accounting.truncated.codeFilesHeadCut, 1, 'render vocabulary is merged in');
    assert.ok(accounting.codeRender, 'the raw record is carried for operators');
  });
});

describe('summariseCodeCoverage', () => {
  const stats = (over) => ({
    requested: 0, maxPerFile: 0, maxTotal: 0, full: [], headTruncated: [],
    budgetOmitted: [], unreadable: [], sensitiveExcluded: [], redactionShortened: [],
    charsRendered: 0, charsOnDisk: 0, ...over,
  });

  it('none — every changed file was dropped', () => {
    const c = summariseCodeCoverage(stats({ budgetOmitted: ['src/a.mjs'] }), ['src/a.mjs']);
    assert.equal(c.state, 'none');
    assert.deepEqual(c.changedMissing, ['src/a.mjs']);
  });

  it('partial — a changed file was head-cut', () => {
    const c = summariseCodeCoverage(
      stats({ headTruncated: [{ path: 'src/a.mjs', charsOnDisk: 9, charsRendered: 8 }] }), ['src/a.mjs']);
    assert.equal(c.state, 'partial');
  });

  it('full — every changed file rendered whole', () => {
    const c = summariseCodeCoverage(stats({ full: ['src/a.mjs'] }), ['src/a.mjs']);
    assert.equal(c.state, 'full');
  });

  it('unknown is never green: no record, and no declared diff set', () => {
    assert.equal(summariseCodeCoverage(null, ['src/a.mjs']).state, 'unknown');
    assert.equal(summariseCodeCoverage(stats({ full: ['src/a.mjs'] }), []).state, 'unknown');
  });

  it('matches paths through the repo normaliser, not by string equality', () => {
    const c = summariseCodeCoverage(stats({ full: ['./src/A.mjs'] }), ['src/a.mjs']);
    assert.equal(c.state, 'full', 'a case/prefix variant must not read as a miss');
  });
});

describe('applyCoverageGate', () => {
  const mk = (verdict) => ({ verdict, overall_reasoning: 'looks fine' });
  const none = { state: 'none', reason: 'all 2 changed file(s) were dropped' };

  it('downgrades an APPROVE issued over zero coverage', () => {
    const r = mk('APPROVE');
    const out = applyCoverageGate(r, none);
    assert.equal(out.downgraded, true);
    assert.equal(r.verdict, 'CONCERNS');
    assert.equal(r._coverageGate.reportedVerdict, 'APPROVE', 'the model verdict is preserved, not erased');
    assert.match(r.overall_reasoning, /COVERAGE GATE/);
    assert.match(r.overall_reasoning, /looks fine/, 'the original reasoning survives');
    assert.ok(r.overall_reasoning.length <= 3000, 'must stay inside the schema cap');
  });

  // THE DIRECTION THE GATE MUST NOT FIRE. A false downgrade is silent: it just
  // looks like a stricter reviewer, and nothing else in the pipeline disagrees.
  it('does NOT fire on partial, unknown, or full coverage', () => {
    for (const state of ['partial', 'unknown', 'full']) {
      const r = mk('APPROVE');
      assert.equal(applyCoverageGate(r, { state, reason: state }).downgraded, false, state);
      assert.equal(r.verdict, 'APPROVE', `${state} must not be downgraded`);
      assert.equal(r._coverageGate, undefined);
    }
  });

  it('does NOT touch a verdict that was never an approval', () => {
    for (const v of ['CONCERNS', 'CONCERNS_REMAINING', 'REJECT']) {
      const r = mk(v);
      assert.equal(applyCoverageGate(r, none).downgraded, false);
      assert.equal(r.verdict, v);
    }
  });

  it('tolerates a missing result or coverage record without throwing', () => {
    assert.equal(applyCoverageGate(null, none).downgraded, false);
    assert.equal(applyCoverageGate(mk('APPROVE'), null).downgraded, false);
  });
});

describe('makeTieredCodeRenderer — the diff is rendered before ambient context', () => {
  it('a changed file survives whole where the old flat cap cut it', () => {
    setup();
    try {
      const render = makeTieredCodeRenderer({ changedFiles: [BIG], reduced: false });
      const { text, stats } = render([SMALL, BIG]);
      assert.ok(text.includes(NEEDLE), 'the change must reach the reviewer');
      assert.deepEqual(stats.headTruncated, [], 'a 15KB changed file fits the changed-file cap');
      const coverage = summariseCodeCoverage(stats, [BIG]);
      assert.equal(coverage.state, 'full');
    } finally { teardown(); }
  });

  it('NEGATIVE CONTROL: undeclared as changed, the same file is still cut', () => {
    setup();
    try {
      const render = makeTieredCodeRenderer({ changedFiles: [], reduced: false });
      const { text, stats } = render([SMALL, BIG]);
      assert.equal(text.includes(NEEDLE), false, 'the ambient cap is unchanged at 8,000');
      assert.equal(stats.headTruncated.length, 1);
      // …and that is reported as `unknown`, never as coverage.
      assert.equal(summariseCodeCoverage(stats, []).state, 'unknown');
    } finally { teardown(); }
  });

  it('changed files are rendered FIRST, so ambient cannot starve them', () => {
    setup();
    try {
      const render = makeTieredCodeRenderer({ changedFiles: [BIG], reduced: false });
      const { text } = render([SMALL, BIG]);
      assert.ok(text.indexOf(BIG.replaceAll('\\', '/')) < text.indexOf(SMALL.replaceAll('\\', '/'))
        || text.indexOf(BIG) < text.indexOf(SMALL), 'the changed file must be rendered first');
    } finally { teardown(); }
  });

  it('ambient files dropped for want of budget are RECORDED, not silently absent', () => {
    setup();
    try {
      // A read stub that reports a changed render already consuming the budget.
      const calls = [];
      const read = (paths, opts) => {
        calls.push({ paths, opts });
        return {
          context: 'X'.repeat(paths === undefined ? 0 : 0) + '',
          stats: {
            requested: paths.length, maxPerFile: opts.maxPerFile, maxTotal: opts.maxTotal,
            full: [], headTruncated: [], budgetOmitted: opts.maxTotal === 0 ? [...paths] : [],
            unreadable: [], sensitiveExcluded: [], redactionShortened: [],
            charsRendered: opts.maxTotal === 0 ? 0 : opts.maxTotal, charsOnDisk: 0,
          },
        };
      };
      const render = makeTieredCodeRenderer({ changedFiles: [BIG], reduced: false, read });
      const { stats } = render([BIG, SMALL]);
      assert.equal(calls.length, 2, 'ambient must be asked even when the budget is spent');
      assert.equal(calls[1].opts.maxTotal, 0);
      assert.deepEqual(stats.budgetOmitted, [SMALL], 'the dropped ambient file must appear in the record');
    } finally { teardown(); }
  });

  it('an empty path list is unmeasured, not measured-and-clean', () => {
    const render = makeTieredCodeRenderer({ changedFiles: [] });
    assert.deepEqual(render([]), { text: '', stats: null });
    assert.equal(codeRenderTruncation(render([]).stats).code, 'unmeasured');
  });

  it('the changed-file cap is genuinely larger than the ambient one', () => {
    assert.ok(CHANGED_FILE_MAX_PER_FILE > 8000, 'a cap equal to the old one would make the fix inert');
  });
});
