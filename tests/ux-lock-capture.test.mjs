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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

// ────────────────────────────────────────────────────────────────────────────
// Collection binding shapes + the loud skip — upstream a0b58a34 (HIGH).
//
// The rig could only bind a collection when the body carried a NAMED ARRAY
// property, and both other common REST shapes failed SILENTLY. In the reporting
// consumer a surface declared a per-row assertion that had never executed; the
// manifest read as enforced coverage for months, because a skipped binding and
// a passing one both produce zero findings. That is the "green having done
// nothing" class, inside the rig built to catch it.
// ────────────────────────────────────────────────────────────────────────────

/** COLLECTION_MANIFEST with the binding + field paths swapped out. */
const collectionManifest = ({ jsonPath, keyField = 'id', field }) => ({
  version: 1,
  collections: [{ id: 'wines-grid', urlPattern: '/api/cellar', jsonPath, keyField }],
  surfaces: [{
    id: 'wine-row',
    scope: 'wines-grid',
    locator: { kind: 'css', selector: '.wine-row', warn: false },
    severityFloor: 'P1',
    engineFields: [{
      field, type: 'integer', llmSafe: false, llmMaxChars: 2000,
      networkSource: { urlPattern: '/api/cellar', jsonPath: field },
    }],
  }],
});

describe('collection bindings — object maps, root arrays, and a loud skip', () => {
  it('binds an object map keyed by entity id, taking identity from the row', async () => {
    // Shape (1) from the report: {"R1": {...}, "R2": {...}}.
    const r = fakeResponse({
      url: '/api/cellar',
      body: { wines: { R1: { id: 'A', vintage: 2011 }, R2: { id: 'B', vintage: 2012 } } },
    });
    const out = await matchResponseAgainstManifest(
      r, collectionManifest({ jsonPath: 'wines', field: 'wines[].vintage' }));
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((o) => o.entry.key).sort(), ['A', 'B']);
    assert.equal(out.find((o) => o.entry.key === 'A').entry.value, 2011);
  });

  it('keyField "$key" identifies a map row by the map own key', async () => {
    // The case Object.values() alone cannot serve: the id is the KEY and does
    // not appear in the value, so every row would otherwise be unkeyed.
    const r = fakeResponse({
      url: '/api/cellar',
      body: { wines: { R1: { vintage: 2011 }, R2: { vintage: 2012 } } },
    });
    const out = await matchResponseAgainstManifest(
      r, collectionManifest({ jsonPath: 'wines', keyField: '$key', field: 'wines[].vintage' }));
    assert.deepEqual(out.map((o) => o.entry.key).sort(), ['R1', 'R2']);
    assert.equal(out.find((o) => o.entry.key === 'R1').entry.value, 2011);
  });

  it('binds a TOP-LEVEL array via the "$" root sentinel', async () => {
    // Shape (2): the document root was unaddressable from both directions —
    // z.string().min(1) rejects "", and resolveJsonPath returned undefined for it.
    const r = fakeResponse({
      url: '/api/cellar',
      body: [{ id: 'A', vintage: 2011 }, { id: 'B', vintage: 2012 }],
    });
    const out = await matchResponseAgainstManifest(
      r, collectionManifest({ jsonPath: '$', field: '$[].vintage' }));
    assert.deepEqual(out.map((o) => o.entry.key).sort(), ['A', 'B']);
    assert.equal(out.find((o) => o.entry.key === 'B').entry.value, 2012);
  });

  it('binds a top-level object MAP via "$" too', async () => {
    const r = fakeResponse({ url: '/api/cellar', body: { R1: { vintage: 2011 } } });
    const out = await matchResponseAgainstManifest(
      r, collectionManifest({ jsonPath: '$', keyField: '$key', field: '$[].vintage' }));
    assert.equal(out.length, 1);
    assert.equal(out[0].entry.key, 'R1');
  });

  it('a named array still binds exactly as before (no-regression control)', async () => {
    // Guards the fix itself: if the array path had broken, every assertion
    // above could pass while the shape everyone actually uses stopped working.
    const r = fakeResponse({
      url: '/api/cellar', body: { wines: [{ id: 'A', vintage: 2011 }] },
    });
    const out = await matchResponseAgainstManifest(r, COLLECTION_MANIFEST);
    assert.equal(out.length, 1);
    assert.equal(out[0].entry.key, 'A');
  });

  for (const [label, body, reason] of [
    ['an absent path', { somethingElse: [] }, /did not resolve/],
    ['a scalar', { wines: 7 }, /scalar/],
    ['a null', { wines: null }, /did not resolve|scalar/],
  ]) {
    it(`warns instead of skipping silently when the binding resolves to ${label}`, async () => {
      const warnings = [];
      const r = fakeResponse({ url: '/api/cellar', body });
      const out = await matchResponseAgainstManifest(
        r, collectionManifest({ jsonPath: 'wines', field: 'wines[].vintage' }),
        { warn: (w) => warnings.push(w) });
      assert.deepEqual(out, [], 'still produces no ground truth');
      assert.equal(warnings.length, 1, 'but says so — a silent skip is the defect');
      assert.equal(warnings[0].kind, 'collection-binding-unusable');
      assert.equal(warnings[0].surfaceId, 'wine-row');
      assert.match(warnings[0].detail, reason);
      assert.match(warnings[0].detail, /wines-grid/, 'names the binding to fix');
    });
  }

  it('refuses "$key" on an ARRAY rather than falling back to the index', async () => {
    // An index is positional: any reordering silently re-identifies every row.
    // Refusing loudly beats a plausible-looking wrong key.
    const warnings = [];
    const r = fakeResponse({ url: '/api/cellar', body: { wines: [{ vintage: 2011 }] } });
    const out = await matchResponseAgainstManifest(
      r, collectionManifest({ jsonPath: 'wines', keyField: '$key', field: 'wines[].vintage' }),
      { warn: (w) => warnings.push(w) });
    assert.deepEqual(out, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].detail, /positional/);
  });

  it('does NOT warn on a legitimately empty collection', async () => {
    // The boundary that keeps the new signal from becoming noise: an empty
    // array/map is the normal quiet-page case, not a broken binding.
    for (const body of [{ wines: [] }, { wines: {} }]) {
      const warnings = [];
      const out = await matchResponseAgainstManifest(
        fakeResponse({ url: '/api/cellar', body }),
        collectionManifest({ jsonPath: 'wines', field: 'wines[].vintage' }),
        { warn: (w) => warnings.push(w) });
      assert.deepEqual(out, []);
      assert.deepEqual(warnings, [], 'an empty collection must stay silent');
    }
  });

  it('omitting the warn sink still works (it is optional, not required)', async () => {
    const out = await matchResponseAgainstManifest(
      fakeResponse({ url: '/api/cellar', body: { wines: 7 } }),
      collectionManifest({ jsonPath: 'wines', field: 'wines[].vintage' }));
    assert.deepEqual(out, []);
  });

  it('the new warning kind is in the schema enum, or the ledger would reject it', async () => {
    const { RigWarningSchema } = await import('../scripts/lib/persona-test/schemas.mjs');
    const parsed = RigWarningSchema.safeParse({
      kind: 'collection-binding-unusable', surfaceId: 'wine-row', detail: 'x',
    });
    assert.ok(parsed.success, 'emitting a kind the schema rejects would drop the warning downstream');
  });
});

