#!/usr/bin/env node
/**
 * @fileoverview `telemetry:exports` — what each expected exporter has sent CES, in one of five
 * states, never as a zero (docs/plans/private-store-telemetry-path.md §2.4).
 *
 * CES-only. Reads the drop directory (`TELEMETRY_DROP_DIR` or `--drop-dir`) and the consumers in the
 * gitignored registry that declare a `telemetry` block. Advisory: always exits 0 (a missing export is a
 * missing measurement to SHOW, not a failure to BLOCK on) — except usage errors (2).
 *
 * Usage:
 *   node scripts/telemetry-exports.mjs [--drop-dir <dir>] [--json]
 *   node scripts/telemetry-exports.mjs --prune        # remove files beyond retention (explicit, single-file unlinks)
 *
 * @module scripts/telemetry-exports
 */
import './lib/load-env.mjs';
import { assertKnownFlags, ArgvError, argOption, hasFlag, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { expectedExporters } from './lib/consumer-repos.mjs';
import { scanDrop, pruneDrop, renderTelemetryExports } from './lib/telemetry-export/reader.mjs';

const KNOWN_FLAGS = ['--drop-dir', '--json', '--prune', '--selfcheck-relocation'];

async function main() {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'telemetry-exports' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }

  const expected = expectedExporters();
  if (expected.length === 0) {
    // The same channel and shape whichever way it is asked for: a JSON caller gets JSON, never prose.
    process.stdout.write(hasFlag('json')
      ? `${JSON.stringify({ scanError: null, scanIncomplete: null, aliases: [], unattributed: [], expected: 0 }, null, 2)}\n`
      : 'telemetry exports: no registered consumer declares a `telemetry` block — nothing is expected, nothing is measured\n');
    await finishAndExit(0); return;
  }
  const dropDir = argOption('drop-dir') || process.env.TELEMETRY_DROP_DIR || null;
  const scan = scanDrop({ dropDir, expected, now: new Date() });

  if (hasFlag('prune')) {
    const r = pruneDrop(scan);
    process.stderr.write(r.skipped
      ? 'telemetry exports: scan not clean — nothing was pruned\n'
      : `telemetry exports: pruned ${r.removed} file(s) beyond retention${r.failed ? `; ${r.failed} could NOT be removed — retention is not enforced` : ''}\n`);
  }
  if (hasFlag('json')) {
    // Strip file paths: they are local and of no use to a reader of the JSON.
    const slim = { ...scan, aliases: scan.aliases.map(({ files, ...rest }) => rest) };
    process.stdout.write(`${JSON.stringify(slim, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTelemetryExports(scan).join('\n')}\n`);
  }
  await finishAndExit(0);
}

if (isInvokedAsScript(import.meta.url)) await main();
