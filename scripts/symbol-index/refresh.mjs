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
 * **File layout (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md,
 * god-module decomposition)**: this file is now a shrunk orchestrator —
 * sequencing plus the deliberately-retained inline persistence/finalization
 * block (steps 8-14: DB upserts, pragma resolution, import-edge persistence,
 * coverage persistence, copy-forward, publish, band calibration — see the
 * plan's Risk Register for why these stay inline, not a pure sequencing
 * shell). The concerns it used to carry inline now live in dedicated
 * siblings: `refresh-args.mjs` (CLI parsing), `refresh-repo-setup.mjs`
 * (identity + registration), `refresh-lock.mjs` (per-repo lock acquisition),
 * `refresh-mode.mjs` (incremental→full mode promotion), `refresh-file-scope.mjs`
 * (VCS scope + sensitive-path filtering), `refresh-subprocess.mjs` (the
 * extract→summarise→embed pipeline + timeout recovery), and `refresh-errors.mjs`
 * (the typed errors the siblings throw and this file's `main()` catches).
 * `logErr`/`logOk` stay here (the injected logging port every sibling takes
 * as an explicit parameter). `runWithHeartbeat` and `persistExtractionCoverage`
 * are untouched by this plan.
 *
 * @module scripts/symbol-index/refresh
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as vcs from '../lib/vcs.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  recordSymbolDefinitions,
  recordSymbolIndex,
  recordSummaryOutcomes,
  recordSymbolEmbeddings,
  recordLayeringViolations,
  recordDuplicateJustifications,
  recordSymbolFileImports,
  copyForwardImports,
  markImportGraphPopulated,
  getImportGraphPopulated,
  recordGraphCoverage,
  copyForwardCoverage,
  copyForwardUntouchedFiles,
  getActiveSnapshot,
  recordBandCalibration,
  sampleSnapshotEmbeddings,
  heartbeatRefreshRun,
  abortRefreshRun,
  publishRefreshRun,
} from '../learning-store.mjs';
import { resolveModel } from '../lib/model-resolver.mjs';
import { resolveEmbedProfile } from '../lib/embed-text.mjs';
import { symbolIndexConfig } from '../lib/config.mjs';
import { detectRepoStack } from '../lib/repo-stack.mjs';
import { tagDomain, loadDomainRules, loadCoverageConfig } from '../lib/symbol-index/domain-tagger.mjs';
import { graphVerdict } from '../lib/symbol-index/graph-verdict.mjs';
import { assessExtractionCoverage } from '../lib/symbol-index/graph-coverage.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';
import { findRepoPragmas, resolvePragmasToDefinitions, PRAGMA_RESOLUTION_MAX_GAP_LINES } from '../lib/duplicate-justification-pragma.mjs';
import { SUBPROC_ERROR_CODES } from '../lib/subprocess.mjs';
import { parseArgs } from './refresh-args.mjs';
import { RepoRegistrationError, RefreshInFlightError, LockAbortError, RefreshAbortedError } from './refresh-errors.mjs';
import { resolveAndRegisterRepo } from './refresh-repo-setup.mjs';
import { resolveWalkStartCommit, acquireRefreshLock } from './refresh-lock.mjs';
import { finalizeRefreshMode } from './refresh-mode.mjs';
import { resolveIncrementalFileScope } from './refresh-file-scope.mjs';
import { runExtractSummariseEmbed } from './refresh-subprocess.mjs';

function logErr(s) { process.stderr.write(`  [refresh] ${s}\n`); }
function logOk(s) { process.stderr.write(`  [refresh] ${s}\n`); }

/**
 * Persist the full-run extraction coverage measurement (§2.1.7). Extracted
 * out of `main()`'s inline block so the coverage-persistence concern this
 * plan already touches (item 7's timeout clamp, the DB-integration test in
 * item 6) has one named, independently readable home instead of living
 * inline in an already-large orchestration function.
 *
 * @param {{mode: string, extractionTimedOut: boolean, coverageConfig: object, coverageLine: object|null, refreshId: string}} args
 */
