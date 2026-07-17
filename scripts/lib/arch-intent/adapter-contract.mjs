/**
 * @fileoverview The framework spine. Orchestrates the two-phase analysis:
 *
 *   Phase 1 (inventory): broad source-file glob → apply domainMap.rules →
 *     mapped + unmappedFiles + deadIntent.  Stack-agnostic.
 *
 *   Phase 2 (edge analysis): per-stack adapter, given pre-mapped files
 *     and the domainMap, returns violations + adapter _meta.
 *
 * Per-stack fault isolation: each adapter runs in its own try/catch.
 * Per-stack envelopes (`perStackResults`) carry status + report or error.
 * Whole-pass fails only when ALL stacks errored.
 *
 * @module scripts/lib/arch-intent/adapter-contract
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ArchIntentAnalyzerError } from './errors.mjs';
import { resolveFileToDomain, computeDeclaredDomains } from './domain-resolver.mjs';
import { ArchIntentReportSchema } from '../schemas.mjs';

/**
 * Empty report constant — returned by SKIPPED states and merged into when
 * no analyzers run.
 */
export const EMPTY_REPORT = Object.freeze({
  violations: [],
  unmappedFiles: [],
  deadIntent: [],
  analyzerVersion: 'none',
  perStackResults: [],
  _meta: {},
});

/**
 * Source-file extensions considered for inventory. Filter applied AFTER
 * the broad glob so we capture only real source files (not docs/configs).
 */
const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.pyi',
  '.java', '.kt',
  '.sql',
  '.go', '.rs',
]);

/**
 * Built-in exclude directory names for the fs-walk fallback. Operators
 * don't configure these — universally noise.
 */
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules', 'dist', 'build', '.git', 'coverage',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'target', '.gradle',
]);

const EXCLUDED_DIR_PREFIXES = ['.audit-cache-', '.audit'];

/**
 * Walk the repo recursively via fs.readdir, applying built-in excludes.
 * Used as fallback when `git ls-files` isn't available (e.g., test
 * fixture repos that aren't git checkouts).
 *
 * @param {string} repoPath
 * @returns {string[]} repo-relative file paths with forward-slashes
 */
function fsWalkFallback(repoPath) {
  const out = [];
  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(e.name)) continue;
        if (EXCLUDED_DIR_PREFIXES.some(p => e.name.startsWith(p))) continue;
        walk(full, relPath);
      } else if (e.isFile()) {
        out.push(relPath);
      }
    }
  }
  walk(repoPath, '');
  return out;
}

/**
 * Discover every path in the repo, normalised to forward-slash.
 *
 * Strategy:
 *   1. `git ls-files` if in a git repo (fastest + respects .gitignore)
 *   2. Else: fs.readdir recursion with built-in directory excludes
 *
 * Shared by `inventoryFiles` (which then filters to SOURCE_EXTENSIONS) and
 * `inventoryAllPaths` (which does not) so the two can never drift.
 *
 * @param {string} repoPath
 * @returns {string[]} repo-relative paths, forward-slashed
 */
