/**
 * @fileoverview Unit tests for the pure orphan-introduced detector.
 * Drives the algorithm via fixture DiffScope + HeadGraph records — no git, no fs.
 *
 * Coverage:
 *   (a) file orphaned by diff → finding emitted
 *   (b) file already orphan at base → no finding
 *   (c) entry-point exempted
 *   (d) test file orphaned → no finding
 *   (e) test-caller-only file → still flagged (Gemini-R2 wrongly-dismissed-R3/M2)
 *   (f) born-orphan
 *   (g) rename → suspect on new path
 *   (h) C (copy) status → suspect on new path
 *   (i) deleted-caller (D-status) drops edge → orphan
 *   (j) cross-target attribution (R5/H1 — exact removers set)
 *   (k) ANALYZED_PARTIAL inheritance
 *   (l) Empty inputs → ANALYZED_CLEAN
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectOrphansIntroduced, isTestFile, isDocExampleFile } from '../scripts/lib/audit/orphan-introduced.mjs';

function makeScope(overrides = {}) {
  return {
    baseRef: 'HEAD~1',
    headRef: 'HEAD',
    changedFiles: [],
    preEdgesByBaseCaller: {},
    targetExistedAtBase: [],
    entryPoints: [],
    state: 'ANALYZED_CLEAN',
    ...overrides,
  };
}

function makeHead(overrides = {}) {
  return {
    callersByTarget: {},
    targetsByCaller: {},
    allFiles: [],
    ...overrides,
  };
}

describe('isTestFile', () => {
  it('matches tests/ prefix', () => assert.equal(isTestFile('tests/foo.test.mjs'), true));
  it('matches *.test.mjs', () => assert.equal(isTestFile('src/foo.test.mjs'), true));
  it('matches *.spec.ts', () => assert.equal(isTestFile('src/bar.spec.ts'), true));
  it('matches __tests__ dir', () => assert.equal(isTestFile('src/__tests__/x.mjs'), true));
  it('matches windows-style backslash paths', () => assert.equal(isTestFile('tests\\foo.test.mjs'), true));
  it('does NOT match production file', () => assert.equal(isTestFile('src/foo.mjs'), false));
  it('handles null/undefined gracefully', () => assert.equal(isTestFile(null), false));
});

describe('isDocExampleFile', () => {
  it('matches docs/ prefix', () => assert.equal(isDocExampleFile('docs/plans/security/files/scripts/security-incidents.mjs'), true));
  it('matches a top-level docs/ file', () => assert.equal(isDocExampleFile('docs/foo.mjs'), true));
  it('matches windows-style backslash paths', () => assert.equal(isDocExampleFile('docs\\plans\\security\\files\\scripts\\x.mjs'), true));
  it('does NOT match a production file outside docs/', () => assert.equal(isDocExampleFile('scripts/lib/audit/orphan-introduced.mjs'), false));
  it('does NOT match a file that merely contains "docs" mid-path', () => assert.equal(isDocExampleFile('src/docs-generator.mjs'), false));
  it('handles null/undefined gracefully', () => assert.equal(isDocExampleFile(null), false));
});

describe('detectOrphansIntroduced', () => {

  it('(a) file orphaned by diff → emits finding', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'M', baseCallerPath: 'src/main.mjs', headCallerPath: 'src/main.mjs' }],
      preEdgesByBaseCaller: { 'src/main.mjs': ['src/old.mjs'] },
      targetExistedAtBase: ['src/old.mjs', 'src/main.mjs'],
    });
    const head = makeHead({
      callersByTarget: {},
      targetsByCaller: { 'src/main.mjs': [] },
      allFiles: ['src/main.mjs', 'src/old.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.rawFindings.length, 1);
    assert.equal(r.rawFindings[0].file, 'src/old.mjs');
    assert.equal(r.rawFindings[0].subKind, 'left-orphan');
    assert.deepEqual(r.rawFindings[0].allRemovedCallers, ['src/main.mjs']);
    assert.equal(r.state, 'ANALYZED_WITH_FINDINGS');
  });

  it('(b) file already orphan at base, diff did not touch it → no finding', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'M', baseCallerPath: 'src/main.mjs', headCallerPath: 'src/main.mjs' }],
      preEdgesByBaseCaller: { 'src/main.mjs': ['src/dep.mjs'] }, // unrelated to orphan.mjs
      targetExistedAtBase: ['src/orphan.mjs', 'src/main.mjs', 'src/dep.mjs'],
    });
    const head = makeHead({
      callersByTarget: { 'src/dep.mjs': ['src/main.mjs'] },
      targetsByCaller: { 'src/main.mjs': ['src/dep.mjs'] },
      allFiles: ['src/main.mjs', 'src/orphan.mjs', 'src/dep.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.rawFindings.length, 0);
    assert.equal(r.state, 'ANALYZED_CLEAN');
  });

  it('(c) entry-point exempted from orphan check', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'M', baseCallerPath: 'src/main.mjs', headCallerPath: 'src/main.mjs' }],
      preEdgesByBaseCaller: { 'src/main.mjs': ['scripts/cli.mjs'] },
      targetExistedAtBase: ['scripts/cli.mjs', 'src/main.mjs'],
      entryPoints: ['scripts/cli.mjs'],
    });
    const head = makeHead({
      callersByTarget: {},
      targetsByCaller: { 'src/main.mjs': [] },
      allFiles: ['src/main.mjs', 'scripts/cli.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.rawFindings.length, 0);
  });

  it('(d) test file orphaned → not flagged (test files never orphan candidates)', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'M', baseCallerPath: 'src/main.mjs', headCallerPath: 'src/main.mjs' }],
      preEdgesByBaseCaller: { 'src/main.mjs': ['tests/old.test.mjs'] },
      targetExistedAtBase: ['tests/old.test.mjs', 'src/main.mjs'],
    });
    const head = makeHead({
      callersByTarget: {},
      targetsByCaller: { 'src/main.mjs': [] },
      allFiles: ['src/main.mjs', 'tests/old.test.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.rawFindings.length, 0);
  });

  it('(d2) doc-embedded example file added with no callers → not flagged (dead-code-phase-1-followup)', () => {
    // Regression for the confirmed FP: docs/plans/security/files/scripts/security-incidents.mjs
    // (a plan-doc snapshot bundle, never live source) was flagged as a born-orphan.
    const scope = makeScope({
      changedFiles: [{ status: 'A', baseCallerPath: null, headCallerPath: 'docs/plans/security/files/scripts/security-incidents.mjs' }],
      targetExistedAtBase: [],
    });
    const head = makeHead({
      callersByTarget: {},
      targetsByCaller: { 'docs/plans/security/files/scripts/security-incidents.mjs': [] },
      allFiles: ['docs/plans/security/files/scripts/security-incidents.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.rawFindings.length, 0);
    assert.equal(r.state, 'ANALYZED_CLEAN');
  });

  it('(d3) file with ONLY a doc-example caller → still flagged as orphan (audit-code round-1 finding: caller-side symmetry)', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'M', baseCallerPath: 'src/main.mjs', headCallerPath: 'src/main.mjs' }],
      preEdgesByBaseCaller: { 'src/main.mjs': ['src/lib.mjs'] },
      targetExistedAtBase: ['src/lib.mjs', 'src/main.mjs', 'docs/plans/example/scripts/x.mjs'],
    });
    const head = makeHead({
      callersByTarget: {
        // Only a doc-embedded snapshot file imports src/lib.mjs at HEAD — not live.
        'src/lib.mjs': ['docs/plans/example/scripts/x.mjs'],
      },
      targetsByCaller: {
        'src/main.mjs': [],
        'docs/plans/example/scripts/x.mjs': ['src/lib.mjs'],
      },
      allFiles: ['src/main.mjs', 'src/lib.mjs', 'docs/plans/example/scripts/x.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.rawFindings.length, 1);
    assert.equal(r.rawFindings[0].file, 'src/lib.mjs');
  });

  it('(e) file with ONLY test callers → still flagged as orphan (test callers filtered out)', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'M', baseCallerPath: 'src/main.mjs', headCallerPath: 'src/main.mjs' }],
      preEdgesByBaseCaller: { 'src/main.mjs': ['src/lib.mjs'] },
      targetExistedAtBase: ['src/lib.mjs', 'src/main.mjs', 'tests/lib.test.mjs'],
    });
    const head = makeHead({
      callersByTarget: {
        // Only a test imports src/lib.mjs at HEAD — counts as orphan in prod
        'src/lib.mjs': ['tests/lib.test.mjs'],
      },
      targetsByCaller: {
        'src/main.mjs': [],
        'tests/lib.test.mjs': ['src/lib.mjs'],
      },
      allFiles: ['src/main.mjs', 'src/lib.mjs', 'tests/lib.test.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.rawFindings.length, 1);
    assert.equal(r.rawFindings[0].file, 'src/lib.mjs');
    assert.deepEqual(r.rawFindings[0].testCallers, ['tests/lib.test.mjs']);
  });

  it('(f) born-orphan: newly added file with no callers', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'A', baseCallerPath: null, headCallerPath: 'src/new-orphan.mjs' }],
      targetExistedAtBase: [],
    });
    const head = makeHead({
      callersByTarget: {},
      targetsByCaller: { 'src/new-orphan.mjs': [] },
      allFiles: ['src/new-orphan.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.rawFindings.length, 1);
    assert.equal(r.rawFindings[0].subKind, 'born-orphan');
    assert.equal(r.rawFindings[0].file, 'src/new-orphan.mjs');
    assert.deepEqual(r.rawFindings[0].allRemovedCallers, []); // born-orphan has no removers
  });

  it('(g) rename → suspect added on new path', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'R', baseCallerPath: 'src/old-name.mjs', headCallerPath: 'src/new-name.mjs' }],
      preEdgesByBaseCaller: { 'src/old-name.mjs': [] },
      targetExistedAtBase: ['src/old-name.mjs'],
    });
    const head = makeHead({
      callersByTarget: {},
      targetsByCaller: { 'src/new-name.mjs': [] },
      allFiles: ['src/new-name.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    // The renamed file has no callers → born-orphan-style finding on the new path
    assert.equal(r.rawFindings.length, 1);
    assert.equal(r.rawFindings[0].file, 'src/new-name.mjs');
  });

  it('(h) C (copy) status treated like A', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'C', baseCallerPath: null, headCallerPath: 'src/copy.mjs' }],
      targetExistedAtBase: [],
    });
    const head = makeHead({
      callersByTarget: {},
      targetsByCaller: { 'src/copy.mjs': [] },
      allFiles: ['src/copy.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.rawFindings.length, 1);
    assert.equal(r.rawFindings[0].subKind, 'born-orphan');
  });

  it('(i) deleted caller (D-status) drops all its preTargets', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'D', baseCallerPath: 'src/old-main.mjs', headCallerPath: null }],
      preEdgesByBaseCaller: { 'src/old-main.mjs': ['src/util.mjs'] },
      targetExistedAtBase: ['src/util.mjs', 'src/old-main.mjs'],
    });
    const head = makeHead({
      callersByTarget: {},
      targetsByCaller: {},
      allFiles: ['src/util.mjs'], // old-main.mjs deleted — not in HEAD
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.rawFindings.length, 1);
    assert.equal(r.rawFindings[0].file, 'src/util.mjs');
    assert.deepEqual(r.rawFindings[0].allRemovedCallers, ['src/old-main.mjs']);
  });

  it('(j) cross-target attribution — multiple removers tracked exactly (R5/H1)', () => {
    const scope = makeScope({
      changedFiles: [
        { status: 'M', baseCallerPath: 'src/a.mjs', headCallerPath: 'src/a.mjs' },
        { status: 'M', baseCallerPath: 'src/b.mjs', headCallerPath: 'src/b.mjs' },
        { status: 'M', baseCallerPath: 'src/c.mjs', headCallerPath: 'src/c.mjs' },
      ],
      preEdgesByBaseCaller: {
        'src/a.mjs': ['src/target.mjs'],
        'src/b.mjs': ['src/target.mjs'],
        'src/c.mjs': ['src/other.mjs'], // c removed an edge to something ELSE
      },
      targetExistedAtBase: ['src/target.mjs', 'src/other.mjs', 'src/a.mjs', 'src/b.mjs', 'src/c.mjs'],
    });
    const head = makeHead({
      // a and b both dropped src/target.mjs; c kept it (didn't have it). c dropped src/other.mjs.
      callersByTarget: { 'src/other.mjs': [] }, // also orphaned but by c only
      targetsByCaller: { 'src/a.mjs': [], 'src/b.mjs': [], 'src/c.mjs': [] },
      allFiles: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/target.mjs', 'src/other.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    const targetFinding = r.rawFindings.find(f => f.file === 'src/target.mjs');
    const otherFinding = r.rawFindings.find(f => f.file === 'src/other.mjs');
    assert.ok(targetFinding, 'expected finding on src/target.mjs');
    assert.ok(otherFinding, 'expected finding on src/other.mjs');
    // Exact attribution: target dropped by a + b (NOT c); other dropped by c only.
    assert.deepEqual(targetFinding.allRemovedCallers, ['src/a.mjs', 'src/b.mjs']);
    assert.deepEqual(otherFinding.allRemovedCallers, ['src/c.mjs']);
  });

  it('(k) ANALYZED_PARTIAL inherited from upstream scope state', () => {
    const scope = makeScope({ state: 'ANALYZED_PARTIAL' });
    const head = makeHead();
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(r.state, 'ANALYZED_PARTIAL');
  });

  it('(l) empty inputs → ANALYZED_CLEAN', () => {
    const r = detectOrphansIntroduced({ scope: makeScope(), head: makeHead() });
    assert.equal(r.rawFindings.length, 0);
    assert.equal(r.state, 'ANALYZED_CLEAN');
  });

  it('priorCallers display list capped at 3, allRemovedCallers full + sorted', () => {
    const scope = makeScope({
      changedFiles: ['a', 'b', 'c', 'd', 'e'].map(p => ({
        status: 'M', baseCallerPath: `src/${p}.mjs`, headCallerPath: `src/${p}.mjs`,
      })),
      preEdgesByBaseCaller: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(p => [`src/${p}.mjs`, ['src/target.mjs']])),
      targetExistedAtBase: ['src/target.mjs', 'src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/e.mjs'],
    });
    const head = makeHead({
      callersByTarget: {},
      targetsByCaller: { 'src/a.mjs': [], 'src/b.mjs': [], 'src/c.mjs': [], 'src/d.mjs': [], 'src/e.mjs': [] },
      allFiles: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/e.mjs', 'src/target.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    const finding = r.rawFindings.find(f => f.file === 'src/target.mjs');
    assert.equal(finding.allRemovedCallers.length, 5);
    assert.equal(finding.priorCallers.length, 3);
    // Sorted alphabetically
    assert.deepEqual(finding.allRemovedCallers,
      ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/e.mjs']);
    // Rationale mentions the overflow
    assert.match(finding.rationale, /more/);
  });

  it('_meta includes counts', () => {
    const scope = makeScope({
      changedFiles: [{ status: 'A', baseCallerPath: null, headCallerPath: 'src/new.mjs' }],
    });
    const head = makeHead({
      callersByTarget: {},
      targetsByCaller: { 'src/new.mjs': [] },
      allFiles: ['src/new.mjs'],
    });
    const r = detectOrphansIntroduced({ scope, head });
    assert.equal(typeof r._meta.suspectsCount, 'number');
    assert.equal(typeof r._meta.removedEdgeTargetCount, 'number');
    assert.equal(typeof r._meta.totalRemovedEdges, 'number');
    assert.equal(typeof r._meta.entryPointsCount, 'number');
  });
});
