/**
 * @fileoverview Cluster B / Phase 4 — verified-candidate selection + typed probe.
 * All injected-client, no network. Covers the catalog-lies case (the whole reason
 * we probe), the H5 typed outcomes (only unknown_model advances), first-verified
 * wins (H11), and a bounded probe budget.
 */
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeDeployment, listEmbeddingCandidates, selectEmbedDeployment, ProbeOutcome, STATIC_EMBED_CANDIDATES,
} from '../scripts/lib/azure/embed-discovery.mjs';

/** Build a fake client whose embeddings.create succeeds for `deployed`, 400s otherwise. */
function fakeClient({ deployed = [], catalog = null, failWith = null } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    embeddings: {
      create: async ({ model }) => {
        calls++;
        if (failWith && failWith[model]) throw failWith[model];
        if (deployed.includes(model)) return { data: [{ embedding: [0.1] }] };
        const err = new Error(`Unknown model: ${model}`);
        err.status = 400; err.code = 'unknown_model';
        throw err;
      },
    },
    models: { list: async () => (catalog === null ? { data: [] } : { data: catalog }) },
  };
}

const err = (status, code, message) => Object.assign(new Error(message || code), { status, code });

describe('probeDeployment — "verified" must mean "usable"', () => {
  // The probe used to call embeddings.create WITHOUT `dimensions`, while every
  // real embedText call sends it. So a deployment could pass the probe, get
  // locked into .env by `azure:doctor --fix`, and then fail on every actual
  // embedding — a green check that never checked the thing that matters.

  it('sends the same `dimensions` the runtime sends', async () => {
    let seen = null;
    const client = {
      embeddings: { create: async (args) => { seen = args; return { data: [{ embedding: [0.1] }] }; } },
      models: { list: async () => ({ data: [] }) },
    };
    await probeDeployment(client, 'text-embedding-3-large');
    assert.ok(seen, 'probe must call embeddings.create');
    assert.equal(typeof seen.dimensions, 'number');
    assert.ok(seen.dimensions > 0, 'dimensions must be a positive integer');
  });

  it('a deployment that REJECTS dimensions advances the ladder, not halts it', async () => {
    // ada-002 exists but has a fixed 1536 vector and refuses `dimensions`.
    // Classifying that as a terminal transient failure would stop discovery in
    // front of a perfectly good candidate behind it.
    const err = new Error("Unsupported parameter: 'dimensions' is not supported with this model.");
    err.status = 400;
    const r = await probeDeployment({
      embeddings: { create: async () => { throw err; } },
      models: { list: async () => ({ data: [] }) },
    }, 'text-embedding-ada-002');
    assert.equal(r.outcome, ProbeOutcome.UNSUPPORTED);
  });

  it('a BARE 400 with no explicit signal stays terminal', async () => {
    // The module's discipline: advancing without an explicit signal would
    // repoint the vector space to hide a malformed-request or gateway fault.
    const err = new Error('Bad Request');
    err.status = 400;
    const r = await probeDeployment({
      embeddings: { create: async () => { throw err; } },
      models: { list: async () => ({ data: [] }) },
    }, 'whatever');
    assert.equal(r.outcome, ProbeOutcome.UNVERIFIED);
  });
});

describe('probeDeployment — typed outcome (H5)', () => {
  test('200 → verified', async () => {
    const r = await probeDeployment(fakeClient({ deployed: ['e'] }), 'e');
    assert.equal(r.outcome, ProbeOutcome.VERIFIED);
  });
  test('400 unknown_model → unsupported (advances)', async () => {
    const r = await probeDeployment(fakeClient({ deployed: [] }), 'nope');
    assert.equal(r.outcome, ProbeOutcome.UNSUPPORTED);
  });
  test('404 DeploymentNotFound → unsupported', async () => {
    const c = { embeddings: { create: async () => { throw err(404, 'DeploymentNotFound', 'not found'); } } };
    assert.equal((await probeDeployment(c, 'x')).outcome, ProbeOutcome.UNSUPPORTED);
  });
  test('401 auth → unverified (terminal, does NOT advance)', async () => {
    const c = { embeddings: { create: async () => { throw err(401, 'Unauthorized'); } } };
    assert.equal((await probeDeployment(c, 'x')).outcome, ProbeOutcome.UNVERIFIED);
  });
  test('429 throttle → unverified', async () => {
    const c = { embeddings: { create: async () => { throw err(429, 'rate_limited'); } } };
    assert.equal((await probeDeployment(c, 'x')).outcome, ProbeOutcome.UNVERIFIED);
  });
  test('500 server → unverified', async () => {
    const c = { embeddings: { create: async () => { throw err(500, 'server_error'); } } };
    assert.equal((await probeDeployment(c, 'x')).outcome, ProbeOutcome.UNVERIFIED);
  });
  test('network timeout (no status) → unverified', async () => {
    const c = { embeddings: { create: async () => { throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }); } } };
    assert.equal((await probeDeployment(c, 'x')).outcome, ProbeOutcome.UNVERIFIED);
  });
  test('BARE 404 (no deployment-not-found signal) → unverified, does NOT advance (H4/H5)', async () => {
    // A 404 from a wrong endpoint / bad route / proxy must NOT be read as proof
    // the deployment is missing, or the ladder would "verify" a different one.
    const c = { embeddings: { create: async () => { throw err(404, 'NotFound', 'Resource not found'); } } };
    assert.equal((await probeDeployment(c, 'x')).outcome, ProbeOutcome.UNVERIFIED);
  });
  test('404 WITH DeploymentNotFound code → unsupported (advances)', async () => {
    const c = { embeddings: { create: async () => { throw err(404, 'DeploymentNotFound', 'The API deployment for this resource does not exist'); } } };
    assert.equal((await probeDeployment(c, 'x')).outcome, ProbeOutcome.UNSUPPORTED);
  });
});

