#!/usr/bin/env node
/**
 * @fileoverview backlog-snapshot — one line summarising every standing queue,
 * for the `/ship` status entry.
 *
 * **Why it does its own reads.** An earlier design had `/ship` Step 0.5 persist
 * the envelopes it had already fetched, and this command read them back. That
 * saved four cheap store reads (~2s, no LLM, no spend) and cost an entire
 * artifact protocol: envelope versioning, atomic writes, collision rules, and a
 * prior-session index purely to carry the post-push Q3 value onto the next
 * ship. Reading here instead makes all of that vanish, and every field then
 * shares ONE honest measurement instant rather than a mix of pre- and
 * post-push values with a single misleading date.
 *
 * **It never writes `status.md`.** It prints one line; the agent pastes it into
 * the entry it is already authoring. PR #87 destroyed 19,257 lines of that file
 * because a tool rewrote it, and no convenience is worth re-introducing a
 * writer.
 *
 * Read-only: this command issues no store write.
 *
 * Exit codes: 0 always — an advisory nudge must never gate a ship, and a queue
 * it could not read renders `unmeasured` rather than failing.
 *
 * Usage:
 *   node scripts/backlog-snapshot.mjs [--json]
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md Phase 10.
 *
 * @module scripts/backlog-snapshot
 */

import './lib/load-env.mjs';

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { renderBacklogSnapshot } from './lib/store/backlog-snapshot.mjs';

// Siblings are resolved relative to THIS FILE, never to a computed repo root.
// In a consumer the bundle lives at `scripts/.claude-skills/`, so a
// `<repoRoot>/scripts/<name>.mjs` join would look in the consumer's own
// `scripts/` and find nothing. Deriving the layout from `import.meta.url`
// works unchanged in both.
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The repo root is still needed as the child's cwd, so the readers resolve the
// repo they are reporting on rather than the bundle directory.
const REPO = process.cwd();
const KNOWN_FLAGS = ['--json', '--help', '-h', '--selfcheck-relocation'];

/**
 * Run one reader and parse its JSON envelope.
 *
 * A reader that fails, times out, or prints unparseable output yields `null`,
 * which the formatter renders as `unmeasured`. It must NEVER yield an empty
 * envelope — that would render as `0` and read as good news.
 */
function readEnvelope(scriptName, args) {
  try {
    const stdout = execFileSync(
      process.execPath, [path.join(HERE, scriptName), ...args],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
    );
    // These CLIs print a JSON envelope on stdout; stderr carries progress.
    const line = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

function printUsage() {
  process.stderr.write(`Usage: node scripts/backlog-snapshot.mjs [--json]

Print one line summarising the standing queues, for the /ship status entry.
Reads every queue itself, read-only, at a single instant. Writes no file.

Options:
  --json     Emit the envelopes plus the rendered line as JSON
  --help     Show this message

Exit code: always 0 (advisory).
`);
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  let jsonMode = false;
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'backlog-snapshot' });
    jsonMode = process.argv.includes('--json');
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      printUsage(); process.exit(0);
    }
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }

  const repoSlug = process.env.LEARNING_REPO_NAME || '';
  const at = new Date();

  const q1 = readEnvelope('cross-skill.mjs', ['list-unlocked-fixes']);
  const q2 = readEnvelope('cross-skill.mjs', ['list-unremediated-acceptances']);
  const q3 = repoSlug
    ? readEnvelope('cross-skill.mjs', ['final-review-pending', '--repo', repoSlug])
    : null;
  const upstream = readEnvelope('cross-skill.mjs', ['upstream', 'list']);
  const debt = readEnvelope('debt-reconcile.mjs', ['--json']);

  const line = renderBacklogSnapshot({ q1, q2, q3, debt, upstream, at });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: true, line, at: at.toISOString() })}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
  process.exit(0);
}

main().catch((err) => {
  // Even a crash must not gate a ship: report and exit 0 with no line, rather
  // than printing a half-measured one.
  process.stderr.write(`backlog-snapshot: ${err.message}\n`);
  process.exit(0);
});
