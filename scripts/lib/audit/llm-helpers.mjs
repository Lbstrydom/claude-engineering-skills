/**
 * @fileoverview Neutral, mode-agnostic GPT call primitives shared by every
 * `openai-audit.mjs` entry point (`code`/`plan`/`rebuttal`) AND by the
 * code-audit-orchestration-specific `legacy-production-audit.mjs` /
 * `tiered-pipeline.mjs` modules.
 *
 * Extracted from `openai-audit.mjs` — tiered-recall audit pipeline Phase 11
 * (Gemini gate fix G2, round 3 of the Phases-10-12 audit pass): a THIRD,
 * neutral module, not left inside `openai-audit.mjs` and not physically
 * relocated into `legacy-production-audit.mjs`. Both of those files import
 * FROM this module; this module imports from neither of them — that
 * one-directional shape is what eliminates the two-file circular-import risk
 * a naive "stays in openai-audit.mjs, exported" placement would create
 * (`openai-audit.mjs` imports `runLegacyProductionAudit` FROM
 * `legacy-production-audit.mjs`, while `legacy-production-audit.mjs`'s own
 * orchestration loop needs `callGPT`/`safeCallGPT`/`getPassPrompt`/
 * `buildCachePrompt` — if those primitives stayed in `openai-audit.mjs`,
 * `legacy-production-audit.mjs` would need to import them back FROM
 * `openai-audit.mjs`, a genuine A-imports-B/B-imports-A cycle).
 *
 * `_callGPTOnce`, `callGPT`, `safeCallGPT` are already the stable primitives
 * exposed via `openai-audit.mjs`'s `__testExports` gate (re-exported from
 * their new home here, so existing tests + `/audit-plan`'s plan/rebuttal
 * call sites need no changes beyond the import path).
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 11.
 *
 * @module scripts/lib/audit/llm-helpers
 */

import { zodTextFormat, zodResponseFormat } from 'openai/helpers/zod';
import {
  LlmError, classifyLlmError, tryRepairJson,
  RETRY_MAX_ATTEMPTS, RETRY_429_MAX_ATTEMPTS,
  retryAttemptsFor, retryAfterMs, nextRetryDelayMs,
} from '../robustness.mjs';
import { buildAuditPassPrompt } from './prompt-builder.mjs';
import { readProjectContextForPass, extractPlanForPass } from '../context.mjs';
import { R2_ROUND_MODIFIER, buildRulingsBlock } from '../ledger.mjs';
import { getActivePrompt, bootstrapFromConstants } from '../prompt-registry.mjs';
import { PASS_PROMPTS } from '../prompt-seeds.mjs';
import { openaiConfig, azureConfig } from '../config.mjs';
import { supportsReasoningEffort } from '../model-resolver.mjs';
import { azureThrottle } from '../azure-throttle.mjs';
import { classifyResponsesSupport } from '../openai-responses-capability.mjs';

// ── Resolved model state (mode-agnostic — used by BOTH code-audit orchestration
// AND the plan/rebuttal single-call paths in openai-audit.mjs's main()) ─────
//
// `MODEL` is `let`, not `const` — `main()` re-resolves it against the live
// model catalog at startup (see openai-audit.mjs). ESM exports of a mutable
// `let` give importers a LIVE read binding, but not a write one, so the
// setter below is how `main()` updates it after resolution.
export let MODEL = openaiConfig.model;

/** Reassign the resolved model id. Only `openai-audit.mjs`'s `main()` calls this. */
export function setModel(id) {
  MODEL = id;
}

// Bootstrap prompt registry on first run (idempotent — same content = no-op).
bootstrapFromConstants(PASS_PROMPTS);

/**
 * Get the active prompt for a pass. Falls back to seed if registry not bootstrapped.
 * @param {string} passName
 * @returns {string}
 */
export function getPassPrompt(passName) {
  const registered = getActivePrompt(passName);
  if (registered) return registered;
  return PASS_PROMPTS[passName] || '';
}

