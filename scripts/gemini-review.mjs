#!/usr/bin/env node
/**
 * @fileoverview Independent final reviewer for the audit loop.
 *
 * This script provides an unbiased third-model perspective after Claude (author)
 * and GPT (auditor) have converged. The default reviewer is Gemini whenever
 * GEMINI_API_KEY is present; otherwise an active Azure profile (Foundry Opus),
 * else public Claude Opus. The default is overridable per-repo via the
 * FINAL_REVIEW_PROVIDER setting (see `set-provider`) or per-invocation via
 * --provider. See selectProvider() for the full precedence.
 *
 * Usage:
 *   node scripts/gemini-review.mjs review <plan-file> <transcript-file>         # Full review
 *   node scripts/gemini-review.mjs review <plan-file> <transcript-file> --json   # JSON output
 *   node scripts/gemini-review.mjs review <plan-file> <transcript-file> --out <file>  # File output
 *   node scripts/gemini-review.mjs set-provider <gemini|azure-claude|anthropic|openai-compatible|openrouter|default>  # Persist the per-repo reviewer
 *   node scripts/gemini-review.mjs ping                                          # Verify API connectivity
 *
 * Requires: GEMINI_API_KEY or ANTHROPIC_API_KEY in .env or environment
 *
 * @module scripts/gemini-review
 */

// dotenv loaded by lib/config.mjs (worktree-safe discovery)
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { z } from 'zod';
import { buildClassificationRubric } from './lib/prompt-seeds.mjs';
import { readFileOrDie, extractPlanPaths, writeOutput, isAuditInfraFile, atomicWriteFileSync } from './lib/file-io.mjs';
import { formatFindings } from './lib/findings.mjs';
import { readProjectContext, initAuditBrief } from './lib/context.mjs';
import { azureConfig, finalReviewConfig, auditShadowConfig } from './lib/config.mjs';
import { describeAzureRoute, describeTransportFailure } from './lib/azure-route-report.mjs';
import { SHADOW_PROVIDER_SPECS, shadowModelMatchesFamily } from './lib/final-review/provider-specs.mjs';
import { createOpenAIClient } from './lib/openai-client.mjs';
import { createAnthropicClient } from './lib/anthropic-client.mjs';
import { getRepoContext } from './lib/repo-context.mjs';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';
import { RUN_ID_RE } from './lib/commit-trailers.mjs';
import { GATE_EVIDENCE_RELPATH } from './lib/audit/gate-evidence.mjs';
import { isRefuted } from './lib/audit/finding-verification.mjs';
import { isCloudEnabled } from './lib/store/repo.mjs';
import { statSync } from 'node:fs';
import { resolveAndClassify, classifyPath } from './lib/sensitive-paths.mjs';
import { redactSecretsWithCount } from './lib/sensitive-egress-gate.mjs';
import {
  isReducedScope, isNonBlindScope, selectInScopeCodeFiles,
} from './lib/final-review/scope.mjs';
import { buildReviewEnvelope } from './lib/final-review/envelope.mjs';
import { serializePrimaryForGap } from './lib/final-review/gap-projection.mjs';
import { summariseCodeCoverage, applyCoverageGate } from './lib/final-review/code-coverage.mjs';
import { makeTieredCodeRenderer } from './lib/final-review/code-render.mjs';
// NOTE: lib/llm-wrappers.mjs provides shared wrappers for learning/refinement/evolution paths.
// This subsystem keeps the specialized `callReviewer` seam (lib/final-review/transport.mjs;
// thinkingConfig + one abort-correct timeout across all transports) because the final
// review requires high-budget reasoning and precise, background-safe timeout/termination
// handling.

// ── Terminal lifecycle (background-safe termination) ─────────────────────────
//
// The success path used to RETURN from main() and rely on natural event-loop
// drain, so a lingering LLM-SDK keep-alive socket blocked exit — invisible
// foreground (the harness reaps on its own timeout) but an indefinite hang in a
// detached background run (no reaper). These three primitives guarantee the CLI
// always terminates:
//   - `_terminalState` makes `finishAndExit` idempotent (running → finishing →
//     exited), so a watchdog racing a successful emit can never replace a clean
//     exit with 124.
//   - `_watchdogTimer` is the process-level hard deadline; NOT unref'd (it must
//     preempt a wedged await — timers still fire while a socket read is pending).
//   - `_activeReviewController` lets the watchdog abort the in-flight review
//     (releasing the socket) BEFORE it force-exits, so 124 is a real teardown.
let _terminalState = 'running';
let _watchdogTimer = null;
let _activeReviewController = null;

/**
 * The single terminal exit for the review CLI (real, fixture, and catch paths
 * all route through it). Idempotent; awaits a bounded, EPIPE-safe stdout drain
 * before exiting. Exit safety does NOT depend on the drain — with `--out` the
 * artifact is already written synchronously; the drain only avoids truncating
 * the one-line stdout summary on a slow pipe.
 * @param {number} code
 */
async function finishAndExit(code) {
  if (_terminalState !== 'running') return; // idempotent — second caller (e.g. watchdog) no-ops
  _terminalState = 'finishing';
  if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
  try {
    if (process.stdout.writableLength > 0) {
      // Race the real 'drain' against a short cap so a wedged/closed pipe can
      // never re-introduce the hang this whole change exists to remove.
      let capTimer;
      const cap = new Promise((r) => { capTimer = setTimeout(r, 2000); });
      await Promise.race([once(process.stdout, 'drain'), cap]);
      clearTimeout(capTimer);
    }
  } catch { /* EPIPE / stream error — proceed straight to exit */ }
  _terminalState = 'exited';
  process.exit(code);
}

/**
 * Arm the hard-deadline watchdog for review mode. On fire: abort the in-flight
 * review first (release the socket), then route through the same idempotent
 * finishAndExit(124). Deliberately not unref'd.
 */
function armReviewWatchdog() {
  _watchdogTimer = setTimeout(() => {
    process.stderr.write(
      `  [final-review] hard deadline ${(finalReviewConfig.hardDeadlineMs / 1000).toFixed(0)}s exceeded ` +
      `— aborting in-flight review and exiting 124\n`,
    );
    try { _activeReviewController?.abort('hard-deadline'); } catch { /* ignore */ }
    void finishAndExit(124);
  }, finalReviewConfig.hardDeadlineMs);
}

// ── Schemas (relocated to lib/final-review/output-schemas.mjs) ─────────────────
// Pure relocation (docs/plans/gemini-review-decomposition.md Phase 1) —
// GeminiFinalReviewSchema + ANTHROPIC_REVIEW_TOOL_NAME keep being re-exported
// at the top level here (test-import contract); AnthropicReviewToolSchema
// keeps flowing through the existing _internals object below.
export {
  GeminiFinalReviewSchema,
  ANTHROPIC_REVIEW_TOOL_NAME,
} from './lib/final-review/output-schemas.mjs';
import {
  GeminiFinalReviewSchema,
  GeminiFinalReviewJsonSchema,
  OpenAiFinalReviewJsonSchema,
  AnthropicReviewToolSchema,
} from './lib/final-review/output-schemas.mjs';

