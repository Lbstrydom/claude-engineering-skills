/**
 * @fileoverview Hybrid secret/PII gate for security-incident writes.
 *
 * Plan: docs/plans/security-strategy-postgres-port.md §4.4.
 *
 * Two-tier policy:
 *   - HIGH_CONFIDENCE patterns (API key shapes, JWTs, AWS keys, private keys)
 *     are unambiguous → REFUSE the write. The operator must edit the markdown.
 *   - LOW_CONFIDENCE PII (emails, phone numbers) is auto-redacted with a loud
 *     warning — refusal would block legitimate incidents over noisy matches.
 *
 * Deviation from the plan's literal pattern list: the proper-name regex
 * (`[A-Z][a-z]+ [A-Z][a-z]+`) is detection-only and NOT auto-redacted. It
 * matches ordinary capitalised prose ("Threat Model", "Security Strategy",
 * incident titles) and auto-redacting it would corrupt the stored incident
 * text + embeddings. Emails and phone numbers are the genuinely-redactable
 * low-confidence PII. Names are surfaced as a warning so a human can decide.
 *
 * @module scripts/lib/security/secret-classifier
 */

import { redactSecrets } from '../sanitizer.mjs';

// Unambiguous secret shapes → refuse.
const HIGH_CONFIDENCE = [
  { name: 'openai-key', re: /sk-[a-zA-Z0-9]{32,}/g },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'jwt', re: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\./g },
  { name: 'slack-token', re: /xox[bpoa]-[a-zA-Z0-9-]{10,}/g },
  { name: 'github-pat', re: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

// Redactable low-confidence PII.
const LOW_CONFIDENCE_REDACT = [
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, token: '[REDACTED-EMAIL]' },
  { name: 'phone', re: /\b\d{3}[-\s]\d{3}[-\s]\d{4}\b/g, token: '[REDACTED-PHONE]' },
];

// Detection-only (warned, never auto-redacted — see file header).
const LOW_CONFIDENCE_WARN = [
  { name: 'proper-name', re: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g },
];

/**
 * Classify a block of text into high/low-confidence secret hits.
 * Pure — no I/O, no mutation. Each hit carries a short masked sample.
 *
 * @param {string} text
 * @returns {{highConfidence: Array<{pattern:string,sample:string}>,
 *            lowConfidence: Array<{pattern:string,sample:string}>}}
 */
export function classifySecrets(text) {
  const hits = { highConfidence: [], lowConfidence: [] };
  if (typeof text !== 'string' || text.length === 0) return hits;

  for (const { name, re } of HIGH_CONFIDENCE) {
    for (const m of text.matchAll(re)) {
      hits.highConfidence.push({ pattern: name, sample: maskSample(m[0]) });
    }
  }
  for (const { name, re } of [...LOW_CONFIDENCE_REDACT, ...LOW_CONFIDENCE_WARN]) {
    for (const m of text.matchAll(re)) {
      hits.lowConfidence.push({ pattern: name, sample: maskSample(m[0]) });
    }
  }
  return hits;
}

/**
 * Gate one block of content before it is written to security_incidents.
 *
 * @param {string} content
 * @returns {{ok: boolean, kind: 'clean'|'redacted'|'refused', content?: string,
 *            detail?: string, warning?: string,
 *            events: Array<{event_kind: string, detail: object}>}}
 *   - refused  → ok:false, kind:'refused', events:[refused_secret ...]
 *   - redacted → ok:true,  kind:'redacted', content:<redacted>, events:[redacted_secret ...]
 *   - clean    → ok:true,  kind:'clean', content:<original>, events:[]
 */
export function preWriteSecretGate(content) {
  const c = classifySecrets(content);

  if (c.highConfidence.length > 0) {
    return {
      ok: false,
      kind: 'refused',
      detail:
        `High-confidence secret pattern(s) detected: ` +
        `${[...new Set(c.highConfidence.map(h => h.pattern))].join(', ')}. ` +
        `Edit the markdown to remove the secret and retry.`,
      events: c.highConfidence.map(h => ({
        event_kind: 'refused_secret',
        detail: { pattern: h.pattern, sample: h.sample },
      })),
    };
  }

  // Apply only the redactable low-confidence patterns to the stored content.
  let redacted = content;
  const redactEvents = [];
  for (const { name, re, token } of LOW_CONFIDENCE_REDACT) {
    // matchAll first (never .test() on a shared /g regex — it leaves lastIndex
    // non-zero and would make a later matchAll start mid-string).
    const matches = [...content.matchAll(re)];
    if (matches.length === 0) continue;
    redacted = redacted.replace(re, token);
    for (const m of matches) {
      redactEvents.push({ event_kind: 'redacted_secret', detail: { pattern: name, sample: maskSample(m[0]) } });
    }
  }
  // Defence in depth: run the shared sanitizer for any high-ish leftovers.
  redacted = redactSecrets(redacted);

  if (redactEvents.length > 0) {
    return {
      ok: true,
      kind: 'redacted',
      content: redacted,
      warning: `Low-confidence PII auto-redacted: ${redactEvents.length} hit(s).`,
      events: redactEvents,
    };
  }

  return { ok: true, kind: 'clean', content: redacted, events: [] };
}

/** First 6 chars + ellipsis — enough to triage, not enough to leak. */
function maskSample(s) {
  return String(s).slice(0, 6) + '…';
}
