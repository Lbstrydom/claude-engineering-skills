/**
 * @fileoverview First dedicated test file for ossStructuredCall's retry/
 * timeout/heartbeat behavior (docs/plans/oss-call-reliability-hardening.md).
 * No dedicated coverage existed before this plan — only incidental
 * egress-gate coverage in tests/model-ab-egress.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { ossStructuredCall } from '../scripts/lib/oss-structured-output.mjs';

const SCHEMA = z.object({ ok: z.boolean() });

/**
 * A deterministic, non-wall-clock scheduler (audit-code round-1 M8): records
 * the REQUESTED delay for assertions, but fires `setTimeout` callbacks on the
 * next tick (via `setImmediate`) instead of actually waiting `ms` real
 * milliseconds — so retry-delay/backoff tests complete instantly rather than
 * genuinely sleeping through production backoff durations. `setInterval`
 * never fires on its own (the heartbeat is a pure side-channel log signal;
 * no test in this file depends on an interval tick to make progress) — tests
 * that specifically need to observe a heartbeat firing pass their own
 * scheduler with an immediately-invoking `setInterval` (see the
 * "legacy heartbeat label" describe block below).
 */
function fakeScheduler() {
  const calls = { setTimeout: [], clearTimeout: 0, setInterval: [], clearInterval: 0 };
  return {
    calls,
    scheduler: {
      setTimeout: (fn, ms) => { calls.setTimeout.push(ms); return setImmediate(fn); },
      clearTimeout: (t) => { calls.clearTimeout++; clearImmediate(t); },
      setInterval: (fn, ms) => { calls.setInterval.push(ms); return null; }, // never fires — pure recording
      clearInterval: (t) => { calls.clearInterval++; },
    },
  };
}

function successClient(payload = { ok: true }) {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } } };
}

function alwaysFailClient(errFactory) {
  return { chat: { completions: { create: async () => { throw errFactory(); } } } };
}