// ── System Prompt (relocated to lib/final-review/prompts.mjs) ──────────────────
import {
  getReviewPrompt,
  setRoleAddendum,
  PLAN_MODE_BLOCK,
  ADJUDICATOR_ONLY_ADDENDUM,
} from './lib/final-review/prompts.mjs';

// ── Unified reviewer call seam (relocated to lib/final-review/transport.mjs) ───
// Pure relocation (Phase 2). ANTHROPIC_MIN_CACHEABLE_TOKENS keeps being
// re-exported at the top level (widened General rule — every symbol this
// file exported before the move keeps being exported after it).
export { ANTHROPIC_MIN_CACHEABLE_TOKENS } from './lib/final-review/transport.mjs';
import {
  callReviewer,
  streamAnthropicMessage,
  REVIEW_TRANSPORTS,
  GEMINI_THINKING_BUDGET_BY_EFFORT,
} from './lib/final-review/transport.mjs';

// ── Provider descriptor catalog (relocated to lib/final-review/providers.mjs) ──
// Pure relocation (Phase 2). selectProvider / applyProviderSetting /
// SETTING_PROVIDERS keep being re-exported at the top level (test-import
// contract — see the plan's widened General rule); PROVIDERS /
// resolveCompatCreds / resolveOpenRouterCreds keep flowing through the
// existing _internals object below.
export {
  selectProvider,
  applyProviderSetting,
  SETTING_PROVIDERS,
} from './lib/final-review/providers.mjs';
import {
  PROVIDERS,
  resolveCompatCreds,
  resolveOpenRouterCreds,
  selectProvider,
  resolveProviderSetting,
  applyProviderSetting,
  runSetProvider,
  buildClient,
  refreshProviderModels,
  MODEL,
  CLAUDE_OPUS_MODEL,
} from './lib/final-review/providers.mjs';

// ── Shadow review (relocated to lib/final-review/shadow.mjs) ───────────────────
// Pure relocation (Phase 3). None of these were previously top-level exports
// (only _internals entries — no test imports them directly), so no top-level
// re-export is owed; _internals below keeps flowing through unchanged.
// shadow.mjs now imports its four post-review dependencies from post-review.mjs
// below (not from this file — Phase 4 retargeted that edge), and this file
// imports its own entry points back from shadow.mjs — the one PERMANENT
// two-file cycle (runReviewWithRetry / runShadowAndPersist; see shadow.mjs's
// fileoverview), safe under ESM because nothing on either side runs at module
// top level, and no longer a cross-domain edge now that both files are
// `audit-orchestration` (.audit-loop/domain-map.json).
import {
  resolveShadow,
  buildShadowClient,
  mapRouteToShadowProvider,
  resolveModelEvalShadowOverride,
  dedupByHash,
  diffFindingBuckets,
  shadowErrorBlock,
  buildFinalReviewPersistPayload,
  runShadowAndPersist,
} from './lib/final-review/shadow.mjs';

// ── Post-review findings pipeline (relocated to lib/final-review/post-review.mjs) ──
// Pure relocation (Phase 4). applyExistenceGate / applyScopeFilter /
// recordNewFindings keep being re-exported at the top level (test-import
// contract — see the plan's widened General rule); applyDebtSuppression /
// addSemanticIds / recordGeminiOutcomes were never top-level exports (the
// first two were a temporary Phase-3-only export for shadow.mjs's benefit,
// now retired — shadow.mjs imports them from here instead).
export {
  applyExistenceGate,
  applyScopeFilter,
  recordNewFindings,
} from './lib/final-review/post-review.mjs';
import {
  applyDebtSuppression,
  applyExistenceGate,
  applyScopeFilter,
  addSemanticIds,
  recordNewFindings,
  recordGeminiOutcomes,
} from './lib/final-review/post-review.mjs';

// ── Review Orchestrator ────────────────────────────────────────────────────────

