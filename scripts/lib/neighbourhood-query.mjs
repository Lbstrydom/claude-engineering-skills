/**
 * @fileoverview Plan-time consultation orchestrator.
 *
 * Owns the description→embedding→RPC path for /plan-* and /audit-code consumers
 * (per R1 H3). Loads the repo's persisted (model, dim) at read time so query
 * embeddings live in the same vector space as stored embeddings (per R2 H9 +
 * Gemini G2 — concrete model id, never sentinel).
 *
 * Caches intent embedding on disk at `.audit-loop/cache/intent-embeddings.json`
 * so the cache survives across ephemeral CLI invocations (per Gemini-R2 G3).
 *
 * @module scripts/lib/neighbourhood-query
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './file-io.mjs';
import {
  NeighbourhoodQueryArgsSchema,
  NeighbourhoodResultSchema,
} from './symbol-index-contracts.mjs';
import { recommendationFromSimilarity } from './symbol-index.mjs';
import { symbolIndexConfig, azureConfig } from './config.mjs';
import { redactSecrets } from './secret-patterns.mjs';
import { embedText } from './embed-text.mjs';

const CACHE_REL = '.audit-loop/cache/intent-embeddings.json';
const CACHE_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000;

function cacheKey(intentDescription, model, dim) {
  return crypto
    .createHash('sha256')
    .update(`${intentDescription}|${model}|${dim}`)
    .digest('hex')
    .slice(0, 24);
}

function loadCache(repoRoot) {
  const file = path.join(repoRoot, CACHE_REL);
  if (!fs.existsSync(file)) return { entries: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { entries: {} };
  }
}

function saveCache(repoRoot, cache) {
  const file = path.join(repoRoot, CACHE_REL);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(cache, null, 2));
}

function getCached(repoRoot, key, ttlMs) {
  const cache = loadCache(repoRoot);
  const e = cache.entries[key];
  if (!e) return null;
  if (Date.now() - e.savedAt > ttlMs) return null;
  return e.embedding;
}

function putCached(repoRoot, key, embedding) {
  const cache = loadCache(repoRoot);
  cache.entries[key] = { embedding, savedAt: Date.now() };
  saveCache(repoRoot, cache);
}

/**
 * Generate an embedding for a single intent string, using the EXACT
 * `(activeModel, activeDim)` pair the repo's stored embeddings use.
 *
 * Implementation: thin wrapper around `@google/genai`. Returns
 * `{result: number[], usage: {totalTokens: number}, latencyMs: number}`
 * matching the `{result, usage, latencyMs}` contract used elsewhere.
 *
 * @param {string} intentDescription
 * @param {string} activeModel - concrete model id, NEVER a sentinel
 * @param {number} activeDim
 * @returns {Promise<{result: number[], usage: {totalTokens: number}, latencyMs: number}>}
 */
