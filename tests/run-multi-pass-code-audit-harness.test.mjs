/**
 * @fileoverview Tier 2 (LLM-orchestration invariants) regression harness for
 * `runMultiPassCodeAudit` — tiered-recall audit pipeline Phase 10.
 *
 * Follows the EXISTING stubbing pattern in `tests/openai-wrapper-contract.test.mjs`
 * exactly: `AUDIT_EXPORTS_FOR_TESTS=1` + `__testExports` + a stub OpenAI client
 * whose `responses.parse(params)` dispatches on `params.text.format.name`
 * (the schemaName). No live model calls; canned-response fixtures only.
 *
 * Per this repo's testing doctrine (AGENTS.md): assert INVARIANTS, never
 * exact prose. One test per row of the plan's Phase 10 bullet: merge/dedup,
 * verdict computation, R2+ suppression, partial-failure resilience,
 * mechanical-pass wiring, telemetry shape, return-value regression guard.
 *
 * This harness is the regression BASELINE Phase 11's extraction is verified
 * against — same stubs, same fixtures, same assertions, run a second time
 * through `runLegacyProductionAudit` (Phase 11's "Regression coverage for
 * the split" bullet). Per Phase 11's own text, the FINAL committed shape of
 * this file runs against `runMultiPassCodeAudit` (openai-audit.mjs's thin
 * chooser, __testExports-exposed) — which, with `tieredAuditConfig
 * .pipelineEnabled` defaulted `false`, delegates to `runLegacyProductionAudit`
 * exactly as this harness originally targeted pre-extraction. The same
 * invariants therefore exercise the SAME code path end-to-end.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 10.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
// Air-gap every side-effecting subsystem this harness doesn't want to
// exercise for real (cloud store, model-catalog refresh, quickfix hook) —
// mirrors tests/audit-no-files-cli.test.mjs's env. audit-code fix H13
// (Cluster E round 1): unconditional override, not `||=` — a developer/CI
// environment with a LIVE AUDIT_DB_URL/LEARNING_DISABLE already set must
// still be air-gapped here (a `||=` silently preserves and USES a live
// value instead of isolating it, defeating the comment's own stated intent).
// Prior values are captured and restored on exit so this file's overrides
// never leak into a differently-configured process.
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
const { LlmError } = await import('../scripts/lib/robustness.mjs');
const { ExecutionMetaSchema, buildExecutionMeta } = await import('../scripts/lib/schemas.mjs');
const { runMultiPassCodeAudit, buildAuditRunContext, runLegacyProductionAudit } = audit.__testExports;

// ── Fixture plan + files ────────────────────────────────────────────────
const FIXTURE_DIR = 'tests/fixtures/harness-plan';
const BACKEND_FILE = `${FIXTURE_DIR}/src/service.mjs`;
const FRONTEND_FILE = `${FIXTURE_DIR}/src/components/Widget.jsx`;

const PLAN_CONTENT = `# Harness Fixture Plan

Implement \`${BACKEND_FILE}\` and \`${FRONTEND_FILE}\`.
`;

// Under the map-reduce / high-reasoning-map-reduce / backend-split thresholds
// (12/15/8 files by default) — one backend file, one frontend file — so
// map-reduce and split-backend branches never trigger.
const BASE_OPTS = {
  passFilter: ['structure', 'wiring', 'backend', 'frontend', 'sustainability', 'quickfix'],
  noTools: true,
  noDebtLedger: true,
  scopeMode: 'plan',
};

// ── Canned per-pass response builders ──────────────────────────────────
const CLASSIFICATION = { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'test-stub' };

function mkFinding(overrides = {}) {
  return {
    id: 'H1', severity: 'HIGH', category: 'Test Category', section: `${BACKEND_FILE}:1`,
    detail: 'canned test finding detail', risk: 'canned risk', recommendation: 'canned recommendation',
    is_quick_fix: false, is_mechanical: false, principle: 'Test Principle',
    classification: CLASSIFICATION,
    ...overrides,
  };
}

const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 2, files_found: 2, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'structure ok' };
const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'wiring ok' };
const EMPTY_BACKEND = { pass_name: 'backend', findings: [], quick_fix_warnings: [], summary: 'backend ok' };
const EMPTY_FRONTEND = { pass_name: 'frontend', findings: [], quick_fix_warnings: [], summary: 'frontend ok' };
const EMPTY_SUSTAIN = { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'sustainability ok' };
const EMPTY_QUICKFIX = { pass_name: 'quickfix', findings: [], summary: 'quickfix ok' };

/**
 * Build a stub OpenAI client. `responses` maps schemaName -> either a plain
 * result object (returned as `output_parsed`) or a function `(params) =>
 * result | throw`. An unrecognized schemaName throws loudly — per the task
 * brief, so a threshold miscalculation (an unexpected map-reduce/architecture
 * pass firing) surfaces as a test failure, not a silently-wrong response.
 */