/**
 * Run the final review with the selected provider (see the PROVIDERS catalog).
 * @param {string} provider - 'gemini' | 'claude-opus' | 'gpt'
 * @param {object} client - Provider-specific client
 * @param {string} planContent
 * @param {string} transcriptContent - JSON string of full audit transcript
 * @param {string} projectContext
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
export async function runFinalReview(provider, client, planContent, transcriptContent, projectContext, auditMode = 'code', modelOverride = null, options = {}) {
  // `envelopeScope` defaults to 'full' so an omitted options bag is
  // byte-identical to the pre-extraction behaviour (plan KD-1: threaded as a
  // parameter, NOT as a second module-global — `_roleAddendum` already has a
  // documented non-reentrancy caveat and adding a consumer would compound it).
  const { envelopeScope = 'full', primaryResult = null } = options;
  const reduced = isReducedScope(envelopeScope);

  // Parse transcript to extract code file paths for direct code inclusion
  let transcript;
  try {
    transcript = JSON.parse(transcriptContent);
  } catch {
    // If not JSON, treat as markdown transcript
    transcript = { raw: transcriptContent };
  }

  // Resolve the code-file set. `full` keeps the historical set verbatim;
  // reduced scopes narrow to the in-scope diff, which is the set the review
  // prompt's own rule 8 already restricts findings to — so the wider set was
  // paying for tokens the scope filter then discards.
  let codePaths = [];
  let codeExcluded = null;
  if (reduced) {
    const sel = selectInScopeCodeFiles(
      Array.isArray(transcript.changed_files) ? transcript.changed_files : [],
      {
        exists: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
        // resolveAndClassify, NOT classifyPath. `changed_files` is
        // transcript-supplied, and this selector's output is read into a prompt
        // that egresses to a third party — so a path named innocently but
        // resolving through a symlink into (say) ~/.ssh must be caught. The
        // lexical classifier matches the visible string only and would pass it
        // (INC-001's class). This variant realpaths, re-classifies the canonical
        // target, and fails CLOSED: a repo-escaping or unresolvable path throws
        // or classifies sensitive, and either way we exclude it.
        isSensitive: (p) => {
          try {
            return resolveAndClassify(p, { repoRoot: process.cwd() }).category === 'sensitive';
          } catch {
            return true; // unresolvable ⇒ sensitive. Never "couldn't classify, so allow".
          }
        },
        // Cheap, name-only, never touches the filesystem — safe to call on a
        // path that does not exist (an ordinary deletion), where the
        // canonicalising check above would throw on realpath's ENOENT and
        // fail-closed to "sensitive" for every deletion. See selectInScopeCodeFiles's
        // docstring for why this split exists.
        isSensitiveLexical: (p) => classifyPath(p) === 'sensitive',
        isInfra: isAuditInfraFile,
      },
    );
    codePaths = sel.files;
    codeExcluded = sel.excluded;
  } else if (transcript.code_files && Array.isArray(transcript.code_files)) {
    const { found } = extractPlanPaths(planContent);
    // Filter out audit-loop infrastructure files — they bleed into scope when
    // consumer repos have synced copies of scripts/ and cause false findings.
    codePaths = [...new Set([...found, ...transcript.code_files])].filter(f => !isAuditInfraFile(f));
  } else {
    // Fall back to extracting from plan (already filtered by extractPlanPaths)
    codePaths = extractPlanPaths(planContent).found;
  }
  // The declared diff set drives the render's PRIORITY, not just its selection:
  // changed files are rendered whole before any budget is spent on ambient
  // context (code-render.mjs). Returns `{text, stats}` — the stats are what
  // make `_envelope.truncated` a measurement instead of a claim.
  const changedFilesDeclared = Array.isArray(transcript.changed_files) ? transcript.changed_files : [];
  const renderCode = makeTieredCodeRenderer({ changedFiles: changedFilesDeclared, reduced });

  // Phase D.4: extract debt-suppression context from transcript envelope.
  // When the upstream audit already filtered debt, tell the reviewer so they
  // don't re-surface the same topics.
  const suppressionContext = transcript._debtMemory?.suppressionContext
    || transcript.debt_memory?.suppressionContext
    || [];
  let debtBlock = '';
  if (Array.isArray(suppressionContext) && suppressionContext.length > 0) {
    const lines = suppressionContext.slice(0, 50).map(s =>
      `- [${s.topicId}] ${s.category} (${s.section}) — ${s.deferredReason}`
    );
    debtBlock = [
      '## Pre-filtered Debt (already suppressed this round — DO NOT resurface)',
      `The following ${suppressionContext.length} topics were matched against the repo's`,
      'persistent debt ledger and filtered from the transcript above. They are',
      'pre-existing concerns explicitly deferred by the operator. If you see new',
      'findings in your review that match any of these topics, EXCLUDE them —',
      'the pipeline already handled them.',
      '',
      ...lines,
      '',
    ].join('\n');
  }

  // Scope block: when the transcript declares changed_files, surface them
  // explicitly so the reviewer knows which files are this PR's responsibility
  // vs which are inlined for context.  Filtered post-hoc by applyScopeFilter().
  const changedFiles = Array.isArray(transcript.changed_files) ? transcript.changed_files : [];
  let scopeBlock = '';
  if (changedFiles.length > 0) {
    scopeBlock = [
      '## Files In Scope (PR diff)',
      'These are the files this PR modified.  new_findings[] entries MUST cite one of these.',
      'Other files in "Code Files" below are inlined for context only — issues there are',
      'pre-existing and out-of-scope for this audit.',
      '',
      ...changedFiles.map(f => `- ${f}`),
      '',
    ].join('\n');
  }

  // Adaptive repo-context (Phase 3 — adaptive-context-blast-radius): give
  // the final reviewer the repo file inventory so it can FALSIFY factual
  // "missing module" claims in the transcript instead of only judging the
  // deliberation. T1 (with the changed files) for a code review; T0 for a
  // plan review. Non-blocking — a failure just omits the block.
  // Reduced scopes drop this block entirely (~8000 tokens) — it is the single
  // largest bounded saving available, and a second reviewer working from the
  // diff does not need a repo-wide inventory to find what the first missed.
  let repoContextBlock = '';
  if (!reduced) {
    try {
      const rc = getRepoContext({
        tier: auditMode === 'plan' ? 'T0' : 'T1',
        scope: auditMode === 'plan' ? 'plan' : 'diff',
        targetPaths: changedFiles, baseDir: process.cwd(),
      });
      if (rc.block) {
        repoContextBlock = `## Repository Context (tier ${rc.resolvedTier})\n${rc.block}`;
      }
      // LOG the structured coverage; never re-render it. `rc.block` already
      // carries the one rendering (repo-context.mjs's one-rendering rule) —
      // emitting it again here would put two differently-formatted coverage
      // statements in front of the model. This line is for the OPERATOR.
      if (rc.truncated) {
        const dropped = (rc.coverage?.sections || [])
          .filter((x) => x.state !== 'full')
          .map((x) => `${x.id}=${x.state}(${x.shown}/${x.total})`).join(' ');
        process.stderr.write(
          `  [repo-context] tier ${rc.requestedTier}→${rc.resolvedTier} `
          + `(~${rc.tokensEst} tok) TRUNCATED ${dropped || '(unitemised)'}\n`);
      }
    } catch { /* non-blocking */ }
  }

  // `gap` only: the primary's findings, bounded + projected + labelled untrusted.
  const gapProjection = isNonBlindScope(envelopeScope)
    ? serializePrimaryForGap(primaryResult)
    : null;

  // Envelope assembly + budget live in lib/final-review/envelope.mjs (KD-2):
  // pure, injectable code reader, so the byte-identity contract for `full` and
  // the truncation order for `thin`/`gap` are unit-testable without a CLI.
  const built = buildReviewEnvelope({
    scope: envelopeScope,
    projectContext, planContent, repoContextBlock, scopeBlock,
    transcript, debtBlock,
    gapBlock: gapProjection?.block ?? '',
    // Truncation step 3: re-render the gap block smaller rather than slicing
    // its string, so its field caps, severity ordering and omission marker
    // survive the trim.
    renderGap: gapProjection
      ? (budget) => serializePrimaryForGap(primaryResult, { maxChars: budget })
      : null,
    codePaths, renderCode,
  });
  let userPrompt = built.userPrompt;

  // Defence-in-depth secret scan over the ASSEMBLED envelope (KD-8). Per-file
  // provenance enforcement already happened upstream in readFilesAsContext,
  // where provenance still exists; this is the net under the PROSE blocks
  // (plan, transcript, project context, debt) that have no other coverage, and
  // it covers every provider rather than only the newest one.
  //
  // The gentle `secret-patterns` redactor, deliberately NOT `sanitizer.mjs` —
  // the blanket variant redacts any 20+ char token and would shred findings
  // prose and code snippets (AGENTS.md).
  const scanned = redactSecretsWithCount(userPrompt);
  userPrompt = scanned.text;
  // How much of the DIFF actually reached the model. Distinct from
  // `truncated`, which counts drops without knowing which of them mattered.
  const codeCoverage = summariseCodeCoverage(built.accounting.codeRender, changedFilesDeclared);
  const envelopeAccounting = {
    ...built.accounting,
    codeCoverage,
    redactions: scanned.redacted,
    codeExcluded,
    gapFindings: gapProjection
      ? { included: gapProjection.included, omitted: gapProjection.omitted }
      : null,
  };

  const descriptor = PROVIDERS[provider];
  if (!descriptor) throw new Error(`[final-review] unknown provider "${provider}"`);
  // modelOverride (shadow reviewer) wins over the provider's resolved model.
  const selectedModel = modelOverride || descriptor.resolveModel();
  const shadowTag = modelOverride ? ' [shadow]' : '';
  process.stderr.write(`\n── ${descriptor.label} Final Review${shadowTag} ──\n`);
  process.stderr.write(`  Model: ${selectedModel}\n`);
  process.stderr.write(`  Context: ~${(userPrompt.length / 4).toFixed(0)} tokens (estimated)\n`);
  process.stderr.write(`  Code coverage: ${codeCoverage.state.toUpperCase()} — ${codeCoverage.reason}\n`);

  // Append classification rubric so new_findings populate the required envelope.
  const classificationBlock = buildClassificationRubric({
    sourceKind: 'REVIEWER',
    sourceName: selectedModel
  });
  let systemPrompt = getReviewPrompt() + classificationBlock;
  if (auditMode === 'plan') {
    systemPrompt += PLAN_MODE_BLOCK;
  }

  // REQUEST IDENTITY. Hash what actually determines the model's answer, so
  // "are these two arms different?" is a comparison, not an investigation.
  //
  // It took token-count archaeology across five result files plus a read of
  // runShadowReview to establish that the bake-off's `opus` and `solo-opus`
  // arms issue the SAME request — a shadow runs blind on the same transcript,
  // plan and context as the primary, and only the downstream BUCKETING differs.
  // An arm table cannot tell you that; two equal fingerprints can.
  //
  // Four inputs because those are what a provider's answer is a function of:
  // the model, both prompt halves, and the reasoning dial. Deliberately NOT
  // max_tokens (a ceiling, not a steer) and NOT the gateway routing extras
  // (which decide WHERE a request runs, not what it asks). Truncated to 16 hex:
  // this distinguishes a handful of arms, it is not a security boundary.
  const requestFingerprint = crypto.createHash('sha256')
    .update(`${selectedModel}\u0000${finalReviewConfig.reasoningEffort}\u0000${systemPrompt}\u0000${userPrompt}`)
    .digest('hex').slice(0, 16);

  // REQUEST IDENTITY, ambient-independent — `requestFingerprint`'s companion,
  // ADDITIVE exactly like `bucketsMatched` further down, and for the same
  // reason: the field above keeps its exact prior meaning, so no collected
  // snapshot is invalidated and this stays off a CONTRACT_EPOCH bump.
  //
  // WHY IT EXISTS. `requestFingerprint` hashes the bytes we sent, and on a
  // `full` envelope those bytes include `repoContextBlock` — a listing of the
  // WORKING TREE (`gitInventory` = tracked ∪ untracked-but-unignored, minus
  // deletions), re-read uncached on every call. Its header line carries the
  // file COUNT, so one file appearing anywhere in the repo moves the hash even
  // when it sorts far past the block's truncation cut. Measured 2026-08-20 on
  // this repo: two back-to-back calls with `tests/historical-replay.fixture.mjs`
  // (written by tests/test-guard-false-green.test.mjs) created between them
  // fingerprinted e9939e1e… vs bfd414f0…, and back to e9939e1e… once removed.
  //
  // That makes the hash a poor answer to the question its consumer asks.
  // `summary.mjs`'s reroll detection intersects fingerprint SETS, so ambient
  // drift can only ever LOSE a pair — and an empty `rerollPairs` reads as "no
  // rerolls", never "unknown". One such miss is already in the recorded log
  // (snapshot d49d421591de, `opus` vs `solo-opus` — the very pair
  // comparison/fingerprint.mjs's docstring says the machinery exists to catch).
  // `armRequestFingerprint` refuses this same class one module over: "a
  // fingerprint depending on mutable remote state is a WORSE failure than the
  // reroll D4 exists to catch". This is that failure with LOCAL mutable state.
  //
  // So: hash the caller-determined request, ambient block replaced by a fixed
  // token. Two arms whose identities match are sampling one distribution — an
  // incidental inventory delta is not a treatment variable.
  //
  // Elided PRE-redaction (`built.userPrompt`), where the block sits verbatim:
  // `repoContextBlock` is non-empty only when `!reduced`, and the `full` path
  // never truncates, so the substring is guaranteed present. Redaction is a
  // deterministic function of content and cannot make two identical requests
  // differ, so hashing before it costs no fidelity and saves a second pass over
  // a ~200KB string.
  //
  // `ri1:`-prefixed so it can never collide with a bare-hex `requestFingerprint`
  // when a consumer unions the two sets, and so a stored value states which
  // contract produced it.
  const identityPrompt = repoContextBlock
    ? built.userPrompt.replace(repoContextBlock, '<ambient:repo-context>')
    : built.userPrompt;
  // Never assume the elision landed. If a block existed and the substring was
  // not found, the identity would silently degrade to ambient-dependent — the
  // "check that checks nothing" failure. Recorded, never swallowed.
  const ambientElided = repoContextBlock ? identityPrompt !== built.userPrompt : true;
  const requestIdentity = `ri1:${crypto.createHash('sha256')
    .update(`${selectedModel}\u0000${finalReviewConfig.reasoningEffort}\u0000${systemPrompt}\u0000${identityPrompt}`)
    .digest('hex').slice(0, 16)}`;
  envelopeAccounting.ambientElided = ambientElided;
  envelopeAccounting.repoContextDigest = repoContextBlock
    ? crypto.createHash('sha256').update(repoContextBlock).digest('hex').slice(0, 16)
    : null;

  // `userPrompt` is the single egress envelope — assembled once above via
  // readFilesAsContext (sensitive-path filtered + secret-redacted). Every
  // transport adapter receives only this string; none re-reads files (C3).
  const call = await callReviewer(client, {
    transportKind: descriptor.transportKind(),
    model: selectedModel,
    systemPrompt,
    userPrompt,
    zodSchema: GeminiFinalReviewSchema,
    jsonSchema: GeminiFinalReviewJsonSchema,
    toolSchema: AnthropicReviewToolSchema,
    passName: `${provider}-review`,
    // Optional per-descriptor gateway body fields (`openrouter`, `xai`).
    requestExtras: descriptor.requestExtras?.(),
    // Only descriptors that opt in (`structuredOutput: true`) ask for the schema.
    // Azure Foundry shares the openai adapter and deliberately does NOT.
    openAiJsonSchema: descriptor.structuredOutput ? OpenAiFinalReviewJsonSchema : undefined,
    // `_activeReviewController` is owned HERE (the watchdog that reads it
    // stays in this file) — `callReviewer` (now in transport.mjs) no longer
    // writes it directly, per the plan's Symbol/Dependency Matrix.
    onController: (c) => { _activeReviewController = c; },
  });
  // Stamped on the RESULT, not just returned, so it survives every downstream
  // path unchanged — the primary's `--out` JSON spreads `{...result}`, and the
  // shadow block copies it explicitly. A value only on the return object would
  // be lost at the first hop that rebuilds its own envelope, which is exactly
  // how the shadow's cache-token counts went missing.
  // A verdict issued over ZERO coverage of the changed code is not a pass, no
  // matter what the model said. Applied BEFORE the result is stamped and
  // returned, so every downstream consumer sees the gated verdict.
  const coverageGate = applyCoverageGate(call.result, codeCoverage);
  if (coverageGate.downgraded) {
    process.stderr.write(
      `  [final-review] COVERAGE GATE: verdict ${coverageGate.from} → ${coverageGate.to} `
      + `— ${codeCoverage.reason}\n`);
  }
  call.result._requestFingerprint = requestFingerprint;
  // Stamped alongside, for the same survives-every-downstream-hop reason.
  call.result._requestIdentity = requestIdentity;
  call.result._envelope = envelopeAccounting;
  return { ...call, requestFingerprint, requestIdentity, envelope: envelopeAccounting };
}

