#!/usr/bin/env node
/**
 * @fileoverview PreToolUse hook — blocks shell-tool invocations that search
 * file contents, nudging Claude to use the Grep tool instead. The Grep tool
 * wraps ripgrep with correct permissions, head_limit/output_mode/context/
 * glob/type filters, and avoids the `| head` anti-pattern.
 *
 * Blocked, per shell tool:
 *   Bash       — leading `grep`/`rg`/`egrep`/`fgrep`.
 *   PowerShell — leading `Select-String`/`sls`/`findstr`/`rg`/`grep`/`egrep`/
 *                `fgrep`, and `Get-ChildItem ... | Select-String`.
 *
 * Pipe-filter uses (e.g. `ps aux | grep node`, `Get-Process | sls node`) are
 * NOT blocked. It is a nudge, not a gate: the PowerShell pipeline form is
 * matched only in its simple shape, and anything more complex is allowed.
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

// PowerShell is matched strictly and never parsed: a shape these patterns do not describe is allowed. Do not
// grow them toward PowerShell's grammar — a hand-rolled lexer here kept failing audit (2026-11-25).
const PS_LEADING = /^\s*(?:&\s*)?(select-string|sls|(?:findstr|rg|grep|egrep|fgrep)(?:\.exe)?)(?=$|[\s;|])/i;
// A literal value (any single-quoted one; double-quoted with no `$` or backtick), blanked so nothing in it is read.
const PS_PLAIN_VALUE = /'[^']*'|"[^"$`]*"/g;
// `<listing> [plain arguments] | <search> [arguments]`; group 1 and group 2 are the two argument lists.
const PS_LISTING_SEARCH = /^\s*(?:get-childitem|gci|ls|dir)(?=[\s|])([^|;&<>(){}#'"`\r\n]*)\|\s*(?:select-string|sls)(?=$|[\s;|])([^|;\r\n]*)/i;
// `-Name` makes the listing emit strings, `-Directory` lists no files, a provider drive (`Env:`) lists objects,
// `-InputObject` searches a value in memory. None of them reads file contents.
const PS_NO_FILE_CONTENT = /\s-(?:n(?:a(?:me?)?)?|dir[a-z]*)(?!:\$false\b)(?![\w-])/i;
const PS_PROVIDER_DRIVE = /[\s:](?:env|variable|alias|function|cert|wsman|registry|hk[a-z]{2}):/i;
const PS_INPUT_OBJECT = /\s-inp/i;

/** @returns {string|null} what the message calls the PowerShell file-content search, or null. */
function powershellSearch(cmd) {
  const lead = PS_LEADING.exec(cmd);
  if (lead) return `leading command is \`${lead[1]}\``;
  const piped = PS_LISTING_SEARCH.exec(cmd.replace(PS_PLAIN_VALUE, '_'));
  if (!piped) return null;
  const [, listing, search] = piped;
  if (PS_NO_FILE_CONTENT.test(listing)|| PS_PROVIDER_DRIVE.test(listing) || PS_INPUT_OBJECT.test(search)) return null;
  return '`Get-ChildItem | Select-String` is a file-content search';
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
  let powershell;
  if (hostMod) {
    host = hostMod.detectHookHost(payload);
    const ev = hostMod.normaliseToolEvent(payload);
    if (ev?.kind !== 'shell') process.exit(0);
    cmd = ev.command;
    powershell = ev.shell === 'powershell';
  } else {
    process.stderr.write('  [bash-grep-nudge] hook-host unavailable — legacy Claude path\n');
    if (payload?.tool_name !== 'Bash' && payload?.tool_name !== 'PowerShell') process.exit(0);
    cmd = payload?.tool_input?.command;
    if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0);
    powershell = payload.tool_name === 'PowerShell';
  }

  const bashTool = powershell ? null : leadingGrepTool(cmd);
  let found = bashTool && `leading command is \`${bashTool}\``;
  if (powershell) found = powershellSearch(cmd);
  if (!found) process.exit(0);

  const reason = [
    `${powershell ? 'PowerShell' : 'Bash'} ${found} — use the ${host === 'copilot' ? 'grep' : 'Grep'} tool instead.`,
    `Grep wraps ripgrep with correct permissions and supports`,
    `output_mode/head_limit/context/-A/-B/-C/glob/type filters,`,
    `which removes the need for \`| ${powershell ? 'Select-Object -First' : 'head'}\` and similar pipe shaping.`,
    `Pipe-filter uses (e.g. \`${powershell ? 'Get-Process | Select-String node' : 'ps aux | grep node'}\`) are fine — only`,
    `${powershell ? '' : 'leading-command '}file-content search is blocked.`,
    `Disable per-session: BASH_GREP_NUDGE_DISABLE=1`,
  ].join(' ');

  const out = hostMod
    ? hostMod.formatHookOutput(host, 'PreToolUse', 'deny', reason)
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  // Exit from the write callback: a piped stdout is asynchronous on Windows and an
  // immediate process.exit() can truncate the envelope.
  if (out) process.stdout.write(JSON.stringify(out), () => process.exit(0));
  else process.exit(0);
})();
