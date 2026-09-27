/**
 * @fileoverview `recordPersonaPairLink` (persona_pair_sessions, migration
 * 20260927120000) and `recordPersonaSession`'s `statsReason` — against a real
 * Postgres. Env-gated on AUDIT_DB_TEST_URL; skips cleanly without it.
 *
 * Why a DB suite and not a stub: every property asserted here belongs to
 * Postgres — the INSERT … SELECT writing nothing for a dangling or cross-repo
 * session, the NULL-safe repo comparison, the ON CONFLICT re-post, the
 * distinct-session CHECK, and an UPDATE that matched no persona reporting
 * rowCount 0. A stubbed pool can only echo what the test told it.
 *
 * Enrolled in scripts/db-test-container.mjs ISOLATED_SUITE_FILES AND
 * .github/workflows/postgres-parity.yml — two edits, always.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid } from '../scripts/lib/store/repo.mjs';
import { recordPersonaPairLink, recordPersonaSession } from '../scripts/lib/store/persona.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

let savedUrl;
const repoIds = [];
const sessionIds = [];
const personaIds = [];

async function seedSession(repoId) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO persona_test_sessions (session_id, persona, url, browser_tool, verdict, repo_id)
     VALUES ($1, 'tester', 'https://example.test', 'playwright', 'Needs work', $2) RETURNING id`,
    [`pair-link-${crypto.randomUUID()}`, repoId],
  );
  sessionIds.push(rows[0].id);
  return rows[0].id;
}

describe('recordPersonaPairLink + statsReason (disposable DB)', { skip }, () => {
  let repoA, repoB;

  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    repoA = (await upsertRepoByUuid({ repoUuid: `test-pair-a-${crypto.randomUUID()}`, name: 'pair-link-a', fingerprint: null })).id;
    repoB = (await upsertRepoByUuid({ repoUuid: `test-pair-b-${crypto.randomUUID()}`, name: 'pair-link-b', fingerprint: null })).id;
    repoIds.push(repoA, repoB);
  });

  after(async () => {
    try {
      const pool = await getPool();
      await pool.query(`DELETE FROM persona_pair_sessions WHERE session_a = ANY($1::uuid[]) OR session_b = ANY($1::uuid[])`, [sessionIds]);
      await pool.query(`DELETE FROM persona_test_sessions WHERE id = ANY($1::uuid[])`, [sessionIds]);
      if (personaIds.length) await pool.query(`DELETE FROM personas WHERE id = ANY($1::uuid[])`, [personaIds]);
      await pool.query(`DELETE FROM audit_repos WHERE id = ANY($1::uuid[])`, [repoIds]);
    } finally {
      await closePool();
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      await _resetForTest();
    }
  });

  it('links two same-repo sessions, derives the rate, and a re-post updates in place', async () => {
    const a = await seedSession(repoA);
    const b = await seedSession(repoA);
    const first = await recordPersonaPairLink({ sessionA: a, sessionB: b, consensusCount: 1, aOnlyCount: 5, bOnlyCount: 6 }, { repoId: repoA });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.overlapRate, 0.0833);
    const again = await recordPersonaPairLink({ sessionA: a, sessionB: b, consensusCount: 2, aOnlyCount: 4, bOnlyCount: 4 }, { repoId: repoA });
    assert.equal(again.ok, true);
    assert.equal(again.pairId, first.pairId, 'the ordered pair is the identity — a re-post must not create a second row');
    const pool = await getPool();
    const { rows } = await pool.query(`SELECT repo_id, consensus_count, overlap_rate FROM persona_pair_sessions WHERE id = $1`, [first.pairId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].repo_id, repoA);
    assert.equal(rows[0].consensus_count, 2);
    assert.equal(Number(rows[0].overlap_rate), 0.2);
  });

  it('refuses a dangling session id as session-not-found', async () => {
    const a = await seedSession(repoA);
    const r = await recordPersonaPairLink({ sessionA: a, sessionB: crypto.randomUUID(), consensusCount: 0, aOnlyCount: 1, bOnlyCount: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'session-not-found');
  });

  it('refuses a cross-repo pair', async () => {
    const a = await seedSession(repoA);
    const b = await seedSession(repoB);
    const r = await recordPersonaPairLink({ sessionA: a, sessionB: b, consensusCount: 0, aOnlyCount: 1, bOnlyCount: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cross-repo-pair');
  });

  it('refuses a same-repo pair outside the resolved scope as session-not-owned', async () => {
    const a = await seedSession(repoB);
    const b = await seedSession(repoB);
    const r = await recordPersonaPairLink({ sessionA: a, sessionB: b, consensusCount: 0, aOnlyCount: 1, bOnlyCount: 1 }, { repoId: repoA });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'session-not-owned');
  });

  it('pairs two repo-less sessions (NULL-safe comparison)', async () => {
    const a = await seedSession(null);
    const b = await seedSession(null);
    const r = await recordPersonaPairLink({ sessionA: a, sessionB: b, consensusCount: 0, aOnlyCount: 0, bOnlyCount: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.overlapRate, 0);
  });

  it('the table itself refuses a self-pair (CHECK), independent of the writer', async () => {
    const a = await seedSession(repoA);
    const pool = await getPool();
    await assert.rejects(
      pool.query(`INSERT INTO persona_pair_sessions (session_a, session_b, consensus_count, a_only_count, b_only_count, overlap_rate)
                  VALUES ($1, $1, 0, 0, 0, 0)`, [a]),
      (err) => err.code === '23514',
    );
  });

  it('statsReason: no-persona-id when absent, null when the persona row was updated', async () => {
    // (A personaId naming no persona cannot reach the stats UPDATE: the
    // session row's persona_id FK refuses it first, so `persona-not-found` is
    // the writer's defence against a concurrent delete, not a testable path.)
    const mk = (over = {}) => ({
      sessionId: `stats-${crypto.randomUUID()}`, persona: 'p', url: 'https://example.test',
      browserTool: 'playwright', verdict: 'Needs work', repoId: repoA, ...over,
    });
    const none = await recordPersonaSession(mk());
    sessionIds.push(none.sessionId);
    assert.equal(none.ok, true, JSON.stringify(none));
    assert.equal(none.statsUpdated, false);
    assert.equal(none.statsReason, 'no-persona-id');

    const pool = await getPool();
    const { rows } = await pool.query(
      `INSERT INTO personas (name, description, app_url) VALUES ($1, 'd', 'https://example.test') RETURNING id`,
      [`pair-link-persona-${crypto.randomUUID()}`],
    );
    personaIds.push(rows[0].id);
    const real = await recordPersonaSession(mk({ personaId: rows[0].id }));
    sessionIds.push(real.sessionId);
    assert.equal(real.statsUpdated, true);
    assert.equal(real.statsReason, null);
  });
});
