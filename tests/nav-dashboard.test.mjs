/**
 * Cluster B — dashboard nav collector section-contract test (plan §4a.F, audit R2-L1).
 * Asserts collector output shape + empty-panel degradation when inputs are absent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectNav } from '../scripts/lib/dashboard/collect-nav.mjs';
import { writeObservedEnvelope, assembleEnvelope } from '../scripts/lib/nav/envelope.mjs';
import { computeContractDigest, NAV_VERIFY_TOOL_VERSION } from '../scripts/lib/nav/schema.mjs';
import { writeVerifyResult } from '../scripts/lib/nav/verify-store.mjs';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-dash-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('collectNav degradation (section-contract)', () => {
  it('returns missing-optional + empty panels when no contract present', async () => {
    const r = await collectNav(dir);
    assert.equal(r.navAudit.status.status, 'missing-optional');
    assert.deepEqual(r.navAudit.scorecard, []);
    assert.deepEqual(r.navAudit.drift, []);
  });

  it('returns missing-optional when contract present but no observed envelope', async () => {
    fs.writeFileSync(path.join(dir, 'nav-contract.json'), JSON.stringify({
      version: 1, navLayers: { primary: ['Sidebar'] },
      personas: [{ id: 'p', intents: [{ id: 'i', destination: '/x', approvedAnchors: ['Sidebar'], requiredInLayer: 'primary' }] }],
    }));
    const r = await collectNav(dir);
    assert.equal(r.navAudit.status.status, 'missing-optional');
  });

  it('LIVE-ONLY: surfaces live scorecard + liveFindings from a fresh verify result when the observed envelope is absent (debt fix 2)', async () => {
    const live = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-dash-lo-'));
    const contract = {
      version: 1, navLayers: { primary: ['#primary-nav'], secondary: ['.sub'] },
      personas: [{ id: 'p', intents: [{ id: 'browse', destination: 'wines', approvedAnchors: ['#primary-nav'], requiredInLayer: 'primary', frequency: 'high', source: 'declared' }] }],
    };
    fs.writeFileSync(path.join(live, 'nav-contract.json'), JSON.stringify(contract));
    // No observed envelope written — only a fresh verify result.
    writeVerifyResult(live, {
      version: 2, url: 'https://app.test/', generatedAt: '2026-06-25T10:00:00+02:00',
      contractDigest: computeContractDigest(contract), toolVersion: NAV_VERIFY_TOOL_VERSION,
      statesRequested: ['mobile'], statesCollected: ['mobile'],
      liveAttribution: { wines: { placements: [{ container: '#primary-nav', layer: 'primary', state: 'mobile', role: null }], layers: ['primary'], states: ['mobile'] } },
      liveFindings: [{ class: 'competing-models', severity: 'P2', destination: 'primary|secondary', evidence: ['x'], confidence: 'high', gateEligible: false, verdict: 'two nav systems', source: 'live' }],
    });
    const r = await collectNav(live);
    assert.equal(r.navAudit.status.status, 'ok');
    assert.equal(r.navAudit.verifyMeta.live, true);
    assert.equal(r.navAudit.verifyMeta.staticStale, true);
    assert.equal(r.navAudit.liveFindings.length, 1);
    assert.ok(r.navAudit.scorecard.length >= 1, 'live scorecard rows surfaced without a static model');
    assert.deepEqual(r.navAudit.drift, [], 'no static drift in live-only mode');
    fs.rmSync(live, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});

describe('collectNav scorecard', () => {
  it('builds a per-intent reachability row and flags a buried high-freq intent red', async () => {
    const contract = {
      version: 1, navLayers: { primary: ['Sidebar'], secondary: ['Footer'] },
      personas: [{ id: 'p', intents: [
        { id: 'browse', destination: '/wines', approvedAnchors: ['Sidebar'], requiredInLayer: 'primary', frequency: 'high', source: 'declared' },
      ] }],
    };
    fs.writeFileSync(path.join(dir, 'nav-contract.json'), JSON.stringify(contract));
    // Observed: /wines reachable only from a NON-prominent 'Footer' → red.
    const env = assembleEnvelope({
      refreshId: 'r', contractDigest: computeContractDigest(contract), headSha: null,
      generatedAt: '2026-06-25T00:00:00Z',
      edges: [{ entryPoint: 'Footer', layer: 'secondary', anchor: 'Footer', affordanceType: 'link', label: 'Wines', destination: '/wines', confidence: 'high', sourceLoc: 'f.tsx:1' }],
      destinations: [{ id: '/wines' }],
    });
    writeObservedEnvelope(dir, env);
    const r = await collectNav(dir);
    assert.equal(r.navAudit.status.status, 'ok');
    assert.equal(r.navAudit.scorecard.length, 1);
    const row = r.navAudit.scorecard[0];
    assert.equal(row.destination, '/wines');
    assert.equal(row.status, 'red'); // high-freq intent not in primary nav
  });
});
