#!/usr/bin/env node
/**
 * @fileoverview Every time-windowed store view must DECLARE its window.
 *
 * **Why it exists.** A count read off a windowed view is a snapshot of a rotating
 * cohort, and nothing in the repository asked whether a figure compared over time
 * was even a comparison. Measured 2026-11-13: `unremediated_acceptances` fell from
 * 116 to 47 code rows over five weeks; the two windows shared **0** rows and
 * **110 of the 116** were still open and unremediated. The 47 reproduced exactly
 * by two independent instruments — reproducing a figure cannot detect that the
 * population under it rotated. (`docs/plans/standing-queue-burndown.md` §7.)
 *
 * **What it checks.** The live definition of every view in the cumulative
 * migrations is classified as windowed or not — windowedness propagates through
 * view references, because the view at the centre of that incident
 * (`unremediated_acceptances = … FROM unremediated_acceptances_all WHERE is_recent`)
 * mentions no clock at all. Each windowed view must appear in the committed
 * `.windowed-views.json` with the window it carries and what a caller may compare
 * instead, or carry a reasoned exemption.
 *
 * **Both directions fail**, in the drift-only ratchet shape `knip-gate` and
 * `skill-size-ratchet` already use: an undeclared windowed view is a figure nobody
 * will know not to trend, and a declaration for a view that is no longer windowed
 * is a false claim in the file a reader consults.
 *
 * **Scope boundary, stated.** It judges VIEWS, not hand-written reader SQL. A
 * reader can window a stable view with its own `now()`; that is a wider net, and
 * an undeclared-view finding is the one that explains both observed incidents.
 *
 * Offline and deterministic: it reads tracked `.sql` files only, and an empty or
 * unreadable migrations directory FAILS rather than reporting "no windowed views".
 *
 * Usage:
 *   node scripts/check-windowed-views.mjs            # gate
 *   node scripts/check-windowed-views.mjs --report   # report-only, exit 0
 *   node scripts/check-windowed-views.mjs --list     # every view and its verdict
 *
 * Plan: docs/plans/standing-queue-burndown.md §7.
 *
 * @module scripts/check-windowed-views
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import {
  MANIFEST_PATH,
  collectViewDefinitions,
  classifyWindowedViews,
  readManifest,
  diffAgainstManifest,
} from './lib/store/windowed-views.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The phrase every undeclared-window failure prints; the poison pill matches it. */
export const UNDECLARED_PHRASE = 'windowed view must declare its window';

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }

  try {
    assertKnownFlags(process.argv, ['--report', '--list', '--help', '-h', '--selfcheck-relocation'], { cli: 'check-windowed-views' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write(`Usage: node scripts/check-windowed-views.mjs [options]

Every store view whose result depends on now() must be declared in ${MANIFEST_PATH},
with the window it carries and what a caller may compare across time instead.

Options:
  --report    Report findings, always exit 0
  --list      Print every view and its verdict
  --help      Show this message

Exit codes: 0=clean, 1=drift, 2=missing/invalid manifest or bad flag
`);
    await finishAndExit(0); return;
  }
  const reportOnly = process.argv.includes('--report');

  let classified;
  try {
    classified = classifyWindowedViews(collectViewDefinitions(REPO));
  } catch (err) {
    // An unreadable corpus is a FAILURE, never "no windowed views".
    process.stderr.write(`check-windowed-views: cannot classify the store views — ${err.message}\n`);
    await finishAndExit(reportOnly ? 0 : 1); return;
  }

  const state = readManifest(REPO);
  if (state.kind !== 'ok') {
    process.stderr.write(state.kind === 'missing'
      ? `check-windowed-views: no ${MANIFEST_PATH} — create it, declaring each windowed view's window and what a caller may compare instead.\n`
      : `check-windowed-views: ${MANIFEST_PATH} is invalid (${state.reason}) — fix it by hand.\n`);
    await finishAndExit(reportOnly ? 0 : 2); return;
  }

  if (process.argv.includes('--list')) {
    for (const [name, rec] of [...classified].sort(([a], [b]) => a.localeCompare(b))) {
      const verdict = rec.windowed ? `WINDOWED (${rec.reason}${rec.via ? ` via ${rec.via}` : ''})` : 'stable';
      process.stdout.write(`  ${name.padEnd(32)} ${verdict}\n`);
    }
  }

  const { undeclared, staleDeclared, staleExempt } = diffAgainstManifest(classified, state);
  const windowedCount = [...classified.values()].filter((r) => r.windowed).length;

  if (undeclared.length === 0 && staleDeclared.length === 0 && staleExempt.length === 0) {
    process.stdout.write(`check-windowed-views: clean — ${classified.size} view(s), ${windowedCount} windowed, all declared.\n`);
    await finishAndExit(0); return;
  }

  for (const u of undeclared) {
    process.stderr.write(`  UNDECLARED  ${u.name} — ${u.reason === 'inherits' ? `inherits the window of ${u.via}` : 'its definition calls a clock function'} (${u.file})\n`);
  }
  for (const s of staleDeclared) process.stderr.write(`  STALE       ${s.name} — declared windowed, but ${s.why}\n`);
  for (const s of staleExempt) process.stderr.write(`  STALE-EXEMPT ${s.name} — ${s.why}\n`);
  process.stderr.write('\n');
  if (undeclared.length) {
    process.stderr.write(`  Rule: a ${UNDECLARED_PHRASE}, because a count read off it is a snapshot of a\n`
      + `  rotating cohort and two such counts are not a trend. Add it to ${MANIFEST_PATH} with\n`
      + '  `window` (what rotates) and `comparable` (what a caller may compare across time instead),\n'
      + '  or an entry under `exemptions` carrying a reason.\n');
  }
  if (staleDeclared.length || staleExempt.length) {
    process.stderr.write(`  A declaration for a view that is no longer windowed misleads the next reader: remove it from ${MANIFEST_PATH}.\n`);
  }
  await finishAndExit(reportOnly ? 0 : 1);
}

if (isInvokedAsScript(import.meta.url)) {
  await main();
}
