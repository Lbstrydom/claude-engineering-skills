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
import { GoogleGenAI } from '@google/genai';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ProducerFindingSchema, zodToGeminiSchema } from './lib/schemas.mjs';
import { zodToOpenAiJsonSchema, sanitizeSchemaName, isResponseFormatUnsupported } from './lib/oss-structured-output.mjs';
import { buildClassificationRubric } from './lib/prompt-seeds.mjs';
import { readFileOrDie, readFilesAsContext, extractPlanPaths, writeOutput, isAuditInfraFile, atomicWriteFileSync } from './lib/file-io.mjs';
import { semanticId, formatFindings, appendOutcome, FalsePositiveTracker } from './lib/findings.mjs';
import { affectedFilesOf, primaryFileOf, matchFindings } from './lib/finding-match.mjs';
import { normalizeGeminiUsage } from './lib/gemini-usage.mjs';
import { readProjectContext, initAuditBrief, generateRepoProfile } from './lib/context.mjs';
import { applyEnvSetting } from './lib/env-setting.mjs';
import { geminiConfig, claudeConfig, azureConfig, shadowReviewConfig, finalReviewConfig, auditShadowConfig, findingMatchConfig, FINDING_MATCH_SCHEMA_VERSION } from './lib/config.mjs';
import { describeAzureRoute, describeTransportFailure } from './lib/azure-route-report.mjs';
import { recordFinalReviewFindings } from './learning-store.mjs';
import {
  refreshModelCatalog, resolveModel, resolveXaiCreds, resolveAlibabaCreds, isAlibabaModel,
  resolveDeepseekCreds, isDeepseekModel,
} from './lib/model-resolver.mjs';
import { createOpenAIClient } from './lib/openai-client.mjs';
import { createAnthropicClient } from './lib/anthropic-client.mjs';
import { azureThrottle } from './lib/azure-throttle.mjs';
import { PromptBandit } from './bandit.mjs';
import { getActivePrompt, getActiveRevisionId, bootstrapFromConstants } from './lib/prompt-registry.mjs';
import { getRepoContext } from './lib/repo-context.mjs';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';
import { RUN_ID_RE } from './lib/commit-trailers.mjs';
import { GATE_EVIDENCE_RELPATH } from './lib/audit/gate-evidence.mjs';
import { resolveRepoIdentity } from './lib/repo-identity.mjs';
import { verifyExistenceFindings, isRefuted } from './lib/audit/finding-verification.mjs';
import { listRepoFiles } from './lib/repo-inventory.mjs';
import { isCloudEnabled } from './lib/store/repo.mjs';
import { getActiveEvalRunId } from './lib/store/model-eval.mjs';
import { resolveCandidateRoute } from './lib/model-eval/route-catalog.mjs';
import { appendModelEvalShadowObservation } from './lib/model-eval/finalize-shadow-eval.mjs';
import { statSync } from 'node:fs';
import { resolveAndClassify, classifyPath } from './lib/sensitive-paths.mjs';
import { redactSecretsWithCount } from './lib/sensitive-egress-gate.mjs';
import {
  resolveEnvelopeScope, isReducedScope, isNonBlindScope, selectInScopeCodeFiles,
} from './lib/final-review/scope.mjs';
import {
  buildReviewEnvelope, THIN_CODE_MAX_CHARS, THIN_CODE_MAX_PER_FILE,
} from './lib/final-review/envelope.mjs';
import { serializePrimaryForGap } from './lib/final-review/gap-projection.mjs';
import { classifyLlmError } from './lib/robustness.mjs';
// NOTE: lib/llm-wrappers.mjs provides shared wrappers for learning/refinement/evolution paths.
// This module keeps the specialized `callReviewer` seam (thinkingConfig + one
// abort-correct timeout across all transports) because the final review requires
// high-budget reasoning and precise, background-safe timeout/termination handling.

// ── Configuration (from centralized config) ─────────────────────────────────

// `let` not `const` — reassigned in main() after refreshModelCatalog()
// pulls the live provider catalog, so we always use the newest available
// model instead of whatever STATIC_POOL knew about at last commit.
let MODEL = geminiConfig.model;
let CLAUDE_OPUS_MODEL = claudeConfig.finalReviewModel;
// `const`, unlike the two above — there is no live-catalog fetcher for xAI
// (deliberate, see XAI_POOL's docstring in model-resolver.mjs: the endpoint
// mixes chat and non-chat models with no uniform version grammar, so a
// maintainer-curated single-entry pool is the right-sized choice), so nothing
// refreshes this after the initial resolution. `resolveModel('latest-grok')`
// still honours XAI_MODEL env override and reads XAI_POOL's head.
const XAI_MODEL = resolveModel('latest-grok');
const TIMEOUT_MS = geminiConfig.timeoutMs;
const MAX_OUTPUT_TOKENS = geminiConfig.maxOutputTokens;

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

// ── Schemas ────────────────────────────────────────────────────────────────────
// FindingSchema + FindingJsonSchema imported from shared.mjs (single source of truth).
// Gemini-specific schemas use explicit JSON Schema — no Zod private API walking.

const WronglyDismissedSchema = z.object({
  original_finding_id: z.string().max(10).describe('The GPT finding ID that was dismissed (e.g. H3, M5)'),
  reason_claude_was_wrong: z.string().max(800).describe('Why Claude should not have dismissed this'),
  recommended_severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  evidence_basis: z.string().max(600).optional().describe(
    'Required if the transcript shows Claude challenged this finding with cited evidence. ' +
    'Explain NEW counter-evidence not already addressed in Claude\'s challenge. ' +
    'Omitting this on a previously-challenged finding signals reassertion without new evidence.'
  ),
  cited_lines: z.array(z.string().max(100)).max(10).optional().describe(
    'Specific line references cited in your reasoning (e.g. ["auth.js:132", "auth.js:137"]). ' +
    'Include these so hallucinated citations can be detected and flagged post-hoc.'
  ),
});

// Exported so tests/provider-contract-enforceable.test.mjs can assert it stays
// refinement-free (evidence-anchor-path-contract §7d). It is handed to a
// provider via z.toJSONSchema below, and z.toJSONSchema drops `.refine`/
// `.superRefine` SILENTLY — the guard is what stops that recurring here.
// Export-only; the module's CLI stays behind its import.meta.url guard.
export const GeminiFinalReviewSchema = z.object({
  verdict: z.enum(['APPROVE', 'CONCERNS', 'CONCERNS_REMAINING', 'REJECT']),

  deliberation_quality: z.object({
    claude_bias_detected: z.boolean().describe('Did Claude dismiss valid findings to protect its own code?'),
    gpt_false_positive_count: z.number().describe('How many GPT findings were noise or incorrect?'),
    deliberation_was_fair: z.boolean().describe('Was the Claude-GPT deliberation balanced overall?'),
    quality_summary: z.string().max(2000).describe('Brief assessment of the deliberation process')
  }),

  new_findings: z.array(ProducerFindingSchema).max(10).describe('Issues neither Claude nor GPT caught. Max 10, only genuinely new.'),

  wrongly_dismissed: z.array(WronglyDismissedSchema).max(10).describe('GPT findings Claude dismissed but were actually valid'),

  over_engineering_flags: z.array(z.string().max(500)).max(10).describe('Places where audit pressure caused unnecessary complexity'),

  architectural_coherence: z.enum(['Strong', 'Adequate', 'Weak']),
  overall_reasoning: z.string().max(3000).describe('Comprehensive final assessment')
});

// Derived from GeminiFinalReviewSchema — single source of truth via Zod → JSON Schema
const GeminiFinalReviewJsonSchema = zodToGeminiSchema(GeminiFinalReviewSchema);

// The OpenAI-compatible dialect of the SAME Zod source of truth. Deliberately
// NOT `GeminiFinalReviewJsonSchema`: `zodToGeminiSchema` strips `maxLength` /
// `additionalProperties` / etc. for Gemini's dialect, and an OpenAI-compatible
// router wants the unstripped draft schema.
//
// Why this exists (experiment-4, 2026-07-28): the openai transport only ever
// appended "Output strictly valid JSON" to the system prompt and hoped. Opus
// complies because the anthropic transport FORCES a `submit_review` tool call
// carrying the real schema — so the OpenAI-side arms were being judged against
// a contract they were never given. Measured: kimi-k3 returned
// `{file,title,description,evidence}` and glm-5.2 returned
// `{title,description,evidence_basis,cited_lines}`, neither carrying the
// `category`/`section`/`risk`/`recommendation` the finding taxonomy and R2+
// suppression ledger key on — and Zod validation here is warn-and-keep, so
// those degraded rows flow into the store silently.
const OpenAiFinalReviewJsonSchema = zodToOpenAiJsonSchema(GeminiFinalReviewSchema);

/**
 * Anthropic forced-tool-use `input_schema` — the SAME Zod source of truth as
 * the Gemini schema above, but a different dialect on purpose.
 * `zodToGeminiSchema` strips `maxLength`/`additionalProperties`/etc. for
 * Gemini's restricted subset; Anthropic accepts standard JSON Schema, and the
 * length hints are worth keeping (the provider does not enforce them — see the
 * anthropic transport — but they steer the model, and `truncateToSchema` is
 * still the actual enforcement downstream).
 *
 * `$schema` is dropped: it is metadata, not a constraint, and tool `input_schema`
 * has no use for it.
 */
const AnthropicReviewToolSchema = (() => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(GeminiFinalReviewSchema);
  return rest;
})();

/** Tool name for the Anthropic structured-review call. Exported for tests. */
export const ANTHROPIC_REVIEW_TOOL_NAME = 'submit_review';

/**
 * Anthropic's minimum cacheable prefix for the Opus/Sonnet tiers. A
 * `cache_control` marker on a shorter prefix is accepted, billed at the write
 * premium, and never read back — the "provably inert" class `efficacy-lints`
 * exists to catch. Mirrors `DEFAULT_CONFIG.modelMinTokens` in
 * scripts/lib/efficacy-lints.mjs; keep the two in step.
 */
export const ANTHROPIC_MIN_CACHEABLE_TOKENS = 1024;

// ── Schema-driven truncation ──────────────────────────────────────────────────
// Gemini verbosity regularly exceeds field maxLength constraints, causing Zod to
// reject the entire response. Instead of failing, we truncate verbose fields and
// log what was shortened. Map is built from the raw JSON Schema (before Gemini
// stripping removes maxLength) so it stays in sync with the Zod definitions.

/**
 * Walk a JSON Schema tree and collect all path → maxLength entries.
 * Handles nested objects, arrays (path[]), and $defs references.
 * @param {object} schema - Raw JSON Schema node
 * @param {string} path - Dot-path to current node
 * @param {Map<string,number>} map - Accumulator
 * @param {object} [defs] - Top-level $defs for $ref resolution
 */
function _collectMaxLengths(schema, path, map, defs) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) {
    const refName = schema.$ref.replace('#/$defs/', '');
    if (defs?.[refName]) _collectMaxLengths(defs[refName], path, map, defs);
    return;
  }
  if (schema.type === 'string' && schema.maxLength) {
    map.set(path, schema.maxLength);
  }
  if (schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      _collectMaxLengths(v, path ? `${path}.${k}` : k, map, defs);
    }
  }
  if (schema.items) {
    _collectMaxLengths(schema.items, `${path}[]`, map, defs);
  }
}

const _rawGeminiReviewSchema = z.toJSONSchema(GeminiFinalReviewSchema);
const _maxLengthMap = new Map();
_collectMaxLengths(_rawGeminiReviewSchema, '', _maxLengthMap, _rawGeminiReviewSchema.$defs);

/**
 * Recursively walk a parsed JSON result and truncate strings that exceed their
 * schema-defined maxLength. Returns a new object (no mutation). Logs truncations.
 * @param {*} obj
 * @param {string} path
 * @param {string[]} truncated - Accumulator for log messages
 * @returns {*}
 */
function truncateToSchema(obj, path, truncated) {
  if (typeof obj === 'string') {
    const max = _maxLengthMap.get(path);
    if (max && obj.length > max) {
      truncated.push(`${path} (${obj.length} → ${max})`);
      return obj.slice(0, max);
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => truncateToSchema(item, `${path}[]`, truncated));
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = truncateToSchema(v, path ? `${path}.${k}` : k, truncated);
    }
    return out;
  }
  return obj;
}

// No verifySchemaSync needed — JSON Schema is derived from Zod, drift is impossible.

// ── System Prompt ──────────────────────────────────────────────────────────────

