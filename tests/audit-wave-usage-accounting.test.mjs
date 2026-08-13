/**
 * @fileoverview Tier 2 regression: the duplication and adjacency waves must
 * report the token usage their LLM bouncers actually spend.
 *
 * **The defect.** Both waves make a real `safeCallGPT` bouncer call and then
 * built their pass result with `usage: { input_tokens: 0, output_tokens: 0,
 * reasoning_tokens: 0, latency_ms: 0 }` — a hard-coded constant, not a
 * measurement. `runLegacyProductionAudit` reduces `allResults[].usage` into
 * `totalUsage`, which becomes `result._usage` (priced into `_usage.costUsd`)
 * and `cacheMetrics.totalInputTokens` / `hitRate`, whose denominator feeds the
 * weekly `cache-hitrate-check`. So up to two PAID calls per audit run were
 * invisible to both cost and cache telemetry, and the zero read as a
 * measurement rather than as missing data.
 *
 * **The asymmetry that names the cause.** The waves that were EXTRACTED into
 * top-level pass functions — `runArchitecturePass`, `runOrphanIntroducedPass` —
 * return `{ ...llmCall, result }`, so `safeCallGPT`'s own `usage` rides along
 * and is correct. The two waves that stayed INLINE inside the 2,600-line
 * `runLegacyProductionAudit` body re-declare a result literal ~140 lines away
 * from their own model call, and fabricate the zeros. Wave 5's banner comment
 * even says it "mirrors runArchitecturePass's two-stage shape" — it mirrors
 * the shape but not the contract, because inline there is no function boundary
 * to carry one.
 *
 * **Why these assertions.** They pin the OBSERVABLE CONSEQUENCE
 * (`result._usage`), not an internal return shape, so the test survives the
 * extraction that fixes it and keeps meaning the same thing afterwards.
 * Each positive case carries a vacuous-pass guard (the bouncer must actually
 * have been called), because `0 === 0` would otherwise pass on a wave that
 * silently stopped calling the model at all — the failure mode this file
 * exists to catch, one level up.
 *
 * Fixtures are lifted from tests/duplication-pipeline.test.mjs and
 * tests/adjacency-pipeline.test.mjs rather than re-invented, so a drift in the
 * detector contract breaks those suites too instead of only here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeStubClient } from './helpers/fixtures.mjs';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
const _priorEnv = {
  MODEL_CATALOG_REFRESH: process.env.MODEL_CATALOG_REFRESH,
  LEARNING_DISABLE: process.env.LEARNING_DISABLE,
  AUDIT_DB_URL: process.env.AUDIT_DB_URL,
  AUDIT_NO_PREFLIGHT: process.env.AUDIT_NO_PREFLIGHT,
};
process.env.MODEL_CATALOG_REFRESH = 'skip';
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';
process.env.AUDIT_NO_PREFLIGHT = '1';
process.on('exit', () => {
  for (const [key, value] of Object.entries(_priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Imported AFTER the env assignments above: a static import would hoist above
// them and the module would read the unset values (this repo has been bitten
// by exactly that — an env-gated test silently proving the OFF path).
const audit = await import('../scripts/openai-audit.mjs');
const { runMultiPassCodeAudit } = audit.__testExports;
const { safeCallGPT } = await import('../scripts/lib/audit/llm-helpers.mjs');
const { LlmError } = await import('../scripts/lib/robustness.mjs');
const { z } = await import('zod');

/**
 * A real Zod schema is REQUIRED even for a probe whose client always throws:
 * `safeCallGPT` builds the structured-output format before dispatching, so a
 * null schema fails inside zodTextFormat and the stub's throw never runs. The
 * probe then fails for a reason that has nothing to do with what it is testing
 * — which it did, twice, before this comment existed.
 */
const PROBE_SCHEMA = z.object({ ok: z.boolean() });

const FIXTURE_DIR = 'tests/fixtures/harness-plan';
const BACKEND_FILE = `${FIXTURE_DIR}/src/service.mjs`;
const PLAN_CONTENT = `# Wave Usage Accounting Fixture Plan\n\nImplement \`${BACKEND_FILE}\`.\n`;

// `makeStubClient` reports a fixed usage envelope on every parse() call:
// 10 input / 5 output tokens. One bouncer call therefore has to show up as
// exactly these numbers — asserting the value, not merely "> 0", so a future
// double-count is caught as loudly as a drop.
const STUB_INPUT_TOKENS = 10;
const STUB_OUTPUT_TOKENS = 5;

const baseOpts = (pass) => ({
  passFilter: [pass],
  noTools: true, noDebtLedger: true, noLedger: true, scopeMode: 'plan',
});

