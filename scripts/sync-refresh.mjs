#!/usr/bin/env node
/**
 * @fileoverview One-command "refresh a consumer from canonical".
 *
 * Pulls the latest canonical `claude-engineering-skills` into THIS clone, then
 * syncs it into the target consumer repo. Does NOT commit or push anything —
 * sync is one-directional (canonical → local → you push the consumer's tracked
 * changes to its own remote by hand). Prints the consumer's `git status` so you
 * see exactly what to review + push.
 *
 * Usage:
 *   node scripts/sync-refresh.mjs --target work
 *   node scripts/sync-refresh.mjs --target work --no-pull   # sync only, skip the git pull
 *   node scripts/sync-refresh.mjs --target work --dry-run   # no pull; sync-to-repos --dry-run (shows what would change, writes nothing)
 *
 * @module scripts/sync-refresh
 */

import './lib/help-guard-run.mjs'; import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargets, consumerAliases } from './lib/consumer-repos.mjs';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}
function capture(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return (r.stdout || '').trim();
}

function main() {
  assertKnownFlags(process.argv, ['--target', '--no-pull', '--dry-run'], { cli: 'sync-refresh' });
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const ti = argv.indexOf('--target');
  const target = ti >= 0 ? argv[ti + 1] : null;
  const noPull = argv.includes('--no-pull');
  // The target value is validated before anything runs: a missing one, or another flag standing in for it, is a usage error.
  if (ti >= 0 && (target === undefined || target.startsWith('--'))) {
    process.stderr.write(`sync-refresh: --target needs a value (one of ${consumerAliases().join(', ')})
`);
    process.exit(2);
  }

  if (!target) {
    process.stderr.write(`usage: sync-refresh.mjs --target <${consumerAliases().join('|')}> [--no-pull]\n`);
    process.exit(2);
  }
  const matches = resolveTargets(target);
  if (matches.length === 0) {
    process.stderr.write(`${R}error${X}: unknown target "${target}". Known: ${consumerAliases().join(', ')}\n`);
    process.exit(2);
  }

  // 1. Pull canonical into this clone (read-only from the public remote).
  if (dryRun) {
    process.stdout.write(`${D}--dry-run: not pulling canonical (a pull rewrites this clone); syncing as a dry run${X}
`);
  } else if (!noPull) {
    process.stdout.write(`${G}→ pulling canonical${X} ${D}(claude-engineering-skills)${X}\n`);
    const pull = run('git', ['pull', '--ff-only'], REPO_ROOT);
    if (pull.status !== 0) {
      process.stderr.write(`${Y}⚠ git pull did not fast-forward — syncing with the CURRENT clone state.${X}\n`);
    }
  }

  // 2. Sync into the consumer (one-directional filesystem write).
  process.stdout.write(`${G}→ syncing → ${matches.map((m) => m.name).join(', ')}${X}\n`);
  const sync = run('node', ['scripts/sync-to-repos.mjs', '--target', target, ...(dryRun ? ['--dry-run'] : [])], REPO_ROOT);
  if (sync.status !== 0) {
    process.stderr.write(`${R}sync failed (exit ${sync.status})${X}\n`);
    process.exit(sync.status || 1);
  }

  // A dry run changed nothing in the consumer: say so and stop. (`git status` there would also be a write - it can refresh the index - and
  // its output would describe the tree BEFORE the sync, not the preview.)
  if (dryRun) {
    process.stdout.write(`${D}--dry-run: nothing was changed in ${matches.map((m) => m.name).join(', ')}; the sync-to-repos output above lists what a real run would change.${X}\n`);
    return;
  }

  // 3. Show the consumer's tracked changes — what YOU review + push to its remote.
  for (const m of matches) {
    process.stdout.write(`\n${G}✓ ${m.name}${X} ${D}(${m.path})${X}\n`);
    const status = capture('git', ['status', '--short'], m.path);
    if (!status) {
      process.stdout.write(`  ${D}no tracked changes — already up to date.${X}\n`);
    } else {
      process.stdout.write(status.split('\n').map((l) => `  ${l}`).join('\n') + '\n');
      process.stdout.write(`  ${Y}review, then commit + push to its own remote (or \`npm run sync:pr\` to branch + PR + auto-merge it).${X}\n`);
      process.stdout.write(`  ${D}(scripts/.claude-skills/** is gitignored and won't appear here.)${X}\n`);
    }
  }
}

try {
  main();
} catch (e) {
  if (e instanceof ArgvError) { process.stderr.write(`${e.message}
`); await finishAndExit(2); }
  throw e;
}
