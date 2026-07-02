/**
 * Tier-1 tests for the blinded rubric judge + repo-intent context pack.
 * Plan: docs/plans/arm-eval-framework.md §2/§10.3/§10.4/D8. Model call + file
 * reads are INJECTED — nothing hits an API or disk.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildIntentContext } from '../scripts/lib/arm-eval/intent-context.mjs';
import { judgeSession, scorableDimensions, judgePassSchema, extractJsonObject } from '../scripts/lib/arm-eval/judge.mjs';
import { RUBRIC_INTENT_DIMS } from '../scripts/lib/arm-eval/experiments.mjs';

// ── intent-context ────────────────────────────────────────────────────────────
function fakeFs(files) {
  return { exists: (p) => Object.keys(files).some((k) => p.endsWith(k)), readFile: (p) => { const k = Object.keys(files).find((k) => p.endsWith(k)); return files[k]; } };
}

describe('intent-context — D8 pack', () => {
  it('absent artifacts → present:false, pack null, intent NOT scorable', () => {
    const r = buildIntentContext({ deps: fakeFs({}) });
    assert.equal(r.present, false);
    assert.equal(r.pack, null);
    assert.equal(r.intentScorable, false);
  });
  it('includes domain-map allowedDeps AND rules (Gemini-R2 fix)', () => {
    const dm = JSON.stringify({ allowedDeps: { a: ['b'] }, rules: [{ glob: 'src/a/**', domain: 'a' }], other: 'ignored' });
    const r = buildIntentContext({ deps: fakeFs({ 'domain-map.json': dm, 'architecture-map.md': '# map\nsym1' }) });
    assert.equal(r.present, true);
    assert.equal(r.intentScorable, true);
    assert.match(r.pack, /allowedDeps/);
    assert.match(r.pack, /rules/);
    assert.ok(r.sources.includes('domain-map'));
    assert.ok(r.sources.includes('architecture-map'));
  });
  it('summarizes only ACTIVE requirements', () => {
    const led = JSON.stringify({ requirements: [{ id: 'R1', statement: 'must X', status: 'active' }, { id: 'R2', statement: 'old', status: 'retired' }] });
    const r = buildIntentContext({ deps: fakeFs({ 'ledger.json': led }) });
    assert.match(r.pack, /R1/);
    assert.doesNotMatch(r.pack, /R2/);
  });
  it('malformed domain-map is skipped, not fatal', () => {
    const r = buildIntentContext({ deps: fakeFs({ 'domain-map.json': '{not json', 'architecture-map.md': '# ok' }) });
    assert.equal(r.present, true);      // arch-map still counts
    assert.ok(!r.sources.includes('domain-map'));
  });
});

// ── judge ─────────────────────────────────────────────────────────────────────
const OUTPUTS = [
  { arm: 'GPT', outputHash: 'h1', text: 'plan A' },
  { arm: 'OSS-GLM', outputHash: 'h2', text: 'plan B' },
  { arm: 'OSS-DS', outputHash: 'h3', text: 'plan C' },
];

/** A fake judge that scores every label 4 on every dim, and records what it saw. */
function fakeJudge(seen) {
  return async ({ prompt, schema, labels, dims, pass }) => {
    seen.push({ prompt, labels, dims, pass });
    const scores = labels.map((label) => ({ label, dims: Object.fromEntries(dims.map((d) => [d, 4])) }));
    const v = schema.safeParse({ scores });
    return { conformant: v.success, result: v.success ? v.data : null, error: v.success ? null : 'schema' };
  };
}

