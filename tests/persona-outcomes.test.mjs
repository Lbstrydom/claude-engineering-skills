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
    personaFindingHash: 'deadbeef00000000000000000000000000000000000000000000000000000000', outcome: 'fixed', labeledBy: 'agent',
  });
  assert.equal(r.ok, true);
});

test('upsertPersonaFindingOutcome: rationale required for "dismissed" — rejected before any cloud check', async () => {
  const r = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'deadbeef00000000000000000000000000000000000000000000000000000000', outcome: 'dismissed', labeledBy: 'agent',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid args/);
});

test('upsertPersonaFindingOutcome: rationale required for "wont_fix"', async () => {
  const r = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'deadbeef00000000000000000000000000000000000000000000000000000000', outcome: 'wont_fix', labeledBy: 'agent', rationale: '   ',
  });
  assert.equal(r.ok, false, 'whitespace-only rationale must not satisfy the requirement');
});

test('upsertPersonaFindingOutcome: rationale NOT required for "fixed"/"stale"', async () => {
  const fixed = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'deadbeef00000000000000000000000000000000000000000000000000000000', outcome: 'fixed', labeledBy: 'agent',
  });
  assert.equal(fixed.ok, true);
  const stale = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'deadbeef00000000000000000000000000000000000000000000000000000000', outcome: 'stale', labeledBy: 'agent',
  });
  assert.equal(stale.ok, true);
});

test('upsertPersonaFindingOutcome: invalid outcome value rejected', async () => {
  const r = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'deadbeef00000000000000000000000000000000000000000000000000000000', outcome: 'wontfix-typo', labeledBy: 'agent',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid args/);
});

test('upsertPersonaFindingOutcome: missing required fields rejected', async () => {
  const r = await upsertPersonaFindingOutcome({ repoId: 'r1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid args/);
});

// code-audit R2 findings H1/H5/H6: the R1 fix accepted EITHER an 8-hex
// (v1) or 64-hex (v2) shape but still unconditionally stamped
// hash_version:2 — so a v1-shaped hash could be persisted confidently
// mislabeled as v2. Only the current v2 shape is a valid write target now.
test('upsertPersonaFindingOutcome: a v1-shaped (8-hex) hash is REJECTED — v1 shapes are historical-only, never a valid write target', async () => {
  const r = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'deadbeef', outcome: 'fixed', labeledBy: 'agent',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid args/);
});

test('upsertPersonaFindingOutcome: a malformed (wrong-length) hash is rejected', async () => {
  const r = await upsertPersonaFindingOutcome({
    repoId: 'r1', personaFindingHash: 'not-a-hash', outcome: 'fixed', labeledBy: 'agent',
  });
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
  const r = await resolveLabelTarget({ sessionId: 's1', personaFindingHash: 'deadbeef00000000000000000000000000000000000000000000000000000000' });
  assert.equal(r.ok, false);
  assert.match(r.error, /cloud not configured/);
});

test('resolveLabelTarget: missing sessionId/hash rejected before any cloud check', async () => {
  const r = await resolveLabelTarget({ sessionId: null, personaFindingHash: 'deadbeef00000000000000000000000000000000000000000000000000000000' });
  assert.equal(r.ok, false);
  assert.match(r.error, /required/);
});

// ── docs/plans/persona-finding-hash-versioning.md: click_path/stepUrlByNumber
// threading + hash_version/staleHashCount additions must not disturb the
// existing cloud-off degradation paths above (they all still return their
// minimal, pre-existing shape — the new code paths are unreachable when
// cloud is off, since every function returns before reaching them). ──────

test('getPersonaOutcomesSummary: cloud-off shape stays minimal — no staleHashCount/hint fabricated when nothing was queried', async () => {
  const r = await getPersonaOutcomesSummary({ repoName: 'my-repo' });
  assert.equal(r.ok, true);
  assert.equal(r.cloud, false);
  assert.equal('staleHashCount' in r, false, 'cloud-off must not claim a stale-hash count it never computed');
});

test('getActionablePersonaOutcomeItems: cloud-off shape stays minimal — no staleHashCount/hint fabricated when nothing was queried', async () => {
  const r = await getActionablePersonaOutcomeItems({ repoName: 'my-repo' });
  assert.equal(r.ok, true);
  assert.equal(r.cloud, false);
  assert.equal('staleHashCount' in r, false);
});
