/**
 * @fileoverview Golden-master characterization harness for the finalization
 * tail (docs/plans/legacy-production-audit-decomposition.md Phase 4a).
 *
 * The tail (`runLegacyProductionAudit`'s post-wave body) is not itself an
 * exported, independently-callable unit — it is inline body closing over the
 * function's own locals. The baseline is therefore captured through the ONE
 * seam that genuinely is callable: `runLegacyProductionAudit` itself, run
 * end-to-end via `buildAuditRunContext`, reusing this repo's own proven
 * stub-client harness pattern (`tests/run-multi-pass-code-audit-harness.test.mjs`,
 * itself the baseline Phase 11's earlier extraction was verified against —
 * same technique, one decomposition later).
 *
 * Per this repo's testing doctrine (Tier 2: invariants + canned fixtures,
 * never a whole-provider mock): this harness runs with cloud OFF
 * (AUDIT_DB_URL='', matching the existing harness's air-gap) — cloudRunId
 * stays null throughout, so it exercises every LOCAL-only code path in the
 * tail (finding assembly, dedup, verdict, ledger read/write, session
 * manifest, cache-metrics.jsonl) but structurally cannot reach the
 * cloud-write branches (cloud run-record finalization, commit-provenance
 * evidence, pass-stats/shadow/bandit cloud sync) — those are gated on
 * `cloudRunId`, which requires a live store connection this harness
 * deliberately does not fake (a whole-provider/store mock is exactly what
 * the doctrine forbids). Cloud-write ORDERING and await-safety are instead
 * covered by the existing static guards (`tests/run-finalisation-awaited.test.mjs`,
 * `tests/audit-store-durability-call-site.test.mjs`) — both re-pointed at the
 * new files once Phase 4c/4d land — plus each extraction being a byte-for-byte
 * relocation, verified directly against the pre-move source.
 *
 * Each scenario's normalized snapshot is captured NOW, before any of
 * 4b/4c/4d's code moves, and re-asserted after each move lands — this file
 * does not change across Phase 4's sub-phases; only the module under the
 * `buildAuditRunContext`/`runLegacyProductionAudit` seam does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const { LlmError } = await import('../scripts/lib/robustness.mjs');
const { buildAuditRunContext, runLegacyProductionAudit } = audit.__testExports;

const FIXTURE_DIR = 'tests/fixtures/harness-plan';
const BACKEND_FILE = `${FIXTURE_DIR}/src/service.mjs`;
const FRONTEND_FILE = `${FIXTURE_DIR}/src/components/Widget.jsx`;
const PLAN_CONTENT = `# Harness Fixture Plan\n\nImplement \`${BACKEND_FILE}\` and \`${FRONTEND_FILE}\`.\n`;

const BASE_OPTS = {
  passFilter: ['structure', 'wiring', 'backend', 'frontend', 'sustainability', 'quickfix'],
  noTools: true,
  noDebtLedger: true,
  scopeMode: 'plan',
};

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

function defaultResponses(overrides = {}) {
  return {
    structure_pass: EMPTY_STRUCTURE, wiring_pass: EMPTY_WIRING, backend_pass: EMPTY_BACKEND,
    frontend_pass: EMPTY_FRONTEND, sustainability_pass: EMPTY_SUSTAIN, quickfix_pass: EMPTY_QUICKFIX,
    ...overrides,
  };
}

function makeStubClient(responses) {
  return {
    responses: {
      parse: async (params) => {
        const schemaName = params?.text?.format?.name;
        const handler = responses[schemaName];
        if (handler === undefined) {
          throw new Error(`makeStubClient: unrecognized schemaName "${schemaName}"`);
        }
        const result = typeof handler === 'function' ? handler(params) : handler;
        return {
          status: 'completed', output: [], output_parsed: result,
          usage: { input_tokens: 100, output_tokens: 50, prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } },
        };
      },
    },
  };
}

function mkTmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalization-char-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return { filePath, dir };
}

/**
 * Normalize a mergedResult to its OBSERVABLE, deterministic substance —
 * strips wall-clock timings, run ids, and cache-dir-derived paths (same
 * fields the existing return-value regression guard strips), and reduces
 * findings to their stable identity (id, severity, category, detail,
 * _pass) so the snapshot survives a pure code relocation but would catch a
 * genuine behavior change (a dropped/reordered/reclassified finding, a
 * changed verdict, a changed runStatus).
 */
