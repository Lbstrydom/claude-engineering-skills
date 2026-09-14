#!/usr/bin/env node
/**
 * @fileoverview event-wiring-lifecycle.mjs — operator CLI for the D12
 * lifecycle ledger (docs/plans/event-wiring-symmetry.md §2's D12 host,
 * scripts/lib/audit/event-wiring-lifecycle-store.mjs).
 *
 * The event-wiring-symmetry wave persists a durable per-event record
 * ("this dispatch has had no listener since <ref>") that only CLOSES by
 * observation — a listener appearing, the dispatch disappearing, or every
 * remaining site going pragma-suppressed. There was no way for a human to
 * close one directly: `disposition: 'dismissed'` was a declared value in the
 * transition table with no producer anywhere (found in final-review credit
 * triage, 2026-09-14). This CLI is that producer.
 *
 * Usage:
 *   node scripts/event-wiring-lifecycle.mjs --ledger <path> --list-open [--json]
 *   node scripts/event-wiring-lifecycle.mjs --ledger <path> --dismiss <eventName> [--reason <text>] [--json]
 *
 * Exit codes:
 *   0 — success
 *   2 — invalid invocation (unknown flag, missing/conflicting mode, missing value)
 *   3 — dismissal refused (no such record, or it isn't currently open)
 */
import { assertKnownFlags, emit } from './lib/cli-io.mjs';
import { listOpenLifecycle, dismissLifecycle } from './lib/audit/event-wiring-lifecycle-store.mjs';

const KIND = 'event-wiring-symmetry';
const KNOWN_FLAGS = ['--ledger', '--list-open', '--dismiss', '--reason', '--json', '--selfcheck-relocation'];

// isMain guard (audit-clean.mjs / event-wiring-scan.mjs precedent) — importing
// this module (e.g. from a test, to reach _internals) must not run the
// top-level flag-check/main() side effects against the importing process's
// own argv.
const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;

if (isMain) {
  try {
    assertKnownFlags(process.argv.slice(2), KNOWN_FLAGS, { cli: 'event-wiring-lifecycle', from: 0 });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
}

/** Same "a terminal flag or the next flag masquerading as a value is an error" contract as event-wiring-scan.mjs. */
function requiredValue(argv, flag, cli) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${cli}: ${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  return {
    ledger: requiredValue(argv, '--ledger', 'event-wiring-lifecycle'),
    listOpen: argv.includes('--list-open'),
    dismiss: requiredValue(argv, '--dismiss', 'event-wiring-lifecycle'),
    reason: requiredValue(argv, '--reason', 'event-wiring-lifecycle'),
    json: argv.includes('--json'),
  };
}

function fail(code, message, jsonOut) {
  if (jsonOut) {
    emit({ ok: false, error: { code: `EXIT_${code}`, message } });
  } else {
    process.stderr.write(`event-wiring-lifecycle: ${message}\n`);
  }
  process.exitCode = code;
}

function main() {
  const argv = process.argv.slice(2);
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (!args.ledger) {
    fail(2, '--ledger <path> is required', args.json);
    return;
  }
  if (args.listOpen === (args.dismiss !== null)) {
    // Both or neither — the two modes are mutually exclusive and one is required.
    fail(2, 'exactly one of --list-open or --dismiss <eventName> is required', args.json);
    return;
  }
  if (args.reason !== null && args.dismiss === null) {
    fail(2, '--reason only applies to --dismiss', args.json);
    return;
  }

  if (args.listOpen) {
    const open = listOpenLifecycle(args.ledger, { kind: KIND });
    if (args.json) {
      emit({ ok: true, records: open });
    } else if (open.length === 0) {
      process.stdout.write('event-wiring-lifecycle: no open records\n');
    } else {
      for (const r of open) {
        process.stdout.write(`${r.eventName}\tfirstSeen=${new Date(r.firstSeen).toISOString()}\toccurrences=${r.occurrences}\ttriggers=${r.triggers.join('+')}\n`);
      }
    }
    return;
  }

  // --dismiss
  const fingerprint = `${KIND}|${args.dismiss}`;
  const result = dismissLifecycle(args.ledger, fingerprint, { reason: args.reason });
  if (!result.ok) {
    const detail = result.error === 'not-found'
      ? `no lifecycle record for "${args.dismiss}" — nothing to dismiss`
      : `"${args.dismiss}" is not open (current disposition: ${result.disposition}) — only an open record can be dismissed`;
    fail(3, detail, args.json);
    return;
  }
  if (args.json) {
    emit({ ok: true, record: result.record });
  } else {
    process.stdout.write(`event-wiring-lifecycle: dismissed "${args.dismiss}"${args.reason ? ` (${args.reason})` : ''}\n`);
  }
}

/** Internal seams for tests. Underscore-prefixed per repo convention (audit-clean.mjs). */
export const _internals = { parseArgs, requiredValue };

if (isMain) main();
