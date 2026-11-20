/**
 * Child process for tests/python-arch-index-e2e.test.mjs: runs the REAL
 * `getNeighbourhoodForIntent` orchestrator over symbol records the REAL
 * extractor produced (read as JSON lines on stdin), with only the provider
 * calls stubbed and the store RPC played by an in-memory cosine ranking.
 *
 * Run with the parent's scrubbed env (LEARNING_DISABLE=1, an empty
 * AUDIT_DB_URL — the air-gap signal) and `--import no-network-preload.mjs`, so
 * nothing here can reach a provider or a store.
 *
 * argv: <repoRoot> <intent>
 */
import crypto from 'node:crypto';
import { getNeighbourhoodForIntent } from '../../scripts/lib/neighbourhood-query.mjs';

const [repoRoot, intent] = process.argv.slice(2);
const DIM = 64;

/** Deterministic bag-of-words embedding: lower-cased word stems hashed into DIM buckets. */
function stubEmbed(text) {
  const v = new Array(DIM).fill(0);
  for (const w of String(text).toLowerCase().match(/[a-z]{3,}/g) || []) {
    const stem = w.replace(/(ing|es|s|ed)$/, '');
    const h = crypto.createHash('sha256').update(stem).digest();
    v[h[0] % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const uuid = (s) => {
  const h = crypto.createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const symbols = input.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'symbol' && !r.redacted);

const REPO_ID = uuid('repo');
const REFRESH_ID = uuid('refresh');
const adapters = {
  getRepoIdByUuid: async () => ({ id: REPO_ID }),
  getActiveSnapshot: async () => ({
    refreshId: REFRESH_ID, activeEmbeddingModel: 'gemini-stub-embedding', activeEmbeddingDim: DIM,
  }),
  normalizeIntent: async (text) => ({ text, mode: 'fallback', normalizerId: 'stub', reason: 'test' }),
  embedIntent: async (text) => ({ result: stubEmbed(text), usage: { totalTokens: 0 }, latencyMs: 0 }),
  // The store boundary: SQL over language-neutral columns in production.
  callNeighbourhoodRpc: async ({ intentEmbedding, k }) => symbols
    .map((s) => ({ s, sim: cosine(intentEmbedding, stubEmbed(`${s.symbolName} ${s.signature} ${s.bodyText}`)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)
    .map(({ s, sim }) => ({
      symbol_index_id: uuid(`${s.filePath}#${s.symbolName}`),
      definition_id: uuid(`def:${s.filePath}#${s.symbolName}`),
      file_path: s.filePath, start_line: s.startLine, end_line: s.endLine,
      symbol_name: s.symbolName, kind: s.kind, signature_hash: s.signatureHash,
      purpose_summary: null, domain_tag: null, similarity: sim, ranking_score: Math.max(0, sim), hop_score: 0,
    })),
};

const out = await getNeighbourhoodForIntent(adapters, {
  repoUuid: uuid('repo-uuid'), targetPaths: ['src/shop/orders/new_feature.py'], intentDescription: intent, k: 3,
}, repoRoot);
process.stdout.write(`${JSON.stringify(out)}\n`);
