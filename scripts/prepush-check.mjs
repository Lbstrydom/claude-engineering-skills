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
import { dependencySetChanged } from './lib/dependency-identity.mjs';
import { countTopLevelEntries, findNodeModules } from './lib/node-modules-resolver.mjs';
import { GIT_LOCK_RETRY_DELAYS_MS, withGitLockRetry } from './lib/git-lock-retry.mjs';
import { sanitizeGitEnv } from './lib/git-env-sanitize.mjs';
import {
  STALE_SANDBOX_AGE_MS,
  removeSandboxDir,
  sweepStaleSandboxes,
} from './lib/prepush-sandbox-cleanup.mjs';

const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

/**
 * `git worktree add/remove/prune` write to the SHARED repo's common
 * .git/config and .git/worktrees/ metadata — the exact resource a concurrent
 * process's own git activity can transiently lock (anthropics/claude-code
 * #34645/#55724 — see the core.bare incident note below). Wrap them in
 * lib/git-lock-retry's exponential backoff so a lock held for a few hundred
 * ms by a peer that's about to release it doesn't hard-fail the sandbox.
 * (Distinct from a stale/corrupted VALUE written mid-run, which the
 * worktree-scoped core.bare pin further down already closes — retrying
 * doesn't undo a bad value that's already durably on disk.)
 */
function gitWithLockRetry(repoRoot, args, opts = {}) {
  return withGitLockRetry(
    () => execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'], ...opts }),
    {
      onRetry: (attempt, delayMs) => log(
        `  ⚠ git ${args.join(' ')} hit lock contention (concurrent session?) — ` +
        `retry ${attempt + 1}/${GIT_LOCK_RETRY_DELAYS_MS.length} in ${delayMs}ms`,
      ),
    },
  );
}

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
 * which is almost always. When the lockfile or a dependency-relevant
 * `package.json` field differs we must install, or we'd be testing the new code
 * against the old dependency tree. "Dependency-relevant" is
 * lib/dependency-identity.mjs's business, and it fails closed; see its
 * fileoverview for why the whole-file comparison this replaced was answering a
 * broader question than the concern it was written for.
 *
 * @param {string} sandbox
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} gitEnv - sanitized env for the `npm ci` spawn
 *   (2026-07-24 audit fix M1) — `npm ci` can shell out to git for
 *   git-hosted dependency resolution; a raw `process.env` here would carry
 *   a leaked `GIT_DIR` into that path just as it would into `npm run check`
 *   itself, the exact hole the surrounding sandbox exists to close.
 * @returns {'linked'|'installed'|'skipped'}
 */
