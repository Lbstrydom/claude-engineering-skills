/**
 * @fileoverview DB-free tests for the persona-outcomes store seam
 * (scripts/lib/store/persona-outcomes.mjs) — WS4 of
 * docs/plans/persona-nav-feedback-recovery.md. Per this repo's testing
 * doctrine, the actual INSERT/SELECT round trip is DB-side and covered by
 * the empirical verify doctrine, not asserted here against a mock. What IS
 * asserted, DB-free: schema validation catches malformed input before any
 * query is built (including the rationale-required-for-dismissal rule,
 * enforced at BOTH the CLI/schema layer here AND the table CHECK
 * constraint — defense in depth), and the cloud-off path degrades
 * gracefully without attempting a connection (this dev machine has a real
 * AUDIT_DB_URL — every test file here must stay hermetic regardless).
 */
process.env.AUDIT_DB_URL = ''; // must precede the dynamic import below

const {
  upsertPersonaFindingOutcome, getPersonaOutcomesSummary,
  getActionablePersonaOutcomeItems, resolveLabelTarget,
} = await import('../scripts/lib/store/persona-outcomes.mjs');

import test from 'node:test';
import assert from 'node:assert/strict';

test('upsertPersonaFindingOutcome: cloud off → {ok:true}, no query attempted', async () => {
  const r = await upsertPersonaFindingOutcome({
    repoId: 'a0000000-0000-0000-0000-000000000000',
    personaFindingHash: 'deadbeef', outcome: 'fixed', labeledBy: 'agent',
  });
  assert.equal(r.ok, true);
});

test('upsertPersonaFindingOutcome: rationale required for "dismissed" — rejected before any cloud check', async () => {
  const r = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'h1', outcome: 'dismissed', labeledBy: 'agent',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid args/);
});

test('upsertPersonaFindingOutcome: rationale required for "wont_fix"', async () => {
  const r = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'h1', outcome: 'wont_fix', labeledBy: 'agent', rationale: '   ',
  });
  assert.equal(r.ok, false, 'whitespace-only rationale must not satisfy the requirement');
});

test('upsertPersonaFindingOutcome: rationale NOT required for "fixed"/"stale"', async () => {
  const fixed = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'h1', outcome: 'fixed', labeledBy: 'agent',
  });
  assert.equal(fixed.ok, true);
  const stale = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'h1', outcome: 'stale', labeledBy: 'agent',
  });
  assert.equal(stale.ok, true);
});

test('upsertPersonaFindingOutcome: invalid outcome value rejected', async () => {
  const r = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'h1', outcome: 'wontfix-typo', labeledBy: 'agent',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid args/);
});

test('upsertPersonaFindingOutcome: missing required fields rejected', async () => {
  const r = await upsertPersonaFindingOutcome({ repoId: 'r1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid args/);
});

test('getPersonaOutcomesSummary: cloud off → {ok:true, cloud:false, sessionId:null}', async () => {
  const r = await getPersonaOutcomesSummary({ repoName: 'my-repo' });
  assert.equal(r.ok, true);
  assert.equal(r.cloud, false);
  assert.equal(r.sessionId, null);
});

test('getPersonaOutcomesSummary: missing repoName is rejected', async () => {
  const r = await getPersonaOutcomesSummary({});
  assert.equal(r.ok, false);
  assert.match(r.error, /repoName/);
});

test('getPersonaOutcomesSummary: cloud off → degrades gracefully even when repoId is supplied (88bc75e1/8993b96f)', async () => {
  const r = await getPersonaOutcomesSummary({ repoName: 'my-repo', repoId: 'r-1234' });
  assert.equal(r.ok, true);
  assert.equal(r.cloud, false);
  assert.equal(r.sessionId, null);
});

test('getActionablePersonaOutcomeItems: cloud off → {ok:true, cloud:false, items:[]}', async () => {
  const r = await getActionablePersonaOutcomeItems({ repoName: 'my-repo' });
  assert.equal(r.ok, true);
  assert.equal(r.cloud, false);
  assert.deepEqual(r.items, []);
  assert.equal(r.truncated, false);
});

test('getActionablePersonaOutcomeItems: missing repoName is rejected', async () => {
  const r = await getActionablePersonaOutcomeItems({});
  assert.equal(r.ok, false);
  assert.match(r.error, /repoName/);
});

test('getActionablePersonaOutcomeItems: cloud off → degrades gracefully even when repoId is supplied (88bc75e1/8993b96f)', async () => {
  const r = await getActionablePersonaOutcomeItems({ repoName: 'my-repo', repoId: 'r-1234' });
  assert.equal(r.ok, true);
  assert.equal(r.cloud, false);
  assert.deepEqual(r.items, []);
});

test('resolveLabelTarget: cloud off → {ok:false} (label requires a real session lookup, never proceeds blind)', async () => {
  const r = await resolveLabelTarget({ sessionId: 's1', personaFindingHash: 'h1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /cloud not configured/);
});

test('resolveLabelTarget: missing sessionId/hash rejected before any cloud check', async () => {
  const r = await resolveLabelTarget({ sessionId: null, personaFindingHash: 'h1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /required/);
});
