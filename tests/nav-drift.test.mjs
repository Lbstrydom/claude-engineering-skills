/**
 * Cluster B — drift: divergence partition, changed-surface scoping, cloud-sourced
 * aging (plan §4a.D/E/G). Tier-1 deterministic seam.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionFindings, scopeToChanged, ageDivergences, divergenceKey, firstSeenFromHistory,
} from '../scripts/lib/nav/drift.mjs';

const gate = { class: 'coverage-gap', severity: 'P1', destination: '/admin', gateEligible: true, evidence: ['/admin requires layer; not reachable at app/admin/page.tsx:3'] };
const advisory = { class: 'orphan', severity: 'P2', destination: '/lonely', gateEligible: false, evidence: ['no inbound'] };

describe('partitionFindings', () => {
  it('splits gate-eligible from advisory', () => {
    const { gateEligible, advisory: adv } = partitionFindings([gate, advisory]);
    assert.equal(gateEligible.length, 1);
    assert.equal(adv.length, 1);
  });
});

describe('scopeToChanged', () => {
  it('blocks only when the finding touches a changed file', () => {
    const blocking = scopeToChanged([gate], new Set(['app/admin/page.tsx']));
    assert.equal(blocking.length, 1);
  });
  it('does not block when the changed set misses the finding', () => {
    const blocking = scopeToChanged([gate], new Set(['README.md']));
    assert.equal(blocking.length, 0);
  });
  it('blocks all eligible when the contract itself changed', () => {
    const blocking = scopeToChanged([gate], new Set(['README.md']), { contractChanged: true });
    assert.equal(blocking.length, 1);
  });
  it('full-scope (no changed set) keeps all eligible', () => {
    assert.equal(scopeToChanged([gate], null).length, 1);
  });
});

describe('aging (cloud-sourced)', () => {
  it('ages from cloud history firstSeen, not a local stamp', () => {
    const history = [
      { driftKeys: ['coverage-gap:/admin'], capturedAt: '2026-06-01T00:00:00Z' },
      { driftKeys: ['coverage-gap:/admin'], capturedAt: '2026-06-10T00:00:00Z' },
    ];
    const lookup = firstSeenFromHistory(history);
    const [aged] = ageDivergences([gate], { firstSeenLookup: lookup, headCommitDate: '2026-06-25T00:00:00Z' });
    assert.equal(aged.key, 'coverage-gap:/admin');
    assert.equal(aged.firstSeen, '2026-06-01T00:00:00Z');
    assert.equal(aged.ageDays, 24); // Jun 1 → Jun 25
  });

  it('a brand-new divergence ages to 0 (stamped at headCommitDate)', () => {
    const [aged] = ageDivergences([gate], { firstSeenLookup: () => null, headCommitDate: '2026-06-25T00:00:00Z' });
    assert.equal(aged.ageDays, 0);
  });
});

describe('divergenceKey', () => {
  it('is stable per class+destination', () => {
    assert.equal(divergenceKey(gate), 'coverage-gap:/admin');
  });
});
