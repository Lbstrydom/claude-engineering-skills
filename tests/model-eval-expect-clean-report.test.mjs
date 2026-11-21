import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toScorable, runExpectCleanReport, exitCodeFor } from '../scripts/lib/model-eval/expect-clean-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } } });

const kase = (kdId, files = ['src/a.js']) => ({ visibleInput: { diff: `diff for ${kdId}`, files }, hiddenGroundTruth: { kdId }, repoRoot: ROOT });
const finding = (severity, over = {}) => ({ severity, _pass: 'be', _primaryFile: 'src/a.js', affectedFiles: ['src/a.js'], ...over });
const usage = (costUsd = 0.1) => ({ costUsd });
/** A fake generator keyed by case: the findings it returns, or an Error to throw. */
const gen = (byDiff) => async ({ auditInput }) => {
  const r = byDiff[auditInput.diff];
  if (r instanceof Error) throw r;
  return { findings: r, usageEvent: usage() };
};
const run = (cases, byDiff, extra = {}) => runExpectCleanReport({ runId: 'r', arm: { id: 'CAND' }, route: {}, cases, generate: gen(byDiff), ...extra });

describe('toScorable: generation findings carry affectedFiles, not file', () => {
  it('a finding naming a case file is attributed to it, case-folded and slash-normalised', () => {
    const f = finding('HIGH', { _primaryFile: 'x\\y.js', affectedFiles: ['SRC\\A.js'] });
    assert.equal(f.affectedFiles[0].includes('\\'), true, 'the fixture really holds a backslash');
    assert.equal(toScorable([f], ['src/a.js'])[0].file, 'SRC\\A.js', 'matched through normalisation, not by falling back to the first name');
  });
  it('a finding naming no file is attributed to the case, so an unattributable MEDIUM+ cannot flatter the candidate', () => {
    assert.equal(toScorable([{ severity: 'MEDIUM' }], ['src/a.js'])[0].file, 'src/a.js');
  });
  it('a finding naming only other files stays on those files', () => {
    assert.equal(toScorable([finding('HIGH', { _primaryFile: 'other.js', affectedFiles: ['other.js'] })], ['src/a.js'])[0].file, 'other.js');
  });
});

