#!/usr/bin/env node
/**
 * @fileoverview Phase B.4 — refresh orchestrator.
 *
 * Pipeline:
 *   1. resolve repo identity (lib/repo-identity.mjs)
 *   2. open refresh_run row (acquires the per-repo running lock)
 *   3. enumerate files based on mode:
 *        - full: walk all repo source files
 *        - incremental: `git diff --name-status <since>` UNION
 *                        `git ls-files --others --exclude-standard`
 *          (Gemini G1 — no `..HEAD`; /ship runs before commit)
 *   4. extract symbols (ts-morph) + layering violations (dep-cruiser)
 *   5. summarise (Haiku) + embed (Gemini, concrete model id resolved once)
 *   6. upsert symbol_definitions (returns definition id map)
 *   7. upsert symbol_index rows under refresh_id
 *   8. upsert symbol_embeddings rows (keyed on definition_id)
 *   9. upsert symbol_layering_violations under refresh_id
 *  10. heartbeat throughout; check refresh_runs.status before publish
 *  11. publishRefreshRun (atomic via Postgres RPC)
 *
 * On any failure: refresh_run is aborted, active_refresh_id unchanged.
 *
 * @module scripts/symbol-index/refresh
 */

import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {
  initLearningStore,
  isCloudEnabled,
  upsertRepoByUuid,
  getRepoIdByUuid,
  openRefreshRun,
  publishRefreshRun,
  abortRefreshRun,
  heartbeatRefreshRun,
  recordSymbolDefinitions,
  recordSymbolIndex,
  recordSymbolEmbedding,
  recordLayeringViolations,
  recordSymbolFileImports,
  copyForwardImports,
  markImportGraphPopulated,
  getImportGraphPopulated,
  setActiveEmbeddingModel,
  copyForwardUntouchedFiles,
  getActiveSnapshot,
  getRefreshRun,
  findStaleRunningRefresh,
} from '../learning-store.mjs';
import { resolveRepoIdentity, persistRepoIdentity } from '../lib/repo-identity.mjs';
import { resolveModel } from '../lib/model-resolver.mjs';
import { symbolIndexConfig } from '../lib/config.mjs';
import { detectRepoStack } from '../lib/repo-stack.mjs';
import { tagDomain, loadDomainRules } from '../lib/symbol-index/domain-tagger.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';

function parseArgs(argv) {
  const args = { full: false, sinceCommit: null, force: false, includeDelegates: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--since-commit') args.sinceCommit = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--include-delegates') args.includeDelegates = true;
  }
  return args;
}

function logErr(s) { process.stderr.write(`  [refresh] ${s}\n`); }
function logOk(s) { process.stderr.write(`  [refresh] ${s}\n`); }