function makeStubClient(responses) {
  return {
    responses: {
      parse: async (params) => {
        const schemaName = params?.text?.format?.name;
        const handler = responses[schemaName];
        if (handler === undefined) {
          throw new Error(`makeStubClient: unrecognized schemaName "${schemaName}" — a threshold miscalculation or unexpected pass fired. Known passes stubbed: ${Object.keys(responses).join(', ')}`);
        }
        const result = typeof handler === 'function' ? handler(params) : handler;
        return {
          status: 'completed',
          output: [],
          output_parsed: result,
          usage: {
            input_tokens: 100, output_tokens: 50,
            prompt_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
        };
      },
    },
  };
}

function defaultResponses(overrides = {}) {
  return {
    structure_pass: EMPTY_STRUCTURE,
    wiring_pass: EMPTY_WIRING,
    backend_pass: EMPTY_BACKEND,
    frontend_pass: EMPTY_FRONTEND,
    sustainability_pass: EMPTY_SUSTAIN,
    quickfix_pass: EMPTY_QUICKFIX,
    ...overrides,
  };
}

function mkTmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('runMultiPassCodeAudit harness — merge/dedup', () => {
  it('two passes returning the exact same finding collapse into one entry in mergedResult.findings', async () => {
    const dupe = mkFinding({ category: 'Duplicate Category', section: `${BACKEND_FILE}:10`, detail: 'the same exact finding text' });
    const stub = makeStubClient(defaultResponses({
      structure_pass: { ...EMPTY_STRUCTURE, findings: [dupe] },
      wiring_pass: { ...EMPTY_WIRING, findings: [dupe] },
    }));
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS, noLedger: true });
    const matches = result.findings.filter(f => f.detail === 'the same exact finding text');
    assert.equal(matches.length, 1, 'exact-duplicate findings from two passes must collapse to one');
  });
});

describe('runMultiPassCodeAudit harness — verdict computation', () => {
  it('PASS: no findings at all', async () => {
    const stub = makeStubClient(defaultResponses());
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS, noLedger: true });
    assert.equal(result.verdict, 'PASS');
  });

  it('SIGNIFICANT_ISSUES: any HIGH finding present', async () => {
    const stub = makeStubClient(defaultResponses({
      backend_pass: { ...EMPTY_BACKEND, findings: [mkFinding({ severity: 'HIGH' })] },
    }));
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS, noLedger: true });
    assert.equal(result.verdict, 'SIGNIFICANT_ISSUES');
  });

  it('NEEDS_FIXES: more than 2 MEDIUM findings, no HIGH', async () => {
    const meds = [1, 2, 3].map(i => mkFinding({ id: `M${i}`, severity: 'MEDIUM', category: `Medium ${i}`, detail: `medium finding ${i}` }));
    const stub = makeStubClient(defaultResponses({
      backend_pass: { ...EMPTY_BACKEND, findings: meds },
    }));
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS, noLedger: true });
    assert.equal(result.verdict, 'NEEDS_FIXES');
  });
});

