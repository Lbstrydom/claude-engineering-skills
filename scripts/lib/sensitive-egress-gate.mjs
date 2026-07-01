/**
 * @fileoverview Two-stage sensitive-content egress gate (R2 H11, Gemini G).
 *
 * Hard project rule (per AGENTS.md "Do NOT" list): `.env` and credential
 * files MUST NEVER be sent to external APIs. This module enforces that
 * via path filter + content scrub + payload redaction.
 *
 * Reuses scripts/lib/secret-patterns.mjs for the regex patterns rather than
 * duplicating them.
 *
 * @module scripts/lib/sensitive-egress-gate
 */

import path from 'node:path';
import { classifyPath, resolveAndClassify } from './sensitive-paths.mjs';
import { scanForSecrets, redactSecrets as redactSecretsImpl } from './secret-patterns.mjs';
import { redactObject } from './redact.mjs';

/** Allowlist: only these extensions ever send body content to providers. */
export const DEFAULT_EXT_ALLOWLIST = Object.freeze([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte',
]);

/** Marker placed in `purpose_summary` when content scrub catches secrets. */
export const SECRET_REDACTED = '[SECRET_REDACTED]';

/**
 * True iff the path matches EITHER canonical category — `sensitive` (secrets,
 * keys, credentials, …) OR `generatedNoise` (lockfiles, *.min.js, *.map).
 *
 * Lockfiles are intentionally blocked from LLM egress even though they're
 * not secret — they blow context windows without adding signal, and the
 * pre-WS3 denylist already excluded them (plan: Gemini-r3-G2).
 *
 * @param {string} filePath - repo-relative or absolute path
 * @returns {boolean}
 */
export function isPathSensitive(filePath) {
  return classifyPath(filePath) !== null;
}

/**
 * @param {string} filePath
 * @param {string[]} [allowlist]
 * @returns {boolean}
 */
export function isExtensionAllowlisted(filePath, allowlist = DEFAULT_EXT_ALLOWLIST) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return allowlist.includes(ext);
}

/**
 * Scan body text for secret patterns. Returns true if any pattern matches.
 * @param {string} bodyText
 * @returns {boolean}
 */
export function containsSecrets(bodyText) {
  if (!bodyText) return false;
  try {
    const result = scanForSecrets(bodyText);
    // scanForSecrets returns {matched: boolean, patterns: string[]}
    return Boolean(result && result.matched);
  } catch {
    // scanForSecrets errored; assume worst case for safety
    return true;
  }
}

/**
 * Redact secret patterns from a payload before logging. **Fail-closed**:
 * any path that can't produce a sanitized output returns
 * `[REDACTED:redaction-failed]` rather than the raw payload or any
 * partial stringification of it (WS-CANON #9).
 *
 * Strings go through the text redactor. Anything else routes through
 * `redact.mjs::redactObject` — recursive, depth/node-capped, ancestor-
 * stack cycle detection. The previous implementation did
 * `JSON.stringify(payload)` OUTSIDE the try block, so non-serializable
 * inputs (BigInt, circular refs, throwing `toJSON`) threw the whole
 * function — and even when the catch fired, it returned `text` which
 * for non-string inputs was whatever `JSON.stringify` had produced
 * BEFORE throwing (often the full payload). This rewrite closes that.
 *
 * @param {string|object} payload
 * @returns {string}
 */
export function redactSecrets(payload) {
  // String path — bounded text redactor.
  if (typeof payload === 'string') {
    try {
      const r = redactSecretsImpl(payload);
      if (r && typeof r === 'object' && typeof r.text === 'string') return r.text;
      return typeof r === 'string' ? r : payload;
    } catch {
      // Fail-closed: NEVER return the raw payload on redactor failure.
      return '[REDACTED:redaction-failed]';
    }
  }
  // Object/array/primitive path — recursive redactor with depth + node
  // caps + cycle detection. Stringification happens on the SANITIZED
  // output only, so BigInt / circular leaks are impossible by then
  // (redactObject replaces them with placeholders).
  try {
    const r = redactObject(payload, { depth: 8 });
    // redactObject returns {redacted, count, patternsHit}; the
    // .redacted shape mirrors the input but with secrets/cycles/caps
    // replaced by safe placeholder strings.
    return JSON.stringify(r.redacted);
  } catch {
    return '[REDACTED:redaction-failed]';
  }
}

/**
 * Scan an outgoing provider payload (already-assembled prompt/messages text)
 * for secret patterns. Model-A/B/C harness Phase 2 (Security §): the OSS arm
 * sends our source to a NEW external provider (OpenRouter), so the egress gate
 * MUST be provable on that exact client path. This is the read-only detector;
 * `assertEgressSafe` is the enforcing wrapper.
 *
 * Fail-closed: a scanner error is treated as "unsafe" (matched), never "clean".
 *
 * @param {string|object} payload
 * @returns {{ safe: boolean, patterns: string[] }}
 */
