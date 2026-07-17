/**
 * @fileoverview Cluster A / Phase 2 — a refresh must promote incremental → full
 * when the vector-space identity changes (D3/H4). Otherwise an incremental run
 * re-embeds only touched files while publishing the new provenance, silently
 * mixing two vector spaces the read-side guard can't detect.
 *
 * Tests the pure decision seam `provenanceRequiresFullReembed`. Importing
 * refresh.mjs must NOT run the pipeline — guarded by its CLI main-guard.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { provenanceRequiresFullReembed } from '../scripts/symbol-index/refresh.mjs';

describe('provenanceRequiresFullReembed (D3/H4)', () => {
  const AZ_LARGE = 'https://gd-ai-dev-aif.openai.azure.com::text-embedding-3-large';
  const AZ_SMALL = 'https://gd-ai-dev-aif.openai.azure.com::text-embedding-3-small';
  const AZ_OTHER_RESOURCE = 'https://other.openai.azure.com::text-embedding-3-large';

  test('provenance changed (different deployment) → promote to full', () => {
    assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: AZ_SMALL }, AZ_LARGE), true);
  });

  test('SAME alias, DIFFERENT endpoint → promote to full (the H8 mix we must catch)', () => {
    assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: AZ_OTHER_RESOURCE }, AZ_LARGE), true);
  });

  test('legacy bare-name index vs qualified → promote to full (the one rebuild that clears D2)', () => {
    assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: 'gemini-embedding-001' }, AZ_LARGE), true);
  });

  test('provenance unchanged → stays incremental (no false full-rebuild)', () => {
    assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: AZ_LARGE }, AZ_LARGE), false);
  });

  test('no prior snapshot → not a provenance change (first-ever refresh handled elsewhere)', () => {
    assert.equal(provenanceRequiresFullReembed(null, AZ_LARGE), false);
    assert.equal(provenanceRequiresFullReembed({}, AZ_LARGE), false);
    assert.equal(provenanceRequiresFullReembed({ activeEmbeddingModel: null }, AZ_LARGE), false);
  });

  test('public path unchanged (Gemini id equal) → incremental', () => {
    assert.equal(
      provenanceRequiresFullReembed({ activeEmbeddingModel: 'gemini-embedding-001' }, 'gemini-embedding-001'),
      false,
    );
  });
});
