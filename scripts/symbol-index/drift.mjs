#!/usr/bin/env node
/**
 * @fileoverview Phase D — drift sweep CLI.
 *
 * Calls the `drift_score` Postgres RPC for the repo's active snapshot,
 * evaluates against thresholds (env-tunable), renders a Markdown report
 * and (optionally) writes it via --out for the GH Action sticky-issue body.
 *
 * Mirrors `scripts/memory-health.mjs` exit-code semantics:
 *   0 — green (or insufficient data)
 *   1 — trigger fired (drift score > threshold)
 *   2 — infra error (RPC failure, no Supabase, etc.)
 *
 * @module scripts/symbol-index/drift
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByUuid,
  getActiveSnapshot,
  computeDriftScore,
  getTopDuplicateClusters,
} from '../learning-store.mjs';
import { resolveRepoIdentity } from '../lib/repo-identity.mjs';
import { symbolIndexConfig } from '../lib/config.mjs';
import { renderDriftIssue } from '../lib/arch-render.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';

function parseArgs(argv) {
  const args = { out: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function atomicWrite(file, content) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function classify(driftScore, threshold) {
  if (driftScore <= threshold * 0.5) return 'GREEN';
  if (driftScore <= threshold) return 'AMBER';
  return 'RED';
}

// R1 audit M2: drift.mjs delegates rendering to lib/arch-render.mjs's
// renderDriftIssue() so all three human surfaces (architecture-map.md,
// drift sticky issue, neighbourhood callout) share one renderer. Local
// renderMarkdown() removed.
function renderMarkdownViaShared(drift, threshold, status, identity, clusters) {
  const { markdown } = renderDriftIssue({
    drift,
    threshold,
    status,
    generatedAt: drift.generated_at,
    commitSha: drift.refresh_id, // best-available identifier without git lookup
    refreshId: drift.refresh_id,
    repoName: identity.name,
    clusters,
    violations: [], // listed elsewhere; map references it
  });
  return markdown + '\n';
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertRepoRoot(import.meta.url);
  const args = parseArgs(process.argv);
  await initLearningStore();
  if (!isCloudEnabled()) {
    process.stderr.write('arch:drift: cloud disabled — skipping\n');
    process.exit(0);
  }
  const identity = resolveRepoIdentity(process.cwd());
  const repo = await getRepoIdByUuid(identity.repoUuid);
  if (!repo) {
    process.stderr.write(`arch:drift: repo not found in store — run \`npm run arch:refresh\` first\n`);
    process.exit(0);
  }
  const snap = await getActiveSnapshot(repo.id);
  if (!snap?.refreshId) {
    process.stderr.write(`arch:drift: no active snapshot for repo\n`);
    process.exit(0);
  }
  let drift;
  try {
    drift = await computeDriftScore({
      repoId: repo.id,
      refreshId: snap.refreshId,
      simDup: symbolIndexConfig.driftSimDup,
      simName: symbolIndexConfig.driftSimName,
    });
  } catch (err) {
    process.stderr.write(`arch:drift: RPC failed: ${err.message}\n`);
    process.exit(2);
  }
  const threshold = symbolIndexConfig.driftThreshold;
  const status = classify(Number(drift.score) || 0, threshold);

  // Surface the top duplicate clusters for the issue body. Best-effort —
  // if the RPC fails (e.g. older Supabase without the migration applied),
  // render still proceeds with empty clusters.
  let rawClusters = [];
  try {
    rawClusters = await getTopDuplicateClusters({
      repoId: repo.id, refreshId: snap.refreshId, limit: 20,
    });
  } catch (err) {
    process.stderr.write(`arch:drift: top_duplicate_clusters failed (continuing without): ${err.message}\n`);
  }

  // Adapt to the shape renderDriftIssue expects: {label, similarity,
  // members:[{symbolName, filePath, purposeSummary}]}. similarity is 1.0
  // because these are EXACT signature_hash matches.
  const clusters = rawClusters.map(c => ({
    label: `${c.symbolNames.join(' / ')} (${c.kind})`,
    similarity: 1.0,
    firstSeen: null,
    members: c.filePaths.map((fp, i) => ({
      symbolName: c.symbolNames[Math.min(i, c.symbolNames.length - 1)],
      filePath: fp,
      purposeSummary: c.examplePurpose,
    })),
  }));

  const md = renderMarkdownViaShared(drift, threshold, status, identity, clusters);

  if (args.json) process.stdout.write(JSON.stringify({ drift, threshold, status }, null, 2) + '\n');
  else process.stdout.write(md);

  if (args.out) atomicWrite(args.out, md);

  process.stderr.write(`arch:drift: status=${status} score=${drift.score}/${threshold}\n`);
  process.exit(status === 'RED' ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`arch:drift: fatal: ${err.stack || err.message}\n`);
  process.exit(2);
});