function provisionNodeModules(sandbox, repoRoot, gitEnv) {
  // Resolve node_modules the way NODE does, not as `<repoRoot>/node_modules`
  // (2026-08-11). A git worktree has none of its own, so the hard-coded path was
  // absent in every worktree and the fast path below was unreachable there —
  // every push paid `npm ci`, and the whole-file package.json compare below hid
  // it by installing anyway. Same defect the poison-pill harness fixed on
  // 2026-08-08; the walk is now shared rather than written twice.
  const mainModules = findNodeModules(repoRoot);
  // …and compare against the checkout that OWNS those modules, not blindly
  // against repoRoot. In a worktree the two differ, and comparing one
  // checkout's manifest while linking another's tree would decide "unchanged"
  // about something it never looked at. Outside a worktree they are the same
  // directory and this is byte-identical to the old behaviour.
  const modulesOwner = mainModules ? path.dirname(mainModules) : repoRoot;
  const lockMain = path.join(modulesOwner, 'package-lock.json');
  const lockSandbox = path.join(sandbox, 'package-lock.json');
  // Also compare package.json (item 5 — sast-sandbox-backlog-hardening.md):
  // a pushed commit can edit dependency declarations without touching the
  // lockfile (e.g. a manually hand-edited package.json whose npm install
  // hasn't been re-run to regenerate the lock), which the lockfile-only
  // comparison would miss, reusing dependencies that don't represent the
  // commit being checked.
  //
  // But compare only the fields that DECIDE the tree, not the whole file
  // (2026-08-11). A whole-file compare answered a much broader question than
  // the concern it was written for: e7e182ea added one `scripts` entry, touched
  // no lockfile, and paid a full 410-package `npm ci`. In a worktree the
  // sandbox's file is compared against the MAIN checkout's, which is usually on
  // a different commit, so `scripts`/`version`/formatting churn made the fast
  // path unreachable on nearly every push. `dependencySetChanged` fails CLOSED
  // — unreadable, unparseable, or an unexpected field shape all install.
  const pkgMain = path.join(modulesOwner, 'package.json');
  const pkgSandbox = path.join(sandbox, 'package.json');

  const readOrNull = (p) => {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  };
  const filePairChanged = (a, b) => {
    try {
      return fs.readFileSync(a, 'utf8') !== fs.readFileSync(b, 'utf8');
    } catch {
      return true; // can't prove they match → install rather than assume
    }
  };
  const deps = dependencySetChanged(readOrNull(pkgMain), readOrNull(pkgSandbox));
  // The lockfile stays a WHOLE-file comparison: it is a resolved-tree artifact
  // with no non-dependency sections, so every byte of it is dependency-relevant.
  const lockChanged = filePairChanged(lockMain, lockSandbox) || deps.changed;
  // Name the cause of every install. A silent 40s pause mid-push is
  // indistinguishable from a hang, and "which input moved" is the first thing
  // you need — this branch was previously taken on every worktree push with no
  // output at all, which is how it went unnoticed.
  if (!mainModules) {
    log(`  no node_modules found at or above ${repoRoot} — installing`);
  } else if (lockChanged) {
    log(`  dependency tree may differ — installing (${
      deps.changed ? deps.reason : 'package-lock.json differs between the checkouts'})`);
  }

  if (!lockChanged && mainModules) {
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
    cwd: sandbox, stdio: 'inherit', shell: IS_WIN, ...(gitEnv ? { env: gitEnv } : {}),
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

/**
 * Remove the sandbox worktree AND verify its directory is actually gone.
 *
 * The exit code of `git worktree remove` is not evidence of removal. Measured
 * 2026-08-01: with a `node_modules` inside — which provisionNodeModules() puts
 * there on EVERY run, as a junction on the linked path or a real tree on the
 * installed one, and both reproduce — git deregisters the worktree, deletes
 * the tracked files, EXITS 0, and leaves the directory standing. So the
 * pre-2026-08-01
 * fallback `rmSync` never ran: it sat in the `catch` of a call that always
 * succeeded, and 21 husks accumulated in %TEMP% in three days with zero signal.
 * Only the `stat` inside removeSandboxDir() can close that gap.
 *
 * Ordering also changed. `git worktree prune` now runs AFTER the directory is
 * removed, and only when git's own removal failed. Pruning first (the old
 * order) deregisters the worktree while the directory may still be there,
 * converting a visible husk into an invisible one — `git worktree list`, the
 * one command that would have surfaced it, then reports clean.
 */
function removeWorktree(sandbox, repoRoot) {
  let gitRemoveFailed = false;
  try {
    gitWithLockRetry(repoRoot, ['worktree', 'remove', '--force', sandbox]);
  } catch {
    // Metadata already gone, a file locked on Windows, or lock contention that
    // outlasted the retry budget. Not decisive either way — the stat below is.
    gitRemoveFailed = true;
  }

  const { removed, error } = removeSandboxDir(sandbox);
  if (!removed) {
    // Do NOT swallow. An unbounded silent leak teaches nobody anything until
    // the temp volume fills; the path on stderr costs one line and makes the
    // next occurrence self-diagnosing.
    log(`  ⚠ pre-push sandbox could not be removed: ${sandbox}`);
    log(`    ${error?.code ? `${error.code}: ` : ''}${error?.message ?? 'unknown error'}`);
    log('    Delete it by hand to reclaim the space; a later push sweeps husks over '
      + `${STALE_SANDBOX_AGE_MS / 3_600_000}h old.`);
  }

  // Only touch shared worktree metadata when git's own removal didn't already
  // do it — every write here contends with concurrent sessions on the same
  // .git locks (the #34645/#55724 class), so an unconditional prune would add
  // a shared-metadata write to every push to fix a path that rarely runs.
  if (gitRemoveFailed) {
    try { gitWithLockRetry(repoRoot, ['worktree', 'prune']); } catch { /* noop */ }
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

  // Self-heal before building a new one. Single-run cleanup cannot be made
  // total on Windows — a SIGKILL, a held handle, or a lost race with an AV
  // scanner all defeat it — so a later run removes what an earlier one could
  // not. Deliberately advisory: an uncleanable temp directory is MACHINE
  // state, and machine state may warn but must never block a push.
  try {
    const { swept, failed } = sweepStaleSandboxes(os.tmpdir());
    if (swept.length) log(`  swept ${swept.length} stale sandbox husk(s) from ${os.tmpdir()}`);
    if (failed.length) log(`  ⚠ ${failed.length} stale sandbox husk(s) still un-removable, e.g. ${failed[0]}`);
    // Metadata written only when there was something to reconcile: a husk from
    // an interrupted run can still be REGISTERED, so its directory disappearing
    // is exactly when `git worktree list` needs pruning to stop showing a
    // corpse pointing into temp.
    if (swept.length) {
      try { gitWithLockRetry(repoRoot, ['worktree', 'prune']); } catch { /* noop */ }
    }
  } catch (err) {
    log(`  ⚠ stale-sandbox sweep failed (continuing): ${err.message}`);
  }

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
      gitWithLockRetry(repoRoot, ['worktree', 'add', '--detach', '--quiet', sandbox, headSha]);
    } catch (err) {
      throw new Error(`could not create sandbox worktree: ${err.stderr?.toString().trim() || err.message}`);
    }

    // Pin a worktree-SCOPED core.bare=false so this sandbox survives a
    // concurrent external write to the shared repo's common .git/config
    // (2026-07-23 incident: a concurrent process — most likely another
    // Claude Code session's own worktree/git activity racing on the same
    // .git/config.lock, a documented class of bug in anthropics/claude-code
    // issues #34645 and #55724 — was observed repeatedly flipping
    // core.bare=true on the shared common config mid-run).
    //
    // This works, and is SAFE, in a way the two env-var approaches tried and
    // rejected earlier were not: `git config --worktree` writes to a file
    // scoped to THIS worktree (.git/worktrees/<name>/config.worktree), not a
    // process-tree-wide environment variable — so it cannot leak into tests
    // that spawn their OWN independent throwaway git repos (verified live:
    // a nested `git init` inside this sandbox is completely unaffected).
    // Requires extensions.worktreeConfig (already enabled on this repo,
    // apparently by the harness itself when provisioning worktrees — without
    // it, core.bare in the common config already applies to the main
    // worktree only, per git-worktree(1), so this is a no-op-but-harmless
    // defensive write either way). Best-effort: a failure here still leaves
    // the run exactly as unprotected as it always was, never worse.
    try {
      execFileSync('git', ['config', '--worktree', 'core.bare', 'false'], { cwd: sandbox, stdio: 'ignore' });
    } catch { /* best-effort hardening — see comment above */ }

    // Computed once, reused both for `npm ci` below (audit fix M1) and for
    // the `npm run check` env built further down — one sanitized-env call
    // per push, not two.
    const gitEnv = sanitizeGitEnv(repoRoot);

    // Snapshotted BEFORE provisioning links the sandbox's node_modules into
    // this path, so a legitimate `npm ci` fallback (which never touches the
    // main checkout) can never trip the postcondition check below — only the
    // 'linked' path, where the sandbox and the main checkout share the exact
    // same directory on disk, can.
    const mainModulesForGuard = findNodeModules(repoRoot);
    const preRunEntryCount = mainModulesForGuard ? countTopLevelEntries(mainModulesForGuard) : null;

    const modules = provisionNodeModules(sandbox, repoRoot, gitEnv);
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
      // Sanitized, NOT raw process.env (2026-07-23 — the actual root cause of
      // six live HEAD-corruption incidents this session, confirmed empirically
      // and by git's own githooks(5) docs: git's hook-invocation machinery
      // exports GIT_DIR/GIT_WORK_TREE/etc into THIS hook's process, and a raw
      // `...process.env` here would hand that straight to `npm run check`
      // below. Any test that then builds an "isolated" fixture repo via
      // `git init`/`git commit` with an explicit `cwd` gets no isolation at
      // all — git gives GIT_DIR precedence over cwd, so the fixture's commits
      // land on THIS repo's real HEAD instead (verified live: synthetic
      // commits reading "seed", "init", "add data + readme" — the literal
      // strings from tests/diff-scope-resolver.test.mjs's fixture helper —
      // repeatedly overwrote HEAD mid-push). sanitizeGitEnv() is the Node
      // equivalent of git's own documented fix, `unset $(git rev-parse
      // --local-env-vars)` — git's own versioned var list, not a guessed one.
      ...gitEnv,
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
      // NOTE (2026-07-23): a GIT_WORK_TREE=sandbox override was tried here to
      // immunize this run against a mid-run core.bare flip on the shared
      // repo's .git/config. Live-tested end-to-end (corrupted core.bare while
      // this spawnSync was in flight) and REJECTED — it broke tests that
      // create their OWN throwaway git repos as fixtures (e.g.
      // known-defect-corpus.test.mjs, drift-stale-pragma.test.mjs):
      // `fatal: GIT_WORK_TREE (or --work-tree=<directory>) not allowed
      // without specifying GIT_DIR`. GIT_WORK_TREE is a process-tree-wide env
      // override, not a per-command one — it applies to every nested `git`
      // call this process's descendants make, REGARDLESS of their own cwd, so
      // it can't be scoped narrowly enough for a suite that spawns its own
      // independent repos. See .githooks/pre-push for the full incident note
      // and the (also-rejected) GIT_CONFIG_KEY_0 alternative. No env-var fix
      // was found; the mid-run flip remains a known, unmitigated gap — retry
      // or `git push --no-verify` if it recurs.
    };
    if (!base) {
      log('  ⚠ no push base supplied — drift gates will infer their range (may under-scope)');
    }

    const r = spawnSync(NPM, ['run', 'check'], { cwd: sandbox, stdio: 'inherit', shell: IS_WIN, env });
    if (r.error) throw new Error(`could not run checks: ${r.error.message}`);

    // Postcondition, not a hope: only 'linked' means the sandbox's
    // node_modules IS the main checkout's directory (a junction, not a
    // copy), so this is the one path where something during the run —
    // teardown, a test's own fs cleanup, anything — could reach through and
    // delete real installed packages. Checked regardless of `r.status`: a
    // check that "passed" against a node_modules that lost packages mid-run
    // proved nothing, and a check that failed deserves the real explanation
    // instead of a wall of misleading ERR_MODULE_NOT_FOUND.
    if (modules === 'linked' && mainModulesForGuard && preRunEntryCount !== null) {
      const postRunEntryCount = countTopLevelEntries(mainModulesForGuard);
      if (postRunEntryCount !== null && postRunEntryCount < preRunEntryCount) {
        throw new Error(
          `CRITICAL: the main checkout's node_modules shrank during this run `
          + `(${preRunEntryCount} -> ${postRunEntryCount} entries) at ${mainModulesForGuard}. `
          + 'Something reached through the sandbox link and deleted real installed packages. '
          + 'Run `npm install` to restore them. Please report this — see the incident note in '
          + 'scripts/lib/prepush-sandbox-cleanup.mjs.',
        );
      }
    }

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
