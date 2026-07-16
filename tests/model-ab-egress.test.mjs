/**
 * Tier-3 (HARD — egress) tests for the model-A/B/C harness. Plan §9.
 *
 * The OSS arm sends our source to a NEW external provider (OpenRouter). These
 * tests prove: (a) the egress gate FIRES on the OSS adapter payload path before
 * any client call; (b) redact-once excludes a sensitive file's content from the
 * shadow's context; (c) an unset shadow constructs NO OSS client; plus the
 * adapter's conformance classification (decision 6).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { scanEgressPayload, assertEgressSafe } from '../scripts/lib/sensitive-egress-gate.mjs';
import { buildRedactedAuditContext } from '../scripts/lib/audit-scope.mjs';
import { ossStructuredCall, sanitizeSchemaName } from '../scripts/lib/oss-structured-output.mjs';
import { resolveArms } from '../scripts/lib/audit-arms.mjs';
import { createOpenAIClient, _resetClientCache } from '../scripts/lib/openai-client.mjs';

// Assembled at runtime so an OpenAI-key-shaped literal never sits in source at
// rest (would trip our own egress/quickfix scanners on this file — audit R1 L3).
const FAKE_SECRET = ['sk', 'abcdefghij0123456789ABCDEFGHIJ'].join('-');   // >20 chars after sk-

// A tiny pass-result schema standing in for a real audit pass schema.
const PassSchema = z.object({
  findings: z.array(z.object({ id: z.string(), detail: z.string() })),
  summary: z.string(),
});

// `usage: null` → the completion carries NO usage block (missing-usage case).
function fakeClient({ content, usage = { prompt_tokens: 12, completion_tokens: 7 }, finish_reason = 'stop', throwErr = null, record } = {}) {
  return {
    chat: {
      completions: {
        create: async (params) => {
          if (record) record.push(params);
          if (throwErr) throw throwErr;
          const completion = { choices: [{ message: { content }, finish_reason }] };
          if (usage) completion.usage = usage;
          return completion;
        },
      },
    },
  };
}

describe('egress gate — scan + assert', () => {
  it('scanEgressPayload flags a secret and passes clean text', () => {
    assert.equal(scanEgressPayload(`const k = "${FAKE_SECRET}"`).safe, false);
    assert.equal(scanEgressPayload('function add(a, b) { return a + b; }').safe, true);
  });
  it('assertEgressSafe throws on a secret, returns true on clean', () => {
    assert.throws(() => assertEgressSafe(`token=${FAKE_SECRET}`), /refusing to send/);
    assert.equal(assertEgressSafe('clean payload'), true);
  });
  it('scans structured (object) payloads too — not just strings', () => {
    assert.equal(scanEgressPayload([{ role: 'user', content: FAKE_SECRET }]).safe, false);
  });
});

describe('redact-once — buildRedactedAuditContext excludes sensitive files', () => {
  it('a sensitive file (.env) is excluded from context; an allowed .js is included', () => {
    const dir = path.join(process.cwd(), '.audit-egress-test-tmp');
    const envRel = path.join('.audit-egress-test-tmp', '.env');
    const jsRel = path.join('.audit-egress-test-tmp', 'keep.js');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.env'), `OPENAI_API_KEY=${FAKE_SECRET}\n`, 'utf-8');
      fs.writeFileSync(path.join(dir, 'keep.js'), 'export const MARKER = "keep-me-visible";\n', 'utf-8');

      const { context, egressSafe } = buildRedactedAuditContext([envRel, jsRel]);
      assert.ok(context.includes('keep-me-visible'), 'allowed file content must be present');
      assert.ok(!context.includes(FAKE_SECRET), 'sensitive file secret must NOT appear in context');
      assert.equal(egressSafe, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('OSS adapter — egress fires BEFORE the client call', () => {
  it('refuses to send when the prompt carries a secret; the client is never called', async () => {
    const record = [];
    const client = fakeClient({ content: '{}', record });
    await assert.rejects(
      () => ossStructuredCall(client, {
        model: 'qwen/qwen3-coder', system: 'audit', userPrompt: `here is a key: ${FAKE_SECRET}`,
        schema: PassSchema, schemaName: 'pass',
      }),
      /refusing to send/,
    );
    assert.equal(record.length, 0, 'client must NOT be called after an egress refusal');
  });
});

describe('OSS adapter — full-payload egress gate (audit R5 H5)', () => {
  it('scans the complete outgoing params (schema included), not just messages', async () => {
    // A schema whose field description carries a secret must be caught before the
    // wire call — the derived json_schema is part of the egressed body.
    const record = [];
    const client = fakeClient({ content: '{}', record });
    const LeakySchema = z.object({ x: z.string().describe(`see key ${FAKE_SECRET}`) });
    await assert.rejects(
      () => ossStructuredCall(client, { model: 'qwen/qwen3-coder', system: 'audit', userPrompt: 'clean context', schema: LeakySchema, schemaName: 'leaky' }),
      /refusing to send/,
    );
    assert.equal(record.length, 0, 'client must NOT be called when the schema payload carries a secret');
  });
});

describe('OSS adapter — conformance classification (decision 6)', () => {
  const base = { model: 'qwen/qwen3-coder', system: 'audit', userPrompt: 'clean context', schema: PassSchema, schemaName: 'pass' };

  it('valid JSON matching the schema → conformant:true', async () => {
    const client = fakeClient({ content: JSON.stringify({ findings: [{ id: 'H1', detail: 'x' }], summary: 'ok' }) });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.conformant, true);
    assert.equal(r.failed, false);
    assert.deepEqual(r.result.findings[0], { id: 'H1', detail: 'x' });
    assert.equal(r.usage.input_tokens, 12);
    assert.equal(r.usage.output_tokens, 7);
  });
  it('malformed JSON → conformant:false, failed:false (degrade, not crash)', async () => {
    const client = fakeClient({ content: '{ not json' });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.conformant, false);
    assert.equal(r.failed, false);
    assert.equal(r.result, null);
  });
  it('schema-invalid JSON → conformant:false', async () => {
    const client = fakeClient({ content: JSON.stringify({ findings: 'not-an-array', summary: 'x' }) });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.conformant, false);
    assert.equal(r.result, null);
  });
  it('truncated output (finish_reason=length) → conformant:false', async () => {
    const client = fakeClient({ content: '{"findings":[', finish_reason: 'length' });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.conformant, false);
    assert.match(r.error, /truncated/);
  });
  it('a non-retryable provider error (401) → failed:true with the real status surfaced', async () => {
    const err = Object.assign(new Error('invalid api key'), { status: 401 });
    const client = fakeClient({ throwErr: err });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.failed, true);
    assert.match(r.error, /401/);
  });
  it('a reply with NO usage flags usageMissing (spend cap must not read it as free — R2 H3)', async () => {
    const client = fakeClient({ content: JSON.stringify({ findings: [], summary: 'x' }), usage: null });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.usage.usageMissing, true);
    assert.equal(r.usage.input_tokens, 0);
  });
  it('valid present usage clears usageMissing (R2 M3)', async () => {
    const client = fakeClient({ content: JSON.stringify({ findings: [], summary: 'x' }), usage: { prompt_tokens: 9, completion_tokens: 4 } });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.usage.usageMissing, false);
    assert.equal(r.usage.input_tokens, 9);
    assert.equal(r.usage.output_tokens, 4);
  });
  it('a failed call flags usageMissing on its empty usage', async () => {
    const client = fakeClient({ throwErr: Object.assign(new Error('bad'), { status: 400 }) });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.usage.usageMissing, true);
  });
  it('partial usage (one token field absent) is treated as missing (R3 H4)', async () => {
    const client = fakeClient({ content: JSON.stringify({ findings: [], summary: 'x' }), usage: { prompt_tokens: 10 } });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.usage.usageMissing, true);
  });
  it('present-but-INVALID token (negative) is treated as missing — presence≠validity (R4 H3)', async () => {
    const client = fakeClient({ content: JSON.stringify({ findings: [], summary: 'x' }), usage: { prompt_tokens: -3, completion_tokens: 5 } });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.usage.usageMissing, true);
    assert.equal(r.usage.input_tokens, 0);   // still clamped for any downstream sum
  });
  it('a NaN/Infinity provider cost is rejected → provider_cost_usd null (R3 L1)', async () => {
    const client = fakeClient({ content: JSON.stringify({ findings: [], summary: 'x' }), usage: { prompt_tokens: 1, completion_tokens: 1, cost: Number.POSITIVE_INFINITY } });
    const r = await ossStructuredCall(client, base);
    assert.equal(r.usage.provider_cost_usd, null);
  });
});

describe('OSS adapter — schema/tool name sanitization (audit R1 M6)', () => {
  it('coerces an invalid name to the OpenAI-compatible shape', () => {
    assert.match(sanitizeSchemaName('pass result!!'), /^[a-zA-Z0-9_-]+$/);
    assert.equal(sanitizeSchemaName(''), 'schema');
    assert.ok(sanitizeSchemaName('x'.repeat(200)).length <= 64);
  });
  it('a schemaName with spaces/special chars is sanitized before reaching the client', async () => {
    const record = [];
    const client = fakeClient({ content: JSON.stringify({ findings: [], summary: '' }), record });
    await ossStructuredCall(client, { model: 'qwen/qwen3-coder', system: 's', userPrompt: 'clean', schema: PassSchema, schemaName: 'pass result!!' });
    const name = record[0].response_format.json_schema.name;
    assert.match(name, /^[a-zA-Z0-9_-]+$/);
  });
});

describe('egress backstop — secret content is caught even inside an allowed file (audit R1 M9)', () => {
  it('a hardcoded secret inside an allowlisted .js is flagged by the egress scan', () => {
    const dir = path.join(process.cwd(), '.audit-egress-test-tmp2');
    const jsRel = path.join('.audit-egress-test-tmp2', 'leaky.js');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'leaky.js'), `export const KEY = "${FAKE_SECRET}";\n`, 'utf-8');
      const { egressSafe, egressPatterns } = buildRedactedAuditContext([jsRel]);
      // The file IS included (allowed extension), but the secret-pattern scan
      // flags it so the adapter's assertEgressSafe refuses to send it onward.
      assert.equal(egressSafe, false);
      assert.ok(egressPatterns.length > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('opt-in invariant — no OSS client unless explicitly requested', () => {
  it('resolveArms unset → disabled (the shadow never builds an OSS client)', () => {
    assert.equal(resolveArms({}).enabled, false);
  });
  it('createOpenAIClient builds an OSS client ONLY via the explicit oss option', async () => {
    _resetClientCache();
    const oss = await createOpenAIClient({ oss: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test' }, fresh: true });
    assert.ok(oss.baseURL.startsWith('https://openrouter.ai'), `got ${oss.baseURL}`);
    // Without the oss option, the public path is unchanged (default OpenAI baseURL).
    const pub = await createOpenAIClient({ apiKey: 'sk-test', fresh: true });
    assert.ok(pub.baseURL.startsWith('https://api.openai.com'), `got ${pub.baseURL}`);
  });
});