const REVIEW_SYSTEM = `You are an independent quality reviewer — the FINAL GATE in a multi-model audit pipeline.

CONTEXT: A software engineer (Claude) created work based on a plan. A separate auditor (GPT-5.4) reviewed it and raised findings. Claude then deliberated on each finding — accepting some, challenging others. GPT ruled on the challenges (sustain/overrule/compromise). The loop repeated until convergence.

IMPORTANT — AUDIT MODE AWARENESS:
If the transcript contains a PLAN audit (no code files, only plan text), your job is to assess PLAN QUALITY — completeness, soundness, specificity, risk coverage. Do NOT judge whether code implements the plan. A plan audit evaluates the plan itself. The plan describes what WILL BE built — absent implementations are expected.
If the transcript contains a CODE audit (code files present), assess CODE QUALITY — correctness, security, architecture, maintainability.

YOUR JOB: Review the FULL audit transcript and render an independent verdict. You have NO stake in either model's output.

WHAT TO LOOK FOR:

1. **Claude Bias Detection** — Did Claude dismiss valid GPT findings with motivated reasoning?
   Signs: vague rebuttals ("this is fine"), appeals to authority ("I know this codebase"),
   severity downgrades without evidence, accepting the letter but not spirit of a finding.

2. **GPT False Positives** — Did GPT raise findings that were genuinely wrong?
   Not everything GPT flags is real. Count the noise.

3. **Missed Issues** — What did BOTH models miss? Look for:
   - Security: injection, auth bypass, data leaks, missing input validation
   - Data integrity: race conditions, missing transactions, partial updates
   - Error handling: swallowed errors, missing edge cases
   - Architecture: god functions, tight coupling, leaky abstractions
   - Performance: N+1 queries, unbounded loops, missing pagination

4. **Wrongly Dismissed** — GPT findings that Claude dismissed but were actually valid.
   Check the dismissed/overruled findings especially carefully.

5. **Over-Engineering** — Did the audit pressure cause Claude to add unnecessary complexity?
   Extra abstractions nobody asked for, premature optimisation, defensive code for impossible scenarios.

6. **Architectural Coherence** — Does the final code hang together as a system?
   Cross-file consistency, naming patterns, data flow clarity.

VERDICT GUIDE:
- APPROVE: Plan/code is production-ready. Minor issues at most. Deliberation was fair.
- CONCERNS: Fixable issues found, Gemini is confident they need attention before proceeding.
- CONCERNS_REMAINING: Mixed picture — at least one valid finding, but other findings were challenged
  by the author with cited evidence. Use this when a blanket REJECT would be unfair because some
  findings are legitimately disputed. Author decides whether disputed items need fixing before proceeding.
- REJECT: Significant unambiguous issues — missed bugs, clear bias in deliberation, or architectural
  problems that need human judgment. A single valid finding alongside legitimately challenged others
  does NOT warrant REJECT — use CONCERNS_REMAINING instead.

RULES:
1. Be ruthlessly honest but fair. Neither model is always right or always wrong.
2. Only raise genuinely NEW findings — do not re-raise what GPT already found (even if phrased differently).
3. Quality over quantity — 3 real findings beat 10 vague ones.
4. Quick-fix detection still applies — flag band-aids.
5. If the deliberation was fair and the plan/code is good, say APPROVE. Don't manufacture issues.
6. If the prompt includes a "Pre-filtered Debt" section, DO NOT re-raise any topic listed there.
   Those concerns are pre-existing, operator-deferred, and tracked outside this audit's scope.
   They were explicitly filtered from the transcript by the upstream pipeline.
7. Wrongly-dismissed escalation cap: If the transcript shows Claude challenged a dismissed finding
   with cited code evidence (file paths, line numbers, existing code), you MUST either:
   (a) Accept the challenge — do not include it in wrongly_dismissed, OR
   (b) Provide genuinely NEW counter-evidence in the evidence_basis field that was NOT addressed
       by Claude's challenge. Re-asserting the prior position without new evidence is not acceptable.
   Populate cited_lines with any specific line references you use, so hallucinated citations
   can be detected. If you cite "line 132" of a file, it must actually contain relevant code.
   PROVENANCE REQUIREMENT: every wrongly_dismissed entry must EITHER (i) cite a concrete
   prior dismissed finding by its original_finding_id, OR (ii) name an explicit deliberation
   error in the transcript. If the entry's evidence_basis cites code in a file NOT in
   "Files In Scope (PR diff)", the evidence_basis MUST also state the linkage to a
   changed file (e.g. "imported by <changed-file>", "consumed by <changed-file>'s call to X").
   Entries that are neither traceable to a prior finding nor linked to in-scope code
   should NOT be raised — they are scope-creep, not missed cross-cutting analysis.
8. Scope discipline: when the prompt contains a "Files In Scope (PR diff)" section, every
   new_findings entry MUST cite a file from that list. Files outside that list are inlined ONLY
   for context (e.g. referenced by the plan or used as dependencies) — issues there are
   pre-existing, NOT this PR's responsibility. Cross-cutting concerns that a PR change BREAKS
   in an in-scope-adjacent file belong in the in-scope file's finding (cite both files in the
   description), not as a standalone finding pointing at the unchanged file. Findings whose
   primary file is out-of-scope will be filtered post-hoc and counted as scope errors.`;

// Bootstrap prompt registry for Gemini review (enables variant selection + evolution)
bootstrapFromConstants({ 'gemini-review': REVIEW_SYSTEM });

// ── Plan Audit Mode Override ───────────────────────────────────────────────────
// Appended to system prompt when --mode plan is passed. Overrides the generic
// "AUDIT MODE AWARENESS" section with an explicit, hard-to-ignore constraint.

const PLAN_MODE_BLOCK = `

## PLAN AUDIT MODE — MANDATORY CONSTRAINTS

You are reviewing a PLAN DOCUMENT, not implemented code.

THE PLAN DESCRIBES FUTURE INTENT. Everything in the plan is describing what WILL BE built.
Items the plan says "add", "create", "implement" or "define" DO NOT EXIST YET — that is the
entire point of the plan. Their absence from the current codebase is expected and correct.

WHAT THIS MEANS FOR YOUR REVIEW:
- DO NOT flag absent implementations as bugs. If the plan says "add SolverInvariantError to
  domainErrors.js", the absence of SolverInvariantError in domainErrors.js is not a bug —
  it is what the plan is for.
- DO NOT cite current codebase line numbers as evidence of plan flaws. The plan is not the code.
  If you cite a line number, it must be a line in the PLAN DOCUMENT itself, not in a source file.
- DO evaluate: Is the plan internally consistent? Are its contracts complete? Are there logical
  gaps, ambiguous APIs, missing error paths, or unresolved dependencies between proposed components?
- DO flag: Missing contracts between components the plan introduces, ambiguous data flows,
  steps that assume dependencies not defined in the plan, or logical impossibilities.

VERDICT CALIBRATION FOR PLAN AUDITS:
- REJECT requires genuine logical flaws in the plan (circular dependencies, ambiguous contracts,
  missing critical error paths). It does NOT apply when the plan simply hasn't been implemented yet.
- CONCERNS_REMAINING is appropriate when some findings are about plan soundness and others
  are disputed (e.g. one model expected code to exist, another correctly identified a plan gap).`;

// ── Role addendum (Phase 12 — `--role adjudicator-only`) ───────────────────
// Module-level, process-lifetime-scoped mutable toggle read by
// `getReviewPrompt()` below. `runAdjudicatorOnlyReview` (defined further
// down, alongside `runShadowReview`) sets this immediately before calling
// `runReviewWithRetry`/`runFinalReview` and resets it in a `finally` —
// `runFinalReview`'s OWN body is never touched (it already calls
// `getReviewPrompt()` with no arguments; only what that call returns
// changes). Default `null` → `getReviewPrompt()` is byte-identical to
// today. Safe because this CLI never runs two reviews concurrently within
// one process (the shadow reviewer runs sequentially AFTER the primary).

let _roleAddendum = null;

const ADJUDICATOR_ONLY_ADDENDUM = `

## ADJUDICATOR-ONLY MODE (Stage 2 — tiered-recall audit pipeline)

You are NOT reviewing a full Claude-GPT deliberation transcript here — you are
re-verifying exactly ONE candidate from an automated tiered-recall audit
pipeline's Stage 1 cheap-model triage, OR inspecting one "clean region" file
no discovery-portfolio model flagged at all.

YOUR JOB:
1. If "Audit Transcript" contains one finding under \`rounds[0].findings\`:
   decide whether it describes a genuine, real issue. If a prior automated
   pass dismissed this exact finding and you believe that dismissal was
   WRONG, populate \`wrongly_dismissed\` citing its \`id\` EXACTLY as given
   (the \`original_finding_id\` field). If you agree it is correctly
   dismissed, or it is a genuine still-open issue you have nothing new to
   add about, leave \`wrongly_dismissed\` empty for it.
2. If "Audit Transcript" contains ZERO findings under \`rounds[0].findings\`
   (a "clean region" sample): this file was never flagged by any prior pass.
   Inspect it fresh. Only populate \`new_findings\` if you find a genuine,
   concrete, real defect — do not manufacture findings to appear thorough;
   an empty \`new_findings\` is the expected, common outcome here.
3. This is a single-item verification pass, not a full audit — keep
   \`new_findings\` empty unless you are in the clean-region case above.`;

/**
 * Get the active review prompt — from registry if a promoted variant exists,
 * otherwise falls back to the static REVIEW_SYSTEM constant. Appends the
 * role addendum (Phase 12) when `runAdjudicatorOnlyReview` has one active.
 * @returns {string}
 */
function getReviewPrompt() {
  const base = getActivePrompt('gemini-review') || REVIEW_SYSTEM;
  return _roleAddendum ? `${base}\n${_roleAddendum}` : base;
}

// ── Unified reviewer call seam (one abort-correct path for every provider) ───
//
// Replaces the former per-provider callGemini/callClaudeOpus/callAzureClaude,
// which re-implemented timeout three ways (Gemini aborted; the other two used a
// leaky Promise.race that never cancelled the losing streaming request). Now:
//   - ONE AbortController + per-attempt timeout, threaded into every SDK call.
//   - a timeout PROMISE backstop guarantees callReviewer rejects at TIMEOUT_MS
//     even if a given SDK ignores the signal (the abort still best-effort tears
//     the socket down for SDKs that honour it — gemini, openai, anthropic-sdk).
//   - one shared parse (fence-strip → truncate → Zod) and one redacted error.
// A new provider is a small `REVIEW_TRANSPORTS` adapter, not a 4th timeout copy.

/**
 * Robustly extract the review JSON from a model response (G2 + audit-code
 * Gemini-gate G1). Must survive: clean JSON (Gemini responseSchema; well-behaved
 * models), an OUTER ```json fence (OSS models via OpenRouter), AND inner ``` code
 * fences inside finding fields (recommendation/evidence snippets). We deliberately
 * do NOT use lib/requirements/llm-json.mjs's `parseLlmJson` here: its lazy
 * `([\s\S]*?)` fence regex stops at the FIRST inner closing fence and truncates
 * a review payload whose findings contain code blocks.
 * @param {string} text
 * @returns {object} parsed JSON — throws (→ truncation-retry) if unrecoverable
 */
