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

  if (payload?.tool_name !== 'Bash') process.exit(0);
  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0);

  const tool = leadingGrepTool(cmd);
  if (!tool) process.exit(0);

  const reason = [
    `Bash leading command is \`${tool}\` — use the Grep tool instead.`,
    `Grep wraps ripgrep with correct permissions and supports`,
    `output_mode/head_limit/context/-A/-B/-C/glob/type filters,`,
    `which removes the need for \`| head\` and similar pipe shaping.`,
    `Pipe-filter uses (e.g. \`ps aux | grep node\`) are fine — only`,
    `leading-command file-content search is blocked.`,
    `Disable per-session: BASH_GREP_NUDGE_DISABLE=1`,
  ].join(' ');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
})();