function snapshot(result) {
  return {
    verdict: result.verdict,
    runStatus: result.runStatus,
    generatorOutcomes: result.generatorOutcomes,
    findings: result.findings.map(f => ({ id: f.id, severity: f.severity, category: f.category, detail: f.detail, _pass: f._pass })),
    files_planned: result.files_planned,
    files_found: result.files_found,
    files_missing: result.files_missing,
    wiring_issues: result.wiring_issues,
    quick_fix_warnings: result.quick_fix_warnings,
    dead_code: result.dead_code,
    _failed_passes: result._failed_passes ?? null,
    _executionMeta: result._executionMeta ?? null,
    _suppression: result._suppression
      ? { keptCount: result._suppression.keptCount, suppressedCount: result._suppression.suppressedCount, reopenedCount: result._suppression.reopenedCount }
      : null,
    hasCacheMetrics: typeof result._cacheMetrics === 'object' && result._cacheMetrics !== null,
    hasUsage: typeof result._usage === 'object' && result._usage !== null,
    hasPassTimings: typeof result._pass_timings === 'object' && result._pass_timings !== null,
  };
}

async function runScenario(responses, opts) {
  const ctx = await buildAuditRunContext({
    openai: makeStubClient(responses), planContent: PLAN_CONTENT, projectContext: '', historyContext: '',
    ...BASE_OPTS, ...opts,
  });
  return runLegacyProductionAudit(ctx);
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe('finalization characterization — golden-master snapshots', () => {
  it('scenario 1: round 1, empty pass (clean run)', async () => {
    const result = await runScenario(defaultResponses(), { noLedger: true, round: 1 });
    assert.deepEqual(snapshot(result), {
      verdict: 'PASS', runStatus: 'complete', generatorOutcomes: [],
      findings: [], files_planned: 2, files_found: 2, files_missing: 0,
      wiring_issues: [], quick_fix_warnings: [], dead_code: [],
      _failed_passes: null, _executionMeta: null, _suppression: null,
      hasCacheMetrics: true, hasUsage: true, hasPassTimings: true,
    });
  });

  it('scenario 2: round 1 with a HIGH finding (SIGNIFICANT_ISSUES verdict)', async () => {
    const finding = mkFinding({ severity: 'HIGH', category: 'Scenario 2', detail: 'scenario-2 high finding' });
    const result = await runScenario(defaultResponses({ backend_pass: { ...EMPTY_BACKEND, findings: [finding] } }), { noLedger: true, round: 1 });
    const snap = snapshot(result);
    assert.equal(snap.verdict, 'SIGNIFICANT_ISSUES');
    assert.equal(snap.runStatus, 'complete');
    assert.equal(snap.findings.length, 1);
    assert.equal(snap.findings[0].detail, 'scenario-2 high finding');
    assert.equal(snap.findings[0].severity, 'HIGH');
  });

  it('scenario 3: round 2+ with a ledger ruling (dismissed entry suppressed)', async () => {
    const category = 'Scenario 3 Dismissed';
    const section = `${BACKEND_FILE}:5`;
    const detail = 'a finding already dismissed in round 1';
    const { filePath: ledgerPath, dir } = mkTmpFile('ledger.json', JSON.stringify({
      version: 1,
      entries: [{
        topicId: 'topic-s3-1', semanticHash: 'hash-s3-1', severity: 'MEDIUM',
        category, section, detailSnapshot: detail,
        affectedFiles: [BACKEND_FILE], affectedPrinciples: [], pass: 'backend',
        source: 'session', adjudicationOutcome: 'dismissed', remediationState: 'pending',
        originalSeverity: 'MEDIUM', ruling: 'sustain', rulingRationale: 'r', resolvedRound: 1,
      }],
    }));
    try {
      const result = await runScenario(
        defaultResponses({ backend_pass: { ...EMPTY_BACKEND, findings: [mkFinding({ severity: 'MEDIUM', category, section, detail })] } }),
        { round: 2, ledgerFile: ledgerPath, noLedger: false, changedFiles: [] },
      );
      const snap = snapshot(result);
      assert.equal(snap.verdict, 'PASS', 'the only finding was suppressed, so the round is clean');
      assert.equal(snap.findings.length, 0);
      assert.ok(snap._suppression, '_suppression must be populated');
      assert.equal(snap._suppression.suppressedCount, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('scenario 4: cloud-off (no cloudRunId) — the default posture of this whole harness', async () => {
    const result = await runScenario(defaultResponses(), { noLedger: true, round: 1 });
    assert.equal(result._cloudRunId, undefined, 'cloud is air-gapped (AUDIT_DB_URL=\'\'); cloudRunId must never be set');
    assert.equal(result._modelAbShadow, undefined, 'the shadow never fires with no arm-eval toggle configured');
  });

  it('scenario 5: generator/REDUCE fallback — one pass throws, run degrades not crashes', async () => {
    const survivor = mkFinding({ category: 'Scenario 5 Survivor', section: `${FRONTEND_FILE}:1`, detail: 'scenario-5 survivor finding' });
    const result = await runScenario(defaultResponses({
      backend_pass: () => { throw new LlmError('simulated provider timeout', { category: 'http-503', retryable: false }); },
      frontend_pass: { ...EMPTY_FRONTEND, findings: [survivor] },
    }), { noLedger: true, round: 1 });
    const snap = snapshot(result);
    assert.ok(Array.isArray(snap._failed_passes) && snap._failed_passes.length > 0);
    assert.ok(snap.findings.some(f => f.detail === 'scenario-5 survivor finding'));
  });

  it('scenario 6: incomplete adjudication — a failed pass yields runStatus reflecting incompleteness in the verdict, not a crash', async () => {
    const result = await runScenario(defaultResponses({
      wiring_pass: () => { throw new LlmError('simulated timeout', { category: 'http-503', retryable: false }); },
    }), { noLedger: true, round: 1 });
    const snap = snapshot(result);
    assert.ok(Array.isArray(snap._failed_passes) && snap._failed_passes.length > 0);
    // runStatus (durable-write outcome tally) stays 'complete' with cloud off —
    // it is the VERDICT that reflects a failed pass, not runStatus, which is a
    // distinct axis (durability vs. quality-gate incompleteness).
    assert.equal(snap.runStatus, 'complete');
  });

  it('scenario 7: forced local ledger-write failure surfaces as _ledgerWriteError, never crashes the run', async (t) => {
    const { filePath: ledgerPath, dir } = mkTmpFile('ledger.json', JSON.stringify({ version: 1, entries: [] }));
    try {
      const { batchWriteLedger } = await import('../scripts/lib/ledger.mjs');
      // batchWriteLedger is imported directly (not injectable) — force the
      // failure at its own dependency, fs.writeFileSync/atomic write, via the
      // same t.mock.method pattern already used elsewhere in this repo
      // (tests/pass-result-cache.test.mjs) rather than mocking the ESM
      // binding itself.
      const fsMod = await import('node:fs');
      t.mock.method(fsMod.default, 'renameSync', () => { throw new Error('simulated disk full'); });
      const result = await runScenario(
        defaultResponses({ backend_pass: { ...EMPTY_BACKEND, findings: [mkFinding({ detail: 'scenario-7 finding' })] } }),
        { round: 1, ledgerFile: ledgerPath, noLedger: false },
      );
      assert.equal(result.runStatus, 'incomplete', 'a failed local ledger write must make the run incomplete');
      assert.ok(result._ledgerWriteError, '_ledgerWriteError must be populated, not silently swallowed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  // ── Cache-lifecycle scenarios (Gemini gate G1, round 1) ────────────────
  //
  // The top-level try/finally in `runLegacyProductionAudit` (wrapping the
  // renamed `runLegacyProductionAuditImpl` body) must call `cleanupCache()`
  // on EVERY exit path, not just success — a narrower try/finally scoped to
  // just the finalization coordinator is unreachable when an earlier wave
  // throws before the coordinator is ever invoked, which is exactly the
  // resource leak Gemini's G1 finding caught in this plan's own audit trail.
  //
  // Cache dir path is re-derived here (module-private in pass-result-cache.mjs)
  // rather than exported, matching this harness's existing no-fixture-imports-
  // internals discipline — `initResultCache(outFile)` with no `outFile` falls
  // back to `os.tmpdir()`.
  function cacheDirFor() {
    return path.join(os.tmpdir(), `.audit-cache-${process.pid}`);
  }

  it('scenario 8: a thrown error DURING finding-assembly (4b) still triggers cache cleanup', async () => {
    // finding-assembly.mjs's own named-ESM-export dependencies (semanticId,
    // normalizeArchCategory, ...) are non-configurable module-namespace
    // bindings — `t.mock.method` cannot redefine them (unlike scenario 7's
    // `fsMod.default.renameSync`, a genuinely mutable CJS-interop object).
    // Forcing a THROW that is representative of a real crash (not an
    // artificial mock) instead: a finding whose `severity` getter throws when
    // read — `addFindings`' own severity-sort comparator reads it, uncaught,
    // well before 4b's own dedup/verdict logic. Same effect (an uncaught
    // throw from inside assembleFindings), no non-configurable-property wall.
    const hostileFinding = mkFinding({ detail: 'scenario-8 finding' });
    Object.defineProperty(hostileFinding, 'severity', {
      get() { throw new Error('simulated 4b failure'); },
      configurable: true,
    });
    await assert.rejects(
      () => runScenario(defaultResponses({
        backend_pass: { ...EMPTY_BACKEND, findings: [hostileFinding] },
      }), { noLedger: true, round: 1 }),
      /simulated 4b failure/,
      'the forced failure must actually propagate (a swallowed throw would make this scenario meaningless)',
    );
    assert.equal(fs.existsSync(cacheDirFor()), false,
      'cleanupCache() must still run when finding-assembly (4b) throws — that is the whole point of the top-level try/finally');
  });

  it('scenario 9: an early-wave throw, BEFORE the finalization coordinator is ever reached, still triggers cache cleanup', async () => {
    // Reuses the documented, already-loud early-failure path (see
    // tests/legacy-production-audit-hardening.test.mjs's "an unreadable
    // --diff file" describe block): an explicitly-passed but unreadable
    // --diff throws well before any wave runs, let alone the coordinator —
    // the scenario the round-4-only cache-lifecycle pair would have missed.
    const missingPath = path.join(os.tmpdir(), `finalization-char-missing-diff-${process.pid}-${Date.now()}.patch`);
    assert.equal(fs.existsSync(missingPath), false, 'precondition: the path must not exist');
    await assert.rejects(
      () => runScenario(defaultResponses(), { noLedger: true, round: 1, diffFile: missingPath }),
      /is not a readable file/,
    );
    assert.equal(fs.existsSync(cacheDirFor()), false,
      'cleanupCache() must still run when an early wave throws before the coordinator is ever reached');
  });

  // A "forced permanent run-persistence (4c) failure" scenario is NOT
  // included here: this harness runs cloud OFF by design (see the file
  // docblock), so run-persistence.mjs's cloud-write branches — the only ones
  // that can produce a genuinely UNCAUGHT permanent failure in production —
  // are structurally unreachable through this seam, the same limitation the
  // docblock already documents for the cloud-write ORDERING coverage. That
  // is a true scope boundary, not a shortcut: forcing cloud on here would
  // require faking a store connection, which is exactly the whole-provider
  // mock this repo's testing doctrine forbids.
});
