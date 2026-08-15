/**
 * @fileoverview Audit-loop dependency management for consumer repos.
 *
 * Shared between `install-skills.mjs` (one-shot installer) and
 * `sync-to-repos.mjs` (recurring sync). Single source of truth for which
 * packages the audit scripts need to run.
 *
 * Called after file copy. Checks `<repoRoot>/node_modules/` for each dep; if
 * missing, installs them **with the consumer's own package manager**, resolved
 * by `lib/package-manager.mjs`. This used to be a hardcoded
 * `npm install --save-dev --legacy-peer-deps`, which does not work in a pnpm
 * consumer at all — npm cannot read pnpm's symlinked tree and aborts (measured
 * 2026-08-15; see that module's header for the negative control). The
 * `node_modules/<dep>` probe below needs no such adjustment: pnpm symlinks
 * every DIRECT dependency there, and every dep we install is direct.
 *
 * @module scripts/lib/install/deps
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getAllConsumerInventories } from '../sync-inventory.mjs';
import {
  detectPackageManager,
  packageManagerInvocation,
  addDevDepsArgs,
  displayAddDev,
  SUPPORTED_PACKAGE_MANAGERS,
} from '../package-manager.mjs';

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
  // DROPPED 2026-08-11: `@playwright/test`. It was only ever in the derived set
  //   because `ux-lock/candidate-spec.mjs` RENDERED that import line into the
  //   specs it generated — a string literal the regex walker could not tell from
  //   real code. That module was deleted with the consistency-candidate
  //   promotion path, so nothing in the bundle mentions it as an import any
  //   more and the stale-entry test fires. This is exactly the "if the generator
  //   stops emitting it, re-justify or drop" case the old comment called out.
  //   Consumers running /ux-lock specs still need the package, and they still
  //   get it: `playwright-runner.mjs` resolves `@playwright/test/cli` at runtime
  //   and falls back to `npx` when it is unresolvable. Declaring it here would
  //   now be a claim about the import graph that is false.
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
 * Argv prefix that runs npm without a shell.
 *
 * **Why not just `execFileSync('npm', …)`.** On Windows the npm on PATH is
 * `npm.cmd`, and Node >= 22.19 refuses to spawn `.cmd` without `shell: true`
 * (CVE-2024-27980 hardening) — bare `'npm'` fails ENOENT, `'npm.cmd'` fails
 * EINVAL. So dependency auto-install had never once run on Windows: every
 * sync printed "Installing required audit-loop deps", failed ENOENT, and
 * fell through to the manual-command hint. That silence is why the
 * REQUIRED_DEPS drift in upstream#57 stayed invisible for so long — the
 * mechanism meant to repair it was itself dead.
 *
 * `shell: true` would fix the spawn and reopen quoting pitfalls on
 * caller-influenced argv. Instead run npm's own JS entry point under the
 * CURRENT node binary — no shell, no `.cmd`, no quoting.
 *
 * Retained as the npm-specific entry point for callers that legitimately mean
 * npm and not "whatever this repo uses" — `update-auditloop.mjs` updates the
 * audit-loop clone itself, which is an npm repo. Consumer-facing code wants
 * {@link packageManagerInvocation} instead.
 *
 * @returns {{bin: string, prefix: string[]}}
 */
