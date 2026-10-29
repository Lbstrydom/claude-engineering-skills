/**
 * Child process for the old-schema compatibility test in tests/audit-capture-db.test.mjs.
 *
 * It runs in a FRESH process because the column probes cache per process: the parent has already
 * seen `audit_runs.capture_epoch` and would never notice it was dropped. The parent drops the column
 * (on a disposable database only), runs this, and restores the column.
 *
 * Prints one JSON line: what the existing writers did on a store without the capture-v1 columns.
 * Args: <repoId> (the repo row the parent already created).
 */
process.env.AUDIT_DB_URL = process.env.AUDIT_DB_TEST_URL;
const [repoId] = process.argv.slice(2);
const root = new URL('../../', import.meta.url);
const rf = await import(new URL('scripts/lib/store/runs-findings.mjs', root));
const { query, one } = await import(new URL('scripts/lib/db/query.mjs', root));
const { recordWriteReceipt } = await import(new URL('scripts/lib/store/write-receipts.mjs', root));
const { recordEquivalence } = await import(new URL('scripts/lib/store/model-ab.mjs', root));

const out = {};
const runId = await rf.recordRunStart(repoId, 'docs/plans/x.md', 'code', { auditSessionId: 'old-schema', auditRound: 1 });
out.runStarted = Boolean(runId);
const hash = `old-${runId.slice(0, 8)}`;
const rec = await rf.recordFindings(runId, [{ _hash: hash, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'd', _sourceModel: 'gpt-6.1-terra' }], 'backend', 1);
out.findingsRecorded = rec?.recorded ?? rec?.count ?? true;
out.pipelineEvent = (await rf.recordAdjudicationEvent(runId, hash, {
  adjudicationOutcome: 'dismissed', remediationState: 'pending', ruling: 'overrule', adjudicatorKind: 'pipeline', dismissReasonClass: 'unclassified', round: 1, rulingRationale: 'old-schema rationale',
})).ok;
out.reviewerEvent = (await rf.recordAdjudicationEvent(runId, hash, {
  adjudicationOutcome: 'accepted', remediationState: 'pending', ruling: 'overrule', adjudicatorKind: 'reviewer', round: 1, evidence: { reviewing_run_id: runId },
})).reason;
out.receipt = (await recordWriteReceipt(runId, 'reviewer', { status: 'complete' })).reason;
out.equivalence = (await recordEquivalence({ duplicateFingerprint: hash, canonicalFingerprint: 'nope', createdBy: 'concern-v1' })).outcome;
out.sessionStamped = (await one('SELECT count(*)::int AS n FROM audit_runs WHERE id = $1', [runId])).n === 1;
await query('DELETE FROM finding_adjudication_events WHERE finding_id IN (SELECT id FROM audit_findings WHERE run_id = $1)', [runId]);
await query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
await query('DELETE FROM audit_runs WHERE id = $1', [runId]);
console.log(`RESULT ${JSON.stringify(out)}`);
process.exit(0);
