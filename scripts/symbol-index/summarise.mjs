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
 * Output-token budget per symbol.
 *
 * Measured 2026-11-14, 10-symbol batches on `claude-haiku-5-5`: **916, 943,
 * 991, 1146, 1308** output tokens — ~92-131 per symbol over 5 runs.
 *
 * Set at 256 (not the 192 this change first shipped) because the 5th sample
 * moved the observed maximum by 14% over the first four, which is the round-1
 * audit's H5 point landing on its own figures: a handful of samples bounds what
 * was seen, not what fits. 256 keeps ~2x headroom over the worst observation
 * instead of the 1.47x that 192 left.
 *
 * The headroom is deliberate, because truncation here was SILENT DATA LOSS — a
 * cut numbered list yields `null` for the tail symbols. That is now also
 * DETECTED (`assessBatchCompleteness`), so the ceiling no longer has to be
 * bulletproof on its own; the two defences are independent.
 */
const TOKENS_PER_SYMBOL = 256;

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
 * Did this response deliver a summary for every symbol we asked about?
 *
 * **A short list and a complete one must not leave here as the same value.**
 * The parse maps a missing numbered entry to `null`, and `main()` folds that
 * into its `summarised=X/Y` line without failing — so a response the provider
 * cut off at `max_tokens` produced a silently incomplete arch-memory index,
 * indistinguishable from symbols the model genuinely declined to describe.
 *
 * Two independent signals, because they fail independently, and **EITHER one
 * alone makes the batch incomplete**:
 *   - a missing entry for any requested index — catches a cut-off list whose
 *     `stop_reason` did not say so (on the cli backend the ceiling is not
 *     enforced at all, so `stop_reason` cannot be relied on to report a cut),
 *     a renumbered list, and a model that simply skipped one.
 *   - `stop_reason === 'max_tokens'` — the provider says it stopped at the
 *     ceiling. **A full slate of non-empty entries does NOT clear this**: the
 *     last summary can be cut mid-sentence and still be a non-empty string, so
 *     "every slot filled" is not evidence that every slot is finished. The
 *     first version of this function (and its test) treated a complete-looking
 *     `max_tokens` response as complete, which the round-2 audit raised as the
 *     same Silent-Data-Loss concern it had already raised once — correctly.
 *
 * Reported as a named incompleteness so the caller can log it loudly rather
 * than emit nulls that read as "no summary available".
 *
 * @param {Array<string|null>} summaries - parse output, parallel to the batch
 * @param {string|undefined} stopReason - the response's `stop_reason`
 * @returns {{complete: boolean, missing: number[], truncated: boolean}}
 */
export function assessBatchCompleteness(summaries, stopReason) {
  const list = Array.isArray(summaries) ? summaries : [];
  const missing = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (typeof s !== 'string' || !s.trim()) missing.push(i + 1);
  }
  const truncated = stopReason === 'max_tokens';
  return {
    complete: missing.length === 0 && !truncated,
    missing,
    truncated,
  };
}

