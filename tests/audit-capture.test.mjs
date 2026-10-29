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
