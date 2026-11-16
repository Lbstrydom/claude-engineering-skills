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
 *   npm run arch:duplicates -- --min-lines 8
 *
 * In a consumer repo the sync ships this file as
 * `scripts/.claude-skills/symbol-index/duplicates.mjs` — run it by that path:
 *   node scripts/.claude-skills/symbol-index/duplicates.mjs --json --min-lines 8
 *
 * Size floor (OPT-IN, default off): with `--min-lines 6`, symbols spanning fewer
 * than 6 lines (5 or fewer) are not clustered — a 3-line `sleep` helper copied across test files is not
 * refactor debt. Override per run with `--min-lines N` or per repo with the
 * `ARCH_DUPLICATE_MIN_LINES` env var (flag wins); `--min-lines 0` disables
 * it. The floor applies inside the SQL RPCs, so the arch:drift score uses the
 * same one. `--json` carries a `floor` object (minLines, source, applied,
 * suppressedClusters) — an unknown count is `null`, never 0. A store that has
 * not applied the floor migration returns the UN-floored list with
 * `floor.applied: false`; if the floor was requested explicitly the CLI exits 2.
 * Policy: docs/plans/duplicate-min-lines-floor.md.
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
  computeDriftScore,
  countSymbolsForSnapshot,
  getActiveStoreDescriptor,
} from '../learning-store.mjs';
import { resolveRepoIdentity } from '../lib/repo-identity.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';
import { assertKnownFlags, ArgvError, finishAndExit } from '../lib/cli-io.mjs';
import { isInvokedAsScript } from '../lib/cli-entry.mjs';
import {
  FloorArgError,
  resolveMinLines,
  readMinLinesFlag,
  buildFloorState,
  floorExitCode,
  renderFloorLines,
} from '../lib/symbol-index/duplicate-floor.mjs';

/**
 * Every flag this CLI accepts. Enforced, not merely documented: `--limit` now
 * drives an over-fetch AND the `truncated` claim a policy gate reads, so a
 * silently-ignored `--limti 50` would enforce that gate over a 20-cluster
 * prefix while the envelope still described itself as complete.
 */
const KNOWN_FLAGS = ['--limit', '--json', '--min-lines', '--help'];

function parseArgs(argv) {
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'arch:duplicates' });
  const args = { limit: 20, json: false, help: false, minLinesFlag: readMinLinesFlag(argv.slice(2)) };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--min-lines') { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++; }
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

/**
 * `corpusLine` describes what was measured. The zero-cluster branch below is the
 * exact sentence the 2026-09-04 consumer incident produced — "no cross-file
 * exact-duplicate clusters in this snapshot" — for a snapshot in the wrong
 * database, an hour after the same repo measured 14. A clean result and an empty
 * corpus were one string. Now they are not.
 */
function corpusLine(symbolCount, store) {
  const corpus = Number.isFinite(symbolCount) ? `${symbolCount} symbols` : 'an UNKNOWN number of symbols';
  return `  snapshot: ${corpus}   store: ${store?.label || 'unknown'}`;
}

