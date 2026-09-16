/**
 * @fileoverview The unified reviewer call seam — one abort-correct path for
 * every provider (Gemini / Anthropic / OpenAI-shaped), plus JSON-response
 * parsing and the Anthropic streaming-message reader.
 *
 * Pure relocation out of `scripts/gemini-review.mjs`
 * (`docs/plans/gemini-review-decomposition.md` Phase 2). `gemini-review.mjs`
 * imports `callReviewer`/`streamAnthropicMessage`/`REVIEW_TRANSPORTS`/
 * `PING_TRANSPORTS`(stays)/`GEMINI_THINKING_BUDGET_BY_EFFORT` back and keeps
 * re-exporting them through its existing `_internals` object, unchanged.
 *
 * `ANTHROPIC_MIN_CACHEABLE_TOKENS` lives here (not `output-schemas.mjs`) —
 * it is consumed only by the anthropic transport adapter below, not by any
 * schema. `gemini-review.mjs` keeps re-exporting it at the top level.
 *
 * `_activeReviewController` (the watchdog-abortable in-flight controller)
 * stays owned by `gemini-review.mjs`, per the plan's Symbol/Dependency
 * Matrix — `callReviewer` no longer writes that global directly. It instead
 * takes an optional `onController(controller | null)` callback in its
 * options object, invoked at the same two points (set on start, cleared in
 * `finally`), so this module has zero references to any
 * `gemini-review.mjs`-owned identifier.
 *
 * `TIMEOUT_MS`/`MAX_OUTPUT_TOKENS` are read directly from `geminiConfig`
 * here rather than imported from `gemini-review.mjs` — read-only config, not
 * CLI-owned mutable state, and they are used nowhere else in that file after
 * this move.
 *
 * @module scripts/lib/final-review/transport
 */
import { sanitizeSchemaName, isResponseFormatUnsupported } from '../oss-structured-output.mjs';
import { normalizeGeminiUsage } from '../gemini-usage.mjs';
import { geminiConfig, finalReviewConfig } from '../config.mjs';
import { azureThrottle } from '../azure-throttle.mjs';
import { ANTHROPIC_REVIEW_TOOL_NAME, truncateToSchema } from './output-schemas.mjs';

const TIMEOUT_MS = geminiConfig.timeoutMs;
const MAX_OUTPUT_TOKENS = geminiConfig.maxOutputTokens;

/**
 * Anthropic's minimum cacheable prefix for the Opus/Sonnet tiers. A
 * `cache_control` marker on a shorter prefix is accepted, billed at the write
 * premium, and never read back — the "provably inert" class `efficacy-lints`
 * exists to catch. Mirrors `DEFAULT_CONFIG.modelMinTokens` in
 * scripts/lib/efficacy-lints.mjs; keep the two in step.
 */
export const ANTHROPIC_MIN_CACHEABLE_TOKENS = 1024;

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
export const GEMINI_THINKING_BUDGET_BY_EFFORT = Object.freeze({ low: 4096, medium: 8192, high: 16384 });

export const REVIEW_TRANSPORTS = {
  async gemini(client, { model, maxTokens, systemPrompt, userPrompt, jsonSchema, signal }) {
    // Streaming supports maxOutputTokens > 21333 (non-streaming SDK ceiling).
    // `generateContentStream(params)` takes exactly ONE argument
    // (`GenerateContentParameters`) — a `{ signal }` second argument is
    // silently dropped, never reaching the SDK. Cancellation is a `config`
    // field (`GenerateContentConfig.abortSignal`), not a call-site option
    // (found in R1 audit H1/H2; verified against @google/genai's own
    // `generateContentStream: (params: types.GenerateContentParameters) => …`
    // signature and `GenerateContentConfig.abortSignal` type).
    const stream = await client.models.generateContentStream({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: jsonSchema,
        maxOutputTokens: maxTokens,
        thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET_BY_EFFORT[finalReviewConfig.reasoningEffort] },
        abortSignal: signal,
      },
    });
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
 * @param {object} [opts.zodSchema]
 * @param {object} [opts.jsonSchema] - only used by the gemini transport (responseSchema)
 * @param {object} [opts.toolSchema] - only used by the anthropic transport
 *   (forced tool-use `input_schema`). Separate from `jsonSchema` because the
 *   two providers take different dialects of the same Zod source; omitting it
 *   degrades that transport to the old prompt-instruction mode.
 * @param {string} [opts.passName]
 * @param {(controller: AbortController|null) => void} [opts.onController] -
 *   called with the attempt's AbortController when it is created, and with
 *   `null` when the attempt finishes — the watchdog-abort contract, owned by
 *   the caller (`gemini-review.mjs`'s `_activeReviewController`), not by this
 *   module.
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
export async function callReviewer(client, { transportKind, model, systemPrompt, userPrompt, zodSchema, jsonSchema, toolSchema, passName, requestExtras, openAiJsonSchema, onController }) {
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
  onController?.(controller);
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
    onController?.(null);
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
export async function streamAnthropicMessage(client, params, { signal } = {}) {
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
