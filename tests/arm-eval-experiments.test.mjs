/**
 * Tier-1 (pure) tests for the arm-eval experiment/rubric config + self-preference guard.
 * Plan: docs/plans/arm-eval-framework.md D1/D2/§10.2.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_EXPERIMENTS, RUBRIC_CORE, RUBRIC_INTENT_DIMS, RUBRIC_EXT, OSS_ROTATION,
  rubricFor, validateArm, validateExperiment, isClaudeFamily, getExperiment,
} from '../scripts/lib/arm-eval/experiments.mjs';

describe('arm-eval experiments — canonical configs', () => {
  it('plan-authoring + brainstorm validate; baseline is an arm', () => {
    for (const [key, exp] of Object.entries(CANONICAL_EXPERIMENTS)) {
      const v = validateExperiment(exp);
      assert.equal(v.ok, true, `${key}: ${v.ok ? '' : v.error}`);
      assert.ok(exp.arms.some((a) => a.id === exp.baselineArm), `${key} baseline must be an arm`);
    }
  });
  it('plan baseline is GPT; brainstorm baseline is D (GPT+Gemini)', () => {
    assert.equal(CANONICAL_EXPERIMENTS['plan-authoring'].baselineArm, 'GPT');
    assert.equal(CANONICAL_EXPERIMENTS.brainstorm.baselineArm, 'D');
  });
  it('no canonical arm contains a Claude model (self-preference guard holds)', () => {
    for (const exp of Object.values(CANONICAL_EXPERIMENTS)) {
      for (const arm of exp.arms) {
        for (const m of arm.models) assert.equal(isClaudeFamily(m), false, `${arm.id}/${m} must not be Claude`);
      }
    }
  });
  it('getExperiment throws on unknown', () => {
    assert.throws(() => getExperiment('nope'), /unknown experiment/);
  });
});

describe('arm-eval — self-preference guard', () => {
  it('rejects an arm with a Claude sentinel', () => {
    const r = validateArm({ id: 'X', label: 'x', models: ['latest-opus'] });
    assert.equal(r.ok, false);
    assert.match(r.error, /self-preference|Claude/);
  });
  it('rejects an arm with a concrete claude id', () => {
    assert.equal(validateArm({ id: 'X', label: 'x', models: ['claude-opus-4-8'] }).ok, false);
    assert.equal(isClaudeFamily('claude-sonnet-4-6'), true);
    assert.equal(isClaudeFamily('latest-haiku'), true);
  });
  it('accepts GPT / Gemini / OSS models', () => {
    assert.equal(validateArm({ id: 'A', label: 'a', models: ['latest-gpt'] }).ok, true);
    assert.equal(validateArm({ id: 'B', label: 'b', models: ['z-ai/glm-5.2', 'latest-pro'], role: 'combination' }).ok, true);
    assert.equal(isClaudeFamily('z-ai/glm-5.2'), false);
    assert.equal(isClaudeFamily('latest-gpt'), false);
    assert.equal(isClaudeFamily('deepseek/deepseek-v4-pro'), false);
  });
  it('rejects a bad arm id + duplicate arm ids', () => {
    assert.equal(validateArm({ id: '', label: 'x', models: ['latest-gpt'] }).ok, false);
    const dup = validateExperiment({ experimentType: 'brainstorm', baselineArm: 'A', arms: [
      { id: 'A', label: 'a', models: ['latest-gpt'] }, { id: 'A', label: 'a2', models: ['latest-pro'] },
    ] });
    assert.equal(dup.ok, false);
    assert.match(dup.error, /unique/);
  });
});

describe('arm-eval — rubric', () => {
  it('rubricFor = core + per-experiment extension; intent dims are in core', () => {
    const plan = rubricFor('plan-authoring');
    assert.deepEqual(plan, [...RUBRIC_CORE, ...RUBRIC_EXT['plan-authoring']]);
    for (const d of RUBRIC_INTENT_DIMS) assert.ok(RUBRIC_CORE.includes(d));
    assert.ok(rubricFor('brainstorm').includes('insight'));
  });
  it('OSS_ROTATION lists concrete OSS ids, none Claude', () => {
    assert.ok(OSS_ROTATION.length >= 2);
    for (const m of OSS_ROTATION) assert.equal(isClaudeFamily(m), false);
  });
});