/** Wave 5's detector shape — one semantic candidate that reaches the bouncer. */
function syntheticDuplicationReport() {
  return {
    state: 'findings',
    deterministicFindings: [],
    semanticCandidates: [{
      id: 'dup-synth1',
      candidate: { filePath: BACKEND_FILE, symbolName: 'foo', kind: 'function', startLine: 1, endLine: 3, purposeSummary: 'x' },
      topMatch: { filePath: BACKEND_FILE, symbolName: 'foo', kind: 'function', startLine: 1, endLine: 3, similarity: 0.95 },
      allMatches: [{ filePath: BACKEND_FILE, symbolName: 'foo', kind: 'function', similarity: 0.95 }],
    }],
  };
}

/** Wave 6's detector shape — one egress-safe trapped-statement candidate. */
function syntheticAdjacencyFacts({ safe = true } = {}) {
  return {
    coverage: { containersEnumerated: 1, statementsJudged: 6 },
    candidates: [{
      id: 'adj-synth1',
      canonicalPath: BACKEND_FILE,
      egressClassification: { category: null },
      span: { startLine: 3, endLine: 5 },
      conditionSpan: { startLine: 2, endLine: 2 },
      containerLine: 2,
      payload: safe
        ? { safe: true, statementText: 'enrich(allThings);', conditionText: 'ledger.entries.length > 0' }
        : { safe: false, reason: 'payload-tripped-egress-scan' },
      dependence: 'independent',
    }],
    incompleteness: [],
    threw: null,
  };
}

/**
 * Wrap a stub client so the test can count model calls independently of the
 * usage numbers under assertion. Counting inside the stub — rather than
 * inferring "it must have been called because usage is non-zero" — is what
 * makes the vacuous-pass guard independent of the thing being measured.
 */
function countingStub(responses) {
  const inner = makeStubClient(responses);
  const state = { calls: 0 };
  return {
    state,
    client: {
      responses: {
        parse: async (params) => { state.calls += 1; return inner.responses.parse(params); },
      },
    },
  };
}

describe('wave usage accounting — a bouncer call must reach _usage', () => {
  it('the duplication wave reports the tokens its bouncer actually spent', async () => {
    const { client, state } = countingStub({
      duplication_bouncer: { decisions: [{ candidateId: 'dup-synth1', decision: 'keep', severity: 'MEDIUM', rationale: 'near-identical body' }] },
    });
    const result = await runMultiPassCodeAudit(client, PLAN_CONTENT, '', false, null, '', {
      ...baseOpts('duplication'),
      __runDuplicationAnalysis: async () => syntheticDuplicationReport(),
    });

    assert.equal(state.calls, 1, 'vacuous-pass guard: the duplication bouncer must actually have been called');
    assert.equal(result._usage.input_tokens, STUB_INPUT_TOKENS,
      'the bouncer\'s input tokens must reach _usage — a hard-coded 0 here is a fabricated measurement, and _usage.costUsd is priced from it');
    assert.equal(result._usage.output_tokens, STUB_OUTPUT_TOKENS,
      'the bouncer\'s output tokens must reach _usage');
  });

  it('the adjacency wave reports the tokens its bouncer actually spent', async () => {
    const { client, state } = countingStub({
      adjacency_bouncer: { decisions: [{ candidateId: 'adj-synth1', decision: 'keep', severity: 'HIGH', rationale: 'a consumer outside the branch reads it' }] },
    });
    const result = await runMultiPassCodeAudit(client, PLAN_CONTENT, '', false, null, '', {
      ...baseOpts('adjacency'),
      __runAdjacencyAnalysis: async () => syntheticAdjacencyFacts(),
    });

    assert.equal(state.calls, 1, 'vacuous-pass guard: the adjacency bouncer must actually have been called');
    assert.equal(result._usage.input_tokens, STUB_INPUT_TOKENS,
      'the bouncer\'s input tokens must reach _usage — cacheMetrics.hitRate uses this as its denominator');
    assert.equal(result._usage.output_tokens, STUB_OUTPUT_TOKENS,
      'the bouncer\'s output tokens must reach _usage');
  });

  // Negative control. Without it, the two assertions above could be satisfied
  // by a wave that reported a constant non-zero usage regardless of what ran —
  // the same defect with a different constant. A wave that makes no model call
  // must report zero, and that zero has to be a measurement of nothing having
  // happened, evidenced by the call counter.
  // The failure path of EVERY pass, found by auditing the census rather than
  // the instance: `callGPT` accumulates tokens a failed call already burned and
  // stamps `err._accumulatedUsage` before rethrowing; `safeCallGPT` used to
  // discard it and return a hard-coded zero envelope. A first attempt at this
  // fix was made one layer UP (in runMapReducePass's REDUCE-failure branch) and
  // was a no-op, because the zeros were manufactured below it — which is why
  // this asserts on `safeCallGPT` directly.
  it('a FAILED call reports the tokens it already burned, not a zero envelope', async () => {
    const burned = { input_tokens: 77, cached_tokens: 3, output_tokens: 11, reasoning_tokens: 5 };
    // Must be an `LlmError`: only those carry `llmUsage`, and `_callGPTOnce`
    // re-throws them intact while wrapping a raw provider throw in a bare Error
    // (which legitimately has no usage to report). This is the shape a
    // truncated / unparseable response produces after tokens were already
    // billed — the case the fix exists for. Reaching for a plain Error here
    // made the probe fail for the wrong reason first.
    const throwingClient = {
      responses: {
        parse: async () => {
          throw new LlmError('simulated truncation after billing', {
            category: 'permanent', usage: burned, retryable: false,
          });
        },
      },
    };
    const out = await safeCallGPT(throwingClient, {
      system: 'sys', messages: [{ role: 'user', content: 'probe' }],
      model: 'gpt-test', schema: PROBE_SCHEMA, schemaName: 'usage_probe', passName: 'usage-probe', maxRetries: 0,
    }, { pass_name: 'usage-probe', findings: [], summary: 'empty' });

    assert.equal(out.failed, true, 'vacuous-pass guard: the call must actually have failed');
    assert.equal(out.usage.input_tokens, burned.input_tokens,
      'a failed call still billed these tokens — zeroing them is unmeasured masquerading as measured-zero');
    assert.equal(out.usage.output_tokens, burned.output_tokens);
    assert.equal(out.usage.reasoning_tokens, burned.reasoning_tokens);
    assert.equal(out.usage.cached_tokens, burned.cached_tokens);
  });

  // Negative control for the above: a failure that burned NOTHING must still
  // report zero, so the assertion above cannot be satisfied by echoing a
  // constant.
  it('a failed call that burned no tokens reports zero — the honest case', async () => {
    const throwingClient = { responses: { parse: async () => { throw new Error('immediate failure'); } } };
    const out = await safeCallGPT(throwingClient, {
      system: 'sys', messages: [{ role: 'user', content: 'probe' }],
      model: 'gpt-test', schema: PROBE_SCHEMA, schemaName: 'usage_probe', passName: 'usage-probe', maxRetries: 0,
    }, { pass_name: 'usage-probe', findings: [], summary: 'empty' });
    assert.equal(out.failed, true);
    assert.equal(out.usage.input_tokens, 0);
    assert.equal(out.usage.output_tokens, 0);
  });

  it('a wave that makes no bouncer call reports zero — an honest zero, not a constant', async () => {
    const { client, state } = countingStub({});
    const result = await runMultiPassCodeAudit(client, PLAN_CONTENT, '', false, null, '', {
      ...baseOpts('adjacency'),
      __runAdjacencyAnalysis: async () => syntheticAdjacencyFacts({ safe: false }),
    });

    assert.equal(state.calls, 0, 'no egress-safe candidate → the bouncer must not be called at all');
    assert.equal(result._usage.input_tokens, 0, 'no call means no tokens');
    assert.equal(result._usage.output_tokens, 0, 'no call means no tokens');
  });
});

