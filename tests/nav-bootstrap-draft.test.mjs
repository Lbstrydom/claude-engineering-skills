/**
 * v1.1 Cluster B — pure bootstrap drafter (plan Priority 2 / §4a). Tier-1: no browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { draftContractFromLive } from '../scripts/lib/nav/bootstrap-draft.mjs';
import { bootstrapContract, contractExists } from '../scripts/lib/nav/contract.mjs';
import { NavContractSchema } from '../scripts/lib/nav/schema.mjs';

function ev(target, sel, role, tag) {
  return { target, navIsh: sel ? { selector: sel, role: role || null, tag: tag || 'DIV' } : null };
}

describe('draftContractFromLive precedence (R2-M3, non-overlapping)', () => {
  it('classifies primary/secondary by selector words', () => {
    const d = draftContractFromLive([
      ev('today', '#primary-nav'),
      ev('grid', '.sub-tabs-row'),
      ev('wines', '#primary-nav'),
    ]);
    assert.deepEqual(d.navLayers.primary, ['#primary-nav']);
    assert.deepEqual(d.navLayers.secondary, ['.sub-tabs-row']);
    assert.deepEqual(d.observedTargets, ['grid', 'today', 'wines']);
  });

  it('promotes the single most-prominent <nav> to primary when no primary word matches', () => {
    const d = draftContractFromLive([
      ev('a', '.toolbar', null, 'DIV'),
      ev('b', '.app-menu', 'navigation', 'NAV'),
    ]);
    // the <nav> wins primary; the other nav-ish → secondary
    assert.deepEqual(d.navLayers.primary, ['.app-menu']);
    assert.ok(d.navLayers.secondary.includes('.toolbar'));
  });

  it('routes sub-tabs to secondary even when seen first', () => {
    const d = draftContractFromLive([ev('x', '.sub-tabs-row'), ev('y', '#primary-nav')]);
    assert.ok(d.navLayers.secondary.includes('.sub-tabs-row'));
    assert.ok(d.navLayers.primary.includes('#primary-nav'));
  });

  it('drops <dynamic> targets from observedTargets', () => {
    const d = draftContractFromLive([ev('<dynamic>', '#primary-nav'), ev('wines', '#primary-nav')]);
    assert.deepEqual(d.observedTargets, ['wines']);
  });
});

describe('bootstrapContract with a live draft', () => {
  it('uses the drafted navLayers and validates against the schema', () => {
    const draft = draftContractFromLive([ev('today', '#primary-nav'), ev('grid', '.sub-tabs-row')]);
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
