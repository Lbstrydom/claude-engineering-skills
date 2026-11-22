#!/usr/bin/env node
/**
 * @fileoverview `capture:completeness` - make silent capture loss visible from METADATA alone
 * (docs/plans/own-model-full-capture.md section 2.9, phase P0). Stores no content.
 *
 *   node scripts/capture-completeness.mjs report [--days N] [--repo NAME] [--json]
 *   node scripts/capture-completeness.mjs canary [--break-write]
 *   node scripts/capture-completeness.mjs flush-ledger
 *
 * report: start events from audit dispatch, chip launch and fleet land, reconciled against
 *   completions, per repo x capture_schema_version. Exit 0 measured and no gap / 1 a measured gap /
 *   3 unmeasured (zero judgeable starts is never green).
 * canary: one synthetic two-attempt call through the real metadata pipeline into the store, read back
 *   and deleted. Exit 0 ok (or disabled by LEARNING_DISABLE=1) / 1 failed / 3 unmeasured.
 *   `--break-write` is its negative control: it must exit 1.
 * flush-ledger: deliver the local decision-ledger spool to the store (the only thing that ever delivers it). Exit 0 flushed /
 *   disabled, 1 a failed flush (events stay spooled), 3 unmeasured (cloud off).
 *
 * @module scripts/capture-completeness
 */
import './lib/load-env.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { assertKnownFlags, ArgvError, arg, emit, finishAndExit } from './lib/cli-io.mjs';
import { buildReport, renderReport } from './lib/capture/report.mjs';

export { buildReport, renderReport };

const FLAGS = ['--days', '--repo', '--json', '--break-write', '--selfcheck-relocation'];

export async function main(argv = process.argv, deps = {}) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  const sub = argv[2];
  assertKnownFlags(argv.slice(3), FLAGS, { cli: 'capture-completeness', from: 0 });
  if (sub !== 'report' && sub !== 'canary' && sub !== 'flush-ledger') throw new ArgvError('usage: capture-completeness.mjs report [--days N] [--repo NAME] [--json] | canary [--break-write] | flush-ledger');
  // Each subcommand accepts only its own flags: a flag that is accepted and ignored reads as honoured.
  assertKnownFlags(argv.slice(3), [...(sub === 'report' ? ['--days', '--repo', '--json'] : sub === 'canary' ? ['--break-write'] : []), '--selfcheck-relocation'], { cli: `capture-completeness ${sub}`, from: 0 });
  const initStore = deps.initStore ?? (async () => (await import('./lib/store/repo.mjs')).initLearningStore());
  const { closePool } = await import('./lib/db/client.mjs');
  try {
    if (sub === 'flush-ledger') {
      // The decision ledger spools locally and is delivered only by a flush; nothing ran one, so 14 events sat spooled
      // since 2026-10-27 with 0 rows in own_model_ledger. A flush that cannot deliver is exit 1, never an empty table.
      if (process.env.LEARNING_DISABLE === '1') { emit({ ok: true, result: 'disabled' }); return 0; }
      if (!await initStore()) { emit({ ok: false, result: 'unmeasured:cloud-off' }); return 3; }
      const { ledgerDir, flushSpool } = await import('./lib/ledger/spool.mjs');
      const { recordLedgerEvents } = await import('./lib/store/own-model-ledger.mjs');
      const res = await flushSpool({ dir: ledgerDir(), write: recordLedgerEvents });
      emit({ ok: !res.error, result: res.error ? 'failed' : 'flushed', ...res });
      return res.error ? 1 : 0;
    }
    if (sub === 'canary') {
      if (process.env.LEARNING_DISABLE === '1') { emit({ ok: true, result: 'disabled', checks: [] }); return 0; }
      if (!await initStore()) { emit({ ok: false, result: 'unmeasured:cloud-off', checks: [] }); return 3; }
      const { runCanary } = await import('./lib/capture/canary.mjs');
      const out = await runCanary({ breakWrite: argv.includes('--break-write') });
      const code = out.result === 'ok' ? 0 : out.result.startsWith('unmeasured') ? 3 : 1;
      emit({ ok: code === 0, ...out });
      return code;
    }
    for (const f of ['--days', '--repo']) {   // a flag with no value must not silently fall back to the default scope
      const i = argv.indexOf(f);
      if (i >= 0 && (argv[i + 1] === undefined || String(argv[i + 1]).startsWith('--'))) throw new ArgvError(`${f} needs a value`);
    }
    const days = Number(arg(argv, '--days') ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new ArgvError('--days must be an integer 1..365');
    if (!await initStore()) { emit({ ok: false, schema: 'capture-completeness/v1', unmeasured: 'store-unreachable' }); return 3; }
    const report = await buildReport({ days, repo: arg(argv, '--repo') ?? null });
    if (argv.includes('--json')) emit({ ok: report.exitCode === 0, ...report }); else process.stdout.write(`${renderReport(report)}\n`);
    return report.exitCode;
  } finally {
    await closePool().catch(() => {});
  }
}

if (isInvokedAsScript(import.meta.url)) {
  main(process.argv).then((code) => finishAndExit(code), (err) => {
    process.stderr.write(`capture-completeness: ${err?.message ?? err}\n`);
    if (process.argv.includes('--json')) emit({ ok: false, error: String(err?.message ?? err) });
    return finishAndExit(err?.code === 'ARGV_ERROR' ? 2 : 1);
  });
}
