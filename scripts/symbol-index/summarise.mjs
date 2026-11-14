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
import { createAnthropicClient, isClaudeAvailable } from '../lib/anthropic-client.mjs';
import { azureThrottle } from '../lib/azure-throttle.mjs';
import { isInvokedAsScript } from '../lib/cli-entry.mjs';

const MODEL = symbolIndexConfig.summariseModel || briefConfig.claudeModel;

function logProgress(s) { process.stderr.write(`  [summarise] ${s}\n`); }

/** Absolute ceiling, kept so the configured default batch of 50 is unchanged. */
const MAX_SUMMARY_TOKENS = 4096;
/**
 * Output-token budget per symbol. Measured 2026-11-14 at ~102 tokens/symbol
 * (4 runs of a 10-symbol batch: 916–1146 output tokens, `claude-haiku-5-5`).
 * 192 leaves ~88% headroom, and the headroom is deliberate: truncation here is
 * SILENT DATA LOSS — a cut numbered list yields `null` for the tail symbols,
 * which `summariseBatch`'s parse folds into the `summarised=X/Y` log without
 * failing the run.
 */
const TOKENS_PER_SYMBOL = 192;

/**
 * The output ceiling for a batch — a function of the request rather than a
 * constant three orders of magnitude above the answer (the previous 4096 on a
 * one-line-per-symbol call).
 *
 * This buys no spend reduction and does not claim one: on the sdk backend you
 * are billed for tokens emitted, not for the ceiling, and on the cli backend
 * the ceiling is accepted and ignored outright (measured 2026-11-14: 1995
 * output tokens against `max_tokens: 200`). What it buys is a bound that is
 * honest about the size of the answer.
 *
 * @param {number} batchLength - symbols in this batch
 * @returns {number} max_tokens for the call
 */
export function summaryMaxTokens(batchLength) {
  const n = Number(batchLength);
  if (!Number.isFinite(n) || n <= 0) return MAX_SUMMARY_TOKENS;
  return Math.min(MAX_SUMMARY_TOKENS, TOKENS_PER_SYMBOL * Math.ceil(n));
}

/**
 * Returns purposeSummary strings parallel to the batch input.
 * Falls back to truncated body if Anthropic SDK unavailable or call fails.
 */
async function summariseBatch(batch) {
  // Under the Azure work profile, summaries run on Sonnet via Foundry (native
  // Anthropic, Bearer). Otherwise the public Anthropic API (Haiku by default).
  // Availability is a question about a ROUTE, not about a public env var
  // (AGENTS.md, Anthropic Backend Routing). The old `!ANTHROPIC_API_KEY` test
  // was the fourth recorded instance of that anti-pattern and the most
  // expensive one: under `CLAUDE_BACKEND=cli` — which needs no key, because it
  // authenticates through the `claude` CLI — it emitted null summaries for the
  // WHOLE symbol corpus while a fully working backend sat unused in the same
  // process, silently stripping every `purposeSummary` from the arch-memory
  // index. `isClaudeAvailable()` answers for sdk, cli, bedrock and an Azure
  // route alike.
  if (!azureConfig.active && !isClaudeAvailable()) {
    logProgress(`no Claude provider (set ANTHROPIC_API_KEY, CLAUDE_BACKEND=cli, or the Azure work profile) — emitting empty summaries`);
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
      // At the configured default batch of 50 this is 4096, so production is
      // byte-identical; it only bites on the small batches where the old
      // constant never bound. See `summaryMaxTokens` for the measurement.
      max_tokens: summaryMaxTokens(batch.length),
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

// ENTRY GUARD. This file was the only `main()`-bearing script under
// scripts/symbol-index/ without one (census 2026-11-14: every sibling with a
// main() had it, including its own `summarise-domains.mjs`), so ANY import of
// it — a test, a library consumer, a tool reading its exports — ran the whole
// summariser, which blocks forever reading stdin. `isInvokedAsScript` and not
// a hand comparison of `process.argv[1]` with `import.meta.url`: Node realpaths
// one side and not the other, so through a symlink or junction the hand guard
// is false and the CLI exits 0 having run nothing (AGENTS.md, CLI smoke
// contract).
if (isInvokedAsScript(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`summarise: fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
