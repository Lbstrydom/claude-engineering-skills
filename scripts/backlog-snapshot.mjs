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
 * ship. Reading here instead makes all of that vanish, and every field is read
 * by ONE process in a single pass rather than mixing pre- and post-push
 * values under a single misleading date. The timestamp is that pass's start:
 * the five reads are child processes started together and finish at different
 * moments, so they are close, NOT simultaneous — close enough for a per-ship
 * trend line, and not claimed as more than that. The reads themselves live in
 * lib/store/backlog-gather.mjs, shared with the dashboard Home card.
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

import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { renderBacklogSnapshot } from './lib/store/backlog-snapshot.mjs';
import { gatherBacklogEnvelopes } from './lib/store/backlog-gather.mjs';

// The repo root is the readers' cwd, so they resolve the repo they are reporting on
// rather than the bundle directory. The readers themselves are resolved relative to
// `backlog-gather.mjs` (see there), which works unchanged in a consumer layout.
const REPO = process.cwd();
const KNOWN_FLAGS = ['--json', '--help', '-h', '--selfcheck-relocation'];

function printUsage() {
  process.stderr.write(`Usage: node scripts/backlog-snapshot.mjs [--json]

Print one line summarising the standing queues, for the /ship status entry.
Reads every queue itself, read-only, at a single instant. Writes no file.

Options:
  --json     Emit {ok, line, at} as JSON (the rendered line plus its instant)
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

  // The five reads run in parallel under a 120 s cap each. The CLI passes ONLY the
  // envelopes to the formatter; `outcomes` (the failure kinds) is for the dashboard.
  const { envelopes } = await gatherBacklogEnvelopes({ repo: repoSlug, cwd: REPO, timeoutMs: 120_000 });
  const { q1, q2, q3, upstream, debt } = envelopes;

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
