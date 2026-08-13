/**
 * @fileoverview The §2b F2 write-outcome contract: a store writer reports its
 * own outcome, and its handler stops inferring one from a null.
 *
 * WHY THIS SUITE HAD TO BE WRITTEN BEFORE THE CHANGE COULD BE BELIEVED. F2
 * converts four writers and five handlers, and the full suite went **0 failures**
 * against the conversion. That green was not evidence: every golden fixture for
 * these commands is a cloud-off or bad-input case, and `cloud: 'degrade-noop'`
 * returns the degrade envelope BEFORE the writer is reached. So the entire
 * converted path — the only path the change touches — had no coverage at all.
 * "Nothing broke" and "nothing ran" are the same colour.
 *
 * Each case drives the real dispatcher in-process with a stub store forced to
 * the cloud path (`cloudGate: 'ready'`), so the handler's mapping from the
 * writer's result to the envelope and the exit code is what is actually under
 * test. The failing-writer cases are the point: before F2 every one of them
 * produced `{ok:false}` (or `{ok:false, locked:false}`) at **exit 0**,
 * indistinguishable from a legitimate refusal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../scripts/lib/cross-skill/dispatch.mjs';

const argv = (...a) => ['node', 'cross-skill.mjs', ...a];

/** The minimum store surface these five commands touch. */
function stubDeps(overrides = {}) {
  return {
    initLearningStore: async () => true,
    isCloudEnabled: async () => true,
    // record-persona-session gates on its OWN cloud check, not the shared one.
    // Omitting it silently routed every persona case to the degrade envelope,
    // where `reason` is absent — a stub gap that reads exactly like a handler
    // that stopped reporting.
    isPersonaCloudEnabled: async () => true,
    resolveRepoForStoreResult: async () => ({ kind: 'resolved', repoRowId: 'repo-1', repoUuid: 'uuid-1', name: 'o/r' }),
    getRepoIdByName: async () => 'repo-1',
    getRepoIdByUuid: async () => ({ id: 'repo-1', name: 'o/r' }),
    listRepoIds: async () => ['repo-1'],
    ...overrides,
  };
}

const WRITE_FAILED = {
  ok: false, cloud: true, reason: 'write-failed',
  message: 'upsert returned no row — the write did not verify',
};

