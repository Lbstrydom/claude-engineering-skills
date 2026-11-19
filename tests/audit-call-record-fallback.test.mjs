/**
 * @fileoverview Tier 2 — a Responses->chat-completions fallback result is recorded under the same key a fresh lookup
 * computes (plan §3.1, audit r1 H1/H3). Own file: the fallback latch (`_responsesUnsupported`) is process-wide state.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { callGPT } from '../scripts/lib/audit/llm-helpers.mjs';
import { configureCallRecords } from '../scripts/lib/audit/call-record.mjs';

const Schema = z.object({ findings: z.array(z.string()) }).strict();
const opts = (t) => ({ system: 's', messages: [{ role: 'user', content: t }], schema: Schema, schemaName: 'fb', reasoning: 'low', maxTokens: 500, timeoutMs: 5000, maxRetries: 0 });
const ID = { auditedTree: 'b'.repeat(40), auditSessionId: 'audit-code-9-9', auditRound: 1 };

describe('fallback transport does not change the record key', () => {
  it('records the chat-fallback result, and a resumed run replays it with no API call', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'call-record-fb-'));
    try {
      configureCallRecords({ repoRoot: root, identity: ID, env: {} });
      let responsesCalls = 0;
      const chatOnly = {
        responses: { parse: async () => { responsesCalls++; const e = new Error('The Responses API is not supported for this deployment'); e.status = 400; e.code = 'OperationNotSupported'; throw e; } },
        chat: { completions: { parse: async () => ({ choices: [{ message: { parsed: { findings: ['via-chat'] } }, finish_reason: 'stop' }], usage: {}, model: 'm' }) } },
      };
      const first = await callGPT(chatOnly, opts('FB'));
      assert.deepEqual(first.result.findings, ['via-chat']);
      assert.equal(responsesCalls, 1, 'the fallback really happened (control: this test would be vacuous otherwise)');

      configureCallRecords({ repoRoot: root, identity: ID, resume: true, env: {} });
      let live = 0;
      const second = { responses: { parse: async () => { live++; throw new Error('must not be called'); } }, chat: { completions: { parse: async () => { live++; throw new Error('must not be called'); } } } };
      const r = await callGPT(second, opts('FB'));
      assert.equal(r.replayed, true);
      assert.equal(live, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
