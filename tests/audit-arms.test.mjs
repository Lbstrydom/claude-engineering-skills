/**
 * Tier-1 (pure) tests for the model-A/B/C harness config layer:
 * arm parse/validate + resolveArms + stage/execution derivation, the OSS
 * sentinels in model-resolver, and usage→cost in model-pricing.
 * Plan: docs/plans/model-ab-experiment-harness.md §9.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_ARMS, ArmSchema, parseArm, stagesForArm, executionPlan, resolveArms, STAGES,
  attributeStageToArms, SHADOW_STAGES, BASELINE_STAGES,
} from '../scripts/lib/audit-arms.mjs';
import { resolveModel, isSentinel, pickOssModel, OSS_POOL } from '../scripts/lib/model-resolver.mjs';
import { costFromUsage, costForBudget, priceFor, isPriced, toEur, EUR_PER_USD, FALLBACK_PRICE_USD, OSS_PRICING } from '../scripts/lib/model-pricing.mjs';

describe('audit-arms — canonical arms', () => {
  it('the 3 canonical arms A/B/C all validate against ArmSchema', () => {
    assert.equal(CANONICAL_ARMS.length, 3);
    for (const arm of CANONICAL_ARMS) {
      assert.equal(ArmSchema.safeParse(arm).success, true, `arm ${arm.id} must validate`);
    }
    assert.deepEqual(CANONICAL_ARMS.map((a) => a.id), ['A', 'B', 'C']);
  });

  it('A is the production baseline; B/C are OSS-generation, non-baseline', () => {
    const [A, B, C] = CANONICAL_ARMS;
    assert.equal(A.isBaseline, true);
    assert.equal(A.generation.provider, 'openai');
    assert.equal(B.isBaseline, false);
    assert.equal(B.generation.provider, 'oss');
    assert.equal(C.generation.provider, 'oss');
    // B and C SHARE the same generation config (compute-sharing invariant).
    assert.deepEqual(B.generation, C.generation);
    // C = B + Gemini gate.
    assert.equal(B.geminiGate, false);
    assert.equal(C.geminiGate, true);
    assert.equal(B.gptRound, true);
    assert.equal(C.gptRound, true);
  });

  it('stagesForArm derives the produced-finding stages (view membership must agree)', () => {
    const [A, B, C] = CANONICAL_ARMS;
    assert.deepEqual(stagesForArm(A), ['gpt-gen', 'gemini']);
    assert.deepEqual(stagesForArm(B), ['oss-gen', 'gpt-round']);
    assert.deepEqual(stagesForArm(C), ['oss-gen', 'gpt-round', 'gemini']);
    for (const s of [...stagesForArm(A), ...stagesForArm(C)]) assert.ok(STAGES.includes(s));
  });

  it('executionPlan honours compute-sharing across B+C (oss-gen + gpt-round once; gemini for C)', () => {
    const [, B, C] = CANONICAL_ARMS;
    const plan = executionPlan([B, C]);
    assert.equal(plan.wantsOssGen, true);
    assert.equal(plan.wantsGptRound, true);
    assert.equal(plan.wantsGemini, true);   // C wants it
    assert.equal(plan.wantsGptGen, false);  // no non-baseline openai-gen arm
    // B alone → no Gemini.
    assert.equal(executionPlan([B]).wantsGemini, false);
  });
});

describe('audit-arms — parseArm validation', () => {
  it('rejects an OSS arm without a role', () => {
    const r = parseArm({ id: 'X', label: 'x', generation: { modelSentinel: 'latest-oss-coder', provider: 'oss' }, gptRound: false, geminiGate: false });
    assert.equal(r.ok, false);
    assert.match(r.error, /role/);
  });
  it('rejects an openai arm carrying an OSS role', () => {
    const r = parseArm({ id: 'X', label: 'x', generation: { modelSentinel: 'latest-gpt', provider: 'openai', role: 'coder' }, gptRound: false, geminiGate: false });
    assert.equal(r.ok, false);
  });
  it('rejects a bad arm id', () => {
    const r = parseArm({ id: 'lowercase-and-way-too-long', label: 'x', generation: { modelSentinel: 'latest-gpt', provider: 'openai' }, gptRound: false, geminiGate: false });
    assert.equal(r.ok, false);
  });
  it('rejects a provider/sentinel mismatch — oss arm with a GPT sentinel (audit R1 M4)', () => {
    const r = parseArm({ id: 'X', label: 'x', generation: { modelSentinel: 'latest-gpt', provider: 'oss', role: 'coder' }, gptRound: false, geminiGate: false });
    assert.equal(r.ok, false);
    assert.match(r.error, /modelSentinel/);
  });
  it('rejects an openai arm with an OSS sentinel', () => {
    const r = parseArm({ id: 'X', label: 'x', generation: { modelSentinel: 'latest-oss-coder', provider: 'openai' }, gptRound: false, geminiGate: false });
    assert.equal(r.ok, false);
  });
  it('rejects a concrete id — arm configs must use SENTINELS (plan decision 2 / R4 M4)', () => {
    const r = parseArm({ id: 'X', label: 'x', generation: { modelSentinel: 'qwen/qwen3-coder', provider: 'oss', role: 'coder' }, gptRound: false, geminiGate: false });
    assert.equal(r.ok, false);
    assert.match(r.error, /SENTINEL/i);
  });
  it('accepts the OSS sentinel for an OSS arm', () => {
    const r = parseArm({ id: 'X', label: 'x', generation: { modelSentinel: 'latest-oss-reasoner', provider: 'oss', role: 'reasoner' }, gptRound: false, geminiGate: false });
    assert.equal(r.ok, true);
  });
});

describe('audit-arms — attributeStageToArms (provenance disambiguates shared gemini — R1 H3/H6)', () => {
  it('baseline gemini → A only; shadow gemini → C only', () => {
    assert.deepEqual(attributeStageToArms('gemini', { provenance: 'baseline' }), ['A']);
    assert.deepEqual(attributeStageToArms('gemini', { provenance: 'shadow' }), ['C']);
  });
  it('shadow oss-gen / gpt-round → both B and C (compute-sharing)', () => {
    assert.deepEqual(attributeStageToArms('oss-gen', { provenance: 'shadow' }), ['B', 'C']);
    assert.deepEqual(attributeStageToArms('gpt-round', { provenance: 'shadow' }), ['B', 'C']);
  });
  it('baseline gpt-gen → A; shadow gpt-gen → nobody (baseline-only stage)', () => {
    assert.deepEqual(attributeStageToArms('gpt-gen', { provenance: 'baseline' }), ['A']);
    assert.deepEqual(attributeStageToArms('gpt-gen', { provenance: 'shadow' }), []);
  });
  it('no double-attribution: a gemini row belongs to exactly one arm per provenance', () => {
    const b = attributeStageToArms('gemini', { provenance: 'baseline' });
    const s = attributeStageToArms('gemini', { provenance: 'shadow' });
    assert.equal(b.length, 1);
    assert.equal(s.length, 1);
    assert.notDeepEqual(b, s);
  });
  it('fails CLOSED on invalid input — omitted/typo provenance or unknown stage throws (R3 H5)', () => {
    assert.throws(() => attributeStageToArms('gemini'), /provenance/);
    assert.throws(() => attributeStageToArms('gemini', { provenance: 'typo' }), /provenance/);
    assert.throws(() => attributeStageToArms('nonsense-stage', { provenance: 'shadow' }), /unknown stage/);
  });
  it('SHADOW_STAGES / BASELINE_STAGES agree with stagesForArm over CANONICAL_ARMS (R5 M2)', () => {
    const shadowFromArms = new Set(CANONICAL_ARMS.filter((a) => !a.isBaseline).flatMap(stagesForArm));
    const baselineFromArms = new Set(CANONICAL_ARMS.filter((a) => a.isBaseline).flatMap(stagesForArm));
    assert.deepEqual([...shadowFromArms].sort(), [...SHADOW_STAGES].sort());
    assert.deepEqual([...baselineFromArms].sort(), [...BASELINE_STAGES].sort());
  });
  it('membership is DERIVED from CANONICAL_ARMS — no drift vs stagesForArm (R4 M3/M6)', () => {
    // For every arm and every stage it declares, the attribution helper (under
    // the matching provenance) must include that arm — one source of truth.
    for (const arm of CANONICAL_ARMS) {
      const provenance = arm.isBaseline ? 'baseline' : 'shadow';
      for (const stage of stagesForArm(arm)) {
        assert.ok(
          attributeStageToArms(stage, { provenance }).includes(arm.id),
          `arm ${arm.id} declares stage ${stage} but attribution (${provenance}) omits it`,
        );
      }
    }
  });
});

describe('audit-arms — resolveArms(env)', () => {
  it('unset AUDIT_MODEL_SHADOW → disabled (byte-identical-to-today path)', () => {
    const r = resolveArms({});
    assert.equal(r.enabled, false);
    assert.deepEqual(r.arms, []);
  });
  it('"B,C" selects arms B and C', () => {
    const r = resolveArms({ AUDIT_MODEL_SHADOW: 'B,C' });
    assert.equal(r.enabled, true);
    assert.deepEqual(r.arms.map((a) => a.id), ['B', 'C']);
  });
  it('dedups repeated ids, preserving order', () => {
    const r = resolveArms({ AUDIT_MODEL_SHADOW: 'C,B,C' });
    assert.deepEqual(r.arms.map((a) => a.id), ['C', 'B']);
  });
  it('throws on an unknown arm id (never silently drops a paid-for arm)', () => {
    assert.throws(() => resolveArms({ AUDIT_MODEL_SHADOW: 'B,Z' }), /unknown arm id/);
  });
  it('throws when the baseline arm A is requested as a shadow target', () => {
    assert.throws(() => resolveArms({ AUDIT_MODEL_SHADOW: 'A' }), /baseline/);
  });
  it('a delimiter-only value is treated as disabled, not enabled-empty (audit R1 M5)', () => {
    assert.equal(resolveArms({ AUDIT_MODEL_SHADOW: ',' }).enabled, false);
    assert.equal(resolveArms({ AUDIT_MODEL_SHADOW: ', ,' }).enabled, false);
  });
});

describe('model-resolver — OSS sentinels', () => {
  it('latest-oss-coder / latest-oss-reasoner are sentinels', () => {
    assert.equal(isSentinel('latest-oss-coder'), true);
    assert.equal(isSentinel('latest-oss-reasoner'), true);
  });
  it('resolve to the OSS_POOL head for their role', () => {
    assert.equal(resolveModel('latest-oss-coder'), OSS_POOL.coder[0]);
    assert.equal(resolveModel('latest-oss-reasoner'), OSS_POOL.reasoner[0]);
  });
  it('env override wins over the static pool head (comma-list head)', () => {
    const prev = process.env.OSS_CODER_MODEL;
    try {
      process.env.OSS_CODER_MODEL = 'vendor/custom-coder, vendor/other';
      assert.equal(pickOssModel('coder'), 'vendor/custom-coder');
    } finally {
      if (prev === undefined) delete process.env.OSS_CODER_MODEL; else process.env.OSS_CODER_MODEL = prev;
    }
  });
  it('a concrete OSS id passes through resolveModel unchanged', () => {
    assert.equal(resolveModel('qwen/qwen3-coder'), 'qwen/qwen3-coder');
  });
});

describe('model-pricing — usage→cost with null-cost policy', () => {
  it('prices a known OSS model and derives USD from usage', () => {
    const px = priceFor('qwen/qwen3-coder');
    assert.ok(px && px.input > 0 && px.output > 0);
    const c = costFromUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'qwen/qwen3-coder');
    assert.equal(c.priced, true);
    assert.ok(Math.abs(c.totalUsd - (px.input + px.output)) < 1e-9);
  });
  it('accepts the OpenAI-style usage shape (prompt_tokens/completion_tokens)', () => {
    const c = costFromUsage({ prompt_tokens: 500_000, completion_tokens: 0 }, 'qwen/qwen3-coder');
    assert.equal(c.inputTokens, 500_000);
    assert.equal(c.outputTokens, 0);
  });
  it('unknown price → null totalUsd, never 0 (excluded from the cost ratio)', () => {
    assert.equal(isPriced('some/never-priced-model'), false);
    const c = costFromUsage({ input_tokens: 999, output_tokens: 999 }, 'some/never-priced-model');
    assert.equal(c.priced, false);
    assert.equal(c.totalUsd, null);
  });
  it('toEur applies the fixed rate and passes null through', () => {
    assert.equal(toEur(null), null);
    assert.ok(Math.abs(toEur(10) - 10 * EUR_PER_USD) < 1e-9);
  });
  it('sanitizes garbage usage — negative/NaN/Infinity tokens never produce a bad cost (R1 H4)', () => {
    const neg = costFromUsage({ input_tokens: -5, output_tokens: Number.NaN }, 'qwen/qwen3-coder');
    assert.equal(neg.inputTokens, 0);
    assert.equal(neg.outputTokens, 0);
    assert.equal(neg.totalUsd, 0);
    const inf = costFromUsage({ input_tokens: Infinity, output_tokens: 1000 }, 'qwen/qwen3-coder');
    assert.equal(inf.inputTokens, 0);
    assert.ok(Number.isFinite(inf.totalUsd));
  });
  it('costForBudget never returns null — an unpriced model over-estimates (R1 H7)', () => {
    const known = costForBudget({ input_tokens: 1_000_000, output_tokens: 0 }, 'qwen/qwen3-coder');
    assert.equal(known.estimated, false);
    assert.ok(known.totalUsd > 0);
    const unknown = costForBudget({ input_tokens: 1_000_000, output_tokens: 0 }, 'some/never-priced');
    assert.equal(unknown.estimated, true);
    // Fallback is conservative — at least the priciest known input rate.
    assert.ok(unknown.totalUsd >= known.totalUsd);
  });
  it('every OSS_POOL head has a price — pool/pricing drift guard (R3 M3)', () => {
    for (const role of Object.keys(OSS_POOL)) {
      const head = OSS_POOL[role][0];
      assert.equal(isPriced(head), true, `OSS_POOL.${role} head "${head}" must be priced`);
    }
  });
  it('FALLBACK_PRICE_USD is at/above every known OSS price — cap invariant (R3 M5)', () => {
    const maxIn = Math.max(...Object.values(OSS_PRICING).map((p) => p.input));
    const maxOut = Math.max(...Object.values(OSS_PRICING).map((p) => p.output));
    assert.ok(FALLBACK_PRICE_USD.input >= maxIn, 'fallback input rate must dominate OSS prices');
    assert.ok(FALLBACK_PRICE_USD.output >= maxOut, 'fallback output rate must dominate OSS prices');
  });
  it('costForBudget flags unmeterable usage so €0 is never authoritative (R5 H4)', () => {
    assert.equal(costForBudget(null, 'qwen/qwen3-coder').unmeterable, true);
    assert.equal(costForBudget({ input_tokens: 5 }, 'qwen/qwen3-coder').unmeterable, true);           // partial
    assert.equal(costForBudget({ input_tokens: -1, output_tokens: 2 }, 'qwen/qwen3-coder').unmeterable, true); // invalid
    assert.equal(costForBudget({ input_tokens: 10, output_tokens: 20 }, 'qwen/qwen3-coder').unmeterable, false);
  });
  it('costForBudget HONORS the explicit usageMissing flag even with sanitized 0 tokens (Gemini R3)', () => {
    // The adapter's REAL output for a missing usage block: tokens clamped to 0
    // (valid numbers) BUT usageMissing:true. The flag must win → unmeterable.
    const r = costForBudget({ input_tokens: 0, output_tokens: 0, usageMissing: true }, 'qwen/qwen3-coder');
    assert.equal(r.unmeterable, true, 'a successful-but-unmeterable call must not read as a real €0');
  });
});
