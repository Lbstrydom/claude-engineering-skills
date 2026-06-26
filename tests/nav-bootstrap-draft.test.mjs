/**
 * v1.1 Cluster B — pure bootstrap drafter (plan Priority 2 / §4a). Tier-1: no browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { draftContractFromLive } from '../scripts/lib/nav/bootstrap-draft.mjs';
import { bootstrapContract, contractExists } from '../scripts/lib/nav/contract.mjs';
import { NavContractSchema } from '../scripts/lib/nav/schema.mjs';

// v1.2: each occurrence carries containerCandidates [{selector,sticky}]. cands is
// a list of selectors (sticky=false) or [selector, sticky] tuples.
function ev(target, ...cands) {
  return { target, containerCandidates: cands.map((c) => (typeof c === 'string' ? { selector: c, sticky: false } : { selector: c[0], sticky: !!c[1] })) };
}

describe('draftContractFromLive (v1.2 container grouping, ≥2 targets)', () => {
  it('classifies primary/secondary by selector words (each container ≥2 targets)', () => {
    const d = draftContractFromLive([
      ev('today', '#primary-nav'), ev('wines', '#primary-nav'),
      ev('grid', '.sub-tabs-row'), ev('drinksoon', '.sub-tabs-row'),
    ]);
    assert.deepEqual(d.navLayers.primary, ['#primary-nav']);
    assert.deepEqual(d.navLayers.secondary, ['.sub-tabs-row']);
    assert.deepEqual(d.observedTargets, ['drinksoon', 'grid', 'today', 'wines']);
  });

  it('a sticky/fixed container → primary even with no primary word', () => {
    const d = draftContractFromLive([
      ev('a', ['.bar', true]), ev('b', ['.bar', true]),  // sticky
      ev('c', '.toolbar'), ev('d', '.toolbar'),
    ]);
    assert.ok(d.navLayers.primary.includes('.bar'));
    assert.ok(d.navLayers.secondary.includes('.toolbar'));
  });

  it('no signal → earliest-document-order container → primary (R2-M3, not <nav> preference)', () => {
    const d = draftContractFromLive([
      ev('a', '.toolbar'), ev('b', '.toolbar'),       // seen first
      ev('c', '.app-menu'), ev('d', '.app-menu'),
    ]);
    assert.deepEqual(d.navLayers.primary, ['.toolbar']);
    assert.ok(d.navLayers.secondary.includes('.app-menu'));
  });

  it('drops single-target containers (never a single-button selector as a layer)', () => {
    const d = draftContractFromLive([
      ev('today', '#primary-nav'), ev('wines', '#primary-nav'),
      ev('lonely', '#tab-kitchen'),  // 1 target → dropped
    ]);
    assert.deepEqual(d.navLayers.primary, ['#primary-nav']);
    assert.equal([...d.navLayers.primary, ...d.navLayers.secondary].includes('#tab-kitchen'), false);
  });

  it('drops <dynamic> targets from observedTargets', () => {
    const d = draftContractFromLive([ev('<dynamic>', '#primary-nav'), ev('wines', '#primary-nav')]);
    assert.deepEqual(d.observedTargets, ['wines']);
  });
});

describe('bootstrapContract with a live draft', () => {
  it('uses the drafted navLayers and validates against the schema', () => {
    const draft = draftContractFromLive([
      ev('today', '#primary-nav'), ev('wines', '#primary-nav'),
      ev('grid', '.sub-tabs-row'), ev('drinksoon', '.sub-tabs-row'),
    ]);
    const { contract } = bootstrapContract({ destinations: [], draftNavLayers: draft.navLayers, observedTargets: draft.observedTargets });
    assert.deepEqual(contract.navLayers.primary, ['#primary-nav']);
    assert.ok(typeof contract._note === 'string'); // observedTargets side-artifact
    assert.ok(NavContractSchema.safeParse(contract).success);
  });
});

describe('contractExists refuse-clobber guard', () => {
  it('reports false for a dir with no contract', () => {
    assert.equal(contractExists(process.env.TMP || '/tmp'), false);
  });
});

import { describe as d2, it as i2 } from 'node:test';
import assert2 from 'node:assert/strict';
import fs2 from 'node:fs';
import os2 from 'node:os';
import path2 from 'node:path';
import { readContract } from '../scripts/lib/nav/contract.mjs';
d2('readContract requiredInLayer validation (R3-M4)', () => {
  i2('errors when an intent requiredInLayer is not a navLayers key', () => {
    const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'nav-ct-'));
    fs2.writeFileSync(path2.join(dir, 'nav-contract.json'), JSON.stringify({
      version: 1, navLayers: { primary: ['#nav'] },
      personas: [{ id: 'p', intents: [{ id: 'i', destination: 'x', requiredInLayer: 'sidebar' }] }],
    }));
    const r = readContract(dir);
    assert2.equal(r.contract, null);
    assert2.match(r.error, /requiredInLayer 'sidebar' is not a key/);
    fs2.rmSync(dir, { recursive: true, force: true });
  });
});
