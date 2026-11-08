import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capReasoning } from '../scripts/lib/reasoning-ceiling.mjs';

test('capReasoning lowers a tier above the ceiling', () => {
  assert.equal(capReasoning('high', 'medium'), 'medium');
  assert.equal(capReasoning('high', 'low'), 'low');
  assert.equal(capReasoning('medium', 'low'), 'low');
});

test('capReasoning never raises a tier below the ceiling', () => {
  assert.equal(capReasoning('low', 'medium'), 'low');
  assert.equal(capReasoning('low', 'high'), 'low');
  assert.equal(capReasoning('medium', 'high'), 'medium');
});

test('the default ceiling (high) clamps nothing', () => {
  for (const t of ['low', 'medium', 'high']) assert.equal(capReasoning(t, 'high'), t);
});

test('an unknown tier or ceiling passes the tier through untouched', () => {
  assert.equal(capReasoning('xhigh', 'medium'), 'xhigh');
  assert.equal(capReasoning('high', 'bogus'), 'high');
  assert.equal(capReasoning(undefined, 'medium'), undefined);
});

// The emitted request, not the helper: config is frozen at import, so each
// ceiling runs in a fresh process with the env set explicitly.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const HELPERS = pathToFileURL(path.resolve('scripts/lib/audit/llm-helpers.mjs')).href;
const probeSource = (tier, fail) => `
import { z } from 'zod';
import { _callGPTOnce, safeCallGPT } from ${JSON.stringify(HELPERS)};
let sent = null;
const usage = { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const openai = { responses: { parse: async (p) => {
  sent = p?.reasoning?.effort ?? null;
  if (${fail}) throw Object.assign(new Error('bad request'), { status: 400 });
  return { status: 'completed', output: [], output_parsed: { findings: [] }, usage };
} } };
const opts = { system: 's', messages: [{ role: 'user', content: 'u' }],
  schema: z.object({ findings: z.array(z.string()) }).strict(), schemaName: 't', reasoning: ${JSON.stringify(tier)},
  maxTokens: 100, timeoutMs: 5000, passName: 'probe' };
const out = ${fail} ? await safeCallGPT(openai, opts, { findings: [] }) : await _callGPTOnce(openai, opts);
console.log(JSON.stringify({ sent, recorded: out.reasoningEffort }));
`;

function probe(ceiling, tier, { fail = false } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AZURE_')));
  env.OPENAI_AUDIT_REASONING = ceiling;
  env.MODEL_CATALOG_REFRESH = 'skip';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probeSource(tier, fail)], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('a high pass is SENT at a medium ceiling, and telemetry records what was sent', () => {
  assert.deepEqual(probe('medium', 'high'), { sent: 'medium', recorded: 'medium' });
});

test('a low pass is never RAISED by a medium ceiling', () => {
  assert.deepEqual(probe('medium', 'low'), { sent: 'low', recorded: 'low' });
});

test('a FAILED call records the clamped effort it dispatched', () => {
  assert.deepEqual(probe('medium', 'high', { fail: true }), { sent: 'medium', recorded: 'medium' });
});

test('negative control: ceiling high sends the pass tier unchanged', () => {
  assert.deepEqual(probe('high', 'high'), { sent: 'high', recorded: 'high' });
});

// The shadow's parity test reads the ceiling from the environment, so run it
// under a ceiling that actually clamps, not only under the ambient one.
for (const ceiling of ['medium', 'high']) {
  test(`shadow parity suite passes with ceiling=${ceiling}`, () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AZURE_')));
    env.OPENAI_AUDIT_REASONING = ceiling;
    env.MODEL_CATALOG_REFRESH = 'skip';
    delete env.NODE_TEST_CONTEXT; // else the child reports to OUR runner, not stdout
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=D4a parity', 'tests/audit-shadow.test.mjs'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout.slice(-2000));
    assert.match(r.stdout, /# pass [1-9]/);
  });
}
