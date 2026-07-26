import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/gemini-review.mjs';

const {
  resolveShadow, diffFindingBuckets, dedupByHash, shadowModelMatchesFamily,
  resolveModelEvalShadowOverride, mapRouteToShadowProvider,
} = _internals;

// A resolver stub so tests don't depend on the live model catalog.
const stubResolve = (sentinel) => {
  const map = { 'latest-opus': 'claude-opus-4-8', 'latest-pro': 'gemini-pro-latest' };
  return map[sentinel] || sentinel;
};

describe('resolveShadow — opt-in invariant (shadow path not entered when unset)', () => {
  it('returns skipped-unset when FINAL_REVIEW_SHADOW is absent — the byte-identical guard', () => {
    const r = resolveShadow({ shadowConfig: { provider: null, model: null }, env: {}, azureActive: false });
    assert.equal(r.state, 'skipped-unset');
    assert.equal(r.provider, null);
    assert.equal(r.model, null);
  });
});

describe('resolveShadow — Azure guard (load-bearing: shadow is a no-op on Foundry)', () => {
  it('returns skipped-azure when an Azure profile is active even if the env is set', () => {
    const r = resolveShadow({
      shadowConfig: { provider: 'claude-opus', model: null },
      env: { ANTHROPIC_API_KEY: 'x' },
      azureActive: true,
      resolve: stubResolve,
    });
    assert.equal(r.state, 'skipped-azure');
  });
});

describe('resolveShadow — provider/key/model resolution', () => {
  it('skips with skipped-no-key when the provider key is missing', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'claude-opus', model: null }, env: {}, azureActive: false, resolve: stubResolve });
    assert.equal(r.state, 'skipped-no-key');
  });

  it('skips unknown providers without throwing (optional feature never breaks the audit)', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'frobnicator', model: null }, env: { X: '1' }, azureActive: false, resolve: stubResolve });
    assert.equal(r.state, 'skipped-unsupported-provider');
  });

  it('resolves a ready claude-opus shadow to its concrete model via the per-provider default', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'claude-opus', model: null }, env: { ANTHROPIC_API_KEY: 'x' }, azureActive: false, resolve: stubResolve });
    assert.equal(r.state, 'ready');
    assert.equal(r.provider, 'claude-opus');
    assert.equal(r.model, 'claude-opus-4-8');
    assert.equal(r.family, 'claude');
  });

  it('maps the "anthropic" alias to the claude-opus canonical provider', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'anthropic', model: null }, env: { ANTHROPIC_API_KEY: 'x' }, azureActive: false, resolve: stubResolve });
    assert.equal(r.state, 'ready');
    assert.equal(r.provider, 'claude-opus');
  });

  it('rejects a provider/model family mismatch (gemini provider + opus model) — R3 M1', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'gemini', model: 'claude-opus-4-8' }, env: { GEMINI_API_KEY: 'x' }, azureActive: false, resolve: (s) => s });
    assert.equal(r.state, 'skipped-unsupported-provider');
  });

  it('honours an explicit, family-compatible model override', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'claude-opus', model: 'claude-opus-4-7' }, env: { ANTHROPIC_API_KEY: 'x' }, azureActive: false, resolve: (s) => s });
    assert.equal(r.state, 'ready');
    assert.equal(r.model, 'claude-opus-4-7');
  });
});

describe('shadowModelMatchesFamily', () => {
  it('matches claude family ids (opus/sonnet/haiku/mythos/fable)', () => {
    for (const id of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-mythos-5', 'claude-fable-5']) {
      assert.equal(shadowModelMatchesFamily(id, 'claude'), true, id);
    }
    assert.equal(shadowModelMatchesFamily('gemini-pro-latest', 'claude'), false);
  });
  it('matches gemini family ids', () => {
    assert.equal(shadowModelMatchesFamily('gemini-pro-latest', 'gemini'), true);
    assert.equal(shadowModelMatchesFamily('claude-opus-4-8', 'gemini'), false);
  });
});

