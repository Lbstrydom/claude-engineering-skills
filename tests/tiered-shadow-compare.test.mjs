import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Air-gap the cloud write `runTieredShadowComparison` now performs
// (2026-07-13 — real Supabase persistence added alongside the local log).
// Matches the EXISTING convention in run-multi-pass-code-audit-harness.test.mjs
// EXACTLY, including WHY it must be a dynamic import: a static
// `import ... from` is hoisted in ESM and evaluates before this file's own
// top-level body runs, so a plain env override placed above a static import
// would NOT reliably take effect first. Only a dynamic `await import()`,
// which executes in normal top-to-bottom order, guarantees the override
// lands before the module (and its store/db transitive imports) evaluates.
// Prior value captured + restored so this override never leaks into a
// differently-configured process.
const _priorAuditDbUrl = process.env.AUDIT_DB_URL;
process.env.AUDIT_DB_URL = '';
process.on('exit', () => {
  if (_priorAuditDbUrl === undefined) delete process.env.AUDIT_DB_URL;
  else process.env.AUDIT_DB_URL = _priorAuditDbUrl;
});

const {
  buildShadowCtx, compareAuditRunResults, runShadowTieredPipeline,
  appendShadowLog, runTieredShadowComparison,
  buildLegacyBuckets, buildTieredBuckets,
} = await import('../scripts/lib/audit/tiered-shadow-compare.mjs');
const { TieredUnavailableError } = await import('../scripts/lib/audit/tiered-pipeline.mjs');

// Shared fixture helper for the bucketing suites below — `semanticId` keys
// on `category|section|detail`, so distinct values here guarantee distinct ids.
const mkFinding = (n, over = {}) => ({
  id: `F${n}`, severity: 'MEDIUM', category: `cat-${n}`, section: `src/f${n}.mjs:1`,
  detail: `detail-${n}`, risk: 'r', recommendation: 'rec',
  is_quick_fix: false, is_mechanical: false, principle: 'p',
  _primaryFile: `src/f${n}.mjs`, affectedFiles: [`src/f${n}.mjs`],
  ...over,
});

describe('buildShadowCtx', () => {
  test('disables every ledger/debt write path — the load-bearing safety property', () => {
    const ctx = { runId: 'r1', ledgerFile: '/real/ledger.json', planContent: 'x', changedFiles: ['a.js'] };
    const shadow = buildShadowCtx(ctx);
    assert.equal(shadow.ledgerFile, null);
    assert.equal(shadow.noLedger, true);
    assert.equal(shadow.noDebtLedger, true);
    assert.equal(shadow.readOnlyDebt, true);
    assert.equal(shadow.noCloudRecording, true);
  });

  test('preserves read-only inputs unchanged (same commit, same diff)', () => {
    const ctx = { runId: 'r1', planContent: 'plan text', changedFiles: ['a.js', 'b.js'], diffText: 'diff' };
    const shadow = buildShadowCtx(ctx);
    assert.equal(shadow.planContent, 'plan text');
    assert.deepEqual(shadow.changedFiles, ['a.js', 'b.js']);
    assert.equal(shadow.diffText, 'diff');
  });

  test('runId is left unchanged — collision-avoidance is now noCloudRecording, not id-mangling', () => {
    // Previously suffixed to `${runId}-shadow` to dodge colliding with the
    // real run's audit_runs row — not a valid uuid, so every write attempt
    // failed loudly instead of writing nothing. noCloudRecording blocks the
    // write outright, so runId stays a valid, real id — still useful as a
    // local telemetry label (tiered-pipeline.mjs's `_sid`).
    const shadow = buildShadowCtx({ runId: 'abc123' });
    assert.equal(shadow.runId, 'abc123');
    assert.equal(shadow.noCloudRecording, true);
  });
});

// `runLegacyProductionAudit` is not exposed for dependency injection (a giant
// orchestrator reading real provider/store modules), and its cloud-recording
// block is only reachable with a live AUDIT_DB_URL — not hermetically
// unit-mockable (see run-unification.test.mjs's identical reasoning for
// recordRunStart). Static guard instead: pins that noCloudRecording is
// destructured with the correct default AND actually gates the block that
// sets cloudRepoId/cloudRunId, so a future refactor can't silently drop the
// check and resume trying (and failing) to write shadow-fallback audit_runs
// rows under an invalid `<uuid>-shadow` id.
describe('runLegacyProductionAudit — noCloudRecording wiring (static regression guard)', () => {
  test('noCloudRecording is destructured from ctx with a safe default', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/lib/audit/legacy-production-audit.mjs'), 'utf-8',
    );
    assert.match(src, /noCloudRecording\s*=\s*false/,
      'expected `noCloudRecording = false` in the ctx destructure');
  });

  test('the cloud-recording gate checks !noCloudRecording', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/lib/audit/legacy-production-audit.mjs'), 'utf-8',
    );
    assert.match(src, /if\s*\(!noCloudRecording\s*&&\s*\(await isCloudEnabled\(\)\)\s*&&\s*repoProfile\)/,
      'expected the cloud-recording block\'s entry condition to short-circuit on !noCloudRecording');
  });
});

