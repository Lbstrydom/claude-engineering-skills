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

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as vcs from '../lib/vcs.mjs';
import { runJsonLinesAsyncStrict, SUBPROC_ERROR_CODES } from '../lib/subprocess.mjs';
import { filterDiffFiles, formatSkipLog } from '../lib/sensitive-paths.mjs';
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
  recordDuplicateJustifications,
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
import { resolveEmbedProfile } from '../lib/embed-text.mjs';
import { symbolIndexConfig } from '../lib/config.mjs';
import { detectRepoStack } from '../lib/repo-stack.mjs';
import { tagDomain, loadDomainRules, loadCoverageConfig } from '../lib/symbol-index/domain-tagger.mjs';
import { graphVerdict } from '../lib/symbol-index/graph-verdict.mjs';
import { assessExtractionCoverage } from '../lib/symbol-index/graph-coverage.mjs';
import { recordGraphCoverage, copyForwardCoverage } from '../lib/store/arch/coverage.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';
import { findRepoPragmas, resolvePragmasToDefinitions, PRAGMA_RESOLUTION_MAX_GAP_LINES } from '../lib/duplicate-justification-pragma.mjs';

// Resolve sibling pipeline scripts (extract/summarise/embed) relative to THIS
// file, not the cwd. The cwd-relative form ('scripts/symbol-index/extract.mjs')
// only exists in the source repo; in a consumer the tooling lives under
// scripts/.claude-skills/symbol-index/, so a cwd-relative spawn was a silent
// MODULE_NOT_FOUND there. refresh.mjs and its pipeline scripts are always
// siblings, so import.meta.dirname is correct in both layouts.
const sibling = (name) => path.join(import.meta.dirname, name);

/**
 * D3/H4 promotion predicate — pure + exported for tests. An incremental refresh
 * re-embeds only touched files but publishes new provenance unconditionally, so
 * when the vector-space identity we're about to publish differs from the prior
 * active snapshot's, an incremental run would leave a MIXED index. Promote to a
 * full re-embed in that case. Only a REAL prior identity triggers it (a first-ever
 * refresh with no prior is handled by the existing anchor-less promotion).
 *
 * @param {{activeEmbeddingModel?: string|null}|null|undefined} prior
 * @param {string} nextProvenanceId
 * @returns {boolean}
 */
export function provenanceRequiresFullReembed(prior, nextProvenanceId) {
  return Boolean(prior?.activeEmbeddingModel) && prior.activeEmbeddingModel !== nextProvenanceId;
}

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

/**
 * Throw a tagged Error so the outer `main()` try/catch can abort the
 * in-flight refresh_run BEFORE exiting. The catch block in `main()`
 * inspects `err.vcsCode` to look up the exit code via `vcs.exitCodeFor`
 * — direct `process.exit()` here would skip `abortRefreshRun`, leaving
 * the row stuck in `running` and the per-repo lock held (R1-audit H10).
 *
 * @param {{code: string, message: string, cause?: Error}} err
 */
function throwVcsError(err) {
  const e = new Error(`vcs failure: ${err.code} — ${err.message}`);
  e.code = 'VCS_FAILURE';
  e.vcsCode = err.code;
  e.vcsMessage = err.message;
  if (err.cause) e.cause = err.cause;
  throw e;
}

