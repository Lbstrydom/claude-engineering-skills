/**
 * @fileoverview Phase 2 capture-library tests.
 *
 * Covers:
 *   - NetworkGroundTruth store: upsert, LRU eviction, latest-wins, cap reporting
 *   - matchResponseAgainstManifest: URL pattern, method, operationName,
 *     requestMatchers, excludeUrlPattern, collection scope walking
 *   - stabiliseDom: returns ticks; emits warning on cap
 *   - extractDomClaims: declared vs undeclared dispatch via fake page
 *   - captureWitness: full integration with a mock page + listener
 *
 * Uses a duck-typed mock `page` to test without installing playwright
 * (Phase 6.5 will land the real install slice).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNetworkGroundTruthStore,
  matchResponseAgainstManifest,
  stabiliseDom,
  extractDomClaims,
  captureWitness,
  attachNetworkListener,
  _internals,
} from '../scripts/lib/ux-lock/capture.mjs';

// ────────────────────────────────────────────────────────────────────────────
// Fake page — enough surface for the capture library to exercise.
// ────────────────────────────────────────────────────────────────────────────

function createFakePage({ domClaims = [], evalScript = null } = {}) {
  let responseHandler = null;
  let stableTickCounter = 0;
  return {
    on(event, fn) {
      if (event === 'response') responseHandler = fn;
    },
    off(event, fn) {
      if (event === 'response' && responseHandler === fn) responseHandler = null;
    },
    async fireResponse(response) {
      if (responseHandler) await responseHandler(response);
    },
    async evaluate(fn) {
      // The capture library passes a function — we don't actually run it in
      // a browser. Instead we hand back synthetic results based on what the
      // test configured.
      if (evalScript) return evalScript(stableTickCounter++);
      return domClaims;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Swallowed-error trap.
//
// `attachNetworkListener`'s handler catches everything and routes it to
// `opts.onError`, and `matchResponseAgainstManifest` fail-softs to `[]` when a
// body cannot be read. Both are correct in production — a response body really
// can vanish after navigation — but with no `onError` supplied they make a
// thrown error indistinguishable from a genuine no-match: the store just stays
// empty. That is exactly how a rare CI failure here surfaced as a bare
// `0 !== 1` with nothing to diagnose from.
//
// These tests therefore always pass an onError sink and assert it stayed empty
// BEFORE asserting on claim counts, so the next occurrence names its own cause
// instead of looking like an assertion mismatch.
function errorSink() {
  const errors = [];
  return {
    opts: { onError: (e) => errors.push(e) },
    assertClean() {
      assert.deepEqual(errors.map((e) => e?.message ?? String(e)), [],
        'the network listener swallowed an error — an empty store here is a masked failure, not a no-match');
    },
  };
}

function fakeResponse({ url, status = 200, method = 'GET', body, postData = null, operationName }) {
  return {
    url() { return url; },
    status() { return status; },
    request() {
      return {
        method() { return method; },
        postData() {
          if (operationName) return JSON.stringify({ operationName, ...(postData ?? {}) });
          return postData ? JSON.stringify(postData) : null;
        },
      };
    },
    async json() { return body; },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// NetworkGroundTruth store
// ────────────────────────────────────────────────────────────────────────────

describe('createNetworkGroundTruthStore', () => {
  it('upserts and retrieves by surface tuple', () => {
    const s = createNetworkGroundTruthStore({ cap: 4 });
    s.upsert('status-chip::cellarOrganised::::', {
      surfaceId: 'status-chip', engineField: 'cellarOrganised',
      scope: null, key: null, value: true, sourceUrl: '/api/cellar',
      receivedAt: '2026-05-20T00:00:00Z',
    });
    const got = s.findFor('status-chip', 'cellarOrganised', null, null);
    assert.ok(got);
    assert.equal(got.value, true);
  });

  it('latest-wins on upsert with same key', () => {
    const s = createNetworkGroundTruthStore({ cap: 4 });
    const k = 'x::y::::';
    s.upsert(k, { value: 1, surfaceId: 'x', engineField: 'y' });
    s.upsert(k, { value: 2, surfaceId: 'x', engineField: 'y' });
    assert.equal(s.findFor('x', 'y', null, null).value, 2);
    assert.equal(s.size(), 1);
  });

  it('LRU evicts the oldest entry when cap is hit', () => {
    const s = createNetworkGroundTruthStore({ cap: 2 });
    s.upsert('a::f::::', { value: 1 });
    s.upsert('b::f::::', { value: 2 });
    s.upsert('c::f::::', { value: 3 });   // evicts 'a'
    assert.equal(s.size(), 2);
    assert.equal(s.findFor('a', 'f', null, null), null);
    assert.equal(s.findFor('c', 'f', null, null).value, 3);
    assert.equal(s.evictedCount(), 1);
    assert.equal(s.isFull(), true);
  });

  it('LRU refreshes a re-upserted entry to most-recent', () => {
    const s = createNetworkGroundTruthStore({ cap: 2 });
    s.upsert('a::f::::', { value: 1 });
    s.upsert('b::f::::', { value: 2 });
    s.upsert('a::f::::', { value: 11 });   // refreshes 'a'
    s.upsert('c::f::::', { value: 3 });    // evicts 'b' (now oldest), not 'a'
    assert.equal(s.findFor('a', 'f', null, null).value, 11);
    assert.equal(s.findFor('b', 'f', null, null), null);
    assert.equal(s.findFor('c', 'f', null, null).value, 3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// matchResponseAgainstManifest
// ────────────────────────────────────────────────────────────────────────────

const SINGLETON_MANIFEST = {
  version: 1,
  collections: [],
  surfaces: [{
    id: 'status-chip',
    locator: { kind: 'role', role: 'status' },
    severityFloor: 'P0',
    engineFields: [{
      field: 'cellarOrganised',
      type: 'boolean',
      llmSafe: false, llmMaxChars: 2000,
      networkSource: { urlPattern: '/api/cellar', jsonPath: 'cellarOrganised' },
    }],
  }],
};

const COLLECTION_MANIFEST = {
  version: 1,
  collections: [{
    id: 'wines-grid', urlPattern: '/api/cellar', jsonPath: 'wines', keyField: 'id',
  }],
  surfaces: [{
    id: 'wine-row',
    scope: 'wines-grid',
    locator: { kind: 'css', selector: '.wine-row', warn: false },
    severityFloor: 'P1',
    engineFields: [{
      field: 'wines[].vintage',
      type: 'integer',
      llmSafe: false, llmMaxChars: 2000,
      networkSource: { urlPattern: '/api/cellar', jsonPath: 'wines[].vintage' },
    }],
  }],
};

describe('matchResponseAgainstManifest', () => {
  it('skips non-2xx responses', async () => {
    const r = fakeResponse({ url: '/api/cellar', status: 500, body: {} });
    const out = await matchResponseAgainstManifest(r, SINGLETON_MANIFEST);
    assert.deepEqual(out, []);
  });

  it('extracts a singleton value from a matching URL', async () => {
    const r = fakeResponse({ url: '/api/cellar?x=1', body: { cellarOrganised: false } });
    const out = await matchResponseAgainstManifest(r, SINGLETON_MANIFEST);
    assert.equal(out.length, 1);
    assert.equal(out[0].entry.surfaceId, 'status-chip');
    assert.equal(out[0].entry.value, false);
  });

  it('returns nothing when method does not match the manifest', async () => {
    const m = JSON.parse(JSON.stringify(SINGLETON_MANIFEST));
    m.surfaces[0].engineFields[0].networkSource.method = 'POST';
    const r = fakeResponse({ url: '/api/cellar', method: 'GET', body: { cellarOrganised: true } });
    const out = await matchResponseAgainstManifest(r, m);
    assert.deepEqual(out, []);
  });

  it('respects excludeUrlPattern (Gemini-R6-G3 path-filter)', async () => {
    const m = JSON.parse(JSON.stringify(SINGLETON_MANIFEST));
    m.surfaces[0].engineFields[0].networkSource.excludeUrlPattern = '/mock';
    const r = fakeResponse({ url: '/api/cellar/mock', body: { cellarOrganised: true } });
    const out = await matchResponseAgainstManifest(r, m);
    assert.deepEqual(out, []);
  });

  it('respects operationName for GraphQL bodies', async () => {
    const m = JSON.parse(JSON.stringify(SINGLETON_MANIFEST));
    m.surfaces[0].engineFields[0].networkSource.urlPattern    = '/graphql';
    m.surfaces[0].engineFields[0].networkSource.method        = 'POST';
    m.surfaces[0].engineFields[0].networkSource.operationName = 'GetCellar';

    const matching = fakeResponse({
      url: '/graphql', method: 'POST',
      operationName: 'GetCellar', body: { cellarOrganised: true },
    });
    const mismatched = fakeResponse({
      url: '/graphql', method: 'POST',
      operationName: 'GetOther', body: { cellarOrganised: true },
    });
    assert.equal((await matchResponseAgainstManifest(matching, m)).length, 1);
    assert.equal((await matchResponseAgainstManifest(mismatched, m)).length, 0);
  });

  it('walks a collection and emits one entry per row', async () => {
    const r = fakeResponse({
      url: '/api/cellar',
      body: { wines: [
        { id: 'A', vintage: 2020 },
        { id: 'B', vintage: 2021 },
        { id: 'C', vintage: 2019 },
      ]},
    });
    const out = await matchResponseAgainstManifest(r, COLLECTION_MANIFEST);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((o) => o.entry.key).sort(), ['A', 'B', 'C']);
    const a = out.find((o) => o.entry.key === 'A');
    assert.equal(a.entry.value, 2020);
    assert.equal(a.entry.scope, 'wines-grid');
  });

  it('skips collection rows without the keyField', async () => {
    const r = fakeResponse({
      url: '/api/cellar',
      body: { wines: [{ id: 'A', vintage: 2020 }, { vintage: 2021 /* no id */ }] },
    });
    const out = await matchResponseAgainstManifest(r, COLLECTION_MANIFEST);
    assert.equal(out.length, 1);
    assert.equal(out[0].entry.key, 'A');
  });

  it('survives a body that is not valid JSON (returns empty)', async () => {
    const r = {
      url: () => '/api/cellar',
      status: () => 200,
      request: () => ({ method: () => 'GET', postData: () => null }),
      json: async () => { throw new Error('not json'); },
    };
    const out = await matchResponseAgainstManifest(r, SINGLETON_MANIFEST);
    assert.deepEqual(out, []);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// attachNetworkListener
// ────────────────────────────────────────────────────────────────────────────

describe('attachNetworkListener', () => {
  it('upserts matching responses into the store', async () => {
    const page = createFakePage();
    const sink = errorSink();
    const { store, removeListener } = attachNetworkListener(page, SINGLETON_MANIFEST, sink.opts);
    await page.fireResponse(fakeResponse({ url: '/api/cellar', body: { cellarOrganised: true } }));
    const got = store.findFor('status-chip', 'cellarOrganised', null, null);
    assert.ok(got);
    assert.equal(got.value, true);
    removeListener();
  });

  it('routes listener errors to onError instead of throwing', async () => {
    const page = createFakePage();
    let errSeen = null;
    const { } = attachNetworkListener(page, SINGLETON_MANIFEST, {
      onError: (e) => { errSeen = e; },
    });
    // Send a response whose json() blows up — the handler must catch.
    const blowUpResponse = {
      url: () => '/api/cellar', status: () => 200,
      request: () => ({ method: () => 'GET', postData: () => null }),
      json: async () => { throw new Error('boom'); },
    };
    await page.fireResponse(blowUpResponse);
    // No throw escaped — that's the assertion. errSeen may be null because
    // matchResponseAgainstManifest itself catches the throw; either way
    // the listener didn't break.
    assert.ok(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// stabiliseDom
// ────────────────────────────────────────────────────────────────────────────

describe('stabiliseDom', () => {
  it('returns stabilised=true after two consecutive identical polls', async () => {
    // Tick 0 returns "v1"; tick 1 also returns "v1" → stable.
    const page = createFakePage({ evalScript: () => 'v1' });
    const r = await stabiliseDom(page, { pollMs: 1, capMs: 200 });
    assert.equal(r.stabilised, true);
    assert.ok(r.ticks >= 2);
  });

  it('emits the cap-reached warning when DOM keeps changing', async () => {
    let i = 0;
    const page = createFakePage({ evalScript: () => `v${i++}` });
    let warned = null;
    const r = await stabiliseDom(page, { pollMs: 1, capMs: 25, warn: (w) => { warned = w; } });
    assert.equal(r.stabilised, false);
    assert.ok(warned);
    assert.equal(warned.kind, 'dom-stabilisation-cap-reached');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// extractDomClaims
// ────────────────────────────────────────────────────────────────────────────

describe('extractDomClaims', () => {
  it('declared engineField → domClaims; undeclared → undeclaredDomClaims', async () => {
    const rawClaims = [
      {
        engineField: 'cellarOrganised', domValueRaw: 'true',
        freshness: 'current', scope: null, key: null, visible: true,
        selector: 'body > div#root > span.chip',
      },
      {
        engineField: 'bogus.field', domValueRaw: 'x',
        freshness: 'current', scope: null, key: null, visible: true,
        selector: 'body > div#root > i.mystery',
      },
    ];
    const page = createFakePage({ evalScript: () => rawClaims });
    const r = await extractDomClaims(page, SINGLETON_MANIFEST);
    assert.equal(r.domClaims.length, 1);
    assert.equal(r.domClaims[0].surfaceId, 'status-chip');
    assert.equal(r.undeclaredDomClaims.length, 1);
    assert.equal(r.undeclaredDomClaims[0].engineField, 'bogus.field');
  });

  it('threads visible + scope + key through to domClaims', async () => {
    const rawClaims = [{
      engineField: 'wines[].vintage', domValueRaw: '2020',
      freshness: 'current', scope: 'wines-grid', key: 'A', visible: false,
      selector: '.wine-row',
    }];
    const page = createFakePage({ evalScript: () => rawClaims });
    const r = await extractDomClaims(page, COLLECTION_MANIFEST);
    assert.equal(r.domClaims.length, 1);
    assert.equal(r.domClaims[0].surfaceId, 'wine-row');
    assert.equal(r.domClaims[0].scope, 'wines-grid');
    assert.equal(r.domClaims[0].key, 'A');
    assert.equal(r.domClaims[0].visible, false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// captureWitness — integration
// ────────────────────────────────────────────────────────────────────────────

describe('captureWitness', () => {
  it('assembles a witness from DOM + cumulative store', async () => {
    const page = createFakePage({
      evalScript: (tick) => {
        // First tick: stabilisation hash. After stable, extractDomClaims runs
        // a separate evaluate. Both go through evalScript, distinguished by
        // tick count (0 then 1 stabilise, 2 = extract).
        if (tick < 2) return 'sig';
        return [{
          engineField: 'cellarOrganised', domValueRaw: 'true',
          freshness: 'current', scope: null, key: null, visible: true,
          selector: '.chip',
        }];
      },
    });
    const sink = errorSink();
    const { store, removeListener } = attachNetworkListener(page, SINGLETON_MANIFEST, sink.opts);
    await page.fireResponse(fakeResponse({ url: '/api/cellar', body: { cellarOrganised: true } }));
    // capMs must comfortably fit the two stabilisation evaluate() ticks plus the
    // setTimeout between them. At capMs:10 a loaded machine aborted the loop
    // after ONE tick, which desynchronised this fake's tick counter (extract
    // then ran as tick 1 and returned the signature string instead of claims) —
    // a ~12% flake, and a flaky gate is exactly what produces false blocks.
    // Stabilisation still returns as soon as two signatures match, so the
    // headroom costs nothing.
    const witness = await captureWitness(page, SINGLETON_MANIFEST, { store }, { pollMs: 1, capMs: 2000, stepIndex: 3 });
    sink.assertClean();
    assert.equal(witness.stepIndex, 3);
    assert.equal(witness.domClaims.length, 1);
    assert.equal(witness.networkClaims.length, 1);
    assert.equal(witness.partialCapture, false);
    removeListener();
  });

  it('sets partialCapture=true when DOM has a claim with no network entry', async () => {
    const page = createFakePage({
      evalScript: (tick) => {
        if (tick < 2) return 'sig';
        return [{
          engineField: 'cellarOrganised', domValueRaw: 'true',
          freshness: 'current', scope: null, key: null, visible: true,
          selector: '.chip',
        }];
      },
    });
    const sink = errorSink();
    const { store } = attachNetworkListener(page, SINGLETON_MANIFEST, sink.opts);
    // Never fire a response → store is empty. The sink still guards the DOM
    // side: partialCapture must come from "nothing fired", not a swallowed throw.
    const witness = await captureWitness(page, SINGLETON_MANIFEST, { store }, { pollMs: 1, capMs: 2000 });
    sink.assertClean();
    assert.equal(witness.domClaims.length, 1, 'extract should have produced one DOM claim');
    assert.equal(witness.networkClaims.length, 0);
    assert.equal(witness.partialCapture, true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// _internals: resolveJsonPath, regexMatch, stripCollectionPrefix
// ────────────────────────────────────────────────────────────────────────────

describe('_internals', () => {
  it('resolveJsonPath walks dotted paths', () => {
    const { resolveJsonPath } = _internals;
    assert.equal(resolveJsonPath({a: {b: 42}}, 'a.b'), 42);
    assert.equal(resolveJsonPath({a: {b: 42}}, 'a.c'), undefined);
    assert.equal(resolveJsonPath(null, 'a'),           undefined);
    assert.equal(resolveJsonPath({a: {b: 42}}, ''),    undefined);
  });
  it('regexMatch returns false on invalid pattern', () => {
    const { regexMatch } = _internals;
    assert.equal(regexMatch('valid', 'validating'), true);
    assert.equal(regexMatch('(', 'invalid'), false);    // bad regex
    assert.equal(regexMatch('', 'x'), false);
  });
  it('stripCollectionPrefix removes [].', () => {
    const { stripCollectionPrefix } = _internals;
    assert.equal(stripCollectionPrefix('wines[].vintage', 'wines'), 'vintage');
    assert.equal(stripCollectionPrefix('wines[].nested.field', 'wines'), 'nested.field');
    assert.equal(stripCollectionPrefix('no-marker', 'wines'), 'no-marker');
  });
});
