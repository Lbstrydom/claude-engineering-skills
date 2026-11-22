/**
 * @fileoverview Bind the per-call provenance log for an audit run with its per-call identity
 * (docs/plans/own-model-full-capture.md, P0): the work item (env, else the `wi-` branch segment), the audited
 * tree and the resolved diff base are stamped on EVERY call row, so a call stays attributable even if its run row
 * is never completed. Kept out of legacy-production-audit.mjs (an oversized file may not grow).
 *
 * @module scripts/lib/audit/bind-call-log
 */
import { bindRun } from '../telemetry/llm-call-log.mjs';
import { resolveWorkItemId } from '../ledger/work-item.mjs';
import { resolveRevisionSha } from './target-identity.mjs';

/**
 * Never throws (`bindRun` does not). Returns whether the log is now bound.
 * @param {{runId: string|null, repoId?: string|null, branch?: string|null, auditedTree?: string|null, auditBaseCommit?: string|null, cwd?: string}} a
 */
export function bindAuditCallLog({ runId, repoId = null, branch = null, auditedTree = null, auditBaseCommit = null, cwd = process.cwd() }) {
  return bindRun({
    runId, repoId, producer: 'audit',
    workItemId: resolveWorkItemId({ branch }),
    auditedTree,
    diffBaseSha: resolveRevisionSha(cwd, auditBaseCommit),
  });
}
