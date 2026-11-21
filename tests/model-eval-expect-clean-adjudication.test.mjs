import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findingKey, findingFingerprint, indexAdjudications, scoreAdjudicated } from '../scripts/lib/model-eval/expect-clean-adjudication.mjs';
import { validateCorpus, summarizeExpectClean, FLAGGED_RATE_NOTE } from '../scripts/lib/model-eval/corpus-selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } } });

// A whole source whose verdicts are bound to its run: the baseline a test then breaks ONE thing of.
const WHOLE = { partial: false, budgetStop: null, costComplete: true, bound: true };
const score = (cases, byKey, over = {}) => scoreAdjudicated(cases, byKey, { ...WHOLE, ...over });
const f = (id, pass = 'backend', severity = 'HIGH') => ({ id, pass, severity });
const v = (kdId, id, cls, extra = {}) => ({ kdId, id, pass: 'backend', class: cls, ...(cls === 'REAL' ? { preExisting: true } : {}), ...extra });
const idx = (list) => { const r = indexAdjudications(list); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.byKey; };
const wholeCases = [
  { kdId: 'K1', outcome: 'flagged', findings: [f('H1'), f('M1', 'backend', 'MEDIUM')] },
  { kdId: 'K2', outcome: 'flagged', findings: [f('H1')] },
  { kdId: 'K3', outcome: 'clean' },
];
const perCase = [...wholeCases, { kdId: 'K4', outcome: 'failed' }];

describe('scoreAdjudicated: falseClaims / realDefects / nits / notClean instead of a bare rate', () => {
  const byKey = idx([v('K1', 'H1', 'REAL', { preExisting: false }), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'WRONG')]);
  const r = score(wholeCases, byKey);

  it('counts each class, and a case with a REAL defect is notClean (introduced when the commit added it)', () => {
    assert.equal(r.falseClaims, 1); assert.equal(r.realDefects, 1); assert.equal(r.nits, 1);
    assert.equal(r.notClean, 1); assert.equal(r.notCleanIntroducedByCommit, 1); assert.equal(r.casesWithFalseClaim, 1);
    assert.equal(r.complete, true);
    assert.equal(r.falseClaimRate, 1 / 3, 'false claims over JUDGED findings');
    assert.equal(r.measuredCases, 3);
  });
  it('a case flagged only by nits or false claims is NOT notClean: flagged and not-clean are different things', () => {
    const k2 = r.perCase.find((c) => c.kdId === 'K2');
    assert.equal(k2.outcome, 'flagged'); assert.equal(k2.notClean, false);
  });
  it('a pre-existing REAL defect makes the case notClean but not introduced-by-commit', () => {
    const q = score(wholeCases, idx([v('K1', 'H1', 'REAL', { preExisting: true }), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'NOT_A_DEFECT')]));
    assert.equal(q.notClean, 1); assert.equal(q.notCleanIntroducedByCommit, 0);
  });
  it('an unadjudicated finding is never counted as anything: the result is INCOMPLETE', () => {
    const q = score(wholeCases, idx([v('K1', 'H1', 'REAL')]));
    assert.equal(q.unadjudicated, 2); assert.equal(q.complete, false);
    assert.equal(q.realDefects, 1); assert.equal(q.nits, 0); assert.equal(q.falseClaims, 0);
  });
  it('a verdict that matches no finding is ORPHANED and reported, never silently ignored', () => {
    const q = score(wholeCases, idx([v('K1', 'H1', 'REAL'), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'WRONG'), v('K9', 'H1', 'REAL')]));
    assert.deepEqual(q.orphaned, ['K9:backend:H1']); assert.equal(q.complete, false);
    assert.equal(q.realDefects, 1, 'the orphan did not count');
  });
  it('findings are keyed by case, pass AND id: the same id in another pass is a different finding', () => {
    assert.notEqual(findingKey('K1', { pass: 'backend', id: 'H1' }), findingKey('K1', { pass: 'Sustainability', id: 'H1' }));
    const q = score([{ kdId: 'K1', outcome: 'flagged', findings: [f('H1', 'backend'), f('H1', 'Sustainability')] }],
      idx([{ kdId: 'K1', id: 'H1', pass: 'backend', class: 'REAL', preExisting: true }, { kdId: 'K1', id: 'H1', pass: 'Sustainability', class: 'WRONG' }]));
    assert.equal(q.realDefects, 1); assert.equal(q.falseClaims, 1);
  });
  it('UNDETERMINED is neither a confirmed nor a refuted claim: outside the false-claim rate, which is null (not 0) when nothing was judged', () => {
    const q = score([{ kdId: 'K1', outcome: 'flagged', findings: [f('H1')] }], idx([v('K1', 'H1', 'UNDETERMINED')]));
    assert.equal(q.undetermined, 1); assert.equal(q.falseClaimRate, null);
  });
});