export async function generateIntentEmbedding(intentDescription, activeModel, activeDim) {
  // Provenance guard (Gemini-R2-H1 / consolidated-gate-H1): the query MUST
  // embed in the SAME vector space the index was built in. We detect the
  // GEMINI provider (its model ids always contain `gemini` or the `models/`
  // prefix) and treat everything else — including arbitrary custom Azure
  // deployment names like `corporate-embed` — as Azure. Inferring "is Azure"
  // from a name prefix would misclassify custom deployment names; inferring
  // "is Gemini" is robust because Gemini's naming is fixed. A cross-provider
  // query returns garbage similarity even at equal dim — refuse it.
  const storedIsGemini = /gemini|^models\//i.test(String(activeModel));
  const storedIsAzure = !storedIsGemini;
  if (storedIsAzure !== azureConfig.active) {
    const err = new Error(
      `Embedding provider mismatch: index built with "${activeModel}" but the active profile is ` +
      `${azureConfig.active ? 'Azure OpenAI' : 'Gemini'}. Re-run \`npm run arch:refresh\` under the ` +
      `current profile to rebuild the index in the matching vector space.`,
    );
    err.code = 'EMBEDDING_MISMATCH';
    throw err;
  }
  // Intra-Azure guard (consolidated-gate R2-H): under Azure, embedText embeds
  // with `azureConfig.embedDeployment` and ignores `activeModel`. Two different
  // Azure embedding deployments can share dim 768 yet occupy different vector
  // spaces, which the provider + dim guards both miss. Refuse when the index's
  // model doesn't match the deployment now in use.
  if (azureConfig.active && String(activeModel) !== azureConfig.embedDeployment) {
    const err = new Error(
      `Embedding deployment mismatch: index built with "${activeModel}" but the active Azure embed ` +
      `deployment is "${azureConfig.embedDeployment}". Re-run \`npm run arch:refresh\` to rebuild the ` +
      `index with the current deployment.`,
    );
    err.code = 'EMBEDDING_MISMATCH';
    throw err;
  }
  // embedText routes to the active provider, redacts at the boundary
  // (defense-in-depth; idempotent with any caller pre-redaction), validates the
  // dim, and returns the {result, usage, latencyMs} contract this caller expects.
  try {
    return await embedText(intentDescription, { dim: activeDim, model: activeModel });
  } catch (err) {
    if (!err.code) err.code = 'EMBED_FAILED';
    throw err;
  }
}

/**
 * Top-level orchestrator for plan-time neighbourhood consultation.
 *
 * Inputs validated against `NeighbourhoodQueryArgsSchema`. Returns a result
 * matching `NeighbourhoodResultSchema`. Errors are typed for the failure-matrix
 * mapping in cross-skill.mjs.
 *
 * @param {{getActiveSnapshot: Function, getRepoIdByUuid: Function, callNeighbourhoodRpc: Function}} adapters - injected for testability
 * @param {object} args - matches NeighbourhoodQueryArgsSchema
 * @param {string} repoRoot - for disk cache location
 */
