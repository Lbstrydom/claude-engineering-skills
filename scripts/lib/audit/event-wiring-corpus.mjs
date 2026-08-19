/**
 * @fileoverview Orchestration-side corpus builder + config loader + the
 * Wave-1.5c production entry point for the event-wiring-symmetry detector.
 * Impure by design — this is the seam that keeps event-wiring.mjs pure.
 *
 * Design: docs/plans/event-wiring-symmetry.md §2 (D2d, D11, D12).
 *
 * @module scripts/lib/audit/event-wiring-corpus
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import {
  extractEventSites, diffSites, resolveSymmetry, lookupEventStatus, EXTRACTOR_VERSION,
} from './event-wiring.mjs';
import { isTestFile, isDocExampleFile, PATH_CLASSIFIER_VERSION } from './path-classifiers.mjs';
import { resolveAndClassify } from '../sensitive-paths.mjs';
// listOpenLifecycle/reconcileLifecycle are imported LAZILY, inside
// detectEventWiringAsymmetry, not at module scope: this file is Cluster A
// (Phase 0), but the D12 lifecycle host lives in ledger.mjs, which is a
// Cluster B (Phase 1) modification (§7b's Phase 1 file list — corrected to
// include ledger.mjs, previously listed only in §7's table). Phase 0's own
// gate (the repo-wide CLI oracle) never calls this function, so the module
// must stay importable/testable before ledger.mjs gains these exports.

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.html', '.template']);
const PER_FILE_BYTE_CAP = 1 * 1024 * 1024; // 1 MiB, matches this repo's spawnSync maxBuffer convention
const DEFAULT_TOTAL_BUDGET_MB = 200;

// ---------------------------------------------------------------------------
// Config loader/validator (R5/M2) — the single owner for both the Phase-0
// CLI and the production entry point below.
// ---------------------------------------------------------------------------
const WrapperEntrySchema = z.object({
  direction: z.enum(['listen', 'dispatch']),
  callee: z.string().regex(/^\*?[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/),
  eventArgIndex: z.number().int().nonnegative(),
  targetArgIndex: z.number().int().nonnegative().optional(),
}).refine(w => w.targetArgIndex === undefined || w.targetArgIndex !== w.eventArgIndex, {
  message: 'eventArgIndex and targetArgIndex must differ',
});

const ConfigFileSchema = z.object({
  version: z.literal(1),
  wrappers: z.array(WrapperEntrySchema).max(32).default([]),
  totalByteBudgetMb: z.number().int().nonnegative().default(DEFAULT_TOTAL_BUDGET_MB),
}).strict();

function assertNoDuplicateWrappers(wrappers) {
  const seen = new Set();
  for (const w of wrappers) {
    const key = `${w.direction}|${w.callee}`;
    if (seen.has(key)) {
      throw new Error(`event-wiring config: duplicate wrapper (direction, callee) = (${w.direction}, ${w.callee})`);
    }
    seen.add(key);
  }
}

/**
 * @param {string} repoPath
 * @returns {{wrappers: Array, totalByteBudgetMb: number}}
 * @throws on a present-but-invalid config — callers convert to their own
 *   exit-2/hard-fail contract (Phase-0 CLI: exit 2; production: skip the run).
 */
export function loadEventWiringConfig(repoPath) {
  const configPath = path.join(repoPath, '.audit-loop', 'event-wiring.json');
  if (!fs.existsSync(configPath)) {
    return { wrappers: [], totalByteBudgetMb: DEFAULT_TOTAL_BUDGET_MB };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`event-wiring config at ${configPath} is not valid JSON: ${err.message}`);
  }
  const parsed = ConfigFileSchema.parse(raw);
  assertNoDuplicateWrappers(parsed.wrappers);
  return { wrappers: parsed.wrappers, totalByteBudgetMb: parsed.totalByteBudgetMb };
}

