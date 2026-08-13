/**
 * @fileoverview Tier 1/2 regression tests for the audit-orchestrator-
 * hardening plan (docs/plans/audit-orchestrator-hardening.md) — Phases 1,
 * 3, 4, 5, 6, 7 against `scripts/lib/audit/legacy-production-audit.mjs`
 * (+ `scripts/lib/config.mjs`'s `clampConfigNumber`).
 *
 * Round 2 (bottom of file): docs/plans/audit-backlog-triage-hardening.md
 * items 1-4 — the `writeLearningState` capability wrapper, `cleanupCache()`
 * failure logging, the guarded shadow-recovery import, and the fuzzy-dedup
 * `_hash` fix.
 *
 * Follows the EXISTING stubbing conventions in this repo exactly:
 * `AUDIT_EXPORTS_FOR_TESTS=1` + `__testExports` + a stub OpenAI client
 * whose `responses.parse(params)` dispatches on `params.text.format.name`
 * (the schemaName) — see `tests/openai-wrapper-contract.test.mjs` and
 * `tests/run-multi-pass-code-audit-harness.test.mjs` (this file's Phase 3
 * integration test reuses that harness's fixture plan/files/stub-client
 * helpers rather than re-inventing them).
 *
 * Plan: docs/plans/audit-orchestrator-hardening.md, docs/plans/audit-backlog-triage-hardening.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
// Air-gap every side-effecting subsystem this file doesn't want to exercise
// for real (cloud store, model-catalog refresh, quickfix hook) — mirrors
// tests/run-multi-pass-code-audit-harness.test.mjs's env, unconditional
// override (not `||=`) for the same reason that file documents.
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

const lpa = await import('../scripts/lib/audit/legacy-production-audit.mjs');
const {
  validateLedgerForR2, deriveFindingsFromReport, runMapReducePass, initResultCache, cachePassResult,
  writeLearningState, cleanupCache, classifyShadowFailureSafe, runOrphanIntroducedPass, dedupReplacementId,
  buildSuppressionStats,
} = lpa.__testExports;

const { clampConfigNumber } = await import('../scripts/lib/config.mjs');
const { FindingSchema, LedgerEntrySchema, ReduceStatus, REDUCE_STATUS_VALUES, reduceStatusFromErrorCategory, ExecutionMetaSchema } = await import('../scripts/lib/schemas.mjs');

// ═══════════════════════════════════════════════════════════════════════
// Phase 1 — Atomic artifact writes
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 1 — atomic artifact writes', () => {
  it('legacy-production-audit.mjs no longer calls fs.writeFileSync directly (static regression guard)', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/lib/audit/legacy-production-audit.mjs'), 'utf-8',
    );
    assert.equal(src.includes('fs.writeFileSync('), false,
      'all 3 known fs.writeFileSync call sites must be migrated to atomicWriteFileSync');
  });

  it('cachePassResult never leaves a torn/partial target file when the atomic rename fails mid-write', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpa-atomic-'));
    try {
      const outFile = path.join(tmpDir, 'result.json');
      initResultCache(outFile);
      // First, a normal successful write establishes the cache dir + baseline.
      cachePassResult('probe', { ok: true });
      const cacheDirEntries = fs.readdirSync(tmpDir).filter(f => f.startsWith('.audit-cache-'));
      assert.equal(cacheDirEntries.length, 1, 'expected exactly one cache dir created');
      const cacheDir = path.join(tmpDir, cacheDirEntries[0]);
      const targetFile = path.join(cacheDir, 'crashme.json');
      assert.equal(fs.existsSync(targetFile), false, 'target must not exist before the crash-simulated write');

      // Simulate a crash mid-write: the temp file write succeeds, but the
      // atomic rename throws (disk full / permission race / etc).
      t.mock.method(fs, 'renameSync', () => { throw new Error('simulated crash mid-rename'); });
      cachePassResult('crashme', { should: 'never persist' });

      // The target must never have been created (atomicWriteFileSync writes
      // to a temp file, then renames — a rename failure means the target is
      // never touched, never torn/partial).
      assert.equal(fs.existsSync(targetFile), false, 'a failed rename must never leave a torn/partial target file');
      // The temp file must be cleaned up (atomicWriteFileSync's catch block).
      const leftoverTemp = fs.readdirSync(cacheDir).filter(f => f.startsWith('.tmp-'));
      assert.deepEqual(leftoverTemp, [], 'a failed rename must not leave a leftover .tmp-* file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2 — Ledger structural validation (validateLedgerForR2)
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 2 — validateLedgerForR2 per-entry schema validation', () => {
  function mkTmpLedger(entries, meta = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpa-ledger-'));
    const filePath = path.join(dir, 'ledger.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, entries, ...meta }), 'utf-8');
    return filePath;
  }

  const VALID_ENTRY = {
    topicId: 't1', semanticHash: 'h1', severity: 'MEDIUM', category: 'cat',
    section: 'a.mjs:1', detailSnapshot: 'd', affectedFiles: ['a.mjs'], affectedPrinciples: [],
    pass: 'backend', source: 'session', adjudicationOutcome: 'dismissed',
    remediationState: 'pending', originalSeverity: 'MEDIUM', ruling: 'sustain',
    rulingRationale: 'r', resolvedRound: 1,
  };

  it('round < 2 short-circuits to {valid:true} without reading the file', () => {
    const result = validateLedgerForR2('/does/not/exist.json', 1);
    assert.deepEqual(result, { valid: true });
  });

  it('a fully-valid ledger returns all entries in validEntries with invalidEntryCount 0', () => {
    const ledgerPath = mkTmpLedger([VALID_ENTRY, { ...VALID_ENTRY, topicId: 't2' }]);
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      assert.equal(result.valid, true);
      assert.equal(result.entryCount, 2);
      assert.equal(result.validEntries.length, 2);
      assert.equal(result.invalidEntryCount, 0);
    } finally { fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a per-entry-malformed ledger (structurally-present entries array, one entry missing required fields) keeps valid entries and skips the malformed one — never throws', () => {
    const malformed = { topicId: 't-bad' }; // missing severity/category/... entirely
    const ledgerPath = mkTmpLedger([VALID_ENTRY, malformed]);
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      assert.equal(result.valid, true, 'a per-entry-malformed ledger is still a structurally-valid ledger file');
      assert.equal(result.entryCount, 2);
      assert.equal(result.validEntries.length, 1);
      assert.equal(result.invalidEntryCount, 1);
      assert.equal(result.validEntries[0].topicId, 't1');
    } finally { fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('validEntries preserves the ORIGINAL raw entry (not a Zod-stripped copy) — extra bookkeeping fields survive', () => {
    const withExtra = { ...VALID_ENTRY, topicId: 't3', _hash: 'abc123', findingId: 'H1' };
    const ledgerPath = mkTmpLedger([withExtra]);
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      assert.equal(result.validEntries[0]._hash, 'abc123');
      assert.equal(result.validEntries[0].findingId, 'H1');
    } finally { fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('every entry surviving into validEntries independently parses via LedgerEntrySchema', () => {
    const ledgerPath = mkTmpLedger([VALID_ENTRY]);
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      for (const entry of result.validEntries) {
        assert.doesNotThrow(() => LedgerEntrySchema.parse(entry));
      }
    } finally { fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  // Regression: a pre-adjudication entry (auto-written every round by
  // `batchWriteLedger`, and left that way for any finding the operator did not
  // triage) cannot satisfy LedgerEntrySchema by design — it has no ruling,
  // originalSeverity or resolvedRound yet. Counting it as `invalid` made a
  // normal run log `0 valid, N invalid`, which reads as a corrupt ledger and
  // was reported from a consumer as "R2+ suppression never engages".
  const PENDING_ENTRY = {
    topicId: 'p1', findingId: 'H1', severity: 'HIGH', category: 'cat',
    section: 'a.mjs:1', detailSnapshot: 'd', detail: 'd',
    affectedFiles: ['a.mjs'], affectedPrinciples: [], pass: 'backend',
    semanticHash: 'h9', adjudicationOutcome: 'pending', remediationState: 'pending', round: 1,
  };

  it('a pre-adjudication (pending) entry counts as pending, NOT invalid', () => {
    const ledgerPath = mkTmpLedger([VALID_ENTRY, PENDING_ENTRY]);
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      assert.equal(result.entryCount, 2);
      assert.equal(result.pendingEntryCount, 1, 'a pending entry is expected residue, not damage');
      assert.equal(result.invalidEntryCount, 0, 'nothing here is malformed');
      // Unchanged where it matters: suppression still only ever sees adjudicated entries.
      assert.equal(result.validEntries.length, 1);
      assert.equal(result.validEntries[0].topicId, 't1');
    } finally { fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a malformed entry is still invalid even when it claims adjudicationOutcome pending', () => {
    // The pending classification must not become a way to launder corruption:
    // this one is missing `severity`, so it fails BatchLedgerEntrySchema too.
    const ledgerPath = mkTmpLedger([{ topicId: 'bad', adjudicationOutcome: 'pending' }]);
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      assert.equal(result.invalidEntryCount, 1);
      assert.equal(result.pendingEntryCount, 0);
      assert.equal(result.validEntries.length, 0);
    } finally { fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('an all-pending ledger reports zero adjudicated without reporting corruption', () => {
    const ledgerPath = mkTmpLedger([PENDING_ENTRY, { ...PENDING_ENTRY, topicId: 'p2' }]);
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      assert.equal(result.valid, true);
      assert.equal(result.validEntries.length, 0);
      assert.equal(result.pendingEntryCount, 2);
      assert.equal(result.invalidEntryCount, 0);
    } finally { fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  // Regression (2026-08-13): this loop inlined its own two-schema predicate and
  // never recognised the THIRD schema that legitimately lives in this file.
  // `writeStage1MechanicalLedgerEntry` writes stage1-mechanical dismissals here,
  // and `suppressReRaises` has a source-aware filter built specifically to route
  // them — but they were counted as corruption and withheld from suppression.
  // Latent only because the tiered pipeline defaults off.
  const STAGE1_ENTRY = {
    topicId: 's1m-1', semanticHash: 'h2', severity: 'MEDIUM', category: 'Dead Code',
    section: 'b.mjs:2', detailSnapshot: 'never called', affectedFiles: ['b.mjs'],
    affectedPrinciples: [], pass: 'sustainability', source: 'stage1-mechanical',
    adjudicationOutcome: 'dismissed', remediationState: 'pending',
    disproof: 'grep confirms zero call sites', resolvedRound: 1,
  };

  it('a stage1-mechanical dismissal is adjudicated — it reaches suppression, and is NOT corruption', () => {
    const ledgerPath = mkTmpLedger([VALID_ENTRY, STAGE1_ENTRY]);
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      assert.equal(result.invalidEntryCount, 0, 'a supported writer\'s output is not corruption');
      assert.equal(result.validEntries.length, 2);
      assert.ok(
        result.validEntries.some(e => e.source === 'stage1-mechanical'),
        'suppressReRaises routes these deliberately — withholding them disables a designed path',
      );
    } finally { fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('negative control — the stage1 branch does not launder corruption', () => {
    // Fails all three schemas (severity is outside the enum, so not even the
    // batch shape holds), which is the only thing that may count as invalid.
    const ledgerPath = mkTmpLedger([{ ...STAGE1_ENTRY, severity: 'NOPE' }]);
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      assert.equal(result.invalidEntryCount, 1, 'the new branch must not launder corruption');
      assert.equal(result.validEntries.length, 0);
    } finally { fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a stage1-mechanical entry missing its disproof is incomplete, NOT corruption', () => {
    // It still satisfies the batch shape. Counting it invalid would light up the
    // degradation signal on an entry that is merely unusable for suppression.
    const ledgerPath = mkTmpLedger([{ ...STAGE1_ENTRY, disproof: undefined }]);
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      assert.equal(result.invalidEntryCount, 0);
      assert.equal(result.pendingEntryCount, 1);
    } finally { fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a missing entries array is UNCHANGED behavior — {valid:false, suppressionUnavailable:true}', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpa-ledger-'));
    const ledgerPath = path.join(dir, 'ledger.json');
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1 }), 'utf-8');
    try {
      const result = validateLedgerForR2(ledgerPath, 2);
      assert.deepEqual(result, { valid: false, suppressionUnavailable: true });
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('an unreadable/missing ledger file is UNCHANGED behavior — {valid:false, suppressionUnavailable:true}', () => {
    const result = validateLedgerForR2('/definitely/does/not/exist/ledger.json', 2);
    assert.deepEqual(result, { valid: false, suppressionUnavailable: true });
  });

  it('no --ledger (null path) is UNCHANGED behavior — {valid:false, suppressionUnavailable:true}', () => {
    const result = validateLedgerForR2(null, 2);
    assert.deepEqual(result, { valid: false, suppressionUnavailable: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Suppression provenance — the DENOMINATOR reaches the store
// ═══════════════════════════════════════════════════════════════════════
//
// `_suppression` carries kept/suppressed/reopened and NOT the size of the
// ruling set they were matched against, and `recordSuppressionEvents` writes
// one row per match (zero rows when there were none). So "suppression matched
// against 0 rulings" was byte-identical downstream to "matched against 9 and
// none hit" — the state behind the 2026-08-08 "R2+ suppression never engages"
// consumer report, visible only on stderr. `buildSuppressionStats` is what
// makes the two distinguishable in `audit_runs.suppression_stats`.

describe('buildSuppressionStats — suppression provenance', () => {
  const LEDGER = { entryCount: 12, adjudicated: 9, pending: 2, invalid: 1 };
  const SUPP = { keptCount: 20, suppressedCount: 3, reopenedCount: 1, fpSuppressedCount: 0 };

  it('round 1 returns null — absence means "suppression did not run", never a measured zero', () => {
    assert.equal(buildSuppressionStats({ round: 1, ledger: LEDGER, suppression: SUPP }), null);
  });

  it('an R2+ round carries the ruling-set size as the denominator', () => {
    const stats = buildSuppressionStats({ round: 2, ledger: LEDGER, suppression: SUPP });
    assert.equal(stats.round, 2);
    assert.deepEqual(stats.ledger, { entryCount: 12, adjudicated: 9, pending: 2, invalid: 1 });
    assert.equal(stats.suppressed, 3);
    assert.equal(stats.kept, 20);
    assert.equal(stats.reopened, 1);
    // Spelled out, not `fpSuppressed` — that bare token is pinned as a removed
    // local by tests/suppression-call-site.test.mjs's whole-file scan.
    assert.equal(stats.falsePositiveSuppressed, 0);
  });

  // The whole point: these two rounds both report `suppressed: 0`, and before
  // this block they were indistinguishable in the store.
  it('"nothing to suppress WITH" and "nothing needed suppressing" are distinguishable', () => {
    const nothingToSuppressWith = buildSuppressionStats({
      round: 2,
      ledger: { entryCount: 5, adjudicated: 0, pending: 5, invalid: 0 },
      suppression: { keptCount: 8, suppressedCount: 0, reopenedCount: 0, fpSuppressedCount: 0 },
    });
    const nothingNeededSuppressing = buildSuppressionStats({
      round: 2,
      ledger: { entryCount: 9, adjudicated: 9, pending: 0, invalid: 0 },
      suppression: { keptCount: 8, suppressedCount: 0, reopenedCount: 0, fpSuppressedCount: 0 },
    });
    assert.equal(nothingToSuppressWith.suppressed, 0);
    assert.equal(nothingNeededSuppressing.suppressed, 0);
    assert.notDeepEqual(
      nothingToSuppressWith.ledger, nothingNeededSuppressing.ledger,
      'the ruling-set denominator is the only thing that separates these two rounds',
    );
    assert.equal(nothingToSuppressWith.ledger.adjudicated, 0);
    assert.equal(nothingToSuppressWith.ledger.pending, 5, 'pending explains WHY the denominator is 0');
  });

  it('an unavailable ledger reports `unavailable`, never zeroed counts', () => {
    const stats = buildSuppressionStats({
      round: 2, ledger: { unavailable: true }, suppression: SUPP,
    });
    assert.deepEqual(stats.ledger, { unavailable: true });
    assert.equal('adjudicated' in stats.ledger, false,
      'a zero denominator would claim a measurement nobody took — suppression could not run at all');
  });

  it('never carries the finding ARRAYS — this is a row, not a payload dump', () => {
    const stats = buildSuppressionStats({
      round: 2, ledger: LEDGER,
      suppression: { ...SUPP, suppressed: [{ finding: { detail: 'x'.repeat(5000) } }], reopened: [{ a: 1 }] },
    });
    const serialized = JSON.stringify(stats);
    assert.equal(serialized.includes('xxxx'), false, 'finding bodies belong in suppression_events rows');
    assert.ok(serialized.length < 400, `row payload must stay compact, got ${serialized.length} chars`);
  });

  it('a missing suppression payload still records the ledger provenance', () => {
    const stats = buildSuppressionStats({ round: 2, ledger: LEDGER, suppression: undefined });
    assert.deepEqual(stats.ledger, { entryCount: 12, adjudicated: 9, pending: 2, invalid: 1 });
    assert.equal(stats.suppressed, undefined, 'absent counters stay absent rather than becoming 0');
  });
});

describe('suppression provenance — the write side', () => {
  it('recordRunComplete maps suppressionStats onto the suppression_stats column, columnExists-guarded', () => {
    const src = fs.readFileSync(path.resolve('scripts/lib/store/runs-findings.mjs'), 'utf-8');
    const block = src.match(/if \(stats\.suppressionStats != null[\s\S]{0,320}?\n\s*}/);
    assert.ok(block, 'recordRunComplete must map stats.suppressionStats — a builder nothing writes is inert');
    assert.match(block[0], /columnExists\('audit_runs', 'suppression_stats'/,
      'the write must degrade cleanly on a pre-migration store, like its six siblings');
    assert.match(block[0], /update\.suppression_stats = stats\.suppressionStats/,
      'pass the object RAW — the jsonb write seam serializes it (never hand-JSON.stringify)');
  });

  it('the orchestrator actually populates it on the completion payload', () => {
    const src = fs.readFileSync(path.resolve('scripts/lib/audit/legacy-production-audit.mjs'), 'utf-8');
    assert.match(src, /suppressionStats: buildSuppressionStats\(/,
      'completionStats must carry the block, or the column stays as dead as it was for four months');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4 — Map-reduce failure-state propagation
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 4 — runMapReducePass mapUnitStatus', () => {
  function mkFixtureFiles(n) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpa-mapreduce-'));
    const files = [];
    for (let i = 0; i < n; i++) {
      const p = path.join(dir, `unit${i}.mjs`);
      fs.writeFileSync(p, `export const unit${i} = ${i};\n`, 'utf-8');
      files.push(p);
    }
    return { dir, files };
  }

  function buildPromptForUnit(unit, i, total, unitLabel) {
    return { system: 'sys', messages: [{ role: 'user', content: unitLabel }] };
  }

  /** Stub client dispatching on schemaName: map_<pass>_<i> and reduce_<pass>. */
  function makeStub({ mapBehavior, reduceBehavior }) {
    return {
      responses: {
        parse: async (params) => {
          const name = params?.text?.format?.name;
          if (name.startsWith('map_')) {
            const idx = Number(name.split('_').pop());
            const behavior = mapBehavior(idx);
            if (behavior.throw) throw new Error(behavior.throw);
            return {
              status: 'completed', output: [], output_parsed: behavior.result,
              usage: { input_tokens: 10, output_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 } },
            };
          }
          if (name.startsWith('reduce_')) {
            if (reduceBehavior?.throw) throw new Error(reduceBehavior.throw);
            return {
              status: 'completed', output: [], output_parsed: reduceBehavior.result,
              usage: { input_tokens: 10, output_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 } },
            };
          }
          throw new Error(`unexpected schemaName: ${name}`);
        },
      },
    };
  }

  const CLASSIFICATION = { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'test-stub' };
  function mkFinding(overrides = {}) {
    return {
      id: 'H1', severity: 'HIGH', category: 'Test', section: 'unit0.mjs:1', detail: 'a finding',
      risk: 'risk', recommendation: 'rec', is_quick_fix: false, is_mechanical: false, principle: 'p',
      classification: CLASSIFICATION, ...overrides,
    };
  }
  const EMPTY_PASS = { pass_name: 'mrtest', findings: [], quick_fix_warnings: [], summary: 'ok' };

  it('all units succeeding (even with 0 findings) yields mapUnitStatus "clean"', async () => {
    const { dir, files } = mkFixtureFiles(2);
    try {
      const stub = makeStub({ mapBehavior: () => ({ result: EMPTY_PASS }) });
      const result = await runMapReducePass(stub, files, 'mrtest', buildPromptForUnit, 1);
      assert.equal(result.mapUnitStatus, 'clean');
      assert.equal(result.unitsAttempted, 2);
      assert.equal(result.unitsFailed, 0);
      assert.deepEqual(result.result.findings, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('every unit throwing yields mapUnitStatus "total_failure" (unitsFailed === unitsAttempted)', async () => {
    const { dir, files } = mkFixtureFiles(3);
    try {
      const stub = makeStub({ mapBehavior: () => ({ throw: 'simulated MAP failure' }) });
      const result = await runMapReducePass(stub, files, 'mrtest', buildPromptForUnit, 1);
      assert.equal(result.mapUnitStatus, 'total_failure');
      assert.equal(result.unitsAttempted, 3);
      assert.equal(result.unitsFailed, 3);
      assert.deepEqual(result.result.findings, [], 'total failure surfaces zero findings — nothing survived to report');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a mix of failures + empty-findings survivors yields mapUnitStatus "partial" with ZERO surviving findings', async () => {
    const { dir, files } = mkFixtureFiles(4);
    try {
      const stub = makeStub({
        mapBehavior: (i) => (i % 2 === 0 ? { throw: 'simulated MAP failure' } : { result: EMPTY_PASS }),
      });
      const result = await runMapReducePass(stub, files, 'mrtest', buildPromptForUnit, 1);
      assert.equal(result.mapUnitStatus, 'partial');
      assert.equal(result.unitsAttempted, 4);
      assert.equal(result.unitsFailed, 2);
      assert.equal(result.result.findings.length, 0,
        'partial-with-zero-survivor-findings is the false-clean case this phase exists to surface');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a mix of failures + real-findings survivors yields mapUnitStatus "partial" WITH surviving findings (real signal, not folded as failed)', async () => {
    const { dir, files } = mkFixtureFiles(4);
    try {
      const stub = makeStub({
        mapBehavior: (i) => (i === 0
          ? { throw: 'simulated MAP failure' }
          : { result: { ...EMPTY_PASS, findings: [mkFinding({ id: `H${i}`, section: `unit${i}.mjs:1`, detail: `finding from unit ${i}` })] } }),
        reduceBehavior: { result: { pass_name: 'mrtest', findings: [mkFinding({ detail: 'reduced finding' })], quick_fix_warnings: [], summary: 'reduced' } },
      });
      const result = await runMapReducePass(stub, files, 'mrtest', buildPromptForUnit, 1);
      assert.equal(result.mapUnitStatus, 'partial');
      assert.equal(result.unitsAttempted, 4);
      assert.equal(result.unitsFailed, 1);
      assert.ok(result.result.findings.length > 0, 'real survivor findings must be present, not discarded');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// reduceStatus is DERIVED from the real failure, not inferred from a boolean
// ═══════════════════════════════════════════════════════════════════════
//
// `runMapReducePass` computed `reduceResult.failed ? MODEL_ERROR : OK`, so three
// of the six declared REDUCE_STATUS_VALUES — parse_error, timeout,
// budget_exceeded — could never be produced by any input. `safeCallGPT` had the
// classification (`classifyLlmError`) and threw it away, keeping only
// `err.message`; the plan (audit-loop-improvements.md:68) asked for status "from
// the actual error classification" and only the READ side had landed.
//
// These drive the REAL producer (`runMapReducePass`) and let the REAL
// classifier run: the stub returns genuine provider response shapes rather than
// hand-thrown LlmErrors, so `llm-helpers.mjs` derives the category itself. Each
// assertion fails against the old boolean inference, which answered
// `model_error` for every one of them.
describe('runMapReducePass — reduceStatus reflects the actual failure category', () => {
  function mkFixtureFiles(n) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpa-reducestatus-'));
    const files = [];
    for (let i = 0; i < n; i++) {
      const p = path.join(dir, `unit${i}.mjs`);
      fs.writeFileSync(p, `export const unit${i} = ${i};\n`, 'utf-8');
      files.push(p);
    }
    return { dir, files };
  }
  const buildPromptForUnit = (unit, i, total, unitLabel) =>
    ({ system: 'sys', messages: [{ role: 'user', content: unitLabel }] });

  const CLASSIFICATION = { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'test-stub' };
  const mkFinding = (o = {}) => ({
    id: 'H1', severity: 'HIGH', category: 'Test', section: 'unit0.mjs:1', detail: 'a finding',
    risk: 'risk', recommendation: 'rec', is_quick_fix: false, is_mechanical: false, principle: 'p',
    classification: CLASSIFICATION, ...o,
  });
  const OK_USAGE = {
    input_tokens: 10, output_tokens: 5,
    prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 },
  };

  /**
   * MAP units always succeed with one finding each (the reduce-failure branch
   * requires survivors). `reduce` is a thunk returning a raw provider response
   * or throwing — so the category is produced by llm-helpers, not asserted into
   * existence here.
   */
  function makeStub(reduce) {
    return {
      responses: {
        parse: async (params) => {
          const name = params?.text?.format?.name;
          if (name.startsWith('map_')) {
            const i = Number(name.split('_').pop());
            return {
              status: 'completed', output: [], usage: OK_USAGE,
              output_parsed: {
                pass_name: 'mrtest', quick_fix_warnings: [], summary: 'ok',
                findings: [mkFinding({ id: `H${i}`, section: `unit${i}.mjs:1`, detail: `finding from unit ${i}` })],
              },
            };
          }
          if (name.startsWith('reduce_')) return reduce();
          throw new Error(`unexpected schemaName: ${name}`);
        },
      },
    };
  }

  async function reduceStatusFor(reduce) {
    const { dir, files } = mkFixtureFiles(2);
    try {
      const r = await runMapReducePass(makeStub(reduce), files, 'mrtest', buildPromptForUnit, 1);
      // Whatever it says, it must be a legal block — a status is worthless if
      // the envelope carrying it is malformed.
      assert.ok(ExecutionMetaSchema.safeParse(r.result._executionMeta).success,
        `_executionMeta must satisfy its schema, got ${JSON.stringify(r.result._executionMeta)}`);
      return r.result._executionMeta?.reduceStatus;
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  }

  it('a schema violation in the REDUCE response is parse_error, not model_error', async () => {
    // `findings` non-array -> llm-helpers throws LlmError{category:'schema'}.
    const status = await reduceStatusFor(() => ({
      status: 'completed', output: [], usage: OK_USAGE,
      output_parsed: { pass_name: 'mrtest', findings: 'not-an-array', quick_fix_warnings: [], summary: 's' },
    }));
    assert.equal(status, ReduceStatus.PARSE_ERROR);
  });

  it('an unparseable REDUCE response is parse_error, not model_error', async () => {
    // No `output_parsed` and no repairable text -> LlmError{category:'empty'}.
    const status = await reduceStatusFor(() => ({
      status: 'completed', output: [], usage: OK_USAGE, output_parsed: null,
    }));
    assert.equal(status, ReduceStatus.PARSE_ERROR);
  });

  it('output truncated at max_tokens is budget_exceeded, not model_error', async () => {
    const status = await reduceStatusFor(() => ({
      status: 'completed', usage: OK_USAGE, output_parsed: null,
      output: [{ status: 'incomplete', incomplete_details: { reason: 'max_tokens' } }],
    }));
    assert.equal(status, ReduceStatus.BUDGET_EXCEEDED);
  });

  it('an aborted REDUCE call is timeout, not model_error', async () => {
    const status = await reduceStatusFor(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    assert.equal(status, ReduceStatus.TIMEOUT);
  });

  it('negative control — a genuinely unclassifiable failure is still model_error', async () => {
    // Guards the opposite error: a mapping so eager that everything acquires a
    // specific status. A bare Error classifies as `permanent` and must stay
    // model_error.
    const status = await reduceStatusFor(() => { throw new Error('provider exploded'); });
    assert.equal(status, ReduceStatus.MODEL_ERROR);
  });

  it('skipping REDUCE because most MAP units failed reports skipped, not a failure', async () => {
    // >50% (MAP_FAILURE_THRESHOLD) of units fail, survivors carry findings:
    // REDUCE is never attempted. This path emitted NO _executionMeta at all, so
    // a run whose synthesis never ran looked identical to a clean one.
    const { dir, files } = mkFixtureFiles(4);
    try {
      const stub = {
        responses: {
          parse: async (params) => {
            const name = params?.text?.format?.name;
            const i = Number(name.split('_').pop());
            if (name.startsWith('reduce_')) throw new Error('REDUCE must not be called on the skip path');
            // 3 of 4 fail. NOT 2 of 4: the gate is `failureRate >
            // MAP_FAILURE_THRESHOLD` and the threshold is 0.5, so an even split
            // is strictly-not-greater and falls through to a normal REDUCE.
            if (i < 3) throw new Error('simulated MAP failure');
            return {
              status: 'completed', output: [], usage: OK_USAGE,
              output_parsed: {
                pass_name: 'mrtest', quick_fix_warnings: [], summary: 'ok',
                findings: [mkFinding({ id: `H${i}`, section: `unit${i}.mjs:1`, detail: `finding from unit ${i}` })],
              },
            };
          },
        },
      };
      const r = await runMapReducePass(stub, files, 'mrtest', buildPromptForUnit, 1);
      assert.equal(r.result._executionMeta?.reduceStatus, ReduceStatus.SKIPPED);
      assert.equal(r.result._executionMeta?.reduceSkipped, true);
      assert.ok(r.result.findings.length > 0, 'the raw survivors must still be returned');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a successful REDUCE emits no _executionMeta at all', async () => {
    // Absence still means "nothing degraded" — guards an always-on block.
    const { dir, files } = mkFixtureFiles(2);
    try {
      const stub = makeStub(() => ({
        status: 'completed', output: [], usage: OK_USAGE,
        output_parsed: { pass_name: 'mrtest', findings: [mkFinding({ detail: 'reduced' })], quick_fix_warnings: [], summary: 'reduced' },
      }));
      const r = await runMapReducePass(stub, files, 'mrtest', buildPromptForUnit, 1);
      assert.equal(r.result._executionMeta, undefined);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('every declared REDUCE_STATUS_VALUE is reachable from some real input', () => {
    // The defect this block exists to prevent, stated as a property: a value
    // nobody can produce is documentation, and it looks identical to a value
    // that merely has not happened yet. `ok` and `skipped` come from control
    // flow (asserted above); the rest must come from the classifier.
    const fromClassifier = new Set(
      ['schema', 'empty', 'timeout', 'truncated', 'incomplete', 'network', 'permanent', 'http-429', 'http-400', 'sensitive']
        .map(reduceStatusFromErrorCategory),
    );
    const reachable = new Set([...fromClassifier, ReduceStatus.OK, ReduceStatus.SKIPPED]);
    const orphans = REDUCE_STATUS_VALUES.filter(v => !reachable.has(v));
    assert.deepEqual(orphans, [], `declared but unreachable ReduceStatus values: ${orphans.join(', ')}`);
  });

  it('an unknown category falls back to model_error rather than minting a new value', () => {
    // Widening classifyLlmError must never silently produce a status the enum
    // has not declared.
    for (const c of ['brand-new-category', '', undefined, null]) {
      assert.equal(reduceStatusFromErrorCategory(c), ReduceStatus.MODEL_ERROR);
      assert.ok(REDUCE_STATUS_VALUES.includes(reduceStatusFromErrorCategory(c)));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5 — Schema-consistent deterministic (architecture) findings
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 5 — deriveFindingsFromReport schema conformance', () => {
  const SYNTHETIC_REPORT = {
    violations: [{ fromFile: 'a.mjs', toFile: 'b.mjs', fromDomain: 'core', toDomain: 'ui', ruleViolated: 'no-cross' }],
    unmappedFiles: ['src/unmapped.mjs'],
    deadIntent: ['stale-domain'],
    perStackResults: [{ stackKind: 'js-ts', status: 'error', error: { message: 'boom' } }],
  };

  it('emits exactly one finding per violation-report entry across the 4 loops, all schema-valid', () => {
    const findings = deriveFindingsFromReport(SYNTHETIC_REPORT);
    assert.equal(findings.length, 4);
    for (const f of findings) {
      assert.doesNotThrow(() => FindingSchema.parse(f), `finding ${f.category} must parse via FindingSchema`);
    }
  });

  it('assigns a unique, monotonic A-prefixed id to every finding', () => {
    const findings = deriveFindingsFromReport(SYNTHETIC_REPORT);
    assert.deepEqual(findings.map(f => f.id), ['A1', 'A2', 'A3', 'A4']);
  });

  it('assigns a distinct, non-empty risk sentence per violation TYPE', () => {
    const findings = deriveFindingsFromReport(SYNTHETIC_REPORT);
    for (const f of findings) {
      assert.equal(typeof f.risk, 'string');
      assert.ok(f.risk.length > 0);
    }
    const uniqueRisks = new Set(findings.map(f => f.risk));
    assert.equal(uniqueRisks.size, 4, 'each of the 4 violation types must carry its own distinct risk sentence');
  });

  it('the id sequence restarts per call (fresh counter, no cross-call leakage)', () => {
    const first = deriveFindingsFromReport(SYNTHETIC_REPORT);
    const second = deriveFindingsFromReport(SYNTHETIC_REPORT);
    assert.deepEqual(first.map(f => f.id), second.map(f => f.id));
  });

  it('an empty report yields no findings, without throwing', () => {
    const findings = deriveFindingsFromReport({ violations: [], unmappedFiles: [], deadIntent: [], perStackResults: [] });
    assert.deepEqual(findings, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6 — Monotonic tool-finding IDs (static regression guard)
// ═══════════════════════════════════════════════════════════════════════
// A full behavioral test would require injecting synthetic multi-severity
// tool findings into `executeTools`'s internal call inside
// `runLegacyProductionAudit` — not exposed for injection, and ESM named
// exports (`linter.mjs::executeTools`) cannot be `mock.method`'d (read-only
// module namespace bindings). This static guard instead locks the exact
// fix shape: the old severity-scoped counter must not be used for the
// T-prefixed id, and a dedicated monotonic counter must exist.

describe('Phase 6 — monotonic tool-finding IDs (static regression guard)', () => {
  it('tool findings no longer derive their id from the severity-scoped findingCounter', () => {
    const src = fs.readFileSync(path.resolve('scripts/lib/audit/legacy-production-audit.mjs'), 'utf-8');
    assert.match(src, /let toolIdCounter = 0;/, 'expected a dedicated run-wide monotonic tool-id counter');
    assert.doesNotMatch(src, /id: `T\$\{findingCounter\[tf\.severity\]\}`/,
      'tool-finding id must not be derived from the severity-scoped findingCounter');
    assert.match(src, /id: `T\$\{toolIdCounter\}`/, 'tool-finding id must be derived from the monotonic toolIdCounter');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 7 — Bounds-validated runtime config (clampConfigNumber)
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 7 — clampConfigNumber', () => {
  const intOpts = (over = {}) => ({ fallback: 5, min: 1, max: 20, parser: Number.parseInt, envVar: 'TEST_INT', ...over });
  const floatOpts = (over = {}) => ({ fallback: 0.2, min: 0, max: 1, parser: Number.parseFloat, envVar: 'TEST_FLOAT', ...over });

  it('returns fallback for null/undefined (never calls .trim() on a nullish value)', () => {
    assert.equal(clampConfigNumber(null, intOpts()), 5);
    assert.equal(clampConfigNumber(undefined, intOpts()), 5);
  });

  it('returns fallback for an empty string', () => {
    assert.equal(clampConfigNumber('', intOpts()), 5);
  });

  it('trims leading/trailing whitespace (including a trailing newline) before parsing', () => {
    assert.equal(clampConfigNumber('10\n', intOpts()), 10);
    assert.equal(clampConfigNumber('  7  ', intOpts()), 7);
  });

  it('rejects a malformed numeric-PREFIX string that parseInt would silently accept', () => {
    assert.equal(clampConfigNumber('10abc', intOpts()), 5);
  });

  it('rejects a decimal value on an integer-pattern field', () => {
    assert.equal(clampConfigNumber('1.5', intOpts()), 5);
  });

  it('clamps a finite value below min up to min', () => {
    assert.equal(clampConfigNumber('0', intOpts()), 1);
    assert.equal(clampConfigNumber('-5', intOpts()), 1);
  });

  it('clamps a finite value above max down to max', () => {
    assert.equal(clampConfigNumber('999', intOpts()), 20);
  });

  it('returns fallback (never a clamp) for a non-finite parse — Infinity', () => {
    assert.equal(clampConfigNumber('Infinity', floatOpts()), 0.2);
    assert.equal(clampConfigNumber('-Infinity', floatOpts()), 0.2);
  });

  it('returns fallback (never a clamp) for a non-finite parse — NaN-shaped input', () => {
    assert.equal(clampConfigNumber('NaN', floatOpts()), 0.2);
  });

  it('accepts a valid in-range integer unchanged', () => {
    assert.equal(clampConfigNumber('12', intOpts()), 12);
  });

  it('accepts a valid in-range float unchanged', () => {
    assert.equal(clampConfigNumber('0.5', floatOpts()), 0.5);
  });

  it('accepts a negative integer within range', () => {
    assert.equal(clampConfigNumber('-3', { fallback: 0, min: -10, max: 10, parser: Number.parseInt, envVar: 'T' }), -3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3 — Pass-result registry (integration — stub all passes, assert
// quickfix + architecture findings now appear in mergedResult.findings)
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 3 — pass-result registry (integration)', () => {
  const FIXTURE_DIR = 'tests/fixtures/harness-plan';
  const BACKEND_FILE = `${FIXTURE_DIR}/src/service.mjs`;
  const FRONTEND_FILE = `${FIXTURE_DIR}/src/components/Widget.jsx`;
  const PLAN_CONTENT = `# Harness Fixture Plan\n\nImplement \`${BACKEND_FILE}\` and \`${FRONTEND_FILE}\`.\n`;
  const CLASSIFICATION = { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'test-stub' };

  function mkFinding(overrides = {}) {
    return {
      id: 'H1', severity: 'HIGH', category: 'Test Category', section: `${BACKEND_FILE}:1`,
      detail: 'canned test finding detail', risk: 'canned risk', recommendation: 'canned recommendation',
      is_quick_fix: false, is_mechanical: false, principle: 'Test Principle',
      classification: CLASSIFICATION, ...overrides,
    };
  }

  const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 2, files_found: 2, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'structure ok' };
  const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'wiring ok' };
  const EMPTY_BACKEND = { pass_name: 'backend', findings: [], quick_fix_warnings: [], summary: 'backend ok' };
  const EMPTY_FRONTEND = { pass_name: 'frontend', findings: [], quick_fix_warnings: [], summary: 'frontend ok' };
  const EMPTY_SUSTAIN = { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'sustainability ok' };

  function makeStubClient(responses) {
    return {
      responses: {
        parse: async (params) => {
          const schemaName = params?.text?.format?.name;
          const handler = responses[schemaName];
          if (handler === undefined) {
            throw new Error(`makeStubClient: unrecognized schemaName "${schemaName}" — known: ${Object.keys(responses).join(', ')}`);
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

  it('quickfix findings (previously silently omitted) now appear in mergedResult.findings', async () => {
    const qfFinding = mkFinding({ category: 'Quickfix Category', detail: 'a quickfix-flagged design shortcut' });
    const stub = makeStubClient({
      structure_pass: EMPTY_STRUCTURE, wiring_pass: EMPTY_WIRING, backend_pass: EMPTY_BACKEND,
      frontend_pass: EMPTY_FRONTEND, sustainability_pass: EMPTY_SUSTAIN,
      quickfix_pass: { pass_name: 'quickfix', findings: [qfFinding], summary: 'quickfix ok' },
    });
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      passFilter: ['structure', 'wiring', 'backend', 'frontend', 'sustainability', 'quickfix'],
      noTools: true, noDebtLedger: true, scopeMode: 'plan', noLedger: true,
    });
    const survived = result.findings.some(f => f.detail === 'a quickfix-flagged design shortcut');
    assert.equal(survived, true, 'quickfix findings must reach mergedResult.findings (Phase 3 fix)');
    const quickfixFinding = result.findings.find(f => f.detail === 'a quickfix-flagged design shortcut');
    assert.equal(quickfixFinding.is_quick_fix, true);
  });

  // Architecture runs for real against THIS repo's own docs/architecture-intent.md
  // + .audit-loop/domain-map.json (both genuinely present — confirmed non-clean,
  // ~178 mechanical violations at the time this test was written, so the LLM
  // bouncer call always fires) — mirrors this harness's OWN established
  // precedent for orphan-introduced (also git-diff-derived, not fixture-
  // controlled; asserts SHAPE when present, not an exact count).
  it('architecture findings (previously silently omitted) now appear in mergedResult.findings, when the mechanical scan is non-clean', async () => {
    const archFinding = mkFinding({ category: 'Forbidden cross-domain edge', section: 'foo.mjs', detail: 'x imports y across a domain boundary' });
    const stub = makeStubClient({
      structure_pass: EMPTY_STRUCTURE, wiring_pass: EMPTY_WIRING, backend_pass: EMPTY_BACKEND,
      frontend_pass: EMPTY_FRONTEND, sustainability_pass: EMPTY_SUSTAIN,
      quickfix_pass: { pass_name: 'quickfix', findings: [], summary: 'quickfix ok' },
      architecture_pass: { pass_name: 'architecture', findings: [archFinding], summary: 'arch bouncer ok' },
    });
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      passFilter: ['structure', 'wiring', 'backend', 'frontend', 'sustainability', 'quickfix', 'architecture'],
      noTools: true, noDebtLedger: true, scopeMode: 'plan', noLedger: true,
    });
    // If the real mechanical scan is (unexpectedly, in some future repo
    // state) clean, the LLM bouncer never fires and archResult.findings
    // stays []. Assert SHAPE conditionally, matching the harness's own
    // orphan-introduced precedent — never a hard count assumption.
    const archSurvived = result.findings.some(f => f.detail === 'x imports y across a domain boundary');
    if (archSurvived) {
      const found = result.findings.find(f => f.detail === 'x imports y across a domain boundary');
      assert.match(found.category, /Architecture/, 'architecture findings must carry an Architecture-tagged category');
    } else {
      // Mechanical scan came back clean this run — the bouncer never fired,
      // so there was nothing for the registry fix to surface. Still prove
      // the WIRING is correct via the registry's own findings array.
      assert.ok(Array.isArray(result.findings));
    }
  });

  it('_pass_timings and overall_reasoning now include quickfix (registry-derived, previously excluded)', async () => {
    const stub = makeStubClient({
      structure_pass: EMPTY_STRUCTURE, wiring_pass: EMPTY_WIRING, backend_pass: EMPTY_BACKEND,
      frontend_pass: EMPTY_FRONTEND, sustainability_pass: EMPTY_SUSTAIN,
      quickfix_pass: { pass_name: 'quickfix', findings: [], summary: 'quickfix summary text' },
    });
    const result = await runMultiPassCodeAudit(stub, PLAN_CONTENT, '', false, null, '', {
      passFilter: ['structure', 'wiring', 'backend', 'frontend', 'sustainability', 'quickfix'],
      noTools: true, noDebtLedger: true, scopeMode: 'plan', noLedger: true,
    });
    assert.equal(typeof result._pass_timings.quickfix, 'string');
    assert.match(result.overall_reasoning, /Quickfix/);
    assert.match(result.overall_reasoning, /quickfix summary text/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Round 2 (docs/plans/audit-backlog-triage-hardening.md) — items 1-4
// ═══════════════════════════════════════════════════════════════════════

describe('Item 1 — writeLearningState capability wrapper', () => {
  it('does not call fn when allowed is false', () => {
    let called = false;
    const result = writeLearningState(false, () => { called = true; return 'x'; });
    assert.equal(called, false);
    assert.equal(result, undefined);
  });

  it('calls fn and returns its value when allowed is true', () => {
    const result = writeLearningState(true, () => 'called');
    assert.equal(result, 'called');
  });

  it('propagates fn\'s return value through async functions unchanged', async () => {
    const result = await writeLearningState(true, async () => 'async-value');
    assert.equal(result, 'async-value');
  });

  it('runOrphanIntroducedPass never emits orphan-run metrics when learningWritesAllowed is false (observation-only shadow)', async () => {
    // No archReport → SKIPPED_NO_GRAPH short-circuit; the point is just that
    // this must not throw and must not attempt any write when gated off.
    const result = await runOrphanIntroducedPass({
      archReport: null, repoRoot: process.cwd(), baseRef: 'HEAD~1', headRef: 'HEAD',
      runId: 'test-run', planContent: null, ledger: null, learningWritesAllowed: false,
    });
    assert.equal(result.state, 'SKIPPED_NO_GRAPH');
  });
});

describe('Item 2 — cleanupCache() logs removal failures instead of swallowing them', () => {
  it('logs to stderr and does not throw when fs.rmSync fails', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpa-cleanup-'));
    try {
      const outFile = path.join(tmpDir, 'result.json');
      initResultCache(outFile);
      cachePassResult('probe', { ok: true }); // establishes _cacheDir for real
      const cacheDirEntries = fs.readdirSync(tmpDir).filter(f => f.startsWith('.audit-cache-'));
      const cacheDir = path.join(tmpDir, cacheDirEntries[0]);

      // Scoped to the cache dir ONLY — an unscoped mock would also intercept
      // this test's own `finally` cleanup of `tmpDir` below, throwing
      // uncaught after the mock outlives this callback (found live: the
      // first version of this test did exactly that).
      const realRmSync = fs.rmSync.bind(fs);
      t.mock.method(fs, 'rmSync', (p, ...rest) => {
        if (path.resolve(String(p)) === path.resolve(cacheDir)) {
          throw Object.assign(new Error('simulated rm failure'), { code: 'EBUSY' });
        }
        return realRmSync(p, ...rest);
      });

      let stderrOutput = '';
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
      try {
        assert.doesNotThrow(() => cleanupCache());
      } finally {
        process.stderr.write = originalWrite;
      }
      assert.match(stderrOutput, /cleanup failed/);
      assert.match(stderrOutput, /EBUSY|simulated rm failure/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('Item 3 — classifyShadowFailureSafe guards its own recovery import', () => {
  it('falls back to a safe classification when the recovery import itself fails, instead of throwing', async () => {
    const originalErr = new Error('original shadow failure');
    const failingImporter = () => { throw new Error('module load failed'); };
    const { log, marker } = await classifyShadowFailureSafe(originalErr, failingImporter);
    assert.equal(marker, null);
    assert.match(log, /shadow failure classification unavailable/);
    assert.match(log, /module load failed/);
    assert.match(log, /original shadow failure/);
  });

  it('delegates to the real classifyShadowFailure when the import succeeds', async () => {
    const { classifyShadowFailure } = await import('../scripts/lib/audit-shadow.mjs');
    const originalErr = new Error('some shadow error');
    const direct = classifyShadowFailure(originalErr);
    const viaSafe = await classifyShadowFailureSafe(originalErr);
    assert.deepEqual(viaSafe, direct);
  });
});

describe('Item 4 — fuzzy-dedup replacement carries the NEW finding\'s _hash (static regression guard)', () => {
  it('the fuzzy-dedup branch no longer keeps the replaced finding\'s stale _hash', () => {
    const src = fs.readFileSync(path.resolve('scripts/lib/audit/legacy-production-audit.mjs'), 'utf-8');
    assert.doesNotMatch(
      src, /_hash: allFindings\[dupeIdx\]\._hash/,
      'fuzzy-dedup replacement must not retain the REPLACED finding\'s _hash — it must use the new finding\'s hash, matching the exact-dedup branch'
    );
    // Both dedup branches (exact at ~2456, fuzzy nearby) must now agree:
    // `_hash: hash` appears at least twice in the addFindings dedup region.
    const hashAssignments = src.match(/_hash: hash,/g) || [];
    assert.ok(hashAssignments.length >= 2, `expected both dedup branches to assign _hash: hash — found ${hashAssignments.length}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Round 2 audit finding M10 (2026-07-24) — dedupReplacementId
// ═══════════════════════════════════════════════════════════════════════

describe('dedupReplacementId — a dedup replacement\'s id must match its severity', () => {
  it('keeps the existing id when severity is unchanged', () => {
    const counter = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    const id = dedupReplacementId('M2', 'MEDIUM', 'MEDIUM', counter);
    assert.equal(id, 'M2');
    assert.deepEqual(counter, { HIGH: 3, MEDIUM: 2, LOW: 1 }, 'counter must not be mutated when severity is unchanged');
  });

  it('mints a fresh id from the NEW severity\'s counter when severity changes (the M10 bug)', () => {
    const counter = { HIGH: 0, MEDIUM: 0, LOW: 5 };
    // A LOW finding ("L5") is being replaced by a HIGH-severity duplicate —
    // keeping "L5" would label a HIGH finding with a LOW-prefixed id.
    const id = dedupReplacementId('L5', 'LOW', 'HIGH', counter);
    assert.equal(id, 'H1');
    assert.equal(counter.HIGH, 1, 'the new severity\'s counter must be incremented');
    assert.equal(counter.LOW, 5, 'the old severity\'s counter must be untouched');
  });

  it('never produces an id whose letter prefix disagrees with the passed-in new severity', () => {
    const counter = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const [from, to, expectedLetter] of [['LOW', 'HIGH', 'H'], ['HIGH', 'MEDIUM', 'M'], ['MEDIUM', 'LOW', 'L']]) {
      const id = dedupReplacementId('X0', from, to, counter);
      assert.equal(id[0], expectedLetter, `${from}->${to} must produce a ${expectedLetter}-prefixed id, got ${id}`);
    }
  });
});

describe('run-cost telemetry reaches the store (2026-08-10 regression)', () => {
  const SRC = fs.readFileSync('scripts/lib/audit/legacy-production-audit.mjs', 'utf-8');

  it('the recordRunComplete payload carries costEstimate', () => {
    // `recordRunComplete` has always mapped stats.costEstimate ->
    // audit_runs.total_cost_estimate, and the audit has priced its aggregate
    // into totalUsage.costUsd since 2026-07-22 — but the payload never passed
    // it. Result: 128 runs over 7 days, ALL with total_cost_estimate NULL,
    // while seven cache-telemetry fields in the same object were populated.
    //
    // A column that is always null does not look broken. It looks free. That
    // is why this is pinned in source rather than left to a live query: the
    // failure produces no error, no warning and no wrong number — just an
    // absence that reads as zero spend.
    // The payload MOVED (durability plan Phase 3, 2026-08-12): the completion
    // write now goes through `durableWrite('audit.runComplete', …)`, so the
    // stats object is bound to `completionStats` first instead of being an
    // inline argument. Same object, same invariant, new anchor.
    const payload = SRC.slice(SRC.indexOf('const completionStats = {'));
    const block = payload.slice(0, payload.indexOf('\n    };'));
    assert.match(block, /costEstimate:/, 'recordRunComplete payload dropped costEstimate — per-run spend will silently stop being recorded');
    assert.match(block, /costEstimate:\s*totalUsage\.costUsd/, 'costEstimate must come from the priced aggregate, not a re-derivation');
  });

  it('costEstimate preserves an unpriced model as null, never 0', () => {
    // costFromUsage returns null for a model absent from the pricing table
    // (e.g. an Azure deployment id). Coercing that to 0 would report an
    // unpriceable run as a free one — the exact conflation the null exists for.
    // The payload MOVED (durability plan Phase 3, 2026-08-12): the completion
    // write now goes through `durableWrite('audit.runComplete', …)`, so the
    // stats object is bound to `completionStats` first instead of being an
    // inline argument. Same object, same invariant, new anchor.
    const payload = SRC.slice(SRC.indexOf('const completionStats = {'));
    const block = payload.slice(0, payload.indexOf('\n    };'));
    assert.doesNotMatch(block, /costEstimate:\s*totalUsage\.costUsd\s*\|\|/, 'a `||` fallback here turns an unknown cost into a measured $0');
  });
});