// ── Output Formatting ──────────────────────────────────────────────────────────

function formatReviewResult(result, usage, latencyMs, provider) {
  const lines = [];
  const descriptor = PROVIDERS[provider];
  const selectedModel = descriptor ? descriptor.resolveModel() : provider;
  const title = `${descriptor?.label ?? provider} — Independent Final Review`;
  lines.push(`# ${title}`);
  lines.push(`- **Model**: ${selectedModel} | **Latency**: ${(latencyMs / 1000).toFixed(1)}s`);
  lines.push(`- **Tokens**: ${usage.input_tokens} in / ${usage.output_tokens} out (${usage.thinking_tokens} thinking)`);
  lines.push('');

  // Verdict
  const VERDICT_ICONS = { APPROVE: '✅', CONCERNS: '⚠️', CONCERNS_REMAINING: '⚠️', REJECT: '❌' };
  const icon = VERDICT_ICONS[result.verdict] ?? '❌';
  lines.push(`## Verdict: ${icon} **${result.verdict}**`);
  lines.push('');

  // Deliberation quality
  const dq = result.deliberation_quality;
  lines.push('## Deliberation Quality');
  lines.push(`- **Claude bias detected**: ${dq.claude_bias_detected ? 'YES' : 'No'}`);
  lines.push(`- **GPT false positives**: ${dq.gpt_false_positive_count}`);
  lines.push(`- **Deliberation fair**: ${dq.deliberation_was_fair ? 'Yes' : 'NO'}`);
  lines.push(`- **Summary**: ${dq.quality_summary}`);
  lines.push('');

  // Architectural coherence
  lines.push(`## Architectural Coherence: **${result.architectural_coherence}**`);
  lines.push('');

  // Wrongly dismissed
  if (result.wrongly_dismissed?.length > 0) {
    lines.push('## Wrongly Dismissed Findings');
    lines.push('');
    for (const wd of result.wrongly_dismissed) {
      lines.push(`### [${wd.original_finding_id}] → Should be ${wd.recommended_severity}`);
      lines.push(`- **Why**: ${wd.reason_claude_was_wrong}`);
      // A mechanically-refuted absence claim must be flagged where the operator
      // reads the finding. Without this the only signal was a stderr line the
      // report reader never sees, and the claim is re-argued in prose instead.
      if (isRefuted(wd)) {
        lines.push(`- **REFUTED (repo inventory)**: ${wd.verification?.verificationReason || 'the cited entity exists'} — this claim is mechanically false; do not re-argue it.`);
      }
      lines.push('');
    }
  }

  // New findings
  if (result.new_findings?.length > 0) {
    lines.push('## New Findings (missed by both models)');
    lines.push(formatFindings(result.new_findings));
  }

  // Over-engineering
  if (result.over_engineering_flags?.length > 0) {
    lines.push('## Over-Engineering Flags');
    lines.push('');
    for (const flag of result.over_engineering_flags) {
      lines.push(`- ${flag}`);
    }
    lines.push('');
  }

  // Overall reasoning
  lines.push('## Overall Assessment');
  lines.push('');
  lines.push(result.overall_reasoning);

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────

// ── main() helpers — keep main() under cognitive-complexity 15 ────────────

/**
 * Minimal reachability request per transport — the smallest call that proves the
 * endpoint, the credential, the auth header AND the model/deployment name are
 * all correct together. Keyed by the same `transportKind()` the real review
 * dispatches on, so a ping can never exercise a different route than a review.
 * @type {Record<string, (client: object, model: string) => Promise<string>>}
 */
const PING_TRANSPORTS = {
  async gemini(client, model) {
    const r = await client.models.generateContent({ model, contents: 'Reply with exactly: ready' });
    return (r.text || '').trim();
  },
  async anthropic(client, model) {
    const r = await client.messages.create({
      model, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
    });
    return (r.content?.[0]?.text || '').trim();
  },
  async openai(client, model) {
    // max_tokens, not max_completion_tokens — must match REVIEW_TRANSPORTS.openai's
    // real request body, or the ping validates a shape the review never sends and
    // can pass while the real call 400s on a gateway strict about the param name.
    const r = await client.chat.completions.create({
      model, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
    });
    return (r.choices?.[0]?.message?.content || '').trim();
  },
};

/**
 * `ping` — prove the CONFIGURED final reviewer is reachable.
 *
 * It used to ignore `--provider` entirely and branch on
 * `GEMINI_API_KEY`/`ANTHROPIC_API_KEY`, which made it useless in exactly the
 * situation it exists for: on an Azure-only machine neither variable is set, so
 * the one diagnostic an operator reaches for when the reviewer is failing
 * answered "Error: set GEMINI_API_KEY or ANTHROPIC_API_KEY" — advice that is
 * wrong for that install and says nothing about the route actually in use.
 *
 * Now it walks the same path a review does: `--provider` (or the persisted
 * `FINAL_REVIEW_PROVIDER`, or auto-detect) → `selectProvider` → the descriptor's
 * own `assertReady` → its own `buildClient` → its own transport.
 */
async function runPing(args = []) {
  const providerIdx = args.indexOf('--provider');
  const providerOverride = providerIdx !== -1 && args[providerIdx + 1] ? args[providerIdx + 1] : null;
  // selectProvider runs the descriptor's assertReady and exits non-zero, naming
  // the missing variable, when the chosen provider is not configured.
  const provider = selectProvider(providerOverride || resolveProviderSetting());
  const descriptor = PROVIDERS[provider];
  const model = descriptor.resolveModel();
  const kind = descriptor.transportKind();
  const ping = PING_TRANSPORTS[kind];
  if (!ping) {
    console.error(`Error: provider "${provider}" has no ping transport for kind "${kind}".`);
    process.exit(1);
  }
  // Report the route BEFORE the call, so a hang or a 401 is still attributable.
  console.log(`ping ${descriptor.label} · provider=${provider} · transport=${kind} · model=${model}${describeAzureRoute(provider)}`);
  try {
    const client = await descriptor.buildClient();
    const text = await ping(client, model);
    console.log(`✓ ${model}: ${text}`);
    process.exit(0);
  } catch (err) {
    console.error(`✗ ${model}: ${describeTransportFailure(err, provider)}`);
    process.exit(1);
  }
}

function parseReviewArgs(args) {
  const planFile = args[1];
  const transcriptFile = args[2];
  const jsonMode = args.includes('--json');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;
  const providerIdx = args.indexOf('--provider');
  const providerOverride = providerIdx !== -1 && args[providerIdx + 1] ? args[providerIdx + 1] : null;
  const modeIdx = args.indexOf('--mode');
  const auditMode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : 'code';
  // --run-id <audit_runs.id> — enables per-finding cloud persistence keyed to
  // this run (shadow A/B). Absent → local-only, today's behaviour unchanged.
  const runIdIdx = args.indexOf('--run-id');
  const runId = runIdIdx !== -1 && args[runIdIdx + 1] ? args[runIdIdx + 1] : null;
  // --role <adjudicator-only> (Phase 12) — closed value set, validated in
  // main(). Absent (null) → today's default behaviour, byte-identical.
  const roleIdx = args.indexOf('--role');
  const role = roleIdx !== -1 && args[roleIdx + 1] ? args[roleIdx + 1] : null;
  // --envelope-scope <full|thin|gap> — the CAMPAIGN's declared scope for the
  // shadow reviewer this process spawns. Presence of this flag (or
  // --campaign-digest) is the "a campaign is active" signal — see KD-6's
  // correction: an earlier draft used the presence of ANY envelope-scope
  // source as that signal, which made identical `gap` intent behave
  // differently by transport (env-supplied gap was fine, CLI-supplied gap was
  // a campaign violation). Precedence: this flag > FINAL_REVIEW_SHADOW_SCOPE
  // env > 'full' default (resolveEnvelopeScope owns the actual resolution).
  const envelopeScopeIdx = args.indexOf('--envelope-scope');
  const envelopeScopeCli = envelopeScopeIdx !== -1 && args[envelopeScopeIdx + 1] ? args[envelopeScopeIdx + 1] : null;
  // --campaign-digest <hex> — the manifest's configDigest, recorded (never
  // verified here; verification is the COLLECTOR's job, which owns the
  // manifest) so a persisted snapshot can be matched to the specific signed
  // cohort that claims it. Its PRESENCE is the campaign-active signal.
  const campaignDigestIdx = args.indexOf('--campaign-digest');
  const campaignDigest = campaignDigestIdx !== -1 && args[campaignDigestIdx + 1] ? args[campaignDigestIdx + 1] : null;
  return { planFile, transcriptFile, jsonMode, outFile, providerOverride, auditMode, runId, role, envelopeScopeCli, campaignDigest };
}

function isJsonTruncationError(err) {
  return err.message?.includes('Unterminated string')
    || err.message?.includes('JSON')
    || err.message?.includes('parse');
}

export async function runReviewWithRetry(provider, client, planContent, transcriptContent, projectContext, auditMode, modelOverride = null, options = {}) {
  const MAX_ATTEMPTS = 2;
  let txContent = transcriptContent;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await runFinalReview(provider, client, planContent, txContent, projectContext, auditMode, modelOverride, options);
      return { ...r, transcriptContent: txContent };
    } catch (err) {
      if (!isJsonTruncationError(err) || attempt >= MAX_ATTEMPTS) throw err;
      process.stderr.write(`  [final-review] JSON truncation on attempt ${attempt} — retrying with conciseness instruction...\n`);
      txContent = JSON.stringify({
        ...JSON.parse(txContent),
        _retryHint: 'IMPORTANT: Your previous response was truncated. Be MORE CONCISE in all string fields. Keep quality_summary under 500 chars and overall_reasoning under 1500 chars.',
      });
    }
  }
  throw new Error('unreachable');
}