function parseReviewJson(text) {
  const raw = String(text ?? '').trim();
  // 1. Clean JSON — the common case (Gemini responseSchema, strict models).
  try { return JSON.parse(raw); } catch { /* fall through */ }
  // 2. Outer ```json fence, GREEDY to the LAST fence so inner ``` snippets in
  //    findings don't cause premature truncation (the G1 bug class).
  const fence = raw.match(/```(?:json)?\s*([\s\S]*)\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ }
  }
  // 3. Fence-agnostic final attempt: the first '{' … last '}' object span.
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) return JSON.parse(raw.slice(first, last + 1));
  throw new SyntaxError('no JSON object found in review response');
}

/**
 * Per-transport adapters. Each maps the normalized input to its installed-SDK
 * request and returns `{ text, usage:{input_tokens,output_tokens,thinking_tokens}, finishReason }`.
 * No adapter re-reads files or re-assembles a prompt — it receives the single
 * egress envelope (`userPrompt`) built once in runFinalReview (C3/egress safety).
 */
/**
 * Map the shared `reasoningEffort` dial onto Gemini's token-budget knob.
 *
 * Gemini has no `effort` parameter, so the dial has to be expressed in the one
 * unit it does accept. `high` is pinned to 16384 — the value this reviewer has
 * always used — so adopting the shared dial leaves the Gemini arm byte-identical
 * and changes only the arm that was actually mis-set.
 *
 * Approximate by construction: a token budget and an effort level are not the
 * same quantity, and no mapping makes them one. It buys comparable DEPTH across
 * arms, not identical compute — read a bake-off accordingly.
 */
const GEMINI_THINKING_BUDGET_BY_EFFORT = Object.freeze({ low: 4096, medium: 8192, high: 16384 });

const REVIEW_TRANSPORTS = {
  async gemini(client, { model, maxTokens, systemPrompt, userPrompt, jsonSchema, signal }) {
    // Streaming supports maxOutputTokens > 21333 (non-streaming SDK ceiling).
    const stream = await client.models.generateContentStream({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: jsonSchema,
        maxOutputTokens: maxTokens,
        thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET_BY_EFFORT[finalReviewConfig.reasoningEffort] },
      },
    }, { signal });
    const textParts = [];
    let usageMetadata = null;
    for await (const chunk of stream) {
      if (chunk.text) textParts.push(chunk.text);
      if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
    }
    // Delegated to the shared oracle (gemini-usage.mjs). The inline fix that
    // landed in 1a89c1ac was correct but was a SECOND place that knew what
    // "billed output" means; folding it in leaves exactly one.
    const g = normalizeGeminiUsage(usageMetadata);
    return {
      text: textParts.join(''),
      usage: {
        input_tokens: g.input_tokens,
        // BILLED output, which for Google means candidates PLUS thoughts —
        // `candidatesTokenCount` excludes `thoughtsTokenCount`, and Google bills
        // both at the output rate. Reading only candidates understated this
        // reviewer by ~2.5x on real runs (measured: 310 candidate tokens beside
        // 17,792 thought tokens on bake-off snapshot 21245f6aae1c), which is not
        // a rounding error when the readout exists to compare arms on cost.
        //
        // This makes `output_tokens` mean the same thing on all three
        // transports: Anthropic and OpenAI already fold reasoning into their
        // output counts, and `thinking_tokens` stays the informational share
        // WITHIN that total rather than a separate addend. Any consumer summing
        // the two would double-count on every provider, which is why the shared
        // cost oracle deliberately does not.
        output_tokens: g.output_tokens,
        thinking_tokens: g.thinking_tokens,
        usageMissing: g.usageMissing,
      },
      finishReason: null,
    };
  },

  async anthropic(client, { model, maxTokens, systemPrompt, userPrompt, toolSchema, signal }) {
    // FORCED TOOL-USE, not a prompt instruction (2026-07-26). Gemini gets a real
    // `responseSchema`; this transport used to get only "Output strictly valid
    // JSON", which enforces nothing. Opus duly returned a review whose finding
    // objects were missing the REQUIRED `category`/`section` and had an empty
    // `detail`. Zod here is warn-and-keep (see callReviewer), so the malformed
    // object flowed downstream and the DB INSERT hit `category NOT NULL`,
    // rolling back the whole persistence tx — losing the PRIMARY reviewer's
    // findings too. Tool-use makes the provider enforce object shape, which is
    // exactly the missing guarantee.
    //
    // Anthropic validates SHAPE provider-side but NOT `maxLength` (same caveat
    // as `tiered-provider-calls.mjs::createSonnetDiscoveryCall`) — length is
    // handled downstream by `truncateToSchema`, so no clamping is needed here.
    //
    // REQUIRES the sdk backend: `CLAUDE_BACKEND=cli` silently drops
    // `tools`/`tool_choice` (AGENTS.md "Anthropic Backend Routing"), which would
    // return prose and defeat this entirely. `buildShadowClient` pins it; the
    // primary-reviewer anthropic fallback builds via `createAnthropicClient()`
    // and is guarded by the readiness assertion below.
    const useTool = Boolean(toolSchema);
    // PROMPT CACHING (opt-in — finalReviewConfig.promptCache; see the config
    // comment for why it is a cost PENALTY when left on for single-shot runs).
    //
    // One breakpoint, on the last (only) user block. Anthropic's cacheable
    // prefix is tools → system → messages in that order, so a breakpoint here
    // covers the whole request, which is what the two byte-identical bake-off
    // Opus calls need. A second breakpoint would buy nothing: there is no
    // shorter prefix that a later request shares but this one does not.
    //
    // Guarded on an ESTIMATED length, never applied blind. Below Opus's 1024-
    // token minimum cacheable prefix the marker is silently INERT — accepted by
    // the API, billed at the 1.25x write premium, and never read back. The
    // chars/4 estimate is the same one this file already prints at call time and
    // it UNDER-reads for Claude (measured: a prompt Gemini tokenized at 54,288
    // Claude tokenized at 81,182), so erring low means we occasionally skip a
    // cacheable prompt and never mark an inert one.
    const cacheable = finalReviewConfig.promptCache
      && Math.floor(userPrompt.length / 4) >= ANTHROPIC_MIN_CACHEABLE_TOKENS;
    const req = {
      model,
      max_tokens: maxTokens,
      // Explicit, not inherited. Opus 5 thinks whenever `thinking` is omitted,
      // so this path was ALREADY reasoning at the API default — it just never
      // said so, and the hardcoded `thinking_tokens: 0` below made it look
      // disabled. Stating the effort puts this arm on the same dial as the
      // others instead of on a default that can move under us.
      output_config: { effort: finalReviewConfig.reasoningEffort },
      system: useTool
        ? `${systemPrompt}\n\nSubmit your review by calling the submit_review tool. Every field is required.`
        : `${systemPrompt}\n\nOutput strictly valid JSON. No markdown fences.`,
      messages: [{
        role: 'user',
        content: cacheable
          ? [{ type: 'text', text: userPrompt, cache_control: { type: 'ephemeral' } }]
          : userPrompt,
      }],
    };
    if (useTool) {
      req.tools = [{
        name: ANTHROPIC_REVIEW_TOOL_NAME,
        description: 'Submit the structured final-review result. All fields are required.',
        input_schema: toolSchema,
      }];
      // `auto`, NOT forced — measured 2026-08-03, three runs on one prompt:
      // no tools 127 thinking tokens, tools+auto 45, tools+FORCED 0. Forcing the
      // call silently disables reasoning on Opus 5 (no error, no warning), so the
      // shadow reviewer was being asked to adjudicate a whole audit with thinking
      // off while the primary ran a 16K budget. That is not a model comparison.
      //
      // Forcing was introduced to stop Opus returning findings missing REQUIRED
      // fields, which rolled back the persistence tx and lost the PRIMARY's
      // findings too. That guarantee survives: `tool_choice` governs WHETHER the
      // tool is called, not whether its input validates — the provider enforces
      // input_schema on any call it makes. The case `auto` reopens is the model
      // answering in prose instead, and that is already a loud throw below
      // (retried by runReviewWithRetry), never a malformed write.
      req.tool_choice = { type: 'auto' };
    }
    // Stream — non-streaming create() throws above the SDK's max_tokens ceiling.
    const r = await streamAnthropicMessage(client, req, { signal });

    let text;
    if (useTool) {
      const toolUse = r.content?.find((b) => b.type === 'tool_use' && b.name === ANTHROPIC_REVIEW_TOOL_NAME);
      if (!toolUse?.input) {
        // stop_reason:'max_tokens' is the truncation signature — surfaced so a
        // recurrence is diagnosable from the message alone (same rationale as
        // the tiered discovery generator's error).
        throw new Error(
          `anthropic response contained no ${ANTHROPIC_REVIEW_TOOL_NAME} tool call `
          + `(stop_reason: ${r.stop_reason ?? 'unknown'}). Under CLAUDE_BACKEND=cli the `
          + 'tools/tool_choice params are silently dropped — this transport needs the sdk backend.'
        );
      }
      // Re-serialize so the shared downstream path (parse → truncate → Zod) is
      // byte-identical across transports; parseReviewJson handles clean JSON first.
      text = JSON.stringify(toolUse.input);
    } else {
      text = r.content?.find((b) => b.type === 'text')?.text?.trim() || '{}';
    }

    return {
      text,
      usage: {
        input_tokens: r.usage?.input_tokens ?? 0,
        output_tokens: r.usage?.output_tokens ?? 0,
        // Anthropic reports UNCACHED input in `input_tokens` and puts cached
        // tokens in these two fields instead. Carrying them is not optional
        // bookkeeping: on a cache HIT `input_tokens` collapses to a few hundred,
        // so a cost derived from it alone would read a full 81K-token review as
        // near-free — a fabricated saving in exactly the shape of a measurement.
        // costFromUsage prices all three at their real multipliers.
        cache_creation_input_tokens: r.usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: r.usage?.cache_read_input_tokens ?? 0,
        // READ, never assumed. This was hardcoded to 0, and the zero happened to
        // be CORRECT for the wrong reason — not because the path declined
        // thinking (Opus 5 thinks by default) but because forced tool_choice
        // suppressed it. A constant that is only accidentally right cannot show
        // you when it stops being right: the moment tool_choice moved to `auto`
        // the same literal would have under-reported real reasoning as zero.
        // `?? 0` is the genuine absent case (a transport reporting no count).
        thinking_tokens: r.usage?.output_tokens_details?.thinking_tokens ?? 0,
      },
      finishReason: r.stop_reason ?? null,
    };
  },

  async openai(client, { model, maxTokens, systemPrompt, userPrompt, signal, requestExtras, openAiJsonSchema }) {
    // OpenAI-shaped chat.completions — Azure Foundry (openai shape) + every
    // OpenAI-compatible gateway (OpenRouter/Together/Fireworks/Groq/vLLM/…).
    // azureThrottle is a no-op off the Azure path.
    const sys = `${systemPrompt}\n\nOutput strictly valid JSON. No markdown fences.`;
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }],
      // Gateway-specific body fields (today: OpenRouter provider routing +
      // reasoning control). Undefined on every other route, so Azure/compat
      // requests stay byte-identical to before this existed.
      ...(requestExtras || {}),
    };
    // Ask for the schema, don't just describe it in prose. Opt-in per descriptor
    // (`structuredOutput: true`) so Azure Foundry's openai shape — which shares
    // this adapter — is untouched. `strict: false` matches oss-structured-output:
    // the schema guides generation without the provider rejecting benign extras.
    if (openAiJsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: sanitizeSchemaName('final_review'), schema: openAiJsonSchema, strict: false },
      };
    }

    let r;
    try {
      r = await azureThrottle(() => client.chat.completions.create(body, { signal }));
    } catch (err) {
      // A router that rejects `response_format` must still produce a review —
      // degrade once to the prompt-only contract rather than failing the gate.
      // Reuses oss-structured-output's predicate, which requires a structured-
      // output keyword in the message so an unrelated 400 (bad model, quota) is
      // never silently masked as a format downgrade.
      if (!openAiJsonSchema || !isResponseFormatUnsupported(err)) throw err;
      process.stderr.write(`  [final-review] "${model}" rejected response_format:json_schema — retrying prompt-only\n`);
      delete body.response_format;
      r = await azureThrottle(() => client.chat.completions.create(body, { signal }));
    }
    // TRUNCATION IS SILENT OTHERWISE. `finish_reason:'length'` means the model
    // was cut off mid-answer; the JSON that survives may still parse, so the
    // caller sees a short but well-formed review and reads it as "found little"
    // rather than "was stopped". Reasoning tokens are billed INSIDE this budget
    // on OpenRouter, so a high effort setting makes the cut-off likelier, not
    // just the answer better.
    const finish = r.choices?.[0]?.finish_reason ?? null;
    if (finish === 'length') {
      process.stderr.write(`  [final-review] WARNING: "${model}" hit max_tokens (finish_reason=length) — `
        + 'the review is TRUNCATED. Findings after the cut are lost, not absent.\n');
    }
    return {
      text: r.choices?.[0]?.message?.content?.trim() || '{}',
      usage: {
        input_tokens: r.usage?.prompt_tokens ?? 0,
        output_tokens: r.usage?.completion_tokens ?? 0,
        // READ, not assumed — the same fabricated zero that hid the Anthropic
        // arm's reasoning hid this one too. It matters more here: OpenRouter
        // counts reasoning against `max_tokens`, so this number is the share of
        // the output budget NOT available for findings. A shadow that looks
        // unproductive may simply have spent its budget thinking.
        thinking_tokens: r.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      },
      finishReason: finish,
      finishReason: r.choices?.[0]?.finish_reason ?? null,
    };
  },
};

/**
 * Make a single final-review call through the unified transport seam.
 * Same `{result, usage, latencyMs}` contract the callers already expect.
 *
 * @param {object} client - provider SDK client (from the descriptor's buildClient)
 * @param {object} opts
 * @param {'gemini'|'anthropic'|'openai'} opts.transportKind
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt - the single egress envelope (already sensitive-filtered)
 * @param {z.ZodType} [opts.zodSchema]
 * @param {object} [opts.jsonSchema] - only used by the gemini transport (responseSchema)
 * @param {object} [opts.toolSchema] - only used by the anthropic transport
 *   (forced tool-use `input_schema`). Separate from `jsonSchema` because the
 *   two providers take different dialects of the same Zod source; omitting it
 *   degrades that transport to the old prompt-instruction mode.
 * @param {string} [opts.passName]
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function callReviewer(client, { transportKind, model, systemPrompt, userPrompt, zodSchema, jsonSchema, toolSchema, passName, requestExtras, openAiJsonSchema }) {
  const startMs = Date.now();
  const label = passName || 'final-review';
  const adapter = REVIEW_TRANSPORTS[transportKind];
  if (!adapter) throw new Error(`[${label}] unknown transport kind "${transportKind}"`);

  process.stderr.write(`  [${label}] Starting ${transportKind} ${model} (timeout: ${(TIMEOUT_MS / 1000).toFixed(0)}s)...\n`);

  // One controller for the attempt; the watchdog can reach it to release the
  // socket on a hard-deadline. The timeout PROMISE is the guaranteed rejection
  // (fires even if a given SDK ignores the abort signal); abort() is the
  // best-effort socket teardown for SDKs that honour it.
  const controller = new AbortController();
  _activeReviewController = controller;
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      try { controller.abort('timeout'); } catch { /* ignore */ }
      reject(new Error(`Timeout after ${(TIMEOUT_MS / 1000).toFixed(0)}s`));
    }, TIMEOUT_MS);
  });

  try {
    const raw = await Promise.race([
      adapter(client, { model, maxTokens: MAX_OUTPUT_TOKENS, systemPrompt, userPrompt, jsonSchema, toolSchema, signal: controller.signal, requestExtras, openAiJsonSchema }),
      timeoutPromise,
    ]);
    const latencyMs = Date.now() - startMs;

    // Shared post-step: fence-strip + parse (G2 — OSS models via OpenRouter
    // routinely wrap output in a ```json fence despite the instruction) →
    // truncate over-long fields → Zod validate (warn-and-keep; truncateToSchema
    // already coerces the common overflow case).
    let result;
    try {
      result = parseReviewJson(raw.text);
    } catch (parseErr) {
      throw new Error(`Failed to parse ${transportKind} JSON response: ${parseErr.message}\nRaw: ${String(raw.text).slice(0, 500)}`);
    }
    const truncated = [];
    result = truncateToSchema(result, '', truncated);
    if (truncated.length > 0) {
      process.stderr.write(`  [${label}] Auto-truncated ${truncated.length} fields: ${truncated.join(', ')}\n`);
    }
    if (zodSchema) {
      const validated = zodSchema.safeParse(result);
      if (validated.success) result = validated.data;
      else process.stderr.write(`  [${label}] Zod validation warning: ${validated.error.message.slice(0, 200)}\n`);
    }

    const usage = { ...raw.usage, latency_ms: latencyMs };
    process.stderr.write(`  [${label}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out / ${usage.thinking_tokens} thinking)\n`);
    return { result, usage, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const isAbort = err.name === 'AbortError' || err.message?.toLowerCase().includes('abort') || err.message?.startsWith('Timeout after');
    // Redacted error normalization — surface provider status + message, NEVER
    // the baseURL / key / endpoint identity.
    const detail = err.status
      ? `HTTP ${err.status}${err.message ? `: ${err.message}` : ''}`
      : (err.message || 'unknown error');
    const msg = isAbort
      ? `[${label}] ${controller.signal.reason === 'hard-deadline' ? 'Hard-deadline abort' : `Timeout after ${(TIMEOUT_MS / 1000).toFixed(0)}s`}`
      : `[${label}] ${detail} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${label}] FAILED: ${msg}\n`);
    const wrapped = new Error(msg);
    if (err.status) wrapped.status = err.status; // preserve for classifyLlmError (404 → non-retryable)
    // A timeout must stay classifiable AFTER the wrap. `classifyLlmError` reads
    // `name`/`code` to reach its `timeout` branch, and both are lost here — the
    // wrapped error carries only a message, so every abort was classified
    // `permanent`, indistinguishable from a bad model id. Anything keying on
    // that verdict (the bake-off collector's automatic retry) would therefore
    // refuse to retry the one failure class that is worth retrying, and
    // matching the message prose instead would be a second, silently-diverging
    // classifier. Setting the structured fields hits `classifyLlmError`'s FIRST
    // branch, so this stays one oracle rather than two.
    if (isAbort) { wrapped.llmCategory = 'timeout'; wrapped.llmRetryable = true; }
    throw wrapped;
  } finally {
    clearTimeout(timeoutHandle);
    _activeReviewController = null;
  }
}

/**
 * Consume an Anthropic streaming Messages response, returning the SAME
 * `{content: [{type:'text', text}], usage}` shape a non-streaming
 * `messages.create()` produces — so call sites need no other change.
 *
 * Why streaming is mandatory: MAX_OUTPUT_TOKENS (32000) exceeds the Anthropic
 * SDK's non-streaming ceiling (~21333 — the SDK's 10-minute heuristic), which
 * makes a plain `create()` throw "Streaming is required for operations that may
 * take longer than 10 minutes". The Gemini path already streams for the same
 * reason. Affects BOTH the public Opus path and the Azure Foundry Claude path.
 *
 * The Foundry client is the redactor-wrapped adapter that exposes only
 * `.messages.create()` (not `.stream()`), so we request `stream: true` through
 * create(). A non-streaming adapter (e.g. the cli backend) that ignores
 * `stream:true` and returns a final message is handled by the iterator guard.
 */