describe('ossStructuredCall — heartbeat timer lifecycle (round-1 M4, round-2/3 M2)', () => {
  it('sets and clears both the abort timer and the heartbeat interval on success', async () => {
    const { scheduler, calls } = fakeScheduler();
    await ossStructuredCall(successClient(), { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', scheduler });
    assert.equal(calls.setTimeout.length, 1);
    assert.equal(calls.setInterval.length, 1);
    assert.equal(calls.clearTimeout, 1);
    assert.equal(calls.clearInterval, 1);
  });

  it('clears both timers on a non-retryable failure too (finally block covers every exit path)', async () => {
    const { scheduler, calls } = fakeScheduler();
    const client = alwaysFailClient(() => { const e = new Error('bad request'); e.status = 400; return e; });
    await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', scheduler });
    assert.equal(calls.clearTimeout, 1);
    assert.equal(calls.clearInterval, 1);
  });

  it('clears both timers on EACH attempt across a retry (2 attempts = 2 abort timers + 2 heartbeats, each cleared once)', async () => {
    const { scheduler, calls } = fakeScheduler();
    const client = alwaysFailClient(() => { const e = new Error('timeout'); e.name = 'AbortError'; return e; });
    await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', operation: 'stage1_triage', scheduler });
    // setTimeout.length also includes the interleaved retry-delay call (round-3
    // M2 unified it onto the same scheduler) — clearTimeout/clearInterval counts
    // are the ones that map 1:1 to per-attempt abort-timer/heartbeat pairs,
    // since the retry-delay timer is never explicitly cleared (it just fires).
    assert.equal(calls.setInterval.length, 2, 'one heartbeat interval per attempt');
    assert.equal(calls.clearTimeout, 2, 'one abort-timer clear per attempt');
    assert.equal(calls.clearInterval, 2, 'one heartbeat-interval clear per attempt');
  });

  it('the heartbeat interval never fires on a fast call (no spurious log noise)', async () => {
    // Proves the CALLBACK never runs before the attempt resolves, using the
    // real scheduler (a fast call resolves and clears the interval well
    // before its first real 15s tick) and checking no heartbeat log fired.
    const realScheduler = { setTimeout, clearTimeout, setInterval, clearInterval };
    let stderrCalls = 0;
    const origWrite = process.stderr.write;
    process.stderr.write = (s) => { if (s.includes('heartbeat')) stderrCalls++; return true; };
    try {
      await ossStructuredCall(successClient(), { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', scheduler: realScheduler });
    } finally {
      process.stderr.write = origWrite;
    }
    assert.equal(stderrCalls, 0, 'a fast call must never log a heartbeat record');
  });
});

describe('ossStructuredCall — the abort timer genuinely aborts the real AbortSignal (audit-code round-1 M4)', () => {
  // The other tests in this file simulate a provider-thrown AbortError to
  // exercise the classification/retry PATH, but never prove the configured
  // abort-timer callback actually fires `controller.abort()` on the REAL
  // AbortSignal the request receives. This test uses the real scheduler
  // (native setTimeout) with a genuinely short timeoutMs, and a client that
  // only resolves when its signal aborts — proving the wiring end-to-end,
  // not just the classification branch.
  it('a request that never resolves on its own is genuinely aborted when timeoutMs elapses', async () => {
    let observedAborted = false;
    const client = {
      chat: {
        completions: {
          create: (params, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              observedAborted = true;
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
            // Deliberately never resolves/rejects on its own — the ONLY way
            // this promise settles is via the real AbortController firing.
          }),
        },
      },
    };
    const res = await ossStructuredCall(client, {
      model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x',
      timeoutMs: 30, maxRetries: 0, // real, short — no fake scheduler here
    });
    assert.equal(observedAborted, true, 'the AbortController must genuinely fire abort() when the real timer elapses');
    assert.equal(res.failed, true);
    assert.equal(res.category, 'timeout');
  });
});

describe('ossStructuredCall — legacy heartbeat label (round-2 L1)', () => {
  it('uses the canonical legacy_default operation label when operation is omitted', async () => {
    const heartbeatLogs = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (s) => { if (s.includes('heartbeat')) heartbeatLogs.push(s); return true; };
    // Force a heartbeat to actually fire by using a slow client + short interval override via real timers.
    const slowClient = { chat: { completions: { create: () => new Promise((resolve) => setTimeout(() => resolve({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), 30)) } } };
    try {
      // Can't easily force the real 15s interval to fire in a fast unit test —
      // assert on the label logic directly via a scheduler that invokes the
      // interval callback immediately.
      const scheduler = {
        setTimeout, clearTimeout,
        setInterval: (fn) => { fn(); return setInterval(() => {}, 999999); },
        clearInterval,
      };
      await ossStructuredCall(slowClient, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', scheduler });
    } finally {
      process.stderr.write = origWrite;
    }
    assert.ok(heartbeatLogs.length >= 1, 'expected at least one heartbeat record');
    assert.ok(heartbeatLogs[0].includes('"operation":"legacy_default"'), heartbeatLogs[0]);
  });
});

describe('ossStructuredCall — category contract (round-1 M3)', () => {
  it('success never carries a category field (byte-identical for no-operation callers)', async () => {
    const res = await ossStructuredCall(successClient(), { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x' });
    assert.equal('category' in res, false);
  });

  it('a classifyLlmError-routed failure carries category, never null', async () => {
    // audit-code round-3 L1: pin maxRetries:0 + the deterministic fake
    // scheduler so this test asserts the category invariant only, without
    // depending on real retry/timer execution (a single attempt is enough
    // to reach a classified failure).
    const { scheduler } = fakeScheduler();
    const client = alwaysFailClient(() => { const e = new Error('timeout'); e.name = 'AbortError'; return e; });
    const res = await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', operation: 'discovery_generation', maxRetries: 0, scheduler });
    assert.equal(res.failed, true);
    assert.equal(res.category, 'timeout');
  });

  it('non-classified early-return failures (schema derivation) never gain a category key', async () => {
    // Force a schema-derivation failure via an un-representable Zod-like construct.
    const throwingSchema = new Proxy({}, { get() { throw new Error('cannot derive'); } });
    const res = await ossStructuredCall(successClient(), { model: 'm', system: 's', userPrompt: 'u', schema: throwingSchema, schemaName: 'x' });
    assert.equal(res.failed, true);
    assert.equal('category' in res, false, 'schema-derivation failure must not fabricate a category');
  });

  it('truncated output is a conformance miss with no category (not classifyLlmError-routed)', async () => {
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } } };
    const res = await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x' });
    assert.equal(res.error, 'output truncated (max_tokens)');
    assert.equal('category' in res, false);
  });
});

describe('ossStructuredCall — backward-compatible no-operation default (regression guard for 3 dormant callers)', () => {
  it('omitted operation success shape is unaffected', async () => {
    const res = await ossStructuredCall(successClient({ ok: true }), { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x' });
    assert.deepEqual(Object.keys(res).sort(), ['conformant', 'error', 'failed', 'latencyMs', 'mode', 'requestedReasoningEffort', 'result', 'usage'].sort());
  });

  it('omitted operation failure shape gains category (explicit value asserted, round-1 L4), and every other field is byte-identical to the pre-plan shape', async () => {
    const client = alwaysFailClient(() => { const e = new Error('boom'); e.status = 400; return e; });
    const res = await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x' });
    assert.equal(res.failed, true);
    assert.equal(res.error, 'HTTP 400: boom');
    // round-1 L4: the ORIGINAL version of this test only checked failed/error —
    // it would have passed even if category were absent, null, or wrong.
    // Assert the actual classified value, and pin the complete field set.
    assert.equal(res.category, 'http-400', 'a plain 4xx must classify to a named category, not be silently dropped');
    assert.deepEqual(
      Object.keys(res).sort(),
      ['category', 'conformant', 'error', 'failed', 'latencyMs', 'mode', 'requestedReasoningEffort', 'result', 'usage'].sort(),
      'the ONLY difference from the success shape must be the added category key — no other field may regress',
    );
  });
});

describe('ossStructuredCall — behavioral proof, not resolver-only (round-1 M5)', () => {
  // `calls.setTimeout` captures BOTH abort-timer AND retry-delay calls (round-3
  // M2 unified them onto the same injected scheduler) — filter to the abort-
  // timer values (equal to the effective timeoutMs) to count real attempts,
  // independent of the interleaved backoff delays.
  function abortTimerCalls(calls, timeoutMs) {
    return calls.setTimeout.filter((ms) => ms === timeoutMs);
  }

  it('stage1_triage: effective timeout is 45s and total attempts is 2 (1 retry)', async () => {
    const { scheduler, calls } = fakeScheduler();
    const client = alwaysFailClient(() => { const e = new Error('t'); e.name = 'AbortError'; return e; });
    await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', operation: 'stage1_triage', scheduler });
    assert.equal(abortTimerCalls(calls, 45000).length, 2);
    // Interleaved retry-delay call (round-3 M2: same injected scheduler) — 800ms per Execution Model.
    assert.deepEqual(calls.setTimeout, [45000, 800, 45000]);
  });

  it('discovery_generation: effective timeout is 120s and total attempts is 2 (1 retry)', async () => {
    const { scheduler, calls } = fakeScheduler();
    const client = alwaysFailClient(() => { const e = new Error('t'); e.name = 'AbortError'; return e; });
    await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', operation: 'discovery_generation', scheduler });
    assert.equal(abortTimerCalls(calls, 120000).length, 2);
    assert.deepEqual(calls.setTimeout, [120000, 800, 120000]);
  });

  it('omitted operation: effective timeout is 300s (legacy) and total attempts is 3 (2 retries)', async () => {
    const { scheduler, calls } = fakeScheduler();
    const client = alwaysFailClient(() => { const e = new Error('t'); e.name = 'AbortError'; return e; });
    await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', scheduler });
    assert.equal(abortTimerCalls(calls, 300000).length, 3);
    // Backoff grows per attempt: 800*(1), then 800*(2).
    assert.deepEqual(calls.setTimeout, [300000, 800, 300000, 1600, 300000]);
  });

  it('explicit opts.timeoutMs/maxRetries win over the resolved policy', async () => {
    const { scheduler, calls } = fakeScheduler();
    const client = alwaysFailClient(() => { const e = new Error('t'); e.name = 'AbortError'; return e; });
    await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', operation: 'stage1_triage', timeoutMs: 5000, maxRetries: 0, scheduler });
    assert.deepEqual(calls.setTimeout, [5000]);
  });
});

describe('ossStructuredCall — retry-delay via the injected scheduler (round-3 M2)', () => {
  it('the retry-delay setTimeout goes through the SAME injected scheduler, not a bare global', async () => {
    const delays = [];
    const scheduler = {
      setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, ms); },
      clearTimeout,
      setInterval, clearInterval,
    };
    const client = alwaysFailClient(() => { const e = new Error('t'); e.name = 'AbortError'; return e; });
    await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x', operation: 'stage1_triage', scheduler });
    // Two abort-timer setTimeouts (45000, 45000) + one retry-delay setTimeout (800).
    assert.deepEqual(delays, [45000, 800, 45000]);
  });
});

// 2026-07-15: live-verified against the real OpenRouter API (not just this
// mock) that GLM-5.2 is proxied across 27 heterogeneous backends, at least
// one of which wraps a valid json_schema-mode reply in a markdown fence —
// extractRawJson previously handed that straight to JSON.parse, hard-failing
// as "reply was not valid JSON" and discarding an otherwise-good response.
// Also confirmed pinning OpenRouter to a single "trusted" backend (even the
// model's own official one) is NOT the fix — Z.AI's own endpoint returned
// 404 for json_schema mode entirely; unpinned routing correctly avoids it.
// The fence-tolerant parse below is the actual fix.
function fencedClient(payload, fenceLang = 'json') {
  const body = fenceLang === null
    ? '```\n' + JSON.stringify(payload) + '\n```'
    : `\`\`\`${fenceLang}\n${JSON.stringify(payload)}\n\`\`\``;
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content: body }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } } };
}