describe('completeness: nothing is guessed, and an incomplete score says why instead of looking like a smaller success', () => {
  const all = idx([v('K1', 'H1', 'REAL'), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'WRONG')]);

  it('a source run that failed a case is INCOMPLETE even though every finding has a verdict', () => {
    const q = score(perCase, all);
    assert.equal(q.complete, false); assert.deepEqual(q.failedCases, ['K4']);
    assert.match(q.incompleteReasons.join(';'), /source run failed case\(s\): K4/);
  });
  for (const [label, source, re] of [
    ['a cap stop', { partial: true, budgetStop: { reason: 'projected-over-cap' } }, /source run was partial/],
    ['a partial report', { partial: true }, /source run was partial/],
    ['an incomplete cost', { costComplete: false }, /cost is incomplete/],
  ]) it(`the source report's own ${label} makes the score INCOMPLETE`, () => {
    const q = score(wholeCases, all, source);
    assert.equal(q.complete, false); assert.match(q.incompleteReasons.join(';'), re);
  });
  it('a whole source with every finding judged is complete, with no reasons', () => {
    const q = score(wholeCases, all, { partial: false, budgetStop: null, costComplete: true });
    assert.equal(q.complete, true); assert.deepEqual(q.incompleteReasons, []);
  });

  it('a flagged case that kept NO findings (an older or truncated report) cannot be adjudicated: INCOMPLETE, never zero findings', () => {
    for (const findings of [undefined, []]) {
      const q = score([{ kdId: 'K1', outcome: 'flagged', findings }], idx([]));
      assert.equal(q.complete, false); assert.deepEqual(q.inconsistent, ['K1']);
    }
  });

  it('a finding with no id, or two findings sharing (case, pass, id), are AMBIGUOUS: one verdict is never applied to both', () => {
    const dup = score([{ kdId: 'K1', outcome: 'flagged', findings: [f('H1'), f('H1')] }], idx([v('K1', 'H1', 'REAL')]));
    assert.equal(dup.complete, false); assert.equal(dup.ambiguous.length, 1); assert.equal(dup.realDefects, 1, 'applied once, not twice');
    const noId = score([{ kdId: 'K1', outcome: 'flagged', findings: [{ pass: 'backend', severity: 'HIGH' }] }], idx([]));
    assert.equal(noId.complete, false); assert.match(noId.ambiguous[0], /\(no id\)/);
  });

  it('a verdict carrying a fingerprint is applied only to a finding that still has it (an id reused by a later run does not inherit it)', () => {
    const mine = { id: 'H1', pass: 'backend', severity: 'HIGH', category: 'c', section: 's', detail: 'the claim' };
    const ok = score([{ kdId: 'K1', outcome: 'flagged', findings: [mine] }], idx([v('K1', 'H1', 'REAL', { fingerprint: findingFingerprint(mine) })]));
    assert.equal(ok.complete, true); assert.equal(ok.realDefects, 1);
    const later = { ...mine, detail: 'a DIFFERENT claim under the same id' };
    const stale = score([{ kdId: 'K1', outcome: 'flagged', findings: [later] }], idx([v('K1', 'H1', 'REAL', { fingerprint: findingFingerprint(mine) })]));
    assert.equal(stale.complete, false); assert.deepEqual(stale.stale, ['K1:backend:H1']);
    assert.equal(stale.realDefects, 0, 'the stale verdict counted nowhere'); assert.equal(stale.unadjudicated, 1);
  });
});

