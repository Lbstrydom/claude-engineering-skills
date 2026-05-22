/**
 * @fileoverview Audit scope filtering — sensitive file detection, audit-infrastructure
 * exclusion, and context assembly with safety guards.
 *
 * Split from file-io.mjs (Wave 2, Phase 2) for Single Responsibility.
 * @module scripts/lib/audit-scope
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifyPath } from './sensitive-paths.mjs';
// normalizePath not used directly here but re-exported via file-io.mjs barrel

// ── Sensitive File Filtering ────────────────────────────────────────────────
//
// The canonical predicate lives in `scripts/lib/sensitive-paths.mjs`. This
// module delegates so audit-context construction, debt capture, plan-path
// discovery, and sanitiser share ONE source of truth (plan: docs/plans/
// sustainability-cleanup-batch.md WS3, R1-H4).

export function isSensitiveFile(relPath) {
  return classifyPath(relPath) === 'sensitive';
}

// ── Audit Infrastructure Exclusion ────────────────────────────────────────
// These are the audit-loop's own scripts, synced to consumer repos via
// sync-to-repos.mjs. They must NEVER appear in the audit scope — including
// them causes Gemini/Claude Opus to flag issues in the tool itself rather
// than in the project being audited.

export const AUDIT_INFRA_BASENAMES = new Set([
  'openai-audit.mjs', 'gemini-review.mjs', 'bandit.mjs', 'learning-store.mjs',
  'phase7-check.mjs', 'shared.mjs', 'check-sync.mjs', 'check-setup.mjs',
  'refine-prompts.mjs', 'evolve-prompts.mjs', 'meta-assess.mjs',
  'debt-auto-capture.mjs', 'debt-backfill.mjs', 'debt-budget-check.mjs',
  'debt-pr-comment.mjs', 'debt-resolve.mjs', 'debt-review.mjs',
  'write-plan-outcomes.mjs', 'write-ledger-r1.mjs', 'sync-to-repos.mjs',
  'audit-loop.mjs',
  // lib/ modules
  'file-io.mjs', 'audit-scope.mjs', 'diff-annotation.mjs', 'plan-paths.mjs',
  'schemas.mjs', 'ledger.mjs', 'code-analysis.mjs', 'context.mjs',
  'findings.mjs', 'findings-format.mjs', 'findings-tracker.mjs',
  'findings-outcomes.mjs', 'findings-tasks.mjs', 'outcome-sync.mjs',
  'config.mjs', 'llm-auditor.mjs', 'llm-wrappers.mjs',
  'language-profiles.mjs', 'rng.mjs', 'robustness.mjs', 'sanitizer.mjs',
  'secret-patterns.mjs', 'suppression-policy.mjs', 'backfill-parser.mjs',
  'owner-resolver.mjs', 'rule-metadata.mjs', 'file-store.mjs',
  'prompt-registry.mjs', 'prompt-seeds.mjs', 'linter.mjs',
  'plan-fp-tracker.mjs', 'predictive-strategy.mjs',
  'debt-capture.mjs', 'debt-events.mjs', 'debt-git-history.mjs',
  'debt-ledger.mjs', 'debt-memory.mjs', 'debt-review-helpers.mjs',
]);

/**
 * Returns true if the path points to an audit-loop infrastructure file.
 * These files are synced to consumer repos but should never be in audit scope.
 * @param {string} relPath - Relative file path
 * @returns {boolean}
 */
export function isAuditInfraFile(relPath) {
  const norm = relPath.replaceAll('\\', '/');
  const basename = path.basename(norm);
  // Must be directly under top-level scripts/ or scripts/lib/ — NOT nested
  // under other directories (e.g. src/scripts/ is a legitimate consumer path).
  if (!norm.startsWith('scripts/')) return false;
  return AUDIT_INFRA_BASENAMES.has(basename);
}

// ── Context Assembly ──────────────────────────────────────────────────────

/** Max file size to read into memory (2MB). Larger files are skipped entirely. */
export const MAX_FILE_SIZE = 2 * 1024 * 1024;

/**
 * Safely read a file with all boundary checks: sensitive filter, symlink-aware
 * containment, size guard, and error recovery.
 * Returns { content, absPath } on success, null on skip (with reason).
 * @param {string} relPath - Relative file path
 * @param {string} cwdBoundary - Resolved CWD for containment check
 * @returns {{ content: string, absPath: string } | null}
 */
export function safeReadFile(relPath, cwdBoundary) {
  if (isSensitiveFile(relPath)) return null;
  const absPath = path.resolve(relPath);
  let realPath;
  try { realPath = fs.realpathSync(absPath); } catch { return null; }
  const rel = path.relative(cwdBoundary, realPath);
  if (rel.startsWith('..' + path.sep) || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return null;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;
    return { content: fs.readFileSync(absPath, 'utf-8'), absPath };
  } catch {
    return null;
  }
}

/**
 * Read file contents as markdown code blocks, with safety guards:
 * - Sensitive file exclusion (full-path matching)
 * - Path containment (rejects ../ escapes)
 * - Per-file error recovery (race conditions, permissions)
 * - Size guard (skip files > 2MB)
 * @param {string[]} filePaths
 * @param {object} opts
 * @param {number} [opts.maxPerFile=10000]
 * @param {number} [opts.maxTotal=120000]
 * @returns {string}
 */
export function readFilesAsContext(filePaths, { maxPerFile = 10000, maxTotal = 120000 } = {}) {
  let total = '';
  let omitted = 0;
  let sensitive = 0;

  const cwdBoundary = path.resolve('.');

  for (const relPath of filePaths) {
    if (isSensitiveFile(relPath)) { sensitive++; continue; }

    const result = safeReadFile(relPath, cwdBoundary);
    if (!result) { omitted++; continue; }
    const raw = result.content;

    const ext = relPath.split('.').pop();
    const lang = { sql: 'sql', css: 'css', html: 'html', md: 'markdown', json: 'json', py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', sh: 'bash' }[ext] ?? 'js';
    const content = raw.length > maxPerFile
      ? raw.slice(0, maxPerFile) + `\n... [TRUNCATED — ${raw.length} chars total]`
      : raw;
    const block = `### ${relPath}\n\`\`\`${lang}\n${content}\n\`\`\`\n`;

    if (total.length + block.length > maxTotal) { omitted++; continue; }
    total += block;
  }

  if (omitted > 0) total += `\n... [${omitted} file(s) omitted — context budget reached]\n`;
  if (sensitive > 0) total += `\n... [${sensitive} sensitive file(s) excluded (.env, secrets, keys)]\n`;
  return total;
}

// ── File Classification ─────────────────────────────────────────────────────

/**
 * Classify files as backend, frontend, or shared.
 * @param {string[]} filePaths
 * @returns {{backend: string[], frontend: string[], shared: string[]}}
 */
export function classifyFiles(filePaths) {
  const backend = [];
  const frontend = [];
  const shared = [];

  const fePatterns = [/^public\//, /\/css\//, /\/html\//, /\.css$/, /\.html$/, /\/components\//];
  const sharedPatterns = [/\/config\//, /\/schemas\//, /\/types\//, /\/shared\//, /\.json$/];

  for (const p of filePaths) {
    if (fePatterns.some(rx => rx.test(p))) {
      frontend.push(p);
    } else if (sharedPatterns.some(rx => rx.test(p))) {
      shared.push(p);
    } else {
      backend.push(p);
    }
  }

  return { backend, frontend, shared };
}