/**
 * Summarise one batch.
 *
 * **Returns the completeness VERDICT alongside the summaries, rather than
 * logging it and dropping it.** The round-3 audit raised the Silent-Data-Loss
 * concern for the THIRD time, and correctly: the previous version computed a
 * verdict in `assessBatchCompleteness`, logged it, and returned only the
 * strings — so `main()` re-derived its own `complete` from a null count and
 * emitted `complete: true` for exactly the truncated-but-fully-populated case
 * the verdict existed to catch. Two places deciding one thing, disagreeing.
 *
 * That is the single-oracle rule, and three patches in three rounds is what it
 * costs to ignore it: the structural answer is that the verdict has ONE
 * producer and every consumer reads it, so there is no second computation left
 * to drift.
 *
 * @param {Array<object>} batch
 * @returns {Promise<{summaries: Array<string|null>,
 *   health: {complete: boolean, missing: number[], truncated: boolean}}>}
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
    const summaries = batch.map(() => null);
    // NOT complete: no provider ran, so every symbol is unsummarised. Reporting
    // this as complete is how the availability-gate defect stayed invisible.
    return { summaries, health: assessBatchCompleteness(summaries, undefined) };
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
    // TRUNCATION IS NOT AN EMPTY RESULT. Without this the run emits nulls for
    // the tail of a cut-off response and reports `summarised=X/Y` as though the
    // model had declined to describe those symbols — the two are
    // indistinguishable downstream, and the arch-memory index loses them
    // silently. Retrying the batch at a larger ceiling is deliberately NOT done
    // here: on the cli backend the ceiling is unenforced, so a retry would
    // change nothing while doubling the spend. Reporting it is what lets the
    // operator act (raise ARCH_INDEX_BATCH_SIZE's inverse, or switch backend).
    const health = assessBatchCompleteness(out, res.stop_reason);
    if (!health.complete) {
      // A `max_tokens` stop with every slot filled is the subtle case: nothing
      // is missing, but the LAST entry may be cut mid-sentence, so the batch is
      // still not trustworthy. Say which case it is rather than printing a
      // misleading "0 symbols have no summary".
      const detail = health.missing.length
        ? `${health.missing.length}/${batch.length} symbols have no summary; missing indices `
          + `${health.missing.slice(0, 20).join(',')}${health.missing.length > 20 ? ',…' : ''}`
        : `all ${batch.length} entries present but the last may be cut mid-sentence`;
      const cause = health.truncated
        ? `provider stopped at max_tokens=${summaryMaxTokens(batch.length)}`
        : 'response omitted entries without reporting truncation';
      logProgress(`INCOMPLETE batch: ${detail} (${cause})`);
    }
    return { summaries: out, health };
  } catch (err) {
    logProgress(`batch failed: ${err.message} — falling back to null`);
    const summaries = batch.map(() => null);
    return { summaries, health: assessBatchCompleteness(summaries, undefined) };
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
    emit({
      type: 'summary',
      counts: { summarised: 0, batches: 0, missing: 0, incompleteBatches: 0, truncatedBatches: 0 },
      complete: true,
    });
    return;
  }

  const batches = chunkBatches(symbols, symbolIndexConfig.batchSize);
  logProgress(`${symbols.length} symbols → ${batches.length} batches (size ${symbolIndexConfig.batchSize})`);
  let summarised = 0;
  let incompleteBatches = 0;
  let truncatedBatches = 0;
  // Run with bounded concurrency
  const concurrency = symbolIndexConfig.llmConcurrency;
  for (let i = 0; i < batches.length; i += concurrency) {
    const slice = batches.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(summariseBatch));
    for (let bi = 0; bi < slice.length; bi++) {
      const batch = slice[bi];
      const { summaries, health } = results[bi];
      // AGGREGATE the batch's own verdict; never recompute one here. A second
      // computation is a second opinion, and the two drifted for three rounds.
      if (!health.complete) incompleteBatches++;
      if (health.truncated) truncatedBatches++;
      for (let si = 0; si < batch.length; si++) {
        const sym = batch[si];
        emit({ ...sym, purposeSummary: summaries[si] });
        if (summaries[si]) summarised++;
      }
    }
  }
  // Carried in the envelope, not just the stderr log: a caller or CI step
  // reading only stdout could otherwise not tell a run that summarised every
  // symbol from one that lost a third of them to truncation.
  //
  // `complete` is the CONJUNCTION of the batches' own verdicts — NOT
  // `missing === 0`, which is what it used to be and which reported
  // `complete: true` for a batch the oracle had already judged truncated. A
  // populated slot is not a finished one, so a count of nulls cannot answer
  // this question; only the verdict that saw the `stop_reason` can.
  const missing = symbols.length - summarised;
  emit({
    type: 'summary',
    counts: {
      summarised, batches: batches.length, missing,
      incompleteBatches, truncatedBatches,
    },
    complete: incompleteBatches === 0,
  });
  logProgress(
    `done — summarised=${summarised}/${symbols.length}`
    + (incompleteBatches
      ? ` — ${incompleteBatches}/${batches.length} batch(es) INCOMPLETE`
        + `${truncatedBatches ? ` (${truncatedBatches} hit the token ceiling)` : ''}`
        + `${missing ? `, ${missing} symbol(s) with no summary` : ', every slot populated but the last may be cut'}`
        + '; see the INCOMPLETE batch lines above'
      : ''),
  );
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
