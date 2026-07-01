/**
 * Cluster B tests — the generation-pass shadow orchestration + store logic.
 * Plan §9. Model calls + store are INJECTED (deps) so nothing hits a real API
 * or DB; the valuable, testable surface is the orchestration invariants.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runGenerationShadow, SHADOW_PASSES } from '../scripts/lib/audit-shadow.mjs';
import { resolveArms } from '../scripts/lib/audit-arms.mjs';
import { applyModelAbAdjudication, reserveSpend } from '../scripts/lib/store/model-ab.mjs';

const ARMS_BC = resolveArms({ AUDIT_MODEL_SHADOW: 'B,C' }).arms;
const ARMS_B = resolveArms({ AUDIT_MODEL_SHADOW: 'B' }).arms;

/** A recording deps harness: schema ready, budget available, model returns 1 finding/pass. */
function harness(overrides = {}) {
  const calls = { model: [], gemini: [], reserve: [], reconcile: [], release: [], findings: [], passStats: [] };
  const deps = {
    modelAbSchemaReady: async () => ({ ready: true, cloud: true, missing: [] }),
    ensureArmSet: async () => {},
    releaseOrphanedReservations: async () => 0,
    reserveSpend: async (r) => { calls.reserve.push(r); return { ok: true, ledgerId: calls.reserve.length, spentEur: 0 }; },
    reconcileSpend: async (r) => { calls.reconcile.push(r); },
    releaseSpend: async (r) => { calls.release.push(r); },
    recordFindings: async (runId, findings, passName) => { calls.findings.push({ passName, findings }); },
    recordPassStats: async (runId, passName, stats) => { calls.passStats.push({ passName, stats }); },
    callModel: async ({ provider, model, stage, passName }) => {
      calls.model.push({ provider, model, stage, passName });
      return {
        result: { findings: [{ id: `X-${stage}-${passName}`, severity: 'MEDIUM', category: 'c', section: 's', detail: `d-${stage}-${passName}`, risk: 'r', recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'p' }] },
        conformant: true, failed: false, usage: { input_tokens: 100, output_tokens: 50, latency_ms: 5, usageMissing: false },
      };
    },
    callGemini: async ({ model }) => {
      calls.gemini.push({ model });
      return { findings: [{ id: 'G-1', severity: 'HIGH', category: 'c', section: 's', detail: 'gemini-new', risk: 'r', recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'p' }], passStats: [{ stage: 'gemini', passName: 'gemini', model, conformant: true, usage: { input_tokens: 10, output_tokens: 5, latency_ms: 1 }, costUsd: 0, usageUnmeterable: false, raised: 1 }] };
    },
    ...overrides,
  };
  return { deps, calls };
}

const BASE = { redactedContext: 'export const x = 1;', capEur: 300, runId: 'run-1', planContent: 'plan' };

describe('runGenerationShadow — preflight & refusals (decision 13 / 12)', () => {
  it('refuses (no spend) when the schema is not ready but cloud is on', async () => {
    const { deps, calls } = harness({ modelAbSchemaReady: async () => ({ ready: false, cloud: true, missing: ['audit_findings.stage'] }) });
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps });
    assert.equal(r.state, 'refused-schema-preflight');
    assert.deepEqual(r.missing, ['audit_findings.stage']);
    assert.equal(calls.model.length, 0, 'no model calls when schema not ready');
    assert.equal(calls.reserve.length, 0);
  });
  it('skips (graceful) when cloud is off', async () => {
    const { deps, calls } = harness({ modelAbSchemaReady: async () => ({ ready: false, cloud: false, missing: [] }) });
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps });
    assert.equal(r.state, 'skipped-cloud-off');
    assert.equal(calls.model.length, 0);
  });
  it('refuses when no budget is set (no unbounded burn)', async () => {
    const { deps, calls } = harness();
    const r = await runGenerationShadow({ ...BASE, capEur: null, arms: ARMS_BC, deps });
    assert.equal(r.state, 'refused-no-budget');
    assert.equal(calls.model.length, 0);
  });
  it('rejects a non-string redactedContext (redact-once contract — decision 11)', async () => {
    const { deps } = harness();
    await assert.rejects(() => runGenerationShadow({ ...BASE, redactedContext: { raw: 'paths' }, arms: ARMS_BC, deps }), /redactedContext must be a string/);
  });
});

