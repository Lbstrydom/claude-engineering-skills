/**
 * @fileoverview Subprocess execution for `refresh.mjs`: the extract →
 * summarise → embed pipeline, plus 8b timed-out-full recovery.
 *
 * Extracted from `refresh.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/symbol-index/refresh-subprocess
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { runJsonLinesAsyncStrict, SUBPROC_ERROR_CODES } from '../lib/subprocess.mjs';
import { getActiveSnapshot } from '../learning-store.mjs';

// Resolve sibling pipeline scripts (extract/summarise/embed) relative to THIS
// file, not the cwd. The cwd-relative form ('scripts/symbol-index/extract.mjs')
// only exists in the source repo; in a consumer the tooling lives under
// scripts/.claude-skills/symbol-index/, so a cwd-relative spawn was a silent
// MODULE_NOT_FOUND there. refresh-subprocess.mjs and its pipeline scripts are
// always siblings, so import.meta.dirname is correct in both layouts.
const sibling = (name) => path.join(import.meta.dirname, name);

/**
 * Spawn options for the extract subprocess (docs/plans/extract-idle-timeout.md).
 *
 * The extract child streams a `progress` record per file, so a healthy run is
 * never silent for long; the coverage-sized threshold is used as an **idle**
 * (inactivity) bound, NOT a total-duration one, so a slow-but-progressing
 * extraction is never truncated. Pulled out as a pure builder so a test can pin
 * `coverageConfig.hardTimeoutMs → idleTimeoutMs` and fail loudly if a future
 * edit reverts to a total `timeoutMs` (which silently re-opens the truncation
 * defect). Deliberately emits `idleTimeoutMs` and NO `timeoutMs`: an absolute
 * ceiling is a deferred, non-required guard (plan §6) — the child's output is
 * finite, so a "streams forever" runaway cannot occur.
 *
 * @param {{hardTimeoutMs: number}} coverageConfig
 * @returns {{stage: 'extract', idleTimeoutMs: number}}
 */
export function buildExtractSpawnOpts(coverageConfig) {
  return { stage: 'extract', idleTimeoutMs: coverageConfig.hardTimeoutMs };
}

/**
 * Pure gate for the 8b timed-out-full recovery path — returns the exact
 * boolean the 8b `if` condition currently tests, synchronous, no I/O.
 * `runExtractSummariseEmbed` calls this FIRST and only calls
 * `getActiveSnapshot(repoId)` when it returns `true`, matching the source's
 * current behavior of never issuing that DB read otherwise.
 *
 * @param {{mode: string, extractionTimedOut: boolean}} args
 * @returns {boolean}
 */
export function shouldAttemptTimeoutRecovery({ mode, extractionTimedOut }) {
  return mode === 'full' && extractionTimedOut;
}

/**
 * Pure decision for the 8b recovery shape, given the `getActiveSnapshot`
 * result and the reached symbols — reproduces the 8b branch verbatim. No
 * I/O — the DB read already happened in the caller; this function only makes
 * the decision from its RESULT.
 *
 * @param {{priorForRecovery: {refreshId?: string}|null, finalSymbols: Array<{filePath: string}>}} args
 * @returns {{timeoutRecovery: {prior: object}|null, recoveredTouchedSet: Set<string>|null}}
 */
export function buildTimeoutRecovery({ priorForRecovery, finalSymbols }) {
  if (!priorForRecovery?.refreshId) {
    return { timeoutRecovery: null, recoveredTouchedSet: null };
  }
  return {
    timeoutRecovery: { prior: priorForRecovery },
    recoveredTouchedSet: new Set(finalSymbols.map(s => s.filePath)),
  };
}

/**
 * Run the extract → summarise → embed subprocess pipeline (steps 6-8 + 8b).
 *
 * @param {{repoRoot: string, repoId: string, mode: string, restrictFiles: string[]|null, includeDelegates: boolean, coverageConfig: object, concreteEmbedModel: string, logOk: (s: string) => void}} args
 * @returns {Promise<{finalSymbols: Array<object>, violations: Array<object>, importEdges: Array<object>, coverageLine: object|null, extractionTimedOut: boolean, timeoutRecovery: object|null, recoveredTouchedSet: Set<string>|null}>}
 */
/**
 * Write the newline-delimited `--files-from` manifest for a resolved
 * `restrictFiles` scope, or return `null` when there is no restriction at
 * all. Factored out so the two fixes below are directly unit-testable
 * without spawning the real extract/summarise/embed subprocess chain.
 *
 * b021576b: `restrictFiles === null` means "no restriction, full walk";
 * `restrictFiles === []` means "a valid incremental scope of ZERO files"
 * (e.g. a diff touching only docs/config, nothing indexable changed) —
 * these are opposite intents. The old `restrictFiles.length > 0` check
 * conflated them, silently falling back to a full repo walk whenever the
 * incremental scope was legitimately empty. `!== null` is the correct
 * test: write the manifest (even empty) for ANY resolved array, so
 * extract.mjs (enumerateFiles/isFullRunFromFiles — same fix applied
 * there) sees the real zero-file scope instead of guessing "unrestricted".
 *
 * e86a9cbb: the prior PID+timestamp path was predictable, and a plain 'w'
 * write follows a pre-existing symlink — a local attacker able to
 * pre-stage one at the guessable path could redirect this write. Adds a
 * random suffix (matching this repo's own `tmpSuffix()` convention in
 * transaction.mjs) AND `flag: 'wx'` (`O_CREAT|O_EXCL` — atomically refuses
 * to write if ANYTHING already exists at the path, symlink or not), which
 * closes the race regardless of predictability.
 *
 * @param {string[]|null} restrictFiles
 * @returns {string|null} the manifest's absolute path, or null if no
 *   restriction was passed at all
 */
