/**
 * @fileoverview Tier 2 — corpus suites, subsets, frozen legacy identities and judge-free expect_clean scoring
 * (plan docs/plans/sashiko-audit-improvements.md §5.6). The real corpus is read, so a regression in the shipped file shows here.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('entry shape per suite (audit r1 M2/M9)', () => {
  const c = real();
  const errs = (e) => validateCorpus({ ...c, defects: [...c.defects, e] }).errors.join(' | ');
  it('a missed entry must say our own audit cleared it', () => {
    assert.match(errs(entry({ id: 'KD-910', suite: 'missed' })), /auditCleared: true/);
    assert.equal(validateCorpus({ ...c, defects: [...c.defects, entry({ id: 'KD-911', suite: 'missed', auditCleared: true })] }).ok, true);
  });
  it('detect/missed need a fixCommit and typed repo/files', () => {
    assert.match(errs(entry({ id: 'KD-912', fixCommit: undefined })), /needs buggyCommit, fixCommit/);
    assert.match(errs(entry({ id: 'KD-913', repo: undefined })), /needs a repo and a non-empty files/);
    assert.match(errs(entry({ id: 'KD-914', files: [] })), /non-empty files/);
    assert.match(errs(entry({ id: 'KD-915', files: [3] })), /array of strings/);
  });
});

describe('the selection stamp', () => {
  const c = { version: 4, defects: [entry({ id: 'KD-1' }), entry({ id: 'KD-2' })] };
  const stampFor = (corpus, over = {}) => ({ ...selectionStamp(corpus, { suite: 'detect', subset: 'full', seed: 1, requestedN: 2, selected: corpus.defects }), corpusLoaderVersion: 'v2', ...over });
  it('an incomplete stamp is never comparable, not even to another incomplete one (r1 H5)', () => {
    assert.match(stampMismatch({}, {}), /^incomplete-stamp:/);
    assert.match(stampMismatch(stampFor(c), {}), /^incomplete-stamp:/);
    assert.match(stampMismatch(stampFor(c, { corpusDigest: undefined }), stampFor(c)), /incomplete-stamp:corpusDigest/);
  });
  it('every field is compared: corpusVersion, seed and requestedN each differ alone (r1 H8)', () => {
    assert.equal(stampMismatch(stampFor(c), stampFor(c, { corpusVersion: '9' })), 'corpusVersion');
    assert.equal(stampMismatch(stampFor(c), { ...stampFor(c), selection: { ...stampFor(c).selection, seed: 2 } }), 'selection.seed');
    assert.equal(stampMismatch(stampFor(c), { ...stampFor(c), selection: { ...stampFor(c).selection, requestedN: 3 } }), 'selection.requestedN');
  });
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
  it('malformed output is failed, never clean (r1 H6/H7)', () => {
    for (const bad of [{}, { findings: null }, { findings: 'none' }, { findings: [{ severity: 'HIGH' }] }, { findings: [{ file: 'a.js' }] }, 'ok', 42]) {
      assert.equal(scoreExpectCleanCase(bad, ['a.js']).outcome, 'failed', JSON.stringify(bad));
    }
    assert.equal(scoreExpectCleanCase({ findings: [] }, ['a.js']).outcome, 'clean', 'control: a valid empty array is clean');
  });
  it('equivalent path spellings match (r1 M4)', () => {
    for (const spelling of ['./a.js', 'A.JS', 'a.js']) assert.equal(scoreExpectCleanCase({ findings: [{ file: spelling, severity: 'HIGH' }] }, ['a.js']).outcome, 'false_positive');
    assert.equal(scoreExpectCleanCase({ findings: [{ file: 'dir\\b.js', severity: 'HIGH' }] }, ['dir/b.js']).outcome, 'false_positive');
  });
  it('the suite block counts a failed case in the denominator; zero cases is unmeasured', () => {
    const perCase = [{ outcome: 'clean' }, { outcome: 'false_positive' }, { outcome: 'failed' }];
    assert.deepEqual(summarizeExpectClean(perCase), { cases: 3, clean: 1, falsePositive: 1, failed: 1, fpRate: 1 / 2, measuredRate: 2 / 3 });
    assert.deepEqual(summarizeExpectClean([]), { cases: 0, failed: 0, unmeasured: true });
    assert.deepEqual(summarizeExpectClean([{ outcome: 'failed' }, { outcome: 'failed' }]), { cases: 2, failed: 2, unmeasured: true }, 'every audit failed: unmeasured, not fpRate 0 (r1 M8)');
  });
});

describe('loading an expect_clean case (hermetic fixture repo, r1 M11)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-fixture-'));
  const root = path.join(dir, 'fixture-repo');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (...a) => execFileSync('git', ['-C', root, '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8', env }).trim();
  fs.mkdirSync(root);
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'base.js'), 'export const a = 1;\n'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(root, 'clean.js'), 'export const c = 2;\n'); g('add', '-A'); g('commit', '-q', '-m', 'add clean.js');
  const head = g('rev-parse', 'HEAD');
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const kd = (over = {}) => ({ id: 'KD-960', repo: 'fixture-repo', suite: 'expect_clean', commit: head, files: ['clean.js'], rationale: 'r', ...over });
  it('uses `commit`, hides no rubric, and keeps the declared-files-in-diff invariant', () => {
    const r = loadCorpusCase({ kdEntry: kd(), repoRoots: [root] });
    assert.equal(r.hiddenGroundTruth.suite, 'expect_clean');
    assert.equal(Object.hasOwn(r.hiddenGroundTruth, 'expectedFindingRubric'), false);
    assert.ok(r.visibleInput.diff.length > 0);
    assert.throws(() => loadCorpusCase({ kdEntry: kd({ files: ['not/in/the/diff.js'] }), repoRoots: [root] }), (e) => e instanceof CorpusCaseUnavailable && e.reason === 'declared_files_not_in_diff');
  });
});