describe('compareAuditRunResults', () => {
  // A LOCATED finding: file:line in `section`. The two pipelines phrase
  // `detail` differently for the same bug, so identity must be LOCATION, not
  // prose (see the cross-pipeline-correlation suite below for the full why).
  const at = (file, line, detail, severity = 'HIGH') => ({ category: 'bug', section: `${file}:${line}`, detail, severity, _primaryFile: file });

  test('counts overlap/only-legacy/only-tiered by LOCATION (file+line), not by prose identity', () => {
    // Same bug at the same spot, phrased differently by the two auditors — a
    // real overlap. Plus one located-only finding on each side.
    const legacy = { findings: [at('x.js', 10, 'null deref when user is missing'), at('a.js', 5, 'legacy-only bug')], runStatus: 'complete', _usage: { costUsd: 1.5 }, _pass_timings: { total: '10.0s' } };
    const tiered = { findings: [at('x.js', 12, 'possible NPE on absent user'), at('b.js', 7, 'tiered-only bug')], runStatus: 'complete', _usage: { costUsd: 0.5 }, _pass_timings: { total: '4.0s' } };
    const cmp = compareAuditRunResults(legacy, tiered);
    assert.equal(cmp.legacyFindingCount, 2);
    assert.equal(cmp.tieredFindingCount, 2);
    assert.equal(cmp.overlapCount, 1, 'x.js:10 vs x.js:12 are within the line window — the SAME issue');
    assert.equal(cmp.onlyLegacyCount, 1);
    assert.equal(cmp.onlyTieredCount, 1);
  });

  test('cost and latency deltas read from the shared _usage/_pass_timings contract', () => {
    const legacy = { findings: [], runStatus: 'complete', _usage: { costUsd: 2 }, _pass_timings: { total: '12.5s' } };
    const tiered = { findings: [], runStatus: 'complete', _usage: { costUsd: 0.8 }, _pass_timings: { total: '5.1s' } };
    const cmp = compareAuditRunResults(legacy, tiered);
    assert.equal(cmp.legacyCostUsd, 2);
    assert.equal(cmp.tieredCostUsd, 0.8);
    assert.equal(cmp.legacyLatencySec, 12.5);
    assert.equal(cmp.tieredLatencySec, 5.1);
  });

  test('missing/malformed cost or timing fields resolve to null, never a fabricated 0', () => {
    const cmp = compareAuditRunResults({ findings: [] }, { findings: [] });
    assert.equal(cmp.legacyCostUsd, null);
    assert.equal(cmp.legacyLatencySec, null);
  });

  test('runStatus is passed through for fallback_legacy visibility', () => {
    const cmp = compareAuditRunResults({ findings: [], runStatus: 'complete' }, { findings: [], runStatus: 'fallback_legacy' });
    assert.equal(cmp.legacyRunStatus, 'complete');
    assert.equal(cmp.tieredRunStatus, 'fallback_legacy');
  });

  // 2026-07-14 incident: the fallback reason was never persisted, so 20/20
  // silent fallbacks across two repos were invisible in stored telemetry —
  // confirming the cause required a live repro instead of a DB query.
  test('fallbackReason is passed through so a fallback is diagnosable without a live repro', () => {
    const cmp = compareAuditRunResults(
      { findings: [], runStatus: 'complete' },
      { findings: [], runStatus: 'fallback_legacy', fallbackReason: 'required generator failed: sonnet: boom' },
    );
    assert.equal(cmp.tieredFallbackReason, 'required generator failed: sonnet: boom');
  });

  test('fallbackReason is null (never undefined) when the tiered run completed normally', () => {
    const cmp = compareAuditRunResults({ findings: [], runStatus: 'complete' }, { findings: [], runStatus: 'complete' });
    assert.equal(cmp.tieredFallbackReason, null);
  });

  // 2026-07-15: two `complete` shadow runs landed with 0 tiered findings
  // against 8-14 legacy findings each — genuinely undiagnosable, because
  // neither generatorOutcomes nor the per-stage counts (both already
  // computed on the full tieredResult) were ever copied into the persisted
  // comparison. Same failure shape as the fallbackReason incident above:
  // the data existed in memory and was thrown away before it reached
  // storage. These two fields close that gap.
  test('generatorOutcomes and stageBreakdown are passed through so a 0-finding complete run is diagnosable', () => {
    const generatorOutcomes = [
      { model: 'z-ai/glm-5.2', role: 'required', status: 'succeeded', findingCount: 3 },
      { model: 'claude-sonnet-5', role: 'required', status: 'succeeded', findingCount: 2 },
    ];
    const stageBreakdown = {
      discoveryRawFindings: 5, stage0Verified: 0, stage0Rejected: 5,
      stage1MechanicalDismissed: 0, stage1Escalated: 0, stage1ConfirmedSurvivor: 0, stage1BudgetExhausted: 0,
      stage2Verified: 0, stage2Reversed: 0, stage2ConfirmedDismissal: 0, stage2MissedCandidate: 0, stage2Unresolved: 0,
    };
    const cmp = compareAuditRunResults(
      { findings: [], runStatus: 'complete' },
      { findings: [], runStatus: 'complete', generatorOutcomes, _stageBreakdown: stageBreakdown },
    );
    assert.deepEqual(cmp.tieredGeneratorOutcomes, generatorOutcomes);
    assert.deepEqual(cmp.tieredStageBreakdown, stageBreakdown);
    // This exact shape (5 raw findings, 0 verified by Stage 0) is what
    // "generators produced candidates but Stage 0 rejected all of them"
    // looks like — distinguishable now from "generators found nothing"
    // (discoveryRawFindings: 0), which was impossible before this fix.
    assert.equal(cmp.tieredStageBreakdown.discoveryRawFindings, 5);
    assert.equal(cmp.tieredStageBreakdown.stage0Verified, 0);
  });

  test('generatorOutcomes and stageBreakdown are null (never undefined) when absent', () => {
    const cmp = compareAuditRunResults({ findings: [] }, { findings: [] });
    assert.equal(cmp.tieredGeneratorOutcomes, null);
    assert.equal(cmp.tieredStageBreakdown, null);
  });
});

