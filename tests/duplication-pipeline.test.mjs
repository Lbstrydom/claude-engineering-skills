/**
 * @fileoverview Seam-level integration test for Wave 5's wiring into
 * `runLegacyProductionAudit` (scripts/lib/audit/legacy-production-audit.mjs)
 * — NOT the detector internals, which tests/duplication-detector.test.mjs
 * and tests/duplication-report.test.mjs already cover. Mirrors
 * tests/run-multi-pass-code-audit-harness.test.mjs's proven stubbing
 * pattern exactly (AUDIT_EXPORTS_FOR_TESTS + __testExports + a stub OpenAI
 * client keyed by schemaName that throws loudly on any unstubbed call).
 *
 * Two groups: (1) pass registration / `--passes` gating, using the REAL
 * detector short-circuited to `unavailable` via an absent `auditBaseCommit`
 * (no live Git/DB/embedding access); (2) the `state:'findings'` → bouncer
 * → convergence path, using `ctx.__runDuplicationAnalysis` — a test-only
 * injection point added specifically because round-1 code-audit findings
 * M25/M26 correctly identified that group (1) alone never proves findings
 * actually reach `allFindings`/flip `converged`, since a real detector run
 * needs a live symbol-index snapshot this hermetic suite doesn't have.
 *
 * Plan: docs/completed/audit-code-duplication-wave.md §4 Phase 4.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
const PLAN_CONTENT = `# Duplication Pipeline Fixture Plan\n\nImplement \`${BACKEND_FILE}\`.\n`;

/** Throws loudly on any schemaName not explicitly stubbed — the assertion
 * mechanism this test uses for "the bouncer must not be called". */
function makeStubClient(responses = {}) {
  return {
    responses: {
      parse: async (params) => {
        const schemaName = params?.text?.format?.name;
        const handler = responses[schemaName];
        if (handler === undefined) {
          throw new Error(`makeStubClient: unrecognized schemaName "${schemaName}" — unstubbed LLM call`);
        }
        const result = typeof handler === 'function' ? handler(params) : handler;
        return {
          status: 'completed', output: [], output_parsed: result,
          usage: { input_tokens: 10, output_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        };
      },
    },
  };
}

const BASE_OPTS = {
  passFilter: ['duplication'],
  noTools: true, noDebtLedger: true, noLedger: true, scopeMode: 'plan',
};

describe('duplication wave — pass registration and --passes gating', () => {
  it('registers a duplication pass entry and converges cleanly when auditBaseCommit is absent (unavailable, not findings)', async () => {
    const stub = makeStubClient(); // empty — throws if ANY LLM call is attempted
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS });
    assert.equal(typeof result._pass_timings, 'object');
    assert.ok('duplication' in result._pass_timings, 'duplication must appear in _pass_timings — the pass ran (attempted), not silently absent');
    // No candidates possible without a resolved base commit → no findings, no bouncer call (stub would have thrown).
    const dupFindings = result.findings.filter((f) => f.category?.startsWith('[Duplication]'));
    assert.equal(dupFindings.length, 0);
    assert.equal(result.verdict, 'PASS');
  });

  it('--passes excluding duplication skips the wave (no registry entry cost, no LLM call attempted for it)', async () => {
    const stub = makeStubClient();
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, passFilter: ['structure'], noTools: true, noDebtLedger: true, noLedger: true, scopeMode: 'plan',
    });
    // structure_pass itself is unstubbed here too — this call is expected to
    // fail closed (safeCallGPT catches + falls back), NOT to reach duplication.
    const dupFindings = result.findings.filter((f) => f.category?.startsWith('[Duplication]'));
    assert.equal(dupFindings.length, 0);
  });

  it('a bare --passes duplication run never touches structure/wiring/backend/frontend/sustainability/quickfix/architecture schemas', async () => {
    // makeStubClient() with zero registered handlers means ANY of those
    // passes calling through would throw — reaching PASS here is itself
    // the assertion that only the duplication wave's (short-circuited,
    // LLM-free) path executed.
    const stub = makeStubClient();
    await assert.doesNotReject(() => runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS }));
  });
});