describe('runMultiPassCodeAudit harness — R2+ suppression', () => {
  it('a --round 2 finding matching a dismissed ledger entry is excluded from findings and counted in _suppression', async () => {
    const category = 'Dismissed Category';
    const section = `${BACKEND_FILE}:5`;
    const detail = 'a finding that was already dismissed in round 1';
    const ledgerPath = mkTmpFile('ledger.json', JSON.stringify({
      version: 1,
      entries: [{
        topicId: 'topic-dismissed-1', semanticHash: 'hash-1', severity: 'MEDIUM',
        category, section, detailSnapshot: detail,
        affectedFiles: [BACKEND_FILE], affectedPrinciples: [], pass: 'backend',
        source: 'session', adjudicationOutcome: 'dismissed', remediationState: 'pending',
        originalSeverity: 'MEDIUM', ruling: 'sustain', rulingRationale: 'r', resolvedRound: 1,
      }],
    }));
    const stub = makeStubClient(defaultResponses({
      backend_pass: { ...EMPTY_BACKEND, findings: [mkFinding({ severity: 'MEDIUM', category, section, detail })] },
    }));
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, round: 2, ledgerFile: ledgerPath, noLedger: false, changedFiles: [],
    });
    const stillPresent = result.findings.some(f => f.detail === detail);
    assert.equal(stillPresent, false, 'a round-2 finding matching a dismissed ledger entry must be excluded');
    assert.ok(result._suppression, '_suppression must be populated on an R2+ run with a matching dismissal');
    assert.ok(result._suppression.suppressedCount >= 1, '_suppression.suppressedCount must reflect the dismissal');
    fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // Regression: `validateLedgerForR2` counted entries it dropped as malformed
  // and reported the count on stderr ONLY — the field was returned but never
  // read, so a round whose suppression ran against a TRUNCATED ruling set was
  // indistinguishable downstream from one that ran against a complete one.
  // Same class as `suppressionUnavailable`, and it travels the same channel.
  const DISMISSED_ENTRY = {
    topicId: 'topic-dismissed-1', semanticHash: 'hash-1', severity: 'MEDIUM',
    category: 'Dismissed Category', section: `${BACKEND_FILE}:5`,
    detailSnapshot: 'a finding that was already dismissed in round 1',
    affectedFiles: [BACKEND_FILE], affectedPrinciples: [], pass: 'backend',
    source: 'session', adjudicationOutcome: 'dismissed', remediationState: 'pending',
    originalSeverity: 'MEDIUM', ruling: 'sustain', rulingRationale: 'r', resolvedRound: 1,
  };

  async function runRound2WithLedger(entries) {
    const ledgerPath = mkTmpFile('ledger.json', JSON.stringify({ version: 1, entries }));
    try {
      const stub = makeStubClient(defaultResponses({
        backend_pass: {
          ...EMPTY_BACKEND,
          findings: [mkFinding({
            severity: 'MEDIUM', category: DISMISSED_ENTRY.category,
            section: DISMISSED_ENTRY.section, detail: DISMISSED_ENTRY.detailSnapshot,
          })],
        },
      }));
      return await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
        ...BASE_OPTS, round: 2, ledgerFile: ledgerPath, noLedger: false, changedFiles: [],
      });
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  it('a ledger with entries dropped as malformed reports the count in _executionMeta.ledgerInvalidEntryCount', async () => {
    // One adjudicated entry survives; two are genuinely malformed (neither
    // LedgerEntrySchema nor the pre-adjudication BatchLedgerEntrySchema).
    const result = await runRound2WithLedger([
      DISMISSED_ENTRY,
      { topicId: 'broken-1' },
      { topicId: 'broken-2', adjudicationOutcome: 'pending' },
    ]);
    assert.equal(
      result._executionMeta?.ledgerInvalidEntryCount, 2,
      'a round that suppressed against a truncated ruling set must say so in _executionMeta',
    );
    // The degradation signal must not disturb the suppression it reports on:
    // the one VALID entry still suppresses its finding.
    assert.equal(
      result.findings.some(f => f.detail === DISMISSED_ENTRY.detailSnapshot), false,
      'the surviving valid entry must still suppress its finding',
    );
  });

  it('negative control — a fully-valid ledger emits no ledgerInvalidEntryCount', async () => {
    const result = await runRound2WithLedger([DISMISSED_ENTRY]);
    assert.equal(
      result._executionMeta?.ledgerInvalidEntryCount, undefined,
      'a clean ledger must not report degradation (guards a hardcoded / always-on key)',
    );
  });

  // ── _executionMeta conforms to its declared contract ───────────────────
  //
  // `ExecutionMetaSchema` called itself the typed SSOT for this block while
  // being applied by nothing: it was imported by two files and used by neither,
  // so every field in it was documentation and a typo'd key reached
  // `audit-loop.mjs` unchallenged. Enforcement now lives in
  // `buildExecutionMeta()`, which both producers construct through.
  //
  // This assertion is the POSITIVE CONTROL for that wiring — it proves the
  // strict contract accepts what the pipeline really emits, so the tightening
  // did not simply move the divergence into a schema that rejects reality.
  it('the _executionMeta a real run emits satisfies the strict schema', async () => {
    const degraded = await runRound2WithLedger([
      DISMISSED_ENTRY,
      { topicId: 'broken-1' },
    ]);
    assert.ok(degraded._executionMeta, 'a degraded round must emit the block at all');
    const parsed = ExecutionMetaSchema.safeParse(degraded._executionMeta);
    assert.ok(
      parsed.success,
      `producer output must satisfy ExecutionMetaSchema, got: ${JSON.stringify(parsed.error?.issues)}`,
    );

    // Absence is also a legal value, and must stay legal — a clean round emits
    // no block, and a schema that rejected that would fail every good run.
    const clean = await runRound2WithLedger([DISMISSED_ENTRY]);
    assert.equal(clean._executionMeta, undefined, 'a clean round emits no block');
    assert.ok(ExecutionMetaSchema.safeParse(clean._executionMeta).success);
  });
});

