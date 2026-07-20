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
import { getAllConsumerInventories } from '../sync-inventory.mjs';

/**
 * Optional — the audit loop still imports cleanly without these, but features
 * degrade (no codeowners routing, no advisory locks, no consistency runner).
 * Installed on a best-effort basis; a failure on any single one doesn't
 * block the rest.
 *
 * This list is hand-curated **by design**: "does this package's absence
 * degrade a feature or break an import?" is a semantic question the import
 * graph cannot answer. Everything the bundle imports that is NOT listed here
 * is required — see `requiredDeps()`.
 */
export const OPTIONAL_DEPS = [
  'codeowners-utils',       // owner resolution in debt ledger
  'proper-lockfile',        // advisory locking for bandit-state writes
  'playwright',             // consistency-mode runner — only used when the consumer
                            //   has adopted consistency mode (canaries/ + surfaces.json).
                            //   Browser binaries are a separate step:
                            //   `npx playwright install chromium`.
  '@playwright/test',       // NOT imported by the bundle itself. The graph sees
                            //   it because `ux-lock/candidate-spec.mjs` renders
                            //   that import line into the specs it GENERATES
                            //   (a string literal the regex walker cannot tell
                            //   from real code — see bundleDeps()). Kept because
                            //   it is genuinely required to RUN those generated
                            //   specs; optional on the same adoption gate as
                            //   `playwright`. If the generator stops emitting
                            //   it, the stale-entry test fires and this line
                            //   must be re-justified or dropped.
];

/** Memoised — the closure walk reads the whole source tree. */
let _bundleDepsCache = null;

/**
 * Every npm package the synced bundle imports, across ALL consumers.
 *
 * **Derived, never hand-maintained.** This list used to be a hand-written
 * `REQUIRED_DEPS` array "mirroring package.json", and it drifted: on
 * 2026-07-20 the bundle imported 17 packages while the hand-list declared 10.
 * The 7 undeclared ones (`@babel/parser`, `@babel/traverse`, `@playwright/test`,
 * `dependency-cruiser`, `minimatch`, `ts-morph`, `yaml`) were latent
 * ERR_MODULE_NOT_FOUND crashes in any consumer that didn't happen to have
 * them for its own reasons — which is exactly how `@babel/traverse` broke
 * `/audit-plan` in wine-cellar-app (upstream#57).
 *
 * The same class had already been curated as a known audit defect once
 * (`known-defects.json` — required-vs-optional misclassification). A hand-list
 * that must be kept in sync with the import graph by memory will drift again;
 * deriving it from the graph is the only version that cannot.
 *
 * **Known over-approximation.** `parseImports` is a regex, so an import line
 * inside a STRING LITERAL — a code generator emitting a spec file — is
 * indistinguishable from a real import. `@playwright/test` enters the set this
 * way (via `ux-lock/candidate-spec.mjs`). This direction is the safe one: the
 * set may name a package the bundle doesn't itself import, never miss one it
 * does. A hallucinated package cannot reach `npm install` silently either —
 * `tests/install-deps-contract.test.mjs` requires every REQUIRED dep to be
 * declared in this repo's own package.json, so an invented name fails there
 * first.
 *
 * @returns {string[]} sorted package names
 */
export function bundleDeps() {
  if (_bundleDepsCache) return _bundleDepsCache;
  const pkgs = new Set();
  for (const inv of getAllConsumerInventories().values()) {
    for (const e of inv.external || []) pkgs.add(e.pkg);
  }
  _bundleDepsCache = [...pkgs].sort();
  return _bundleDepsCache;
}

/**
 * Core dependencies — without these the audit loop can't import. Derived as
 * "everything the bundle imports, minus the curated optional set".
 *
 * @returns {string[]} sorted package names
 */
export function requiredDeps() {
  const optional = new Set(OPTIONAL_DEPS);
  return bundleDeps().filter(d => !optional.has(d));
}

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
    missing: requiredDeps().filter(d => !present(d)),
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
