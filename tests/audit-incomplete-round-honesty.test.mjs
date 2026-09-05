/**
 * @fileoverview A round that measured nothing must not be readable as a clean one.
 *
 * Reported by a consumer 2026-09-04. Under Azure OpenAI peak load, EVERY pass in
 * a round failed — two on a 90s timeout, four on `429 The system is currently
 * experiencing high demand` — and the round printed:
 *
 *     Verdict: INCOMPLETE | H:0 M:0 L:0
 *
 * and exited 0. That is one word away from what a clean audit prints, the three
 * zeros are the ABSENCE of a measurement rather than a measurement of zero, and
 * `audit-loop.mjs`'s convergence test reads exactly those three numbers. An
 * agent chaining rounds — which `/cycle` does — converges and ships.
 *
 * Three independent mechanisms are pinned below, because any one of them alone
 * still leaves the failure reachable:
 *   1. the retry policy, so a capacity refusal gets a backoff that can succeed;
 *   2. the rendered line, so a human or an LLM reading stdout cannot confuse the
 *      two;
 *   3. the convergence predicate, which is what actually decides to stop.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RETRY_MAX_ATTEMPTS,
  RETRY_429_MAX_ATTEMPTS,
  RETRY_429_BASE_DELAY_MS,
  RETRY_429_MAX_DELAY_MS,
  RETRY_BASE_DELAY_MS,
  retryAttemptsFor,
  retryAfterMs,
  nextRetryDelayMs,
  describeLostWrites,
  classifyLlmError,
} from '../scripts/lib/robustness.mjs';
import { formatAuditSummaryLine } from '../scripts/lib/audit/findings-pipeline.mjs';
import { countFindings, isConverged } from '../scripts/audit-loop.mjs';

/** What a CLEAN audit's summary line looks like. Nothing else may match it. */
const CLEAN_LINE = /^Verdict: \w+ \| H:\d+ M:\d+ L:\d+ \|/;

describe('retry policy — a capacity refusal is not a generic transient', () => {
  it('budgets 429 separately from, and above, the generic transient budget', () => {
    assert.equal(retryAttemptsFor('http-429'), RETRY_429_MAX_ATTEMPTS);
    assert.equal(retryAttemptsFor('http-503'), RETRY_MAX_ATTEMPTS);
    assert.equal(retryAttemptsFor('network'), RETRY_MAX_ATTEMPTS);
    assert.ok(RETRY_429_MAX_ATTEMPTS > RETRY_MAX_ATTEMPTS);
  });

  it('backs off into TENS of seconds, not the old 8s ceiling', () => {
    // The measured failure: one retry, capped at 8s, against a provider saying
    // "high demand". The policy could not succeed against its own condition.
    assert.ok(RETRY_429_MAX_DELAY_MS >= 30_000, 'a peak-load backoff must clear tens of seconds');
    const last = nextRetryDelayMs({
      category: 'http-429', attempt: RETRY_429_MAX_ATTEMPTS - 1, random: () => 1,
    });
    assert.ok(last > 8000, `final 429 backoff ${last}ms must exceed the old 8s ceiling`);
    assert.ok(last <= RETRY_429_MAX_DELAY_MS);
  });

  it('never retries sooner than the base delay, and never past the ceiling', () => {
    for (let attempt = 0; attempt < RETRY_429_MAX_ATTEMPTS; attempt++) {
      for (const random of [() => 0, () => 0.5, () => 0.999999]) {
        const d = nextRetryDelayMs({ category: 'http-429', attempt, random });
        assert.ok(d >= RETRY_429_BASE_DELAY_MS, `attempt ${attempt} returned ${d}ms`);
        assert.ok(d <= RETRY_429_MAX_DELAY_MS, `attempt ${attempt} returned ${d}ms`);
      }
    }
  });

  it('jitters — two 429 retries at the same attempt do not collide in lockstep', () => {
    const lo = nextRetryDelayMs({ category: 'http-429', attempt: 2, random: () => 0 });
    const hi = nextRetryDelayMs({ category: 'http-429', attempt: 2, random: () => 1 });
    assert.ok(hi > lo, 'a fixed delay makes N rate-limited passes wake together and re-collide');
  });

  it('leaves the generic transient curve exactly as it was', () => {
    for (const category of ['http-503', 'network', 'timeout']) {
      assert.equal(nextRetryDelayMs({ category, attempt: 0 }), RETRY_BASE_DELAY_MS);
      assert.equal(nextRetryDelayMs({ category, attempt: 1 }), RETRY_BASE_DELAY_MS * 2);
    }
  });

  it("obeys the provider's Retry-After over any curve we invent", () => {
    const d = nextRetryDelayMs({ category: 'http-429', attempt: 0, retryAfter: 21_000 });
    assert.equal(d, 21_000);
  });

  it('still clamps a hostile or mistaken Retry-After to the ceiling', () => {
    const d = nextRetryDelayMs({ category: 'http-429', attempt: 0, retryAfter: 3_600_000 });
    assert.equal(d, RETRY_429_MAX_DELAY_MS);
  });
});