export function renderText(clusters, repoName, { truncated, limit, symbolCount = null, store = null, floor = null }) {
  const floorLines = floor ? renderFloorLines(floor) : [];
  if (clusters.length === 0) {
    return `arch:duplicates (${repoName}): no cross-file exact-duplicate clusters in this snapshot.\n`
      + [corpusLine(symbolCount, store), ...floorLines].join('\n') + '\n';
  }
  const lines = [];
  const count = truncated
    ? `the top ${clusters.length} of MORE than ${limit} cluster(s)`
    : `${clusters.length} cluster(s)`;
  lines.push(`arch:duplicates (${repoName}): ${count} — files share identical symbol bodies + signatures`);
  lines.push(corpusLine(symbolCount, store));
  lines.push(...floorLines);
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
    process.stdout.write('Usage: node scripts/symbol-index/duplicates.mjs [--limit N] [--min-lines N] [--json]\n'
      + '  --min-lines N  skip symbols spanning fewer than N lines (default 0 = off, opt-in; env ARCH_DUPLICATE_MIN_LINES)\n');
    return finishAndExit(0);
  }
  let resolved;
  try {
    resolved = resolveMinLines({ flag: args.minLinesFlag });
  } catch (err) {
    if (err instanceof FloorArgError) { process.stderr.write(`arch:duplicates: ${err.message}\n`); process.exit(2); }
    throw err;
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
  let floorUnsupported = false;
  const fetchRows = (minLines) => getTopDuplicateClusters({
    // limit + 1: see `paginate` — the extra row is how truncation is DETECTED
    // rather than inferred.
    repoId: repo.id, refreshId: snap.refreshId, limit: args.limit + 1, minLines,
  });
  try {
    rows = await fetchRows(resolved.minLines);
  } catch (err) {
    if (err.code === 'FLOOR_UNSUPPORTED') {
      floorUnsupported = true;
      // The floor only ever REMOVES rows, so the un-floored POPULATION is a
      // superset: it can over-report. A truncated top-N page can additionally
      // be displaced by trivial clusters, so `truncated` still governs
      // completeness. Say so, don't hide it.
      const state = buildFloorState(resolved, { unsupported: true });
      if (floorExitCode(state) === 2) {
        process.stderr.write(`arch:duplicates: --min-lines ${resolved.minLines} was requested (${resolved.source}) `
          + 'but this store has not applied the floor migration (supabase/migrations/20261030130000_duplicate_min_lines_floor.sql). '
          + 'Migrate the store, or pass --min-lines 0 to run without a floor.\n');
        process.exit(2);
      }
      try {
        rows = await fetchRows(0);
      } catch (err2) {
        process.stderr.write(`arch:duplicates: RPC failed: ${err2.message}\n`);
        process.exit(2);
      }
    } else {
      process.stderr.write(`arch:duplicates: RPC failed: ${err.message}\n`);
      process.exit(2);
    }
  }
  const { clusters, truncated, total } = paginate(rows, args.limit);

  // Corpus size + store, for the same reason `truncated`/`total` are here:
  // `limit`/`truncated`/`total` let a caller assert EXHAUSTIVITY over the page,
  // and these two let it assert that the page describes a real corpus in the
  // intended database. A consumer's duplication gate exited 0 over a near-empty
  // snapshot in the wrong store on 2026-09-04 and could not tell — they had to
  // thread the count in from the refresh step's own output to build a floor
  // check. Best-effort: null renders/serialises as unknown, never as 0.
  let symbolCount = null;
  try {
    symbolCount = await countSymbolsForSnapshot({ repoId: repo.id, refreshId: snap.refreshId });
  } catch (err) {
    process.stderr.write(`arch:duplicates: symbol count failed (reporting unknown): ${err.message}\n`);
  }
  const store = getActiveStoreDescriptor();

  // Suppressed-count, from the SAME SQL population as the list (drift_score's
  // duplication_floor). Whole-snapshot, so independent of --limit; fetched once.
  // A failure is reported as an UNKNOWN count (null), never as 0.
  let stats = null;
  if (resolved.minLines > 0 && !floorUnsupported) {
    try {
      const drift = await computeDriftScore({
        repoId: repo.id, refreshId: snap.refreshId, minLines: resolved.minLines,
      });
      stats = drift?.duplication_floor ?? null;
    } catch (err) {
      process.stderr.write(`arch:duplicates: floor stats failed (suppressed count reported as unknown): ${err.message}\n`);
    }
  }
  const floor = buildFloorState(resolved, { stats, unsupported: floorUnsupported });

  if (args.json) {
    process.stdout.write(JSON.stringify({
      repoName: identity.name,
      refreshId: snap.refreshId,
      symbolCount,
      floor,
      store,
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
    process.stdout.write(renderText(clusters, identity.name, { truncated, limit: args.limit, symbolCount, store, floor }));
  }
  // NOT `process.exit(0)`: on Windows a redirected/piped stdout is async, and
  // exit() discards whatever has not flushed. The `--json` envelope exists to
  // be read by a policy gate THROUGH a pipe, and `truncated`/`total` are
  // worthless inside JSON that was itself truncated.
  await finishAndExit(0);
}

// CLI-only entry guard, same idiom as extract.mjs / gemini-review.mjs. Without
// it, importing this module to unit-test `paginate` starts a real cloud query.
if (isInvokedAsScript(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`arch:duplicates: fatal: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