/**
 * Build an audit-pass prompt opts object ready to pass to safeCallGPT in
 * structured mode. Bundles the typical per-pass setup (brief lookup, plan
 * slicing, optional rulings, R2_ROUND_MODIFIER) so call sites stay terse.
 *
 * Returns { system, messages } — pass directly to `safeCallGPT`/`callGPT`
 * via spread: `safeCallGPT(openai, { ...buildCachePrompt({...}), schema, ... })`.
 *
 * @param {object} args
 * @param {string} args.rubric            - pass-specific static system rubric (e.g. PASS_STRUCTURE_SYSTEM)
 * @param {string} args.focusBlock        - repo-focus addition (appended to rubric)
 * @param {string} args.passName          - pass identifier (used for brief/plan slicing)
 * @param {string} args.planContent       - full plan markdown
 * @param {string|null} args.ledgerFile   - ledger path (null on R1)
 * @param {Set<string>|null} args.impactSet - impacted-file set for rulings filter
 * @param {boolean} args.isR2Plus         - R2+ flag (controls rulings + roundModifier)
 * @param {string} args.code              - file contents to audit
 * @param {string} [args.fileListContext] - optional file-list summary block
 * @param {string} [args.requirementsRubric] - optional requirements-rubric block
 * @returns {{ system: string, messages: Array<{role:'user',content:string}> }}
 */
export function buildCachePrompt({ rubric, focusBlock, passName, planContent, ledgerFile, impactSet, isR2Plus, code, codeHeader = '## Code', fileListContext = '', requirementsRubric = '', historyBlock = '', unitLabel = '' }) {
  // Combine pre-existing CLI --history block (rare) with R2+ ledger rulings.
  // Both are round-varying; both belong in msg #2 for cache stability.
  const rulings = (isR2Plus && ledgerFile) ? buildRulingsBlock(ledgerFile, passName, impactSet) : null;
  const history = [historyBlock, rulings].filter(Boolean).join('\n\n') || null;
  return buildAuditPassPrompt({
    systemRubric: rubric + (focusBlock || ''),
    brief: readProjectContextForPass(passName),
    planSlice: extractPlanForPass(planContent, passName),
    fileListContext,
    requirementsRubric,
    code,
    codeHeader,
    history,
    roundModifier: isR2Plus ? R2_ROUND_MODIFIER : null,
    unitLabel,
  });
}

/**
 * Normalise prompt opts into a Responses-API `input` array.
 * Accepts EITHER legacy `{ systemPrompt, userPrompt }` (strings) OR
 * structured `{ system, messages }` (string + user-message array).
 * Rejects hybrid combinations with LlmError({category:'config'}) — those
 * are programmer bugs and must fail-fast per repo policy.
 *
 * SUNSET PLAN (legacy `systemPrompt`/`userPrompt` mode):
 * The legacy mode is kept for non-audit callers (currently none in this
 * repo's audit pipeline — all 14 audit call sites migrated to structured
 * mode as of `feat(audit): prompt prefix-cache restructure`). It will be
 * removed once we've gone 30 days without any internal caller using it.
 * The wrapper-contract test asserts both modes work; remove the legacy
 * branch + its test when the sunset fires.
 *
 * @returns {Array<{role:'system'|'user',content:string}>} input array
 */
export function normalisePromptInput(opts) {
  const hasLegacy = opts.systemPrompt !== undefined || opts.userPrompt !== undefined;
  const hasStructured = opts.system !== undefined || opts.messages !== undefined;
  if (hasLegacy && hasStructured) {
    throw new LlmError(
      'Hybrid prompt input: cannot pass both {systemPrompt|userPrompt} and {system|messages}. Pick one mode.',
      { category: 'config', retryable: false }
    );
  }
  if (hasStructured) {
    if (typeof opts.system !== 'string') {
      throw new LlmError('Structured mode requires opts.system: string', { category: 'config', retryable: false });
    }
    if (!Array.isArray(opts.messages) || opts.messages.length === 0) {
      throw new LlmError('Structured mode requires opts.messages: non-empty array', { category: 'config', retryable: false });
    }
    for (const m of opts.messages) {
      if (!m || m.role !== 'user' || typeof m.content !== 'string') {
        throw new LlmError('Structured mode: each message must be { role: "user", content: string }', { category: 'config', retryable: false });
      }
    }
    return [{ role: 'system', content: opts.system }, ...opts.messages];
  }
  // Legacy mode
  if (typeof opts.systemPrompt !== 'string' || typeof opts.userPrompt !== 'string') {
    throw new LlmError('Legacy mode requires systemPrompt + userPrompt as strings', { category: 'config', retryable: false });
  }
  return [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userPrompt }
  ];
}