describe('record-regression-spec — a failed write is exit 1, not ok:false at exit 0', () => {
  const payload = JSON.stringify({
    specPath: 'tests/x.spec.ts', description: 'd', sourceKind: 'ux-lock',
    assertionCount: 1, domContractTypes: [],
  });

  it('happy path: the handler reports the specId the writer verified', async () => {
    const deps = stubDeps({ recordRegressionSpec: async () => ({ ok: true, cloud: true, specId: 'spec-9' }) });
    const r = await dispatch(argv('record-regression-spec', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.deepEqual(r.envelope, { ok: true, cloud: true, specId: 'spec-9' });
  });

  it('a failed write exits 1 and names the store reason', async () => {
    // PRE-F2 this was `{ok: false, cloud: true, specId: null}` at exit 0 — the
    // `ok: !!specId` shape, where a DB outage looked like a declined write.
    const deps = stubDeps({ recordRegressionSpec: async () => ({ ...WRITE_FAILED, specId: null }) });
    const r = await dispatch(argv('record-regression-spec', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 1, 'a write that did not verify must not exit 0');
    assert.equal(r.envelope.ok, false);
    assert.equal(r.envelope.error.code, 'WRITE_FAILED');
    assert.match(r.envelope.error.message, /did not verify/);
  });

  it('an input refusal is a distinct code from a write failure', async () => {
    // The whole point of the discriminated result: the writer had EIGHT ways to
    // return null and the handler could not tell them apart.
    const deps = stubDeps({
      recordRegressionSpec: async () => ({ ok: false, cloud: true, specId: null, reason: 'invalid-input', message: 'spec_path is required' }),
    });
    const r = await dispatch(argv('record-regression-spec', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 2, 'bad input is exit 2, not the write-failure exit');
    assert.equal(r.envelope.error.code, 'BAD_INPUT');
  });
});

describe('record-plan-verify-run — same contract, second writer', () => {
  const payload = JSON.stringify({ planId: 'plan-1', totalCriteria: 3, passedCount: 3 });

  it('happy path returns the verified runId', async () => {
    const deps = stubDeps({ recordPlanVerificationRun: async () => ({ ok: true, cloud: true, runId: 'run-7' }) });
    const r = await dispatch(argv('record-plan-verify-run', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.deepEqual(r.envelope, { ok: true, cloud: true, runId: 'run-7' });
  });

  it('a failed insert exits 1 rather than reporting runId:null at exit 0', async () => {
    const deps = stubDeps({ recordPlanVerificationRun: async () => ({ ...WRITE_FAILED, runId: null }) });
    const r = await dispatch(argv('record-plan-verify-run', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 1);
    assert.equal(r.envelope.error.code, 'WRITE_FAILED');
  });
});

describe('record-plan-verify-items — a SHORT write is a failed write', () => {
  const payload = JSON.stringify({
    runId: 'r-1', planId: 'p-1',
    items: [{ criterionHash: 'a' }, { criterionHash: 'b' }, { criterionHash: 'c' }],
  });

  it('all rows accepted → ok, with both counts reported', async () => {
    const deps = stubDeps({ recordPlanVerificationItems: async () => ({ ok: true, inserted: 3 }) });
    const r = await dispatch(argv('record-plan-verify-items', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.deepEqual(r.envelope, { ok: true, cloud: true, inserted: 3, requested: 3 });
  });

  it('a PARTIAL insert exits 1 and names both counts', async () => {
    // Raised in BOTH Cluster F audit rounds. `inserted` was already the count
    // Postgres accepted rather than the count requested — but `ok:true` rode
    // alongside it, so a caller checking `ok` and a caller comparing `inserted`
    // to `items.length` reached opposite conclusions from one result.
    const deps = stubDeps({
      recordPlanVerificationItems: async () => ({
        ok: false, inserted: 2, reason: 'row-count-mismatch',
        message: 'INSERT affected 2 of 3 plan_verification_items row(s)',
      }),
    });
    const r = await dispatch(argv('record-plan-verify-items', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 1, 'a short write is operational failure (1), not an argv error (2)');
    assert.equal(r.envelope.error.code, 'WRITE_FAILED');
    assert.match(r.envelope.error.message, /2 of 3/);
    assert.equal(r.envelope.error.inserted, 2);
    assert.equal(r.envelope.error.requested, 3);
  });

  it('a planId that disagrees with the run is refused BEFORE anything is written', async () => {
    // The first cut reconciled the caller's planId AFTER the insert, so a
    // mismatch left the rows committed while telling the caller it had failed —
    // write-then-refuse, worse than either alternative (audit H2/H5). The check
    // is input validation now, and it runs first.
    const deps = stubDeps({
      recordPlanVerificationItems: async () => ({
        ok: false, inserted: 0, reason: 'plan-id-mismatch',
        message: 'run r-1 belongs to plan p-9, not the supplied p-1 — refusing before writing anything',
      }),
    });
    const r = await dispatch(argv('record-plan-verify-items', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 1);
    assert.equal(r.envelope.error.reason, 'plan-id-mismatch');
    assert.equal(r.envelope.error.inserted, 0, 'a refusal must report that NOTHING was written');
    assert.match(r.envelope.error.message, /before writing anything/);
  });

  it('ZERO rows written is distinguishable from a partial write', async () => {
    const deps = stubDeps({
      recordPlanVerificationItems: async () => ({
        ok: false, inserted: 0, reason: 'no-rows-written',
        message: 'INSERT affected 0 of 3 plan_verification_items row(s)',
      }),
    });
    const r = await dispatch(argv('record-plan-verify-items', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.error.reason, 'no-rows-written');
  });
});

describe('lock-with-test — `locked` must never claim a write that did not verify', () => {
  const base = ['lock-with-test', '--finding', 'f-1', '--test', 'tests/cross-skill-write-outcome-contract.test.mjs', '--description', 'd'];
  // A REAL file: lock-with-test refuses a path that does not exist ('a lock
  // naming a missing file is a fake check'), so a fabricated path never reaches
  // the writer and the case would assert the refusal instead.
  const found = { audit_finding_id: 'f-1', repo_id: 'repo-1' };

  it('a verified write reports locked:true with the specId', async () => {
    const deps = stubDeps({
      findUnlockedFixInRepo: async () => found,
      recordRegressionSpec: async () => ({ ok: true, cloud: true, specId: 'spec-3' }),
    });
    const r = await dispatch(argv(...base), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.equal(r.envelope.locked, true);
    assert.equal(r.envelope.specId, 'spec-3');
  });

  it('a failed write reports locked:false WITH a reason, never a bare false', async () => {
    // This command's entire job is to answer "is this finding locked?". Before
    // F2 a store outage answered `locked:false` — the same answer as a refusal
    // the operator can act on, with nothing to tell them apart.
    const deps = stubDeps({
      findUnlockedFixInRepo: async () => found,
      recordRegressionSpec: async () => ({ ...WRITE_FAILED, specId: null }),
    });
    const r = await dispatch(argv(...base), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.locked, false);
    assert.equal(r.envelope.reason, 'write-failed', 'the envelope must say WHY it is not locked');
    assert.match(r.envelope.error, /NOT written/);
    assert.ok(!('specId' in r.envelope), 'no specId may be reported for a write that did not verify');
  });
});

describe('record-persona-session — reports the failure WITHOUT discarding the diagnosis', () => {
  const payload = JSON.stringify({
    sessionId: 's-1', persona: 'p', url: 'https://x.test', browserTool: 'playwright',
    verdict: 'Ready for users', stepsTaken: 1, findings: [],
  });

  it('a failed write is ok:false and still carries correlationSummary', async () => {
    // The designed exception to "map ok:false to a throw". A throw discards the
    // payload, and `correlationSummary.reason` is the field that explains the
    // failure downstream — trading the diagnosis for the signal is not a fix.
    const deps = stubDeps({
      recordPersonaSession: async () => ({
        ok: false, cloud: true, reason: 'write-failed', message: 'boom',
        sessionId: null, existed: false, statsUpdated: false,
      }),
    });
    const r = await dispatch(argv('record-persona-session', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.ok, false, 'the envelope must not claim success');
    assert.equal(r.envelope.reason, 'write-failed');
    assert.equal(r.envelope.correlationSummary.reason, 'session-write-failed',
      'the diagnosis must survive — that is why this command does not throw');
  });

  it('a verified write is ok:true and carries the row id', async () => {
    const deps = stubDeps({
      recordPersonaSession: async () => ({ ok: true, cloud: true, sessionId: 'row-1', existed: false, statsUpdated: true }),
      getCandidateAuditFindings: async () => [],
      getExistingCorrelationHashesForSession: async () => [],
    });
    const r = await dispatch(argv('record-persona-session', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.equal(r.envelope.ok, true);
    assert.equal(r.envelope.sessionId, 'row-1');
  });
});

describe('count validation — the guard that was satisfied by its own presence', () => {
  // Four audit rounds reported plan-verify counts as unvalidated while
  // `validateCountFields(p)` sat at the call site. Both were true: the
  // validator's DEFAULT field list is passedCriteria/failedCriteria/
  // skippedCriteria, and this command's payload carries passedCount/
  // failedCount/skippedCount — so every optional field was `undefined`,
  // skipped, and `passedCount: -5` returned ok. Accepted, validated, inert.
  //
  // Fixed at BOTH layers, deliberately: the handler (so the CLI refuses with
  // exit 2) and the store (because ux-lock-run.mjs calls the writer directly
  // and a handler-only guard leaves that caller unprotected).
  for (const [label, bad] of [
    ['a negative peer', { planId: 'p-1', totalCriteria: 3, passedCount: -5 }],
    // NOT NaN: `JSON.stringify({x: NaN})` emits `null`, so NaN cannot reach a
    // CLI through a --json payload at all — the test case would have been
    // asserting a shape the transport makes unrepresentable. A numeric STRING
    // is what a shell pipeline actually delivers, and it is the same class as
    // the `"false"`-becomes-true bug fixed in the items writer.
    ['a numeric string', { planId: 'p-1', totalCriteria: 3, failedCount: '2' }],
    ['peers exceeding the total', { planId: 'p-1', totalCriteria: 1, passedCount: 5 }],
  ]) {
    it(`the handler refuses ${label} (exit 2)`, async () => {
      const deps = stubDeps({
        recordPlanVerificationRun: async () => { throw new Error('the writer must not be reached'); },
      });
      const r = await dispatch(argv('record-plan-verify-run', '--json', JSON.stringify(bad)), { deps, cloudGate: 'ready' });
      assert.equal(r.exitCode, 2, JSON.stringify(r.envelope));
      assert.equal(r.envelope.error.code, 'BAD_INPUT');
    });
  }

  it('a VALID payload still passes — the fix narrows, it does not block', async () => {
    const deps = stubDeps({ recordPlanVerificationRun: async () => ({ ok: true, cloud: true, runId: 'run-1' }) });
    const payload = JSON.stringify({ planId: 'p-1', totalCriteria: 3, passedCount: 2, failedCount: 1 });
    const r = await dispatch(argv('record-plan-verify-run', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.equal(r.envelope.runId, 'run-1');
  });
});
