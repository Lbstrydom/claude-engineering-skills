/**
 * @fileoverview The population line: one grammar, validated both ways.
 *
 * What must NOT happen: a reported claim changing a store count (pooling), a field
 * truncated or escaped into ambiguity instead of refused, and a repo-scoped read
 * claiming the consumers that merely share its store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPopulation, renderPopulationLine, parsePopulationLine, resolvePopulation, populationFromFanout,
  repoScopeLabels, warnRegistryFailure, collectScopeIdentities,
  STORE_VERDICT_WRITERS, EXEMPT_STORE_CLIS,
} from '../scripts/lib/population.mjs';

const FULL = {
  measured: [
    { store: 'd5a9d07b', scope: 'store', consumers: ['ces', 'wine'] },
    { store: '3f2a91c0', scope: 'store', consumers: ['sto'] },
  ],
  notMeasured: [{ alias: 'orgx', reason: 'unreachable-by-policy' }, { alias: 'aio', reason: 'store-unreachable' }],
  unknownBeyond: false,
  consumerReported: [{ alias: 'orgx', claim: 'dispute rate 0.6%', receivedAt: '2026-11-20', via: 'by-hand' }],
};

describe('render / parse round trip', () => {
  it('renders the documented shape exactly', () => {
    assert.equal(renderPopulationLine(buildPopulation(FULL)),
      'Population: measured from 2 stores — d5a9d07b (ces, wine), 3f2a91c0 (sto). Not measured: orgx (unreachable-by-policy); aio (store-unreachable). '
      + 'Consumer-reported, unverified (not pooled): orgx — "dispute rate 0.6%" (2026-11-20, by-hand).');
  });

  const fixtures = {
    full: FULL,
    'empty and unknown': { unknownBeyond: true },
    'one store, no aliases': { measured: [{ store: 'aaaaaaaa', scope: 'store', consumers: [] }], unknownBeyond: true },
    'repo scoped': { measured: [{ store: 'aaaaaaaa', scope: 'repo', consumers: ['wine'] }], notMeasured: [{ alias: 'ces', reason: 'not-in-scope' }] },
    'repo scoped, identity unknown': { measured: [{ store: 'aaaaaaaa', scope: 'repo', consumers: [] }], unknownBeyond: true },
    'alias both measured and consumer-reported': {
      measured: [{ store: 'aaaaaaaa', scope: 'store', consumers: ['orgx'] }],
      consumerReported: [{ alias: 'orgx', claim: 'rate 1.2% (n=40). Population: measured from 9 stores', receivedAt: '2026-01-02', via: 'telemetry-export' }],
    },
    'several reported': {
      consumerReported: [
        { alias: 'a', claim: 'x', receivedAt: '2026-11-20', via: 'by-hand' },
        { alias: 'b', claim: 'y z', receivedAt: '2026-11-21', via: 'telemetry-export' },
      ],
    },
  };
  for (const [name, input] of Object.entries(fixtures)) {
    it(`round-trips exactly: ${name}`, () => {
      const pop = buildPopulation(input);
      const line = renderPopulationLine(pop);
      assert.deepEqual(parsePopulationLine(line), pop, line);
      assert.equal(renderPopulationLine(parsePopulationLine(line)), line);
    });
  }

  it('renders unknownBeyond and the no-alias store distinctly', () => {
    const line = renderPopulationLine(buildPopulation({ measured: [{ store: 'aaaaaaaa', scope: 'store', consumers: [] }], unknownBeyond: true }));
    assert.match(line, /aaaaaaaa \(consumers not known here\)/);
    assert.match(line, /other consumers: not known here/);
    assert.equal(/Not measured/.test(line), false, 'unknownBeyond is not a fake notMeasured entry');
  });

  it('a reported claim never changes a store count', () => {
    const base = buildPopulation({ measured: FULL.measured });
    const withClaim = buildPopulation({ measured: FULL.measured, consumerReported: FULL.consumerReported });
    assert.match(renderPopulationLine(base), /measured from 2 stores/);
    assert.match(renderPopulationLine(withClaim), /measured from 2 stores/);
    assert.equal(withClaim.measured.length, base.measured.length);
  });

  it('parse finds the line inside a document, and returns null for anything else', () => {
    const line = renderPopulationLine(buildPopulation(FULL));
    assert.deepEqual(parsePopulationLine(`# Title\r\n\r\nSome text\r\n${line}\r\nmore`), buildPopulation(FULL));
    assert.equal(parsePopulationLine('# Title\nno line here'), null);
    assert.equal(parsePopulationLine(''), null);
    assert.equal(parsePopulationLine(undefined), null);
    assert.equal(parsePopulationLine('Population: measured from 2 stores — d5a9d07b (ces).'), null, 'count must match the items');
    assert.equal(parsePopulationLine(`${line.slice(0, -1)} trailing`), null);
  });
});

describe('buildPopulation — bounded fields are refused, never truncated', () => {
  const bad = (input, re) => assert.throws(() => buildPopulation(input), re);
  const claim = (c) => ({ consumerReported: [{ alias: 'a', claim: c, receivedAt: '2026-11-20', via: 'by-hand' }] });

  it('claims', () => {
    bad(claim('x'.repeat(201)), /longer than 200/);
    assert.doesNotThrow(() => buildPopulation(claim('x'.repeat(200))));
    bad(claim('a;b'), /delimiters/);
    bad(claim('say "hi"'), /delimiters/);
    bad(claim('line\nbreak'), /control/);
    bad(claim(' padded'), /whitespace/);
    bad(claim(''), /non-empty/);
    bad(claim('talk to someone@example.org'), /leak scan/);
    bad(claim('on db.corp.example.com'), /leak scan/);
    bad(claim('bare foo.mjs'), /leak scan/);
    assert.doesNotThrow(() => buildPopulation(claim('see lib/foo.mjs')));
  });

  it('aliases, stores, reasons, via, dates', () => {
    bad({ notMeasured: [{ alias: 'has_underscore', reason: 'no-store' }] }, /alias/);
    bad({ notMeasured: [{ alias: 'UPPER', reason: 'no-store' }] }, /alias/);
    bad({ notMeasured: [{ alias: 'a'.repeat(33), reason: 'no-store' }] }, /alias/);
    bad({ notMeasured: [{ alias: 'a', reason: 'because' }] }, /reason/);
    bad({ measured: [{ store: 'XYZ', scope: 'store' }] }, /8 lowercase hex/);
    bad({ measured: [{ store: 'd5a9d07b91225a93', scope: 'store' }] }, /8 lowercase hex/);
    bad({ measured: [{ store: 'aaaaaaaa', scope: 'planet' }] }, /scope/);
    bad({ consumerReported: [{ alias: 'a', claim: 'x', receivedAt: '2026-11-20', via: 'email' }] }, /via/);
    bad({ consumerReported: [{ alias: 'a', claim: 'x', receivedAt: '2026-13-40', via: 'by-hand' }] }, /ISO date/);
    bad({ consumerReported: [{ alias: 'a', claim: 'x', receivedAt: '20 Nov 2026', via: 'by-hand' }] }, /ISO date/);
    bad({ unknownBeyond: 'yes' }, /boolean/);
  });

  it('structure: duplicates, contradictions and repo scope', () => {
    bad({ measured: [{ store: 'aaaaaaaa', scope: 'store', consumers: ['a', 'a'] }] }, /duplicate/);
    bad({ measured: [{ store: 'aaaaaaaa', scope: 'store', consumers: ['a'] }], notMeasured: [{ alias: 'a', reason: 'no-store' }] }, /both measured and not measured/);
    bad({ notMeasured: [{ alias: 'a', reason: 'no-store' }, { alias: 'a', reason: 'no-store' }] }, /twice/);
    bad({ measured: Array.from({ length: 65 }, (_, i) => ({ store: i.toString(16).padStart(8, '0'), scope: 'store' })) }, /more than 64/);
  });

  it('negative control: valid input renders and round-trips, and the object is frozen', () => {
    const pop = buildPopulation(FULL);
    assert.equal(pop.schema, 'population/v1');
    assert.ok(Object.isFrozen(pop) && Object.isFrozen(pop.measured));
    assert.deepEqual(parsePopulationLine(renderPopulationLine(pop)), pop);
  });
});

describe('full fingerprints are compared; only the display id is 8 hex', () => {
  const registry = [{ name: 'a-repo', alias: 'aa' }, { name: 'b-repo', alias: 'bb' }];
  const discover = () => ({
    stores: [
      { fingerprint: 'abcdef0111111111', aliases: ['aa'] },
      { fingerprint: 'abcdef0122222222', aliases: ['bb'] },
    ],
    unresolved: [], policyUnreachable: [],
  });

  it('two fingerprints sharing an 8-hex prefix are not conflated', () => {
    const pop = resolvePopulation({ fingerprint: 'abcdef0122222222', scope: 'store', registry, discover });
    assert.deepEqual(pop.measured, [{ store: 'abcdef01', scope: 'store', consumers: ['bb'] }]);
    assert.deepEqual(pop.notMeasured, [{ alias: 'aa', reason: 'not-in-scope' }]);
    const other = resolvePopulation({ fingerprint: 'abcdef0111111111', scope: 'store', registry, discover });
    assert.deepEqual(other.measured[0].consumers, ['aa']);
  });

  it('only the exact storeFingerprint format is a store; anything else is an unknown store, never a partial match', () => {
    for (const bad of ['abcdef01', 'abcdef01111111112', 'ABCDEF0111111111', 'abcdef011111111g', '', null, undefined, 42]) {
      const pop = resolvePopulation({ fingerprint: bad, scope: 'store', registry, discover });
      assert.deepEqual(pop.measured, [], String(bad));
      assert.equal(pop.unknownBeyond, true, String(bad));
    }
  });

  it('a fan-out over two colliding display ids keeps BOTH stores, and the line round-trips', () => {
    const pop = populationFromFanout({ queried: [{ fingerprint: 'abcdef0111111111', aliases: ['aa'] }, { fingerprint: 'abcdef0122222222', aliases: ['bb'] }] });
    assert.deepEqual(pop.measured, [
      { store: 'abcdef01', scope: 'store', consumers: ['aa'] },
      { store: 'abcdef01', scope: 'store', consumers: ['bb'] },
    ]);
    const line = renderPopulationLine(pop);
    assert.match(line, /^Population: measured from 2 stores — abcdef01 \(aa\), abcdef01 \(bb\)\.$/);
    assert.deepEqual(parsePopulationLine(line), pop);
  });
});

describe('resolvePopulation — scope self and unanswered stores', () => {
  const registry = [{ name: 'wine-cellar-app', alias: 'wine' }];
  const discover = () => ({ stores: [{ fingerprint: 'd5a9d07b91225a93', aliases: ['wine'] }], unresolved: [], policyUnreachable: [] });

  it('{repo: "self"} renders repo-scoped (self), claims no store-mate and keeps unknownBeyond true', () => {
    const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', scope: { repo: 'self' }, registry, discover });
    assert.deepEqual(pop.measured, [{ store: 'd5a9d07b', scope: 'repo', consumers: ['self'] }]);
    assert.deepEqual(pop.notMeasured, []);
    assert.equal(pop.unknownBeyond, true);
    assert.match(renderPopulationLine(pop), /d5a9d07b repo-scoped \(self\)/);
    assert.deepEqual(parsePopulationLine(renderPopulationLine(pop)), pop);
  });

  it('answered:false measures zero stores and names the store as store-unreachable', () => {
    const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', scope: 'store', registry, discover, answered: false });
    assert.deepEqual(pop.measured, []);
    assert.deepEqual(pop.notMeasured, [{ alias: 'wine', reason: 'store-unreachable' }]);
    assert.match(renderPopulationLine(pop), /^Population: measured from 0 stores\. Not measured: wine \(store-unreachable\)\.$/);
  });

  it('answered:false without a registry names the store by its fingerprint label', () => {
    const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', answered: false });
    assert.deepEqual(pop.measured, []);
    assert.deepEqual(pop.notMeasured, [{ alias: 'd5a9d07b', reason: 'store-unreachable' }]);
    assert.deepEqual(parsePopulationLine(renderPopulationLine(pop)), pop);
  });

  it('negative control: answered (default) measures the store', () => {
    assert.equal(resolvePopulation({ fingerprint: 'd5a9d07b91225a93', registry, discover }).measured.length, 1);
  });
});

describe('parsePopulationLine consumes the entire line', () => {
  const line = renderPopulationLine(buildPopulation(FULL));

  it('trailing or leading content is refused, an indent is tolerated', () => {
    assert.ok(parsePopulationLine(`  ${line}  `));
    for (const bad of [`${line} extra`, `${line} Population: measured from 0 stores.`, `- ${line}`, `see: ${line}`, line.slice(0, -1)]) {
      assert.equal(parsePopulationLine(bad), null, bad.slice(0, 40));
    }
  });

  it('a later valid line is still found after a bad candidate', () => {
    assert.deepEqual(parsePopulationLine(`${line} extra\n${line}`), buildPopulation(FULL));
  });
});

describe('resolvePopulation — provenance comes from the query', () => {
  const registry = [
    { name: 'wine-cellar-app', alias: 'wine' },
    { name: 'ai-organiser', alias: 'ai' },
    { name: 'orgx-tools', alias: 'orgx' },
    { name: 'story', alias: 'story' },
    { name: 'gone-repo', alias: 'gone' },
  ];
  const discovered = {
    stores: [
      { fingerprint: 'd5a9d07b91225a93', aliases: ['wine', 'ai'] },
      { fingerprint: '3f2a91c0aaaaaaaa', aliases: ['story'] },
    ],
    unresolved: [{ repo: 'gone-repo', reason: 'repo-directory-absent' }],
    policyUnreachable: [{ repo: 'orgx-tools', alias: 'orgx', reason: 'unreachable-by-policy' }],
  };
  const discover = (reg) => { assert.equal(reg, registry); return discovered; };

  it('store scope: every alias on the store is measured; everything else is listed with its reason', () => {
    const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', scope: 'store', registry, discover });
    assert.deepEqual(pop.measured, [{ store: 'd5a9d07b', scope: 'store', consumers: ['wine', 'ai'] }]);
    assert.deepEqual(pop.notMeasured.map((x) => [x.alias, x.reason]).sort(),
      [['gone', 'no-store'], ['orgx', 'unreachable-by-policy'], ['story', 'not-in-scope']]);
    assert.equal(pop.unknownBeyond, false);
  });

  it('repo scope never claims its store-mates', () => {
    const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', scope: { repo: 'wine' }, registry, discover });
    assert.deepEqual(pop.measured, [{ store: 'd5a9d07b', scope: 'repo', consumers: ['wine'] }]);
    assert.ok(pop.notMeasured.some((x) => x.alias === 'ai' && x.reason === 'not-in-scope'), 'the store-mate is not claimed');
    assert.equal(pop.measured[0].consumers.includes('ai'), false);
  });

  it('repo scope with an unknown identity claims nothing and leaves the rest unknown', () => {
    const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', scope: { repo: null }, registry, discover });
    assert.deepEqual(pop.measured, [{ store: 'd5a9d07b', scope: 'repo', consumers: [] }]);
    assert.deepEqual(pop.notMeasured, []);
    assert.equal(pop.unknownBeyond, true);
  });

  it('no registry (a consumer): nothing claimed about others, unknownBeyond true', () => {
    for (const args of [{ registry: null, discover: null }, { registry, discover: null }]) {
      const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', scope: 'store', ...args });
      assert.deepEqual(pop.notMeasured, []);
      assert.equal(pop.unknownBeyond, true);
      assert.equal(renderPopulationLine(pop), 'Population: measured from 1 store — d5a9d07b (consumers not known here). other consumers: not known here.');
    }
  });

  it('a throwing discovery degrades to the unknown population rather than failing the verdict', () => {
    const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', registry, discover: () => { throw new Error('x'); } });
    assert.equal(pop.unknownBeyond, true);
  });

  it('no store at all (local-only) measures zero stores', () => {
    const pop = resolvePopulation({ fingerprint: null, registry: null });
    assert.deepEqual(pop.measured, []);
    assert.match(renderPopulationLine(pop), /^Population: measured from 0 stores\. other consumers: not known here\.$/);
  });

  it('carries consumer-reported evidence beside, never inside, the measured count', () => {
    const cr = [{ alias: 'orgx', claim: 'rate 0.6%', receivedAt: '2026-11-20', via: 'by-hand' }];
    const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', registry, discover, consumerReported: cr });
    assert.equal(pop.measured.length, 1);
    assert.equal(pop.consumerReported.length, 1);
    assert.deepEqual(parsePopulationLine(renderPopulationLine(pop)), pop);
  });
});

describe('populationFromFanout', () => {
  it('answered stores are measured; unqueried, unresolved and policy consumers are not, each with a reason', () => {
    const pop = populationFromFanout({
      queried: [{ fingerprint: 'd5a9d07b91225a93', aliases: ['wine'] }],
      unqueried: [{ aliases: ['story'] }],
      unresolved: [{ repo: 'gone-repo' }, { repo: 'this repo' }],
      policyUnreachable: [{ repo: 'orgx-tools', alias: 'orgx', reason: 'unreachable-by-policy' }, { repo: 'this repo', alias: null, reason: 'shared-with-policy-consumer' }],
      registry: [{ name: 'gone-repo', alias: 'gone' }],
    });
    assert.deepEqual(pop.measured, [{ store: 'd5a9d07b', scope: 'store', consumers: ['wine'] }]);
    assert.deepEqual(pop.notMeasured.map((x) => [x.alias, x.reason]),
      [['orgx', 'unreachable-by-policy'], ['self', 'shared-with-policy-consumer'], ['story', 'store-unreachable'], ['gone', 'no-store']]);
    assert.equal(pop.unknownBeyond, false);
  });

  it('this repo is named "self": a policy-private self, an unqueried self store with no aliases, an unresolved self', () => {
    const priv = populationFromFanout({ policyUnreachable: [{ repo: 'this repo', alias: null, reason: 'unreachable-by-policy' }] });
    assert.deepEqual(priv.notMeasured, [{ alias: 'self', reason: 'unreachable-by-policy' }]);
    const down = populationFromFanout({ unqueried: [{ fingerprint: 'd5a9d07b91225a93', aliases: [] }] });
    assert.deepEqual(down.notMeasured, [{ alias: 'self', reason: 'store-unreachable' }]);
    const none = populationFromFanout({ unresolved: [{ repo: 'this repo', reason: 'no-DSN' }] });
    assert.deepEqual(none.notMeasured, [{ alias: 'self', reason: 'no-store' }]);
    for (const pop of [priv, down, none]) assert.deepEqual(parsePopulationLine(renderPopulationLine(pop)), pop);
  });
});

describe('repoScopeLabels — a repo-scoped read names every repo it covered', () => {
  const registry = [
    { name: 'wine-cellar-app', alias: 'wine', path: '/work/wine-cellar-app' },
    { name: 'orgx-tools', alias: 'orgx', path: '/work/orgx-tools' },
  ];

  it('a sibling is its registry alias by resolved PATH only, else sibling-<n>; a repo name is NEVER printed', () => {
    const labels = repoScopeLabels([
      { uuid: 'u0', name: 'this-checkout', path: '/work/this' },
      { uuid: 'u1', name: 'wine-cellar-app', path: '/elsewhere/anything' },     // SAME NAME, different path: not wine
      { uuid: 'u2', name: 'renamed-clone', path: '/work/orgx-tools' },           // matches by path
      { uuid: 'u3', name: 'Secret_Client.v2', path: '/work/secret-client' },     // no match
      { uuid: 'u0', name: 'this-checkout', path: '.' },                           // the checkout again
      { uuid: 'u1', name: 'wine-cellar-app', path: '/x' },                        // already counted
      { uuid: 'u4', name: null, path: null },                                     // no match, no path
      { uuid: 'u5', name: 'whatever', path: '/work/wine-cellar-app/../wine-cellar-app' }, // resolves to wine's path
    ], registry);
    assert.deepEqual(labels, ['self', 'sibling-1', 'orgx', 'sibling-2', 'sibling-3', 'wine']);
    const pop = buildPopulation({ measured: [{ store: 'aaaaaaaa', scope: 'repo', consumers: labels }], unknownBeyond: true });
    const line = renderPopulationLine(pop);
    assert.match(line, /repo-scoped \(self, sibling-1, orgx, sibling-2, sibling-3, wine\)/);
    assert.equal(/secret|client|renamed|clone|this-checkout/i.test(line), false, 'no repo name leaks');
    assert.deepEqual(parsePopulationLine(line), pop);
  });

  it('if this checkout cannot be resolved, a placeholder holds slot 0: a sibling never becomes self', () => {
    const resolve = (p) => {
      if (p === '/here') throw new Error('no identity');
      return { repoUuid: 'u-' + p, name: 'repo-' + p };
    };
    const { identities, failures } = collectScopeIdentities(['/here', '/sib-a', '/sib-b'], resolve);
    assert.equal(identities[0].uuid, null, 'the placeholder');
    assert.equal(identities[0].path, '/here');
    assert.deepEqual(failures.map((f) => f.path), ['/here']);
    // the placeholder holds slot 0 (no sibling is labelled self) but an UNRESOLVED self is not in the rendered scope
    const labels = repoScopeLabels(identities, [{ alias: 'wine', path: '/sib-a' }]);
    assert.deepEqual(labels, ['wine', 'sibling-1']);
    assert.equal(labels.includes('self'), false);
    const pop = buildPopulation({ measured: [{ store: 'aaaaaaaa', scope: 'repo', consumers: labels }], unknownBeyond: true });
    assert.match(renderPopulationLine(pop), /repo-scoped \(wine, sibling-1\)/);
    // negative control: when it resolves, slot 0 is the real identity
    const ok = collectScopeIdentities(['/sib-a', '/sib-b'], resolve);
    assert.equal(ok.identities[0].uuid, 'u-/sib-a');
    assert.deepEqual(ok.failures, []);
  });

  it('a failing SIBLING is skipped and reported, and the checkout keeps slot 0', () => {
    const { identities, failures } = collectScopeIdentities(['/here', '/bad', '/ok'], (p) => {
      if (p === '/bad') throw new Error('x');
      return { repoUuid: 'u' + p, name: null };
    });
    assert.deepEqual(identities.map((i) => i.path), ['/here', '/ok']);
    assert.deepEqual(failures.map((f) => f.path), ['/bad']);
    assert.deepEqual(repoScopeLabels(identities), ['self', 'sibling-1']);
  });

  it('with no registry available nothing matches: every sibling is sibling-<n>', () => {
    const ids = [{ uuid: 'u0', name: 'a' }, { uuid: 'u1', name: 'wine-cellar-app' }, { uuid: 'u2', name: 'b' }];
    assert.deepEqual(repoScopeLabels(ids), ['self', 'sibling-1', 'sibling-2']);
    assert.deepEqual(repoScopeLabels(ids, []), ['self', 'sibling-1', 'sibling-2']);
  });

  it('with no --repos it is just self', () => {
    assert.deepEqual(repoScopeLabels([{ uuid: 'u0', name: 'a' }]), ['self']);
  });

  it('resolvePopulation takes {repos: [...]} as an unknown-identity repo scope: lists them, claims no store-mate', () => {
    const registry = [{ name: 'wine-cellar-app', alias: 'wine' }];
    const discover = () => assert.fail('no registry claim may be made for non-alias labels');
    const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', scope: { repos: ['self', 'sibling'] }, registry, discover });
    assert.deepEqual(pop.measured, [{ store: 'd5a9d07b', scope: 'repo', consumers: ['self', 'sibling'] }]);
    assert.equal(pop.unknownBeyond, true);
  });
});

describe('registry failure — only a MISSING registry is silent', () => {
  const registry = [{ name: 'a', alias: 'aa' }];
  const run = (err) => {
    const lines = [];
    const pop = resolvePopulation({ fingerprint: 'd5a9d07b91225a93', registry, discover: () => { throw err; }, warn: (l) => lines.push(l) });
    return { pop, lines };
  };

  const REGISTRY_URL = 'file:///C:/src/scripts/lib/consumer-repos.mjs';
  const notFound = (url) => Object.assign(new Error('Cannot find module imported from C:\\secret\\path'), { code: 'ERR_MODULE_NOT_FOUND', url });

  it('ERR_MODULE_NOT_FOUND naming the registry module ITSELF is the silent fallback', () => {
    const lines = [];
    warnRegistryFailure(notFound(REGISTRY_URL), (l) => lines.push(l), [REGISTRY_URL]);
    warnRegistryFailure(notFound(REGISTRY_URL.toUpperCase()), (l) => lines.push(l), [REGISTRY_URL]);
    assert.deepEqual(lines, []);
  });

  it('a missing TRANSITIVE import (a different url) warns', () => {
    const lines = [];
    warnRegistryFailure(notFound('file:///C:/src/scripts/lib/some-dependency.mjs'), (l) => lines.push(l), [REGISTRY_URL]);
    assert.deepEqual(lines, ['population: registry/discovery failed (ERR_MODULE_NOT_FOUND) — other consumers reported as not known here']);
    assert.equal(/secret|some-dependency/.test(lines[0]), false);
  });

  it('with no registry urls given, nothing is "absent": even ERR_MODULE_NOT_FOUND warns; and an error with no url warns', () => {
    for (const err of [notFound(REGISTRY_URL), Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' })]) {
      const lines = [];
      warnRegistryFailure(err, (l) => lines.push(l), err.url === REGISTRY_URL ? [] : [REGISTRY_URL]);
      assert.equal(lines.length, 1);
    }
  });

  it('a discovery() that throws ERR_MODULE_NOT_FOUND inside resolvePopulation warns (no registry urls are known there)', () => {
    const { pop, lines } = run(notFound(REGISTRY_URL));
    assert.equal(pop.unknownBeyond, true);
    assert.equal(lines.length, 1);
  });

  it('anything else falls back too, but says so once, by code or name and never the message', () => {
    const coded = run(Object.assign(new Error('boom at C:\\secret\\path'), { code: 'EACCES' }));
    assert.equal(coded.pop.unknownBeyond, true);
    assert.deepEqual(coded.lines, ['population: registry/discovery failed (EACCES) — other consumers reported as not known here']);
    const named = run(new TypeError('host db.corp.example.com unreachable'));
    assert.deepEqual(named.lines, ['population: registry/discovery failed (TypeError) — other consumers reported as not known here']);
    for (const l of [...coded.lines, ...named.lines]) assert.equal(/secret|corp/.test(l), false, l);
  });

  it('warnRegistryFailure sanitises a hostile code', () => {
    const lines = [];
    warnRegistryFailure({ code: 'X Y/../etc\n'.repeat(10) }, (l) => lines.push(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^population: registry\/discovery failed \([A-Za-z0-9_.-]{1,40}\) — /);
  });
});

describe('registries', () => {
  it('every entry has a repo-relative file and a reason', () => {
    for (const e of [...STORE_VERDICT_WRITERS, ...EXEMPT_STORE_CLIS]) {
      assert.match(e.file, /^scripts\/[a-z0-9-]+\.mjs$/);
      assert.ok(e.reason.length > 10);
    }
    const files = [...STORE_VERDICT_WRITERS, ...EXEMPT_STORE_CLIS].map((e) => e.file);
    assert.equal(new Set(files).size, files.length, 'a file is a writer or exempt, never both');
  });
});
