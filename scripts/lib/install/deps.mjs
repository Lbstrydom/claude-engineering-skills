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
 * `node_modules/<dep>/package.json` probe below needs no such adjustment: pnpm
 * symlinks every DIRECT dependency there, every dep we install is direct, and
 * `existsSync` follows the symlink to the real manifest.
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
 * Per-phase install caps.
 *
 * **Why two numbers and not one.** There used to be a single 120s cap covering
 * both phases. The optional set contains `playwright`, whose tarball is orders
 * of magnitude larger than anything in the required set, so one number sized
 * for the required phase silently under-bounded the optional one. Measured
 * 2026-09-04 on Windows: the required install exceeded 120s, was killed, and
 * the deps had landed anyway (the re-probe below rescued it); the optional
 * install then ate a second 120s and was killed too. Two phases × one cap is
 * also how the caller's own bound got out of step — see `installTimeouts`.
 *
 * These are ceilings on a network operation, not budgets: on a warm cache both
 * phases finish in seconds, and the only thing a generous ceiling costs is how
 * long a genuinely wedged install takes to give up.
 */
export const DEFAULT_REQUIRED_INSTALL_TIMEOUT_MS = 300_000;
export const DEFAULT_OPTIONAL_INSTALL_TIMEOUT_MS = 600_000;

/**
 * Node's documented maximum timer delay (2**31 - 1 ms, ~24.9 days). A `timeout`
 * beyond it is outside the range `setTimeout` supports, so no cap this module
 * hands to `execFileSync` may exceed it.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The one validation boundary every timeout source passes through.
 *
 * `execFileSync` reads `timeout: 0` as NO TIMEOUT, so an unvalidated value does
 * not merely mis-size the cap — it removes it, which is the opposite of what
 * anyone setting a timeout intends. A negative, fractional or non-numeric value
 * is the same class of mistake. All of them fall back to the default rather
 * than being passed through.
 *
 * Applied to the explicit `timeoutMs` argument as well as to the env vars: an
 * in-process caller is no more trustworthy than an env var here, and routing
 * only one of the two through validation is how the gap arose in the first
 * place (round-1 code audit H5/M2, 2026-09-04 — `installTimeouts({timeoutMs:0})`
 * returned `{requiredMs: 0}`, i.e. an uncapped install).
 *
 * The upper bound is `MAX_TIMEOUT_MS`, Node's documented maximum timer delay —
 * NOT an arbitrary policy maximum. Within it, a large cap is a deliberate
 * operator decision about how long to wait, and this module imposes no opinion
 * on it.
 *
 * **What was and was not measured** (round-2 code audit M1/M3, 2026-09-04). The
 * finding claimed a value past that range "can produce incorrect timeout
 * behavior or runtime failures". That did NOT reproduce: with a verified
 * positive control (a 300ms cap killing a 3s child at 318ms), `timeout` values
 * of 2**31 and 2**32 let the child run to completion with no clamp-kill and no
 * `TimeoutOverflowWarning`. The bound is here because those values are outside
 * the range `setTimeout` documents as supported, and leaning on undocumented
 * behaviour is its own defect — not because a failure was observed.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger` is the half that is
 * load-bearing today: `installTimeouts` returns `requiredMs + optionalMs`, and
 * past 2**53 that sum stops being exact.
 *
 * Out-of-range values FALL BACK rather than throwing, matching how this
 * function already treats junk: an over-large number is a plausible typo (one
 * digit too many), and quietly using the default is safer than aborting a sync
 * over it. The caller is told which cap it got by the messages that name it.
 *
 * @param {unknown} raw — an env string, an explicit number, or nothing
 * @param {number} fallback
 * @returns {number}
 */
function positiveIntTimeout(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_TIMEOUT_MS ? n : fallback;
}

/**
 * The caps a given call will actually use — the single oracle for "how long can
 * this take at most".
 *
 * Exported because a CALLER that bounds `ensureAuditDeps` from the outside (a
 * test driving the sync in a subprocess, say) must derive its own budget from
 * these rather than hardcode a second number. Two independently-chosen bounds
 * is how the outer one ended up TIGHTER than the inner one: the sync's own
 * per-phase caps summed to exactly the 240s the test allowed the whole
 * subprocess, so a slow network killed the parent — reported as a bare
 * `null !== 0` with no mention of an install anywhere in the assertion.
 *
 * @param {{timeoutMs?: number, env?: Record<string, string|undefined>}} [opts]
 * @returns {{requiredMs: number, optionalMs: number, totalMs: number}}
 */
export function installTimeouts({ timeoutMs, env = process.env } = {}) {
  // Each phase's default is its own, so an invalid `timeoutMs` falls back to
  // per-phase defaults rather than collapsing both onto one number.
  const requiredMs = positiveIntTimeout(
    timeoutMs ?? env.AUDIT_DEPS_INSTALL_TIMEOUT_MS, DEFAULT_REQUIRED_INSTALL_TIMEOUT_MS);
  const optionalMs = positiveIntTimeout(
    timeoutMs ?? env.AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS, DEFAULT_OPTIONAL_INSTALL_TIMEOUT_MS);
  return { requiredMs, optionalMs, totalMs: requiredMs + optionalMs };
}

