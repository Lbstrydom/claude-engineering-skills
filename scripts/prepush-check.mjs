#!/usr/bin/env node
/**
 * @fileoverview Run `npm run check` against a CLEAN CHECKOUT of the commit
 * being pushed, in a throwaway git worktree, instead of against the working
 * tree.
 *
 * WHY (the two defects this closes):
 *
 *   1. FALSE BLOCKS. Two concurrent agent sessions share one working tree.
 *      Session A pushes; the hook runs the checks over session B's half-written
 *      edits and blocks a push whose own commits are fine. The gate becomes
 *      noise, and noise gets `--no-verify`'d — which silently disarms it.
 *
 *   2. FALSE PASSES (the more dangerous one). Working-tree checking verifies an
 *      artifact nobody receives. A fix that is present in the tree but NOT in
 *      the commit — unstaged, or belonging to the other session's change set —
 *      makes the hook green while the pushed commit is broken. Only a clean
 *      checkout tests what the remote actually gets.
 *
 * WHY NOT `git stash`: with two live sessions, stashing yanks the other
 * session's files out from under it mid-edit, and a pop conflict wedges both.
 * It also violates the repo's standing rule against auto-stashing unrelated
 * work (AGENTS.md "Scope discipline"). A worktree touches nothing the other
 * session can observe.
 *
 * THE SANDBOX-HONESTY INVARIANT (load-bearing): a fresh worktree has no
 * gitignored inputs, so any check that DEGRADES to a skip on a missing input
 * would turn this into a gate that passes having read less. Two such paths
 * exist, and the sandbox converts both into hard errors:
 *   · AUDIT_PUSH_RANGE_REQUIRED=1      — drift gates may not infer a range
 *                                         (a detached tree always infers HEAD~1)
 *   · ARCH_COVERAGE_REQUIRE_ENVELOPE=1 — the observed-graph gate may not skip
 * Anything that makes a check silently no-op in a clean checkout must be added
 * here as a hard requirement, not tolerated.
 *
 * Escape hatches: AUDIT_PREPUSH_SANDBOX=0 runs the checks in-tree (old
 * behaviour); `git push --no-verify` skips the hook entirely.
 *
 * Usage (normally invoked by .githooks/pre-push, not by hand):
 *   node scripts/prepush-check.mjs --base <sha> --head <sha>
 *
 * Exit codes: the checks' own exit code, or 1 on a sandbox setup failure.
 *   A setup failure is NEVER reported as success — an unbuildable sandbox
 *   means the push was not verified.
 *
 * @module scripts/prepush-check
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './lib/cli-io.mjs';

const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

/** Gitignored/untracked files that must be copied into the sandbox for a check
 *  to be meaningful.
 *
 *  Provisioning vs. a strictness flag — pick by WHO owns the input:
 *  · Input is machine-derived evidence that should always exist (the DB graph)
 *    → a REQUIRE flag is right; absent means something is broken.
 *  · Input is OPERATOR CONFIG that may legitimately not exist (opt-in policy
 *    files) → provisioning is right. A require flag there would fail every push
 *    in a repo that simply hasn't opted in, and the honest reading of "absent
 *    in the main checkout too" is genuinely "not configured".
 *  The failure mode being closed is the middle case: the operator HAS opted in,
 *  but the clean checkout doesn't see it, so the gate silently runs disabled
 *  while they believe it is on. */
const PROVISIONED_ARTIFACTS = [
  // DB-derived, not commit-derived, so the main checkout's copy is the correct
  // evidence for any commit. Absent → arch:coverage-gate would exit 0 blind.
  '.audit-loop/domain-deps-observed.json',
];

/** Untracked OPERATOR CONFIG: copied when present, silently skipped when not.
 *
 *  Deliberately NOT in PROVISIONED_ARTIFACTS — a missing entry there THROWS and
 *  blocks the push, which is right for machine-derived evidence ("absent means
 *  something is broken") and wrong for opt-in policy files ("absent means not
 *  configured", the state this repo and most consumers are in today). Putting
 *  them in the required list would fail every push for everyone who hasn't
 *  opted in.
 *
 *  The hole being closed is the middle case: the operator HAS a config, but the
 *  clean checkout can't see it, so the gate runs disabled while they believe it
 *  is on. Absent in the main checkout too → genuinely not configured → the
 *  sandbox reading matches the in-tree reading, which is honest. */
const OPTIONAL_ARTIFACTS = [
  // Absent → loadEfficacyConfig() falls to schema defaults (enabled:false) and
  // efficacy-lints-check exits 0 with ZERO output.
  'efficacy-lints.config.json',
  // Absent → check-context-drift falls to DEFAULT_ALLOWLIST and default line
  // ceilings, so a repo that TIGHTENED its limits gets silently loosened.
  // `--strict` only covers a malformed config, never an absent one.
  '.claude-context-allowlist.json',
];

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Provision node_modules. A junction/symlink to the main checkout is ~instant
 * and correct WHENEVER the dependency set is unchanged by the pushed commit —
 * which is almost always. When package-lock.json differs we must install, or
 * we'd be testing the new code against the old dependency tree.
 *
 * @returns {'linked'|'installed'|'skipped'}
 */