describe('buildExecutionMeta — the producers\' construction point rejects malformed blocks', () => {
  // Red-then-green for the wiring above. These exercise the EXACT function both
  // `_executionMeta` emit sites in legacy-production-audit.mjs call, so a
  // rejection here is a rejection on the producer path.

  it('rejects a typo\'d key rather than silently dropping it', () => {
    // The load-bearing case. A plain `z.object` STRIPS an unknown key — it
    // parses clean and returns `{}` — so the permissive schema would have
    // accepted this and emitted a block missing the count entirely, leaving
    // audit-loop.mjs to read `?? 0` and count a truncated round as clean.
    assert.throws(
      () => buildExecutionMeta({ ledgerInvalidEntryCounts: 2 }),
      /ledgerInvalidEntryCounts|Unrecognized key/,
      'a misspelled field name must fail loudly, not vanish',
    );
  });

  it('rejects a wrong type on a declared field', () => {
    assert.throws(() => buildExecutionMeta({ suppressionUnavailable: 'yes' }), /suppressionUnavailable/);
    assert.throws(() => buildExecutionMeta({ ledgerInvalidEntryCount: 1.5 }), /ledgerInvalidEntryCount/);
    assert.throws(() => buildExecutionMeta({ reduceStatus: 'exploded' }), /reduceStatus/);
  });

  it('accepts every field the producers actually emit', () => {
    // Mirrors the two real emit sites: the reduce-failure pass block and the
    // merged-run degradation block.
    assert.deepEqual(
      buildExecutionMeta({ reduceStatus: 'model_error', reduceSkipped: true }),
      { reduceStatus: 'model_error', reduceSkipped: true },
    );
    assert.deepEqual(
      buildExecutionMeta({ suppressionUnavailable: true, ledgerInvalidEntryCount: 2 }),
      { suppressionUnavailable: true, ledgerInvalidEntryCount: 2 },
    );
  });

  it('collapses an all-absent block to undefined, preserving omit-vs-zero', () => {
    // The producers pass `undefined` for anything not degraded. A `{}` here
    // would make every clean round carry an empty block, turning "nothing
    // degraded" into a measurement someone took.
    assert.equal(buildExecutionMeta({}), undefined);
    assert.equal(
      buildExecutionMeta({ suppressionUnavailable: undefined, ledgerInvalidEntryCount: undefined }),
      undefined,
    );
  });
});

