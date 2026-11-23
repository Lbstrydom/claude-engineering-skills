/**
 * Child process for the coordinator -> worker linkage test in tests/audit-capture-db.test.mjs.
 *
 * It is a DIFFERENT PROCESS from the parent that started the session: the only thing it shares with the
 * coordinator is the `<sid>-r<N>-result.json` --out path (the handover a coordinator gives a worker), from
 * which it must resolve the same session and round, then write a run, a pass and a finding through the real
 * writers. Prints one `RESULT {json}` line.
 *
 * Args: <repoId> <outPath>
 */
process.env.AUDIT_DB_URL = process.env.AUDIT_DB_TEST_URL;
const [repoId, outPath] = process.argv.slice(2);
const root = new URL('../../', import.meta.url);
const rf = await import(new URL('scripts/lib/store/runs-findings.mjs', root));
const { resolveAuditIdentity, runStartIdentity } = await import(new URL('scripts/lib/audit/audit-identity.mjs', root));
const { closePool } = await import(new URL('scripts/lib/db/client.mjs', root));

const identity = resolveAuditIdentity({ outPath });
const runId = await rf.recordRunStart(repoId, 'docs/plans/x.md', 'code', runStartIdentity(identity));
const round = identity.auditRound;
const pass = await rf.recordPassStats(runId, 'backend', { raised: 1 }, round);
const hash = `worker-${runId.slice(0, 8)}`;
await rf.recordFindings(runId, [{ _hash: hash, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'd' }], 'backend', round);
console.log(`RESULT ${JSON.stringify({ runId, identity, passApplied: pass.applied })}`);
await closePool();
process.exit(0);
