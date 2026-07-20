/**
 * @fileoverview Query-side genre bridge for the architectural-memory consultation.
 *
 * THE PROBLEM THIS SOLVES (measured, not assumed — see
 * `docs/plans/arch-memory-band-recalibration.md` §1):
 *
 * The consultation embeds a user *intent* ("add a function that finds similar
 * existing symbols") while the index embeds a *purpose description* ("Queries
 * architectural-memory index for K-nearest symbols matching an intent."). Those
 * are different genres of English, and the gap is large: for the SAME function
 * against the SAME index text, intent-phrasing scores cosine 0.66 where
 * purpose-phrasing scores 0.91. Across 1,770 real consultations the maximum
 * similarity ever observed was 0.8294 — below the 0.85 `extend` cutoff — so the
 * `reuse` and `extend` bands never fired once in 1,763 decisions.
 *
 * This module rewrites the intent into the index's genre before embedding, so
 * the two sides are comparable. It is the dominant term of the fix (~0.25);
 * the `compose()` template accounted for a further ~0.06 and was fixed
 * separately on 2026-07-20 (file path + signature removed — see
 * `symbol-index.mjs` `compose`).
 *
 * CONTRACTS (plan §2.1):
 * - C1 — the caller redacts and egress-gates BEFORE calling in. This module
 *   never sees a raw intent and never bypasses the gate.
 * - C10 — caches only SUCCESSFUL LLM normalizations. Fallback output is never
 *   cached: one transient timeout would otherwise pin an intent to the fallback
 *   path permanently, and fallback is band-capped at `justify-divergence`.
 * - C4/C6 — `NORMALIZE_PROMPT_VERSION` is a CONTENT HASH of the prompt, not a
 *   hand-bumped constant. Editing the prompt mechanically invalidates cache
 *   keys and trips the stale-calibration guard, with no human in the loop.
 *
 * @module scripts/lib/arch-memory/normalize-intent
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';

const CACHE_REL = '.audit-loop/cache/intent-normalizations.json';
const CACHE_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000;

/** Hard bounds — an intent is a sentence, not a document (C10). */
export const MAX_INTENT_CHARS = 2000;
export const MAX_OUTPUT_CHARS = 400;
export const NORMALIZE_TIMEOUT_MS = 10_000;

/**
 * The prompt. Kept as a module-level constant so its hash IS the version —
 * see NORMALIZE_PROMPT_VERSION below. Do not inline it into the call site.
 */
export const NORMALIZE_PROMPT = [
  'Rewrite the developer intent below as a one-line PURPOSE DESCRIPTION, in the',
  'style used to document what an existing function already does.',
  '',
  'Rules:',
  '- Start with a third-person verb ("Queries", "Resolves", "Writes", "Validates").',
  '- Describe WHAT THE CODE DOES, not what the developer wants to do.',
  '- Do not say "add", "create", "implement", "I want", or "we need".',
  '- One sentence. No preamble, no quotes, no markdown.',
  '',
  'Example:',
  '  intent:  "add a function that finds similar existing symbols before writing new code"',
  '  output:  Queries the symbol index for the nearest existing symbols matching an intent.',
].join('\n');

/**
 * Content hash of the prompt (C6). A prompt edit changes this automatically,
 * which invalidates every cache entry and calibration bound to the old text.
 * This is deliberately NOT a hand-maintained constant: the defect this whole
 * plan fixes was two coupled values drifting apart with nothing enforcing it,
 * and re-introducing a "remember to bump me" convention would rebuild that bug
 * one layer up.
 */
export const NORMALIZE_PROMPT_VERSION = crypto
  .createHash('sha256')
  .update(NORMALIZE_PROMPT)
  .digest('hex')
  .slice(0, 12);

/**
 * Deterministic, provider-free fallback (C10). Strips the intent-genre verb
 * scaffolding so the text moves toward purpose genre without an LLM call.
 *
 * This is a DEGRADED path, not an equivalent one — its output distribution
 * differs from LLM-normalized text, so callers must cap its band at
 * `justify-divergence` (C4) rather than trusting a calibrated threshold.
 *
 * @param {string} safeIntent - already redacted by the caller (C1)
 * @returns {string}
 */
