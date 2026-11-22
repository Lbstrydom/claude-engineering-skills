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

import '../lib/help-guard-run.mjs'; import readline from 'node:readline';
import { briefConfig } from '../lib/config.mjs';
import { symbolIndexConfig, azureConfig } from '../lib/config.mjs';
import { chunkBatches } from '../lib/symbol-index.mjs';
import { redactSecrets } from '../lib/sensitive-egress-gate.mjs';
import { emit, finishAndExit } from '../lib/cli-io.mjs';
import { createAnthropicClient, isClaudeAvailable } from '../lib/anthropic-client.mjs';
import { azureThrottle } from '../lib/azure-throttle.mjs';
import { isInvokedAsScript } from '../lib/cli-entry.mjs';

const MODEL = symbolIndexConfig.summariseModel || briefConfig.claudeModel;

function logProgress(s) { process.stderr.write(`  [summarise] ${s}\n`); }

/**
 * Absolute ceiling on one call's output.
 *
 * Was 4096, which CAPPED the default batch of 50 below what the answer needs:
 * measured 2026-11-22 (50 real symbols, `claude-haiku-5-5`) at 4577 and 4374
 * output tokens, i.e. 87-92 per symbol, so a 50-symbol batch truncates on any
 * backend that enforces `max_tokens` (sdk). That is the 55 of 151 batches /
 * 410 symbols that came back INCOMPLETE on the 2026-11-22 full refresh. 16384
 * leaves `TOKENS_PER_SYMBOL * 50 = 12800` unclamped; it stays under the SDK's
 * non-streaming limit (a request is refused above ~21k max_tokens).
 */
const MAX_SUMMARY_TOKENS = 16384;
/**
 * Output-token budget per symbol.
 *
 * Measured 2026-11-14, 10-symbol batches on `claude-haiku-5-5`: **916, 943,
 * 991, 1146, 1308** output tokens — ~92-131 per symbol over 5 runs. Re-measured
 * 2026-11-22: 140 and 151 per symbol at batch 10, 87 and 92 at batch 50 (small
 * batches cost MORE per symbol: the preamble is amortised over fewer lines), so
 * 256 still leaves ~1.7x over the worst observation.
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
    return { summaries, health: assessBatchCompleteness(summaries, undefined), error: 'no Claude provider' };
  }
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
    // Inside the try: a client-construction failure is a provider failure with
    // a verdict, so the first attempt is counted like any other.
    const client = azureConfig.active
      ? await createAnthropicClient({ azureRoute: azureConfig.claudeRoute })
      : await createAnthropicClient();
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
    let lastParsed = -1;
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(\d+)\.\s*(.*)$/);
      if (!m) continue;
      const idx = Number(m[1]) - 1;
      // `lastParsed` = last entry in RESPONSE order: the one a cut can have hit,
      // which is not the highest index if entries arrive out of order.
      if (idx >= 0 && idx < out.length) { out[idx] = m[2].trim(); lastParsed = idx; }
    }
    // TRUNCATION IS NOT AN EMPTY RESULT. Without this the run emits nulls for
    // the tail of a cut-off response and reports `summarised=X/Y` as though the
    // model had declined to describe those symbols — the two are
    // indistinguishable downstream, and the arch-memory index loses them
    // silently. The verdict is returned and `summariseWithSplit` re-asks ONLY
    // what is missing, in halves (a larger ceiling would change nothing on the
    // cli backend, where it is unenforced; a smaller request is the lever).
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
    return { summaries: out, health, lastParsed };
  } catch (err) {
    const msg = String(err?.message || err || '') || 'unknown provider error';
    logProgress(`batch failed: ${msg} — falling back to null`);
    const summaries = batch.map(() => null);
    return { summaries, health: assessBatchCompleteness(summaries, undefined), failed: true, error: msg };
  }
}

/**
 * Re-run only what a batch failed to deliver, in halves, down to size 1.
 *
 * A response that came back short (the provider stopped at the ceiling, or the
 * model skipped entries) is NOT a reason to give up on the tail: those symbols
 * are re-asked in a smaller request, which needs less output. A thrown provider
 * error is different — a smaller request will not fix an auth or network fault,
 * so it is NOT split (that would multiply calls by the tree size for nothing).
 *
 * TRUST: every present entry is kept EXCEPT, when the provider stopped at the
 * ceiling, the last one — a populated slot is not a finished one, so it is
 * re-asked with the missing ones.
 *
 * BOUND. Re-asking a set of m symbols costs at most 2m-1 calls (a full binary
 * tree with m leaves, depth ceil(log2 m)+1; 7 levels for the default 50), so a
 * batch of n costs at most 1 + (2n-1) calls in the worst case where every call
 * truncates. `budget.remaining` caps the whole run at the sum of that, which is
 * 2 x symbols; once spent, unresolved symbols stop being retried and are
 * recorded as unsummarised with that reason.
 *
 * Nothing is ever back-filled: a symbol that fails at size 1 has `summary: null`
 * and a `reason`.
 *
 * @param {Array<object>} batch
 * @param {(b: Array<object>) => Promise<{summaries: Array<string|null>,
 *   health: {complete: boolean, missing: number[], truncated: boolean}, error?: string}>} once
 * @param {{remaining: number, calls: number, splits: number}} budget - mutated
 * @returns {Promise<Array<{summary: string|null, reason?: string}>>} parallel to `batch`
 */
