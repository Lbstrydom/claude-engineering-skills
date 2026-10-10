/**
 * @fileoverview The final-review envelope and the tiered discovery read render changed files as hunk windows, and the
 * envelope's coverage counts the changed lines the reviewer never saw (docs/plans/final-review-hunk-windows.md).
 *
 * Every positive assertion has a negative control: the same input without hunk evidence reproduces the old head-first
 * render (the change is NOT shown) and the coverage reports the shortfall as UNMEASURED, never as a clean 0.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readFilesAsContextDetailed } from '../scripts/lib/audit-scope.mjs';
import { buildReviewEnvelope } from '../scripts/lib/final-review/envelope.mjs';
import {
  summariseCodeCoverage, applyCoverageGate, formatCodeCoverageSegment,
} from '../scripts/lib/final-review/code-coverage.mjs';
import { makeTieredCodeRenderer, windowTargetFor, CHANGED_FILE_MAX_PER_FILE } from '../scripts/lib/final-review/code-render.mjs';
import { buildHunkMap } from '../scripts/lib/audit/hunk-evidence.mjs';
import { resolveFinalReviewHunks, transcriptDiffBase } from '../scripts/lib/audit/final-review-hunks.mjs';
import { readDiscoveryCode } from '../scripts/lib/audit/tiered-pipeline.mjs';
import { stampAuditRound } from '../scripts/lib/finalize-outcomes.mjs';
import { buildAuditTranscript } from '../scripts/lib/audit/transcript.mjs';
import { mkdtemp, gitInit, commitAll, gitFixtureEnv } from './helpers/fixtures.mjs';

// ── fixtures ────────────────────────────────────────────────────────────────

/** A module of `n` lines, each ~`width` chars, every line naming its own number (`L0001`). */
function moduleText(n, width = 60) {
  return Array.from({ length: n }, (_, i) => `export const L${String(i + 1).padStart(4, '0')} = '${'x'.repeat(Math.max(0, width - 26))}';`).join('\n') + '\n';
}
/** Replace line `ln` (1-based) with a needle line. */
function withNeedle(text, ln, needle) {
  const lines = text.split('\n');
  lines[ln - 1] = `export const ${needle} = true; // changed`;
  return lines.join('\n');
}