export function deterministicNormalize(safeIntent) {
  const s = String(safeIntent || '').trim();
  if (!s) return '';
  return s
    // Leading first-person / imperative intent framing.
    .replace(/^\s*(?:i\s+(?:want|need)\s+to|we\s+(?:want|need)\s+to|please|let'?s)\s+/i, '')
    // Intent verbs → purpose verbs. Only at the head; mid-sentence "add" may be real.
    .replace(/^\s*add\s+(?:a|an|the)?\s*/i, 'Provides ')
    .replace(/^\s*create\s+(?:a|an|the)?\s*/i, 'Provides ')
    .replace(/^\s*implement\s+(?:a|an|the)?\s*/i, 'Provides ')
    .replace(/^\s*build\s+(?:a|an|the)?\s*/i, 'Provides ')
    .replace(/^\s*write\s+(?:a|an|the)?\s*/i, 'Provides ')
    .replace(/^\s*make\s+(?:a|an|the)?\s*/i, 'Provides ')
    .replace(/^\s*fix\s+/i, 'Handles ')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_OUTPUT_CHARS)
    .trim();
}

function cacheFile(repoRoot) {
  return path.join(repoRoot, CACHE_REL);
}

function loadCache(repoRoot) {
  const file = cacheFile(repoRoot);
  if (!fs.existsSync(file)) return { entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

/**
 * Cache key (C2/C10). Keyed on the REDACTED intent — never the raw text — so a
 * secret in a prompt is never hashed into, or written to, a disk cache file,
 * and two intents differing only by an embedded secret share one entry.
 */
export function normalizationCacheKey(safeIntent, normalizerId) {
  return crypto
    .createHash('sha256')
    .update(`${safeIntent}|${normalizerId}|${NORMALIZE_PROMPT_VERSION}`)
    .digest('hex')
    .slice(0, 24);
}

function getCached(repoRoot, key, ttlMs) {
  const e = loadCache(repoRoot).entries[key];
  if (!e) return null;
  if (Date.now() - e.savedAt > ttlMs) return null;
  return typeof e.text === 'string' ? e.text : null;
}

function putCached(repoRoot, key, text) {
  const cache = loadCache(repoRoot);
  cache.entries[key] = { text, savedAt: Date.now() };
  const file = cacheFile(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(cache, null, 2));
}

/**
 * Normalize a developer intent into index (purpose) genre.
 *
 * NEVER THROWS into the query path (C10). Any provider error, timeout, empty
 * response, or missing client degrades to `deterministicNormalize` with
 * `mode: 'fallback'`, which the caller must band-cap.
 *
 * @param {string} safeIntent - MUST already be redacted + egress-gated (C1)
 * @param {object} [opts]
 * @param {string} [opts.repoRoot=process.cwd()]
 * @param {number} [opts.ttlMs]
 * @param {Function} [opts.createClient] - injected for tests
 * @param {Function} [opts.isAvailable] - injected for tests
 * @returns {Promise<{text: string, mode: 'llm'|'fallback', normalizerId: string, reason?: string}>}
 */
export async function normalizeIntentToPurpose(safeIntent, opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const ttlMs = opts.ttlMs ?? CACHE_TTL_MS_DEFAULT;
  const raw = String(safeIntent || '');
  const bounded = raw.length > MAX_INTENT_CHARS ? raw.slice(0, MAX_INTENT_CHARS) : raw;

  if (!bounded.trim()) {
    return { text: '', mode: 'fallback', normalizerId: 'none', reason: 'empty-intent' };
  }

  let createClient = opts.createClient;
  let isAvailable = opts.isAvailable;
  let normalizerId = 'unknown';
  try {
    const mod = await import('../anthropic-client.mjs');
    createClient = createClient || mod.createAnthropicClient;
    isAvailable = isAvailable || mod.isClaudeAvailable;
    const { symbolIndexConfig } = await import('../config.mjs');
    normalizerId = symbolIndexConfig?.summariseModel || 'unknown';
  } catch (err) {
    return {
      text: deterministicNormalize(bounded),
      mode: 'fallback',
      normalizerId,
      reason: `client-module-unavailable: ${err.code || err.message}`,
    };
  }

  // Backend-aware availability (AGENTS.md): the cli backend authenticates via
  // the `claude` CLI and needs no key, so a raw ANTHROPIC_API_KEY check here
  // would silently skip a fully-available backend.
  try {
    if (typeof isAvailable === 'function' && !(await isAvailable())) {
      return {
        text: deterministicNormalize(bounded),
        mode: 'fallback',
        normalizerId,
        reason: 'claude-unavailable',
      };
    }
  } catch {
    return {
      text: deterministicNormalize(bounded),
      mode: 'fallback',
      normalizerId,
      reason: 'availability-check-failed',
    };
  }

  const key = normalizationCacheKey(bounded, normalizerId);
  const hit = getCached(repoRoot, key, ttlMs);
  if (hit) return { text: hit, mode: 'llm', normalizerId };

  try {
    // MUST pin the sdk backend (measured 2026-07-19; new instance of the
    // AGENTS.md cli-backend gotcha, for a different reason than tool_choice).
    // Under CLAUDE_BACKEND=cli this spawns `claude -p`, which (a) took 36.3s
    // vs 0.9s on the sdk, and (b) does not honour `system` as a terse
    // instruction — it answered as an interactive Claude Code session, reading
    // AGENTS.md and returning a multi-paragraph essay instead of a one-line
    // purpose sentence. That output is unusable as an embedding input, and its
    // apparent similarity lift was an accident of shared vocabulary.
    const client = await createClient({ backend: 'sdk' });
    const resp = await Promise.race([
      client.messages.create({
        model: normalizerId,
        max_tokens: 200,
        system: NORMALIZE_PROMPT,
        messages: [{ role: 'user', content: bounded }],
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('normalize-timeout')), NORMALIZE_TIMEOUT_MS).unref?.()
      ),
    ]);

    const text = (resp?.content || [])
      .filter(b => b && b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
      .slice(0, MAX_OUTPUT_CHARS);

    if (!text) {
      return {
        text: deterministicNormalize(bounded),
        mode: 'fallback',
        normalizerId,
        reason: 'empty-response',
      };
    }

    // Only successful LLM normalizations are cached (C10 / Gemini G1).
    putCached(repoRoot, key, text);
    return { text, mode: 'llm', normalizerId };
  } catch (err) {
    return {
      text: deterministicNormalize(bounded),
      mode: 'fallback',
      normalizerId,
      reason: `provider-error: ${err.message || 'unknown'}`,
    };
  }
}

export const _internals = { loadCache, getCached, putCached, cacheFile, CACHE_REL };