async function persistExtractionCoverage({ mode, extractionTimedOut, coverageConfig, coverageLine, refreshId }) {
  if (mode !== 'full') return;
  const extraction = extractionTimedOut
    ? assessExtractionCoverage({
        outcome: 'timedOut', elapsedMs: coverageConfig.hardTimeoutMs,
      })
    : (coverageLine?.extraction ?? null);

  if (!extraction) {
    // A full run that produced no coverage line is itself a signal —
    // silence here is what the whole feature exists to stop.
    logOk('WARNING: full refresh produced no coverage line; the graph will read `unknown`');
    return;
  }

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
}

const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 3;   // ~45s at the 15s interval

/**
 * 41bf7af6/812d9d83: a failed heartbeat write used to be silently swallowed
 * after the first stderr line — the refresh continued (correct: a telemetry
 * write failing is not a reason to abort real work already in flight) but
 * the failure itself was invisible to the run's own result, so nothing
 * downstream could ever tell a healthy refresh from one whose liveness
 * signal had gone dark. `fn` now receives a live `heartbeatStatus` object it
 * can fold into its own final output, so the degradation is observable
 * rather than swallowed.
 *
 * ENFORCEMENT (docs/plans/symbol-index-pipeline-reliability-hardening.md
 * Theme 1): the heartbeat used to be purely advisory — nothing ever
 * checked whether the run's own row was still `running`, so a
 * `--force`-aborted refresh kept executing unaware. `fn` now also
 * receives an `AbortSignal`; `main()` checks `signal.aborted` at exactly
 * two points (before the extract/summarise/embed subprocess spawn, and
 * before the atomic publish RPC — the only truly irreversible step). The
 * ACTUAL correctness boundary is server-side (`abortRefreshRun`'s
 * `AND status='running'` guard + `publishRefreshRun`'s own atomic RPC
 * check) — this signal is a cost-saving optimization that skips wasted
 * work early, not the thing that makes the race safe.
 *
 * Ticks are self-scheduling (`setTimeout`, never `setInterval`) so two
 * ticks can never run concurrently, and a `settled` flag closes the race
 * where an in-flight tick observes a stale `false` after `fn()` already
 * resolved. `MAX_CONSECUTIVE_HEARTBEAT_FAILURES` consecutive `beatFn`
 * rejections (e.g. a sustained DB outage) also trigger an abort — a
 * cancellation mechanism that can never get an answer is exactly as dead
 * as one that never checks at all.
 *
 * `beatFn` defaults to the real `heartbeatRefreshRun` and is injectable so
 * tests can simulate a failing heartbeat without mocking module imports
 * (mirrors this repo's adapter-injection convention, e.g.
 * discovery-portfolio.mjs).
 */