export async function getNeighbourhoodForIntent(adapters, args, repoRoot = process.cwd()) {
  const parsed = NeighbourhoodQueryArgsSchema.safeParse(args);
  if (!parsed.success) {
    const err = new Error('Invalid args');
    err.code = 'BAD_INPUT';
    err.issues = parsed.error.issues;
    throw err;
  }
  const v = parsed.data;

  // 1. Resolve repo + active snapshot
  const repoRow = await adapters.getRepoIdByUuid(v.repoUuid);
  if (!repoRow) {
    const out = {
      cloud: false,
      refreshId: null,
      records: [],
      totalCandidatesConsidered: 0,
      truncated: false,
      hint: `repo not found in cloud store; run \`npm run arch:refresh\` to populate`,
    };
    return NeighbourhoodResultSchema.parse(out);
  }

  const active = await adapters.getActiveSnapshot(repoRow.id);
  if (!active || !active.refreshId) {
    return NeighbourhoodResultSchema.parse({
      cloud: true,
      refreshId: null,
      records: [],
      totalCandidatesConsidered: 0,
      truncated: false,
      hint: `repo has no active snapshot; run \`npm run arch:refresh\` to populate`,
    });
  }
  if (!active.activeEmbeddingModel || !active.activeEmbeddingDim) {
    const err = new Error('repo has no active embedding model configured');
    err.code = 'EMBEDDING_MISMATCH';
    err.expected = { model: null, dim: null };
    err.available = [];
    throw err;
  }

  // 2. Cache lookup or generate
  const ttlMs = symbolIndexConfig?.intentEmbedCacheTtlMs ?? CACHE_TTL_MS_DEFAULT;
  // Redact BEFORE deriving the cache key (defence-in-depth): a secret-bearing
  // intent must not produce a stable on-disk hash of the raw secret, nor split
  // the cache across secret variants. The embedding egress already redacts
  // internally; this aligns the key + egress to the same safe text.
  const safeIntent = redactSecrets(v.intentDescription || '').text;
  const key = cacheKey(safeIntent, active.activeEmbeddingModel, active.activeEmbeddingDim);
  let intentEmbedding = getCached(repoRoot, key, ttlMs);
  if (!intentEmbedding) {
    const emb = await generateIntentEmbedding(
      safeIntent,
      active.activeEmbeddingModel,
      active.activeEmbeddingDim
    );
    intentEmbedding = emb.result;
    putCached(repoRoot, key, intentEmbedding);
  }

  // 3. Call RPC
  const rpcRows = await adapters.callNeighbourhoodRpc({
    repoId:           repoRow.id,
    refreshId:        active.refreshId,
    targetPaths:      v.targetPaths,
    intentEmbedding,
    kindFilter:       v.kind || null,
    k:                v.k,
  });

  const records = (rpcRows || []).map(r => ({
    id:              r.symbol_index_id || r.id,
    definitionId:    r.definition_id || r.definitionId,
    refreshId:       active.refreshId,
    repoId:          repoRow.id,
    filePath:        r.file_path || r.filePath,
    startLine:       r.start_line ?? r.startLine ?? null,
    endLine:         r.end_line ?? r.endLine ?? null,
    symbolName:      r.symbol_name || r.symbolName,
    kind:            r.kind,
    signatureHash:   r.signature_hash || r.signatureHash || '',
    purposeSummary:  r.purpose_summary ?? r.purposeSummary ?? null,
    domainTag:       r.domain_tag ?? r.domainTag ?? null,
    score:           Number(r.combined_score ?? r.score ?? 0),
    hopScore:        Number(r.hop_score ?? r.hopScore ?? 0),
    similarityScore: Number(r.similarity ?? r.similarityScore ?? 0),
    recommendation:  recommendationFromSimilarity(Number(r.similarity ?? 0)),
  }));

  // Phase 3 — adaptive-learning arch_memory_band telemetry.  One decision
  // per record so the reconciler can later resolve outcome (reuse-correct,
  // wrong-fork, etc.) by inspecting subsequent commits.  Off-audit
  // decisions: decision_key = `arch_memory_band:<symbol_index_id>`.
  // Best-effort, fire-and-forget; never throws into the query path.
  if (records.length > 0) {
    try {
      const [{ recordDecision }, { redactSecrets }] = await Promise.all([
        import('./learning/decision-logger.mjs'),
        import('./secret-patterns.mjs'),
      ]);
      // Audit-fix Phase 3 R2 M7: intent strings can carry secrets the
      // user pasted (URLs with tokens, error logs, etc.).  Redact + cap
      // before persisting to learning_decisions.
      const rawIntent = v.intentDescription || null;
      const intentSafe = rawIntent
        ? redactSecrets(String(rawIntent)).text.slice(0, 240)
        : null;
      for (const rec of records) {
        if (!rec.id) continue;
        try {
          recordDecision({
            decisionType: 'arch_memory_band',
            repoId: repoRow.id,
            externalId: String(rec.id),
            context: {
              similarity: rec.similarityScore,
              symbol:     rec.symbolName,
              kind:       rec.kind,
              filePath:   rec.filePath,
              intent:     intentSafe,
            },
            choice: { band: rec.recommendation },
            outcome: null,
          });
        } catch (err) {
          process.stderr.write(`[learning:tel:arch_memory_band] record failure for ${rec.id}: ${err.message || ''}\n`);
        }
      }
      // Flush HERE (Cluster B / Phase 4): this fn runs from the cross-skill CLI
      // (get-neighbourhood), a short-lived process that never installs the
      // beforeExit lifecycle hook — so without an explicit flush the enqueued
      // arch_memory_band decisions are lost on exit (why the cloud table was
      // empty). flush is idempotent (decision_key UNIQUE) so a double-flush
      // from the /plan path is harmless.
      try {
        const [{ flush }, store] = await Promise.all([
          import('./learning/decision-logger.mjs'),
          import('../learning-store.mjs'),
        ]);
        await flush({ store });
      } catch (err) {
        process.stderr.write(`[learning:tel:arch_memory_band] flush failure: ${err.message || ''}\n`);
      }
    } catch (err) {
      process.stderr.write(`[learning:tel:arch_memory_band] import failure: ${err.message || ''}\n`);
    }
  }

  return NeighbourhoodResultSchema.parse({
    cloud: true,
    refreshId: active.refreshId,
    records,
    totalCandidatesConsidered: records.length,
    truncated: false,
    hint: null,
  });
}