describe('dedupByHash — no count inflation (R3 M2)', () => {
  it('keeps the first occurrence of each semantic hash and drops duplicates', () => {
    const out = dedupByHash([{ _hash: 'a' }, { _hash: 'b' }, { _hash: 'b' }, { _hash: 'a' }]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((f) => f._hash), ['a', 'b']);
  });
  it('tolerates null/empty input', () => {
    assert.deepEqual(dedupByHash(null), []);
    assert.deepEqual(dedupByHash([]), []);
  });

  it('never silently drops a finding without _hash — computes semanticId as fallback (R2 H1)', () => {
    // A finding lacking _hash must NOT vanish; it is keyed by its computed
    // semanticId so it still reaches the diff + persistence.
    const out = dedupByHash([{ severity: 'HIGH', category: 'x', section: 's', detail: 'd' }]);
    assert.equal(out.length, 1);
  });
});

describe('diffFindingBuckets — three-way partition by semantic hash', () => {
  it('classifies both / primary-only / shadow-only and dedups each side first', () => {
    const primary = { new_findings: [{ _hash: 'a' }, { _hash: 'b' }, { _hash: 'b' }] }; // dup b
    const shadow = { new_findings: [{ _hash: 'b' }, { _hash: 'c' }] };
    const d = diffFindingBuckets(primary, shadow);
    assert.deepEqual(d.counts, { both: 1, primaryOnly: 1, shadowOnly: 1 });
    // primary deduped to [a, b]; buckets stamped
    assert.equal(d.primary.length, 2);
    assert.equal(d.primary.find((f) => f._hash === 'a')._bucket, 'primary-only');
    assert.equal(d.primary.find((f) => f._hash === 'b')._bucket, 'both');
    assert.equal(d.shadow.find((f) => f._hash === 'c')._bucket, 'shadow-only');
    assert.equal(d.shadow.find((f) => f._hash === 'b')._bucket, 'both');
  });

  it('handles a shadow with no findings (all primary become primary-only)', () => {
    const d = diffFindingBuckets({ new_findings: [{ _hash: 'a' }, { _hash: 'b' }] }, { new_findings: [] });
    assert.deepEqual(d.counts, { both: 0, primaryOnly: 2, shadowOnly: 0 });
  });

  it('handles empty/missing results without throwing', () => {
    const d = diffFindingBuckets({}, {});
    assert.deepEqual(d.counts, { both: 0, primaryOnly: 0, shadowOnly: 0 });
  });
});

// model-swap-eval-harness Phase 4 — adjudicator Tier A/B live-shadow override.
describe('mapRouteToShadowProvider — pure route-to-provider mapping (Phase 4)', () => {
  it('native-gemini transport maps to "gemini"', () => {
    assert.equal(mapRouteToShadowProvider({ transport: 'native-gemini' }), 'gemini');
  });

  it('native-anthropic transport from an azure-resolved route maps to "azure-claude"', () => {
    assert.equal(mapRouteToShadowProvider({ transport: 'native-anthropic', provider: 'azure' }), 'azure-claude');
  });

  it('native-anthropic transport from a public sentinel route maps to "claude-opus"', () => {
    assert.equal(mapRouteToShadowProvider({ transport: 'native-anthropic', provider: 'anthropic' }), 'claude-opus');
  });

  it('openai-compatible transport has no live-shadow prompt path — returns null (Tier C only)', () => {
    assert.equal(mapRouteToShadowProvider({ transport: 'openai-compatible', provider: 'openai' }), null);
  });
});

describe('resolveModelEvalShadowOverride — discovery is unconditional, never requires FINAL_REVIEW_SHADOW (round-6 audit H4)', () => {
  it('returns null gracefully when no adjudicator Tier A/B eval run is active for this repo (real DB call, no mocking)', async () => {
    // This repo's cloud IS enabled in dev/CI here, and there is genuinely no
    // active pending_shadow adjudicator run right now — exercises the REAL
    // isCloudEnabled -> resolveRepoIdentity -> getActiveEvalRunId chain
    // end-to-end without needing to fabricate DB state.
    const result = await resolveModelEvalShadowOverride();
    assert.equal(result, null);
  });
});