// Subprocess driver moved to scripts/lib/subprocess.mjs (WS-LIVE).
// The async streaming runner restores `runWithHeartbeat` liveness during
// the multi-minute extract → summarise → embed pipeline; `spawnSync` here
// previously blocked the event loop, silencing heartbeats for the entire
// duration. The strict wrapper hard-fails on malformed JSON (silent
// `.filter(Boolean)` data loss was a documented invariant violation —
// see docs/plans/liveness-and-canonical-paths.md cluster A).

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
  const coverageConfig = loadCoverageConfig(repoRoot);
  if (domainRules.length === 0) {
    process.stderr.write(`  [refresh] no domain rules found at .audit-loop/domain-map.json — symbols will all tag as _other\n`);
  } else {
    process.stderr.write(`  [refresh] loaded ${domainRules.length} domain rules from .audit-loop/domain-map.json\n`);
  }
  await initLearningStore();

  if (!await isCloudEnabled()) {
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

  // 2. Resolve embedding model NOW (per Gemini G2: persist concrete id).
  //    The ONE shared profile (embed-text.mjs) — the same resolver embed.mjs uses,
  //    so what we PUBLISH as provenance can never disagree with what made the
  //    vectors (D2/H3). `provenanceId` is endpoint-qualified under Azure (H8).
  const concreteEmbedModel = resolveModel(symbolIndexConfig.embedModel);
  const embedProfile = resolveEmbedProfile({ concreteModel: concreteEmbedModel });
  const embedDim = symbolIndexConfig.embedDim;

  // 3. Upsert repo + open refresh_run
  const repo = await upsertRepoByUuid({ repoUuid: identity.repoUuid, name: identity.name });
  if (!repo) {
    logErr('upsertRepoByUuid returned null — aborting');
    process.exit(1);
  }
  const repoId = repo.id;

  let mode = args.full ? 'full' : 'incremental';
  // `walkStartCommit` is informational — the snapshot can publish without it.
  // A `!sha.ok` result is NOT fatal here (terminal failures like missing-git
  // or not-a-repo surface later when we try to read the diff). Empty repos
  // (no commits yet → BAD_REVISION) are also tolerated so a brand-new repo
  // can publish its first snapshot.
  const shaResult = vcs.gitCommitSha(repoRoot);
  let walkStartCommit = shaResult.ok ? shaResult.sha : null;
  let sinceCommit = args.sinceCommit;

  // NOTE: the incremental-vs-full decision (anchor derivation + the D3/H4
  // provenance-change safety gate) is deliberately made AFTER openRefreshRun
  // below — see the "Finalize scope under the running lock (H4)" block. Reading
  // the prior snapshot here, BEFORE the lock, would let a concurrent refresh
  // publish between the read and the lock and leave the decision acting on a
  // stale snapshot. `walkStartCommit` is lock-independent, so it stays here.

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
  logOk(`opened refresh_run ${refreshId} (requested mode=${mode})`);

  // Finalize scope UNDER the running lock (H4). openRefreshRun holds the
  // per-repo running lock (partial-unique on status='running'), so from here
  // getActiveSnapshot reflects the last COMPLETED publish and cannot be
  // superseded by a concurrent refresh mid-decision — closing the stale-read
  // race. The decision can only ESCALATE incremental→full (the safe direction);
  // the row's recorded mode stays the user's request, the log records escalation.
  if (mode === 'incremental') {
    const prior = await getActiveSnapshot(repoId);
    // Provenance-change guard (D3/H4): an incremental run re-embeds only touched
    // files but publishes new provenance unconditionally. If the identity we're
    // about to publish differs from the prior snapshot's, an incremental run
    // would leave a MIXED index — touched symbols in the new space, untouched in
    // the old — that the read-side guard can't catch (the published id would
    // "match"). Force a full re-embed whenever provenance changes.
    if (provenanceRequiresFullReembed(prior, embedProfile.provenanceId)) {
      logOk(
        `embedding provenance changed (${prior.activeEmbeddingModel} → ${embedProfile.provenanceId}) ` +
        `— promoting to --full to avoid a mixed vector space`,
      );
      mode = 'full';
    } else if (!sinceCommit) {
      // R1 audit M7: derive the incremental anchor from the prior snapshot; no
      // usable anchor ⇒ promote to full rather than walk the whole repo as a
      // "no diff" incremental.
      if (prior?.refreshId) {
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
  }

  try {
    await runWithHeartbeat(refreshId, 15_000, async () => {
      // 4. Enumerate files
      let restrictFiles = null;
      let touchedSet = null;
      if (mode === 'incremental' && sinceCommit) {
        const diffResult = vcs.gitDiffWithWorkingTree(repoRoot, sinceCommit);
        if (!diffResult.ok) {
          throwVcsError(diffResult.error);
        }
        // State-aware filter: sensitive `modified` → rewritten as `deleted`
        // so the indexer tombstones prior rows; sensitive `deleted` is
        // preserved as tombstone. See sensitive-paths.mjs filterDiffFiles.
        const { diff, skipped } = filterDiffFiles(diffResult.files, ['sensitive', 'generatedNoise']);
        for (const line of formatSkipLog(skipped, { logger: 'refresh' })) {
          process.stderr.write(`  ${line}\n`);
        }
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
      const extractArgs = [sibling('extract.mjs'), '--root', repoRoot, '--mode', mode];
      // Hand the touched-file list to extract via a temp manifest (--files-from)
      // rather than a `--files <comma-joined>` argv. A large incremental
      // changeset (1600+ files on Windows) overflows the OS command-line limit
      // → `spawn ENAMETOOLONG`. The manifest is newline-delimited (safe for any
      // filename) and removed in the finally below.
      let filesManifest = null;
      if (restrictFiles && restrictFiles.length > 0) {
        filesManifest = path.join(os.tmpdir(), `arch-refresh-files-${process.pid}-${Date.now()}.txt`);
        fs.writeFileSync(filesManifest, restrictFiles.join('\n') + '\n', 'utf-8');
        extractArgs.push('--files-from', filesManifest);
      }
      if (args.includeDelegates) {
        extractArgs.push('--include-delegates');
        logOk('WARNING: --include-delegates is a debug/visibility flag. Index will include thin-facade duplicates; do NOT publish this snapshot as a normal baseline. Re-run without the flag for standard operations.');
      }
      logOk(`extracting symbols...`);
      let extracted;
      // A timeout here is a DEGRADED MEASUREMENT, not a failed refresh: the
      // symbol index is independently valuable (#16), so we synthesise the
      // coverage record and continue. Any OTHER abnormal death keeps today's
      // failure behaviour — an unexplained kill is still an error. The child
      // cannot report its own death, which is exactly why the parent owns this
      // (§2.1.8); a timer inside a child wedged in synchronous cruise work
      // could never fire.
      let extractionTimedOut = false;
      try {
        extracted = await runJsonLinesAsyncStrict('node', extractArgs, {
          stage: 'extract',
          timeoutMs: coverageConfig.hardTimeoutMs,
        });
      } catch (err) {
        if (err.code === SUBPROC_ERROR_CODES.KILLED_BY_SIGNAL && err.cause?.timedOut) {
          extractionTimedOut = true;
          extracted = err.cause.records || [];
          logOk(`WARNING: extract timed out after ${coverageConfig.hardTimeoutMs}ms — `
            + `coverage will report extraction_timeout; the symbol index still publishes`);
        } else {
          throw err;
        }
      } finally {
        if (filesManifest) {
          try { fs.unlinkSync(filesManifest); } catch { /* best-effort cleanup */ }
        }
      }
      const symbolsRaw = extracted.filter(r => r.type === 'symbol');
      const violations = extracted.filter(r => r.type === 'violation');
      const importEdges = extracted.filter(r => r.type === 'import');
      const coverageLine = extracted.find(r => r.type === 'coverage') || null;
      logOk(`extracted ${symbolsRaw.length} symbols, ${violations.length} violations, ${importEdges.length} internal import edges`);

      // 7. Summarise (only non-redacted)
      logOk(`summarising...`);
      const summarised = await runJsonLinesAsyncStrict('node', [sibling('summarise.mjs')], {
        input: symbolsRaw.map(r => JSON.stringify(r)).join('\n') + '\n',
        stage: 'summarise',
      });
      const summarisedSymbols = summarised.filter(r => r.type === 'symbol');

      // 8. Embed
      logOk(`embedding (model=${concreteEmbedModel})...`);
      const embedded = await runJsonLinesAsyncStrict('node', [sibling('embed.mjs')], {
        input: summarisedSymbols.map(r => JSON.stringify(r)).join('\n') + '\n',
        env: { ARCH_INDEX_EMBED_CONCRETE: concreteEmbedModel },
        stage: 'embed',
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
          // Same endpoint-qualified provenance published as the snapshot's active
          // model, so per-symbol rows and the snapshot never disagree (D2/H8).
          embeddingModel: embedProfile.provenanceId,
          dimension: s.embeddingDim,
          vector: s.embedding,
          signatureHash: s.signatureHash,
        });
        embeddedCount++;
      }

      // 12. Upsert layering violations (always full repo per R2 H8)
      await recordLayeringViolations(refreshId, repoId, violations);

      // 12a. Resolve @duplicate-justification pragmas + persist exclusions
      // (arch-drift-duplication-cleanup) — always full repo, every refresh,
      // mirroring step 12's layering-violations pattern. Candidates are
      // sourced from finalSymbols + defMap (already in memory from steps
      // 9-10) rather than a DB round-trip — the same (filePath, symbolName,
      // kind, startLine) data symbol_index was just written from.
      // round-2 H8 fix: `strict: true` throws on a REAL git failure instead
      // of degrading to []; a failed sweep and a genuinely-empty sweep are
      // NOT interchangeable here — recordDuplicateJustifications always
      // does a full reset-then-reapply, so treating "sweep failed" as
      // "zero pragmas" would silently wipe every already-justified row.
      // Skip the whole write step (leave existing justifications exactly
      // as they were) rather than risk that.
      let repoPragmas;
      try {
        repoPragmas = findRepoPragmas(repoRoot, { strict: true });
      } catch (err) {
        logOk(`WARNING: @duplicate-justification pragma sweep failed (${err.message}) — skipping this refresh's exclusion write entirely, leaving existing justifications untouched rather than risk wiping them.`);
        repoPragmas = null;
      }
      if (repoPragmas !== null) {
        const pragmaCandidates = finalSymbols
          .map((s) => ({
            filePath: s.filePath, symbolName: s.symbolName, kind: s.kind, startLine: s.startLine,
            definitionId: defMap[`${s.filePath}|${s.symbolName}|${s.kind}`],
          }))
          .filter((c) => c.definitionId);
        const { resolved, ambiguous, unresolved } = resolvePragmasToDefinitions(repoPragmas, pragmaCandidates);
        await recordDuplicateJustifications(refreshId, repoId, resolved);
        if (ambiguous.length > 0) {
          logOk(`WARNING: ${ambiguous.length} @duplicate-justification pragma(s) target a declaration already claimed by another pragma — NEITHER is applied (round-5 M5: an ambiguous declaration is never excluded on an unreliable signal) — see stderr detail below.`);
          for (const a of ambiguous) logErr(`  ambiguous pragma: ${a.pragmaFile}:${a.pragmaLine} (definition claimed by multiple pragmas — none applied)`);
        }
        if (unresolved.length > 0) {
          logOk(`WARNING: ${unresolved.length} @duplicate-justification pragma(s) did not resolve to any declaration within ${PRAGMA_RESOLUTION_MAX_GAP_LINES} line(s) — not excluded from the drift score.`);
          for (const u of unresolved) logErr(`  unresolved pragma: ${u.pragmaFile}:${u.pragmaLine}`);
        }
      }

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

      // 12c. Persist the coverage measurement (§2.1.7). Without this the
      // measurement is computed in the extract SUBPROCESS and then dropped on
      // the floor — it is consumed by a DIFFERENT process (render-mermaid.mjs)
      // reading from the DB, so the table IS the route between them.
      //
      // Keyed on the refreshId this run already owns, so coverage can never be
      // attributed to the wrong snapshot. The attribution layer is NOT filled
      // here: those buckets need domain rules applied to persisted edges, which
      // is render's job — this records extraction only, and render merges.
      if (mode === 'full') {
        const extraction = extractionTimedOut
          ? assessExtractionCoverage({
              outcome: 'timedOut', elapsedMs: coverageConfig.hardTimeoutMs,
            })
          : (coverageLine?.extraction ?? null);

        if (extraction) {
          const record = {
            schemaVersion: 1,
            verdict: graphVerdict({ extraction, attribution: null, config: coverageConfig }),
            measuredAt: new Date().toISOString(),
            refreshId,
            stale: false,
            extraction,
            attribution: null,
          };
          const res = await recordGraphCoverage(refreshId, record);
          logOk(`coverage: ${record.verdict.status}`
            + `${record.verdict.reason ? ` (${record.verdict.reason})` : ''}`
            + `${res.recorded ? '' : ` — NOT persisted: ${res.reason}`}`);
        } else {
          // A full run that produced no coverage line is itself a signal —
          // silence here is what the whole feature exists to stop.
          logOk('WARNING: full refresh produced no coverage line; the graph will read `unknown`');
        }
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
          // Coverage is a FULL-RUN measurement (§2.1.3 row 4). An incremental
          // run inherits the NUMBERS for display but never the VERDICT — file
          // content can change (adding edges, making them untagged) while the
          // file LIST stays byte-identical, so any digest-based freshness check
          // would be false comfort. Categorical beats heuristic here.
          const cov = await copyForwardCoverage({
            fromRefreshId: prior.refreshId,
            toRefreshId: refreshId,
          });
          logOk(cov.copied
            ? `copy-forward coverage from ${prior.refreshId} (stale — reports \`unknown\`)`
            : `no prior coverage to copy forward (${cov.reason}); graph reads \`unknown\``);
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
        // Publish the SHARED profile's provenance id (endpoint-qualified under
        // Azure), NOT the bare Gemini-only `concreteEmbedModel` — that stale name
        // was the D2 bug that made every Azure query fail the read-side guard.
        activeEmbeddingModel: embedProfile.provenanceId,
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
        embeddingModel: embedProfile.provenanceId,
        embeddingDim: embedDim,
      }) + '\n');
    });
  } catch (err) {
    // WS-LIVE: stage-tagged subprocess errors get a precise log line
    // (`stage=summarise exit=2`) so the operator knows which pipeline
    // stage failed without grepping. Other errors fall through to the
    // generic message.
    const isSubprocFailure = Object.values(SUBPROC_ERROR_CODES).includes(err.code);
    if (isSubprocFailure) {
      const tags = [
        err.stage ? `stage=${err.stage}` : null,
        err.exitCode != null ? `exit=${err.exitCode}` : null,
        err.signal ? `signal=${err.signal}` : null,
        err.parseErrors ? `parseErrors=${err.parseErrors.length}` : null,
      ].filter(Boolean).join(' ');
      logErr(`pipeline failure: ${tags} — ${err.message}`);
    } else {
      logErr(`refresh failed: ${err.message}`);
    }
    // ALWAYS abort the open refresh_run first so the row leaves `running`
    // state + the per-repo lock is released. Only after that do we exit.
    try { await abortRefreshRun({ refreshId, reason: err.message }); } catch { /* best-effort */ }
    // Structured VCS failures: surface the precise exit code via
    // vcs.exitCodeFor(vcsCode). Everything else exits 2.
    const isVcsFailure = err.code === 'VCS_FAILURE' && typeof err.vcsCode === 'string';
    const exitCode = isVcsFailure ? vcs.exitCodeFor(err.vcsCode) : 2;
    process.stdout.write(JSON.stringify({
      ok: false,
      error: {
        code: isVcsFailure ? err.vcsCode : (err.code || 'EXCEPTION'),
        message: isVcsFailure ? err.vcsMessage : err.message,
        // Surface subprocess detail for CI/operator consumers when applicable.
        ...(isSubprocFailure ? {
          stage: err.stage ?? null,
          exitCode: err.exitCode ?? null,
          signal: err.signal ?? null,
          parseErrorCount: err.parseErrors?.length ?? 0,
        } : {}),
      },
    }) + '\n');
    process.exit(exitCode);
  }
}

// Run as a CLI only — importing this module (e.g. from tests, to exercise the
// pure `provenanceRequiresFullReembed` seam) must NOT kick off the whole pipeline.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  main().catch(err => {
    process.stderr.write(`refresh: fatal: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