// ── callCount is a measurement, not a constant ──────────────────────────────
//
// `cacheMetrics.perPass[*].callCount` was hard-coded to 1 for every registry
// entry, including passes that never dispatched. That made the pipeline's only
// per-pass call counter unusable as a denominator — the final-review shadow's
// point that nothing persisted distinguishes "the bouncer was not invoked"
// (legitimate: it fires only on eligible candidates) from "usage is still
// fabricated as 0". The two waves now report their own count, tracked
// independently of the token values so it cannot be circular.
describe('per-pass callCount distinguishes "no call" from "one call"', () => {
  it('a wave whose bouncer fires reports callCount 1', async () => {
    const { client } = countingStub({
      adjacency_bouncer: { decisions: [{ candidateId: 'adj-synth1', decision: 'keep', severity: 'HIGH', rationale: 'r' }] },
    });
    const result = await runMultiPassCodeAudit(client, PLAN_CONTENT, '', false, null, '', {
      ...baseOpts('adjacency'),
      __runAdjacencyAnalysis: async () => syntheticAdjacencyFacts(),
    });
    assert.equal(result._cacheMetrics.perPass.adjacency.callCount, 1);
  });

  // The direction that makes it a denominator rather than decoration: a pass
  // that ran but dispatched nothing must report 0, not 1.
  it('a wave that ran but made no model call reports callCount 0', async () => {
    const { client, state } = countingStub({});
    const result = await runMultiPassCodeAudit(client, PLAN_CONTENT, '', false, null, '', {
      ...baseOpts('adjacency'),
      __runAdjacencyAnalysis: async () => syntheticAdjacencyFacts({ safe: false }),
    });
    assert.equal(state.calls, 0, 'vacuous-pass guard: no model call may have happened');
    assert.equal(result._cacheMetrics.perPass.adjacency.callCount, 0,
      'a hard-coded 1 here is what made the counter useless as a denominator');
  });
});
