/**
 * @fileoverview Cluster A, the final-review half (docs/plans/copilot-feedback-item4.md §2.1 A5): the audit writes the
 * required list to the transcript (the single source), the final reviewer is handed every non-sensitive required subject
 * whatever its class, says per subject whether it RECEIVED it, and a required subject not received in full makes the gate
 * disposition `blocked`. 11/12 and 12/12 must be told apart by the gate itself, not by an agent-maintained shim.
 *
 * Canned objects only — no provider, no network. Every gate assertion has a negative control.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildAuditTranscript } from '../scripts/lib/audit/transcript.mjs';
import { selectFinalReviewCodePaths } from '../scripts/lib/final-review/scope.mjs';
import { summariseRequiredReceived, applyRequiredSubjectsGate } from '../scripts/lib/final-review/code-coverage.mjs';
import { computeGateDisposition } from '../scripts/lib/final-review/round-gate.mjs';

const LOCK = 'package-lock.json';
const roundWith = (subjects) => ({
  verdict: 'PASS', findings: [], code_files: ['src/a.mjs'],
  _coverage: { requiredSubjects: { declared: subjects.length, full: 0, notApplicable: 0, notFull: [], subjects } },
});
const sub = (path, status, reason = null) => ({ path, status, reason });

describe('A5 — the transcript carries the required list (the single source)', () => {
  it('required_subjects is {path, status} per declared subject, read from the LAST round that declared them', () => {
    const t = buildAuditTranscript({
      rounds: [roundWith([sub(LOCK, 'UNREAD', 'not-admitted')]), roundWith([sub(LOCK, 'FULL'), sub('.env', 'SENSITIVE', 'sensitive')])],
      auditMode: 'code', changedFiles: ['src/a.mjs'],
    });
    assert.deepEqual(t.required_subjects, [{ path: LOCK, status: 'FULL' }, { path: '.env', status: 'SENSITIVE' }]);
  });
  it('control: no --require, no key (the transcript is byte-identical to today)', () => {
    const t = buildAuditTranscript({ rounds: [{ verdict: 'PASS', findings: [], code_files: [] }], auditMode: 'code' });
    assert.equal('required_subjects' in t, false);
  });
  it('control: a plan audit has no code under review, so no required subjects', () => {
    const t = buildAuditTranscript({ rounds: [roundWith([sub(LOCK, 'FULL')])], auditMode: 'plan' });
    assert.equal('required_subjects' in t, false);
  });
});

describe('A5 — selectFinalReviewCodePaths includes required subjects regardless of class', () => {
  const deps = {
    exists: () => true,
    isSensitive: (p) => p === '.env' || p === 'innocent.json',
    isSensitiveLexical: (p) => p === '.env',
    isInfra: () => false,
  };
  const base = (extra) => ({
    reduced: false, planContent: 'x', infraAdmitted: false, deps, extractPlanPaths: () => ({ found: [] }),
    transcript: { code_files: ['src/a.mjs'], changed_files: ['src/a.mjs'], ...extra }, ...extra.__args,
  });
  it('a required lockfile (non-code) is in the Code Files block, in the full AND the reduced envelope', () => {
    const required_subjects = [{ path: LOCK, status: 'FULL' }];
    for (const reduced of [false, true]) {
      const { codePaths } = selectFinalReviewCodePaths({ ...base({ required_subjects }), reduced });
      assert.ok(codePaths.includes(LOCK), `reduced=${reduced}: ${codePaths}`);
    }
  });
  it('a SENSITIVE subject — lexical, or an innocent name that resolves to one — is never handed over', () => {
    const required_subjects = [{ path: '.env', status: 'SENSITIVE' }, { path: 'innocent.json', status: 'FULL' }];
    for (const reduced of [false, true]) {
      const { codePaths } = selectFinalReviewCodePaths({ ...base({ required_subjects }), reduced });
      assert.equal(codePaths.includes('.env'), false);
      assert.equal(codePaths.includes('innocent.json'), false, 'the final reviewer re-classifies with resolveAndClassify');
    }
  });
  it('an N/A (deleted) subject that is still absent is not requested: there is nothing on disk to receive', () => {
    const absent = { ...deps, exists: (p) => p !== 'gone.json' };
    const { codePaths } = selectFinalReviewCodePaths({ ...base({ required_subjects: [{ path: 'gone.json', status: 'N/A' }] }), deps: absent });
    assert.equal(codePaths.includes('gone.json'), false);
  });
  it('R1 audit M1: an N/A (deleted) subject that is BACK on disk is requested after all — a stale deletion never excuses a file that exists', () => {
    const present = { ...deps, exists: (p) => p === 'back.json' };
    const { codePaths } = selectFinalReviewCodePaths({ ...base({ required_subjects: [{ path: 'back.json', status: 'N/A' }] }), deps: present });
    assert.ok(codePaths.includes('back.json'));
  });
  it('control: without required_subjects the selection is unchanged', () => {
    const { codePaths } = selectFinalReviewCodePaths(base({}));
    assert.deepEqual(codePaths, ['src/a.mjs']);
  });
});

describe('A5 — summariseRequiredReceived: per-subject received state', () => {
  const stats = (over) => ({ full: [], headTruncated: [], unreadable: [], budgetOmitted: [], sensitiveExcluded: [], lineCounts: {}, ...over });
  const run = (s, required, opts = {}) => summariseRequiredReceived(s, required, { hunksFor: null, changedFiles: [], readText: () => null, ...opts });
  const stateOf = (rows, p) => rows.find((r) => r.path === p).state;

  it('rendered whole → full; absent from the render → not-received', () => {
    const rows = run(stats({ full: [LOCK] }), [{ path: LOCK, status: 'FULL' }, { path: 'other.json', status: 'FULL' }]);
    assert.equal(stateOf(rows, LOCK), 'full');
    assert.equal(stateOf(rows, 'other.json'), 'not-received');
  });
  it('head-cut → partial (an unchanged context subject cannot prove it was covered)', () => {
    const rows = run(stats({ headTruncated: [{ path: LOCK, charsOnDisk: 90000, charsRendered: 40000, ranges: [[1, 100]], windowed: false }] }), [{ path: LOCK, status: 'FULL' }]);
    assert.equal(stateOf(rows, LOCK), 'partial');
    assert.match(rows[0].reason, /head-cut/);
  });
  it('a CHANGED subject windowed with every changed line shown → full; with a changed line outside the window → partial', () => {
    const win = (ranges) => stats({ headTruncated: [{ path: LOCK, charsOnDisk: 90000, charsRendered: 4000, ranges, windowed: true }], lineCounts: { [LOCK]: 400 } });
    const opts = { changedFiles: [LOCK], hunksFor: () => [{ startLine: 50, lineCount: 5 }] };
    assert.equal(stateOf(run(win([[40, 80]]), [{ path: LOCK, status: 'FULL' }], opts), LOCK), 'full');
    assert.equal(stateOf(run(win([[200, 260]]), [{ path: LOCK, status: 'FULL' }], opts), LOCK), 'partial');
  });
  it('the audit\'s N/A (a git-verified deletion) is carried as n-a, so the two gates agree', () => {
    assert.equal(stateOf(run(stats({}), [{ path: 'gone.json', status: 'N/A' }]), 'gone.json'), 'n-a');
  });
  it('a subject the audit marked SENSITIVE is never-received, whatever the render says', () => {
    const rows = run(stats({ full: ['.env'] }), [{ path: '.env', status: 'SENSITIVE' }]);
    assert.equal(rows[0].state, 'not-received');
    assert.match(rows[0].reason, /sensitive/);
  });
  it('R1 audit M1: N/A is carried only while the file is still absent; if it is back, it is judged on what the reviewer received', () => {
    const back = run(stats({}), [{ path: 'back.json', status: 'N/A' }], { exists: () => true });
    assert.equal(back[0].state, 'not-received');
    const gone = run(stats({}), [{ path: 'gone.json', status: 'N/A' }], { exists: () => false });
    assert.equal(gone[0].state, 'n-a');
  });
  it('R2 audit H1/M1: a recreated N/A subject is FULL only if rendered whole — a window that happens to cover hunks is not enough', () => {
    const cutStats = stats({ headTruncated: [{ path: 'back.json', charsOnDisk: 90000, charsRendered: 4000, ranges: [[1, 400]], windowed: true }], lineCounts: { 'back.json': 400 } });
    const opts = { exists: () => true, changedFiles: ['back.json'], hunksFor: () => [{ startLine: 5, lineCount: 3 }] };
    assert.equal(run(cutStats, [{ path: 'back.json', status: 'N/A' }], opts)[0].state, 'partial');
    assert.equal(run(stats({ full: ['back.json'] }), [{ path: 'back.json', status: 'N/A' }], opts)[0].state, 'full');
  });
  it('no render record at all → every non-N/A subject is not-received, never an assumed full', () => {
    const rows = run(null, [{ path: LOCK, status: 'FULL' }]);
    assert.equal(rows[0].state, 'not-received');
  });
});

describe('A5 — the gate: 11/12 is told from 12/12 (P-A4)', () => {
  const clean = () => ({ verdict: 'APPROVE', new_findings: [], wrongly_dismissed: [] });
  const row = (path, state, reason = null) => ({ path, state, reason });

  it('a partial or not-received required subject makes the disposition blocked, naming the path', () => {
    for (const bad of ['partial', 'not-received']) {
      const r = clean();
      assert.equal(applyRequiredSubjectsGate(r, [row('a', 'full'), row(LOCK, bad, 'head-cut')]), true);
      const d = computeGateDisposition(r);
      assert.equal(d.disposition, 'blocked', bad);
      assert.ok(d.reasons.some((x) => /required subject\(s\) not received in full: .*package-lock\.json/.test(x)), JSON.stringify(d.reasons));
    }
  });
  it('control: all required subjects full — the disposition is untouched', () => {
    const r = clean();
    assert.equal(applyRequiredSubjectsGate(r, [row('a', 'full'), row(LOCK, 'full')]), false);
    assert.equal(computeGateDisposition(r).disposition, 'approve');
    assert.equal('_requiredSubjectsGate' in r, false);
  });
  it('control: an n-a (deleted) subject never blocks', () => {
    const r = clean();
    assert.equal(applyRequiredSubjectsGate(r, [row('gone.json', 'n-a')]), false);
    assert.equal(computeGateDisposition(r).disposition, 'approve');
  });
  it('control: no required subjects declared — no gate, no stamp', () => {
    const r = clean();
    assert.equal(applyRequiredSubjectsGate(r, []), false);
    assert.equal(applyRequiredSubjectsGate(r, null), false);
    assert.equal(computeGateDisposition(r).disposition, 'approve');
  });
  it('the verdict stays the model\'s word: only the disposition is computed', () => {
    const r = clean();
    applyRequiredSubjectsGate(r, [row(LOCK, 'not-received')]);
    assert.equal(r.verdict, 'APPROVE');
  });
});

// ── End to end through runFinalReview (stubbed provider; the real selection, render, coverage and gate) ───────────────────
describe('A5 — through runFinalReview: the required list in the transcript reaches the gate', async () => {
  const { runFinalReview } = await import('../scripts/gemini-review.mjs');
  const { stampGateDisposition } = await import('../scripts/lib/final-review/round-gate.mjs');

  const REAL = 'scripts/lib/final-review/envelope.mjs';
  const NON_CODE = 'tests/fixtures/required-subjects/package-lock.json'; // non-code: never reaches the reviewer unless required
  const APPROVE = {
    deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'fine' },
    new_findings: [], wrongly_dismissed: [], over_engineering_flags: [], architectural_coherence: 'Strong',
    overall_reasoning: 'looks good', verdict: 'APPROVE',
  };
  const stub = (captured) => ({
    messages: {
      create: async (params) => {
        captured.push(JSON.stringify(params));
        return { content: [{ type: 'tool_use', name: 'submit_review', input: APPROVE }], usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: 'tool_use' };
      },
    },
  });
  const transcript = (required_subjects) => JSON.stringify({
    audit_mode: 'code', changed_files: [REAL], code_files: [REAL], summary: 't', rounds: [{ round: 1, findings: [] }], claude_resolutions: [],
    ...(required_subjects ? { required_subjects } : {}),
  });
  const review = async (required_subjects) => {
    const captured = [];
    const { result } = await runFinalReview('claude-opus', stub(captured), '# plan', transcript(required_subjects), 'ctx', 'code');
    stampGateDisposition(result, 1);
    return { result, sent: captured.join('\n') };
  };

  it('a required non-code file is SENT to the reviewer, received whole, and the disposition stays approve', async () => {
    const { result, sent } = await review([{ path: NON_CODE, status: 'FULL' }]);
    assert.ok(sent.includes('required-subjects-fixture'), 'the lockfile body reached the final reviewer');
    assert.deepEqual(result._envelope.requiredSubjects.map((r) => [r.path, r.state]), [[NON_CODE, 'full']]);
    assert.equal(result.gateDisposition, 'approve');
  });
  it('P-A4: the reviewer APPROVED, yet a required subject it never received makes the disposition blocked, naming the path', async () => {
    const { result } = await review([{ path: NON_CODE, status: 'FULL' }, { path: 'typo/never.txt', status: 'FULL' }]);
    assert.equal(result.verdict, 'APPROVE', 'the verdict is the model\'s own word');
    assert.equal(result.gateDisposition, 'blocked');
    assert.ok(result.gateDispositionDetail.reasons.some((r) => /not received in full: typo\/never\.txt/.test(r)), JSON.stringify(result.gateDispositionDetail.reasons));
  });
  it('control: no --require, no required block and the disposition is as before', async () => {
    const { result } = await review(null);
    assert.equal('requiredSubjects' in result._envelope, false);
    assert.equal(result.gateDisposition, 'approve');
  });
  it('a subject the audit marked SENSITIVE is never in the request and blocks the disposition', async () => {
    const { result, sent } = await review([{ path: '.env', status: 'SENSITIVE' }]);
    assert.equal(sent.includes('API_TOKEN'), false);
    assert.equal(result.gateDisposition, 'blocked');
  });
  it('R1 audit M8: a subject the validator did NOT flag but that resolves sensitive is dropped by the final reviewer own check (second wall), with a positive control in the same request', async () => {
    const dir = '.audit/test-fixtures/req-subj-fr';
    fs.mkdirSync(dir, { recursive: true });
    const secret = `${dir}/.env`;
    fs.writeFileSync(secret, 'FR_DOTENV_MARKER=zzz-1f2e3d\n');
    try {
      const { result, sent } = await review([{ path: NON_CODE, status: 'FULL' }, { path: secret, status: 'FULL' }]);
      assert.ok(sent.includes('required-subjects-fixture'), 'positive control: the non-sensitive required file IS in the same request');
      assert.equal(sent.includes('zzz-1f2e3d'), false, 'the sensitive body never reached the final reviewer');
      assert.equal(result.gateDisposition, 'blocked', 'and it was not received, so the gate blocks');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  it('a git-verified deletion (N/A) is satisfied in both gates', async () => {
    const { result } = await review([{ path: 'gone/deleted.json', status: 'N/A' }]);
    assert.equal(result.gateDisposition, 'approve');
  });
});
