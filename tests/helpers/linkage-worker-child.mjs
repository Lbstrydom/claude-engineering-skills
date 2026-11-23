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
// AUDIT_DB_URL is supplied by the parent's spawn env (the test DSN); static imports, so the gate can see them.
import * as rf from '../../scripts/lib/store/runs-findings.mjs';
import { resolveAuditIdentity, runStartIdentity } from '../../scripts/lib/audit/audit-identity.mjs';
import { closePool } from '../../scripts/lib/db/client.mjs';

const [repoId, outPath] = process.argv.slice(2);
const identity = resolveAuditIdentity({ outPath });
const runId = await rf.recordRunStart(repoId, 'docs/plans/x.md', 'code', runStartIdentity(identity));
const round = identity.auditRound;
const pass = await rf.recordPassStats(runId, 'backend', { raised: 1 }, round);
const hash = `worker-${runId.slice(0, 8)}`;
await rf.recordFindings(runId, [{ _hash: hash, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'd' }], 'backend', round);
console.log(`RESULT ${JSON.stringify({ runId, identity, passApplied: pass.applied })}`);
await closePool();
process.exit(0);
