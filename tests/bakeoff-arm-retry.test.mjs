/**
 * @fileoverview Automatic retry-on-timeout for one bake-off arm.
 *
 * Tier 1 (deterministic module, test-first): `classifyArmAttempt` and
 * `runArmAttempts` take their spawn, their result reader and their run-minting
 * as PARAMETERS precisely so the whole policy is assertable here without a
 * provider call, a subprocess or a database.
 *
 * **The load-bearing direction is the one the guard must NOT fire in.** A
 * missed retry costs one re-invocation; a retry of a deterministic failure
 * (bad model id, missing credential, 4xx, schema rejection) spends real money
 * to reproduce a certainty, twice per arm, on every snapshot. Every retryable
 * case below therefore has a non-retryable twin.
 *
 * @module tests/bakeoff-arm-retry
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyArmAttempt, runArmAttempts, ARM_MAX_ATTEMPTS, HARD_DEADLINE_EXIT_CODE,
} from '../scripts/lib/bakeoff/spawn.mjs';
import { classifyLlmError } from '../scripts/lib/robustness.mjs';
import { mergeRetryHistory } from '../scripts/bakeoff-collect.mjs';

const ARM = { id: 'qwen', env: { GEMINI_REVIEW_TIMEOUT_MS: '900000' } };
const CTX = { transcript: 't.json', plan: 'p.md', mode: 'code', outDir: '.audit/x', id: 'snap1' };

/** A spawn outcome for a child that exited 0 and wrote a result file. */
const ok = (elapsedMs = 1000) => ({ ok: true, outPath: 'o.json', status: 0, elapsedMs });
/** A spawn outcome for a child that failed hard. */
const exited = (status, elapsedMs = 1000) => ({ error: `exit ${status}`, stderrTail: '…', status, elapsedMs });

/** The arm record a TIMED-OUT shadow produces — the real measured shape. */
const timedOut = () => ({
  costUsd: null,
  unpricedModels: ['qwen3.8-max'],
  shadowState: 'error-unavailable',
  shadowModel: 'qwen3.8-max',
  shadowErrorCategory: 'timeout',
  shadowErrorRetryable: true,
  shadowError: '[shadow-review] Timeout after 900s',
});
/** The arm record a SUCCESSFUL shadow produces. */
const ran = (costUsd = 0.41) => ({
  costUsd,
  unpricedModels: [],
  shadowState: 'ran',
  shadowModel: 'qwen3.8-max',
  shadowScope: 'thin',
  shadowErrorCategory: null,
  shadowErrorRetryable: null,
});

