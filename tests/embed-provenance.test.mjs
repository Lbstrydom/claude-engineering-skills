/**
 * @fileoverview Cluster A / Phase 1 — the vector-space identity is ONE shared
 * resolver (the D2/H3/H8 fix). These are the regression tests for the bug that
 * made Azure architectural-memory unusable: vectors made by the Azure deployment
 * while a stale Gemini name was published as provenance, so every query threw
 * EMBEDDING_MISMATCH.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveEmbedProfile, azureProvenanceId, providerTag } from '../scripts/lib/embed-text.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

const AZURE = Object.freeze({
  active: true,
  openaiEndpoint: 'https://contoso-ai-dev.openai.azure.com',
  embedDeployment: 'text-embedding-3-large',
});
const AZURE_OTHER_ENDPOINT = Object.freeze({
  active: true,
  openaiEndpoint: 'https://other-resource.openai.azure.com',
  embedDeployment: 'text-embedding-3-large', // SAME alias, different resource
});
const INACTIVE = Object.freeze({ active: false, openaiEndpoint: null, embedDeployment: 'text-embedding-3-small' });

describe('resolveEmbedProfile — one shared identity', () => {
  test('Azure: requestModel is the bare deployment, provenanceId is endpoint-qualified', () => {
    const p = resolveEmbedProfile({ azure: AZURE });
    assert.equal(p.kind, 'azure-openai');
    assert.equal(p.requestModel, 'text-embedding-3-large', 'the API needs the bare deployment name');
    assert.equal(p.provenanceId, 'https://contoso-ai-dev.openai.azure.com::text-embedding-3-large');
  });

  test('public: requestModel and provenanceId are BOTH the caller-supplied concrete model', () => {
    const p = resolveEmbedProfile({ azure: INACTIVE, concreteModel: 'gemini-embedding-001' });
    assert.equal(p.kind, 'gemini');
    assert.equal(p.requestModel, 'gemini-embedding-001');
    assert.equal(p.provenanceId, 'gemini-embedding-001');
  });

  test('H3: off-Azure WITHOUT a concrete model throws — never silently re-defaults', () => {
    assert.throws(() => resolveEmbedProfile({ azure: INACTIVE }), /concreteModel is required/);
  });

  test('H3 regression: a NON-default public model is published as-is, not the library default', () => {
    // The exact bug shape H3 caught: refresh must publish the model that made the
    // vectors, not `symbolIndexConfig.embedModel`'s default.
    const p = resolveEmbedProfile({ azure: INACTIVE, concreteModel: 'text-embedding-005-custom' });
    assert.equal(p.provenanceId, 'text-embedding-005-custom');
  });
});

describe('azureProvenanceId — endpoint qualifies the identity (H8)', () => {
  test('normalizes the origin (lower-case, path/query stripped)', () => {
    assert.equal(
      azureProvenanceId({ openaiEndpoint: 'https://CONTOSO-AI-DEV.openai.azure.com/openai/', embedDeployment: 'e' }),
      'https://contoso-ai-dev.openai.azure.com::e',
    );
  });

  test('SAME deployment alias on a DIFFERENT endpoint yields a DIFFERENT identity', () => {
    // This is the whole point of H8: a bare name would compare equal and let an
    // incremental refresh silently mix two resources' vector spaces.
    assert.notEqual(
      resolveEmbedProfile({ azure: AZURE }).provenanceId,
      resolveEmbedProfile({ azure: AZURE_OTHER_ENDPOINT }).provenanceId,
    );
  });
});

describe('D2 regression: the production call sites actually use the shared resolver', () => {
  // A behavioural equality test here would be tautological (calling one function
  // twice). The D2 bug was a WIRING divergence — refresh published a value the
  // vectors weren't made with. So guard the wiring at the source, the same way
  // anthropic-client-migration.test.mjs guards its factory: if a call site stops
  // using resolveEmbedProfile / publishes the stale name again, THIS breaks.
  const refresh = src('scripts/symbol-index/refresh.mjs');
  const embed = src('scripts/symbol-index/embed.mjs');

  test('refresh.mjs imports and uses resolveEmbedProfile', () => {
    assert.match(refresh, /import\s*\{[^}]*resolveEmbedProfile[^}]*\}\s*from\s*['"][^'"]*embed-text/);
    assert.match(refresh, /resolveEmbedProfile\(/);
  });

  test('refresh.mjs publishes embedProfile.provenanceId — NOT the bare concreteEmbedModel (the D2 bug)', () => {
    // The publish call must carry provenanceId. A regression that reverts to
    // `activeEmbeddingModel: concreteEmbedModel` re-opens the unfixable loop.
    assert.match(refresh, /activeEmbeddingModel:\s*embedProfile\.provenanceId/);
    assert.doesNotMatch(refresh, /activeEmbeddingModel:\s*concreteEmbedModel\b/);
  });

  test('embed.mjs stores embedProfile.provenanceId as embeddingModel and requests with requestModel', () => {
    assert.match(embed, /import\s*\{[^}]*resolveEmbedProfile[^}]*\}\s*from\s*['"][^'"]*embed-text/);
    assert.match(embed, /embeddingModel:\s*provenanceId/);
    assert.match(embed, /embedBatch\([^,]+,\s*requestModel\)/);
  });

  test('refresh-incidents.mjs persists provenanceId and REQUESTS with requestModel', () => {
    // The third writer, and the one this hand-written list did not mention until
    // 2026-08-30 — found by the final reviewer, not by this suite. It resolved
    // `modelToUse = azureConfig.embedDeployment` itself, so under Azure the
    // security index stored a BARE deployment name while the arch index stored
    // the endpoint-qualified id: two provenance formats in one store, and a
    // deployment-name collision across two Azure resources reading as one
    // vector space.
    const inc = src('scripts/security-memory/refresh-incidents.mjs');
    assert.match(inc, /import\s*\{[^}]*resolveEmbedProfile[^}]*\}\s*from\s*['"][^'"]*embed-text/);
    assert.match(inc, /modelToUse\s*=\s*embedProfile\.provenanceId/);
    assert.match(inc, /generateEmbedding\([^,]+,\s*requestModel\b/,
      'the WIRE call must send requestModel — sending the endpoint-qualified id 404s');
    assert.doesNotMatch(inc, /modelToUse\s*=\s*azureConfig\.embedDeployment\b/,
      'reverted to resolving the deployment locally — the split-brain bug');
  });

  test('CENSUS: every embedText writer is enumerated above — a fourth cannot hide', () => {
    // The defect was not that a call site was wrong; it was that this list was
    // written by hand and did not know the call site existed. Iterate the side
    // that can see a file nobody mentioned: the filesystem. AGENTS.md — "of any
    // set comparison ask which side am I iterating, and what is unrepresentable
    // from it".
    const NAMED = new Set([
      'scripts/symbol-index/refresh.mjs',
      'scripts/symbol-index/embed.mjs',
      'scripts/security-memory/refresh-incidents.mjs',
    ]);
    // Every exemption carries its reason; an unreasoned one is how a list stops
    // being a census.
    const EXEMPT = new Map([
      ['scripts/lib/embed-text.mjs', 'the helper itself'],
      // QUERY side: embeds a search vector and persists no `embedding_model`, so
      // it publishes no provenance to diverge. It must still COMPARE against the
      // stored identity, which neighbourhood-query already does via its own guard.
      ['scripts/lib/audit/duplication-detector.mjs', 'query-side; persists no provenance'],
      ['scripts/lib/neighbourhood-query.mjs', 'query-side; persists no provenance'],
      // KNOWN GAP, deliberately not fixed here (found by this census on
      // 2026-08-30, while fixing the security index). These three DO persist
      // `finding_embeddings.embedding_model`, and all three record
      // `symbolIndexConfig.embedModel` — the configured GEMINI default — even
      // when `embedText` routed the call to Azure. That is the same D2 defect
      // `resolveEmbedProfile` exists to kill, in a third table.
      //
      // Not folded into this commit because it is not a like-for-like edit: the
      // fix CHANGES THE STORED STRING, so existing rows and new rows would
      // disagree, and `semantic-suppress` matches within a vector space. It
      // needs a backfill/compat decision, not a one-line swap. Tracked as its
      // own item; when it lands, move these three up to NAMED with real
      // assertions rather than deleting the entry.
      ['scripts/lib/store/runs-findings.mjs', 'KNOWN GAP: finding_embeddings provenance — needs backfill design'],
      ['scripts/semantic-suppress.mjs', 'KNOWN GAP: finding_embeddings provenance — needs backfill design'],
      ['scripts/memory-pgvector-prototype.mjs', 'KNOWN GAP: finding_embeddings provenance — needs backfill design'],
    ]);
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(abs);
      return e.isFile() && e.name.endsWith('.mjs') ? [abs] : [];
    });
    const callers = walk(path.join(repoRoot, 'scripts'))
      .filter((abs) => /\bembedText\s*\(/.test(readFileSync(abs, 'utf8')))
      .map((abs) => path.relative(repoRoot, abs).split(path.sep).join('/'))
      .filter((rel) => !EXEMPT.has(rel));
    const unknown = callers.filter((rel) => !NAMED.has(rel));
    assert.deepEqual(unknown, [],
      `these call embedText() but no provenance assertion above names them: ${unknown.join(', ')}. `
      + 'Add a per-caller test (and check it publishes provenanceId), or exempt it with a reason.');
  });

  test('MIRROR: no NAMED or EXEMPT entry has gone stale', () => {
    // The other direction. A file that is renamed away leaves its entry behind,
    // and the census then passes while silently covering nothing — the same
    // one-directional blindness that let refresh-incidents.mjs drift.
    for (const rel of [
      'scripts/symbol-index/refresh.mjs', 'scripts/symbol-index/embed.mjs',
      'scripts/security-memory/refresh-incidents.mjs', 'scripts/lib/embed-text.mjs',
      'scripts/lib/audit/duplication-detector.mjs', 'scripts/lib/neighbourhood-query.mjs',
      'scripts/lib/store/runs-findings.mjs', 'scripts/semantic-suppress.mjs',
      'scripts/memory-pgvector-prototype.mjs',
    ]) {
      assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} is listed but no longer exists — renamed?`);
    }
  });

  test('the resolved Azure provenance is never the stale Gemini default', () => {
    assert.notEqual(resolveEmbedProfile({ azure: AZURE }).provenanceId, 'gemini-embedding-001');
  });
});

describe('providerTag stays a bare display string (H9 — never persisted/compared)', () => {
  test('Azure display tag is unchanged (backward-compatible with existing callers)', () => {
    assert.equal(providerTag({ azure: AZURE }), 'azure-openai:text-embedding-3-large');
  });
  test('public display tag is unchanged', () => {
    assert.equal(providerTag({ azure: INACTIVE, model: 'gemini-embedding-001' }), 'gemini:gemini-embedding-001');
  });
});
