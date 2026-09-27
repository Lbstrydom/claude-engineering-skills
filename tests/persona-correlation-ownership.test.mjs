/**
 * @fileoverview Hermetic (no DB) halves of three audit fixes on the persona
 * write path. The DB halves — the ownership SQL itself — live in the enrolled
 * suite tests/plans-ship-persona-correlation.test.mjs.
 *
 *  - H21: `recordPersonaAuditCorrelation` with no session id is a named
 *    refusal, never the `{ok:true}` a real write returns.
 *  - H1/H2/H23 (caller half): `record-correlation` maps every named ownership
 *    refusal to its own code; the auto-correlator threads the session's repo
 *    and counts refusals separately from outages.
 *  - H15/H28: the `persona-outcomes --worksheet` label commands carry `--repo`,
 *    a generated line runs through the real `label` handler, and `label`
 *    refuses a `--repo` that does not own the addressed session.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatch } from '../scripts/lib/cross-skill/dispatch.mjs';
import { argv } from './helpers/cross-skill-argv.mjs';
import { recordPersonaAuditCorrelation } from '../scripts/lib/store/persona-correlations.mjs';

const HASH = 'a'.repeat(64);

function stubDeps(overrides = {}) {
  return {
    initLearningStore: async () => true,
    isCloudEnabled: async () => true,
    isPersonaCloudEnabled: async () => true,
    resolveRepoForStoreResult: async () => ({ kind: 'resolved', repoRowId: 'repo-1', repoUuid: 'uuid-1', name: 'o/r' }),
    getRepoIdByName: async (name) => (name === 'o/r' ? 'repo-1' : name === 'other/repo' ? 'repo-2' : null),
    getRepoIdByUuid: async () => ({ id: 'repo-1', name: 'o/r' }),
    listRepoIds: async () => ['repo-1', 'repo-2'],
    ...overrides,
  };
}

describe('recordPersonaAuditCorrelation — a missing session id is not a write (H21)', () => {
  for (const missing of [null, undefined, '']) {
    it(`personaSessionId=${JSON.stringify(missing)} → ok:false, written:false, reason invalid-input`, async () => {
      const r = await recordPersonaAuditCorrelation(missing, {
        personaFindingHash: HASH, personaSeverity: 'P0', correlationType: 'audit_missed',
      });
      assert.equal(r.ok, false);
      assert.equal(r.written, false);
      assert.equal(r.reason, 'invalid-input');
    });
  }
});

describe('record-correlation — every named refusal keeps its own code', () => {
  const payload = JSON.stringify({
    personaSessionId: 's-1', personaFindingHash: HASH, personaSeverity: 'P1', correlationType: 'confirmed_hit',
    auditRunId: 'run-1', auditFindingId: 'f-1',
  });
  const cases = [
    ['parent-not-found', 'PARENT_NOT_FOUND', 1],
    ['audit-run-not-found', 'PARENT_NOT_FOUND', 1],
    ['audit-finding-not-found', 'PARENT_NOT_FOUND', 1],
    ['parent-not-owned', 'PARENT_NOT_OWNED', 1],
    ['parent-repo-unknown', 'PARENT_NOT_OWNED', 1],
    ['audit-run-cross-tenant', 'PARENT_NOT_OWNED', 1],
    ['audit-finding-cross-tenant', 'PARENT_NOT_OWNED', 1],
    ['audit-finding-run-mismatch', 'PARENT_NOT_OWNED', 1],
    ['invalid-input', 'BAD_INPUT', 2],
    ['write-failed', 'WRITE_FAILED', 1],
  ];
  for (const [reason, code, exit] of cases) {
    it(`${reason} → ${code}, exit ${exit}`, async () => {
      const deps = stubDeps({
        recordPersonaAuditCorrelation: async () => ({ ok: false, written: false, reason, error: reason }),
      });
      const r = await dispatch(argv('record-correlation', '--json', payload), { deps, cloudGate: 'ready' });
      assert.equal(r.exitCode, exit, JSON.stringify(r.envelope));
      assert.equal(r.envelope.error.code, code);
    });
  }
  it('a real write reports written:true (the control)', async () => {
    const deps = stubDeps({ recordPersonaAuditCorrelation: async () => ({ ok: true, written: true }) });
    const r = await dispatch(argv('record-correlation', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.deepEqual(r.envelope, { ok: true, cloud: true, written: true });
  });
});

describe('record-persona-session auto-correlation — refusals are counted, not hidden', () => {
  const session = {
    persona: 'p', url: 'https://x.test', browserTool: 'playwright', verdict: 'Needs work',
    p0Count: 1, p1Count: 0,
    findings: [{ severity: 'P0', step: 1, element: 'Checkout button', expected: 'Order confirms', observed: 'Page crashes' }],
  };
  function correlatingDeps(writeResult, calls) {
    return stubDeps({
      recordPersonaSession: async () => ({ ok: true, cloud: true, sessionId: 'row-1', existed: false, statsUpdated: true, statsReason: null }),
      getCandidateAuditFindings: async () => ({ ok: true, rows: [{
        id: 'f-1', run_id: 'run-1', finding_fingerprint: 'fp', severity: 'HIGH', category: 'x',
        primary_file: 'src/unrelated.mjs', detail_snapshot: 'nothing alike', run_created_at: new Date().toISOString(),
      }] }),
      getExistingCorrelationHashesForSession: async () => ({ ok: true, hashes: new Set() }),
      recordPersonaAuditCorrelation: async (...args) => { calls.push(args); return writeResult; },
    });
  }

  it('threads the session repo into the writer and counts a named refusal as refused', async () => {
    const calls = [];
    const deps = correlatingDeps({ ok: false, written: false, reason: 'audit-run-cross-tenant', error: 'x' }, calls);
    const r = await dispatch(argv('record-persona-session', '--json', JSON.stringify(session)), { deps, cloudGate: 'ready' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][2], { repoId: 'repo-1' }, 'the resolved repo must reach the ownership check');
    assert.equal(r.envelope.correlationSummary.writeFailed, 1);
    assert.equal(r.envelope.correlationSummary.refused, 1);
  });

  it('a store outage is writeFailed but NOT refused', async () => {
    const calls = [];
    const deps = correlatingDeps({ ok: false, written: false, reason: 'write-failed', error: 'down' }, calls);
    const r = await dispatch(argv('record-persona-session', '--json', JSON.stringify(session)), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.correlationSummary.writeFailed, 1);
    assert.equal(r.envelope.correlationSummary.refused, 0);
  });

  it('a written row is neither (the control)', async () => {
    const calls = [];
    const deps = correlatingDeps({ ok: true, written: true }, calls);
    const r = await dispatch(argv('record-persona-session', '--json', JSON.stringify(session)), { deps, cloudGate: 'ready' });
    assert.equal(r.envelope.correlationSummary.writeFailed, 0);
    assert.equal(r.envelope.correlationSummary.refused, 0);
  });
});

// ── H15/H28: worksheet → label ────────────────────────────────────────────

/** Minimal POSIX tokenizer for the lines `shellQuoteSingle` renders. */
function tokenize(line) {
  const out = []; let cur = ''; let inTok = false; let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') { if (ch === '"') q = null; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; inTok = true; continue; }
    if (ch === '\\') { cur += line[i + 1] ?? ''; i += 1; inTok = true; continue; }
    if (/\s/.test(ch)) { if (inTok) { out.push(cur); cur = ''; inTok = false; } continue; }
    cur += ch; inTok = true;
  }
  if (inTok) out.push(cur);
  return out;
}

