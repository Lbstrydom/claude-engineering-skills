#!/usr/bin/env node
/**
 * @fileoverview Phase B.3 — symbol embedder.
 *
 * Reads enriched records from stdin, batches them, calls the **resolved
 * concrete** embedding model (per Gemini G2 — sentinels resolved once at
 * refresh-start, persisted as concrete IDs). Emits records with embedding
 * + embeddingModel + embeddingDim fields populated.
 *
 * @module scripts/symbol-index/embed
 */

import readline from 'node:readline';
import { symbolIndexConfig } from '../lib/config.mjs';
import { chunkBatches } from '../lib/symbol-index.mjs';
import { emit } from '../lib/cli-io.mjs';
import { getGeminiClient } from '../lib/llm-wrappers.mjs';

function logProgress(s) { process.stderr.write(`  [embed] ${s}\n`); }

/**
 * @param {string[]} texts
 * @param {string} modelId - concrete provider id
 * @returns {Promise<{vectors: number[][], dim: number}>}
 */
async function embedBatch(texts, modelId) {
  const client = await getGeminiClient();
  if (!client) {
    logProgress(`GEMINI_API_KEY missing — emitting null embeddings`);
    return { vectors: texts.map(() => null), dim: symbolIndexConfig.embedDim };
  }
  let dim = symbolIndexConfig.embedDim;
  // R1 audit Gemini-G2: parallelise per-text embed calls within a batch.
  // Sequential await loop nullified batching's whole point. Promise.all is
  // safe at batch size ≤25 for gemini-embedding-* providers.
  // Pass outputDimensionality so providers that default to wider vectors
  // (e.g. gemini-embedding-001 defaults to 3072) return our schema-compatible
  // dim (VECTOR(768) in the migration).
  const targetDim = symbolIndexConfig.embedDim;
  // Retry+backoff on rate-limit / transient network errors. Found live
  // during ai-organiser concurrent refresh: embedded=1788/8407 because
  // many calls hit Gemini quota-burst limits when multiple repos refresh
  // simultaneously.
  async function embedOne(t, attempt = 1) {
    try {
      const r = await client.models.embedContent({
        model: modelId,
        contents: t,
        config: { outputDimensionality: targetDim },
      });
      return r?.embeddings?.[0]?.values || null;
    } catch (err) {
      const msg = String(err.message || err);
      const transient = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')
        || msg.includes('fetch failed') || msg.includes('ETIMEDOUT')
        || msg.includes('500') || msg.includes('502') || msg.includes('503');
      if (transient && attempt < 4) {
        const delayMs = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
        await new Promise(r => setTimeout(r, delayMs));
        return embedOne(t, attempt + 1);
      }
      logProgress(`embed failed (attempt ${attempt}): ${msg.slice(0, 100)}`);
      return null;
    }
  }
  const settled = await Promise.all(texts.map(t => embedOne(t)));
  for (const v of settled) {
    if (v && v.length > 0) dim = v.length;
  }
  return { vectors: settled, dim };
}

function compose(s) {
  // Build a stable text representation for embedding: identity + summary + signature
  const summary = s.purposeSummary || '';
  return `${s.kind} ${s.symbolName} in ${s.filePath}\n` +
         `${summary}\n` +
         `${s.signature || ''}`;
}

async function main() {
  // Concrete model ID: caller passes via env so refresh.mjs can resolve sentinels once
  // and persist + propagate the concrete ID. Default falls back to symbolIndexConfig.embedModel.
  const concreteModel = process.env.ARCH_INDEX_EMBED_CONCRETE || symbolIndexConfig.embedModel;

  const rl = readline.createInterface({ input: process.stdin });
  const records = [];
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try { records.push(JSON.parse(t)); } catch { /* skip */ }
  }

  const symbols = records.filter(r => r.type === 'symbol' && !r.redacted);
  const passthrough = records.filter(r => r.type !== 'symbol' || r.redacted);
  for (const r of passthrough) emit(r);

  if (symbols.length === 0) {
    emit({ type: 'summary', counts: { embedded: 0, model: concreteModel, dim: symbolIndexConfig.embedDim } });
    return;
  }

  const batches = chunkBatches(symbols, Math.min(symbolIndexConfig.batchSize, 25));
  logProgress(`${symbols.length} symbols → ${batches.length} embed batches (model=${concreteModel})`);
  let embedded = 0;
  let dim = symbolIndexConfig.embedDim;
  for (const batch of batches) {
    const { vectors, dim: batchDim } = await embedBatch(batch.map(compose), concreteModel);
    if (batchDim) dim = batchDim;
    for (let i = 0; i < batch.length; i++) {
      const v = vectors[i];
      emit({
        ...batch[i],
        embedding: v,
        embeddingModel: concreteModel,
        embeddingDim: v ? v.length : null,
      });
      if (v) embedded++;
    }
  }
  emit({ type: 'summary', counts: { embedded, model: concreteModel, dim } });
  logProgress(`done — embedded=${embedded}/${symbols.length} model=${concreteModel} dim=${dim}`);
}

main().catch(err => {
  process.stderr.write(`embed: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
