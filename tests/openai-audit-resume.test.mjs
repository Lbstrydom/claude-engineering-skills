/**
 * @fileoverview Tier 2 — `--resume` at the CLI and report seams (plan docs/plans/sashiko-audit-improvements.md §3.3).
 * A resumed round must never read as a fresh one (summary line, gate evidence), and unsupported modes must refuse loudly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { formatAuditSummaryLine } from '../scripts/lib/audit/findings-pipeline.mjs';
import { buildGateEvidence } from '../scripts/lib/audit/gate-evidence.mjs';

const CLI = path.resolve('scripts/openai-audit.mjs');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 60_000,
  env: { ...process.env, MODEL_CATALOG_REFRESH: 'skip', AZURE_OPENAI_ENDPOINT: '', LEARNING_DISABLE: '1' },
});

describe('--resume refusals', () => {
  it('refuses plan mode with the reason and exit 1', () => {
    const r = run('plan', 'docs/plans/sashiko-audit-improvements.md', '--mode', 'plan', '--resume');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /resume-unsupported:plan/);
  });
  it('refuses rebuttal mode', () => {
    const r = run('rebuttal', 'docs/plans/sashiko-audit-improvements.md', 'x.md', '--resume');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /resume-unsupported:rebuttal/);
  });
});

describe('a resumed round is stamped, a fresh round is byte-identical', () => {
  const base = { verdict: 'PASS', high: 0, medium: 0, low: 0, latencyMs: 12000 };
  it('summary line carries `resumed:` after the seconds field and keeps the leading shape', () => {
    const line = formatAuditSummaryLine({ ...base, resume: { resumed: true, replayedCalls: 4, liveCalls: 1 } });
    assert.match(line, /^Verdict: PASS \| H:0 M:0 L:0 \| 12s \| resumed: 4\/5 calls replayed$/);
  });
  it('INCOMPLETE keeps the stamp too', () => {
    const line = formatAuditSummaryLine({ ...base, verdict: 'INCOMPLETE', failedPasses: ['wiring'], passesTotal: 5, resume: { resumed: true, replayedCalls: 3, liveCalls: 2 } });
    assert.match(line, /resumed: 3\/5 calls replayed/);
    assert.match(line, /^Verdict: INCOMPLETE/);
  });
  it('no resume and recording-only runs print the pre-change line', () => {
    const plain = formatAuditSummaryLine(base);
    assert.equal(plain, 'Verdict: PASS | H:0 M:0 L:0 | 12s');
    assert.equal(formatAuditSummaryLine({ ...base, resume: { resumed: false, replayedCalls: 0, liveCalls: 3 } }), plain);
  });
  it('gate evidence carries resumed:true only on a resumed round', () => {
    const input = { runId: 'r', sid: 's', round: 1, auditedSha: 'a', auditedTree: 'b', auditedBranch: 'main', nowIso: '2026-01-01T00:00:00.000Z' };
    const fresh = buildGateEvidence(input);
    assert.equal(Object.hasOwn(fresh, 'resumed'), false, 'a non-resumed marker is byte-identical to before');
    assert.equal(buildGateEvidence({ ...input, resumed: true }).resumed, true);
    assert.equal(Object.hasOwn(buildGateEvidence({ ...input, resumed: false }), 'resumed'), false);
  });
});
