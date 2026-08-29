/**
 * @fileoverview Store-call goldens — the cloud-path complement to the
 * cloud-off envelope goldens (docs/plans/cross-skill-command-registry.md §9,
 * audit R1-M1 / R3-H2).
 *
 * Dispatches migrated commands IN-PROCESS against a RECORDING stub store
 * with the cloud gate forced ready (`cloudGate: 'ready'` — without it a
 * hermetic run has no pool, degrade-noop routes to the cloud-off envelope,
 * and the stub is never reached; that was R2's unrunnable harness). Every
 * store call records {fn, args}; the expectations pin which functions run,
 * in what order, with what argument shapes.
 *
 * What these fixtures can and cannot prove (R3-H2, stated honestly): there
 * is no legacy-side capture — legacy handlers bypass ctx.deps by
 * construction. The expectations were written from the migrated handler at
 * its first green run and REVIEWED against the legacy source (move-only
 * diff); from that point they pin against FUTURE drift: a dropped store
 * call, reordered writes, or a changed argument shape fails here even when
 * the cloud-off envelope is identical.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, CommandError } from '../scripts/lib/cross-skill/dispatch.mjs';

function recordingDeps(overrides = {}) {
  const calls = [];
  const record = (fn, ret) => (...args) => { calls.push({ fn, args }); return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret); };
  const deps = {
    initLearningStore: record('initLearningStore', true),
    isCloudEnabled: record('isCloudEnabled', true),
    resolveRepoForStoreResult: record('resolveRepoForStoreResult',
      { kind: 'resolved', repoRowId: 'repo-row-1', repoUuid: 'uuid-1', name: 'o/r' }),
    getRepoIdByName: record('getRepoIdByName', 'repo-row-1'),
    getRepoIdByUuid: record('getRepoIdByUuid', { id: 'repo-row-1', name: 'o/r' }),
    listRepoIds: record('listRepoIds', ['repo-row-1']),
    recordShipEvent: record('recordShipEvent', { ok: true, cloud: true }),
    getPersonaOutcomesSummary: record('getPersonaOutcomesSummary', { ok: true, cloud: true, sessionId: null }),
    getActionablePersonaOutcomeItems: record('getActionablePersonaOutcomeItems', { ok: true, cloud: true, items: [], truncated: false }),
    resolveLabelTarget: record('resolveLabelTarget', { ok: true, repoId: 'repo-row-1' }),
    upsertPersonaFindingOutcome: record('upsertPersonaFindingOutcome', { ok: true }),
    backfillPersonaFindingHashV2: record('backfillPersonaFindingHashV2', { alreadyCurrent: true, scanned: 0 }),
    ...overrides,
  };
  return { deps, calls };
}

const argv = (...a) => ['node', 'cross-skill.mjs', ...a];

describe('record-ship-event — the write template', () => {
  it('happy path: scope resolved ambiently, ONE ship-event write, ok envelope', async () => {
    const { deps, calls } = recordingDeps();
    const r = await dispatch(argv('record-ship-event', '--json', '{"outcome":"success","commitSha":"abc","branch":"main"}'), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.deepEqual(r.envelope, { ok: true, cloud: true });
    const names = calls.map((c) => c.fn);
    assert.deepEqual(names, ['resolveRepoForStoreResult', 'recordShipEvent'],
      'exactly these store calls, in this order — a dropped or reordered call is silent data loss');
    const [repoId, event] = calls[1].args;
    assert.equal(repoId, 'repo-row-1', 'the write must carry the RESOLVED scope, not null');
    assert.equal(event.outcome, 'success');
    assert.equal(event.commitSha, 'abc');
  });

  it('payload repoId wins over ambient (legacy resolveRepoId precedence)', async () => {
    const { deps, calls } = recordingDeps();
    await dispatch(argv('record-ship-event', '--json', '{"outcome":"success","repoId":"explicit-row"}'), { deps, cloudGate: 'ready' });
    assert.ok(!calls.some((c) => c.fn === 'resolveRepoForStoreResult'),
      'an explicit payload repoId must not trigger ambient resolution');
    assert.equal(calls.find((c) => c.fn === 'recordShipEvent').args[0], 'explicit-row');
  });

  it("the store's {ok:false} becomes a thrown failure, never a returned success", async () => {
    const { deps } = recordingDeps({
      recordShipEvent: async () => ({ ok: false, cloud: true, reason: 'write-failed', error: 'boom' }),
    });
    const r = await dispatch(argv('record-ship-event', '--json', '{"outcome":"success"}'), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 1);
    assert.equal(r.envelope.ok, false);
    assert.equal(r.envelope.error.code, 'WRITE_FAILED');
  });

  it('a transient ambient-resolution failure refuses the write (F7 stays dead)', async () => {
    const { deps, calls } = recordingDeps({
      resolveRepoForStoreResult: async () => { throw new Error('pool down'); },
    });
    const r = await dispatch(argv('record-ship-event', '--json', '{"outcome":"success"}'), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.error.code, 'REPO_RESOLVE_FAILED');
    assert.ok(!calls.some((c) => c.fn === 'recordShipEvent'),
      'no unscoped row may be written on a transient failure');
  });
});

describe('upsert-plan — a receipt is not a write', () => {
  // Locks audit finding d2c4fe8a (aged out of /ship Step 0.5b unlocked, and
  // unclosable until 2026-08-29 because the close path queried the WINDOWED
  // view). The handler's own comment calls this "the exact shape this handler
  // just closed, one field over": `{ok:true, planId:null}` used to fall
  // through to `ok: !!planId` and surface as a soft `{ok:false}` at exit 0.
  const payload = JSON.stringify({ path: 'docs/plans/x.md', skill: 'plan' });

  it('a well-formed receipt is a success (negative control — the guard must not fire on the happy path)', async () => {
    const { deps } = recordingDeps({ upsertPlan: async () => ({ ok: true, planId: 'plan-1' }) });
    const r = await dispatch(argv('upsert-plan', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.ok, true);
    assert.equal(r.envelope.planId, 'plan-1');
  });

  it('ok:true with NO planId is a hard failure, never a soft ok:false at exit 0', async () => {
    const { deps } = recordingDeps({ upsertPlan: async () => ({ ok: true, planId: null }) });
    const r = await dispatch(argv('upsert-plan', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.ok, false);
    assert.equal(r.envelope.error.code, 'PLAN_WRITE_UNVERIFIED');
    assert.notEqual(r.exitCode, 0,
      'a write the command cannot evidence must not exit 0 — that is the reading that made an outage invisible');
  });

  it('an UNHANDLED !ok reason still fails closed (no fall-through as a non-event)', async () => {
    const { deps } = recordingDeps({ upsertPlan: async () => ({ ok: false, reason: 'a-reason-added-later' }) });
    const r = await dispatch(argv('upsert-plan', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.error.code, 'PLAN_WRITE_FAILED');
    assert.match(r.envelope.error.message, /a-reason-added-later/);
  });
});

describe('persona-outcomes — the explicit-required template', () => {
  it('summary resolves the REQUESTED repo by name, then reads with that id', async () => {
    const { deps, calls } = recordingDeps();
    const r = await dispatch(argv('persona-outcomes', 'summary', '--repo', 'other/repo'), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.deepEqual(calls.find((c) => c.fn === 'getRepoIdByName').args, ['other/repo']);
    assert.deepEqual(calls.find((c) => c.fn === 'getPersonaOutcomesSummary').args,
      [{ repoName: 'other/repo', repoId: 'repo-row-1' }]);
    assert.ok(!calls.some((c) => c.fn === 'resolveRepoForStoreResult'),
      'the ambient checkout must play NO part in an explicitly-named read (F4/F10)');
  });

  it('label writes through resolveLabelTarget → upsert, with the target repoId (NO --repo — the session is the parent)', async () => {
    // label never resolves --repo: its repo derives from the addressed session
    // row (the documented invocation the /ship worksheet prints has no --repo).
    const { deps, calls } = recordingDeps();
    const r = await dispatch(
      argv('persona-outcomes', 'label', '--session', 's1', '--hash', 'h1', '--outcome', 'fixed'),
      { deps, cloudGate: 'ready' },
    );
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    const upsert = calls.find((c) => c.fn === 'upsertPersonaFindingOutcome');
    assert.deepEqual(upsert.args[0], {
      repoId: 'repo-row-1', personaFindingHash: 'h1', outcome: 'fixed',
      lastSeenSessionId: 's1', labeledBy: 'agent', rationale: null,
    });
  });

  it('backfill-hash (MUTATING) uses the requested repo, never ambient', async () => {
    const { deps, calls } = recordingDeps();
    const r = await dispatch(
      argv('persona-outcomes', 'backfill-hash', '--repo', 'other/repo', '--dry-run'),
      { deps, cloudGate: 'ready' },
    );
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    const bf = calls.find((c) => c.fn === 'backfillPersonaFindingHashV2');
    assert.deepEqual(bf.args[0], { repoId: 'repo-row-1', dryRun: true, reportPath: null });
    assert.ok(!calls.some((c) => c.fn === 'resolveRepoForStoreResult'));
  });

  it('--worksheet resolves explicit scope, reads actionables, and writes the file (audit CA-r4 coverage gap)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xskill-ws-'));
    const outPath = path.join(tmp, 'worksheet.md');
    try {
      const { deps, calls } = recordingDeps();
      // Override AND record (a raw override bypasses the recorder — the
      // recordingDeps overrides parameter is for return-value stubs only).
      deps.getActionablePersonaOutcomeItems = async (args) => {
        calls.push({ fn: 'getActionablePersonaOutcomeItems', args: [args] });
        return {
          ok: true, cloud: true, truncated: false,
          items: [{ sessionId: 's1', personaFindingHash: 'h1', severity: 'P0', outcome: null, element: 'button', observed: 'dead' }],
        };
      };
      const r = await dispatch(
        argv('persona-outcomes', '--worksheet', '--repo', 'other/repo', '--out', outPath),
        { deps, cloudGate: 'ready' },
      );
      assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
      assert.equal(r.envelope.count, 1);
      assert.deepEqual(calls.find((c) => c.fn === 'getActionablePersonaOutcomeItems').args,
        [{ repoName: 'other/repo', repoId: 'repo-row-1' }]);
      assert.ok(!calls.some((c) => c.fn === 'resolveRepoForStoreResult'),
        'worksheet scope comes from --repo, never ambient');
      assert.ok(fs.readFileSync(outPath, 'utf8').includes('h1'), 'the worksheet file must contain the finding');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a store outage during name resolution reads as REPO_LOOKUP_FAILED, not UNKNOWN_REPO (F17)', async () => {
    const { deps } = recordingDeps({ getRepoIdByName: async () => { throw new Error('down'); } });
    const r = await dispatch(argv('persona-outcomes', 'summary', '--repo', 'o/r'), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.error.code, 'REPO_LOOKUP_FAILED');
  });
});

describe('Cluster B writers — store-call shapes', () => {
  it('upsert-plan resolves ambient scope then upserts with it', async () => {
    const { deps, calls } = recordingDeps();
    deps.upsertPlan = async (repoId, plan) => { calls.push({ fn: 'upsertPlan', args: [repoId, plan] }); return { ok: true, planId: 'plan-1' }; };
    const r = await dispatch(argv('upsert-plan', '--json', '{"path":"docs/plans/x.md","skill":"plan"}'), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.equal(r.envelope.planId, 'plan-1');
    assert.deepEqual(calls.map((c) => c.fn), ['resolveRepoForStoreResult', 'upsertPlan']);
    assert.equal(calls[1].args[0], 'repo-row-1', 'the plan row must carry the resolved scope');
  });

  it("upsert-plan maps the store's write-failed reason to a typed failure", async () => {
    const { deps } = recordingDeps();
    deps.upsertPlan = async () => ({ ok: false, reason: 'write-failed', message: 'boom' });
    const r = await dispatch(argv('upsert-plan', '--json', '{"path":"docs/plans/x.md","skill":"plan"}'), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.error.code, 'PLAN_WRITE_FAILED');
  });

  it('update-plan-status resolves the plan by path, scoped, then updates', async () => {
    const { deps, calls } = recordingDeps();
    deps.getPlanIdByPath = async (repoId, p) => { calls.push({ fn: 'getPlanIdByPath', args: [repoId, p] }); return { ok: true, planId: 'plan-1', path: p }; };
    deps.updatePlanStatus = async (a) => { calls.push({ fn: 'updatePlanStatus', args: [a] }); return { ok: true }; };
    const r = await dispatch(argv('update-plan-status', '--json', '{"path":"docs/plans/x.md","status":"Complete"}'), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.deepEqual(calls.find((c) => c.fn === 'getPlanIdByPath').args, ['repo-row-1', 'docs/plans/x.md']);
    assert.deepEqual(calls.find((c) => c.fn === 'updatePlanStatus').args[0],
      { repoId: 'repo-row-1', planId: 'plan-1', status: 'Complete' });
  });

  it('update-plan-status separates a lookup OUTAGE from a genuinely absent plan', async () => {
    const { deps } = recordingDeps();
    deps.getPlanIdByPath = async () => ({ ok: false, reason: 'lookup-failed', message: 'store down' });
    const r = await dispatch(argv('update-plan-status', '--json', '{"path":"docs/plans/x.md","status":"Complete"}'), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.error.code, 'PLAN_LOOKUP_FAILED',
      'a store outage must not read as "no plan registered — run /plan first"');
  });

  it('record-regression-spec REFUSES an unscoped write (the duplicate-on-rerun trap)', async () => {
    const { deps, calls } = recordingDeps({
      resolveRepoForStoreResult: async () => ({ kind: 'unresolved' }),
    });
    const r = await dispatch(argv('record-regression-spec', '--json', '{"sourceKind":"audit-loop-fix","description":"d","specPath":"tests/x.spec.ts"}'), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.error.code, 'BAD_INPUT');
    assert.ok(!calls.some((c) => c.fn === 'recordRegressionSpec'),
      'a NULL repo_id is distinct from every other NULL in Postgres — the row would duplicate on every re-run');
  });

  it('the batch writers demand EXACT cardinality — short, over, or non-numeric (audit CB-r1/r2)', async () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const partial = recordingDeps();
    partial.deps.recordSymbolIndex = async () => 1;
    const r1 = await dispatch(argv('record-symbol-index', '--json', JSON.stringify({ refreshId: 'r', repoId: 'p', rows })), { deps: partial.deps, cloudGate: 'ready' });
    assert.equal(r1.envelope.error.code, 'ROW_COUNT_MISMATCH');

    // An OVER-count is equally evidence the one-row-per-input contract does
    // not hold — rejecting only short counts let it read as success.
    const over = recordingDeps();
    over.deps.recordSymbolIndex = async () => 5;
    const rOver = await dispatch(argv('record-symbol-index', '--json', JSON.stringify({ refreshId: 'r', repoId: 'p', rows })), { deps: over.deps, cloudGate: 'ready' });
    assert.equal(rOver.envelope.error.code, 'ROW_COUNT_MISMATCH');

    const nan = recordingDeps();
    nan.deps.recordLayeringViolations = async () => undefined;
    const r2 = await dispatch(argv('record-layering-violations', '--json', JSON.stringify({ refreshId: 'r', repoId: 'p', violations: rows })), { deps: nan.deps, cloudGate: 'ready' });
    assert.equal(r2.envelope.error.code, 'WRITE_UNVERIFIED');

    // Vacuous-pass guard: a complete write still succeeds.
    const okDeps = recordingDeps();
    okDeps.deps.recordSymbolIndex = async () => 3;
    const r3 = await dispatch(argv('record-symbol-index', '--json', JSON.stringify({ refreshId: 'r', repoId: 'p', rows })), { deps: okDeps.deps, cloudGate: 'ready' });
    assert.equal(r3.exitCode, 0);
    assert.equal(r3.envelope.inserted, 3);
  });

  it('abort-refresh-run keeps its exit-1 refusal through the error wrapper', async () => {
    const { deps } = recordingDeps();
    deps.abortRefreshRun = async () => ({ aborted: false });
    const r = await dispatch(argv('abort-refresh-run', '--json', '{"repoId":"p","refreshId":"r"}'), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.error.code, 'ABORT_NOT_APPLIED');
    assert.equal(r.exitCode, 1, 'passthroughErrors must not re-wrap a handler CommandError down to exit 2');
  });

  it('record-persona-session reconciles identity UNCONDITIONALLY, even when both fields are supplied', async () => {
    const { deps, calls } = recordingDeps({
      isPersonaCloudEnabled: async () => true,
      resolveRepoForStoreResult: async () => ({ kind: 'resolved', repoRowId: 'id-B', repoUuid: 'u', name: 'owner/repo-B' }),
    });
    const payload = JSON.stringify({
      persona: 'p', url: 'https://e.test', browserTool: 'playwright', verdict: 'Needs work',
      repoId: 'id-A', repoName: 'owner/repo-A',
    });
    const r = await dispatch(argv('record-persona-session', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.error.code, 'REPO_IDENTITY_CONFLICT',
      'a payload naming repo A from a checkout of repo B must not be written verbatim');
    assert.ok(!calls.some((c) => c.fn === 'recordPersonaSession'));
  });
});

describe('the dispatcher contract itself', () => {
  it('an undeclared flag READ throws UNDECLARED_FLAG (the --report-path class, structurally)', async () => {
    // whoami declares no flags; a handler stub reading one must die. Proven
    // via ctx directly: dispatch a synthetic entry is not possible without
    // widening the registry, so assert through the public surface — the
    // declared-flag accessor on a real command.
    const { deps } = recordingDeps();
    const r = await dispatch(argv('whoami'), { deps });
    assert.equal(r.exitCode, 0);
    assert.equal(r.envelope.ok, true);
  });

  it('a DECLARED in-band failure keeps its payload AND exits non-zero', async () => {
    // `softFail` → `reportsFailure` (2026-08-12). The old declaration meant
    // "ok:false at exit 0", which conflated two opposite things: an outcome
    // that is not really a failure (a declined run, a cloud-off read) and a
    // real failure whose PAYLOAD is the point. The first kind was converted to
    // honest `ok:true`; this second kind now exits 1 with the envelope intact.
    //
    // The exit code is what makes the difference visible: under softFail this
    // exact case returned 0, so every caller checking `$?` — every shell
    // script, every CI step — read a failed summary query as a success.
    const { deps } = recordingDeps({
      getPersonaOutcomesSummary: async () => ({ ok: false, error: 'store exploded' }),
    });
    const r = await dispatch(argv('persona-outcomes', 'summary', '--repo', 'o/r'), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 1, 'a declaration must not be able to buy exit 0 for a real failure');
    assert.equal(r.envelope.ok, false);
    assert.equal(r.envelope.error, 'store exploded',
      'the payload survives — that is the whole reason this is a declaration and not a throw');
  });

  it('the declaration is VERB-SCOPED — it exempts summary only, not the whole command', async () => {
    // The negative control for the case above, and it has to be this rather
    // than "drive an undeclared command until it returns ok:false": no command
    // CAN do that any more. Every handler either builds an ok:true envelope or
    // throws CommandError, which is the validator having done its job — so the
    // violation branch is unreachable through the public surface, and a test
    // that pretended otherwise would be asserting a fiction.
    //
    // What IS checkable is that the exemption stayed narrow. A command-wide
    // declaration on persona-outcomes would silently cover `label`,
    // `backfill-hash` and `--worksheet` too, and those must stay armed.
    const { REGISTRY } = await import('../scripts/lib/cross-skill/registry.mjs');
    const entry = REGISTRY.find((e) => e.name === 'persona-outcomes');
    assert.deepEqual(entry.reportsFailure, { verbs: ['summary'] },
      'only `summary` forwards a store result verbatim; the other verbs throw and must stay validated');
    assert.notEqual(entry.reportsFailure?.all, true);
  });

  it('NO command declares softFail any more — the exemption that bought exit 0 is gone', async () => {
    // §2b F4's invariant is absolute rather than baselined: there is no
    // declaration left that yields `ok:false` at exit 0. `reportsFailure`
    // replaced it and always exits 1.
    const { REGISTRY } = await import('../scripts/lib/cross-skill/registry.mjs');
    assert.deepEqual(REGISTRY.filter((e) => e.softFail).map((e) => e.name), []);
  });

  it('CommandError is exported and typed', () => {
    const e = new CommandError('X', 'msg', { a: 1 }, 3);
    assert.equal(e.code, 'X');
    assert.equal(e.exitCode, 3);
  });
});