async function streamAnthropicMessage(client, params, { signal } = {}) {
  const resp = await client.messages.create({ ...params, stream: true }, signal ? { signal } : undefined);
  // Adapter ignored stream:true (e.g. cli backend) → already a final message.
  if (!resp || typeof resp[Symbol.asyncIterator] !== 'function') return resp;
  let text = '';
  let stopReason = null;
  // TOOL-USE REASSEMBLY (2026-07-26). This reader used to accumulate only
  // `text_delta` events and return a hardcoded single text block, silently
  // DROPPING any `tool_use` block and `stop_reason`. That made forced tool-use
  // structurally impossible through this path however correct the request was:
  // the caller always saw an empty text block and reported "no tool call".
  // A streamed tool call arrives as `content_block_start` (type:'tool_use') then
  // a run of `input_json_delta` fragments that must be concatenated and parsed.
  const toolBlocks = new Map(); // block index → { name, json }
  // `output_tokens_details` carries the reasoning-token count. It is accumulated
  // here rather than assumed, because this reader BUILDS the usage object it
  // returns — a field it does not copy simply does not exist downstream, which
  // is how the caller ended up reporting a hardcoded `thinking_tokens: 0` for a
  // model that was in fact thinking. Left null when the provider omits it, so
  // "not reported" stays distinguishable from "measured zero".
  const usage = {
    input_tokens: 0, output_tokens: 0,
    // Both halves of the cache ledger. `cache_read_input_tokens` was the missing
    // one, and its absence is worse than a wrong number: on a cache hit the
    // provider moves the prefix OUT of `input_tokens` into this field, so a
    // reader that drops it reports a full-size review as a few hundred input
    // tokens. Same class as the hardcoded `thinking_tokens: 0` below — a field
    // this builder does not copy simply does not exist downstream.
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    output_tokens_details: null,
  };
  for await (const event of resp) {
    if (event.type === 'message_start') {
      usage.input_tokens = event.message?.usage?.input_tokens ?? usage.input_tokens;
      usage.cache_creation_input_tokens =
        event.message?.usage?.cache_creation_input_tokens ?? usage.cache_creation_input_tokens;
      usage.cache_read_input_tokens =
        event.message?.usage?.cache_read_input_tokens ?? usage.cache_read_input_tokens;
      stopReason = event.message?.stop_reason ?? stopReason;
      usage.output_tokens_details = event.message?.usage?.output_tokens_details ?? usage.output_tokens_details;
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      toolBlocks.set(event.index, { name: event.content_block.name, json: '' });
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') {
        text += event.delta.text;
      } else if (event.delta?.type === 'input_json_delta') {
        const block = toolBlocks.get(event.index);
        if (block) block.json += event.delta.partial_json ?? '';
      }
    } else if (event.type === 'message_delta') {
      usage.output_tokens = event.usage?.output_tokens ?? usage.output_tokens;
      // Later events win: message_delta carries the CUMULATIVE totals, so a
      // details block here supersedes anything seen at message_start.
      usage.output_tokens_details = event.usage?.output_tokens_details ?? usage.output_tokens_details;
      stopReason = event.delta?.stop_reason ?? stopReason;
    }
  }
  const content = [];
  for (const block of toolBlocks.values()) {
    let input;
    try {
      input = block.json ? JSON.parse(block.json) : {};
    } catch (err) {
      // Truncation is the overwhelmingly likely cause (max_tokens reached
      // mid-JSON), so name it — a silent `{}` here would look like a model that
      // returned an empty review.
      throw new Error(
        `tool_use "${block.name}" streamed malformed JSON (${err.message}); `
        + `stop_reason: ${stopReason ?? 'unknown'} — usually max_tokens truncation`
      );
    }
    content.push({ type: 'tool_use', name: block.name, input });
  }
  // Text block preserved only when non-empty: the non-tool path reads it with a
  // `|| '{}'` fallback, and an empty block would mask a dropped tool call.
  if (text) content.push({ type: 'text', text });
  return { content, usage, stop_reason: stopReason };
}

// ── Provider descriptor catalog (single source of truth) ────────────────────
//
// One immutable descriptor per provider is THE source of truth for identity,
// label, transport, model resolution, readiness, and client construction —
// selectProvider / buildClient / formatReviewResult / dispatch all derive from
// it, so adding a provider is one entry (+ only a new transport adapter if the
// wire shape is genuinely new). `resolveModel`/`transportKind` are functions so
// they read live module state (MODEL/CLAUDE_OPUS_MODEL are reassigned in main()
// after the catalog refresh; the azure transport depends on the resolved shape).
const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    transportKind: () => 'gemini',
    resolveModel: () => MODEL,
    assertReady: (env = process.env) => {
      if (!env.GEMINI_API_KEY) { console.error('Error: provider "gemini" requires GEMINI_API_KEY'); process.exit(1); }
    },
    buildClient: async () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
  },
  'claude-opus': {
    id: 'claude-opus',
    label: 'Claude Opus',
    transportKind: () => 'anthropic',
    resolveModel: () => CLAUDE_OPUS_MODEL,
    assertReady: (env = process.env) => {
      if (!env.ANTHROPIC_API_KEY) { console.error('Error: provider "anthropic" requires ANTHROPIC_API_KEY'); process.exit(1); }
    },
    buildClient: async () => {
      process.stderr.write(`  [final-review] GEMINI_API_KEY missing; using Claude Opus fallback (${CLAUDE_OPUS_MODEL}).\n`);
      // `backend:'sdk'` PINNED, exactly as buildShadowClient does — the PRIMARY
      // path was left on the ambient CLAUDE_BACKEND and is broken twice over
      // under `cli`: that transport silently drops tools/tool_choice (so the
      // provider-side schema enforcement this reviewer depends on vanishes,
      // AGENTS.md "Anthropic Backend Routing"), and it passes the prompt as a
      // process argument, which a ~50K-token review exceeds — observed
      // 2026-08-03 as `'claude' exited 1: The command line is too long`.
      //
      // This is the reviewer the loop falls back to when GEMINI_API_KEY is
      // absent, so on any machine running CLAUDE_BACKEND=cli the final gate had
      // no working fallback at all. The shadow path was pinned on 2026-07-26;
      // the primary was missed because it is only reached without a Gemini key.
      return createAnthropicClient({ backend: 'sdk' });
    },
  },
  'azure-claude': {
    id: 'azure-claude',
    label: 'Azure Foundry Claude',
    transportKind: () => (azureConfig.claudeApiShape === 'anthropic' ? 'anthropic' : 'openai'),
    resolveModel: () => azureConfig.claudeDeployment,
    assertReady: () => assertAzureClaudeReady(),
    buildClient: async () => {
      const route = azureConfig.claudeRoute;
      process.stderr.write(
        `  [final-review] Azure work profile — Claude via ${route.mode} route ` +
        `(${azureConfig.claudeApiShape} shape, ${azureConfig.claudeDeployment}, ` +
        `auth ${route.authMode} from ${route.credentialVar}).\n`);
      if (azureConfig.claudeApiShape === 'anthropic') {
        return createAnthropicClient({ azureRoute: route });
      }
      return createOpenAIClient({ purpose: 'foundry-claude' });
    },
  },
  // Generic OpenAI-compatible gateway (Together / Fireworks / Groq / vLLM /
  // Ollama / LM Studio / any OpenAI-shaped endpoint). Model id is passed to the
  // gateway verbatim (NO resolveModel sentinel rewrite — D6).
  'openai-compatible': {
    id: 'openai-compatible',
    // Ask for the schema rather than describing it in prose (experiment-4).
    structuredOutput: true,
    label: 'OpenAI-compatible',
    transportKind: () => 'openai',
    resolveModel: () => finalReviewConfig.model,
    assertReady: () => {
      const c = resolveCompatCreds();
      const missing = [];
      if (!c.baseUrl) missing.push('FINAL_REVIEW_BASE_URL');
      if (!c.apiKey) missing.push('FINAL_REVIEW_API_KEY');
      if (!c.model) missing.push('FINAL_REVIEW_MODEL');
      if (missing.length) {
        console.error(`Error: provider "openai-compatible" requires ${missing.join(' + ')}.`);
        process.exit(1);
      }
    },
    buildClient: async () => {
      const c = resolveCompatCreds();
      return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
    },
  },
  // OpenRouter convenience preset — the openai-compatible transport with the
  // baseURL prefilled and a fallback to the (globally scoped) OPENROUTER_API_KEY
  // that OTHER skills already use. That fallback is why this route is
  // EXPLICIT-SELECTION-ONLY (never auto-detect) — see G1 in selectProvider.
  openrouter: {
    id: 'openrouter',
    structuredOutput: true,
    label: 'OpenRouter',
    transportKind: () => 'openai',
    resolveModel: () => finalReviewConfig.model,
    assertReady: () => {
      const c = resolveOpenRouterCreds();
      const missing = [];
      if (!c.apiKey) missing.push('FINAL_REVIEW_API_KEY (or OPENROUTER_API_KEY)');
      if (!c.model) missing.push('FINAL_REVIEW_MODEL');
      if (missing.length) {
        console.error(`Error: provider "openrouter" requires ${missing.join(' + ')}.`);
        process.exit(1);
      }
    },
    buildClient: async () => {
      const c = resolveOpenRouterCreds();
      return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
    },
    // OpenRouter serves one model id from MANY backends with incompatible
    // limits, and picks per request. Measured 2026-07-28 while smoke-testing
    // kimi-k3/glm-5.2 as final reviewers:
    //   - `moonshotai/kimi-k3` is offered by Nebius at 8K context and by others
    //     at 1M. A 54K-token review routed to Nebius cannot succeed.
    //   - `z-ai/glm-5.2` is offered by AkashML at 96,890 — under a 106K review.
    //   - Same request, no pinning: Moonshot AI 15.5s vs Fireworks 5.0s. 3x.
    // So identical runs failed or passed at random, which reads as "the model
    // is flaky" when it is really the router.
    //
    // `require_parameters` drops backends that don't support what we send;
    // `sort: throughput` avoids the slow tail. Both are OpenRouter-only body
    // fields and are ignored by other OpenAI-compatible gateways.
    //
    // `reasoning.effort` is the load-bearing one for REASONING models.
    // Reasoning tokens are billed and counted against `max_tokens`, so kimi-k3
    // spent 597 of a 600-token budget thinking and emitted almost no answer.
    // At MAX_OUTPUT_TOKENS (32000) on a ~39 tok/s backend that is ~830s of
    // pure reasoning before the first byte of JSON — every timeout we saw.
    // The final reviewer wants a verdict, not a visible chain of thought.
    //
    // But `low` was tuned against a 600-token triager, and silently became the
    // setting under which `moonshotai/kimi-k2-thinking` was measured as a shadow
    // final reviewer: 3 runs, 0 findings. Re-run at `high` on an identical
    // transcript, it produced 3. A "thinking" model reviewed with thinking
    // turned down is evidence about the flag, not the model — so the depth is
    // now the shared `reasoningEffort` dial every provider reads.
    requestExtras: () => ({
      provider: { require_parameters: true, sort: 'throughput' },
      reasoning: { effort: finalReviewConfig.reasoningEffort },
    }),
  },
  // Native xAI — final-review shadow arm (plan KD-4). OpenAI-compatible chat
  // completions at api.x.ai; verified live 2026-08-14 (200 on /v1/models,
  // response_format:json_schema returns valid structured JSON, top-level
  // reasoning_effort accepted and moves reasoning_tokens in usage).
  xai: {
    id: 'xai',
    structuredOutput: true,
    label: 'xAI Grok',
    transportKind: () => 'openai',
    resolveModel: () => XAI_MODEL,
    assertReady: (env = process.env) => {
      if (!env.XAI_API_KEY) { console.error('Error: provider "xai" requires XAI_API_KEY'); process.exit(1); }
    },
    buildClient: async () => {
      const c = resolveXaiCreds();
      return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
    },
    // DELIBERATELY not the OpenRouter descriptor's requestExtras (KD-4). The
    // `provider`/`require_parameters`/`sort` fields are OpenRouter gateway-only
    // — xAI is a single direct endpoint, not a router selecting among upstream
    // backends, so those fields have no meaning here and a strict API could
    // reject them as unknown. `reasoning.effort` is also OpenRouter's NESTED
    // shape; xAI takes a FLAT top-level `reasoning_effort` string (verified
    // live) — nesting it as OpenRouter does would silently be ignored, which is
    // exactly the "accepted but inert" failure class the plan's pre-flight
    // (Phase 5) exists to catch, so getting the shape right here matters.
    requestExtras: () => ({ reasoning_effort: finalReviewConfig.reasoningEffort }),
  },
  // Native Alibaba Cloud Model Studio — replaces the OpenRouter route for the
  // qwen/deepseek bake-off arms (2026-08-17), after repeated 300s timeouts on
  // OpenRouter's routing for `qwen/qwen3.8-max` traced to the ROUTER, not the
  // model (same failure class the openrouter descriptor's own comment above
  // documents for kimi/glm). This is a per-account WORKSPACE gateway serving
  // several model families verbatim (Qwen, DeepSeek, GLM, Kimi) — closer in
  // shape to `openai-compatible` than to `xai`'s single fixed model, so there
  // is no `resolveModel` sentinel default; the concrete id always comes from
  // the caller (arm declaration or FINAL_REVIEW_SHADOW_MODEL).
  alibaba: {
    id: 'alibaba',
    structuredOutput: true,
    label: 'Alibaba Cloud (Model Studio)',
    transportKind: () => 'openai',
    resolveModel: () => finalReviewConfig.model,
    assertReady: (env = process.env) => {
      const missing = [];
      if (!env.ALIBABA_CLOUD_API_KEY) missing.push('ALIBABA_CLOUD_API_KEY');
      if (!env.ALIBABA_CLOUD_BASE_URL) missing.push('ALIBABA_CLOUD_BASE_URL');
      if (missing.length) { console.error(`Error: provider "alibaba" requires ${missing.join(' + ')}`); process.exit(1); }
    },
    buildClient: async () => {
      const c = resolveAlibabaCreds();
      return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
    },
    // Same non-router reasoning as xai above: one direct workspace endpoint,
    // not OpenRouter's many-backends-per-id router, so none of OpenRouter's
    // `provider`/`require_parameters`/`sort` fields apply.
    //
    // `enable_thinking: true` is EXPLICIT, and both halves of that matter
    // (2026-08-17, after 4 of 7 qwen collection attempts stalled to their
    // timeout ceiling — including once past a doubled 600s):
    //
    //  - **Explicit at all**, because Alibaba's OpenAI-compatible endpoint
    //    documents `enable_thinking` as a required top-level field for
    //    non-streaming calls to thinking-capable models, and every stalled
    //    call had left it unset. Live-measured at the failing size class
    //    (260K chars): unset → the observed stalls; explicitly `true` →
    //    7.2s with 163 reasoning tokens.
    //  - **`true`, never `false`**, because this is a MODEL COMPARISON arm.
    //    The campaign's `controls.reasoningEffort: 'high'` binds every arm
    //    and is hashed into the cohort's lock digest, so an arm quietly
    //    running with reasoning OFF would (a) measure the dial instead of
    //    the model — the campaign's own measured lesson, where one arm found
    //    0 findings at `low` and 3 at `high` on an identical transcript —
    //    and (b) make that digest attest a control the run did not honour.
    //    Faster and cheaper is NOT the goal here; comparability is.
    requestExtras: () => ({ enable_thinking: true }),
  },
  // Native DeepSeek — REPLACES the Alibaba-workspace route for this model
  // (2026-08-17): deepseek-v4-pro-0813 timed out at 300s twice via Alibaba at
  // real review size while qwen, on the identical request, succeeded both
  // times — a model-specific throughput issue on that workspace, not a
  // shared route problem. Direct to the source instead, mirroring xai: a
  // single known endpoint with a real default, not a multi-family gateway
  // like alibaba/openrouter. DeepSeek's OWN model ids carry no dated-snapshot
  // suffix (confirmed live against its /models endpoint: `deepseek-v4-pro`,
  // `deepseek-v4-flash` — the `-0813` pin was Alibaba's own workspace
  // convention, not DeepSeek's).
  deepseek: {
    id: 'deepseek',
    structuredOutput: true,
    label: 'DeepSeek (direct)',
    transportKind: () => 'openai',
    // No single sensible default (DEEPSEEK_POOL has two real choices —
    // v4-pro vs v4-flash), so — like alibaba, unlike xai's one true
    // default — this reads the ambient config rather than a sentinel.
    resolveModel: () => finalReviewConfig.model,
    assertReady: (env = process.env) => {
      if (!env.DEEPSEEK_API_KEY) { console.error('Error: provider "deepseek" requires DEEPSEEK_API_KEY'); process.exit(1); }
    },
    buildClient: async () => {
      const c = resolveDeepseekCreds();
      return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
    },
    // No routing-gateway extras (same reasoning as xai/alibaba above). Unlike
    // alibaba, deepseek's own API is confirmed (live, 2026-08-17) to REJECT
    // response_format:json_schema outright ("This response_format type is
    // unavailable now", HTTP 400) — but that 400 message contains the literal
    // substring `response_format`, so the EXISTING `isResponseFormatUnsupported`
    // degrade-to-prompt-only path (openai transport, above) already catches it
    // with no new code; json_object mode and prompt-only both confirmed 200
    // live. No reasoning-effort field: unverified whether one exists here,
    // so none is claimed.
    requestExtras: () => ({}),
  },
};

