/**
 * v1.2 — verify-result persistence: write/read + contract-digest staleness, and
 * the dashboard merging live verdicts when a fresh result exists.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeVerifyResult, readVerifyResult } from '../scripts/lib/nav/verify-store.mjs';
import { computeContractDigest } from '../scripts/lib/nav/schema.mjs';
import { collectNav } from '../scripts/lib/dashboard/collect-nav.mjs';
import { writeObservedEnvelope, assembleEnvelope } from '../scripts/lib/nav/envelope.mjs';

const contract = {
  version: 1, navLayers: { primary: ['#primary-nav'], secondary: ['.sub-tabs-row'] },
  personas: [{ id: 'p', intents: [{ id: 'browse', destination: 'wines', approvedAnchors: ['#primary-nav'], requiredInLayer: 'primary', frequency: 'high', source: 'declared' }] }],
};
const digest = computeContractDigest(contract);

function result(over = {}) {
  return {
    version: 1, url: 'https://app.test/', generatedAt: '2026-06-25T10:00:00+02:00',
    contractDigest: digest, statesRequested: ['mobile', 'desktop'], statesCollected: ['mobile', 'desktop'],
    liveAttribution: { wines: { placements: [{ container: '#primary-nav', layer: 'primary', state: 'mobile', role: null }], layers: ['primary'], states: ['mobile'] } },
    ...over,
  };
}

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-vs-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('verify-store write/read', () => {
  it('round-trips a valid result', () => {
    writeVerifyResult(dir, result());
    const { result: r } = readVerifyResult(dir, digest);
    assert.ok(r);
    assert.equal(r.url, 'https://app.test/');
  });
  it('rejects as stale when the contract digest changed', () => {
    writeVerifyResult(dir, result());
    const { result: r, rejectedReason } = readVerifyResult(dir, 'a'.repeat(64));
    assert.equal(r, null);
    assert.match(rejectedReason, /stale/);
  });
  it('returns null (no reason) when absent', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-vs2-'));
    const { result: r, rejectedReason } = readVerifyResult(fresh, digest);
    assert.equal(r, null);
    assert.equal(rejectedReason, null);
    fs.rmSync(fresh, { recursive: true, force: true });
  });
});

describe('dashboard merges live verdicts when a fresh result exists', () => {
  it('shows pass (live) instead of the static status', () => {
    fs.writeFileSync(path.join(dir, 'nav-contract.json'), JSON.stringify(contract));
    writeObservedEnvelope(dir, assembleEnvelope({
      refreshId: 'r', contractDigest: digest, headSha: null, generatedAt: '2026-06-25T00:00:00Z',
      edges: [], destinations: [{ id: 'wines' }],
    }));
    writeVerifyResult(dir, result());
    const { navAudit } = collectNav(dir);
    assert.equal(navAudit.verifyMeta.live, true);
    const row = navAudit.scorecard.find((r) => r.destination === 'wines');
    assert.equal(row.status, 'pass'); // live verdict, not static 'unverified'
  });
});