describe('runMultiPassCodeAudit harness — partial-failure resilience', () => {
  it('one pass throwing never crashes the run; other passes\' findings still surface', async () => {
    const survivorFinding = mkFinding({ category: 'Survivor', section: `${FRONTEND_FILE}:1`, detail: 'a finding from the pass that did NOT fail' });
    const stub = makeStubClient(defaultResponses({
      backend_pass: () => { throw new LlmError('simulated provider timeout', { category: 'http-503', retryable: false }); },
      frontend_pass: { ...EMPTY_FRONTEND, findings: [survivorFinding] },
    }));
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS, noLedger: true });
    assert.ok(Array.isArray(result._failed_passes) && result._failed_passes.length > 0, '_failed_passes must be populated when a pass fails');
    const survived = result.findings.some(f => f.detail === 'a finding from the pass that did NOT fail');
    assert.equal(survived, true, 'findings from the OTHER (successful) pass must still be present');
  });
});

describe('runMultiPassCodeAudit harness — mechanical pass wiring', () => {
  it('runOrphanIntroducedPass runs without crashing alongside LLM passes, and its findings (if any) merge with the standard shape', async () => {
    const llmFinding = mkFinding({ category: 'LLM Finding', section: `${BACKEND_FILE}:2`, detail: 'an LLM-produced finding, present regardless of orphan output' });
    const stub = makeStubClient(defaultResponses({
      backend_pass: { ...EMPTY_BACKEND, findings: [llmFinding] },
    }));
    // Include the mechanical (non-LLM) orphan-introduced pass — no schemaName
    // stub needed for it (it never calls the GPT client at all).
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      ...BASE_OPTS, passFilter: [...BASE_OPTS.passFilter, 'orphan-introduced'], noLedger: true,
    });
    assert.ok(Array.isArray(result.findings));
    const llmSurvived = result.findings.some(f => f.detail === 'an LLM-produced finding, present regardless of orphan output');
    assert.equal(llmSurvived, true, 'LLM findings must still merge correctly when the mechanical pass also runs');
    // Orphan findings are git-diff-derived (HEAD~1..HEAD of the real repo) —
    // not fixture-controlled, so this repo's current commit history may or
    // may not produce any for this run. WHEN present, they must carry the
    // same standard finding shape (category prefixed "[Orphan]", a _pass tag)
    // as every other pass's output — proving the wiring, not forcing a
    // specific count.
    const orphanFindings = result.findings.filter(f => f._pass === 'Orphan');
    for (const f of orphanFindings) {
      assert.match(f.category, /^\[Orphan\]/, 'orphan findings must carry the standard [Orphan]-prefixed category the merge step assigns');
      assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(f.severity));
    }
  });
});

describe('runMultiPassCodeAudit harness — telemetry shape', () => {
  it('_pass_timings, _usage, _cacheMetrics are present and structurally valid', async () => {
    const stub = makeStubClient(defaultResponses());
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS, noLedger: true });

    assert.equal(typeof result._pass_timings, 'object');
    for (const key of ['structure', 'wiring', 'backend', 'frontend', 'sustainability', 'quickfix', 'total']) {
      assert.equal(typeof result._pass_timings[key], 'string', `_pass_timings.${key} must be a string (e.g. "0.3s")`);
    }

    assert.equal(typeof result._usage, 'object');
    for (const key of ['input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens', 'latency_ms']) {
      assert.equal(typeof result._usage[key], 'number', `_usage.${key} must be a number`);
    }

    assert.equal(typeof result._cacheMetrics, 'object');
    assert.equal(typeof result._cacheMetrics.totalInputTokens, 'number');
    assert.equal(typeof result._cacheMetrics.totalCachedTokens, 'number');
    assert.equal(typeof result._cacheMetrics.hitRate, 'number');
    assert.equal(typeof result._cacheMetrics.perPass, 'object');
  });
});

