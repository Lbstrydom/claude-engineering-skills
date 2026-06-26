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
import { computeContractDigest, NAV_VERIFY_TOOL_VERSION } from '../scripts/lib/nav/schema.mjs';
import { collectNav } from '../scripts/lib/dashboard/collect-nav.mjs';
import { writeObservedEnvelope, assembleEnvelope } from '../scripts/lib/nav/envelope.mjs';

const contract = {
  version: 1, navLayers: { primary: ['#primary-nav'], secondary: ['.sub-tabs-row'] },
  personas: [{ id: 'p', intents: [{ id: 'browse', destination: 'wines', approvedAnchors: ['#primary-nav'], requiredInLayer: 'primary', frequency: 'high', source: 'declared' }] }],
};
const digest = computeContractDigest(contract);

function result(over = {}) {
  return {
    version: 2, url: 'https://app.test/', generatedAt: '2026-06-25T10:00:00+02:00',
    contractDigest: digest, toolVersion: NAV_VERIFY_TOOL_VERSION,
    statesRequested: ['mobile', 'desktop'], statesCollected: ['mobile', 'desktop'],
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
  it('rejects as stale when toolVersion mismatches (debt fix 3)', () => {
    writeVerifyResult(dir, result({ toolVersion: NAV_VERIFY_TOOL_VERSION + 99 }));
    const { result: r, rejectedReason } = readVerifyResult(dir, digest);
    assert.equal(r, null);
    assert.match(rejectedReason, /tool version/);
  });
  it('rejects a legacy un-versioned result as stale (debt fix 3)', () => {
    // A v1-shaped result with no toolVersion still PARSES (optional) but reads stale.
    const legacy = result(); delete legacy.toolVersion; legacy.version = 1;
    writeVerifyResult(dir, legacy);
    const { result: r, rejectedReason } = readVerifyResult(dir, digest);
    assert.equal(r, null);
    assert.match(rejectedReason, /tool version/);
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
