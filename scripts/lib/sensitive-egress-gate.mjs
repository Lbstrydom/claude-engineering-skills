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
import { classifyPath } from './sensitive-paths.mjs';
import { scanForSecrets, redactSecrets as redactSecretsImpl } from './secret-patterns.mjs';

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
 * Redact secret patterns from a payload before logging. Delegates to the
 * shared implementation for consistency with the rest of the codebase.
 *
 * @param {string|object} payload
 * @returns {string}
 */
export function redactSecrets(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  try {
    // secret-patterns.redactSecrets returns {text, redacted}
    const r = redactSecretsImpl(text);
    if (r && typeof r === 'object' && typeof r.text === 'string') return r.text;
    return typeof r === 'string' ? r : text;
  } catch {
    return text;
  }
}

/**
 * Decide what to do with a candidate symbol body before it's sent to a
 * provider (LLM summary or embedding).
 *
 * @param {{filePath: string, bodyText: string}} input
 * @returns {{action: 'send'|'skip-path'|'skip-extension'|'redact-content', reason: string}}
 */
export function gateSymbolForEgress({ filePath, bodyText }) {
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
