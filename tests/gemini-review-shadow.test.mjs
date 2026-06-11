import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/gemini-review.mjs';

const { resolveShadow, diffFindingBuckets, dedupByHash, shadowModelMatchesFamily } = _internals;

// A resolver stub so tests don't depend on the live model catalog.
const stubResolve = (sentinel) => {
  const map = { 'latest-opus': 'claude-opus-4-8', 'latest-pro': 'gemini-pro-latest' };
  return map[sentinel] || sentinel;
};

describe('resolveShadow — opt-in invariant (shadow path not entered when unset)', () => {
  it('returns skipped-unset when FINAL_REVIEW_SHADOW is absent — the byte-identical guard', () => {
    const r = resolveShadow({ shadowConfig: { provider: null, model: null }, env: {}, azureActive: false });
    assert.equal(r.state, 'skipped-unset');
    assert.equal(r.provider, null);
    assert.equal(r.model, null);
  });
});

describe('resolveShadow — Azure guard (load-bearing: shadow is a no-op on Foundry)', () => {
  it('returns skipped-azure when an Azure profile is active even if the env is set', () => {
    const r = resolveShadow({
      shadowConfig: { provider: 'claude-opus', model: null },
      env: { ANTHROPIC_API_KEY: 'x' },
      azureActive: true,
      resolve: stubResolve,
    });
    assert.equal(r.state, 'skipped-azure');
  });
});

describe('resolveShadow — provider/key/model resolution', () => {
  it('skips with skipped-no-key when the provider key is missing', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'claude-opus', model: null }, env: {}, azureActive: false, resolve: stubResolve });
    assert.equal(r.state, 'skipped-no-key');
  });

  it('skips unknown providers without throwing (optional feature never breaks the audit)', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'frobnicator', model: null }, env: { X: '1' }, azureActive: false, resolve: stubResolve });
    assert.equal(r.state, 'skipped-unsupported-provider');
  });

  it('resolves a ready claude-opus shadow to its concrete model via the per-provider default', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'claude-opus', model: null }, env: { ANTHROPIC_API_KEY: 'x' }, azureActive: false, resolve: stubResolve });
    assert.equal(r.state, 'ready');
    assert.equal(r.provider, 'claude-opus');
    assert.equal(r.model, 'claude-opus-4-8');
    assert.equal(r.family, 'claude');
  });

  it('maps the "anthropic" alias to the claude-opus canonical provider', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'anthropic', model: null }, env: { ANTHROPIC_API_KEY: 'x' }, azureActive: false, resolve: stubResolve });
    assert.equal(r.state, 'ready');
    assert.equal(r.provider, 'claude-opus');
  });

  it('rejects a provider/model family mismatch (gemini provider + opus model) — R3 M1', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'gemini', model: 'claude-opus-4-8' }, env: { GEMINI_API_KEY: 'x' }, azureActive: false, resolve: (s) => s });
    assert.equal(r.state, 'skipped-unsupported-provider');
  });

  it('honours an explicit, family-compatible model override', () => {
    const r = resolveShadow({ shadowConfig: { provider: 'claude-opus', model: 'claude-opus-4-7' }, env: { ANTHROPIC_API_KEY: 'x' }, azureActive: false, resolve: (s) => s });
    assert.equal(r.state, 'ready');
    assert.equal(r.model, 'claude-opus-4-7');
  });
});

describe('shadowModelMatchesFamily', () => {
  it('matches claude family ids (opus/sonnet/haiku/mythos/fable)', () => {
    for (const id of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-mythos-5', 'claude-fable-5']) {
      assert.equal(shadowModelMatchesFamily(id, 'claude'), true, id);
    }
    assert.equal(shadowModelMatchesFamily('gemini-pro-latest', 'claude'), false);
  });
  it('matches gemini family ids', () => {
    assert.equal(shadowModelMatchesFamily('gemini-pro-latest', 'gemini'), true);
    assert.equal(shadowModelMatchesFamily('claude-opus-4-8', 'gemini'), false);
  });
});

describe('dedupByHash — no count inflation (R3 M2)', () => {
  it('keeps the first occurrence of each semantic hash and drops duplicates', () => {
    const out = dedupByHash([{ _hash: 'a' }, { _hash: 'b' }, { _hash: 'b' }, { _hash: 'a' }]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((f) => f._hash), ['a', 'b']);
  });
  it('tolerates null/empty input', () => {
    assert.deepEqual(dedupByHash(null), []);
    assert.deepEqual(dedupByHash([]), []);
  });

  it('never silently drops a finding without _hash — computes semanticId as fallback (R2 H1)', () => {
    // A finding lacking _hash must NOT vanish; it is keyed by its computed
    // semanticId so it still reaches the diff + persistence.
    const out = dedupByHash([{ severity: 'HIGH', category: 'x', section: 's', detail: 'd' }]);
    assert.equal(out.length, 1);
  });
});

describe('diffFindingBuckets — three-way partition by semantic hash', () => {
  it('classifies both / primary-only / shadow-only and dedups each side first', () => {
    const primary = { new_findings: [{ _hash: 'a' }, { _hash: 'b' }, { _hash: 'b' }] }; // dup b
    const shadow = { new_findings: [{ _hash: 'b' }, { _hash: 'c' }] };
    const d = diffFindingBuckets(primary, shadow);
    assert.deepEqual(d.counts, { both: 1, primaryOnly: 1, shadowOnly: 1 });
    // primary deduped to [a, b]; buckets stamped
    assert.equal(d.primary.length, 2);
    assert.equal(d.primary.find((f) => f._hash === 'a')._bucket, 'primary-only');
    assert.equal(d.primary.find((f) => f._hash === 'b')._bucket, 'both');
    assert.equal(d.shadow.find((f) => f._hash === 'c')._bucket, 'shadow-only');
    assert.equal(d.shadow.find((f) => f._hash === 'b')._bucket, 'both');
  });

  it('handles a shadow with no findings (all primary become primary-only)', () => {
    const d = diffFindingBuckets({ new_findings: [{ _hash: 'a' }, { _hash: 'b' }] }, { new_findings: [] });
    assert.deepEqual(d.counts, { both: 0, primaryOnly: 2, shadowOnly: 0 });
  });

  it('handles empty/missing results without throwing', () => {
    const d = diffFindingBuckets({}, {});
    assert.deepEqual(d.counts, { both: 0, primaryOnly: 0, shadowOnly: 0 });
  });
});