describe('listEmbeddingCandidates — catalog is a hint, degrades to static', () => {
  test('filters embeddings-capable + GA from the catalog', async () => {
    const c = fakeClient({ catalog: [
      { id: 'text-embedding-3-large', capabilities: { embeddings: true }, lifecycle_status: 'generally-available' },
      { id: 'gpt-5.5', capabilities: { embeddings: false }, lifecycle_status: 'generally-available' },
      { id: 'text-similarity-old', capabilities: { embeddings: true }, lifecycle_status: 'deprecated' },
    ] });
    const r = await listEmbeddingCandidates(c);
    assert.equal(r.source, 'catalog');
    assert.deepEqual(r.names, ['text-embedding-3-large']);
  });
  test('empty / errored catalog → static fallback', async () => {
    assert.deepEqual((await listEmbeddingCandidates(fakeClient({ catalog: null }))).names, [...STATIC_EMBED_CANDIDATES]);
    const boom = { models: { list: async () => { throw new Error('no route'); } } };
    assert.equal((await listEmbeddingCandidates(boom)).source, 'static');
  });
});

describe('selectEmbedDeployment — ordered probe, first-verified wins', () => {
  test('configured wins with a single probe (no ladder walk)', async () => {
    const c = fakeClient({ deployed: ['text-embedding-3-large'] });
    const r = await selectEmbedDeployment({ configured: 'text-embedding-3-large', client: c });
    assert.equal(r.status, 'verified');
    assert.equal(r.selected, 'text-embedding-3-large');
    assert.equal(c.calls(), 1, 'stops at the first verified candidate');
  });

  test('THE CATALOG-LIES CASE: catalog lists 3-small GA, but only -large answers', async () => {
    // The exact live-observed situation. configured (3-small) 400s; the ladder
    // continues through the catalog to -large, which verifies.
    const c = fakeClient({
      deployed: ['text-embedding-3-large'],
      catalog: [
        { id: 'text-embedding-3-small', capabilities: { embeddings: true }, lifecycle_status: 'generally-available' },
        { id: 'text-embedding-3-large', capabilities: { embeddings: true }, lifecycle_status: 'generally-available' },
      ],
    });
    const r = await selectEmbedDeployment({ configured: 'text-embedding-3-small', client: c });
    assert.equal(r.status, 'verified');
    assert.equal(r.selected, 'text-embedding-3-large');
  });

  test('user --candidate is tried before the catalog (custom deployment names)', async () => {
    const c = fakeClient({ deployed: ['team-a-embed-prod'] });
    const r = await selectEmbedDeployment({ configured: 'text-embedding-3-small', userCandidates: ['team-a-embed-prod'], client: c });
    assert.equal(r.selected, 'team-a-embed-prod');
  });

  test('a terminal unverified stops the ladder — no replacement offered (H5)', async () => {
    const c = fakeClient({ deployed: [], failWith: { 'text-embedding-3-small': err(429, 'rate_limited') } });
    const r = await selectEmbedDeployment({ configured: 'text-embedding-3-small', client: c });
    assert.equal(r.status, 'unverified');
    assert.equal(r.selected, null);
  });

  test('all candidates unsupported → none-found (never claims "no deployment exists")', async () => {
    const c = fakeClient({ deployed: [], catalog: null });
    const r = await selectEmbedDeployment({ configured: 'nope', client: c });
    assert.equal(r.status, 'none-found');
    assert.equal(r.selected, null);
  });

  test('probe budget is bounded (never probes more than maxProbes)', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `text-embedding-${i}`, capabilities: { embeddings: true }, lifecycle_status: 'generally-available' }));
    const c = fakeClient({ deployed: [], catalog: many });
    await selectEmbedDeployment({ configured: 'cfg', client: c, maxProbes: 6 });
    assert.ok(c.calls() <= 6, `probed ${c.calls()} times, expected <= 6`);
  });
});