function gitCommitSha(cwd) {
  try { return execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

/**
 * Validate that `sinceCommit` is a safe git revision spec — defends against
 * command injection (R1 audit H6/H11). Allows: 40-char SHA prefix (4+ chars),
 * `HEAD` / `HEAD~N`, `@{upstream}`, `origin/<branch>`, plain branch/tag names.
 * Rejects anything containing shell metacharacters.
 */
function isSafeGitRevision(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 200) return false;
  // Strict allowlist — no spaces, no shell metas, no path-traversal.
  // First char MUST NOT be `-` so a malformed/malicious arg like
  // `--output=/path` cannot be passed through as a git argument and
  // interpreted as a flag (git would otherwise treat any leading-`-`
  // string as an option, not a revspec).
  return /^[A-Za-z0-9._\/@{}~^][A-Za-z0-9._\/@{}~^-]*$/.test(s);
}

/**
 * Working-tree-aware diff (Gemini G1): include uncommitted + untracked.
 * Returns categorised file lists.
 *
 * Uses spawnSync with explicit args (no shell interpretation) — `sinceCommit`
 * is also pre-validated against `isSafeGitRevision` (R1 audit H6/H11).
 */
function gitDiffWithWorkingTree(cwd, sinceCommit) {
  const out = { added: [], modified: [], deleted: [], renamed: [], untracked: [] };
  if (sinceCommit) {
    if (!isSafeGitRevision(sinceCommit)) {
      logErr(`refusing unsafe --since-commit: ${JSON.stringify(sinceCommit).slice(0, 80)}`);
      return out;
    }
    const r = spawnSync('git', ['diff', '--name-status', sinceCommit], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) {
      for (const line of (r.stdout || '').split('\n')) {
        const m = line.match(/^([AMDR])\d*\s+(.+?)(?:\s+(.+))?$/);
        if (!m) continue;
        if (m[1] === 'A') out.added.push(m[2]);
        else if (m[1] === 'M') out.modified.push(m[2]);
        else if (m[1] === 'D') out.deleted.push(m[2]);
        else if (m[1] === 'R') out.renamed.push({ from: m[2], to: m[3] });
      }
    } else {
      logErr(`git diff failed (exit ${r.status}): ${(r.stderr || '').slice(0, 200)}`);
    }
  }
  const ls = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (ls.status === 0) {
    for (const line of (ls.stdout || '').split('\n')) {
      const t = line.trim();
      if (t) out.untracked.push(t);
    }
  }
  return out;
}

/**
 * Run a child process and capture its JSON-line stdout.
 * @returns {object[]}
 */
function runJsonLines(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    input: opts.input || undefined,
    stdio: ['pipe', 'pipe', 'inherit'],
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 100,
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
  }
  return r.stdout.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

async function runWithHeartbeat(refreshId, intervalMs, fn) {
  let alive = true;
  const beat = setInterval(() => {
    heartbeatRefreshRun({ refreshId }).catch(() => { /* ignore */ });
  }, intervalMs);
  try { return await fn(); }
  finally { alive = false; clearInterval(beat); }
}

async function main() {
  assertRepoRoot(import.meta.url);
  const args = parseArgs(process.argv);
  const repoRoot = path.resolve(process.cwd());
  const domainRules = loadDomainRules(repoRoot);
  if (domainRules.length === 0) {
    process.stderr.write(`  [refresh] no domain rules found at .audit-loop/domain-map.json — symbols will all tag as _other\n`);
  } else {
    process.stderr.write(`  [refresh] loaded ${domainRules.length} domain rules from .audit-loop/domain-map.json\n`);
  }
  await initLearningStore();

  if (!isCloudEnabled()) {
    process.stderr.write(`architectural-memory: cloud disabled — skipping refresh\n`);
    process.stdout.write(JSON.stringify({ ok: true, cloud: false, skipped: true, reason: 'cloud-disabled' }) + '\n');
    process.exit(0);
  }

  // Stack short-circuit: JS/TS only in v1
  const { stack } = detectRepoStack(repoRoot);
  if (stack !== 'js-ts' && stack !== 'mixed') {
    process.stderr.write(`architectural-memory: ${stack === 'python' ? 'Python' : stack} extraction not yet supported (stack=${stack} detected)\n`);
    process.stdout.write(JSON.stringify({ ok: true, cloud: true, skipped: true, reason: 'unsupported-stack', stack }) + '\n');
    process.exit(0);
  }

  // 1. Resolve identity
  const identity = resolveRepoIdentity(repoRoot);
  persistRepoIdentity(identity.repoUuid, repoRoot);

  // 2. Resolve embedding model NOW (per Gemini G2: persist concrete id)
  const concreteEmbedModel = resolveModel(symbolIndexConfig.embedModel);
  const embedDim = symbolIndexConfig.embedDim;

  // 3. Upsert repo + open refresh_run
  const repo = await upsertRepoByUuid({ repoUuid: identity.repoUuid, name: identity.name });
  if (!repo) {
    logErr('upsertRepoByUuid returned null — aborting');
    process.exit(1);
  }
  const repoId = repo.id;

  let mode = args.full ? 'full' : 'incremental';
  let walkStartCommit = gitCommitSha(repoRoot);
  let sinceCommit = args.sinceCommit;

  // R1 audit M7: when running incremental WITHOUT an explicit --since-commit,
  // derive the anchor from the prior active snapshot. If no prior snapshot
  // exists yet (first refresh ever for this repo), promote to full mode
  // automatically rather than running a "no diff" loop that still walks the
  // whole repo and re-embeds everything.
  if (mode === 'incremental' && !sinceCommit) {
    const prior = await getActiveSnapshot(repoId);
    if (prior?.refreshId) {
      // Look up the prior run's walk commit so we have a concrete anchor.
      // Best-effort — if the lookup fails we fall through to full mode below.
      try {
        const priorRun = await getRefreshRun(prior.refreshId, {
          select: ['walk_start_commit', 'walk_end_commit'],
        });
        sinceCommit = priorRun?.walk_end_commit || priorRun?.walk_start_commit || null;
      } catch { /* fall through */ }
    }
    if (!sinceCommit) {
      logOk(`no prior snapshot anchor — promoting to --full for this run`);
      mode = 'full';
    }
  }

  let refreshId, cancellationToken;
  try {
    const opened = await openRefreshRun({ repoId, mode, walkStartCommit });
    refreshId = opened.refreshId;
    cancellationToken = opened.cancellationToken;
  } catch (err) {
    if (err.code === 'REFRESH_IN_FLIGHT' && !args.force) {
      logErr(err.message);
      process.exit(2);
    }
    if (err.code === 'REFRESH_IN_FLIGHT' && args.force) {
      // Abort the prior in-flight run, then retry openRefreshRun.
      // Partial-unique index on (repo_id, status='running') guarantees at
      // most one row to clear. The aborted worker's heartbeat loop exits
      // cleanly when it observes status!='running'.
      logOk(`--force: aborting prior in-flight refresh for repo ${repoId}`);
      try {
        const stale = await findStaleRunningRefresh(repoId);
        if (stale) {
          await abortRefreshRun({ refreshId: stale.id, reason: 'aborted by --force' });
          logOk(`--force: aborted refresh_run ${stale.id}`);
        } else {
          logOk(`--force: no in-flight row found, retrying openRefreshRun`);
        }
      } catch (abortErr) {
        logErr(`--force: failed to abort prior run: ${abortErr.message}`);
        process.exit(2);
      }
      const opened = await openRefreshRun({ repoId, mode, walkStartCommit });
      refreshId = opened.refreshId;
      cancellationToken = opened.cancellationToken;
    } else {
      throw err;
    }
  }
  logOk(`opened refresh_run ${refreshId} (mode=${mode})`);

  try {
    await runWithHeartbeat(refreshId, 15_000, async () => {
      // 4. Enumerate files
      let restrictFiles = null;
      let touchedSet = null;
      if (mode === 'incremental' && sinceCommit) {
        const diff = gitDiffWithWorkingTree(repoRoot, sinceCommit);
        const fileList = [
          ...diff.added,
          ...diff.modified,
          ...diff.untracked,
          ...diff.renamed.map(r => r.to),
        ];
        restrictFiles = fileList;
        touchedSet = new Set([
          ...fileList,
          ...diff.deleted,
          ...diff.renamed.map(r => r.from),
        ]);
        logOk(`incremental: ${fileList.length} touched files (since ${sinceCommit})`);
      }

      // 5. (R1 H4 fix) — active_embedding_model + dim are now passed to the
      //     publish RPC and set atomically with active_refresh_id. We no
      //     longer write them to the repo here, where an abort downstream
      //     would leave repo metadata pointing at a model whose embeddings
      //     never landed.

      // 6. Run extract → summarise → embed pipeline
      const extractArgs = ['scripts/symbol-index/extract.mjs', '--root', repoRoot, '--mode', mode];
      if (restrictFiles && restrictFiles.length > 0) {
        extractArgs.push('--files', restrictFiles.join(','));
      }
      if (args.includeDelegates) {
        extractArgs.push('--include-delegates');
        logOk('WARNING: --include-delegates is a debug/visibility flag. Index will include thin-facade duplicates; do NOT publish this snapshot as a normal baseline. Re-run without the flag for standard operations.');
      }
      logOk(`extracting symbols...`);
      const extracted = runJsonLines('node', extractArgs);
      const symbolsRaw = extracted.filter(r => r.type === 'symbol');
      const violations = extracted.filter(r => r.type === 'violation');
      const importEdges = extracted.filter(r => r.type === 'import');
      logOk(`extracted ${symbolsRaw.length} symbols, ${violations.length} violations, ${importEdges.length} internal import edges`);

      // 7. Summarise (only non-redacted)
      logOk(`summarising...`);
      const summarised = runJsonLines('node', ['scripts/symbol-index/summarise.mjs'], {
        input: symbolsRaw.map(r => JSON.stringify(r)).join('\n') + '\n',
      });
      const summarisedSymbols = summarised.filter(r => r.type === 'symbol');

      // 8. Embed
      logOk(`embedding (model=${concreteEmbedModel})...`);
      const embedded = runJsonLines('node', ['scripts/symbol-index/embed.mjs'], {
        input: summarisedSymbols.map(r => JSON.stringify(r)).join('\n') + '\n',
        env: { ARCH_INDEX_EMBED_CONCRETE: concreteEmbedModel },
      });
      const finalSymbols = embedded.filter(r => r.type === 'symbol');

      // 9. Upsert definitions, get id map
      const defs = finalSymbols.map(s => ({
        canonicalPath: s.filePath,
        symbolName: s.symbolName,
        kind: s.kind,
      }));
      const defMap = await recordSymbolDefinitions(repoId, defs);

      // 10. Upsert symbol_index rows
      const indexRows = finalSymbols.map(s => ({
        definitionId: defMap[`${s.filePath}|${s.symbolName}|${s.kind}`],
        filePath: s.filePath,
        startLine: s.startLine,
        endLine: s.endLine,
        signatureHash: s.signatureHash,
        purposeSummary: s.purposeSummary,
        domainTag: tagDomain(s.filePath, domainRules),
      })).filter(r => r.definitionId);
      await recordSymbolIndex(refreshId, repoId, indexRows);

      // 11. Upsert embeddings (keyed on definition_id per R3 H8)
      let embeddedCount = 0;
      for (const s of finalSymbols) {
        if (!s.embedding) continue;
        const definitionId = defMap[`${s.filePath}|${s.symbolName}|${s.kind}`];
        if (!definitionId) continue;
        await recordSymbolEmbedding({
          definitionId,
          embeddingModel: concreteEmbedModel,
          dimension: s.embeddingDim,
          vector: s.embedding,
          signatureHash: s.signatureHash,
        });
        embeddedCount++;
      }

      // 12. Upsert layering violations (always full repo per R2 H8)
      await recordLayeringViolations(refreshId, repoId, violations);

      // 12b. Persist file-level import edges for "Where used" + /explain
      // (Plan §2.6). Edges are filtered to internal modules in extract.mjs
      // (Gemini-R1-G3 / Gemini-R2-G1) so we never persist node_modules
      // or core-module edges.
      if (importEdges.length > 0) {
        const r = await recordSymbolFileImports(
          refreshId,
          importEdges.map(e => ({ importer: e.importer, imported: e.imported })),
        );
        logOk(`recorded ${r.inserted} file-import edges`);
      }

      // 13. Incremental: copy-forward untouched-file symbols + imports
      // from prior snapshot. Symbol copy-forward already proven; imports
      // copy-forward keys on importer_path (R1-H1) so dropped edges from
      // touched files correctly disappear.
      let priorImportGraphPopulated = false;
      if (mode === 'incremental' && touchedSet) {
        const prior = await getActiveSnapshot(repoId);
        if (prior?.refreshId) {
          const copied = await copyForwardUntouchedFiles({
            repoId,
            fromRefreshId: prior.refreshId,
            toRefreshId: refreshId,
            touchedFileSet: touchedSet,
            // Re-apply current domain rules to copied rows so domain-map.json
            // edits take effect on incremental refresh, not just full rebuild.
            retagDomain: domainRules.length > 0 ? (filePath => tagDomain(filePath, domainRules)) : null,
          });
          logOk(`copy-forward ${copied} untouched-file symbols from ${prior.refreshId}`);
          // Also carry forward the import edges
          const imp = await copyForwardImports({
            fromRefreshId: prior.refreshId,
            toRefreshId: refreshId,
            touchedFileSet: touchedSet,
          });
          if (imp.copied > 0) logOk(`copy-forward ${imp.copied} untouched-file import edges`);
          priorImportGraphPopulated = await getImportGraphPopulated(prior.refreshId);
        }
      }

      // 13b. Chain-of-trust for import_graph_populated (Plan §2.6.1, R2-H1):
      //   - Full refresh → true (every file re-extracted)
      //   - Incremental from populated → true (carry-forward + new edges = full)
      //   - Incremental from un-populated → false (untouched files have no edges)
      const populated = (mode === 'full') || (mode === 'incremental' && priorImportGraphPopulated);
      if (populated) {
        await markImportGraphPopulated(refreshId);
        logOk(`import_graph_populated=true (mode=${mode}, prior=${priorImportGraphPopulated})`);
      } else {
        logOk(`import_graph_populated=false (mode=${mode}, prior=${priorImportGraphPopulated}); run \`npm run arch:refresh:full\` to flip`);
      }

      // 14. Atomic publish (server-side RPC per Gemini G1).
      // R1 H4: active_embedding_model + dim are set INSIDE this RPC, in the
      // same transaction as active_refresh_id, so an abort cannot leave repo
      // metadata pointing at an unpublished model.
      await publishRefreshRun({
        repoId,
        refreshId,
        activeEmbeddingModel: concreteEmbedModel,
        activeEmbeddingDim: embedDim,
      });
      logOk(`published refresh ${refreshId} as active`);

      process.stdout.write(JSON.stringify({
        ok: true,
        cloud: true,
        repoId,
        refreshId,
        mode,
        counts: {
          symbols: finalSymbols.length,
          embedded: embeddedCount,
          violations: violations.length,
        },
        embeddingModel: concreteEmbedModel,
        embeddingDim: embedDim,
      }) + '\n');
    });
  } catch (err) {
    logErr(`refresh failed: ${err.message}`);
    try { await abortRefreshRun({ refreshId, reason: err.message }); } catch { /* best-effort */ }
    process.stdout.write(JSON.stringify({ ok: false, error: { code: err.code || 'EXCEPTION', message: err.message } }) + '\n');
    process.exit(2);
  }
}

main().catch(err => {
  process.stderr.write(`refresh: fatal: ${err.stack || err.message}\n`);
  process.exit(2);
});
