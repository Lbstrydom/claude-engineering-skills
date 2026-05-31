/**
 * @fileoverview Security dashboard section — reshape contract + renderer.
 * Both pure (no DB): securityData() maps getSecurityStats() output into the
 * render shape; sectionSecurity() renders that shape with a fake ui bundle.
 * Back-port: docs/plans/security (Phase 6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../scripts/lib/dashboard/collect-telemetry.mjs';
import sectionSecurity from '../scripts/lib/dashboard/sections/security.mjs';
import { buildUi } from '../scripts/lib/dashboard/helpers.mjs';

const { securityData, emptySecurity } = __test__;

test('securityData reshapes maps → arrays and ISO-stamps timestamps', () => {
  const out = securityData({
    cloud: true,
    totalIncidents: 3,
    embedded: 2,
    byStatus: { 'mitigation-passing': 2, historical: 1 },
    eventCounts: { inserted: 3, refused_secret: 1 },
    lastRefreshAt: new Date('2026-05-31T10:00:00Z'),
    recentEvents: [
      { incident_id: 'INC-001', event_kind: 'inserted', branch: 'main', created_at: new Date('2026-05-31T10:00:00Z') },
    ],
  });
  assert.equal(out.cloud, true);
  assert.deepEqual(out.byStatus, [
    { status: 'mitigation-passing', count: 2 },
    { status: 'historical', count: 1 },
  ]);
  assert.deepEqual(out.eventCounts, [
    { kind: 'inserted', count: 3 },
    { kind: 'refused_secret', count: 1 },
  ]);
  assert.equal(out.lastRefreshAt, '2026-05-31T10:00:00.000Z');
  assert.equal(out.recentEvents[0].incidentId, 'INC-001');
  assert.equal(out.recentEvents[0].createdAt, '2026-05-31T10:00:00.000Z');
});

test('emptySecurity is schema-shaped with cloud=false', () => {
  const e = emptySecurity();
  assert.equal(e.cloud, false);
  assert.deepEqual(e.byStatus, []);
  assert.equal(e.lastRefreshAt, null);
});

test('sectionSecurity renders the secret-gate tallies', () => {
  const ui = buildUi();
  const html = sectionSecurity({
    src: { status: 'ok', detail: '' },
    security: securityData({
      cloud: true, totalIncidents: 2, embedded: 2,
      byStatus: { 'mitigation-passing': 2 },
      eventCounts: { refused_secret: 1, redacted_secret: 3 },
      lastRefreshAt: new Date('2026-05-31T10:00:00Z'),
      recentEvents: [],
    }),
  }, ui);
  assert.match(html, /Secrets refused/);
  assert.match(html, /PII redacted/);
  assert.match(html, /2<\/strong> incident/);
});

test('sectionSecurity shows an empty panel when no incidents', () => {
  const ui = buildUi();
  const html = sectionSecurity({ src: { status: 'ok', detail: '' }, security: emptySecurity() }, ui);
  // emptySecurity has cloud:false → "needs cloud" empty state
  assert.match(html, /needs cloud/i);
});
