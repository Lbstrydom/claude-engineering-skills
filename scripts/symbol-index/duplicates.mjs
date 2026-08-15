#!/usr/bin/env node
/**
 * @fileoverview arch:duplicates — list top cross-file duplicate clusters
 * for the active snapshot. Companion to arch:drift, which gives a single
 * count; this CLI shows what's actually duplicated so triage is one
 * command away.
 *
 * Usage:
 *   npm run arch:duplicates
 *   npm run arch:duplicates -- --limit 50
 *   npm run arch:duplicates -- --json
 *
 * Exit codes:
 *   0 — query succeeded (zero or many clusters; both are normal)
 *   2 — infra error (RPC failed, no Supabase, no active snapshot)
 *
 * @module scripts/symbol-index/duplicates
 */

import '../lib/load-env.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByUuid,
  getActiveSnapshot,
  getTopDuplicateClusters,
} from '../learning-store.mjs';
import { resolveRepoIdentity } from '../lib/repo-identity.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';

function parseArgs(argv) {
  const args = { limit: 20, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write(`Usage: npm run arch:duplicates [-- --limit N] [--json]\n`);
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0 || !Number.isInteger(args.limit)) {
    process.stderr.write('arch:duplicates: --limit must be a positive integer\n');
    process.exit(2);
  }
  return args;
}

function renderText(clusters, repoName) {
  if (clusters.length === 0) {
    return `arch:duplicates (${repoName}): no cross-file exact-duplicate clusters in this snapshot.\n`;
  }
  const lines = [];
  lines.push(`arch:duplicates (${repoName}): ${clusters.length} cluster(s) — files share identical symbol bodies + signatures`);
  lines.push('');
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    lines.push(`${i + 1}. [${c.kind}] ${c.symbolNames.join(' / ')}  —  ${c.fileCount} files`);
    if (c.examplePurpose) lines.push(`     "${c.examplePurpose}"`);
    for (const fp of c.filePaths) lines.push(`     • ${fp}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  assertRepoRoot(import.meta.url);
  const args = parseArgs(process.argv);
  await initLearningStore();
  if (!await isCloudEnabled()) {
    process.stderr.write('arch:duplicates: cloud disabled — skipping\n');
    process.exit(2);
  }
  const identity = resolveRepoIdentity(process.cwd());
  const repo = await getRepoIdByUuid(identity.repoUuid);
  if (!repo) {
    process.stderr.write(`arch:duplicates: repo not found in store — run \`npm run arch:refresh\` first\n`);
    process.exit(2);
  }
  const snap = await getActiveSnapshot(repo.id);
  if (!snap?.refreshId) {
    process.stderr.write('arch:duplicates: no active snapshot for repo\n');
    process.exit(2);
  }

  let clusters;
  try {
    clusters = await getTopDuplicateClusters({
      repoId: repo.id, refreshId: snap.refreshId, limit: args.limit,
    });
  } catch (err) {
    process.stderr.write(`arch:duplicates: RPC failed: ${err.message}\n`);
    process.exit(2);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ repoName: identity.name, refreshId: snap.refreshId, clusters }, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(clusters, identity.name));
  }
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`arch:duplicates: fatal: ${err.stack || err.message}\n`);
  process.exit(2);
});
