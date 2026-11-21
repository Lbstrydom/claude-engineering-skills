import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findingKey, indexAdjudications, scoreAdjudicated } from '../scripts/lib/model-eval/expect-clean-adjudication.mjs';
import { validateCorpus, summarizeExpectClean, FLAGGED_RATE_NOTE } from '../scripts/lib/model-eval/corpus-selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } } });

const f = (id, pass = 'backend', severity = 'HIGH') => ({ id, pass, severity });
const v = (kdId, id, cls, extra = {}) => ({ kdId, id, pass: 'backend', class: cls, ...extra });
const idx = (list) => { const r = indexAdjudications(list); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.byKey; };
const perCase = [
  { kdId: 'K1', outcome: 'flagged', findings: [f('H1'), f('M1', 'backend', 'MEDIUM')] },
  { kdId: 'K2', outcome: 'flagged', findings: [f('H1')] },
  { kdId: 'K3', outcome: 'clean' },
  { kdId: 'K4', outcome: 'failed' },
];

describe('scoreAdjudicated: falseClaims / realDefects / nits / notClean instead of a bare rate', () => {
  const byKey = idx([v('K1', 'H1', 'REAL', { preExisting: false }), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'WRONG')]);
  const r = scoreAdjudicated(perCase, byKey);

  it('counts each class, and a case with a REAL defect is notClean (introduced when the commit added it)', () => {
    assert.equal(r.falseClaims, 1); assert.equal(r.realDefects, 1); assert.equal(r.nits, 1);
    assert.equal(r.notClean, 1); assert.equal(r.notCleanIntroducedByCommit, 1); assert.equal(r.casesWithFalseClaim, 1);
    assert.equal(r.complete, true);
    assert.equal(r.falseClaimRate, 1 / 3, 'false claims over JUDGED findings');
    assert.equal(r.measuredCases, 3, 'a failed case is not measured');
  });
  it('a case flagged only by nits or false claims is NOT notClean: flagged and not-clean are different things', () => {
    const k2 = r.perCase.find((c) => c.kdId === 'K2');
    assert.equal(k2.outcome, 'flagged'); assert.equal(k2.notClean, false);
  });
  it('a pre-existing REAL defect makes the case notClean but not introduced-by-commit', () => {
    const q = scoreAdjudicated(perCase, idx([v('K1', 'H1', 'REAL', { preExisting: true }), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'NOT_A_DEFECT')]));
    assert.equal(q.notClean, 1); assert.equal(q.notCleanIntroducedByCommit, 0);
  });
  it('an unadjudicated finding is never counted as anything: the result is INCOMPLETE', () => {
    const q = scoreAdjudicated(perCase, idx([v('K1', 'H1', 'REAL')]));
    assert.equal(q.unadjudicated, 2); assert.equal(q.complete, false);
    assert.equal(q.realDefects, 1); assert.equal(q.nits, 0); assert.equal(q.falseClaims, 0);
  });
  it('a verdict that matches no finding is ORPHANED and reported, never silently ignored', () => {
    const q = scoreAdjudicated(perCase, idx([v('K1', 'H1', 'REAL'), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'WRONG'), v('K9', 'H1', 'REAL')]));
    assert.deepEqual(q.orphaned, ['K9:backend:H1']); assert.equal(q.complete, false);
    assert.equal(q.realDefects, 1, 'the orphan did not count');
  });
  it('findings are keyed by case, pass AND id: the same id in another pass is a different finding', () => {
    assert.notEqual(findingKey('K1', { pass: 'backend', id: 'H1' }), findingKey('K1', { pass: 'Sustainability', id: 'H1' }));
    const q = scoreAdjudicated([{ kdId: 'K1', outcome: 'flagged', findings: [f('H1', 'backend'), f('H1', 'Sustainability')] }],
      idx([{ kdId: 'K1', id: 'H1', pass: 'backend', class: 'REAL' }, { kdId: 'K1', id: 'H1', pass: 'Sustainability', class: 'WRONG' }]));
    assert.equal(q.realDefects, 1); assert.equal(q.falseClaims, 1);
  });
  it('UNDETERMINED is neither a confirmed nor a refuted claim: outside the false-claim rate, which is null (not 0) when nothing was judged', () => {
    const q = scoreAdjudicated([{ kdId: 'K1', outcome: 'flagged', findings: [f('H1')] }], idx([v('K1', 'H1', 'UNDETERMINED')]));
    assert.equal(q.undetermined, 1); assert.equal(q.falseClaimRate, null);
  });
});

describe('indexAdjudications refuses a malformed verdict list', () => {
  for (const [label, list, re] of [
    ['not an array', {}, /must be a JSON array/],
    ['an unknown class', [{ kdId: 'K1', id: 'H1', pass: 'backend', class: 'MAYBE' }], /class must be one of/],
    ['a missing pass', [{ kdId: 'K1', id: 'H1', class: 'REAL' }], /pass must be a non-empty string/],
    ['a duplicate verdict', [v('K1', 'H1', 'REAL'), v('K1', 'H1', 'WRONG')], /duplicate verdict/],
  ]) it(label, () => { const r = indexAdjudications(list); assert.equal(r.ok, false); assert.match(r.errors.join(';'), re); });
});