describe('attachNetworkListener — an unusable binding must not storm the journey', () => {
  const unusable = {
    version: 1,
    collections: [{ id: 'wines-grid', urlPattern: '/api/cellar', jsonPath: 'wines', keyField: 'id' }],
    surfaces: [{
      id: 'wine-row',
      scope: 'wines-grid',
      locator: { kind: 'css', selector: '.wine-row', warn: false },
      severityFloor: 'P1',
      engineFields: [{
        field: 'wines[].vintage', type: 'integer', llmSafe: false, llmMaxChars: 2000,
        networkSource: { urlPattern: '/api/cellar', jsonPath: 'wines[].vintage' },
      }],
    }],
  };

  it('warns ONCE across many matching responses, not once per response', async () => {
    // An unusable binding is a property of the MANIFEST, so it is wrong on
    // every matching response. Emitting each time turns one manifest defect
    // into a per-request storm and buries the signal it exists to raise —
    // making the fix for a silent failure into a loud useless one.
    const page = createFakePage();
    const warnings = [];
    attachNetworkListener(page, unusable, { warn: (w) => warnings.push(w) });

    for (let i = 0; i < 5; i++) {
      await page.fireResponse(fakeResponse({ url: `/api/cellar?page=${i}`, body: { wines: 7 } }));
    }

    assert.equal(warnings.length, 1, `expected 1 warning across 5 responses, got ${warnings.length}`);
    assert.equal(warnings[0].kind, 'collection-binding-unusable');
    // Dedup keys on the detail, so the detail must not carry the URL — five
    // distinct URLs above would otherwise be five distinct "unique" warnings.
    assert.ok(!/page=/.test(warnings[0].detail),
      'detail must stay stable per binding, or the dedup key varies per request');
  });

  it('a throwing warn sink does not take the capture down with it', async () => {
    // The sink is operator-supplied. Losing a warning is bad; losing the
    // ground-truth capture because a warning handler threw is worse.
    const page = createFakePage();
    attachNetworkListener(page, unusable, { warn: () => { throw new Error('sink exploded'); } });
    await page.fireResponse(fakeResponse({ url: '/api/cellar', body: { wines: 7 } }));

    const good = createFakePage();
    const { store } = attachNetworkListener(good, COLLECTION_MANIFEST, {
      warn: () => { throw new Error('sink exploded'); },
    });
    await good.fireResponse(fakeResponse({ url: '/api/cellar', body: { wines: [{ id: 'A', vintage: 2011 }] } }));
    assert.equal(store.size(), 1, 'ground truth must still be captured');
  });

  it('omitting warn keeps the listener working (opts.warn is optional)', async () => {
    const page = createFakePage();
    const { store } = attachNetworkListener(page, COLLECTION_MANIFEST);
    await page.fireResponse(fakeResponse({ url: '/api/cellar', body: { wines: [{ id: 'A', vintage: 2011 }] } }));
    assert.equal(store.size(), 1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WIRING — the half a unit test cannot see.
//
// `matchResponseAgainstManifest` can detect an unusable binding perfectly and
// the run still say nothing, if the runner attaches the listener without a warn
// sink or never drains the buffer. That is the exact shape recorded in
// AGENTS.md for the gate-honesty contract: enforcement that was asserted, unit-
// tested, and reached by nothing in production. Source-level because the drain
// sits inside a browser-driving loop no hermetic fixture can run.
// ────────────────────────────────────────────────────────────────────────────

describe('persona-consistency-run wires the binding warning to the ledger', () => {
  const runnerSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts', 'persona-consistency-run.mjs'), 'utf-8');

  it('attaches the listener WITH a warn sink, not bare', () => {
    const call = runnerSrc.slice(runnerSrc.indexOf('attachNetworkListener(page'));
    assert.ok(call.length > 0, 'anchor missing — this test is stale');
    const head = call.slice(0, 220);
    assert.match(head, /warn:/,
      'attachNetworkListener must receive a warn sink, or every collection-binding '
      + 'warning is discarded and the silent skip is back');
  });

  it('drains the buffer into a step, or the warnings never reach the ledger', () => {
    assert.match(runnerSrc, /bindingWarnings\.splice\(0\)/,
      'the session buffer must be drained into a step warnings array');
    // Ordering is the contract: draining must happen BEFORE stepWarnings is
    // assembled, else the push lands in an array already copied and is lost.
    const iDrain = runnerSrc.indexOf('bindingWarnings.splice(0)');
    const iAssemble = runnerSrc.indexOf('const stepWarnings =');
    assert.ok(iDrain > -1 && iAssemble > -1, 'both anchors must exist');
    assert.ok(iDrain < iAssemble,
      'the drain must precede stepWarnings assembly, or the warning is computed away');
  });

  it('drains with splice, not a copy — a session-deduped warning must not repeat per step', () => {
    // The listener dedupes for the whole session, so a non-emptying read would
    // re-emit the same warning on every subsequent step: one manifest defect
    // rendered as N findings, which is the storm the dedup exists to prevent.
    assert.ok(!/warnings\.push\(\.\.\.bindingWarnings\)/.test(runnerSrc),
      'a non-emptying drain re-emits the same warning on every later step');
  });
});
