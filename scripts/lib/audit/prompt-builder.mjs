/**
 * @fileoverview Audit-pass prompt builder — single SSoT for the message shape
 * sent to the OpenAI Responses API for code/plan audit passes.
 *
 * **Why this module exists** (cache-efficiency contract):
 * OpenAI's Responses API auto-caches the byte-stable prefix of a request.
 * Audit calls historically built ad-hoc string-concat user prompts that
 * interleaved per-round dynamic content (rulings) with per-pass static
 * content (brief, plan-slice, code) — destroying the cache prefix from
 * byte 0.  This module enforces a THREE-MESSAGE structure:
 *
 *   - system: pass rubric (static across rounds + sub-units)
 *   - msg #1: brief + plan-slice + file-list-context (CACHEABLE)
 *   - msg #2: rulings (R2+ only — preserves rulings-before-code salience)
 *   - msg #3: code (per-unit dynamic tail)
 *
 * The R2_ROUND_MODIFIER prelude (round-varying) also lives in msg #2, NOT
 * in the system prompt — keeps system byte-identical across R1/R2/R3.
 *
 * @module scripts/lib/audit/prompt-builder
 */

/**
 * Build the audit-pass prompt as a structured message set.
 *
 * **Trust boundary contract** (R3/H3 LOW compromise from /audit-code review):
 * Inputs are NOT sanitized inside this function — that would duplicate work
 * already done upstream. Callers MUST source `brief`, `planSlice`,
 * `fileListContext`, and `code` from vetted source helpers that apply the
 * project's sensitive-egress policy:
 *   - `brief` from `readProjectContextForPass()` (initAuditBrief filter)
 *   - `planSlice` from `extractPlanForPass()` (regex section extraction)
 *   - `code` from `readFilesAsContext()` or `readFilesAsAnnotatedContext()`
 *     (sensitive-egress-gate applied at read time)
 * Passing raw user input bypasses these filters. Don't.
 *
 * @param {object} opts
 * @param {string} opts.systemRubric    - pass-specific static system prompt (e.g. PASS_STRUCTURE_SYSTEM + focusBlock)
 * @param {string} opts.brief           - audit brief (output of readProjectContextForPass)
 * @param {string} opts.planSlice       - pass-sliced plan content (output of extractPlanForPass)
 * @param {string} [opts.fileListContext=''] - optional file-list summary block
 * @param {string} [opts.requirementsRubric=''] - optional requirements-rubric
 *   block (output of `getRequirementsContext`). Static across rounds —
 *   lives in the cacheable msg #1. Empty string → no rubric injected.
 * @param {string} opts.code            - code to audit (file content or unit chunk)
 * @param {string} [opts.codeHeader='## Code'] - section header for the code message (per-pass varies, e.g. '## File Signatures')
 * @param {string|null} [opts.history=null]  - R2+ rulings block (null/empty on R1 → no msg #2)
 * @param {string|null} [opts.roundModifier=null] - R2_ROUND_MODIFIER text on R2+ (null on R1)
 * @param {string} [opts.unitLabel=''] - map-reduce unit label (e.g. "Audit Unit 3/7")
 * @returns {{ system: string, messages: Array<{role: 'user', content: string}> }}
 *
 * Output shape:
 *   - When neither history nor roundModifier: 2 messages [msg1, msg3]
 *   - When either history or roundModifier set: 3 messages [msg1, msg2, msg3]
 *
 * Cache-invariant guarantee (snapshot-tested):
 *   - `system` is byte-identical across calls with the same `systemRubric`,
 *     regardless of round, unitLabel, history, or code values.
 *   - `messages[0].content` (msg #1) is byte-identical across calls with the
 *     same `{ brief, planSlice, fileListContext, requirementsRubric }`
 *     regardless of round or unit context.
 */