describe('runGenerationShadow — compute-sharing & attribution', () => {
  it('B+C runs oss-gen + gpt-round ONCE and the gemini stage (C); findings carry stage+source_model', async () => {
    const { deps, calls } = harness();
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps });
    assert.equal(r.state, 'ran');
    assert.deepEqual(r.stages.sort(), ['gemini', 'gpt-round', 'oss-gen']);
    // oss-gen + gpt-round each = 5 passes; run ONCE (shared by B and C).
    const ossCalls = calls.model.filter((c) => c.stage === 'oss-gen');
    const gptCalls = calls.model.filter((c) => c.stage === 'gpt-round');
    assert.equal(ossCalls.length, SHADOW_PASSES.length);
    assert.equal(gptCalls.length, SHADOW_PASSES.length);
    assert.equal(calls.gemini.length, 1);
    // Findings persisted per-stage with the model-ab-<stage> pass name.
    const passNames = calls.findings.map((f) => f.passName).sort();
    assert.deepEqual(passNames, ['model-ab-gemini', 'model-ab-gpt-round', 'model-ab-oss-gen']);
    // Every persisted finding carries its attribution.
    for (const grp of calls.findings) {
      for (const f of grp.findings) { assert.ok(f._stage); assert.ok(f._sourceModel); }
    }
  });
  it('B alone (no Gemini) runs oss-gen + gpt-round only', async () => {
    const { deps, calls } = harness();
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    assert.deepEqual(r.stages.sort(), ['gpt-round', 'oss-gen']);
    assert.equal(calls.gemini.length, 0);
  });
  it('oss-gen uses the OSS model; gpt-round uses a GPT model', async () => {
    const { deps, calls } = harness();
    await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps });
    assert.ok(calls.model.find((c) => c.stage === 'oss-gen').model.includes('/'), 'oss model is vendor/model');
    assert.ok(/gpt/i.test(calls.model.find((c) => c.stage === 'gpt-round').model));
  });
});

describe('runGenerationShadow — spend cap & reconcile', () => {
  it('reserves before and reconciles after every pass', async () => {
    const { deps, calls } = harness();
    await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    // 2 stages × 5 passes = 10 reserve + 10 reconcile.
    assert.equal(calls.reserve.length, 10);
    assert.equal(calls.reconcile.length, 10);
  });
  it('stops a stage early when the cap refuses a reservation', async () => {
    let n = 0;
    const { deps, calls } = harness({
      reserveSpend: async () => { n += 1; return n <= 2 ? { ok: true, ledgerId: n } : { ok: false, reason: 'cap-exceeded', spentEur: 300 }; },
    });
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    assert.equal(r.state, 'ran');
    // Only 2 model calls admitted before the cap refused the 3rd.
    assert.equal(calls.model.length, 2);
  });
  it('propagates usageMissing/unmeterable into reconcile', async () => {
    const { deps, calls } = harness({
      callModel: async () => ({ result: { findings: [] }, conformant: false, failed: true, usage: { usageMissing: true } }),
    });
    await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    assert.ok(calls.reconcile.every((r) => r.unmeterable === true), 'missing usage → reconcile unmeterable');
  });
});