describe('judge — blinding, order-randomization, double-pass', () => {
  it('blinds arm identity (labels only; arm never in the prompt) + double-passes', async () => {
    const seen = [];
    const r = await judgeSession({ experimentType: 'plan-authoring', outputs: OUTPUTS, contextPack: 'INTENT', seed: 3, deps: { callJudge: fakeJudge(seen) } });
    assert.equal(r.conformant, true);
    assert.equal(r.passes.length, 2, 'judged twice');
    assert.deepEqual(r.presentationOrder.slice().sort(), ['output-1', 'output-2', 'output-3']);
    for (const s of seen) {
      for (const arm of ['GPT', 'OSS-GLM', 'OSS-DS']) assert.ok(!s.prompt.includes(arm), `arm ${arm} must not leak into the prompt`);
    }
    // label→arm map is returned for post-hoc unblinding, covers all arms.
    assert.deepEqual(Object.values(r.labelToArm).sort(), ['GPT', 'OSS-DS', 'OSS-GLM']);
  });
  it('same seed → same presentation order (replayable)', async () => {
    const a = await judgeSession({ experimentType: 'plan-authoring', outputs: OUTPUTS, contextPack: 'X', seed: 42, deps: { callJudge: fakeJudge([]) } });
    const b = await judgeSession({ experimentType: 'plan-authoring', outputs: OUTPUTS, contextPack: 'X', seed: 42, deps: { callJudge: fakeJudge([]) } });
    assert.deepEqual(a.labelToArm, b.labelToArm);
  });
  it('intent dims are DROPPED + marked unscored when no context pack', async () => {
    const seen = [];
    const r = await judgeSession({ experimentType: 'plan-authoring', outputs: OUTPUTS, contextPack: null, seed: 1, deps: { callJudge: fakeJudge(seen) } });
    assert.equal(r.intentDims, 'unscored');
    for (const d of RUBRIC_INTENT_DIMS) assert.ok(!r.dims.includes(d), `${d} must not be scored without a pack`);
    // and the intent dims aren't asked for in the prompt
    for (const d of RUBRIC_INTENT_DIMS) assert.ok(!seen[0].dims.includes(d));
  });
  it('intent dims ARE scored when a pack is present', async () => {
    const r = await judgeSession({ experimentType: 'plan-authoring', outputs: OUTPUTS, contextPack: 'INTENT', seed: 1, deps: { callJudge: fakeJudge([]) } });
    assert.equal(r.intentDims, 'scored');
    for (const d of RUBRIC_INTENT_DIMS) assert.ok(r.dims.includes(d));
  });
  it('a non-conformant judge pass fails closed (conformant:false, no fabricated scores)', async () => {
    const r = await judgeSession({ experimentType: 'brainstorm', outputs: OUTPUTS, contextPack: null, seed: 1, deps: { callJudge: async () => ({ conformant: false, result: null, error: 'bad json' }) } });
    assert.equal(r.conformant, false);
    assert.equal(r.passes.length, 0);
  });
  it('extractJsonObject grabs the balanced object, not greedy-to-last-brace (Gemini gate)', () => {
    assert.equal(extractJsonObject('prose {"a":1} more prose { not json'), '{"a":1}');
    assert.equal(extractJsonObject('{"a":{"b":2}} trailing {junk'), '{"a":{"b":2}}');
    assert.equal(extractJsonObject('a "quoted } brace" then {"x":"y}"}'), '{"x":"y}"}'); // string-aware
    assert.equal(extractJsonObject('no json here'), null);
    assert.equal(extractJsonObject('{ unbalanced'), null);
  });
  it('scorableDimensions drops intent dims iff no pack', () => {
    assert.ok(scorableDimensions('plan-authoring', true).includes('architectural_coherence'));
    assert.ok(!scorableDimensions('plan-authoring', false).includes('architectural_coherence'));
  });
  it('judgePassSchema enforces 1–5 integers for each label', () => {
    const s = judgePassSchema(['output-1'], ['correctness']);
    assert.equal(s.safeParse({ scores: [{ label: 'output-1', dims: { correctness: 4 } }] }).success, true);
    assert.equal(s.safeParse({ scores: [{ label: 'output-1', dims: { correctness: 9 } }] }).success, false);
  });
  it('judgePassSchema rejects a DUPLICATE label + omission (audit R1 fbad4aa6)', () => {
    const s = judgePassSchema(['output-1', 'output-2'], ['correctness']);
    // right length (2) but output-1 twice, output-2 missing → must reject.
    const dup = s.safeParse({ scores: [
      { label: 'output-1', dims: { correctness: 4 } },
      { label: 'output-1', dims: { correctness: 5 } },
    ] });
    assert.equal(dup.success, false);
    // a true permutation passes.
    assert.equal(s.safeParse({ scores: [
      { label: 'output-1', dims: { correctness: 4 } },
      { label: 'output-2', dims: { correctness: 3 } },
    ] }).success, true);
  });
});
