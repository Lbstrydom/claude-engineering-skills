/**
 * @fileoverview Azure OpenAI embedding wrapper for security incidents.
 *
 * Plan: docs/plans/security-strategy-postgres-port.md §2 (decisions) + §4.5.
 *
 * Honours audit-loop's "all LLM calls via Azure AI Foundry" rule: uses the
 * Azure OpenAI `text-embedding-3-small` deployment with the `dimensions: 768`
 * reduction parameter so the stored vector matches the schema's VECTOR(768)
 * layout. Native dim is 1536; the API supports reduction.
 *
 * Client construction mirrors scripts/openai-audit.mjs::makeClient (Azure v1
 * surface: baseURL `${endpoint}/openai/v1`, api-key header, api-version query).
 *
 * @module scripts/lib/security/azure-embed
 */

import { retryWithBackoff } from '../robustness.mjs';

export const SECURITY_EMBED_DIM = 768;

/**
 * Parse a non-negative integer env var with a safe fallback. Guards against
 * `Number(env || default)` yielding NaN on malformed input (R1 finding
 * 2026-05-30, GPT-sustained LOW) — NaN would otherwise disable retry/backoff.
 */
function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

let _client = null;

/** Resolved embedding deployment name (env override → default). */
export function embedDeployment() {
  return process.env.AZURE_OPENAI_EMBED_DEPLOYMENT || 'text-embedding-3-small';
}

/** Build (once) the Azure OpenAI client used for embeddings. */
async function getClient() {
  if (_client) return _client;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || 'preview';
  if (!endpoint || !apiKey) {
    throw new Error('azure-embed: missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY');
  }
  const OpenAI = (await import('openai')).default;
  _client = new OpenAI({
    baseURL: `${endpoint.replace(/\/+$/, '')}/openai/v1`,
    apiKey,
    defaultHeaders: { 'api-key': apiKey },
    defaultQuery: { 'api-version': apiVersion },
  });
  return _client;
}

/**
 * Embed a single text into a 768-dim vector. Retries transient failures.
 *
 * @param {string} text
 * @returns {Promise<number[]>} length === SECURITY_EMBED_DIM
 * @throws when the API returns an empty/wrong-dimension vector.
 */
export async function azureEmbed(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('azureEmbed: text must be a non-empty string');
  }
  const client = await getClient();
  const model = embedDeployment();

  const { result } = await retryWithBackoff(
    async () => {
      const resp = await client.embeddings.create({
        model,
        input: text,
        dimensions: SECURITY_EMBED_DIM,
      });
      const vec = resp?.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error(`azureEmbed: empty embedding from ${model}`);
      }
      if (vec.length !== SECURITY_EMBED_DIM) {
        throw new Error(
          `azureEmbed: dim mismatch — got ${vec.length}, expected ${SECURITY_EMBED_DIM} (model=${model})`
        );
      }
      return vec;
    },
    {
      maxRetries: envInt('RETRY_MAX_ATTEMPTS', 3),
      baseDelayMs: 1000,
      provider: 'azure-openai',
      label: 'azure-embed',
    }
  );

  return result;
}

/** Reset the cached client (test seam). */
export function _resetClientForTest() {
  _client = null;
}

/**
 * Inject a fake client (test seam). The fake must expose
 * `embeddings.create({model, input, dimensions}) -> { data: [{ embedding }] }`.
 */
export function _setClientForTest(fake) {
  _client = fake;
}
