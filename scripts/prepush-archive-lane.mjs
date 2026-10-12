#!/usr/bin/env node
/**
 * @fileoverview CLI for the pre-push archive lane (`.githooks/pre-push` §1).
 *
 * Reads the hook's stdin lines, decides whether the push is archive-only, and if
 * so scans exactly what it publishes. Plan: docs/plans/prepush-archive-lane.md.
 *
 * PROTOCOL. stdout carries ONE line, `archive-lane/v1 <outcome>`, written last;
 * everything human-readable goes to stderr. The hook acts on that token and on
 * nothing else: `node` exits 1 on a syntax or import error before any catch can
 * run, so exit status cannot tell "findings" from "crashed". The exit code is
 * transport only (clean 0 · findings/error 1 · not-applicable 3).
 *
 * Usage (invoked by the hook, not by hand):
 *   node scripts/prepush-archive-lane.mjs --remote="$1" --destination="$2" < push-lines
 * The `=` form is deliberate: a destination beginning with `-` must not be read
 * as a flag. AUDIT_ARCHIVE_LANE_ACK acknowledges an exact finding set.
 *
 * @module scripts/prepush-archive-lane
 */
import { argOption, assertKnownFlags, finishAndExit } from './lib/cli-io.mjs';
import { LANE_PROTOCOL, makeGit, runArchiveLane } from './lib/prepush-archive-lane.mjs';

const EXIT_FOR = Object.freeze({ clean: 0, findings: 1, error: 1, 'not-applicable': 3 });

/**
 * Stdin as text. A TTY (a manual run) is empty by definition. A read that FAILS is
 * not empty input: it propagates to the crash handler (no token), because treating
 * it as 'no ref updates' would answer not-applicable for a push it never saw.
 */
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  try {
    assertKnownFlags(process.argv, ['--remote', '--destination', '--selfcheck-relocation'], { cli: 'prepush-archive-lane' });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    await finishAndExit(2);
    return;
  }

  const destination = argOption('destination', '') ?? '';
  const ack = (process.env.AUDIT_ARCHIVE_LANE_ACK ?? '').trim() || undefined;
  const result = runArchiveLane({
    stdinText: await readStdin(),
    destination,
    git: makeGit(process.cwd()),
    ack,
  });

  for (const line of result.lines) process.stderr.write(`${line}\n`);
  process.stdout.write(`${LANE_PROTOCOL} ${result.outcome}\n`);
  await finishAndExit(EXIT_FOR[result.outcome] ?? 1);
}

main().catch(async (err) => {
  // No token on purpose: a crash is "no valid result", which the hook reports
  // loudly and answers with the full gate. Class name only — never the message.
  process.stderr.write(`archive lane crashed (${err?.constructor?.name ?? 'Error'})\n`);
  await finishAndExit(3);
});
