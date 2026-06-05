#!/usr/bin/env node
/**
 * @fileoverview Azure rate-limit diagnostic.
 *
 * Makes one tiny call to each configured Azure deployment and prints the
 * rate-limit headers Azure returns (`x-ratelimit-limit-tokens`,
 * `-limit-requests`, reset windows). Answers "what is our TPM/RPM, and how
 * close are we?" without guessing.
 *
 * Usage: node scripts/azure-limits.mjs   (or: npm run azure:limits)
 *
 * @module scripts/azure-limits
 */

import { azureConfig } from './lib/config.mjs';
import { createOpenAIClient } from './lib/openai-client.mjs';
import { createAnthropicClient } from './lib/anthropic-client.mjs';
import { azureMaxRetries } from './lib/azure-throttle.mjs';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

function rowsFrom(headers) {
  const get = (n) => headers.get(n);
  // Azure OpenAI uses x-ratelimit-*; Foundry Claude adds renewalperiod/reset.
  return {
    limitTokens: get('x-ratelimit-limit-tokens'),
    remainingTokens: get('x-ratelimit-remaining-tokens'),
    limitRequests: get('x-ratelimit-limit-requests'),
    remainingRequests: get('x-ratelimit-remaining-requests'),
    windowSecs: get('x-ratelimit-renewalperiod-tokens') || get('x-ratelimit-renewalperiod-requests'),
    resetTokens: get('x-ratelimit-reset-tokens'),
    resetRequests: get('x-ratelimit-reset-requests'),
  };
}

function printRow(label, deployment, r, err) {
  if (err) {
    process.stdout.write(`  ${R}✗${X} ${label.padEnd(10)} ${D}${deployment}${X}  ${R}${err}${X}\n`);
    return;
  }
  const tpm = r.limitTokens ? `${r.limitTokens} TPM (${r.remainingTokens} left)` : '— TPM';
  const rpm = r.limitRequests ? `${r.limitRequests} RPM (${r.remainingRequests} left)` : '— RPM';
  const win = r.windowSecs ? ` · ${r.windowSecs}s window` : '';
  process.stdout.write(`  ${G}✓${X} ${label.padEnd(10)} ${D}${deployment}${X}\n      ${tpm} · ${rpm}${win}\n`);
}

async function probeOpenAI(purpose, deployment, kind) {
  const client = await createOpenAIClient({ purpose });
  if (kind === 'embed') {
    const { response } = await client.embeddings.create(
      { model: deployment, input: 'ping', dimensions: 768 }).withResponse();
    return rowsFrom(response.headers);
  }
  const { response } = await client.responses.create(
    { model: deployment, input: 'ping', max_output_tokens: 16 }).withResponse();
  return rowsFrom(response.headers);
}

async function probeClaude(deployment) {
  const client = await createAnthropicClient({ baseURL: azureConfig.claudeBaseUrl, redactor: null });
  const { response } = await client.messages.create(
    { model: deployment, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }).withResponse();
  return rowsFrom(response.headers);
}

async function main() {
  if (!azureConfig.active) {
    process.stderr.write(`${Y}Azure work profile inactive${X} (AZURE_OPENAI_ENDPOINT not set) — nothing to probe.\n`);
    process.exit(0);
  }
  process.stdout.write(`${G}Azure rate limits${X} ${D}(${azureConfig.openaiEndpoint})${X}\n`);
  process.stdout.write(`  ${D}throttle: AZURE_MAX_CONCURRENCY in-flight cap · maxRetries=${azureMaxRetries()} (Retry-After-aware)${X}\n\n`);

  const probes = [
    ['GPT', azureConfig.gptDeployment, () => probeOpenAI('gpt', azureConfig.gptDeployment, 'gpt')],
    ['Embeddings', azureConfig.embedDeployment, () => probeOpenAI('embed', azureConfig.embedDeployment, 'embed')],
    ['Opus', azureConfig.claudeDeployment, () => probeClaude(azureConfig.claudeDeployment)],
    ['Sonnet', azureConfig.summaryDeployment, () => probeClaude(azureConfig.summaryDeployment)],
  ];

  for (const [label, deployment, fn] of probes) {
    try {
      printRow(label, deployment, await fn());
    } catch (err) {
      printRow(label, deployment, null, `${err.status || ''} ${(err.message || err).toString().slice(0, 90)}`.trim());
    }
  }

  process.stdout.write(
    `\n  ${D}10 RPM / 10K TPM is the unprovisioned default. Raise it: Azure AI Foundry →\n` +
    `  your deployment → Edit → increase the tokens-per-minute quota.${X}\n`,
  );
}

main().catch((err) => { process.stderr.write(`${R}error${X}: ${err.message}\n`); process.exit(1); });
