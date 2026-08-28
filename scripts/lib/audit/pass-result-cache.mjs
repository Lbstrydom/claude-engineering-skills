/**
 * @fileoverview Intermediate audit-pass result cache — write each wave's
 * results to disk as they complete, so a merge-step crash (TDZ, disk error,
 * OOM) leaves recoverable findings on disk instead of losing the run.
 *
 * Extracted from `legacy-production-audit.mjs` (docs/plans/legacy-production-audit-decomposition.md
 * Phase 1) — a pure relocation, verbatim bodies, no behaviour change.
 *
 * @module scripts/lib/audit/pass-result-cache
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteFileSync } from '../file-io.mjs';
import { normalizeFindingsForOutput as _normalizeFindingsForOutput } from '../robustness.mjs';
import { semanticId } from '../findings.mjs';

let _cacheDir = null;

export function initResultCache(outFile) {
  const base = outFile
    ? path.dirname(path.resolve(outFile))
    : os.tmpdir();
  _cacheDir = path.join(base, `.audit-cache-${process.pid}`);
  try {
    // 9e965821: explicit mode (masked by the process umask on POSIX; a no-op
    // on Windows, which doesn't meaningfully honor POSIX mode bits) rather
    // than the filesystem's default dir mode for a cache holding audit
    // pass results.
    fs.mkdirSync(_cacheDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    // Fail-open (a cache is an optimisation, never a precondition) but NOT
    // silent — `cleanupCache` below already had this treatment and this,
    // its sibling, was missed. Without the line, recovery-cache disablement is
    // invisible: every subsequent `cachePassResult` becomes a no-op and a
    // crashed run has nothing to resume from, with no signal that the cache was
    // never there.
    process.stderr.write(`  [cache] disabled — cannot create ${_cacheDir}: ${err.code || err.message}\n`);
    _cacheDir = null;
  }
}

/**
 * @returns {boolean} true iff the write actually landed. Callers that only
 * need the fire-and-forget behaviour (the historical contract) can ignore
 * the return value — it is purely additive (legacy-production-audit-
 * decomposition Cluster A audit L1/H7: `cacheWaveResults` previously
 * reported "cached" even when every write failed, because this function
 * gave it nothing to check).
 */
export function cachePassResult(passName, result) {
  if (!_cacheDir) return false;
  try {
    const filePath = path.join(_cacheDir, `${passName}.json`);
    // Phase 1 (audit-orchestrator-hardening): atomicWriteFileSync (existing,
    // file-io.mjs) instead of a plain fs.writeFileSync — a crash mid-write
    // now leaves the cache artifact either fully-old or fully-new, never torn.
    atomicWriteFileSync(filePath, JSON.stringify(result));
    return true;
  } catch (err) {
    process.stderr.write(`  [cache] Failed to cache ${passName}: ${err.message}\n`);
    return false;
  }
}

export function cacheWaveResults(passNames, results) {
  let succeeded = 0;
  let attempted = 0;
  for (let i = 0; i < passNames.length; i++) {
    if (results[i]) {
      attempted++;
      if (cachePassResult(passNames[i], results[i])) succeeded++;
    }
  }
  // Reported what it INTENDED, not what happened: with the cache disabled this
  // printed "N pass results cached to null" — a success line over zero writes.
  // Now reports the ACTUAL write outcome, not just "cache was enabled" —
  // a per-write atomicWriteFileSync failure used to be invisible here.
  if (!_cacheDir) {
    process.stderr.write(`  [cache] ${attempted} pass result(s) NOT cached — cache disabled\n`);
    return;
  }
  if (succeeded < attempted) {
    process.stderr.write(`  [cache] ${succeeded}/${attempted} pass results cached to ${_cacheDir} (${attempted - succeeded} write failure(s) — see prior diagnostics)\n`);
    return;
  }
  process.stderr.write(`  [cache] ${succeeded} pass results cached to ${_cacheDir}\n`);
}

export function cleanupCache() {
  if (!_cacheDir) return;
  try {
    fs.rmSync(_cacheDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (err) {
    // Cache cleanup failing must never fail the audit run (fail-open) — but
    // silent used to mean INVISIBLE: audit-result cache artifacts (which can
    // carry sensitive diff/finding content) could be left behind with no
    // operator signal at all.
    process.stderr.write(`  [cache] cleanup failed for ${_cacheDir}: ${err.code || err.message}\n`);
  }
}

// buildReducePayload and normalizeFindingsForOutput imported from lib/robustness.mjs
// Wrap normalizeFindingsForOutput to inject semanticId
// @duplicate-justification: target=scripts/lib/audit/map-reduce-scheduler.mjs:normalizeFindingsForOutput reason=deliberate — neither new module may import the other under this plan's dependency direction, and this is 3 lines wrapping 2 pre-existing shared primitives (robustness.mjs, findings.mjs)
export function normalizeFindingsForOutput(findings) {
  return _normalizeFindingsForOutput(findings, semanticId);
}

/**
 * Collect per-pass REDUCE degradation off a built passRegistry.
 *
 * Only degraded passes carry an `_executionMeta` (a clean REDUCE emits none) and
 * only map-reduce passes have one at all, so the result contains exactly the
 * passes worth an operator's attention. Returns `undefined` — not `{}` — when
 * nothing degraded, keeping the omit-vs-zero convention the rest of the block
 * follows: absence means "no map-reduce pass degraded", never "measured zero".
 *
 * Pure and separately exported because the alternative is asserting it through
 * a full audit run; the run-level wiring is proved separately.
 *
 * @param {Array<{name: string, _result?: object}>} passRegistry
 * @returns {Record<string, string>|undefined}
 */
export function collectReducePassStatuses(passRegistry) {
  const statuses = {};
  for (const entry of passRegistry ?? []) {
    const status = entry?._result?.result?._executionMeta?.reduceStatus;
    if (status) statuses[entry.name] = status;
  }
  return Object.keys(statuses).length > 0 ? statuses : undefined;
}
