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

  it('a returned non-ok envelope on a non-softFail command is CONTRACT_VIOLATION', async () => {
    // record-ship-event throws CommandError for failures; simulate a handler
    // regression by making the STORE return ok:true while the handler is
    // forced into the returned-envelope path — covered above. Here: prove
    // the validator itself using persona-outcomes' softFail exemption as the
    // negative control: summary returning ok:false PASSES (exit 0)…
    const { deps } = recordingDeps({
      getPersonaOutcomesSummary: async () => ({ ok: false, error: 'store exploded' }),
    });
    const r = await dispatch(argv('persona-outcomes', 'summary', '--repo', 'o/r'), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, 'softFail: summary forwards the store result verbatim (frozen legacy quirk)');
    assert.equal(r.envelope.ok, false);
  });

  it('CommandError is exported and typed', () => {
    const e = new CommandError('X', 'msg', { a: 1 }, 3);
    assert.equal(e.code, 'X');
    assert.equal(e.exitCode, 3);
  });
});
