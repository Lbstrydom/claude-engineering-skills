import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  runAuditGenerationArm, UnsupportedGenerationTransport, _internals,
} from '../scripts/lib/model-eval/arm-generation.mjs';
import { EgressGateError } from '../scripts/lib/model-eval/egress-path-scan.mjs';
import { resolveModel } from '../scripts/lib/model-resolver.mjs';
import { CANONICAL_ARMS, buildCandidateArm } from '../scripts/lib/audit-arms.mjs';
import { extractPlanPaths } from '../scripts/lib/plan-paths.mjs';

const [ARM_A, , ARM_C] = CANONICAL_ARMS; // A = sentinel, C = oss-role

// A client-factory spy: the pure cases never construct a real client (that needs OPENAI_API_KEY, which a CI runner lacks).
function spyFactories() {
  const calls = { openai: [], openrouter: [] };
  return {
    calls,
    factories: {
      createOpenAIClient: async (opts) => { calls.openai.push(opts); return { fake: 'openai' }; },
      createOpenRouterClient: async (opts) => { calls.openrouter.push(opts); return { fake: 'openrouter' }; },
    },
  };
}

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
    const { model } = await _internals.resolveGenerationClient(ARM_A.generation, route, spyFactories().factories);
    assert.equal(model, route.resolvedModel);
  });

  test('oss-role kind also uses route.resolvedModel — single resolution source, no second mechanism', async () => {
    const route = { resolvedModel: resolveModel('latest-oss-reasoner') };
    const { model } = await _internals.resolveGenerationClient(ARM_C.generation, route, spyFactories().factories);
    assert.equal(model, route.resolvedModel);
  });

  test('resolved-route kind: route.deploymentId wins over route.resolvedModel when both present', async () => {
    const generation = { kind: 'resolved-route', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' }, resolvedModel: 'gpt-5.4', deploymentId: 'foundry-audit-deployment' };
    const route = { resolvedModel: 'gpt-5.4', deploymentId: 'foundry-audit-deployment' };
    const { model } = await _internals.resolveGenerationClient(generation, route, spyFactories().factories);
    assert.equal(model, 'foundry-audit-deployment');
  });

  test('each kind constructs exactly one client of the right family, through the injected factory (no credentials needed)', async () => {
    const a = spyFactories();
    await _internals.resolveGenerationClient(ARM_A.generation, { resolvedModel: 'm' }, a.factories);
    assert.deepEqual([a.calls.openai.length, a.calls.openrouter.length], [1, 0]);
    const c = spyFactories();
    await _internals.resolveGenerationClient(ARM_C.generation, { resolvedModel: 'm' }, c.factories);
    assert.deepEqual([c.calls.openai.length, c.calls.openrouter.length], [0, 1]);
  });

  test('resolved-route kind: falls back to route.resolvedModel when route.deploymentId is null', async () => {
    const generation = { kind: 'resolved-route', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' }, resolvedModel: 'gpt-5.4', deploymentId: null };
    const route = { resolvedModel: 'gpt-5.4', deploymentId: null };
    const { model } = await _internals.resolveGenerationClient(generation, route, spyFactories().factories);
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
    const spy = spyFactories();
    const fakeAudit = async () => { called = true; return {}; };
    await assert.rejects(
      () => runAuditGenerationArm({ _withCaseTree: fakeTree,
        arm: ARM_A, auditInput: { diff: 'x', files: [], repoRoot: tmpDir, treeSha: 'abc123' },
        route: { transport: 'native-anthropic' }, runId: 'r1', role: 'auditor',
        _runMultiPassCodeAudit: fakeAudit, _clientFactories: spy.factories,
      }),
      UnsupportedGenerationTransport,
    );
    assert.equal(called, false);
    assert.deepEqual([spy.calls.openai.length, spy.calls.openrouter.length], [0, 0], 'a refused transport must not construct any client');
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
    const result = await runAuditGenerationArm({ _withCaseTree: fakeTree,
      arm: ARM_A,
      auditInput: { diff: '--- fake diff ---', files: ['a.js', 'b.js'], repoRoot: tmpDir, treeSha: 'abc123' },
      route, runId: 'r-test-1', role: 'auditor',
      _runMultiPassCodeAudit: fakeAudit, _clientFactories: spyFactories().factories,
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
      () => runAuditGenerationArm({ _withCaseTree: fakeTree,
        arm: ARM_A, auditInput: { diff: 'x', files: [], repoRoot: tmpDir, treeSha: 'abc123' },
        route, runId: 'r-test-2', role: 'auditor', _runMultiPassCodeAudit: fakeAudit, _clientFactories: spyFactories().factories,
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
    await runAuditGenerationArm({ _withCaseTree: fakeTree,
      arm: candidateArm, auditInput: { diff: 'x', files: ['a.js'], repoRoot: tmpDir, treeSha: 'abc123' },
      route, runId: 'r-test-3', role: 'auditor', _runMultiPassCodeAudit: fakeAudit, _clientFactories: spyFactories().factories,
    });
    assert.equal(capturedOpts.model, 'audit-deployment');
    assert.equal(capturedOpts.scopeMode, 'diff'); // same shape as the sentinel-arm test above
  });

  test('refuses (EgressGateError) a diff containing a sensitive path mention, BEFORE any generation call', async () => {
    let called = false;
    const fakeAudit = async () => { called = true; return { findings: [], _usage: {} }; };
    const route = { transport: 'openai-compatible', resolvedModel: 'gpt-5.4', deploymentId: null, pricingModel: 'gpt-5.4', provider: 'openai' };
    await assert.rejects(
      () => runAuditGenerationArm({ _withCaseTree: fakeTree,
        arm: ARM_A, auditInput: { diff: '+++ b/.env\n+SECRET=abc123', files: ['.env'], repoRoot: tmpDir, treeSha: 'abc123' },
        route, runId: 'r-test-4', role: 'auditor', _runMultiPassCodeAudit: fakeAudit, _clientFactories: spyFactories().factories,
      }),
      EgressGateError,
    );
    assert.equal(called, false);
  });

  test('throws when the underlying audit result has a malformed (non-array) findings field', async () => {
    const fakeAudit = async () => ({ findings: 'not-an-array', _usage: { input_tokens: 1, output_tokens: 1 } });
    const route = { transport: 'openai-compatible', resolvedModel: 'gpt-5.4', deploymentId: null, pricingModel: 'gpt-5.4', provider: 'openai' };
    await assert.rejects(
      () => runAuditGenerationArm({ _withCaseTree: fakeTree,
        arm: ARM_A, auditInput: { diff: 'x', files: [], repoRoot: tmpDir, treeSha: 'abc123' },
        route, runId: 'r-test-5', role: 'auditor', _runMultiPassCodeAudit: fakeAudit, _clientFactories: spyFactories().factories,
      }),
      /malformed result/,
    );
  });
});

describe('arm-generation.mjs — controls.scope/controls.passes wiring (auditor-controls-execution-wiring.md, round 1)', () => {
  const route = { transport: 'openai-compatible', resolvedModel: 'gpt-5.4', deploymentId: null, pricingModel: 'gpt-5.4', provider: 'openai' };
  const fakeAuditResult = { findings: [], _usage: { input_tokens: 1, output_tokens: 1 } };

  test('omitting scope/passes reproduces today\'s exact ctx shape — scopeMode:"diff", no passFilter KEY at all', async () => {
    let capturedOpts = null;
    const fakeAudit = async (client, planContent, projectContext, jsonMode, outFile, historyContext, opts) => {
      capturedOpts = opts;
      return fakeAuditResult;
    };
    await runAuditGenerationArm({ _withCaseTree: fakeTree,
      arm: ARM_A, auditInput: { diff: 'x', files: [], repoRoot: tmpDir, treeSha: 'abc123' },
      route, runId: 'r-scope-1', role: 'auditor', _runMultiPassCodeAudit: fakeAudit, _clientFactories: spyFactories().factories,
    });
    assert.equal(capturedOpts.scopeMode, 'diff');
    assert.equal(Object.hasOwn(capturedOpts, 'passFilter'), false, 'passFilter key must be absent, not null, when passes is omitted');
  });

  test('a present scope reaches ctx.scopeMode', async () => {
    let capturedOpts = null;
    const fakeAudit = async (client, planContent, projectContext, jsonMode, outFile, historyContext, opts) => {
      capturedOpts = opts;
      return fakeAuditResult;
    };
    await runAuditGenerationArm({ _withCaseTree: fakeTree,
      arm: ARM_A, auditInput: { diff: 'x', files: [], repoRoot: tmpDir, treeSha: 'abc123' },
      route, runId: 'r-scope-2', role: 'auditor', scope: 'full', _runMultiPassCodeAudit: fakeAudit, _clientFactories: spyFactories().factories,
    });
    assert.equal(capturedOpts.scopeMode, 'full');
  });

  test('a present passes array reaches ctx.passFilter unchanged', async () => {
    let capturedOpts = null;
    const fakeAudit = async (client, planContent, projectContext, jsonMode, outFile, historyContext, opts) => {
      capturedOpts = opts;
      return fakeAuditResult;
    };
    await runAuditGenerationArm({ _withCaseTree: fakeTree,
      arm: ARM_A, auditInput: { diff: 'x', files: [], repoRoot: tmpDir, treeSha: 'abc123' },
      route, runId: 'r-scope-3', role: 'auditor', passes: ['structure', 'wiring'], _runMultiPassCodeAudit: fakeAudit, _clientFactories: spyFactories().factories,
    });
    assert.deepEqual(capturedOpts.passFilter, ['structure', 'wiring']);
  });
});

// The case-tree fake: runs the call in the given dir without touching git (the real one is exercised below against a real repo).
const fakeTree = async ({ repoRoot }, fn) => fn(repoRoot);

describe('arm-generation.mjs — a case is audited at ITS commit, not at the checkout (instrument fix, 2026-11-20)', () => {
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const route = { transport: 'openai-compatible', resolvedModel: 'gpt-5.4', deploymentId: null, pricingModel: 'gpt-5.4', provider: 'openai' };
  /** A repo whose CHECKOUT is ahead of the case commit: `later()` exists only in the second commit. */
  function repoAheadOfCase() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-tree-repo-'));
    sh(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'a.js'), 'export function atCommit() {}\n');
    sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'case');
    const caseSha = sh(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'a.js'), 'export function atCommit() {}\nexport function later() {}\n');
    sh(repo, 'commit', '-q', '-am', 'post-commit');
    return { repo, caseSha };
  }
  const readA = () => fs.readFileSync('a.js', 'utf8');

  test('file reads during the audit see the case commit, never a symbol a later commit added', async () => {
    const { repo, caseSha } = repoAheadOfCase();
    let seen = null; let cwdDuring = null;
    const fakeAudit = async () => { seen = readA(); cwdDuring = process.cwd(); return { findings: [], _usage: {} }; };
    try {
      await runAuditGenerationArm({
        arm: ARM_A, auditInput: { diff: 'x', files: ['a.js'], repoRoot: repo, treeSha: caseSha }, route, runId: 'r-tree', role: 'auditor',
        _runMultiPassCodeAudit: fakeAudit, _clientFactories: spyFactories().factories,
      });
      assert.match(seen, /atCommit/);
      assert.equal(seen.includes('later'), false, 'a post-commit symbol must not be visible to the audit');
      assert.notEqual(path.resolve(cwdDuring), path.resolve(repo), 'the audit must not run in the checkout itself');
      assert.equal(path.resolve(process.cwd()), path.resolve(savedCwd), 'cwd restored');
      assert.equal(fs.existsSync(cwdDuring), false, 'the throwaway tree is removed');
      assert.equal(sh(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'no worktree left registered');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('NEGATIVE CONTROL: auditing the checkout (the old behaviour) DOES see the post-commit symbol, so the test above can fail', async () => {
    const { repo } = repoAheadOfCase();
    let seen = null;
    try {
      await runAuditGenerationArm({
        arm: ARM_A, auditInput: { diff: 'x', files: ['a.js'], repoRoot: repo, treeSha: 'unused' }, route, runId: 'r-ctl', role: 'auditor',
        _withCaseTree: fakeTree, // the old behaviour: run in repoRoot itself
        _runMultiPassCodeAudit: async () => { seen = readA(); return { findings: [], _usage: {} }; }, _clientFactories: spyFactories().factories,
      });
      assert.match(seen, /later/, 'the probe can see a post-commit symbol when the tree is the checkout');
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('a call that names no case commit is refused, never defaulted to the checkout', async () => {
    let called = false;
    await assert.rejects(() => runAuditGenerationArm({
      arm: ARM_A, auditInput: { diff: 'x', files: [], repoRoot: tmpDir }, route, runId: 'r-none', role: 'auditor',
      _runMultiPassCodeAudit: async () => { called = true; return { findings: [] }; }, _clientFactories: spyFactories().factories,
    }), /treeSha/);
    assert.equal(called, false);
  });

  test('the tree is removed even when the audit throws', async () => {
    const { repo, caseSha } = repoAheadOfCase();
    let dir = null;
    try {
      await assert.rejects(() => runAuditGenerationArm({
        arm: ARM_A, auditInput: { diff: 'x', files: ['a.js'], repoRoot: repo, treeSha: caseSha }, route, runId: 'r-throw', role: 'auditor',
        _runMultiPassCodeAudit: async () => { dir = process.cwd(); throw new Error('boom'); }, _clientFactories: spyFactories().factories,
      }), /boom/);
      assert.equal(fs.existsSync(dir), false);
      assert.equal(path.resolve(process.cwd()), path.resolve(savedCwd));
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});