describe('ossStructuredCall — markdown-fence-tolerant JSON parsing (2026-07-15 GLM fence incident)', () => {
  it('parses a reply wrapped in ```json ... ``` (the exact incident shape)', async () => {
    const result = await ossStructuredCall(fencedClient({ ok: true }), {
      model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x',
    });
    assert.equal(result.conformant, true);
    assert.deepEqual(result.result, { ok: true });
  });

  it('parses a reply wrapped in a bare ``` fence (no language tag)', async () => {
    const result = await ossStructuredCall(fencedClient({ ok: false }, null), {
      model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x',
    });
    assert.equal(result.conformant, true);
    assert.deepEqual(result.result, { ok: false });
  });

  it('unfenced replies are unaffected (regression guard — the common case)', async () => {
    const result = await ossStructuredCall(successClient({ ok: true }), {
      model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x',
    });
    assert.equal(result.conformant, true);
    assert.deepEqual(result.result, { ok: true });
  });

  it('a genuinely malformed reply still fails — fence-stripping does not mask real errors', async () => {
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'not json at all, no fence either' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } } };
    const result = await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x' });
    assert.equal(result.conformant, false);
    assert.equal(result.error, 'reply was not valid JSON');
  });

  it('a fence-like substring inside actual prose (unanchored, not wrapping the whole reply) is not stripped', async () => {
    // The regex is start/end-anchored — text like "see ```json``` for an
    // example" embedded in non-JSON prose must NOT be treated as a fence
    // wrapper; it should still fail as malformed, not silently mis-parse.
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'Note: ```json``` is the format. {"ok": true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } } };
    const result = await ossStructuredCall(client, { model: 'm', system: 's', userPrompt: 'u', schema: SCHEMA, schemaName: 'x' });
    assert.equal(result.conformant, false);
    assert.equal(result.error, 'reply was not valid JSON');
  });
});

