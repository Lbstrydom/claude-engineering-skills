/**
 * @fileoverview A plan-less code audit run end to end through `runMultiPassCodeAudit` with a stub OpenAI client (Tier 2: invariants,
 * never model prose). Plan: docs/plans/prepush-gate-consumer-feedback-theme1.md D1, "D1, run".
 *
 * Both directions: a plan-less run's envelope says `planless: true` and every pass prompt carries `PLANLESS_HEADER`; the same run with a
 * plan has no `planless` field and no header anywhere. Cloud store and learning are off, so nothing is written or upserted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_FILE, defaultResponses,
} from './helpers/multi-pass-audit-fixtures.mjs';
import { PLANLESS_HEADER, buildIntentDocument } from '../scripts/lib/audit/planless-intent.mjs';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
const _priorEnv = {
  MODEL_CATALOG_REFRESH: process.env.MODEL_CATALOG_REFRESH,
  LEARNING_DISABLE: process.env.LEARNING_DISABLE,
  AUDIT_DB_URL: process.env.AUDIT_DB_URL,
  AUDIT_NO_PREFLIGHT: process.env.AUDIT_NO_PREFLIGHT,
};
process.env.MODEL_CATALOG_REFRESH = 'skip';
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';
process.env.AUDIT_NO_PREFLIGHT = '1';
process.on('exit', () => {
  for (const [key, value] of Object.entries(_priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const audit = await import('../scripts/openai-audit.mjs');
const { runMultiPassCodeAudit } = audit.__testExports;

const PASSES = ['structure', 'wiring', 'backend', 'sustainability', 'quickfix'];
const BASE_OPTS = { passFilter: PASSES, noTools: true, noDebtLedger: true, noLedger: true, scopeMode: 'diff', fileFilter: [BACKEND_FILE] };

/** A stub client that records every request it was sent. */
function recordingClient() {
  const sent = [];
  const responses = defaultResponses();
  return {
    sent,
    client: {
      responses: {
        parse: async (params) => {
          sent.push(params);
          const handler = responses[params?.text?.format?.name];
          if (handler === undefined) throw new Error(`unstubbed pass ${params?.text?.format?.name}`);
          return {
            status: 'completed', output: [], output_parsed: handler,
            usage: { input_tokens: 1, output_tokens: 1, prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
          };
        },
      },
    },
  };
}

const promptOf = (params) => JSON.stringify(params?.input ?? params);

describe('runMultiPassCodeAudit, plan-less vs plan-keyed', () => {
  it('a plan-less run: the envelope says planless:true and EVERY pass prompt carries the header', async () => {
    const { client, sent } = recordingClient();
    const intent = buildIntentDocument({ messages: ['fix: harden the service'] }).text;
    const result = await runMultiPassCodeAudit(client, `${PLANLESS_HEADER}${intent}`, '', false, null, '', { ...BASE_OPTS, planless: true });
    assert.equal(result.planless, true);
    assert.ok(sent.length >= PASSES.length, `expected a request per pass, got ${sent.length}`);
    const marker = 'PLAN-LESS AUDIT - there is no plan for this change';
    for (const p of sent) assert.ok(promptOf(p).includes(marker), `pass ${p?.text?.format?.name} did not receive the header`);
  });
  it('the same run with a plan: no planless field, and the header appears in no prompt', async () => {
    const { client, sent } = recordingClient();
    const result = await runMultiPassCodeAudit(client, `# Plan\n\nImplement \`${BACKEND_FILE}\`.\n`, '', false, null, '', { ...BASE_OPTS });
    assert.equal('planless' in result, false);
    assert.ok(sent.length >= PASSES.length);
    for (const p of sent) assert.ok(!promptOf(p).includes('PLAN-LESS AUDIT'), `pass ${p?.text?.format?.name} received the plan-less header`);
  });
});