describe('runExpectCleanReport: the real generation arm, scored judge-free (G1)', () => {
  it('no MEDIUM+ finding on the case is clean; a MEDIUM or HIGH on it is a false positive naming the pass', async () => {
    const r = await run([kase('K1'), kase('K2'), kase('K3')], {
      'diff for K1': [finding('LOW')], 'diff for K2': [finding('MEDIUM')], 'diff for K3': [finding('HIGH', { _pass: 'wiring' })],
    });
    assert.deepEqual(r.perCase.map((c) => [c.kdId, c.outcome]), [['K1', 'clean'], ['K2', 'flagged'], ['K3', 'flagged']]);
    assert.deepEqual(r.perCase[2].passes, ['wiring']);
    assert.equal(r.summary.flaggedRate, 2 / 3);
  });
  it('a HIGH finding on some OTHER file does not make this case a false positive', async () => {
    const r = await run([kase('K1')], { 'diff for K1': [finding('HIGH', { _primaryFile: 'other.js', affectedFiles: ['other.js'] })] });
    assert.equal(r.perCase[0].outcome, 'clean');
  });
  it('a generation that throws is failed, counts in the denominator and is never clean', async () => {
    const r = await run([kase('K1'), kase('K2')], { 'diff for K1': [], 'diff for K2': new Error('429') });
    assert.deepEqual(r.perCase.map((c) => c.outcome), ['clean', 'failed']);
    assert.equal(r.summary.failed, 1);
    assert.equal(r.summary.measuredRate, 0.5);
  });
  it('when every generation fails the summary is unmeasured, never a flaggedRate of 0', async () => {
    const r = await run([kase('K1')], { 'diff for K1': new Error('down') });
    assert.equal(r.summary.unmeasured, true);
    assert.equal(r.summary.flaggedRate, undefined);
  });
  it('a malformed generation result (findings not an array) is failed, not clean', async () => {
    const r = await runExpectCleanReport({ runId: 'r', arm: {}, route: {}, cases: [kase('K1')], generate: async () => ({ findings: undefined, usageEvent: usage() }) });
    assert.equal(r.perCase[0].outcome, 'failed');
  });
  it('a malformed entry inside the findings array makes the case failed, never clean (r6 H1)', async () => {
    for (const bad of [[{}], [null], [{ severity: 'SEVERE' }]]) {
      const r = await run([kase('K1')], { 'diff for K1': bad });
      assert.equal(r.perCase[0].outcome, 'failed', JSON.stringify(bad));
    }
  });
  it('a call is metered once whatever scoring says; a failed call is metered as unknown and flagged unaccounted (r6 M2/M3/M4)', async () => {
    const recorded = [];
    const meter = { record: (c) => recorded.push(c), check: () => ({ stop: false }) };
    const r = await run([kase('K1'), kase('K2')], { 'diff for K1': [{}], 'diff for K2': new Error('429') }, { meter });
    assert.deepEqual(recorded, [0.1, null]);
    assert.equal(r.unaccounted, 1);
  });
  it('floating-point sums do not stop an affordable case: 0.1 + 0.1 + 0.1 fits a 0.3 cap (r2 H2)', async () => {
    let spent = 0;
    const meter = { record: (c) => { spent += c ?? 0; }, check: () => ({ stop: false }), get spentUsd() { return spent; } };
    const r = await run([kase('K1'), kase('K2'), kase('K3')], { 'diff for K1': [], 'diff for K2': [], 'diff for K3': [] }, { meter, capUsd: 0.3 });
    assert.equal(r.perCase.length, 3);
    assert.equal(r.budgetStop, null);
  });
  it('a meter already at its cap starts no generation at all (r1 H3)', async () => {
    let calls = 0;
    const meter = { record() {}, check: () => ({ stop: true, reason: 'at-cap' }), spentUsd: 30 };
    const r = await runExpectCleanReport({ runId: 'r', arm: {}, route: {}, cases: [kase('K1')], meter, generate: async () => { calls += 1; return { findings: [], usageEvent: usage() }; } });
    assert.equal(calls, 0);
    assert.deepEqual(r.budgetStop, { reason: 'at-cap', casesCompleted: 0, casesPlanned: 1 });
  });
  it('a case is not started when the costliest case so far would not fit under the cap (r1 H1/H4/H5)', async () => {
    let spent = 0;
    const meter = { record: (c) => { spent += c ?? 0; }, check: () => ({ stop: false }), get spentUsd() { return spent; } };
    const r = await run([kase('K1'), kase('K2'), kase('K3')], { 'diff for K1': [], 'diff for K2': [], 'diff for K3': [] }, { meter, capUsd: 0.25 });
    assert.deepEqual(r.perCase.map((c) => c.kdId), ['K1', 'K2'], 'after 0.2 spent, another 0.1 case would pass 0.25');
    assert.equal(r.budgetStop.reason, 'projected-over-cap');
  });
  it('a generation that resolves to nothing, or a usage event with no finite cost, is unaccounted, never a silently complete cost (r1 H2/H6/M1)', async () => {
    const recorded = [];
    const meter = { record: (c) => recorded.push(c), check: () => ({ stop: false }), spentUsd: 0 };
    const gens = [async () => null, async () => ({ findings: [], usageEvent: { costUsd: null } }), async () => ({ findings: [] })];
    let i = 0;
    const r = await runExpectCleanReport({ runId: 'r', arm: {}, route: {}, cases: [kase('K1'), kase('K2'), kase('K3')], meter, generate: () => gens[i++]() });
    assert.equal(r.unaccounted, 3);
    assert.deepEqual(recorded, [null, null, undefined]);
    assert.equal(r.perCase[0].outcome, 'failed');
  });
  it('the budget meter is fed every call and stops the run between cases', async () => {
    const recorded = [];
    const meter = { record: (c) => recorded.push(c), check: () => (recorded.length >= 1 ? { stop: true, reason: 'budget' } : { stop: false }) };
    const r = await run([kase('K1'), kase('K2')], { 'diff for K1': [], 'diff for K2': [] }, { meter });
    assert.equal(r.perCase.length, 1);
    assert.deepEqual(r.budgetStop, { reason: 'budget', casesCompleted: 1, casesPlanned: 2 });
    assert.equal(r.usageEvents.length, 1);
  });
});

describe('a generation that rejects with a non-Error value is a failed case, never a crash', () => {
  for (const [label, v] of [['null', null], ['undefined', undefined], ['a string', 'boom'], ['0', 0]]) {
    it(`rejecting with ${label}`, async () => {
      const r = await runExpectCleanReport({ runId: 'r', arm: { id: 'CAND' }, route: {}, cases: [kase('K1')], generate: async () => { throw v; } });
      assert.equal(r.perCase[0].outcome, 'failed');
      assert.equal(r.unaccounted, 1);
    });
  }
});

