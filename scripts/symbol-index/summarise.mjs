#!/usr/bin/env node
/**
 * @fileoverview Phase B.2 — purpose summariser.
 *
 * Reads symbol records from stdin (one JSON line each), batches them, calls
 * Haiku (resolved sentinel) to produce a one-line `purposeSummary` per
 * symbol, emits enriched records on stdout.
 *
 * Body content already passed the egress gate at extract time. Per defence-
 * in-depth, this stage runs `redactSecrets` on outbound LLM payloads.
 *
 * Skips records flagged `redacted: true` (their purposeSummary is already set
 * to [SECRET_REDACTED]).
 *
 * @module scripts/symbol-index/summarise
 */

import readline from 'node:readline';
import { briefConfig } from '../lib/config.mjs';
import { symbolIndexConfig, azureConfig } from '../lib/config.mjs';
import { chunkBatches } from '../lib/symbol-index.mjs';
import { redactSecrets } from '../lib/sensitive-egress-gate.mjs';
import { emit } from '../lib/cli-io.mjs';
import { createAnthropicClient } from '../lib/anthropic-client.mjs';
import { azureThrottle } from '../lib/azure-throttle.mjs';

const MODEL = symbolIndexConfig.summariseModel || briefConfig.claudeModel;

function logProgress(s) { process.stderr.write(`  [summarise] ${s}\n`); }

/**
 * Returns purposeSummary strings parallel to the batch input.
 * Falls back to truncated body if Anthropic SDK unavailable or call fails.
 */
async function summariseBatch(batch) {
  // Under the Azure work profile, summaries run on Sonnet via Foundry (native
  // Anthropic, Bearer). Otherwise the public Anthropic API (Haiku by default).
  if (!azureConfig.active && !process.env.ANTHROPIC_API_KEY) {
    logProgress(`no Claude provider (set ANTHROPIC_API_KEY or the Azure work profile) — emitting empty summaries`);
    return batch.map(() => null);
  }
  const client = azureConfig.active
    ? await createAnthropicClient({ azureRoute: azureConfig.claudeRoute })
    : await createAnthropicClient();
  const model = azureConfig.active ? azureConfig.summaryDeployment : MODEL;
  const lines = batch.map((s, i) =>
    `${i + 1}. ${s.kind} \`${s.symbolName}\` in \`${s.filePath}\` (lines ${s.startLine}-${s.endLine}):\n` +
    '```\n' + redactSecrets((s.bodyText || '').slice(0, 1500)) + '\n```'
  );
  const prompt = `Summarise each of these ${batch.length} symbols in EXACTLY ONE LINE describing its purpose. ` +
    `Use plain English; no boilerplate. Output as a numbered list (one line each, matching input numbers). ` +
    `If a symbol's body is empty or unparseable, write "<no body>".\n\n` +
    lines.join('\n\n');
  try {
    const res = await azureThrottle(() => client.messages.create({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }));
    const text = res.content?.map(c => c.text || '').join('') || '';
    // Parse "N. summary" lines
    const out = batch.map(() => null);
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(\d+)\.\s*(.*)$/);
      if (!m) continue;
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < out.length) out[idx] = m[2].trim();
    }
    return out;
  } catch (err) {
    logProgress(`batch failed: ${err.message} — falling back to null`);
    return batch.map(() => null);
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  const records = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const r = JSON.parse(trimmed);
      records.push(r);
    } catch { /* skip malformed */ }
  }

  const symbols = records.filter(r => r.type === 'symbol' && !r.redacted);
  const passthrough = records.filter(r => r.type !== 'symbol' || r.redacted);

  // Emit passthrough (violations + redacted symbols) unchanged
  for (const r of passthrough) emit(r);

  if (symbols.length === 0) {
    emit({ type: 'summary', counts: { summarised: 0, batches: 0 } });
    return;
  }

  const batches = chunkBatches(symbols, symbolIndexConfig.batchSize);
  logProgress(`${symbols.length} symbols → ${batches.length} batches (size ${symbolIndexConfig.batchSize})`);
  let summarised = 0;
  // Run with bounded concurrency
  const concurrency = symbolIndexConfig.llmConcurrency;
  for (let i = 0; i < batches.length; i += concurrency) {
    const slice = batches.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(summariseBatch));
    for (let bi = 0; bi < slice.length; bi++) {
      const batch = slice[bi];
      const summaries = results[bi];
      for (let si = 0; si < batch.length; si++) {
        const sym = batch[si];
        emit({ ...sym, purposeSummary: summaries[si] });
        if (summaries[si]) summarised++;
      }
    }
  }
  emit({ type: 'summary', counts: { summarised, batches: batches.length } });
  logProgress(`done — summarised=${summarised}/${symbols.length}`);
}

main().catch(err => {
  process.stderr.write(`summarise: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