/** Review-scoped OpenAI-compatible creds (all explicit; validated in assertReady). */
function resolveCompatCreds() {
  return { baseUrl: finalReviewConfig.baseUrl, apiKey: finalReviewConfig.apiKey, model: finalReviewConfig.model };
}

/**
 * OpenRouter preset creds — baseURL prefilled; apiKey falls back to the shared
 * OPENROUTER_API_KEY ONLY after an explicit `openrouter` selection (G1). The
 * fallback never runs during auto-detect because selectProvider never
 * auto-selects this route.
 */
function resolveOpenRouterCreds() {
  return {
    baseUrl: finalReviewConfig.baseUrl || auditShadowConfig.openrouterBaseUrl,
    apiKey: finalReviewConfig.apiKey || auditShadowConfig.openrouterApiKey,
    model: finalReviewConfig.model,
  };
}

// `resolveXaiCreds` (base URL + credential) lives in model-resolver.mjs —
// NOT routed through resolveOpenRouterCreds/resolveCompatCreds, on purpose
// (plan: final-review-scoped-second-reviewer.md KD-4). Those two exist to let
// an operator point at an ARBITRARY gateway/base URL via env; xAI is a
// specific, known, closed-catalog provider with one real endpoint, so a
// fixed constant is the same choice this file already makes for `gemini` and
// `claude-opus` above — an endpoint and the credential it is addressed with
// are one unit (AGENTS.md). Shared with grok-effort-preflight.mjs (M4's fix)
// so the base URL and env var name have exactly one definition, not two that
// can silently drift apart.

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
  const renderCode = (paths) => (paths.length === 0
    ? ''
    : readFilesAsContext(paths, reduced
      ? { maxPerFile: THIN_CODE_MAX_PER_FILE, maxTotal: THIN_CODE_MAX_CHARS }
      : { maxPerFile: 8000, maxTotal: 100000 }));

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
  const envelopeAccounting = {
    ...built.accounting,
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
  });
  // Stamped on the RESULT, not just returned, so it survives every downstream
  // path unchanged — the primary's `--out` JSON spreads `{...result}`, and the
  // shadow block copies it explicitly. A value only on the return object would
  // be lost at the first hop that rebuilds its own envelope, which is exactly
  // how the shadow's cache-token counts went missing.
  call.result._requestFingerprint = requestFingerprint;
  call.result._envelope = envelopeAccounting;
  return { ...call, requestFingerprint, envelope: envelopeAccounting };
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

// ── Shadow Final Review (observation-only A/B) ──────────────────────────────
//
// Plan: docs/plans/final-review-shadow-reviewer.md. An opt-in SECOND reviewer
// that runs BLIND on the same transcript as the primary (never sees the
// primary's output), is attributed per source_model, and NEVER gates the
// build. Guarded so that with FINAL_REVIEW_SHADOW unset the shadow path is not
// entered at all (byte-identical to today), and a no-op under an active Azure
// profile (these models aren't on Foundry).

/**
 * Canonical provider specs keyed by the raw FINAL_REVIEW_SHADOW value.
 *
 * `canonical` is not cosmetic — it is the `PROVIDERS` key the shared review path
 * looks up (`runFinalReview`: `const descriptor = PROVIDERS[provider]`, then
 * `requestExtras: descriptor.requestExtras?.()`). So a spec whose canonical name
 * matches a PROVIDERS entry inherits that descriptor's wire behaviour for free —
 * which is exactly how `openrouter` gets its routing pins without any plumbing
 * here (verified by trace, docs/plans/final-review-credit-and-cheap-shadow.md §3).
 *
 * `hasCredential` replaces a bare `keyEnv` string because a GATEWAY has more than
 * one legitimate source for its key: the review-scoped `FINAL_REVIEW_API_KEY`
 * first, then the shared `OPENROUTER_API_KEY` other skills already use. It
 * returns a BOOLEAN only — the secret itself must never reach the resolver's
 * result object, the log line, or the persisted `_shadow` block.
 *
 * `gateway: true` marks a provider whose model ids are passed VERBATIM (descriptor
 * D6: no `resolveModel` sentinel rewrite), which has two consequences below: the
 * family regex cannot validate them, and there is no sensible per-provider
 * default, so an explicit `FINAL_REVIEW_SHADOW_MODEL` is required.
 */
const SHADOW_PROVIDER_SPECS = {
  'claude-opus': { canonical: 'claude-opus', family: 'claude', defaultSentinel: 'latest-opus', hasCredential: (env) => Boolean(env.ANTHROPIC_API_KEY) },
  'anthropic':   { canonical: 'claude-opus', family: 'claude', defaultSentinel: 'latest-opus', hasCredential: (env) => Boolean(env.ANTHROPIC_API_KEY) },
  'gemini':      { canonical: 'gemini',      family: 'gemini', defaultSentinel: 'latest-pro',  hasCredential: (env) => Boolean(env.GEMINI_API_KEY) },
  'openrouter':  {
    canonical: 'openrouter', family: 'gateway', gateway: true, defaultSentinel: null,
    hasCredential: (env) => Boolean(env.FINAL_REVIEW_API_KEY || env.OPENROUTER_API_KEY),
  },
  // Native xAI — NOT a gateway (unlike openrouter): xai is a single known
  // endpoint with a real default model, so `defaultSentinel: 'latest-grok'`
  // means FINAL_REVIEW_SHADOW=xai with no FINAL_REVIEW_SHADOW_MODEL is
  // perfectly usable, matching claude-opus/gemini's behaviour above rather
  // than openrouter's "explicit model required" refusal.
  'xai': { canonical: 'xai', family: 'xai', defaultSentinel: 'latest-grok', hasCredential: (env) => Boolean(env.XAI_API_KEY) },
  // Native Alibaba — like `openrouter`, a `gateway` (verbatim model ids, no
  // sensible single default across Qwen/DeepSeek/GLM/Kimi) but NOT actually a
  // multi-backend router like OpenRouter is — see the PROVIDERS.alibaba
  // descriptor's own note on why its requestExtras stays empty. `gateway:
  // true` here buys the same "no default, explicit model required, bypass
  // resolveModel's sentinel rewrite" behaviour openrouter already gets from
  // `resolveShadow`, which is exactly what a verbatim-id, no-default provider
  // needs regardless of whether it is itself a router.
  'alibaba': {
    canonical: 'alibaba', family: 'alibaba', gateway: true, defaultSentinel: null,
    hasCredential: (env) => Boolean(env.ALIBABA_CLOUD_API_KEY && env.ALIBABA_CLOUD_BASE_URL),
  },
  // Native DeepSeek — also `gateway: true` (no single default across
  // v4-pro/v4-flash), but its own family so a mismatched model (e.g. a
  // qwen id) is rejected rather than silently accepted.
  'deepseek': {
    canonical: 'deepseek', family: 'deepseek', gateway: true, defaultSentinel: null,
    hasCredential: (env) => Boolean(env.DEEPSEEK_API_KEY),
  },
};

/** Cheap family check so an explicit model can't be paired with a wrong provider (R3 M1). */
function shadowModelMatchesFamily(modelId, family) {
  const id = (modelId || '').toLowerCase();
  // A gateway serves every family and takes ids verbatim (`moonshotai/kimi-k2-thinking`),
  // so there is no family to match against — the guard here is the REQUIRED
  // explicit model in resolveShadow, not a name pattern.
  if (family === 'gateway') return true;
  if (family === 'gemini') return id.includes('gemini');
  if (family === 'xai') return id.includes('grok');
  // Unlike the gateway/xai/gemini checks above (name-pattern or blanket
  // accept), `alibaba` has an authoritative source of truth to defer to: the
  // SAME curated `ALIBABA_POOL` allowlist `transportForModel` consults, so
  // this check can never diverge from what the runner actually recognises.
  if (family === 'alibaba') return isAlibabaModel(id);
  if (family === 'deepseek') return isDeepseekModel(id);
  // claude family — opus/sonnet/haiku today, mythos/fable when they land.
  return /claude|opus|sonnet|haiku|mythos|fable/.test(id);
}

/**
 * Resolve the shadow reviewer config into a concrete plan, or a skip reason.
 * Never throws (optional feature must not break the mandatory audit path).
 * Deps are injectable for tests (mirrors selectProvider).
 * @param {{shadowConfig?: object, env?: object, azureActive?: boolean, resolve?: Function}} [deps]
 * @returns {{provider: string|null, model: string|null, family?: string, state: string}}
 */
function resolveShadow({
  shadowConfig = shadowReviewConfig,
  env = process.env,
  azureActive = azureConfig.active,
  resolve = resolveModel,
} = {}) {
  const raw = shadowConfig.provider;
  if (!raw) return { provider: null, model: null, state: 'skipped-unset' };
  // Azure guard (load-bearing): Claude/Fable/Mythos are not on Foundry.
  if (azureActive) return { provider: raw, model: null, state: 'skipped-azure' };
  const spec = SHADOW_PROVIDER_SPECS[raw];
  if (!spec) return { provider: raw, model: null, state: 'skipped-unsupported-provider' };
  // Credential presence via the spec's own resolver — a gateway legitimately has
  // two sources. Boolean only; the value never enters this result.
  if (!spec.hasCredential(env)) return { provider: spec.canonical, model: null, state: 'skipped-no-key' };
  // A GATEWAY has no meaningful default model: ids are passed verbatim, so there
  // is nothing to derive and guessing one would send an unintended model at the
  // operator's expense. Refuse explicitly instead — a named skip, never a silent
  // default (docs/plans/final-review-credit-and-cheap-shadow.md §3.2).
  if (spec.gateway && !shadowConfig.model) {
    return { provider: spec.canonical, model: null, state: 'skipped-no-model' };
  }
  // Derive the model: explicit override (validated against family) or per-
  // provider default. config injects NO default, so an unset model means
  // "derive from provider" (Gemini R2 G3).
  let model;
  if (shadowConfig.model) {
    // Gateways bypass resolveModel entirely (descriptor D6): a sentinel rewrite
    // would mangle `moonshotai/kimi-k2-thinking` into something the gateway has
    // never heard of.
    model = spec.gateway ? shadowConfig.model : resolve(shadowConfig.model, { silent: true });
    if (!shadowModelMatchesFamily(model, spec.family)) {
      return { provider: spec.canonical, model, state: 'skipped-unsupported-provider' };
    }
  } else {
    model = resolve(spec.defaultSentinel, { silent: true });
  }
  return { provider: spec.canonical, model, family: spec.family, state: 'ready' };
}

/**
 * Build a provider-appropriate client for the shadow reviewer.
 * `'azure-claude'` (model-swap-eval-harness Phase 4) mirrors buildClient's
 * existing azure-claude branch exactly (below, the PRIMARY reviewer's
 * client builder) — this was the actual "no-op under Azure" gap the plan's
 * round-1 audit M3 fix closes: the shadow path never had ANY Azure support
 * before this, unlike the primary reviewer path which already did.
 */
