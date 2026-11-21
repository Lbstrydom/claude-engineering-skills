/**
 * @fileoverview Per-stage recall (scripts/lib/model-eval/stage-recall.mjs): artifact contract, capture writer, eligibility,
 * and what is measured vs reported unmeasured.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  STAGE_FINDINGS_VERSION, artifactFileName, buildStageFindingsArtifact, captureStageFindings, computeStageRecall, loadEligibleEntries,
  projectStageFindings, resolveCorpusRev,
} from '../scripts/lib/model-eval/stage-recall.mjs';

const REV = 'a'.repeat(40);
const entries = [
  { id: 'KD-1', files: ['src/a.js'], expectedFindingRubric: 'flags use before declaration of mergedResult variable temporal dead zone' },
  { id: 'KD-2', files: ['src/b.js'], expectedFindingRubric: 'missing await on the cache invalidation promise' },
];
const art = (stage, entryId, findings, runId = 'r1') => ({
  version: STAGE_FINDINGS_VERSION, runId, corpusRev: REV, entryId, stage, findings,
});
const finding = (file, description, extra = {}) => ({ topicId: 'H1', file, line: 10, severity: 'HIGH', importance: 'important', ...(description ? { description } : {}), ...extra });
const hit = finding('src/a.js', 'use before declaration of mergedResult variable in temporal dead zone');

describe('computeStageRecall', () => {
  it('measures each stage with the scorer match contract; the join is run+entry', () => {
    const r = computeStageRecall({ entries, artifacts: [
      art('raw', 'KD-1', [hit]), art('post-verification', 'KD-1', []),
      art('raw', 'KD-2', [finding('src/b.js', 'missing await on the cache invalidation promise')]),
      art('post-verification', 'KD-2', [finding('src/b.js', 'missing await on the cache invalidation promise')]),
    ] });
    assert.deepEqual(r.stages.raw, { numerator: 2, denominator: 2, recall: 1, unmeasuredReason: null });
    assert.deepEqual(r.stages['post-verification'], { numerator: 1, denominator: 2, recall: 0.5, unmeasuredReason: null });
  });
  it('an empty finding list is a measured zero (the stage found nothing)', () => {
    const r = computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [])] });
    assert.deepEqual(r.stages.raw, { numerator: 0, denominator: 1, recall: 0, unmeasuredReason: null });
  });
  it('findings with no description are unmeasured, never a fabricated 0', () => {
    const r = computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [finding('src/a.js')])] });
    assert.deepEqual(r.stages.raw, { numerator: 0, denominator: 0, recall: null, unmeasuredReason: 'findings carry no description' });
    assert.equal(r.droppedUnits[0].reason, 'findings carry no description in stage raw');
  });
  it('a stage with no artifact reports not captured (final-gate)', () => {
    const r = computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [hit])] });
    assert.equal(r.stages['final-gate'].recall, null);
    assert.equal(r.stages['final-gate'].unmeasuredReason, 'stage not captured');
  });
  it('a wrong-file finding with a matching description does not match (file rule reused)', () => {
    const r = computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [finding('src/zzz.js', hit.description)])] });
    assert.equal(r.stages.raw.numerator, 0);
  });
  it('an entry outside the eligible set (invalidated) is ignored and named', () => {
    const r = computeStageRecall({ entries, artifacts: [art('raw', 'KD-13', [hit]), art('raw', 'KD-1', [hit])] });
    assert.deepEqual(r.ignoredEntryIds, ['KD-13']);
    assert.equal(r.stages.raw.denominator, 1);
  });
  it('rejects a malformed artifact, mixed corpusRev and a duplicated unit', () => {
    assert.throws(() => computeStageRecall({ entries, artifacts: [{ ...art('raw', 'KD-1', [hit]), version: 'v0' }] }));
    assert.throws(() => computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [hit]), { ...art('raw', 'KD-2', [hit]), corpusRev: 'b'.repeat(40) }] }), /corpusRev/);
    assert.throws(() => computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [hit]), art('raw', 'KD-1', [hit])] }), /duplicate/);
    assert.throws(() => computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [{ ...hit, extra: 1 }])] }));
  });
});

describe('computeStageRecall - the same units in every compared stage (H13/H16/M6)', () => {
  it('H16: a unit missing from one stage is dropped from ALL stages and named', () => {
    const r = computeStageRecall({ entries, artifacts: [
      art('raw', 'KD-1', [hit]), art('post-verification', 'KD-1', [hit]),
      art('raw', 'KD-2', [finding('src/b.js', 'missing await on the cache invalidation promise')]),   // no post-verification for KD-2
    ] });
    assert.deepEqual(r.stages.raw, { numerator: 1, denominator: 1, recall: 1, unmeasuredReason: null });
    assert.deepEqual(r.stages['post-verification'], { numerator: 1, denominator: 1, recall: 1, unmeasuredReason: null });
    assert.deepEqual(r.droppedUnits, [{ runId: 'r1', entryId: 'KD-2', reason: 'not captured in stage post-verification' }]);
  });
  it('the join is by (runId, entryId): the same entry in two runs is two units', () => {
    const r = computeStageRecall({ entries, artifacts: [
      art('raw', 'KD-1', [hit], 'r1'), art('post-verification', 'KD-1', [hit], 'r1'),
      art('raw', 'KD-1', [hit], 'r2'), art('post-verification', 'KD-1', [], 'r2'),
    ] });
    assert.equal(r.stages.raw.denominator, 2);
    assert.equal(r.stages.raw.numerator, 2);
    assert.equal(r.stages['post-verification'].numerator, 1);
  });
  it('H13: description availability is per UNIT - an undescribed unit is dropped, not scored as a miss', () => {
    const r = computeStageRecall({ entries, artifacts: [
      art('raw', 'KD-1', [hit]), art('raw', 'KD-2', [finding('src/b.js')]),   // KD-2 has findings but no description
    ] });
    assert.deepEqual(r.stages.raw, { numerator: 1, denominator: 1, recall: 1, unmeasuredReason: null });
    assert.deepEqual(r.droppedUnits, [{ runId: 'r1', entryId: 'KD-2', reason: 'findings carry no description in stage raw' }]);
  });
  it('stages with no unit in common report unmeasured, never a fabricated zero', () => {
    const r = computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [hit]), art('post-verification', 'KD-2', [])] });
    assert.equal(r.stages.raw.recall, null);
    assert.equal(r.stages.raw.unmeasuredReason, 'no unit captured in every compared stage');
  });
});

describe('projectStageFindings', () => {
  it('derives file:line from section and importance null for a legacy finding', () => {
    const [p] = projectStageFindings([{ id: 'H1', severity: 'HIGH', section: 'src/a.js:42', detail: 'x' }]);
    assert.deepEqual(p, { topicId: 'H1', file: 'src/a.js', line: 42, severity: 'HIGH', importance: null, description: 'x' });
  });
  it('prefers the verified anchor', () => {
    const [p] = projectStageFindings([{ id: 'H2', severity: 'LOW', section: 'ignored', anchor: { newFile: 'q.js', startLine: 7 }, importance: 'nit' }]);
    assert.deepEqual([p.file, p.line, p.importance, 'description' in p], ['q.js', 7, 'nit', false]);
  });
});

describe('corpusRev is a resolved full sha (H15/M11)', () => {
  it('score time refuses a mutable ref and a short sha', () => {
    assert.throws(() => computeStageRecall({ entries, artifacts: [{ ...art('raw', 'KD-1', [hit]), corpusRev: 'main' }] }));
    assert.throws(() => computeStageRecall({ entries, artifacts: [{ ...art('raw', 'KD-1', [hit]), corpusRev: 'abc123' }] }));
    assert.throws(() => loadEligibleEntries('main', { exec: () => '{"defects":[]}' }), /full commit sha/);
  });
  it('resolveCorpusRev asks git once, returns the full sha, and rejects a non-commit answer', () => {
    let calls = 0;
    const exec = (_c, args) => { calls++; assert.ok(args.includes('some-ref^{commit}')); return `${'c'.repeat(40)}\n`; };
    assert.equal(resolveCorpusRev('some-ref', { cwd: 'x1', exec }), 'c'.repeat(40));
    resolveCorpusRev('some-ref', { cwd: 'x1', exec });
    assert.equal(calls, 1);
    assert.throws(() => resolveCorpusRev('bad-ref', { cwd: 'x2', exec: () => 'not-a-sha' }));
  });
  it('capture stores the RESOLVED sha, not the ref it was given', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-rev-'));
    const env = { AUDIT_STAGE_CAPTURE_DIR: dir, AUDIT_STAGE_CAPTURE_ENTRY_ID: 'KD-1', AUDIT_STAGE_CAPTURE_CORPUS_REV: 'main' };
    const r = captureStageFindings({ stage: 'raw', runId: 'r', findings: [], env, resolveRev: () => REV });
    assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf8')).corpusRev, REV);
  });
  it('an unresolvable ref is a skipped capture, not a written one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-rev-'));
    const env = { AUDIT_STAGE_CAPTURE_DIR: dir, AUDIT_STAGE_CAPTURE_ENTRY_ID: 'KD-1', AUDIT_STAGE_CAPTURE_CORPUS_REV: 'nope' };
    const r = captureStageFindings({ stage: 'raw', runId: 'r', findings: [], env, resolveRev: () => { throw new Error('unknown revision'); } });
    assert.deepEqual([r.written, fs.readdirSync(dir).length], [false, 0]);
  });
});

describe('captureStageFindings - behind AUDIT_STAGE_CAPTURE_DIR', () => {
  it('H7/M7: run/1 and run_1 never share a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-coll-'));
    const env = { AUDIT_STAGE_CAPTURE_DIR: dir, AUDIT_STAGE_CAPTURE_ENTRY_ID: 'KD-1', AUDIT_STAGE_CAPTURE_CORPUS_REV: REV };
    const a = captureStageFindings({ stage: 'raw', runId: 'run/1', findings: [], env, resolveRev: () => REV });
    const b = captureStageFindings({ stage: 'raw', runId: 'run_1', findings: [], env, resolveRev: () => REV });
    assert.notEqual(a.file, b.file);
    assert.equal(fs.readdirSync(dir).length, 2);
    assert.equal(JSON.parse(fs.readFileSync(a.file, 'utf8')).runId, 'run/1');
    assert.notEqual(artifactFileName({ runId: 'a', entryId: 'b.c', stage: 'raw' }), artifactFileName({ runId: 'a.b', entryId: 'c', stage: 'raw' }));
  });
  const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stage-cap-'));
  it('unset: no write, nothing created', () => {
    const r = captureStageFindings({ stage: 'raw', runId: 'r', findings: [], env: {} });
    assert.deepEqual(r, { written: false, reason: 'capture-off' });
  });
  it('set and bound: writes one v1 artifact per stage', () => {
    const dir = dirOf();
    const env = { AUDIT_STAGE_CAPTURE_DIR: dir, AUDIT_STAGE_CAPTURE_ENTRY_ID: 'KD-1', AUDIT_STAGE_CAPTURE_CORPUS_REV: REV };
    const r = captureStageFindings({ stage: 'raw', runId: 'run/1', findings: [{ id: 'H1', severity: 'HIGH', section: 'src/a.js:3', detail: 'd' }], env, resolveRev: () => REV });
    assert.equal(r.written, true);
    const j = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    assert.equal(j.version, STAGE_FINDINGS_VERSION);
    assert.equal(j.stage, 'raw');
    assert.equal(path.dirname(r.file), dir);
    assert.deepEqual(buildStageFindingsArtifact({ runId: 'run/1', corpusRev: REV, entryId: 'KD-1', stage: 'raw', findings: [{ id: 'H1', severity: 'HIGH', section: 'src/a.js:3', detail: 'd' }] }), j);
  });
  it('set but unbound: skipped loudly, never guessed, never throws', () => {
    const dir = dirOf();
    const r = captureStageFindings({ stage: 'raw', runId: 'r', findings: [], env: { AUDIT_STAGE_CAPTURE_DIR: dir }, resolveRev: () => REV });
    assert.equal(r.reason, 'unbound');
    assert.deepEqual(fs.readdirSync(dir), []);
  });
  it('a malformed finding does not throw out of the capture point', () => {
    const dir = dirOf();
    const env = { AUDIT_STAGE_CAPTURE_DIR: dir, AUDIT_STAGE_CAPTURE_ENTRY_ID: 'KD-1', AUDIT_STAGE_CAPTURE_CORPUS_REV: REV };
    const r = captureStageFindings({ stage: 'raw', runId: 'r', findings: [{ id: 'H1', severity: 'BOGUS' }], env, resolveRev: () => REV });
    assert.deepEqual([r.written, r.reason], [false, 'write-failed']);
  });
});

describe('projectStageFindings - anchor side (H17)', () => {
  it('a base-side anchor reports oldFile; a head-side anchor reports newFile', () => {
    const [b] = projectStageFindings([{ id: 'H1', severity: 'HIGH', anchor: { side: 'base', oldFile: 'gone.js', newFile: 'new.js', startLine: 4 } }]);
    const [h] = projectStageFindings([{ id: 'H2', severity: 'HIGH', anchor: { side: 'head', oldFile: 'gone.js', newFile: 'new.js', startLine: 4 } }]);
    assert.deepEqual([b.file, h.file], ['gone.js', 'new.js']);
  });
  it('a base-side anchor on a deleted file (no newFile) still locates', () => {
    const [b] = projectStageFindings([{ id: 'H1', severity: 'LOW', anchor: { side: 'base', oldFile: 'gone.js', startLine: 9 } }]);
    assert.deepEqual([b.file, b.line], ['gone.js', 9]);
  });
});

describe('loadEligibleEntries - corpus shape (H14)', () => {
  it('a corpus without a defects array is an error, never an empty corpus', () => {
    for (const bad of ['{}', '[]', '{"defects":{}}', 'null']) {
      assert.throws(() => loadEligibleEntries(REV, { exec: () => bad }), /defects/, bad);
    }
    assert.deepEqual(loadEligibleEntries(REV, { exec: () => '{"defects":[]}' }), []);   // negative control: a real empty array is fine
  });
});

describe('loadEligibleEntries - read at corpusRev via git show', () => {
  it('drops invalidated entries and reads the committed revision, not the working tree', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-corpus-'));
    const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
    git('init', '-q');
    const p = path.join(repo, 'docs/experiments/audit-effectiveness/known-defects.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ defects: [{ id: 'KD-1', files: [], expectedFindingRubric: 'r' }, { id: 'KD-2', invalidated: true }] }));
    git('add', '.'); git('commit', '-q', '-m', 'c1');
    const rev = git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(p, JSON.stringify({ defects: [] }));   // working tree moves on
    assert.deepEqual(loadEligibleEntries(rev, { cwd: repo }).map((e) => e.id), ['KD-1']);
  });
});
