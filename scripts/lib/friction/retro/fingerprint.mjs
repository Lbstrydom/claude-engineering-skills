/**
 * @fileoverview Normalise a failure signal's text and fingerprint it (plan
 * docs/plans/harness-retro.md §2 component 3). The ONE normaliser — the scanner,
 * the inventory matcher and the registry all key on what this returns, so two
 * spellings of the same failure (different paths, shas, ids, counts) collapse to
 * one fingerprint.
 *
 * The LABEL is the only transcript-derived text allowed to leave the reader: it is
 * normalised (no absolute paths, ids, emails, numbers), secret-redacted through
 * the gentle `redactSecrets` (NOT sanitizer.mjs, which blanket-redacts prose),
 * then refused outright if `preWriteSecretGate` still sees a high-confidence
 * secret shape. Capped at {@link LABEL_MAX} characters.
 *
 * @module scripts/lib/friction/retro/fingerprint
 */
import crypto from 'node:crypto';
import { redactSecrets } from '../../secret-patterns.mjs';
import { preWriteSecretGate } from '../../security/secret-classifier.mjs';
import { NOISE_LINE_PATTERNS } from './patterns.mjs';

/** Bump when normalisation or classification changes meaning: every fingerprint
 *  changes with it, and an effect comparison across versions is `unmeasured`. */
export const FINGERPRINT_VERSION = 1;
export const LABEL_MAX = 160;
/** Lines scanned when looking for the most informative one. */
const MEANINGFUL_SCAN_LINES = 20;
const INFORMATIVE_RE = /\b(?:error|denied|refus\w*|not found|no such|cannot|can't|failed|invalid|blocked|must|timed out|behind)\b/i;
/** Wrapper lines that look informative but only announce that something failed. */
const WRAPPER_LINE_RE = /^(?:Failed with (?:non-)?blocking status code\b|node:internal\/|\s*at\s)/i;
const NON_BLOCKING_PREFIX_RE = /^Failed with non-blocking status code:\s*/i;

/**
 * Pick the line that best names the failure: the first informative line within
 * the first {@link MEANINGFUL_SCAN_LINES}, else the first non-noise line.
 * @param {string} text
 * @returns {string}
 */
export function meaningfulLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).slice(0, MEANINGFUL_SCAN_LINES)
    .map((l) => l.replace(NON_BLOCKING_PREFIX_RE, '').trim())
    .filter((l) => !NOISE_LINE_PATTERNS.some((re) => re.test(l)));
  return lines.find((l) => INFORMATIVE_RE.test(l) && !WRAPPER_LINE_RE.test(l))
    ?? lines.find((l) => !WRAPPER_LINE_RE.test(l)) ?? lines[0] ?? '';
}

/**
 * Normalise variable parts away. Order matters: URLs before paths, uuids before
 * hex shas, everything before the bare-number pass.
 * @param {string} line
 * @returns {string}
 */
export function normaliseSignalText(line) {
  return String(line ?? '')
    .replace(/\bhttps?:\/\/\S+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\bmcp__[0-9a-f]{8}-[0-9a-f-]{27,}__/gi, 'mcp__X__')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?:toolu|local|req|msg|agent)[_-][A-Za-z0-9-]{6,}/g, '<id>')
    // Absolute paths, INCLUDING segments with spaces ("My Docs"): a space is
    // consumed when the next word still carries a separator, so the path's tail
    // is never left behind in the label (cluster-A audit R2-H2).
    .replace(/~[\\/](?:[^\s'"`)\]]|\s(?=[^'"`)\]\n]*[\\/]))*/g, '<path>')
    .replace(/[A-Za-z]:[\\/](?:[^\s'"`)\]]|\s(?=[^'"`)\]\n]*[\\/]))*/g, '<path>')
    .replace(/(?<![\w.<>~])\/[\w.~-](?:[^\s'"`)\]:]|\s(?=[^\s'"`)\]]*\/))*/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, (m) => (/\d/.test(m) && /[a-f]/i.test(m) ? '<sha>' : m))
    // A status code carries meaning (401 ≠ 404): keep a 3-digit number that
    // follows HTTP/status/code/error; every other number is noise.
    .replace(/\b(HTTP|status|code|error)(\s*[:=]?\s*)([1-5]\d\d)\b/gi, '$1$2§$3§')
    .replace(/\d+(?![\d]*§)/g, 'N')
    .replace(/§(\d{3})§/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn normalised text into a public-safe label: redacted, gated, capped.
 * @param {string} normalised
 * @returns {string}
 */
export function safeLabel(normalised) {
  const redacted = redactSecrets(String(normalised ?? '')).text;
  const gate = preWriteSecretGate(redacted);
  const text = gate.ok ? gate.content ?? redacted : '[REDACTED:secret]';
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

/**
 * Fingerprint a signal. `tool` is normalised the same way (an MCP server uuid in
 * a tool name must not split one failure into many).
 * @param {{kind: string, tool?: string, text?: string}} signal
 * @returns {{fingerprint: string, label: string, tool: string}}
 */
export function fingerprintOf({ kind, tool = '', text = '' }) {
  // Secrets are redacted on the RAW text, before normalisation: the number pass
  // would otherwise break a digit-bearing secret's shape and let fragments
  // through the redactor (cluster-A audit H18). Both exported fields are gated.
  const rawLine = redactSecrets(meaningfulLine(text)).text;
  const normTool = safeLabel(normaliseSignalText(redactSecrets(String(tool)).text));
  const normLine = normaliseSignalText(rawLine).slice(0, 200);
  const fingerprint = crypto.createHash('sha256')
    .update(`${FINGERPRINT_VERSION}|${kind}|${normTool}|${normLine}`).digest('hex').slice(0, 16);
  return { fingerprint, label: safeLabel(normLine), tool: normTool };
}