// ── providerPreferences passthrough (experiment-4 gate-1 availability screen) ──
// Every GLM measurement to date was taken against OpenRouter's unfiltered
// ~26-host fleet (fp8/fp4/undisclosed quantizations). Pinning via the
// request body's `provider` field is the control that separates
// model-vs-router — and dormant callers must stay byte-identical.
describe('ossStructuredCall — providerPreferences passthrough (experiment-4 gate 1)', () => {
  const capture = () => {
    const seen = [];
    const client = { chat: { completions: { create: async (params) => {
      seen.push(params);
      return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } } } };
    return { client, seen };
  };
  const okSchema = z.object({ ok: z.boolean() });

  it('sends provider preferences verbatim when given', async () => {
    const { client, seen } = capture();
    const prefs = { order: ['z-ai'], quantizations: ['fp8'], require_parameters: true, allow_fallbacks: false };
    const r = await ossStructuredCall(client, {
      model: 'z-ai/glm-5.2', system: 's', userPrompt: 'u',
      schema: okSchema, schemaName: 'ok', providerPreferences: prefs,
    });
    assert.equal(r.conformant, true);
    assert.deepEqual(seen[0].provider, prefs);
  });

  it('omits the provider field entirely when not given — dormant callers stay byte-identical', async () => {
    const { client, seen } = capture();
    await ossStructuredCall(client, {
      model: 'z-ai/glm-5.2', system: 's', userPrompt: 'u',
      schema: okSchema, schemaName: 'ok',
    });
    assert.equal('provider' in seen[0], false, 'no provider field may appear without an explicit opt-in');
  });

  it('null is treated as absent, not sent as a literal null', async () => {
    const { client, seen } = capture();
    await ossStructuredCall(client, {
      model: 'm', system: 's', userPrompt: 'u',
      schema: okSchema, schemaName: 'ok', providerPreferences: null,
    });
    assert.equal('provider' in seen[0], false);
  });
});