function listRepoPaths(repoPath) {
  let candidates;
  // Union tracked + untracked-but-not-ignored so newly-added uncommitted
  // files ARE analysed (R1/H2 fix — closes the "audit blind spot" on fresh code).
  try {
    const tracked = execSync('git ls-files', { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const combined = new Set();
    for (const s of tracked.split('\n')) if (s.trim()) combined.add(s.trim());
    for (const s of untracked.split('\n')) if (s.trim()) combined.add(s.trim());
    candidates = [...combined];
  } catch {
    candidates = fsWalkFallback(repoPath);
  }
  return candidates.map(p => p.replaceAll('\\', '/'));
}

/**
 * Phase 1 — Inventory ALL source files in the repo, then apply domainMap.rules.
 *
 * Discovery strategy:
 *   1. `listRepoPaths` (git ls-files, else fs-walk)
 *   2. Filter by SOURCE_EXTENSIONS
 *   3. Apply each rule's pattern to assign domain; first-match-wins
 *   4. Files matched by NO rule become `unmappedFiles`
 *
 * @param {string} repoPath
 * @param {{rules: Array<{pattern, domain}>, allowedDeps?, description?}} domainMap
 * @returns {Promise<{ mapped: Map<string, string>, unmappedFiles: string[] }>}
 */
export async function inventoryFiles(repoPath, domainMap) {
  const candidates = listRepoPaths(repoPath);

  // Filter to source-file extensions
  const sourceFiles = candidates.filter(p => SOURCE_EXTENSIONS.has(path.extname(p).toLowerCase()));

  // Assign domains
  const mapped = new Map();
  const unmappedFiles = [];
  for (const f of sourceFiles) {
    const domain = resolveFileToDomain(f, domainMap.rules);
    if (domain) {
      mapped.set(f, domain);
    } else {
      unmappedFiles.push(f);
    }
  }
  return { mapped, unmappedFiles };
}

/**
 * Inventory EVERY path in the repo (no extension filter) → domain.
 *
 * This is the inventory `computeDeadIntent` wants: "dead" must mean *the
 * rule matches nothing*, not "the rule matches nothing the JS symbol
 * indexer would parse". A markdown-only domain (`skills-content`: 57 .md +
 * 2 .json) owns real paths and is a live rule — reporting it dead sent the
 * operator hunting for a bug that wasn't there. Conversely a genuinely dead
 * rule (a literal `scripts/ship.mjs` after the file was renamed to
 * `ship-commit.mjs`) matches zero paths under either filter, so this is the
 * strictly better signal.
 *
 * @param {string} repoPath
 * @param {{rules: Array<{pattern, domain}>}} domainMap
 * @returns {Map<string,string>} path → domain, for every rule-matched path
 */
export function inventoryAllPaths(repoPath, domainMap) {
  const mapped = new Map();
  for (const p of listRepoPaths(repoPath)) {
    const domain = resolveFileToDomain(p, domainMap.rules);
    if (domain) mapped.set(p, domain);
  }
  return mapped;
}

/**
 * Compute deadIntent — declared domains that don't own any local file.
 * Excludes pseudo-domains (vendor). Operator may want to remove from intent
 * OR plan to populate.
 *
 * Pure in `mapped`: pass `inventoryAllPaths()` for the "is this rule dead?"
 * question (see its note), or a source-file `inventoryFiles().mapped` for a
 * narrower one.
 *
 * @param {Map<string,string>} mapped
 * @param {{rules, allowedDeps, description}} domainMap
 * @returns {string[]} sorted list of dead domains
 */
export function computeDeadIntent(mapped, domainMap) {
  const declared = computeDeclaredDomains(domainMap);
  const live = new Set(mapped.values());
  const dead = [];
  for (const d of declared) {
    if (!live.has(d)) dead.push(d);
  }
  return dead.sort((a, b) => a.localeCompare(b));
}

/**
 * Dynamically load an adapter module for a given stack kind.
 *
 * Returns:
 *   - { module }: adapter loaded successfully
 *   - { missing: true }: adapter file does not exist (orchestrator → UNSUPPORTED)
 *   - throws ArchIntentAnalyzerError: adapter exists but its dependencies failed
 *     (the orchestrator must NOT silently fail-open in this case — this is a
 *     real bug in the adapter or its env)
 *
 * @param {string} stackKind
 * @returns {Promise<{ module?: { default: Function }, missing?: true }>}
 */
async function loadAdapter(stackKind) {
  const adapterPath = `./adapters/${stackKind}.mjs`;
  // First: check if the file exists at all. If not → genuine "no adapter".
  const url = new URL(adapterPath, import.meta.url);
  if (!fs.existsSync(url)) {
    return { missing: true };
  }
  // File exists; any import error from here is a real problem (e.g.,
  // transitive dep missing, syntax error). Don't swallow.
  try {
    const module = await import(adapterPath);
    return { module };
  } catch (err) {
    throw new ArchIntentAnalyzerError(
      `Adapter ${adapterPath} exists but failed to load: ${err.message}`,
      { stackKind, cause: err }
    );
  }
}

/**
 * Validate an adapter's return shape against ArchIntentReportSchema
 * (subset — violations + _meta).  Throws on misbehaving adapter.
 *
 * @param {object} raw
 * @param {string} adapterName
 */
function validateAdapterReport(raw, adapterName) {
  // Adapters return only the violations + _meta subset
  const adapterReturnSchema = ArchIntentReportSchema.pick({ violations: true, _meta: true });
  const parsed = adapterReturnSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ArchIntentAnalyzerError(
      `Adapter ${adapterName} returned malformed report: ${parsed.error.issues.map(i => i.message).join('; ')}`,
      { stackKind: adapterName }
    );
  }
  return parsed.data;
}

/**
 * Run the full architecture-intent analysis: inventory + per-stack adapters.
 *
 * @param {object} opts
 * @param {string} opts.repoPath
 * @param {string[]} opts.stackKinds - from detectRepoStack().stackKinds; iterate per kind
 * @param {object} opts.domainMap - typed config from loadArchIntentConfig()
 * @returns {Promise<ArchIntentReport>}
 */
export async function runArchIntentAnalysis({ repoPath, stackKinds, domainMap }) {
  // Phase 1: inventory (shared, runs once)
  const { mapped, unmappedFiles } = await inventoryFiles(repoPath, domainMap);
  // Dead intent is asked of the UNFILTERED path inventory, not `mapped` —
  // a rule is dead only when it matches no path at all.
  const deadIntent = computeDeadIntent(inventoryAllPaths(repoPath, domainMap), domainMap);

  // Phase 2: per-stack edge analysis with fault isolation
  const perStackResults = [];
  const mergedViolations = [];
  const mergedMeta = {};
  let runningAnalyzerVersion = 'none';

  for (const stackKind of stackKinds) {
    let adapterModule;
    try {
      const loaded = await loadAdapter(stackKind);
      if (loaded.missing) {
        perStackResults.push({
          stackKind,
          status: 'unsupported',
          error: { message: `No adapter at adapters/${stackKind}.mjs`, kind: 'analyzer' },
        });
        continue;
      }
      adapterModule = loaded.module;
    } catch (err) {
      // ArchIntentAnalyzerError from loadAdapter → adapter file exists but
      // failed to load.  Real error, not fail-open.
      perStackResults.push({
        stackKind,
        status: 'error',
        error: { message: err.message, kind: 'analyzer' },
      });
      continue;
    }
    const analyseImports = adapterModule.default;
    try {
      const raw = await analyseImports({ mapped, domainMap, repoPath });
      const valid = validateAdapterReport(raw, stackKind);
      perStackResults.push({
        stackKind,
        status: 'ok',
        report: valid,
      });
      mergedViolations.push(...valid.violations);
      mergedMeta[stackKind] = valid._meta;
      // Use the most-recent stack's version (first one wins for non-mixed)
      if (runningAnalyzerVersion === 'none' && typeof raw.analyzerVersion === 'string') {
        runningAnalyzerVersion = raw.analyzerVersion;
      }
    } catch (err) {
      perStackResults.push({
        stackKind,
        status: 'error',
        error: { message: err.message ?? String(err), kind: 'analyzer' },
      });
    }
  }

  return {
    violations: mergedViolations,
    unmappedFiles,
    deadIntent,
    analyzerVersion: runningAnalyzerVersion,
    perStackResults,
    _meta: mergedMeta,
  };
}

/**
 * Central definition of "clean" — used by audit-pass gate, tests, and
 * stderr summary. No path drift.
 *
 * Clean iff:
 *   - no violations
 *   - no unmapped source files
 *   - no dead intent
 *   - every per-stack analyzer succeeded (status 'ok' — 'unsupported' OK)
 *
 * (Gemini-R2/H1: per-stack failures that returned zero violations would
 * otherwise pass the previous definition — fixed by the per-stack check.)
 *
 * @param {ArchIntentReport} report
 * @returns {boolean}
 */
export function isArchIntentReportClean(report) {
  return report.violations.length === 0
    && report.unmappedFiles.length === 0
    && report.deadIntent.length === 0
    && report.perStackResults.every(r => r.status === 'ok' || r.status === 'unsupported');
}

/**
 * Derive the pass-state label from a completed report. Used by the audit
 * pipeline to emit one stderr line per run + record cacheMetrics-style.
 *
 * @param {ArchIntentReport} report
 * @returns {'ANALYZED_CLEAN'|'ANALYZED_WITH_FINDINGS'|'ANALYZED_PARTIAL'|'ERROR_ALL_STACKS_FAILED'|'SKIPPED_UNSUPPORTED_STACK'}
 */
export function deriveArchState(report) {
  const okStacks = report.perStackResults.filter(r => r.status === 'ok').length;
  const errorStacks = report.perStackResults.filter(r => r.status === 'error').length;
  const unsupportedStacks = report.perStackResults.filter(r => r.status === 'unsupported').length;

  if (report.perStackResults.length === 0) return 'SKIPPED_UNSUPPORTED_STACK';
  if (okStacks === 0 && errorStacks > 0) return 'ERROR_ALL_STACKS_FAILED';
  if (okStacks === 0 && unsupportedStacks > 0) return 'SKIPPED_UNSUPPORTED_STACK';
  if (errorStacks > 0) return 'ANALYZED_PARTIAL';
  if (isArchIntentReportClean(report)) return 'ANALYZED_CLEAN';
  return 'ANALYZED_WITH_FINDINGS';
}
