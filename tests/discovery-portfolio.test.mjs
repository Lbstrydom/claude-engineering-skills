/**
 * Tier-1 tests for the discovery portfolio orchestrator (tiered-recall
 * pipeline, Cluster D scoped Phase 6). Plan: docs/plans/tiered-recall-audit-pipeline.md.
 * Adapters are stubs throughout — no live LLM/network calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runDiscoveryPortfolio } from '../scripts/lib/audit/discovery-portfolio.mjs';
import { resolveModel } from '../scripts/lib/model-resolver.mjs';

const mkFinding = (n) => ({ id: `f${n}`, severity: 'MEDIUM' });
// Resolved dynamically (audit fix M4, round 2 — the module now resolves via
// the `latest-gpt` sentinel, not a hardcoded string) so this test suite
// doesn't go stale when the resolver's pinned model changes.
const GPT_MODEL = resolveModel('latest-gpt');

describe('runDiscoveryPortfolio', () => {
  it('runs both required generators and merges their findings', async () => {
    const ctx = {};
    const adapters = {
      glmCall: async () => [mkFinding(1)],
      sonnetCall: async () => [mkFinding(2)],
    };
    const { findings, requiredGeneratorFailed } = await runDiscoveryPortfolio(ctx, adapters, { fire: false });
    assert.equal(findings.length, 2);
    assert.equal(requiredGeneratorFailed, false);
  });

  it('records a generatorOutcome per generator regardless of finding count', async () => {
    const ctx = {};
    const adapters = { glmCall: async () => [], sonnetCall: async () => [] };
    await runDiscoveryPortfolio(ctx, adapters, { fire: false });
    assert.equal(ctx.generatorOutcomes.length, 2);
    assert.ok(ctx.generatorOutcomes.every((o) => o.status === 'succeeded' && o.findingCount === 0));
  });

  it('marks requiredGeneratorFailed=true when a required generator throws, without throwing itself', async () => {
    const ctx = {};
    const adapters = {
      glmCall: async () => { throw new Error('GLM API down'); },
      sonnetCall: async () => [mkFinding(1)],
    };
    const { findings, requiredGeneratorFailed } = await runDiscoveryPortfolio(ctx, adapters, { fire: false });
    assert.equal(requiredGeneratorFailed, true);
    assert.equal(findings.length, 1); // sonnet's finding still included — one failure doesn't drop the other's output
    const glmOutcome = ctx.generatorOutcomes.find((o) => o.model === 'glm');
    assert.equal(glmOutcome.status, 'failed');
    assert.match(glmOutcome.errorMessage, /GLM API down/);
  });

  it('treats a non-array generator return as a required-generator failure, not a successful zero-finding result (audit fix H5, round 2)', async () => {
    const ctx = {};
    const adapters = {
      glmCall: async () => ({ notAnArray: true }), // malformed adapter response
      sonnetCall: async () => [],
    };
    const { requiredGeneratorFailed } = await runDiscoveryPortfolio(ctx, adapters, { fire: false });
    assert.equal(requiredGeneratorFailed, true);
    const glmOutcome = ctx.generatorOutcomes.find((o) => o.model === 'glm');
    assert.equal(glmOutcome.status, 'failed');
    assert.match(glmOutcome.errorMessage, /non-array/);
  });

  it('does not invoke the GPT generator when the trigger does not fire', async () => {
    const ctx = {};
    let gptCalled = false;
    const adapters = {
      glmCall: async () => [], sonnetCall: async () => [],
      gptCall: async () => { gptCalled = true; return [mkFinding(1)]; },
    };
    await runDiscoveryPortfolio(ctx, adapters, { fire: false });
    assert.equal(gptCalled, false);
    const gptOutcome = ctx.generatorOutcomes.find((o) => o.model === GPT_MODEL);
    assert.equal(gptOutcome.status, 'skipped');
  });

  it('invokes the GPT generator and tags it optional when the deterministic/sentinel trigger fires', async () => {
    const ctx = {};
    const adapters = {
      glmCall: async () => [], sonnetCall: async () => [],
      gptCall: async () => [mkFinding(1)],
    };
    const { findings } = await runDiscoveryPortfolio(ctx, adapters, { fire: true, firedBy: 'deterministic' });
    assert.equal(findings.length, 1);
    const gptOutcome = ctx.generatorOutcomes.find((o) => o.model === GPT_MODEL);
    assert.equal(gptOutcome.role, 'optional');
    assert.equal(gptOutcome.status, 'succeeded');
  });

  it('tags the GPT generator exploratory when firedBy is exploration', async () => {
    const ctx = {};
    const adapters = { glmCall: async () => [], sonnetCall: async () => [], gptCall: async () => [] };
    await runDiscoveryPortfolio(ctx, adapters, { fire: true, firedBy: 'exploration' });
    const gptOutcome = ctx.generatorOutcomes.find((o) => o.model === GPT_MODEL);
    assert.equal(gptOutcome.role, 'exploratory');
  });

  it('records a failed GPT outcome without throwing when GPT fires but errors', async () => {
    const ctx = {};
    const adapters = {
      glmCall: async () => [], sonnetCall: async () => [],
      gptCall: async () => { throw new Error('rate limited'); },
    };
    const { findings } = await runDiscoveryPortfolio(ctx, adapters, { fire: true, firedBy: 'deterministic' });
    assert.equal(findings.length, 0);
    const gptOutcome = ctx.generatorOutcomes.find((o) => o.model === GPT_MODEL);
    assert.equal(gptOutcome.status, 'failed');
  });

  it('reuses an existing ctx.generatorOutcomes array across calls rather than replacing it', async () => {
    const ctx = { generatorOutcomes: [{ model: 'prior', role: 'required', status: 'succeeded', findingCount: 0 }] };
    const adapters = { glmCall: async () => [], sonnetCall: async () => [] };
    await runDiscoveryPortfolio(ctx, adapters, { fire: false });
    assert.equal(ctx.generatorOutcomes.length, 3); // prior entry preserved + 2 new
    assert.equal(ctx.generatorOutcomes[0].model, 'prior');
  });

  it('requiredGeneratorFailed reflects only THIS call — a stale prior-round failure in a reused ctx does not leak in (audit fix M4)', async () => {
    const ctx = { generatorOutcomes: [{ model: 'glm', role: 'required', status: 'failed', findingCount: 0, errorMessage: 'prior round failure' }] };
    const adapters = { glmCall: async () => [], sonnetCall: async () => [] }; // this round's calls succeed
    const { requiredGeneratorFailed } = await runDiscoveryPortfolio(ctx, adapters, { fire: false });
    assert.equal(requiredGeneratorFailed, false);
    assert.equal(ctx.generatorOutcomes.length, 3); // stale entry preserved for audit trail, just not counted
  });
});
