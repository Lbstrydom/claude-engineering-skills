/**
 * WS-C2 — proves the `@on-conflict-ok` pragmas on the five scope-identity sites
 * are TRUE, not merely asserted.
 *
 * A suppression that says "this conflict target is correct because X" is only
 * worth what X is worth. Each pragma here rests on a claim about the schema or
 * about key construction, and every one of those claims is mechanically checked
 * below — so if a future migration falsifies one (drops a NOT NULL, widens a
 * constraint, changes a key format), this suite fails instead of the pragma
 * quietly becoming a lie.
 *
 * Pure-unit tests (session-id construction) run unconditionally.
 * Schema/behaviour tests are env-gated on AUDIT_DB_TEST_URL — the DISPOSABLE
 * container, never AUDIT_DB_URL — matching tests/db-withtx.test.mjs.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPersonaSessionId,
  isCollisionResistantSessionId,
} from '../scripts/lib/persona-test/session-id.mjs';
import { buildDecisionKey } from '../scripts/lib/learning/decision-logger.mjs';
import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

/**
 * Point the pool at the disposable DSN.
 *
 * The ambient `AUDIT_DB_SSL_MODE` belongs to the LIVE store (`require` /
 * `no-verify`); `db-test-container.mjs` serves plaintext on loopback, so
 * inheriting it fails with "server does not support SSL connections". Derive
 * the mode from the DSN instead of forcing `disable` unconditionally — a
 * TLS-capable disposable DSN keeps whatever the operator configured.
 */
function useDisposableDsn() {
  assertDisposableDbUrl(TEST_URL);      // fail-closed: never a production DSN
  _resetForTest();
  process.env.AUDIT_DB_URL = TEST_URL;
  if (/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(TEST_URL)) {
    process.env.AUDIT_DB_SSL_MODE = 'disable';
  }
}

// ── Pure unit: the persona_test_sessions pragma's root-cause claim ──────────

