/**
 * @fileoverview Audit telemetry capture (docs/plans/audit-telemetry-capture.md) -
 * the pure halves: session identity resolution. The store halves are in
 * audit-capture-db.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuditIdentity, stampableSourceModel } from '../scripts/lib/audit/audit-identity.mjs';

describe('resolveAuditIdentity', () => {
  it('two rounds from the --out path share a session and get distinct rounds', () => {
    const r1 = resolveAuditIdentity({ outPath: '.audit/audit-1-r1-result.json' });
    const r2 = resolveAuditIdentity({ outPath: '.audit/audit-1-r2-result.json' });
    assert.equal(r1.auditSessionId, 'audit-1');
    assert.equal(r2.auditSessionId, 'audit-1');
    assert.deepEqual([r1.auditRound, r2.auditRound], [1, 2]);
  });

  it('the flag wins when the path does not parse, and agreeing sources are not a conflict', () => {
    assert.deepEqual(resolveAuditIdentity({ sessionFlag: 's1', roundFlag: 3, outPath: '/tmp/x.json' }),
      { auditSessionId: 's1', auditRound: 3, conflict: null });
    assert.equal(resolveAuditIdentity({ sessionFlag: 's1', roundFlag: 2, outPath: 's1-r2-result.json' }).conflict, null);
  });

  it('a session disagreement yields NULL for both, never a pick', () => {
    const r = resolveAuditIdentity({ sessionFlag: 'a', roundFlag: 1, outPath: 'b-r1-result.json' });
    assert.equal(r.auditSessionId, null);
    assert.equal(r.auditRound, null);
    assert.match(r.conflict, /disagrees/);
  });

  it('a round disagreement yields NULL for both', () => {
    const r = resolveAuditIdentity({ roundFlag: 2, outPath: 'a-r1-result.json' });
    assert.equal(r.auditSessionId, null);
    assert.equal(r.auditRound, null);
    assert.match(r.conflict, /round/);
  });

  it('no source yields NULL with no conflict (the id is never guessed)', () => {
    assert.deepEqual(resolveAuditIdentity({}), { auditSessionId: null, auditRound: null, conflict: null });
    assert.deepEqual(resolveAuditIdentity({ sessionFlag: '  ', roundFlag: 0 }), { auditSessionId: null, auditRound: null, conflict: null });
  });
});

describe('stampableSourceModel', () => {
  it('passes a concrete provider-returned id through unnormalised', () => {
    assert.equal(stampableSourceModel('gpt-6.1-terra-2026-10-28'), 'gpt-6.1-terra-2026-10-28');
    assert.equal(stampableSourceModel('qwen/qwen3.8-max'), 'qwen/qwen3.8-max');
  });
  it('a mechanical pass (no model) is an honest null', () => {
    assert.equal(stampableSourceModel(null), null);
    assert.equal(stampableSourceModel(undefined), null);
    assert.equal(stampableSourceModel('  '), null);
  });
  it('an unresolved latest-* sentinel is refused, not stored', () => {
    assert.equal(stampableSourceModel('latest-gpt'), null);
    assert.equal(stampableSourceModel('latest-opus'), null);
  });
});

describe('assembleFindings stamps _sourceModel per pass', async () => {
  const { assembleFindings } = await import('../scripts/lib/audit/finding-assembly.mjs');
  const { minimalFinalizationData } = await import('./helpers/multi-pass-audit-fixtures.mjs');
  const mk = (detail, extra = {}) => ({
    id: 'H1', severity: 'HIGH', category: 'Test', section: `${detail}.mjs:1`, detail, risk: 'r', recommendation: 'x',
    is_quick_fix: false, is_mechanical: false, principle: 'Test',
    classification: { sonarType: 'BUG', effort: 'MEDIUM', sourceKind: 'MODEL', sourceName: 'test' }, ...extra,
  });

  it('an LLM pass stamps the provider-returned model; a mechanical pass (no model) stays null', async () => {
    const data = minimalFinalizationData({
      backendPassNames: ['backend'],
      backendResults: [{ result: { pass_name: 'backend', findings: [mk('alpha unrelated detail')], quick_fix_warnings: [] }, usage: {}, latencyMs: 0, model: 'gpt-6.1-terra-2026-10-28' }],
      runDuplication: true,
      duplicationResult: { result: { findings: [mk('zeta separate concern here')] }, usage: {}, latencyMs: 0 },
    });
    const { allFindings } = await assembleFindings(data);
    const llm = allFindings.find((f) => f.detail.startsWith('alpha'));
    const mech = allFindings.find((f) => f.detail.startsWith('zeta'));
    assert.equal(llm._sourceModel, 'gpt-6.1-terra-2026-10-28');
    assert.equal(mech._sourceModel, undefined);
  });

  it('an unresolved sentinel is not stamped', async () => {
    const data = minimalFinalizationData({
      backendPassNames: ['backend'],
      backendResults: [{ result: { pass_name: 'backend', findings: [mk('beta detail')], quick_fix_warnings: [] }, usage: {}, latencyMs: 0, model: 'latest-gpt' }],
    });
    const { allFindings } = await assembleFindings(data);
    assert.equal(allFindings[0]._sourceModel, undefined);
  });
});

describe('reviewer events: id parsing, matching and the receipt', async () => {
  const re = await import('../scripts/lib/final-review/reviewer-events.mjs');
  const { presentedDismissals } = await import('../scripts/lib/audit/transcript.mjs');
  const { redactAndCapText, CAPTURE_TEXT_MAX } = await import('../scripts/lib/store/capture-identity.mjs');

  const ledger = { entries: [
    { adjudicationOutcome: 'dismissed', latestFindingId: 'H1', resolvedRound: 1, topicId: 't1' },
    { adjudicationOutcome: 'dismissed', latestFindingId: 'H1', resolvedRound: 2, topicId: 't2' },
    { adjudicationOutcome: 'dismissed', latestFindingId: 'M3', resolvedRound: 2, topicId: 't3' },
    { adjudicationOutcome: 'accepted', latestFindingId: 'H9', resolvedRound: 2, topicId: 't9' },
  ] };
  const transcript = {
    presented_dismissals: presentedDismissals(ledger),
    rounds: [
      { round: 1, findings: [{ id: 'H1', _hash: 'fp-r1-h1' }] },
      { round: 2, findings: [{ id: 'H1', _hash: 'fp-r2-h1' }, { id: 'M3', _hash: 'fp-r2-m3' }] },
    ],
  };

  it('presentedDismissals keeps dismissed entries only, round-qualified', () => {
    assert.deepEqual(transcript.presented_dismissals.map((p) => p.id), ['R1 H1', 'R2 H1', 'R2 M3']);
  });

  it('parses round-qualified and bare ids; rejects junk', () => {
    assert.deepEqual(re.parseOriginalFindingId('R2 H7'), { round: 2, id: 'H7' });
    assert.deepEqual(re.parseOriginalFindingId('[h3]'), { round: null, id: 'H3' });
    assert.equal(re.parseOriginalFindingId('two words'), null);
    assert.equal(re.parseOriginalFindingId(42), null);
  });

  it('a bare id present in two rounds is ambiguous; a round-qualified one is exact; outside the set is unmatched', () => {
    const p = transcript.presented_dismissals;
    assert.equal(re.matchPresented('H1', p).status, 'ambiguous');
    assert.equal(re.matchPresented('R2 H1', p).entry.resolvedRound, 2);
    assert.equal(re.matchPresented('M3', p).entry.resolvedRound, 2);
    assert.equal(re.matchPresented('H9', p).status, 'unmatched');
    assert.equal(re.matchPresented('R3 H1', p).status, 'unmatched');
  });

  it('3 presented (1 from round 1, 2 from round 2) and 1 reversal: one event on the correct source, receipt complete', () => {
    const plan = re.planReviewerEvents({ transcript, wronglyDismissed: [{ original_finding_id: 'R1 H1', reason_claude_was_wrong: 'x' }] });
    assert.equal(plan.presented, 3);
    assert.equal(plan.resolvable.length, 3);
    assert.deepEqual(plan.reversals.map((r) => [r.fingerprint, r.entry.resolvedRound]), [['fp-r1-h1', 1]]);
    const receipt = re.buildReviewerReceipt({ plan, presentedResolved: 3, reversalsWritten: 1 });
    assert.deepEqual(receipt, { presented: 3, presented_resolved: 3, reversals: 1, reversals_written: 1, unresolved: 0, ambiguous: 0, status: 'complete' });
  });

  it('an unresolvable, ambiguous or unwritten reversal makes the receipt incomplete (counted, never guessed)', () => {
    const plan = re.planReviewerEvents({ transcript, wronglyDismissed: [
      { original_finding_id: 'R9 H1' }, { original_finding_id: 'H1' }, { original_finding_id: 'R2 M3' },
    ] });
    assert.equal(plan.unresolved, 1);
    assert.equal(plan.ambiguous, 1);
    assert.equal(plan.reversals.length, 1);
    assert.equal(re.buildReviewerReceipt({ plan, presentedResolved: 3, reversalsWritten: 1 }).status, 'incomplete');
    const clean = re.planReviewerEvents({ transcript, wronglyDismissed: [{ original_finding_id: 'R2 M3' }] });
    assert.equal(re.buildReviewerReceipt({ plan: clean, presentedResolved: 3, reversalsWritten: 0 }).status, 'incomplete', 'a spilled/lost write is not complete');
    assert.equal(re.buildReviewerReceipt({ plan: clean, presentedResolved: 2, reversalsWritten: 1 }).status, 'incomplete', 'an unresolved presented entry is not complete');
  });

  it('an absent presented set is an unknown denominator (incomplete), distinct from an empty one', () => {
    const absent = re.planReviewerEvents({ transcript: { rounds: [] }, wronglyDismissed: [] });
    assert.equal(absent.presentedKnown, false);
    assert.equal(re.buildReviewerReceipt({ plan: absent, presentedResolved: 0, reversalsWritten: 0 }).status, 'incomplete');
    const empty = re.planReviewerEvents({ transcript: { rounds: [], presented_dismissals: [] }, wronglyDismissed: [] });
    assert.equal(empty.presentedKnown, true);
    assert.equal(re.buildReviewerReceipt({ plan: empty, presentedResolved: 0, reversalsWritten: 0 }).status, 'complete');
  });

  it('the same finding cited twice is one reversal', () => {
    const plan = re.planReviewerEvents({ transcript, wronglyDismissed: [{ original_finding_id: 'R2 M3' }, { original_finding_id: 'r2 m3' }] });
    assert.equal(plan.reversals.length, 1);
  });

  it('redactAndCapText redacts a seeded secret and caps the length', () => {
    const seeded = `rotate the key sk-${'a1B2c3D4'.repeat(6)} before shipping`;
    const out = redactAndCapText(seeded);
    assert.ok(!out.includes('a1B2c3D4a1B2c3D4'), 'the seeded secret must not survive');
    assert.equal(redactAndCapText('x'.repeat(CAPTURE_TEXT_MAX + 500)).length, CAPTURE_TEXT_MAX);
    assert.equal(redactAndCapText('   '), null);
    assert.equal(redactAndCapText(undefined), null);
  });
});

describe('equivalence links: tally and concern link pairs', async () => {
  const { emptyEquivalenceTally, tallyEquivalenceOutcome, recordEquivalenceLinks } = await import('../scripts/lib/audit/equivalence-links.mjs');
  const { resolveConcernLinks } = await import('../scripts/lib/concern-identity.mjs');

  it('every durableWrite outcome lands in a named counter; an unknown outcome is not a success', () => {
    const t = emptyEquivalenceTally();
    for (const out of [
      { outcome: 'written' }, { outcome: 'spilled' }, { outcome: 'lost' },
      { outcome: 'skipped', error: 'skipped:endpoint' }, { outcome: 'skipped', error: 'skipped:cycle' },
      { outcome: 'skipped', error: 'cloud-off' }, { outcome: 'weird' },
    ]) tallyEquivalenceOutcome(t, out);
    assert.equal(t.expected, 7);
    assert.deepEqual([t.written, t.spilled, t.lost], [1, 1, 2]);
    assert.equal(t['skipped:endpoint'], 1);
    assert.equal(t['skipped:cycle'], 1);
    assert.equal(t['skipped:other'], 1);
  });

  it('recordEquivalenceLinks survives a throwing writer and still reports the receipt', async () => {
    const receipts = [];
    const tally = await recordEquivalenceLinks({
      runId: 'run-1', createdBy: 'concern-v1',
      links: [{ duplicateFingerprint: 'a', canonicalFingerprint: 'b' }, { duplicateFingerprint: 'c', canonicalFingerprint: 'd' }],
      deps: {
        durableWrite: async (_id, p) => { if (p.duplicateFingerprint === 'a') throw new Error('boom'); return { outcome: 'written' }; },
        recordWriteReceipt: async (run, key, r) => receipts.push([run, key, r]),
      },
    });
    assert.deepEqual([tally.expected, tally.written, tally.lost], [2, 1, 1]);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0][1], 'equivalence');
  });

  it('resolveConcernLinks returns the resolved root pairs for THIS batch only', () => {
    const pending = [{ topicId: 'T-new', latestFindingId: 'H1' }, { topicId: 'T-other', latestFindingId: 'H2' }];
    const ledgerByTopic = new Map([['T-old-root', { topicId: 'T-old-root' }]]);
    const { links } = resolveConcernLinks(pending, new Map([['T-new', 'T-old-root']]), new Map([['H1', 'T-new'], ['H2', 'T-other']]), ledgerByTopic);
    assert.deepEqual(links, [{ duplicateTopicId: 'T-new', canonicalTopicId: 'T-old-root' }]);
  });
});

describe('coverage applicability keys are generated from MECHANICAL_WAVES', async () => {
  const { APPLICABILITY } = await import('../scripts/lib/telemetry/coverage.mjs');
  const { MECHANICAL_WAVES } = await import('../scripts/lib/audit-shadow.mjs');

  it('every mechanical wave is excluded from model_pass and model_finding (no hand list)', () => {
    assert.ok(MECHANICAL_WAVES.length > 0, 'vacuous-pass guard: the wave list must not be empty');
    for (const w of MECHANICAL_WAVES) {
      assert.ok(APPLICABILITY.model_pass.includes(`'${w}'`), `model_pass must exclude ${w}`);
      assert.ok(APPLICABILITY.model_finding.includes(`[${w[0].toUpperCase()}${w.slice(1)}]`), `model_finding must exclude [${w}]`);
    }
  });

  it('model_pass counts only passes that made a model call (tokens recorded)', () => {
    assert.match(APPLICABILITY.model_pass, /COALESCE\(input_tokens, 0\) > 0/);
  });
});
