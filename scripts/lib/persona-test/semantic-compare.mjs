/**
 * @fileoverview LLM-backed prose-vs-prose comparator for the consistency rig.
 *
 * Phase 1 of docs/plans/persona-test-consistency-mode.md.
 *
 * Contract (resolves R1-H4 + R3-M1):
 *   - Repo-standard envelope: returns `{result: SemanticVerdict, usage, latencyMs}`
 *   - Inner `SemanticVerdict` is `{matched, score?, reason?}` — no telemetry
 *     fields in the inner schema (Gemini-R4-G4)
 *   - REFUSES to run for non-prose fieldType — throws CROSS_STREAM_VIOLATION
 *     (acceptance criterion in the audited plan)
 *   - Gated by `llmSafe` at the caller boundary (consistency.mjs skips
 *     non-llmSafe fields entirely; this module is the second line of defence)
 *   - Pre-egress redaction via `redact.mjs` — never sends raw text to the
 *     provider without running the secret scanner first
 *   - llmMaxChars cap (Gemini-R5-G1) — payloads beyond the cap are truncated
 *     AND the verdict carries `reason: 'prose-truncated-for-llm'` so the
 *     engineer knows comparison was lossy
 *
 * Cache: per-session JSON at `.persona-test/sessions/<SID>-semantic-cache.json`.
 * Per-session avoids the concurrent-write problem (Gemini-R5-G3 / R3-M3); a
 * separate end-of-session merger folds the cache into a shared file under
 * a lockfile.
 *
 * @module scripts/lib/persona-test/semantic-compare
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SemanticVerdictSchema } from './schemas.mjs';
import { redact } from '../redact.mjs';
import { resolveModel, parseClaudeModel, parseGeminiModel } from '../model-resolver.mjs';

// Resolves Gemini-final-G4: plan §11 Boundary 1 step 3 mandates an
// explicit allowlist of permitted egress destinations. The semantic
// comparator refuses to invoke unknown providers — only Claude/Anthropic
// or Google/Gemini are sanctioned. OpenAI/other providers throw at the
// boundary so a misconfigured `PERSONA_CONSISTENCY_SEMANTIC_MODEL` cannot
// quietly send prose to a provider the security review didn't sign off on.
function assertEgressApproved(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return;   // wrapper default
  let resolved;
  try { resolved = resolveModel(modelId, { silent: true }); }
  catch { resolved = modelId; }
  const isClaude  = !!parseClaudeModel(resolved)  || /^(claude-|anthropic\/)/i.test(resolved) || /^latest-(opus|sonnet|haiku)$/.test(resolved);
  const isGemini  = !!parseGeminiModel(resolved)  || /^gemini-/i.test(resolved) || /^latest-(pro|flash|flash-lite)$/.test(resolved);
  if (!isClaude && !isGemini) {
    throw new Error(
      `semantic-compare egress refused: model "${modelId}" (resolved="${resolved}") is not in the approved provider allowlist ` +
      '(Anthropic Claude or Google Gemini only — see plan §11 Boundary 1). ' +
      'Set PERSONA_CONSISTENCY_SEMANTIC_MODEL to a `claude-*` or `gemini-*` id (or a `latest-*` sentinel that resolves to one).',
    );
  }
}

/**
 * The provider returns a JSON object matching `SemanticVerdictSchema`.
 * On parse failure we emit the deterministic fallback verdict (R2-M1).
 */
const FALLBACK_VERDICT = Object.freeze({ matched: 'uncertain', reason: 'provider-parse-failed' });

const SYSTEM_PROMPT =
  'You compare two short prose strings and decide whether they make the same claim. ' +
  'Output ONLY JSON: {"matched":"yes"|"no"|"uncertain","score":0..1,"reason":"<short>"}. ' +
  'Use "yes" when both express the same factual claim, "no" when they contradict, "uncertain" when ambiguous. ' +
  '"score" is your confidence in the verdict.';

