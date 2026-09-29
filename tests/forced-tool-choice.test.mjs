/**
 * Forced `tool_choice` on models that reject it (Claude Opus 5.5, which
 * `latest-opus` resolves to; Fable 5.1; Mythos 5.1).
 *
 * The client stub below mirrors the real API: a forced `tool_choice`
 * (`tool`/`any`) on claude-opus-5-5 is a 400, `auto` is answered. Every
 * behavioural test here failed before the fix — the two opt-in paths sent a
 * forced choice to every model, so the stub's 400 fired on each call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptsForcedToolChoice, buildToolUseRequest, toStrictToolSchema, withToolInstruction,
} from '../scripts/lib/anthropic-tool-choice.mjs';
import { callVerifier } from '../scripts/lib/remediation-verification.mjs';
import { _internals as soloCtl } from '../scripts/solo-control-audit.mjs';
import { createSonnetDiscoveryCall } from '../scripts/lib/audit/tiered-provider-calls.mjs';

const REJECTS_FORCED = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']);

/** The shape `@anthropic-ai/sdk` throws for a 400 (status + provider message). */
function forcedToolChoice400() {
  return Object.assign(
    new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}'),
    { status: 400 },
  );
}

/** A client that behaves like the API on tool_choice, and answers with `respond(params)`. */
function apiLikeClient(respond) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const t = params.tool_choice?.type;
        if (REJECTS_FORCED.has(params.model) && (t === 'tool' || t === 'any')) throw forcedToolChoice400();
        return respond(params);
      },
    },
  };
}

// ── the predicate + request builder ─────────────────────────────────────────

test('acceptsForcedToolChoice: 4.x and 5.0 accept; Opus 5.5 and every unplaceable id take the auto path', () => {
  for (const m of ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6']) {
    assert.equal(acceptsForcedToolChoice(m), true, m);
  }
  // Unknown ⇒ false is the fail-safe direction: `auto` is accepted by every model.
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-sonnet-6', 'my-azure-deployment', '', null, undefined]) {
    assert.equal(acceptsForcedToolChoice(m), false, String(m));
  }
});

test('buildToolUseRequest: a forcing-capable model gets exactly the pre-existing request (byte-identical tools + forced choice)', () => {
  const tool = { name: 't', description: 'd', input_schema: { type: 'object', properties: { s: { type: 'string', maxLength: 5 } } } };
  const r = buildToolUseRequest('claude-sonnet-5', tool);
  assert.deepEqual(r.tools, [tool]);
  assert.deepEqual(r.tool_choice, { type: 'tool', name: 't' });
  assert.equal(r.instruction, null);
});

test('buildToolUseRequest: Opus 5.5 gets auto, a strict tool with a strict-compatible schema, and an instruction naming the tool', () => {
  const tool = { name: 'emit', input_schema: { type: 'object', additionalProperties: false, properties: { s: { type: 'string', maxLength: 5 } }, required: ['s'] } };
  const r = buildToolUseRequest('claude-opus-5-5', tool);
  assert.deepEqual(r.tool_choice, { type: 'auto' });
  assert.equal(r.tools[0].strict, true);
  assert.equal(r.tools[0].input_schema.properties.s.maxLength, undefined, 'strict mode 400s on maxLength');
  assert.equal(tool.input_schema.properties.s.maxLength, 5, 'the caller\'s schema is not mutated');
  assert.match(r.instruction, /calling the emit tool/);
  assert.equal(withToolInstruction('SYS', r.instruction), `SYS\n\n${r.instruction}`);
  assert.equal(withToolInstruction('SYS', null), 'SYS');
});

test('toStrictToolSchema: strips unsupported keywords at every depth but keeps a PROPERTY that happens to share a keyword name', () => {
  const s = toStrictToolSchema({
    type: 'object',
    properties: {
      maxLength: { type: 'integer', minimum: 0 },
      list: { type: 'array', maxItems: 50, items: { type: 'object', properties: { d: { type: 'string', maxLength: 10 } } } },
    },
  });
  assert.deepEqual(Object.keys(s.properties), ['maxLength', 'list']);
  assert.equal(s.properties.maxLength.minimum, undefined);
  assert.equal(s.properties.list.maxItems, undefined);
  assert.equal(s.properties.list.items.properties.d.maxLength, undefined);
});

// ── remediation-verification (--model latest-opus) ─────────────────────────

const FINDING = { finding_fingerprint: 'fp1', category: 'bug', severity: 'HIGH', detail_snapshot: 'x' };