describe('classifyArmAttempt — retry eligibility is READ, never re-derived', () => {
  it('a shadow timeout is retryable, carrying the classifier’s own category', () => {
    const c = classifyArmAttempt(ok(900_000), timedOut());
    assert.equal(c.retryable, true);
    assert.equal(c.category, 'timeout');
  });

  it('the reviewer’s hard-deadline exit (124) is retryable even with NO readable result', () => {
    // The watchdog force-exits, so no `_shadow` block is ever written — the
    // exit code is the only structured evidence that survives. Classifying on
    // the result alone would read this as an unreadable file and give up.
    const c = classifyArmAttempt(exited(HARD_DEADLINE_EXIT_CODE, 1_860_000), { error: 'unreadable result: ENOENT' });
    assert.equal(c.retryable, true);
    assert.equal(c.category, 'hard-deadline');
  });

  it('NEGATIVE CONTROL: a deterministic non-zero exit is NOT retryable', () => {
    // exit 1 is what a missing credential, an unknown provider and a campaign
    // -safety refusal all produce. Every one of them fails identically on a
    // second spawn, after burning another envelope's worth of provider time.
    for (const status of [1, 2, 127]) {
      const c = classifyArmAttempt(exited(status), null);
      assert.equal(c.retryable, false, `exit ${status} must fail fast`);
      assert.equal(c.category, 'spawn-failed');
    }
  });

  it('NEGATIVE CONTROL: a shadow error the classifier called PERMANENT is not retryable', () => {
    // A bad model id / 4xx / schema rejection reaches the same
    // `state:'error-unavailable'` block as a timeout; only the recorded
    // classification separates them.
    for (const category of ['http-404', 'http-400', 'permanent']) {
      const c = classifyArmAttempt(ok(), { ...timedOut(), shadowErrorCategory: category, shadowErrorRetryable: false });
      assert.equal(c.retryable, false, `${category} must fail fast`);
      assert.equal(c.category, category);
    }
  });

  it('NEGATIVE CONTROL: an UNCLASSIFIED failure is not retryable — absence is never permission', () => {
    // An artifact written by a reviewer predating the field, or an error path
    // that never classified. "We do not know" must fail closed, or a
    // deterministic failure gets retried by omission.
    const unclassified = { ...timedOut(), shadowErrorCategory: undefined, shadowErrorRetryable: undefined };
    assert.equal(classifyArmAttempt(ok(), unclassified).retryable, false);
    // And a truthy-but-not-true value must not sneak through a loose check.
    for (const bogus of ['true', 1, {}]) {
      assert.equal(classifyArmAttempt(ok(), { ...timedOut(), shadowErrorRetryable: bogus }).retryable, false,
        `${JSON.stringify(bogus)} is not the boolean true and must not authorise a re-spawn`);
    }
  });

  it('NEGATIVE CONTROL: a successful arm is never retried', () => {
    const c = classifyArmAttempt(ok(), ran());
    assert.equal(c.retryable, false);
    assert.equal(c.category, 'ran');
  });

  it('a SKIPPED shadow (no key, azure) is not retried — nothing transient about it', () => {
    const c = classifyArmAttempt(ok(), { shadowState: 'skipped-no-key', costUsd: null });
    assert.equal(c.retryable, false);
    assert.equal(c.category, 'skipped-no-key');
  });

  it('the retryable set agrees with classifyLlmError, the single oracle', () => {
    // What this pins is that the collector never invents its own opinion about
    // a category: whatever `classifyLlmError` says of an error, the recorded
    // verdict is what the collector acts on. Drive the real oracle, then feed
    // its own answer back through the collector's predicate.
    const cases = [
      [{ name: 'AbortError' }, true],
      [{ status: 429 }, true],
      [{ status: 503 }, true],
      [{ status: 404 }, false],
      [{ status: 400 }, false],
      [{ message: 'nope' }, false],
    ];
    for (const [err, expected] of cases) {
      const verdict = classifyLlmError(err);
      assert.equal(verdict.retryable, expected, `oracle changed its mind about ${JSON.stringify(err)}`);
      const c = classifyArmAttempt(ok(), {
        shadowState: 'error-unavailable', shadowErrorCategory: verdict.category, shadowErrorRetryable: verdict.retryable,
      });
      assert.equal(c.retryable, expected);
    }
  });
});

