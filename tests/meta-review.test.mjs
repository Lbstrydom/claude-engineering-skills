/**
 * The automatic meta-review at the audit round cap (docs/plans/meta-step-back-at-cap.md §9).
 *
 * Every provider here is INJECTED; no test makes a model call. Each behaviour has a positive and a negative control:
 * the guard is the thing that bounds an automatic decision, so every way it can downgrade is exercised, and each
 * honoured effect is shown to happen only under its stated condition.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { topicOf } from '../scripts/lib/audit/cap-productivity.mjs';
import {
  runMetaReview, guardMetaDecision, openInventory, ruledBefore, metaTriggerFor, isMetaReviewOptedOut,
  fingerprintOf, attemptIdFor, metaLogPath, readMetaLog, appendMetaEvent, foldMetaLog, admissionFor,
  honouredLoopEnd, spendOf, projectMetaDecisionForStore, appendMetaOverride, META_REVIEW_SESSION_BUDGET, renderMetaLog, reserveUnderSessionLock, resolveExisting,
} from '../scripts/lib/audit/meta-review.mjs';
import { buildStepBackPack, parseMetaReviewOutput, MetaReviewSchema } from '../scripts/lib/audit/step-back.mjs';
import { createMetaReviewProvider, createStepBackProvider } from '../scripts/lib/audit/step-back-provider.mjs';

const CAPS = { plan: { soft: 3, absolute: 5 }, code: { soft: 6, absolute: 8 } };
const f = (id, severity, category) => ({ id, severity, category, section: '§2', detail: `detail of ${category}`, _pass: 'plan', affectedFiles: ['scripts/a.mjs'] });
const R3 = [f('H1', 'HIGH', 'Unsafe stop guard'), f('M1', 'MEDIUM', 'Wording polish'), f('M2', 'MEDIUM', 'Spec nit')];
const [TH, TM1, TM2] = R3.map(topicOf);
const ROUNDS = [{ round: 1, findings: [f('H1', 'HIGH', 'Unsafe stop guard')] }, { round: 2, findings: [f('H1', 'HIGH', 'Unsafe stop guard')] }, { round: 3, findings: R3 }];
const CODE_ROUNDS = [...ROUNDS, { round: 4, findings: R3 }, { round: 5, findings: R3 }, { round: 6, findings: R3 }];
const ruledEarlier = (t) => ({ topicId: t, adjudicationOutcome: 'accepted', firstSeenRound: 1, resolvedRound: 2 });
const ruledAt3 = (t, o = 'accepted') => ({ topicId: t, adjudicationOutcome: o, firstSeenRound: 3, resolvedRound: 3, ruling: 'fix' });
const A = { sustainability: 's', efficiency: 'e', effectiveness: 'x' };
const stopAll = (highKind = 'settled') => ({ action: 'stop', assessment: A, reason: 'rigour chasing', items: [
  { topicId: TH, kind: highKind, premise: 'already ruled in round 2' }, { topicId: TM1, kind: 'rigour-chasing', premise: 'polish' }, { topicId: TM2, kind: 'marginal', premise: 'nit' }] });

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-review-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const planArgv = (round = 4, extra = []) => ['plan', 'docs/plans/x.md', '--mode', 'plan', '--round', String(round), ...extra];
const codeArgv = (round, extra = []) => ['code', 'docs/plans/x.md', '--round', String(round), ...extra];

/** A provider whose reply is `verdict`; counts calls. */
function provider(verdict, { usage = { input_tokens: 1000, output_tokens: 100, usageMissing: false }, sent = true, throwErr = null } = {}) {
  const calls = [];
  return {
    calls,
    select: () => ({ ok: true, arm: 'higher', family: 'claude', auditorFamily: 'gpt', provider: {
      model: 'claude-opus-5-5', sentinel: 'latest-opus', outputCeilingTokens: 4000,
      call: async (req) => { calls.push(req); if (throwErr) throw throwErr; return { text: typeof verdict === 'string' ? verdict : JSON.stringify(verdict), usage, sent }; },
    } }),
  };
}

function deps({ ledger = [ruledEarlier(TH), ruledAt3(TH), ruledAt3(TM1), ruledAt3(TM2)], rounds = ROUNDS, prov, pack = null, append, signalsFire = false } = {}) {
  const topics = [...new Set(rounds.flatMap((r) => r.findings.map(topicOf)))];
  return {
    readRounds: ({ upTo }) => ({ rounds: rounds.filter((r) => r.round <= upTo), unmeasured: null }),
    readLedger: () => ({ entries: ledger, unmeasured: null }),
    buildPack: pack || (async () => ({ text: 'PACK', files: [{ path: 'scripts/a.mjs' }], notes: [], truncations: [], excluded: { sensitive: 0, unreadable: 0 }, topics, skipLog: [] })),
    repoFiles: () => [], archNeighbours: null,
    computeSignals: () => ({ version: 1, round: 3, importanceSource: 'test', anyFires: signalsFire, unmeasured: [], signals: { reopenRate: { measured: true, fires: signalsFire, value: signalsFire ? 1 : 0, reason: 'test' } } }),
    selectProvider: prov.select, record: () => 'key', flush: async () => {},
    evidence: () => ({ planSha256: 'p', head: 'h', diffSha256: null }),
    ...(append ? { append } : {}),
  };
}

const run = (o, d) => runMetaReview({ sid: 'audit-plan-1-1', mode: 'plan', round: 4, caps: CAPS.plan, argv: planArgv(), auditDir: dir, trigger: 'T1', ...o }, d);

