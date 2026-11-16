/**
 * @fileoverview Deterministic failure-signal extraction from transcript records —
 * no model, no I/O (plan docs/plans/harness-retro.md §2 component 2).
 *
 * One extractor per session (`createSessionExtractor`) is fed records in file
 * order; it joins each `tool_result` to the `tool_use` that produced it and emits
 * occurrences `{fingerprint, label, kind, tool, ts}`. Each raw record is dropped
 * after `push` — nothing transcript-shaped is retained beyond the derived fields.
 *
 * Kinds (classified ONCE, most specific first):
 *   hook_rewrite    a hook changed the call's input and the classifier then could not judge it
 *   hook_block      a hook refused the call by design (enforcement that FIRED)
 *   denial          a permission/classifier/safety denial (structured field first, text fallback)
 *   refusal         a tooling refusal phrase ("must be owner", "is behind", "refused"), error or not
 *   tool_error      any other `is_error` tool result
 *   hook_error      a hook that itself failed or was cancelled (attachment record)
 *   retry           the same tool + same input re-issued after that call errored
 *   user_correction a human turn opening with a correction phrase — the TEXT is never kept;
 *                   the fingerprint is `user_correction|<preceding tool>`
 *
 * @module scripts/lib/friction/retro/signals
 */
import crypto from 'node:crypto';
import { fingerprintOf, meaningfulLine } from './fingerprint.mjs';
import {
  DENIAL_PATTERNS, HOOK_REWRITE_PATTERN, HOOK_BLOCK_PATTERN, POST_HOOK_ERROR_PATTERN, REFUSAL_PATTERNS, CORRECTION_PATTERNS,
} from './patterns.mjs';
import { isHumanTurn } from './transcripts.mjs';

export const SIGNAL_KINDS = Object.freeze([
  'hook_rewrite', 'hook_block', 'denial', 'refusal', 'tool_error', 'hook_error', 'retry', 'user_correction',
]);

const HOOK_FAILURE_ATTACHMENTS = new Set(['hook_non_blocking_error', 'hook_blocking_error', 'hook_cancelled', 'hook_error']);
/** Result text is only ever inspected up to this many characters (a 1 MB tool dump must not be regex-scanned whole). */
const RESULT_TEXT_CAP = 4000;

function resultText(content) {
  if (typeof content === 'string') return content.slice(0, RESULT_TEXT_CAP);
  if (Array.isArray(content)) {
    let out = '';
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string') out += `${b.text}\n`;
      if (out.length >= RESULT_TEXT_CAP) break;
    }
    return out.slice(0, RESULT_TEXT_CAP);
  }
  return '';
}

function humanText(rec) {
  if (rec?.type === 'attachment') return String(rec.attachment?.prompt ?? '');
  const c = rec?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return '';
}

/** Strip harness-injected wrappers so a correction phrase is matched on what the human typed. */
function stripInjected(text) {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[\s\S]*?<\/pasted_content>/g, '')
    .trim();
}

const inputKey = (name, input) => crypto.createHash('sha256')
  .update(`${name}|${JSON.stringify(input ?? {})}`).digest('hex');

/**
 * Classify one tool result. Returns null for a non-signal (a clean success).
 * @param {{text: string, isError: boolean, permissionDecision?: object, toolDenialKind?: string}} r
 * @returns {string|null} kind
 */
export function classifyToolResult({ text, isError, permissionDecision, toolDenialKind }) {
  const head = text.slice(0, 600);
  if (HOOK_REWRITE_PATTERN.test(head)) return 'hook_rewrite';
  if (permissionDecision?.decision === 'reject' && permissionDecision?.source === 'hook') return 'hook_block';
  if (HOOK_BLOCK_PATTERN.test(head)) return 'hook_block';
  if (POST_HOOK_ERROR_PATTERN.test(head)) return 'hook_error';
  if (permissionDecision?.decision === 'reject' || toolDenialKind) return 'denial';
  if (DENIAL_PATTERNS.some((re) => re.test(head))) return 'denial';
  const refusalScope = isError ? head : meaningfulLine(head);
  if (REFUSAL_PATTERNS.some((re) => re.test(refusalScope))) return 'refusal';
  if (isError) return 'tool_error';
  return null;
}

/**
 * Is this human turn a correction? Matched on the first line the human typed,
 * after harness-injected blocks are stripped.
 * @param {string} text
 */
