/**
 * @fileoverview Pure linkage contract (scripts/lib/telemetry/linkage.mjs) and the report folder
 * (linkage-queries.mjs `buildLinkageReport`). The persisted chain is tested on a real Postgres in
 * tests/audit-capture-db.test.mjs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveLinkage, classifyStoredRun, STANDALONE_REASONS, LINKAGE_REGISTRY, UNDECLARED_REASON } from '../scripts/lib/telemetry/linkage.mjs';
import { buildLinkageReport } from '../scripts/lib/telemetry/linkage-queries.mjs';

describe('resolveLinkage', () => {
  test('a session id is linked; a unified run drops the round', () => {
    assert.deepEqual(resolveLinkage({ auditSessionId: 's', auditRound: 2 }), { state: 'linked', reason: null, auditSessionId: 's', auditRound: 2 });
    assert.equal(resolveLinkage({ auditSessionId: 's', auditRound: 2, unifiedRun: true }).auditRound, null);
  });

  test('no session and no declaration is explicit `unlinked`, never an absent state', () => {
    for (const v of [{}, { auditSessionId: '' }, { auditSessionId: '   ' }, { auditSessionId: null }]) {
      assert.deepEqual(resolveLinkage(v), { state: 'unlinked', reason: UNDECLARED_REASON, auditSessionId: null, auditRound: null });
    }
  });

  test('a declared reason is standalone; an unknown reason or a reason plus a session throws', () => {
    const reason = Object.keys(STANDALONE_REASONS)[0];
    assert.equal(resolveLinkage({ standaloneReason: reason }).state, 'standalone');
    assert.throws(() => resolveLinkage({ standaloneReason: 'whatever' }), /unknown standalone reason/);
    assert.throws(() => resolveLinkage({ standaloneReason: reason, auditSessionId: 's' }), /cannot be standalone/);
    // inherited keys are not declarations
    assert.throws(() => resolveLinkage({ standaloneReason: 'toString' }), /unknown standalone reason/);
  });
});

describe('classifyStoredRun', () => {
  test('a row without the state column is `legacy-unstated`, never linked; a contradicted `linked` is demoted', () => {
    assert.equal(classifyStoredRun({ audit_session_id: null }), 'legacy-unstated');
    assert.equal(classifyStoredRun({ audit_session_id: 's' }), 'linked');
    assert.equal(classifyStoredRun({ linkage_state: 'linked', audit_session_id: null }), 'unlinked');
    assert.equal(classifyStoredRun({ linkage_state: 'standalone' }), 'standalone');
  });
});

describe('buildLinkageReport', () => {
  const runs = [{ id: 'a', audit_round: 1, linkage_state: 'linked', audit_session_id: 's' }, { id: 'u', audit_round: null, linkage_state: 'linked', audit_session_id: 's' }];
  test('places rows by their own round, then the run round, and lists what it cannot place', () => {
    const rep = buildLinkageReport({
      session: 's', round: 2, runs,
      passes: [{ run_id: 'a', round: 1 }, { run_id: 'u', round: 2 }, { run_id: 'u', round: null }],
      findings: [{ run_id: 'u', round: 2, n: 3 }, { run_id: 'a', round: 1, n: 1 }],
      calls: [{ run_id: 'a', n: 4 }, { run_id: 'u', n: 5 }],
      unlinked: [], orphanCalls: 0,
    });
    assert.deepEqual(rep.passes, { matched: 1, otherRounds: 1, unresolved: 1 });
    assert.deepEqual(rep.findings, { matched: 3, otherRounds: 1, unresolved: 0 });
    assert.deepEqual(rep.calls, { matched: 0, unresolvedRound: 5 });
    assert.equal(rep.complete, false);
  });

  test('an unknown session is never complete (an empty result is not an answer)', () => {
    const rep = buildLinkageReport({ session: 'x', round: 1, runs: [], passes: [], findings: [], calls: [], unlinked: [{ state: 'unlinked', runs: 2 }], orphanCalls: 0 });
    assert.equal(rep.sessionKnown, false);
    assert.equal(rep.complete, false);
    assert.equal(rep.unlinkedStoreWide[0].runs, 2);
  });
});

describe('inventory', () => {
  test('every registry key names a writer registered in audit-store-writers (no stale inventory)', async () => {
    const src = fs.readFileSync(new URL('../scripts/lib/audit-store-writers.mjs', import.meta.url), 'utf8');
    for (const id of Object.keys(LINKAGE_REGISTRY)) {
      if (id === 'audit.runStart') continue; // the run row's own insert is not a durableWrite
      assert.ok(src.includes(`registerWriter('${id}'`), `${id} is not a registered writer`);
    }
  });
});
