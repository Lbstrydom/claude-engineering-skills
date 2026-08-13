/**
 * Cluster B tests — the v2 generation-pass shadow orchestration.
 * Plan: docs/plans/model-ab-harness-v2.md §7b Phase 3. Model calls + store are
 * INJECTED (deps) so nothing hits a real API or DB; the valuable, testable
 * surface is the orchestration invariants (the execution DAG, per-arm gemini,
 * arm-specific `_arm` stamping, spend cap, best-effort containment, egress).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runGenerationShadow, SHADOW_PASSES, seededShuffle, classifyShadowFailure } from '../scripts/lib/audit-shadow.mjs';
import { resolveArms } from '../scripts/lib/audit-arms.mjs';
import { applyModelAbAdjudication, reserveSpend } from '../scripts/lib/store/model-ab.mjs';

const ARMS_BC = resolveArms({ AUDIT_MODEL_SHADOW: 'B,C' }).arms;
const ARMS_B = resolveArms({ AUDIT_MODEL_SHADOW: 'B' }).arms;
const ARMS_C = resolveArms({ AUDIT_MODEL_SHADOW: 'C' }).arms;

/** A recording deps harness: schema ready, budget available, model returns 1 finding/pass. */
function harness(overrides = {}) {
  const calls = { model: [], gemini: [], reserve: [], reconcile: [], release: [], findings: [], passStats: [], meta: [] };
  const deps = {
    modelAbSchemaReady: async () => ({ ready: true, cloud: true, missing: [] }),
    ensureArmSet: async () => {},
    updateRunMeta: async (runId, meta) => { calls.meta.push(meta); },
    releaseOrphanedReservations: async () => 0,
    reserveSpend: async (r) => { calls.reserve.push(r); return { ok: true, ledgerId: calls.reserve.length, spentEur: 0 }; },
    reconcileSpend: async (r) => { calls.reconcile.push(r); },
    releaseSpend: async (r) => { calls.release.push(r); },
    recordFindings: async (runId, findings, passName) => { calls.findings.push({ passName, findings }); },
    recordPassStats: async (runId, passName, stats) => { calls.passStats.push({ passName, stats }); },
    callModel: async ({ provider, model, stage, passName, reasoningEffort }) => {
      calls.model.push({ provider, model, stage, passName, reasoningEffort });
      return {
        result: { findings: [{ id: `X-${stage}-${passName}`, severity: 'MEDIUM', category: 'c', section: 's', detail: `d-${stage}-${passName}`, risk: 'r', recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'p' }] },
        conformant: true, failed: false, requestedReasoningEffort: reasoningEffort,
        usage: { input_tokens: 100, output_tokens: 50, latency_ms: 5, usageMissing: false },
      };
    },
    callGemini: async ({ model, arm }) => {
      calls.gemini.push({ model, arm });
      return { findings: [{ id: `G-${arm}`, severity: 'HIGH', category: 'c', section: 's', detail: `gemini-new-${arm}`, risk: 'r', recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'p' }], passStats: [{ stage: 'gemini', passName: 'gemini', model, conformant: true, usage: { input_tokens: 10, output_tokens: 5, latency_ms: 1 }, costUsd: 0, usageUnmeterable: false, raised: 1 }] };
    },
    ...overrides,
  };
  return { deps, calls };
}

const BASE = { redactedContext: 'export const x = 1;', capEur: 300, runId: 'run-1', planContent: 'plan', seed: 42 };
const genStats = (calls) => calls.passStats.filter((p) => p.stats.stage !== 'gemini');

describe('seededShuffle — deterministic + replayable', () => {
  it('same seed → same order; a permutation of the input', () => {
    const a = seededShuffle([1, 2, 3, 4, 5], 7);
    const b = seededShuffle([1, 2, 3, 4, 5], 7);
    assert.deepEqual(a, b);
    assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5]);
  });
});