async function renderWorksheet(repoName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-ws-'));
  const out = path.join(tmp, 'ws.md');
  try {
    const deps = stubDeps({
      getActionablePersonaOutcomeItems: async () => ({
        ok: true, cloud: true, truncated: false,
        items: [{ sessionId: "sess'1", personaFindingHash: HASH, severity: 'P0', outcome: null, element: 'button', observed: 'dead' }],
      }),
    });
    const r = await dispatch(argv('persona-outcomes', '--worksheet', '--repo', repoName, '--out', out), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    return fs.readFileSync(out, 'utf8');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function labelLines(md) {
  return md.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('node scripts/cross-skill.mjs persona-outcomes label'));
}

describe('persona-outcomes --worksheet → label (H15/H28)', () => {
  it('every generated label command carries --repo', async () => {
    const lines = labelLines(await renderWorksheet('o/r'));
    assert.equal(lines.length, 1, `expected one paste-ready line per finding, got ${lines.length} — instrument broken`);
    for (const l of lines) assert.equal(tokenize(l)[tokenize(l).indexOf('--repo') + 1], 'o/r', l);
  });

  it('a generated command parses AND runs through the real label handler', async () => {
    const line = labelLines(await renderWorksheet('o/r')).find((l) => l.includes('--outcome fixed'));
    const args = tokenize(line).slice(2); // drop `node scripts/cross-skill.mjs`
    let upserted = null;
    const deps = stubDeps({
      resolveLabelTarget: async ({ sessionId }) => { assert.equal(sessionId, "sess'1"); return { ok: true, repoId: 'repo-1' }; },
      upsertPersonaFindingOutcome: async (p) => { upserted = p; return { ok: true }; },
    });
    const r = await dispatch(argv(...args), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.equal(upserted.repoId, 'repo-1');
    assert.equal(upserted.outcome, 'fixed');
  });

  it('the same line pasted against a session of ANOTHER repo is refused, nothing written', async () => {
    const line = labelLines(await renderWorksheet('other/repo')).find((l) => l.includes('--outcome fixed'));
    let upserted = false;
    const deps = stubDeps({
      resolveLabelTarget: async () => ({ ok: true, repoId: 'repo-1' }),
      upsertPersonaFindingOutcome: async () => { upserted = true; return { ok: true }; },
    });
    const r = await dispatch(argv(...tokenize(line).slice(2)), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 1);
    assert.equal(r.envelope.error.code, 'PARENT_NOT_OWNED');
    assert.equal(upserted, false);
  });

  it('label WITHOUT --repo still works — the session decides the repo (control)', async () => {
    const deps = stubDeps({
      resolveLabelTarget: async () => ({ ok: true, repoId: 'repo-1' }),
      upsertPersonaFindingOutcome: async () => ({ ok: true }),
    });
    const r = await dispatch(argv('persona-outcomes', 'label', '--session', 's1', '--hash', HASH, '--outcome', 'fixed'),
      { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
  });
});
