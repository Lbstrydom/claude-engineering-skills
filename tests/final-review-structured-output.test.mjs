/**
 * @fileoverview The openai final-review transport must ASK for the schema, not
 * describe it in prose — and must not do so on routes that share the adapter.
 *
 * Why (experiment-4, 2026-07-28): the openai transport only appended "Output
 * strictly valid JSON" to the system prompt. Opus complied because the
 * anthropic transport FORCES a `submit_review` tool call carrying the real
 * schema, so OpenAI-side arms were judged against a contract they were never
 * given. Measured: kimi-k3 returned `{file,title,description,evidence}` and
 * glm-5.2 returned `{title,description,evidence_basis,cited_lines}` — neither
 * carrying `category`/`section`/`risk`/`recommendation`, which the finding
 * taxonomy and R2+ suppression ledger key on. Zod validation here is
 * warn-and-keep, so those degraded rows reached the store silently.
 *
 * The Azure-parity case is the one that guards a regression in the OTHER
 * direction: Azure Foundry's openai shape shares this adapter and must keep
 * sending a byte-identical body.
 *
 * @module tests/final-review-structured-output
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/gemini-review.mjs';

const { REVIEW_TRANSPORTS, PROVIDERS } = _internals;

/** Minimal fake client capturing the request body; optionally throwing first. */
function fakeClient({ throwFirst = null } = {}) {
  const bodies = [];
  let thrown = false;
  return {
    bodies,
    chat: {
      completions: {
        create: async (body) => {
          bodies.push(structuredClone(body));
          if (throwFirst && !thrown) { thrown = true; throw throwFirst; }
          return {
            choices: [{ message: { content: '{"verdict":"APPROVE"}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      },
    },
  };
}

const baseArgs = { model: 'm', maxTokens: 100, systemPrompt: 'sys', userPrompt: 'usr', signal: undefined };
const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } } };

describe('openai final-review transport — structured output', () => {
  it('sends response_format:json_schema when a schema is supplied', async () => {
    const c = fakeClient();
    await REVIEW_TRANSPORTS.openai(c, { ...baseArgs, openAiJsonSchema: SCHEMA });
    const rf = c.bodies[0].response_format;
    assert.equal(rf?.type, 'json_schema');
    assert.deepEqual(rf.json_schema.schema, SCHEMA);
    assert.match(rf.json_schema.name, /^[a-zA-Z0-9_-]{1,64}$/, 'schema name must match the provider-accepted shape');
  });

  it('AZURE PARITY: omits response_format entirely when no schema is supplied', async () => {
    const c = fakeClient();
    await REVIEW_TRANSPORTS.openai(c, { ...baseArgs });
    assert.ok(!('response_format' in c.bodies[0]),
      'a route that did not opt in must send a byte-identical body');
  });

  it('degrades ONCE to prompt-only when the router rejects response_format', async () => {
    const err = Object.assign(new Error('response_format is not supported by this provider'), { status: 400 });
    const c = fakeClient({ throwFirst: err });
    const r = await REVIEW_TRANSPORTS.openai(c, { ...baseArgs, openAiJsonSchema: SCHEMA });
    assert.equal(c.bodies.length, 2, 'exactly one retry');
    assert.ok('response_format' in c.bodies[0]);
    assert.ok(!('response_format' in c.bodies[1]), 'the retry must drop response_format');
    assert.equal(r.text, '{"verdict":"APPROVE"}');
  });

  it('does NOT mask an unrelated 400 as a format downgrade', async () => {
    // A bad-model / quota 400 must surface, not silently become a prompt-only
    // review — otherwise a broken config reads as a successful gate.
    const err = Object.assign(new Error('model not found'), { status: 400 });
    const c = fakeClient({ throwFirst: err });
    await assert.rejects(
      () => REVIEW_TRANSPORTS.openai(c, { ...baseArgs, openAiJsonSchema: SCHEMA }),
      /model not found/,
    );
    assert.equal(c.bodies.length, 1, 'must not retry an unrelated error');
  });

  it('only the explicitly-selected OpenAI-compatible routes opt in', () => {
    assert.equal(PROVIDERS.openrouter.structuredOutput, true);
    assert.equal(PROVIDERS['openai-compatible'].structuredOutput, true);
    for (const id of ['gemini', 'anthropic', 'azure-claude']) {
      assert.ok(!PROVIDERS[id]?.structuredOutput,
        `${id} must not opt in — azure-claude shares the openai adapter`);
    }
  });
});