describe('v2 schema', () => {
  test('a bare continue and an admit without topics are unrepresentable', () => {
    assert.equal(parseMetaReviewOutput('{"action":"continue"}').ok, false);
    assert.equal(parseMetaReviewOutput({ action: 'admit', assessment: A, rounds: 1, topics: [], reason: 'r' }).ok, false);
    assert.equal(parseMetaReviewOutput({ action: 'admit', assessment: A, rounds: 3, topics: ['t'], reason: 'r' }).ok, false, 'at most 2 rounds');
  });
  test('assessment is required on every branch (flat wire shape)', () => {
    assert.equal(MetaReviewSchema.safeParse({ action: 'admit', rounds: 1, topics: ['t'], reason: 'r' }).success, false);
    assert.equal(parseMetaReviewOutput({ action: 'admit', assessment: A, rounds: 1, topics: ['t'], reason: 'r' }).ok, true);
  });
  test('a stop naming an unknown topic is invalid', () => {
    const r = parseMetaReviewOutput(stopAll(), { knownTopics: [TH, TM1] });
    assert.equal(r.ok, false); assert.match(r.error, /unknown topicId/);
  });
});

describe('triggers and opt-out', () => {
  test('T1 only on PAST_CAP_REQUIRED; T2 only at code round 4 inside the cap', () => {
    assert.equal(metaTriggerFor({ mode: 'plan', round: 4, refusalCode: 'PAST_CAP_REQUIRED' }), 'T1');
    assert.equal(metaTriggerFor({ mode: 'code', round: 9, refusalCode: 'ABSOLUTE_CAP' }), null, 'nothing to decide past the absolute cap');
    assert.equal(metaTriggerFor({ mode: 'code', round: 4 }), 'T2');
    assert.equal(metaTriggerFor({ mode: 'plan', round: 4 }), null, 'plan audits have no signals');
    assert.equal(metaTriggerFor({ mode: 'code', round: 5 }), null);
    assert.equal(metaTriggerFor({ mode: 'rebuttal', round: 4, refusalCode: 'PAST_CAP_REQUIRED' }), null);
  });
  test('opt-out by flag or env', () => {
    assert.equal(isMetaReviewOptedOut({ argv: ['--no-meta-review'], env: {} }), true);
    for (const v of ['off', 'OFF', '0', 'false', 'no']) assert.equal(isMetaReviewOptedOut({ argv: [], env: { AUDIT_META_REVIEW: v } }), true, v);
    assert.equal(isMetaReviewOptedOut({ argv: [], env: { AUDIT_META_REVIEW: 'on' } }), false);
    assert.equal(isMetaReviewOptedOut({ argv: [], env: {} }), false);
  });
});

describe('guard (pure)', () => {
  const inventory = openInventory(R3);
  const ledger = [ruledEarlier(TH)];
  const g = (output, o = {}) => guardMetaDecision({ trigger: 'T1', output, inventory, ledgerEntries: ledger, lastRound: 3, productivity: { stillProductive: false }, packFiles: ['scripts/a.mjs'], round: 4, caps: CAPS.plan, ...o });

  test('POSITIVE: a complete stop with the HIGH ruled earlier is honoured', () => {
    const r = g(stopAll()); assert.equal(r.honoured, true); assert.equal(r.effect, 'stop');
  });
  test('NEGATIVE: a stop that omits a topic is downgraded and names it', () => {
    const o = stopAll(); o.items.pop();
    const r = g(o); assert.equal(r.honoured, false); assert.equal(r.reasonCode, 'omitted-topic'); assert.match(r.reason, new RegExp(TM2)); assert.equal(r.effect, 'human-card');
  });
  test('NEGATIVE: a HIGH judged only marginal is downgraded', () => {
    assert.equal(g(stopAll('marginal')).reasonCode, 'high-not-settled');
  });
  test('NEGATIVE: a settled claim the ledger does not support is downgraded', () => {
    assert.equal(g(stopAll(), { ledgerEntries: [] }).reasonCode, 'unverified-settled');
  });
  test('REGRESSION (R1 H1): a topic first SEEN early but first RULED in the last round is not settled', () => {
    assert.equal(ruledBefore([{ topicId: TH, adjudicationOutcome: 'accepted', firstSeenRound: 1, resolvedRound: 3 }], TH, 3), false);
  });
  test('the auditor own _priorRuling stamp on a last-round finding IS a prior ruling', () => {
    const inv = openInventory([{ ...R3[0], _priorRuling: { topicId: 'older', score: 0.3 } }]);
    assert.equal(inv[0].priorRuled, true);
    assert.equal(ruledBefore([], TH, 3, inv), true);
  });
  test('a ruling made only in the last round is not "earlier"', () => {
    assert.equal(ruledBefore([ruledAt3(TH)], TH, 3), false);
    assert.equal(ruledBefore([ruledEarlier(TH)], TH, 3), true);
    assert.equal(ruledBefore([{ ...ruledEarlier(TH), adjudicationOutcome: undefined }], TH, 3), false, 'an unruled entry is not settled');
  });
  test('admit: honoured within the absolute cap, clipped to it, refused for a closed topic', () => {
    const ok = g({ action: 'admit', assessment: A, rounds: 1, topics: [TH], reason: 'real defect' });
    assert.equal(ok.effect, 'admit'); assert.equal(ok.admittedThrough, 4);
    const clipped = guardMetaDecision({ trigger: 'T1', output: { action: 'admit', assessment: A, rounds: 2, topics: [TH], reason: 'r' }, inventory, ledgerEntries: ledger, lastRound: 7, round: 8, caps: CAPS.code });
    assert.equal(clipped.admittedThrough, 8, 'never past the absolute cap');
    assert.equal(g({ action: 'admit', assessment: A, rounds: 1, topics: ['closed-topic'], reason: 'r' }).reasonCode, 'topic-not-open');
    assert.equal(g({ action: 'admit', assessment: A, rounds: 1, topics: [TH, 'closed-topic'], reason: 'r' }).reasonCode, 'topic-not-open', 'REGRESSION (R1 M5): every admitted topic must be open');
  });
  test('structural: honoured with shown evidence and settled HIGHs; downgraded otherwise', () => {
    const s = (file) => ({ action: 'structural', assessment: A, cause: 'missing shared primitive', evidence: [{ file, why: 'w' }], proposedFix: 'plan it', reason: 'r' });
    assert.equal(g(s('scripts/a.mjs')).effect, 'structural');
    assert.equal(g(s('scripts/not-shown.mjs')).reasonCode, 'evidence-not-in-pack');
    assert.equal(g(s('scripts/a.mjs'), { ledgerEntries: [] }).reasonCode, 'high-not-settled', 'an open, never-ruled HIGH blocks a structural route');
  });
  test('T2 (L2): a stop while productive or unmeasured is downgraded; honoured only when measured unproductive', () => {
    const t2 = (p) => g(stopAll(), { trigger: 'T2', productivity: p });
    assert.equal(t2({ stillProductive: true, acceptanceRate: 0.8 }).reasonCode, 'productive');
    assert.equal(t2({ stillProductive: true, acceptanceRate: 0.8 }).effect, 'round-runs', 'the round runs as before');
    assert.equal(t2({ stillProductive: null, unmeasured: 'no ledger' }).reasonCode, 'unmeasured');
    assert.equal(t2({ stillProductive: false, acceptanceRate: 0.3 }).effect, 'stop');
  });
  test('T2 admit is a no-op: the round runs', () => {
    assert.equal(g({ action: 'admit', assessment: A, rounds: 1, topics: [TH], reason: 'r' }, { trigger: 'T2' }).effect, 'round-runs');
  });
});