describe('a flagged case keeps the findings that drove it, redacted', () => {
  const full = (severity, over = {}) => finding(severity, {
    id: 'H1', category: '[backend] Fail-open check', section: 'src/a.js: f', detail: 'f swallows the error and returns ok',
    risk: 'a failure reads as success', recommendation: 'rethrow after logging', principle: 'fail closed', evidence: 'line 12: catch {}', ...over,
  });
  it('carries the claim, risk, suggested fix and evidence of each MEDIUM+ finding on the case', async () => {
    const r = await run([kase('K1')], { 'diff for K1': [full('HIGH'), full('LOW', { id: 'L1', detail: 'a nit' })] });
    assert.equal(r.perCase[0].outcome, 'flagged');
    assert.equal(r.perCase[0].findings.length, 1, 'only the finding that drove the outcome, not the LOW one');
    assert.deepEqual(r.perCase[0].findings[0], {
      severity: 'HIGH', pass: 'be', files: ['src/a.js'], primaryFile: 'src/a.js', id: 'H1', category: '[backend] Fail-open check', section: 'src/a.js: f',
      detail: 'f swallows the error and returns ok', risk: 'a failure reads as success', recommendation: 'rethrow after logging', principle: 'fail closed', evidence: 'line 12: catch {}',
    });
  });
  it('a clean case carries no findings and a finding on another file is not retained', async () => {
    const r = await run([kase('K1'), kase('K2')], { 'diff for K1': [full('LOW')], 'diff for K2': [full('HIGH', { _primaryFile: 'other.js', affectedFiles: ['other.js'] })] });
    assert.deepEqual(r.perCase.map((c) => c.findings), [undefined, undefined]);
  });
  it('a secret nested in structured evidence, an array or file metadata is redacted too', async () => {
    const secret = 'ghp_' + 'a'.repeat(36);
    const r = await run([kase('K1')], { 'diff for K1': [full('HIGH', { evidence: { quote: secret, lines: [secret, 12] }, affectedFiles: ['src/a.js', `x/${secret}.js`] })] });
    assert.equal(JSON.stringify(r.perCase).includes(secret), false, 'no nested string may carry the token');
    assert.equal(r.perCase[0].findings[0].evidence.lines[1], 12, 'non-strings pass through');
  });
  it('the retained findings are exactly the scorer drivers: severity and attribution cannot drift apart', async () => {
    const r = await run([kase('K1')], { 'diff for K1': [full('MEDIUM', { id: 'M1' }), full('LOW', { id: 'L1' }), full('HIGH', { id: 'H9', _primaryFile: 'other.js', affectedFiles: ['other.js'] }), full('HIGH', { id: 'H2', _primaryFile: null, affectedFiles: [] })] });
    assert.deepEqual(r.perCase[0].findings.map((f) => f.id), ['M1', 'H2'], 'MEDIUM+ on the case (a file-less one is attributed to it); never LOW, never another file');
  });
  it('free text is secret-redacted before it can be written', async () => {
    const secret = 'ghp_' + 'a'.repeat(36);
    const r = await run([kase('K1')], { 'diff for K1': [full('HIGH', { detail: `token ${secret} is logged`, evidence: secret })] });
    assert.equal(JSON.stringify(r.perCase).includes(secret), false, 'the token must not survive into the report');
    assert.match(r.perCase[0].findings[0].detail, /\[REDACTED/);
  });
});

describe('the CLI no longer refuses --suite expect_clean (G1)', () => {
  it('it reaches corpus loading: an empty corpus fails as corpus_too_small, not as an invalid suite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expect-clean-cli-')); dirs.push(dir);
    const corpus = path.join(dir, 'corpus.json');
    fs.writeFileSync(corpus, JSON.stringify({ version: 4, defects: [] }));
    const r = spawnSync(process.execPath, ['scripts/model-eval-auditor.mjs', '--candidate', '{"kind":"sentinel","value":"latest-gpt"}', '--tier', 'screen', '--suite', 'expect_clean', '--corpus', corpus], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    assert.doesNotMatch(r.stderr, /report-only path/, r.stderr);
    assert.doesNotMatch(r.stderr, /invalid_corpus_selection/, r.stderr);
    assert.match(r.stderr, /corpus_too_small|usable entries/, r.stderr);
    assert.equal(r.status, 2);
  });
});

describe('exitCodeFor: a report exits 0 only when it is whole (r2 H1)', () => {
  const rep = (over = {}) => ({ budgetStop: null, summary: { unmeasured: false, failed: 0 }, unaccounted: 0, ...over });
  it('whole = 0; cap stop = the budget code; unmeasured, a failed case or unaccounted cost = 3 (INCOMPLETE)', () => {
    assert.equal(exitCodeFor(rep(), 4), 0);
    assert.equal(exitCodeFor(rep({ budgetStop: { reason: 'x' } }), 4), 4);
    assert.equal(exitCodeFor(rep({ summary: { unmeasured: true, failed: 2 } }), 4), 3);
    assert.equal(exitCodeFor(rep({ summary: { unmeasured: false, failed: 1 } }), 4), 3);
    assert.equal(exitCodeFor(rep({ unaccounted: 1 }), 4), 3);
  });
});
