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
  STAGE_FINDINGS_VERSION, buildStageFindingsArtifact, captureStageFindings, computeStageRecall, loadEligibleEntries,
  projectStageFindings,
} from '../scripts/lib/model-eval/stage-recall.mjs';

const entries = [
  { id: 'KD-1', files: ['src/a.js'], expectedFindingRubric: 'flags use before declaration of mergedResult variable temporal dead zone' },
  { id: 'KD-2', files: ['src/b.js'], expectedFindingRubric: 'missing await on the cache invalidation promise' },
];
const art = (stage, entryId, findings, runId = 'r1') => ({
  version: STAGE_FINDINGS_VERSION, runId, corpusRev: 'abc123', entryId, stage, findings,
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
    assert.deepEqual(r.stages.raw, { numerator: 0, denominator: 1, recall: null, unmeasuredReason: 'findings carry no description' });
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
    assert.throws(() => computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [hit]), { ...art('raw', 'KD-2', [hit]), corpusRev: 'other' }] }), /corpusRev/);
    assert.throws(() => computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [hit]), art('raw', 'KD-1', [hit])] }), /duplicate/);
    assert.throws(() => computeStageRecall({ entries, artifacts: [art('raw', 'KD-1', [{ ...hit, extra: 1 }])] }));
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

describe('captureStageFindings - behind AUDIT_STAGE_CAPTURE_DIR', () => {
  const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stage-cap-'));
  it('unset: no write, nothing created', () => {
    const r = captureStageFindings({ stage: 'raw', runId: 'r', findings: [], env: {} });
    assert.deepEqual(r, { written: false, reason: 'capture-off' });
  });
  it('set and bound: writes one v1 artifact per stage', () => {
    const dir = dirOf();
    const env = { AUDIT_STAGE_CAPTURE_DIR: dir, AUDIT_STAGE_CAPTURE_ENTRY_ID: 'KD-1', AUDIT_STAGE_CAPTURE_CORPUS_REV: 'abc123' };
    const r = captureStageFindings({ stage: 'raw', runId: 'run/1', findings: [{ id: 'H1', severity: 'HIGH', section: 'src/a.js:3', detail: 'd' }], env });
    assert.equal(r.written, true);
    const j = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    assert.equal(j.version, STAGE_FINDINGS_VERSION);
    assert.equal(j.stage, 'raw');
    assert.equal(path.dirname(r.file), dir);
    assert.deepEqual(buildStageFindingsArtifact({ runId: 'run/1', corpusRev: 'abc123', entryId: 'KD-1', stage: 'raw', findings: [{ id: 'H1', severity: 'HIGH', section: 'src/a.js:3', detail: 'd' }] }), j);
  });
  it('set but unbound: skipped loudly, never guessed, never throws', () => {
    const dir = dirOf();
    const r = captureStageFindings({ stage: 'raw', runId: 'r', findings: [], env: { AUDIT_STAGE_CAPTURE_DIR: dir } });
    assert.equal(r.reason, 'unbound');
    assert.deepEqual(fs.readdirSync(dir), []);
  });
  it('a malformed finding does not throw out of the capture point', () => {
    const dir = dirOf();
    const env = { AUDIT_STAGE_CAPTURE_DIR: dir, AUDIT_STAGE_CAPTURE_ENTRY_ID: 'KD-1', AUDIT_STAGE_CAPTURE_CORPUS_REV: 'abc123' };
    const r = captureStageFindings({ stage: 'raw', runId: 'r', findings: [{ id: 'H1', severity: 'BOGUS' }], env });
    assert.deepEqual([r.written, r.reason], [false, 'write-failed']);
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
