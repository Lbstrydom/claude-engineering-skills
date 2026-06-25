/**
 * Cluster A — contract + schema (plan §4a.A/D/G).
 * Tier-1 deterministic seam: schema validation, navMeta grammar, bootstrap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NavContractSchema,
  NavObservedSchema,
  computeContractDigest,
  computeConfigDigest,
} from '../scripts/lib/nav/schema.mjs';
import { parseNavMeta, isUtilityRoute, bootstrapContract } from '../scripts/lib/nav/contract.mjs';
import { assembleEnvelope } from '../scripts/lib/nav/envelope.mjs';

describe('nav schema', () => {
  it('validates a minimal contract', () => {
    const r = NavContractSchema.safeParse({ version: 1, navLayers: {}, personas: [] });
    assert.ok(r.success);
  });

  it('applies intent defaults (frequency=normal, source=declared)', () => {
    const r = NavContractSchema.parse({
      version: 1,
      personas: [{ id: 'admin', intents: [{ id: 'revoke', destination: '/admin/users/:param' }] }],
    });
    assert.equal(r.personas[0].intents[0].frequency, 'normal');
    assert.equal(r.personas[0].intents[0].source, 'declared');
    assert.equal(r.personas[0].intents[0].requiredInLayer, null);
  });

  it('contract digest is stable across key ordering', () => {
    const a = { version: 1, navLayers: { primary: ['B', 'A'] }, personas: [] };
    const b = { version: 1, navLayers: { primary: ['A', 'B'] }, personas: [] };
    assert.equal(computeContractDigest(a), computeContractDigest(b));
  });

  it('strict schema rejects a typo\'d contract key (audit M14)', () => {
    const r = NavContractSchema.safeParse({
      version: 1,
      personas: [{ id: 'a', intents: [{ id: 'i', destination: '/x', approvedAnchor: ['Side'] }] }],
    });
    assert.equal(r.success, false); // approvedAnchor (typo) must fail, not be stripped
  });

  it('contract digest changes when an intent source flips inferred→declared (audit H7)', () => {
    const base = { version: 1, personas: [{ id: 'a', intents: [{ id: 'i', destination: '/x', source: 'inferred' }] }] };
    const confirmed = { version: 1, personas: [{ id: 'a', intents: [{ id: 'i', destination: '/x', source: 'declared' }] }] };
    assert.notEqual(computeContractDigest(base), computeContractDigest(confirmed));
  });

  it('config digest excludes source shas (Gemini-2-H) — only contract + version', () => {
    const cd = computeContractDigest({ version: 1, personas: [] });
    const d1 = computeConfigDigest({ contractDigest: cd });
    const d2 = computeConfigDigest({ contractDigest: cd, adapterVersion: 1 });
    assert.equal(d1, d2);
    assert.match(d1, /^[0-9a-f]{64}$/);
  });

  it('envelope round-trips through NavObservedSchema + persists destinations (audit R2-H4)', () => {
    const env = assembleEnvelope({
      refreshId: 'r1',
      contractDigest: computeContractDigest({ version: 1, personas: [] }),
      headSha: 'abc123',
      generatedAt: '2026-06-25T10:00:00.000Z',
      edges: [],
      destinations: [{ id: '/wines' }, { id: '/oauth/callback' }],
    });
    const r = NavObservedSchema.safeParse(env);
    assert.ok(r.success, r.success ? '' : JSON.stringify(r.error?.issues));
    assert.equal(r.data.destinations.length, 2);
  });
});

describe('navMeta parsing', () => {
  it('parses an export const navMeta object literal', () => {
    const src = `export const navMeta = { deepLinkOnly: true, navClass: 'primary', anchor: "PrimarySidebar", roleGated: ['admin','owner'] };`;
    const claims = parseNavMeta(src, 'a.tsx');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].fields.deepLinkOnly, true);
    assert.equal(claims[0].fields.navClass, 'primary');
    assert.equal(claims[0].fields.anchor, 'PrimarySidebar');
    assert.deepEqual(claims[0].fields.roleGated, ['admin', 'owner']);
    assert.equal(claims[0].scope, 'module');
  });

  it('parses a @nav docblock', () => {
    const src = `/** @nav deepLinkOnly navClass=primary roleGated=admin,owner */`;
    const claims = parseNavMeta(src, 'b.tsx');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].fields.deepLinkOnly, true);
    assert.deepEqual(claims[0].fields.roleGated, ['admin', 'owner']);
    assert.equal(claims[0].scope, 'docblock');
  });

  it('ignores unknown navMeta keys (forward-compatible)', () => {
    const src = `export const navMeta = { deepLinkOnly: true, futureField: 'x' };`;
    const claims = parseNavMeta(src, 'c.tsx');
    assert.deepEqual(claims[0].unknownKeys, ['futureField']);
    assert.equal('futureField' in claims[0].fields, false);
  });

  it('returns nothing when no navMeta present', () => {
    assert.deepEqual(parseNavMeta('const x = 1;', 'd.tsx'), []);
  });
});

describe('utility classification', () => {
  it('flags known utility routes', () => {
    assert.ok(isUtilityRoute('/oauth/callback'));
    assert.ok(isUtilityRoute('/auth/login'));
    assert.ok(isUtilityRoute('/404'));
    assert.ok(isUtilityRoute('/reset-password'));
  });
  it('does not flag product routes', () => {
    assert.equal(isUtilityRoute('/wines'), false);
    assert.equal(isUtilityRoute('/admin/users/:param'), false);
  });
});

describe('bootstrap', () => {
  it('seeds inferred intents from persona seeds + flags inferred utility', () => {
    const { contract, inferredUtility } = bootstrapContract({
      destinations: ['/wines', '/oauth/callback', '/404'],
      personaIntents: [{ personaId: 'admin', intentId: 'revoke', destination: '/admin/users/:param' }],
    });
    assert.equal(contract.personas[0].intents[0].source, 'inferred');
    assert.deepEqual(inferredUtility.sort(), ['/404', '/oauth/callback']);
    assert.ok(NavContractSchema.safeParse(contract).success);
  });
});