function inTempDir(t, files) {
  const dir = mkdtemp('final-review-hunk-windows-');
  const prev = process.cwd();
  t.after(() => { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  process.chdir(dir);
  return dir;
}

/** The REAL hunk map the final review builds (D1), from known per-file hunks. */
function hunkMapFor(hunksByPath) {
  const records = Object.entries(hunksByPath).map(([p, hunks]) => ({ path: p, hunks }));
  return buildHunkMap({ diffMap: null, changed: records, coverageChanged: records, warn: () => {} });
}

const envelopeOf = (scope, codePaths, renderCode) => buildReviewEnvelope({
  scope, projectContext: 'ctx', planContent: 'plan', transcript: { rounds: [] }, codePaths, renderCode,
});

// ── 1. the realistic envelope shape ─────────────────────────────────────────

describe('final-review envelope — a large changed file renders its change past the old head cut', () => {
  test('full scope: the needle past char 45,000 of a ~60K file reaches the reviewer; coverage says every line was shown', (t) => {
    const big = withNeedle(moduleText(1000), 800, 'FAR_CHANGE_SENTINEL');   // line 800 ≈ char 48,000
    const mid = withNeedle(moduleText(330), 165, 'MID_CHANGE_SENTINEL');    // ~20K: whole today, windowed-then-grown now
    inTempDir(t, { 'src/big.mjs': big, 'src/mid.mjs': mid, 'src/ambient.mjs': 'export const ambient = 1;\n' });
    assert.ok(big.indexOf('FAR_CHANGE_SENTINEL') > CHANGED_FILE_MAX_PER_FILE, 'fixture: the change sits past the old 40K head cut');
    const changed = ['src/big.mjs', 'src/mid.mjs'];
    const codePaths = [...changed, 'src/ambient.mjs'];
    const map = hunkMapFor({ 'src/big.mjs': [{ startLine: 800, lineCount: 1 }], 'src/mid.mjs': [{ startLine: 165, lineCount: 1 }] });

    // Negative control FIRST: today's render (no hunk evidence) does not carry the change, and says so as UNMEASURED.
    const before = envelopeOf('full', codePaths, makeTieredCodeRenderer({ changedFiles: changed }));
    assert.equal(before.userPrompt.includes('FAR_CHANGE_SENTINEL'), false, 'fixture reproduces the head cut');
    const covBefore = summariseCodeCoverage(before.accounting.codeRender, changed, { requested: codePaths });
    assert.equal(covBefore.state, 'partial');
    assert.equal(covBefore.changedLinesUnread, null, 'no diff evidence: unmeasured, never a clean 0');
    assert.equal(covBefore.hunkEvidence, 'not-applicable');
    assert.match(covBefore.reason, /unmeasured for 1 file\(s\) \(no diff evidence\)/);

    const after = envelopeOf('full', codePaths, makeTieredCodeRenderer({ changedFiles: changed, hunksFor: map.hunksFor }));
    assert.ok(after.userPrompt.includes('FAR_CHANGE_SENTINEL'), 'the change past the old head cut is rendered');
    assert.ok(after.userPrompt.includes('MID_CHANGE_SENTINEL'));
    assert.ok(after.userPrompt.includes('export const ambient'), 'leftover budget still reaches ambient context');
    assert.match(after.userPrompt, /### src\/big\.mjs \[WINDOWED — shows lines 1-\d+, 797-803 of 1001/);
    const cov = summariseCodeCoverage(after.accounting.codeRender, changed, { hunksFor: map.hunksFor, requested: codePaths });
    assert.equal(cov.state, 'full', cov.reason);
    assert.equal(cov.changedLinesUnread, 0);
    assert.equal(cov.changedLinesTotal, 2);
    assert.deepEqual(cov.changedFull, ['src/mid.mjs'], 'a file under the 40K cap grows back to whole when budget allows');
  });

  test('thin scope: a change past the 30K cap of a 35K file is rendered (before: head-cut away)', (t) => {
    const text = withNeedle(moduleText(590), 560, 'THIN_CHANGE_SENTINEL');
    inTempDir(t, { 'a.mjs': text });
    assert.ok(text.length > 30_000 && text.indexOf('THIN_CHANGE_SENTINEL') > 30_000);
    const map = hunkMapFor({ 'a.mjs': [{ startLine: 560, lineCount: 1 }] });
    const before = envelopeOf('thin', ['a.mjs'], makeTieredCodeRenderer({ changedFiles: ['a.mjs'], reduced: true }));
    assert.equal(before.userPrompt.includes('THIN_CHANGE_SENTINEL'), false);
    const after = envelopeOf('thin', ['a.mjs'], makeTieredCodeRenderer({ changedFiles: ['a.mjs'], reduced: true, hunksFor: map.hunksFor }));
    assert.ok(after.userPrompt.includes('THIN_CHANGE_SENTINEL'));
    const cov = summariseCodeCoverage(after.accounting.codeRender, ['a.mjs'], { hunksFor: map.hunksFor, requested: ['a.mjs'] });
    assert.equal(cov.changedLinesUnread, 0);
  });

  test('the 27-file shape: with hunks nothing is budget-omitted and every changed line is shown', (t) => {
    const files = {};
    const hunks = {};
    for (let i = 0; i < 27; i++) {
      const p = `mod${String(i).padStart(2, '0')}.mjs`;
      files[p] = withNeedle(moduleText(200), 100, `NEEDLE_${i}`);   // ~12K each
      hunks[p] = [{ startLine: 100, lineCount: 1 }];
    }
    inTempDir(t, files);
    const changed = Object.keys(files);
    const before = makeTieredCodeRenderer({ changedFiles: changed })(changed);
    assert.ok(before.stats.budgetOmitted.length > 0, 'fixture reproduces the measured budget omission');
    const map = hunkMapFor(hunks);
    const after = makeTieredCodeRenderer({ changedFiles: changed, hunksFor: map.hunksFor })(changed);
    assert.equal(after.stats.budgetOmitted.length, 0);
    for (let i = 0; i < 27; i++) assert.ok(after.text.includes(`NEEDLE_${i}`), `needle ${i}`);
    const cov = summariseCodeCoverage(after.stats, changed, { hunksFor: map.hunksFor, requested: changed });
    assert.equal(cov.state, 'full', cov.reason);
    assert.equal(cov.changedLinesUnread, 0);
    assert.equal(windowTargetFor(27, 100_000), 3703, 'fair-share window target');
  });
});

// ── 2b. overflow is measured, never hidden (plan audit R1-M1) ──────────────

describe('overflow — what does not fit is counted unread', () => {
  test('windows exceed the thin budget: omitted files carry their changed lines as unread; state partial', (t) => {
    const files = {};
    const hunks = {};
    for (let i = 0; i < 60; i++) {
      const p = `f${String(i).padStart(2, '0')}.mjs`;
      files[p] = moduleText(150);   // ~9K each
      hunks[p] = [{ startLine: 75, lineCount: 2 }];
    }
    inTempDir(t, files);
    const changed = Object.keys(files);
    const map = hunkMapFor(hunks);
    const r = makeTieredCodeRenderer({ changedFiles: changed, reduced: true, hunksFor: map.hunksFor })(changed);
    assert.ok(r.stats.budgetOmitted.length > 0, 'fixture: the windows do not all fit 30K');
    const cov = summariseCodeCoverage(r.stats, changed, { hunksFor: map.hunksFor, requested: changed });
    assert.equal(cov.state, 'partial');
    assert.equal(cov.changedLinesUnread, r.stats.budgetOmitted.length * 2, 'every omitted file’s 2 changed lines are unread');
    assert.ok(cov.changedUnread.every((u) => u.outcome === 'budget-omitted'));
    assert.match(formatCodeCoverageSegment(cov), /^Code: PARTIAL, \d+ changed line\(s\) never shown$/);
  });

  test('changed text larger than the budget in ONE file: its own unread lines are counted', (t) => {
    inTempDir(t, { 'huge.mjs': moduleText(1200) });   // ~72K, all of it changed
    const map = hunkMapFor({ 'huge.mjs': [{ startLine: 1, lineCount: 1201 }] });
    const r = makeTieredCodeRenderer({ changedFiles: ['huge.mjs'], reduced: true, hunksFor: map.hunksFor })(['huge.mjs']);
    const cov = summariseCodeCoverage(r.stats, ['huge.mjs'], { hunksFor: map.hunksFor, requested: ['huge.mjs'] });
    assert.equal(cov.state, 'partial');
    // Exact, derived independently from the fixture (1201 lines, all changed) and the ranges the renderer recorded.
    const cut = r.stats.headTruncated.find((c) => c.path === 'huge.mjs');
    assert.ok(cut, 'the file was rendered (cut), not dropped');
    const shown = new Set();
    for (const [a, b] of cut.ranges) for (let i = a; i <= b; i++) shown.add(i);
    assert.equal(cov.changedLinesTotal, 1201);
    assert.equal(cov.changedLinesUnread, 1201 - shown.size);
    assert.ok(cov.changedLinesUnread > 0, 'fixture: the change does not fit');
    assert.deepEqual(cov.changedUnread, [{ path: 'huge.mjs', outcome: 'windowed', unread: 1201 - shown.size, total: 1201 }]);
  });
});

// ── 4. byte-identity without evidence ───────────────────────────────────────

describe('no hunk evidence → today’s bytes', () => {
  test('the renderer without hunksFor equals the historical direct call', (t) => {
    const text = withNeedle(moduleText(1000), 800, 'X');
    inTempDir(t, { 'a.mjs': text, 'b.mjs': 'export const b = 1;\n' });
    const r = makeTieredCodeRenderer({ changedFiles: ['a.mjs'] })(['a.mjs', 'b.mjs']);
    const first = readFilesAsContextDetailed(['a.mjs'], { maxPerFile: 40_000, maxTotal: 100_000 });
    const second = readFilesAsContextDetailed(['b.mjs'], { maxPerFile: 8_000, maxTotal: 100_000 - first.stats.charsRendered });
    assert.equal(r.text, first.context + second.context);
  });

  test('growWholeUpTo without hunks changes nothing; with hunks the whole file is the grown variant', (t) => {
    const text = withNeedle(moduleText(330), 165, 'G');
    inTempDir(t, { 'a.mjs': text });
    const plain = readFilesAsContextDetailed(['a.mjs'], { maxPerFile: 8000, maxTotal: 100_000 });
    const noHunks = readFilesAsContextDetailed(['a.mjs'], { maxPerFile: 8000, maxTotal: 100_000, growWholeUpTo: 40_000 });
    assert.equal(noHunks.context, plain.context, 'unknown hunks never grow');
    const grown = readFilesAsContextDetailed(['a.mjs'], {
      maxPerFile: 8000, maxTotal: 100_000, growWholeUpTo: 40_000, hunksFor: () => [{ startLine: 165, lineCount: 1 }],
    });
    assert.deepEqual(grown.stats.full, ['a.mjs']);
    assert.equal(grown.stats.lineCounts['a.mjs'], text.split('\n').length);
    const tight = readFilesAsContextDetailed(['a.mjs'], {
      maxPerFile: 8000, maxTotal: 9000, growWholeUpTo: 40_000, hunksFor: () => [{ startLine: 165, lineCount: 1 }],
    });
    assert.equal(tight.stats.headTruncated[0].windowed, true, 'no room to grow: the window stays');
  });
});

// ── 5. coverage outcomes ────────────────────────────────────────────────────

const statsOf = (over = {}) => ({
  requested: 0, maxPerFile: 8000, maxTotal: 100_000, full: [], headTruncated: [], budgetOmitted: [], unreadable: [],
  sensitiveExcluded: [], redactionShortened: [], lineCounts: {}, charsRendered: 1, charsOnDisk: 1, ...over,
});

describe('summariseCodeCoverage — line-level outcomes', () => {
  const hunksFor = (p) => ({ 'a.js': [{ startLine: 50, lineCount: 5 }], 'b.js': [{ startLine: 10, lineCount: 2 }], 'c.js': [{ startLine: 1, lineCount: 3 }] })[p] ?? null;

  test('budget-omitted with hunks: every changed line unread (and the gate still only fires on none)', () => {
    const cov = summariseCodeCoverage(statsOf({ full: ['b.js'], budgetOmitted: ['a.js'], lineCounts: { 'a.js': 100, 'b.js': 40 } }), ['a.js', 'b.js'], { hunksFor });
    assert.equal(cov.state, 'partial');
    assert.equal(cov.changedLinesUnread, 5);
    assert.equal(cov.changedLinesTotal, 7);
    assert.match(cov.reason, /5 of 7 changed line\(s\) never shown/);
    const result = { verdict: 'APPROVE', overall_reasoning: '' };
    assert.equal(applyCoverageGate(result, cov).downgraded, false, 'partial is surfaced, never gated');
    assert.equal(result.verdict, 'APPROVE');
  });

  test('requested but dropped by the envelope (Step 4) is counted; never requested is unmeasured, not counted', () => {
    const cov = summariseCodeCoverage(statsOf({ full: ['b.js'], lineCounts: { 'b.js': 40 } }), ['a.js', 'b.js', 'c.js'], {
      hunksFor, requested: ['a.js', 'b.js'], readText: (p) => (p === 'a.js' ? 'x\n'.repeat(99) : null),
    });
    assert.equal(cov.changedLinesUnread, 5, 'a.js (dropped) counted');
    assert.deepEqual(cov.changedUnmeasured.map((u) => [u.path, u.outcome]), [['c.js', 'not-requested']]);
    assert.equal(cov.changedLinesUnmeasuredFiles, 1);
  });

  test('without hunks: whole render is 0 unread (total unknown); a cut is unmeasured; the sum is null, not 0', () => {
    const cut = { path: 'a.js', charsOnDisk: 20_000, charsRendered: 8000, ranges: [[1, 120]], windowed: false };
    const cov = summariseCodeCoverage(statsOf({ full: ['b.js'], headTruncated: [cut], lineCounts: { 'a.js': 300, 'b.js': 40 } }), ['a.js', 'b.js']);
    assert.equal(cov.changedLinesUnread, null);
    assert.equal(cov.changedLinesTotalUnknownFiles, 2);
    assert.equal(cov.changedHeadCut[0].unread, null);
    assert.equal(formatCodeCoverageSegment(cov), 'Code: PARTIAL, changed lines unmeasured for 1 file(s)');
    const allWhole = summariseCodeCoverage(statsOf({ full: ['b.js'], lineCounts: { 'b.js': 40 } }), ['b.js']);
    assert.equal(allWhole.state, 'full');
    assert.equal(allWhole.changedLinesUnread, 0, 'a whole render shows every line, evidence or not');
  });

  test('snapshot (R1-M2): the reader’s recorded line count wins over a re-read', () => {
    const cut = { path: 'a.js', charsOnDisk: 9000, charsRendered: 4000, ranges: [[1, 40]], windowed: true };
    const cov = summariseCodeCoverage(statsOf({ headTruncated: [cut], lineCounts: { 'a.js': 100 } }), ['a.js'], {
      hunksFor, readText: () => 'one\ntwo\n',   // would clip line 50 away if it were consulted
    });
    assert.equal(cov.changedLinesTotal, 5);
    assert.equal(cov.changedLinesUnread, 5);
  });

  test('a windowed file holding every changed line is full coverage', () => {
    const cut = { path: 'a.js', charsOnDisk: 9000, charsRendered: 4000, ranges: [[1, 10], [47, 57]], windowed: true };
    const cov = summariseCodeCoverage(statsOf({ headTruncated: [cut], lineCounts: { 'a.js': 100 } }), ['a.js'], { hunksFor });
    assert.equal(cov.state, 'full');
    assert.equal(formatCodeCoverageSegment(cov), 'Code: FULL');
  });

  test('formatCodeCoverageSegment: no record or no changed set → empty; a shortfall is always named', () => {
    assert.equal(formatCodeCoverageSegment(null), '');
    assert.equal(formatCodeCoverageSegment(summariseCodeCoverage(statsOf(), [])), '');
    const cov = summariseCodeCoverage(statsOf({ budgetOmitted: ['a.js'], lineCounts: { 'a.js': 100 } }), ['a.js'], { hunksFor });
    assert.equal(cov.state, 'none');
    assert.equal(formatCodeCoverageSegment(cov), 'Code: NONE, 5 changed line(s) never shown');
  });
});

// ── 6. hunk source: the audit's own base, through real git ─────────────────

describe('resolveFinalReviewHunks — the transcript base rebuilds the working-tree hunks', () => {
  const gitRun = (dir) => (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir, env: gitFixtureEnv() });
  const gitHash = (dir) => (p) => execFileSync('git', ['hash-object', '--', p], { cwd: dir, encoding: 'utf8', env: gitFixtureEnv() }).trim();
  function baseRepo(t) {
    const dir = inTempDir(t, { 'big.js': moduleText(420) });
    gitInit(dir);
    commitAll(dir, 'base');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', env: gitFixtureEnv() }).trim();
    return { dir, base };
  }

  test('an edit AFTER the diff was read demotes the file to wholly changed (post-image check, code audit R1-M1)', (t) => {
    const { dir, base } = baseRepo(t);
    fs.writeFileSync(path.join(dir, 'big.js'), withNeedle(moduleText(420), 300, 'EDIT'));
    const lines = [];
    const r = resolveFinalReviewHunks({ transcript: { rounds: [{ _diffBase: base }] }, changedFiles: ['big.js'], run: gitRun(dir), hashFile: gitHash(dir), warn: (l) => lines.push(l) });
    // The file changes between hunk acquisition and the render (the reader asks for hunks as it reaches the file).
    fs.writeFileSync(path.join(dir, 'big.js'), withNeedle(withNeedle(moduleText(420), 300, 'EDIT'), 10, 'LATER'));
    assert.deepEqual(r.hunksFor('big.js'), [{ startLine: 1, lineCount: 421 }], 'stale hunks are never trusted');
    assert.match(lines.join(''), /does not describe the current file \(stale\)/);
  });

  test('only the untracked file’s own fallback is quiet: a stale tracked file whose path CONTAINS it still warns (code audit R2)', (t) => {
    const dir = inTempDir(t, { 'src/new.js': moduleText(50) });
    gitInit(dir);
    commitAll(dir, 'base');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', env: gitFixtureEnv() }).trim();
    fs.writeFileSync(path.join(dir, 'src/new.js'), withNeedle(moduleText(50), 20, 'E1'));
    fs.writeFileSync(path.join(dir, 'new.js'), 'a\n');   // untracked; its path is a substring of the tracked one
    const warned = [];
    const r = resolveFinalReviewHunks({
      transcript: { rounds: [{ _diffBase: base }] }, changedFiles: ['src/new.js', 'new.js'],
      run: gitRun(dir), hashFile: gitHash(dir), warn: (l) => warned.push(l),
    });
    fs.writeFileSync(path.join(dir, 'src/new.js'), withNeedle(moduleText(50), 30, 'E2'));   // now stale
    assert.deepEqual(r.hunksFor('src/new.js'), [{ startLine: 1, lineCount: 51 }]);
    assert.deepEqual(r.hunksFor('new.js'), [{ startLine: 1, lineCount: 2 }]);
    assert.equal(warned.length, 1, warned.join(''));
    assert.match(warned[0], /src\/new\.js: the supplied --diff does not describe the current file \(stale\)/);
  });

  test('a changed path outside the checkout is never opened (code audit R1-M2)', (t) => {
    const { dir, base } = baseRepo(t);
    const outside = path.join(path.dirname(dir), `outside-${process.pid}.js`);
    fs.writeFileSync(outside, 'secret\n');
    t.after(() => fs.rmSync(outside, { force: true }));
    const rel = path.relative(dir, outside);
    const r = resolveFinalReviewHunks({ transcript: { rounds: [{ _diffBase: base }] }, changedFiles: [rel], run: gitRun(dir), hashFile: gitHash(dir), warn: () => {} });
    assert.equal(r.hunksFor(rel), null, 'no line count read from outside the repo');
    // Negative control: an in-repo path with the same shape IS read.
    fs.writeFileSync(path.join(dir, 'inside.js'), 'x\n');
    const r2 = resolveFinalReviewHunks({ transcript: { rounds: [{ _diffBase: base }] }, changedFiles: ['inside.js'], run: gitRun(dir), hashFile: gitHash(dir), warn: () => {} });
    assert.deepEqual(r2.hunksFor('inside.js'), [{ startLine: 1, lineCount: 2 }]);
    const cov = summariseCodeCoverage(statsOf({ budgetOmitted: [rel] }), [rel], { hunksFor: () => [{ startLine: 1, lineCount: 1 }] });
    assert.equal(cov.changedLinesUnread, null, 'the coverage fallback read is bounded too');
  });

  test('R1 _diffBase + an edited and an untracked file → their real hunks', (t) => {
    const dir = inTempDir(t, { 'big.js': moduleText(420) });
    gitInit(dir);
    commitAll(dir, 'base');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', env: gitFixtureEnv() }).trim();
    fs.writeFileSync(path.join(dir, 'big.js'), withNeedle(moduleText(420), 300, 'EDIT'));
    fs.writeFileSync(path.join(dir, 'new.js'), 'a\nb\nc\n');
    const transcript = { rounds: [{ round: 1, _diffBase: base }, { round: 2 }] };
    const warned = [];
    const r = resolveFinalReviewHunks({ transcript, changedFiles: ['big.js', 'new.js'], run: gitRun(dir), hashFile: gitHash(dir), warn: (l) => warned.push(l) });
    assert.equal(r.evidence, 'expected');
    assert.equal(r.base, base);
    assert.deepEqual(r.hunksFor('big.js'), [{ startLine: 300, lineCount: 1 }]);
    assert.deepEqual(r.hunksFor('new.js'), [{ startLine: 1, lineCount: 4 }]);
    assert.deepEqual(warned, [], 'an untracked file is wholly new by definition — not reported as a degradation');
  });

  test('no base, or a non-hex base: not-applicable and git is never called', () => {
    let calls = 0;
    const spy = () => { calls++; return ''; };
    for (const transcript of [{ rounds: [{ round: 1 }] }, { rounds: [{ _diffBase: '--output=pwned' }] }, { rounds: [{ _diffBase: 'HEAD~1' }] }, {}]) {
      const r = resolveFinalReviewHunks({ transcript, changedFiles: ['a.js'], run: spy });
      assert.equal(r.evidence, 'not-applicable');
      assert.equal(r.hunksFor, null);
    }
    assert.equal(calls, 0);
  });

  test('the base travels: stampAuditRound → round result → buildAuditTranscript → transcriptDiffBase', () => {
    const sha = 'a'.repeat(40);
    const r1 = stampAuditRound({ findings: [] }, 1, sha);
    assert.equal(r1._diffBase, sha);
    assert.equal('_diffBase' in stampAuditRound({ findings: [] }, 1, 'HEAD~1'), false, 'the provisional ref is never stamped');
    assert.equal('_diffBase' in stampAuditRound({ findings: [] }, 1, null), false);
    const r2 = stampAuditRound({ findings: [] }, 2, 'b'.repeat(40));
    const transcript = buildAuditTranscript({ rounds: [r1, r2], auditMode: 'code', changedFiles: ['x.js'] });
    assert.equal(transcriptDiffBase(transcript), sha, 'the EARLIEST round wins');
  });
});

// ── 8. tiered discovery read ───────────────────────────────────────────────

describe('tiered readDiscoveryCode — the same windowed reader, only when evidence applies', () => {
  test('an R1 change record with hunks → the change is rendered as a window', (t) => {
    inTempDir(t, { 'big.js': withNeedle(moduleText(420), 300, 'TIERED_NEEDLE') });
    const ctx = { round: 1, changedFiles: ['big.js'], coverageChanged: [{ path: 'big.js', changeKind: 'modified', renamedFrom: null, hunks: [{ startLine: 300, lineCount: 1 }] }] };
    const { context, stats, hunkMap } = readDiscoveryCode(ctx);
    assert.equal(hunkMap.applicable, true);
    assert.ok(context.includes('TIERED_NEEDLE'));
    assert.equal(stats.headTruncated[0].windowed, true);
  });

  test('no evidence → the read options are exactly the historical ones', () => {
    let seen = null;
    const read = (files, opts) => { seen = opts; return { context: '', stats: {} }; };
    readDiscoveryCode({ round: 1, changedFiles: ['a.js'] }, { read });
    assert.deepEqual(seen, { maxPerFile: 8000, maxTotal: 100000 });
    // Negative control: with evidence the options DO change.
    readDiscoveryCode({ round: 1, changedFiles: ['a.js'], coverageChanged: [{ path: 'a.js', hunks: [] }] }, { read });
    assert.equal(typeof seen.hunksFor, 'function');
  });

  test('R2+ uses the operator --diff like legacy; R1 ignores it', () => {
    const parsed = [];
    const parseDiff = (f) => { parsed.push(f); return new Map(); };
    const read = () => ({ context: '', stats: {} });
    readDiscoveryCode({ round: 1, diffFile: 'x.diff', changedFiles: ['a.js'] }, { read, parseDiff });
    assert.deepEqual(parsed, []);
    readDiscoveryCode({ round: 2, diffFile: 'x.diff', changedFiles: ['a.js'] }, { read, parseDiff });
    assert.deepEqual(parsed, ['x.diff']);
  });
});