// The wire-level model id. Public path: the resolved sentinel (MODEL). Azure
// path: the deployment name (§1.5 H4 — never feed a deployment through
// resolveModel; the sentinel stays for logging/pricing only).
//
// Exported because it is the ONLY honest answer to "what model served this
// pass" for a caller that never sees an individual call result — notably
// `runMapReducePass`, whose N map units + reduce all dispatch here. It is a
// process-level constant for the life of a run (`MODEL` is reassigned only by
// `openai-audit.mjs`'s `main()`, before any pass runs), so reading it after
// the fact returns the same id the units were sent to.
export function wireModel() {
  return azureConfig.active ? azureConfig.gptDeployment : MODEL;
}

// Process-level latch: once a deployment proves it lacks the Responses route,
// route every subsequent pass via chat-completions (don't re-probe per call).
let _responsesUnsupported = false;

/**
 * Call the Responses API, transparently falling back to chat-completions +
 * `zodResponseFormat` ONLY when the deployment positively reports the Responses
 * route is unsupported (a chat-only Azure deployment like `gpt-5.3-chat`). A
 * generic 404 / config error is rethrown — never masked (AGENTS.md). Returns a
 * Responses-API-shaped object so the caller's extraction code is unchanged.
 */
async function parseStructured(openai, requestParams, callOpts, ctx) {
  if (!_responsesUnsupported) {
    try {
      return await azureThrottle(() => openai.responses.parse(requestParams, callOpts));
    } catch (err) {
      if (classifyResponsesSupport(err) !== 'unsupported') throw err;
      _responsesUnsupported = true;
      process.stderr.write(
        `  [openai-audit] Responses API unsupported on deployment "${ctx.model}" — ` +
        `using chat-completions + zodResponseFormat for the rest of this run.\n`,
      );
    }
  }
  // normalisePromptInput already returns chat-shaped [{role, content:string}],
  // so `input` is directly usable as `messages`.
  const params = {
    model: ctx.model,
    messages: ctx.input,
    response_format: zodResponseFormat(ctx.schema, ctx.schemaName),
    max_completion_tokens: ctx.tokens,
  };
  if (supportsReasoningEffort(ctx.model)) params.reasoning_effort = ctx.effort;
  const completion = await azureThrottle(() => openai.chat.completions.parse(params, callOpts));
  const choice = completion.choices?.[0];
  const u = completion.usage || {};
  const parsed = choice?.message?.parsed ?? null;
  const truncated = choice?.finish_reason === 'length';
  return {
    output_parsed: parsed,
    // Echoed so the caller's `response.model` read is answered on THIS path too
    // rather than silently falling through to what we sent — the two agree in
    // the normal case and the provider is the authority when they don't.
    model: completion.model ?? ctx.model,
    status: truncated ? 'incomplete' : 'completed',
    incomplete_details: truncated ? { reason: 'max_tokens' } : undefined,
    // Surface raw text for the bracket-repair path only when parsing failed.
    output: parsed ? [] : [{ type: 'output_text', text: choice?.message?.content ?? '' }],
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens: u.completion_tokens ?? 0,
      output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    },
  };
}

const REASONING_EFFORT = openaiConfig.reasoning;
const MAX_OUTPUT_TOKENS_CAP = openaiConfig.maxOutputTokensCap;
const TIMEOUT_MS_CAP = openaiConfig.timeoutMsCap;

/**
 * Make a single GPT call with structured output. Detects incomplete/truncated
 * responses and throws LlmError with usage attached.
 */