describe('runGenerationShadow — preflight & refusals (decision 13 / 12)', () => {
  it('refuses (no spend) when the schema is not ready but cloud is on', async () => {
    const { deps, calls } = harness({ modelAbSchemaReady: async () => ({ ready: false, cloud: true, missing: ['audit_findings.arm'] }) });
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps });
    assert.equal(r.state, 'refused-schema-preflight');
    assert.deepEqual(r.missing, ['audit_findings.arm']);
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

describe('runGenerationShadow — v2 execution DAG & attribution', () => {
  it('B+C: oss-gen + gpt-round ONCE (shared), gemini PER-ARM (B and C)', async () => {
    const { deps, calls } = harness();
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps });
    assert.equal(r.state, 'ran');
    // oss-gen + gpt-round each = 5 passes; run ONCE (shared / B-only).
    assert.equal(calls.model.filter((c) => c.stage === 'oss-gen').length, SHADOW_PASSES.length);
    assert.equal(calls.model.filter((c) => c.stage === 'gpt-round').length, SHADOW_PASSES.length);
    // gemini runs PER ARM — one for B, one for C, over DIFFERENT inputs.
    assert.equal(calls.gemini.length, 2);
    assert.deepEqual(calls.gemini.map((g) => g.arm).sort(), ['B', 'C']);
    assert.deepEqual(r.stages.sort(), ['gemini:B', 'gemini:C', 'gpt-round', 'oss-gen']);
  });
  it('arm-specific findings carry _arm (gpt-round → B; gemini → its arm); shared oss-gen does NOT', async () => {
    const { deps, calls } = harness();
    await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps });
    const all = calls.findings.flatMap((g) => g.findings);
    for (const f of all) {
      assert.ok(f._stage, 'every finding carries a stage');
      if (f._stage === 'oss-gen') assert.equal(f._arm, undefined, 'shared oss-gen findings have no arm (view derives {B,C})');
      if (f._stage === 'gpt-round') assert.equal(f._arm, 'B', 'gpt-round is B-only');
      if (f._stage === 'gemini') assert.ok(f._arm === 'B' || f._arm === 'C', 'gemini findings carry their explicit arm');
    }
    // Both a B-gemini and a C-gemini finding were produced.
    const geminiArms = all.filter((f) => f._stage === 'gemini').map((f) => f._arm).sort();
    assert.deepEqual(geminiArms, ['B', 'C']);
  });
  it('C alone: oss-gen + its own gemini, NO gpt-round (the diversity probe is B-only)', async () => {
    const { deps, calls } = harness();
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_C, deps });
    assert.equal(calls.model.filter((c) => c.stage === 'gpt-round').length, 0);
    assert.equal(calls.gemini.length, 1);
    assert.equal(calls.gemini[0].arm, 'C');
    assert.deepEqual(r.stages.sort(), ['gemini:C', 'oss-gen']);
  });
  it('B alone: oss-gen + gpt-round + its own gemini', async () => {
    const { deps, calls } = harness();
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    assert.deepEqual(r.stages.sort(), ['gemini:B', 'gpt-round', 'oss-gen']);
    assert.equal(calls.gemini.length, 1);
    assert.equal(calls.gemini[0].arm, 'B');
  });
  it('oss-gen uses the OSS model; gpt-round uses a GPT model', async () => {
    const { deps, calls } = harness();
    await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps });
    assert.ok(calls.model.find((c) => c.stage === 'oss-gen').model.includes('/'), 'oss model is vendor/model');
    assert.ok(/gpt/i.test(calls.model.find((c) => c.stage === 'gpt-round').model));
  });
  it('records the assignment grain (stage_type + phase + variant + attempt + arm-order seed)', async () => {
    const { deps, calls } = harness();
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps, phase: 'calibration', promptVariant: 'probe-A', attempt: 2 });
    assert.equal(calls.meta.length, 1);
    assert.deepEqual(calls.meta[0], { stageType: 'audit-code', phase: 'calibration', promptVariant: 'probe-A', attempt: 2, armOrderSeed: 42 });
    assert.equal(r.seed, 42);
  });
  it('feeds the per-pass reasoning tier to BOTH transports (D4a parity)', async () => {
    const { deps, calls } = harness();
    await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    const structure = calls.model.find((c) => c.passName === 'structure');
    const backend = calls.model.find((c) => c.passName === 'backend');
    assert.equal(structure.reasoningEffort, 'low');
    assert.equal(backend.reasoningEffort, 'high');
  });
});

describe('runGenerationShadow — stage_type=audit-plan (v2.1 cross-skill)', () => {
  it('runs ONE plan pass per gen unit (not the 5 code passes) + per-arm gemini', async () => {
    const { deps, calls } = harness();
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps, stageType: 'audit-plan' });
    assert.equal(r.state, 'ran');
    assert.equal(calls.model.filter((c) => c.stage === 'oss-gen').length, 1, 'plan mode = 1 oss pass');
    assert.equal(calls.model.filter((c) => c.stage === 'gpt-round').length, 1, 'plan mode = 1 gpt-round pass');
    assert.equal(calls.gemini.length, 2, 'per-arm gemini still runs (B + C)');
    // The gen units emit a single "plan" pass.
    assert.ok(calls.model.every((c) => c.passName === 'plan'));
  });
  it('records stage_type=audit-plan on the run (so the scorer compares across skills)', async () => {
    const { deps, calls } = harness();
    await runGenerationShadow({ ...BASE, arms: ARMS_BC, deps, stageType: 'audit-plan' });
    assert.equal(calls.meta[0].stageType, 'audit-plan');
  });
  it('audit-code (default) still runs the full 5-pass set — no regression', async () => {
    const { deps, calls } = harness();
    await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    assert.equal(calls.model.filter((c) => c.stage === 'oss-gen').length, SHADOW_PASSES.length);
    assert.equal(calls.meta[0].stageType, 'audit-code');
  });
});