test('callVerifier on claude-opus-5-5: no forced tool_choice, so the verdict comes back instead of a 400 that degrades every finding to uncertain', async () => {
  const client = apiLikeClient(() => ({
    content: [{ type: 'tool_use', name: 'record_remediation_verdicts', input: { verdicts: [{ fingerprint: 'fp1', verdict: 'resolved', rationale: 'gone' }] } }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
  const r = await callVerifier({ client, model: 'claude-opus-5-5', file: 'a.js', findings: [FINDING], diffText: 'd', currentContent: 'c', truncated: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.verdicts[0].verdict, 'resolved');
  assert.deepEqual(client.calls[0].tool_choice, { type: 'auto' });
  assert.match(client.calls[0].system, /calling the record_remediation_verdicts tool/);
});

test('callVerifier on claude-sonnet-5 still forces the tool (the request is unchanged where forcing works)', async () => {
  const client = apiLikeClient(() => ({ content: [{ type: 'tool_use', name: 'record_remediation_verdicts', input: { verdicts: [] } }] }));
  await callVerifier({ client, model: 'claude-sonnet-5', file: 'a.js', findings: [FINDING], diffText: '', currentContent: '', truncated: false });
  assert.deepEqual(client.calls[0].tool_choice, { type: 'tool', name: 'record_remediation_verdicts' });
});

test('callVerifier: a real 400 still degrades to uncertain with ok:false — never a verdict', async () => {
  const client = { messages: { create: async () => { throw forcedToolChoice400(); } } };
  const r = await callVerifier({ client, model: 'claude-opus-5-5', file: 'a.js', findings: [FINDING], diffText: '', currentContent: '', truncated: false });
  assert.equal(r.ok, false);
  assert.equal(r.verdicts[0].verdict, 'uncertain');
});

// ── solo-control gate (--gate-model latest-opus) ────────────────────────────

const EMPTY_FINDINGS = { findings: [] };

test('runClaudeGateReview on claude-opus-5-5: sends auto (not forced) and reads the tool call — the shared user prompt stays byte-identical', async () => {
  const client = apiLikeClient(() => ({ content: [{ type: 'tool_use', name: 'emit_findings', input: EMPTY_FINDINGS }], stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 2 } }));
  const r = await soloCtl.runClaudeGateReview(client, 'claude-opus-5-5', [], 'DIFF');
  assert.equal(r.state, 'ok');
  assert.deepEqual(client.calls[0].tool_choice, { type: 'auto' });
  assert.equal(client.calls[0].tools[0].strict, true);
  assert.equal(client.calls[0].messages[0].content, soloCtl.buildGateReviewPrompt([], 'DIFF'));
  assert.match(client.calls[0].system, /calling the emit_findings tool/);
});

test('runClaudeGateReview: a mocked 400 on forced tool_choice is provider-error (unverified), never an empty clean result', async () => {
  // Pre-fix: {findings: [], skipped: 'error: 400 …'} — and the call site
  // recorded the gate cell as `ok`, so a gate that never ran read as a gate
  // that found nothing.
  const client = { messages: { create: async () => { throw forcedToolChoice400(); } } };
  const r = await soloCtl.runClaudeGateReview(client, 'claude-opus-5-5', [], 'X');
  assert.equal(r.state, 'provider-error');
  assert.match(r.error, /not supported for this model/);
  assert.notEqual(soloCtl.gateCellState(r), 'ok');
});

test('runClaudeGateReview: a refusal is provider-error with its billed usage kept, never zero findings reading as clean', async () => {
  const client = apiLikeClient(() => ({ content: [], stop_reason: 'refusal', usage: { input_tokens: 40, output_tokens: 1 } }));
  const r = await soloCtl.runClaudeGateReview(client, 'claude-opus-5-5', [], 'X');
  assert.equal(r.state, 'provider-error');
  assert.match(r.error, /refusal/);
  assert.deepEqual(r.usage, { input_tokens: 40, output_tokens: 1 });
});

test('runClaudeGateReview: an auto-mode prose answer (no tool call) is provider-error, not an empty finding list', async () => {
  const client = apiLikeClient(() => ({ content: [{ type: 'text', text: 'looks fine to me' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 4 } }));
  const r = await soloCtl.runClaudeGateReview(client, 'claude-opus-5-5', [], 'X');
  assert.equal(r.state, 'provider-error');
  assert.match(r.error, /no emit_findings tool call/);
});

test('runClaudeGateReview: a tool call whose input fails the schema is a conformance-miss — the ledger\'s existing "answered, malformed" state', async () => {
  const client = apiLikeClient(() => ({ content: [{ type: 'tool_use', name: 'emit_findings', input: { findings: 'not-an-array' } }], usage: { input_tokens: 1, output_tokens: 1 } }));
  const r = await soloCtl.runClaudeGateReview(client, 'claude-sonnet-5', [], 'X');
  assert.equal(r.state, 'conformance-miss');
  assert.deepEqual(r.findings, []);
});

test('gateCellState: every gate runner\'s skip (Gemini no-key included) is provider-error, and only an explicit/absent-skip success is ok', () => {
  assert.equal(soloCtl.gateCellState({ findings: [], skipped: 'no-key' }), 'provider-error');
  assert.equal(soloCtl.gateCellState({ findings: [], state: 'conformance-miss' }), 'conformance-miss');
  assert.equal(soloCtl.gateCellState({ findings: [] }), 'ok');
});

// ── tiered discovery generator (latest-sonnet) routes through the same helper ─

test('createSonnetDiscoveryCall: the tool_choice comes from buildToolUseRequest for the resolved model, not a hardcoded force', async () => {
  const { resolveModel } = await import('../scripts/lib/model-resolver.mjs');
  const model = resolveModel('latest-sonnet');
  const client = apiLikeClient(() => ({ content: [{ type: 'tool_use', name: 'report_findings', input: { findings: [] } }] }));
  const call = createSonnetDiscoveryCall({
    providers: { anthropicClient: client },
    ctx: {},
    contract: { anchorContract: 'A', sonnetFindingsTool: { name: 'report_findings', input_schema: { type: 'object', properties: {} } }, unclampedQuoteSchema: { type: 'object', properties: {} } },
    discoveryPlan: 'p', discoveryCode: 'c', recordUsage: () => {},
  });
  await call();
  assert.deepEqual(client.calls[0].tool_choice, buildToolUseRequest(model, { name: 'report_findings', input_schema: {} }).tool_choice);
});
