/**
 * @fileoverview Tests for the optional subprocess timeout (§2.1.8).
 *
 * The load-bearing assertion is the LAST one: a timeout that "passes" while
 * orphaning a wedged child has not timed out, it has lied. §2.1.8 exists
 * because `cruise()` does substantial synchronous work on the calling event
 * loop, so no in-child timer can fire — only a process boundary interrupts it.
 *
 * Plan: docs/plans/observed-graph-coverage-honesty.md §2.1.8
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runJsonLinesAsync, runJsonLinesAsyncStrict, SUBPROC_ERROR_CODES,
} from '../scripts/lib/subprocess.mjs';

/**
 * A child that emits one record then wedges its event loop synchronously.
 *
 * The wedge is bounded at 5s, not 60s, deliberately. A busy-wait pins a CPU
 * core, and if a kill ever regressed, a 60s burner × several tests would
 * destabilise timing-sensitive tests elsewhere in the suite — observed as an
 * intermittent unrelated failure while building this. A test that can flake
 * the rest of the suite is a bad test regardless of what it proves. 5s is
 * still 3-4× the 1500ms timeouts asserted below, so the wedge is unambiguous
 * while its worst case stays survivable.
 *
 * The timeouts below were originally 200-300ms (~20× headroom) and flaked
 * under a fully-loaded pre-push sandbox run: `timeoutMs` starts ticking the
 * instant `spawn()` is called (subprocess.mjs's `timeouts.arm()`), correctly
 * including child process-startup latency in the budget — a slow-to-start
 * child should count against it. Under heavy CPU contention, Node's own
 * interpreter startup occasionally exceeded 300ms, killing the child before
 * it reached its first `stdout.write`. 1500ms absorbs realistic startup
 * jitter while keeping a clear multiple of headroom under the 5s wedge.
 */
const WEDGE = `
  process.stdout.write(JSON.stringify({type:'hello'}) + '\\n');
  const until = Date.now() + 5000;
  while (Date.now() < until) {}   // synchronous — no timer in here can fire
`;

/** A well-behaved child that exits promptly. */
const QUICK = `process.stdout.write(JSON.stringify({type:'ok'}) + '\\n');`;

describe('runJsonLinesAsync — optional timeout', () => {
  it('is OFF by default: a fast child is untouched', async () => {
    const r = await runJsonLinesAsync(process.execPath, ['-e', QUICK]);
    assert.equal(r.timedOut, false);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.records, [{ type: 'ok' }]);
  });

  it('does not fire when the child finishes inside the budget', async () => {
    const r = await runJsonLinesAsync(process.execPath, ['-e', QUICK], { timeoutMs: 30_000 });
    assert.equal(r.timedOut, false);
    assert.equal(r.exitCode, 0);
  });

  it('kills a child wedged in synchronous work', async () => {
    const started = Date.now();
    // timeoutMs/killGraceMs start ticking the instant spawn() is called (see
    // subprocess.mjs's timeouts.arm()), correctly — a slow-to-start child
    // should count against its own budget. But that means these values must
    // absorb legitimate OS/Node process-startup jitter, not just the wedge's
    // own execution: 200-300ms flaked under a heavily loaded full test-suite
    // run (observed: the child's own startup ate the whole budget before it
    // reached its first stdout write, so `records` came back `[]` instead of
    // `[{type:'hello'}]` — not a kill-mechanism bug, a too-tight test budget).
    // 1500/300 keeps the same ~3-4x proof margin against the 5s wedge and the
    // `< 3_000` assertion below, while tolerating multi-hundred-ms spawn
    // latency spikes under contention.
    const r = await runJsonLinesAsync(process.execPath, ['-e', WEDGE], {
      timeoutMs: 1500, killGraceMs: 300,
    });
    assert.equal(r.timedOut, true);
    // The wedge would run 5s; being back well inside that proves we killed it
    // rather than waited it out.
    assert.ok(Date.now() - started < 3_500, 'must not wait out the wedged child');
    // Output produced BEFORE the kill is still returned — a timeout degrades
    // the measurement, it does not discard what was already observed.
    assert.deepEqual(r.records, [{ type: 'hello' }]);
  });

  it('leaves no DIRECT child alive — SIGTERM escalates to SIGKILL', async () => {
    // Without this, the timeout could report success while a wedged process
    // keeps burning a core. SIGTERM is only a request; a synchronously-wedged
    // child never services it, so the escalation is what actually ends it.
    //
    // Scoped to the DIRECT child deliberately (round-1 Cluster B audit, HIGH):
    // the child is not spawned into its own process group, so a grandchild
    // would survive. No current caller spawns one — see the LIMITATION note in
    // subprocess.mjs. Naming this "no child alive" would overclaim, and an
    // overclaiming test is worse than a missing one.
    // See the timing note in the previous test — same latent flake, not yet
    // observed here only because nothing asserts a wall-clock ceiling.
    const r = await runJsonLinesAsync(process.execPath, ['-e', WEDGE], {
      timeoutMs: 1500, killGraceMs: 300,
    });
    assert.equal(r.timedOut, true);
    // `close` fires only after the process is genuinely gone, so arriving here
    // with a settled result IS the proof the child is dead.
    assert.ok(r.exitCode !== 0 || r.signal, 'child must have died abnormally');
  });
});

describe('runJsonLinesAsyncStrict — the timeout surfaces as a THROW', () => {
  it('throws KILLED_BY_SIGNAL with cause.timedOut', async () => {
    // NOT a flag on the success return: the strict wrapper returns only
    // `records` on success, so a result flag would be unreachable by
    // construction. The thrown error is the channel that already exists.
    // Same timing note as the runJsonLinesAsync tests above.
    await assert.rejects(
      () => runJsonLinesAsyncStrict(process.execPath, ['-e', WEDGE], {
        timeoutMs: 1500, killGraceMs: 300, stage: 'extract',
      }),
      (err) => {
        assert.equal(err.code, SUBPROC_ERROR_CODES.KILLED_BY_SIGNAL);
        assert.equal(err.timedOut, true);
        assert.equal(err.cause.timedOut, true, 'refresh.mjs reads cause.timedOut');
        assert.equal(err.stage, 'extract');
        return true;
      }
    );
  });

  it('an ordinary non-zero exit is NOT reported as a timeout', async () => {
    // A timeout is a degraded measurement; an unexplained failure is still an
    // error. Conflating them would let a crashing extractor render as a
    // benign "budget exceeded".
    await assert.rejects(
      () => runJsonLinesAsyncStrict(process.execPath, ['-e', 'process.exit(3)'], {
        timeoutMs: 30_000,
      }),
      (err) => {
        assert.equal(err.code, SUBPROC_ERROR_CODES.EXIT_NONZERO);
        assert.ok(!err.timedOut);
        return true;
      }
    );
  });

  it('a successful run under a budget behaves exactly as before', async () => {
    const records = await runJsonLinesAsyncStrict(process.execPath, ['-e', QUICK], {
      timeoutMs: 30_000,
    });
    assert.deepEqual(records, [{ type: 'ok' }]);
  });
});