describe('the raw summary no longer calls a flagged case a false positive', () => {
  it('reports flagged / flaggedRate with a note that says what the rate is NOT', () => {
    const s = summarizeExpectClean([{ outcome: 'clean' }, { outcome: 'flagged' }]);
    assert.equal(s.flagged, 1); assert.equal(s.flaggedRate, 1 / 2);
    assert.equal('fpRate' in s, false); assert.equal('falsePositive' in s, false);
    assert.match(s.flaggedRateNote, /NOT a false-positive rate/); assert.equal(s.flaggedRateNote, FLAGGED_RATE_NOTE);
  });
});

describe('an expect_clean corpus entry records its re-curation as evidence', () => {
  const entry = (over = {}) => ({ id: 'KD-900', repo: 'r', suite: 'expect_clean', commit: 'abc', files: ['a.js'], rationale: 'why', curation: { method: 'human-review', reviewedIn: 'w.md' }, ...over });
  const ok = (e) => validateCorpus({ version: '1', defects: [e] }, { requireCuration: false });
  const adj = (over = {}) => ({ verdict: 'not-clean', date: '2026-11-20', source: 'docs/x.json', realDefects: [{ id: 'H1', pass: 'backend', why: 'a real bug' }], ...over });

  it('accepts a not-clean verdict with its real defects, and a clean-under-audit verdict', () => {
    assert.equal(ok(entry({ adjudication: adj() })).ok, true);
    assert.equal(ok(entry({ adjudication: adj({ verdict: 'clean-under-audit', realDefects: undefined }) })).ok, true);
  });
  for (const [label, a, re] of [
    ['an unknown verdict', adj({ verdict: 'dirty' }), /adjudication\.verdict must be/],
    ['not-clean with no evidence', adj({ realDefects: [] }), /must list its realDefects/],
    ['a real defect with no why', adj({ realDefects: [{ id: 'H1', pass: 'backend' }] }), /needs id, pass and why/],
    ['no source record', adj({ source: '' }), /adjudication\.source/],
    ['a malformed date', adj({ date: 'yesterday' }), /YYYY-MM-DD/],
    ['clean-under-audit that lists defects', adj({ verdict: 'clean-under-audit' }), /cannot list realDefects/],
  ]) it(`refuses ${label}`, () => { const r = ok(entry({ adjudication: a })); assert.equal(r.ok, false); assert.match(r.errors.join(';'), re); });
  it('refuses an adjudication on a detect entry (only expect_clean carries one)', () => {
    const r = ok({ id: 'KD-901', repo: 'r', buggyCommit: 'a', fixCommit: 'b', files: ['a.js'], expectedFindingRubric: 'x', severity: 'HIGH', defectDesc: 'd', adjudication: adj() });
    assert.equal(r.ok, false); assert.match(r.errors.join(';'), /only an expect_clean entry carries an adjudication/);
  });
});

describe('the offline CLI mode: --adjudicate-report scores a report with no spend and no provider', () => {
  const run = (report, adjudications) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adj-cli-')); dirs.push(d);
    const rp = path.join(d, 'report.json'); const ap = path.join(d, 'adj.json'); const out = path.join(d, 'out.json');
    fs.writeFileSync(rp, JSON.stringify(report)); fs.writeFileSync(ap, JSON.stringify(adjudications));
    const r = spawnSync('node', [path.join(ROOT, 'scripts', 'model-eval-auditor.mjs'), '--adjudicate-report', rp, '--adjudications', ap, '--out', out], { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '' } });
    return { r, out: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
  };
  const report = { runId: 'x', suite: 'expect_clean', perCase };

  it('writes the adjudicated block and exits 0 when every finding has a verdict', () => {
    const { r, out } = run(report, [v('K1', 'H1', 'REAL'), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'WRONG')]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(out.adjudicated.realDefects, 1); assert.equal(out.adjudicated.falseClaims, 1);
    assert.match(r.stdout, /falseClaims=1 realDefects=1 nits=1 notClean=1\/3/);
  });
  it('exits 3 (INCOMPLETE) with unadjudicated findings, never a clean-looking success', () => {
    const { r, out } = run(report, [v('K1', 'H1', 'REAL')]);
    assert.equal(r.status, 3); assert.equal(out.adjudicated.complete, false);
    assert.match(r.stdout, /INCOMPLETE \(unadjudicated=2/);
  });
  it('refuses a report that is not an expect_clean report, and a missing --adjudications argument', () => {
    assert.equal(run({ suite: 'detect', perCase: [] }, []).r.status, 2);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adj-cli-')); dirs.push(d);
    fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify(report));
    const r = spawnSync('node', [path.join(ROOT, 'scripts', 'model-eval-auditor.mjs'), '--adjudicate-report', path.join(d, 'r.json')], { encoding: 'utf8' });
    assert.equal(r.status, 2); assert.match(r.stderr, /needs --adjudications/);
  });
});
