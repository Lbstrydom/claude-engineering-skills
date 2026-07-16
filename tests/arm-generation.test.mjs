import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runAuditGenerationArm, UnsupportedGenerationTransport, _internals,
} from '../scripts/lib/model-eval/arm-generation.mjs';
import { EgressGateError } from '../scripts/lib/model-eval/egress-path-scan.mjs';
import { resolveModel } from '../scripts/lib/model-resolver.mjs';
import { CANONICAL_ARMS, buildCandidateArm } from '../scripts/lib/audit-arms.mjs';
import { extractPlanPaths } from '../scripts/lib/plan-paths.mjs';

const [ARM_A, , ARM_C] = CANONICAL_ARMS; // A = sentinel, C = oss-role

let tmpDir;
let savedCwd;

beforeEach(() => {
  savedCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-generation-'));
});

afterEach(() => {
  process.chdir(savedCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('arm-generation.mjs — resolveGenerationClient (pure, per-kind)', () => {
  test('sentinel kind uses route.resolvedModel (not a fresh resolveModel re-derivation)', async () => {
    const route = { resolvedModel: resolveModel('latest-gpt') };
    const { model } = await _internals.resolveGenerationClient(ARM_A.generation, route);
    assert.equal(model, route.resolvedModel);
  });

  test('oss-role kind also uses route.resolvedModel — single resolution source, no second mechanism', async () => {
    const route = { resolvedModel: resolveModel('latest-oss-reasoner') };
    const { model } = await _internals.resolveGenerationClient(ARM_C.generation, route);
    assert.equal(model, route.resolvedModel);
  });

  test('resolved-route kind: route.deploymentId wins over route.resolvedModel when both present', async () => {
    const generation = { kind: 'resolved-route', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' }, resolvedModel: 'gpt-5.4', deploymentId: 'foundry-audit-deployment' };
    const route = { resolvedModel: 'gpt-5.4', deploymentId: 'foundry-audit-deployment' };
    const { model } = await _internals.resolveGenerationClient(generation, route);
    assert.equal(model, 'foundry-audit-deployment');
  });

  test('resolved-route kind: falls back to route.resolvedModel when route.deploymentId is null', async () => {
    const generation = { kind: 'resolved-route', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' }, resolvedModel: 'gpt-5.4', deploymentId: null };
    const route = { resolvedModel: 'gpt-5.4', deploymentId: null };
    const { model } = await _internals.resolveGenerationClient(generation, route);
    assert.equal(model, 'gpt-5.4');
  });
});

describe('arm-generation.mjs — buildGenericPlanContent × real extractPlanPaths (round-15 empirical-verify regression)', () => {
  // Deliberately exercises the REAL extractPlanPaths, not a mock — this is
  // exactly the seam a fully-mocked _runMultiPassCodeAudit test suite could
  // never catch (the bug was that runMultiPassCodeAudit does NOT read
  // ctx.changedFiles for file discovery; it parses extractPlanPaths(planContent)
  // instead). Found via the harness's first real dogfood run: a bare
  // instructional plan string (no file paths) always resolved ZERO files,
  // so every promotion-tier Tier A/B generation call unconditionally hit
  // the "0 implementation files reached the prompt" guard and aborted.
  test('the generated plan content resolves every input file via the real extractPlanPaths (allowInfraFiles:true)', () => {
    const files = ['scripts/openai-audit.mjs', 'scripts/lib/ledger.mjs'];
    const plan = _internals.buildGenericPlanContent(files);
    const { found } = extractPlanPaths(plan, { allowInfraFiles: true });
    for (const f of files) assert.ok(found.includes(f), `expected "${f}" in extractPlanPaths' found list, got ${JSON.stringify(found)}`);
  });

  test('without allowInfraFiles, a tool-infrastructure file is excluded — this is exactly why runAuditGenerationArm must pass allowInfraScope:true', () => {
    const plan = _internals.buildGenericPlanContent(['scripts/openai-audit.mjs']);
    const { found } = extractPlanPaths(plan, { allowInfraFiles: false });
    assert.equal(found.length, 0);
  });

  test('an empty file list still produces valid plan content (no crash) — the corpus-loader guarantees non-empty, but this function must not assume it', () => {
    const plan = _internals.buildGenericPlanContent([]);
    assert.equal(typeof plan, 'string');
    const { found } = extractPlanPaths(plan, { allowInfraFiles: true });
    assert.equal(found.length, 0);
  });

  test('the instructional prose is byte-identical regardless of the file list — fairness invariant: two calls for the SAME KD case (candidate + baseline) get identical framing, only the file list may legitimately differ from case to case', () => {
    const planA = _internals.buildGenericPlanContent(['a.mjs']);
    const planB = _internals.buildGenericPlanContent(['b.mjs', 'c.mjs']);
    const instructionsA = planA.split('\n\nFiles changed in this diff:\n')[0];
    const instructionsB = planB.split('\n\nFiles changed in this diff:\n')[0];
    assert.equal(instructionsA, instructionsB);
  });
});

describe('arm-generation.mjs — runAuditGenerationArm', () => {
  test('throws UnsupportedGenerationTransport BEFORE any client/generation work for a non-openai-compatible route', async () => {
    let called = false;
    const fakeAudit = async () => { called = true; return {}; };
    await assert.rejects(
      () => runAuditGenerationArm({
        arm: ARM_A, auditInput: { diff: 'x', files: [], repoRoot: tmpDir },
        route: { transport: 'native-anthropic' }, runId: 'r1', role: 'auditor',
        _runMultiPassCodeAudit: fakeAudit,
      }),
      UnsupportedGenerationTransport,
    );
    assert.equal(called, false);
  });

  test('chdirs into auditInput.repoRoot for the call, restores cwd after, writes an absolute diff file, and NEVER sets repoProfile', async () => {
    let capturedOpts = null;
    let cwdDuringCall = null;
    const fakeAudit = async (client, planContent, projectContext, jsonMode, outFile, historyContext, opts) => {
      cwdDuringCall = process.cwd();
      capturedOpts = opts;
      return { findings: [{ id: 'f1' }], _usage: { input_tokens: 100, output_tokens: 50 } };
    };

    const route = { transport: 'openai-compatible', resolvedModel: 'gpt-5.4', deploymentId: null, pricingModel: 'gpt-5.4', provider: 'openai' };
    const result = await runAuditGenerationArm({
      arm: ARM_A,
      auditInput: { diff: '--- fake diff ---', files: ['a.js', 'b.js'], repoRoot: tmpDir },
      route, runId: 'r-test-1', role: 'auditor',
      _runMultiPassCodeAudit: fakeAudit,
    });

    assert.equal(path.resolve(cwdDuringCall), path.resolve(tmpDir));
    assert.equal(path.resolve(process.cwd()), path.resolve(savedCwd)); // restored

    assert.deepEqual(capturedOpts.changedFiles, ['a.js', 'b.js']);
    assert.equal(capturedOpts.scopeMode, 'diff');
    assert.equal(capturedOpts.round, 1);
    assert.equal(capturedOpts.noLedger, true);
    assert.equal(capturedOpts.noDebtLedger, true);
    assert.ok(!('repoProfile' in capturedOpts), 'repoProfile must never be set — omitting it is what prevents cloud pollution of audit_runs/audit_findings');
    assert.ok(path.isAbsolute(capturedOpts.diffFile));
    assert.equal(fs.readFileSync(capturedOpts.diffFile, 'utf8'), '--- fake diff ---');
    // Round-15 empirical-verify regression: without allowInfraScope:true, a
    // known-defect corpus case citing this tool's OWN control-plane files
    // (e.g. openai-audit.mjs) would have those files silently excluded by
    // extractPlanPaths's isAuditInfraFile filter.
    assert.equal(capturedOpts.allowInfraScope, true);

    assert.deepEqual(result.findings, [{ id: 'f1' }]);
    assert.equal(result.usageEvent.usageStatus, 'captured');
    assert.equal(result.usageEvent.armId, ARM_A.id);
    assert.equal(result.usageEvent.candidateRef, 'gpt-5.4');
  });

  test('restores cwd even when the underlying audit call throws', async () => {
    const fakeAudit = async () => { throw new Error('boom'); };
    const route = { transport: 'openai-compatible', resolvedModel: 'gpt-5.4', deploymentId: null, pricingModel: 'gpt-5.4', provider: 'openai' };
    await assert.rejects(
      () => runAuditGenerationArm({
        arm: ARM_A, auditInput: { diff: 'x', files: [], repoRoot: tmpDir },
        route, runId: 'r-test-2', role: 'auditor', _runMultiPassCodeAudit: fakeAudit,
      }),
      /boom/,
    );
    assert.equal(path.resolve(process.cwd()), path.resolve(savedCwd));
  });

  test('a resolved-route candidate arm (buildCandidateArm) drives the SAME call shape as a sentinel arm — no special-casing', async () => {
    const candidateArm = buildCandidateArm({ candidateSpec: { kind: 'azure-deployment', profile: 'foundry-gpt-audit' }, resolvedModel: 'gpt-5.4', deploymentId: 'audit-deployment' }, { id: 'CAND' });
    let capturedOpts = null;
    const fakeAudit = async (client, planContent, projectContext, jsonMode, outFile, historyContext, opts) => {
      capturedOpts = opts;
      return { findings: [], _usage: { input_tokens: 10, output_tokens: 5 } };
    };
    const route = { transport: 'openai-compatible', resolvedModel: 'gpt-5.4', deploymentId: 'audit-deployment', pricingModel: 'gpt-5.4', provider: 'azure' };
    await runAuditGenerationArm({
      arm: candidateArm, auditInput: { diff: 'x', files: ['a.js'], repoRoot: tmpDir },
      route, runId: 'r-test-3', role: 'auditor', _runMultiPassCodeAudit: fakeAudit,
    });
    assert.equal(capturedOpts.model, 'audit-deployment');
    assert.equal(capturedOpts.scopeMode, 'diff'); // same shape as the sentinel-arm test above
  });

  test('refuses (EgressGateError) a diff containing a sensitive path mention, BEFORE any generation call', async () => {
    let called = false;
    const fakeAudit = async () => { called = true; return { findings: [], _usage: {} }; };
    const route = { transport: 'openai-compatible', resolvedModel: 'gpt-5.4', deploymentId: null, pricingModel: 'gpt-5.4', provider: 'openai' };
    await assert.rejects(
      () => runAuditGenerationArm({
        arm: ARM_A, auditInput: { diff: '+++ b/.env\n+SECRET=abc123', files: ['.env'], repoRoot: tmpDir },
        route, runId: 'r-test-4', role: 'auditor', _runMultiPassCodeAudit: fakeAudit,
      }),
      EgressGateError,
    );
    assert.equal(called, false);
  });

  test('throws when the underlying audit result has a malformed (non-array) findings field', async () => {
    const fakeAudit = async () => ({ findings: 'not-an-array', _usage: { input_tokens: 1, output_tokens: 1 } });
    const route = { transport: 'openai-compatible', resolvedModel: 'gpt-5.4', deploymentId: null, pricingModel: 'gpt-5.4', provider: 'openai' };
    await assert.rejects(
      () => runAuditGenerationArm({
        arm: ARM_A, auditInput: { diff: 'x', files: [], repoRoot: tmpDir },
        route, runId: 'r-test-5', role: 'auditor', _runMultiPassCodeAudit: fakeAudit,
      }),
      /malformed result/,
    );
  });
});
