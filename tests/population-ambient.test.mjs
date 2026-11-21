/**
 * @fileoverview `ambientPopulation` — the impure wrapper. A registry that is simply ABSENT (a consumer) is the
 * silent, ordinary fallback; every other failure still falls back to `unknownBeyond: true` but says so once, by
 * code or name only (an error message can carry a path).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ambientPopulation, siblingScopeLabels } from '../scripts/lib/store/population-ambient.mjs';

const LIB = path.resolve(import.meta.dirname, '..', 'scripts', 'lib');
const urlOf = (rel) => pathToFileURL(path.join(LIB, rel)).href;
const notFound = (url) => Object.assign(new Error('Cannot find module imported from /home/someone/secret'), { code: 'ERR_MODULE_NOT_FOUND', url });

const FP = 'd5a9d07b91225a93';

async function run(loadRegistry) {
  const lines = [];
  const pop = await ambientPopulation({ fingerprint: FP, loadRegistry, warn: (l) => lines.push(l) });
  return { pop, lines };
}

describe('ambientPopulation — registry load failures', () => {
  it('ERR_MODULE_NOT_FOUND naming a registry module (consumer-repos, store-discovery, store-reachability): silent unknown population', async () => {
    for (const rel of ['consumer-repos.mjs', 'upstream/store-discovery.mjs', 'doctor/store-reachability.mjs']) {
      const r = await run(async () => { throw notFound(urlOf(rel)); });
      assert.equal(r.pop.unknownBeyond, true, rel);
      assert.deepEqual(r.lines, [], rel);
    }
    const { pop, lines } = await run(async () => { throw notFound(urlOf('consumer-repos.mjs')); });
    assert.equal(pop.unknownBeyond, true);
    assert.deepEqual(pop.measured, [{ store: 'd5a9d07b', scope: 'store', consumers: [] }]);
    assert.deepEqual(lines, []);
  });

  it('a missing TRANSITIVE import warns once (it is not "registry absent")', async () => {
    const { pop, lines } = await run(async () => { throw notFound(urlOf('some-transitive-dependency.mjs')); });
    assert.equal(pop.unknownBeyond, true);
    assert.deepEqual(lines, ['population: registry/discovery failed (ERR_MODULE_NOT_FOUND) — other consumers reported as not known here']);
    assert.equal(/someone|secret|transitive/.test(lines[0]), false);
  });

  it('any other error: same fallback plus ONE line with the code or name, never the message', async () => {
    const { pop, lines } = await run(async () => { throw Object.assign(new Error('refused at /home/someone/secret'), { code: 'EPERM' }); });
    assert.equal(pop.unknownBeyond, true);
    assert.deepEqual(lines, ['population: registry/discovery failed (EPERM) — other consumers reported as not known here']);
    const named = await run(async () => { throw new SyntaxError('Unexpected token in /home/someone/secret'); });
    assert.deepEqual(named.lines, ['population: registry/discovery failed (SyntaxError) — other consumers reported as not known here']);
    assert.equal(/someone|secret/.test([...lines, ...named.lines].join('')), false);
  });

  it('negative control: a working registry makes no claim of ignorance and no stderr line', async () => {
    const { pop, lines } = await run(async () => ({
      registry: [{ name: 'a', alias: 'aa' }],
      discover: () => ({ stores: [{ fingerprint: FP, aliases: ['aa'] }], unresolved: [], policyUnreachable: [] }),
    }));
    assert.equal(pop.unknownBeyond, false);
    assert.deepEqual(pop.measured[0].consumers, ['aa']);
    assert.deepEqual(lines, []);
  });

  it('a discovery that throws at run time is reported the same way', async () => {
    const { pop, lines } = await run(async () => ({ registry: [{ name: 'a', alias: 'aa' }], discover: () => { throw new RangeError('x'); } }));
    assert.equal(pop.unknownBeyond, true);
    assert.deepEqual(lines, ['population: registry/discovery failed (RangeError) — other consumers reported as not known here']);
  });
});

describe('siblingScopeLabels', () => {
  const ids = [{ uuid: 'u0', name: 'here', path: '/h' }, { uuid: 'u1', name: 'wine-cellar-app', path: '/w' }, { uuid: 'u2', name: 'unknown-one', path: '/u' }, { uuid: 'u3', name: 'wine-cellar-app', path: '/other-wine-clone' }];

  it('uses the registry to turn a matching sibling into its alias', async () => {
    const labels = await siblingScopeLabels(ids, { loadRegistry: async () => ({ registry: [{ name: 'wine-cellar-app', alias: 'wine', path: '/w' }] }) });
    assert.deepEqual(labels, ['self', 'wine', 'sibling-1', 'sibling-2'], 'same name, different path: not wine');
  });

  it('an absent registry is silent and matches nothing', async () => {
    const lines = [];
    const labels = await siblingScopeLabels(ids, { loadRegistry: async () => { throw notFound(urlOf('consumer-repos.mjs')); }, warn: (l) => lines.push(l) });
    assert.deepEqual(labels, ['self', 'sibling-1', 'sibling-2', 'sibling-3']);
    assert.deepEqual(lines, []);
  });

  it('a failing registry says so once and never prints a repo name', async () => {
    const lines = [];
    const labels = await siblingScopeLabels(ids, { loadRegistry: async () => { throw new TypeError('x'); }, warn: (l) => lines.push(l) });
    assert.deepEqual(labels, ['self', 'sibling-1', 'sibling-2', 'sibling-3']);
    assert.equal(lines.length, 1);
    assert.equal(/wine|unknown-one/.test([...labels, ...lines].join(' ')), false);
  });
});
