#!/usr/bin/env node
/**
 * @fileoverview Operator CLI for the transcript archive
 * (docs/plans/own-model-telemetry-pr3.md decision 8). Core: lib/telemetry/transcript-archive.mjs.
 *
 *   node scripts/transcript-archive.mjs archive --file t.md --repo Lbstrydom/claude-engineering-skills --coordinator CES --date 2026-10-27
 *   node scripts/transcript-archive.mjs verify --repair
 *   node scripts/transcript-archive.mjs purge --repo Lbstrydom/claude-engineering-skills
 *
 * Default-deny: content is stored only for a repo whose stored flag is exactly `true`.
 * A repo that is `false`, undecided or unreachable (storyline today) gets a manifest row
 * with the sha256 and NO content.
 *
 * @module scripts/transcript-archive
 */
import fs from 'node:fs';
import './lib/load-env.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { assertKnownFlags, ArgvError, arg, finishAndExit } from './lib/cli-io.mjs';
import { archiveDir, archiveTranscript, purgeRepo, verifyArchive } from './lib/telemetry/transcript-archive.mjs';

async function resolveFlag(repo) {
  try {
    const { initLearningStore } = await import('./lib/store/repo.mjs');
    if (!await initLearningStore()) return 'unknown';
    const { lookupRepoFlag } = await import('./lib/store/own-model-ledger.mjs');
    return (await lookupRepoFlag(repo)).flag;
  } catch { return 'unknown'; }
}

async function main(argv) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  const sub = argv[2];
  assertKnownFlags(argv.slice(3), ['--file', '--repo', '--coordinator', '--date', '--dir', '--repair'], { cli: 'transcript-archive', from: 0 });
  if (!['archive', 'verify', 'purge'].includes(sub)) throw new ArgvError('usage: transcript-archive.mjs archive --file <f> --repo <r> --coordinator CES|WCA|STO|AIO|other --date YYYY-MM-DD | verify [--repair] | purge --repo <r>');
  const dir = arg(argv, '--dir') ?? archiveDir();
  if (sub === 'verify') {
    const res = verifyArchive({ dir, repair: argv.includes('--repair') });
    console.log(JSON.stringify(res));
    return res.ok || res.repaired ? 0 : 1;
  }
  const repo = arg(argv, '--repo');
  if (!repo) throw new ArgvError('--repo is required');
  if (sub === 'purge') {
    console.log(JSON.stringify(purgeRepo({ dir, repo })));
    return 0;
  }
  const file = arg(argv, '--file');
  if (!file) throw new ArgvError('--file is required');
  const flag = await resolveFlag(repo);
  const { closePool } = await import('./lib/db/client.mjs');
  try {
    const res = archiveTranscript({
      dir, repo, coordinator: arg(argv, '--coordinator'), date: arg(argv, '--date'),
      text: fs.readFileSync(file, 'utf8'), flag,
    });
    console.log(JSON.stringify({ ...res, flag }));
    return res.ok ? 0 : 1;
  } finally { await closePool(); }
}

if (isInvokedAsScript(import.meta.url)) {
  main(process.argv).then((code) => finishAndExit(code), (err) => {
    process.stderr.write(`transcript-archive: ${err.message}\n`);
    return finishAndExit(err?.code === 'ARGV_ERROR' ? 2 : 1);
  });
}