export function isCorrection(text) {
  const first = stripInjected(text).split(/\r?\n/).find((l) => l.trim()) ?? '';
  return CORRECTION_PATTERNS.some((re) => re.test(first.trim()));
}

/**
 * Stateful per-session extractor.
 * Tool-use joins are PER FILE: a subagent's `tool_use_id`s live in its own file,
 * so call `endFile()` at each file boundary — it clears the join and retry state
 * (bounded memory) while the session's counters carry on. A `tool_result` whose
 * `tool_use` is not in the same file is still classified (with `tool: ''`) and
 * counted in `unjoined` — never dropped.
 *
 * @returns {{push: (rec: object) => void, endFile: () => void, finish: () => {occurrences: object[], humanTurns: number, records: number, unjoined: number, conversational: number, firstTs: string|null, firstCwd: string|null, versions: string[]}}}
 */
export function createSessionExtractor() {
  const toolUses = new Map();          // tool_use_id -> {name, key}
  const erroredKeys = new Set();       // inputKey of calls whose result errored
  const occurrences = [];
  const versions = new Set();
  let lastToolName = '';
  let humanTurns = 0;
  let records = 0;
  let unjoined = 0;
  let conversational = 0;   // user/assistant records — the format self-check
  let firstTs = null;
  let firstCwd = null;

  const emit = (kind, tool, text, ts) => {
    const { fingerprint, label, tool: normTool } = fingerprintOf({ kind, tool, text });
    occurrences.push({ fingerprint, label, kind, tool: normTool, ts: ts ?? null });
  };

  function push(rec) {
    if (!rec || typeof rec !== 'object') return;
    records++;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    if (ts && (!firstTs || ts < firstTs)) firstTs = ts;
    if (!firstCwd && typeof rec.cwd === 'string' && rec.cwd) firstCwd = rec.cwd;
    if (typeof rec.version === 'string') versions.add(rec.version);
    if (rec.type === 'user' || rec.type === 'assistant') conversational++;

    if (rec.type === 'assistant' && Array.isArray(rec.message?.content)) {
      for (const b of rec.message.content) {
        if (b?.type !== 'tool_use' || !b.id) continue;
        const key = inputKey(b.name, b.input);
        if (erroredKeys.has(key)) emit('retry', b.name, `retry of ${b.name} after error`, ts);
        toolUses.set(b.id, { name: String(b.name ?? ''), key });
        lastToolName = String(b.name ?? '');
      }
      return;
    }

    if (rec.type === 'user' && Array.isArray(rec.message?.content)) {
      for (const b of rec.message.content) {
        if (b?.type !== 'tool_result') continue;
        const use = toolUses.get(b.tool_use_id);
        if (!use) unjoined++;
        const text = resultText(b.content);
        const kind = classifyToolResult({
          text, isError: b.is_error === true,
          permissionDecision: rec.permissionDecision, toolDenialKind: rec.toolDenialKind,
        });
        if (kind) {
          emit(kind, use?.name ?? '', text, ts);
          if (use && kind !== 'hook_block') erroredKeys.add(use.key);
        } else if (use) {
          erroredKeys.delete(use.key);   // a later success ends the retry chain
        }
      }
    }

    if (isHumanTurn(rec) || (rec.type === 'attachment' && rec.attachment?.type === 'queued_command'
        && rec.attachment?.origin?.kind === 'human')) {
      humanTurns++;
      if (isCorrection(humanText(rec))) emit('user_correction', lastToolName, `correction after ${lastToolName || 'no tool'}`, ts);
      return;
    }

    if (rec.type === 'attachment' && HOOK_FAILURE_ATTACHMENTS.has(rec.attachment?.type)) {
      const a = rec.attachment;
      // The detail ALONE is fingerprinted: prefixing the attachment type put the
      // wrapper's "Failed with non-blocking status code" first, which the
      // informative-line picker then chose over the real error (seen on the real
      // corpus, 2026-11-16).
      const detail = a.stderr || (a.timedOut ? `timed out after ${a.timeoutMs}ms` : a.type);
      emit('hook_error', String(a.hookName ?? a.hookEvent ?? 'hook'), detail, ts);
    }
  }

  function endFile() {
    toolUses.clear();
    erroredKeys.clear();
    lastToolName = '';
  }

  function finish() {
    return {
      occurrences, humanTurns, records, unjoined, conversational,
      firstTs, firstCwd, versions: [...versions].sort(),
    };
  }

  return { push, endFile, finish };
}