function provisionNodeModules(sandbox, repoRoot) {
  const mainModules = path.join(repoRoot, 'node_modules');
  const lockMain = path.join(repoRoot, 'package-lock.json');
  const lockSandbox = path.join(sandbox, 'package-lock.json');

  const lockChanged = (() => {
    try {
      return fs.readFileSync(lockMain, 'utf8') !== fs.readFileSync(lockSandbox, 'utf8');
    } catch {
      return true; // can't prove they match → install rather than assume
    }
  })();

  if (!lockChanged && fs.existsSync(mainModules)) {
    try {
      // 'junction' is Windows-only and needs no elevation; other platforms
      // ignore the type and create a directory symlink.
      fs.symlinkSync(mainModules, path.join(sandbox, 'node_modules'), 'junction');
      return 'linked';
    } catch (err) {
      log(`  node_modules link failed (${err.message}) — falling back to install`);
    }
  }

  // --ignore-scripts: the `prepare` lifecycle runs install-git-hooks.mjs, which
  // writes core.hooksPath. That config is shared with the main checkout, so
  // letting it run from a throwaway worktree could repoint the real repo's hooks.
  const r = spawnSync(NPM, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: sandbox, stdio: 'inherit', shell: IS_WIN,
  });
  if (r.status !== 0) throw new Error(`npm ci failed in sandbox (exit ${r.status})`);
  return 'installed';
}

function copyIfPresent(sandbox, repoRoot, rel) {
  const src = path.join(repoRoot, rel);
  if (!fs.existsSync(src)) return false;
  const dest = path.join(sandbox, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

/** @returns {{missing: string[], carried: string[]}} — `missing` is REQUIRED
 *  artifacts only (the caller throws on those); `carried` is the optional
 *  operator configs that were actually found, reported so the log says which
 *  policy the run used rather than leaving it ambiguous. */
function provisionArtifacts(sandbox, repoRoot) {
  const missing = [];
  for (const rel of PROVISIONED_ARTIFACTS) {
    if (!copyIfPresent(sandbox, repoRoot, rel)) missing.push(rel);
  }
  const carried = OPTIONAL_ARTIFACTS.filter(rel => copyIfPresent(sandbox, repoRoot, rel));
  return { missing, carried };
}

function removeWorktree(sandbox, repoRoot) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', sandbox], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    // The worktree metadata may already be gone, or a file may be locked on
    // Windows. Prune so `git worktree list` doesn't accumulate corpses, and
    // best-effort rm the directory.
    try { execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' }); } catch { /* noop */ }
    // Windows holds handles briefly after a process exits — retry rather than
    // leak the directory (repo-wide rmSync hardening contract).
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* noop */ }
  }
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const repoRoot = git(['rev-parse', '--show-toplevel']);
  const head = argValue('--head') || 'HEAD';
  const base = argValue('--base');

  const headSha = git(['rev-parse', '--verify', `${head}^{commit}`]);
  const shortSha = headSha.slice(0, 8);
  const sandbox = path.join(os.tmpdir(), `ces-prepush-${shortSha}-${process.pid}`);

  log(`→ Pre-push checks in a clean checkout of ${shortSha} (not the working tree)`);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    removeWorktree(sandbox, repoRoot);
  };
  // A killed hook must not leave worktrees behind; git would keep listing them.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanup(); process.exit(130); });
  }

  try {
    try {
      execFileSync('git', ['worktree', 'add', '--detach', '--quiet', sandbox, headSha], {
        cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      throw new Error(`could not create sandbox worktree: ${err.stderr?.toString().trim() || err.message}`);
    }

    const modules = provisionNodeModules(sandbox, repoRoot);
    const { missing, carried } = provisionArtifacts(sandbox, repoRoot);
    if (missing.length) {
      // Do not proceed into a run whose gates we have just told to be strict —
      // that would fail confusingly. Say exactly what is missing and why.
      throw new Error(
        `sandbox is missing required local artifact(s): ${missing.join(', ')}\n` +
        `  These are gitignored and must be copied from the main checkout.\n` +
        `  Run \`npm run arch:render\` (or \`npm run dashboard:setup\`) and retry.`,
      );
    }
    log(`  sandbox ready (node_modules: ${modules})`);
    // Name the operator configs that came across. Silence would leave "gate ran
    // with your policy" and "gate ran with defaults" indistinguishable — the
    // exact ambiguity this provisioning exists to remove.
    if (carried.length) log(`  operator config carried in: ${carried.join(', ')}`);

    const env = {
      ...process.env,
      // Drift gates get the REAL range instead of inferring one. Without this a
      // detached checkout resolves every drift base to HEAD~1.
      ...(base ? { AUDIT_PUSH_RANGE_BASE: base } : {}),
      AUDIT_PUSH_RANGE_HEAD: headSha,
      // Sandbox-honesty: forbid the two silent-skip paths (see fileoverview).
      // Only meaningful with a real base — without one, inference is all there is.
      ...(base ? { AUDIT_PUSH_RANGE_REQUIRED: '1' } : {}),
      ARCH_COVERAGE_REQUIRE_ENVELOPE: '1',
      // Marks the run for any check that wants to report its context.
      AUDIT_PREPUSH_SANDBOX_ACTIVE: '1',
    };
    if (!base) {
      log('  ⚠ no push base supplied — drift gates will infer their range (may under-scope)');
    }

    const r = spawnSync(NPM, ['run', 'check'], { cwd: sandbox, stdio: 'inherit', shell: IS_WIN, env });
    if (r.error) throw new Error(`could not run checks: ${r.error.message}`);
    return r.status ?? 1;
  } catch (err) {
    log(`✗  pre-push sandbox failed: ${err.message}`);
    log('   The push was NOT verified. Fix the above, or bypass with: git push --no-verify');
    log('   To run the checks against the working tree instead: AUDIT_PREPUSH_SANDBOX=0');
    return 1;
  } finally {
    cleanup();
  }
}

process.exit(main());