describe('runMultiPassCodeAudit harness — return-value regression guard', () => {
  it('mergedResult is equivalent whether --out is set or not (module output ignoring timestamps/durations)', async () => {
    const finding = mkFinding({ category: 'Stable', section: `${BACKEND_FILE}:3`, detail: 'a stable finding used to compare both invocations' });
    const responses = defaultResponses({ backend_pass: { ...EMPTY_BACKEND, findings: [finding] } });

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-out-'));
    const outFile = path.join(outDir, 'result.json');

    const stubA = makeStubClient(responses);
    const withOut = await runMultiPassCodeAudit(stubA, PLAN_CONTENT, '', false, outFile, '', { ...BASE_OPTS, noLedger: true });

    const stubB = makeStubClient(responses);
    const withoutOut = await runMultiPassCodeAudit(stubB, PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS, noLedger: true });

    // Strip non-deterministic / presentation-only fields before comparing —
    // wall-clock timings, run ids, and cache-dir-derived paths legitimately
    // differ between two real invocations; the SUBSTANTIVE result (verdict,
    // findings, counts) must not.
    const strip = (r) => {
      const { _pass_timings, _usage, _cacheMetrics, _sid, _cloudRunId, ...rest } = r;
      return { ...rest, _toolCapability: { ...rest._toolCapability, timestamp: undefined } };
    };
    assert.deepEqual(strip(withOut), strip(withoutOut), 'mergedResult must be equivalent (module output) regardless of whether --out was set');
    assert.ok(fs.existsSync(outFile), '--out must still write the result file');

    fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});

describe('runMultiPassCodeAudit harness — Phase 11 extraction baseline (direct runLegacyProductionAudit call)', () => {
  it('runLegacyProductionAudit, called directly via buildAuditRunContext, produces the same verdict/findings as the chooser', async () => {
    const finding = mkFinding({ severity: 'HIGH', category: 'Direct Call', section: `${BACKEND_FILE}:7`, detail: 'exercises runLegacyProductionAudit directly, not through the chooser' });
    const responses = defaultResponses({ backend_pass: { ...EMPTY_BACKEND, findings: [finding] } });

    // Through the chooser (pipelineEnabled defaults false → delegates to
    // runLegacyProductionAudit internally).
    const viaChooser = await runMultiPassCodeAudit(makeStubClient(responses), PLAN_CONTENT, '', false, null, '', { ...BASE_OPTS, noLedger: true });

    // Directly against runLegacyProductionAudit via buildAuditRunContext —
    // Phase 11's own "Regression coverage for the split" / "Verification"
    // instruction: re-run this harness's assertions against the extracted
    // function directly, proving the extraction preserved behavior.
    const ctx = await buildAuditRunContext({
      openai: makeStubClient(responses), planContent: PLAN_CONTENT, projectContext: '', historyContext: '',
      ...BASE_OPTS, noLedger: true,
    });
    const direct = await runLegacyProductionAudit(ctx);

    assert.equal(direct.verdict, viaChooser.verdict);
    assert.equal(direct.verdict, 'SIGNIFICANT_ISSUES');
    assert.deepEqual(
      direct.findings.map(f => f.detail),
      viaChooser.findings.map(f => f.detail),
    );
    assert.equal(direct.runStatus, 'complete');
    assert.deepEqual(direct.generatorOutcomes, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Backlog-triage bug #4 (fixed 2026-08-20): the ledger auto-write used to
// run BEFORE the deterministic existence-verification gate, so every
// finding — including one the gate went on to REFUTE (prove false) a few
// lines later — was persisted as `adjudicationOutcome: 'pending'`, and
// nothing ever went back to correct it. A refuted finding was excluded
// from the verdict count but sat in the ledger forever with no record it
// had been disproven. The gate now runs first, so a refuted finding is
// known to be false at the moment it is written.
// ═══════════════════════════════════════════════════════════════════════
describe('runMultiPassCodeAudit harness — ledger write reflects the existence gate (bug #4 fix)', () => {
  it('a finding the existence gate REFUTES is persisted to the ledger as dismissed, with the disproof reason recorded — not pending', async () => {
    const ledgerPath = mkTmpFile('ledger.json', JSON.stringify({ version: 1, entries: [] }));
    const category = 'Missing Module Refuted';
    const section = `${BACKEND_FILE}:1`;
    // Same phrasing already proven (in tests/finding-verification.test.mjs)
    // to classify as an existence claim and resolve against the repo
    // inventory — BACKEND_FILE is a real, tracked fixture file, so the gate
    // must refute this claim (the cited module DOES exist).
    const detail = `The module \`${BACKEND_FILE}\` does not exist.`;
    try {
      const stub = makeStubClient(defaultResponses({
        backend_pass: { ...EMPTY_BACKEND, findings: [mkFinding({ severity: 'HIGH', category, section, detail })] },
      }));
      const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
        ...BASE_OPTS, round: 1, ledgerFile: ledgerPath, noLedger: false,
      });

      // Sanity: the gate really did refute this finding in the merged result
      // (refuted findings stay in findings[], only the verdict count excludes
      // them — verify the fixture actually exercises the refutation path
      // before trusting the ledger assertion below).
      const refutedInResult = result.findings.find((f) => f.detail === detail);
      assert.ok(refutedInResult, 'the refuted finding must still be present in findings[]');
      assert.equal(
        refutedInResult.verification?.verification, 'refuted',
        'sanity check: the existence gate must have refuted this finding (the cited file really exists in this repo)',
      );

      const ledgerOnDisk = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
      // Matched by `detailSnapshot`, not `category` — the merge step prefixes
      // category with the originating pass name (e.g. `[backend] …`), so an
      // exact-category match is brittle to that unrelated behavior.
      const entry = ledgerOnDisk.entries.find((e) => e.detailSnapshot === detail);
      assert.ok(entry, 'the refuted finding must still have been written to the ledger');
      assert.equal(
        entry.adjudicationOutcome, 'dismissed',
        'a finding already proven false by the gate must not land in the ledger as `pending` with no record it was ever disproven',
      );
      assert.ok(entry.rulingRationale, 'the disproof reason must be recorded on the ledger entry, not silently dropped');
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('negative control — a genuine (non-refuted) finding is still persisted as pending, unaffected by the reorder', async () => {
    const ledgerPath = mkTmpFile('ledger.json', JSON.stringify({ version: 1, entries: [] }));
    const category = 'Real Non-Refuted Finding';
    const section = `${BACKEND_FILE}:2`;
    const detail = 'a genuine finding with no existence claim in it at all';
    try {
      const stub = makeStubClient(defaultResponses({
        backend_pass: { ...EMPTY_BACKEND, findings: [mkFinding({ severity: 'HIGH', category, section, detail })] },
      }));
      await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
        ...BASE_OPTS, round: 1, ledgerFile: ledgerPath, noLedger: false,
      });
      const ledgerOnDisk = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
      const entry = ledgerOnDisk.entries.find((e) => e.detailSnapshot === detail);
      assert.ok(entry, 'the finding must have been written to the ledger');
      assert.equal(
        entry.adjudicationOutcome, 'pending',
        'a finding the gate never touched must stay pending — only gate-refuted findings are auto-dismissed',
      );
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