// ── Cross-pipeline finding correlation (2026-07-22 defect) ─────────────────
// The overlap metric was keyed on `semanticId` — a hash of the finding's
// PROSE (category|section|detail). Two DIFFERENT auditors (legacy GPT 5-pass
// vs the tiered discovery→Gemini pipeline) essentially never phrase a finding
// identically, so the prose-hash overlap was structurally ~0: all 13
// `tieredRunStatus='complete'` shadow rows since the 2026-07-17 anchor fix
// read overlapCount:0, making the central "do the two pipelines agree?"
// metric decision-void. Overlap is now correlated by LOCATION (file + line
// proximity). NOTE: the historical rows persist only counts, not findings, so
// this suite (realistic synthetic findings) + the next real shadow runs are
// the only validation available — the 13 void rows cannot be re-derived.
describe('compareAuditRunResults — cross-pipeline correlation by location, not prose', () => {
  const at = (file, line, detail) => ({ category: 'bug', section: `${file}:${line}`, detail, severity: 'HIGH', _primaryFile: file });

  test('same file+line, DIFFERENT prose still overlaps — the exact case prose-hash missed', () => {
    const legacy = { findings: [at('src/auth.mjs', 42, 'token compared with == allowing type coercion')] };
    const tiered = { findings: [at('src/auth.mjs', 44, 'loose equality on auth token permits bypass')] };
    const c = compareAuditRunResults(legacy, tiered);
    assert.equal(c.overlapCount, 1, 'the two auditors flagged the same spot — a real overlap semanticId could never see');
    assert.equal(c.onlyLegacyCount, 0);
    assert.equal(c.onlyTieredCount, 0);
  });

  test('same file but lines beyond the window are distinct issues, not an overlap', () => {
    const legacy = { findings: [at('src/big.mjs', 10, 'bug A')] };
    const tiered = { findings: [at('src/big.mjs', 400, 'bug B far away')] };
    const c = compareAuditRunResults(legacy, tiered);
    assert.equal(c.overlapCount, 0, 'line 10 vs 400 in the same file are two different bugs');
    assert.equal(c.onlyLegacyCount, 1);
    assert.equal(c.onlyTieredCount, 1);
  });

  test('different files never overlap', () => {
    const c = compareAuditRunResults(
      { findings: [at('src/a.mjs', 5, 'x')] },
      { findings: [at('src/b.mjs', 5, 'x')] },
    );
    assert.equal(c.overlapCount, 0);
  });

  test('same file+line but DIFFERENT severity does NOT overlap — a LOW nit is not the HIGH vuln beside it (Gemini gate)', () => {
    const legacy = { findings: [{ category: 'style', section: 'src/a.mjs:20', detail: 'trailing whitespace', severity: 'LOW', _primaryFile: 'src/a.mjs' }] };
    const tiered = { findings: [{ category: 'security', section: 'src/a.mjs:21', detail: 'auth bypass', severity: 'HIGH', _primaryFile: 'src/a.mjs' }] };
    const c = compareAuditRunResults(legacy, tiered);
    assert.equal(c.overlapCount, 0, 'different severity at nearby lines must not inflate overlap');
    assert.equal(c.onlyLegacyCount, 1);
    assert.equal(c.onlyTieredCount, 1);
  });

  test('same file+line AND same severity still overlaps (the discriminator does not block genuine agreement)', () => {
    const c = compareAuditRunResults(
      { findings: [{ category: 'bug', section: 'src/a.mjs:20', detail: 'npe', severity: 'HIGH', _primaryFile: 'src/a.mjs' }] },
      { findings: [{ category: 'correctness', section: 'src/a.mjs:22', detail: 'null deref', severity: 'HIGH', _primaryFile: 'src/a.mjs' }] },
    );
    assert.equal(c.overlapCount, 1);
  });

  test('correlation is one-to-one — two legacy findings at one spot match at most the one tiered finding there', () => {
    const legacy = { findings: [at('src/f.mjs', 20, 'first'), at('src/f.mjs', 21, 'second')] };
    const tiered = { findings: [at('src/f.mjs', 20, 'the one tiered finding here')] };
    const c = compareAuditRunResults(legacy, tiered);
    assert.equal(c.overlapCount, 1, 'one tiered finding cannot cover two legacy findings');
    assert.equal(c.onlyLegacyCount, 1, 'the second legacy finding is a genuine miss');
    assert.equal(c.onlyTieredCount, 0);
  });

  test('a finding with no resolvable line is conservatively NON-overlapping and surfaced as unlocalized', () => {
    // File-only (no `:line`) on both sides — could be the same bug or two
    // different bugs in the file; for a production-FLIP gate the safe reading
    // is "not confirmed to overlap", and the ambiguity is made visible rather
    // than silently counted either way.
    const legacy = { findings: [{ category: 'bug', section: 'src/auth.mjs', detail: 'x', severity: 'HIGH', _primaryFile: 'src/auth.mjs' }] };
    const tiered = { findings: [{ category: 'bug', section: 'src/auth.mjs', detail: 'y', severity: 'HIGH', _primaryFile: 'src/auth.mjs' }] };
    const c = compareAuditRunResults(legacy, tiered);
    assert.equal(c.overlapCount, 0, 'no line → not confirmed to overlap (conservative)');
    assert.equal(c.legacyUnlocalizedCount, 1, 'the limitation is surfaced, not hidden');
    assert.equal(c.tieredUnlocalizedCount, 1);
  });

  test('unlocalized counts are 0 (never undefined) when every finding carries a line', () => {
    const c = compareAuditRunResults(
      { findings: [at('a.mjs', 1, 'x')] },
      { findings: [at('a.mjs', 1, 'y')] },
    );
    assert.equal(c.legacyUnlocalizedCount, 0);
    assert.equal(c.tieredUnlocalizedCount, 0);
  });

  test('accounting invariants hold: overlap+debtRouted+onlyLegacy == legacy total; overlap+onlyTiered == tiered total', () => {
    const legacy = { findings: [at('a.mjs', 1, 'shared'), at('b.mjs', 9, 'legacy only'), at('c.mjs', 3, 'debt-routed away')] };
    const tiered = { findings: [at('a.mjs', 2, 'shared reworded'), at('d.mjs', 4, 'tiered only')], debtRoutedFiles: ['c.mjs'] };
    const c = compareAuditRunResults(legacy, tiered);
    assert.equal(c.overlapCount + c.overlapDebtRouted + c.onlyLegacyCount, 3);
    assert.equal(c.overlapCount + c.onlyTieredCount, 2);
    assert.equal(c.overlapDebtRouted, 1);
  });
});