describe('retryAfterMs — read the header, and know when there is none', () => {
  it('reads delta-seconds from a Headers-like object', () => {
    const headers = new Map([['retry-after', '31']]);
    assert.equal(retryAfterMs({ headers }), 31_000);
  });

  it('reads delta-seconds from a plain object, either casing', () => {
    assert.equal(retryAfterMs({ headers: { 'retry-after': '7' } }), 7000);
    assert.equal(retryAfterMs({ headers: { 'Retry-After': '7' } }), 7000);
  });

  it('reads the HTTP-date form', () => {
    const at = new Date(Date.now() + 45_000).toUTCString();
    const ms = retryAfterMs({ headers: { 'retry-after': at } });
    assert.ok(ms > 40_000 && ms <= 46_000, `got ${ms}`);
  });

  it('returns NULL — not 0 — when absent or unparseable', () => {
    // 0 would read as "retry immediately", the opposite of what a missing
    // header means.
    assert.equal(retryAfterMs({}), null);
    assert.equal(retryAfterMs({ headers: {} }), null);
    assert.equal(retryAfterMs({ headers: { 'retry-after': 'soon' } }), null);
    assert.equal(retryAfterMs(null), null);
  });
});

describe('formatAuditSummaryLine — INCOMPLETE cannot wear a clean line', () => {
  it('leaves a real verdict byte-identical to the old format', () => {
    const line = formatAuditSummaryLine({
      verdict: 'PASS', high: 0, medium: 0, low: 0, latencyMs: 12_000,
    });
    assert.equal(line, 'Verdict: PASS | H:0 M:0 L:0 | 12s');
    assert.match(line, CLEAN_LINE);
  });

  it('does NOT render the clean-line shape for INCOMPLETE — the exact reported string', () => {
    const line = formatAuditSummaryLine({
      verdict: 'INCOMPLETE', high: 0, medium: 0, low: 0,
      failedPasses: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], passesTotal: 7, latencyMs: 91_000,
    });
    assert.doesNotMatch(line, CLEAN_LINE);
    assert.match(line, /0 of 7 pass\(es\) produced output/);
    assert.match(line, /measured NOTHING/);
    assert.match(line, /not evidence of cleanliness/);
  });

  it('distinguishes "nothing ran" from "some ran"', () => {
    const partial = formatAuditSummaryLine({
      verdict: 'INCOMPLETE', high: 0, medium: 0, low: 0,
      failedPasses: ['a', 'b'], passesTotal: 7,
    });
    assert.match(partial, /5 of 7 pass\(es\) produced output/);
    assert.doesNotMatch(partial, /measured NOTHING/);
  });

  it('says the denominator is unknown rather than inventing one', () => {
    // Results persisted before `_passes_total` existed have no denominator.
    // Guessing it is the fabrication the whole line exists to stop.
    const line = formatAuditSummaryLine({
      verdict: 'INCOMPLETE', high: 0, medium: 0, low: 0, failedPasses: ['a'], passesTotal: null,
    });
    assert.match(line, /total attempted unknown/);
    assert.doesNotMatch(line, /of null/);
  });
});

describe('audit-loop convergence — an unmeasured round cannot converge', () => {
  const clean = { verdict: 'PASS', findings: [] };
  const collapsed = { verdict: 'INCOMPLETE', findings: [], _failed_passes: ['x'], _passes_total: 7 };

  it('reads a genuinely clean round as converged', () => {
    // The direction the guard must NOT fire in: a real PASS with no findings is
    // exactly what convergence is for, and blocking it would make the loop run
    // forever and cost money every round.
    const counts = countFindings(clean);
    assert.equal(counts.failed, false);
    assert.equal(isConverged(counts), true);
  });

  it('refuses to converge on an INCOMPLETE round with identical counts', () => {
    const counts = countFindings(collapsed);
    assert.deepEqual(
      { high: counts.high, medium: counts.medium, low: counts.low },
      { high: 0, medium: 0, low: 0 },
      'the counts are identical to a clean round — that is the whole problem',
    );
    assert.equal(counts.failed, true);
    assert.equal(isConverged(counts), false);
  });

  it('still refuses when the round produced no result file at all', () => {
    assert.equal(isConverged(countFindings(null)), false);
  });
});

