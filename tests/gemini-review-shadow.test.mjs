import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  _internals, shouldWarnMissingRunId, recoverRunIdFromMarker, RUN_ID_MARKER_MAX_AGE_MS,
  canAttemptRunIdRecovery,
} from '../scripts/gemini-review.mjs';

const {
  resolveShadow, diffFindingBuckets, dedupByHash, shadowModelMatchesFamily,
  resolveModelEvalShadowOverride, mapRouteToShadowProvider, runShadowAndPersist,
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

describe('runShadowAndPersist — campaign-safety refusals (plan KD-6)', () => {
  const ctx = { planContent: 'plan', transcriptContent: '{}', projectContext: '', auditMode: 'code' };

  // `runShadowAndPersist` resolves `shadow` via `resolveShadow()` (ambient
  // process.env) on its very first line, UNCONDITIONALLY — before either
  // refusal check below. The two REFUSES cases throw regardless of what
  // `shadow` resolves to, so ambient env can't flip them. But the two
  // doesNotReject cases fall through PAST the refusal checks into the
  // `shadow.state === 'ready'` branch, which makes an actual provider call —
  // so on a machine/CI where FINAL_REVIEW_SHADOW happens to be set with a
  // valid key, these would attempt a real network call inside what is
  // supposed to be a pure config-refusal unit test. `resolveShadow` has no
  // env-independent path here (it's read once via frozen shadowReviewConfig
  // at module load), so the fix is a deterministic `modelEvalOverride` that
  // bypasses `resolveShadow()` entirely and forces a known non-ready state —
  // same seam `resolveModelEvalShadowOverride` uses in production, just
  // hand-supplied instead of DB-resolved.
  const FORCED_SKIP = { repoId: null, modelEvalRunId: null, shadow: { state: 'skipped-unset', provider: null, model: null } };

  it('gap + active campaign (--campaign-digest present) REFUSES before any provider call', async () => {
    await assert.rejects(
      () => runShadowAndPersist({ verdict: 'X' }, 'gemini-pro-latest', null, ctx,
        { envelopeScopeCli: 'gap', campaignDigest: 'abc123' }),
      /campaign-ineligible/,
    );
  });

  it('gap WITHOUT an active campaign is a supported operator flag — does not throw', async () => {
    const result = { verdict: 'X' };
    await assert.doesNotReject(
      () => runShadowAndPersist(result, 'gemini-pro-latest', null, ctx,
        { envelopeScopeCli: 'gap', campaignDigest: null, modelEvalOverride: FORCED_SKIP }),
    );
  });

  it('an invalid scope under an active campaign REFUSES before any provider call', async () => {
    await assert.rejects(
      () => runShadowAndPersist({ verdict: 'X' }, 'gemini-pro-latest', null, ctx,
        { envelopeScopeCli: 'not-a-real-scope', campaignDigest: 'abc123' }),
      /invalid --envelope-scope/,
    );
  });

  it('an invalid scope with NO active campaign warns and proceeds (interactive default)', async () => {
    const result = { verdict: 'X' };
    await assert.doesNotReject(
      () => runShadowAndPersist(result, 'gemini-pro-latest', null, ctx,
        { envelopeScopeCli: 'not-a-real-scope', campaignDigest: null, modelEvalOverride: FORCED_SKIP }),
    );
  });

  it('a VALID scope under an active campaign does not refuse (only invalid/gap do)', async () => {
    const result = { verdict: 'X' };
    await assert.doesNotReject(
      () => runShadowAndPersist(result, 'gemini-pro-latest', null, ctx,
        { envelopeScopeCli: 'thin', campaignDigest: 'abc123', modelEvalOverride: FORCED_SKIP }),
    );
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

// ── Missing --run-id warning (2026-07-26 — 101 lost consumer reviews) ───────
// Root-cause chain: a cloud-enabled `review` invocation with no --run-id
// silently never persists to audit_runs (runShadowAndPersist's cloud-write
// guard is `if (!runId) return` — no log, no error). Found tracing why a
// consumer repo's 101 real audit runs over 30 days all had a genuine Gemini
// verdict computed but NEVER reached the store. This pins the pure predicate
// that decides when to warn, extracted specifically so this is unit-testable
// without mocking the whole CLI/cloud-detection flow.
describe('shouldWarnMissingRunId — the loud warning for a silent persistence loss', () => {
  it('warns: review mode, cloud enabled, no run-id — the exact incident shape', () => {
    assert.equal(shouldWarnMissingRunId({ mode: 'review', runId: null, cloudEnabled: true }), true);
  });

  it('does not warn when --run-id is supplied', () => {
    assert.equal(shouldWarnMissingRunId({ mode: 'review', runId: 'abc-123', cloudEnabled: true }), false);
  });

  it('does not warn when cloud is genuinely off — that is the legitimate local-only case', () => {
    assert.equal(shouldWarnMissingRunId({ mode: 'review', runId: null, cloudEnabled: false }), false);
  });

  it('does not warn for non-review modes (ping, set-provider)', () => {
    assert.equal(shouldWarnMissingRunId({ mode: 'ping', runId: null, cloudEnabled: true }), false);
    assert.equal(shouldWarnMissingRunId({ mode: 'set-provider', runId: null, cloudEnabled: true }), false);
  });
});

// The warning above was NOT sufficient — proven the same day it shipped. A
// wine-cellar-app session already holding a pre-fix SKILL.md in context kept
// omitting --run-id, and run 94a2676f persisted final_review_model: null even
// though Gemini demonstrably ran (the verdict is in that repo's local
// .audit/outcomes.jsonl). A flag whose only enforcement is "the calling agent
// remembers to pass it" fails exactly this way, so the id is now recovered from
// the marker the AUDIT wrote, which needs no agent cooperation.
describe('recoverRunIdFromMarker — the id the audit already wrote to disk', () => {
  const FRESH_TS = '2026-07-26T17:44:54.387Z';
  const NOW = Date.parse('2026-07-26T17:46:00.000Z');
  // Verbatim shape of wine-cellar-app's real marker at the moment run
  // 94a2676f lost its final review.
  const REAL_MARKER = {
    runId: '94a2676f-ed92-40f1-abce-251310eacfdd',
    sid: 'audit-1785087895857',
    round: 4,
    auditedSha: '046449a834dbebe6591e721c25c8d53e174a343f',
    auditedTree: '43d9ac56c3d61456f1030d87080a82cb23f65098',
    ts: FRESH_TS,
  };

  it('recovers the run id from the real marker that was on disk during the incident', () => {
    const got = recoverRunIdFromMarker({ marker: REAL_MARKER, nowMs: NOW });
    assert.deepEqual(got, { runId: '94a2676f-ed92-40f1-abce-251310eacfdd', reason: 'recovered' });
  });

  it('refuses a stale marker rather than attaching this review to an older run', () => {
    // A wrong row looks like real evidence, which is worse than no row.
    const dayLater = Date.parse('2026-07-27T18:00:00.000Z');
    assert.deepEqual(
      recoverRunIdFromMarker({ marker: REAL_MARKER, nowMs: dayLater }),
      { runId: null, reason: 'stale' }
    );
  });

  it('accepts a marker right at the age boundary and refuses one just past it', () => {
    const base = Date.parse(FRESH_TS);
    assert.equal(
      recoverRunIdFromMarker({ marker: REAL_MARKER, nowMs: base + RUN_ID_MARKER_MAX_AGE_MS }).reason,
      'recovered'
    );
    assert.equal(
      recoverRunIdFromMarker({ marker: REAL_MARKER, nowMs: base + RUN_ID_MARKER_MAX_AGE_MS + 1 }).reason,
      'stale'
    );
  });

  it('reports no-marker when the file was absent or unreadable', () => {
    assert.deepEqual(recoverRunIdFromMarker({ marker: null, nowMs: NOW }), { runId: null, reason: 'no-marker' });
    assert.deepEqual(recoverRunIdFromMarker({ marker: 'not-an-object', nowMs: NOW }), { runId: null, reason: 'no-marker' });
  });

  it('rejects a run id the ship-commit readers would reject, so the two can never disagree', () => {
    // RUN_ID_RE is /^[A-Za-z0-9-]{8,64}$/ — too short, and illegal characters.
    for (const bad of ['short', 'has spaces in it', 'semi;colon;injection', '', 'a'.repeat(65)]) {
      assert.equal(
        recoverRunIdFromMarker({ marker: { ...REAL_MARKER, runId: bad }, nowMs: NOW }).reason,
        'malformed',
        `expected malformed for runId ${JSON.stringify(bad)}`
      );
    }
  });

  it('treats a missing or unparseable ts as malformed — freshness cannot be assumed', () => {
    assert.equal(recoverRunIdFromMarker({ marker: { runId: REAL_MARKER.runId }, nowMs: NOW }).reason, 'malformed');
    assert.equal(
      recoverRunIdFromMarker({ marker: { ...REAL_MARKER, ts: 'not-a-date' }, nowMs: NOW }).reason,
      'malformed'
    );
  });
});

// Found live 2026-07-27, the day the recovery above shipped: a wine-cellar-app
// /audit-plan session's Gemini review (--mode plan) omitted --run-id — which
// is CORRECT for plan mode, since audit-plan never has a commit-scoped
// audit_runs row to attach to — but recoverRunIdFromMarker still fired,
// because auditMode was never checked. It found the still-fresh (< 6h old)
// marker from an EARLIER, unrelated code audit and misattached the plan
// review's shadow findings to that run_id. Worse than a wrong label:
// recordFinalReviewFindings's own DELETE (scoped only by run_id) then wiped
// that code audit's 4 already-adjudicated findings as a side effect. This
// predicate is the fix — it must be auditMode-only, deliberately blind to
// whether a marker actually exists, so the two failure classes stay separate.
describe('canAttemptRunIdRecovery — plan mode has no marker to recover, ever', () => {
  it('permits recovery for code mode — the only mode that writes the marker', () => {
    assert.equal(canAttemptRunIdRecovery({ auditMode: 'code' }), true);
  });

  it('refuses for plan mode — this is the exact incident shape', () => {
    assert.equal(canAttemptRunIdRecovery({ auditMode: 'plan' }), false);
  });

  it('refuses for any mode string that is not literally "code" (fail closed, not an allowlist bypass)', () => {
    for (const auditMode of ['rebuttal', '', undefined, null, 'Code', 'CODE']) {
      assert.equal(canAttemptRunIdRecovery({ auditMode }), false, `expected false for auditMode ${JSON.stringify(auditMode)}`);
    }
  });
});