describe('event log', () => {
  test('append, fold, reread; a torn tail is repaired and both later events survive', () => {
    const file = metaLogPath(dir, 's');
    assert.equal(appendMetaEvent(file, { event: 'reserve', attemptId: 'a1' }).ok, true);
    assert.equal(appendMetaEvent(file, { event: 'decision', attemptId: 'a1', sent: true, guard: {} }).ok, true);
    fs.appendFileSync(file, '{"event":"decision","attemptId":"torn"');
    assert.equal(readMetaLog(file).tornTail > 0, true);
    const r1 = appendMetaEvent(file, { event: 'reserve', attemptId: 'a2' });
    assert.equal(r1.ok, true); assert.ok(r1.repairedTornTail > 0);
    assert.equal(appendMetaEvent(file, { event: 'override', attemptId: 'a1', by: 'x' }).ok, true);
    const log = readMetaLog(file);
    assert.equal(log.malformed, null); assert.equal(log.tornTail, 0);
    assert.deepEqual(log.events.map((e) => e.attemptId), ['a1', 'a1', 'a2', 'a1']);
    assert.ok(log.events[2].repairedTornTail > 0);
    const fold = foldMetaLog(log.events);
    assert.equal(fold.sentCount, 2); assert.equal(fold.overridden.has('a1'), true);
  });
  test('a non-JSON middle line makes the log malformed', () => {
    const file = metaLogPath(dir, 's');
    fs.writeFileSync(file, '{"event":"decision"}\nnot json\n{"event":"decision"}\n');
    assert.match(readMetaLog(file).malformed, /line 2/);
  });
  test('a failed append verification is not ok', () => {
    const fake = { ...fs, appendFileSync: () => {} };
    assert.equal(appendMetaEvent(metaLogPath(dir, 's'), { event: 'decision', attemptId: 'x' }, { fsImpl: fake }).ok, false);
  });
});

describe('identity', () => {
  test('the attempt id carries an identity digest', () => {
    const a = attemptIdFor({ sid: 's', round: 4, trigger: 'T1', fingerprint: fingerprintOf({ argv: planArgv(), mode: 'plan', sid: 's' }) });
    const b = attemptIdFor({ sid: 's', round: 4, trigger: 'T1', fingerprint: fingerprintOf({ argv: ['plan', 'docs/plans/other.md'], mode: 'plan', sid: 's' }) });
    const c = attemptIdFor({ sid: 's', round: 4, trigger: 'T1', fingerprint: fingerprintOf({ argv: codeArgv(4, ['--changed', 'b.mjs,a.mjs']), mode: 'code', sid: 's' }) });
    const c2 = attemptIdFor({ sid: 's', round: 4, trigger: 'T1', fingerprint: fingerprintOf({ argv: codeArgv(4, ['--changed', 'a.mjs,b.mjs']), mode: 'code', sid: 's' }) });
    assert.notEqual(a, b); assert.equal(c, c2, 'the changed set is order-insensitive'); assert.match(a, /^s-r4-T1-[0-9a-f]{8}$/);
  });
});

