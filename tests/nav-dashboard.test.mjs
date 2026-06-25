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
import { computeContractDigest } from '../scripts/lib/nav/schema.mjs';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-dash-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('collectNav degradation (section-contract)', () => {
  it('returns missing-optional + empty panels when no contract present', () => {
    const r = collectNav(dir);
    assert.equal(r.navAudit.status.status, 'missing-optional');
    assert.deepEqual(r.navAudit.scorecard, []);
    assert.deepEqual(r.navAudit.drift, []);
  });

  it('returns missing-optional when contract present but no observed envelope', () => {
    fs.writeFileSync(path.join(dir, 'nav-contract.json'), JSON.stringify({
      version: 1, navLayers: { primary: ['Sidebar'] },
      personas: [{ id: 'p', intents: [{ id: 'i', destination: '/x', approvedAnchors: ['Sidebar'], requiredInLayer: 'primary' }] }],
    }));
    const r = collectNav(dir);
    assert.equal(r.navAudit.status.status, 'missing-optional');
  });
});

describe('collectNav scorecard', () => {
  it('builds a per-intent reachability row and flags a buried high-freq intent red', () => {
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
    const r = collectNav(dir);
    assert.equal(r.navAudit.status.status, 'ok');
    assert.equal(r.navAudit.scorecard.length, 1);
    const row = r.navAudit.scorecard[0];
    assert.equal(row.destination, '/wines');
    assert.equal(row.status, 'red'); // high-freq intent not in primary nav
  });
});