/**
 * `--role adjudicator-only` (Phase 12) — a NEW sibling function that wraps
 * `runReviewWithRetry`/`runFinalReview` from OUTSIDE, mirroring the
 * already-shipped `runShadowReview`/`runShadowAndPersist` pattern above
 * (lines ~913-1041): it injects a role-specific system-prompt addendum via
 * the `lib/final-review/prompts.mjs`-owned `_roleAddendum` toggle
 * `getReviewPrompt()` reads (set through the exported `setRoleAddendum`,
 * since the state itself lives in that module now), without modifying
 * `runFinalReview`'s own body at all. Used by the tiered-recall audit
 * pipeline's Stage 2 adjudicator (`scripts/lib/audit/final-adjudication.mjs`)
 * to re-verify one candidate/clean-region file per subprocess call.
 * @returns {Promise<{result: object, usage: object, latencyMs: number, transcriptContent: string}>}
 */
export async function runAdjudicatorOnlyReview(provider, client, planContent, transcriptContent, projectContext, auditMode, modelOverride = null) {
  setRoleAddendum(ADJUDICATOR_ONLY_ADDENDUM);
  try {
    return await runReviewWithRetry(provider, client, planContent, transcriptContent, projectContext, auditMode, modelOverride);
  } finally {
    setRoleAddendum(null);
  }
}