describe('buildPersonaSessionId — the identity fix behind the sessions pragma', () => {
  it('mints the documented collision-resistant shape (timestamp + uuid)', () => {
    const id = buildPersonaSessionId();
    assert.match(
      id,
      /^persona-test-\d{10,}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(isCollisionResistantSessionId(id));
  });

  it('does NOT collide for two repos minting in the same second — the exact defect', () => {
    // Freeze the clock: this is precisely the case the legacy
    // `persona-test-<unix seconds>` id could not survive.
    const now = 1_784_230_599_000;
    const a = buildPersonaSessionId({ now });
    const b = buildPersonaSessionId({ now });
    assert.notEqual(a, b, 'same-second mints must differ — the uuid suffix is the uniqueness mechanism');
    assert.equal(a.slice(0, 'persona-test-1784230599'.length), b.slice(0, 'persona-test-1784230599'.length),
      'the timestamp prefix is still shared — it is legibility, not identity');
  });

  // Smoke test only. The uniqueness CONTRACT is crypto.randomUUID's, not
  // something a sampling loop can prove; this just catches a suffix that has
  // been accidentally made constant or dropped.
  it('stays distinct across a same-second batch (smoke)', () => {
    const now = 1_784_230_599_000;
    const ids = new Set(Array.from({ length: 1000 }, () => buildPersonaSessionId({ now })));
    assert.equal(ids.size, 1000);
  });

  it('exposes no entropy seam that could emit a malformed production id', () => {
    // Regression guard for round-1 audit M2: an injectable byte source could
    // silently produce a short suffix. Only `now` is injectable, and a bogus
    // `now` still yields a well-formed id.
    const id = buildPersonaSessionId({ now: Number.NaN, entropy: () => Buffer.alloc(1) });
    assert.ok(isCollisionResistantSessionId(id),
      'a non-finite now falls back to the real clock; entropy is not a seam');
  });

  it('rejects the legacy weak shape as non-collision-resistant', () => {
    assert.equal(isCollisionResistantSessionId('persona-test-1784230599'), false);
    assert.equal(isCollisionResistantSessionId('persona-test-1784230599-3f2a1b4c5d6e'), false);
    assert.equal(isCollisionResistantSessionId(''), false);
    assert.equal(isCollisionResistantSessionId(undefined), false);
  });
});

// ── Pure unit: the learning_decisions pragma's global-uniqueness claim ──────

describe('buildDecisionKey — the global-uniqueness claim behind the learning_decisions pragma', () => {
  it('audit-bound keys embed the globally-unique audit_run_id, so scope is already in the key', () => {
    const key = buildDecisionKey({
      decisionType: 'pass_selection', auditRunId: 'e3b0c442-98fc-1c14-9afb-4c8996fb9242', round: 1, sequence: 0,
    });
    assert.ok(key.startsWith('e3b0c442-98fc-1c14-9afb-4c8996fb9242:'),
      'the run uuid must lead the key — that is what makes repo_id redundant in the conflict target');
  });

  it('two repos cannot produce the same audit-bound key without sharing an audit_run_id', () => {
    const mk = (runId) => buildDecisionKey({ decisionType: 'pass_selection', auditRunId: runId, round: 1, sequence: 0 });
    assert.notEqual(mk('11111111-1111-1111-1111-111111111111'), mk('22222222-2222-2222-2222-222222222222'));
  });
});

// ── Schema invariants (disposable container only) ──────────────────────────

describe('scope-identity schema invariants (WS-C2 pragmas)', { skip }, () => {
  let pool;

  before(async () => {
    useDisposableDsn();
    pool = await getPool();
  });

  after(async () => {
    await closePool();
    _resetForTest();
  });

  const nullability = async (table, column) => {
    const { rows } = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, column]);
    return rows[0]?.is_nullable;
  };

  const constraintDef = async (table, contype = 'u') => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname='public' AND rel.relname=$1 AND con.contype=$2
       ORDER BY con.conname`, [table, contype]);
    return rows.map((r) => r.def);
  };

  it('symbol_index: refresh_id NOT NULL — the FD the pragma rests on', async () => {
    assert.equal(await nullability('symbol_index', 'refresh_id'), 'NO');
    assert.equal(await nullability('refresh_runs', 'repo_id'), 'NO',
      'if refresh_runs.repo_id becomes nullable the symbol_index pragma is no longer true');
  });

  it('symbol_layering_violations: same FD holds', async () => {
    assert.equal(await nullability('symbol_layering_violations', 'refresh_id'), 'NO');
  });

  it('the FD is a real DB constraint, not a convention — refresh_id FKs to refresh_runs', async () => {
    const { rows } = await pool.query(
      `SELECT rel.relname AS tbl, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname='public' AND con.contype='f'
         AND rel.relname IN ('symbol_index','symbol_layering_violations')`);
    for (const t of ['symbol_index', 'symbol_layering_violations']) {
      assert.ok(
        rows.some((r) => r.tbl === t && /FOREIGN KEY \(refresh_id\) REFERENCES refresh_runs/.test(r.def)),
        `${t}.refresh_id must FK to refresh_runs for the functional dependency to hold`);
    }
  });

  it('learning_decisions: decision_key is GLOBALLY unique — not (repo_id, decision_key)', async () => {
    const defs = await constraintDef('learning_decisions');
    assert.ok(defs.includes('UNIQUE (decision_key)'),
      'widening this to include repo_id would WEAKEN it and reintroduce NULL-distinct');
    assert.ok(!defs.some((d) => /UNIQUE \(.*repo_id.*decision_key/.test(d)));
  });

  it('personas: identity is (name, app_url) — app-scoped by design', async () => {
    assert.ok((await constraintDef('personas')).includes('UNIQUE (name, app_url)'));
  });

  it('persona_test_sessions: identity is session_id alone', async () => {
    assert.ok((await constraintDef('persona_test_sessions')).includes('UNIQUE (session_id)'));
  });
});

// ── Behavioural: the upsert semantics the pragmas promise ──────────────────

describe('scope-identity upsert behaviour (WS-C2)', { skip }, () => {
  let pool;

  before(async () => {
    useDisposableDsn();
    pool = await getPool();
  });

  after(async () => {
    await pool.query(`DELETE FROM persona_test_sessions WHERE session_id LIKE 'persona-test-%-wsc2%'`);
    await closePool();
    _resetForTest();
  });

  const insertSession = (sessionId, repoName) => pool.query(
    `INSERT INTO persona_test_sessions (session_id, persona, url, browser_tool, verdict, repo_name)
     VALUES ($1, 'p', 'https://example.test', 'Playwright MCP', 'Needs work', $2)
     ON CONFLICT (session_id) DO UPDATE SET repo_name = EXCLUDED.repo_name
     RETURNING id, repo_name`, [sessionId, repoName]);

  it('a second scope INSERTS rather than overwriting the first', async () => {
    // Two repos, same wall-clock second — the collision scenario. With minted
    // ids they are distinct keys, so both rows survive independently.
    const now = 1_784_230_599_000;
    const a = `${buildPersonaSessionId({ now })}-wsc2a`;
    const b = `${buildPersonaSessionId({ now })}-wsc2b`;
    assert.notEqual(a, b);

    const ra = await insertSession(a, 'repo-alpha');
    const rb = await insertSession(b, 'repo-beta');
    assert.notEqual(ra.rows[0].id, rb.rows[0].id, 'distinct rows, not an overwrite');

    const { rows } = await pool.query(
      `SELECT session_id, repo_name FROM persona_test_sessions WHERE session_id IN ($1,$2) ORDER BY repo_name`, [a, b]);
    assert.deepEqual(rows.map((r) => r.repo_name), ['repo-alpha', 'repo-beta'],
      "repo-alpha's row must still hold its own repo_name");
  });

  it('re-upserting the same session_id still UPDATES in place (idempotency preserved)', async () => {
    const id = `${buildPersonaSessionId()}-wsc2c`;
    const first = await insertSession(id, 'repo-alpha');
    const second = await insertSession(id, 'repo-alpha-renamed');
    assert.equal(first.rows[0].id, second.rows[0].id, 'same row — an update, not a duplicate insert');
    assert.equal(second.rows[0].repo_name, 'repo-alpha-renamed');

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM persona_test_sessions WHERE session_id = $1`, [id]);
    assert.equal(rows[0].n, 1);
  });
});
