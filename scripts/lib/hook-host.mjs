/**
 * @fileoverview The ONE host oracle for the repo's hooks (VS Code cluster D,
 * docs/plans/vscode-compatibility.md §2, §7b Phase 4).
 *
 * Copilot runs `.claude/settings.json` hooks, but its tool-event payload and its
 * output contract differ from Claude Code's. Every hook asks this module; none
 * re-derives the host or re-parses a tool event.
 *
 * Three exports:
 *   - `detectHookHost(payload)`        -> 'claude-code' | 'copilot' | 'unknown'
 *   - `normaliseToolEvent(payload)`    -> `{kind:'file',...}` | `{kind:'shell',...}` | null
 *   - `formatHookOutput(host, event, kind, reason)` -> the stdout object, or null
 *
 * Two invariants that shape every line below:
 *   1. `unknown` behaves EXACTLY as today (the Claude shape), so a misdetection
 *      fails toward current behaviour, never toward silence.
 *   2. A field this module does not know yields `null` (the hook exits 0 with no
 *      output, as before). Field names for Copilot `tool_input` are NOT published;
 *      they are mapped only from recorded fixtures (cluster A), never guessed.
 *      Until those fixtures exist, Copilot tool events normalise to `null`
 *      ("Tier 2 deferred: no recorded fixtures"), and only the documented
 *      envelope (host detection, `prompt`, output shapes) is used.
 *
 * Multi-file tools (Copilot `apply_patch`) are deferred: `null`, so no hook sees a
 * partial patch and no path skips the sensitive-path check (INC-001). This module
 * returns a RAW `filePath`; the caller MUST run its sensitive-path short-circuit on
 * it before any read or scan.
 *
 * @module scripts/lib/hook-host
 */

/** @typedef {'claude-code'|'copilot'|'unknown'} HookHost */
/**
 * @typedef {{kind:'file', op:'edit'|'write', filePath:string, text?:string}
 *   | {kind:'shell', shell:'bash'|'powershell', command:string}} ToolEvent
 *   `text` is absent when the payload carries no text field; a path-only event is
 *   still a valid `file` event (syntax-check needs only the path).
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.length > 0;

/**
 * Classify the host from the documented envelope only.
 *
 * `copilot`: a string `timestamp` and `hook_event_name`, and NO `transcript_path`.
 * `claude-code`: a string `transcript_path` (Claude Code's envelope carries it).
 * Anything else — a bare test payload, a malformed value, a third host — is
 * `unknown`, which the hooks treat as the Claude shape.
 *
 * @param {unknown} payload parsed stdin JSON
 * @returns {HookHost}
 */
export function detectHookHost(payload) {
  if (!isObject(payload)) return 'unknown';
  const hasTranscript = Object.hasOwn(payload, 'transcript_path');
  if (typeof payload.transcript_path === 'string') return 'claude-code';
  if (
    !hasTranscript
    && typeof payload.timestamp === 'string' && payload.timestamp.length > 0
    && typeof payload.hook_event_name === 'string' && payload.hook_event_name.length > 0
  ) return 'copilot';
  return 'unknown';
}

/**
 * Normalise a tool event to the one shape the hooks consume.
 *
 * Claude shape only (see the module header for why Copilot is `null`):
 *   Bash  -> `{kind:'shell', shell:'bash', command}`
 *   PowerShell -> `{kind:'shell', shell:'powershell', command}`
 *   Edit -> `{kind:'file', op:'edit', filePath, text?}`   (`text` = `new_string`)
 *   Write -> `{kind:'file', op:'write', filePath, text?}`  (`text` = `content`)
 * `filePath` is `file_path` or `filePath`. A variant missing a REQUIRED field
 * (`command`, `filePath`) is `null`; a missing optional `text` is not.
 *
 * @param {unknown} payload parsed stdin JSON
 * @returns {ToolEvent|null}
 */
export function normaliseToolEvent(payload) {
  if (!isObject(payload)) return null;
  // Tier 2 (Copilot tool_input keys) is shipped only with recorded fixtures.
  if (detectHookHost(payload) === 'copilot') return null;

  const input = isObject(payload.tool_input) ? payload.tool_input : {};
  switch (payload.tool_name) {
    case 'Bash':
    case 'PowerShell':
      return nonEmptyString(input.command) && input.command.trim()
        ? { kind: 'shell', shell: payload.tool_name === 'Bash' ? 'bash' : 'powershell', command: input.command }
        : null;
    case 'Edit':
    case 'Write': {
      const filePath = input.file_path || input.filePath;
      if (!nonEmptyString(filePath)) return null;
      const op = payload.tool_name === 'Edit' ? 'edit' : 'write';
      const raw = op === 'edit' ? input.new_string : input.content;
      return typeof raw === 'string' ? { kind: 'file', op, filePath, text: raw } : { kind: 'file', op, filePath };
    }
    default:
      return null;
  }
}

/**
 * Build the stdout object for a host. `claude-code` and `unknown` reproduce
 * today's envelopes byte for byte once the caller `JSON.stringify`s the result.
 *
 * @param {HookHost} host
 * @param {'PreToolUse'|'PostToolUse'} event
 * @param {'deny'|'context'} kind `deny` is PreToolUse only; `context` is PostToolUse only
 * @param {string} reason the message text
 * @returns {object|null} null for an unsupported (event, kind) pair — emit nothing
 */
export function formatHookOutput(host, event, kind, reason) {
  const isDeny = event === 'PreToolUse' && kind === 'deny';
  const isContext = event === 'PostToolUse' && kind === 'context';
  if (!isDeny && !isContext) return null;
  if (host === 'copilot') {
    return isDeny
      ? { permissionDecision: 'deny', permissionDecisionReason: reason }
      : { additionalContext: reason };
  }
  return isDeny
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    : { systemMessage: reason };
}
