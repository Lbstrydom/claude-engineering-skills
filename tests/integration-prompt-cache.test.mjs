/**
 * Live integration test: prove OpenAI's prefix cache actually fires on the
 * 3-message structure produced by buildAuditPassPrompt.  Two back-to-back
 * calls with byte-identical msg #1 should produce cached_tokens > 0 on
 * the second call.
 *
 * **Gated** by both `OPENAI_API_KEY` AND `RUN_LIVE_TESTS=1`.  Skipped by
 * default — costs ~$0.01-0.02 per run.
 *
 * Per plan §7 (R1/L1 fix): assertion simplified to `cached_tokens > 0`
 * (provider-grounded, no estimator dependency).  Fixture char-length is
 * locked >= 8192 (= 2048 tokens via Math.ceil(length/4)) to exceed
 * OpenAI's 1024-token cache-eligibility minimum.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';

const FIXTURE_PATH = path.resolve(import.meta.dirname, 'fixtures/prefix-cache-stable-prefix.txt');

const ENABLED = process.env.OPENAI_API_KEY && process.env.RUN_LIVE_TESTS === '1';

const REPLY_SCHEMA = z.object({ ack: z.string() });

describe('OpenAI prefix-cache live integration', { skip: !ENABLED }, () => {
  let openai;
  let stablePrefix;

  before(async () => {
    if (!ENABLED) return;
    const OpenAI = (await import('openai')).default;
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    stablePrefix = fs.readFileSync(FIXTURE_PATH, 'utf8');
    assert.ok(stablePrefix.length >= 8192,
      `Fixture must be >= 8192 chars for cache eligibility (got ${stablePrefix.length}). Regenerate via tests/fixtures/.`);
  });

  it('second call hits cache when msg #1 is byte-identical', async () => {
    const baseInput = [
      { role: 'system', content: 'You acknowledge briefly.  Reply with {"ack": "<one-word>"}.' },
      { role: 'user', content: stablePrefix }, // The byte-identical cacheable part
    ];

    // Use the same model the audit pipeline uses so eligibility behaviour
    // matches production. Resolved at call time via model-resolver to follow
    // the same `latest-gpt` sentinel chain.
    const { resolveModel } = await import('../scripts/lib/model-resolver.mjs');
    const MODEL = resolveModel(process.env.OPENAI_AUDIT_MODEL || 'latest-gpt');
    process.stderr.write(`  [integration-cache] using model: ${MODEL}\n`);

    const call = (variantTail) => openai.responses.parse({
      model: MODEL,
      input: [...baseInput, { role: 'user', content: variantTail }],
      text: { format: zodTextFormat(REPLY_SCHEMA, 'reply') },
      max_output_tokens: 256,
    });

    // Read cached_tokens from input_tokens_details (Responses API shape) —
    // NOT prompt_tokens_details (Chat Completions shape).  This bug existed
    // in production code before this test exposed it (2026-05-11).
    const readCached = (r) => r.usage?.input_tokens_details?.cached_tokens
      ?? r.usage?.prompt_tokens_details?.cached_tokens
      ?? 0;

    // First call — seeds the cache
    const r1 = await call('Variant A — first call to seed prefix cache.');
    const r1Cached = readCached(r1);

    // Small delay so the cache can propagate across server shards.
    // Empirically: too-fast back-to-back calls hit different nodes before
    // cache is visible (the "Parallel Trap" Gemini flagged in brainstorm).
    await new Promise(r => setTimeout(r, 2000));

    // Second call within TTL — should hit cache on the byte-stable prefix
    const r2 = await call('Variant B — second call should reuse cached prefix.');
    const r2Cached = readCached(r2);

    process.stderr.write(`  [integration-cache] call#1: cached=${r1Cached} | call#2: cached=${r2Cached}\n`);

    // Provider-grounded assertion: second call MUST have a non-zero
    // cached_tokens count.  If this fails, either:
    //   (a) the test ran across a TTL window (5min default — flaky test),
    //   (b) OpenAI changed cache eligibility (re-check threshold),
    //   (c) buildAuditPassPrompt is producing a non-stable prefix.
    assert.ok(r2Cached > 0,
      `Expected cached_tokens > 0 on second call (got ${r2Cached}). ` +
      `Likely cache miss — investigate prefix stability OR TTL window.`);
  });
});