// ---------------------------------------------------------------------------
// Corpus builder (D11) — repo-wide (ref-less) or ref-anchored (D2d/R3-H3).
// ---------------------------------------------------------------------------
/**
 * Lists tracked files — from the CURRENT index/worktree when `ref` is
 * omitted (the repo-wide diagnostic mode), or from the ref's own tree when
 * given (audit-code R1/M1 fix). `git ls-files` always describes the current
 * index regardless of any `ref` the CALLER intends to read content from —
 * using it unconditionally meant a ref-anchored build could enumerate a
 * file list from a different repo state than the content it reads, silently
 * missing files that existed at `ref` but were since deleted, or including
 * ones that didn't exist there yet.
 */
function gitLsFiles(repoPath, ref) {
  const args = ref ? ['ls-tree', '-r', '--name-only', '-z', ref] : ['ls-files', '-z'];
  const buf = execFileSync('git', args, { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return buf.toString('utf8').split('\0').filter(Boolean);
}

/**
 * Strips ASCII control characters (including newlines/carriage-returns) from
 * a value before it's interpolated into a terminal diagnostic — audit-code
 * R4/M4 fix. Tracked git paths CAN legally contain control characters, and
 * writing one raw could forge extra log lines or terminal escape sequences.
 */
function sanitizeForTerminal(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\x00-\x1f\x7f]/g, '·');
}

function isGenerated(relPath) {
  return relPath.includes('.min.') || relPath.includes('.generated.');
}

function isAllowedExtension(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

function readAtRef(repoPath, ref, relPath) {
  // git show <ref>:<path> — every file becomes git-object-addressed under a
  // ref-anchored build, so no dirty/clean special case is needed here.
  // `<ref>:<path>` notation is REPO-ROOT-relative unless `<path>` is
  // explicitly `./`-prefixed (unlike `git ls-files`/`ls-tree`, which are
  // cwd-relative) — found live: `buildCorpus` scoped to a subdirectory of a
  // larger repo (this repo's own oracle fixture pack) resolved every clean
  // file's blob OID against the wrong tree entry once M1's fix made this
  // codepath reachable for the first time.
  return execFileSync('git', ['show', `${ref}:./${relPath}`], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: PER_FILE_BYTE_CAP + 4096 });
}

