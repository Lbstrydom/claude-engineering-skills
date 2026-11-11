/**
 * @fileoverview The plan-less code audit (`openai-audit.mjs code --planless <intent-file>`): its CLI door and the intent document.
 *
 * A push with no selectable plan used to be refused by the consumer pre-push hook ("the audit is plan-keyed"), which taught sessions to
 * bypass it (consumer feedback 2026-11-11, theme 1a). Only the CLI required a plan file: every pass reads `planContent` as prompt text.
 * So a plan-less audit passes the pushed commits' own messages as the stated intent, under a header that tells every pass there is no
 * plan and that plan conformance and completeness must NOT be judged. Plan: docs/plans/prepush-gate-consumer-feedback-theme1.md D1.
 *
 * Kept out of `openai-audit.mjs`, which is over the size ratchet and may not grow.
 *
 * @module scripts/lib/audit/planless-intent
 */
import fs from 'node:fs';
import { redactSecrets } from '../secret-patterns.mjs';

export const PLANLESS_FLAG = '--planless';

/** Prepended to the intent text. Every pass receives it as its "plan", so it must say plainly that it is not one. */
export const PLANLESS_HEADER = [
  '# PLAN-LESS AUDIT - there is no plan for this change',
  '',
  'No plan document governs this change. The text below is NOT a plan: it is the pushed commits\' own messages, given as the',
  'author\'s stated intent. Do NOT judge plan conformance or plan completeness, do NOT report missing planned files or',
  'unimplemented plan items, and do NOT report the absence of a plan as a finding. Audit the code in scope on its own merits;',
  'use the stated intent only to understand what the change is for.',
  '',
  '---',
  '',
  '',
].join('\n');

/** The intent document's size cap, in UTF-8 bytes. */
export const INTENT_CAP_BYTES = 8 * 1024;

/**
 * The CLI door for `--planless`. Refusals happen before any read, store write or model call; the caller exits 2 on `error` (the hook
 * reads exit 2 as "the audit refused its arguments", i.e. UNMEASURED). Reading the intent file is the one read this performs.
 *
 * @param {string[]} args `process.argv.slice(2)`: `args[0]` is the mode, `args[1]` the positional plan when one was given
 * @param {{read?: (p: string) => string}} [deps]
 * @returns {{planless: false} | {planless: true, intentPath: string, planContent: string, redacted: string[]} | {error: string}}
 */
export function parsePlanlessArgs(args, { read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const idx = args.indexOf(PLANLESS_FLAG);
  if (idx === -1) return { planless: false };
  const mode = args[0];
  if (mode !== 'code') return { error: `Error: ${PLANLESS_FLAG} is a code-audit mode only (got mode "${mode ?? ''}")` };
  const intentPath = args[idx + 1];
  if (!intentPath || intentPath.startsWith('--')) return { error: `Error: ${PLANLESS_FLAG} needs an intent file: ${PLANLESS_FLAG} <intent-file>` };
  // A positional right after the intent file is a plan as well (`code --planless i.md plan.md`): one or the other, in either order.
  const trailing = args[idx + 2];
  if (typeof trailing === 'string' && !trailing.startsWith('--')) {
    return { error: `Error: ${PLANLESS_FLAG} replaces the plan argument - pass a plan file OR ${PLANLESS_FLAG} <intent-file>, not both (got plan "${trailing}")` };
  }
  const positional = args[1];
  if (idx !== 1 && typeof positional === 'string' && !positional.startsWith('--')) {
    return { error: `Error: ${PLANLESS_FLAG} replaces the plan argument - pass a plan file OR ${PLANLESS_FLAG} <intent-file>, not both (got plan "${positional}")` };
  }
  // Only a plan can supply plan scope: the audited files must come from git (--scope diff) or an explicit --files list.
  const scopeIdx = args.indexOf('--scope');
  const scope = scopeIdx !== -1 ? args[scopeIdx + 1] : 'diff';
  if (scope !== 'diff') return { error: `Error: ${PLANLESS_FLAG} needs --scope diff or --files (got --scope ${scope ?? '(none)'}): only a plan can supply plan scope` };
  let text;
  try { text = read(intentPath); } catch (e) {
    return { error: `Error: ${PLANLESS_FLAG} intent file unreadable: ${intentPath} (${e?.code || e?.message || 'error'})` };
  }
  const { text: safe, redacted } = redactSecrets(String(text));
  return { planless: true, intentPath, planContent: `${PLANLESS_HEADER}${safe}`, redacted };
}

/**
 * Mark a plan-less run's result envelope `planless: true`, so it can never be read as plan-keyed evidence. Applied once, in
 * `runMultiPassCodeAudit`, to whichever pipeline produced the result (legacy or tiered); a plan-keyed result is returned unchanged.
 * @template T
 * @param {T} result
 * @param {{planless?: boolean}} [opts]
 * @returns {T}
 */
export function stampPlanless(result, opts) {
  return opts?.planless === true && result && typeof result === 'object' ? { ...result, planless: true } : result;
}

/** Truncate to at most `cap` UTF-8 bytes without splitting a character. */
function capBytes(s, cap) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= cap) return s;
  const note = '\n\n[intent truncated at the 8 KB cap]\n';
  let cut = cap - Buffer.byteLength(note, 'utf8');
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut -= 1; // back off a UTF-8 continuation byte
  return `${buf.subarray(0, Math.max(0, cut)).toString('utf8')}${note}`;
}

/**
 * The intent document the hook writes for a plan-less audit: the branch's own commit messages, secret-redacted, capped.
 * An empty message set still produces a document that says so - it is never confused with a failed read (the caller refuses on that).
 *
 * @param {{messages: string[], cap?: number}} input messages oldest first
 * @returns {{text: string, count: number, redacted: string[]}}
 */
export function buildIntentDocument({ messages, cap = INTENT_CAP_BYTES } = {}) {
  const list = (Array.isArray(messages) ? messages : []).map((m) => String(m ?? '').trim()).filter(Boolean);
  const head = '# Stated intent (plan-less audit)\n\n';
  if (list.length === 0) {
    return { text: `${head}The pushed range carries no commit messages, so the stated intent is empty.\n`, count: 0, redacted: [] };
  }
  const body = list.map((m, i) => `## Commit ${i + 1} of ${list.length}\n\n${m}\n`).join('\n');
  const { text: safe, redacted } = redactSecrets(`${head}The pushed commits' own messages, oldest first:\n\n${body}`);
  return { text: capBytes(safe, cap), count: list.length, redacted };
}
