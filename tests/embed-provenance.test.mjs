/**
 * @fileoverview Cluster A / Phase 1 — the vector-space identity is ONE shared
 * resolver (the D2/H3/H8 fix). These are the regression tests for the bug that
 * made Azure architectural-memory unusable: vectors made by the Azure deployment
 * while a stale Gemini name was published as provenance, so every query threw
 * EMBEDDING_MISMATCH.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveEmbedProfile, azureProvenanceId, providerTag } from '../scripts/lib/embed-text.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

const AZURE = Object.freeze({
  active: true,
  openaiEndpoint: 'https://gd-ai-dev-aif.openai.azure.com',
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
    assert.equal(p.provenanceId, 'https://gd-ai-dev-aif.openai.azure.com::text-embedding-3-large');
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
      azureProvenanceId({ openaiEndpoint: 'https://GD-AI-DEV-AIF.openai.azure.com/openai/', embedDeployment: 'e' }),
      'https://gd-ai-dev-aif.openai.azure.com::e',
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