function emitReviewOutput(result, usage, latencyMs, provider, jsonMode, outFile) {
  if (jsonMode || outFile) {
    const selectedModel = provider === 'gemini' ? MODEL : (provider === 'azure-claude' ? azureConfig.claudeDeployment : CLAUDE_OPUS_MODEL);
    const data = { ...result, _model: selectedModel, _provider: provider, _usage: usage };
    if (outFile) {
      const newCount = result.new_findings?.length ?? 0;
      const dismissedCount = result.wrongly_dismissed?.length ?? 0;
      const summaryLine = `Verdict: ${result.verdict} | New: ${newCount} | Wrongly dismissed: ${dismissedCount} | ${(latencyMs / 1000).toFixed(0)}s`;
      writeOutput(data, outFile, summaryLine);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    return;
  }
  console.log(formatReviewResult(result, usage, latencyMs, provider));
}

/**
 * Test-only, deterministic fixture path for `--provider fixture` (plan
 * Phase 12, audit-plan fix M1 round 3) — rejected outside `NODE_ENV=test`
 * (mirrors how `--role`'s own closed value set is validated). Skips ALL
 * real provider client construction and network calls; writes a canned,
 * schema-valid `GeminiFinalReviewSchema` result straight to `--out`. Reads
 * `transcript.rounds[0].findings[0].id` + the test-only
 * `transcript._fixtureVerdict` field so a caller (the subprocess-adapter
 * test) can deterministically drive either verdict-mapping branch without
 * a live model call — this is the SAME kind of test-gated determinism this
 * repo already uses for provider stubbing elsewhere, just crossing a
 * subprocess boundary instead of a function-call boundary.
 */
function runFixtureReview({ transcriptFile, outFile, jsonMode }) {
  let transcript = {};
  try {
    transcript = JSON.parse(readFileOrDie(transcriptFile));
  } catch { /* malformed/non-JSON transcript — fixture still returns a canned result */ }

  const findingId = transcript?.rounds?.[0]?.findings?.[0]?.id ?? null;
  const wantReversed = transcript?._fixtureVerdict === 'reversed' && !!findingId;
  const wantMissed = transcript?._fixtureVerdict === 'missed_candidate';
  const targetFile = Array.isArray(transcript?.changed_files) ? transcript.changed_files[0] : 'fixture.js';

  const result = GeminiFinalReviewSchema.parse({
    verdict: 'CONCERNS',
    deliberation_quality: {
      claude_bias_detected: false, gpt_false_positive_count: 0,
      deliberation_was_fair: true, quality_summary: 'fixture canned result — no live model call made.',
    },
    new_findings: wantMissed ? [{
      id: 'F1', severity: 'MEDIUM', category: 'Fixture', section: targetFile || 'fixture.js',
      detail: 'fixture canned missed-candidate finding', risk: 'fixture risk',
      recommendation: 'fixture recommendation', is_quick_fix: false, is_mechanical: false, is_reopened: false,
      principle: 'fixture', classification: { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'REVIEWER', sourceName: 'fixture' },
    }] : [],
    wrongly_dismissed: wantReversed ? [{
      original_finding_id: findingId, reason_claude_was_wrong: 'fixture canned reversal', recommended_severity: 'MEDIUM',
    }] : [],
    over_engineering_flags: [],
    architectural_coherence: 'Adequate',
    overall_reasoning: 'fixture canned result — no live model call made (NODE_ENV=test, --provider fixture).',
  });
  addSemanticIds(result, 'gemini');
  const data = { ...result, _model: 'fixture', _provider: 'fixture', _usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 } };
  const summaryLine = `Verdict: ${result.verdict} | New: ${result.new_findings.length} | Wrongly dismissed: ${result.wrongly_dismissed.length} | fixture (no live call)`;
  if (outFile) {
    writeOutput(data, outFile, summaryLine);
  } else if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatReviewResult(result, { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 }, 0, 'fixture'));
  }
  return finishAndExit(0);
}

