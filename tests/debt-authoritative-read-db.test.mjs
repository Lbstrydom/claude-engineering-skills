/**
 * @fileoverview The debt REPORTING CLIs read the private store, not the local
 * cache — against a real Postgres.
 *
 * Measured 2026-10-11: the store held 315 entries and this machine's
 * `.audit/tech-debt.json` held 67, so `debt-health-check` reported 67 (or
 * UNVERIFIABLE in a linked worktree, where the cache is absent) and
 * `debt-review` ranked a different file first than the store's own entries
 * do. `loadAuthoritativeDebt` (scripts/lib/debt-memory.mjs) was written for
 * exactly this on 2026-09-04 and had no caller. A mocked store would only
 * restate the assumption under test; this seeds real `debt_entries` and
 * `debt_events` rows and spawns the real CLIs with NO local cache at all.
 *
 * INC-002 (docs/security-strategy.md): gated on `assertDisposableDbUrl`,
 * never on "is AUDIT_DB_TEST_URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

const HEALTH = path.resolve('scripts/debt-health-check.mjs');
const REVIEW = path.resolve('scripts/debt-review.mjs');
const TOPICS = ['a0a0a0a0a0a1', 'a0a0a0a0a0a2', 'a0a0a0a0a0a3'];

function makeDebtRow(topicId, file) {
  return {
    source: 'debt',
    topicId,
    semanticHash: `h${topicId.slice(-4)}`,
    severity: 'HIGH',
    category: 'authoritative-read test',
    section: `${file}:1`,
    detailSnapshot: 'a debt entry seeded by the authoritative-read DB suite',
    affectedFiles: [file],
    affectedPrinciples: [],
    pass: 'backend',
    classificationUnavailableReason: 'not-provided-by-capture-source',
    deferredReason: 'out-of-scope',
    deferredAt: new Date().toISOString(),
    deferredRun: 'db-test',
    deferredRationale: 'a sufficiently long rationale for the schema minimum',
    contentAliases: [],
    sensitive: false,
  };
}

function run(script, args) {
  return spawnSync('node', [script, ...args], {
    encoding: 'utf-8', cwd: path.resolve('.'),
    env: { ...process.env, AUDIT_DB_URL: TEST_URL },
  });
}

describe('debt CLIs read the private store (DB integration)', { skip }, () => {
  let q, repoId, tmpDir, absentLedger, cacheLedger;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    const { resolveRepoForStore } = await import('../scripts/learning-store.mjs');
    const { generateRepoProfile } = await import('../scripts/lib/context.mjs');
    const { upsertDebtEntries, appendDebtEventsCloud } = await import('../scripts/lib/store/debt.mjs');

    // The SAME resolution the spawned CLIs perform, so the rows land under the
    // repo id they will ask about.
    repoId = (await resolveRepoForStore({ profile: generateRepoProfile() }))?.repoRowId;
    assert.ok(repoId, 'repo identity must resolve in the disposable store');
    await q.query('DELETE FROM debt_events WHERE repo_id = $1', [repoId]);
    await q.query('DELETE FROM debt_entries WHERE repo_id = $1', [repoId]);

    const up = await upsertDebtEntries(repoId, TOPICS.map((t) => makeDebtRow(t, 'scripts/lib/debt-memory.mjs')));
    assert.equal(up.ok, true, `seed failed: ${JSON.stringify(up)}`);
    // Three distinct runs surfacing ONE topic — recurrence lives only in the
    // store's events, so a CLI that hydrates store rows from the local event
    // log reports it as 0.
    await appendDebtEventsCloud(repoId, ['r1', 'r2', 'r3'].map((runId, i) => ({
      ts: new Date(Date.now() - (3 - i) * 60_000).toISOString(), runId, topicId: TOPICS[0], event: 'surfaced',
    })));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-auth-read-'));
    absentLedger = path.join(tmpDir, 'absent', 'tech-debt.json');
    cacheLedger = path.join(tmpDir, 'tech-debt.json');
    fs.writeFileSync(cacheLedger, JSON.stringify({ version: 1, entries: [makeDebtRow(TOPICS[0], 'scripts/lib/debt-memory.mjs')] }));
  });

  after(async () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
    if (!q) return;
    try {
      await q.query('DELETE FROM debt_events WHERE repo_id = $1', [repoId]);
      await q.query('DELETE FROM debt_entries WHERE repo_id = $1', [repoId]);
    } finally {
      const { closePool } = await import('../scripts/lib/db/client.mjs');
      await closePool();
    }
  });

  test('debt-health-check counts the store\'s entries with NO local cache present', () => {
    const r = run(HEALTH, ['--json', '--ledger', absentLedger]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.source, 'cloud', `stderr: ${r.stderr}`);
    assert.equal(out.available, true);
    assert.equal(out.totalEntries, TOPICS.length);
  });

  test('recurrence is hydrated from the STORE\'s events', () => {
    const r = run(HEALTH, ['--json', '--ledger', absentLedger]);
    assert.deepEqual(JSON.parse(r.stdout).recurring, [TOPICS[0]]);
  });

  test('a diverging local cache is named, never substituted for the store', () => {
    const r = run(HEALTH, ['--ledger', cacheLedger]);
    assert.match(r.stdout, /\(private store\): 3 open entries/);
    assert.match(r.stdout, /Local cache holds 1/);
  });

  test('--no-cloud reads the cache alone, labelled not authoritative — negative control', () => {
    const r = run(HEALTH, ['--json', '--no-cloud', '--ledger', cacheLedger]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.source, 'local');
    assert.equal(out.totalEntries, 1);
  });

  test('debt-review ranks the store\'s entries and says so', () => {
    const r = run(REVIEW, ['--local-only', '--ledger', absentLedger]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /\*\*Source\*\*: private store/);
    assert.match(r.stdout, /\*\*Entries\*\*: 3/);
    assert.doesNotMatch(r.stdout, /UNVERIFIABLE/);
  });
});