describe('completeness, round 2: unknown and unresolved are never success', () => {
  const all = idx([v('K1', 'H1', 'REAL'), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'WRONG')]);
  it('an UNDETERMINED finding leaves its case unresolved: INCOMPLETE, never a case quietly counted clean', () => {
    const q = score([{ kdId: 'K1', outcome: 'flagged', findings: [f('H1')] }], idx([v('K1', 'H1', 'UNDETERMINED')]));
    assert.equal(q.complete, false); assert.match(q.incompleteReasons.join(';'), /UNDETERMINED/); assert.equal(q.notClean, 0);
  });
  it('a repeated or missing case id is INCOMPLETE even when the findings are disjoint or the cases are clean', () => {
    const disjoint = score([{ kdId: 'K1', outcome: 'flagged', findings: [f('H1')] }, { kdId: 'K1', outcome: 'flagged', findings: [f('H2')] }], idx([v('K1', 'H1', 'WRONG'), v('K1', 'H2', 'WRONG')]));
    assert.equal(disjoint.complete, false); assert.deepEqual(disjoint.duplicateCases, ['K1']);
    assert.equal(score([{ kdId: 'K3', outcome: 'clean' }, { kdId: 'K3', outcome: 'clean' }], idx([])).complete, false, 'two clean entries for one case');
    assert.equal(score([{ outcome: 'clean' }], idx([])).complete, false, 'a case with no id');
  });
  it('a repeated case id cannot receive the same verdict twice: the duplicate is ambiguous across the WHOLE report', () => {
    const q = score([{ kdId: 'K1', outcome: 'flagged', findings: [f('H1')] }, { kdId: 'K1', outcome: 'flagged', findings: [f('H1')] }], idx([v('K1', 'H1', 'REAL')]));
    assert.equal(q.complete, false); assert.equal(q.realDefects, 1, 'applied once'); assert.deepEqual(q.ambiguous, ['K1:backend:H1']);
  });
  for (const [label, source] of [['partial missing', { partial: undefined }], ['costComplete missing', { costComplete: undefined }], ['partial not a boolean', { partial: 'no' }]]) {
    it(`a source report with ${label} has UNKNOWN completeness: INCOMPLETE`, () => {
      const q = score(wholeCases, all, source);
      assert.equal(q.complete, false); assert.match(q.incompleteReasons.join(';'), /completeness is unknown/);
    });
  }
  it('verdicts tied to neither a run nor to every finding content are INCOMPLETE; either tie makes them usable', () => {
    const unbound = score(wholeCases, all, { bound: false });
    assert.equal(unbound.complete, false); assert.match(unbound.incompleteReasons.join(';'), /not bound to this report run/);
    assert.equal(score(wholeCases, all, { bound: false, allFingerprinted: true }).complete, true, 'every verdict fingerprinted is an acceptable tie');
    assert.equal(score(wholeCases, all, { bound: true }).complete, true, 'a reportRunId-bound file is the other');
  });
  it('indexAdjudications reports allFingerprinted only when every verdict has one', () => {
    const fp = (id) => v('K1', id, 'WRONG', { fingerprint: 'abcdef0123456789' });
    assert.equal(indexAdjudications([fp('H1'), fp('H2')]).allFingerprinted, true);
    assert.equal(indexAdjudications([fp('H1'), v('K1', 'H2', 'WRONG')]).allFingerprinted, false);
    assert.equal(indexAdjudications([]).allFingerprinted, false, 'an empty list ties nothing');
  });
});

describe('fingerprints end to end: built from the real findings, indexed, matched and accepted together', () => {
  const rich = (id) => ({ id, pass: 'backend', severity: 'HIGH', category: 'c', section: 's', detail: `claim ${id}` });
  const findings = [rich('H1'), rich('H2')];
  const rep = { kdId: 'K1', outcome: 'flagged', findings };
  const withFp = (over = {}) => findings.map((x) => ({ kdId: 'K1', id: x.id, pass: x.pass, class: 'WRONG', fingerprint: findingFingerprint(x), ...over }));

  it('verdicts fingerprinted from the report findings need no run binding: indexAdjudications derives allFingerprinted and the score is complete', () => {
    const r = indexAdjudications(withFp());
    assert.equal(r.ok, true); assert.equal(r.allFingerprinted, true); assert.equal(r.reportRunId, null);
    const q = scoreAdjudicated([rep], r.byKey, { partial: false, costComplete: true, bound: false, allFingerprinted: r.allFingerprinted });
    assert.equal(q.complete, true); assert.equal(q.falseClaims, 2); assert.deepEqual(q.stale, []);
  });
  it('NEGATIVE CONTROL: one wrong fingerprint makes that verdict stale and the score INCOMPLETE', () => {
    const list = withFp(); list[1] = { ...list[1], fingerprint: findingFingerprint({ ...findings[1], detail: 'something else' }) };
    const r = indexAdjudications(list);
    const q = scoreAdjudicated([rep], r.byKey, { partial: false, costComplete: true, bound: false, allFingerprinted: r.allFingerprinted });
    assert.equal(q.complete, false); assert.deepEqual(q.stale, ['K1:backend:H2']); assert.equal(q.falseClaims, 1);
  });
  it('through the CLI: a bare array of fingerprinted verdicts exits 0, and a changed fingerprint exits 3', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adj-fp-')); dirs.push(d);
    const report = { runId: 'x', suite: 'expect_clean', partial: false, budgetStop: null, costComplete: true, perCase: [rep] };
    const call = (verdicts) => {
      fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify(report)); fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify(verdicts));
      return spawnSync('node', [path.join(ROOT, 'scripts', 'model-eval-auditor.mjs'), '--adjudicate-report', path.join(d, 'r.json'), '--adjudications', path.join(d, 'a.json'), '--out', path.join(d, 'o.json')], { encoding: 'utf8' });
    };
    assert.equal(call(withFp()).status, 0);
    const tampered = withFp(); tampered[0].fingerprint = '0000000000000000';
    const r = call(tampered); assert.equal(r.status, 3); assert.match(r.stdout, /different finding under the same id/);
  });
});

