/**
 * @fileoverview Core file I/O utilities + barrel re-exports.
 *
 * Core: atomic writes, path normalization, safe parsing, readFileOrDie, writeOutput.
 * Re-exports: audit-scope, diff-annotation, plan-paths (backward compat for all 19+ importers).
 *
 * @module scripts/lib/file-io
 */

import fs from 'node:fs';
import path from 'node:path';
import { retrySync } from './retry-transient-fs.mjs';

// ── Atomic File Writes ──────────────────────────────────────────────────────
// Write to a temp file in the same directory, then rename for crash-safety.

/**
 * Real implementation body, parameterized over the fs functions so tests
 * can inject a failing renameFn/unlinkFn and exercise the whole function
 * (symlink-following, mkdirSync, temp-write, retry-wrapped rename,
 * cleanup-on-failure) rather than mocking at the module boundary.
 */
export function atomicWriteFileSyncImpl(filePath, data, {
  mode,
  renameFn = fs.renameSync,
  unlinkFn = fs.unlinkSync,
} = {}) {
  let absPath = path.resolve(filePath);
  // Gemini-r3-r2 G1: symlink preservation. If the target is a symlink
  // (common for dotfiles managed by stow / chezmoi / etc., e.g. ~/.audit-loop.env
  // → ~/dotfiles/audit-loop.env), follow it to the physical target so the
  // atomic rename replaces the file's CONTENTS, not the symlink itself.
  // Without this, the rename destroys the symlink and breaks the operator's
  // dotfile manager. Best-effort: if lstat/realpath errors, fall through.
  try {
    if (fs.lstatSync(absPath).isSymbolicLink()) {
      absPath = fs.realpathSync(absPath);
    }
  } catch { /* target doesn't exist yet — first write — no symlink to follow */ }
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
  // Forward mode to fs.writeFileSync so the temp file is created with the
  // requested permission bits AT OPEN — secure-mode-at-create for secrets
  // files (plan: docs/plans/shared-cloud-config.md Gemini-G4). Default
  // (mode undefined) preserves Node's prior open-with-umask behaviour.
  const writeOpts = mode !== undefined ? { encoding: 'utf-8', mode } : 'utf-8';
  try {
    fs.writeFileSync(tmpPath, data, writeOpts);
    retrySync(() => renameFn(tmpPath, absPath));
  } catch (err) {
    try { unlinkFn(tmpPath); } catch (cleanupErr) {
      process.stderr.write(`  [atomic-write] Temp file cleanup failed: ${cleanupErr.message}\n`);
    }
    throw err;
  }
}

export function atomicWriteFileSync(filePath, data, { mode } = {}) {
  atomicWriteFileSyncImpl(filePath, data, { mode });
}

export const _internals = { atomicWriteFileSyncImpl };

// ── Path Normalization ──────────────────────────────────────────────────────

/**
 * Canonicalize file paths to cwd-relative, forward-slash, lowercase form.
 * @param {string} p - File path (absolute or relative)
 * @returns {string} Normalized path
 */
export function normalizePath(p) {
  const resolved = path.resolve(p);
  const cwdPrefix = path.resolve('.');
  return resolved.replace(cwdPrefix, '').replaceAll(/\\/g, '/').replace(/^\//, '').toLowerCase();
}

// ── Safe Parsing ────────────────────────────────────────────────────────────

/** Safe parseInt with fallback for NaN. */
export function safeInt(val, fallback) {
  const n = Number.parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ── File Helpers ────────────────────────────────────────────────────────────

export function readFileOrDie(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, 'utf-8');
}

// ── Output Helpers ──────────────────────────────────────────────────────────

/**
 * Write output to file or stdout.
 * @param {object} data
 * @param {string} outPath
 * @param {string} summaryLine
 */
export function writeOutput(data, outPath, summaryLine) {
  const json = JSON.stringify(data, null, 2);
  if (outPath) {
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, json, 'utf-8');
    process.stderr.write(`  [out] Results written to ${abs}\n`);
    console.log(summaryLine);
  } else {
    console.log(json);
  }
}

// ── Barrel Re-exports (backward compat) ─────────────────────────────────────
// All 19+ importers of file-io.mjs continue working unchanged.

export { isSensitiveFile, isAuditInfraFile, readFilesAsContext, classifyFiles, safeReadFile, auditSubjectFileGuard, AUDIT_INFRA_BASENAMES, MAX_FILE_SIZE } from './audit-scope.mjs';
export { parseDiffFile, readFilesAsAnnotatedContext, getCommentStyle } from './diff-annotation.mjs';
export { extractPlanPaths } from './plan-paths.mjs';
