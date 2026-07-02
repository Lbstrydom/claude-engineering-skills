/**
 * Tier-1 tests for the arm-eval run orchestration. Producers, judge, cross-checks
 * and store are INJECTED — nothing hits an API or DB. Plan: §6 / D7.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runArmEvalSession, hashTask } from '../scripts/lib/arm-eval/run.mjs';

function harness(over = {}) {
  const calls = { session: [], run: [], output: [], judgment: [], crosscheck: [] };
  const store = {
    armEvalSchemaReady: async () => ({ ready: true, cloud: true, missing: [] }),
    recordSession: async (a) => { calls.session.push(a); },
    recordRun: async (a) => { calls.run.push(a); },
    recordOutput: async (a) => { calls.output.push(a); },
    recordJudgment: async (a) => { calls.judgment.push(a); },
    recordCrossCheck: async (a) => { calls.crosscheck.push(a); },
    ...(over.store || {}),
  };
  const deps = {
    store,
    buildIntentContext: () => ({ present: true, pack: 'INTENT', intentScorable: true }),
    producePlan: async ({ arm }) => ({ output: `plan ${arm.id}`, outputHash: `h-${arm.id}`, conformant: true, resolvedModel: arm.models[0], usage: {} }),
    produceBrainstorm: async ({ arm }) => ({ output: `take ${arm.id}`, outputHash: `h-${arm.id}`, conformant: true, resolvedModels: arm.models, usage: [] }),
    judgeSession: async ({ outputs }) => ({
      conformant: true, presentationOrder: outputs.map((_, i) => `output-${i + 1}`),
      labelToArm: Object.fromEntries(outputs.map((o, i) => [`output-${i + 1}`, o.arm])),
      dims: ['correctness'], intentDims: 'scored',
      passes: [Object.fromEntries(outputs.map((o, i) => [`output-${i + 1}`, { correctness: 4 }])), Object.fromEntries(outputs.map((o, i) => [`output-${i + 1}`, { correctness: 4 }]))],
    }),
    runCrossChecks: async ({ checks }) => checks.map((c) => ({ checkName: c, checkVersion: '1', status: 'ok', score: 0 })),
    ...over,
  };
  return { deps, calls };
}

const BASE = { experimentType: 'plan-authoring', task: 'build a widget', repoId: 'repo-1', budgetCapEur: 50, seed: 7 };

describe('runArmEvalSession — refusals (D7 inert)', () => {
  it('refuses without a budget', async () => {
    const { deps } = harness();
    assert.equal((await runArmEvalSession({ ...BASE, budgetCapEur: null, deps })).state, 'refused-no-budget');
  });
  it('skips when cloud off', async () => {
    const { deps } = harness({ store: { armEvalSchemaReady: async () => ({ ready: false, cloud: false, missing: [] }) } });
    assert.equal((await runArmEvalSession({ ...BASE, deps })).state, 'skipped-cloud-off');
  });
  it('refuses when schema not ready', async () => {
    const { deps } = harness({ store: { armEvalSchemaReady: async () => ({ ready: false, cloud: true, missing: ['arm_eval_sessions'] }) } });
    const r = await runArmEvalSession({ ...BASE, deps });
    assert.equal(r.state, 'refused-schema-preflight');
  });
  it('unknown experiment throws', async () => {
    const { deps } = harness();
    await assert.rejects(() => runArmEvalSession({ ...BASE, experimentType: 'nope', deps }), /unknown experiment/);
  });
});

describe('runArmEvalSession — plan-authoring orchestration', () => {
  it('produces each arm, records session/runs/outputs, judges (double-pass), cross-checks', async () => {
    const { deps, calls } = harness();
    const r = await runArmEvalSession({ ...BASE, deps });
    assert.equal(r.state, 'ran');
    assert.equal(calls.session.length, 1);
    assert.equal(calls.run.length, 3);            // GPT + OSS-GLM + OSS-DS
    assert.equal(calls.output.length, 3);
    assert.equal(r.judged, true);
    // 3 arms × 2 passes = 6 judgment writes.
    assert.equal(calls.judgment.length, 6);
    // cross-checks: 4 checks × 3 conformant plans = 12.
    assert.equal(calls.crosscheck.length, 12);
    assert.deepEqual(r.conformance, { GPT: true, 'OSS-GLM': true, 'OSS-DS': true });
  });
  it('a non-conformant arm is excluded from judging but its run+conformance are recorded', async () => {
    const { deps, calls } = harness({
      producePlan: async ({ arm }) => arm.id === 'OSS-DS'
        ? { output: null, outputHash: null, conformant: false, resolvedModel: arm.models[0] }
        : { output: `plan ${arm.id}`, outputHash: `h-${arm.id}`, conformant: true, resolvedModel: arm.models[0] },
    });
    const r = await runArmEvalSession({ ...BASE, deps });
    assert.equal(r.conformance['OSS-DS'], false);
    assert.equal(calls.run.length, 3);            // all 3 runs recorded
    assert.equal(calls.output.length, 2);         // only conformant outputs
    assert.equal(calls.judgment.length, 4);       // 2 arms × 2 passes
  });
  it('does NOT judge with <2 conformant outputs', async () => {
    const { deps, calls } = harness({ producePlan: async ({ arm }) => arm.id === 'GPT' ? { output: 'p', outputHash: 'h', conformant: true, resolvedModel: 'x' } : { output: null, outputHash: null, conformant: false, resolvedModel: 'x' } });
    const r = await runArmEvalSession({ ...BASE, deps });
    assert.equal(r.judged, false);
    assert.equal(calls.judgment.length, 0);
  });
});

describe('runArmEvalSession — brainstorm', () => {
  it('runs brainstorm producer + no cross-checks (brainstorm has none)', async () => {
    const { deps, calls } = harness();
    const r = await runArmEvalSession({ ...BASE, experimentType: 'brainstorm', task: 'how to X', deps });
    assert.equal(r.state, 'ran');
    assert.equal(calls.run.length, 3);            // D, E, F
    assert.equal(calls.crosscheck.length, 0);     // brainstorm declares no cross-checks
  });
});

describe('hashTask — normalized, stable diversity id', () => {
  it('same text (whitespace/case-insensitive) → same id', () => {
    assert.equal(hashTask('Build  A Widget'), hashTask('build a widget'));
    assert.notEqual(hashTask('build a widget'), hashTask('build a gadget'));
    assert.match(hashTask('x'), /^task-[0-9a-f]{8}$/);
  });
});
