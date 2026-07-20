#!/usr/bin/env node
/**
 * @fileoverview Phase D — snapshot retention prune (per R2 M5).
 *
 * Policy (from plan §2 Snapshot retention):
 *   - active: forever
 *   - rollback: last 4 published per repo, forever
 *   - weekly_checkpoint: one per ISO week, retained 90 days
 *   - transient: pruned after 30 days
 *   - aborted: pruned after 7 days
 *
 * Prune is transactional per snapshot — snapshot-scoped rows
 * (symbol_index, symbol_layering_violations) cascade-delete via the
 * refresh_runs FK CASCADE.
 *
 * @module scripts/symbol-index/prune
 */

import 'dotenv/config';
import {
  initLearningStore,
  isCloudEnabled,
  listRepoIds,
  listPrunableRefreshRuns,
  deleteRefreshRuns,
  listRollbacksForRepo,
  demoteRefreshRuns,
} from '../learning-store.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';
import { assertKnownFlags } from '../lib/cli-io.mjs';

/**
 * Every flag this CLI accepts — must list only flags `parseArgs` HANDLES.
 * @see scripts/symbol-index/refresh.mjs KNOWN_FLAGS for why that matters.
 */
export const KNOWN_FLAGS = Object.freeze(['--dry-run']);

function parseArgs(argv) {
  // Fails in the dangerous direction without this: the ONLY flag prune accepts
  // is the one that makes it harmless, so any typo (`--dry-runn`, `--dryrun`)
  // was silently dropped and the run DELETED rows the operator meant only to
  // preview. Sibling `refresh.mjs` has no `--dry-run` at all, which is what
  // made assuming this family's flags a live-store incident (2026-07-20).
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'prune' });

  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

const ROLLBACK_KEEP = 4;
const CHECKPOINT_RETAIN_DAYS = 90;
const TRANSIENT_RETAIN_DAYS = 30;
const ABORTED_RETAIN_DAYS = 7;

async function main() {
  assertRepoRoot(import.meta.url);
  const args = parseArgs(process.argv);
  await initLearningStore();
  if (!await isCloudEnabled()) {
    process.stderr.write('arch:prune: cloud disabled — skipping\n');
    process.exit(0);
  }

  async function pruneClass({ filterCol, filterVal, retainDays }) {
    const ids = await listPrunableRefreshRuns({ filterCol, filterVal, retainDays });
    if (ids.length === 0) return 0;
    if (args.dryRun) return ids.length;
    return await deleteRefreshRuns(ids);
  }

  // 1. Aborted runs older than 7d (incl. those that never set completed_at —
  //    the listPrunableRefreshRuns helper accounts for the NULL-completed_at
  //    crash case via started_at < cutoff, closing Gemini-G3).
  const prunedAborted     = await pruneClass({ filterCol: 'status',          filterVal: 'aborted',           retainDays: ABORTED_RETAIN_DAYS });
  // 2. Transient older than 30d
  const prunedTransient   = await pruneClass({ filterCol: 'retention_class', filterVal: 'transient',         retainDays: TRANSIENT_RETAIN_DAYS });
  // 3. Weekly checkpoints older than 90d
  const prunedCheckpoints = await pruneClass({ filterCol: 'retention_class', filterVal: 'weekly_checkpoint', retainDays: CHECKPOINT_RETAIN_DAYS });

  // 4. Rollback retention: keep last 4 per repo. Demote older to 'transient'
  //    so the next prune cycle catches them via the transient retention rule.
  let demotedRollback = 0;
  const repoIds = await listRepoIds();
  for (const repoId of repoIds) {
    const rollbacks = await listRollbacksForRepo(repoId);
    if (rollbacks.length <= ROLLBACK_KEEP) continue;
    const demote = rollbacks.slice(ROLLBACK_KEEP).map((x) => x.id);
    if (demote.length === 0) continue;
    if (!args.dryRun) {
      const n = await demoteRefreshRuns(demote, 'transient');
      demotedRollback += n;
    } else {
      demotedRollback += demote.length;
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    pruned: { aborted: prunedAborted, transient: prunedTransient, checkpoints: prunedCheckpoints },
    demoted: { rollback: demotedRollback },
  }) + '\n');
  process.stderr.write(`arch:prune: aborted=${prunedAborted} transient=${prunedTransient} checkpoints=${prunedCheckpoints} demoted=${demotedRollback}\n`);
  process.exit(0);
}

main().catch((err) => {
  // A usage mistake is not an operational failure: exit 2 with the message
  // alone (a stack trace buries the one line the operator needs to read).
  if (err?.code === 'ARGV_ERROR') {
    process.stderr.write(`arch:prune: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`arch:prune: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