export async function _callGPTOnce(openai, opts) {
  const { schema, schemaName, reasoning, maxTokens, timeoutMs, passName } = opts;
  const effort = reasoning ?? REASONING_EFFORT;
  const tokens = maxTokens ?? MAX_OUTPUT_TOKENS_CAP;
  const timeout = timeoutMs ?? TIMEOUT_MS_CAP;

  // Normalise prompt input ONCE — throws config-category LlmError on hybrid.
  // This deliberately happens OUTSIDE the try/catch below so it propagates
  // unwrapped (the try block re-throws structured LlmErrors anyway, but the
  // config check here makes the failure unmissable for callers).
  const input = normalisePromptInput(opts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const startMs = Date.now();

  if (passName) {
    process.stderr.write(`  [${passName}] Starting (reasoning: ${effort}, timeout: ${(timeout / 1000).toFixed(0)}s)...\n`);
  }

  try {
    const wm = wireModel();
    const requestParams = {
      model: wm,
      input,
      text: { format: zodTextFormat(schema, schemaName) },
      max_output_tokens: tokens
    };

    if (supportsReasoningEffort(wm)) {
      requestParams.reasoning = { effort };
    }

    const response = await parseStructured(
      openai, requestParams, { signal: controller.signal },
      { model: wm, input, schema, schemaName, effort, tokens },
    );
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    // Extract usage regardless of success/failure (includes cached_tokens).
    // NOTE: Responses API returns cached_tokens under `input_tokens_details`
    // (NOT `prompt_tokens_details` which is the Chat Completions API shape).
    // The fallback to prompt_tokens_details is kept defensively for any
    // future SDK shape changes — it costs nothing when not present.
    const usage = {
      input_tokens: response.usage?.input_tokens ?? 0,
      cached_tokens: response.usage?.input_tokens_details?.cached_tokens
        ?? response.usage?.prompt_tokens_details?.cached_tokens
        ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      reasoning_tokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      latency_ms: latencyMs
    };

    // Detect incomplete response
    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason ?? 'unknown';
      throw new LlmError(`Response incomplete: ${reason}`, { category: 'incomplete', usage, retryable: true });
    }

    // Check ALL output items for truncation
    for (const item of (response.output ?? [])) {
      if (item?.status === 'incomplete') {
        throw new LlmError(`Output truncated: ${item.incomplete_details?.reason ?? 'max_tokens'}`,
          { category: 'truncated', usage, retryable: true });
      }
    }

    let result = response.output_parsed;
    if (!result) {
      // Attempt bracket-balance repair on raw text before giving up
      const rawText = response.output?.find(o => o.type === 'output_text')?.text ?? '';
      if (rawText) {
        const repairAttempt = tryRepairJson(rawText);
        if (repairAttempt.ok) {
          process.stderr.write(`  [${passName ?? 'call'}] output_parsed null — repaired truncated JSON\n`);
          result = repairAttempt.result;
        }
      }
      if (!result) throw new LlmError('No parsed output from model', { category: 'empty', usage });
    }

    // Validate expected shape
    if (result.findings !== undefined && !Array.isArray(result.findings)) {
      throw new LlmError(`Schema violation: findings is ${typeof result.findings}, expected array`,
        { category: 'schema', usage });
    }

    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out)\n`);
    }

    // `reasoningEffort` is the effort ACTUALLY SENT, carried back so telemetry
    // never has to guess it. `audit_pass_stats.reasoning_effort` used to be
    // filled by a name→level lookup in the orchestrator that returned 'high'
    // for the structure and wiring passes while both dispatch 'low' — a
    // fabricated measurement, and one this line is the only honest source for:
    // the fallback to `REASONING_EFFORT` is resolved here, so a call site that
    // passes no `reasoning` at all cannot be reconstructed anywhere else.
    // `model` is the SAME argument as `reasoningEffort` above, one column over:
    // `audit_pass_stats.source_model` was NULL on every production row since the
    // table existed, because the only caller that ever supplied it was the
    // model-A/B shadow (concluded 2026-07-09). Without it the per-pass log
    // records tokens/latency/accept-rate against no model, so "did the new GPT
    // release change accept-rate or cost" is unanswerable from six weeks of
    // rows. `response.model` is the server's report of what actually served the
    // call (the concrete dated snapshot, which can be more specific than what we
    // sent); `wm` is what we dispatched, and is the honest fallback on the
    // chat-completions path where the provider echoes nothing.
    return { result, usage, latencyMs, reasoningEffort: effort, model: response.model ?? wm };

  } catch (err) {
    clearTimeout(timer);
    if (err instanceof LlmError) throw err; // Already structured
    const latencyMs = Date.now() - startMs;
    const isAbort = err.name === 'AbortError' || err.message?.toLowerCase().includes('abort');
    const msg = isAbort
      ? `[${passName ?? 'call'}] Timeout after ${(timeout / 1000).toFixed(0)}s`
      : `[${passName ?? 'call'}] ${err.message} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${passName ?? 'call'}] FAILED: ${msg}\n`);
    // A detected abort must leave here as a STRUCTURED timeout. This threw a
    // bare `new Error(msg)`, so the one thing this block had just established —
    // `isAbort` — was destroyed on the way out, and every downstream consumer
    // saw category `permanent`. `classifyLlmError` has an AbortError branch, but
    // it could never fire: the name was gone and matching "Timeout after" out of
    // the prose is exactly the message-string matching that function exists to
    // avoid. This is why `ReduceStatus.TIMEOUT` was unreachable.
    //
    // `retryable: false` PRESERVES today's behaviour deliberately — an abort is
    // currently classified `permanent` and therefore never retried, and this is
    // a labelling fix, not a retry-policy change. Note `classifyLlmError`'s own
    // AbortError branch would say `retryable: true`; flipping it would make
    // every timed-out pass re-dispatch a full attempt, which is a cost decision
    // that deserves its own change.
    if (isAbort) throw new LlmError(msg, { category: 'timeout', retryable: false });
    // CARRY THE HTTP FACTS FORWARD (Gemini final gate, 2026-09-04). This threw
    // a bare `new Error(msg)`, which destroyed `.status`, `.code` and
    // `.headers` on the way out — the exact same shape as the abort bug two
    // lines above, which this block's own comment describes. Measured:
    //
    //   SDK error   → classifyLlmError → {retryable:true,  category:'http-429'}
    //   rewrapped   → classifyLlmError → {retryable:false, category:'permanent'}
    //
    // So the `http-429` branch was UNREACHABLE from this call path, and every
    // 429 was treated as permanent and never retried. That is why a consumer's
    // whole round died to `429 ... high demand` with no retry line in the log
    // at all — and it means the enlarged 429 budget and `Retry-After` handling
    // added in this same change were inert until now. AGENTS.md states the rule
    // this violated: "When rewrapping an LLM error, surface `err.status` + the
    // real provider `error.message`".
    const wrapped = new Error(msg);
    if (err.status !== undefined) wrapped.status = err.status;
    if (err.code !== undefined) wrapped.code = err.code;
    if (err.headers !== undefined) wrapped.headers = err.headers;
    if (err.cause !== undefined) wrapped.cause = err.cause;
    throw wrapped;
  }
}

/**
 * Call GPT with single retry on transient failures.
 * Accumulates usage across attempts for truthful accounting.
 */
export async function callGPT(openai, opts) {
  let lastErr;
  const startMs = Date.now();
  const accumulatedUsage = { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  // The loop CEILING, not the policy: how many retries an attempt is actually
  // allowed depends on the category of the error it just hit, which is unknown
  // until it happens. An explicit `opts.maxRetries` overrides both.
  const ceiling = opts.maxRetries ?? Math.max(RETRY_MAX_ATTEMPTS, RETRY_429_MAX_ATTEMPTS);

  for (let attempt = 0; attempt <= ceiling; attempt++) {
    try {
      const result = await _callGPTOnce(openai, opts);
      if (attempt > 0) {
        result.usage.input_tokens += accumulatedUsage.input_tokens;
        result.usage.cached_tokens += accumulatedUsage.cached_tokens;
        result.usage.output_tokens += accumulatedUsage.output_tokens;
        result.usage.reasoning_tokens += accumulatedUsage.reasoning_tokens;
        result.latencyMs = Date.now() - startMs;
        result._retried = true;
        result._attempts = attempt + 1;
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (err.llmUsage) {
        accumulatedUsage.input_tokens += err.llmUsage.input_tokens ?? 0;
        accumulatedUsage.cached_tokens += err.llmUsage.cached_tokens ?? 0;
        accumulatedUsage.output_tokens += err.llmUsage.output_tokens ?? 0;
        accumulatedUsage.reasoning_tokens += err.llmUsage.reasoning_tokens ?? 0;
      }
      const { retryable, category } = classifyLlmError(err);
      const allowed = opts.maxRetries ?? retryAttemptsFor(category);
      if (attempt < allowed && retryable) {
        const delayMs = nextRetryDelayMs({
          category, attempt, retryAfter: retryAfterMs(err),
        });
        // `allowed`, not the constant: the line used to print the generic
        // budget regardless of the policy actually in force, so a run that
        // was about to give up after one try reported "Retry 1/1" while a
        // caller-overridden budget reported someone else's number.
        process.stderr.write(`  [${opts.passName ?? 'call'}] Retry ${attempt + 1}/${allowed} in ${(delayMs / 1000).toFixed(1)}s [${category}]\n`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      err._accumulatedUsage = accumulatedUsage;
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Wrapper that catches LLM/runtime pass failures and returns empty results
 * instead of crashing. Allows the audit to continue even if one pass fails.
 *
 * Fail-fast for config errors (programmer bugs): if the underlying call throws
 * LlmError({category:'config'}), it is RE-THROWN — those represent hybrid
 * prompt inputs or schema mismatches that must surface immediately in tests
 * rather than silently degrade in production audits.
 */
export async function safeCallGPT(openai, opts, emptyResult) {
  try {
    return await callGPT(openai, opts);
  } catch (err) {
    // Fail-fast on programmer bugs (hybrid input, schema misconfig)
    if (err instanceof LlmError && err.llmCategory === 'config') {
      throw err;
    }
    process.stderr.write(`  [${opts.passName}] Graceful degradation — using empty result\n`);
    // Tokens a FAILED call already burned are reported, not zeroed. `callGPT`
    // accumulates them from `err.llmUsage` across attempts and stamps
    // `err._accumulatedUsage` before rethrowing (see its catch) — this seam used
    // to drop that on the floor and return a hard-coded zero envelope, so a
    // truncated or retried-then-failed pass billed real tokens that never
    // reached `totalUsage`, `_usage.costUsd`, or `cacheMetrics`. Same
    // fabricated-zero class as the duplication/adjacency waves (a7db0baf), but
    // on the failure path of EVERY pass rather than two of them.
    //
    // This is the same argument the `reasoningEffort` comment below already
    // makes — the call WAS dispatched, so what it consumed is a fact about what
    // happened, not a claim that it succeeded. Zeros here are unmeasured, not
    // measured-zero, and they are indistinguishable downstream.
    const failedUsage = err._accumulatedUsage ?? {};
    return {
      result: emptyResult,
      usage: {
        input_tokens: failedUsage.input_tokens ?? 0,
        cached_tokens: failedUsage.cached_tokens ?? 0,
        output_tokens: failedUsage.output_tokens ?? 0,
        reasoning_tokens: failedUsage.reasoning_tokens ?? 0,
        latency_ms: 0,
      },
      latencyMs: 0,
      failed: true,
      // WHY the call failed, not just THAT it did. `failed: true` collapses
      // every cause into one bit, and a caller left holding only `error`
      // (a message string) can recover the cause solely by matching on prose —
      // which is exactly what `classifyLlmError` exists to avoid. Callers that
      // report a typed status (`runMapReducePass` → `reduceStatusFromErrorCategory`)
      // read this; without it, `_executionMeta.reduceStatus` could only ever
      // say `model_error`.
      errorCategory: classifyLlmError(err).category,
      // Stamped on the degraded path too: the effort WAS requested — the call
      // was made and failed — so recording it is a fact about what we asked
      // for, not a claim that it ran. Omitting it here would leave a failed
      // pass indistinguishable from one that never dispatched.
      reasoningEffort: opts.reasoning ?? REASONING_EFFORT,
      // Stamped on the degraded path for the same reason as `reasoningEffort`
      // directly above: the call WAS dispatched to this model and burned the
      // tokens reported above, so attributing them to it is a fact about what
      // happened. Omitting it would file a failed pass's real spend against no
      // model at all.
      model: wireModel(),
      error: err.message
    };
  }
}