async function runWithHeartbeat(refreshId, repoId, intervalMs, fn, beatFn = heartbeatRefreshRun) {
  let consecutiveFailures = 0;
  const controller = new AbortController();
  const heartbeatStatus = { failureCount: 0, lastError: null, aborted: false };
  let settled = false;
  let timer = null;

  async function tick() {
    if (settled) return;
    try {
      const stillRunning = await beatFn({ refreshId, repoId });
      consecutiveFailures = 0;
      if (!settled && !stillRunning && !heartbeatStatus.aborted) {
        heartbeatStatus.aborted = true;
        controller.abort(new RefreshAbortedError(`refresh ${refreshId} force-stopped externally`));
      }
    } catch (err) {
      heartbeatStatus.failureCount++;
      heartbeatStatus.lastError = err.message;
      consecutiveFailures++;
      if (heartbeatStatus.failureCount <= 1) {
        logErr(`heartbeat failed for refresh ${refreshId}: ${err.message} (further failures this run are counted in heartbeatFailures but not logged individually)`);
      }
      if (!settled && consecutiveFailures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES && !heartbeatStatus.aborted) {
        heartbeatStatus.aborted = true;
        controller.abort(new RefreshAbortedError(`refresh ${refreshId}: heartbeat unreachable for ${consecutiveFailures} consecutive ticks`));
      }
    } finally {
      if (!settled) scheduleTick();
    }
  }

  // Wraps the scheduled tick's own promise in a no-op `.catch` (shadow
  // final-gate finding, defensive): `tick()`'s body already catches every
  // realistic failure, but `setTimeout(tick, ...)` alone would leave an
  // unhandled rejection if anything ever threw outside that guarded
  // region — matching this function's own stated invariant that no
  // unhandled rejection is ever raised by the heartbeat loop.
  function scheduleTick() {
    if (settled) return;
    timer = setTimeout(() => { tick().catch(() => {}); }, intervalMs);
  }

  scheduleTick();
  try { return await fn(heartbeatStatus, controller.signal); }
  finally { settled = true; if (timer) clearTimeout(timer); }
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

  let mode = args.full ? 'full' : 'incremental';
  let sinceCommit = args.sinceCommit;
  let refreshId;
  let repoId;   // hoisted (mirrors refreshId) so the catch block can scope its abortRefreshRun call

  try {
    // 1. Resolve identity + register repo.
    ({ repoId } = await resolveAndRegisterRepo(repoRoot));

    // 2. Resolve embedding model NOW (per Gemini G2: persist concrete id).
    //    The ONE shared profile (embed-text.mjs) — the same resolver embed.mjs uses,
    //    so what we PUBLISH as provenance can never disagree with what made the
    //    vectors (D2/H3). `provenanceId` is endpoint-qualified under Azure (H8).
    const concreteEmbedModel = resolveModel(symbolIndexConfig.embedModel);
    const embedProfile = resolveEmbedProfile({ concreteModel: concreteEmbedModel });
    const embedDim = symbolIndexConfig.embedDim;

    // 3. `walkStartCommit` is informational — the snapshot can publish without
    //    it. A `null` result is NOT fatal here (terminal failures like
    //    missing-git or not-a-repo surface later when we try to read the
    //    diff). Empty repos (no commits yet) are also tolerated so a
    //    brand-new repo can publish its first snapshot.
    const walkStartCommit = resolveWalkStartCommit(repoRoot);

    // 4. Acquire the per-repo running lock.
    ({ refreshId } = await acquireRefreshLock({ repoId, mode, walkStartCommit, force: args.force, logOk }));
    logOk(`opened refresh_run ${refreshId} (requested mode=${mode})`);

    // 5. Finalize scope UNDER the running lock (H4). openRefreshRun holds the
    // per-repo running lock (partial-unique on status='running'), so from here
    // getActiveSnapshot reflects the last COMPLETED publish and cannot be
    // superseded by a concurrent refresh mid-decision — closing the stale-read
    // race. Runs BEFORE runWithHeartbeat opens (mode finalization is not
    // itself heartbeat-monitored, only the long-running work after it is).
    const finalized = await finalizeRefreshMode({ mode, sinceCommit, repoId, embedProfile, logOk });
    mode = finalized.mode;
    sinceCommit = finalized.sinceCommit;
    const prior = finalized.prior;

    await runWithHeartbeat(refreshId, repoId, 15_000, async (heartbeatStatus, signal) => {
      // 6. Enumerate files.
      const { restrictFiles, touchedSet: scopeTouchedSet, diffStats } = await resolveIncrementalFileScope({
        mode, repoRoot, sinceCommit, repoId, prior, logOk,
      });
      let touchedSet = scopeTouchedSet;

      // 5. (R1 H4 fix) — active_embedding_model + dim are now passed to the
      //     publish RPC and set atomically with active_refresh_id. We no
      //     longer write them to the repo here, where an abort downstream
      //     would leave repo metadata pointing at a model whose embeddings
      //     never landed.

      // 7. Run extract → summarise → embed pipeline (+ 8b timeout recovery).
      // Cost-saving cancellation checkpoint (Theme 1): skip the most
      // expensive single step entirely if a concurrent --force already
      // aborted this run. The actual correctness guarantee is the DB-level
      // guards on abortRefreshRun/publishRefreshRun, not this check.
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new RefreshAbortedError(`refresh ${refreshId} aborted before extraction`);
      const {
        finalSymbols, violations, importEdges, coverageLine,
        extractionTimedOut, timeoutRecovery, recoveredTouchedSet,
      } = await runExtractSummariseEmbed({
        repoRoot, repoId, mode, restrictFiles,
        includeDelegates: args.includeDelegates, coverageConfig, concreteEmbedModel, logOk,
      });
      // CONDITIONAL rebind, never an unconditional destructure: on every
      // path other than timed-out-full recovery, the step-6 `touchedSet`
      // value passes through completely untouched.
      if (recoveredTouchedSet) touchedSet = recoveredTouchedSet;

      // 9. Upsert definitions, get id map
      const defs = finalSymbols.map(s => ({
        canonicalPath: s.filePath,
        symbolName: s.symbolName,
        kind: s.kind,
      }));
      const defMap = await recordSymbolDefinitions(repoId, defs);

      // 9b. Record summarisation outcomes so the bounded re-queue can converge
      // (plan §2.1 C9). Success RESETS the counter — the contract is
      // "consecutive failures", so a symbol that recovers carries no scar
      // tissue toward the cap. Failure increments and flips `summary_failed`
      // at SUMMARY_RETRY_CAP, after which the symbol stops being retried and
      // stays honestly `unscored` rather than burning a provider call every
      // refresh forever.
      //
      // Runs AFTER recordSymbolDefinitions because it needs definition ids,
      // and is best-effort: a bookkeeping failure must never abort a refresh
      // whose real work already succeeded.
      try {
        const outcomes = finalSymbols
          .map(s => ({
            definitionId: defMap[`${s.filePath}|${s.symbolName}|${s.kind}`],
            ok: typeof s.purposeSummary === 'string' && s.purposeSummary.trim() !== '',
          }))
          .filter(o => o.definitionId);
        const res = await recordSummaryOutcomes(repoId, outcomes);
        if (res.incremented > 0 || res.reset > 0) {
          logOk(
            `summary retry ledger: ${res.reset} reset on success, `
            + `${res.incremented} incremented on failure`
            + (res.nowTerminal ? `, ${res.nowTerminal} now TERMINAL (cap reached — will not be retried)` : ''),
          );
        }
      } catch (err) {
        logOk(`WARNING: summary retry bookkeeping failed (${err.message}) — refresh continues`);
      }

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

      // 11. Upsert embeddings (keyed on definition_id per R3 H8). Batched in
      // one call (chunked internally) rather than one round trip per symbol —
      // the per-row loop this replaced was ~95k individual INSERT..ON
      // CONFLICT statements on a single full refresh, the dominant driver of
      // the project's Disk IO budget (pg_stat_statements, 2026-07-24).
      const embeddingRows = finalSymbols
        .filter((s) => s.embedding)
        .map((s) => ({
          definitionId: defMap[`${s.filePath}|${s.symbolName}|${s.kind}`],
          // Same endpoint-qualified provenance published as the snapshot's active
          // model, so per-symbol rows and the snapshot never disagree (D2/H8).
          embeddingModel: embedProfile.provenanceId,
          dimension: s.embeddingDim,
          vector: s.embedding,
          signatureHash: s.signatureHash,
        }))
        .filter((r) => r.definitionId);
      const embeddedCount = await recordSymbolEmbeddings(embeddingRows);

      // 12. Upsert layering violations (always full repo per R2 H8)
      await recordLayeringViolations(refreshId, repoId, violations);

      // 12a. Resolve @duplicate-justification pragmas + persist exclusions
      // (arch-drift-duplication-cleanup). Candidates are sourced from
      // finalSymbols + defMap (already in memory from steps 9-10) rather
      // than a DB round-trip — the same (filePath, symbolName, kind,
      // startLine) data symbol_index was just written from.
      //
      // SCOPE (corrected): this step is NOT "always full repo". It runs
      // BEFORE step 13's copy-forward, so at this point `refreshId` owns
      // only the touched files' rows — which makes the reset inside
      // recordDuplicateJustifications de-facto touched-scoped too, matching
      // the touched-scoped re-apply. That symmetry is what keeps the
      // `strict: true` skip below meaningful, and it is why the re-apply
      // must NOT be "widened to full repo": untouched rows do not exist
      // yet, so a widened apply would be a no-op, and reordering 12a after
      // step 13 would pair a full-repo reset with a touched-only re-apply
      // and wipe every copied-forward justification. Untouched files keep
      // their flags by being COPIED WITH the duplicate_justification*
      // columns (see copyForwardUntouchedFiles) — a pragma cannot change
      // without touching its own file, so a copied flag is never stale.
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
        // The sweep is full-repo, but the candidate set is scope-limited when
        // `touchedSet` is set — touched files on an incremental, OR the reached
        // files on a timed-out full run (8b). Restricting the pragma set to the
        // same scope keeps the "unresolved" warning below honest: without this,
        // every pragma in a copy-forwarded file would be reported as "not
        // excluded from the drift score" when it is in fact still excluded, via
        // the copy-forward path (which carries its flag). A clean full refresh
        // has `touchedSet === null` → every pragma is resolved with full
        // authority.
        const scopedPragmas = touchedSet
          ? repoPragmas.filter((p) => touchedSet.has(p.pragmaFile))
          : repoPragmas;
        const pragmaCandidates = finalSymbols
          .map((s) => ({
            filePath: s.filePath, symbolName: s.symbolName, kind: s.kind, startLine: s.startLine,
            definitionId: defMap[`${s.filePath}|${s.symbolName}|${s.kind}`],
          }))
          .filter((c) => c.definitionId);
        const { resolved, ambiguous, unresolved } = resolvePragmasToDefinitions(scopedPragmas, pragmaCandidates);
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
      await persistExtractionCoverage({ mode, extractionTimedOut, coverageConfig, coverageLine, refreshId });

      // 13. Incremental: copy-forward untouched-file symbols + imports
      // from prior snapshot. Symbol copy-forward already proven; imports
      // copy-forward keys on importer_path (R1-H1) so dropped edges from
      // touched files correctly disappear.
      // Copy-forward fires for a scope-limited run: an incremental (untouched
      // files) OR a timed-out full run (8b — the un-reached tail). `touchedSet`
      // is non-null in exactly those two cases.
      let priorImportGraphPopulated = false;
      if (touchedSet) {
        // Reuse the prior fetched by the 8b recovery when present, so a timed-out
        // full run does not issue a second getActiveSnapshot.
        const prior = timeoutRecovery?.prior ?? await getActiveSnapshot(repoId);
        // A full run has no git-diff of deletions, so an "un-reached" file and a
        // "deleted since prior" file both look absent from this run's symbols.
        // Gate copy-forward on on-disk existence for the timeout case so a
        // deleted file is not resurrected. Incremental keeps its git-detected
        // deletions in touchedSet and needs no on-disk check (null gate).
        const fileStillExists = timeoutRecovery
          ? (filePath => fs.existsSync(path.join(repoRoot, filePath)))
          : null;
        if (prior?.refreshId) {
          const copied = await copyForwardUntouchedFiles({
            repoId,
            fromRefreshId: prior.refreshId,
            toRefreshId: refreshId,
            touchedFileSet: touchedSet,
            fileStillExists,
            // Re-apply current domain rules to copied rows so domain-map.json
            // edits take effect on incremental refresh, not just full rebuild.
            retagDomain: domainRules.length > 0 ? (filePath => tagDomain(filePath, domainRules)) : null,
          });
          logOk(`copy-forward ${copied} ${timeoutRecovery ? 'un-reached' : 'untouched'}-file symbols from ${prior.refreshId}`);
          // Also carry forward the import edges
          const imp = await copyForwardImports({
            fromRefreshId: prior.refreshId,
            toRefreshId: refreshId,
            touchedFileSet: touchedSet,
            fileStillExists,
          });
          if (imp.copied > 0) logOk(`copy-forward ${imp.copied} ${timeoutRecovery ? 'un-reached' : 'untouched'}-file import edges`);
          // Coverage is a FULL-RUN measurement (§2.1.3 row 4). An incremental
          // run inherits the NUMBERS for display but never the VERDICT — file
          // content can change (adding edges, making them untagged) while the
          // file LIST stays byte-identical, so any digest-based freshness check
          // would be false comfort. Categorical beats heuristic here.
          //
          // A timed-out full run must NOT copy coverage forward: it recorded its
          // own honest `timedOut` verdict at step 12c, and overwriting that with
          // the prior (often `verified`) record would launder a degraded run
          // into a clean-looking one — the exact capture-dishonesty this whole
          // fix exists to remove. Incremental only.
          if (mode === 'incremental') {
            const cov = await copyForwardCoverage({
              fromRefreshId: prior.refreshId,
              toRefreshId: refreshId,
            });
            logOk(cov.copied
              ? `copy-forward coverage from ${prior.refreshId} (stale — reports \`unknown\`)`
              : `no prior coverage to copy forward (${cov.reason}); graph reads \`unknown\``);
          }
          priorImportGraphPopulated = await getImportGraphPopulated(prior.refreshId, repoId);
        }
      }

      // 13b. Chain-of-trust for import_graph_populated (Plan §2.6.1, R2-H1):
      //   - Full refresh → true (every file re-extracted)
      //   - Incremental from populated → true (carry-forward + new edges = full)
      //   - Incremental from un-populated → false (untouched files have no edges)
      const populated = (mode === 'full') || (mode === 'incremental' && priorImportGraphPopulated);
      if (populated) {
        const { populated: didLand } = await markImportGraphPopulated(refreshId, repoId);
        logOk(didLand
          ? `import_graph_populated=true (mode=${mode}, prior=${priorImportGraphPopulated})`
          : `WARNING: import_graph_populated write did not land (mode=${mode}, prior=${priorImportGraphPopulated}) — the flag may now understate what this refresh actually did`);
      } else {
        logOk(`import_graph_populated=false (mode=${mode}, prior=${priorImportGraphPopulated}); run \`npm run arch:refresh:full\` to flip`);
      }

      // 14. Atomic publish (server-side RPC per Gemini G1).
      // R1 H4: active_embedding_model + dim are set INSIDE this RPC, in the
      // same transaction as active_refresh_id, so an abort cannot leave repo
      // metadata pointing at an unpublished model.
      //
      // Correctness-critical cancellation checkpoint (Theme 1): this is the
      // ONE point of no return in the whole pipeline — everything before it
      // is an unpublished, safely-abandonable snapshot. If a concurrent
      // --force raced past this check, publishRefreshRun's own atomic RPC
      // guard (rejects a non-`running` row) still fails it server-side; this
      // check just avoids paying for a doomed publish attempt.
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new RefreshAbortedError(`refresh ${refreshId} aborted before publish`);
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

      // 14b. Log the differential churn for operator visibility. This is the
      // whole observability value of the per-run diff — surfaced live at run
      // time, NOT stored: the old refresh_runs.files_* columns held this same
      // data but nothing ever read them and they duplicated `git diff`, so they
      // were dropped (migration 20260721150000). Only a differential run has a
      // diff; a full rebuild leaves diffStats === null and logs nothing here.
      if (diffStats) {
        logOk(
          `differential churn: added=${diffStats.added.length} modified=${diffStats.modified.length} `
          + `deleted=${diffStats.deleted.length} renamed=${diffStats.renamed.length} untracked=${diffStats.untracked.length}`,
        );
      }

      // 13. Per-repo band calibration (plan §2.1 C4-REVISED).
      //
      // The band floor is computed from THIS repo's own embedding background,
      // never shipped as a constant: config.mjs and symbol-index.mjs both sync
      // to consumers, so a threshold written there would carry our corpus
      // statistics into a repo with different vocabulary and symbol density —
      // the same class of defect as the original unreachable 0.90/0.85/0.75.
      //
      // Runs AFTER publish and samples from the PUBLISHED snapshot, because an
      // incremental refresh only embeds touched files; sampling this run's own
      // output would measure the background of whatever was being edited
      // rather than of the corpus.
      //
      // Best-effort: a calibration failure leaves the repo uncalibrated, which
      // bands `review` only. That is the honest degradation — never a reason to
      // fail a refresh whose real work succeeded.
      try {
        const { computeBackgroundStats, floorFromStats, DEFAULT_K, DEFAULT_SAMPLE_SIZE, CLIFF_REPORTING_THRESHOLD } =
          await import('../lib/arch-memory/background-calibration.mjs');
        const { COMPOSE_VERSION } = await import('../lib/symbol-index.mjs');
        const { NORMALIZE_PROMPT_VERSION } = await import('../lib/arch-memory/normalize-intent.mjs');

        const sample = await sampleSnapshotEmbeddings(refreshId, DEFAULT_SAMPLE_SIZE);
        const stats = computeBackgroundStats(sample);
        const floor = floorFromStats(stats, DEFAULT_K);

        if (floor === null) {
          // Too small / too sparse to characterise. Clear any stale record
          // rather than leave a floor derived from a corpus that no longer
          // exists — a stale floor is worse than none.
          await recordBandCalibration(repoId, null);
          logOk(`band calibration: insufficient sample (${sample.length} vectors) — repo left UNCALIBRATED (bands `
            + `\`review\` only)`);
        } else {
          await recordBandCalibration(repoId, {
            floor,
            k: DEFAULT_K,
            // Reported, not gated — see CLIFF_REPORTING_THRESHOLD. Stored so a
            // reader can tell a tight cluster from a lone standout.
            cliffReportingThreshold: CLIFF_REPORTING_THRESHOLD,
            stats,
            provenance: {
              embedModel: embedProfile.provenanceId,
              embedDim,
              composeVersion: COMPOSE_VERSION,
              normalizePromptVersion: NORMALIZE_PROMPT_VERSION,
              normalizerId: symbolIndexConfig.summariseModel,
              refreshId,
            },
            calibratedAt: new Date().toISOString(),
          });
          logOk(`band calibration: floor=${floor.toFixed(4)} (mu=${stats.mean.toFixed(4)} `
            + `sigma=${stats.sd.toFixed(4)} k=${DEFAULT_K}, ${stats.pairs} pairs from ${stats.n} symbols)`);
        }
      } catch (err) {
        logOk(`WARNING: band calibration failed (${err.message}) — repo stays uncalibrated, refresh stands`);
      }

      // 41bf7af6/812d9d83: surface heartbeat health on the run's own result
      // rather than a stderr line an operator may never see in a long log —
      // `heartbeatFailures: 0` is the common case; a non-zero count means
      // this refresh's liveness signal went dark for at least one beat
      // while the real work (visibly) still completed successfully.
      if (heartbeatStatus.failureCount > 0) {
        logOk(`WARNING: heartbeat failed ${heartbeatStatus.failureCount} time(s) during this refresh (last: ${heartbeatStatus.lastError}) — refresh completed anyway`);
      }
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
        heartbeatFailures: heartbeatStatus.failureCount,
      }) + '\n');
    });
  } catch (err) {
    if (err instanceof RepoRegistrationError) { logErr(err.message); process.exit(1); }
    if (err instanceof RefreshInFlightError) { logErr(err.message); process.exit(2); }
    if (err instanceof LockAbortError) { logErr(err.message); process.exit(2); }
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
    // `repoId` is hoisted above the try so it's available here even when
    // the failure happened before it would otherwise have been assigned —
    // in that case it's still undefined and abortRefreshRun's own
    // repo_id-scoped predicate simply matches 0 rows (logged, not thrown).
    try { await abortRefreshRun({ refreshId, repoId, reason: err.message }); } catch { /* best-effort */ }
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

// Exported for direct test assertion (mirrors this repo's `_internals`
// convention, e.g. transaction.mjs, anthropic-client.mjs).
export const _internals = { runWithHeartbeat };

// Run as a CLI only — importing this module (e.g. from tests) must NOT kick
// off the whole pipeline.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  main().catch(err => {
    process.stderr.write(`refresh: fatal: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