/**
 * Compare two prose strings.
 *
 * @param {string} textA
 * @param {string} textB
 * @param {string} fieldType                      - MUST be 'prose'; else throws
 * @param {object} [opts]
 * @param {Function} [opts.callLLM]               - Injected wrapper from llm-wrappers.mjs (callClaude or callGemini). Required at runtime; absent ⇒ throws.
 * @param {object} [opts.provider]                - The pre-configured Anthropic/Gemini client. Passed through to callLLM.
 * @param {string} [opts.model]                   - Optional model id override.
 * @param {number} [opts.maxChars]                - Per-input truncation cap (default 2000)
 * @param {(rec: {timestamp: string, surfaceId: string|null, charsIn: number, redactionCount: number}) => void} [opts.logEgress]
 * @param {{ get(key: string): unknown, set(key: string, value: unknown): void }} [opts.cache]
 * @param {string} [opts.surfaceId]               - For egress logging only
 * @returns {Promise<{result: import('./schemas.mjs').SemanticVerdict, usage: object, latencyMs: number}>}
 */
export async function compare(textA, textB, fieldType, opts = {}) {
  if (fieldType !== 'prose') {
    throw new Error(
      `CROSS_STREAM_VIOLATION: semantic-compare invoked for fieldType="${fieldType}". ` +
      'Only "prose" fields may use semantic comparison; typed fields (boolean/integer/' +
      'count/enum/id/freshness) must use exact-match via the diff engine.',
    );
  }
  if (typeof textA !== 'string' || typeof textB !== 'string') {
    throw new Error('semantic-compare: both inputs must be strings');
  }

  const maxChars = Number.isInteger(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 2000;
  // Resolves R2-H6: redact FIRST, truncate AFTER. The previous order let
  // a secret straddling the maxChars boundary be cut in half — half of
  // an OpenAI key (e.g. `sk-AAAAAAAAAAAAAAAA...`) doesn't match the
  // pattern and would pass through to the provider. Redacting on the
  // full input then truncating the already-safe text preserves the
  // egress guarantee at any cap.
  const aFull = redact(textA);
  const bFull = redact(textB);
  const aRaw = aFull.redacted.length > maxChars ? aFull.redacted.slice(0, maxChars) : aFull.redacted;
  const bRaw = bFull.redacted.length > maxChars ? bFull.redacted.slice(0, maxChars) : bFull.redacted;
  const truncated = aFull.redacted.length > maxChars || bFull.redacted.length > maxChars;

  // The "a"/"b" handles below are kept for the cacheKey + log-emit lines.
  const a = { redacted: aRaw, count: aFull.count, patternsHit: aFull.patternsHit };
  const b = { redacted: bRaw, count: bFull.count, patternsHit: bFull.patternsHit };
  const redactionCount = a.count + b.count;

  // Cache lookup — key is content-hash of redacted text + model (if provided).
  const cacheKey = makeCacheKey(a.redacted, b.redacted, opts.model);
  if (opts.cache) {
    const cached = safeCacheGet(opts.cache, cacheKey);
    if (cached) {
      // Cached verdicts carry the deterministic verdict only — operational
      // telemetry (latencyMs, usage) is regenerated as zeros to keep the
      // output shape consistent.
      return { result: cached, usage: { cache_hit: 1 }, latencyMs: 0 };
    }
  }

  if (typeof opts.callLLM !== 'function' || !opts.provider) {
    // No comparator wired — return uncertain with explicit reason so the
    // diff engine can record it without falsely flagging a mismatch.
    return {
      result: { matched: 'uncertain', reason: 'comparator-not-configured' },
      usage: {},
      latencyMs: 0,
    };
  }

  // Resolves Gemini-final-G4: enforce model-allowlist before any egress.
  // Thrown errors propagate to the caller — refusing to call rather than
  // silently downgrading prevents an unsigned-off model from receiving
  // user data even when callLLM is hooked up.
  if (opts.model) assertEgressApproved(opts.model);

  const userPrompt = renderUserPrompt(a.redacted, b.redacted, truncated);
  // Resolves R2-H8: wrap the wrapper. Provider timeouts, auth failures,
  // SDK exceptions, transient HTTP errors must NOT abort the entire
  // consistency run — semantic compare is best-effort and degrades to
  // 'uncertain' on any error.
  let envelope;
  try {
    envelope = await opts.callLLM(
      opts.provider,
      SYSTEM_PROMPT,
      userPrompt,
      SemanticVerdictSchema,
      opts.model ? { model: opts.model } : {},
    );
  } catch (err) {
    // Resolves R4-H3: SDK exceptions commonly include endpoint URLs, model
    // identifiers, filesystem paths, sometimes auth metadata. Run the raw
    // error message through redact() so any matched secret patterns get
    // replaced before we surface them in the (cached, logged) verdict.
    const rawMsg = err?.message || String(err);
    const safeMsg = redact(rawMsg).redacted.slice(0, 200);
    return {
      result: { matched: 'uncertain', reason: `provider-error: ${safeMsg}` },
      usage: {},
      latencyMs: 0,
    };
  }

  let verdict;
  if (!envelope || !envelope.result) {
    verdict = FALLBACK_VERDICT;
  } else {
    const parsed = SemanticVerdictSchema.safeParse(envelope.result);
    verdict = parsed.success ? parsed.data : FALLBACK_VERDICT;
  }

  if (truncated && (!verdict.reason || verdict.reason.length === 0)) {
    verdict = { ...verdict, reason: 'prose-truncated-for-llm' };
  }

  if (opts.cache) {
    safeCacheSet(opts.cache, cacheKey, verdict);
  }

  if (typeof opts.logEgress === 'function') {
    try {
      opts.logEgress({
        timestamp: new Date().toISOString(),
        surfaceId: opts.surfaceId ?? null,
        charsIn: a.redacted.length + b.redacted.length,
        redactionCount,
        truncated,
      });
    } catch {
      // egress logging must never throw out of the compare path
    }
  }

  return {
    result: verdict,
    usage: envelope?.usage || {},
    latencyMs: envelope?.latencyMs ?? 0,
  };
}

function renderUserPrompt(a, b, truncated) {
  const note = truncated ? '\n\n(Inputs were truncated to the manifest maxChars cap.)' : '';
  return [
    'Compare these two prose values from a state-rendering UI surface against the engine\'s ground-truth prose.',
    '',
    `A (DOM-rendered):  ${a}`,
    `B (engine source): ${b}`,
    note,
    '',
    'Return verdict JSON as instructed.',
  ].filter(Boolean).join('\n');
}

function makeCacheKey(a, b, model) {
  const h = createHash('sha256');
  h.update(a);
  h.update('\x00');
  h.update(b);
  h.update('\x00');
  h.update(model || '');
  return h.digest('hex');
}

function safeCacheGet(cache, key) {
  try {
    const v = cache.get(key);
    if (!v) return null;
    const parsed = SemanticVerdictSchema.safeParse(v);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function safeCacheSet(cache, key, verdict) {
  try { cache.set(key, verdict); } catch { /* cache failures are non-fatal */ }
}

/**
 * Minimal in-memory cache compatible with the optional `opts.cache` shape.
 * Disk persistence is added by the runner — this is a stand-in for tests
 * and ad-hoc invocations.
 */
export function createInMemoryCache() {
  const map = new Map();
  return {
    get: (k) => map.get(k),
    set: (k, v) => map.set(k, v),
    size: () => map.size,
  };
}

// Test-internal exports.
export const _internals = Object.freeze({
  SYSTEM_PROMPT,
  FALLBACK_VERDICT,
  renderUserPrompt,
  makeCacheKey,
});
