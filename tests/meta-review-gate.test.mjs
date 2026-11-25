/**
 * The automatic meta-review wired into the round-cap gate (docs/plans/meta-step-back-at-cap.md, cluster B), and its
 * debt handoff (`debt-auto-capture --meta-decision`). Providers are INJECTED through `metaDeps`; nothing here calls a model.
 *
 * Positive and negative controls per gate effect: T1 admit (L1) runs the round and carries to the next; T1 stop / structural
 * exits 4 with the debt command; T2 early stop (L2) exits 4 only when the last round is measured unproductive, and
 * `--meta-override` overrides it; a human `--past-cap` is recorded as an override; opt-out and ineligibility never reach a
 * provider; an unavailable reviewer leaves today's refusal unchanged.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gateRoundCap } from '../scripts/lib/audit/round-cap-gate.mjs';
import { topicOf } from '../scripts/lib/audit/cap-productivity.mjs';
import { metaLogPath, readMetaLog, foldMetaLog, metaDecisionToLedgerEntries, appendMetaEvent } from '../scripts/lib/audit/meta-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = { sustainability: 's', efficiency: 'e', effectiveness: 'x' };
const f = (id, severity, category) => ({ id, severity, category, section: '§2', detail: `detail ${category}`, _pass: 'plan', affectedFiles: ['scripts/a.mjs'] });
const LAST = [f('H1', 'HIGH', 'Unsafe stop guard'), f('M1', 'MEDIUM', 'Wording polish')];
const [TH, TM] = LAST.map(topicOf);
const rounds = (upTo) => Array.from({ length: upTo }, (_, i) => ({ round: i + 1, findings: i + 1 === upTo ? LAST : [f('H1', 'HIGH', 'Unsafe stop guard')] }));
const ruled = (topicId, resolvedRound, outcome = 'accepted') => ({ topicId, adjudicationOutcome: outcome, resolvedRound });
const stopAll = { action: 'stop', assessment: A, reason: 'rigour chasing', items: [{ topicId: TH, kind: 'settled', premise: 'ruled earlier' }, { topicId: TM, kind: 'rigour-chasing', premise: 'polish' }] };

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-gate-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function harness({ verdict, ledger, signalsFire = false, select = null }) {
  const calls = [];
  const lines = [];
  const metaDeps = {
    readRounds: ({ upTo }) => ({ rounds: rounds(upTo), unmeasured: null }),
    readLedger: () => ({ entries: ledger, unmeasured: null }),
    buildPack: async () => ({ text: 'PACK', files: [{ path: 'scripts/a.mjs' }], notes: [], truncations: [], excluded: { sensitive: 0, unreadable: 0 }, topics: [TH, TM], plan: { path: 'plan.md', included: true } }),
    repoFiles: () => [], archNeighbours: null, evidence: () => ({ planSha256: 'p', head: 'h', diffSha256: null }),
    computeSignals: () => ({ version: 1, round: 3, importanceSource: 't', anyFires: signalsFire, unmeasured: [], signals: { reopenRate: { measured: true, fires: signalsFire, value: 1, reason: 't' } } }),
    record: () => 'k', flush: async () => {},
    selectProvider: select || (() => ({ ok: true, arm: 'higher', family: 'claude', auditorFamily: 'gpt', provider: { model: 'claude-opus-5-5', sentinel: 'latest-opus', outputCeilingTokens: 4000,
      call: async (req) => { calls.push(req); return { text: JSON.stringify(verdict), usage: { input_tokens: 10, output_tokens: 5, usageMissing: false }, sent: true }; } } })),
  };
  const gate = (argv, opts = {}) => gateRoundCap(argv, {
    cwd: dir, auditDir: dir, env: { AUDIT_META_REVIEW_T1: 'on' }, write: (l) => lines.push(l), metaReview: true, auditorModel: 'gpt-6', metaDeps,
    build: async ({ round, mode, planFile }) => ({ card: { version: 1, round, mode, planFile, summary: { clusters: 0 } }, text: 'CARD' }),
    recordCap: async () => ({ recorded: false, reason: 'test' }),
    ...opts,
  });
  return { gate, calls, lines, out: () => lines.join('') };
}
const planArgv = (round, extra = []) => ['plan', 'plan.md', '--round', String(round), '--out', path.join(dir, `s-r${round}-result.json`), ...extra];
const codeArgv = (round, extra = []) => ['code', 'plan.md', '--round', String(round), '--out', path.join(dir, `c-r${round}-result.json`), ...extra];

describe('T1 — at the cap', () => {
  test('ADMIT (L1): the refused round runs, stamped meta-review; the next round is covered; past it the cap applies again', async () => {
    const h = harness({ verdict: { action: 'admit', assessment: A, rounds: 1, topics: [TH], reason: 'a real defect the next round closes' }, ledger: [] });
    const r4 = await h.gate(planArgv(4));
    assert.equal(r4.ok, true, h.out());
    assert.equal(r4.roundCap.pastCap, true); assert.match(r4.roundCap.pastCapReason, /^meta-review s-r4-T1-/);
    assert.equal(h.calls.length, 1);
    await h.gate(planArgv(5));
    assert.equal(h.calls.length, 2, 'admitted through round 4 only: round 5 is a fresh T1, decided again');
    assert.equal((await h.gate(planArgv(6))).code, 'ABSOLUTE_CAP', 'past the absolute cap nothing is decided and no admission lifts it');
    assert.equal(h.calls.length, 2);
  });
  test('ADMIT 2 carries to the next round with no second call', async () => {
    const h = harness({ verdict: { action: 'admit', assessment: A, rounds: 2, topics: [TH], reason: 'two defects left' }, ledger: [] });
    assert.equal((await h.gate(planArgv(4))).ok, true);
    const r5 = await h.gate(planArgv(5));
    assert.equal(r5.ok, true); assert.equal(h.calls.length, 1, 'the admission is the evidence: no second call');
  });
  test('STOP (rigour-chasing, HIGH settled earlier): exit 4 META_STOP with the debt command', async () => {
    const h = harness({ verdict: stopAll, ledger: [ruled(TH, 2)] });
    const r = await h.gate(planArgv(4));
    assert.equal(r.ok, false); assert.equal(r.exitCode, 4); assert.equal(r.code, 'META_STOP');
    assert.match(h.out(), /debt-auto-capture\.mjs --meta-decision '.*' --decision 's-r4-T1-[^']+' --run 's'/);
  });
  test('NEGATIVE: the same stop with the HIGH never ruled → today\'s refusal (PAST_CAP_REQUIRED)', async () => {
    const h = harness({ verdict: stopAll, ledger: [] });
    const r = await h.gate(planArgv(4));
    assert.equal(r.code, 'PAST_CAP_REQUIRED');
  });
  test('STRUCTURAL: exit 4 META_STRUCTURAL naming the cause and the proposed fix', async () => {
    const h = harness({ verdict: { action: 'structural', assessment: A, cause: 'a missing shared primitive', evidence: [{ file: 'scripts/a.mjs', why: 'cited by every round' }], proposedFix: 'plan the primitive', reason: 'r' }, ledger: [ruled(TH, 2)] });
    const r = await h.gate(planArgv(4));
    assert.equal(r.code, 'META_STRUCTURAL'); assert.match(h.out(), /missing shared primitive/); assert.match(h.out(), /plan the primitive/);
  });
  test('UNAVAILABLE reviewer: today\'s refusal, unchanged', async () => {
    const h = harness({ verdict: stopAll, ledger: [ruled(TH, 2)], select: () => ({ ok: false, reason: 'no route', skipped: [] }) });
    const r = await h.gate(planArgv(4));
    assert.equal(r.code, 'PAST_CAP_REQUIRED'); assert.equal(r.exitCode, 4);
  });
  test('a human --past-cap over an honoured stop is recorded as an override of that decision', async () => {
    const h = harness({ verdict: stopAll, ledger: [ruled(TH, 2)] });
    await h.gate(planArgv(4));
    const r = await h.gate(planArgv(4, ['--past-cap', 'the HIGH is real and this round closes it']));
    assert.equal(r.ok, true, h.out());
    const fold = foldMetaLog(readMetaLog(metaLogPath(dir, 's')).events);
    assert.equal([...fold.overridden.values()].flat()[0].source, 'past-cap');
  });
});

describe('T1 is off by default', () => {
  const throwing = () => { throw new Error('provider must not be selected'); };
  for (const [label, env] of [['unset', {}], ['AUDIT_META_REVIEW=on alone', { AUDIT_META_REVIEW: 'on' }], ['AUDIT_META_REVIEW_T1=off', { AUDIT_META_REVIEW_T1: 'off' }]]) {
    test(`${label}: the cap refuses as before, no reviewer, no log (plan and code)`, async () => {
      const h = harness({ verdict: stopAll, ledger: [ruled(TH, 2)], select: throwing });
      assert.equal((await h.gate(planArgv(4), { env })).code, 'PAST_CAP_REQUIRED');
      assert.equal((await h.gate(codeArgv(7), { env })).code, 'PAST_CAP_REQUIRED');
      assert.equal(fs.existsSync(metaLogPath(dir, 's')), false);
      assert.equal(fs.existsSync(metaLogPath(dir, 'c')), false);
    });
  }
  test('an admission recorded while opted in does not lift the cap once T1 is off', async () => {
    const h = harness({ verdict: { action: 'admit', assessment: A, rounds: 2, topics: [TH], reason: 'r' }, ledger: [] });
    assert.equal((await h.gate(planArgv(4))).ok, true, h.out());
    assert.equal((await h.gate(planArgv(5), { env: {} })).code, 'PAST_CAP_REQUIRED');
    assert.equal(h.calls.length, 1);
  });
  test('T2 still fires with T1 off', async () => {
    const h = harness({ verdict: stopAll, ledger: [ruled(TH, 2), ruled(TH, 3, 'dismissed'), ruled(TM, 3, 'dismissed')], signalsFire: true });
    assert.equal((await h.gate(codeArgv(4), { env: {} })).code, 'META_STOP', h.out());
  });
});

describe('opt-out and eligibility never reach a provider', () => {
  const throwing = () => { throw new Error('provider must not be selected'); };
  test('AUDIT_META_REVIEW=off', async () => {
    const h = harness({ verdict: stopAll, ledger: [ruled(TH, 2)], select: throwing });
    const r = await h.gate(planArgv(4), { env: { AUDIT_META_REVIEW: 'off', AUDIT_META_REVIEW_T1: 'on' } });
    assert.equal(r.code, 'PAST_CAP_REQUIRED'); assert.equal(fs.existsSync(metaLogPath(dir, 's')), false);
  });
  test('--no-meta-review', async () => {
    const h = harness({ verdict: stopAll, ledger: [ruled(TH, 2)], select: throwing });
    assert.equal((await h.gate(planArgv(4, ['--no-meta-review']))).code, 'PAST_CAP_REQUIRED');
  });
  test('metaReview not passed (every caller but openai-audit main)', async () => {
    const h = harness({ verdict: stopAll, ledger: [ruled(TH, 2)], select: throwing });
    assert.equal((await h.gate(planArgv(4), { metaReview: false })).code, 'PAST_CAP_REQUIRED');
  });
  test('opt-out ignores an admission on disk', async () => {
    const h = harness({ verdict: { action: 'admit', assessment: A, rounds: 2, topics: [TH], reason: 'r' }, ledger: [] });
    await h.gate(planArgv(4));
    assert.equal((await h.gate(planArgv(5), { env: { AUDIT_META_REVIEW: 'off', AUDIT_META_REVIEW_T1: 'on' } })).code, 'PAST_CAP_REQUIRED');
  });
});

describe('T2 — code round 4 with a fired signal (L2)', () => {
  const unproductive = [ruled(TH, 2), ruled(TH, 3, 'dismissed'), ruled(TM, 3, 'dismissed')];
  test('POSITIVE: measured-unproductive + complete stop → exit 4 META_STOP before the soft cap', async () => {
    const h = harness({ verdict: stopAll, ledger: unproductive, signalsFire: true });
    const r = await h.gate(codeArgv(4));
    assert.equal(r.code, 'META_STOP'); assert.match(h.out(), /before the soft cap \(L2\)/);
  });
  test('NEGATIVE CONTROL: the same stop while productive → the round runs', async () => {
    const h = harness({ verdict: stopAll, ledger: [ruled(TH, 2), ruled(TH, 3), ruled(TM, 3)], signalsFire: true });
    const r = await h.gate(codeArgv(4));
    assert.equal(r.ok, true);
  });
  test('quiet signals → no call, the round runs', async () => {
    const h = harness({ verdict: stopAll, ledger: unproductive, signalsFire: false });
    assert.equal((await h.gate(codeArgv(4))).ok, true); assert.equal(h.calls.length, 0);
  });
  test('--meta-override: refused without a decision or a reason; with both, the round runs and the override is recorded', async () => {
    const h = harness({ verdict: stopAll, ledger: unproductive, signalsFire: true });
    assert.equal((await h.gate(codeArgv(4, ['--meta-override', 'nothing to override here yet']))).code, 'META_OVERRIDE_UNNEEDED');
    await h.gate(codeArgv(4));
    assert.equal((await h.gate(codeArgv(4, ['--meta-override', 'short']))).code, 'META_OVERRIDE_REASON');
    const r = await h.gate(codeArgv(4, ['--meta-override', 'this round closes the real HIGH']));
    assert.equal(r.ok, true, h.out()); assert.equal(h.calls.length, 1, 'no second call');
    const events = readMetaLog(metaLogPath(dir, 'c')).events;
    assert.equal(events.filter((e) => e.event === 'override')[0].source, 'meta-override');
  });
  test('--meta-override with the meta-review off is refused (it is not a general bypass)', async () => {
    const h = harness({ verdict: stopAll, ledger: unproductive, signalsFire: true });
    assert.equal((await h.gate(codeArgv(4, ['--meta-override', 'this round closes the real HIGH']), { metaReview: false })).code, 'META_OVERRIDE_UNNEEDED');
  });
});

describe('cluster B R1 fixes', () => {
  const unproductive = [ruled(TH, 2), ruled(TH, 3, 'dismissed'), ruled(TM, 3, 'dismissed')];
  test('REGRESSION (H3/M8): --meta-override on a round the cap refuses writes NOTHING', async () => {
    const h = harness({ verdict: stopAll, ledger: unproductive, signalsFire: true });
    await h.gate(codeArgv(4));
    const before = fs.readFileSync(metaLogPath(dir, 'c'), 'utf8');
    const r = await h.gate(codeArgv(4, ['--meta-override', 'this round closes the real HIGH', '--past-cap', 'and a needless past-cap reason here']));
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(metaLogPath(dir, 'c'), 'utf8'), before, 'no override event was appended');
  });
  test('REGRESSION (M2/M7): a --past-cap override that cannot be recorded admits nothing', async () => {
    const h = harness({ verdict: stopAll, ledger: [ruled(TH, 2)] });
    await h.gate(planArgv(4));
    const failing = { ...h, gate: (argv) => gateRoundCap(argv, { cwd: dir, auditDir: dir, env: {}, write: () => {}, metaReview: true, auditorModel: 'gpt-6',
      metaDeps: { record: () => 'k', flush: async () => {}, append: () => ({ ok: false, reason: 'disk full' }) },
      build: async ({ round, mode, planFile }) => ({ card: { version: 1, round, mode, planFile, summary: {} }, text: 'CARD' }), recordCap: async () => ({ recorded: false }) }) };
    const r = await failing.gate(planArgv(4, ['--past-cap', 'the HIGH is real and this round closes it']));
    assert.equal(r.ok, false); assert.equal(r.code, 'META_OVERRIDE_WRITE');
  });
  test('REGRESSION (H1/M5): the printed debt command single-quotes every argument', async () => {
    const { metaDebtCommand, shellQuote } = await import('../scripts/lib/audit/meta-review.mjs');
    assert.equal(shellQuote("a'b $(rm -rf x) `y`"), "'a'\\''b $(rm -rf x) `y`'");
    const cmd = metaDebtCommand({ auditDir: path.join(dir, '$(evil)'), sid: 's;x', attemptId: "a'1" });
    assert.match(cmd, /--meta-decision '[^']*\$\(evil\)[^']*' --decision 'a'\\''1' --run 's;x'$/);
  });
  test('REGRESSION (M4): a round result whose findings is not an array is a skipped candidate set, never ok-with-nothing-wrong', () => {
    const log = metaLogPath(dir, 's');
    fs.writeFileSync(path.join(dir, 's-r3-result.json'), JSON.stringify({ findings: { not: 'an array' } }));
    appendMetaEvent(log, { event: 'decision', attemptId: 'a', round: 4, fingerprint: { sid: 's' }, sent: true, state: 'valid', inventory: [{ topicId: TH, findingId: 'H1', severity: 'HIGH' }], verdict: stopAll, guard: { effect: 'stop', honoured: true } });
    const p = metaDecisionToLedgerEntries({ logFile: log, attemptId: 'a' });
    assert.equal(p.entries.length, 0); assert.match(p.skipped[0].reason, /no findings array/);
  });
  test('REGRESSION (M9): --revoke-meta-admission with --no-write is refused (exit 2), writing nothing', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/audit-structural-card.mjs'), '--sid', 's', '--mode', 'plan', '--dir', dir, '--revoke-meta-admission', '--by', 'x', '--reason', 'a reason long enough here', '--no-write'], { cwd: dir, encoding: 'utf8', env: { ...process.env, AUDIT_DB_URL: '' } });
    assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /cannot be combined with --no-write/);
  });
});

describe('debt handoff: --meta-decision', () => {
  function honouredStop() {
    const log = metaLogPath(dir, 's');
    fs.writeFileSync(path.join(dir, 's-r3-result.json'), JSON.stringify({ findings: LAST }));
    appendMetaEvent(log, { event: 'decision', attemptId: 's-r4-T1-x', round: 4, fingerprint: { sid: 's' }, sent: true, state: 'valid', model: 'claude-opus-5-5',
      inventory: LAST.map((x) => ({ topicId: topicOf(x), findingId: x.id, severity: x.severity })), verdict: stopAll, guard: { effect: 'stop', honoured: true, reasonCode: 'ok', reason: 'ok' } });
    return log;
  }
  test('projects every inventory topic, re-read from the round result, through the ledger-entry shape', () => {
    const p = metaDecisionToLedgerEntries({ logFile: honouredStop(), attemptId: 's-r4-T1-x', sid: 's' });
    assert.equal(p.ok, true); assert.equal(p.entries.length, 2); assert.equal(p.skipped.length, 0);
    assert.deepEqual(p.entries.map((e) => e.ruling), ['defer', 'defer']);
    assert.match(p.entries[0].rulingRationale, /meta-review stop/);
  });
  test('refuses: no --decision, a downgraded decision, an overridden one, another session', () => {
    const log = honouredStop();
    assert.equal(metaDecisionToLedgerEntries({ logFile: log, attemptId: null }).ok, false);
    assert.equal(metaDecisionToLedgerEntries({ logFile: log, attemptId: 's-r4-T1-x', sid: 'other' }).ok, false);
    appendMetaEvent(log, { event: 'override', attemptId: 's-r4-T1-x', by: 'louis' });
    assert.equal(metaDecisionToLedgerEntries({ logFile: log, attemptId: 's-r4-T1-x' }).ok, false);
  });
  test('a missing round result is a SKIPPED candidate, never a silent zero', () => {
    const log = honouredStop();
    fs.rmSync(path.join(dir, 's-r3-result.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const p = metaDecisionToLedgerEntries({ logFile: log, attemptId: 's-r4-T1-x' });
    assert.equal(p.entries.length, 0); assert.equal(p.skipped.length, 2);
  });
  test('the CLI: --dry-run shows the capture; a non-decision is refused with exit 1', () => {
    const log = honouredStop();
    const env = { ...process.env, AUDIT_DB_URL: '', LEARNING_DISABLE: '1' };
    const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts/debt-auto-capture.mjs'), '--meta-decision', log, '--decision', 's-r4-T1-x', '--run', 's', '--dry-run'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /Would capture 2 deferred entries/);
    const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts/debt-auto-capture.mjs'), '--meta-decision', log, '--decision', 'nope', '--run', 's', '--dry-run'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(bad.status, 1); assert.match(bad.stderr, /not an honoured stop\/structural/);
  });
});