/**
 * Did this install attempt die on the CAP rather than on its own exit code?
 *
 * Kept distinct because the two say opposite things about the operator's next
 * move: a non-zero exit is the manager reporting on work it finished, while a
 * kill is us cutting it off mid-flight — the same install may well succeed
 * given more time, or may already have succeeded (the re-probe decides which).
 * `execFileSync` reports the kill as `code:'ETIMEDOUT'`, a string, where an
 * ordinary failure's `code` is the numeric exit status — so the two can never
 * be confused (verified 2026-09-04, Windows + Node 22).
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isInstallTimeout(err) {
  return err?.code === 'ETIMEDOUT' || err?.killed === true;
}

/** Human-readable cap, for operator messages. */
const secs = (ms) => `${Math.round(ms / 1000)}s`;

/**
 * The stable substring every cap-kill message carries.
 *
 * Exported because the return value is not always available to whoever needs
 * to know: `sync-to-repos.mjs` calls `ensureAuditDeps` and discards it, so
 * anything downstream of a sync subprocess can only read this out of stderr.
 * One spelling, one place to change it — and the test asserting on the
 * operator message keys on this rather than re-typing the wording.
 */
export const DEPS_TIMEOUT_MARKER = 'dependency install timed out';

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
/**
 * Is this dependency actually a package, or merely a directory with its name?
 *
 * The probe asks for `<dep>/package.json`, not for `<dep>`. A bare directory is
 * not evidence of an install: a partial or interrupted install can leave the
 * directory with no manifest, and the caller then reports the dependency
 * present while it cannot be loaded (round-1 code audit H1/H4, 2026-09-04).
 *
 * It stays a filesystem question rather than a resolution one on purpose. This
 * process resolves modules from the SOURCE checkout, not from the consumer, so
 * `import`-ing or `require.resolve`-ing a consumer's dependency would answer
 * about the wrong tree — and every real npm package has a manifest by
 * definition, so this distinguishes the two states the caller can actually be
 * in. Verified 2026-09-04: of every required and optional dep installed in this
 * repo, zero lack `package.json`.
 *
 * Still correct under pnpm, which is why the check is not `lstat`-based:
 * `node_modules/<dep>` is a symlink into `.pnpm/`, and `existsSync` follows it
 * to the real manifest.
 *
 * @param {string} nodeModules — absolute path to the target's `node_modules`
 * @param {string} dep — package name, possibly scoped
 * @returns {boolean}
 */
function isInstalledPackage(nodeModules, dep) {
  return fs.existsSync(path.join(nodeModules, dep, 'package.json'));
}