// ── Incident neighbourhood (Plan: docs/plans/security-memory-v1.md) ─────────

/**
 * Sister fn for security incidents. Mirrors getNeighbourhoodForIntent's
 * embedding + cache shell but calls a different RPC and applies a
 * client-side weighted composite score (R1-M3 — weights env-tunable).
 *
 * Returns the project-standard {result, usage, latencyMs} contract; the
 * cross-skill bridge unwraps `.result` before emitting on stdout
 * (R-Gemini-G4 — preserves flat JSON shape for /plan callers).
 *
 * @param {{getRepoIdByUuid: Function, getActiveSnapshot: Function,
 *          callIncidentNeighbourhoodRpc: Function,
 *          getMaxIncidentRefreshAt: Function}} adapters
 * @param {{repoUuid: string, targetPaths: string[],
 *          intentDescription: string, k?: number}} args
 * @param {string} repoRoot
 */

const SEC_W = {
  cosine:     Number(process.env.SEC_SCORE_W_COSINE     ?? 0.65),
  pathBonus:  Number(process.env.SEC_SCORE_W_PATH       ?? 0.20),
  mitigation: Number(process.env.SEC_SCORE_W_MITIGATION ?? 0.10),
  recency:    Number(process.env.SEC_SCORE_W_RECENCY    ?? 0.05),
};