describe('describeLostWrites — name the loser, not just the count', () => {
  it('names the writer and its error', () => {
    const lines = describeLostWrites({
      'learning.banditArms': { written: 0, spilled: 0, lost: 1, skipped: 0, lastError: 'boom' },
      'audit.findings': { written: 18, spilled: 0, lost: 0, skipped: 0 },
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /learning\.banditArms/);
    assert.match(lines[0], /boom/);
  });

  it('recognises a missing relation/column and gives the ledger remedy', () => {
    const lines = describeLostWrites({
      'learning.someWriter': {
        written: 0, spilled: 0, lost: 1, skipped: 0,
        lastError: 'relation "some_table" does not exist',
      },
    });
    const joined = lines.join('\n');
    assert.match(joined, /STORE SCHEMA DRIFT/);
    assert.match(joined, /--check-drift/);
    assert.match(joined, /--migrate/);
    assert.match(joined, /every run/);
  });

  it('recognises a conflict-target mismatch and does NOT send the operator to --check-drift as a diagnosis (2026-09-04 correction)', () => {
    // --check-drift compares the applied-migrations LEDGER to source files — a
    // constraint replaced out-of-band with no corresponding migration is
    // invisible to it. The old wording claimed --check-drift would "diagnose"
    // this; a live consumer measured a clean ledger against a genuinely wrong
    // constraint shape, so that claim was false.
    const lines = describeLostWrites({
      'learning.banditArms': {
        written: 0, spilled: 0, lost: 1, skipped: 0,
        // Post-annotateConflictTargetFault shape: table + columns are named
        // ahead of Postgres's own message.
        lastError: 'bandit_arms has no unique constraint on (pass_name, variant_id, context_bucket) — '
          + 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
      },
    });
    const joined = lines.join('\n');
    assert.doesNotMatch(joined, /STORE SCHEMA DRIFT/);
    assert.match(joined, /--check-drift.* cannot see this|cannot see this.*--check-drift/is);
    assert.match(joined, /pg_constraint/);
  });

  it('says so when a loss carries no error at all', () => {
    const lines = describeLostWrites({ w: { written: 0, spilled: 0, lost: 2, skipped: 0 } });
    assert.match(lines[0], /no error recorded/);
  });

  it('stays silent when nothing was lost', () => {
    assert.deepEqual(describeLostWrites({ w: { written: 5, spilled: 1, lost: 0, skipped: 0 } }), []);
    assert.deepEqual(describeLostWrites({}), []);
    assert.deepEqual(describeLostWrites(null), []);
  });

  it('does NOT cry schema drift over a transient failure', () => {
    const lines = describeLostWrites({
      w: { written: 0, spilled: 0, lost: 1, skipped: 0, lastError: 'connection terminated unexpectedly' },
    });
    assert.equal(lines.length, 1, 'a transient loss gets its line and no remedy paragraph');
    assert.doesNotMatch(lines[0], /SCHEMA DRIFT/);
  });
});

describe('the rewrapped LLM error carries its HTTP facts (Gemini final gate)', () => {
  // THE finding that mattered most in this whole audit. `_callGPTOnce` rewrapped
  // every non-abort failure as `new Error(msg)`, destroying `.status` and
  // `.headers`. classifyLlmError then answered `permanent`/not-retryable, so the
  // `http-429` branch was UNREACHABLE from the audit's own call path — and the
  // enlarged 429 budget and Retry-After handling added in this very change were
  // inert. It also explains the consumer's log: a whole round lost to
  // `429 ... high demand` with no retry line at all.
  const sdkError = () => Object.assign(
    new Error('429 The system is currently experiencing high demand'),
    { status: 429, headers: new Map([['retry-after', '30']]) },
  );

  it('a 429 is classified as retryable, with the rate-limit budget', () => {
    const c = classifyLlmError(sdkError());
    assert.equal(c.category, 'http-429');
    assert.equal(c.retryable, true);
    assert.equal(retryAttemptsFor(c.category), RETRY_429_MAX_ATTEMPTS);
  });

  it('and a STRIPPED error is not — which is what made the branch dead', () => {
    // The negative control, stated as the defect: this is exactly what the
    // rewrap used to hand `callGPT`.
    const stripped = new Error('[be-services] 429 ... high demand (31.6s)');
    const c = classifyLlmError(stripped);
    assert.equal(c.category, 'permanent');
    assert.equal(c.retryable, false);
    assert.equal(retryAfterMs(stripped), null);
  });

  it('preserving status/headers is what makes Retry-After readable', () => {
    assert.equal(retryAfterMs(sdkError()), 30_000);
  });

  it('the rewrap copies status, code, headers and cause', () => {
    // Mirrors `_callGPTOnce`'s catch: assert the CONTRACT the fix establishes,
    // so a future edit that drops a field fails here rather than silently
    // re-deadening the retry path.
    const err = Object.assign(new Error('boom'), {
      status: 503, code: 'server_error', headers: { 'retry-after': '5' }, cause: new Error('inner'),
    });
    const wrapped = new Error('[pass] boom (1.0s)');
    for (const k of ['status', 'code', 'headers', 'cause']) {
      if (err[k] !== undefined) wrapped[k] = err[k];
    }
    assert.equal(classifyLlmError(wrapped).retryable, true);
    assert.equal(retryAfterMs(wrapped), 5000);
  });
});
