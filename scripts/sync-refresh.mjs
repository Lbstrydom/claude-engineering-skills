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
 *
 * @module scripts/sync-refresh
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargets, consumerAliases } from './lib/consumer-repos.mjs';

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
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--target');
  const target = ti >= 0 ? argv[ti + 1] : null;
  const noPull = argv.includes('--no-pull');

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
  if (!noPull) {
    process.stdout.write(`${G}→ pulling canonical${X} ${D}(claude-engineering-skills)${X}\n`);
    const pull = run('git', ['pull', '--ff-only'], REPO_ROOT);
    if (pull.status !== 0) {
      process.stderr.write(`${Y}⚠ git pull did not fast-forward — syncing with the CURRENT clone state.${X}\n`);
    }
  }

  // 2. Sync into the consumer (one-directional filesystem write).
  process.stdout.write(`${G}→ syncing → ${matches.map((m) => m.name).join(', ')}${X}\n`);
  const sync = run('node', ['scripts/sync-to-repos.mjs', '--target', target], REPO_ROOT);
  if (sync.status !== 0) {
    process.stderr.write(`${R}sync failed (exit ${sync.status})${X}\n`);
    process.exit(sync.status || 1);
  }

  // 3. Show the consumer's tracked changes — what YOU review + push to its remote.
  for (const m of matches) {
    process.stdout.write(`\n${G}✓ ${m.name}${X} ${D}(${m.path})${X}\n`);
    const status = capture('git', ['status', '--short'], m.path);
    if (!status) {
      process.stdout.write(`  ${D}no tracked changes — already up to date.${X}\n`);
    } else {
      process.stdout.write(status.split('\n').map((l) => `  ${l}`).join('\n') + '\n');
      process.stdout.write(`  ${Y}review, then commit + push to its own remote.${X}\n`);
      process.stdout.write(`  ${D}(scripts/.claude-skills/** is gitignored and won't appear here.)${X}\n`);
    }
  }
}

main();