export function buildAuditPassPrompt(opts) {
  validateOpts(opts);
  const {
    systemRubric,
    brief,
    planSlice,
    fileListContext = '',
    requirementsRubric = '',
    code,
    codeHeader = '## Code',
    history = null,
    roundModifier = null,
    unitLabel = '',
  } = opts;

  // System prompt is the static rubric ONLY. R2_ROUND_MODIFIER and rulings
  // move to dynamic msg #2 so system stays byte-identical across rounds.
  const system = systemRubric;

  // msg #1: stable prefix — cacheable across rounds AND map-reduce sub-units.
  const msg1Parts = [
    `## Project Context\n${brief}`,
    `## Plan\n${planSlice}`,
  ];
  if (fileListContext) msg1Parts.push(fileListContext);
  // Requirements rubric — static across rounds, so it stays in the cacheable
  // msg #1 (self-delimiting `<requirements_rubric>` block, no extra header).
  if (requirementsRubric) msg1Parts.push(requirementsRubric);
  const msg1 = msg1Parts.join('\n\n');

  // msg #2: dynamic — round-specific content. Omitted entirely on R1.
  const msg2Parts = [];
  if (roundModifier) msg2Parts.push(roundModifier);
  if (history) msg2Parts.push(`## Prior Rulings\n${history}`);
  const msg2 = msg2Parts.length > 0 ? msg2Parts.join('\n\n') : null;

  // msg #3 (or #2 when no R2 content): code + optional unit label.
  const codeHeaderFull = unitLabel ? `${codeHeader} (${unitLabel})` : codeHeader;
  const codeMsg = `${codeHeaderFull}\n${code}`;

  const messages = [{ role: 'user', content: msg1 }];
  if (msg2 !== null) messages.push({ role: 'user', content: msg2 });
  messages.push({ role: 'user', content: codeMsg });

  return { system, messages };
}

function validateOpts(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('buildAuditPassPrompt: opts must be an object');
  }
  for (const k of ['systemRubric', 'brief', 'planSlice', 'code']) {
    if (typeof opts[k] !== 'string') {
      throw new TypeError(`buildAuditPassPrompt: opts.${k} must be a string`);
    }
  }
  // Optional fields that affect prompt shape — validate types when present
  // so a bad caller (e.g. passing an array) doesn't silently produce
  // `[object Array]` substrings in the prompt.
  for (const k of ['fileListContext', 'requirementsRubric', 'codeHeader', 'unitLabel']) {
    if (opts[k] !== undefined && typeof opts[k] !== 'string') {
      throw new TypeError(`buildAuditPassPrompt: opts.${k} must be a string when set (got ${typeof opts[k]})`);
    }
  }
  for (const k of ['history', 'roundModifier']) {
    if (opts[k] !== undefined && opts[k] !== null && typeof opts[k] !== 'string') {
      throw new TypeError(`buildAuditPassPrompt: opts.${k} must be a string or null (got ${typeof opts[k]})`);
    }
  }
}

/**
 * Version tag for snapshot-test stability tracking. Bump when the prompt
 * shape changes intentionally; snapshot tests will fail and require update
 * via `UPDATE_SNAPSHOTS=1`.
 */
export const PROMPT_BUILDER_VERSION = '1.0.0';

/**
 * Cheap char-based token estimate (~chars/4) used to gate cache-seed
 * eligibility. Matches the heuristic used elsewhere in the audit pipeline
 * (e.g. computePassLimits) — no new tokenizer dependency in the hot path.
 *
 * @param {string} text
 * @returns {number} estimated token count
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the stable-prefix size for a pass (system + msg #1) to decide
 * cache-seed eligibility. The stable prefix is what OpenAI prefix-caches;
 * if it's below ~1024 tokens, caching is ineligible and seeding is pointless.
 *
 * Only `systemRubric`, `brief`, `planSlice`, `fileListContext`, and
 * `requirementsRubric` affect the stable prefix. `code` is part of msg #3
 * (dynamic) — pass any string or rely on the empty-string default; this
 * function ignores it.
 *
 * @param {object} opts - subset of buildAuditPassPrompt opts (code optional)
 * @returns {number} estimated stable-prefix token count
 */
export function estimateStablePrefixTokens(opts) {
  // Use empty code; the stable prefix doesn't include the code msg, but
  // buildAuditPassPrompt requires code to be a string for shape validity.
  // `code: ''` MUST come AFTER `...opts` so the override is final — otherwise
  // a caller's large `code` payload would defeat the empty-code intent.
  const built = buildAuditPassPrompt({
    ...opts,
    code: '',
    history: null,
    roundModifier: null,
  });
  return estimateTokens(built.system) + estimateTokens(built.messages[0].content);
}