describe('runArmAttempts — bounded, visible, and only on transient failures', () => {
  /** Collect stderr lines instead of writing them. */
  const recorder = () => { const lines = []; return { lines, log: (m) => lines.push(m) }; };

  it('THE HEADLINE CASE: a timeout retries and succeeds on attempt 2', async () => {
    const { lines, log } = recorder();
    const outcomes = [timedOut(), ran()];
    let spawns = 0;
    const r = await runArmAttempts(ARM, CTX, {
      spawn: () => { spawns++; return ok(spawns === 1 ? 900_000 : 175_819); },
      readOutcome: () => outcomes.shift(),
      log,
    });
    assert.equal(spawns, 2, 'the timed-out attempt must be re-spawned');
    assert.equal(r.result.shadowState, 'ran');
    assert.equal(r.attempts, 2);
    assert.equal(r.supersededAttempts.length, 1);
    // The superseded attempt keeps its own evidence: how long it burned, why,
    // and that its cost is UNKNOWN rather than zero.
    assert.equal(r.supersededAttempts[0].elapsedMs, 900_000);
    assert.equal(r.supersededAttempts[0].errorCategory, 'timeout');
    assert.equal(r.supersededAttempts[0].costUsd, null);
    assert.deepEqual(r.supersededAttempts[0].unpricedModels, ['qwen3.8-max']);
    // Visible: the retry is announced with attempt number and elapsed time, and
    // the success says it was a retry — a retried arm must never be mistaken
    // for a first-try result.
    const all = lines.join('');
    assert.match(all, /attempt 1\/2 failed after 900\.0s \(timeout\)/);
    assert.match(all, /retrying automatically/);
    assert.match(all, /RETRIED, not a first-try result/);
  });

  it('NEGATIVE CONTROL: a deterministic failure is spawned exactly ONCE', async () => {
    // The load-bearing direction. A second spawn here buys nothing and costs a
    // full envelope; worse, it does so on every arm of every snapshot.
    for (const attempt1 of [
      { spawned: exited(1), result: null },
      { spawned: ok(), result: { ...timedOut(), shadowErrorCategory: 'http-404', shadowErrorRetryable: false } },
      { spawned: ok(), result: { error: 'unreadable result: Unexpected end of JSON input' } },
    ]) {
      let spawns = 0;
      const { lines, log } = recorder();
      const r = await runArmAttempts(ARM, CTX, {
        spawn: () => { spawns++; return attempt1.spawned; },
        readOutcome: () => attempt1.result,
        log,
      });
      assert.equal(spawns, 1, `retried a deterministic failure: ${JSON.stringify(attempt1.spawned)}`);
      assert.equal(r.attempts, 1);
      assert.deepEqual(r.supersededAttempts, []);
      assert.equal(lines.join('').includes('retrying automatically'), false);
    }
  });

  it('NEGATIVE CONTROL: a first-try success is spawned exactly ONCE', async () => {
    let spawns = 0;
    const r = await runArmAttempts(ARM, CTX, {
      spawn: () => { spawns++; return ok(175_819); },
      readOutcome: () => ran(),
      log: () => {},
    });
    assert.equal(spawns, 1);
    assert.deepEqual(r.supersededAttempts, [], 'a first-try success must record no retry history at all');
  });

  it('the attempt bound is respected — a permanently timing-out arm stops at ARM_MAX_ATTEMPTS', async () => {
    let spawns = 0;
    const { lines, log } = recorder();
    const r = await runArmAttempts(ARM, CTX, {
      spawn: () => { spawns++; return ok(900_000); },
      readOutcome: () => timedOut(),
      log,
    });
    assert.equal(spawns, ARM_MAX_ATTEMPTS, 'the loop must not be unbounded on a persistently transient failure');
    assert.equal(r.attempts, ARM_MAX_ATTEMPTS);
    assert.equal(r.supersededAttempts.length, ARM_MAX_ATTEMPTS - 1);
    assert.equal(r.result.shadowState, 'error-unavailable', 'the last failure is what the log records');
    // Exhausted must not read as "this arm is broken" — the operator's next
    // step is the human-invoked retry, and the line has to say so.
    assert.match(lines.join(''), /automatic retries EXHAUSTED; re-run the collector/);
  });

  it('the bound is READ from maxAttempts, not coincidentally equal to it', async () => {
    // Without this, the assertion above (`spawns === ARM_MAX_ATTEMPTS`) is
    // self-referential: it would hold for any constant, including one the loop
    // ignores. Driving a DIFFERENT bound proves the parameter is what stops it.
    let spawns = 0;
    await runArmAttempts(ARM, CTX, {
      spawn: () => { spawns++; return ok(900_000); },
      readOutcome: () => timedOut(),
      maxAttempts: 3,
      log: () => {},
    });
    assert.equal(spawns, 3);
  });

  it('the bound is 2 — sized from the measured recovery, not from symmetry', () => {
    // Every manual retry of a timed-out qwen arm succeeded on its FIRST
    // re-attempt. Raising this is a wall-clock decision (attempts x the 900s
    // ceiling), so it must be a deliberate edit with a measurement behind it.
    assert.equal(ARM_MAX_ATTEMPTS, 2);
  });

  it('mints ONE cloud run per ATTEMPT, never one shared across retries', async () => {
    // Two attempts sharing an `audit_runs` row would persist the PRIMARY
    // reviewer's findings into it twice — the store would then carry a doubled
    // review nobody ran.
    const minted = [];
    let spawns = 0;
    const outcomes = [timedOut(), ran()];
    const r = await runArmAttempts(ARM, CTX, {
      spawn: () => { spawns++; return ok(); },
      readOutcome: () => outcomes.shift(),
      beforeAttempt: async (n) => { minted.push(n); return `run-${n}`; },
      log: () => {},
    });
    assert.deepEqual(minted, [1, 2]);
    assert.equal(r.runId, 'run-2', 'the live result must carry the LAST attempt’s run id');
    assert.equal(r.supersededAttempts[0].runId, 'run-1', 'the superseded attempt keeps its own row id');
  });

  it('threads the attempt’s run id into the spawn — a blank one writes nowhere', async () => {
    const seen = [];
    const outcomes = [timedOut(), ran()];
    await runArmAttempts(ARM, CTX, {
      spawn: (_arm, ctx) => { seen.push(ctx.runId); return ok(); },
      readOutcome: () => outcomes.shift(),
      beforeAttempt: async (n) => `run-${n}`,
      log: () => {},
    });
    assert.deepEqual(seen, ['run-1', 'run-2']);
  });
});