/**
 * A cloud-enabled `review` invocation with no `--run-id` is a SILENT total
 * loss of this review's persistence (found live 2026-07-26, chasing a
 * consumer repo whose `audit_runs` rows all showed real, non-zero
 * rounds/findings — the audit itself genuinely ran — but
 * `gemini_verdict`/`final_review_model` were NULL on every one of 101 runs
 * across 30 days). Root cause: `runId` simply defaults to null when
 * `--run-id` is omitted (a manual, easy-to-forget CLI flag — the caller must
 * extract `_cloudRunId` from the audit `--out` JSON and pass it through), and
 * `runShadowAndPersist`'s cloud-write guard (`if (!runId) return`) then
 * no-ops with ZERO signal that anything was skipped. The review still runs,
 * still prints a real verdict — it just never reaches the store, silently,
 * every time, indistinguishable from a deliberate "cloud is off" run.
 *
 * Extracted as a pure predicate (Tier 1 — a deterministic seam per this
 * repo's testing doctrine) so the condition is unit-testable without mocking
 * the whole CLI/cloud-detection flow.
 *
 * @param {{mode: string, runId: string|null, cloudEnabled: boolean}} args
 * @returns {boolean}
 */
export function shouldWarnMissingRunId({ mode, runId, cloudEnabled }) {
  return mode === 'review' && !runId && cloudEnabled;
}

/**
 * Whether marker-based run-id recovery may even be ATTEMPTED for this call.
 *
 * Restricted to `auditMode === 'code'` because `.audit/last-audit-run.json`
 * is written ONLY by the code-audit path (`legacy-production-audit.mjs` via
 * `writeGateEvidence`) — `/audit-plan`'s `--mode plan` review never refreshes
 * it, and never has. Without this gate, a plan review that omits --run-id
 * (which is not a stale-context bug for plan mode — audit-plan's SKILL.md
 * never teaches it to pass one at all, because a plan isn't a commit-scoped
 * `audit_runs` row the same way code is) would recover whatever CODE audit's
 * marker happened to still sit inside the freshness window and misattach to
 * it. Found live 2026-07-27, the day this recovery shipped: a wine-cellar-app
 * `/audit-plan` session's shadow findings landed under an unrelated code
 * audit's run_id, and `recordFinalReviewFindings`'s own DELETE (scoped only
 * by `run_id`, so it cannot tell "replace this run's stale findings" apart
 * from "wipe another run's findings out from under it") then destroyed that
 * code audit's 4 already-adjudicated findings as a side effect — not just a
 * mislabel, real data loss. A wrong row is worse than no row; here it was
 * worse than that again.
 *
 * @param {{auditMode: string}} args
 * @returns {boolean}
 */
export function canAttemptRunIdRecovery({ auditMode }) {
  return auditMode === 'code';
}

export const MISSING_RUN_ID_WARNING =
  '  [gemini-review] WARNING: cloud is enabled but no --run-id was supplied. '
  + 'This review\'s verdict and findings will NOT be persisted to audit_runs — '
  + 'they exist only in this process\'s stdout/--out file. If this is unintentional, '
  + 're-invoke with --run-id <audit_runs.id> (read _cloudRunId from the audit --out JSON).\n';

/**
 * How stale a gate-evidence marker may be and still identify THIS review's run.
 *
 * Step 7 runs minutes after the audit round that wrote the marker. Six hours is
 * far beyond any real gap while still refusing yesterday's marker — attaching a
 * review to a run it did not review is a worse failure than not persisting it,
 * because a wrong row looks like real evidence.
 */
export const RUN_ID_MARKER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Recover the audit run id from the gate-evidence marker when `--run-id` was
 * not passed.
 *
 * **Why a fallback exists at all.** The flag is extracted by an AGENT following
 * a markdown snippet in SKILL.md, so its correctness depends on the agent
 * reading the current instructions — which a long-running session that loaded
 * an older SKILL.md into context will not do. That is not a hypothetical: a
 * consumer repo lost 101 runs' final reviews to it, and then lost one MORE
 * immediately after the snippet was fixed, because the session already
 * mid-flight kept executing the stale snippet from memory. A flag whose only
 * enforcement is "the caller remembers" fails exactly this way. `.audit/last-audit-run.json`
 * is written by the audit itself ([`lib/audit/gate-evidence.mjs`](lib/audit/gate-evidence.mjs)),
 * so the id is already on disk and needs no agent cooperation to find.
 *
 * Pure (marker content + clock in, decision out) so every branch is testable
 * without a filesystem — Tier 1 per this repo's testing doctrine.
 *
 * @param {{marker: unknown, nowMs: number, maxAgeMs?: number}} args
 * @returns {{runId: string|null, reason: 'recovered'|'no-marker'|'malformed'|'stale'}}
 */
export function recoverRunIdFromMarker({ marker, nowMs, maxAgeMs = RUN_ID_MARKER_MAX_AGE_MS }) {
  if (!marker || typeof marker !== 'object') return { runId: null, reason: 'no-marker' };
  const { runId, ts } = /** @type {{runId?: unknown, ts?: unknown}} */ (marker);
  // Same shape gate the ship-commit readers apply, so a marker this accepts can
  // never be one they reject.
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return { runId: null, reason: 'malformed' };
  const tsMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (Number.isNaN(tsMs)) return { runId: null, reason: 'malformed' };
  if (nowMs - tsMs > maxAgeMs) return { runId: null, reason: 'stale' };
  return { runId, reason: 'recovered' };
}