describe('indexAdjudications refuses a malformed verdict list', () => {
  it('a REAL verdict needs a boolean preExisting: an unknown origin must not read as "not introduced by the commit"', () => {
    const r = indexAdjudications([{ kdId: 'K1', id: 'H1', pass: 'backend', class: 'REAL' }]);
    assert.equal(r.ok, false); assert.match(r.errors.join(';'), /boolean preExisting/);
    assert.equal(indexAdjudications([{ kdId: 'K1', id: 'H1', pass: 'backend', class: 'NOT_A_DEFECT' }]).ok, true, 'only REAL needs it');
  });
  it('accepts {reportRunId, verdicts} and returns the run it is bound to; a bare array is unbound', () => {
    const bound = indexAdjudications({ reportRunId: 'run-1', verdicts: [v('K1', 'H1', 'WRONG')] });
    assert.equal(bound.ok, true); assert.equal(bound.reportRunId, 'run-1');
    assert.equal(indexAdjudications([v('K1', 'H1', 'WRONG')]).reportRunId, null);
  });
  it('refuses a malformed fingerprint', () => assert.equal(indexAdjudications([v('K1', 'H1', 'WRONG', { fingerprint: 'zz' })]).ok, false));
  for (const [label, list, re] of [
    ['not an array', 'x', /must be a JSON array/],
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
  const report = { runId: 'x', suite: 'expect_clean', partial: false, budgetStop: null, costComplete: true, perCase: wholeCases };
  const bind = (verdicts) => ({ reportRunId: 'x', verdicts });

  it('writes the adjudicated block and exits 0 when every finding has a verdict', () => {
    const { r, out } = run(report, bind([v('K1', 'H1', 'REAL'), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'WRONG')]));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(out.adjudicated.realDefects, 1); assert.equal(out.adjudicated.falseClaims, 1);
    assert.match(r.stdout, /falseClaims=1 realDefects=1 nits=1 notClean=1\/3/);
  });
  it('exits 3 (INCOMPLETE) with unadjudicated findings, never a clean-looking success', () => {
    const { r, out } = run(report, bind([v('K1', 'H1', 'REAL')]));
    assert.equal(r.status, 3); assert.equal(out.adjudicated.complete, false);
    assert.match(r.stdout, /INCOMPLETE \(2 finding\(s\) have no verdict/);
  });
  it('exits 3 (INCOMPLETE) for a source report that failed a case or stopped at the cap, even with every finding judged', () => {
    const verdicts = [v('K1', 'H1', 'REAL'), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'WRONG')];
    const failed = run({ ...report, partial: true, perCase: perCase }, bind(verdicts));
    assert.equal(failed.r.status, 3); assert.match(failed.r.stdout, /source run failed case\(s\): K4/);
    const capped = run({ ...report, partial: true, budgetStop: { reason: 'projected-over-cap' } }, bind(verdicts));
    assert.equal(capped.r.status, 3); assert.match(capped.r.stdout, /source run was partial/);
  });
  it('exits 3 for a flagged case with no retained findings (an older report)', () => {
    const { r } = run({ ...report, perCase: [{ kdId: 'K1', outcome: 'flagged' }] }, bind([]));
    assert.equal(r.status, 3); assert.match(r.stdout, /flagged case\(s\) kept no findings: K1/);
  });
  it('refuses verdicts bound to a DIFFERENT report run (exit 2) and records boundToReport when the run matches', () => {
    const verdicts = [v('K1', 'H1', 'REAL'), v('K1', 'M1', 'NOT_A_DEFECT'), v('K2', 'H1', 'WRONG')];
    const wrong = run(report, { reportRunId: 'some-other-run', verdicts });
    assert.equal(wrong.r.status, 2); assert.match(wrong.r.stderr, /made for report run some-other-run, not x/);
    const right = run(report, { reportRunId: 'x', verdicts });
    assert.equal(right.r.status, 0, right.r.stderr); assert.equal(right.out.adjudicated.boundToReport, true);
    const bare = run(report, verdicts);
    assert.equal(bare.out.adjudicated.boundToReport, false); assert.equal(bare.r.status, 3, 'an unbound, unfingerprinted verdict list is INCOMPLETE, not a success');
    assert.match(bare.r.stdout, /not bound to this report run/);
  });
  it('refuses a report that is not an expect_clean report, and a missing --adjudications argument', () => {
    assert.equal(run({ suite: 'detect', perCase: [] }, bind([])).r.status, 2);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adj-cli-')); dirs.push(d);
    fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify(report));
    const r = spawnSync('node', [path.join(ROOT, 'scripts', 'model-eval-auditor.mjs'), '--adjudicate-report', path.join(d, 'r.json')], { encoding: 'utf8' });
    assert.equal(r.status, 2); assert.match(r.stderr, /needs --adjudications/);
  });
});
