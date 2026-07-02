/**
 * Tier-1 tests for the arm-eval producers + cross-checks.
 * Plan: docs/plans/arm-eval-framework.md §10.2/§10.5. Model calls + check deps
 * are INJECTED — nothing hits an API.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { producePlan } from '../scripts/lib/arm-eval/producers/plan.mjs';
import { produceBrainstorm } from '../scripts/lib/arm-eval/producers/brainstorm.mjs';
import { parsePlanIntent, buildPlanGenPrompt, PLAN_SYSTEM } from '../scripts/lib/arm-eval/plan-seed.mjs';
import { runCrossChecks, CROSS_CHECK_VERSION } from '../scripts/lib/arm-eval/cross-checks.mjs';
import { providerFor } from '../scripts/lib/arm-eval/producers/model-call.mjs';

const GOOD_PLAN = `# Plan: thing
## Overview
Do the thing well, right-sized.
## Target Paths
- scripts/lib/foo.mjs
- tests/foo.test.mjs
## Section 9 — Acceptance Criteria
1. foo() returns bar
2. errors are handled
`.padEnd(260, ' ');

describe('plan-seed — parse + prompt', () => {
  it('parsePlanIntent extracts target paths + acceptance criteria', () => {
    const i = parsePlanIntent(GOOD_PLAN);
    assert.ok(i.parseable);
    assert.deepEqual(i.targetPaths, ['scripts/lib/foo.mjs', 'tests/foo.test.mjs']);
    assert.equal(i.acceptanceCriteria.length, 2);
  });
  it('parsePlanIntent requires BOTH blocks (Gemini-gate fix — not OR)', () => {
    assert.equal(parsePlanIntent('just prose, no blocks').parseable, false);
    const onlyPaths = '## Target Paths\n- a.mjs\n';
    const onlyAC = '## Section 9 — Acceptance Criteria\n1. does X\n';
    assert.equal(parsePlanIntent(onlyPaths).parseable, false, 'target paths alone is not enough');
    assert.equal(parsePlanIntent(onlyAC).parseable, false, 'criteria alone is not enough');
    assert.equal(parsePlanIntent(GOOD_PLAN).parseable, true, 'both present → parseable');
  });
  it('parsePlanIntent extracts BACKTICK-wrapped + annotated paths (Gemini gate)', () => {
    const plan = '## Target Paths\n- `scripts/lib/foo.mjs` (create)\n- `tests/foo.test.mjs` — the test\n## Section 9 — Acceptance Criteria\n1. ok\n';
    const i = parsePlanIntent(plan);
    assert.deepEqual(i.targetPaths, ['scripts/lib/foo.mjs', 'tests/foo.test.mjs']);
  });
  it('buildPlanGenPrompt includes the task + omits context when absent', () => {
    assert.match(buildPlanGenPrompt('T'), /## Task\nT/);
    assert.doesNotMatch(buildPlanGenPrompt('T'), /Repository context/);
    assert.match(buildPlanGenPrompt('T', 'CTX'), /Repository context/);
  });
});

describe('producePlan', () => {
  const arm = { id: 'OSS-GLM', label: 'x', models: ['z-ai/glm-5.2'], role: 'author' };
  it('conformant plan (intent block + length) → conformant:true + hash', async () => {
    const seen = [];
    const r = await producePlan({ task: 'build X', arm, contextPack: null, deps: { callModel: async (a) => { seen.push(a); return { text: GOOD_PLAN, usage: {} }; } } });
    assert.equal(r.conformant, true);
    assert.ok(r.outputHash);
    assert.equal(r.resolvedModel, 'z-ai/glm-5.2');
    assert.equal(seen[0].model, 'z-ai/glm-5.2'); // single-model author
    assert.equal(seen[0].system, PLAN_SYSTEM);
  });
  it('short / no-intent plan → conformant:false (no survivorship flattery)', async () => {
    const r = await producePlan({ task: 'build X', arm, deps: { callModel: async () => ({ text: 'too short, no blocks', usage: {} }) } });
    assert.equal(r.conformant, false);
    assert.match(r.error, /intent block|short|empty/);
  });
  it('a secret in the task aborts BEFORE the model call (egress)', async () => {
    const secret = ['sk', 'abcdefghij0123456789ABCDEFGHIJ'].join('-');
    let called = false;
    await assert.rejects(
      () => producePlan({ task: `use key ${secret}`, arm, deps: { callModel: async () => { called = true; return { text: GOOD_PLAN }; } } }),
      /egress-gate|refusing/,
    );
    assert.equal(called, false);
  });
});

describe('produceBrainstorm', () => {
  const arm = { id: 'E', label: 'x', models: ['z-ai/glm-5.2', 'latest-pro'], role: 'combination' };
  it('calls BOTH legs then synthesizes with the arm\'s first model (never Claude)', async () => {
    const calls = [];
    const r = await produceBrainstorm({ topic: 'how to X', arm, deps: { callModel: async (a) => { calls.push(a.model); return { text: `A reasonably long synthesized brainstorm take from ${a.model} about the topic, covering several distinct angles, trade-offs, and concrete actionable next steps worth padding well past the conformance floor.`, usage: {} }; } } });
    assert.equal(r.conformant, true);
    // two legs (glm, pro) + one synthesis (glm again).
    assert.deepEqual(calls, ['z-ai/glm-5.2', 'latest-pro', 'z-ai/glm-5.2']);
    for (const m of calls) assert.ok(!/claude|opus|sonnet|haiku/i.test(m));
  });
  it('requires a ≥2-model combination arm', async () => {
    await assert.rejects(() => produceBrainstorm({ topic: 'x', arm: { id: 'Z', models: ['latest-gpt'] } }), /≥2|combination/);
  });
  it('fails closed if EITHER leg is empty (no degraded single-model combination — Gemini gate)', async () => {
    const arm = { id: 'E', label: 'x', models: ['z-ai/glm-5.2', 'latest-pro'], role: 'combination' };
    let synthCalled = false;
    const r = await produceBrainstorm({ topic: 'how to X', arm, deps: { callModel: async (a) => {
      if (a.system.includes('synthesizing')) { synthCalled = true; return { text: 'synth' }; }
      return { text: a.model === 'latest-pro' ? '' : 'a full take from the first leg here'.padEnd(120, '.') };
    } } });
    assert.equal(r.conformant, false);
    assert.match(r.error, /leg empty/);
    assert.equal(synthCalled, false, 'must not synthesize from one empty leg');
  });
});

describe('runCrossChecks — dispatch + fail-closed', () => {
  it('unavailable when a dep is not wired (never a fabricated pass)', async () => {
    const r = await runCrossChecks({ checks: ['audit-proxy'], planText: GOOD_PLAN, deps: {} });
    assert.equal(r[0].status, 'unavailable');
    assert.equal(r[0].checkVersion, CROSS_CHECK_VERSION);
  });
  it('arch-memory-reuse: unavailable with no target paths; INFORMATIONAL (never a penalty) otherwise', async () => {
    const noPaths = await runCrossChecks({ checks: ['arch-memory-reuse'], planIntent: { targetPaths: [] }, deps: { getNeighbourhood: async () => ({ records: [] }) } });
    assert.equal(noPaths[0].status, 'unavailable');
    // Gemini-gate fix: reuse candidates existing nearby is NOT a reinvention
    // penalty — status stays 'ok', the candidates are reported as context.
    const info = await runCrossChecks({ checks: ['arch-memory-reuse'], planIntent: { targetPaths: ['a.mjs'] }, deps: { getNeighbourhood: async () => ({ records: [{ recommendation: 'reuse' }, { recommendation: 'review' }] }) } });
    assert.equal(info[0].status, 'ok');
    assert.equal(info[0].score, null);
    assert.equal(info[0].findings.length, 1); // the one 'reuse' candidate, reported not penalized
  });
  it('audit-proxy reports defect load as score', async () => {
    const r = await runCrossChecks({ checks: ['audit-proxy'], planText: GOOD_PLAN, deps: { auditProxy: async () => ({ load: 12, runId: 'run-1' }) } });
    assert.equal(r[0].status, 'ok');
    assert.equal(r[0].score, 12);
    assert.deepEqual(r[0].evidenceRefs, { auditRunId: 'run-1' });
  });
  it('unknown check → error envelope, never silent', async () => {
    const r = await runCrossChecks({ checks: ['nope'], deps: {} });
    assert.equal(r[0].status, 'error');
    assert.match(r[0].failureReason, /unknown/);
  });
});

describe('model-call — provider routing (Gemini gate fix)', () => {
  it('classifies OSS / Gemini / GPT correctly — a slash-less Gemini id is NOT GPT', () => {
    assert.equal(providerFor('z-ai/glm-5.2'), 'oss');
    assert.equal(providerFor('deepseek/deepseek-v4-pro'), 'oss');
    assert.equal(providerFor('gemini-pro-latest'), 'gemini');   // latest-pro resolves here → must NOT be gpt
    assert.equal(providerFor('gemini-2.5-flash'), 'gemini');
    assert.equal(providerFor('gpt-5.5'), 'gpt');
  });
});