export function scanEgressPayload(payload) {
  const text = typeof payload === 'string' ? payload : (() => {
    try { return JSON.stringify(payload ?? ''); } catch { return String(payload); }
  })();
  try {
    const r = scanForSecrets(text);
    return { safe: !(r && r.matched), patterns: (r && r.patterns) || [] };
  } catch {
    // Fail-closed — a scanner failure must not read as "clean".
    return { safe: false, patterns: ['scan-error'] };
  }
}

/**
 * Enforcing egress guard: THROW (refuse to send) if a secret pattern is present
 * in the payload. Called at the OSS adapter boundary as defence-in-depth on top
 * of redact-once upstream (decision 11) — a detected secret means the upstream
 * redaction FAILED and the fix belongs there, so we refuse rather than silently
 * scrub-and-send to a new provider.
 *
 * @param {string|object} payload
 * @param {{label?: string}} [opts]
 * @returns {true}
 */
export function assertEgressSafe(payload, { label = 'oss-arm' } = {}) {
  const { safe, patterns } = scanEgressPayload(payload);
  if (!safe) {
    throw new Error(
      `[egress-gate] refusing to send ${label} payload to an external provider — ` +
      `secret pattern(s) detected: ${patterns.join(', ')}. This indicates a redact-once ` +
      `upstream failure; redact the payload before it reaches the provider (do NOT bypass this gate).`,
    );
  }
  return true;
}

/**
 * Decide what to do with a candidate symbol body before it's sent to a
 * provider (LLM summary or embedding).
 *
 * `repoRoot` enables the canonical-path enforcement layer (WS-CANON):
 * `resolveAndClassify` follows symlinks and classifies the RESOLVED
 * target, so an innocent-named symlink (`repo/notes.txt`) pointing at
 * a sensitive location (`~/.ssh/id_rsa`) is caught. Callers that have
 * `repoRoot` available (extract.mjs already does — `args.root`) should
 * pass it. When omitted, the gate falls back to lexical-only
 * classification (the pre-WS-CANON behaviour) to preserve backward
 * compatibility for existing callers.
 *
 * On a `send` action the result includes `canonicalAbsPath` — the path
 * the caller should READ from (so a TOCTOU window between gate-check
 * and file-read is minimised; callers should still re-fstat after open
 * for full defence-in-depth).
 *
 * Plan: docs/plans/liveness-and-canonical-paths.md WS-CANON #7.
 *
 * @param {{filePath: string, bodyText: string, repoRoot?: string}} input
 * @returns {{
 *   action: 'send' | 'skip-path' | 'skip-extension' | 'redact-content' | 'skip-symlink-escape',
 *   reason: string,
 *   canonicalAbsPath?: string,
 * }}
 */
export function gateSymbolForEgress({ filePath, bodyText, repoRoot }) {
  // Canonical-path enforcement path (WS-CANON): resolve the symlink,
  // classify the canonical target, fail-closed on resolution errors,
  // and surface symlink-escapes as a distinct action.
  if (repoRoot) {
    const cls = resolveAndClassify(filePath, { repoRoot });
    if (cls.escapedRepo) {
      return {
        action: 'skip-symlink-escape',
        reason: `path resolves outside repoRoot (symlink escape): ${filePath} → ${cls.canonical}`,
      };
    }
    if (cls.category === 'sensitive') {
      // Distinguish lexical-vs-canonical match for the operator log.
      const reason = cls.resolutionFailed
        ? `path could not be resolved (fail-closed): ${filePath}`
        : cls.lexical === 'sensitive'
          ? `path matches sensitive denylist: ${filePath}`
          : `canonical target matches sensitive denylist: ${filePath} → ${cls.canonical}`;
      return { action: 'skip-path', reason };
    }
    // Gemini-r2-G2 (WS-CANON regression-fix): the pre-WS-CANON
    // `isPathSensitive` returned true for BOTH categories — sensitive
    // (secrets) AND generatedNoise (lockfiles, *.min.js, *.map). The
    // new repoRoot branch only checked `sensitive`, so a `bundle.min.js`
    // file slipped through with `action: 'send'` because `.js` is on
    // the extension allowlist. Block generatedNoise here to preserve
    // the pre-WS-CANON contract.
    if (cls.category === 'generatedNoise') {
      return { action: 'skip-path', reason: `path matches generated-noise denylist: ${filePath}` };
    }
    if (!isExtensionAllowlisted(filePath)) {
      return { action: 'skip-extension', reason: `extension not in summarise allowlist: ${path.extname(filePath)}` };
    }
    if (containsSecrets(bodyText)) {
      return { action: 'redact-content', reason: 'body contains secret patterns' };
    }
    return { action: 'send', reason: 'allowed', canonicalAbsPath: cls.canonical };
  }

  // Pre-WS-CANON behaviour preserved for callers without repoRoot.
  if (isPathSensitive(filePath)) {
    return { action: 'skip-path', reason: `path matches sensitive denylist: ${filePath}` };
  }
  if (!isExtensionAllowlisted(filePath)) {
    return { action: 'skip-extension', reason: `extension not in summarise allowlist: ${path.extname(filePath)}` };
  }
  if (containsSecrets(bodyText)) {
    return { action: 'redact-content', reason: 'body contains secret patterns' };
  }
  return { action: 'send', reason: 'allowed' };
}