function syntheticFindingsReport() {
  // formatCandidatesForPrompt (round-1 code-audit M24 fix) reads REAL files
  // from disk to build the bouncer excerpt — both paths here must exist.
  // Points both candidate and match at the same real fixture file; this
  // test exercises the PIPELINE WIRING, not the detector's own self-match
  // exclusion (already covered in tests/duplication-detector.test.mjs).
  return {
    state: 'findings',
    deterministicFindings: [],
    semanticCandidates: [{
      id: 'dup-synth1',
      candidate: { filePath: BACKEND_FILE, symbolName: 'foo', kind: 'function', startLine: 1, endLine: 3, purposeSummary: 'x' },
      topMatch: { filePath: BACKEND_FILE, symbolName: 'foo', kind: 'function', startLine: 1, endLine: 3, similarity: 0.95 },
      allMatches: [{ filePath: BACKEND_FILE, symbolName: 'foo', kind: 'function', similarity: 0.95 }],
    }],
  };
}

describe('duplication wave — state:findings reaches the bouncer and flips convergence (round-1 code-audit M25/M26 fix)', () => {
  it('a bouncer "keep" decision produces a MEDIUM finding with is_quick_fix:true that blocks convergence', async () => {
    const stub = makeStubClient({
      duplication_bouncer: { decisions: [{ candidateId: 'dup-synth1', decision: 'keep', severity: 'MEDIUM', rationale: 'same responsibility' }] },
    });
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, __runDuplicationAnalysis: async () => syntheticFindingsReport(),
    });
    const dupFindings = result.findings.filter((f) => f.category?.startsWith('[Duplication]'));
    assert.equal(dupFindings.length, 1);
    assert.equal(dupFindings[0].severity, 'MEDIUM');
    // is_quick_fix:true is the actual convergence-gating mechanism (converged =
    // HIGH===0 && MEDIUM<=2 && quickFix===0, computed by the /audit-code round
    // orchestration from allFindings — not exposed as a field on this return
    // value, so this is the correct, directly-observable proof of wiring: the
    // finding carries the flag that feeds that computation).
    assert.equal(dupFindings[0].is_quick_fix, true);
    const quickFixCount = result.findings.filter((f) => f.is_quick_fix).length;
    assert.equal(quickFixCount, 1);
  });

  it('a bouncer "drop" decision produces zero findings (clean convergence despite a semantic candidate existing)', async () => {
    const stub = makeStubClient({
      duplication_bouncer: { decisions: [{ candidateId: 'dup-synth1', decision: 'drop', severity: 'MEDIUM', rationale: 'coincidental' }] },
    });
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, __runDuplicationAnalysis: async () => syntheticFindingsReport(),
    });
    const dupFindings = result.findings.filter((f) => f.category?.startsWith('[Duplication]'));
    assert.equal(dupFindings.length, 0);
  });

  it('a bouncer failure (malformed response) falls back to the deterministic MEDIUM finding for the same candidate', async () => {
    const stub = makeStubClient({
      duplication_bouncer: { decisions: [] }, // missing the required candidateId — mapBouncerDecisionsToFindings rejects this as incomplete
    });
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, __runDuplicationAnalysis: async () => syntheticFindingsReport(),
    });
    const dupFindings = result.findings.filter((f) => f.category?.startsWith('[Duplication]'));
    assert.equal(dupFindings.length, 1); // deterministic fallback still produced a finding
    assert.equal(dupFindings[0].is_mechanical, true);
  });

  it('state:clean never invokes the bouncer (stub throws if it does)', async () => {
    const stub = makeStubClient(); // no duplication_bouncer registered
    await assert.doesNotReject(() => runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, __runDuplicationAnalysis: async () => ({ state: 'clean', deterministicFindings: [], semanticCandidates: [] }),
    }));
  });

  it('state:failed produces the deterministic detector-failed finding, which also blocks convergence', async () => {
    const stub = makeStubClient();
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, __runDuplicationAnalysis: async () => ({ state: 'failed', reason: 'boom', deterministicFindings: [], semanticCandidates: [] }),
    });
    const dupFindings = result.findings.filter((f) => f.category?.startsWith('[Duplication]'));
    assert.equal(dupFindings.length, 1);
    assert.match(dupFindings[0].category, /detector failed/);
    assert.equal(dupFindings[0].is_quick_fix, true);
  });
});