export function npmInvocation() {
  const { bin, prefix } = packageManagerInvocation('npm');
  return { bin, prefix };
}

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
 *   action: 'installed' | 'already-satisfied' | 'no-package-json' | 'failed'
 *         | 'ambiguous-package-manager' | 'invalid-package-manager-declaration'
 *         | 'manual-install-required',
 *   installed: string[],
 *   installedOptional: string[],
 *   failed: string[],
 *   packageManager?: string,
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

  const pm = detectPackageManager(repoRoot);
  const all = [...missing, ...missingOptional];

  // Ambiguity/invalid-declaration/unsupported-manager refusal has to run BEFORE
  // the dry-run branch, not after (round-1 audit M9, 2026-08-15) — otherwise
  // `--dry-run` on exactly the repos this module exists to protect (two
  // lockfiles, or a typo'd `packageManager`) silently reported "would
  // install via <guessed manager>" instead of the same refusal a real run
  // would give, which is the one case a dry-run must not lie about.

  // A `packageManager` field is present but does not parse — do not fall
  // through to a lockfile guess, which may be stale (e.g. left over from
  // before a migration to the declared-but-typo'd manager).
  if (pm.invalidDeclaration) {
    process.stderr.write(
      `  ${Y}⚠${X} ${path.basename(repoRoot)}: package.json "packageManager" field is present but unrecognised — not guessing\n`
      + `  Fix it to "<name>@<version>" (${SUPPORTED_PACKAGE_MANAGERS.join('|')}), or install manually:\n`
      + `    cd ${repoRoot} && ${displayAddDev(pm.name, all)}\n`,
    );
    return {
      action: 'invalid-package-manager-declaration', installed: [], installedOptional: [],
      failed: all, packageManager: pm.name,
    };
  }

  // Two managers' lockfiles and nothing declaring which one governs. Installing
  // with either writes a lockfile the other does not own, so the honest move is
  // to hand the decision back rather than pick — the repo cannot tell us, and
  // guessing wrong is the exact corruption this module exists to prevent.
  if (pm.ambiguous) {
    process.stderr.write(
      `  ${Y}⚠${X} ${path.basename(repoRoot)}: multiple lockfiles (${pm.candidates.join(', ')}) — not guessing a package manager\n`
      + `  Add a "packageManager" field to package.json, or install manually with the one you use:\n`
      + `    cd ${repoRoot} && ${displayAddDev(pm.candidates[0], all)}\n`,
    );
    return {
      action: 'ambiguous-package-manager', installed: [], installedOptional: [],
      failed: all, packageManager: pm.name,
    };
  }

  // Automated install is deliberately npm+pnpm only — the two managers this
  // module verifies presence for correctly. Both `node_modules/<dep>` (used by
  // findMissingDeps above): npm always populates it; pnpm symlinks every
  // DIRECT dependency there too (confirmed in this module's header). Yarn in
  // Plug'n'Play mode resolves through `.pnp.cjs` with no `node_modules` at
  // all, so the SAME presence check would report every dep "missing" and then
  // install duplicates on top of a working PnP tree (round-1 audit H2,
  // 2026-08-15) — a correctness gap, not a crash, but not one to paper over.
  // bun has no bundled JS entry point to spawn without a shell on Windows the
  // way npm/pnpm/yarn do (see `packageManagerInvocation`), so an automated bun
  // install would EINVAL there (H4/M6). Neither gap is worth solving to ship
  // pnpm support — see the plan's stated scope boundary — so yarn/bun get the
  // same honest hand-back as an ambiguous repo, never a silent wrong attempt.
  if (pm.name !== 'npm' && pm.name !== 'pnpm') {
    process.stderr.write(
      `  ${Y}⚠${X} ${path.basename(repoRoot)}: automated install supports npm/pnpm only — not attempting an unverified ${pm.name} install\n`
      + `  Install manually:\n`
      + `    cd ${repoRoot} && ${displayAddDev(pm.name, all)}\n`,
    );
    return {
      action: 'manual-install-required', installed: [], installedOptional: [],
      failed: all, packageManager: pm.name,
    };
  }

  if (dryRun) {
    if (!quiet) {
      if (missing.length) process.stderr.write(`  ${Y}~${X} ${path.basename(repoRoot)}: would install required via ${pm.name} — ${missing.join(', ')}\n`);
      if (missingOptional.length) process.stderr.write(`  ${Y}~${X} ${path.basename(repoRoot)}: would install optional via ${pm.name} — ${missingOptional.join(', ')}\n`);
    }
    return {
      action: missing.length > 0 ? 'installed' : 'already-satisfied',
      installed: missing, installedOptional: missingOptional, failed: [],
      packageManager: pm.name,
    };
  }

  const installed = [];
  const installedOptional = [];
  const failed = [];

  /**
   * One install attempt, adjudicated by RE-PROBING the tree rather than by the
   * exit code.
   *
   * A non-zero exit does not mean the packages are absent. pnpm 11 blocks
   * dependency build scripts by default and then exits 1 with
   * `ERR_PNPM_IGNORED_BUILDS` to force a decision — measured 2026-08-15, where
   * all 12 required deps installed correctly and the run still reported
   * failure, because `@google/genai` and `protobufjs` ship postinstall scripts.
   * Keying on that error code would be brittle (it is version- and
   * manager-specific); asking the filesystem the question we actually care
   * about — "are they there now?" — cannot rot the same way, and it also
   * catches a partial install that exited 0.
   *
   * The exit-code error is kept as an ADVISORY when the deps did land, since
   * ignored build scripts are still worth telling the operator about.
   *
   * @param {string[]} pkgs
   * @returns {{stillMissing: string[], err: Error|null}}
   */
  const installAndVerify = (pkgs) => {
    let err = null;
    try {
      const { bin, prefix, shell } = packageManagerInvocation(pm.name);
      execFileSync(bin, [...prefix, ...addDevDepsArgs(pm.name, pkgs)], {
        cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, shell,
      });
    } catch (e) {
      err = e;
    }
    const nodeModules = path.join(repoRoot, 'node_modules');
    return { stillMissing: pkgs.filter(p => !fs.existsSync(path.join(nodeModules, p))), err };
  };

  /** First interesting line of a manager's failure output (it may use stdout). */
  const advisory = (err) => {
    const text = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`;
    const line = text.split('\n').map(s => s.trim()).find(s => /^\[?ERR|error/i.test(s));
    return (line || err?.message || '').slice(0, 200);
  };

  if (missing.length > 0) {
    process.stderr.write(`  ${D}Installing required audit-loop deps in ${path.basename(repoRoot)} via ${pm.name}: ${missing.join(', ')}${X}\n`);
    const { stillMissing, err } = installAndVerify(missing);
    if (stillMissing.length > 0) {
      failed.push(...stillMissing);
      process.stderr.write(`  ${Y}⚠${X} ${pm.name} install failed: ${advisory(err) || 'packages absent after install'}\n`);
      process.stderr.write(`  Run manually: cd ${repoRoot} && ${displayAddDev(pm.name, stillMissing)}\n`);
      return {
        action: 'failed', installed, installedOptional, failed,
        packageManager: pm.name, error: err?.message || `still missing: ${stillMissing.join(', ')}`,
      };
    }
    installed.push(...missing);
    process.stderr.write(`  ${G}✓${X} Required deps installed\n`);
    if (err) process.stderr.write(`  ${Y}○${X} ${pm.name} reported: ${advisory(err)}\n`);
  }

  if (missingOptional.length > 0) {
    process.stderr.write(`  ${D}Installing optional audit-loop deps in ${path.basename(repoRoot)} via ${pm.name}: ${missingOptional.join(', ')}${X}\n`);
    const { stillMissing, err } = installAndVerify(missingOptional);
    installedOptional.push(...missingOptional.filter(p => !stillMissing.includes(p)));
    if (stillMissing.length > 0) {
      failed.push(...stillMissing);
      process.stderr.write(`  ${Y}○${X} Optional deps unavailable (${stillMissing.join(', ')}) — audit will degrade gracefully\n`);
    } else {
      process.stderr.write(`  ${G}✓${X} Optional deps installed\n`);
      if (err) process.stderr.write(`  ${Y}○${X} ${pm.name} reported: ${advisory(err)}\n`);
    }
  }

  return {
    action: installed.length > 0 ? 'installed' : 'already-satisfied',
    installed, installedOptional, failed, packageManager: pm.name,
  };
}