export function findMissingDeps(repoRoot) {
  const hasPackageJson = fs.existsSync(path.join(repoRoot, 'package.json'));
  if (!hasPackageJson) {
    return { missing: [], missingOptional: [], hasPackageJson: false };
  }
  const nodeModules = path.join(repoRoot, 'node_modules');
  const present = (dep) => isInstalledPackage(nodeModules, dep);
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
 * @param {number} [opts.timeoutMs] — override BOTH per-phase caps with one
 *   number. Omitted (the normal case) each phase uses its own cap — see
 *   {@link installTimeouts}.
 * @returns {{
 *   action: 'installed' | 'already-satisfied' | 'no-package-json' | 'failed'
 *         | 'timed-out'
 *         | 'ambiguous-package-manager' | 'invalid-package-manager-declaration'
 *         | 'manual-install-required',
 *   installed: string[],
 *   installedOptional: string[],
 *   failed: string[],
 *   packageManager?: string,
 *   error?: string,
 *   timedOut?: boolean,
 * }}
 *   `timed-out` is a DISTINCT action from `failed`: the required deps are absent
 *   in both, but only one of them is a verdict about the install itself. Anything
 *   deciding whether the consumer is broken should read `failed`/`installed`;
 *   anything deciding whether to retry or raise the cap should read this.
 *   `timedOut` is also set on an otherwise-successful result when a phase was
 *   cut off but the packages landed regardless.
 */
export function ensureAuditDeps(repoRoot, { dryRun = false, quiet = false, timeoutMs } = {}) {
  const caps = installTimeouts({ timeoutMs });
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
      + `    cd ${repoRoot} && ${displayAddDev(pm.name, all, repoRoot)}\n`,
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
      + `    cd ${repoRoot} && ${displayAddDev(pm.candidates[0], all, repoRoot)}\n`,
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
      + `    cd ${repoRoot} && ${displayAddDev(pm.name, all, repoRoot)}\n`,
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
   * A CAP-kill takes the same route deliberately: `ETIMEDOUT` is no more
   * evidence of absence than `ERR_PNPM_IGNORED_BUILDS` was, and measured
   * 2026-09-04 the required install exceeded its cap having already written
   * every package. The re-probe is what makes both cases answerable; the
   * `timedOut` flag only changes what we TELL the operator.
   *
   * @param {string[]} pkgs
   * @param {number} capMs
   * @returns {{stillMissing: string[], err: Error|null, timedOut: boolean}}
   */
  const installAndVerify = (pkgs, capMs) => {
    let err = null;
    try {
      const { bin, prefix, shell } = packageManagerInvocation(pm.name);
      execFileSync(bin, [...prefix, ...addDevDepsArgs(pm.name, pkgs, repoRoot)], {
        cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: capMs, shell,
      });
    } catch (e) {
      err = e;
    }
    // The SAME predicate `findMissingDeps` used to decide these were missing.
    // Two spellings of "is it installed" is how a re-probe starts disagreeing
    // with the check that queued the work.
    const nodeModules = path.join(repoRoot, 'node_modules');
    return {
      stillMissing: pkgs.filter(p => !isInstalledPackage(nodeModules, p)),
      err,
      timedOut: isInstallTimeout(err),
    };
  };

  /** First interesting line of a manager's failure output (it may use stdout). */
  const advisory = (err) => {
    const text = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`;
    const line = text.split('\n').map(s => s.trim()).find(s => /^\[?ERR|error/i.test(s));
    return (line || err?.message || '').slice(0, 200);
  };

  let timedOut = false;

  if (missing.length > 0) {
    process.stderr.write(`  ${D}Installing required audit-loop deps in ${path.basename(repoRoot)} via ${pm.name}: ${missing.join(', ')}${X}\n`);
    const r = installAndVerify(missing, caps.requiredMs);
    timedOut ||= r.timedOut;
    if (r.stillMissing.length > 0) {
      failed.push(...r.stillMissing);
      // A cap-kill and a manager-reported failure get different words on
      // purpose. "install failed" sends the operator looking for a broken
      // package; the honest report here is that we never let it finish, and
      // the lever is the cap, not the manifest.
      if (r.timedOut) {
        process.stderr.write(
          `  ${Y}⚠${X} ${DEPS_TIMEOUT_MARKER}: required install exceeded ${secs(caps.requiredMs)} and was killed — packages NOT verified present\n`
          + `  Raise the cap with AUDIT_DEPS_INSTALL_TIMEOUT_MS=<ms>, or install manually:\n`,
        );
      } else {
        process.stderr.write(`  ${Y}⚠${X} ${pm.name} install failed: ${advisory(r.err) || 'packages absent after install'}\n`);
      }
      process.stderr.write(`  Run manually: cd ${repoRoot} && ${displayAddDev(pm.name, r.stillMissing, repoRoot)}\n`);
      return {
        action: r.timedOut ? 'timed-out' : 'failed', installed, installedOptional, failed,
        packageManager: pm.name, timedOut: r.timedOut,
        error: r.timedOut
          ? `required install exceeded ${secs(caps.requiredMs)}; still missing: ${r.stillMissing.join(', ')}`
          : (r.err?.message || `still missing: ${r.stillMissing.join(', ')}`),
      };
    }
    installed.push(...missing);
    process.stderr.write(`  ${G}✓${X} Required deps installed\n`);
    // Landed anyway. Say WHICH thing happened — a raw `spawnSync … ETIMEDOUT`
    // under a "✓ installed" line reads as a contradiction rather than as the
    // benign case it is.
    if (r.timedOut) {
      process.stderr.write(`  ${Y}○${X} ${DEPS_TIMEOUT_MARKER}: required install exceeded ${secs(caps.requiredMs)}, but all packages verified present\n`);
    } else if (r.err) {
      process.stderr.write(`  ${Y}○${X} ${pm.name} reported: ${advisory(r.err)}\n`);
    }
  }

  if (missingOptional.length > 0) {
    process.stderr.write(`  ${D}Installing optional audit-loop deps in ${path.basename(repoRoot)} via ${pm.name}: ${missingOptional.join(', ')}${X}\n`);
    const r = installAndVerify(missingOptional, caps.optionalMs);
    timedOut ||= r.timedOut;
    installedOptional.push(...missingOptional.filter(p => !r.stillMissing.includes(p)));
    if (r.stillMissing.length > 0) {
      failed.push(...r.stillMissing);
      const why = r.timedOut
        ? `${DEPS_TIMEOUT_MARKER}: optional install exceeded ${secs(caps.optionalMs)} (raise AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS)`
        : 'unavailable';
      process.stderr.write(`  ${Y}○${X} Optional deps ${why} (${r.stillMissing.join(', ')}) — audit will degrade gracefully\n`);
    } else {
      process.stderr.write(`  ${G}✓${X} Optional deps installed\n`);
      if (r.timedOut) {
        process.stderr.write(`  ${Y}○${X} ${DEPS_TIMEOUT_MARKER}: optional install exceeded ${secs(caps.optionalMs)}, but all packages verified present\n`);
      } else if (r.err) {
        process.stderr.write(`  ${Y}○${X} ${pm.name} reported: ${advisory(r.err)}\n`);
      }
    }
  }

  return {
    action: installed.length > 0 ? 'installed' : 'already-satisfied',
    installed, installedOptional, failed, packageManager: pm.name, timedOut,
  };
}
