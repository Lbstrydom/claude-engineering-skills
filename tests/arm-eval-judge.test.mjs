/**
 * Tier-1 tests for the blinded rubric judge + repo-intent context pack.
 * Plan: docs/plans/arm-eval-framework.md §2/§10.3/§10.4/D8. Model call + file
 * reads are INJECTED — nothing hits an API or disk.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildIntentContext } from '../scripts/lib/arm-eval/intent-context.mjs';
import { judgeSession, scorableDimensions, judgePassSchema, extractJsonObject } from '../scripts/lib/arm-eval/judge.mjs';
import { RUBRIC_INTENT_DIMS, rubricFor } from '../scripts/lib/arm-eval/experiments.mjs';
import { redactSecrets as shapeRedact } from '../scripts/lib/secret-patterns.mjs';
import { redactSecrets as blanketRedact } from '../scripts/lib/sanitizer.mjs';

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
  it('recovers via ONE corrective retry when the first pass omits a dim (live-run fix)', async () => {
    // Real Opus dropped architectural_coherence/repo_intent_fidelity/acceptance_criteria_quality
    // on the first live calibration run. The retry must feed the error back + recover.
    const calls = [];
    let attempt = 0;
    const callJudge = async ({ prompt, schema, labels, dims, retry }) => {
      attempt++;
      calls.push({ retry: !!retry, corrective: /previous response was REJECTED/.test(prompt) });
      if (attempt === 1) return { conformant: false, result: null, error: 'scores.0.dims.correctness: expected number, received undefined' };
      const scores = labels.map((label) => ({ label, dims: Object.fromEntries(dims.map((d) => [d, 4])) }));
      const v = schema.safeParse({ scores });
      return { conformant: v.success, result: v.data };
    };
    const r = await judgeSession({ experimentType: 'plan-authoring', outputs: OUTPUTS, contextPack: 'INTENT', seed: 5, deps: { callJudge } });
    assert.equal(r.conformant, true, 'recovers after the corrective retry');
    assert.equal(r.passes.length, 2);
    assert.equal(calls[1].retry, true, 'second call is flagged as a retry');
    assert.equal(calls[1].corrective, true, 'retry prompt carries the CRITICAL corrective block with the prior error');
  });
  it('the judge redactor must NOT corrupt rubric dim names (live-run root cause)', () => {
    // Root cause of the first live calibration failure: the anthropic client's
    // DEFAULT redactor (sanitizer.mjs) blanket-redacts any 20+ char token, so it
    // rewrote the long rubric dim NAMES — which are the JSON keys — to
    // [REDACTED_TOKEN] in the OUTBOUND prompt; the model echoed the corrupted key
    // → schema fail. The judge must use the SHAPE redactor (secret-patterns.mjs),
    // which leaves identifiers intact. This test pins both halves so a future
    // redactor swap can't silently reintroduce the corruption.
    const dims = rubricFor('plan-authoring');
    const longDims = dims.filter((d) => d.length >= 20);
    assert.ok(longDims.includes('architectural_coherence'), 'sanity: a ≥20-char dim exists');
    for (const d of dims) {
      assert.equal(shapeRedact(d).text, d, `shape redactor must preserve dim name "${d}"`);
    }
    // …and prove the OLD default would have corrupted the long ones (the trap).
    for (const d of longDims) {
      assert.notEqual(blanketRedact(d), d, `blanket redactor corrupts "${d}" — why the override exists`);
    }
  });
  it('bounds the retry to ONE — two failures in a pass fail closed (≤2 calls/pass)', async () => {
    let n = 0;
    const r = await judgeSession({ experimentType: 'brainstorm', outputs: OUTPUTS, contextPack: null, seed: 1, deps: { callJudge: async () => { n++; return { conformant: false, result: null, error: 'still bad' }; } } });
    assert.equal(r.conformant, false);
    assert.equal(n, 2, 'exactly one retry then stop (no unbounded loop)');
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

// right_sizing rubric guidance (2026-07-04 de-confound) ─────────────────────
import { buildJudgePrompt, buildJudgePrompt as _bjp } from '../scripts/lib/arm-eval/judge.mjs';
import { RUBRIC_GUIDANCE } from '../scripts/lib/arm-eval/experiments.mjs';

describe('judge rubric — right_sizing gets an explicit concision definition', () => {
  const promptFor = () => buildJudgePrompt({
    experimentType: 'brainstorm',
    blindOutputs: [{ label: 'output-1', text: 'x' }, { label: 'output-2', text: 'y' }],
    dims: rubricFor('brainstorm'),
    contextPack: null,
  });

  it('right_sizing is rendered WITH its concision guidance, not a bare name', () => {
    const p = promptFor();
    assert.match(p, /- right_sizing: Concision relative to the ideas conveyed/);
    assert.match(p, /Length and structure are NOT thoroughness/);
    // the guidance text is the single source of truth
    assert.ok(p.includes(RUBRIC_GUIDANCE.right_sizing));
  });

  it('un-guided dims stay bare (sparse map — no re-baseline of working dims)', () => {
    const p = promptFor();
    assert.match(p, /- insight\n/);        // bare, no colon-definition
    assert.ok(!/- insight: /.test(p));
    assert.match(p, /- clarity\n/);
  });

  it('RUBRIC_GUIDANCE is deliberately sparse (only demonstrated mis-scorings)', () => {
    assert.deepEqual(Object.keys(RUBRIC_GUIDANCE), ['right_sizing']);
  });
});

// ── Judge transport failure is UNAVAILABLE + classified retry (fable-vs-opus §2.1) ────────────
// docs/plans/fable-vs-opus-decision-eval.md §2.1. At 809a615e callJudgeDefault's
// catch returned {conformant:false} for every error but [egress-gate], so an
// outage (ECONNRESET, 5xx, timeout) read exactly like a judge that answered
// badly — and judgeSession fed the transport error text back to the model as a
// "your previous response was REJECTED" schema correction.
describe('judge — transport failure is unavailable, and only a retryable one is retried', () => {
  it('callJudgeDefault: a thrown client error → unavailable:true, reason judge-transport', async () => {
    const { _internals } = await import('../scripts/lib/arm-eval/judge.mjs');
    const createClient = async () => ({ messages: { create: async () => { throw new Error('ECONNRESET socket hang up'); } } });
    const res = await _internals.callJudgeDefault({ prompt: 'score these', schema: judgePassSchema(['output-1'], ['correctness']) }, { createClient });
    assert.equal(res.unavailable, true, 'a transport failure must be marked unavailable');
    assert.equal(res.reason, 'judge-transport');
    assert.equal(res.conformant, false);
    assert.equal(res.result, null);
  });

  it('callJudgeDefault: a parsed-but-invalid answer stays a judge-quality failure (not unavailable)', async () => {
    const { _internals } = await import('../scripts/lib/arm-eval/judge.mjs');
    const createClient = async () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: '{"scores":[]}' }] }) } });
    const res = await _internals.callJudgeDefault({ prompt: 'score these', schema: judgePassSchema(['output-1'], ['correctness']) }, { createClient });
    assert.equal(res.conformant, false);
    assert.ok(!res.unavailable, 'a bad answer is not unavailable — the judge answered, badly');
  });

  it('judgeSession: persistent RETRYABLE transport failure → unavailable, one plain retry (no corrective nudge)', async () => {
    const prompts = [];
    const callJudge = async ({ prompt }) => { prompts.push(prompt); return { conformant: false, unavailable: true, retryable: true, reason: 'judge-transport', result: null, error: 'ECONNRESET socket hang up' }; };
    const r = await judgeSession({ experimentType: 'brainstorm', outputs: OUTPUTS, contextPack: null, seed: 1, deps: { callJudge } });
    assert.equal(r.unavailable, true, 'the session reports the judge as unavailable');
    assert.equal(r.conformant, false);
    assert.equal(r.passes.length, 0, 'nothing scored');
    assert.equal(prompts.length, 2, 'exactly one retry');
    assert.ok(!/previous response was REJECTED/.test(prompts[1]), 'a transport error is not a schema rejection');
    assert.ok(!prompts[1].includes('ECONNRESET'), 'the transport error text never reaches the model');
  });

  it('a non-429 4xx (auth) is unavailable and NOT retried', async () => {
    const { _internals } = await import('../scripts/lib/arm-eval/judge.mjs');
    const createClient = async () => ({ messages: { create: async () => { throw Object.assign(new Error('invalid x-api-key'), { status: 401 }); } } });
    const res = await _internals.callJudgeDefault({ prompt: 'p', schema: judgePassSchema(['output-1'], ['correctness']) }, { createClient });
    assert.equal(res.unavailable, true);
    assert.equal(res.retryable, false);
    let calls = 0;
    const r = await judgeSession({ experimentType: 'brainstorm', outputs: OUTPUTS, contextPack: null, seed: 1, deps: { callJudge: async () => { calls++; return res; } } });
    assert.equal(r.unavailable, true);
    assert.equal(calls, 1, 'a 401 is not retried');
  });

  it('judgeSession: a transient transport failure recovers on the plain retry', async () => {
    let n = 0;
    const ok = fakeJudge([]);
    const callJudge = async (args) => { n++; if (n === 1) return { conformant: false, unavailable: true, retryable: true, reason: 'judge-transport', result: null, error: 'HTTP 503' }; return ok(args); };
    const r = await judgeSession({ experimentType: 'brainstorm', outputs: OUTPUTS, contextPack: null, seed: 1, deps: { callJudge } });
    assert.equal(r.conformant, true);
    assert.ok(!r.unavailable);
    assert.equal(r.passes.length, 2);
  });
});

// ── UNAVAILABLE is not NON-CONFORMANT (2026-11-15) ─────────────────────────
//
// `callJudgeDefault`'s catch returned `{ conformant: false, error }` for EVERY
// throw except the egress gate. So a missing credential, a refused route or the
// new seam refusal all arrived as a judgement about the judge's OUTPUT — "the
// judge failed to conform" — which is the same conflation (a transport failure
// wearing a result's clothes) that the throw-and-pin change exists to end one
// layer down. Pinning these sites to the sdk backend makes it reachable on a
// keyless install, so it is load-bearing for that change, not adjacent to it.
//
// `conformant` stays false either way, so every existing consumer still fails
// closed; `unavailable` is what lets a reader tell the two apart.
describe('judgeSession: a judge that never ran is distinguishable', () => {
  const unavailableJudge = (calls) => async (args) => {
    calls.push(args);
    return { conformant: false, unavailable: true, result: null, error: 'ANTHROPIC_API_KEY required', latencyMs: 1 };
  };
  const badJsonJudge = (calls) => async (args) => {
    calls.push(args);
    return { conformant: false, result: null, error: 'judge returned no JSON', latencyMs: 1 };
  };

  it('an UNAVAILABLE judge propagates the flag', async () => {
    const calls = [];
    const r = await judgeSession({
      experimentType: 'plan-authoring', outputs: OUTPUTS, contextPack: 'INTENT', seed: 1,
      deps: { callJudge: unavailableJudge(calls) },
    });
    assert.equal(r.conformant, false, 'still fails closed for every existing consumer');
    assert.equal(r.unavailable, true, 'and a reader can tell no answer was obtained');
    assert.match(r.error, /ANTHROPIC_API_KEY/);
  });

  // The corrective retry exists for a model that omitted a rubric dimension. It
  // is pointless — and doubles the spend — when no answer was obtained: a
  // missing credential does not become present because the prompt was reworded.
  it('an UNAVAILABLE judge is NOT retried with a corrective prompt', async () => {
    const calls = [];
    await judgeSession({
      experimentType: 'plan-authoring', outputs: OUTPUTS, contextPack: 'INTENT', seed: 1,
      deps: { callJudge: unavailableJudge(calls) },
    });
    assert.equal(calls.length, 1, 'one attempt, not two');
    assert.ok(!calls.some((c) => c.retry), 'and none of them a retry');
  });

  // POSITIVE CONTROL for the line above: a genuinely non-conformant judge MUST
  // still get its retry, or this change would have removed the recovery path it
  // was only meant to skip.
  it('a NON-CONFORMANT judge still gets exactly one corrective retry', async () => {
    const calls = [];
    const r = await judgeSession({
      experimentType: 'plan-authoring', outputs: OUTPUTS, contextPack: 'INTENT', seed: 1,
      deps: { callJudge: badJsonJudge(calls) },
    });
    assert.equal(calls.length, 2, 'the corrective retry is intact');
    assert.equal(calls[1].retry, true);
    assert.equal(r.conformant, false);
    assert.ok(!('unavailable' in r), 'and it is NOT labelled unavailable — the judge answered, badly');
  });
});
