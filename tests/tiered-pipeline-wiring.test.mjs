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
import { runTieredAuditPipeline } from '../scripts/lib/audit/tiered-pipeline.mjs';
import { TieredUnavailableError } from '../scripts/lib/audit/discovery-fallback.mjs';
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

// Per-stage usage capture (2026-07-22 item 2b): the pipeline accumulated no
// usage, so `computeCostReport` got `usageEvents: []` and `_usage.costUsd` was
// a meaningless 0/null. These guards pin that real capture is wired at the
// source (the pipeline isn't hermetically runnable end-to-end — same reasoning
// as the diffText/adapter guards above).
//
// docs/plans/tiered-pipeline-refresh-god-module-decomposition.md: `buildUsageBlock`
// (the `computeCostReport`/`hasPricedUsage` wrapper) relocated into
// cost-budget.mjs, colocated with `computeCostReport` itself. The pipeline-side
// guard now pins that the orchestrator feeds its real accumulated `usageEvents`
// into `buildUsageBlock` (never a hardcoded `[]`); the pricing-honesty guard
// moved to where `hasPricedUsage`/`costUsd` are actually computed.
describe('per-stage usage capture wiring (static guards)', () => {
  const tieredSrc = () => fs.readFileSync(path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf-8');
  const costBudgetSrc = () => fs.readFileSync(path.resolve('scripts/lib/audit/cost-budget.mjs'), 'utf-8');
  const adjSrc = () => fs.readFileSync(path.resolve('scripts/lib/audit/final-adjudication.mjs'), 'utf-8');

  test('buildUsageBlock receives the accumulated usageEvents array, not a hardcoded []', () => {
    const src = tieredSrc();
    assert.match(src, /buildUsageBlock\(usageEvents\b/, 'usageEvents must be a variable fed into buildUsageBlock');
    assert.doesNotMatch(src, /buildUsageBlock\(\[\]/, 'the hardcoded empty-events call is the defect being fixed');
  });

  test('the pipeline captures via the fail-open tryBuildUsageEvent wrapper (never a raw buildUsageEvent that could throw mid-stage)', () => {
    assert.match(tieredSrc(), /tryBuildUsageEvent/, 'usage capture must be fail-open so a malformed usage object cannot abort the audit');
  });

  test('the Stage-2 subprocess adapters surface _usage/_model instead of stripping them', () => {
    const src = adjSrc();
    assert.match(src, /_usage/, 'reviewCall/cleanRegionCall must propagate the subprocess _usage the --out JSON already carries');
  });

  test('tiered cost is real when priced, honest-null when nothing could be priced — never a fabricated flat null', () => {
    const src = costBudgetSrc();
    // The last-session flat `costUsd: null` override on the MAIN return is gone;
    // cost now derives from whether any captured event was priced.
    assert.match(src, /costUsd:\s*hasPricedUsage\s*\?/, 'expected honest cost: real sum when priced, null when not');
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
  test('end-to-end: runMultiPassCodeAudit (the real chooser) with no allowTiered opt enters NEITHER route, even with both flags forced on', () => {
    // ROUTE EVIDENCE, NOT WALL CLOCK (2026-07-19).
    //
    // This assertion used to be `elapsedMs < 10000`. Timing is not the
    // contract, and this suite runs in parallel: measured 3896ms for this
    // file in isolation vs 15767ms under full-suite load — a ~4x
    // load-degradation that puts the threshold INSIDE the noise band, so it
    // failed a push on a green tree. (Same class as the vitest oversubscription
    // flake: import-heavy work under many parallel workers, where the clock
    // measures machine contention rather than behaviour.) Both routes now
    // assert on a positive marker of entry instead:
    //
    //   SHADOW branch — runTieredShadowComparison ALWAYS ends in
    //   recordObservation(), on both its paths, INCLUDING when the shadow
    //   pipeline itself fails on a missing key (it records shadowOk:false).
    //   recordObservation stamps each line with ctx.runId, so this probe
    //   passes a unique runId and asserts NO shadow-log line carries it.
    //
    //   The discriminator must be the runId, NOT the file's size or line
    //   count: .audit/tiered-shadow-log.jsonl is global mutable state and
    //   the suite runs in parallel, so a CONCURRENT test's legitimate
    //   allowTiered audit appends to the same file. A size-delta assertion
    //   passes in isolation and fails under load — which is the very class
    //   of bug this rewrite exists to remove, so don't reintroduce it.
    //
    //   PIPELINE branch — runTieredAuditPipeline fails fast and loudly when
    //   providers.geminiReviewCall / geminiCleanRegionCall are absent, and
    //   without allowTiered buildAuditRunContext never constructs them. So a
    //   regressed gate throws inside the subprocess → non-zero exit →
    //   execFileSync throws → this test fails with that error, not a timeout.
    //
    // Both flags are now pinned ON (the old probe pinned pipeline OFF, which
    // made the pipeline gate unreachable at runtime and left it covered only
    // by the static pin below). Pinning both explicitly keeps the isolation
    // the R1-M1 note asked for while actually exercising both conditions.
    //
    // The execFileSync `timeout` below stays, but it is a HANG guard, not an
    // assertion — a wrongly-entered route must not stall the suite for the
    // shadow's 20-minute default. Nothing asserts on how long this takes.
    const shadowLog = path.resolve('.audit', 'tiered-shadow-log.jsonl');
    const probeRunId = `route-probe-${process.pid}-${Date.now()}`;
    const script = `
      process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
      const audit = await import(${JSON.stringify(new URL('../scripts/openai-audit.mjs', import.meta.url).href)});
      const { runMultiPassCodeAudit } = audit.__testExports;
      // Always-fail-gracefully stub — safeCallGPT degrades per-pass rather
      // than crashing, so this still lets the run COMPLETE; content is
      // irrelevant here, only "did it stay on the fast legacy path" matters.
      const stubOpenai = { responses: { parse: async () => { throw new Error('stub: no real calls expected'); } } };
      // Must reference a real, on-disk file — the legacy path's own
      // unrelated preflight guard refuses to run over zero resolved
      // implementation files, before this test's own gate is ever reached.
      const result = await runMultiPassCodeAudit(stubOpenai, '# plan\\n\\nImplement \`tests/fixtures/harness-plan/src/service.mjs\`.\\n', '', false, null, '', {
        passFilter: ['structure'], noTools: true, noDebtLedger: true, noLedger: true,
        runId: ${JSON.stringify(probeRunId)},
      });
      // Proves the legacy path actually COMPLETED — without this the route
      // assertions could pass vacuously on a run that returned nothing.
      console.log(JSON.stringify({ completed: result !== null && typeof result === 'object' }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 60000,
      env: {
        ...process.env, AUDIT_LOOP_DISABLE_SHARED: '1',
        AUDIT_TIERED_SHADOW_ENABLED: 'true', AUDIT_TIERED_PIPELINE_ENABLED: 'true',
        // If the fix ever regresses and a no-opt call wrongly reaches the
        // tiered/shadow path, missing keys make that fail in milliseconds
        // instead of hanging for the shadow's real 20-minute default timeout.
        OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '',
      },
    });
    const { completed } = JSON.parse(out.trim().split('\n').pop());
    assert.equal(completed, true, 'the legacy path must have run to completion (guards against a vacuous pass)');

    const shadowLines = fs.existsSync(shadowLog)
      ? fs.readFileSync(shadowLog, 'utf8').split('\n').filter(Boolean)
      : [];
    const ourObservations = shadowLines.filter((line) => line.includes(probeRunId));
    assert.equal(
      ourObservations.length, 0,
      `the shadow route was entered: ${ourObservations.length} observation(s) in ${shadowLog} ` +
      `carry this probe's runId (${probeRunId}). runTieredShadowComparison records an observation ` +
      'on every path, so a line stamped with our runId means the chooser ran the shadow for a call ' +
      `that never passed allowTiered. First: ${ourObservations[0] ?? '(none)'}`,
    );
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
  // docs/plans/tiered-pipeline-refresh-god-module-decomposition.md: provider
  // invocation (validatedTriagerCall/createGlmDiscoveryCall) relocated to
  // tiered-provider-calls.mjs; the glmResponseValidationSchema construction
  // relocated to discovery-prompts.mjs. Stage sequencing (failedNames, the
  // Stage1->Stage2 handoff, the admission-budget resolution, the returned
  // telemetry) stays inline in the orchestrator.
  const tieredSrc = fs.readFileSync(path.resolve('scripts/lib/audit/tiered-pipeline.mjs'), 'utf8');
  const providerCallsSrc = fs.readFileSync(path.resolve('scripts/lib/audit/tiered-provider-calls.mjs'), 'utf8');
  const discoveryPromptsSrc = fs.readFileSync(path.resolve('scripts/lib/audit/discovery-prompts.mjs'), 'utf8');

  test('static pin: validatedTriagerCall passes operation: stage1_triage to providers.ossCall', () => {
    const fnMatch = providerCallsSrc.match(/export async function validatedTriagerCall[\s\S]*?\n}/);
    assert.ok(fnMatch, 'expected to find validatedTriagerCall');
    assert.match(fnMatch[0], /operation:\s*'stage1_triage'/);
  });

  test('static pin: createGlmDiscoveryCall passes operation: discovery_generation to providers.ossCall', () => {
    const glmMatch = providerCallsSrc.match(/export function createGlmDiscoveryCall\([\s\S]*?\n}\n/);
    assert.ok(glmMatch, 'expected to find the createGlmDiscoveryCall factory');
    assert.match(glmMatch[0], /operation:\s*'discovery_generation'/);
  });

  test('static pin: both adapters destructure category/error from ossCall and set err.category on throw', () => {
    const validatedMatch = providerCallsSrc.match(/export async function validatedTriagerCall[\s\S]*?\n}/)[0];
    // `usage` was added to the destructure for per-stage cost capture (2026-07-22);
    // category/error must still be destructured and threaded into err.category.
    assert.match(validatedMatch, /const \{ result, category, error, usage \} = await providers\.ossCall/);
    assert.match(validatedMatch, /err\.category = category \?\? null/);

    const glmMatch = providerCallsSrc.match(/export function createGlmDiscoveryCall\([\s\S]*?\n}\n/)[0];
    assert.match(glmMatch, /const \{ result, category, error, usage \} = await providers\.ossCall/);
    assert.match(glmMatch, /err\.category = category \?\? null/);
  });

  test('static pin: failedNames embeds category into the fallback-reason string', () => {
    assert.match(tieredSrc, /o\.category \? `\[\$\{o\.category\}\] ` : ''/);
  });

  test('static pin: the Stage-1 -> Stage-2 handoff (runFinalAdjudication input) never references budgetExhausted (round-2 H1 regression guard)', () => {
    const handoffMatch = tieredSrc.match(/const stage2Result = await runFinalAdjudication\(\s*\{[^}]*\}/s);
    assert.ok(handoffMatch, 'expected to find the runFinalAdjudication call');
    assert.match(handoffMatch[0], /escalated:\s*triageResult\.escalated/);
    assert.equal(/budgetExhausted/.test(handoffMatch[0]), false, 'budgetExhausted must never be routed into Stage 2\'s workload');
  });

  test('static pin: runTieredAuditPipeline resolves BOTH the admission budget and the per-candidate worst-case duration before calling runStage1CheapTriage', () => {
    assert.match(tieredSrc, /const stage1AdmissionBudgetMs = getStage1TriageBudget\(\)/);
    assert.match(tieredSrc, /const stage1CandidateWorstCaseMs = calculateWorstCaseAttemptDuration\(getOssOperationPolicy\('stage1_triage'\)\)/);
    const callMatch = tieredSrc.match(/const triageResult = await runStage1CheapTriage\([\s\S]*?\}\);/);
    assert.ok(callMatch, 'expected to find the runStage1CheapTriage call');
    assert.match(callMatch[0], /admissionBudgetMs:\s*stage1AdmissionBudgetMs/);
    assert.match(callMatch[0], /candidateWorstCaseMs:\s*stage1CandidateWorstCaseMs/);
  });

  test('static pin: the returned AuditRunResult carries typed _stage1BudgetExhausted/_stage1FailureCategories telemetry', () => {
    assert.match(tieredSrc, /_stage1BudgetExhausted:\s*\{/);
    assert.match(tieredSrc, /count:\s*triageResult\.skippedBudgetExhaustedCount/);
    assert.match(tieredSrc, /_stage1FailureCategories:\s*triageResult\.failureCategories/);
  });

  test('static pin: createGlmDiscoveryCall passes a lenient responseSchema, decoupled from the provider-guidance schema', () => {
    const glmMatch = providerCallsSrc.match(/export function createGlmDiscoveryCall\([\s\S]*?\n}\n/);
    assert.ok(glmMatch, 'expected to find the createGlmDiscoveryCall factory');
    assert.match(glmMatch[0], /responseSchema:\s*contract\.glmResponseValidationSchema/, 'createGlmDiscoveryCall must validate the reply leniently, never via the strict per-item schema');
    assert.match(glmMatch[0], /schema:\s*contract\.glmLenientSchema/, 'the provider-facing JSON Schema must still derive from the strict-shaped schema (unaffected)');
    assert.match(discoveryPromptsSrc, /const glmResponseValidationSchema = z\.preprocess\(/);
    assert.match(discoveryPromptsSrc, /z\.object\(\{ findings: z\.array\(z\.unknown\(\)\)\.max\(15\) \}\)/, 'per-item shape must be left entirely to prepareCandidates downstream');
  });
});

// ── Discovery batch-abort hardening (2026-07-22, systematic follow-up to the
// Stage-1 clamp fix) ─────────────────────────────────────────────────────────
// `glmStrictSchema = z.object({findings: z.array(producerFindingSchema).max(15)})`
// used to ALSO validate the OSS response inside ossStructuredCall — and zod
// array validation is all-or-nothing, so ONE malformed finding among several
// good ones failed the WHOLE response, `glmCall` threw, GLM (a required
// generator) reported `failed`, and `requiredGeneratorFailed` fell the ENTIRE
// tiered run back to legacy (or aborted the shadow) over a single bad
// candidate. This end-to-end test drives `runTieredAuditPipeline` with a
// `providers.ossCall` stub that reproduces ossStructuredCall's own validation
// contract (`(opts.responseSchema ?? opts.schema).safeParse(...)`) — so this
// test regresses to red if the fix's `responseSchema` wiring is ever dropped
// from `glmCall`, without needing the real network-calling ossStructuredCall.
describe('discovery batch-abort hardening — one malformed GLM finding must not abort the run', () => {
  const REAL_DIFF = 'diff --git a/src/x.js b/src/x.js\nindex 111..222 100644\n--- a/src/x.js\n+++ b/src/x.js\n@@ -1 +1 @@\n-old\n+new\n';

  const classification = { sonarType: 'BUG', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'glm-test' };
  const baseFinding = {
    id: 'H1', category: 'Test Category', section: 'src/x.js', detail: 'a real defect',
    risk: 'something breaks', recommendation: 'fix it', is_quick_fix: false, is_mechanical: false,
    principle: 'correctness', classification,
  };
  // A genuinely well-formed V3 commission finding citing the diff-path map's
  // first (only) entry, 'f0001'.
  const goodFinding = {
    ...baseFinding, severity: 'MEDIUM', evidenceType: 'commission',
    anchor: { diffPathId: 'f0001', side: 'head', startLine: 1, endLine: 1, quote: 'new', symbolName: null },
  };
  // Malformed in a way length-clamping cannot fix: an invalid severity enum
  // value — must be rejected by prepareCandidates's per-item safeParse
  // (bucketed as malformed), never by the OSS response's own envelope check.
  const malformedFinding = { ...goodFinding, id: 'H2', severity: 'CRITICAL_NOT_A_REAL_ENUM_VALUE' };

  // Reproduces ossStructuredCall's real validation contract for both GLM and
  // (if ever exercised) any other array-batch caller: JSON round-trips the
  // payload, then validates with `responseSchema ?? schema` exactly as the
  // real implementation does — so this test is a faithful proxy for the real
  // provider boundary, not a hand-waved stub.
  function makeOssCallStub(payload) {
    return async (opts) => {
      const parsed = JSON.parse(JSON.stringify(payload));
      const validationSchema = opts.responseSchema ?? opts.schema;
      const validated = validationSchema.safeParse(parsed);
      if (!validated.success) {
        return { result: null, category: null, error: 'schema validation failed', usage: { input_tokens: 1, output_tokens: 1 } };
      }
      return { result: validated.data, category: null, error: null, usage: { input_tokens: 1, output_tokens: 1 } };
    };
  }

  const emptySonnetToolUse = {
    content: [{ type: 'tool_use', name: 'report_findings', input: { findings: [] } }],
  };

  function makeCtx(ossCall, over = {}) {
    return {
      planContent: 'p', changedFiles: ['src/x.js'], diffText: REAL_DIFF, generatorOutcomes: [],
      providers: {
        openai: null, // Stage 1's default GPT triager degrades to `escalated` per-candidate without one — never fatal.
        ossCall,
        anthropicClient: { messages: { create: async () => emptySonnetToolUse } },
        geminiReviewCall: async () => ({ verdict: 'confirmed' }),
        geminiCleanRegionCall: async () => ({ verdict: 'clean' }),
      },
      noLedger: true, noDebtLedger: true,
      ...over,
    };
  }

  test('regression baseline: a strict-schema-only ossCall stub reproduces the bug (requiredGeneratorFailed -> TieredUnavailableError)', async () => {
    // Bypasses the fix entirely by ignoring opts.responseSchema — proves the
    // TEST HARNESS itself would have caught the original defect. shadowMode
    // is used here (rather than asserting on the real legacy fallback) so
    // this test doesn't need a plan referencing real on-disk implementation
    // files — matching the existing "shadow vs production fallback" suite's
    // own pattern one describe block up; production's fallback_legacy
    // behavior for this same failure is already covered there.
    const strictOnlyOssCall = async (opts) => {
      const parsed = JSON.parse(JSON.stringify({ findings: [goodFinding, malformedFinding] }));
      const validated = opts.schema.safeParse(parsed);
      return validated.success
        ? { result: validated.data, category: null, error: null, usage: { input_tokens: 1, output_tokens: 1 } }
        : { result: null, category: null, error: 'schema validation failed', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    await assert.rejects(
      () => runTieredAuditPipeline(makeCtx(strictOnlyOssCall, { shadowMode: true })),
      (err) => {
        assert.equal(err.name, 'TieredUnavailableError', 'without the fix, one malformed finding must (still) abort the whole tiered run — this is the bug, reproduced');
        return true;
      },
    );
  });

  test('the fix: one malformed finding among several good ones does NOT abort the run', async () => {
    const result = await runTieredAuditPipeline(makeCtx(makeOssCallStub({ findings: [goodFinding, malformedFinding] })));
    assert.notEqual(result.runStatus, 'fallback_legacy', 'a single malformed candidate must never fall the whole tiered run back to legacy');
    assert.equal(result.generatorOutcomes.find((o) => o.model === 'glm')?.status, 'succeeded', 'GLM must be recorded as succeeded — it produced findings, one of which degrades itself downstream');
  });

  test('the malformed finding is still caught — just at prepareCandidates, scoped to itself, not the batch', async () => {
    const result = await runTieredAuditPipeline(makeCtx(makeOssCallStub({ findings: [goodFinding, malformedFinding] })));
    assert.equal(result._stageBreakdown.discoveryRawFindings, 2, 'both raw findings must have reached the producer boundary');
    assert.equal(result._stageBreakdown.discoveryMalformedRaw, 1, 'exactly the ONE malformed finding must be caught — scoped to itself');
  });

  test('the good finding survives end-to-end (proves this is not silently dropping BOTH findings)', async () => {
    const result = await runTieredAuditPipeline(makeCtx(makeOssCallStub({ findings: [goodFinding, malformedFinding] })));
    assert.ok(result.findings.length >= 1, 'the well-formed finding must survive the pipeline');
  });

  test('a genuinely broken envelope (GLM returns something that is not {findings: [...]} at all) still correctly fails the whole call', async () => {
    // The responseSchema loosens PER-ITEM shape only — the envelope contract
    // (findings must be an array) is still enforced, so a truly broken
    // response is still a real required-generator failure, not silently
    // accepted as zero findings. shadowMode, same reasoning as the baseline
    // test above.
    await assert.rejects(
      () => runTieredAuditPipeline(makeCtx(makeOssCallStub({ findings: 'not an array at all' }), { shadowMode: true })),
      (err) => {
        assert.equal(err.name, 'TieredUnavailableError', 'a broken envelope (not per-item malformed) is a genuine required-generator failure');
        return true;
      },
    );
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
  // The producer schema/contract construction relocated to discovery-prompts.mjs
  // (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
  const discoveryPromptsSrc = fs.readFileSync(path.resolve('scripts/lib/audit/discovery-prompts.mjs'), 'utf8');

  // RETARGETED V2 → V3 (evidence-anchor-path-contract Phase 6). The original
  // pin's SUBJECT survives unchanged: the discovery schema must be
  // evidence-bearing, never V1 — Stage 0 cannot function without
  // evidenceType/anchor, and V1 silently stripped both. V3 keeps that property
  // and adds the one V2 lacked: it is actually ENFORCEABLE by the provider
  // (V2's rules lived in superRefine, which z.toJSONSchema drops silently, so
  // "the provider validates it" was always false). Pinning V2 now would pin the
  // defect.
  test('the discovery generator schema is V3 (evidence-bearing AND provider-enforceable), never V1/V2', () => {
    assert.match(discoveryPromptsSrc, /import \{ makeProducerFindingV3Schema, clampToJsonSchemaLimits \} from '\.\.\/schemas\.mjs'/);
    assert.match(discoveryPromptsSrc, /const glmStrictSchema = z\.object\(\{ findings: z\.array\(producerFindingSchema\)\.max\(15\) \}\)/);
    assert.match(discoveryPromptsSrc, /items:\s*z\.toJSONSchema\(producerFindingSchema\)/);
    assert.equal(/ProducerFindingV2Schema/.test(discoveryPromptsSrc.replace(/^\s*\/\/.*$/gm, '')), false,
      'V2 must no longer reach a provider from this module — its superRefine is the bug class');
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
  //
  // diffText was `''` until evidence-anchor-path-contract Phase 6. It must now
  // be a REAL diff: an empty one yields `{kind:'empty'}`, which by design skips
  // both generators and returns `skipped_no_eligible_files` BEFORE discovery
  // ever runs — so these tests would silently stop exercising the
  // required-generator-failure path they exist to pin. A one-file diff is the
  // minimum that makes the map `ready`.
  const REAL_DIFF = 'diff --git a/x.js b/x.js\nindex 111..222 100644\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new\n';
  const failingCtx = (over = {}) => ({
    planContent: 'p', changedFiles: [], diffText: REAL_DIFF, generatorOutcomes: [],
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
    // failRequiredGenerator relocated to discovery-fallback.mjs
    // (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
    const src = fs.readFileSync(path.resolve('scripts/lib/audit/discovery-fallback.mjs'), 'utf8');
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

  // ── The anti-green rule, behaviourally (evidence-anchor-path-contract §7j) ──
  // "The test that would have caught this on day one": a run that verified
  // NOTHING must never summarise as a clean 0-finding `complete` run.
  // summarize()'s decision-grade filter is `tieredRunStatus === 'complete'`, so
  // a wrong status here silently re-poisons the Phase-14 denominator — which is
  // exactly how 62 vacuous runs read as a met window.
  test('empty scope: BOTH generators skipped, named status, never `complete`', async () => {
    // Providers that would THROW if called — the strongest available proof that
    // no provider call happens, since there is no other injection seam.
    const ctx = failingCtx({
      diffText: '',
      providers: {
        openai: null,
        ossCall: () => { throw new Error('ossCall must never be reached for an empty map'); },
        anthropicClient: { messages: { create: () => { throw new Error('sonnet must never be reached for an empty map'); } } },
        geminiReviewCall: async () => ({ verdict: 'verified' }),
        geminiCleanRegionCall: async () => ({ verdict: 'clean' }),
      },
    });
    const result = await runTieredAuditPipeline(ctx);
    assert.equal(result.runStatus, 'skipped_no_eligible_files');
    assert.notEqual(result.runStatus, 'complete', 'a run that called no generator is NOT a clean zero-findings run');
    assert.deepEqual(result.findings, []);
    assert.match(result.fallbackReason, /no_eligible_diff_files/);
    assert.equal(result.verdict, 'INCOMPLETE');
    // The zeros must be attributable: `discoveryRawFindings: 0` here means
    // "nothing ran", not "nothing found" — the status is what tells them apart.
    assert.equal(result._stageBreakdown.discoveryRawFindings, 0);
    assert.equal(result._stageBreakdown.discoveryMalformedRaw, 0);
    assert.match(result._stageBreakdown.diffPathMapStatus, /^empty:/);
  });

  test('invalid diff input: its OWN status, never conflated with an empty scope', async () => {
    // §7j/H5: collapsing these would let a broken input read as an ordinary
    // no-op. `invalid` is attributed to OUR bug; `empty` to neither.
    const result = await runTieredAuditPipeline(failingCtx({ diffText: 'this is not a diff at all\njust prose\n' }));
    assert.equal(result.runStatus, 'failed_invalid_diff_input');
    assert.match(result.fallbackReason, /malformed_diff_header/);
    assert.match(result._stageBreakdown.diffPathMapStatus, /^invalid:/);
  });

  test('a shadow run reports empty/invalid as a RESULT, not a TieredUnavailableError', async () => {
    // Distinct from a required-generator failure: the pipeline did not fail, it
    // correctly declined to run. §7j gives it its own reason bucket in
    // comparedRuns rather than the shadow's {ok:false} error channel.
    const result = await runTieredAuditPipeline(failingCtx({ diffText: '', shadowMode: true }));
    assert.equal(result.runStatus, 'skipped_no_eligible_files');
  });

  test('over-budget map: a named required-generator failure that falls back, never a truncated success', async () => {
    // §8a: truncation would make real changed files unauditable while reporting
    // success — the anti-green class again. It reuses §1.5's existing semantics,
    // so production falls back and the shadow throws, exactly like any other
    // required-generator failure.
    const many = Array.from({ length: 400 }, (_, i) =>
      `diff --git a/src/f${i}.js b/src/f${i}.js\nindex 1..2 100644\n--- a/src/f${i}.js\n+++ b/src/f${i}.js\n@@ -1 +1 @@\n-a\n+b\n`).join('');
    await assert.rejects(
      () => runTieredAuditPipeline(failingCtx({ diffText: many, shadowMode: true })),
      (err) => {
        assert.equal(err.name, 'TieredUnavailableError');
        assert.match(err.reason, /^required generator failed: /);
        assert.match(err.reason, /discovery_map_exceeds_budget/);
        assert.match(err.reason, /not truncated/);
        return true;
      },
    );
  });
});

// ── runStatus emissions ⊆ the declared enum (adjudicated 2026-07-17) ─────────
// The §7j statuses were emitted for a day while the schema's closed enum
// lacked them — a declared contract diverging from what the system actually
// produces, i.e. the exact bug class evidence-anchor-path-contract fixed at
// the provider seam, reproduced at our own seam. The adjudication (see the
// enum's comment in schemas.mjs) extended the enum; this scan is what makes
// the divergence class mechanical instead of memorial: ANY string literal
// assigned to or compared against `runStatus` anywhere in scripts/ must be a
// declared member, or a producer and a consumer are speaking different
// vocabularies with no error anywhere.
describe('runStatus emissions ⊆ AuditRunResultSchema enum (declared = actual)', () => {
  test('every runStatus literal in scripts/ is a declared enum member', async () => {
    const { fileURLToPath } = await import('node:url');
    const { AuditRunResultSchema } = await import('../scripts/lib/schemas.mjs');
    const rs = (AuditRunResultSchema.shape ?? AuditRunResultSchema._def.shape).runStatus;
    const members = new Set(Object.keys(rs._def.entries ?? rs._def.values ?? {}));
    assert.ok(members.has('complete') && members.has('skipped_no_eligible_files'), 'sanity: enum readable');

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
        else if (e.name.endsWith('.mjs')) files.push(p);
      }
    })(root);

    // Three shapes, deliberately narrow (a bare "any literal on a runStatus
    // line" scan false-positives on map.kind's 'empty' in the ternary):
    //   runStatus: 'x'         — property emission
    //   runStatus ===/!== 'x'  — consumer comparison (a non-member here is dead code)
    //   runStatus = … ? 'x' : 'y' — the conditional assignment shape
    const PATTERNS = [
      /\brunStatus: '([a-z_]+)'/g,
      /\brunStatus [!=]== '([a-z_]+)'/g,
      /\brunStatus = [^;\n]*\? '([a-z_]+)' : '([a-z_]+)'/g,
    ];
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      for (const re of PATTERNS) {
        for (const m of src.matchAll(re)) {
          for (const lit of m.slice(1).filter(Boolean)) {
            if (!members.has(lit)) offenders.push(`${path.relative(root, file)}: '${lit}'`);
          }
        }
      }
    }
    assert.deepEqual(offenders, [],
      'a runStatus literal is not in the declared enum — either the emission is a typo, '
      + 'or the enum must be extended WITH an adjudication note (see schemas.mjs runStatus)');
  });
});