/** Read + parse the gate-evidence marker. Any I/O or parse failure → null. */
function readGateEvidenceMarker(repoRoot) {
  try {
    const p = resolve(repoRoot, GATE_EVIDENCE_RELPATH);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  assertRepoRoot(import.meta.url);
  await refreshProviderModels();

  const args = process.argv.slice(2);
  const mode = args[0];
  if (mode === 'ping') return runPing(args);
  if (mode === 'set-provider') return runSetProvider(args[1]);

  const { planFile, transcriptFile, jsonMode, outFile, providerOverride, auditMode, runId: cliRunId, role, envelopeScopeCli, campaignDigest } = parseReviewArgs(args);
  let runId = cliRunId;
  // A cloud-enabled invocation with no --run-id is a SILENT total loss of this
  // review's persistence (found live 2026-07-26, chasing a consumer repo whose
  // audit_runs rows all showed real, non-zero rounds/findings — the audit
  // itself genuinely ran — but `gemini_verdict`/`final_review_model` were NULL
  // on every one of 101 runs across 30 days). Root cause: `runId` simply
  // defaults to null when `--run-id` is omitted (a manual, easy-to-forget CLI
  // flag — the caller must extract `_cloudRunId` from the audit --out JSON and
  // pass it through), and `runShadowAndPersist`'s cloud-write guard
  // (`if (!runId) return`) then no-ops with ZERO signal that anything was
  // skipped. The review still runs, still prints a real verdict — it just
  // never reaches the store, silently, every time, indistinguishable from a
  // deliberate "cloud is off" run. Warn loudly instead of vanishing quietly;
  // this is advisory only (never blocks a review) — the same "audit your
  // success paths" doctrine as everything else this session hardened.
  //
  // Warning alone was NOT enough (proven the same day it shipped): a session
  // already holding a stale SKILL.md kept omitting the flag, and the warning
  // scrolled past unread. So recover the id from the marker the audit itself
  // wrote — no agent cooperation required — and only warn when that also fails.
  if (shouldWarnMissingRunId({ mode, runId, cloudEnabled: await isCloudEnabled() })) {
    const rec = canAttemptRunIdRecovery({ auditMode })
      ? recoverRunIdFromMarker({ marker: readGateEvidenceMarker(process.cwd()), nowMs: Date.now() })
      : { runId: null, reason: 'plan-mode-has-no-marker' };
    if (rec.runId) {
      runId = rec.runId;
      console.error(
        `  [gemini-review] no --run-id supplied; recovered ${runId} from ${GATE_EVIDENCE_RELPATH} `
        + '(written by this audit). Persisting to that run.\n'
      );
    } else {
      console.error(MISSING_RUN_ID_WARNING);
      console.error(`  [gemini-review] (marker fallback also unavailable: ${rec.reason})\n`);
    }
  }
  if (mode !== 'review' || !planFile || !transcriptFile) {
    console.error('Usage: node scripts/gemini-review.mjs review <plan-file> <transcript-file> [--json] [--out <file>] [--provider gemini|azure-claude|anthropic|openai-compatible|openrouter] [--mode plan|code] [--role adjudicator-only] [--run-id <audit_runs.id>] [--envelope-scope full|thin|gap] [--campaign-digest <hex>]');
    console.error('       node scripts/gemini-review.mjs set-provider <gemini|azure-claude|anthropic|openai-compatible|openrouter|default>');
    console.error('       node scripts/gemini-review.mjs ping');
    process.exit(1);
  }
  if (auditMode !== 'plan' && auditMode !== 'code') {
    console.error(`Error: --mode must be "plan" or "code", got "${auditMode}"`);
    process.exit(1);
  }
  if (role !== null && role !== 'adjudicator-only') {
    console.error(`Error: --role must be "adjudicator-only", got "${role}"`);
    process.exit(1);
  }

  // Test-only deterministic fixture path (Phase 12) — accepted ONLY under
  // NODE_ENV=test, skips all real provider construction / network calls.
  if (providerOverride === 'fixture') {
    if (process.env.NODE_ENV !== 'test') {
      console.error('Error: --provider fixture is test-only (requires NODE_ENV=test).');
      process.exit(1);
    }
    return runFixtureReview({ transcriptFile, outFile, jsonMode });
  }

  // Arm the hard-deadline watchdog for the whole review (incl. cloud persistence)
  // so a detached background run can never hang — the harness gives it no reaper.
  armReviewWatchdog();

  // CLI --provider wins; else the persistent FINAL_REVIEW_PROVIDER setting; else auto-detect.
  const provider = selectProvider(providerOverride || resolveProviderSetting());
  const planContent = readFileOrDie(planFile);
  const transcriptContent = readFileOrDie(transcriptFile);
  await initAuditBrief();
  const projectContext = readProjectContext();
  const client = await buildClient(provider);

  try {
    // `--role adjudicator-only` routes through the sibling wrapper that
    // injects the role-specific system-prompt addendum; default (no --role)
    // is byte-identical to today (runReviewWithRetry, unchanged call).
    const runReview = role === 'adjudicator-only' ? runAdjudicatorOnlyReview : runReviewWithRetry;
    const r = await runReview(provider, client, planContent, transcriptContent, projectContext, auditMode);
    const { result, usage, latencyMs, transcriptContent: usedTranscript } = r;
    await applyDebtSuppression(result, usedTranscript);
    await applyScopeFilter(result, usedTranscript);
    applyExistenceGate(result);
    addSemanticIds(result, provider);
    // Primary reviewer's resolved concrete model id (for source_model attribution).
    const primaryModel = provider === 'gemini' ? MODEL
      : provider === 'azure-claude' ? azureConfig.claudeDeployment
      : CLAUDE_OPUS_MODEL;
    // Shadow reviewer + cloud persistence — runs BEFORE emit so the --out
    // artifact carries the _shadow block (R1 M1). Observation-only for an
    // ACTUAL PROVIDER CALL failure — that half still never throws out (its own
    // try/catch keeps the primary review unaffected). NOT observation-only for
    // a config-level campaign-safety refusal (invalid/gap scope under
    // --campaign-digest): that throws PAST this call, past the outer catch
    // below, to a non-zero exit — deliberately losing this arm's otherwise-good
    // primary result too, because the whole point is "nothing about this arm
    // invocation should be trusted" when its own campaign config is wrong.
    // Phase 4: resolved UNCONDITIONALLY (independent of FINAL_REVIEW_SHADOW,
    // round-6 audit H4) — a non-null result overrides the ordinary shadow
    // resolution for this invocation only when a Tier A/B eval is active.
    const modelEvalOverride = await resolveModelEvalShadowOverride();
    // `runReviewWithRetry` is this file's own function — shadow.mjs cannot
    // import it without a permanent cross-file cycle (see shadow.mjs's
    // fileoverview), so it is threaded through as an explicit dependency.
    await runShadowAndPersist(result, primaryModel, runId, { planContent, transcriptContent: usedTranscript, projectContext, auditMode }, { modelEvalOverride, envelopeScopeCli, campaignDigest, runReviewWithRetry });
    emitReviewOutput(result, usage, latencyMs, provider, jsonMode, outFile);
    recordGeminiOutcomes(result, primaryModel);
    await finishAndExit(0); // guarantee termination — never rely on natural drain
  } catch (err) {
    // Route-enriched for the Azure provider (a bare 401/404 there names neither
    // the endpoint nor the credential variable); byte-identical `err.message`
    // for every other provider. This path already avoids the worse failure —
    // it never emits a review verdict — so what was missing was attribution,
    // not a new artifact contract.
    console.error(`Error: ${describeTransportFailure(err, provider)}`);
    await finishAndExit(1);
  }
}

// Test-only exports for the shadow A/B internals (mirrors the project's
// _internals pattern, e.g. anthropic-client.mjs). Underscore signals private.
export const _internals = {
  resolveShadow,
  shadowErrorBlock,
  diffFindingBuckets,
  dedupByHash,
  shadowModelMatchesFamily,
  SHADOW_PROVIDER_SPECS,
  resolveModelEvalShadowOverride,
  mapRouteToShadowProvider,
  buildShadowClient,
  GEMINI_THINKING_BUDGET_BY_EFFORT,
  runShadowAndPersist,
  buildFinalReviewPersistPayload,
  callReviewer,
  REVIEW_TRANSPORTS,
  PING_TRANSPORTS,
  PROVIDERS,
  resolveCompatCreds,
  resolveOpenRouterCreds,
  AnthropicReviewToolSchema,
  streamAnthropicMessage,
};

// Auto-run only when invoked directly (node scripts/gemini-review.mjs ...),
// not when imported by a test — lets tests exercise selectProvider() in-process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