// ── responseSchema — decoupling provider-guidance from response validation ──
// (2026-07-22, tiered-recall batch-abort hardening, systematic follow-up to
// the Stage-1 clamp fix). A batch/array response validated against a schema
// requiring every element to conform (e.g. `z.array(itemSchema)`) fails
// ALL-OR-NOTHING: one malformed element destroys every other valid element in
// the same response. `responseSchema` lets a caller decouple "what shape do
// we ask the provider to produce" (still `schema`) from "how strictly do we
// validate what came back" — so a caller with its own authoritative
// per-element validator downstream can opt into lenient envelope-only
// validation here.
describe('ossStructuredCall — responseSchema (decoupled validation, batch-abort hardening)', () => {
  const itemSchema = z.object({ id: z.string(), severity: z.enum(['HIGH', 'MEDIUM', 'LOW']) });
  const strictSchema = z.object({ findings: z.array(itemSchema).max(15) });
  const lenientResponseSchema = z.object({ findings: z.array(z.unknown()).max(15) });

  it('a response with one malformed element among several good ones is REJECTED under the strict schema alone (regression baseline — proves the bug exists without the fix)', async () => {
    const payload = { findings: [
      { id: 'a', severity: 'HIGH' },
      { id: 'b', severity: 'NOT_A_REAL_SEVERITY' }, // malformed: invalid enum
      { id: 'c', severity: 'LOW' },
    ] };
    const client = successClient(payload);
    const res = await ossStructuredCall(client, {
      model: 'm', system: 's', userPrompt: 'u', schema: strictSchema, schemaName: 'x',
    });
    assert.equal(res.conformant, false, 'array validation is all-or-nothing — this is the bug this feature exists to route around');
    assert.equal(res.result, null);
  });

  it('the SAME response with a lenient responseSchema survives — all elements returned raw, none silently dropped', async () => {
    const payload = { findings: [
      { id: 'a', severity: 'HIGH' },
      { id: 'b', severity: 'NOT_A_REAL_SEVERITY' },
      { id: 'c', severity: 'LOW' },
    ] };
    const client = successClient(payload);
    const res = await ossStructuredCall(client, {
      model: 'm', system: 's', userPrompt: 'u', schema: strictSchema, schemaName: 'x',
      responseSchema: lenientResponseSchema,
    });
    assert.equal(res.conformant, true, 'one malformed element must not fail the whole batch when a lenient responseSchema is supplied');
    assert.equal(res.result.findings.length, 3, 'every element — good AND malformed — passes through raw; per-item validation is the CALLER\'s job downstream');
    assert.deepEqual(res.result.findings[1], { id: 'b', severity: 'NOT_A_REAL_SEVERITY' }, 'the malformed element is untouched, not silently fixed or dropped here');
  });

  it('omitting responseSchema is byte-identical to today — falls back to opts.schema for validation', async () => {
    const client = successClient({ findings: [{ id: 'a', severity: 'HIGH' }] });
    const res = await ossStructuredCall(client, {
      model: 'm', system: 's', userPrompt: 'u', schema: strictSchema, schemaName: 'x',
    });
    assert.equal(res.conformant, true);
    assert.deepEqual(res.result, { findings: [{ id: 'a', severity: 'HIGH' }] });
  });

  it('the provider-facing JSON Schema still derives from opts.schema, never from responseSchema', async () => {
    const seen = [];
    const client = { chat: { completions: { create: async (params) => {
      seen.push(params);
      return { choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } } } };
    await ossStructuredCall(client, {
      model: 'm', system: 's', userPrompt: 'u', schema: strictSchema, schemaName: 'x',
      responseSchema: lenientResponseSchema,
    });
    const sentSchema = seen[0].response_format.json_schema.schema;
    // The strict item schema's `severity` enum must be present in what the
    // provider was asked to produce — proving guidance is untouched even
    // though validation was decoupled onto a much looser schema.
    assert.deepEqual(sentSchema.properties.findings.items.properties.severity.enum, ['HIGH', 'MEDIUM', 'LOW']);
  });

  it('a genuinely broken envelope (not an array at all) still fails even with a lenient responseSchema — this only loosens PER-ITEM shape, not the envelope contract', async () => {
    const client = successClient({ findings: 'not an array' });
    const res = await ossStructuredCall(client, {
      model: 'm', system: 's', userPrompt: 'u', schema: strictSchema, schemaName: 'x',
      responseSchema: lenientResponseSchema,
    });
    assert.equal(res.conformant, false);
    assert.equal(res.result, null);
  });
});