function blobOidAtRef(repoPath, ref, relPath) {
  const out = execFileSync('git', ['rev-parse', `${ref}:./${relPath}`], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
  return out.toString('utf8').trim();
}

function gitStatusForFile(repoPath, relPath) {
  // Clean iff `git status --porcelain -- <path>` is empty.
  const out = execFileSync('git', ['status', '--porcelain', '--', relPath], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
  return out.toString('utf8').trim() === '';
}

/**
 * @param {{repoPath: string, wrappers: Array, ref?: string}} args
 * @returns {{sites: {dispatches: object[], listens: object[]}, counters: object, cacheKey: string}}
 */
export function buildCorpus({ repoPath, wrappers = [], ref, totalByteBudgetMb = DEFAULT_TOTAL_BUDGET_MB } = {}) {
  const trackedFiles = gitLsFiles(repoPath, ref);
  const dispatches = [];
  const listens = [];
  let skippedFiles = 0;
  let excludedFiles = 0;
  let totalBytesRead = 0;
  const totalBudgetBytes = totalByteBudgetMb > 0 ? totalByteBudgetMb * 1024 * 1024 : Infinity;
  const hashParts = [];
  let budgetExhausted = false;

  for (const relPath of trackedFiles) {
    if (!isAllowedExtension(relPath)) { excludedFiles++; continue; }
    if (isGenerated(relPath)) { excludedFiles++; continue; }

    const classification = resolveAndClassify(relPath, { repoRoot: repoPath });
    if (classification.category === 'sensitive') { excludedFiles++; continue; }

    if (budgetExhausted) { skippedFiles++; continue; }

    let source;
    let contentHash;
    try {
      if (ref) {
        source = readAtRef(repoPath, ref, relPath).toString('utf8');
        contentHash = blobOidAtRef(repoPath, ref, relPath);
      } else {
        const abs = path.join(repoPath, relPath);
        // audit-code R4/H2 fix: stat BEFORE reading — the prior version read
        // the whole file into memory unconditionally, then discarded it if
        // over the cap, so a very large tracked file paid the full read cost
        // (and its memory) before the limit that exists to bound exactly
        // that ever applied.
        const st = fs.statSync(abs);
        if (st.size > PER_FILE_BYTE_CAP) {
          skippedFiles++;
          process.stderr.write(`  [event-wiring] skip (oversize): ${sanitizeForTerminal(relPath)}\n`);
          continue;
        }
        const buf = fs.readFileSync(abs);
        source = buf.toString('utf8');
        contentHash = gitStatusForFile(repoPath, relPath)
          ? blobOidAtRef(repoPath, 'HEAD', relPath)
          : crypto.createHash('sha256').update(buf).digest('hex');
      }
    } catch (err) {
      // audit-code L2 fix: a bare aggregate count can't distinguish "expected
      // unsupported file" from "operational failure" — log path + reason
      // (mirrors diff-scope-resolver.mjs's precedent). The path itself is
      // never sensitive here (resolveAndClassify already excluded those
      // above); only the error message is truncated, since it could echo
      // file content in a read-error edge case.
      skippedFiles++;
      process.stderr.write(`  [event-wiring] skip (read failed): ${sanitizeForTerminal(relPath)} — ${sanitizeForTerminal(String(err.message || err)).slice(0, 200)}\n`);
      continue;
    }

    if (Buffer.byteLength(source, 'utf8') > PER_FILE_BYTE_CAP) { skippedFiles++; continue; }
    totalBytesRead += Buffer.byteLength(source, 'utf8');
    if (totalBytesRead > totalBudgetBytes) { budgetExhausted = true; skippedFiles++; continue; }

    hashParts.push(`${relPath}:${contentHash}`);

    const runtime = isTestFile(relPath) ? 'test' : isDocExampleFile(relPath) ? 'doc-example' : 'production';
    const sites = extractEventSites(source, { path: relPath, wrappers, runtime });
    dispatches.push(...sites.dispatches);
    listens.push(...sites.listens);
  }

  hashParts.sort();
  const wrapperConfigHash = crypto.createHash('sha256').update(JSON.stringify(wrappers)).digest('hex').slice(0, 16);
  const cacheKey = crypto.createHash('sha256')
    .update(`${EXTRACTOR_VERSION}|${PATH_CLASSIFIER_VERSION}|${wrapperConfigHash}|${PER_FILE_BYTE_CAP}|${totalByteBudgetMb}|${hashParts.join(',')}`)
    .digest('hex');

  return {
    sites: { dispatches, listens },
    counters: { skippedFiles, excludedFiles, filesConsidered: trackedFiles.length },
    cacheKey,
  };
}

// ---------------------------------------------------------------------------
// Production entry point (Wave-1.5c) — R2/H1, corrected R3/H2, R3/H3, R5/H1.
// ---------------------------------------------------------------------------

/**
 * @param {{diffScope: {headRef: string, changedFiles: Array<{path:string, status:string, beforeSource?:string, afterSource?:string}>}, repoPath: string, wrappers: Array, ledgerPath: string, metricsSinkPath?: string}} args
 */
export async function detectEventWiringAsymmetry({ diffScope, repoPath, wrappers = [], totalByteBudgetMb, ledgerPath, metricsSinkPath } = {}) {
  const { listOpenLifecycle, reconcileLifecycle } = await import('../ledger.mjs');
  // (1) After-state repo-wide corpus, ref-anchored to headRef — reused by
  // both the site-diff below and D12 reconciliation, never built twice.
  // `totalByteBudgetMb` is threaded through explicitly (audit-code R1/M6 fix
  // — a prior draft loaded the config's budget but never passed it here,
  // so the production path silently always used buildCorpus's default).
  const { sites: corpus, counters: corpusCounters } = buildCorpus({ repoPath, wrappers, ref: diffScope.headRef, totalByteBudgetMb });

  // (2) Per-changed-file before/after extraction.
  let readSkips = 0;
  const perFile = [];
  for (const f of diffScope.changedFiles) {
    try {
      const before = f.beforeSource !== undefined
        ? extractEventSites(f.beforeSource, { path: f.path, wrappers, runtime: isTestFile(f.path) ? 'test' : isDocExampleFile(f.path) ? 'doc-example' : 'production' })
        : { dispatches: [], listens: [] };
      const after = f.afterSource !== undefined
        ? extractEventSites(f.afterSource, { path: f.path, wrappers, runtime: isTestFile(f.path) ? 'test' : isDocExampleFile(f.path) ? 'doc-example' : 'production' })
        : { dispatches: [], listens: [] };
      perFile.push({ status: f.status, before, after });
    } catch (err) {
      readSkips++;
      process.stderr.write(`  [event-wiring] skip changed-file (extraction failed): ${sanitizeForTerminal(f.path)} — ${sanitizeForTerminal(String(err.message || err)).slice(0, 200)}\n`);
    }
  }

  // (2.5) partial decided BEFORE any side effect (R5/H1).
  const skippedFiles = corpusCounters.skippedFiles + readSkips;
  const counters = { ...corpusCounters, skippedFiles };
  if (skippedFiles > 0) {
    if (metricsSinkPath) writeRunSummary(metricsSinkPath, { counters, partial: true });
    return { findings: [], counters, partial: true };
  }

  // (3) Diff-wide union, then diffSites per changed-file pair, unioned.
  let addedDispatches = [];
  let removedListeners = [];
  for (const { before, after } of perFile) {
    const d = diffSites(before, after);
    addedDispatches = addedDispatches.concat(d.addedDispatches);
    removedListeners = removedListeners.concat(d.removedListeners);
  }

  // (4) resolveSymmetry.
  const { findings, coverage, counters: symCounters } = resolveSymmetry({ corpus, addedDispatches, removedListeners });

  // (5) D12 reconciliation — one locked transaction, ancestry precomputed
  // outside the lock (R4/M1, corrected R5/H2, Gemini round-3 G1/G2).
  const openRecords = listOpenLifecycle(ledgerPath, { kind: 'event-wiring-symmetry' });
  const coveredNames = new Set(coverage.map(c => c.eventName));
  const observations = coverage.map(c => ({ eventName: c.eventName, ref: diffScope.headRef, coverage: c }));
  for (const rec of openRecords) {
    if (coveredNames.has(rec.eventName)) continue;
    const status = lookupEventStatus(corpus, rec.eventName);
    observations.push({ eventName: rec.eventName, ref: diffScope.headRef, status });
  }
  const ancestryDecisions = computeAncestryDecisions(repoPath, diffScope.headRef, openRecords);
  reconcileLifecycle(ledgerPath, { kind: 'event-wiring-symmetry', observations, now: Date.now(), ancestryDecisions });

  // (6) merge counters, write metrics, return.
  const merged = { ...counters, ...symCounters };
  if (metricsSinkPath) writeRunSummary(metricsSinkPath, { counters: merged, partial: false });

  return { findings, counters: merged, partial: false };
}

function computeAncestryDecisions(repoPath, headRef, openRecords) {
  const decisions = new Map();
  const distinctStoredRefs = new Set(openRecords.map(r => r.lastObservedRef).filter(Boolean));
  for (const storedRef of distinctStoredRefs) {
    if (storedRef === headRef) { decisions.set(storedRef, true); continue; }
    try {
      // "is storedRef an ancestor of headRef" — i.e. is headRef newer-or-equal.
      execFileSync('git', ['merge-base', '--is-ancestor', storedRef, headRef], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
      decisions.set(storedRef, true);
    } catch (err) {
      // Fail closed on ANY failure — a real "not an ancestor" (exit 1) and an
      // unreachable-commit error (exit 128, shallow clone / gc / force-push)
      // are handled identically: drop the observation, never throw
      // (Gemini round-3 G2).
      decisions.set(storedRef, false);
      void err;
    }
  }
  return decisions;
}

function writeRunSummary(sinkPath, { counters, partial }) {
  try {
    fs.mkdirSync(path.dirname(sinkPath), { recursive: true });
    const line = JSON.stringify({
      kind: 'event-wiring-run-summary',
      _meta: counters,
      partial,
      ts: Date.now(),
    });
    fs.appendFileSync(sinkPath, line + '\n');
  } catch {
    // Best-effort — never fail the detector run over a metrics-sink write error.
  }
}
