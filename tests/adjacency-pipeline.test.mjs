/**
 * @fileoverview Tier-2 orchestration test for the containment-adjacency wave —
 * the WIRING, not the detector (that is tests/adjacency-detector.test.mjs).
 *
 * Plan: docs/plans/adjacency-check-containment.md §9 "Tier 2" (Cluster C).
 *
 * Asserts INVARIANTS with canned fixtures rather than mocking a provider to
 * check call order (which would test the mock). The one that matters most:
 * **a wave's findings must actually reach `mergedResult.findings`.** The pass
 * registry's own docblock records that this seam ALREADY drifted once and
 * silently dropped the quickfix and architecture passes' findings entirely —
 * so a new wave that computes findings nobody consumes is the single most
 * likely way this integration fails, and it fails green.
 *
 * Uses `ctx.__runAdjacencyAnalysis`, the test-only injection point, so the
 * whole path runs with no Git, no filesystem walk, and no real provider.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeStubClient } from './helpers/fixtures.mjs';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
const _priorEnv = {
  MODEL_CATALOG_REFRESH: process.env.MODEL_CATALOG_REFRESH,
  LEARNING_DISABLE: process.env.LEARNING_DISABLE,
  AUDIT_DB_URL: process.env.AUDIT_DB_URL,
  AUDIT_NO_PREFLIGHT: process.env.AUDIT_NO_PREFLIGHT,
};
process.env.MODEL_CATALOG_REFRESH = 'skip';
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';
process.env.AUDIT_NO_PREFLIGHT = '1';
process.on('exit', () => {
  for (const [key, value] of Object.entries(_priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const audit = await import('../scripts/openai-audit.mjs');
const { runMultiPassCodeAudit } = audit.__testExports;

const FIXTURE_DIR = 'tests/fixtures/harness-plan';
const BACKEND_FILE = `${FIXTURE_DIR}/src/service.mjs`;
const PLAN_CONTENT = `# Adjacency Pipeline Fixture Plan\n\nImplement \`${BACKEND_FILE}\`.\n`;

const BASE_OPTS = {
  passFilter: ['adjacency'],
  noTools: true, noDebtLedger: true, noLedger: true, scopeMode: 'plan',
};

/** One trapped-statement candidate, already egress-safe — the detector's shape. */
function syntheticFacts({ safe = true } = {}) {
  return {
    coverage: { containersEnumerated: 1, statementsJudged: 6 },
    candidates: [{
      id: 'adj-synth1',
      canonicalPath: BACKEND_FILE,
      egressClassification: { category: null },
      span: { startLine: 3, endLine: 5 },
      conditionSpan: { startLine: 2, endLine: 2 },
      containerLine: 2,
      payload: safe
        ? { safe: true, statementText: 'enrich(allThings);', conditionText: 'ledger.entries.length > 0' }
        : { safe: false, reason: 'payload-tripped-egress-scan' },
      dependence: 'independent',
    }],
    incompleteness: [],
    threw: null,
  };
}

describe('adjacency wave — pass registration and --passes gating', () => {
  it('registers an adjacency pass entry and converges cleanly with no diff contract', async () => {
    const stub = makeStubClient(); // empty — throws if ANY LLM call is attempted
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS });
    assert.ok('adjacency' in result._pass_timings, 'the wave must appear in _pass_timings — ran, not silently absent');
    const adj = result.findings.filter((f) => f.category?.startsWith('[Adjacency]'));
    assert.equal(adj.length, 0, 'no auditBaseCommit → not-applicable, which is silent by design');
    assert.equal(result.verdict, 'PASS');
  });

  it('--passes excluding adjacency skips the wave even when a finding WOULD be produced', async () => {
    // The direct proof of gating: inject an analysis that yields a real
    // candidate, exclude the wave, and assert nothing comes out. (An
    // unstubbed-LLM rejection cannot be used here — `safeCallGPT` degrades
    // gracefully by design rather than throwing.)
    const stub = makeStubClient({
      adjacency_bouncer: { decisions: [{ candidateId: 'adj-synth1', decision: 'keep', severity: 'HIGH', rationale: 'x' }] },
    });
    let detectorCalls = 0;
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS,
      passFilter: ['duplication'], // anything except 'adjacency'
      __runAdjacencyAnalysis: async () => { detectorCalls += 1; return syntheticFacts(); },
    });
    assert.equal(detectorCalls, 0, 'the detector must not run at all when the wave is filtered out');
    assert.equal(result.findings.filter((f) => f.category?.startsWith('[Adjacency]')).length, 0);
  });
});

