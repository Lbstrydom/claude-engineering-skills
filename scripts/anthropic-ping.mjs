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
import { createAnthropicClient, resolveBackend, isClaudeAvailable } from './lib/anthropic-client.mjs';

async function main() {
  const backend = resolveBackend();
  const model = briefConfig.claudeModel;
  process.stderr.write(`[anthropic-ping] backend=${backend} model=${model}\n`);

  // ROUTE, not key. An Azure work profile reaches Claude through the tenant's
  // own endpoint and never sets ANTHROPIC_API_KEY, so the raw-key test refused
  // to ping a backend that works (AGENTS.md availability-gate rule).
  if (!isClaudeAvailable()) {
    process.stderr.write(
      `[anthropic-ping] no Claude route: the sdk backend needs ANTHROPIC_API_KEY in .env, `
      + `or an active Azure work profile (AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY)\n`);
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
