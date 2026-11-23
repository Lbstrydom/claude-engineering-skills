#!/usr/bin/env node
/**
 * @fileoverview PreToolUse hook — blocks Bash invocations whose leading
 * command is `grep`/`rg`/`egrep`/`fgrep`, nudging Claude to use the Grep
 * tool instead. The Grep tool wraps ripgrep with correct permissions,
 * head_limit/output_mode/context/glob/type filters, and avoids the
 * `| head` anti-pattern.
 *
 * Pipe-filter uses (e.g. `ps aux | grep node`, `cmd | grep -v foo`) are
 * NOT blocked — only leading-command form, which is the actual misuse
 * pattern (file-content search via Bash).
 *
 * Disable: BASH_GREP_NUDGE_DISABLE=1
 *
 * @module .claude/hooks/bash-grep-nudge
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Both tooling layouts, resolved from this file's own directory (never the cwd).
const HOST_LIB_CANDIDATES = Object.freeze([
  path.join(REPO_ROOT, 'scripts', 'lib', 'hook-host.mjs'),
  path.join(REPO_ROOT, 'scripts', '.claude-skills', 'lib', 'hook-host.mjs'),
]);

/** @returns {Promise<object|null>} the hook-host module, or null (legacy Claude path). */
async function loadHookHost() {
  for (const candidate of HOST_LIB_CANDIDATES) {
    if (!fs.existsSync(candidate)) continue;
    try { return await import(pathToFileURL(candidate).href); } catch { /* try the next layout */ }
  }
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

function leadingGrepTool(cmd) {
  const stripped = cmd.replace(/^\s+/, '').replace(/^(?:\w+=\S+\s+)+/, '');
  const m = stripped.match(/^(grep|rg|egrep|fgrep)\b/);
  return m ? m[1] : null;
}

(async () => {
  if (process.env.BASH_GREP_NUDGE_DISABLE === '1') process.exit(0);

  let payload;
  try {
    const raw = await readStdin();
    if (!raw.trim()) process.exit(0);
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Host-normalised input. If the oracle cannot load, run the legacy Claude-shape
  // path (the original inline parse) — observable on stderr, exit status unchanged.
  const hostMod = await loadHookHost();
  let host = 'unknown';
  let cmd;
  if (hostMod) {
    host = hostMod.detectHookHost(payload);
    const ev = hostMod.normaliseToolEvent(payload);
    if (ev?.kind !== 'shell') process.exit(0);
    cmd = ev.command;
  } else {
    process.stderr.write('  [bash-grep-nudge] hook-host unavailable — legacy Claude path\n');
    if (payload?.tool_name !== 'Bash') process.exit(0);
    cmd = payload?.tool_input?.command;
    if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0);
  }

  const tool = leadingGrepTool(cmd);
  if (!tool) process.exit(0);

  const reason = [
    `Bash leading command is \`${tool}\` — use the ${host === 'copilot' ? 'grep' : 'Grep'} tool instead.`,
    `Grep wraps ripgrep with correct permissions and supports`,
    `output_mode/head_limit/context/-A/-B/-C/glob/type filters,`,
    `which removes the need for \`| head\` and similar pipe shaping.`,
    `Pipe-filter uses (e.g. \`ps aux | grep node\`) are fine — only`,
    `leading-command file-content search is blocked.`,
    `Disable per-session: BASH_GREP_NUDGE_DISABLE=1`,
  ].join(' ');

  const out = hostMod
    ? hostMod.formatHookOutput(host, 'PreToolUse', 'deny', reason)
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
})();
