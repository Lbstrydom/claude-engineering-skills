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
import { assertKnownFlags, ArgvError, finishAndExit } from '../lib/cli-io.mjs';
import { pathToFileURL } from 'node:url';

/**
 * Every flag this CLI accepts. Enforced, not merely documented: `--limit` now
 * drives an over-fetch AND the `truncated` claim a policy gate reads, so a
 * silently-ignored `--limti 50` would enforce that gate over a 20-cluster
 * prefix while the envelope still described itself as complete.
 */
const KNOWN_FLAGS = ['--limit', '--json', '--help'];

function parseArgs(argv) {
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'arch:duplicates' });
  const args = { limit: 20, json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      // By PATH, not `npm run` — the sync never adds npm aliases to a consumer
      // (AGENTS.md), so the alias form names a script that does not exist
      // there. `args.help` rather than an inline exit: the write-then-exit(0)
      // pair truncates on a pipe exactly like the one fixed in `main()` below
      // (audit R2 L3), and fixing one branch while leaving its twin is the
      // "fix what the audit named and stop" failure.
      args.help = true;
    }
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0 || !Number.isInteger(args.limit)) {
    process.stderr.write('arch:duplicates: --limit must be a positive integer\n');
    process.exit(2);
  }
  return args;
}

/**
 * Split an over-fetched page into "the page" plus a truthful truncation flag.
 *
 * The RPC has no count mode, so exhaustivity is established by asking for ONE
 * more row than the caller wants: if it comes back, more exist. `total` is
 * `null` when truncated — the number is genuinely unknown, and reporting the
 * page size as the total is the fabrication this exists to prevent. A consumer
 * enforcing a policy over ALL clusters previously had to infer truncation from
 * `clusters.length === limit`, which is correct but cannot tell a full page
 * from an exactly-full result.
 *
 * @param {object[]} rows - up to `limit + 1` rows
 * @param {number} limit
 * @returns {{clusters: object[], truncated: boolean, total: number|null}}
 */
export function paginate(rows, limit) {
  const truncated = rows.length > limit;
  const clusters = truncated ? rows.slice(0, limit) : rows;
  return { clusters, truncated, total: truncated ? null : clusters.length };
}

function renderText(clusters, repoName, { truncated, limit }) {
  if (clusters.length === 0) {
    return `arch:duplicates (${repoName}): no cross-file exact-duplicate clusters in this snapshot.\n`;
  }
  const lines = [];
  const count = truncated
    ? `the top ${clusters.length} of MORE than ${limit} cluster(s)`
    : `${clusters.length} cluster(s)`;
  lines.push(`arch:duplicates (${repoName}): ${count} — files share identical symbol bodies + signatures`);
  if (truncated) {
    lines.push(`  (truncated at --limit ${limit}; re-run with a larger --limit for the full set)`);
  }
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
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertRepoRoot(import.meta.url);
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (args.help) {
    process.stdout.write('Usage: node scripts/symbol-index/duplicates.mjs [--limit N] [--json]\n');
    return finishAndExit(0);
  }
  await initLearningStore();
  if (!await isCloudEnabled()) {
    process.stderr.write('arch:duplicates: cloud disabled — skipping\n');
    process.exit(2);
  }
  const identity = resolveRepoIdentity(process.cwd());
  const repo = await getRepoIdByUuid(identity.repoUuid);
  if (!repo) {
    process.stderr.write('arch:duplicates: repo not found in store — run '
      + '`node scripts/symbol-index/refresh.mjs` first\n');
    process.exit(2);
  }
  const snap = await getActiveSnapshot(repo.id);
  if (!snap?.refreshId) {
    process.stderr.write('arch:duplicates: no active snapshot for repo\n');
    process.exit(2);
  }

  let rows;
  try {
    // limit + 1: see `paginate` — the extra row is how truncation is DETECTED
    // rather than inferred.
    rows = await getTopDuplicateClusters({
      repoId: repo.id, refreshId: snap.refreshId, limit: args.limit + 1,
    });
  } catch (err) {
    process.stderr.write(`arch:duplicates: RPC failed: ${err.message}\n`);
    process.exit(2);
  }
  const { clusters, truncated, total } = paginate(rows, args.limit);

  if (args.json) {
    process.stdout.write(JSON.stringify({
      repoName: identity.name,
      refreshId: snap.refreshId,
      // `limit`/`truncated`/`total` let a caller assert EXHAUSTIVITY. Without
      // them a policy gate over "all clusters" cannot tell a complete result
      // from a full page, and silently enforces over a prefix.
      limit: args.limit,
      returned: clusters.length,
      truncated,
      total,
      clusters,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(clusters, identity.name, { truncated, limit: args.limit }));
  }
  // NOT `process.exit(0)`: on Windows a redirected/piped stdout is async, and
  // exit() discards whatever has not flushed. The `--json` envelope exists to
  // be read by a policy gate THROUGH a pipe, and `truncated`/`total` are
  // worthless inside JSON that was itself truncated.
  await finishAndExit(0);
}

// CLI-only entry guard, same idiom as extract.mjs / gemini-review.mjs. Without
// it, importing this module to unit-test `paginate` starts a real cloud query.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    process.stderr.write(`arch:duplicates: fatal: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
