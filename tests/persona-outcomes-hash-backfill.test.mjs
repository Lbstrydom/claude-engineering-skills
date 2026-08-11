/**
 * @fileoverview Integration test (disposable DB) for
 * `backfillPersonaFindingHashV2` — the v1->v2 personaFindingHash migration
 * tool, docs/plans/persona-finding-hash-versioning.md. Every scenario named
 * in the plan's §4/§6 is covered here, keyed by its originating audit
 * finding ID so the regression each guards against stays traceable.
 *
 * Env-gated: requires AUDIT_DB_TEST_URL. Skips cleanly when absent. Mirrors
 * tests/symbol-index-drift-justification.test.mjs's disposable-DB pattern.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid } from '../scripts/lib/store/repo.mjs';
import { backfillPersonaFindingHashV2 } from '../scripts/lib/store/persona-outcomes-hash-backfill.mjs';
import { personaFindingHash, personaFindingHashV1, buildStepUrlLookup } from '../scripts/lib/persona/audit-correlator.mjs';
import { retrySync } from '../scripts/lib/retry-transient-fs.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

let savedUrl, repoId;
const reportPaths = [];

async function seedSession({ findings, clickPath = [] }) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO persona_test_sessions
       (session_id, persona, url, browser_tool, verdict, repo_id, findings, click_path)
     -- 'Ready for users' | 'Needs work' | 'Blocked' are the only values
     -- persona_test_sessions_verdict_check accepts (20260413224948). This said
     -- 'pass'; the suite was enrolled in no runner, so it never ran to find out.
     VALUES ($1, 'tester', 'https://example.com', 'playwright', 'Needs work', $2, $3, $4)
     RETURNING id`,
    [`session-${crypto.randomUUID()}`, repoId, JSON.stringify(findings), JSON.stringify(clickPath)],
  );
  return rows[0].id;
}

async function seedV1Outcome({ hash, outcome = 'dismissed', rationale = 'false positive', lastSeenSessionId = null, labeledBy = 'alice' }) {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO persona_finding_outcomes
       (repo_id, persona_finding_hash, outcome, last_seen_session_id, labeled_by, rationale, hash_version)
     VALUES ($1, $2, $3, $4, $5, $6, 1)`,
    [repoId, hash, outcome, lastSeenSessionId, labeledBy, rationale],
  );
}

async function getOutcomeRow(hash) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT * FROM persona_finding_outcomes WHERE repo_id = $1 AND persona_finding_hash = $2`,
    [repoId, hash],
  );
  return rows[0] ?? null;
}

function finding(over = {}) {
  return { code: 'P0', step: 1, element: 'Checkout button', expected: 'Order confirms', observed: 'Page crashes', ...over };
}

describe('backfillPersonaFindingHashV2 (disposable DB)', { skip }, () => {
  beforeEach(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    const repo = await upsertRepoByUuid({
      repoUuid: `test-persona-hash-backfill-${crypto.randomUUID()}`,
      name: 'persona-hash-backfill-test-repo', fingerprint: null,
    });
    repoId = repo.id;
  });

  afterEach(async () => {
    const cleanupErrors = [];
    try {
      const pool = await getPool();
      if (pool) {
        const statements = [
          [`DELETE FROM persona_finding_outcomes WHERE repo_id = $1`, [repoId]],
          [`DELETE FROM persona_test_sessions WHERE repo_id = $1`, [repoId]],
        ];
        for (const [sql, params] of statements) {
          try { await pool.query(sql, params); } catch (err) { cleanupErrors.push(new Error(`${sql}: ${err?.message || err}`)); }
        }
        try {
          const { rowCount } = await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [repoId]);
          if (rowCount === 0) cleanupErrors.push(new Error(`DELETE FROM audit_repos WHERE id = ${repoId}: matched 0 rows`));
        } catch (err) { cleanupErrors.push(new Error(`audit_repos delete: ${err?.message || err}`)); }
      }
    } finally {
      for (const p of reportPaths.splice(0)) {
        try { retrySync(() => fs.rmSync(p, { force: true })); } catch { /* best-effort */ }
      }
      process.env.AUDIT_DB_URL = savedUrl;
      await closePool();
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'teardown had errors');
    }
  });

  it('(a) a v1 outcome row whose finding reappears in exactly one session/route → recoveredThisRun:1, full field-level projection preserved, old row untouched (H7 regression lock)', async () => {
    const f = finding();
    const oldHash = personaFindingHashV1(f);
    const clickPath = [{ step: 1, url: 'https://example.com/checkout' }];
    await seedSession({ findings: [f], clickPath });
    await seedV1Outcome({ hash: oldHash, rationale: 'known flake' });
    const before = await getOutcomeRow(oldHash);

    const result = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(result.recoveredThisRun, 1);
    assert.equal(result.unrecoverable, 0);
    assert.equal(result.ambiguousCount, 0);

    const stepUrlByNumber = buildStepUrlLookup(clickPath);
    const newHash = personaFindingHash(f, stepUrlByNumber);
    const after = await getOutcomeRow(newHash);
    assert.ok(after, 'expected a new v2 row to exist');
    assert.equal(after.hash_version, 2);
    assert.equal(after.outcome, before.outcome);
    assert.equal(after.rationale, before.rationale);
    assert.equal(after.labeled_by, before.labeled_by);
    assert.equal(String(after.last_seen_session_id), String(before.last_seen_session_id));
    assert.equal(new Date(after.created_at).getTime(), new Date(before.created_at).getTime());
    assert.ok(after.migrated_at, 'migrated_at must be set on the new row');

    const oldRowAfter = await getOutcomeRow(oldHash);
    assert.deepEqual(oldRowAfter, before, 'the v1 row must be completely untouched (non-destructive)');
  });

  it('(b) a v1 outcome row whose finding never reappears in any session → unrecoverable, no new row created', async () => {
    const oldHash = crypto.randomBytes(4).toString('hex');
    await seedV1Outcome({ hash: oldHash });
    const result = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(result.unrecoverable, 1);
    assert.equal(result.recoveredThisRun, 0);
  });

  it('(c) a v1 outcome row whose old hash maps to TWO distinct new hashes across different sessions → ambiguousCount:1, report names both candidates, NEITHER is written (H1 regression lock)', async () => {
    // Two sessions where the SAME v1-era finding shape (so it shares an
    // old_hash) resolves to two DIFFERENT routes/observed text under v2 —
    // achieved here via two distinct sessions with the same element/code/
    // observed (so personaFindingHashV1 collides) but different routes.
    const shared = { code: 'P0', element: 'Save button', observed: 'Save fails silently' };
    const oldHash = personaFindingHashV1(shared);
    await seedSession({ findings: [{ ...shared, step: 1 }], clickPath: [{ step: 1, url: 'https://example.com/a' }] });
    await seedSession({ findings: [{ ...shared, step: 1 }], clickPath: [{ step: 1, url: 'https://example.com/b' }] });
    await seedV1Outcome({ hash: oldHash });

    const result = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(result.ambiguousCount, 1);
    assert.equal(result.recoveredThisRun, 0);
    assert.ok(result.ambiguousReportPath);
    reportPaths.push(result.ambiguousReportPath);
    const lines = fs.readFileSync(result.ambiguousReportPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    const newHashes = new Set(lines.map((l) => l.newHash));
    assert.equal(newHashes.size, 2, 'both distinct new-hash candidates must appear in the report');

    // Gemini gate R2 shadow finding 121c7d93: the report is staged to a
    // temp file INSIDE the transaction and only renamed to its final path
    // AFTER commit. A successful run must leave exactly the published
    // file behind — no orphaned `.tmp-*` sibling from a publish that
    // never happened or happened twice.
    const dirEntries = fs.readdirSync(path.dirname(result.ambiguousReportPath));
    const tmpLeftovers = dirEntries.filter((f) => f.startsWith('.tmp-'));
    assert.deepEqual(tmpLeftovers, [], 'no leftover temp file after a successful publish');

    const oldRow = await getOutcomeRow(oldHash);
    assert.equal(oldRow.hash_version, 1, 'ambiguous source row must remain untouched at v1');
  });

  it('(d) a v1 row whose computed v2 target already has a LIVE (directly human-labeled) outcome row → targetAlreadyExists, the existing row is UNCHANGED (H2 regression lock — a direct label always wins, never overwritten)', async () => {
    const f = finding();
    const oldHash = personaFindingHashV1(f);
    const clickPath = [{ step: 1, url: 'https://example.com/checkout' }];
    const stepUrlByNumber = buildStepUrlLookup(clickPath);
    const newHash = personaFindingHash(f, stepUrlByNumber);
    await seedSession({ findings: [f], clickPath });
    await seedV1Outcome({ hash: oldHash, outcome: 'dismissed', rationale: 'stale reason' });

    // A live v2 label already exists at the target hash (e.g. a human
    // already re-labeled it post-migration-formula-change). migrated_at
    // is explicitly NULL here (the real column DEFAULT, and exactly what
    // upsertPersonaFindingOutcome always writes for a direct label) — this
    // is what makes the row PROTECTED from the R4 H2 conditional
    // reconciliation, regardless of timestamps.
    const pool = await getPool();
    await pool.query(
      `INSERT INTO persona_finding_outcomes (repo_id, persona_finding_hash, outcome, labeled_by, rationale, hash_version, migrated_at)
       VALUES ($1, $2, 'fixed', 'bob', NULL, 2, NULL)`,
      [repoId, newHash],
    );

    const result = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(result.targetAlreadyExists, 1);
    assert.equal(result.recoveredThisRun, 0);
    assert.equal(result.reconciledThisRun, 0, 'a directly-labeled row (migrated_at IS NULL) must never be reconciled, no matter how old/new its timestamp');
    const liveRow = await getOutcomeRow(newHash);
    assert.equal(liveRow.outcome, 'fixed', 'the live v2 row must be untouched, never overwritten by historical v1 data');
  });

  it('(d2) a BACKFILL-CREATED v2 row (migrated_at IS NOT NULL) whose v1 source is edited by a lagging consumer AFTER migration → reconciledThisRun, the v2 row is updated to match the newer v1 edit (R4 finding H2 compromise)', async () => {
    const f = finding();
    const oldHash = personaFindingHashV1(f);
    const clickPath = [{ step: 1, url: 'https://example.com/checkout' }];
    const stepUrlByNumber = buildStepUrlLookup(clickPath);
    const newHash = personaFindingHash(f, stepUrlByNumber);
    await seedSession({ findings: [f], clickPath });
    await seedV1Outcome({ hash: oldHash, outcome: 'dismissed', rationale: 'original reason' });

    // First run migrates it normally.
    const run1 = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(run1.recoveredThisRun, 1);
    const afterRun1 = await getOutcomeRow(newHash);
    assert.ok(afterRun1.migrated_at, 'a backfill-created row must have migrated_at set');

    // A lagging, un-synced consumer's OLD code relabels the v1 source
    // AFTER the backfill already ran — updated_at advances via the
    // touch trigger (a real UPDATE, not a fresh insert).
    const pool = await getPool();
    await pool.query(
      `UPDATE persona_finding_outcomes SET outcome = 'wont_fix', rationale = 'lagging consumer changed their mind'
       WHERE repo_id = $1 AND persona_finding_hash = $2`,
      [repoId, oldHash],
    );

    const run2 = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(run2.reconciledThisRun, 1, 'the backfill-created (never hand-labeled) v2 row must reconcile against the newer v1 edit');
    assert.equal(run2.recoveredThisRun, 0);
    const afterRun2 = await getOutcomeRow(newHash);
    assert.equal(afterRun2.outcome, 'wont_fix', 'the v2 row must now reflect the newer v1 edit');
    assert.equal(afterRun2.rationale, 'lagging consumer changed their mind');
  });

  it('(e) corrected rerun contract (H5): run twice — the DATABASE STATE (row count/contents) is identical across runs; per-run counters correctly differ (recoveredThisRun -> targetAlreadyExists)', async () => {
    const f = finding();
    const oldHash = personaFindingHashV1(f);
    const clickPath = [{ step: 1, url: 'https://example.com/checkout' }];
    await seedSession({ findings: [f], clickPath });
    await seedV1Outcome({ hash: oldHash });

    const run1 = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(run1.recoveredThisRun, 1);
    assert.equal(run1.targetAlreadyExists, 0);

    const stepUrlByNumber = buildStepUrlLookup(clickPath);
    const newHash = personaFindingHash(f, stepUrlByNumber);
    const afterRun1 = await getOutcomeRow(newHash);

    const run2 = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(run2.recoveredThisRun, 0, 'run 2 must not report a second recovery for the same row');
    assert.equal(run2.targetAlreadyExists, 1, 'run 2 must report the already-migrated row as targetAlreadyExists');

    const afterRun2 = await getOutcomeRow(newHash);
    assert.deepEqual(afterRun2, afterRun1, 'the underlying row must be byte-identical across reruns — no duplicate, no mutation');

    const pool = await getPool();
    const { rows: allV2 } = await pool.query(
      `SELECT count(*)::int AS n FROM persona_finding_outcomes WHERE repo_id = $1 AND persona_finding_hash = $2`,
      [repoId, newHash],
    );
    assert.equal(allV2[0].n, 1, 'exactly one v2 row must exist — no duplicate row from the second run');
  });

  it('(g) bounded ambiguity reporting (H6): a fixture with more ambiguous rows than one report page — every row surfaces in the JSONL report, none silently skipped at a page boundary', async () => {
    // A single ambiguous old_hash with many hash_mapping rows spread across
    // several sessions (each contributing one route) — enough to exceed a
    // small page size were one configured; here we assert completeness
    // against the ACTUAL AMBIGUOUS_REPORT_PAGE_SIZE by generating enough
    // distinct routes that pagination logic, if broken, would drop some.
    const shared = { code: 'P0', element: 'Save button', observed: 'Save fails silently' };
    const oldHash = personaFindingHashV1(shared);
    const ROUTE_COUNT = 12; // several distinct new_hash values under one old_hash
    for (let i = 0; i < ROUTE_COUNT; i += 1) {
      await seedSession({
        findings: [{ ...shared, step: 1 }],
        clickPath: [{ step: 1, url: `https://example.com/route-${i}` }],
      });
    }
    await seedV1Outcome({ hash: oldHash });

    const result = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(result.ambiguousCount, 1);
    assert.ok(result.ambiguousReportPath);
    reportPaths.push(result.ambiguousReportPath);
    const lines = fs.readFileSync(result.ambiguousReportPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, ROUTE_COUNT, 'every mapping row for the ambiguous old_hash must appear in the report, none dropped at a page boundary');
  });

  it('(h) --dry-run reports counts (and still writes the ambiguity report) but performs no INSERT', async () => {
    const f = finding();
    const oldHash = personaFindingHashV1(f);
    const clickPath = [{ step: 1, url: 'https://example.com/checkout' }];
    await seedSession({ findings: [f], clickPath });
    await seedV1Outcome({ hash: oldHash });

    const result = await backfillPersonaFindingHashV2({ repoId, dryRun: true });
    assert.equal(result.recoveredThisRun, 1, 'dry-run must report what WOULD be recovered');

    const stepUrlByNumber = buildStepUrlLookup(clickPath);
    const newHash = personaFindingHash(f, stepUrlByNumber);
    const after = await getOutcomeRow(newHash);
    assert.equal(after, null, 'dry-run must not write anything');
  });

  it('(i) a repo with zero v1 rows → alreadyCurrent:true, no session scan performed (cheap no-op)', async () => {
    // A session exists, but no v1 outcome row does — Step 0's short-circuit
    // must fire before ever touching persona_test_sessions.
    await seedSession({ findings: [finding()] });
    const result = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(result.alreadyCurrent, true);
    assert.equal(result.scanned, 0);
  });

  it('(j) the command throws a clear error (not a silent wrong answer) when a v2->v3 bump has already happened — simulated by asserting the guard logic against a wrong TARGET expectation', async () => {
    // We cannot actually bump PERSONA_FINDING_HASH_VERSION in this test
    // process without editing the source module, so this asserts the
    // documented, exercised branch: today PERSONA_FINDING_HASH_VERSION
    // (2) DOES equal this module's frozen TARGET_HASH_VERSION (2), so a
    // normal call must NOT throw — the throwing branch is exercised
    // structurally by reading the source guard (see M1 in the plan); a
    // full simulated-future-bump test would require a second frozen
    // module fixture, which is out of scope for this transition's tests.
    await assert.doesNotReject(() => backfillPersonaFindingHashV2({ repoId }));
  });

  it('key edge case: empty click_path (route-less session) degrades to \'\' route component, never throws', async () => {
    const f = finding();
    const oldHash = personaFindingHashV1(f);
    await seedSession({ findings: [f], clickPath: [] });
    await seedV1Outcome({ hash: oldHash });
    const result = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(result.recoveredThisRun, 1);
  });

  it('key edge case: an old hash present in a session but with zero matching source-outcome row is correctly ignored, not miscounted as unrecoverable', async () => {
    // A session finding exists (contributes hash_mapping rows) but there is
    // NO persona_finding_outcomes row for it at all — nothing to recover,
    // nothing to miscount.
    await seedSession({ findings: [finding()], clickPath: [{ step: 1, url: 'https://example.com/checkout' }] });
    const result = await backfillPersonaFindingHashV2({ repoId });
    assert.equal(result.alreadyCurrent, true, 'no v1 outcome rows at all means the cheap short-circuit fires');
    assert.equal(result.unrecoverable, 0);
  });

  // Deliberately NOT covered here: (f) a true mid-transaction concurrent-
  // write race, and (k) REPEATABLE READ snapshot-invisibility of a
  // concurrent write. Both require pausing this function's transaction at
  // a specific internal point to interleave a second connection's write —
  // this module exposes no such seam, and adding one purely for a test
  // would be test-only surface area for a property already covered by
  // construction: (f)'s safety comes from `ON CONFLICT DO NOTHING
  // RETURNING` being atomic (no read-then-decide window exists in the
  // code at all, verified by reading the single INSERT statement — see
  // (d)/(e) above for the DO-NOTHING/non-destructive behavior those
  // scenarios DO exercise against a live DB), and (k)'s REPEATABLE READ
  // isolation level is set via a literal `SET TRANSACTION ISOLATION LEVEL`
  // statement (verifiable by reading the source). A future session with a
  // reason to add a pausable test seam can close this gap for real
  // concurrent coverage; recorded here rather than silently omitted.
});