export function writeFilesManifestIfRestricted(restrictFiles) {
  if (restrictFiles === null) return null;
  const suffix = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 0xFFFFFF).toString(16)}`;
  const manifestPath = path.join(os.tmpdir(), `arch-refresh-files-${suffix}.txt`);
  fs.writeFileSync(manifestPath, restrictFiles.join('\n') + '\n', { encoding: 'utf-8', flag: 'wx' });
  return manifestPath;
}

export async function runExtractSummariseEmbed({ repoRoot, repoId, mode, restrictFiles, includeDelegates, coverageConfig, concreteEmbedModel, logOk }) {
  // 6. Run extract → summarise → embed pipeline
  const extractArgs = [sibling('extract.mjs'), '--root', repoRoot, '--mode', mode];
  // Hand the touched-file list to extract via a temp manifest (--files-from)
  // rather than a `--files <comma-joined>` argv. A large incremental
  // changeset (1600+ files on Windows) overflows the OS command-line limit
  // → `spawn ENAMETOOLONG`. The manifest is newline-delimited (safe for any
  // filename) and removed in the finally below.
  const filesManifest = writeFilesManifestIfRestricted(restrictFiles);
  if (filesManifest) {
    extractArgs.push('--files-from', filesManifest);
  }
  if (includeDelegates) {
    extractArgs.push('--include-delegates');
    logOk('WARNING: --include-delegates is a debug/visibility flag. Index will include thin-facade duplicates; do NOT publish this snapshot as a normal baseline. Re-run without the flag for standard operations.');
  }
  logOk(`extracting symbols...`);
  let extracted;
  // The bound is an IDLE (inactivity) timeout, not a total-duration one
  // (docs/plans/extract-idle-timeout.md): the child streams a `progress`
  // record per file, so a healthy-but-slow extraction keeps the timer reset
  // and is never truncated — only genuine silence (a wedged parse) trips it.
  // A trip here is a DEGRADED MEASUREMENT, not a failed refresh: the symbol
  // index is independently valuable (#16), so we synthesise the coverage
  // record and recover the un-reached tail via copy-forward. Any OTHER
  // abnormal death keeps today's failure behaviour. The parent owns the
  // timer (§2.1.8) precisely because it is immune to the child's synchronous
  // blocking — a parent-side idle timer observes silence correctly even
  // while the child is wedged in synchronous work.
  let extractionTimedOut = false;
  try {
    extracted = await runJsonLinesAsyncStrict('node', extractArgs, buildExtractSpawnOpts(coverageConfig));
  } catch (err) {
    if (err.code === SUBPROC_ERROR_CODES.KILLED_BY_SIGNAL && err.cause?.timedOut) {
      extractionTimedOut = true;
      extracted = err.cause.records || [];
      logOk(`WARNING: extract went idle for ${coverageConfig.hardTimeoutMs}ms `
        + `(no output — a wedged parse, not a slow one${err.cause?.records?.length ? `; last file: ${err.cause.records[err.cause.records.length - 1]?.file ?? '?'}` : ''}) — `
        + `coverage will report extraction_timeout; reached symbols publish and the un-reached tail recovers via copy-forward`);
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

  // 8b. Timed-out-full recovery. A full extraction is a synchronous ts-morph
  // loop; the hard timeout is a parent-owned SIGKILL, so a slow run under
  // load is killed MID-LOOP and the tail of files is never reached — their
  // symbols (and their duplicate_justification flags) vanish from a snapshot
  // that still publishes as `full`. Field-observed on a consumer: a full
  // refresh dropped 146 symbols including a file whose 3 pragmas then
  // mis-reported as `unresolved`. There is no jsx-extraction gap — the file
  // parses fine; it was simply never reached.
  //
  // A truncated full run is really a partial run, so recover it exactly as
  // an incremental does: treat the files we DID reach as the "touched" set.
  // Coverage still records `unverified (extraction_timeout)` — recovery
  // restores completeness, it does not launder the degraded verdict.
  let timeoutRecovery = null;
  let recoveredTouchedSet = null;
  if (shouldAttemptTimeoutRecovery({ mode, extractionTimedOut })) {
    const priorForRecovery = await getActiveSnapshot(repoId);
    ({ timeoutRecovery, recoveredTouchedSet } = buildTimeoutRecovery({ priorForRecovery, finalSymbols }));
    if (timeoutRecovery) {
      logOk(`WARNING: full extraction was truncated by timeout — reached ${recoveredTouchedSet.size} file(s); `
        + `recovering the rest via copy-forward from ${priorForRecovery.refreshId} `
        + `(snapshot stays coverage-unverified). Re-run \`npm run arch:refresh:full\` unloaded for a clean baseline.`);
    } else {
      logOk('WARNING: full extraction truncated by timeout and no prior snapshot to recover from — publishing a partial full snapshot.');
    }
  }

  return { finalSymbols, violations, importEdges, coverageLine, extractionTimedOut, timeoutRecovery, recoveredTouchedSet };
}