describe('runMetaReview — the positive and negative controls', () => {
  test('STOPS A RIGOUR-CHASING ROUND: honoured stop, persisted, costed, learning row is the allowlisted projection', async () => {
    const p = provider(stopAll());
    const recorded = [];
    const d = { ...deps({ prov: p }), record: (x) => { recorded.push(x); return 'key'; } };
    const r = await run({}, d);
    assert.equal(r.persisted, true); assert.equal(r.effect, 'stop'); assert.equal(r.honoured, true);
    assert.equal(p.calls.length, 1);
    assert.match(p.calls[0].user, /Open-topic inventory/);
    const log = readMetaLog(metaLogPath(dir, 'audit-plan-1-1')).events;
    assert.deepEqual(log.map((e) => e.event), ['reserve', 'decision']);
    assert.equal(log[1].spendSource, 'usage'); assert.equal(typeof log[1].costUsd, 'number');
    assert.equal(recorded[0].decisionType, 'meta_review_decision');
    assert.equal(recorded[0].externalId, r.decision.attemptId);
    assert.deepEqual(recorded[0].context.stopKinds, ['marginal', 'rigour-chasing', 'settled']);
    assert.equal(honouredLoopEnd({ fold: foldMetaLog(log), attemptId: r.decision.attemptId })?.attemptId, r.decision.attemptId);
  });
  test('NEGATIVE: the same stop with the HIGH never ruled earlier is downgraded to the human card', async () => {
    const r = await run({}, deps({ prov: provider(stopAll()), ledger: [ruledAt3(TH)] }));
    assert.equal(r.honoured, false); assert.equal(r.effect, 'human-card'); assert.equal(r.decision.guard.reasonCode, 'unverified-settled');
  });
  test('ADMITS A DEFECT ROUND: admission recorded, bound to the identity, re-run reuses it', async () => {
    const p = provider({ action: 'admit', assessment: A, rounds: 1, topics: [TH], reason: 'a real defect the next round closes' });
    const r = await run({}, deps({ prov: p }));
    assert.equal(r.effect, 'admit'); assert.equal(r.decision.admittedThrough, 4);
    const fold = foldMetaLog(readMetaLog(metaLogPath(dir, 'audit-plan-1-1')).events);
    assert.equal(admissionFor({ fold, digest: r.decision.fingerprintDigest, round: 4 })?.attemptId, r.decision.attemptId);
    assert.equal(admissionFor({ fold, digest: r.decision.fingerprintDigest, round: 5 }), null, 'round 5 is past the admission');
    assert.equal(admissionFor({ fold, digest: 'deadbeef', round: 4 }), null, 'another identity is not admitted');
    const again = await run({}, deps({ prov: p }));
    assert.equal(again.reused, true); assert.equal(p.calls.length, 1, 'an idempotent re-run makes no second call');
  });
  test('a different identity at the same round gets a fresh decision; returning reuses the original', async () => {
    const p = provider({ action: 'admit', assessment: A, rounds: 1, topics: [TH], reason: 'r' });
    const first = await run({}, deps({ prov: p }));
    const other = await run({ argv: planArgv(4, ['--changed', 'x.mjs']) }, deps({ prov: p }));
    assert.notEqual(other.decision.attemptId, first.decision.attemptId);
    const back = await run({}, deps({ prov: p }));
    assert.equal(back.reused, true); assert.equal(back.decision.attemptId, first.decision.attemptId);
    assert.equal(p.calls.length, 2);
  });
  test('ROUTES A STRUCTURAL PATTERN', async () => {
    const r = await run({}, deps({ prov: provider({ action: 'structural', assessment: A, cause: 'a missing shared primitive', evidence: [{ file: 'scripts/a.mjs', why: 'every finding cites it' }], proposedFix: 'plan the primitive', reason: 'r' }) }));
    assert.equal(r.effect, 'structural'); assert.equal(r.honoured, true);
  });
  test('UNAVAILABLE PROVIDER admits no automatic decision and falls back to the human card', async () => {
    const r = await run({}, { ...deps({ prov: provider(stopAll()) }), selectProvider: () => ({ ok: false, reason: 'no route for any independent reviewer', skipped: [{ arm: 'higher', reason: 'sdk backend unavailable' }] }) });
    assert.equal(r.effect, 'human-card'); assert.equal(r.honoured, false);
    assert.equal(r.decision.state, 'unavailable'); assert.equal(r.decision.costUsd, 0); assert.equal(r.decision.spendSource, 'none');
  });
  test('a provider throw AFTER send is charged an estimate, never 0; BEFORE send costs 0', async () => {
    const after = await run({}, deps({ prov: provider(stopAll(), { throwErr: Object.assign(new Error('socket hang up'), { sent: true }) }) }));
    assert.equal(after.decision.spendSource, 'estimate'); assert.ok(after.decision.costUsd > 0);
    fs.rmSync(metaLogPath(dir, 'audit-plan-1-1'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const before = await run({}, deps({ prov: provider(stopAll(), { throwErr: Object.assign(new Error('no key'), { sent: false }) }) }));
    assert.equal(before.decision.spendSource, 'none'); assert.equal(before.decision.costUsd, 0);
  });
  test('an invalid reply is recorded invalid (raw kept, redacted) and takes the human path', async () => {
    const r = await run({}, deps({ prov: provider('I think one more round would help. sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD') }));
    assert.equal(r.decision.state, 'invalid'); assert.equal(r.effect, 'human-card');
    assert.doesNotMatch(r.decision.raw, /sk-proj-/);
  });
  test('NO PRIOR ROUNDS → not run, nothing recorded (keeps every fresh-sid refusal fixture unchanged)', async () => {
    const p = provider(stopAll());
    const r = await run({}, deps({ prov: p, rounds: [] }));
    assert.equal(r.ran, false); assert.equal(p.calls.length, 0);
    assert.equal(fs.existsSync(metaLogPath(dir, 'audit-plan-1-1')), false);
  });
  test('persist-before-act: an append failure means no action', async () => {
    const append = (file, ev) => (ev.event === 'decision' ? { ok: false, reason: 'disk full' } : appendMetaEvent(file, ev));
    const r = await run({}, deps({ prov: provider(stopAll()), append }));
    assert.equal(r.persisted, false); assert.equal(r.effect, 'human-card');
    const failReserve = await run({ sid: 'other' }, deps({ prov: provider(stopAll()), append: () => ({ ok: false, reason: 'disk full' }) }));
    assert.equal(failReserve.ran, false); assert.match(failReserve.reason, /nothing was sent/);
  });
  test('a malformed log → not run, human path', async () => {
    fs.writeFileSync(metaLogPath(dir, 'audit-plan-1-1'), 'garbage\n{}\n');
    const p = provider(stopAll());
    const r = await run({}, deps({ prov: p }));
    assert.equal(r.ran, false); assert.equal(p.calls.length, 0);
  });
  test('session budget: past it, no call and a recorded session-budget decision', async () => {
    const file = metaLogPath(dir, 'audit-plan-1-1');
    for (let i = 0; i < META_REVIEW_SESSION_BUDGET.plan; i++) appendMetaEvent(file, { event: 'reserve', attemptId: `prior-${i}` });
    const p = provider(stopAll());
    const r = await run({}, deps({ prov: p }));
    assert.equal(p.calls.length, 0); assert.match(r.decision.reason, /session-budget/);
  });
  test('plan audit: an excluded or truncated plan fails closed with no call', async () => {
    const p = provider(stopAll());
    const base = deps({ prov: p });
    const excluded = await run({}, { ...base, buildPack: async () => ({ text: 'P', files: [], notes: ['plan file was excluded or unreadable'], truncations: [], excluded: { sensitive: 1, unreadable: 0 }, topics: [] }) });
    assert.match(excluded.decision.reason, /plan-required-evidence/);
    fs.rmSync(metaLogPath(dir, 'audit-plan-1-1'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const cut = await run({}, { ...base, buildPack: async () => ({ text: 'P', files: [], notes: [], truncations: [{ section: 'plan', action: 'truncated' }], excluded: { sensitive: 0, unreadable: 0 }, topics: [] }) });
    assert.match(cut.decision.reason, /truncated/);
    assert.equal(p.calls.length, 0);
  });
  const t2 = (o, d) => runMetaReview({ trigger: 'T2', sid: 'audit-code-1-1', mode: 'code', round: 4, caps: CAPS.code, argv: codeArgv(4), auditDir: dir, ...o }, d);
  test('T2 (L2) POSITIVE: a fired signal + measured-unproductive last round + complete stop → the loop stops before the cap', async () => {
    const unproductive = [ruledEarlier(TH), ruledAt3(TH, 'dismissed'), ruledAt3(TM1, 'dismissed'), ruledAt3(TM2, 'dismissed')];
    const r = await t2({}, deps({ prov: provider(stopAll()), ledger: unproductive, signalsFire: true }));
    assert.equal(r.effect, 'stop'); assert.equal(r.honoured, true);
    assert.deepEqual(r.decision.signals.fired, ['reopenRate']);
  });
  test('T2 (L2) NEGATIVE CONTROL: the same stop while the last round is productive → downgraded, the round runs', async () => {
    const r = await t2({}, deps({ prov: provider(stopAll()), signalsFire: true }));
    assert.equal(r.honoured, false); assert.equal(r.effect, 'round-runs'); assert.equal(r.decision.guard.reasonCode, 'productive');
  });
  test('T2 with quiet signals is not run', async () => {
    const p = provider(stopAll());
    const r = await runMetaReview({ trigger: 'T2', sid: 'audit-code-1-1', mode: 'code', round: 4, caps: CAPS.code, argv: codeArgv(4), auditDir: dir }, deps({ prov: p }));
    assert.equal(r.ran, false); assert.match(r.reason, /signals did not fire/); assert.equal(p.calls.length, 0);
  });
  test('T2 that does not fire is RECORDED with each signal state (measured/unmeasured), and the record never changes a decision', async () => {
    const p = provider(stopAll());
    const base = deps({ prov: p });
    const d = { ...base, computeSignals: () => ({ version: 1, round: 3, anyFires: false, unmeasured: ['reopenRate'], signals: { reopenRate: { measured: false, fires: false, value: null, reason: 'round 3\'s 4 findings cite no lines' }, severityDrift: { measured: true, fires: false, value: 0, reason: 'median 0' } } }) };
    const r = await runMetaReview({ trigger: 'T2', sid: 'audit-code-eval', mode: 'code', round: 4, caps: CAPS.code, argv: codeArgv(4), auditDir: dir }, d);
    assert.equal(r.ran, false); assert.equal(p.calls.length, 0);
    assert.match(r.lines.join('\n'), /T2 evaluation logged: reopenRate=unmeasured severityDrift=quiet/);
    const ev = readMetaLog(metaLogPath(dir, 'audit-code-eval')).events.filter((e) => e.event === 'evaluation');
    assert.equal(ev.length, 1); assert.equal(ev[0].checkpoint, 3); assert.equal(ev[0].anyFires, false);
    assert.deepEqual(ev[0].signals.map((s) => [s.name, s.measured]), [['reopenRate', false], ['severityDrift', true]]);
    assert.match(ev[0].signals[0].reason, /cite no lines/);
    assert.equal(foldMetaLog(readMetaLog(metaLogPath(dir, 'audit-code-eval')).events).decisions.size, 0, 'an evaluation is not a decision');
  });
  test('T2 evaluation: a computation that THROWS is recorded as failed (redacted), not as a quiet no-fire', async () => {
    const d = { ...deps({ prov: provider(stopAll()) }), computeSignals: () => { throw new Error('boom token=sk-abcdefghijklmnopqrstuvwxyz0123456789'); } };
    const r = await runMetaReview({ trigger: 'T2', sid: 'audit-code-eval3', mode: 'code', round: 4, caps: CAPS.code, argv: codeArgv(4), auditDir: dir }, d);
    assert.match(r.reason, /could not be computed/); assert.match(r.lines.join('\n'), /COMPUTATION FAILED/);
    const ev = readMetaLog(metaLogPath(dir, 'audit-code-eval3')).events.find((e) => e.event === 'evaluation');
    assert.equal(ev.failed, true); assert.doesNotMatch(JSON.stringify(ev), /sk-abcdefghijklmnop/);
  });
  test('T2 evaluation: a log that cannot be written is reported, never thrown, and the round still runs', async () => {
    const base = deps({ prov: provider(stopAll()), append: () => ({ ok: false, reason: 'disk full' }) });
    const r = await runMetaReview({ trigger: 'T2', sid: 'audit-code-eval2', mode: 'code', round: 4, caps: CAPS.code, argv: codeArgv(4), auditDir: dir }, base);
    assert.equal(r.ran, false); assert.match(r.lines.join('\n'), /not logged \(disk full\)/);
  });
});

describe('R1 fixes', () => {
  test('an unsent unavailable decision is retried once the route exists', async () => {
    const first = await run({}, { ...deps({ prov: provider(stopAll()) }), selectProvider: () => ({ ok: false, reason: 'no route', skipped: [] }) });
    assert.equal(first.decision.state, 'unavailable');
    const p = provider(stopAll());
    const second = await run({}, deps({ prov: p }));
    assert.equal(p.calls.length, 1, 'retried, not reused'); assert.equal(second.effect, 'stop');
    assert.equal(foldMetaLog(readMetaLog(metaLogPath(dir, 'audit-plan-1-1')).events).decisions.get(second.decision.attemptId).state, 'valid');
  });
  test('the budget reservation is durable BEFORE the call (a crash mid-call still counts)', async () => {
    const p = provider(stopAll(), { throwErr: Object.assign(new Error('killed'), { sent: true }) });
    await run({}, deps({ prov: p }));
    const events = readMetaLog(metaLogPath(dir, 'audit-plan-1-1')).events;
    assert.deepEqual(events.map((e) => e.event), ['reserve', 'decision']);
    assert.equal(foldMetaLog(events).sentCount, 1);
  });
  test('an attempt reserved by another invocation with no decision (in flight / crashed mid-call) → not run, no call', async () => {
    const p = provider(stopAll());
    const d = deps({ prov: p });
    const probe = await run({}, { ...d, selectProvider: () => ({ ok: false, reason: 'probe', skipped: [] }) });
    appendMetaEvent(metaLogPath(dir, 'audit-plan-1-1'), { event: 'reserve', attemptId: probe.decision.attemptId });
    const r = await run({}, d);
    assert.equal(r.ran, false); assert.match(r.reason, /reserved by another invocation/); assert.equal(p.calls.length, 0);
  });
  test('a concurrent winner for the same attempt is the decision acted on', async () => {
    const d = deps({ prov: provider(stopAll()) });
    const append = (file, ev) => {
      if (ev.event === 'decision') appendMetaEvent(file, { ...ev, eventId: 'rival', guard: { effect: 'human-card', honoured: false, reasonCode: 'invalid', reason: 'rival' }, state: 'invalid', sent: true });
      return appendMetaEvent(file, ev);
    };
    const r = await run({}, { ...d, append });
    assert.equal(r.decision.eventId, 'rival'); assert.equal(r.effect, 'human-card');
  });
  test('changed evidence (plan content / HEAD) at the same round decides afresh', async () => {
    const p = provider(stopAll());
    await run({}, deps({ prov: p }));
    await run({}, { ...deps({ prov: p }), evidence: () => ({ planSha256: 'p2', head: 'h', diffSha256: null }) });
    assert.equal(p.calls.length, 2);
  });
  test('an unknown auditor family admits no automatic reviewer', () => {
    const r = createMetaReviewProvider({ auditorModel: null });
    assert.equal(r.ok, false); assert.match(r.reason, /auditor-family-unknown/);
  });
  test('a structural verdict citing the plan is honoured only when the plan reached the pack whole', async () => {
    const v = { action: 'structural', assessment: A, cause: 'stale doc', evidence: [{ file: 'docs/plans/x.md', why: 'w' }], proposedFix: 'f', reason: 'r' };
    const pk = (included) => async () => ({ text: 'P', files: [], notes: [], truncations: [], excluded: { sensitive: 0, unreadable: 0 }, topics: [TH, TM1, TM2], plan: included == null ? null : { path: 'docs/plans/x.md', included } });
    const ok = await runMetaReview({ trigger: 'T1', sid: 'c1', mode: 'code', round: 7, caps: CAPS.code, argv: codeArgv(7), auditDir: dir }, { ...deps({ prov: provider(v), rounds: CODE_ROUNDS }), buildPack: pk(true) });
    assert.equal(ok.effect, 'structural');
    const no = await runMetaReview({ trigger: 'T1', sid: 'c2', mode: 'code', round: 7, caps: CAPS.code, argv: codeArgv(7), auditDir: dir }, { ...deps({ prov: provider(v), rounds: CODE_ROUNDS }), buildPack: pk(null) });
    assert.equal(no.decision.guard.reasonCode, 'evidence-not-in-pack');
  });
  test('an invalid-JSON reply never persists a secret through the parse error', async () => {
    const r = await run({}, deps({ prov: provider('{"action":"stop", "x": sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD') }));
    assert.equal(r.decision.state, 'invalid');
    const line = fs.readFileSync(metaLogPath(dir, 'audit-plan-1-1'), 'utf8');
    assert.doesNotMatch(line, /sk-proj-abcdef/);
  });
});

describe('R2 fixes', () => {
  test('REGRESSION (R2 H1): the budget is checked inside a session lock — a slot taken meanwhile is seen', () => {
    const file = metaLogPath(dir, 's');
    const first = reserveUnderSessionLock({ auditDir: dir, sid: 's', file, budget: 1, attemptId: 'a', event: { event: 'reserve', attemptId: 'a' } });
    assert.equal(first.ok, true);
    const second = reserveUnderSessionLock({ auditDir: dir, sid: 's', file, budget: 1, attemptId: 'b', event: { event: 'reserve', attemptId: 'b' } });
    assert.equal(second.ok, false); assert.equal(second.budget, true);
  });
  test('a held (or crashed-and-left) session lock fails closed and is never stolen', () => {
    const lock = path.join(dir, 's.meta-review.lock');
    fs.writeFileSync(lock, '');
    const r = reserveUnderSessionLock({ auditDir: dir, sid: 's', file: metaLogPath(dir, 's'), budget: 3, attemptId: 'a', event: { event: 'reserve', attemptId: 'a' }, tries: 2 });
    assert.equal(r.ok, false); assert.match(r.reason, /is held/);
    assert.equal(fs.existsSync(lock), true, 'the lock is left for a human, not removed');
    assert.equal(readMetaLog(metaLogPath(dir, 's')).events.length, 0, 'nothing reserved');
  });
  test('REGRESSION (R2 H2): a changed ledger ruling at the same round decides afresh', async () => {
    const p = provider(stopAll());
    await run({}, deps({ prov: p }));
    await run({}, deps({ prov: p, ledger: [ruledEarlier(TH), ruledAt3(TH, 'dismissed'), ruledAt3(TM1), ruledAt3(TM2)] }));
    assert.equal(p.calls.length, 2);
  });
  test('REGRESSION (R2 H3): an overridden decision is not re-applied on reuse', async () => {
    const r = await run({}, deps({ prov: provider(stopAll()) }));
    await appendMetaOverride({ auditDir: dir, sid: 'audit-plan-1-1', attemptId: r.decision.attemptId, kind: 'override', by: 'louis', reason: 'continuing past the cap deliberately', source: 'past-cap' }, { record: () => 'k', flush: async () => {} });
    const again = await run({}, deps({ prov: provider(stopAll()) }));
    assert.equal(again.overridden, true); assert.equal(again.honoured, false); assert.equal(again.effect, 'human-card');
  });
});

describe('R3 fixes', () => {
  test('REGRESSION (R3 M1): a throwing appender is a failed reservation, never a rejection', () => {
    const r = reserveUnderSessionLock({ auditDir: dir, sid: 's', file: metaLogPath(dir, 's'), budget: 3, attemptId: 'a', event: { event: 'reserve', attemptId: 'a' }, append: () => { throw new Error('EIO'); } });
    assert.equal(r.ok, false); assert.match(r.reason, /EIO/);
    assert.equal(fs.existsSync(path.join(dir, 's.meta-review.lock')), false, 'the lock is released');
  });
  test('REGRESSION (R3 H1): a changed finding detail at the same round decides afresh', async () => {
    const p = provider(stopAll());
    await run({}, deps({ prov: p }));
    const changed = ROUNDS.map((r) => (r.round === 3 ? { ...r, findings: r.findings.map((x, i) => (i === 1 ? { ...x, detail: 'a different concern entirely' } : x)) } : r));
    await run({}, deps({ prov: p, rounds: changed }));
    assert.equal(p.calls.length, 2);
  });
  test('REGRESSION (R3 H2): a decision persisted while this invocation waited for the claim is reused, not re-sent', async () => {
    const p = provider(stopAll());
    const d = deps({ prov: p });
    const probe = await run({}, { ...d, selectProvider: () => ({ ok: false, reason: 'probe', skipped: [] }) });
    const id = probe.decision.attemptId;
    // Simulate the rival finishing between our first read and our claim: inject its decision at provider selection.
    const r = await run({}, { ...d, selectProvider: (a) => { appendMetaEvent(metaLogPath(dir, 'audit-plan-1-1'), { event: 'decision', attemptId: id, sent: true, state: 'valid', guard: { effect: 'stop', honoured: true, reasonCode: 'ok', reason: 'rival' } }); return p.select(a); } });
    assert.equal(r.reused, true); assert.equal(p.calls.length, 0);
  });
});

describe('R4 pivot: one lock, one resolver', () => {
  test('REGRESSION (R4 H2): a rival decision that a human then overrode, both landing while this invocation worked, is not applied', async () => {
    const p = provider(stopAll());
    const d = deps({ prov: p });
    const probe = await run({}, { ...d, selectProvider: () => ({ ok: false, reason: 'probe', skipped: [] }) });
    const id = probe.decision.attemptId; const file = metaLogPath(dir, 'audit-plan-1-1');
    const r = await run({}, { ...d, selectProvider: (a) => {
      appendMetaEvent(file, { event: 'decision', attemptId: id, sent: true, state: 'valid', guard: { effect: 'stop', honoured: true, reasonCode: 'ok', reason: 'rival' } });
      appendMetaEvent(file, { event: 'override', attemptId: id, by: 'louis', reason: 'continuing deliberately' });
      return p.select(a);
    } });
    assert.equal(r.overridden, true); assert.equal(r.effect, 'human-card'); assert.equal(p.calls.length, 0);
  });
  test('resolveExisting: none, retryable, overridden, honoured', () => {
    const fold = (events) => foldMetaLog(events);
    assert.equal(resolveExisting({ fold: fold([]), attemptId: 'a', human: 'human-card' }), null);
    assert.equal(resolveExisting({ fold: fold([{ event: 'decision', attemptId: 'a', state: 'unavailable', sent: false, guard: {} }]), attemptId: 'a', human: 'human-card' }), null);
    const dec = { event: 'decision', attemptId: 'a', state: 'valid', sent: true, guard: { effect: 'stop', honoured: true } };
    assert.equal(resolveExisting({ fold: fold([dec]), attemptId: 'a', human: 'human-card' }).effect, 'stop');
    assert.equal(resolveExisting({ fold: fold([dec, { event: 'override', attemptId: 'a' }]), attemptId: 'a', human: 'human-card' }).effect, 'human-card');
  });
});

describe('R5 fix', () => {
  test('REGRESSION (R5 M1): a confirmed pre-send failure releases its reservation; the retry runs and the budget is not consumed', async () => {
    const before = await run({}, deps({ prov: provider(stopAll(), { throwErr: Object.assign(new Error('no key'), { sent: false }) }) }));
    assert.equal(before.decision.sent, false);
    const fold = foldMetaLog(readMetaLog(metaLogPath(dir, 'audit-plan-1-1')).events);
    assert.equal(fold.sentCount, 0, 'nothing was sent, nothing charged'); assert.equal(fold.reserved.size, 0, 'not in flight');
    const p = provider(stopAll());
    const retry = await run({}, deps({ prov: p }));
    assert.equal(p.calls.length, 1); assert.equal(retry.effect, 'stop');
  });
  test('a reserve with no decision stays in flight and charged (crash mid-call is conservative)', () => {
    const fold = foldMetaLog([{ event: 'reserve', attemptId: 'a' }]);
    assert.equal(fold.sentCount, 1); assert.equal(fold.reserved.has('a'), true);
  });
});

describe('overrides', () => {
  test('an override reverses an honoured loop-end; a revoke ends an admission', async () => {
    const r = await run({}, deps({ prov: provider(stopAll()) }));
    const id = r.decision.attemptId;
    const o = await appendMetaOverride({ auditDir: dir, sid: 'audit-plan-1-1', attemptId: id, kind: 'override', by: 'louis', reason: 'the HIGH is real; continuing', source: 'past-cap' }, { record: () => 'k', flush: async () => {} });
    assert.equal(o.ok, true);
    const fold = foldMetaLog(readMetaLog(metaLogPath(dir, 'audit-plan-1-1')).events);
    assert.equal(honouredLoopEnd({ fold, attemptId: id }), null);
    assert.match(renderMetaLog({ auditDir: dir, sid: 'audit-plan-1-1' }).join('\n'), /override by louis/);
  });
});

describe('spend', () => {
  test('usage, estimate and none', () => {
    assert.equal(spendOf({ sent: false, usage: null, modelId: 'claude-opus-5-5', requestChars: 9e5, outputCeiling: 4000 }).costUsd, 0);
    const est = spendOf({ sent: true, usage: { usageMissing: true }, modelId: 'claude-opus-5-5', requestChars: 100_000, outputCeiling: 4000 });
    assert.equal(est.spendSource, 'estimate'); assert.ok(est.costUsd > 0);
    assert.equal(spendOf({ sent: true, usage: { input_tokens: 10, output_tokens: 1, usageMissing: false }, modelId: 'claude-opus-5-5', requestChars: 1, outputCeiling: 1 }).spendSource, 'usage');
  });
});

describe('egress (Tier 3)', () => {
  test('the pack the reviewer receives excludes a sensitive cited file and redacts a secret', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-egress-'));
    try {
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'src', 'a.mjs'), "export const k = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD';\n");
      fs.writeFileSync(path.join(repo, 'credentials.json'), '{"UNIQUE_ENV_MARKER_7731": 1}\n');
      fs.mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'docs', 'plans', 'x.md'), '# Plan\n');
      const cite = (id, sev) => ({ id, severity: sev, category: `c-${id}`, section: '§1', detail: 'd', _pass: 'plan', affectedFiles: ['src/a.mjs', 'credentials.json'] });
      const rounds = [{ round: 3, findings: [cite('H1', 'HIGH')] }];
      const p = provider(stopAll());
      const d = deps({ prov: p, rounds });
      const r = await runMetaReview({ trigger: 'T1', sid: 's', mode: 'plan', round: 4, caps: CAPS.plan, argv: planArgv(), auditDir: dir, cwd: repo },
        { ...d, buildPack: (a) => buildStepBackPack({ ...a, repoFiles: ['src/a.mjs', 'credentials.json', 'docs/plans/x.md'], archNeighbours: null }) });
      assert.equal(p.calls.length, 1, r.lines.join('\n'));
      const sent = p.calls[0].user;
      assert.doesNotMatch(sent, /UNIQUE_ENV_MARKER_7731/, 'a sensitive file never leaves');
      assert.doesNotMatch(sent, /sk-proj-abcdef/, 'a secret in a cited file is redacted');
      assert.ok(r.decision.pack.excludedCount >= 1, 'the exclusion is counted');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  test('the learning projection is an allowlist: no path, detail, premise or raw reply', () => {
    const d = { attemptId: 'a', trigger: 'T1', mode: 'plan', round: 4, caps: CAPS.plan, inventory: [{ topicId: 't', findingId: 'H1', severity: 'HIGH' }],
      verdict: { action: 'stop', items: [{ topicId: 't', kind: 'settled', premise: 'SECRET PREMISE src/private.mjs' }] }, raw: 'RAW REPLY', guard: { effect: 'stop', honoured: true, reasonCode: 'ok', reason: 'REASON TEXT .env' },
      pack: { chars: 10, fileCount: 1, excludedCount: 1 }, spendSource: 'usage' };
    const s = JSON.stringify(projectMetaDecisionForStore(d));
    for (const leak of ['SECRET PREMISE', 'src/private.mjs', 'RAW REPLY', 'REASON TEXT', '.env', 'H1']) assert.equal(s.includes(leak), false, leak);
  });
});

describe('reviewer selection', () => {
  const sel = (o) => createMetaReviewProvider({ auditorModel: o.auditor }, {
    family: (m) => (m.startsWith('claude') ? 'claude' : m.startsWith('gemini') ? 'gemini' : 'gpt'),
    resolve: (s) => ({ 'latest-opus': 'claude-opus-5-5', 'latest-pro': 'gemini-pro-latest' }[s]),
    geminiAvailability: () => ({ available: o.gemini !== false, reason: 'GEMINI_API_KEY not set' }),
    factory: (arm) => ({ arm, model: arm, ...(arm === 'higher' && o.sdk === false ? { unmeasuredReason: 'sdk backend unavailable' } : {}) }),
  });
  test('Opus first; falls to Gemini without an sdk route; unavailable with neither', () => {
    assert.equal(sel({ auditor: 'gpt-6' }).arm, 'higher');
    assert.equal(sel({ auditor: 'gpt-6', sdk: false }).arm, 'different');
    const none = sel({ auditor: 'gpt-6', sdk: false, gemini: false });
    assert.equal(none.ok, false); assert.equal(none.skipped.length, 2);
  });
  test('independence: an arm in the auditor\'s family is skipped', () => {
    assert.equal(sel({ auditor: 'claude-opus-5-5' }).arm, 'different');
    assert.equal(sel({ auditor: 'claude-opus-5-5', gemini: false }).reason, 'no route for any independent reviewer');
  });
  test('the higher arm pins the sdk backend on the emitted request and never falls back to cli', async () => {
    const created = []; const requests = [];
    const p = createStepBackProvider('higher', { resolve: () => 'claude-opus-5-5', sdkAvailability: () => ({ available: true, error: null }),
      createClient: async (opts) => { created.push(opts); return { messages: { create: async (body, o) => { requests.push({ body, o }); return { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }; } } }; },
      timeoutMs: 5000, maxRetries: 0 });
    const out = await p.call({ system: 'S', user: 'U' });
    assert.deepEqual(created, [{ backend: 'sdk' }]);
    assert.equal(requests[0].body.system, 'S'); assert.ok(requests[0].o.signal, 'a deadline is attached');
    assert.equal(requests[0].o.maxRetries, 0, 'REGRESSION (spawned CLI): the SDK retried 3 times; one attempt is one call');
    assert.equal(out.sent, true);
    const none = createStepBackProvider('higher', { resolve: () => 'claude-opus-5-5', sdkAvailability: () => ({ available: false, error: null }) });
    assert.ok(none.unmeasuredReason);
  });
  test('a failure building the client is sent:false', async () => {
    const p = createStepBackProvider('higher', { resolve: () => 'm', sdkAvailability: () => ({ available: true }), createClient: async () => { throw new Error('ANTHROPIC_API_KEY required'); } });
    await assert.rejects(p.call({ system: 's', user: 'u' }), (e) => e.sent === false);
  });
});