async function buildShadowClient(canonicalProvider) {
  if (canonicalProvider === 'gemini') {
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  if (canonicalProvider === 'openrouter') {
    // Delegates to the PRIMARY route's own credential resolver rather than
    // re-deriving the baseURL/key here — one definition of "how do we reach
    // OpenRouter", so the shadow can never drift onto a different endpoint than
    // the primary. Note `buildShadowClient` deliberately does NOT call
    // `PROVIDERS[...].buildClient`/`assertReady`; the openrouter descriptor's
    // assertReady demands FINAL_REVIEW_MODEL (the PRIMARY's model), which a
    // shadow run has no reason to set. Readiness for this path is enforced in
    // resolveShadow instead — see its credential + explicit-model checks.
    const c = resolveOpenRouterCreds();
    return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
  }
  if (canonicalProvider === 'azure-claude') {
    if (azureConfig.claudeApiShape === 'anthropic') {
      return createAnthropicClient({ azureRoute: azureConfig.claudeRoute });
    }
    return createOpenAIClient({ purpose: 'foundry-claude' });
  }
  if (canonicalProvider === 'xai') {
    // Same non-delegation note as openrouter above: buildShadowClient does NOT
    // call PROVIDERS.xai.assertReady/buildClient — that descriptor's assertReady
    // is a plain env check the shadow path duplicates in resolveShadow's own
    // hasCredential, so calling both would just be two places to keep in sync.
    const c = resolveXaiCreds();
    return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
  }
  if (canonicalProvider === 'alibaba') {
    // Same non-delegation note as openrouter/xai above.
    const c = resolveAlibabaCreds();
    return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
  }
  if (canonicalProvider === 'deepseek') {
    // Same non-delegation note as openrouter/xai/alibaba above.
    const c = resolveDeepseekCreds();
    return createOpenAIClient({ oss: { baseURL: c.baseUrl, apiKey: c.apiKey } });
  }
  // `backend:'sdk'` PINNED, never the ambient CLAUDE_BACKEND (found live
  // 2026-07-26 on the shadow's first real run). This transport gets its JSON
  // contract from a PROMPT INSTRUCTION ("Output strictly valid JSON") with no
  // provider-side enforcement — Gemini has `responseSchema`, Anthropic here has
  // nothing. Under `CLAUDE_BACKEND=cli` the call is served by a conversational
  // `claude -p`, which returned a markdown report ("# Final Gate Review … ##
  // Verdict: **APPROVE**") — no JSON object anywhere, so `parseReviewJson`
  // threw and the observation was dropped as `error-unavailable`. The shadow
  // stayed enabled and silently recorded NOTHING: precisely the dead-experiment
  // failure mode the A/B exists to avoid, and the same class as the tiered
  // pipeline's discovery generator (AGENTS.md: any call needing a structured
  // response must pin the sdk backend explicitly).
  //
  // Cost note: this bills ANTHROPIC_API_KEY rather than drawing Max-20x Agent
  // SDK credit. Accepted deliberately — the pre-registered window is ~20 runs,
  // and a shadow that produces no parseable verdict has zero value at any price.
  return createAnthropicClient({ backend: 'sdk' });
}

// ── Model-eval adjudicator Tier A/B override (model-swap-eval-harness
// Phase 4) ───────────────────────────────────────────────────────────────
//
// Round-6 audit H4 fix (the plan's own self-correction): gating discovery
// behind FINAL_REVIEW_SHADOW would defeat its own purpose — an operator
// starts a Tier A/B eval today, but the /audit-code runs that need to
// collect shadow observations happen days/weeks later, in ordinary
// sessions where FINAL_REVIEW_SHADOW was never set (that env var is the
// OPERATOR's manual shadow-reviewer choice, unrelated to whether an eval
// run is active). So this resolves UNCONDITIONALLY whenever cloud is
// configured — independent of FINAL_REVIEW_SHADOW — and its result
// OVERRIDES (never requires) any FINAL_REVIEW_SHADOW setting. A null
// result (the common case) falls through to today's ordinary
// resolveShadow() behavior, byte-identical to pre-plan.
//
// Only maps to the THREE provider strings runFinalReview's prompt dispatch
// already supports (gemini / claude-opus / azure-claude) — an
// openai-compatible-transport adjudicator candidate (a GPT-family
// candidateSpec) has no existing prompt-building branch in this file and
// is deliberately NOT wired here; model-eval-adjudicator.mjs falls back to
// Tier C for that transport rather than this file growing a fourth
// provider dispatch branch for a case the plan's primary use case (an
// Azure Claude candidate) doesn't need.
/**
 * Pure — maps a resolved route to one of the three provider strings
 * runFinalReview's prompt dispatch supports, or null when the transport has
 * no live-shadow prompt path yet. Extracted as its own function so the
 * mapping logic is directly unit-testable without a live DB/active eval run.
 */
function mapRouteToShadowProvider(route) {
  if (route.transport === 'native-gemini') return 'gemini';
  if (route.transport === 'native-anthropic') return route.provider === 'azure' ? 'azure-claude' : 'claude-opus';
  return null;
}

async function resolveModelEvalShadowOverride() {
  if (!await isCloudEnabled()) return null;
  let repoId;
  try {
    repoId = resolveRepoIdentity().repoUuid;
  } catch {
    return null; // not a git repo / no identity resolvable — never fatal
  }
  const active = await getActiveEvalRunId({ repoId, role: 'adjudicator' });
  if (!active) return null;

  let route;
  try {
    route = resolveCandidateRoute({ role: 'adjudicator', candidateSpec: active.candidateRef.candidateSpec });
  } catch (err) {
    process.stderr.write(`  [model-eval-shadow] active run ${active.runId}: candidate route failed to resolve — ${err.message}\n`);
    return null;
  }

  const provider = mapRouteToShadowProvider(route);
  if (!provider) {
    process.stderr.write(`  [model-eval-shadow] active run ${active.runId}: transport "${route.transport}" has no live-shadow prompt path yet (Tier C only) — skipping override\n`);
    return null;
  }

  return {
    repoId, modelEvalRunId: active.runId,
    shadow: { provider, model: route.deploymentId ?? route.resolvedModel, state: 'ready' },
  };
}

/**
 * Run the shadow review on the same transcript as the primary, then apply the
 * identical suppression/scope/semantic-id pipeline so finding counts are
 * comparable. Returns {result, usage, latencyMs}.
 *
 * BLINDNESS IS SCOPE-DEPENDENT — do not read the old unconditional claim here.
 * `full` and `thin` are BLIND: the primary's result is not a parameter of this
 * function and is never forwarded, so blindness is structural rather than
 * conventional. `gap` deliberately surrenders it — the mode's whole job is
 * "what did the primary miss?", which cannot be asked without showing it the
 * primary's findings. That trade is why `gap` is campaign-INELIGIBLE: a shadow
 * conditioned on its own arm's stochastic primary is not comparable across arms.
 */
async function runShadowReview(shadow, planContent, transcriptContent, projectContext, auditMode, options = {}) {
  const client = await buildShadowClient(shadow.provider);
  const r = await runReviewWithRetry(
    shadow.provider, client, planContent, transcriptContent, projectContext, auditMode, shadow.model, options
  );
  const { result, usage, latencyMs, requestFingerprint, transcriptContent: usedTranscript } = r;
  await applyDebtSuppression(result, usedTranscript);
  await applyScopeFilter(result, usedTranscript);
  applyExistenceGate(result);
  addSemanticIds(result, shadow.provider);
  return { result, usage, latencyMs, requestFingerprint };
}

/**
 * Dedup a reviewer's findings by semantic hash (R3 M2 — no count inflation).
 * A finding is normally pre-stamped with `_hash` by addSemanticIds(); if one
 * arrives without it (defensive — a programming error upstream), we compute
 * semanticId(f) as a fallback rather than SILENTLY DROPPING it (cluster-A R2 H1
 * — silent data loss). Only a truly empty/nullish entry is skipped.
 */
function dedupByHash(findings) {
  const seen = new Map();
  for (const f of (findings || [])) {
    if (!f) continue;
    const key = f._hash || semanticId(f);
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

/**
 * Classify each reviewer's findings into both / primary-only / shadow-only by
 * semantic-hash set membership (after per-reviewer dedup). Stamps `_bucket` on
 * each finding. The SINGLE writer of the three bucket literals (R3 M5).
 */
function diffFindingBuckets(primaryResult, shadowResult) {
  const p = dedupByHash(primaryResult?.new_findings);
  const s = dedupByHash(shadowResult?.new_findings);
  const pHashes = new Set(p.map((f) => f._hash));
  const sHashes = new Set(s.map((f) => f._hash));
  for (const f of p) f._bucket = sHashes.has(f._hash) ? 'both' : 'primary-only';
  for (const f of s) f._bucket = pHashes.has(f._hash) ? 'both' : 'shadow-only';
  return {
    primary: p,
    shadow: s,
    counts: {
      both: p.filter((f) => f._bucket === 'both').length,
      primaryOnly: p.filter((f) => f._bucket === 'primary-only').length,
      shadowOnly: s.filter((f) => f._bucket === 'shadow-only').length,
    },
  };
}

/**
 * The file+similarity view of the same two finding sets (plan §2.5b-i).
 *
 * Returns `null` — not an empty bucket set — when matching is disabled, so a
 * consumer can tell "not computed" from "computed, found nothing". An empty
 * bucket set here would read as a measured zero, which is the exact failure
 * this whole change is fixing.
 */
function buildMatchedBuckets(primaryResult, shadowResult) {
  if (!findingMatchConfig.enabled) return null;
  const p = dedupByHash(primaryResult?.new_findings);
  const s = dedupByHash(shadowResult?.new_findings);
  const r = matchFindings(p, s, {
    threshold: findingMatchConfig.threshold,
    coverageFloor: findingMatchConfig.coverageFloor,
  });
  return {
    both: r.both,
    primaryOnly: r.primaryOnly,
    shadowOnly: r.shadowOnly,
    unmatchablePrimary: r.unmatchablePrimary,
    unmatchableShadow: r.unmatchableShadow,
    coverage: r.coverage,
    verdict: r.verdict,
    // Evidence for every merge: both hashes and the score that joined them.
    // A `both` count without this is an unauditable assertion — you could not
    // answer "which two findings did it merge, and how close were they?", which
    // is the only way to catch a false merge after the fact.
    pairs: r.pairs,
  };
}

/**
 * The `_shadow` block for a shadow reviewer that FAILED.
 *
 * A function rather than an object literal inside the catch, because it carries
 * a cross-process contract and a contract needs a boundary to be tested at: the
 * bake-off collector decides whether to re-spawn the arm from `errorRetryable`,
 * and a timed-out shadow and one rejected for a bad model id are otherwise
 * separated only by an English sentence. The classification is therefore made
 * HERE, by the repo's single `classifyLlmError` oracle, where the error object
 * still exists — nothing downstream can recover it from `error` prose.
 *
 * A consumer that finds these fields absent (an artifact from a reviewer
 * predating them) must read that as "not classified", never as "retryable".
 *
 * @param {{provider: string|null, model: string|null}} shadow
 * @param {Error} err
 */
function shadowErrorBlock(shadow, err) {
  const cls = classifyLlmError(err);
  return {
    state: 'error-unavailable', provider: shadow.provider, model: shadow.model,
    verdict: null, usage: null, buckets: null, shadowOnlyFindings: null,
    error: (err.message || 'unknown error').slice(0, 300),
    errorCategory: cls.category,
    errorRetryable: cls.retryable,
    // What the attempt COST is unknown, not zero: the provider may well have
    // burned the full reasoning budget before the deadline fired and simply
    // never returned a usage block. `usage: null` above already reads as
    // unmeterable to `armCostUsd`; this states it in the artifact so a reader
    // does not have to infer it from an absence.
    usageEvidence: 'unreported-call-may-have-been-billed',
  };
}

/** The empty/skip `_shadow` block for a given skip state. */
function shadowSkipBlock(shadow) {
  return {
    state: shadow.state, provider: shadow.provider, model: shadow.model,
    verdict: null, usage: null, buckets: null, shadowOnlyFindings: null, error: null,
  };
}

/**
 * Run the shadow reviewer (when enabled) and persist both reviewers' findings.
 * Mutates `result` to add `result._shadow`. Returns nothing — observation only.
 *
 * Decoupling (Gemini G2): primary final-review rows persist whenever
 * cloud+runId, INDEPENDENT of the shadow. Shadow rows + shadow model/usage
 * persist only when the shadow actually ran (`state==='ran'`).
 *
 * @param {object} result          primary reviewer result (already id-stamped)
 * @param {string} primaryModel    primary reviewer's resolved concrete model id
 * @param {string|null} runId      audit_runs.id (null → local-only, no cloud)
 * @param {{modelEvalOverride?: {repoId:string, modelEvalRunId:string, shadow:object}|null, envelopeScopeCli?: string|null, campaignDigest?: string|null}} [opts]
 */
async function runShadowAndPersist(result, primaryModel, runId, { planContent, transcriptContent, projectContext, auditMode }, { modelEvalOverride = null, envelopeScopeCli = null, campaignDigest = null } = {}) {
  // modelEvalOverride (Phase 4) takes priority over the ordinary
  // FINAL_REVIEW_SHADOW-derived resolution — resolveModelEvalShadowOverride()
  // itself only returns non-null when an adjudicator Tier A/B eval run is
  // actively collecting for THIS repo, so this never silently hijacks an
  // operator's own FINAL_REVIEW_SHADOW choice when no eval is running.
  const shadow = modelEvalOverride ? modelEvalOverride.shadow : resolveShadow();
  let diff = null;

  // Campaign identity + scope resolution happen HERE, unconditionally and
  // BEFORE the shadow.state check — never inside the try/catch below, whose
  // only job is making an ACTUAL PROVIDER CALL failure non-fatal. A
  // config-level refusal must propagate as a genuine uncaught error ("exit
  // non-zero before any client is constructed" is the plan's own test for
  // this); relabelling it 'error-unavailable' via the catch would silently
  // turn a campaign-safety refusal into the same non-fatal shrug a network
  // timeout gets, which defeats the entire point of refusing early.
  //
  // Campaign identity is `--campaign-digest`'s PRESENCE, never how scope was
  // supplied (KD-6's correction: an earlier draft used "was --envelope-scope
  // given" as the campaign signal, which made identical `gap` intent behave
  // differently by transport — gap via env was fine, gap via CLI was a
  // violation, for no reason a caller could predict).
  //
  // Scope resolution has ONE home (scope.mjs). Precedence: --envelope-scope
  // (campaign) > FINAL_REVIEW_SHADOW_SCOPE (operator) > 'full' (default) —
  // resolveEnvelopeScope's own cli-then-env precedence gives this for free.
  const campaignActive = campaignDigest !== null;
  const scopeRes = resolveEnvelopeScope({ cliScope: envelopeScopeCli, envScope: shadowReviewConfig.scope });
  if (campaignActive && scopeRes.scope === 'gap') {
    // Zero-latency failure — the tell that nothing was billed.
    throw new Error(
      '[shadow-review] --envelope-scope gap is campaign-ineligible (plan KD-5): a gap '
      + 'shadow is conditioned on its own arm\'s primary result, so gap arms are not '
      + 'comparable across a cohort. Refusing before any provider call.',
    );
  }
  if (scopeRes.invalid !== null) {
    // Disposition differs by whether a campaign is watching. Interactive:
    // loud warning, proceed on 'full' (the most expensive envelope, so a
    // typo cannot silently buy the cheap behaviour). Campaign: hard reject
    // before any billed call — an unattended run has nobody to read the
    // warning, and the operator-approved plan explicitly requires this.
    if (campaignActive) {
      throw new Error(
        `[shadow-review] invalid --envelope-scope "${scopeRes.invalid}" under an active campaign `
        + '(--campaign-digest present) — refusing before any provider call. Campaign scope must be valid.',
      );
    }
    process.stderr.write(
      `  [shadow-review] WARNING: FINAL_REVIEW_SHADOW_SCOPE="${scopeRes.invalid}" is not one of `
      + `full|thin|gap — falling back to "full" (the most expensive envelope). `
      + 'Fix the value or unset it.\n',
    );
  }
  const envelopeScope = scopeRes.scope;

  if (shadow.state !== 'ready') {
    result._shadow = shadowSkipBlock(shadow);
    if (shadow.state !== 'skipped-unset') {
      process.stderr.write(`  [shadow-review] ${shadow.state} (provider=${shadow.provider ?? '-'})\n`);
    }
  } else {
    try {
      // `primaryResult` is passed ONLY for `gap` — for `full`/`thin` it stays
      // null so blindness is enforced by what the callee receives, not by
      // what it promises.
      const sr = await runShadowReview(shadow, planContent, transcriptContent, projectContext, auditMode, {
        envelopeScope,
        primaryResult: isNonBlindScope(envelopeScope) ? result : null,
      });
      diff = diffFindingBuckets(result, sr.result);
      for (const f of diff.primary) f._sourceModel = primaryModel;
      for (const f of diff.shadow) f._sourceModel = shadow.model;
      result._shadow = {
        state: 'ran', provider: shadow.provider, model: shadow.model,
        // Provenance: WHICH envelope produced this observation. Without it a
        // persisted shadow row cannot be told apart across contract epochs, and
        // the campaign's scope-binding eligibility check has nothing to read.
        scope: envelopeScope,
        envelope: sr.result?._envelope ?? null,
        // Recorded, never verified here — verification is the COLLECTOR's job
        // (it owns the manifest and can recompute against it). This is what
        // lets a persisted snapshot be matched to the specific signed cohort
        // that claims it, rather than merely being contemporaneous with one.
        campaignDigest,
        verdict: sr.result.verdict,
        // Cache token counts are copied, not dropped. This envelope is rebuilt
        // by hand rather than spread, so any field omitted here does not exist
        // downstream however correct the adapter was — and on a cache WRITE the
        // provider moves the whole prefix OUT of `input_tokens`, so omitting
        // these two would have reported an 81K-token shadow review as costing
        // almost nothing. Absent on providers that do not cache, where they
        // sanitize to 0 and the arithmetic is unchanged.
        usage: {
          input_tokens: sr.usage.input_tokens,
          output_tokens: sr.usage.output_tokens,
          cache_creation_input_tokens: sr.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: sr.usage.cache_read_input_tokens ?? 0,
          latency_ms: sr.latencyMs,
        },
        // Lets a bake-off detect that a "different arm" issued the SAME request.
        requestFingerprint: sr.requestFingerprint ?? null,
        buckets: diff.counts,
        // BOTH views, side by side. `buckets` keeps its exact prior meaning
        // (exact-hash), so the pre-registered metric is untouched and no
        // collected snapshot is invalidated — that is what keeps this off a
        // CONTRACT_EPOCH bump. `bucketsMatched` is additive evidence.
        bucketsMatched: buildMatchedBuckets(result, sr.result),
        matchSchemaVersion: FINDING_MATCH_SCHEMA_VERSION,
        matchConfig: {
          threshold: findingMatchConfig.threshold,
          coverageFloor: findingMatchConfig.coverageFloor,
          enabled: findingMatchConfig.enabled,
        },
        // The shadow's FULL deduped list, under a NEW field. `shadowOnlyFindings`
        // keeps meaning only the shadow-only subset — widening a field named
        // `shadowOnly…` would silently change what every existing reader gets,
        // the same defect class this plan exists to fix. Without the full list
        // no future matching rule can be re-derived from a collected snapshot,
        // which is why each instrument change used to shrink the cohort.
        allFindings: dedupByHash(sr.result?.new_findings).map((f) => ({
          fingerprint: f._hash,
          severity: f.severity,
          category: f.category,
          section: f.section,
          affectedFiles: f.affectedFiles ?? [],
          detail: (f.detail || '').slice(0, 600),
        })),
        shadowOnlyFindings: diff.shadow
          .filter((f) => f._bucket === 'shadow-only')
          .map((f) => ({ fingerprint: f._hash, severity: f.severity, category: f.category, section: f.section, detail: (f.detail || '').slice(0, 600) })),
        error: null,
      };
      process.stderr.write(`  [shadow-review] ran ${shadow.model} — buckets both:${diff.counts.both} primary-only:${diff.counts.primaryOnly} shadow-only:${diff.counts.shadowOnly}\n`);
    } catch (err) {
      result._shadow = shadowErrorBlock(shadow, err);
      process.stderr.write(`  [shadow-review] FAILED (non-fatal, primary review unaffected): ${err.message}\n`);
    }
  }

  // Cloud persistence — primary always (when cloud+runId); shadow only when ran.
  if (!runId) return;
  const ran = result._shadow.state === 'ran';
  const primaryFindings = (diff?.primary) || dedupByHash(result.new_findings);
  for (const f of primaryFindings) {
    f._sourceModel = primaryModel;
    if (!ran) f._bucket = null; // bucket only meaningful when both reviewers ran
  }
  const shadowFindings = ran ? diff.shadow : [];
  await recordFinalReviewFindings(runId, {
    primary: primaryFindings,
    shadow: shadowFindings,
    models: {
      primaryModel,
      shadowModel: ran ? shadow.model : null,
      shadowInputTokens: result._shadow.usage?.input_tokens ?? null,
      shadowOutputTokens: result._shadow.usage?.output_tokens ?? null,
      shadowLatencyMs: result._shadow.usage?.latency_ms ?? null,
    },
    // The PRIMARY reviewer's verdict — the thing Step 7 exists to produce, and
    // until 2026-07-18 the one part of it that was never persisted. Explicitly
    // NOT `result._shadow.verdict`: the shadow is observation-only and must
    // never reach a column anything gates on.
    verdict: result.verdict ?? null,
  });

  // Phase 4 — append a model_eval_shadow_observations row when a Tier A/B
  // eval run is actively collecting AND the shadow actually ran this time
  // (a skip/error round contributes nothing to score against). findingRefs
  // disambiguates the underlying audit_runs.id from THIS observation's own
  // model_eval_run_id FK (round-6 audit H5) — finding_fingerprint alone is
  // only unique WITHIN one audit run. idempotencyKey = the audit run's own
  // id: runShadowAndPersist runs at most once per audit run, so a repeated
  // write for the same run upserts rather than duplicating.
  if (modelEvalOverride && ran) {
    const findingRefs = [
      ...primaryFindings.map((f) => ({ auditRunId: runId, findingFingerprint: f._hash, passName: 'final-review', bucket: f._bucket })),
      ...shadowFindings.map((f) => ({ auditRunId: runId, findingFingerprint: f._hash, passName: 'final-review-shadow', bucket: f._bucket })),
    ];
    try {
      await appendModelEvalShadowObservation({
        repoId: modelEvalOverride.repoId, runId: modelEvalOverride.modelEvalRunId,
        observation: { findingRefs }, idempotencyKey: runId,
      });
    } catch (err) {
      process.stderr.write(`  [model-eval-shadow] appendModelEvalShadowObservation failed (non-fatal): ${err.message}\n`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

// ── main() helpers — keep main() under cognitive-complexity 15 ────────────

async function refreshCatalogAndWarn() {
  if (process.env.MODEL_CATALOG_REFRESH === 'skip') return;
  try { await refreshModelCatalog(); } catch { /* silent */ }
  // Re-resolve BOTH the Gemini reviewer model + the Claude Opus fallback
  // against the freshly-populated live catalog, then reassign. "Always
  // use the latest" path — operators no longer have to update STATIC_POOL
  // manually when a provider ships a new model.
  try {
    const liveGemini = resolveModel(process.env.GEMINI_REVIEW_MODEL || 'latest-pro', { silent: true });
    if (liveGemini !== MODEL) {
      process.stderr.write(`  [model-resolver] upgraded Gemini reviewer ${MODEL} → ${liveGemini}\n`);
      MODEL = liveGemini;
    }
  } catch { /* ignore */ }
  try {
    const liveOpus = resolveModel(process.env.CLAUDE_FINAL_REVIEW_MODEL || 'latest-opus', { silent: true });
    if (liveOpus !== CLAUDE_OPUS_MODEL) {
      process.stderr.write(`  [model-resolver] upgraded Claude Opus fallback ${CLAUDE_OPUS_MODEL} → ${liveOpus}\n`);
      CLAUDE_OPUS_MODEL = liveOpus;
    }
  } catch { /* ignore */ }
}

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
    const r = await client.chat.completions.create({
      model, max_completion_tokens: 32, messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
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

/**
 * Resolve the final-review provider.
 *
 * Precedence (top wins):
 *   1. Explicit choice — the CLI `--provider` flag OR the persistent
 *      `FINAL_REVIEW_PROVIDER` per-repo setting (both arrive via `choice`).
 *   2. Auto-detect default stack — `GEMINI_API_KEY` present → Gemini.
 *   3. Active Azure profile → azure-claude.
 *   4. `ANTHROPIC_API_KEY` → public Claude Opus.
 *
 * The per-repo default is "GPT auditor + Gemini reviewer": Gemini is preferred
 * whenever its key is present, and a *configured* Azure profile no longer
 * silently hijacks the reviewer (a stray AZURE_OPENAI_ENDPOINT in the
 * environment used to reroute a private-repo review to Foundry Opus). To make
 * a repo use Azure permanently, set `FINAL_REVIEW_PROVIDER=azure-claude`
 * (`node scripts/gemini-review.mjs set-provider azure-claude`).
 *
 * @param {string|null} choice - explicit provider (flag or setting), or null
 * @param {{env?:object, azureActive?:boolean}} [deps] - injected for tests
 */
export function selectProvider(choice, { env = process.env, azureActive = azureConfig.active } = {}) {
  // ── 1. Explicit choice (flag or FINAL_REVIEW_PROVIDER setting) — always wins.
  if (choice === 'anthropic' || choice === 'claude-opus') {
    if (!env.ANTHROPIC_API_KEY) {
      console.error('Error: provider "anthropic" requires ANTHROPIC_API_KEY');
      process.exit(1);
    }
    return 'claude-opus';
  }
  if (choice === 'gemini') {
    if (!env.GEMINI_API_KEY) {
      console.error('Error: provider "gemini" requires GEMINI_API_KEY');
      process.exit(1);
    }
    return 'gemini';
  }
  if (choice === 'azure-claude') {
    assertAzureClaudeReady();
    return 'azure-claude';
  }
  // Provider-agnostic routes (generic OpenAI-compatible + OpenRouter preset) are
  // EXPLICIT-SELECTION-ONLY — reachable via --provider / FINAL_REVIEW_PROVIDER,
  // never auto-detect (G1: a globally scoped OPENROUTER_API_KEY must not silently
  // route proprietary code egress to a third-party gateway).
  if (choice === 'openai-compatible' || choice === 'openrouter') {
    PROVIDERS[choice].assertReady(env);
    return choice;
  }
  if (choice) {
    console.error(`Error: Unknown provider "${choice}". Use "gemini", "anthropic", "azure-claude", "openai-compatible", or "openrouter".`);
    process.exit(1);
  }
  // ── 2-4. Auto-detect. Gemini first (default reviewer); Azure only when no
  // Gemini key AND the profile is active; public Opus last. NO fallback to a
  // compatible/OpenRouter route (G1) — those require explicit selection.
  if (env.GEMINI_API_KEY) return 'gemini';
  if (azureActive) {
    assertAzureClaudeReady();
    return 'azure-claude';
  }
  if (env.ANTHROPIC_API_KEY) return 'claude-opus';
  console.error('Error: Final review requires GEMINI_API_KEY, ANTHROPIC_API_KEY, or an active Azure profile.');
  console.error('Set GEMINI_API_KEY (Gemini), ANTHROPIC_API_KEY (Claude Opus), or run');
  console.error('`node scripts/gemini-review.mjs set-provider azure-claude` for the Azure work profile.');
  process.exit(1);
  return null;
}

/** The persistent per-repo final-review setting (FINAL_REVIEW_PROVIDER), or null. */
function resolveProviderSetting() {
  const v = (process.env.FINAL_REVIEW_PROVIDER || '').trim();
  return v || null;
}

export const SETTING_PROVIDERS = new Set(['gemini', 'azure-claude', 'anthropic', 'openai-compatible', 'openrouter', 'default']);
const SETTING_COMMENT = '# Final-review provider — persistent per-repo setting (managed by `set-provider`).';

/**
 * Pure: compute new `.env` contents after applying a final-review provider
 * setting. `default` removes the managed line (+ its comment) and reverts to
 * auto-detection. Returns `{ text, changed }`; `text` is the original when
 * nothing changed. Throws on an invalid provider. Exported for tests (no IO).
 * @param {string} existingText
 * @param {string} provider
 * @returns {{text: string, changed: boolean}}
 */
export function applyProviderSetting(existingText, provider) {
  if (!SETTING_PROVIDERS.has(provider)) throw new Error(`invalid provider "${provider}"`);
  // Delegates to the shared pure writer (Cluster B / Phase 3). `reformat: true`
  // preserves this function's historical blank-run normalisation so its output is
  // byte-identical to before the extraction; `default` maps to a null value (remove).
  return applyEnvSetting(existingText, 'FINAL_REVIEW_PROVIDER',
    provider === 'default' ? null : provider,
    { comment: SETTING_COMMENT, reformat: true });
}

/**
 * Persist (or clear) the per-repo final-review provider in the repo-root `.env`.
 * This is the user-triggered "permanent setting".
 * @param {string} provider
 */
function runSetProvider(provider) {
  if (!provider || !SETTING_PROVIDERS.has(provider)) {
    console.error('Usage: node scripts/gemini-review.mjs set-provider <gemini|azure-claude|anthropic|openai-compatible|openrouter|default>');
    console.error('  gemini            — final review via Gemini (the default when GEMINI_API_KEY is present)');
    console.error('  azure-claude      — Opus on Azure Foundry (the work-repo setting)');
    console.error('  anthropic         — public Claude Opus');
    console.error('  openai-compatible — any OpenAI-shaped gateway (needs FINAL_REVIEW_BASE_URL/_API_KEY/_MODEL)');
    console.error('  openrouter        — OpenRouter preset (needs FINAL_REVIEW_MODEL + FINAL_REVIEW_API_KEY or OPENROUTER_API_KEY)');
    console.error('  default           — clear the setting; revert to auto-detection');
    process.exit(1);
  }
  const envPath = resolve(process.cwd(), '.env');
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const { text, changed } = applyProviderSetting(existing, provider);
  if (!changed) {
    console.log('FINAL_REVIEW_PROVIDER is not set — already on auto-detection (Gemini → Azure-if-active → Opus).');
    return;
  }
  atomicWriteFileSync(envPath, text);
  console.log(provider === 'default'
    ? `✓ Cleared FINAL_REVIEW_PROVIDER in ${envPath} — reverted to auto-detection.`
    : `✓ Set FINAL_REVIEW_PROVIDER=${provider} in ${envPath}. This repo now uses "${provider}" for the final review.`);
}

/**
 * Fail-fast (Cluster-A audit H3): the azure-claude final reviewer needs a
 * resolvable route + deployment regardless of which transport shape is used.
 *
 * The endpoint requirement is ROUTE-SPECIFIC. It used to demand
 * `AZURE_AI_ENDPOINT` unconditionally, which is the wrong variable for a tenant
 * that serves Claude through APIM — the route resolver owns that decision now
 * (it throws for `foundry` without an AI endpoint), so this only has to confirm
 * a route resolved at all and that we have something to address.
 */
function assertAzureClaudeReady() {
  const route = azureConfig.claudeRoute;
  const missing = [];
  if (!route) missing.push('AZURE_OPENAI_ENDPOINT');
  if (!route?.apiKey) missing.push(route?.credentialVar || 'AZURE_OPENAI_API_KEY');
  if (!azureConfig.claudeDeployment) missing.push('AZURE_FOUNDRY_CLAUDE_DEPLOYMENT');
  if (missing.length > 0) {
    console.error(
      `Error: Azure final reviewer (${route?.mode || 'unresolved'} route) requires ` +
      `${missing.join(' + ')}. Set ${missing.length > 1 ? 'them' : 'it'} or unset ` +
      `AZURE_OPENAI_ENDPOINT to use Gemini/Claude.`,
    );
    process.exit(1);
  }
}

async function buildClient(provider) {
  const descriptor = PROVIDERS[provider];
  if (!descriptor) throw new Error(`[final-review] unknown provider "${provider}"`);
  return descriptor.buildClient();
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
 * the module-level `_roleAddendum` toggle `getReviewPrompt()` reads, without
 * modifying `runFinalReview`'s own body at all. Used by the tiered-recall
 * audit pipeline's Stage 2 adjudicator (`scripts/lib/audit/final-adjudication.mjs`)
 * to re-verify one candidate/clean-region file per subprocess call.
 * @returns {Promise<{result: object, usage: object, latencyMs: number, transcriptContent: string}>}
 */
export async function runAdjudicatorOnlyReview(provider, client, planContent, transcriptContent, projectContext, auditMode, modelOverride = null) {
  _roleAddendum = ADJUDICATOR_ONLY_ADDENDUM;
  try {
    return await runReviewWithRetry(provider, client, planContent, transcriptContent, projectContext, auditMode, modelOverride);
  } finally {
    _roleAddendum = null;
  }
}

async function applyDebtSuppression(result, transcriptContent) {
  try {
    const transcriptObj = JSON.parse(transcriptContent);
    const suppressionCtx = transcriptObj._debtMemory?.suppressionContext
      || transcriptObj.debt_memory?.suppressionContext
      || [];
    if (!Array.isArray(suppressionCtx) || suppressionCtx.length === 0) return;
    if (!Array.isArray(result.new_findings)) return;
    const { jaccardSimilarity } = await import('./lib/ledger.mjs');
    // Threshold 0.30 vs suppressReRaises' 0.35 — debt envelope signatures
    // (category+section) are shorter than new_findings (which include detail
    // text), so asymmetric lengths dilute Jaccard.
    const THRESHOLD = 0.3;
    const before = result.new_findings.length;
    const kept = [];
    const debtSuppressed = [];
    for (const f of result.new_findings) {
      const fSig = `${f.category} ${f.section} ${f.detail}`;
      let match = null;
      let bestScore = 0;
      for (const d of suppressionCtx) {
        const score = jaccardSimilarity(fSig, `${d.category} ${d.section}`);
        if (score > bestScore) { bestScore = score; match = d; }
      }
      if (match && bestScore > THRESHOLD) debtSuppressed.push({ finding: f, matchedTopic: match.topicId, score: bestScore });
      else kept.push(f);
    }
    if (debtSuppressed.length === 0) return;
    process.stderr.write(`  [final-review] Debt re-suppression: ${debtSuppressed.length}/${before} new_findings matched pre-filtered debt\n`);
    for (const s of debtSuppressed.slice(0, 3)) {
      process.stderr.write(`    [debt-suppressed] ${s.matchedTopic.slice(0, 8)} score=${s.score.toFixed(2)}\n`);
    }
    result.new_findings = kept;
    result._debtSuppressedCount = debtSuppressed.length;
  } catch { /* transcript not JSON or no _debtMemory — skip */ }
}

/**
 * Project a `wrongly_dismissed` entry onto the `{category, section, detail}`
 * shape `classifyFinding` reads.
 *
 * **This projection is the whole point of the function** (validator-inert-by-
 * arguments). `WronglyDismissedSchema` shares NOT ONE field name with
 * `FindingBase` — its prose lives in `reason_claude_was_wrong`/`evidence_basis`
 * and its file references in `cited_lines`. Handing those entries to the gate
 * unprojected type-checks, runs, and classifies exactly zero of them, so the
 * gate would read clean on the path that needs it most: a re-asserted GPT
 * finding is where a false absence claim survives Claude's dismissal and comes
 * back as "you hallucinated the verification".
 *
 * `category` is left EMPTY on purpose — it is concatenated into the haystack
 * `classifyFinding` scans, so a synthetic label there could manufacture a
 * classification the model's own prose never made.
 */
function projectWronglyDismissed(wd) {
  const cited = Array.isArray(wd?.cited_lines) ? wd.cited_lines : [];
  return {
    category: '',
    // `auth.js:132` → `extractCitedEntity` splits on `:` for the fromFile anchor.
    section: cited.length > 0 ? String(cited[0]) : '',
    detail: `${wd?.reason_claude_was_wrong || ''}\n${wd?.evidence_basis || ''}`.trim(),
    // `mk()` defaults verdictSeverity to `finding.severity`; without this the
    // projected view has no severity at all and the annotation reads undefined.
    severity: wd?.recommended_severity,
  };
}

/**
 * Deterministic existence-claim gate for FINAL-REVIEW findings — the same
 * `verifyExistenceFindings` the GPT audit path runs at
 * `legacy-production-audit.mjs`, which the final reviewer never passed through.
 *
 * Why it belongs here too: a "file/module/symbol X does not exist" claim is
 * mechanically decidable against the repo inventory, and until this ran, a
 * false one from the final reviewer could only be answered by argument — the
 * operator re-deriving `git ls-files` by hand while the reviewer restated the
 * claim. The failure shape is a category error (treating "not in the
 * changed-files list" as "not in the repo"), which no amount of prose settles
 * and one set lookup does.
 *
 * Deliberately ANNOTATES rather than drops, mirroring the GPT path: `.verification`
 * rides on the finding and `isRefuted` decides what it means. The model's own
 * `verdict` is NOT recomputed here — mechanically flipping a REJECT is a
 * separate decision with its own failure modes, and a refuted finding that is
 * *named as refuted* in the report already ends the argument.
 *
 * @param {object} result - parsed GeminiFinalReviewSchema object, mutated in place
 * @param {object} [deps] - test seam
 * @returns {{checked:number, refuted:number}}
 */
export function applyExistenceGate(result, { listFiles = listRepoFiles } = {}) {
  const stats = { checked: 0, refuted: 0 };
  try {
    const inv = listFiles({ baseDir: process.cwd() });
    const ctx = { repoFiles: inv.files, inventoryComplete: inv.complete };

    // ── new_findings: already FindingBase-shaped, gate applies directly ──
    if (Array.isArray(result?.new_findings) && result.new_findings.length > 0) {
      stats.checked += result.new_findings.length;
      result.new_findings = verifyExistenceFindings(result.new_findings, ctx);
    }

    // ── wrongly_dismissed: needs the projection above to be adjudicable ──
    if (Array.isArray(result?.wrongly_dismissed) && result.wrongly_dismissed.length > 0) {
      stats.checked += result.wrongly_dismissed.length;
      const projected = verifyExistenceFindings(result.wrongly_dismissed.map(projectWronglyDismissed), ctx);
      // Map the verdict back onto the ORIGINAL entries — index-aligned because
      // verifyExistenceFindings is a `.map`, one output per input, order kept.
      result.wrongly_dismissed = result.wrongly_dismissed.map((wd, i) => (
        projected[i]?.verification ? { ...wd, verification: projected[i].verification } : wd
      ));
    }

    const refuted = [
      ...(result?.new_findings || []),
      ...(result?.wrongly_dismissed || []),
    ].filter(isRefuted);
    stats.refuted = refuted.length;

    if (refuted.length > 0) {
      // Name the entities, not just a count — the operator's next move is to
      // stop arguing about a specific path, so the path has to be on screen.
      process.stderr.write(
        `  [final-review] Existence gate: ${refuted.length}/${stats.checked} claim(s) REFUTED against the repo inventory\n`,
      );
      for (const f of refuted.slice(0, 5)) {
        const id = f.id || f.original_finding_id || '?';
        process.stderr.write(`    [refuted] ${id}: ${f.verification?.verificationReason || 'entity exists'}\n`);
      }
    }
    if (!inv.complete) {
      // Absence is not provable against a partial inventory — the gate degrades
      // to `requires_verification` internally, and saying so here stops the
      // operator reading a quiet run as a clean one.
      process.stderr.write('  [final-review] Existence gate: repo inventory INCOMPLETE — absence claims not adjudicable\n');
    }
  } catch (err) {
    // Non-blocking, like the GPT path's own try/catch: a gate failure must not
    // take down a review that otherwise succeeded.
    process.stderr.write(`  [final-review] Existence gate skipped: ${err.message}\n`);
  }
  result._existenceGate = stats;
  return stats;
}

export async function applyScopeFilter(result, transcriptContent) {
  try {
    const transcriptObj = JSON.parse(transcriptContent);
    const changedFiles = Array.isArray(transcriptObj.changed_files) ? transcriptObj.changed_files : [];
    if (changedFiles.length === 0) return;
    if (!Array.isArray(result.new_findings)) return;
    // Normalise paths for comparison: trim whitespace, strip leading ./.
    const inScope = new Set(changedFiles.map(f => f.trim().replace(/^\.\//, '')));
    const before = result.new_findings.length;
    const kept = [];
    const scopeFiltered = [];
    for (const f of result.new_findings) {
      const file = (f.file || f.location || '').trim().replace(/^\.\//, '');
      // Empty file → keep (deliberation-level finding, not file-specific).
      if (!file) { kept.push(f); continue; }
      const matched = inScope.has(file) || [...inScope].some(s => file === s || file.endsWith('/' + s) || s.endsWith('/' + file));
      if (matched) kept.push(f);
      else scopeFiltered.push({ finding: f, file });
    }
    if (scopeFiltered.length === 0) return;
    process.stderr.write(`  [final-review] Scope filter: ${scopeFiltered.length}/${before} new_findings cited out-of-scope files (dropped)\n`);
    for (const s of scopeFiltered.slice(0, 3)) {
      process.stderr.write(`    [scope-dropped] ${s.finding.id || '?'} → ${s.file}\n`);
    }
    result.new_findings = kept;
    result._scopeFilteredCount = scopeFiltered.length;
    result._scopeFilteredFindings = scopeFiltered.map(s => ({ id: s.finding.id, file: s.file, hash: s.finding._hash }));
  } catch { /* transcript not JSON or no changed_files — skip */ }
}

function addSemanticIds(result, provider) {
  if (!result.new_findings) return;
  for (let i = 0; i < result.new_findings.length; i++) {
    const f = result.new_findings[i];
    f.id = `${provider === 'gemini' ? 'G' : 'C'}${i + 1}`;
    f._hash = semanticId(f);
    f._source = provider;
    // Stamp the MATCHING keys. Their absence is why cross-model bucketing was
    // reduced to an exact hash over model-authored prose (0/48 matches on real
    // data while 9/48 named the same file). `affectedFiles` is the set matching
    // uses; `_primaryFile` is the reporting key and may be null, which is
    // honest — a finding naming no file is unmatchable, not unique.
    f.affectedFiles = affectedFilesOf(f);
    f._primaryFile = primaryFileOf(f);
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

export function recordNewFindings(result, fpTracker, repoFP, revId, modelId = 'gemini') {
  if (!Array.isArray(result.new_findings)) return;
  for (const f of result.new_findings) {
    appendOutcome('.audit/outcomes.jsonl', {
      findingId: f.id,
      severity: f.severity,
      category: f.category,
      section: f.section,
      pass: 'gemini-new',
      model: modelId,
      accepted: null,
      gemini_reconfirmed: true,
      round: 0,
      promptVariant: revId,
      promptRevisionId: revId,
      semanticHash: f._hash,
    });
    fpTracker.record(f, true, repoFP);
  }
}

function recordWronglyDismissed(result, revId, modelId = 'gemini') {
  if (!Array.isArray(result.wrongly_dismissed)) return;
  for (const w of result.wrongly_dismissed) {
    appendOutcome('.audit/outcomes.jsonl', {
      findingId: w.original_finding_id,
      severity: w.recommended_severity,
      category: `[wrongly-dismissed] ${w.original_finding_id}`,
      section: w.reason_claude_was_wrong?.slice(0, 120) || '',
      pass: 'gemini-wrongly-dismissed',
      model: modelId,
      accepted: null,
      gemini_reconfirmed: true,
      round: 0,
      promptVariant: revId,
      promptRevisionId: revId,
      semanticHash: semanticId({
        category: w.original_finding_id,
        section: w.reason_claude_was_wrong || '',
        detail: '',
      }),
    });
  }
}

function recordGeminiOutcomes(result, modelId = 'gemini') {
  try {
    const repoProfile = generateRepoProfile();
    const repoFP = repoProfile?.repoFingerprint || null;
    const bandit = new PromptBandit();
    const fpTracker = new FalsePositiveTracker();
    const revId = getActiveRevisionId('gemini-review') || 'default';
    recordNewFindings(result, fpTracker, repoFP, revId, modelId);
    recordWronglyDismissed(result, revId, modelId);
    const VERDICT_REWARDS = { APPROVE: 0.8, CONCERNS: 0.5, CONCERNS_REMAINING: 0.35, REJECT: 0.2 };
    const verdictReward = VERDICT_REWARDS[result.verdict] ?? 0.5;
    bandit.update('gemini-review', revId, verdictReward);
    bandit.flush();
    fpTracker.flush?.();
    const newCount = result.new_findings?.length ?? 0;
    const wrongCount = result.wrongly_dismissed?.length ?? 0;
    if (newCount > 0 || wrongCount > 0) {
      process.stderr.write(`  [learning] Recorded ${newCount} new + ${wrongCount} wrongly-dismissed outcomes for gemini-review pass\n`);
    }
  } catch (learnErr) {
    process.stderr.write(`  [learning] ${learnErr.message?.slice(0, 100)}\n`);
  }
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
  await refreshCatalogAndWarn();

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
    await runShadowAndPersist(result, primaryModel, runId, { planContent, transcriptContent: usedTranscript, projectContext, auditMode }, { modelEvalOverride, envelopeScopeCli, campaignDigest });
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