describe('runGenerationShadow — spend cap & reconcile', () => {
  it('reserves + reconciles every gen pass AND each per-arm gemini', async () => {
    const { deps, calls } = harness();
    await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    // B: oss-gen(5) + gpt-round(5) = 10 gen passes + 1 gemini(B) = 11.
    assert.equal(calls.reserve.length, 11);
    assert.equal(calls.reconcile.length, 11);
  });
  it('stops a stage early when the cap refuses a reservation', async () => {
    let n = 0;
    const { deps, calls } = harness({
      reserveSpend: async () => { n += 1; return n <= 2 ? { ok: true, ledgerId: n } : { ok: false, reason: 'cap-exceeded', spentEur: 300 }; },
    });
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    assert.equal(r.state, 'ran');
    assert.equal(calls.model.length, 2, 'only 2 model calls admitted before the cap refused');
  });
  it('a FAILED call RELEASES the reservation, never reconcile-keeps it (Gemini G1 — budget-leak fix)', async () => {
    const { deps, calls } = harness({
      callModel: async () => ({ result: { findings: [] }, conformant: false, failed: true, usage: { input_tokens: 0, output_tokens: 0, usageMissing: true } }),
      callGemini: async () => { throw new Error('gemini down'); },   // gemini also fails → released, never reconciled
    });
    await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    assert.ok(calls.release.length > 0, 'failed gen calls + failed gemini free the reservation');
    assert.equal(calls.reconcile.length, 0, 'a 429/500 storm must NOT keep max-cost reservations');
  });
  it('a SUCCESSFUL gen call missing its usage block reconciles as unmeterable (conservative keep)', async () => {
    const { deps, calls } = harness({
      callModel: async () => ({ result: { findings: [] }, conformant: true, failed: false, usage: { input_tokens: 0, output_tokens: 0, usageMissing: true } }),
    });
    await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    // The GEN passes are successful-but-unmeterable → kept (reconciled unmeterable).
    const genReconciles = calls.reconcile.filter((r) => r.unmeterable === true);
    assert.ok(genReconciles.length >= 10, 'the 10 gen passes reconcile unmeterable');
    assert.equal(calls.release.length, 0, 'successful calls are never released');
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
  it('a failed gen pass is persisted with structured_output_ok=false (conformance denominator — R1 M3)', async () => {
    const { deps, calls } = harness({
      callModel: async () => ({ result: null, conformant: false, failed: true, usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await runGenerationShadow({ ...BASE, arms: ARMS_B, deps });
    const gen = genStats(calls);
    assert.ok(gen.length > 0);
    assert.ok(gen.every((p) => p.stats.structuredOutputOk === false), 'failed gen passes are conformance misses');
  });
});

describe('classifyShadowFailure — caller-side containment (the shadow NEVER gates)', () => {
  // Companion to the "propagates" tests above: runGenerationShadow correctly
  // THROWS on an egress-gate refusal (so the reservation is released, not
  // reconciled), but the CALLER (openai-audit.mjs) must never let that — or
  // any other shadow failure — escape past this classification and abort the
  // primary audit's already-successful --out write.
  it('an egress-gate error gets a refused-egress marker (caller must not rethrow)', () => {
    const err = new Error('[egress-gate] refusing to send oss-arm payload — secret pattern(s) detected: dsn-password');
    const r = classifyShadowFailure(err);
    assert.deepEqual(r.marker, { state: 'refused-egress' });
    assert.match(r.log, /REFUSED \(egress-gate\)/);
  });
  it('a non-egress shadow failure (e.g. provider timeout) has no marker but is still logged', () => {
    const r = classifyShadowFailure(new Error('provider timeout'));
    assert.equal(r.marker, null);
    assert.match(r.log, /failed \(non-gating\)/);
  });
  it('handles a non-Error thrown value without crashing', () => {
    const r = classifyShadowFailure('a raw string throw');
    assert.equal(r.marker, null);
    assert.match(r.log, /a raw string throw/);
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
  it('reserveSpend fails CLOSED on a non-positive/non-finite activeTtlMs (R2 abb590b6)', async () => {
    await assert.rejects(() => reserveSpend({ reservedEur: 1, capEur: 100, activeTtlMs: 0 }), /activeTtlMs/);
    await assert.rejects(() => reserveSpend({ reservedEur: 1, capEur: 100, activeTtlMs: -5 }), /activeTtlMs/);
    await assert.rejects(() => reserveSpend({ reservedEur: 1, capEur: 100, activeTtlMs: NaN }), /activeTtlMs/);
  });
});

describe('runGenerationShadow — bucketing vs baseline', () => {
  it('stamps shadow-only vs both against the baseline finding set', async () => {
    const { deps, calls } = harness();
    const seed = { id: 'X-oss-gen-structure', severity: 'MEDIUM', category: 'c', section: 's', detail: 'd-oss-gen-structure', risk: 'r', recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'p' };
    const r = await runGenerationShadow({ ...BASE, arms: ARMS_B, baseline: { findings: [seed] }, deps });
    assert.equal(r.state, 'ran');
    const allPersisted = calls.findings.flatMap((g) => g.findings);
    assert.ok(allPersisted.some((f) => f._bucket === 'both'), 'the seeded match is bucketed both');
    assert.ok(allPersisted.some((f) => f._bucket === 'shadow-only'), 'novel findings are shadow-only');
  });
});

describe('egress: a secret in the PLAN aborts the run', () => {
  // Audit 2026-08-13 raised this as "sensitive data egress bypass: the stated
  // redaction boundary protects only redactedContext, but the prompt builders
  // also interpolate planContent directly". Investigating it showed the
  // OPPOSITE, and the intended fix was reverted as a latent regression:
  //
  //   assertEgressSafe() scans the ASSEMBLED prompt (plan included) at the single
  //   call site in runStage, and its own contract is that it does not trust
  //   redactedContext's provenance. The plan is covered — by a GATE, not a
  //   scrubber. Redacting the plan first would have converted this loud, correct
  //   refusal into a silent pass, hiding from the operator that their plan
  //   document contains a credential.
  //
  // These lock the behaviour that already existed, so the "fix" cannot be
  // re-applied by a future reader of that finding.
  const SECRET_PLAN = '# Plan\nUse postgresql://u:sup3rs3cr3t@db.example.com:5432/prod for the store.';

  function capturingHarness() {
    const prompts = [];
    const deps = {
      modelAbSchemaReady: async () => ({ ready: true, cloud: true, missing: [] }),
      ensureArmSet: async () => {},
      updateRunMeta: async () => {},
      releaseOrphanedReservations: async () => 0,
      reserveSpend: async () => ({ ok: true, ledgerId: 1, spentEur: 0 }),
      reconcileSpend: async () => {},
      releaseSpend: async () => {},
      recordFindings: async () => {},
      recordPassStats: async () => {},
      // The mock ECHOES the prompt rather than returning a canned-correct value:
      // a mock that repairs its input hides exactly this class of prompt bug.
      callModel: async ({ userPrompt }) => {
        prompts.push(userPrompt);
        return {
          result: { findings: [] }, conformant: true, failed: false,
          usage: { input_tokens: 1, output_tokens: 1, latency_ms: 1, usageMissing: false },
        };
      },
      callGemini: async () => ({ findings: [], passStats: [] }),
    };
    return { deps, prompts };
  }

  it('the run ABORTS and the provider is never called', async () => {
    const { deps, prompts } = capturingHarness();
    await assert.rejects(
      () => runGenerationShadow({ ...BASE, arms: ARMS_B, deps, planContent: SECRET_PLAN }),
      // Keyed on the gate's identity, not its prose — a stale substring here
      // would read as "never rejected" even while the gate worked.
      (err) => /egress-gate/.test(err.message) && /dsn-password/.test(err.message),
      'a plan carrying a DSN must abort the shadow, not be quietly scrubbed',
    );
    assert.equal(prompts.length, 0, 'the egress gate must abort BEFORE any provider call');
  });

  it('NEGATIVE CONTROL: a clean plan DOES reach the provider prompt', async () => {
    // Without this, a gate stuck permanently closed passes the test above while
    // silently disabling every shadow run.
    const { deps, prompts } = capturingHarness();
    await runGenerationShadow({
      ...BASE, arms: ARMS_B, deps,
      planContent: '# Plan\nExtract the arm vocabulary into shared-lib.',
    });
    assert.ok(prompts.length > 0, 'no provider call was made for a clean plan — the gate is stuck closed');
    assert.ok(prompts.some((p) => p.includes('Extract the arm vocabulary into shared-lib')),
      'the plan body must reach the prompt — it is the audit subject');
  });
});
