/**
 * @fileoverview Audit telemetry capture against a real Postgres
 * (docs/plans/audit-telemetry-capture.md; migration 20261029120000).
 *
 * Enrolled in scripts/db-test-container.mjs ISOLATED_SUITE_FILES AND
 * .github/workflows/postgres-parity.yml - two edits, always.
 * INC-002: gated on `assertDisposableDbUrl`, never on "is the URL set".
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('audit telemetry capture (DB integration)', { skip }, () => {
  let q, rf, repoId;
  const tag = crypto.randomUUID().slice(0, 8);
  const runIds = [];

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    rf = await import('../scripts/lib/store/runs-findings.mjs');
    repoId = crypto.randomUUID();
    await q.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2)', [repoId, `capture-${tag}`]);
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM finding_adjudication_events WHERE finding_id IN (SELECT id FROM audit_findings WHERE run_id = ANY($1::uuid[]))', [runIds]);
    await q.query('DELETE FROM audit_findings WHERE run_id = ANY($1::uuid[])', [runIds]);
    await q.query('DELETE FROM audit_runs WHERE id = ANY($1::uuid[])', [runIds]);
    await q.query('DELETE FROM audit_repos WHERE name = $1', [`capture-other-${tag}`]);
    await q.query('DELETE FROM audit_runs WHERE repo_id = $1', [repoId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  async function start(opts) {
    const id = await rf.recordRunStart(repoId, 'docs/plans/x.md', 'code', opts);
    runIds.push(id);
    return q.one('SELECT audit_session_id, audit_round, capture_epoch FROM audit_runs WHERE id = $1', [id]);
  }

  // Phase 1: session identity and epoch
  {
    test('P1: two rounds of one session share the session id and get rounds 1 and 2; both carry the epoch', async () => {
      const a = await start({ auditSessionId: 'sess-1', auditRound: 1 });
      const b = await start({ auditSessionId: 'sess-1', auditRound: 2 });
      assert.equal(a.audit_session_id, 'sess-1');
      assert.equal(b.audit_session_id, 'sess-1');
      assert.deepEqual([a.audit_round, b.audit_round], [1, 2]);
      assert.equal(a.capture_epoch, 'capture-v1');
    });

    test('P1: an arm run (round null) and a unified run (explicit runId) carry no round', async () => {
      const arm = await start({ auditSessionId: 'bake-1', auditRound: null });
      assert.equal(arm.audit_round, null);
      assert.equal(arm.audit_session_id, 'bake-1');
      const unified = await start({ auditSessionId: 'sess-2', auditRound: 1, runId: crypto.randomUUID() });
      assert.equal(unified.audit_round, null);
    });

    test('P1: no identity: the run is stamped with the epoch but stays unlinked (never guessed)', async () => {
      const r = await start({});
      assert.equal(r.audit_session_id, null);
      assert.equal(r.audit_round, null);
      assert.equal(r.capture_epoch, 'capture-v1');
    });

    test('P1: the migration is idempotent (applied twice)', async () => {
      const sql = fs.readFileSync(path.resolve('supabase/migrations/20261029120000_audit_capture_v1.sql'), 'utf8');
      await q.query(sql);
      await q.query(sql);
    });
  }
  // Phase 2: source model on findings
  {
    const finding = (hash, extra = {}) => ({ _hash: hash, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'd', ...extra });
    const modelOf = (runId, hash) => q.one('SELECT source_model FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2', [runId, hash]);

    test('P2: a re-record with a null _sourceModel keeps gpt-6.1-terra (a set value is not nulled)', async () => {
      const runId = crypto.randomUUID();
      await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/x.md', 'code')`, [runId, repoId]);
      runIds.push(runId);
      const hash = `p2-${crypto.randomUUID().slice(0, 8)}`;
      await rf.recordFindings(runId, [finding(hash, { _sourceModel: 'gpt-6.1-terra' })], 'backend', 1);
      assert.equal((await modelOf(runId, hash)).source_model, 'gpt-6.1-terra');
      await rf.recordFindings(runId, [finding(hash)], 'backend', 1);
      assert.equal((await modelOf(runId, hash)).source_model, 'gpt-6.1-terra');
    });

    test('P2: a re-record with a different concrete model still updates it (negative control: COALESCE is not DO NOTHING)', async () => {
      const runId = crypto.randomUUID();
      await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/x.md', 'code')`, [runId, repoId]);
      runIds.push(runId);
      const hash = `p2b-${crypto.randomUUID().slice(0, 8)}`;
      await rf.recordFindings(runId, [finding(hash, { _sourceModel: 'gpt-6.1-sol' })], 'backend', 1);
      await rf.recordFindings(runId, [finding(hash, { _sourceModel: 'gpt-6.1-terra' })], 'backend', 1);
      assert.equal((await modelOf(runId, hash)).source_model, 'gpt-6.1-terra');
    });

    test('P2: recordRunComplete with a null geminiVerdict does not erase a verdict already written', async () => {
      const runId = crypto.randomUUID();
      await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode, gemini_verdict) VALUES ($1, $2, 'docs/plans/x.md', 'code', 'APPROVE')`, [runId, repoId]);
      runIds.push(runId);
      await rf.recordRunComplete(runId, { rounds: 1, totalFindings: 0, accepted: 0, dismissed: 0, fixed: 0, geminiVerdict: null });
      assert.equal((await q.one('SELECT gemini_verdict FROM audit_runs WHERE id = $1', [runId])).gemini_verdict, 'APPROVE');
      await rf.recordRunComplete(runId, { rounds: 1, totalFindings: 0, accepted: 0, dismissed: 0, fixed: 0, geminiVerdict: 'CONCERNS' });
      assert.equal((await q.one('SELECT gemini_verdict FROM audit_runs WHERE id = $1', [runId])).gemini_verdict, 'CONCERNS');
    });
  }
  // Phase 3: adjudication provenance
  {
    const newRun = async (sessionId, round) => {
      const id = await rf.recordRunStart(repoId, 'docs/plans/x.md', 'code', { auditSessionId: sessionId, auditRound: round });
      runIds.push(id);
      return id;
    };
    const addFinding = async (runId, hash, round) => {
      await rf.recordFindings(runId, [{ _hash: hash, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'd' }], 'backend', round);
      return q.one('SELECT id FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2', [runId, hash]);
    };
    const events = (findingId) => q.many('SELECT adjudicator_kind, adjudication_outcome, ruling_rationale, evidence FROM finding_adjudication_events WHERE finding_id = $1 ORDER BY adjudicator_kind, ruling_rationale', [findingId]);
    const pipelineEvent = (over = {}) => ({ adjudicationOutcome: 'dismissed', remediationState: 'pending', ruling: 'overrule', adjudicatorKind: 'pipeline', dismissReasonClass: 'unclassified', round: 1, ...over });
    const reviewerEvent = (reviewing, over = {}) => ({ adjudicationOutcome: 'accepted', remediationState: 'pending', ruling: 'overrule', adjudicatorKind: 'reviewer', round: 1, evidence: { reviewing_run_id: reviewing }, ...over });

    test('P3: the reviewer kind is accepted and an unknown kind is rejected by the CHECK', async () => {
      const runId = await newRun('p3-kind', 1);
      const f = await addFinding(runId, `p3k-${tag}`, 1);
      const ok = await rf.recordAdjudicationEvent(runId, `p3k-${tag}`, reviewerEvent(runId));
      assert.equal(ok.ok, true);
      assert.deepEqual((await events(f.id)).map((e) => e.adjudicator_kind), ['reviewer']);
      await assert.rejects(
        q.query(`INSERT INTO finding_adjudication_events (finding_id, adjudication_outcome, remediation_state, ruling, round, adjudicator_kind) VALUES ($1, 'accepted', 'pending', 'sustain', 1, 'bogus')`, [f.id]),
        (err) => err.code === '23514',
      );
      const refused = await rf.recordAdjudicationEvent(runId, `p3k-${tag}`, { adjudicationOutcome: 'accepted', ruling: 'sustain', adjudicatorKind: 'bogus', round: 1 });
      assert.equal(refused.reason, 'bad-input');
    });

    test('P3: a pipeline re-write replaces its own row and a reviewer row survives (kind-scoped delete)', async () => {
      const runId = await newRun('p3-delete', 1);
      const f = await addFinding(runId, `p3d-${tag}`, 1);
      await rf.recordAdjudicationEvent(runId, `p3d-${tag}`, pipelineEvent({ rulingRationale: 'first' }));
      await rf.recordAdjudicationEvent(runId, `p3d-${tag}`, reviewerEvent(runId));
      await rf.recordAdjudicationEvent(runId, `p3d-${tag}`, pipelineEvent({ rulingRationale: 'second' }));
      const rows = await events(f.id);
      assert.deepEqual(rows.map((e) => e.adjudicator_kind), ['pipeline', 'reviewer'], 'one pipeline row (no duplicate), reviewer intact');
      assert.equal(rows.find((e) => e.adjudicator_kind === 'pipeline').ruling_rationale, 'second');
    });

    test('P3: a reviewer rewrite replaces only the SAME reviewing run; a later review adds its own row', async () => {
      const runId = await newRun('p3-review', 1);
      const f = await addFinding(runId, `p3r-${tag}`, 1);
      await rf.recordAdjudicationEvent(runId, `p3r-${tag}`, reviewerEvent('rev-A', { rulingRationale: 'a1' }));
      await rf.recordAdjudicationEvent(runId, `p3r-${tag}`, reviewerEvent('rev-A', { rulingRationale: 'a2' }));
      await rf.recordAdjudicationEvent(runId, `p3r-${tag}`, reviewerEvent('rev-B', { rulingRationale: 'b1' }));
      assert.deepEqual((await events(f.id)).map((e) => e.ruling_rationale), ['a2', 'b1']);
    });

    test('P3: a reviewer event does not rewrite the finding outcome the pipeline set', async () => {
      const runId = await newRun('p3-outcome', 1);
      const f = await addFinding(runId, `p3o-${tag}`, 1);
      await rf.recordAdjudicationEvent(runId, `p3o-${tag}`, pipelineEvent());
      await rf.recordAdjudicationEvent(runId, `p3o-${tag}`, reviewerEvent(runId));
      assert.equal((await q.one('SELECT adjudication_outcome FROM audit_findings WHERE id = $1', [f.id])).adjudication_outcome, 'dismissed');
    });

    test('P3: a seeded secret in the rationale is redacted and the length is capped at the store boundary', async () => {
      const runId = await newRun('p3-redact', 1);
      const f = await addFinding(runId, `p3x-${tag}`, 1);
      await rf.recordAdjudicationEvent(runId, `p3x-${tag}`, pipelineEvent({ rulingRationale: `leaked sk-${'a1B2c3D4'.repeat(6)} ${'y'.repeat(3000)}` }));
      const [row] = await events(f.id);
      assert.ok(!row.ruling_rationale.includes('a1B2c3D4a1B2c3D4'));
      assert.ok(row.ruling_rationale.length <= 2000);
    });

    test('P3: reviewer events land on the SOURCE rows across rounds, with a complete receipt (3 presented, 1 reversal)', async () => {
      const { persistReviewerEvents } = await import('../scripts/lib/final-review/reviewer-events.mjs');
      const { presentedDismissals } = await import('../scripts/lib/audit/transcript.mjs');
      const { durableWrite } = await import('../scripts/lib/durable-write.mjs');
      await import('../scripts/lib/audit-store-writers.mjs');
      const capture = await import('../scripts/lib/store/capture-identity.mjs');
      const receipts = await import('../scripts/lib/store/write-receipts.mjs');

      const session = `p3-x-${tag}`;
      const r1 = await newRun(session, 1);
      const r2 = await newRun(session, 2);
      const reviewing = await newRun(session, null);
      const h = { a: `p3xa-${tag}`, b: `p3xb-${tag}`, c: `p3xc-${tag}` };
      const fa = await addFinding(r1, h.a, 1);
      const fb = await addFinding(r2, h.b, 2);
      const fc = await addFinding(r2, h.c, 2);
      const ledger = { entries: [
        { adjudicationOutcome: 'dismissed', latestFindingId: 'H1', resolvedRound: 1 },
        { adjudicationOutcome: 'dismissed', latestFindingId: 'H1', resolvedRound: 2 },
        { adjudicationOutcome: 'dismissed', latestFindingId: 'M2', resolvedRound: 2 },
      ] };
      const transcript = {
        presented_dismissals: presentedDismissals(ledger),
        rounds: [
          { round: 1, findings: [{ id: 'H1', _hash: h.a }] },
          { round: 2, findings: [{ id: 'H1', _hash: h.b }, { id: 'M2', _hash: h.c }] },
        ],
      };
      const deps = {
        captureV1Present: capture.captureV1Present, resolveSourceRun: capture.resolveSourceRun, hasFinding: capture.hasFinding,
        clearReviewerEvents: capture.clearReviewerEvents, durableWrite, recordWriteReceipt: receipts.recordWriteReceipt,
      };
      const out = await persistReviewerEvents({
        runId: reviewing, reviewRound: 1, primaryModel: 'gemini-test',
        result: { verdict: 'CONCERNS', wrongly_dismissed: [{ original_finding_id: 'R1 H1', reason_claude_was_wrong: 'real bug' }] },
        transcript, deps,
      });
      assert.equal(out.receipt.status, 'complete');
      assert.equal(out.receipt.presented, 3);
      assert.equal(out.receipt.presented_resolved, 3);
      assert.equal(out.receipt.reversals_written, 1);
      const written = await events(fa.id);
      assert.deepEqual(written.map((e) => [e.adjudicator_kind, e.adjudication_outcome]), [['reviewer', 'accepted']]);
      assert.equal(written[0].evidence.reviewing_run_id, reviewing);
      assert.equal((await events(fb.id)).length, 0);
      assert.equal((await events(fc.id)).length, 0);
      const stored = (await q.one('SELECT write_outcomes FROM audit_runs WHERE id = $1', [reviewing])).write_outcomes;
      assert.equal(stored.reviewer.status, 'complete');

      // An id outside the presented set is counted and the receipt reads incomplete (negative control).
      const bad = await persistReviewerEvents({
        runId: reviewing, reviewRound: 1, primaryModel: 'gemini-test',
        result: { verdict: 'CONCERNS', wrongly_dismissed: [{ original_finding_id: 'R5 H1', reason_claude_was_wrong: 'x' }] },
        transcript, deps,
      });
      assert.equal(bad.receipt.status, 'incomplete');
      assert.equal(bad.receipt.unresolved, 1);
      // The re-run no longer reverses R1 H1: the earlier reversal must not survive (replaced wholesale, keyed on the reviewing run).
      assert.equal((await events(fa.id)).length, 0, 'a reversal the re-run no longer makes is removed');

      // A transcript that never said what was presented is an unknown denominator, not an empty one.
      const unknown = await persistReviewerEvents({
        runId: reviewing, reviewRound: 1, primaryModel: 'gemini-test',
        result: { verdict: 'APPROVE', wrongly_dismissed: [] }, transcript: { rounds: transcript.rounds }, deps,
      });
      assert.equal(unknown.receipt.status, 'incomplete');
      assert.equal(unknown.receipt.reason, 'no-presented-set');

      // presented_resolved needs the FINDING to exist in the resolved run, not just the run.
      const ghost = { ...transcript, rounds: [{ round: 1, findings: [{ id: 'H1', _hash: `ghost-${tag}` }] }, transcript.rounds[1]] };
      const ghosted = await persistReviewerEvents({
        runId: reviewing, reviewRound: 1, primaryModel: 'gemini-test', result: { verdict: 'APPROVE', wrongly_dismissed: [] }, transcript: ghost, deps,
      });
      assert.equal(ghosted.receipt.presented, 3);
      assert.equal(ghosted.receipt.presented_resolved, 2);
      assert.equal(ghosted.receipt.status, 'incomplete');
    });

    test('P3: the outcome_sync receipt merges without erasing other write_outcomes keys', async () => {
      const receipts = await import('../scripts/lib/store/write-receipts.mjs');
      const runId = await newRun('p3-receipt', 1);
      await q.query(`UPDATE audit_runs SET write_outcomes = '{"written": 4}'::jsonb WHERE id = $1`, [runId]);
      const res = await receipts.recordWriteReceipt(runId, 'outcome_sync', { expected: 2, written: 2, spilled: 0, lost: 0 });
      assert.equal(res.applied, true);
      const stored = (await q.one('SELECT write_outcomes FROM audit_runs WHERE id = $1', [runId])).write_outcomes;
      assert.equal(stored.written, 4);
      assert.deepEqual(stored.outcome_sync, { expected: 2, written: 2, spilled: 0, lost: 0 });
      assert.equal((await receipts.recordWriteReceipt(runId, 'bogus-key', {})).reason, 'bad-input');
    });

    test('P3: an accumulated receipt SUMS batches, so a later clean batch cannot erase an earlier batch loss', async () => {
      const receipts = await import('../scripts/lib/store/write-receipts.mjs');
      const runId = await newRun('p3-accumulate', 1);
      await receipts.recordWriteReceipt(runId, 'equivalence', { expected: 2, written: 1, lost: 1 }, { accumulate: true });
      await receipts.recordWriteReceipt(runId, 'equivalence', { expected: 3, written: 3, lost: 0 }, { accumulate: true });
      const stored = (await q.one('SELECT write_outcomes FROM audit_runs WHERE id = $1', [runId])).write_outcomes.equivalence;
      assert.deepEqual([stored.expected, stored.written, stored.lost], [5, 4, 1]);
    });
  }
  // Phase 4: finding_equivalence
  {
    const mab = () => import('../scripts/lib/store/model-ab.mjs');
    const eqRow = (dup) => q.one('SELECT canonical_finding_id, created_by FROM finding_equivalence WHERE duplicate_finding_id = $1', [dup]);
    const seed = async (hash, repo = repoId) => {
      const runId = crypto.randomUUID();
      await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/x.md', 'code')`, [runId, repo]);
      runIds.push(runId);
      await rf.recordFindings(runId, [{ _hash: hash, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'd' }], 'backend', 1);
      return runId;
    };
    const cleanup = [];
    after(async () => {
      for (const h of cleanup) await q.query('DELETE FROM finding_equivalence WHERE duplicate_finding_id = $1 OR canonical_finding_id = $1', [h]);
    });

    test('P4: a link round-trips and its root resolution matches the duplicate (chain A <- B <- C stores root A)', async () => {
      const { recordEquivalence } = await mab();
      const [a, b, c] = ['a', 'b', 'c'].map((x) => `p4chain${x}-${tag}`);
      cleanup.push(a, b, c);
      await seed(a); await seed(b); const runC = await seed(c);
      assert.equal((await recordEquivalence({ duplicateFingerprint: b, canonicalFingerprint: a, createdBy: 'concern-v1' })).outcome, 'written');
      const second = await recordEquivalence({ duplicateFingerprint: c, canonicalFingerprint: b, runId: runC, createdBy: 'semantic-suppress' });
      assert.equal(second.outcome, 'written');
      assert.equal(second.root, a);
      assert.deepEqual(await eqRow(c), { canonical_finding_id: a, created_by: 'semantic-suppress' });
    });

    test('P4: a missing endpoint, a cross-repo endpoint, a fingerprint in two repos and a cycle are each skipped and named', async () => {
      const { recordEquivalence } = await mab();
      const [x, y, other, shared, cyc1, cyc2] = ['x', 'y', 'o', 's', 'c1', 'c2'].map((n) => `p4skip${n}-${tag}`);
      cleanup.push(x, y, other, shared, cyc1, cyc2);
      await seed(x);
      const otherRepo = crypto.randomUUID();
      await q.query('INSERT INTO audit_repos (id, name) VALUES ($1, $2)', [otherRepo, `capture-other-${tag}`]);
      await seed(other, otherRepo);
      await seed(y);
      // missing endpoint
      assert.equal((await recordEquivalence({ duplicateFingerprint: x, canonicalFingerprint: `nope-${tag}`, createdBy: 'concern-v1' })).outcome, 'skipped:endpoint');
      // cross-repo
      assert.equal((await recordEquivalence({ duplicateFingerprint: x, canonicalFingerprint: other, createdBy: 'concern-v1' })).outcome, 'skipped:endpoint');
      // a fingerprint that appears in two repos
      await seed(shared); await seed(shared, otherRepo);
      assert.equal((await recordEquivalence({ duplicateFingerprint: x, canonicalFingerprint: shared, createdBy: 'concern-v1' })).outcome, 'skipped:ambiguous-repo');
      // cycle: y -> x written, then x -> y would close the loop; self-link too
      assert.equal((await recordEquivalence({ duplicateFingerprint: y, canonicalFingerprint: x, createdBy: 'concern-v1' })).outcome, 'written');
      assert.equal((await recordEquivalence({ duplicateFingerprint: x, canonicalFingerprint: y, createdBy: 'concern-v1' })).outcome, 'skipped:cycle');
      assert.equal((await recordEquivalence({ duplicateFingerprint: x, canonicalFingerprint: x, createdBy: 'concern-v1' })).outcome, 'skipped:cycle');
      assert.equal(await eqRow(x), null, 'no row was written for any refused link');
    });

    test('P4: a manual link survives an automatic upsert; an automatic one is replaced by a later automatic one', async () => {
      const { recordEquivalence, applyModelAbAdjudication } = await mab();
      const [m1, m2, m3] = ['m1', 'm2', 'm3'].map((n) => `p4man${n}-${tag}`);
      cleanup.push(m1, m2, m3);
      const runDup = await seed(m1); await seed(m2); await seed(m3);
      await applyModelAbAdjudication({ runId: runDup, fingerprint: m1, action: 'duplicate', canonicalFingerprint: m2, actor: 'louis' });
      assert.equal((await eqRow(m1)).created_by, 'louis');
      assert.equal((await recordEquivalence({ duplicateFingerprint: m1, canonicalFingerprint: m3, createdBy: 'semantic-suppress' })).outcome, 'skipped:manual');
      assert.deepEqual(await eqRow(m1), { canonical_finding_id: m2, created_by: 'louis' });
      // automatic over automatic is allowed
      const [p, r1, r2] = ['auto-p', 'auto-r1', 'auto-r2'].map((n) => `p4${n}-${tag}`);
      cleanup.push(p, r1, r2);
      await seed(p); await seed(r1); await seed(r2);
      await recordEquivalence({ duplicateFingerprint: p, canonicalFingerprint: r1, createdBy: 'concern-v1' });
      assert.equal((await recordEquivalence({ duplicateFingerprint: p, canonicalFingerprint: r2, createdBy: 'semantic-suppress' })).outcome, 'written');
      assert.equal((await eqRow(p)).canonical_finding_id, r2);
    });

    test('P4: the manual duplicate with no canonical outcome leaves the duplicate outcome NULL, not the literal pending', async () => {
      const { applyModelAbAdjudication } = await mab();
      const [d, c] = ['nulld', 'nullc'].map((n) => `p4${n}-${tag}`);
      cleanup.push(d, c);
      const runD = await seed(d); await seed(c);
      const res = await applyModelAbAdjudication({ runId: runD, fingerprint: d, action: 'duplicate', canonicalFingerprint: c, actor: 'louis' });
      assert.equal(res.ok, true);
      assert.equal((await q.one('SELECT adjudication_outcome FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2', [runD, d])).adjudication_outcome, null);
    });

    test('P4: durableWrite audit.equivalence tallies outcomes and the equivalence receipt lands on the run', async () => {
      const { recordEquivalenceLinks } = await import('../scripts/lib/audit/equivalence-links.mjs');
      const { durableWrite } = await import('../scripts/lib/durable-write.mjs');
      await import('../scripts/lib/audit-store-writers.mjs');
      const receipts = await import('../scripts/lib/store/write-receipts.mjs');
      const [d, c] = ['rcd', 'rcc'].map((n) => `p4${n}-${tag}`);
      cleanup.push(d, c);
      const runD = await seed(d); await seed(c);
      const tally = await recordEquivalenceLinks({
        runId: runD, createdBy: 'concern-v1', deps: { durableWrite, recordWriteReceipt: receipts.recordWriteReceipt },
        links: [
          { duplicateFingerprint: d, canonicalFingerprint: c },
          { duplicateFingerprint: d, canonicalFingerprint: `missing-${tag}` },
        ],
      });
      assert.equal(tally.expected, 2);
      assert.equal(tally.written, 1);
      assert.equal(tally['skipped:endpoint'], 1);
      const stored = (await q.one('SELECT write_outcomes FROM audit_runs WHERE id = $1', [runD])).write_outcomes;
      assert.equal(stored.equivalence.written, 1);
    });
  }
  // Phase 5: coverage SQL
  test('P5: every new coverage entry measures on a real Postgres (the predicate SQL is valid)', async () => {
    const { buildMeasureSql } = await import('../scripts/lib/telemetry/coverage.mjs');
    const config = JSON.parse(fs.readFileSync(path.resolve('.own-model-coverage.json'), 'utf8'));
    const wanted = new Set(['audit_session_id', 'capture_epoch', 'source_model', 'ruling_rationale', 'adjudicator_model', 'canonical_finding_id']);
    const entries = config.entries.filter((e) => wanted.has(e.column));
    assert.ok(entries.length >= 7, 'vacuous-pass guard: the new entries must be present');
    for (const e of entries) {
      const { sql, params } = buildMeasureSql(e, config.windowDays);
      const row = await q.one(sql, params);
      assert.ok(Number.isInteger(row.total) && Number.isInteger(row.filled), `${e.table}.${e.column} must measure`);
    }
  });
  // Phase 5: the query recipes are executable
  {
    const DOC = fs.readFileSync(path.resolve('docs/reference/audit-telemetry-queries.md'), 'utf8');
    const block = (name) => {
      const m = DOC.match(new RegExp(`<!-- sql:${name}:start -->\\s*\`\`\`sql\\n([\\s\\S]*?)\`\`\`\\s*<!-- sql:${name}:end -->`));
      assert.ok(m, `doc block ${name} must exist`);
      return m[1].replaceAll(':epochs', "'{capture-v1}'::text[]");
    };
    const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

    test('P5: the doc inlines the SAME terminal-state CASE in the concerns view (the two cannot drift)', () => {
      assert.ok(norm(block('capture-concerns')).includes(norm(block('terminal-state').replaceAll('f.user_action', 'f.user_action'))));
    });

    test('P5: terminal-state mapping, one fixture per row of the mapping', async () => {
      const cases = [
        [null, 'auto_dismissed', null], ['accepted', null, 'accepted'], [null, 'accepted-permanent', 'accepted'],
        ['dismissed', null, 'dismissed'], ['severity_adjusted', null, 'severity_adjusted'],
        [null, null, 'open'], ['pending', null, 'open'], ['needs_triage', null, 'open'], ['weird', null, 'unknown'],
      ];
      const values = cases.map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::text)`).join(', ');
      const rows = await q.many(
        `SELECT (${block('terminal-state')}) AS state FROM (VALUES ${values}) AS f(adjudication_outcome, user_action)`,
        cases.flatMap(([o, u]) => [o, u]),
      );
      assert.deepEqual(rows.map((r) => r.state), cases.map((c) => c[2]));
    });

    test('P5: reviewer-vs-ledger run agreement, one fixture per row of the table', async () => {
      const cases = [
        ['APPROVE', true, 'agree'], ['REJECT', false, 'agree'], ['REJECT', true, 'disagree'], ['APPROVE', false, 'disagree'],
        [null, true, 'unknown'], ['CONCERNS', true, 'unknown'], ['CONCERNS_REMAINING', false, 'unknown'],
      ];
      const values = cases.map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::boolean)`).join(', ');
      const rows = await q.many(
        `SELECT (${block('c-run-agreement')}) AS result FROM (VALUES ${values}) AS v(gemini_verdict, converged)`,
        cases.flatMap(([v, c]) => [v, c]),
      );
      assert.deepEqual(rows.map((r) => r.result), cases.map((c) => c[2]));
    });

    test('P5: every recipe executes, and a seeded two-round session yields the expected re-raise and reopen rates', async () => {
      const session = `p5-${tag}`;
      const complete = async (round, hash, outcome) => {
        const id = await rf.recordRunStart(repoId, 'docs/plans/x.md', 'code', { auditSessionId: session, auditRound: round });
        runIds.push(id);
        await rf.recordFindings(id, [{ _hash: hash, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'd', _sourceModel: 'gpt-6.1-terra' }], 'backend', round);
        await q.query(`UPDATE audit_runs SET run_status = 'complete' WHERE id = $1`, [id]);
        if (outcome) await q.query(`UPDATE audit_findings SET adjudication_outcome = $2 WHERE run_id = $1`, [id, outcome]);
        return id;
      };
      // Round 1 dismisses concern X; round 2 re-raises X (a reopen) and raises a fresh concern Y.
      await complete(1, `p5x-${tag}`, 'dismissed');
      const r2 = await rf.recordRunStart(repoId, 'docs/plans/x.md', 'code', { auditSessionId: session, auditRound: 2 });
      runIds.push(r2);
      await rf.recordFindings(r2, [
        { _hash: `p5x-${tag}`, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'd' },
        { _hash: `p5y-${tag}`, _bucket: null, severity: 'HIGH', category: 'test', section: 'y', detail: 'd' },
      ], 'backend', 2);
      await q.query(`UPDATE audit_runs SET run_status = 'complete' WHERE id = $1`, [r2]);

      await q.withTx(async () => {
        await q.query(block('capture-rounds'));
        await q.query(block('capture-concerns'));
        const scoped = (sql) => sql.replace('FROM capture_concerns GROUP BY', `FROM capture_concerns WHERE audit_session_id = '${session}' GROUP BY`);
        const reraise = await q.one(scoped(block('reraise-rate')));
        assert.equal(Number(reraise.concerns), 2);
        assert.equal(Number(reraise.reraise_rate), 0.5, 'X seen in 2 rounds, Y in 1');
        const reopen = await q.one(block('reopen-rate').replace('GROUP BY 1, 2)', 'GROUP BY 1, 2)'));
        assert.ok(Number(reopen.dismissed_concerns) >= 1);
        assert.ok(Number(reopen.reopen_rate) > 0, 'the dismissed-in-round-1 concern X was re-raised in round 2');
        for (const name of ['dispute-rate', 'quality-prospective', 'quality-historical', 'reversal-rate', 'null-outcome']) {
          await q.many(block(name));
        }
        // Temp views outlive the transaction on a pooled connection and would pin audit_runs columns (the old-schema test drops one).
        await q.query('DROP VIEW capture_concerns');
        await q.query('DROP VIEW capture_rounds');
      });
    });
  }
  // Compatibility: an un-migrated store keeps working
  test('P6: on a store without the capture-v1 columns the existing writes succeed and only the additive parts are skipped', async () => {
    const { execFileSync } = await import('node:child_process');
    await q.query('ALTER TABLE audit_runs DROP COLUMN capture_epoch');
    let out;
    try {
      const stdout = execFileSync(process.execPath, ['tests/helpers/audit-capture-oldschema-child.mjs', repoId], {
        env: { ...process.env, AUDIT_DB_TEST_URL: TEST_URL, AUDIT_DB_URL: TEST_URL }, encoding: 'utf8', timeout: 60000,
      });
      out = JSON.parse(stdout.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
    } finally {
      await q.query('ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS capture_epoch text');
    }
    assert.equal(out.runStarted, true, 'the run row is still registered (the unknown column is not inserted)');
    assert.equal(out.pipelineEvent, true, 'the pipeline event still lands');
    assert.equal(out.reviewerEvent, 'unmigrated', 'a reviewer event is skipped, not failed against an old CHECK');
    assert.equal(out.receipt, 'unmigrated');
    assert.equal(out.equivalence, 'skipped:unmigrated');
  });
});
