/**
 * Writer-seam regression: the audit identity resolved by `openai-audit.mjs` must survive
 * `buildAuditRunContext`, the only hop between the CLI and the `recordRunStart` call that
 * stamps `audit_runs.audit_session_id` / `audit_round`.
 *
 * Failure it pins (measured 2026-11-23, store d5a9d07b): `buildAuditRunContext` neither
 * destructured nor returned `auditIdentity`, so the code writer always read `undefined` and
 * 0 of 1,213 code runs since 2026-10-29 carried a session id (plan runs, which bypass the
 * ctx, were 253/262).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAuditRunContext } from '../scripts/lib/audit/legacy-production-audit.mjs';
import { resolveAuditIdentity, runStartIdentity } from '../scripts/lib/audit/audit-identity.mjs';

describe('audit identity survives buildAuditRunContext', () => {
  it('carries the resolved identity through to the ctx the writer reads', async () => {
    const auditIdentity = resolveAuditIdentity({ roundFlag: 2, outPath: '.audit/audit-code-111-222-r2-result.json' });
    assert.deepEqual(auditIdentity, { auditSessionId: 'audit-code-111-222', auditRound: 2, conflict: null });
    const ctx = await buildAuditRunContext({ openai: undefined, planContent: '# plan\n', changedFiles: [], auditIdentity });
    assert.deepEqual(ctx.auditIdentity, auditIdentity, 'ctx.auditIdentity must equal what the CLI resolved');
  });

  it('an absent identity stays null (never undefined-spread into the INSERT)', async () => {
    const ctx = await buildAuditRunContext({ openai: undefined, planContent: '# plan\n', changedFiles: [] });
    assert.equal(ctx.auditIdentity, null);
  });

  it('runStartIdentity maps ctx identity to the recordRunStart options, and null to undefined', () => {
    assert.deepEqual(runStartIdentity({ auditSessionId: 's', auditRound: 2, conflict: null }), { auditSessionId: 's', auditRound: 2 });
    assert.deepEqual(runStartIdentity(null), { auditSessionId: undefined, auditRound: undefined });
  });

  it('the code writer builds its options from the helper, and the CLI hands the identity over', () => {
    const src = fs.readFileSync(new URL('../scripts/lib/audit/legacy-production-audit.mjs', import.meta.url), 'utf8');
    assert.match(src, /recordRunStart\(cloudRepoId, planFile \|\| 'ad-hoc', 'code', \{[^}]*\.\.\.runStartIdentity\(auditIdentity\)/);
    const cli = fs.readFileSync(new URL('../scripts/openai-audit.mjs', import.meta.url), 'utf8');
    assert.match(cli, /runMultiPassCodeAudit\([^\n]*auditIdentity,/);
  });
});
