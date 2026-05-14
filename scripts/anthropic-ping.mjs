#!/usr/bin/env node
/**
 * @fileoverview Smoke-test for the Anthropic backend factory.
 *
 * Routes a 1-token "ping" prompt through whichever backend `CLAUDE_BACKEND`
 * resolves to and prints the response, usage, and latency. Use to verify
 * the migration path before flipping `CLAUDE_BACKEND=cli` in production.
 *
 *   npm run anthropic:ping
 *   CLAUDE_BACKEND=cli npm run anthropic:ping
 *   CLAUDE_BACKEND=sdk npm run anthropic:ping
 *
 * Exits 0 on a non-empty response, 1 on any error (so CI can gate on it).
 *
 * The `cost_usd` field surfaces `_meta.cost_usd` from the cli adapter's
 * documented response shape (see normaliseCliOutput in anthropic-client.mjs).
 * It is undefined on the sdk backend (raw API does not return per-call cost).
 *
 * @module scripts/anthropic-ping
 */
import { briefConfig } from './lib/config.mjs';
import { createAnthropicClient, resolveBackend } from './lib/anthropic-client.mjs';

async function main() {
  const backend = resolveBackend();
  const model = briefConfig.claudeModel;
  process.stderr.write(`[anthropic-ping] backend=${backend} model=${model}\n`);

  if (backend === 'sdk' && !process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(`[anthropic-ping] sdk backend requires ANTHROPIC_API_KEY in .env\n`);
    process.exit(1);
  }

  const client = await createAnthropicClient();

  const start = Date.now();
  const resp = await client.messages.create({
    model,
    max_tokens: 50,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  });
  const latencyMs = Date.now() - start;

  const text = resp?.content?.[0]?.text?.trim() ?? '';
  if (!text) {
    process.stderr.write(`[anthropic-ping] empty response\n`);
    process.exit(1);
  }

  const out = {
    backend,
    model,
    response: text.slice(0, 200),
    usage: resp.usage,
    latencyMs,
    cost_usd: resp._meta?.cost_usd,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch(err => {
  // Surface the full diagnostic context. CI runners scrape stderr — include
  // anything that helps distinguish auth errors from rate limits from
  // subprocess-exit errors.
  process.stderr.write(`[anthropic-ping] FAILED: ${err.message}\n`);
  if (err.status !== undefined) process.stderr.write(`  status: ${err.status}\n`);
  if (err.code !== undefined) process.stderr.write(`  code: ${err.code}\n`);
  if (err.cause) process.stderr.write(`  cause: ${err.cause.message || err.cause}\n`);
  if (err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
