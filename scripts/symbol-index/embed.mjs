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
import { symbolIndexConfig, azureConfig } from '../lib/config.mjs';
import { chunkBatches, compose } from '../lib/symbol-index.mjs';
import { emit } from '../lib/cli-io.mjs';
import { embedText, resolveEmbedProfile } from '../lib/embed-text.mjs';

function logProgress(s) { process.stderr.write(`  [embed] ${s}\n`); }

/**
 * @param {string[]} texts
 * @param {string} modelId - concrete provider id
 * @returns {Promise<{vectors: number[][], dim: number}>}
 */
async function embedBatch(texts, modelId) {
  // Provider routing lives in embed-text.mjs (Azure OpenAI when the work
  // profile is active, else Gemini). Short-circuit only when NEITHER is
  // available.
  if (!azureConfig.active && !process.env.GEMINI_API_KEY) {
    logProgress(`no embedding provider (set GEMINI_API_KEY or the Azure work profile) — emitting null embeddings`);
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
      const { result } = await embedText(t, { dim: targetDim, model: modelId });
      return result || null;
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

async function main() {
  // The ONE shared resolver (embed-text.mjs) — same object refresh.mjs publishes,
  // so the vectors and the stored provenance can never disagree (the D2/H3 fix).
  // `requestModel` is what we send to the provider (bare Azure deployment or the
  // concrete Gemini id); `provenanceId` is the endpoint-qualified identity we
  // PERSIST as `embeddingModel`, so the read-side guard matches what actually
  // built the vectors under any Azure resource, not just a bare deployment name.
  const embedProfile = resolveEmbedProfile({
    concreteModel: process.env.ARCH_INDEX_EMBED_CONCRETE || symbolIndexConfig.embedModel,
  });
  const requestModel = embedProfile.requestModel;
  const provenanceId = embedProfile.provenanceId;

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
    emit({ type: 'summary', counts: { embedded: 0, model: provenanceId, dim: symbolIndexConfig.embedDim } });
    return;
  }

  // NULL-SUMMARY GUARD (plan §2.1 C9).
  //
  // `compose()` is `<kind> <name>\n<summary>`. With a null/blank summary that
  // collapses to pure metadata — and a metadata-only vector is NOT inert: it
  // scored 0.5440 against a real intent, versus 0.4256 for a completely
  // unrelated sentence and 0.6043 for a genuine match. That is only 0.06 below
  // a correct answer, so such vectors compete for top-k slots while carrying no
  // semantic content at all.
  //
  // Summaries go null when the summariser batch fails or no Claude provider is
  // configured (`summarise.mjs` returns all-nulls in both cases). Embedding
  // those anyway silently seeds the index with noise. Withhold the embedding
  // instead: the symbol row is still indexed (the architecture map and drift
  // detection need it), it simply has no vector, and the RPC now reports that
  // honestly as `similarity: null` / `scored: false` → band `unscored`.
  //
  // PREVENTION, NOT REMEDIATION — measured 2026-07-20: the active snapshot
  // holds ZERO null-summary rows today. This guard is what keeps that true
  // through a future provider outage; it is not cleaning up existing damage.
  const withSummary = [];
  const withheld = [];
  for (const s of symbols) {
    const summary = typeof s.purposeSummary === 'string' ? s.purposeSummary.trim() : '';
    (summary ? withSummary : withheld).push(s);
  }
  if (withheld.length > 0) {
    logProgress(
      `null-summary guard: withholding embeddings for ${withheld.length}/${symbols.length} symbol(s) ` +
      `with no purpose summary — they will surface as \`unscored\`, not as weak matches`,
    );
    // Emit them WITHOUT an embedding so the symbol row is still recorded.
    for (const s of withheld) {
      emit({ ...s, embedding: null, embeddingModel: provenanceId, embeddingDim: null });
    }
  }

  if (withSummary.length === 0) {
    emit({ type: 'summary', counts: { embedded: 0, withheldNullSummary: withheld.length, model: provenanceId, dim: symbolIndexConfig.embedDim } });
    logProgress(`done — embedded=0/${symbols.length} (all withheld: no purpose summaries)`);
    return;
  }

  const batches = chunkBatches(withSummary, Math.min(symbolIndexConfig.batchSize, 25));
  logProgress(`${withSummary.length} symbols → ${batches.length} embed batches (model=${requestModel}, provenance=${provenanceId})`);
  let embedded = 0;
  let dim = symbolIndexConfig.embedDim;
  for (const batch of batches) {
    const { vectors, dim: batchDim } = await embedBatch(batch.map(compose), requestModel);
    if (batchDim) dim = batchDim;
    for (let i = 0; i < batch.length; i++) {
      const v = vectors[i];
      emit({
        ...batch[i],
        embedding: v,
        embeddingModel: provenanceId,
        embeddingDim: v ? v.length : null,
      });
      if (v) embedded++;
    }
  }
  emit({ type: 'summary', counts: { embedded, withheldNullSummary: withheld.length, model: provenanceId, dim } });
  logProgress(
    `done — embedded=${embedded}/${symbols.length} ` +
    `withheld-null-summary=${withheld.length} ` +
    `model=${requestModel} provenance=${provenanceId} dim=${dim}`,
  );
}

main().catch(err => {
  process.stderr.write(`embed: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
