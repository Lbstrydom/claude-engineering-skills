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
  countSymbolsForSnapshot,
} from '../learning-store.mjs';
import { resolveRepoIdentity } from '../lib/repo-identity.mjs';
import { symbolIndexConfig } from '../lib/config.mjs';
import { renderDriftIssue } from '../lib/arch-render.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';
import { atomicWriteFileSync } from '../lib/file-io.mjs';

function parseArgs(argv) {
  const args = { out: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') {
      // round-1 M2: reject a missing/flag-looking value rather than
      // silently consuming the NEXT flag as the path (`--out --json` used
      // to set out="--json" and leave args.json false) — same idiom as
      // refresh-args.mjs's `--since-commit` guard.
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`--out requires a non-empty path value (got ${JSON.stringify(value ?? null)})`);
      }
      args.out = value;
      i++;
    }
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function atomicWrite(file, content) {
  atomicWriteFileSync(file, content);
}

/**
 * Closed status set (docs/plans/symbol-index-pipeline-reliability-hardening.md
 * Theme 2), mirroring `GRAPH_STATUS`'s "unknown is NOT a synonym for
 * verified/green" doctrine — a missing/non-finite score must never read as
 * GREEN via silent coercion.
 */
const DRIFT_STATUS = Object.freeze({ GREEN: 'GREEN', AMBER: 'AMBER', RED: 'RED', UNKNOWN: 'UNKNOWN' });

function classify(driftScore, threshold) {
  if (driftScore <= threshold * 0.5) return DRIFT_STATUS.GREEN;
  if (driftScore <= threshold) return DRIFT_STATUS.AMBER;
  return DRIFT_STATUS.RED;
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
    // No `commitSha` — renderDriftIssue already renders `refreshId`
    // separately (`Commit: ${commitSha||'unknown'}   refresh_id:
    // ${refreshId||'unknown'}`); passing the refresh UUID as `commitSha`
    // too mislabeled it as a git commit (round-1 H5).
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
  // Deliberately stricter than the old `Number(x) || 0` (round-1 H8):
  // drift.score is a genuine JS number here (traced end-to-end through the
  // drift_score RPC's jsonb_build_object serialization and pg's JSONB
  // auto-parse, round-2 H3 rebuttal) — a non-finite value is a real
  // data-integrity anomaly worth surfacing as UNKNOWN, never silently
  // coerced to 0 (which reads as GREEN). `status = classify(...)` is
  // computed as a plain value, never an early `return` — this line sits
  // inside main() itself, and an early return here would skip the
  // markdown render + stdout emission entirely (round-3 H1's real bug).
  const status = Number.isFinite(drift.score) ? classify(drift.score, threshold) : DRIFT_STATUS.UNKNOWN;

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
      const [symbols, totalCount] = await Promise.all([
        listSymbolsForSnapshot({ refreshId: snap.refreshId, limit: 10000 }),
        countSymbolsForSnapshot({ refreshId: snap.refreshId }),
      ]);
      const capped = totalCount > 10000;
      if (capped) {
        process.stderr.write(`arch:drift: showing 10000 of ${totalCount} symbols in this cluster analysis (capped)\n`);
      }
      // Gemini final-gate finding (round 1): this candidate pool feeds
      // pragma reconciliation below, NOT the rendered drift score/cluster
      // body — a cap here risks false "unresolved pragma" warnings for
      // symbols outside the capped pool, so skip the reconciliation
      // entirely rather than report a misleading partial result.
      if (capped) {
        ambiguousUnresolvedSection = `\n## Unresolved suppression pragmas — skipped (LOW — capped snapshot)\n\n` +
          `This snapshot has ${totalCount} symbols, over the 10000-row candidate-pool cap; pragma reconciliation was skipped rather than risk false "unresolved" warnings for symbols outside the capped pool.\n`;
      } else {
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
    }
  } catch (err) {
    process.stderr.write(`arch:drift: pragma reconciliation skipped: ${err.message}\n`);
  }

  const md = renderMarkdownViaShared(drift, threshold, status, identity, clusters) + excludedNote + renderStalePragmaSection(stalePragmas) + ambiguousUnresolvedSection;

  if (args.json) process.stdout.write(JSON.stringify({ drift, threshold, status, stalePragmas }, null, 2) + '\n');
  else process.stdout.write(md);

  // round-1 M1: an unwritable --out path (bad dir, full disk, permissions)
  // must not read the same as an ordinary RED/AMBER/GREEN result — the
  // report was already generated correctly (stdout above already has it);
  // only its on-disk persistence failed. Caught here (not left to the
  // top-level main().catch) so that distinction is visible in the message,
  // not collapsed into a generic fatal.
  let outWriteFailed = false;
  if (args.out) {
    try {
      atomicWrite(args.out, md);
    } catch (err) {
      outWriteFailed = true;
      process.stderr.write(`arch:drift: report generated but writing --out file ${args.out} failed: ${err.message}\n`);
    }
  }

  process.stderr.write(`arch:drift: status=${status} score=${drift.score}/${threshold}\n`);
  // `process.exitCode` (not `process.exit()`) — avoids truncating the
  // stdout write above before the event loop flushes it on a piped stdout
  // (D3). Exit-code contract: UNKNOWN behaves exactly like GREEN/AMBER (0)
  // — it is reported, never gating; only RED is non-zero. A failed --out
  // write is an infra-level failure (mirrors the RPC-failure exit(2)
  // convention above) and takes precedence over the status-driven code.
  process.exitCode = outWriteFailed ? 2 : (status === DRIFT_STATUS.RED ? 1 : 0);
}

export const _internals = { atomicWrite, parseArgs };

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  main().catch(err => {
    process.stderr.write(`arch:drift: fatal: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
