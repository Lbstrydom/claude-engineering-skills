/**
 * Shadow-validation flip wiring (2026-07-13) — the seams that had to change
 * before AUDIT_TIERED_SHADOW_ENABLED could produce real data instead of
 * deterministic failures:
 *  1. the Stage 2 subprocess adapter's default gemini-review.mjs path must be
 *     MODULE-relative (consumer scripts/.claude-skills/ layout), never
 *     repoRoot-relative (source layout only);
 *  2. runTieredAuditPipeline requires BOTH Stage 2 handles (reviewCall /
 *     cleanRegionCall have different signatures — one function cannot serve
 *     both), failing fast with a clear configuration error.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import os from 'node:os';
import { defaultGeminiReviewScriptPath } from '../scripts/lib/audit/final-adjudication.mjs';
import { runTieredAuditPipeline, TieredUnavailableError } from '../scripts/lib/audit/tiered-pipeline.mjs';
import { buildAuditRunContext } from '../scripts/lib/audit/legacy-production-audit.mjs';

// 2026-07-15: root cause behind the first 4 real `complete` shadow runs all
// landing with 0 tiered findings against 10-18 raw discovery candidates
// EVERY time — not model-recall noise, a wiring gap. `ctx.diffText` is read
// in 3 places (discovery-portfolio.mjs, tiered-pipeline.mjs,
// evidence-triage.mjs) but was never ASSIGNED anywhere in the whole
// codebase, so evidence-triage.mjs's `verifyAnchor` unconditionally
// returned 'unverifiable' for every candidate (`if (!diffText) return
// 'unverifiable'`) — Stage 0 rejected 100% of candidates, always.
// `runLegacyProductionAudit` never needed this (it independently re-reads
// `diffFile` itself for its own line-count metadata), so the gap was
// invisible on the legacy-only path this whole time.
describe('buildAuditRunContext — diffText wiring (2026-07-15, Stage-0-always-rejects incident)', () => {
  test('diffFile is read into ctx.diffText — the exact field evidence-triage.mjs needs', async () => {
    const tmpFile = path.join(os.tmpdir(), `diff-text-wiring-${process.pid}-${Date.now()}.patch`);
    const diffContent = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new\n';
    fs.writeFileSync(tmpFile, diffContent, 'utf-8');
    try {
      const ctx = await buildAuditRunContext({ openai: { fake: true }, planContent: 'x', changedFiles: [], diffFile: tmpFile });
      assert.equal(ctx.diffText, diffContent);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test('no diffFile → diffText is null, not undefined or a crash (evidence-triage degrades gracefully on null)', async () => {
    const ctx = await buildAuditRunContext({ openai: { fake: true }, planContent: 'x', changedFiles: [] });
    assert.equal(ctx.diffText, null);
  });

  test('an unreadable diffFile degrades to diffText:null instead of throwing — the legacy path\'s own read is the authoritative loud failure', async () => {
    const ctx = await buildAuditRunContext({ openai: { fake: true }, planContent: 'x', changedFiles: [], diffFile: path.join(os.tmpdir(), 'does-not-exist-12345.patch') });
    assert.equal(ctx.diffText, null);
  });
});

describe('defaultGeminiReviewScriptPath (consumer-layout safety)', () => {
  test('resolves module-relative to an existing gemini-review.mjs sibling', () => {
    const p = defaultGeminiReviewScriptPath();
    assert.ok(p.endsWith('gemini-review.mjs'), `unexpected basename: ${p}`);
    assert.ok(fs.existsSync(p), `default script path does not exist: ${p}`);
  });

  test('does not depend on process.cwd() (the repoRoot-join form broke in consumers)', () => {
    const fromRepoRoot = defaultGeminiReviewScriptPath();
    const saved = process.cwd();
    try {
      process.chdir(path.dirname(saved)); // any other directory
      assert.equal(defaultGeminiReviewScriptPath(), fromRepoRoot);
    } finally {
      process.chdir(saved);
    }
  });
});

describe('allowTiered call-site gate (shadow-flip incident regression, 2026-07-13)', () => {
  // The env flags load from the shared ~/.audit-loop.env into EVERY Node
  // process — including test runs whose harnesses stub only the `openai`
  // argument. Without the per-call `allowTiered` opt, flipping
  // AUDIT_TIERED_SHADOW_ENABLED=true routed fully-mocked unit tests into
  // real multi-provider execution (observed live: full suite 54s → 6.5min,
  // real GLM/Sonnet calls + gemini-review subprocess spawns from inside
  // stubbed tests). tieredAuditConfig freezes at module import, so this is
  // asserted in a hermetic subprocess with the env var forced on.
  // audit-code R1 fix M1: explicitly force AUDIT_TIERED_PIPELINE_ENABLED
  // off too — the incident is about SHARED/OPERATOR flags leaking into
  // tests, so a probe that only forces the shadow flag while inheriting
  // whatever AUDIT_TIERED_PIPELINE_ENABLED the host happens to have would
  // be testing an unisolated combination. AUDIT_LOOP_DISABLE_SHARED stops
  // the ~/.audit-loop.env LOAD; it does not unset an already-exported
  // parent variable, so both flags are pinned explicitly here.
  // audit-code R1 fix L1: `process.execPath` (not the literal `'node'`) and
  // an absolute, cwd-independent import path — matching the sibling
  // consumer-layout test's own stated purpose one block up.
  const LEGACY_AUDIT_MODULE_URL = new URL('../scripts/lib/audit/legacy-production-audit.mjs', import.meta.url).href;
  const runProbe = (allowTieredArg) => {
    const script = `
      import { buildAuditRunContext } from ${JSON.stringify(LEGACY_AUDIT_MODULE_URL)};
      const ctx = await buildAuditRunContext({ openai: { fake: true }, planContent: 'x', changedFiles: []${allowTieredArg ? ', allowTiered: true' : ''} });
      const p = ctx.providers;
      console.log(JSON.stringify({
        allowTiered: ctx.allowTiered === true,
        anthropic: p.anthropicClient !== null,
        oss: typeof p.ossCall === 'function',
        review: typeof p.geminiReviewCall === 'function',
        cleanRegion: typeof p.geminiCleanRegionCall === 'function',
      }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 60000,
      env: {
        ...process.env, AUDIT_LOOP_DISABLE_SHARED: '1',
        AUDIT_TIERED_SHADOW_ENABLED: 'true', AUDIT_TIERED_PIPELINE_ENABLED: 'false',
      },
    });
    return JSON.parse(out.trim().split('\n').pop());
  };

  test('shadow flag ON + no call-site opt → NO provider construction (tests stay hermetic)', () => {
    const r = runProbe(false);
    assert.equal(r.allowTiered, false);
    assert.equal(r.anthropic, false, 'anthropicClient must NOT be constructed without allowTiered');
    assert.equal(r.oss, false);
    assert.equal(r.review, false);
    assert.equal(r.cleanRegion, false);
  });

  test('shadow flag ON + allowTiered:true (the CLI entrypoint) → all handles constructed', () => {
    const r = runProbe(true);
    assert.equal(r.allowTiered, true);
    assert.equal(r.review, true, 'geminiReviewCall must be a function for an eligible call');
    assert.equal(r.cleanRegion, true);
  });

  // audit-code R1 fix M2: the two probes above only exercise
  // buildAuditRunContext in isolation — they never call
  // runMultiPassCodeAudit (openai-audit.mjs's actual CHOOSER), which is
  // where the real incident fired. A future edit that dropped
  // `&& ctx.allowTiered` from the chooser's own conditions would still
  // pass both probes above (the context builder's own gate would be
  // unaffected) while re-introducing the incident. Two independent checks
  // close that gap: (a) an end-to-end subprocess run through the REAL
  // chooser proving a no-opt call stays fast/legacy-only even with the
  // shadow flag forced on and no OSS/Anthropic/Gemini keys present (so any
  // wrongly-entered tiered/shadow path fails FAST on a missing key, never
  // hangs the suite for the full 20-minute default timeout); (b) a static
  // source assertion pinning the exact gate expressions, independent of
  // runtime behavior.
  test('end-to-end: runMultiPassCodeAudit (the real chooser) with no allowTiered opt stays legacy-only and fast, even with the shadow flag forced on', () => {
    const script = `
      process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
      const audit = await import(${JSON.stringify(new URL('../scripts/openai-audit.mjs', import.meta.url).href)});
      const { runMultiPassCodeAudit } = audit.__testExports;
      // Always-fail-gracefully stub — safeCallGPT degrades per-pass rather
      // than crashing, so this still lets the run COMPLETE; content is
      // irrelevant here, only "did it stay on the fast legacy path" matters.
      const stubOpenai = { responses: { parse: async () => { throw new Error('stub: no real calls expected'); } } };
      const start = Date.now();
      // Must reference a real, on-disk file — the legacy path's own
      // unrelated preflight guard refuses to run over zero resolved
      // implementation files, before this test's own gate is ever reached.
      const result = await runMultiPassCodeAudit(stubOpenai, '# plan\\n\\nImplement \`tests/fixtures/harness-plan/src/service.mjs\`.\\n', '', false, null, '', {
        passFilter: ['structure'], noTools: true, noDebtLedger: true, noLedger: true,
      });
      console.log(JSON.stringify({ elapsedMs: Date.now() - start, runStatus: result.runStatus ?? null }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 60000,
      env: {
        ...process.env, AUDIT_LOOP_DISABLE_SHARED: '1',
        AUDIT_TIERED_SHADOW_ENABLED: 'true', AUDIT_TIERED_PIPELINE_ENABLED: 'false',
        // If the fix ever regresses and a no-opt call wrongly reaches the
        // tiered/shadow path, missing keys make that fail in milliseconds
        // (a clear assertion failure below) instead of hanging for the
        // shadow's real 20-minute default timeout.
        OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '',
      },
    });
    const { elapsedMs } = JSON.parse(out.trim().split('\n').pop());
    assert.ok(elapsedMs < 10000, `expected a fast legacy-only completion, took ${elapsedMs}ms — the chooser likely routed into tiered/shadow`);
  });

  test('static pin: the chooser\'s tiered-pipeline AND shadow conditions both require ctx.allowTiered', () => {
    const src = fs.readFileSync(path.resolve('scripts/openai-audit.mjs'), 'utf8');
    assert.match(src, /tieredAuditConfig\.pipelineEnabled\s*&&\s*ctx\.allowTiered/, 'tiered-pipeline branch must require ctx.allowTiered');
    assert.match(src, /tieredAuditConfig\.shadowEnabled\s*&&\s*ctx\.allowTiered/, 'shadow-comparison branch must require ctx.allowTiered');
  });

  // 2026-07-14 incident: this handle is constructed with the AMBIENT
  // CLAUDE_BACKEND-resolved backend (`createAnthropicClient()`, no options),
  // which is `cli` locally. The cli backend silently drops `tools`/
  // `tool_choice` (anthropic-client.mjs's messages.create() only reads
  // {model, max_tokens, system, messages}), so discovery-portfolio.mjs's
  // Sonnet generator — which REQUIRES `tool_choice:{type:'tool',…}` to get
  // structured findings back — got plain text instead and failed its
  // `tool_use` check on every call. Both real repos' Close-out shadow
  // windows were 100% fallback_legacy as a result (confirmed via a live
  // probe, since `tieredFallbackReason` wasn't even persisted at the time).
  // A live end-to-end test would require real ANTHROPIC_API_KEY/CLAUDE_BIN
  // wiring in CI, so this is a static source pin — cheap and reliable
  // against someone reverting the `{ backend: 'sdk' }` override by accident.
  test('static pin: the tiered pipeline\'s anthropicClient forces backend:"sdk", never the ambient CLAUDE_BACKEND', () => {
    const src = fs.readFileSync(path.resolve('scripts/lib/audit/legacy-production-audit.mjs'), 'utf8');
    assert.match(
      src,
      /anthropicClient\s*=\s*await createAnthropicClient\(\s*\{\s*backend:\s*['"]sdk['"]\s*\}\s*\)/,
      'the tiered pipeline\'s Sonnet generator needs real tool_choice support — the cli backend silently drops it (2026-07-14 incident: 20/20 fallback_legacy)',
    );
  });
});

describe('discoveryCode assembly — secret-redaction default (discovery-portfolio-secret-redaction.md)', () => {
  // readFilesAsContext's default flipped to redact:true (scripts/lib/audit-scope.mjs)
  // so every caller EXCEPT the documented decision-11 opt-out (buildRedactedAuditContext)
  // inherits safe behaviour with zero code changes here. This is a static pin, not a
  // behavioural test (that coverage lives in tests/audit-scope-egress.test.mjs) — it
  // guards against a future edit silently re-introducing `redact: false` on this call
  // site, which would re-open the exact gap that suppressed 4 of the last 7
  // tiered-shadow observations in wine-cellar-app.
  test('static pin: the discoveryCode readFilesAsContext call does not pass redact:false', () => {
    const src = fs.readFileSync(path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf8');
    const callMatch = src.match(/const discoveryCode = readFilesAsContext\([^;]*\);/s);
    assert.ok(callMatch, 'expected to find the discoveryCode readFilesAsContext call');
    assert.equal(
      /redact\s*:\s*false/.test(callMatch[0]),
      false,
      'discoveryCode must inherit the safe redact:true default — do not opt out here',
    );
  });
});

describe('OSS-call reliability wiring (docs/plans/oss-call-reliability-hardening.md)', () => {
  const src = fs.readFileSync(path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf8');

  test('static pin: validatedTriagerCall passes operation: stage1_triage to providers.ossCall', () => {
    const fnMatch = src.match(/async function validatedTriagerCall[\s\S]*?\n}/);
    assert.ok(fnMatch, 'expected to find validatedTriagerCall');
    assert.match(fnMatch[0], /operation:\s*'stage1_triage'/);
  });

  test('static pin: glmCall passes operation: discovery_generation to providers.ossCall', () => {
    const glmMatch = src.match(/const glmCall = providers\.ossCall[\s\S]*?: async \(\) => \{ throw new Error\('discovery portfolio: providers\.ossCall unavailable'\); \};/);
    assert.ok(glmMatch, 'expected to find the glmCall assignment');
    assert.match(glmMatch[0], /operation:\s*'discovery_generation'/);
  });

  test('static pin: both adapters destructure category/error from ossCall and set err.category on throw', () => {
    const validatedMatch = src.match(/async function validatedTriagerCall[\s\S]*?\n}/)[0];
    assert.match(validatedMatch, /const \{ result, category, error \} = await providers\.ossCall/);
    assert.match(validatedMatch, /err\.category = category \?\? null/);

    const glmMatch = src.match(/const glmCall = providers\.ossCall[\s\S]*?: async \(\) => \{ throw new Error\('discovery portfolio: providers\.ossCall unavailable'\); \};/)[0];
    assert.match(glmMatch, /const \{ result, category, error \} = await providers\.ossCall/);
    assert.match(glmMatch, /err\.category = category \?\? null/);
  });

  test('static pin: failedNames embeds category into the fallback-reason string', () => {
    assert.match(src, /o\.category \? `\[\$\{o\.category\}\] ` : ''/);
  });

  test('static pin: the Stage-1 -> Stage-2 handoff (runFinalAdjudication input) never references budgetExhausted (round-2 H1 regression guard)', () => {
    const handoffMatch = src.match(/const stage2Result = await runFinalAdjudication\(\s*\{[^}]*\}/s);
    assert.ok(handoffMatch, 'expected to find the runFinalAdjudication call');
    assert.match(handoffMatch[0], /escalated:\s*triageResult\.escalated/);
    assert.equal(/budgetExhausted/.test(handoffMatch[0]), false, 'budgetExhausted must never be routed into Stage 2\'s workload');
  });

  test('static pin: runTieredAuditPipeline resolves BOTH the admission budget and the per-candidate worst-case duration before calling runStage1CheapTriage', () => {
    assert.match(src, /const stage1AdmissionBudgetMs = getStage1TriageBudget\(\)/);
    assert.match(src, /const stage1CandidateWorstCaseMs = calculateWorstCaseAttemptDuration\(getOssOperationPolicy\('stage1_triage'\)\)/);
    const callMatch = src.match(/const triageResult = await runStage1CheapTriage\([\s\S]*?\}\);/);
    assert.ok(callMatch, 'expected to find the runStage1CheapTriage call');
    assert.match(callMatch[0], /admissionBudgetMs:\s*stage1AdmissionBudgetMs/);
    assert.match(callMatch[0], /candidateWorstCaseMs:\s*stage1CandidateWorstCaseMs/);
  });

  test('static pin: the returned AuditRunResult carries typed _stage1BudgetExhausted/_stage1FailureCategories telemetry', () => {
    assert.match(src, /_stage1BudgetExhausted:\s*\{/);
    assert.match(src, /count:\s*triageResult\.skippedBudgetExhaustedCount/);
    assert.match(src, /_stage1FailureCategories:\s*triageResult\.failureCategories/);
  });
});

describe('buildAuditRunContext — commitSha/workingTreeDirty threading (docs/plans/stage0-evidence-relevance-split.md decision #5)', () => {
  test('commitSha/workingTreeDirty pass through unchanged when supplied', async () => {
    const ctx = await buildAuditRunContext({
      openai: { fake: true }, planContent: 'x', changedFiles: [],
      commitSha: 'abc1234', workingTreeDirty: true,
    });
    assert.equal(ctx.commitSha, 'abc1234');
    assert.equal(ctx.workingTreeDirty, true);
  });

  test('defaults to null/false when omitted (backward compatible with every pre-existing call site)', async () => {
    const ctx = await buildAuditRunContext({ openai: { fake: true }, planContent: 'x', changedFiles: [] });
    assert.equal(ctx.commitSha, null);
    assert.equal(ctx.workingTreeDirty, false);
  });
});

describe('static pins — Stage 0 relevance-split wiring (docs/plans/stage0-evidence-relevance-split.md)', () => {
  const src = fs.readFileSync(path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf8');

  test('the discovery generator schema is V2 (evidence-bearing), never V1 — Stage 0 cannot function without evidenceType/anchor', () => {
    assert.match(src, /import \{ ProducerFindingV2Schema, clampToJsonSchemaLimits \} from '\.\.\/schemas\.mjs'/);
    assert.match(src, /const glmStrictSchema = z\.object\(\{ findings: z\.array\(ProducerFindingV2Schema\)\.max\(15\) \}\)/);
    assert.match(src, /items:\s*z\.toJSONSchema\(ProducerFindingV2Schema\)/);
  });

  test('the Stage 0 stub adapters (() => null) are gone — real adapters are wired', () => {
    assert.equal(/blameAdapter:\s*\(\)\s*=>\s*null/.test(src), false, 'blameAdapter must no longer be the unconditional-null stub');
    assert.equal(/impactAdapter:\s*\(\)\s*=>\s*null/.test(src), false, 'impactAdapter must no longer be the unconditional-null stub');
    assert.match(src, /blameAdapter:\s*makeBlameAdapter\(/);
    assert.match(src, /impactAdapter:\s*makeImpactAdapter\(/);
    assert.match(src, /headContentAdapter:\s*makeHeadContentAdapter\(/);
  });

  // 4 buckets since evidence-anchor-path-contract §7a (2026-07-17): `malformed`
  // split out of `rejected`. The distinction is load-bearing, not cosmetic —
  // `rejected` means the model's evidence failed, `malformed` means OUR schema
  // couldn't parse the claim, and blending them made a 100%-schema-rejection
  // run read as 100% model hallucination (stage0Verified > 0 in 1 of 62 runs).
  // Pinned statically so a future refactor cannot silently drop the 4th bucket
  // on the floor — dropping it would restore the blend without any test going red.
  test('runStage0EvidenceTriage is called with the 4-bucket destructure (verified/preExistingIndependent/rejected/malformed)', () => {
    assert.match(src, /const \{ verified: stage0Verified, preExistingIndependent, rejected: stage0Rejected, malformed: stage0Malformed \} = runStage0EvidenceTriage\(/);
  });

  test('the malformed bucket reaches telemetry AND stderr — never counted silently', () => {
    assert.match(src, /stage0MalformedTripwire: stage0Malformed\.length/, 'must reach _stageBreakdown');
    assert.match(src, /CONTRACT BUG/, 'a contract bug must be loud on stderr, not just a counter');
  });

  test('debt-routing reconciliation and the routing manifest are wired before Stage 1', () => {
    assert.match(src, /routePreExistingIndependent\(preExistingIndependent, ctx\)/);
    assert.match(src, /const stage0EligibleForStage1 = \[\.\.\.stage0Verified, \.\.\.restoredFromDebtRouting\]/);
    assert.match(src, /const triageResult = await runStage1CheapTriage\(stage0EligibleForStage1,/);
  });

  test('AuditRunResult carries debtRoutedFiles/debtRoutingIncomplete (decision #9)', () => {
    assert.match(src, /debtRoutedFiles,\s*\n\s*debtRoutingIncomplete,/);
  });

  test('findings carry _originCandidateIds + resolveScopeBucketForFinding-derived scopeBucket (decision #8)', () => {
    assert.match(src, /_originCandidateIds:\s*\[env\.fingerprint\]/);
    assert.match(src, /scopeBucket:\s*resolveScopeBucketForFinding\(\[env\.fingerprint\], stage0RoutingManifest\)/);
  });
});

describe('runTieredAuditPipeline Stage 2 handle fail-fast', () => {
  const fn = async () => {};

  test('missing BOTH handles throws the configuration error before any provider work', async () => {
    await assert.rejects(
      () => runTieredAuditPipeline({ providers: {} }),
      /geminiReviewCall and .*geminiCleanRegionCall must both be functions/s,
    );
  });

  test('reviewCall alone is not enough (the old single-handle design)', async () => {
    await assert.rejects(
      () => runTieredAuditPipeline({ providers: { geminiReviewCall: fn } }),
      /must both be functions/,
    );
  });

  test('cleanRegionCall alone is not enough', async () => {
    await assert.rejects(
      () => runTieredAuditPipeline({ providers: { geminiCleanRegionCall: fn } }),
      /must both be functions/,
    );
  });
});

// ── The shadow must never fall back to a second legacy audit ──────────────
// docs/plans/shadow-no-legacy-fallback.md. Measured motivation: 41 of 57 live
// shadow records each ran a FULL extra 5-pass GPT audit and then compared
// legacy against legacy (their `overlap: 0` was GPT nondeterminism, not
// recall). The fallback is CORRECT for production (openai-audit.mjs:440 must
// return findings) and WRONG for the shadow — so it is gated, not deleted.
describe('shadow vs production fallback (docs/plans/shadow-no-legacy-fallback.md)', () => {
  // A ctx that reaches the requiredGeneratorFailed branch deterministically:
  // both required generators are unavailable (no ossCall, no anthropicClient),
  // so runDiscoveryPortfolio marks required-failure without any network call.
  const failingCtx = (over = {}) => ({
    planContent: 'p', changedFiles: [], diffText: '', generatorOutcomes: [],
    providers: {
      openai: null, ossCall: null, anthropicClient: null,
      geminiReviewCall: async () => ({ verdict: 'verified' }),
      geminiCleanRegionCall: async () => ({ verdict: 'clean' }),
    },
    ...over,
  });

  test('shadowMode: a required-generator failure THROWS TieredUnavailableError — no legacy audit', async () => {
    await assert.rejects(
      () => runTieredAuditPipeline(failingCtx({ shadowMode: true })),
      (err) => {
        assert.equal(err.name, 'TieredUnavailableError', 'must be the typed error, not a bare Error');
        assert.match(err.reason, /required generator failed/);
        // .reason is the clean formatted string the shadow's catch records.
        assert.equal(typeof err.reason, 'string');
        return true;
      },
    );
  });

  // The throw IS the behavioural half of the "legacy is never invoked" proof:
  // the `await import('./legacy-production-audit.mjs')` sits AFTER the
  // shadowMode branch inside the same block, so propagating the throw
  // structurally guarantees that line was never reached. There is no
  // injection seam to spy on (round-1 plan-audit M2) — the static pin below
  // is the other half, and it is what survives a refactor that hoists the
  // import above the branch.
  test('static pin: the legacy dynamic import lives INSIDE the non-shadow branch', () => {
    const src = fs.readFileSync(path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf8');
    const throwIdx = src.indexOf('if (ctx.shadowMode) throw new TieredUnavailableError(reason);');
    const importIdx = src.indexOf("await import('./legacy-production-audit.mjs')");
    assert.ok(throwIdx > 0, 'expected the shadowMode throw');
    assert.ok(importIdx > 0, 'expected the legacy dynamic import');
    assert.ok(
      throwIdx < importIdx,
      'the shadowMode throw MUST precede the legacy import — otherwise a shadow run would load/execute the legacy audit before the guard',
    );
  });

  // The production regression guard: without the flag, today's exact
  // behaviour must survive byte-for-byte. Production is the untouched
  // default; a caller that forgets the flag fails SAFE (falls back — costly
  // but correct, never a wrong result).
  test('NO shadowMode (production): still returns fallback_legacy, unchanged', async () => {
    // The legacy path is reached for real here; give it a stub openai whose
    // every call fails gracefully (safeCallGPT degrades per-pass), so the run
    // completes without network.
    const ctx = failingCtx({
      planContent: '# plan\n\nImplement `tests/fixtures/harness-plan/src/service.mjs`.\n',
      providers: {
        openai: { responses: { parse: async () => { throw new Error('stub'); } } },
        ossCall: null, anthropicClient: null,
        geminiReviewCall: async () => ({ verdict: 'verified' }),
        geminiCleanRegionCall: async () => ({ verdict: 'clean' }),
      },
      noLedger: true, noDebtLedger: true, noTools: true, noCloudRecording: true,
      passFilter: ['structure'],
    });
    const result = await runTieredAuditPipeline(ctx);
    assert.equal(result.runStatus, 'fallback_legacy', 'production MUST still fall back');
    assert.match(result.fallbackReason, /required generator failed/);
    assert.ok(Array.isArray(result.generatorOutcomes), 'the discovery attempt is still reported');
  });

  test('the reason string is identical in both modes — only the delivery differs', async () => {
    let shadowReason;
    await runTieredAuditPipeline(failingCtx({ shadowMode: true })).catch((e) => { shadowReason = e.reason; });
    assert.match(shadowReason, /^required generator failed: /);
    // Same prefix the production fallbackReason uses, so shadowFailureReasons
    // and tieredFallbackReasons stay mutually legible.
    assert.ok(shadowReason.includes('glm') || shadowReason.includes('sonnet'),
      'the failing generator must be named in the reason');
  });
});
