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
import { findStalePragmas, renderStalePragmaSection } from '../lib/symbol-index/stale-pragma-sweep.mjs';
import { findRepoPragmas, resolvePragmasToDefinitions } from '../lib/duplicate-justification-pragma.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByUuid,
  getActiveSnapshot,
  computeDriftScore,
  getTopDuplicateClusters,
  listSymbolsForSnapshot,
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
  if (!await isCloudEnabled()) {
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

  const stalePragmas = findStalePragmas(process.cwd());

  // Report-time reconciliation of ambiguous/unresolved @duplicate-
  // justification pragmas (round-2 M1) — the WRITE path (refresh.mjs) is
  // the safety-critical one (an ambiguous/unresolved pragma is simply not
  // excluded, never mis-attached), this is advisory surfacing so an author
  // gets feedback. Best-effort — a query failure degrades to skipping this
  // section, never blocks the report.
  let excludedNote = '';
  let ambiguousUnresolvedSection = '';
  const excludedCount = Number(drift.duplication_excluded_count) || 0;
  if (excludedCount > 0) {
    excludedNote = `\n_Excludes ${excludedCount} \`@duplicate-justification\`-marked declaration(s) this refresh._\n`;
  }
  try {
    const repoPragmas = findRepoPragmas(process.cwd());
    if (repoPragmas.length > 0) {
      // listSymbolsForSnapshot already returns camelCase (definitionId,
      // filePath, startLine, symbolName, kind) — round-3 M1 fix: an
      // earlier draft read snake_case here, so every candidate silently
      // had undefined fields and this whole reconciliation was a no-op.
      const symbols = await listSymbolsForSnapshot({ refreshId: snap.refreshId, limit: 10000 });
      const candidates = symbols.map((s) => ({
        filePath: s.filePath, symbolName: s.symbolName, kind: s.kind,
        startLine: s.startLine, definitionId: s.definitionId,
      }));
      const { ambiguous, unresolved } = resolvePragmasToDefinitions(repoPragmas, candidates);
      if (ambiguous.length > 0 || unresolved.length > 0) {
        const rows = [
          ...ambiguous.map((a) => `| \`${a.pragmaFile}:${a.pragmaLine}\` | ambiguous — declaration already claimed by another pragma |`),
          ...unresolved.map((u) => `| \`${u.pragmaFile}:${u.pragmaLine}\` | unresolved — no declaration found within the resolution window |`),
        ].join('\n');
        ambiguousUnresolvedSection = `\n## Unresolved suppression pragmas (LOW — not excluded, not a safety gap)\n\n` +
          `| Pragma location | Issue |\n|---|---|\n${rows}\n\n` +
          `These \`// @duplicate-justification\` pragmas could not be resolved to a single declaration this refresh — they do NOT exclude anything from the drift score. Check placement (the pragma must sit immediately above the declaration it justifies) and that at most one pragma targets each declaration.\n`;
      }
    }
  } catch (err) {
    process.stderr.write(`arch:drift: pragma reconciliation skipped: ${err.message}\n`);
  }

  const md = renderMarkdownViaShared(drift, threshold, status, identity, clusters) + excludedNote + renderStalePragmaSection(stalePragmas) + ambiguousUnresolvedSection;

  if (args.json) process.stdout.write(JSON.stringify({ drift, threshold, status, stalePragmas }, null, 2) + '\n');
  else process.stdout.write(md);

  if (args.out) atomicWrite(args.out, md);

  process.stderr.write(`arch:drift: status=${status} score=${drift.score}/${threshold}\n`);
  process.exit(status === 'RED' ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`arch:drift: fatal: ${err.stack || err.message}\n`);
  process.exit(2);
});