describe('mergeRetryHistory — a human-invoked retry does not erase the attempt it replaces', () => {
  // readLog() keeps only the newest entry per snapshotId, so without this the
  // prior failed attempt vanishes from the log entirely — and with it the
  // evidence that it happened and was billed.
  it('folds the prior failed record in as a superseded attempt', () => {
    const prior = { qwen: { runId: 'run-1', costUsd: null, shadowState: 'error-unavailable', shadowErrorCategory: 'timeout', shadowError: 'Timeout after 900s', unpricedModels: ['qwen3.8-max'] } };
    const merged = mergeRetryHistory({ qwen: { runId: 'run-2', ...ran() } }, prior);
    assert.equal(merged.qwen.supersededAttempts.length, 1);
    assert.equal(merged.qwen.supersededAttempts[0].runId, 'run-1');
    assert.equal(merged.qwen.supersededAttempts[0].costUsd, null, 'unknown, never $0');
    assert.equal(merged.qwen.shadowState, 'ran', 'the new result stays live');
  });

  it('numbering stays continuous across invocations — a third attempt does not amnesty the first', () => {
    const prior = { qwen: { runId: 'run-2', supersededAttempts: [{ attempt: 1, runId: 'run-1', costUsd: null }], costUsd: null, shadowErrorCategory: 'timeout' } };
    const fresh = { qwen: { runId: 'run-4', ...ran(), supersededAttempts: [{ attempt: 1, runId: 'run-3', costUsd: null, errorCategory: 'timeout' }] } };
    const merged = mergeRetryHistory(fresh, prior);
    assert.deepEqual(merged.qwen.supersededAttempts.map((a) => a.attempt), [1, 2, 3]);
    assert.deepEqual(merged.qwen.supersededAttempts.map((a) => a.runId), ['run-1', 'run-2', 'run-3']);
  });

  it('NEGATIVE CONTROL: an arm with no prior record gains no fabricated history', () => {
    const merged = mergeRetryHistory({ qwen: ran() }, { opus: ran() });
    assert.equal(merged.qwen.supersededAttempts, undefined,
      'inventing an attempt that never happened would over-report spend, the mirror of under-reporting it');
  });
});
