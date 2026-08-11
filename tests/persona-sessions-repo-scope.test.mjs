/**
 * @fileoverview The persona-session reader scopes by CANONICAL repo id too.
 *
 * Guards the audit finding "Tenant/owner scoping": `getPersonaSessionsByRepo`
 * filtered on the caller-supplied `repo_name` alone and never resolved or passed
 * `audit_repos.id`, unlike every sibling path.
 *
 * `repo_name` IS `audit_repos.name` and is unique, so this was never a
 * cross-repo LEAK. What name-scoping cannot catch is a row whose two identity
 * fields DISAGREE — and that row was producible until 2026-08-11, because
 * `cmdRecordPersonaSession` filled only the MISSING field: a caller supplying
 * repo A's name from a checkout of repo B wrote A's name beside B's id, and this
 * reader served it as A's. The writer is fixed (reconcileRepoIdentity); this is
 * the read half of the same defect.
 *
 * `OR repo_id IS NULL` is deliberate and asserted below. The column is nullable
 * BY DESIGN — the writer records by name when ambient identity cannot resolve —
 * so requiring the id would silently drop exactly the degraded rows it exists to
 * cover. Measured 2026-08-11: 0 of 7 rows in this store are null, but a
 * consumer's store is not this store.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
// STATIC — loads `.env`; reading process.env before it runs skips the suite.
import '../scripts/lib/config.mjs';

const HAS_STORE = Boolean(process.env.AUDIT_DB_URL);

describe('getPersonaSessionsByRepo — canonical id narrows, never widens',
  { skip: !HAS_STORE && 'needs AUDIT_DB_URL' }, () => {
    let store, q, fixture, foreignId;

    before(async () => {
      q = await import('../scripts/lib/db/query.mjs');
      store = await import('../scripts/lib/store/persona.mjs');
      // Discover a repo_name that actually HAS sessions carrying a non-null
      // repo_id — a fixture chosen without reference to what it must
      // demonstrate is how a suite goes green having checked nothing.
      fixture = await q.one(
        `SELECT repo_name, repo_id, count(*)::int AS n
           FROM persona_test_sessions
          WHERE repo_name IS NOT NULL AND repo_id IS NOT NULL
          GROUP BY 1,2 ORDER BY 3 DESC LIMIT 1`, []);
      // Any OTHER repo id, to stand in for a mismatched row.
      const other = await q.one(
        `SELECT id FROM audit_repos WHERE id <> $1 ORDER BY created_at LIMIT 1`,
        [fixture?.repo_id ?? '00000000-0000-4000-8000-000000000000']);
      foreignId = other?.id ?? null;
    });

    const needsFixture = (t) => {
      if (fixture?.repo_name && fixture?.repo_id && foreignId) return false;
      t.skip('no persona session with a non-null repo_id (plus a second repo) — unproven, not proven absent');
      return true;
    };

    it('a matching canonical id returns the rows (positive control)', async (t) => {
      if (needsFixture(t)) return;
      const rows = await store.getPersonaSessionsByRepo({
        repoName: fixture.repo_name, repoId: fixture.repo_id, limit: 100,
      });
      assert.equal(rows.length, fixture.n,
        'scoping by the row\'s OWN repo id must not hide it');
    });

    it('a FOREIGN canonical id excludes them — the fence actually fences', async (t) => {
      if (needsFixture(t)) return;
      const rows = await store.getPersonaSessionsByRepo({
        repoName: fixture.repo_name, repoId: foreignId, limit: 100,
      });
      assert.equal(rows.length, 0,
        'a row whose repo_id names a different repo must not be served under this name');
    });

    it('omitting the id keeps the pre-existing name-scoped behaviour', async (t) => {
      if (needsFixture(t)) return;
      const rows = await store.getPersonaSessionsByRepo({ repoName: fixture.repo_name, limit: 100 });
      assert.equal(rows.length, fixture.n,
        'an unresolvable checkout must degrade to where this was, never below it');
    });

    it('p0Only carries the same predicate, not a looser one', async (t) => {
      if (needsFixture(t)) return;
      // The two branches are written out separately, so one can drift from the
      // other — which is precisely how this family accumulated its
      // one-sibling-only divergences.
      const foreign = await store.getPersonaSessionsByRepo({
        repoName: fixture.repo_name, repoId: foreignId, p0Only: true, limit: 100,
      });
      assert.equal(foreign.length, 0, 'the p0-only branch must fence identically');
      const own = await store.getPersonaSessionsByRepo({
        repoName: fixture.repo_name, repoId: fixture.repo_id, p0Only: true, limit: 100,
      });
      const expected = await q.one(
        `SELECT count(*)::int AS n FROM persona_test_sessions
          WHERE repo_name = $1 AND repo_id = $2 AND p0_count > 0`,
        [fixture.repo_name, fixture.repo_id]);
      assert.equal(own.length, expected.n, 'and must still return the rows that DO match');
    });

    it('a NULL repo_id row survives scoping — the degraded case is not dropped', async (t) => {
      if (needsFixture(t)) return;
      const nulls = await q.one(
        `SELECT repo_name, count(*)::int AS n FROM persona_test_sessions
          WHERE repo_id IS NULL AND repo_name IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, []);
      if (!nulls?.repo_name) {
        t.skip('no NULL-repo_id session in this store — the OR-IS-NULL arm is unproven, not proven unnecessary');
        return;
      }
      const rows = await store.getPersonaSessionsByRepo({
        repoName: nulls.repo_name, repoId: foreignId, limit: 100,
      });
      assert.equal(rows.length, nulls.n,
        'rows recorded by name only must remain readable — the writer creates them deliberately');
    });
  });
