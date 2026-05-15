/**
 * Tests for the domain-summary cache invariants in summarise-domains.mjs.
 * Plan v6 §2.5: composition_hash + symbol_count ±20% + prompt_template_version
 * + generated_model — any one mismatch forces regeneration.
 *
 * Pure-logic tests against the exported PROMPT_TEMPLATE_VERSION constant
 * + the cache-hit semantics. Live Haiku call is covered by integration
 * smoke (live arch:render run).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Import the cache-hit predicate + helpers directly from source (single
// source of truth — no Supabase coupling; these are pure functions).
import {
  PROMPT_TEMPLATE_VERSION, computeCompositionHash, symbolCountDeltaOk, cacheHit,
} from '../scripts/symbol-index/summarise-domains.mjs';

describe('PROMPT_TEMPLATE_VERSION', () => {
  it('is a positive integer', () => {
    assert.equal(typeof PROMPT_TEMPLATE_VERSION, 'number');
    assert.ok(Number.isInteger(PROMPT_TEMPLATE_VERSION));
    assert.ok(PROMPT_TEMPLATE_VERSION >= 1);
  });
});

describe('cache invariants — all 4 axes (Plan v6 §2.5)', () => {
  const baseline = {
    compositionHash: 'abc123',
    symbolCount: 100,
    promptTemplateVersion: 1,
    generatedModel: 'claude-haiku-4-5',
  };
  const baselineCurrent = { ...baseline };

  it('cache HIT when all invariants match', () => {
    assert.equal(cacheHit(baseline, baselineCurrent), true);
  });

  it('cache MISS when composition_hash differs (Gemini-R2-G2 — content-aware)', () => {
    assert.equal(cacheHit(baseline, { ...baselineCurrent, compositionHash: 'different' }), false);
  });

  it('cache MISS when symbol_count delta > 20%', () => {
    assert.equal(cacheHit(baseline, { ...baselineCurrent, symbolCount: 130 }), false, '+30%');
    assert.equal(cacheHit(baseline, { ...baselineCurrent, symbolCount: 70 }),  false, '-30%');
  });

  it('cache HIT when symbol_count delta within 20%', () => {
    assert.equal(cacheHit(baseline, { ...baselineCurrent, symbolCount: 110 }), true, '+10%');
    assert.equal(cacheHit(baseline, { ...baselineCurrent, symbolCount: 85  }), true, '-15%');
    assert.equal(cacheHit(baseline, { ...baselineCurrent, symbolCount: 120 }), true, '+20% boundary');
  });

  it('cache MISS when prompt_template_version differs (R2-M2)', () => {
    assert.equal(cacheHit(baseline, { ...baselineCurrent, promptTemplateVersion: 2 }), false);
  });

  it('cache MISS when generated_model differs (R2-M2 — protects against latest-haiku rolling)', () => {
    assert.equal(cacheHit(baseline, { ...baselineCurrent, generatedModel: 'claude-haiku-5-0' }), false);
  });

  it('cache MISS when prior is null', () => {
    assert.equal(cacheHit(null, baselineCurrent), false);
  });

  it('cache MISS when prior symbol count was 0 (defensive)', () => {
    assert.equal(cacheHit({ ...baseline, symbolCount: 0 }, baselineCurrent), false);
  });
});

describe('compositionHash — content-derived (Gemini-R2-G2)', () => {
  it('identical symbols → identical hash', () => {
    const syms = [
      { definitionId: 'd1', signatureHash: 's1' },
      { definitionId: 'd2', signatureHash: 's2' },
    ];
    assert.equal(computeCompositionHash(syms), computeCompositionHash(syms));
  });

  it('order-independent — sorted internally', () => {
    const a = [
      { definitionId: 'd1', signatureHash: 's1' },
      { definitionId: 'd2', signatureHash: 's2' },
    ];
    const b = [a[1], a[0]];
    assert.equal(computeCompositionHash(a), computeCompositionHash(b));
  });

  it('sig change in one symbol → different hash (Gemini-R2-G2 invariant)', () => {
    const a = [{ definitionId: 'd1', signatureHash: 's1' }];
    const b = [{ definitionId: 'd1', signatureHash: 's1-changed' }];
    assert.notEqual(computeCompositionHash(a), computeCompositionHash(b));
  });

  it('paths-only refactor IS detected (which the previous path-only hash would have missed)', () => {
    // Simulates a file where signature_hash changes (body refactor)
    // but file_paths stay identical
    const before = [
      { definitionId: 'd1', signatureHash: 'body-v1' },
      { definitionId: 'd2', signatureHash: 'body-v1' },
    ];
    const after = [
      { definitionId: 'd1', signatureHash: 'body-v2' },  // body changed
      { definitionId: 'd2', signatureHash: 'body-v1' },
    ];
    assert.notEqual(computeCompositionHash(before), computeCompositionHash(after));
  });
});
