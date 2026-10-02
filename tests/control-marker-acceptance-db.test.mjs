/**
 * @fileoverview A control-state marker can never become an ACCEPTED
 * obligation — proven on real Postgres, end to end.
 *
 * The adjacency wave's coverage notice (`ADJACENCY_INCOMPLETE …`) is machine
 * control state, not a finding about code. `splitPendingFindings` routes an
 * UN-ruled one to `auto_dismissed`, but a ledger that ruled it `accepted`
 * bypassed that split entirely: `recordAdjudicationEvent` wrote
 * `adjudication_outcome = 'accepted'`, and it surfaced in
 * `unremediated_acceptances_all` as something owed a fix. Measured on the live
 * store 2026-10-02: 34 control markers carried `accepted`, 3 of them still
 * open in the view.
 *
 * Two halves, both needing a real schema:
 *   1. The write path (`finalizeRoundOutcomes` driving the REAL store
 *      functions) leaves an accepted control marker `auto_dismissed`, with no
 *      adjudication event, and absent from the view — while a real finding the
 *      same ledger accepts IS in the view (the negative control: without it, an
 *      empty view would pass for the wrong reason).
 *   2. Migration 20261002120000 repairs rows written before the fix, is
 *      idempotent, and leaves a human-set `user_action` alone.
 *
 * INC-002: gated on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';
const MIGRATION = path.resolve('supabase/migrations/20261002120000_control_marker_accepted_obligation_repair.sql');
const CONTROL_DETAIL = 'ADJACENCY_INCOMPLETE (input-bound): 91 changed files exceeds maxChangedFiles=60';
const CONTROL_CATEGORY = '[Adjacency] coverage incomplete — control did not fully run';

describe('control markers never become accepted obligations (DB integration)', { skip }, () => {
  let q, store, finalize, generateTopicId, repoId, runId, savedUrl, tmp, cwd0;

  before(async () => {
    const client = await import('../scripts/lib/db/client.mjs');
    savedUrl = process.env.AUDIT_DB_URL;
    client.assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    await client._resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    store = await import('../scripts/lib/store/runs-findings.mjs');
    ({ finalizeRoundOutcomes: finalize } = await import('../scripts/lib/finalize-outcomes.mjs'));
    ({ generateTopicId } = await import('../scripts/lib/ledger.mjs'));

    // finalize appends local bandit outcomes under cwd/.audit — keep it out of the repo.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrl-marker-db-'));
    fs.mkdirSync(path.join(tmp, '.audit'), { recursive: true });
    cwd0 = process.cwd();
    process.chdir(tmp);

    repoId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [repoId, `test-${repoId.slice(0, 8)}`]);
    await q.query(
      `INSERT INTO audit_runs (id, repo_id, plan_file, mode, created_at)
       VALUES ($1, $2, 'docs/plans/test-fixture.md', 'code', now() - interval '10 days')`, [runId, repoId]);
  });

  after(async () => {
    if (cwd0) process.chdir(cwd0);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    if (!q) return;
    await q.query('DELETE FROM finding_adjudication_events WHERE finding_id IN (SELECT id FROM audit_findings WHERE run_id = $1)', [runId]);
    await q.query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = savedUrl;
  });

  /** Seed one finding row directly; returns its id. */
  async function seedRow(fp, { detail, category = 'test', outcome = null, remediation = null, userAction = null, withEvent = false }) {
    const row = await q.one(
      `INSERT INTO audit_findings
         (run_id, finding_fingerprint, pass_name, severity, category, primary_file, detail_snapshot,
          round_raised, adjudication_outcome, remediation_state, user_action)
       VALUES ($1, $2, 'adjacency', 'MEDIUM', $3, 'diff', $4, 1, $5, $6, $7) RETURNING id`,
      [runId, fp, category, detail, outcome, remediation, userAction]);
    if (withEvent) {
      await q.query(
        `INSERT INTO finding_adjudication_events (finding_id, adjudication_outcome, remediation_state, ruling, round)
         VALUES ($1, $2, $3, 'sustain', 1)`, [row.id, outcome, remediation ?? 'pending']);
    }
    return row.id;
  }

  const readRow = (id) => q.one(
    `SELECT adjudication_outcome, remediation_state, user_action, decided_at,
            (SELECT count(*)::int FROM finding_adjudication_events e WHERE e.finding_id = f.id) AS events,
            EXISTS (SELECT 1 FROM unremediated_acceptances_all v WHERE v.audit_finding_id = f.id) AS in_view
       FROM audit_findings f WHERE f.id = $1`, [id]);

  test('write path: a ledger-accepted control marker lands auto_dismissed, off the obligation view', async () => {
    const ctrlFp = `ctrl-${crypto.randomUUID().slice(0, 8)}`;
    const realFp = `real-${crypto.randomUUID().slice(0, 8)}`;
    const ctrlId = await seedRow(ctrlFp, { detail: CONTROL_DETAIL, category: CONTROL_CATEGORY });
    const realId = await seedRow(realFp, { detail: 'a.mjs:12 reads a stale cache entry after invalidation' });

    const findings = [
      { id: 'M1', _hash: ctrlFp, severity: 'MEDIUM', category: CONTROL_CATEGORY, section: 'diff', detail: CONTROL_DETAIL, _pass: 'adjacency' },
      { id: 'M2', _hash: realFp, severity: 'MEDIUM', category: 'test', section: 'a.mjs', detail: 'a.mjs:12 reads a stale cache entry after invalidation', _pass: 'adjacency' },
    ];
    const ledger = { entries: findings.map(f => ({
      topicId: generateTopicId(f), adjudicationOutcome: 'accepted', remediationState: 'pending', ruling: 'sustain',
    })) };
    await finalize({
      result: { findings, _cloudRunId: runId }, ledger, round: 1, sid: runId,
      store: {
        recordAdjudicationEvent: store.recordAdjudicationEvent,
        updatePassStatsPostDeliberation: store.updatePassStatsPostDeliberation,
        updateRunMeta: store.updateRunMeta,
      },
    });

    const real = await readRow(realId);
    assert.equal(real.adjudication_outcome, 'accepted', 'negative control: the real finding must be accepted');
    assert.equal(real.in_view, true, 'negative control: a real accepted finding IS an obligation');

    const ctrl = await readRow(ctrlId);
    assert.equal(ctrl.adjudication_outcome, null, 'a control marker must carry no adjudication outcome');
    assert.equal(ctrl.events, 0, 'no adjudication event may be recorded for it');
    assert.equal(ctrl.user_action, 'auto_dismissed', 'it must take the auto-dismiss route');
    assert.equal(ctrl.in_view, false, 'a control marker must never be an obligation');
  });

  test('migration repairs a pre-fix accepted control marker, and is idempotent', async () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const brokenId = await seedRow(`old-${crypto.randomUUID().slice(0, 8)}`,
      { detail: CONTROL_DETAIL, category: CONTROL_CATEGORY, outcome: 'accepted', remediation: 'planned', withEvent: true });
    const humanId = await seedRow(`hum-${crypto.randomUUID().slice(0, 8)}`,
      { detail: CONTROL_DETAIL, category: CONTROL_CATEGORY, outcome: 'accepted', remediation: 'pending', userAction: 'fix-now', withEvent: true });
    const fixedId = await seedRow(`fix-${crypto.randomUUID().slice(0, 8)}`,
      { detail: CONTROL_DETAIL, category: CONTROL_CATEGORY, outcome: 'accepted', remediation: 'fixed', withEvent: true });
    const realId = await seedRow(`rl-${crypto.randomUUID().slice(0, 8)}`,
      { detail: 'b.mjs:4 swallows the write error', outcome: 'accepted', remediation: 'pending', withEvent: true });

    // Positive control: the broken row really is in the view before the repair.
    assert.equal((await readRow(brokenId)).in_view, true, 'fixture must reproduce the defect, or the repair proves nothing');

    await q.query(sql);
    const repaired = await readRow(brokenId);
    assert.deepEqual(
      { ...repaired, decided_at: repaired.decided_at === null ? null : 'set' },
      { adjudication_outcome: null, remediation_state: null, user_action: 'auto_dismissed', decided_at: null, events: 0, in_view: false },
      'the repaired row must be exactly what the fixed write path produces');

    const human = await readRow(humanId);
    assert.equal(human.user_action, 'fix-now', 'a human-set user_action is never clobbered');
    assert.equal(human.adjudication_outcome, 'accepted');
    const fixed = await readRow(fixedId);
    assert.equal(fixed.adjudication_outcome, 'accepted', 'an already-remediated row is not an obligation and is left as history');
    assert.equal(fixed.events, 1);
    const real = await readRow(realId);
    assert.equal(real.adjudication_outcome, 'accepted', 'a real finding is never touched');
    assert.equal(real.in_view, true);

    await q.query(sql); // second application must be a no-op
    assert.deepEqual(await readRow(brokenId), repaired, 'second run must change nothing');
    assert.equal((await readRow(realId)).in_view, true);
  });
});