// ── Cost capture (2026-07-22 defect) — static producer guards ─────────────
// The comparison reads `_usage.costUsd` off each result. All 13 `complete`
// shadow rows read legacyCostUsd:NULL (legacy never priced its tokens) and
// tieredCostUsd:0 (the tiered pipeline hardcodes `usageEvents: []`, so
// computeCostReport returns a MEANINGLESS confirmed $0). These are producer
// bugs, not comparison bugs — the giant producers aren't hermetically unit-
// testable (see the noCloudRecording guard above for the same reasoning), so
// pin the fixes at the source with readFileSync guards.
describe('cost producers — legacy + tiered both price real usage (static guards)', () => {
  test('legacy-production-audit prices totalUsage into _usage.costUsd via costFromUsage', () => {
    const src = fs.readFileSync(path.resolve('scripts/lib/audit/legacy-production-audit.mjs'), 'utf-8');
    assert.match(src, /costFromUsage/, 'legacy must price its token totals');
    assert.match(src, /totalUsage\.costUsd\s*=/, 'the priced cost must land on _usage.costUsd (what the comparison reads)');
  });

  // Superseded 2026-07-22 (item 2b): the tiered pipeline no longer emits a flat
  // `costUsd: null` — it now captures per-stage usage and prices it. costUsd is
  // the REAL sum when any captured event was priceable, else honest null
  // (`buildUsageBlock`) — never a fabricated 0 from empty usageEvents.
  test('the tiered pipeline prices captured usage — real sum when priced, honest null when not (no flat null, no fabricated 0)', () => {
    const src = fs.readFileSync(path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf-8');
    assert.match(src, /costUsd:\s*hasPricedUsage\s*\?\s*report\.costUsd\s*:\s*null/, 'cost must derive from whether any captured event was priced');
    assert.match(src, /computeCostReport\(\{\s*usageEvents\b/, 'the empty-events hardcode is gone; real usageEvents flow in');
    assert.doesNotMatch(src, /computeCostReport\(\{\s*usageEvents:\s*\[\]/, 'no hardcoded empty-events call may remain');
  });
});

// tiered-pipeline.mjs's success-path return isn't hermetically unit-testable
// end-to-end (Stage 0/1/2 need real provider adapters + evidence-triage
// input shapes — see the Stage 2 fail-fast describe block below for why this
// file only injection-tests the entry guard). Static guard instead: pins
// that `_stageBreakdown` is built from the SAME variables as
// `overall_reasoning` immediately above it, so the two can't silently drift
// apart (e.g. a future edit changing what `overall_reasoning` counts
// without updating the structured mirror, or vice versa).
describe('runTieredAuditPipeline — _stageBreakdown wiring (static regression guard)', () => {
  test('_stageBreakdown counts use the same source variables as overall_reasoning', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf-8',
    );
    assert.match(src, /discoveryRawFindings:\s*rawFindings\.length/);
    // docs/plans/stage0-evidence-relevance-split.md decision #9/#10: this
    // now reports the ACTUAL Stage-1-eligible pool (Gate-A survivors PLUS
    // any pre_existing_independent candidate restored after a debt-routing
    // failure), not the raw Gate-A bucket alone — the number that matters
    // for shadow-comparison eligibility. stage0Rejected now reads directly
    // off runStage0EvidenceTriage's own third bucket instead of a derived
    // subtraction (envelopes.length - stage0Verified.length), which stopped
    // being exact once a third (preExistingIndependent) bucket existed.
    assert.match(src, /stage0Verified:\s*stage0EligibleForStage1\.length/);
    assert.match(src, /stage0Rejected:\s*stage0Rejected\.length/);
    assert.match(src, /stage1MechanicalDismissed:\s*triageResult\.mechanicalDismissed\.length/);
    assert.match(src, /stage2Verified:\s*stage2Result\.verified\.length/);
    assert.match(src, /stage2Unresolved:\s*stage2Result\.unresolved\.length/);
  });
});

describe('runShadowTieredPipeline', () => {
  test('never throws — a provider error resolves ok:false, not a rejection', async () => {
    const outcome = await runShadowTieredPipeline({ runId: 'r1' }, {
      runTieredAuditPipeline: async () => { throw new Error('provider exploded'); },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /provider exploded/);
    assert.equal(typeof outcome.latencyMs, 'number');
  });

  test('a hung pipeline times out rather than hanging forever', async () => {
    const outcome = await runShadowTieredPipeline({ runId: 'r1' }, {
      runTieredAuditPipeline: () => new Promise(() => {}), // never resolves
      timeoutMs: 20,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /timed out/);
  });

  test('success resolves ok:true with the real result', async () => {
    const fakeResult = { findings: [], runStatus: 'complete' };
    const outcome = await runShadowTieredPipeline({ runId: 'r1' }, {
      runTieredAuditPipeline: async () => fakeResult,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result, fakeResult);
  });

  // Regression (found live 2026-07-13, running this exact suite): the losing
  // side of Promise.race left an uncleared setTimeout handle, keeping the
  // event loop alive for the full default timeout (20 min) after a FAST
  // success — every caller (including this test file's own run) would hang.
  // A default-timeout call must not keep the process alive once resolved.
  test('a fast success does not leave a dangling timer alive (would hang the process at the default 20-min timeout otherwise)', async () => {
    const before = process._getActiveHandles ? process._getActiveHandles().length : null;
    await runShadowTieredPipeline({ runId: 'r1' }, { runTieredAuditPipeline: async () => ({ findings: [] }) });
    if (before !== null) {
      const after = process._getActiveHandles().length;
      assert.ok(after <= before, `expected no net-new active handles after a fast success, before=${before} after=${after}`);
    }
  });

  test('the pipeline is invoked with a shadow-safe ctx (ledgerFile disabled)', async () => {
    let capturedCtx = null;
    await runShadowTieredPipeline({ runId: 'r1', ledgerFile: '/real/ledger.json' }, {
      runTieredAuditPipeline: async (ctx) => { capturedCtx = ctx; return { findings: [] }; },
    });
    assert.equal(capturedCtx.ledgerFile, null);
  });
});

describe('appendShadowLog + runTieredShadowComparison (file I/O)', () => {
  let dir, logPath;
  test('writes one JSON record per call, creating the parent dir', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-shadow-'));
    logPath = path.join(dir, 'nested', 'log.jsonl');
    appendShadowLog({ a: 1 }, logPath);
    appendShadowLog({ a: 2 }, logPath);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].a, 1);
    assert.equal(lines[1].a, 2);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('a write failure is swallowed, never thrown (fail-open telemetry)', () => {
    assert.doesNotThrow(() => appendShadowLog({ a: 1 }, '\0invalid\0path'));
  });

  test('runTieredShadowComparison: successful shadow + legacy writes a full comparison record', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-shadow-'));
    logPath = path.join(dir, 'log.jsonl');
    const legacyResultPromise = Promise.resolve({ findings: [], runStatus: 'complete', _usage: { costUsd: 1 }, _pass_timings: { total: '5.0s' } });
    await runTieredShadowComparison({
      ctx: { runId: 'r1' },
      legacyResultPromise,
      runTieredAuditPipeline: async () => ({ findings: [], runStatus: 'complete', _usage: { costUsd: 0.3 }, _pass_timings: { total: '2.0s' } }),
      logPath,
    });
    const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(record.legacyOk, true);
    assert.equal(record.shadowOk, true);
    assert.ok(record.comparison);
    assert.equal(record.comparison.legacyCostUsd, 1);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('a legacy failure is recorded with comparison:null, never a crash', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-shadow-'));
    logPath = path.join(dir, 'log.jsonl');
    await runTieredShadowComparison({
      ctx: { runId: 'r1' },
      legacyResultPromise: Promise.reject(new Error('legacy blew up')),
      runTieredAuditPipeline: async () => ({ findings: [] }),
      logPath,
    });
    const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(record.legacyOk, false);
    assert.equal(record.comparison, null);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('a shadow failure is recorded with shadowOk:false + shadowError, comparison:null', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiered-shadow-'));
    logPath = path.join(dir, 'log.jsonl');
    await runTieredShadowComparison({
      ctx: { runId: 'r1' },
      legacyResultPromise: Promise.resolve({ findings: [], runStatus: 'complete' }),
      runTieredAuditPipeline: async () => { throw new Error('tiered blew up'); },
      logPath,
    });
    const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(record.legacyOk, true);
    assert.equal(record.shadowOk, false);
    assert.match(record.shadowError, /tiered blew up/);
    assert.equal(record.comparison, null);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});

// ── Cluster C: symmetric scope bucketing + bucketed comparison
//    (docs/plans/stage0-evidence-relevance-split.md decisions #6/#7/#10) ────

describe('buildLegacyBuckets — file-level scope bucketing (decision #6)', () => {
  test('a finding whose file IS in changedFiles buckets as change_related', () => {
    const f = mkFinding(1);
    const buckets = buildLegacyBuckets({ findings: [f] }, ['src/f1.mjs', 'src/other.mjs']);
    assert.equal([...buckets.values()][0], 'change_related');
  });

  test('a finding whose file is NOT in a non-empty changedFiles buckets as out-of-scope', () => {
    const f = mkFinding(1);
    const buckets = buildLegacyBuckets({ findings: [f] }, ['src/unrelated.mjs']);
    assert.equal([...buckets.values()][0], 'out-of-scope');
  });

  // The tri-state's whole point: an empty changedFiles is AMBIGUOUS (diff
  // resolution may have failed), so it must never mass-classify everything
  // as out-of-scope — it falls back to the safe, inclusion-biased default.
  test('an empty/absent changedFiles falls back to change_related, never a silent mass out-of-scope', () => {
    const f = mkFinding(1);
    assert.equal([...buildLegacyBuckets({ findings: [f] }, []).values()][0], 'change_related');
    assert.equal([...buildLegacyBuckets({ findings: [f] }, null).values()][0], 'change_related');
  });

  test('an unresolvable file falls back to change_related (the safe default), never out-of-scope', () => {
    const f = mkFinding(1, { _primaryFile: undefined, affectedFiles: [], section: '' });
    assert.equal([...buildLegacyBuckets({ findings: [f] }, ['src/a.mjs']).values()][0], 'change_related');
  });

  test('reuses the isFileInChangedScope predicate — normalized paths match (Windows-safe)', () => {
    const f = mkFinding(1, { _primaryFile: 'SRC/F1.MJS', affectedFiles: ['SRC/F1.MJS'] });
    // normalizePath lowercases (documented accepted debt for Windows) — the
    // legacy side must not report out-of-scope purely on a case difference.
    const buckets = buildLegacyBuckets({ findings: [f] }, ['src/f1.mjs']);
    assert.equal([...buckets.values()][0], 'change_related');
  });

  test('no findings → an empty map, never a throw', () => {
    assert.equal(buildLegacyBuckets({ findings: [] }, ['a.mjs']).size, 0);
    assert.equal(buildLegacyBuckets({}, ['a.mjs']).size, 0);
  });
});

describe('buildTieredBuckets — reads the finding own scopeBucket (decision #8 provenance link)', () => {
  test('each finding scopeBucket is used verbatim', () => {
    const findings = [
      mkFinding(1, { scopeBucket: 'change_related' }),
      mkFinding(2, { scopeBucket: 'pre_existing_impactful' }),
      mkFinding(3, { scopeBucket: 'pre_existing_independent' }),
    ];
    const buckets = buildTieredBuckets({ findings });
    assert.deepEqual([...buckets.values()].sort(), ['change_related', 'pre_existing_impactful', 'pre_existing_independent']);
  });

  test('a finding with no scopeBucket (pre-plan result shape) falls back to change_related', () => {
    const buckets = buildTieredBuckets({ findings: [mkFinding(1)] });
    assert.equal([...buckets.values()][0], 'change_related');
  });
});

describe('compareAuditRunResults — bucketed mode (decisions #7/#10)', () => {
  test('omitting opts preserves the pre-plan overlap math EXACTLY (backward compatible)', () => {
    const shared = mkFinding(1);
    const legacy = { findings: [shared, mkFinding(2)] };
    const tiered = { findings: [shared, mkFinding(3)] };
    const c = compareAuditRunResults(legacy, tiered);
    assert.equal(c.overlapCount, 1);
    assert.equal(c.onlyLegacyCount, 1);
    assert.equal(c.onlyTieredCount, 1);
    // Only the sub-bucket PROVENANCE counts are opts-gated.
    assert.equal('legacyOutOfScopeCount' in c, false);
    assert.equal('tieredPreExistingIndependentCount' in c, false);
  });

  // The structural half of the concurrent session's flag: "an unbucketed
  // production call site would make every future row old-shape and silently
  // un-comparable — a fourth way for this window to read wrong". Fixed by
  // construction: the decision-grade fields never needed the bucket maps, so
  // they are no longer gated on them. A caller CANNOT forget them into
  // existence-as-null.
  test('the decision-grade fields are emitted even WITHOUT opts — an unbucketed caller can never produce a silently un-comparable row', () => {
    const c = compareAuditRunResults({ findings: [mkFinding(1)] }, { findings: [mkFinding(2)] });
    assert.equal(c.legacyEligibleCount, 1);
    assert.equal(c.tieredEligibleCount, 1);
    assert.equal(c.overlapDebtRouted, 0);
  });

  test('overlapDebtRouted is honoured without opts too (it reads debtRoutedFiles off the RESULT, never the bucket maps)', () => {
    const legacy = { findings: [mkFinding(1)] };
    const tiered = { findings: [], debtRoutedFiles: ['src/f1.mjs'] };
    const c = compareAuditRunResults(legacy, tiered);
    assert.equal(c.overlapDebtRouted, 1);
    assert.equal(c.onlyLegacyCount, 0, 'debt-routed is handled, not missed — with or without opts');
  });

  test('symmetric eligible counts are BOTH populated from the same bucket maps (decision #7 / round-2 H3)', () => {
    const legacy = { findings: [mkFinding(1), mkFinding(2)] };
    const tiered = { findings: [mkFinding(3)] };
    const c = compareAuditRunResults(legacy, tiered, {
      legacyBuckets: buildLegacyBuckets(legacy, ['src/f1.mjs', 'src/f2.mjs']),
      tieredBuckets: buildTieredBuckets(tiered),
    });
    assert.equal(c.legacyEligibleCount, 2);
    assert.equal(c.tieredEligibleCount, 1);
  });

  // Decision #10 — the single most consequential fix in the plan. A
  // correctly debt-routed candidate is ABSENT from tieredResult.findings by
  // design; counting the legacy side's finding on that file as a tiered
  // "miss" would penalize the pipeline exactly when it did its job right.
  test('a legacy finding on a debt-routed file counts as overlapDebtRouted, NOT onlyLegacyCount', () => {
    const legacy = { findings: [mkFinding(1), mkFinding(2)] };
    const tiered = { findings: [], debtRoutedFiles: ['src/f1.mjs'] };
    const c = compareAuditRunResults(legacy, tiered, {
      legacyBuckets: buildLegacyBuckets(legacy, ['src/f1.mjs', 'src/f2.mjs']),
      tieredBuckets: buildTieredBuckets(tiered),
    });
    assert.equal(c.overlapDebtRouted, 1, 'f1 was debt-routed — handled, not missed');
    assert.equal(c.onlyLegacyCount, 1, 'only f2 is a genuine miss');
    assert.equal(c.overlapCount, 0, 'a debt-routed match is NOT a two-sided overlap');
  });

  test('a genuine two-sided overlap is never reclassified as overlapDebtRouted', () => {
    const shared = mkFinding(1);
    const legacy = { findings: [shared] };
    const tiered = { findings: [shared], debtRoutedFiles: ['src/f1.mjs'] };
    const c = compareAuditRunResults(legacy, tiered, {
      legacyBuckets: buildLegacyBuckets(legacy, ['src/f1.mjs']),
      tieredBuckets: buildTieredBuckets(tiered),
    });
    assert.equal(c.overlapCount, 1, 'both sides independently produced it — a real overlap');
    assert.equal(c.overlapDebtRouted, 0);
    assert.equal(c.onlyLegacyCount, 0);
  });

  test('no debtRoutedFiles → overlapDebtRouted is 0 and onlyLegacyCount is unchanged', () => {
    const legacy = { findings: [mkFinding(1)] };
    const tiered = { findings: [] };
    const c = compareAuditRunResults(legacy, tiered, {
      legacyBuckets: buildLegacyBuckets(legacy, ['src/f1.mjs']),
      tieredBuckets: buildTieredBuckets(tiered),
    });
    assert.equal(c.overlapDebtRouted, 0);
    assert.equal(c.onlyLegacyCount, 1);
  });

  // Round-3 plan-audit H5, corrected by Gemini round-2 G2: eligibility is
  // "did this finding reach the comparison at all" — decision #9 already
  // guarantees a SUCCESSFULLY routed candidate never becomes a finding, so a
  // pre_existing_independent finding present here is a debt-routing FAILURE
  // fallback and MUST be compared like any other.
  test('a pre_existing_independent-bucketed tiered finding is still eligible (it is a debt-routing FAILURE fallback)', () => {
    const f = mkFinding(1, { scopeBucket: 'pre_existing_independent' });
    const tiered = { findings: [f] };
    const c = compareAuditRunResults({ findings: [] }, tiered, {
      legacyBuckets: new Map(),
      tieredBuckets: buildTieredBuckets(tiered),
    });
    assert.equal(c.tieredEligibleCount, 1, 'never excluded by bucket — it reached the comparison, so it counts');
    assert.equal(c.tieredPreExistingIndependentCount, 1, 'but its provenance is still reported separately');
    assert.equal(c.onlyTieredCount, 1);
  });

  test('detailed sub-bucket counts are reported for provenance without gating eligibility', () => {
    const tiered = { findings: [
      mkFinding(1, { scopeBucket: 'change_related' }),
      mkFinding(2, { scopeBucket: 'change_related' }),
      mkFinding(3, { scopeBucket: 'pre_existing_impactful' }),
      mkFinding(4, { scopeBucket: 'pre_existing_independent' }),
    ] };
    const legacy = { findings: [mkFinding(5)] };
    const c = compareAuditRunResults(legacy, tiered, {
      legacyBuckets: buildLegacyBuckets(legacy, ['src/unrelated.mjs']),
      tieredBuckets: buildTieredBuckets(tiered),
    });
    assert.equal(c.tieredEligibleCount, 4, 'every bucket is eligible');
    assert.equal(c.tieredChangeRelatedCount, 2);
    assert.equal(c.tieredPreExistingImpactfulCount, 1);
    assert.equal(c.tieredPreExistingIndependentCount, 1);
    assert.equal(c.legacyOutOfScopeCount, 1, 'f5 is not in changedFiles');
  });
});

describe('compareAuditRunResults — new copy-through telemetry fields', () => {
  test('tieredStage0Verified is hoisted from _stageBreakdown to a top-level field', () => {
    const c = compareAuditRunResults(
      { findings: [] },
      { findings: [], _stageBreakdown: { stage0Verified: 7 } },
    );
    assert.equal(c.tieredStage0Verified, 7);
  });

  test('tieredStage0Verified is null (never 0) when no _stageBreakdown exists — absent must not read as "verified nothing"', () => {
    const c = compareAuditRunResults({ findings: [] }, { findings: [] });
    assert.equal(c.tieredStage0Verified, null);
  });

  test('debtRoutingIncomplete is persisted so a silent restore-to-pool is diagnosable', () => {
    const c = compareAuditRunResults(
      { findings: [] },
      { findings: [], debtRoutingIncomplete: [{ fingerprint: 'fp1', reason: 'writeDebtEntries threw: disk full' }] },
    );
    assert.deepEqual(c.tieredDebtRoutingIncomplete, [{ fingerprint: 'fp1', reason: 'writeDebtEntries threw: disk full' }]);
  });
});

describe('parseTotalSeconds strictness (Cluster-C audit M1/M4)', () => {
  test('malformed decimal strings resolve to null, never a numeric-prefix truncation', () => {
    // Reached via the public API: _pass_timings.total carries the string.
    const via = (total) => compareAuditRunResults(
      { findings: [], _pass_timings: { total } }, { findings: [] },
    ).legacyLatencySec;
    assert.equal(via('1..5s'), null, '"1..5s" must not parse as 1');
    assert.equal(via('..s'), null);
    assert.equal(via('1.2.3s'), null);
    assert.equal(via('3.2s'), 3.2, 'well-formed values still parse');
    assert.equal(via('10s'), 10, 'integer seconds still parse');
  });
});

// ── The shadow ctx marks itself; the catch preserves the clean reason ─────
// docs/plans/shadow-no-legacy-fallback.md decisions #1/#3.
describe('buildShadowCtx — shadowMode (no-legacy-fallback plan)', () => {
  test('marks the ctx so runTieredAuditPipeline never falls back to a second legacy audit', () => {
    const shadow = buildShadowCtx({ runId: 'r1', planContent: 'x', changedFiles: ['a.js'] });
    assert.equal(shadow.shadowMode, true);
  });

  test('sits alongside the other "not the real run" markers — one coherent set', () => {
    const shadow = buildShadowCtx({ runId: 'r1' });
    // If a future edit drops shadowMode while keeping the rest, the shadow
    // silently resumes burning a full legacy audit per failed run.
    for (const flag of ['noLedger', 'noDebtLedger', 'readOnlyDebt', 'noCloudRecording', 'shadowMode']) {
      assert.equal(shadow[flag], true, `${flag} must be set on a shadow ctx`);
    }
  });

  test('PRODUCTION never gets shadowMode — the flag is opt-in, absence is the safe default', () => {
    // The production caller (openai-audit.mjs:440) passes its ctx straight
    // through; nothing sets shadowMode for it.
    const productionCtx = { runId: 'r1', planContent: 'x' };
    assert.equal(productionCtx.shadowMode, undefined);
  });
});

describe('runShadowTieredPipeline — TieredUnavailableError handling', () => {
  test('a TieredUnavailableError resolves ok:false with the CLEAN .reason (not a raw message)', async () => {
    const reason = 'required generator failed: glm: [timeout] aborted; sonnet: 529 overloaded';
    const outcome = await runShadowTieredPipeline({ runId: 'r1' }, {
      runTieredAuditPipeline: async () => { throw new TieredUnavailableError(reason); },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, reason, 'the formatted reason must reach shadowError verbatim');
    assert.equal(typeof outcome.latencyMs, 'number');
  });

  test('a NON-typed throw (a real harness bug) still resolves ok:false with err.message', async () => {
    const outcome = await runShadowTieredPipeline({ runId: 'r1' }, {
      runTieredAuditPipeline: async () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /Cannot read properties of undefined/);
  });

  // The reason string is self-discriminating — which is why no persisted
  // boolean was added (plan decision #3/#4). An operator reading
  // shadowFailureReasons can tell a provider outage from a harness bug.
  test('the two failure classes are distinguishable by their reason string alone', async () => {
    const unavailable = await runShadowTieredPipeline({}, {
      runTieredAuditPipeline: async () => { throw new TieredUnavailableError('required generator failed: glm: boom'); },
    });
    const bug = await runShadowTieredPipeline({}, {
      runTieredAuditPipeline: async () => { throw new Error('undefined is not a function'); },
    });
    assert.match(unavailable.error, /^required generator failed: /);
    assert.doesNotMatch(bug.error, /^required generator failed: /);
  });
});

describe('runTieredShadowComparison — an unavailable tiered run records honestly and cheaply', () => {
  test('records shadowOk:false + the reason + comparison:null — and never fabricates a comparison', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-unavail-'));
    const logPath = path.join(dir, 'log.jsonl');
    try {
      await runTieredShadowComparison({
        ctx: { runId: 'r1', planContent: 'x', changedFiles: ['a.js'] },
        legacyResultPromise: Promise.resolve({ findings: [], runStatus: 'complete' }),
        runTieredAuditPipeline: async () => {
          throw new TieredUnavailableError('required generator failed: glm: [timeout] aborted');
        },
        logPath,
      });
      const rec = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
      assert.equal(rec.legacyOk, true);
      assert.equal(rec.shadowOk, false);
      assert.match(rec.shadowError, /required generator failed: glm/);
      assert.equal(rec.comparison, null,
        'an unavailable tiered run must NOT produce a comparison — that was the legacy-vs-legacy bug');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// ── buildShadowCtx must not share mutable state with the real ctx ─────────
// Audit round-1 M2, reproduced directly: the shallow spread shared the
// `generatorOutcomes` ARRAY, and discovery-portfolio.mjs mutates it IN PLACE
// (append-only) — so the shadow's discovery pushed its outcomes into the
// REAL run's array while the two ran concurrently. Contained today only
// because runLegacyProductionAudit hardcodes `generatorOutcomes: []` on its
// result (legacy-production-audit.mjs:2974); a latent hazard, and a direct
// contradiction of this function's own contract.
describe('buildShadowCtx — no shared mutable state with the real ctx (audit M2)', () => {
  test('generatorOutcomes is SNAPSHOT, not shared by reference', () => {
    const real = { runId: 'r1', generatorOutcomes: [] };
    const shadow = buildShadowCtx(real);
    assert.notEqual(shadow.generatorOutcomes, real.generatorOutcomes,
      'the shadow must not hold the same array instance as the real ctx');
  });

  test("the shadow's in-place appends never reach the real ctx", () => {
    const real = { runId: 'r1', generatorOutcomes: [] };
    const shadow = buildShadowCtx(real);
    // Exactly what discovery-portfolio.mjs does (append-only, in place).
    shadow.generatorOutcomes.push({ model: 'glm', role: 'required', status: 'failed' });
    shadow.generatorOutcomes.push({ model: 'sonnet', role: 'required', status: 'failed' });
    assert.equal(real.generatorOutcomes.length, 0,
      'the real, concurrently-running audit ctx must be untouched by the shadow');
    assert.equal(shadow.generatorOutcomes.length, 2, 'the shadow still records its own outcomes');
  });

  test('pre-existing outcomes are COPIED forward, not dropped', () => {
    const real = { runId: 'r1', generatorOutcomes: [{ model: 'prior', role: 'required', status: 'succeeded' }] };
    const shadow = buildShadowCtx(real);
    assert.deepEqual(shadow.generatorOutcomes, real.generatorOutcomes, 'contents equal…');
    assert.notEqual(shadow.generatorOutcomes, real.generatorOutcomes, '…but not the same instance');
  });

  test('an absent generatorOutcomes degrades to an empty array, never a crash', () => {
    assert.deepEqual(buildShadowCtx({ runId: 'r1' }).generatorOutcomes, []);
  });
});