export async function getIncidentNeighbourhoodForIntent(adapters, args, repoRoot = process.cwd()) {
  const startMs = Date.now();
  const usage = { embeddingCalls: 0, haikuCalls: 0 };

  if (!args || typeof args !== 'object') {
    throw Object.assign(new Error('Invalid args'), { code: 'BAD_INPUT' });
  }
  const { repoUuid, targetPaths, intentDescription } = args;
  const k = args.k ?? 3;

  if (!repoUuid || !Array.isArray(targetPaths) || typeof intentDescription !== 'string') {
    throw Object.assign(new Error('repoUuid, targetPaths, intentDescription required'), { code: 'BAD_INPUT' });
  }

  // 1. Resolve repo + active snapshot (for embedding model contract)
  const repoRow = await adapters.getRepoIdByUuid(repoUuid);
  if (!repoRow) {
    return {
      result: { records: [], totalCandidatesConsidered: 0, freshnessWarning: null,
                hint: 'repo not found in cloud store; run `npm run security:refresh`' },
      usage, latencyMs: Date.now() - startMs,
    };
  }
  const active = await adapters.getActiveSnapshot(repoRow.id);
  if (!active?.activeEmbeddingModel || !active.activeEmbeddingDim) {
    return {
      result: { records: [], totalCandidatesConsidered: 0, freshnessWarning: null,
                hint: 'repo has no active embedding model; run `npm run arch:refresh:full`' },
      usage, latencyMs: Date.now() - startMs,
    };
  }

  // 2. Freshness check (R2-H2 + R-Gemini-r2-G1: try/catch on statSync)
  let mdMtime = 0;
  try {
    const { statSync } = await import('node:fs');
    mdMtime = statSync('docs/security-strategy.md').mtimeMs;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let freshnessWarning = null;
  if (mdMtime > 0) {
    const lastRefresh = await adapters.getMaxIncidentRefreshAt(repoRow.id);
    if (lastRefresh != null) {
      const lastMs = new Date(lastRefresh).getTime();
      if (mdMtime > lastMs + 5_000) {
        freshnessWarning = '`docs/security-strategy.md` edited since last refresh — run `npm run security:refresh` to bring index current.';
      }
    }
  }

  // 3. Embed intent (with redaction — R3-H1)
  const ttlMs = symbolIndexConfig?.intentEmbedCacheTtlMs ?? CACHE_TTL_MS_DEFAULT;
  const redacted = redactSecrets(intentDescription).text;
  const key = cacheKey(redacted, active.activeEmbeddingModel, active.activeEmbeddingDim);
  let intentEmbedding = getCached(repoRoot, key, ttlMs);
  if (!intentEmbedding) {
    const emb = await generateIntentEmbedding(
      redacted,
      active.activeEmbeddingModel,
      active.activeEmbeddingDim,
    );
    intentEmbedding = emb.result;
    putCached(repoRoot, key, intentEmbedding);
    usage.embeddingCalls++;
  }

  // 4. Call RPC, apply client-side composite weighting (R1-M3)
  let candidates = await adapters.callIncidentNeighbourhoodRpc({
    repoId: repoRow.id,
    targetPaths,
    intentEmbedding,
    k,
  });

  // 5. Intent-rephrasing fallback (R-Gemini-G2): only when length > 0
  //    AND no path-overlap AND every cosine < 0.5
  const noOverlap = candidates.every(c => !c.pathOverlap);
  const allLowCosine = candidates.length > 0 && candidates.every(c => c.cosineScore < 0.5);
  if (candidates.length > 0 && noOverlap && allLowCosine) {
    // Single Haiku rephrase attempt (R3-M3 spec — Zod schema)
    // Best-effort: wrapped in try so a failure here doesn't kill /plan.
    // `cli` backend (CLAUDE_BACKEND=cli) draws from the Max 20x Agent SDK credit.
    try {
      const { z } = await import('zod');
      const FailureModesSchema = z.object({
        failureModes: z.array(z.string().min(20).max(200)).min(1).max(3),
      });
      if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_BACKEND === 'cli') {
        const { createAnthropicClient } = await import('./anthropic-client.mjs');
        const client = await createAnthropicClient();
        const { resolveModel } = await import('./model-resolver.mjs');
        const haikuModel = resolveModel('latest-haiku');
        const prompt = redactSecrets(
          `Given intent: "${intentDescription}", list 1-3 hypothetical security failure modes that might apply. Each: one sentence, concrete (mention attack vector + asset). Return ONLY JSON: {"failureModes": ["...", "..."]}`
        ).text;
        const resp = await client.messages.create({
          model: haikuModel,
          max_tokens: 400,
          messages: [{ role: 'user', content: prompt }],
        });
        usage.haikuCalls++;
        const text = resp?.content?.[0]?.text?.trim() || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = FailureModesSchema.safeParse(JSON.parse(jsonMatch[0]));
          if (parsed.success) {
            const augmented = redactSecrets(intentDescription + ' ' + parsed.data.failureModes.join(' ')).text;
            const augKey = cacheKey(augmented, active.activeEmbeddingModel, active.activeEmbeddingDim);
            const augEmb = await generateIntentEmbedding(augmented, active.activeEmbeddingModel, active.activeEmbeddingDim);
            putCached(repoRoot, augKey, augEmb.result);
            usage.embeddingCalls++;
            candidates = await adapters.callIncidentNeighbourhoodRpc({
              repoId: repoRow.id, targetPaths, intentEmbedding: augEmb.result, k,
            });
          }
        }
      }
    } catch {
      // Swallow — fallback is best-effort
    }
  }

  // 6. Client-side weighted composite + final top-k
  const ranked = candidates
    .map(r => ({
      ...r,
      compositeScore:
          SEC_W.cosine     * r.cosineScore
        + SEC_W.pathBonus  * (r.pathOverlap ? 1 : 0)
        + SEC_W.mitigation * r.mitigationBonus
        + SEC_W.recency    * r.recencyDecay,
    }))
    .sort((a, b) =>
      a.pathOverlap === b.pathOverlap
        ? b.compositeScore - a.compositeScore
        : (b.pathOverlap ? 1 : -1)
    )
    .slice(0, k);

  return {
    result: {
      records: ranked,
      totalCandidatesConsidered: candidates.length,
      freshnessWarning,
      hint: null,
    },
    usage,
    latencyMs: Date.now() - startMs,
  };
}
