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

/** A child that emits one record then wedges its event loop synchronously. */
const WEDGE = `
  process.stdout.write(JSON.stringify({type:'hello'}) + '\\n');
  const until = Date.now() + 60000;
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
    const r = await runJsonLinesAsync(process.execPath, ['-e', WEDGE], {
      timeoutMs: 300, killGraceMs: 200,
    });
    assert.equal(r.timedOut, true);
    // The wedge would run 60s; we must be back far sooner.
    assert.ok(Date.now() - started < 20_000, 'must not wait out the wedged child');
    // Output produced BEFORE the kill is still returned — a timeout degrades
    // the measurement, it does not discard what was already observed.
    assert.deepEqual(r.records, [{ type: 'hello' }]);
  });

  it('LEAVES NO CHILD ALIVE — SIGTERM escalates to SIGKILL', async () => {
    // Without this, the timeout could report success while a wedged process
    // keeps burning a core. SIGTERM is only a request; a synchronously-wedged
    // child never services it, so the escalation is what actually ends it.
    const r = await runJsonLinesAsync(process.execPath, ['-e', WEDGE], {
      timeoutMs: 200, killGraceMs: 150,
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
    await assert.rejects(
      () => runJsonLinesAsyncStrict(process.execPath, ['-e', WEDGE], {
        timeoutMs: 200, killGraceMs: 150, stage: 'extract',
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