describe('runGenerationShadow — best-effort & egress', () => {
  it('a throwing stage is contained (unverified) and the shadow still returns', async () => {
    let calledOss = false;
    const { deps } = harness({
      callModel: async ({ stage }) => {
        if (stage === 'oss-gen') { calledOss = true; throw new Error('provider down'); }
        return { result: { findings: [] }, conformant: true, failed: false, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    assert.equal(r.state, 'ran');   // never throws into the caller
    assert.ok(calledOss);
  });
  it('an egress-gate refusal PROPAGATES and RELEASES the reservation (R2 H2)', async () => {
    const { deps, calls } = harness({
      callModel: async () => { throw new Error('[egress-gate] refusing to send oss payload'); },
    });
    await assert.rejects(() => runGenerationShadow({ ...BASE, arms: ARMS_B, deps }), /egress-gate/);
    assert.equal(calls.release.length, 1, 'the reservation is released (freed), not kept');
    assert.equal(calls.reconcile.length, 0, 'reconcile-unmeterable (which KEEPS) is NOT used on abort');
  });
  it('a secret in redactedContext aborts BEFORE any reserve/model call (defence-in-depth — R1 H3/M6)', async () => {
    const secret = ['sk', 'abcdefghij0123456789ABCDEFGHIJ'].join('-');
    const { deps, calls } = harness();
    await assert.rejects(
      () => runGenerationShadow({ ...BASE, redactedContext: `const K = "${secret}";`, arms: ARMS_B, deps }),
      /egress-gate|refusing to send/,
    );
    assert.equal(calls.model.length, 0, 'no model call when the payload carries a secret');
    assert.equal(calls.reserve.length, 0, 'no reservation before the egress abort');
  });
  it('a failed pass is persisted with structured_output_ok=false (conformance denominator — R1 M3)', async () => {
    const { deps, calls } = harness({
      callModel: async () => ({ result: null, conformant: false, failed: true, usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    assert.ok(calls.passStats.length > 0);
    assert.ok(calls.passStats.every((p) => p.stats.structuredOutputOk === false), 'failed passes are conformance misses');
  });
});

describe('store/model-ab — DB-independent argument guards', () => {
  it('applyModelAbAdjudication requires runId + fingerprint (before any cloud/DB touch)', async () => {
    await assert.rejects(() => applyModelAbAdjudication({ fingerprint: 'f', action: 'accepted' }), /runId \+ fingerprint required/);
    await assert.rejects(() => applyModelAbAdjudication({ runId: 'r', action: 'accepted' }), /runId \+ fingerprint required/);
  });
  it('reserveSpend fails CLOSED on a missing/invalid cap — no unlimited path (R2 H1)', async () => {
    await assert.rejects(() => reserveSpend({ reservedEur: 1, capEur: null, activeTtlMs: 1000 }), /finite number/);
    await assert.rejects(() => reserveSpend({ reservedEur: 1, capEur: undefined, activeTtlMs: 1000 }), /finite number/);
    await assert.rejects(() => reserveSpend({ reservedEur: 1, capEur: NaN, activeTtlMs: 1000 }), /finite number/);
  });
});

describe('runGenerationShadow — bucketing vs baseline', () => {
  it('stamps shadow-only vs both against the baseline finding set', async () => {
    // Make the baseline contain the exact finding oss-gen/structure will emit.
    const { deps, calls } = harness();
    // Compute what the harness emits for oss-gen/structure to seed the baseline.
    const seed = { id: 'X-oss-gen-structure', severity: 'MEDIUM', category: 'c', section: 's', detail: 'd-oss-gen-structure', risk: 'r', recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'p' };
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_B, baseline: { findings: [seed] }, deps });
    assert.equal(r.state, 'ran');
    // At least one finding should be bucketed 'both' (the seeded match), rest shadow-only.
    const allPersisted = calls.findings.flatMap((g) => g.findings);
    assert.ok(allPersisted.some((f) => f._bucket === 'both'), 'the seeded match is bucketed both');
    assert.ok(allPersisted.some((f) => f._bucket === 'shadow-only'), 'novel findings are shadow-only');
  });
});