// ── The shadow must pin the sdk backend (found live 2026-07-26) ─────────────
// First real run of the enabled shadow: Opus produced a genuine review whose
// verdict was APPROVE, but as a MARKDOWN report — no JSON object at all — so
// parseReviewJson threw and the observation was dropped (`error-unavailable`).
// Root cause: `buildShadowClient` used the ambient `CLAUDE_BACKEND`, which is
// `cli` on the operator's machine, and the cli backend serves a conversational
// `claude -p`. This transport's JSON contract is a prompt instruction with no
// provider-side enforcement, so a conversational backend silently voids it.
//
// A source-level pin (not a behavioural mock) because the failure is a MISSING
// ARGUMENT: there is no return value to assert on, and constructing the real
// client would either spawn the CLI or need an API key. This mirrors the
// existing `tests/tiered-pipeline-wiring.test.mjs` static pin guarding the same
// invariant for the discovery generator.
describe('buildShadowClient pins backend:sdk — a conversational backend silently voids the JSON contract', () => {
  it('passes backend:"sdk" explicitly rather than inheriting the ambient CLAUDE_BACKEND', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('scripts/gemini-review.mjs', 'utf8');
    const fn = src.slice(src.indexOf('async function buildShadowClient'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(
      body,
      /return createAnthropicClient\(\{\s*backend:\s*'sdk'\s*\}\)/,
      'the claude-opus shadow branch must pin backend:sdk — a bare createAnthropicClient() '
      + 'inherits CLAUDE_BACKEND=cli and returns markdown prose, which drops every observation',
    );
    assert.doesNotMatch(
      body,
      /return createAnthropicClient\(\)\s*;/,
      'a bare, argument-less createAnthropicClient() in this function is the exact 2026-07-26 defect',
    );
  });
});

// ── Anthropic transport: forced tool-use, not a prompt instruction ──────────
// Live 2026-07-26. The anthropic transport asked for JSON via the system prompt
// only ("Output strictly valid JSON"), which enforces nothing, while Gemini got
// a real `responseSchema`. Opus returned a review whose finding objects were
// missing the REQUIRED `category`/`section` and had an empty `detail`. Zod in
// callReviewer is warn-and-keep, so the malformed object flowed through
// bucketing into persistence, where `category NOT NULL` aborted the INSERT and
// silently rolled back the PRIMARY reviewer's findings too.
//
// Schema-level assertions only — no live API call.
describe('anthropic review transport forces structured output via tool-use', () => {
  const { AnthropicReviewToolSchema } = _internals;

  it('the tool input_schema requires the fields that went missing', () => {
    const itemRequired = AnthropicReviewToolSchema.properties.new_findings.items.required;
    for (const field of ['category', 'section', 'detail', 'severity']) {
      assert.ok(
        itemRequired.includes(field),
        `${field} must be provider-enforced as required — its absence is what broke persistence`,
      );
    }
  });

  it('the tool schema is the standard dialect, NOT the Gemini-stripped one', () => {
    // zodToGeminiSchema strips maxLength for Gemini's restricted subset. Handing
    // that to Anthropic would silently drop the length hints; they are different
    // dialects of the same Zod source and must not be conflated.
    const detail = AnthropicReviewToolSchema.properties.new_findings.items.properties.detail;
    assert.equal(detail.maxLength, 600, 'standard JSON Schema keeps maxLength');
    assert.equal(AnthropicReviewToolSchema.$schema, undefined, '$schema is metadata, dropped for input_schema');
  });
});

// ── Shadow-only findings must round-trip with gradeable content ─────────────
// The A/B's pre-registered stopping rule is "KEEP iff human-accepted shadow-only
// HIGH/MEDIUM >= 1 per 5 runs". A shadow-only finding with an empty `detail` is
// ungradeable, so the accept-rate numerator can never be evaluated and the
// experiment silently collects only cost data — the dead-experiment failure mode
// it exists to avoid. This pins the mapping end of that contract.
describe('shadow-only findings round-trip with gradeable content', () => {
  const { diffFindingBuckets } = _internals;

  const finding = (over = {}) => ({
    id: 'G1', severity: 'MEDIUM', category: 'Data Contract Violation',
    section: 'scripts/lib/audit/candidate-envelope.mjs',
    detail: 'evidenceAlternatives[0] is not the canonical claim after promotion.',
    risk: 'Downstream consumers read the wrong evidence.',
    recommendation: 'Swap the promoted entry to index 0.',
    is_quick_fix: false, is_mechanical: true, principle: 'Respect declared invariants.',
    _hash: 'aaaa1111', ...over,
  });

  // Mirrors runShadowAndPersist's shadowOnlyFindings projection (gemini-review.mjs).
  const project = (f) => ({
    fingerprint: f._hash, severity: f.severity, category: f.category,
    section: f.section, detail: (f.detail || '').slice(0, 600),
  });

  it('a shadow-only finding keeps detail/category/section through bucketing', () => {
    const primary = { new_findings: [finding({ _hash: 'bbbb2222', id: 'P1' })] };
    const shadowResult = { new_findings: [finding()] };
    const diff = diffFindingBuckets(primary, shadowResult);

    const shadowOnly = diff.shadow.filter((f) => f._bucket === 'shadow-only').map(project);
    assert.equal(shadowOnly.length, 1, 'precondition: exactly one shadow-only finding');
    const [f] = shadowOnly;
    assert.ok(f.detail.length > 0, 'detail must be non-empty — an empty detail is ungradeable');
    assert.equal(f.category, 'Data Contract Violation');
    assert.equal(f.section, 'scripts/lib/audit/candidate-envelope.mjs');
    assert.equal(f.severity, 'MEDIUM');
    assert.equal(f.fingerprint, 'aaaa1111');
  });

  // The exact 2026-07-26 shape, as a canary: if a producer ever regresses to
  // omitting these fields, the projection reproduces the ungradeable row. The
  // provider-side tool schema is what prevents it; this documents the symptom
  // so a future empty queue is diagnosed in seconds rather than re-investigated.
  it('documents the malformed shape that produced the empty adjudication queue', () => {
    const malformed = { _hash: 'e3852b1f', severity: 'MEDIUM' }; // no category/section/detail
    const projected = project(malformed);
    assert.equal(projected.detail, '', 'the observed symptom: empty detail');
    assert.equal(projected.category, undefined, 'and an absent category — NOT NULL in audit_findings');
  });
});

// ── Streamed tool_use reassembly ────────────────────────────────────────────
// The defect that made forced tool-use structurally impossible (2026-07-26):
// streamAnthropicMessage accumulated only `text_delta` events and returned a
// hardcoded single text block, silently discarding any `tool_use` block AND
// `stop_reason`. So the transport always reported "no submit_review tool call"
// no matter how correct the request was. Two fixes had to land together — the
// request (tools/tool_choice) and the reader — which is why the first live run
// after the request-side fix still failed.
describe('streamAnthropicMessage reassembles streamed tool_use input', () => {
  const { streamAnthropicMessage } = _internals;

  /** A stub client whose create() yields a canned Anthropic event stream. */
  const streamingClient = (events) => ({
    messages: {
      create: async () => (async function* () { yield* events; })(),
    },
  });

  it('concatenates input_json_delta fragments into a parsed tool input', async () => {
    const r = await streamAnthropicMessage(streamingClient([
      { type: 'message_start', message: { usage: { input_tokens: 100 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'submit_review' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"verdict":"APP' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ROVE"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
    ]));
    const tool = r.content.find((b) => b.type === 'tool_use');
    assert.ok(tool, 'the tool_use block must survive streaming — dropping it was the bug');
    assert.equal(tool.name, 'submit_review');
    assert.deepEqual(tool.input, { verdict: 'APPROVE' }, 'fragments must be concatenated then parsed');
    assert.equal(r.stop_reason, 'tool_use', 'stop_reason must survive — it is the truncation signature');
    assert.equal(r.usage.input_tokens, 100);
    assert.equal(r.usage.output_tokens, 42);
  });

  it('still handles a pure-text stream (the non-tool path is unchanged)', async () => {
    const r = await streamAnthropicMessage(streamingClient([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"verdict":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '"REJECT"}' } },
    ]));
    assert.equal(r.content.find((b) => b.type === 'text')?.text, '{"verdict":"REJECT"}');
  });

  it('throws a truncation-naming error on malformed streamed JSON, never a silent empty input', async () => {
    // A silent `{}` here would read as "the model returned an empty review",
    // sending the next investigation at the model instead of at max_tokens.
    await assert.rejects(
      () => streamAnthropicMessage(streamingClient([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'submit_review' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"verdict":"APPRO' } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      ])),
      /malformed JSON.*stop_reason: max_tokens.*truncation/s,
    );
  });

  it('passes a non-streaming adapter response straight through (cli backend guard)', async () => {
    const final = { content: [{ type: 'text', text: '{}' }], usage: {} };
    const r = await streamAnthropicMessage({ messages: { create: async () => final } });
    assert.equal(r, final, 'an adapter that ignores stream:true must be returned unchanged');
  });
});
