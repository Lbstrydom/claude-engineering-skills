/**
 * @fileoverview Audit-loop npm dependency management for consumer repos.
 *
 * Shared between `install-skills.mjs` (one-shot installer) and
 * `sync-to-repos.mjs` (recurring sync). Single source of truth for which
 * npm packages the audit scripts need to run.
 *
 * Called after file copy. Checks `<repoRoot>/node_modules/` for each dep;
 * if missing, runs `npm install --save-dev --legacy-peer-deps <missing>`
 * in the target repo. The `--legacy-peer-deps` flag bypasses ESLint /
 * framework plugin peer-dep conflicts that are orthogonal to the audit loop.
 *
 * @module scripts/lib/install/deps
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Core dependencies — without these the audit loop can't import.
 * Mirrors `dependencies` in `claude-engineering-skills/package.json`
 * minus the optional ones.
 */
export const REQUIRED_DEPS = [
  '@anthropic-ai/sdk',
  '@google/genai',
  'dotenv',
  'micromatch',
  'openai',
  'zod',
];

/**
 * Optional — audit loop still imports cleanly without these, but features
 * degrade (no cloud learning store, no codeowners routing, no advisory locks).
 * Installed on a best-effort basis; a failure on any single one doesn't
 * block the rest.
 */
export const OPTIONAL_DEPS = [
  '@supabase/supabase-js', // cloud learning store + persona-test + cross-skill
  'codeowners-utils',       // owner resolution in debt ledger
  'proper-lockfile',        // advisory locking for bandit-state writes
  'playwright',             // consistency-mode runner — only used when the consumer
                            //   has adopted consistency mode (canaries/ + surfaces.json).
                            //   Browser binaries are a separate step:
                            //   `npx playwright install chromium`.
];

const G = '\x1b[32m', Y = '\x1b[33m', X = '\x1b[0m', D = '\x1b[2m';

/**
 * Check which REQUIRED/OPTIONAL deps are missing in a target repo.
 *
 * @param {string} repoRoot — absolute path to consumer repo root
 * @returns {{ missing: string[], missingOptional: string[], hasPackageJson: boolean }}
 */
export function findMissingDeps(repoRoot) {
  const hasPackageJson = fs.existsSync(path.join(repoRoot, 'package.json'));
  if (!hasPackageJson) {
    return { missing: [], missingOptional: [], hasPackageJson: false };
  }
  const nodeModules = path.join(repoRoot, 'node_modules');
  const present = (dep) => fs.existsSync(path.join(nodeModules, dep));
  return {
    missing: REQUIRED_DEPS.filter(d => !present(d)),
    missingOptional: OPTIONAL_DEPS.filter(d => !present(d)),
    hasPackageJson: true,
  };
}

/**
 * Ensure all audit-loop deps are installed in the target repo. Idempotent —
 * safe to call on every sync. No-op when everything is already present.
 *
 * @param {string} repoRoot — absolute path to consumer repo root
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] — report only, no install
 * @param {boolean} [opts.quiet=false] — suppress stdout when no action needed
 * @param {number} [opts.timeoutMs=120000] — per-install timeout
 * @returns {{
 *   action: 'installed' | 'already-satisfied' | 'no-package-json' | 'failed',
 *   installed: string[],
 *   installedOptional: string[],
 *   failed: string[],
 *   error?: string,
 * }}
 */
export function ensureAuditDeps(repoRoot, { dryRun = false, quiet = false, timeoutMs = 120000 } = {}) {
  const { missing, missingOptional, hasPackageJson } = findMissingDeps(repoRoot);

  if (!hasPackageJson) {
    if (!quiet) process.stderr.write(`  ${Y}○${X} ${path.basename(repoRoot)}: no package.json — skipping dep install\n`);
    return { action: 'no-package-json', installed: [], installedOptional: [], failed: [] };
  }

  if (missing.length === 0 && missingOptional.length === 0) {
    if (!quiet) process.stderr.write(`  ${G}✓${X} ${path.basename(repoRoot)}: all audit-loop deps present\n`);
    return { action: 'already-satisfied', installed: [], installedOptional: [], failed: [] };
  }

  if (dryRun) {
    if (!quiet) {
      if (missing.length) process.stderr.write(`  ${Y}~${X} ${path.basename(repoRoot)}: would install required — ${missing.join(', ')}\n`);
      if (missingOptional.length) process.stderr.write(`  ${Y}~${X} ${path.basename(repoRoot)}: would install optional — ${missingOptional.join(', ')}\n`);
    }
    return {
      action: missing.length > 0 ? 'installed' : 'already-satisfied',
      installed: missing, installedOptional: missingOptional, failed: [],
    };
  }

  const installed = [];
  const installedOptional = [];
  const failed = [];

  if (missing.length > 0) {
    process.stderr.write(`  ${D}Installing required audit-loop deps in ${path.basename(repoRoot)}: ${missing.join(', ')}${X}\n`);
    try {
      execFileSync('npm', ['install', '--save-dev', '--legacy-peer-deps', ...missing], {
        cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs,
      });
      installed.push(...missing);
      process.stderr.write(`  ${G}✓${X} Required deps installed\n`);
    } catch (err) {
      failed.push(...missing);
      process.stderr.write(`  ${Y}⚠${X} npm install failed: ${err.message?.slice(0, 160)}\n`);
      process.stderr.write(`  Run manually: cd ${repoRoot} && npm install --save-dev --legacy-peer-deps ${missing.join(' ')}\n`);
      return { action: 'failed', installed, installedOptional, failed, error: err.message };
    }
  }

  if (missingOptional.length > 0) {
    process.stderr.write(`  ${D}Installing optional audit-loop deps in ${path.basename(repoRoot)}: ${missingOptional.join(', ')}${X}\n`);
    try {
      execFileSync('npm', ['install', '--save-dev', '--legacy-peer-deps', ...missingOptional], {
        cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs,
      });
      installedOptional.push(...missingOptional);
      process.stderr.write(`  ${G}✓${X} Optional deps installed\n`);
    } catch {
      failed.push(...missingOptional);
      process.stderr.write(`  ${Y}○${X} Some optional deps failed — audit will degrade gracefully\n`);
    }
  }

  return {
    action: installed.length > 0 ? 'installed' : 'already-satisfied',
    installed, installedOptional, failed,
  };
}
