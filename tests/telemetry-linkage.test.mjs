/**
 * @fileoverview Pure linkage contract (scripts/lib/telemetry/linkage.mjs) and the report folder
 * (linkage-queries.mjs `buildLinkageReport`). The persisted chain is tested on a real Postgres in
 * tests/audit-capture-db.test.mjs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveLinkage, classifyStoredRun, STANDALONE_REASONS, LINKAGE_REGISTRY, LINKAGE_EXEMPT, UNDECLARED_REASON } from '../scripts/lib/telemetry/linkage.mjs';
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
    assert.deepEqual(rep.passes, { matched: 1, otherRounds: 1, unresolved: 1 }, 'a null child round is unresolved, NOT filled from the run');
    assert.deepEqual(rep.findings, { matched: 3, otherRounds: 1, unresolved: 0 });
    assert.deepEqual(rep.calls, { matched: 0, otherRounds: 4, unresolvedRound: 5 });
    assert.equal(rep.complete, false);
  });

  test('an unknown session is never complete (an empty result is not an answer)', () => {
    const rep = buildLinkageReport({ session: 'x', round: 1, runs: [], passes: [], findings: [], calls: [], unlinked: [{ state: 'unlinked', runs: 2 }], orphanCalls: 0 });
    assert.equal(rep.sessionKnown, false);
    assert.equal(rep.complete, false);
    assert.equal(rep.unlinkedStoreWide[0].runs, 2);
  });
});

describe('buildLinkageReport: round existence and repo scope', () => {
  const base = { passes: [], findings: [], calls: [], unlinked: [], orphanCalls: 0 };
  test('a round that does not exist in a known session is NOT complete', () => {
    const runs = [{ id: 'a', repo_id: 'r', audit_round: 1, linkage_state: 'linked', audit_session_id: 's' }];
    assert.equal(buildLinkageReport({ ...base, session: 's', round: 1, runs }).complete, true);
    const rep = buildLinkageReport({ ...base, session: 's', round: 999, runs });
    assert.equal(rep.roundKnown, false);
    assert.equal(rep.complete, false);
  });
  test('a session spanning two repos without --repo is ambiguous and never complete', () => {
    const runs = [{ id: 'a', repo_id: 'r1', audit_round: 1, audit_session_id: 's' }, { id: 'b', repo_id: 'r2', audit_round: 1, audit_session_id: 's' }];
    const rep = buildLinkageReport({ ...base, session: 's', round: 1, runs });
    assert.deepEqual(rep.ambiguousRepos, ['r1', 'r2']);
    assert.equal(rep.complete, false);
    assert.equal(buildLinkageReport({ ...base, session: 's', round: 1, repoId: 'r1', runs: [runs[0]] }).ambiguousRepos, null);
  });
});

describe('inventory', () => {
  const registered = () => {
    const src = fs.readFileSync(new URL('../scripts/lib/audit-store-writers.mjs', import.meta.url), 'utf8');
    return [...src.matchAll(/registerWriter\('([^']+)'/g)].map((m) => m[1]);
  };
  test('every registered writer is in LINKAGE_REGISTRY or LINKAGE_EXEMPT, and the two never overlap (both directions)', () => {
    const reg = new Set(registered());
    const declared = new Set([...Object.keys(LINKAGE_REGISTRY).filter((k) => k !== 'audit.runStart'), ...Object.keys(LINKAGE_EXEMPT)]);
    assert.deepEqual([...reg].filter((x) => !declared.has(x)), [], 'a registered writer has no linkage decision');
    assert.deepEqual([...declared].filter((x) => !reg.has(x)), [], 'a declared writer is not registered (stale)');
    assert.deepEqual(Object.keys(LINKAGE_EXEMPT).filter((k) => k in LINKAGE_REGISTRY), []);
  });
  test('the migration CHECK lists exactly STANDALONE_REASONS (both directions)', () => {
    const sql = fs.readFileSync(new URL('../supabase/migrations/20261123150000_audit_runs_linkage_state.sql', import.meta.url), 'utf8');
    const m = sql.match(/linkage_reason IN (([^)]*))/);
    assert.ok(m, 'standalone reason list not found in migration');
    const inSql = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(inSql, Object.keys(STANDALONE_REASONS).sort());
  });
});