export async function summariseWithSplit(batch, once, budget) {
  budget.calls++;
  // A rejected `once` (client construction, a non-Error throw) is a provider
  // failure like a returned one: normalised to a NON-EMPTY diagnostic, and
  // discriminated by `failed`, never by the message being truthy.
  let r0;
  try {
    r0 = await once(batch);
  } catch (err) {
    r0 = { failed: true, error: String(err?.message || err || '') || 'unknown provider error' };
  }
  const { summaries, health, error, lastParsed } = r0;
  const results = batch.map(() => ({ summary: null }));
  if (r0.failed || error !== undefined) {
    for (const r of results) r.reason = `provider error: ${error || 'unknown provider error'}`;
    return results;
  }
  const redo = [];
  // The cut entry is the last one in RESPONSE order (`lastParsed`); a provider
  // that cannot say falls back to the highest populated index.
  let lastPresent = Number.isInteger(lastParsed) ? lastParsed : -1;
  if (lastPresent < 0) {
    for (let i = 0; i < batch.length; i++) {
      if (typeof summaries[i] === 'string' && summaries[i].trim()) lastPresent = i;
    }
  }
  for (let i = 0; i < batch.length; i++) {
    const present = typeof summaries[i] === 'string' && summaries[i].trim();
    if (present && !(health.truncated && i === lastPresent)) results[i] = { summary: summaries[i].trim() };
    else redo.push(i);
  }
  if (redo.length === 0) return results;
  const why = health.truncated ? 'truncated at max_tokens' : 'entry omitted by the model';
  if (redo.length === 1 && batch.length === 1) {
    results[redo[0]].reason = `${why} even at batch size 1`;
    return results;
  }
  // A split needs a call per half; with no budget left stop here, honestly.
  const half = Math.ceil(redo.length / 2);
  const parts = redo.length === 1 ? [redo] : [redo.slice(0, half), redo.slice(half)];
  for (const idxs of parts) {
    if (budget.remaining <= 0) {
      for (const i of idxs) results[i].reason = `${why}; retry budget exhausted`;
      continue;
    }
    budget.remaining--;
    budget.splits++;
    const sub = await summariseWithSplit(idxs.map(i => batch[i]), once, budget);
    idxs.forEach((i, k) => { results[i] = sub[k]; });
  }
  return results;
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
  const failures = [];
  // Run-wide retry budget: 2 x symbols (see `summariseWithSplit` BOUND).
  const budget = { remaining: 2 * symbols.length, calls: 0, splits: 0 };
  // First-attempt verdicts are still recorded, per batch, for observability:
  // they say how often the provider fell short BEFORE any re-ask.
  let incompleteBatches = 0;
  let truncatedBatches = 0;
  const observeFirst = async (b) => {
    const r = await summariseBatch(b);
    if (!r.health.complete) incompleteBatches++;
    if (r.health.truncated) truncatedBatches++;
    return r;
  };
  // Run with bounded concurrency
  const concurrency = symbolIndexConfig.llmConcurrency;
  for (let i = 0; i < batches.length; i += concurrency) {
    const slice = batches.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(b => {
      // Only the FIRST call on the whole batch is a first attempt; sub-batches
      // call summariseBatch directly and are not counted as incomplete batches.
      let first = true;
      return summariseWithSplit(b, bb => { if (first) { first = false; return observeFirst(bb); } return summariseBatch(bb); }, budget);
    }));
    for (let bi = 0; bi < slice.length; bi++) {
      const batch = slice[bi];
      for (let si = 0; si < batch.length; si++) {
        const sym = batch[si];
        const { summary, reason } = results[bi][si];
        emit({ ...sym, purposeSummary: summary });
        if (summary) summarised++;
        else failures.push({ filePath: sym.filePath, symbolName: sym.symbolName, reason });
      }
    }
  }
  // Carried in the envelope, not just the stderr log: a caller or CI step
  // reading only stdout could otherwise not tell a run that summarised every
  // symbol from one that lost a third of them.
  //
  // `complete` is derived from the per-symbol outcomes — ONE producer. A symbol
  // is either summarised or listed in `failures` with its reason; a populated
  // slot cut mid-sentence is never counted as summarised (see summariseWithSplit).
  const missing = symbols.length - summarised;
  emit({
    type: 'summary',
    counts: {
      summarised, batches: batches.length, missing,
      incompleteBatches, truncatedBatches,
      calls: budget.calls, splitCalls: budget.splits,
    },
    complete: missing === 0,
    // EVERY failure with its reason, never capped: no unsummarised symbol is
    // left without one (a full refresh once had 410).
    failures,
  });
  for (const f of failures.slice(0, 20)) {
    logProgress(`UNSUMMARISED ${f.filePath}#${f.symbolName}: ${f.reason}`);
  }
  logProgress(
    `done — summarised=${summarised}/${symbols.length}`
    + ` — ${budget.calls} calls (${batches.length} first-attempt + ${budget.splits} split re-asks)`
    + (incompleteBatches
      ? ` — ${incompleteBatches}/${batches.length} first-attempt batch(es) INCOMPLETE`
        + `${truncatedBatches ? ` (${truncatedBatches} hit the token ceiling)` : ''}`
      : '')
    + (missing ? `; ${missing} symbol(s) still with no summary (listed above, reasons in the envelope)` : ''),
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
  // `await finishAndExit(1)`, never a bare `process.exit(1)`. This script emits
  // one JSON line per symbol to stdout, and on Windows a piped stdout is
  // ASYNCHRONOUS — `npm run`, `| tee` and every CI capture are pipes. A throw
  // part-way through a long run therefore discarded whatever had not flushed,
  // and the consumer read a truncated final line as a parse error, blamed on
  // the wrong thing (AGENTS.md, "an exit that stdout can reach must drain
  // first"). `npm run stdout:flush:gate` did not catch it: its census walks
  // `scripts/*.mjs` and never descends into `scripts/symbol-index/`, so it
  // reported "at baseline" over a corpus that had not looked here.
  main().catch(async err => {
    process.stderr.write(`summarise: fatal: ${err.stack || err.message}\n`);
    await finishAndExit(1);
  });
}