describe('adjacency wave — findings reach mergedResult and gate convergence', () => {
  it('THE WIRING PIN: a bouncer "keep" produces a finding that arrives in result.findings', async () => {
    // The passRegistry drift class: a wave can compute perfect findings that
    // nobody consumes, and the audit reads green.
    const stub = makeStubClient({
      adjacency_bouncer: { decisions: [{ candidateId: 'adj-synth1', decision: 'keep', severity: 'HIGH', rationale: 'a consumer outside the branch reads it' }] },
    });
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, __runAdjacencyAnalysis: async () => syntheticFacts(),
    });
    const adj = result.findings.filter((f) => f.category?.startsWith('[Adjacency]'));
    assert.equal(adj.length, 1, 'the finding must survive the merge into mergedResult.findings');
    assert.equal(adj[0].severity, 'HIGH');
    // is_quick_fix is the actual convergence mechanism (HIGH===0 && MEDIUM<=2 && quickFix===0).
    assert.equal(adj[0].is_quick_fix, true);
  });

  it('a bouncer "drop" produces zero findings — the wave can stay silent', async () => {
    // MIRROR: without this, the pin above could pass on a wave that always fires.
    const stub = makeStubClient({
      adjacency_bouncer: { decisions: [{ candidateId: 'adj-synth1', decision: 'drop', severity: 'MEDIUM', rationale: 'reports on the branch' }] },
    });
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, __runAdjacencyAnalysis: async () => syntheticFacts(),
    });
    assert.equal(result.findings.filter((f) => f.category?.startsWith('[Adjacency]')).length, 0);
  });

  it('a malformed bouncer response degrades to the deterministic MEDIUM, never to silence', async () => {
    const stub = makeStubClient({ adjacency_bouncer: { decisions: [] } }); // missing the required id
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, __runAdjacencyAnalysis: async () => syntheticFacts(),
    });
    const adj = result.findings.filter((f) => f.category?.startsWith('[Adjacency]'));
    const trapped = adj.filter((f) => /trapped/.test(f.category));
    assert.equal(trapped.length, 1, 'a failed judgement must fall back, not vanish');
    assert.equal(trapped[0].severity, 'MEDIUM', 'no HIGH without model judgement');
    // The degradation is ALSO reported end-to-end (G1) — the wave never
    // silently substitutes a weaker judgement for the one it promised.
    assert.ok(adj.some((f) => /coverage incomplete/.test(f.category)),
      'an incomplete judgement must surface as coverage loss through the full orchestrator path');
  });

  it('zero EGRESS-SAFE candidates → no bouncer call, and the refusal is still reported', async () => {
    // The stub throws on any LLM call, so reaching PASS proves no call was made.
    const stub = makeStubClient();
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS,
      __runAdjacencyAnalysis: async () => ({
        ...syntheticFacts({ safe: false }),
        incompleteness: [{ kind: 'excerpt-unresolvable', scope: BACKEND_FILE, detail: 'withheld — content tripped the egress scan' }],
      }),
    });
    const adj = result.findings.filter((f) => f.category?.startsWith('[Adjacency]'));
    assert.ok(adj.some((f) => /coverage incomplete/.test(f.category)), 'a withheld candidate must still surface as coverage loss');
    assert.ok(!JSON.stringify(result).includes('statementText'));
  });

  it('a detector throw becomes a convergence-blocking finding, not a silent pass', async () => {
    const stub = makeStubClient();
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, __runAdjacencyAnalysis: async () => { throw new Error('boom /home/u/.ssh/id_rsa'); },
    });
    const adj = result.findings.filter((f) => f.category?.startsWith('[Adjacency]'));
    assert.equal(adj.length, 1);
    assert.match(adj[0].detail, /ADJACENCY_DETECTOR_FAILED/);
    assert.equal(adj[0].is_quick_fix, true, '"the control did not run" must block convergence');
    assert.ok(!JSON.stringify(adj).includes('id_rsa'), 'a raw error can carry paths or credentials');
  });
});
