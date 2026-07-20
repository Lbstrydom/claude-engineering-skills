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
/**
 * GATE-ONLY secret shapes (plan: docs/plans/egress-secret-coverage-gap.md).
 *
 * **Why these live here and not in `secret-patterns.mjs`.** This gate delegated
 * entirely to `scanForSecrets` — the same module `redactSecrets` uses — so its
 * pattern set was a strict SUBSET of the redactor's. Two layers that share a
 * pattern list do not fail differently; they fail identically, and every shape
 * redaction missed passed the gate by construction. Measured 2026-07-19: an AWS
 * secret access key, a JWT, a PEM private key and a keyed 40-hex token all
 * reached a provider payload through both layers.
 *
 * They are added HERE and deliberately NOT to the redactor, because the two have
 * opposite failure costs. A false positive in the redactor silently corrupts text
 * — which is exactly why AGENTS.md pins the gentle `secret-patterns.mjs` over
 * `sanitizer.mjs`. A false positive in the gate merely REFUSES, and every one of
 * the 20 call sites was audited to fail safe on refusal (§4c of the plan).
 *
 * Every pattern below is measured at **zero** false positives against 18 MB of
 * real audit payload (200 commits of diffs). The bare forms were not: 40-hex
 * matched 227 times (all git SHAs) and 40-char base64 matched 301 times, which is
 * why those two require a secret-ish key nearby rather than matching on shape.
 *
 * Names are `gate:`-prefixed on purpose. `secret-patterns.mjs` already exports a
 * `pem-private-key`, and an unprefixed duplicate made the refusal message
 * ambiguous about WHICH layer fired — which cost real time during this change,
 * because a shared-scanner hit read as a gate-only hit and looked like a false
 * positive that was not there.
 */
const GATE_ONLY_PATTERNS = [
  // Ambiguous shapes — a bare match is overwhelmingly a git SHA or an ordinary
  // base64 blob, so require a secret-ish key within a short window.
  //
  // GAP + TERMINATOR NOTE (Gemini gate, R1 HIGH + MEDIUM — both were real):
  // an earlier revision spelled the gap as a NEGATED class (`[^0-9a-f]{0,12}` /
  // `[^A-Za-z0-9/+=]{0,12}`). Under `/i` those exclude every letter, so the gap
  // could not cross an ordinary variable-name suffix — `AWS_SECRET_KEY=…`,
  // `api_key_id=…` and `GITHUB_TOKEN_VALUE=…` all slipped through, i.e. the three
  // most common real spellings. The fixtures happened to use `secret <space>
  // <token>`, the one form that worked, so the suite was 12/12 green over a
  // pattern that missed the common case.
  // It also ended in `\b`, which cannot fire when the token ends in base64
  // padding (`=`) followed by a delimiter — both are non-word, so there is no
  // word/non-word transition. Terminators are now negative lookaheads.
  // NOTE — there is deliberately no separate `keyed-hex-40` rule. One existed and
  // was removed as redundant: hex is a SUBSET of the base64 alphabet and both
  // used the same gap, so `keyed-b64-40` already matches every keyed 40-hex
  // token. Its only unique coverage was a 41-character run (`secret=<40hex>g`),
  // which is not a 40-hex secret — i.e. a false positive, not coverage. Its
  // presence also made the b64 rule impossible to mutation-test: reverting the
  // hex rule left the suite green because b64 silently covered the same cases.
  [
    'gate:keyed-b64-40',
    /(token|secret|api[_-]?key|apikey|password|passwd|auth|credential|aws)(?:[A-Za-z0-9_.\-[\]"']{0,24}\s*[:=]\s*["']?|\s{1,3})([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
  ],
  // Structurally distinctive — safe to match bare (zero bare false positives).
  ['gate:jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  // TRUNCATED PEM — the case the redactor structurally cannot see. Its pattern
  // (secret-patterns.mjs:46) requires a matching `-----END … PRIVATE KEY-----`,
  // so a key clipped by a diff hunk or split across a payload boundary passes
  // through with its body intact. This wants header + base64 BODY and no
  // terminator, which is exactly the gap: a bare header is prose (correctly
  // ignored by both layers), a complete key is already redacted, and only the
  // truncated middle case leaks.
  ['gate:pem-truncated', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\r\n\s]+[A-Za-z0-9+/=]{40,}/],
];

/** @returns {string[]} names of gate-only patterns present in `text` */
function scanGateOnly(text) {
  const hits = [];
  for (const [name, re] of GATE_ONLY_PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

export function scanEgressPayload(payload) {
  const text = typeof payload === 'string' ? payload : (() => {
    try { return JSON.stringify(payload ?? ''); } catch { return String(payload); }
  })();
  try {
    const r = scanForSecrets(text);
    // Union of the shared redactor patterns and the gate-only set. The gate-only
    // scan runs even when `scanForSecrets` reports clean — that is the whole
    // point: the shapes it adds are precisely the ones the redactor does not know.
    const patterns = [...((r && r.patterns) || []), ...scanGateOnly(text)];
    return { safe: patterns.length === 0 && !(r && r.matched), patterns };
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
