/**
 * @fileoverview Tier 2 — corpus suites, subsets, frozen legacy identities and judge-free expect_clean scoring
 * (plan docs/plans/sashiko-audit-improvements.md §5.6). The real corpus is read, so a regression in the shipped file shows here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  LEGACY_UNCURATED_KD, validateCorpus, selectPool, selectionStamp, stampMismatch, corpusDigest,
  scoreExpectCleanCase, summarizeExpectClean,
} from '../scripts/lib/model-eval/corpus-selection.mjs';
import { loadCorpusCase, CorpusCaseUnavailable } from '../scripts/lib/model-eval/known-defect-corpus.mjs';

const CORPUS_PATH = 'docs/experiments/audit-effectiveness/known-defects.json';
const real = () => JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
const entry = (over = {}) => ({ id: 'KD-900', repo: 'r', buggyCommit: 'b'.repeat(40), fixCommit: 'f'.repeat(40), files: ['x.js'], expectedFindingRubric: 'rubric', curation: { method: 'human-review', reviewedIn: 'worksheet' }, ...over });

describe('the sampling pool', () => {
  it('RED→GREEN: never contains an invalidated entry (KD-013 on the real corpus)', () => {
    const c = real();
    assert.equal(c.defects.find((d) => d.id === 'KD-013').invalidated, true);
    const pool = selectPool(c);
    assert.equal(pool.some((d) => d.invalidated), false);
    assert.equal(pool.length, c.defects.length - c.defects.filter((d) => d.invalidated).length);
  });
  it('narrows to the requested suite and refuses an unknown suite or an undeclared subset', () => {
    const c = { version: 4, defects: [entry({ id: 'KD-901' }), entry({ id: 'KD-902', suite: 'missed' })], subsets: { tiny: ['KD-901'] } };
    assert.deepEqual(selectPool(c).map((d) => d.id), ['KD-901']);
    assert.deepEqual(selectPool(c, { suite: 'missed' }).map((d) => d.id), ['KD-902']);
    assert.deepEqual(selectPool(c, { subset: 'tiny' }).map((d) => d.id), ['KD-901']);
    assert.throws(() => selectPool(c, { suite: 'nope' }), /unknown suite/);
    assert.throws(() => selectPool(c, { subset: 'small' }), /no "small" subset/);
  });
});

describe('validateCorpus', () => {
  it('accepts the shipped corpus: the 18 legacy identities need no curation', () => {
    assert.deepEqual(validateCorpus(real()), { ok: true, errors: [] });
    assert.equal(LEGACY_UNCURATED_KD.length, 18);
  });
  it('LEGACY_UNCURATED_KD equals the identities committed at 1df6fbfb', () => {
    const old = JSON.parse(execFileSync('git', ['show', `1df6fbfb:${CORPUS_PATH}`], { encoding: 'utf8' }));
    const want = old.defects.map((d) => ({ id: d.id, repo: d.repo, buggyCommit: d.buggyCommit, fixCommit: d.fixCommit }));
    assert.deepEqual(LEGACY_UNCURATED_KD.map((l) => ({ ...l })), want);
  });
  it('a new entry without curation fails; a legacy repointed at another commit loses its exemption', () => {
    const c = real();
    assert.ok(validateCorpus({ ...c, defects: [...c.defects, entry({ curation: undefined })] }).errors.some((e) => /KD-900.*curation/.test(e)));
    const repointed = c.defects.map((d) => (d.id === 'KD-002' ? { ...d, buggyCommit: 'c'.repeat(40) } : d));
    assert.ok(validateCorpus({ ...c, defects: repointed }).errors.some((e) => /KD-002.*curation/.test(e)));
    const prose = c.defects.map((d) => (d.id === 'KD-002' ? { ...d, defectDesc: 'reworded' } : d));
    assert.equal(validateCorpus({ ...c, defects: prose }).ok, true, 'a prose correction keeps the exemption');
  });
  it('a curated entry must name its review; a malformed curation fails', () => {
    const c = real();
    assert.equal(validateCorpus({ ...c, defects: [...c.defects, entry()] }).ok, true);
    assert.ok(validateCorpus({ ...c, defects: [...c.defects, entry({ curation: { method: 'auto' } })] }).errors.some((e) => /curation needs/.test(e)));
  });
  it('subsets must name existing, non-invalidated ids', () => {
    const c = real();
    assert.ok(validateCorpus({ ...c, subsets: { tiny: ['KD-404'] } }).errors.some((e) => /unknown id KD-404/.test(e)));
    assert.ok(validateCorpus({ ...c, subsets: { tiny: ['KD-013'] } }).errors.some((e) => /invalidated/.test(e)));
  });
  it('expect_clean has its own shape: commit, files, rationale; no buggyCommit or rubric', () => {
    const base = { id: 'KD-950', repo: 'r', suite: 'expect_clean', commit: 'a'.repeat(40), files: ['x.js'], rationale: 'soaked', curation: { method: 'human-review', reviewedIn: 'w' } };
    const c = real();
    assert.equal(validateCorpus({ ...c, defects: [...c.defects, base] }).ok, true);
    assert.ok(validateCorpus({ ...c, defects: [...c.defects, { ...base, buggyCommit: 'b'.repeat(40) }] }).errors.some((e) => /must not carry/.test(e)));
    const { rationale, ...noRationale } = base;
    assert.ok(validateCorpus({ ...c, defects: [...c.defects, noRationale] }).errors.some((e) => /needs commit, files and rationale/.test(e)));
    assert.ok(validateCorpus({ ...c, defects: [...c.defects, entry({ id: 'KD-951', buggyCommit: undefined })] }).errors.some((e) => /needs buggyCommit/.test(e)));
  });
});

describe('the selection stamp', () => {
  const c = { version: 4, defects: [entry({ id: 'KD-1' }), entry({ id: 'KD-2' })] };
  const stampFor = (corpus, over = {}) => ({ ...selectionStamp(corpus, { suite: 'detect', subset: 'full', seed: 1, requestedN: 2, selected: corpus.defects }), corpusLoaderVersion: 'v2', ...over });
  it('a one-field corpus edit under the same version changes the digest, and the comparison is refused', () => {
    const edited = { ...c, defects: [entry({ id: 'KD-1', expectedFindingRubric: 'edited' }), entry({ id: 'KD-2' })] };
    assert.notEqual(corpusDigest(c), corpusDigest(edited));
    assert.equal(stampMismatch(stampFor(c), stampFor(edited)), 'corpusDigest');
  });
  it('a different subset, suite or selected ids is refused; an identical stamp matches', () => {
    assert.equal(stampMismatch(stampFor(c), stampFor(c)), null);
    assert.equal(stampMismatch(stampFor(c), stampFor(c, { subset: 'tiny' })), 'subset');
    assert.equal(stampMismatch(stampFor(c), stampFor(c, { suite: 'missed' })), 'suite');
    const other = { ...stampFor(c), selection: { seed: 1, requestedN: 2, selectedIds: ['KD-1'] } };
    assert.equal(stampMismatch(stampFor(c), other), 'selection.selectedIds');
  });
});

describe('expect_clean scoring is judge-free and strict', () => {
  it('clean / false_positive (pass recorded) / failed', () => {
    const files = ['a.js'];
    assert.deepEqual(scoreExpectCleanCase({ findings: [] }, files), { outcome: 'clean', passes: [] });
    assert.deepEqual(scoreExpectCleanCase({ findings: [{ file: 'a.js', severity: 'MEDIUM', pass: 'backend' }] }, files), { outcome: 'false_positive', passes: ['backend'] });
    assert.equal(scoreExpectCleanCase({ failed: true }, files).outcome, 'failed');
    assert.equal(scoreExpectCleanCase({ findings: [{ file: 'a.js', severity: 'LOW' }, { file: 'other.js', severity: 'HIGH' }] }, files).outcome, 'clean', 'LOW, or a file outside the case, is not a false positive');
  });
  it('the suite block counts a failed case in the denominator; zero cases is unmeasured', () => {
    const perCase = [{ outcome: 'clean' }, { outcome: 'false_positive' }, { outcome: 'failed' }];
    assert.deepEqual(summarizeExpectClean(perCase), { cases: 3, clean: 1, falsePositive: 1, failed: 1, fpRate: 1 / 3, measuredRate: 2 / 3 });
    assert.deepEqual(summarizeExpectClean([]), { cases: 0, unmeasured: true });
  });
});

describe('loading an expect_clean case', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['show', '--name-only', '--format=', head], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const kd = (over = {}) => ({ id: 'KD-960', repo: 'claude-engineering-skills', suite: 'expect_clean', commit: head, files: files.slice(0, 1), rationale: 'r', ...over });
  it('uses `commit`, hides no rubric, and keeps the declared-files-in-diff invariant', () => {
    const r = loadCorpusCase({ kdEntry: kd(), repoRoots: [process.cwd()] });
    assert.equal(r.hiddenGroundTruth.suite, 'expect_clean');
    assert.equal(Object.hasOwn(r.hiddenGroundTruth, 'expectedFindingRubric'), false);
    assert.ok(r.visibleInput.diff.length > 0);
    assert.throws(() => loadCorpusCase({ kdEntry: kd({ files: ['not/in/the/diff.js'] }), repoRoots: [process.cwd()] }), (e) => e instanceof CorpusCaseUnavailable && e.reason === 'declared_files_not_in_diff');
  });
});
