/**
 * @fileoverview Guards the pre-push sandbox's honesty invariants.
 *
 * The sandbox runs `npm run check` in a clean checkout of the pushed commit.
 * That fixes false blocks from a concurrent session's working-tree edits, but
 * it introduces a specific hazard: a fresh worktree has NO gitignored inputs,
 * so any check that degrades to a skip on a missing input would make the gate
 * pass having read less than the operator believes.
 *
 * Two such paths exist. Both are converted to hard errors inside the sandbox.
 * These tests pin that conversion, because the failure mode of losing it is a
 * gate that reports success — i.e. invisible until something broken ships.
 * (AGENTS.md: "audit your success paths — can this return green without having
 * actually checked anything?")
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = process.cwd();
const RUNNER = path.join(REPO, 'scripts', 'prepush-check.mjs');
const runnerSrc = fs.readFileSync(RUNNER, 'utf-8');

describe('the sandbox forbids the silent-skip paths', () => {
  it('forces drift gates to use the real push range instead of inferring one', () => {
    // A detached clean checkout has no upstream and is never dirty, so every
    // inference-based drift base collapses to HEAD~1 — scoping a multi-commit
    // push to its tip while reporting clean.
    assert.match(
      runnerSrc, /AUDIT_PUSH_RANGE_REQUIRED: '1'/,
      'the sandbox must forbid range inference; without it a drift gate silently checks one commit',
    );
  });

  it('forces the observed-graph gate to require its envelope', () => {
    assert.match(
      runnerSrc, /ARCH_COVERAGE_REQUIRE_ENVELOPE: '1'/,
      'without this the coverage gate exits 0 on the absent (gitignored) envelope',
    );
  });

  it('provisions the gitignored envelope rather than letting the gate skip', () => {
    assert.match(runnerSrc, /domain-deps-observed\.json/);
  });

  it('treats a sandbox setup failure as a failure, never as a pass', () => {
    // An unbuildable sandbox means the push was not verified. Returning 0 here
    // would be the worst possible outcome: a green gate that ran nothing.
    assert.match(runnerSrc, /return 1;/, 'the catch path must return non-zero');
    assert.doesNotMatch(
      runnerSrc, /catch[\s\S]{0,200}?return 0;/,
      'no catch path may report success',
    );
  });

  it('installs deps with --ignore-scripts so a throwaway worktree cannot repoint core.hooksPath', () => {
    // `prepare` runs install-git-hooks.mjs, which writes git config shared with
    // the main checkout.
    assert.match(runnerSrc, /--ignore-scripts/);
  });

  it('always removes its worktree, including on signals', () => {
    assert.match(runnerSrc, /worktree', 'remove'/);
    assert.match(runnerSrc, /SIGINT/, 'a killed hook must not leak worktrees');
    assert.match(runnerSrc, /finally\s*\{\s*cleanup\(\);/);
  });

  it('verifies the sandbox directory is GONE rather than trusting git\'s exit code (2026-08-01)', () => {
    // Measured: `git worktree remove --force` exits 0 while leaving the
    // directory, because the sandbox always holds a node_modules entry git
    // declines to delete. The pre-fix code put its fallback rmSync in the
    // CATCH of that call, so it never ran, and one husk leaked per push with
    // no signal whatsoever. The behavioural proof lives in
    // tests/prepush-sandbox-cleanup.test.mjs; this pins the wiring.
    assert.match(runnerSrc, /from '\.\/lib\/prepush-sandbox-cleanup\.mjs'/);
    assert.match(runnerSrc, /removeSandboxDir\(sandbox\)/,
      'removal must be stat-verified, not inferred from a subprocess exit code');
    assert.doesNotMatch(
      runnerSrc, /catch\s*\{\s*\/\* noop \*\/\s*\}\s*\n\s*\/\/ Windows holds handles/,
      'the pre-2026-08-01 swallow-and-leak shape must not return',
    );
  });

  it('reports an un-removable sandbox instead of leaking it silently', () => {
    // A silent unbounded leak teaches nobody anything until the temp volume
    // fills. The path on stderr makes the next occurrence self-diagnosing.
    const idx = runnerSrc.indexOf('could not be removed');
    assert.ok(idx !== -1, 'a failed sandbox removal must warn with the leaked path');
    assert.match(runnerSrc.slice(idx - 200, idx + 200), /\$\{sandbox\}/);
  });

  it('prunes worktree metadata AFTER removing the directory, never before', () => {
    // Pruning first deregisters the worktree while its directory may still be
    // present, turning a visible husk into an invisible one — `git worktree
    // list`, the one command that would have surfaced it, then reads clean.
    const removeIdx = runnerSrc.indexOf('removeSandboxDir(sandbox)');
    const pruneIdx = runnerSrc.indexOf("'worktree', 'prune'", removeIdx);
    assert.ok(removeIdx !== -1 && pruneIdx !== -1);
    assert.ok(pruneIdx > removeIdx,
      'the fallback prune must follow the directory removal, not precede it');
  });

  it('sweeps stale husks from earlier runs, and never lets that block a push', () => {
    // Single-run cleanup cannot be total on Windows (SIGKILL, held handles,
    // AV races), so a later run removes what an earlier one could not.
    // Temp-dir state is MACHINE state: it may warn, never block.
    assert.match(runnerSrc, /sweepStaleSandboxes\(os\.tmpdir\(\)\)/);
    const idx = runnerSrc.indexOf('sweepStaleSandboxes(os.tmpdir())');
    // Bounded by the STRUCTURE, not by a character count: a fixed ±N window
    // silently stops covering the thing it was written to cover as soon as the
    // block grows (which is exactly what a logging addition did on 2026-08-30).
    const catchIdx = runnerSrc.indexOf('catch (err)', idx);
    assert.ok(catchIdx !== -1, 'the sweep must not be able to throw out of main()');
    assert.doesNotMatch(
      runnerSrc.slice(idx, catchIdx), /return 1;/,
      'a sweep failure must never fail the push',
    );
  });

  it('says what the sweep SAW when it swept nothing (2026-08-30)', () => {
    // Silence was ambiguous: "temp is clean" and "three husks are here, all
    // younger than the threshold" printed identically, and a failing push with
    // three husks on disk was therefore read as a broken sweeper. Measured
    // afterwards, the oldest was 3h old against a 6h threshold and the sweep had
    // been exactly right. An unasked question must never render as an empty
    // result. Behaviour of `young` itself: tests/prepush-sandbox-cleanup.test.mjs.
    assert.match(runnerSrc, /const \{ swept, failed, young \} = sweepStaleSandboxes/);
    assert.match(runnerSrc, /if \(!swept\.length && young\.length\)/,
      'the "saw husks, swept none" case must be reported, and only that case');
  });

  it('pins a worktree-scoped core.bare=false on the sandbox, right after creating it (2026-07-23)', () => {
    // Live-tested fix for a concurrent process (another Claude Code session's
    // own git activity — anthropics/claude-code #34645/#55724 describe the
    // same .git/config.lock race) flipping core.bare=true on the shared
    // common config WHILE this sandbox's `npm run check` is running. Must be
    // `--worktree` scoped (a per-worktree FILE), never a bare env var — an
    // env var was tried and rejected: it leaks into tests that spawn their
    // own throwaway git repos (see the incident note in .githooks/pre-push).
    assert.match(
      runnerSrc, /config', '--worktree', 'core\.bare', 'false'/,
      'the sandbox must get its own worktree-scoped core.bare override, not a process-wide env var',
    );
    const addIdx = runnerSrc.indexOf("'worktree', 'add'");
    const pinIdx = runnerSrc.indexOf("'--worktree', 'core.bare'");
    assert.ok(addIdx !== -1 && pinIdx !== -1 && addIdx < pinIdx,
      'the worktree-scoped pin must be applied AFTER the sandbox is created, not before');
  });

  it('sanitizes git-local env vars before spawning the sandboxed check (2026-07-23)', () => {
    // The confirmed root cause of six live HEAD-corruption incidents this
    // session: raw `...process.env` here hands the hook's own leaked
    // GIT_DIR/GIT_WORK_TREE straight to `npm run check`, and any test that
    // builds a fixture git repo via `cwd` alone gets no isolation from it —
    // git gives GIT_DIR precedence over cwd. A regression here silently
    // reopens exactly that hole.
    assert.match(runnerSrc, /from '\.\/lib\/git-env-sanitize\.mjs'/);
    assert.match(runnerSrc, /const gitEnv = sanitizeGitEnv\(repoRoot\)/);
    assert.match(runnerSrc, /\.\.\.gitEnv,/);
    assert.doesNotMatch(
      runnerSrc, /const env = \{\s*\.\.\.process\.env/,
      'the sandboxed check env must start from sanitizeGitEnv(), never raw process.env',
    );
  });

  it('threads the sanitized env into npm ci too, not just npm run check (2026-07-24 audit M1)', () => {
    // npm ci can shell out to git for git-hosted dependency resolution — a
    // raw process.env there would carry a leaked GIT_DIR into that path just
    // as surely as into the check run itself.
    assert.match(runnerSrc, /provisionNodeModules\(sandbox, repoRoot, gitEnv\)/);
    assert.match(runnerSrc, /function provisionNodeModules\(sandbox, repoRoot, gitEnv\)/);
    const ciIdx = runnerSrc.indexOf("NPM, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']");
    assert.ok(ciIdx !== -1, 'the npm ci spawn must still use the pinned argv');
    assert.match(
      runnerSrc.slice(ciIdx, ciIdx + 600), /\.\.\.\(gitEnv \? \{ env: gitEnv \} : \{\}\)/,
      'the sanitized env must reach the npm ci spawn, not just the check spawn',
    );
  });

  it('CAPTURES npm ci output instead of inheriting it, and surfaces it on failure (2026-08-30)', () => {
    // Inheriting looked like the transparent choice and was the opposite: npm's
    // diagnosis landed hundreds of lines upstream of the ✗ that reported it, and
    // npm's own debug log — the fallback — is rotated out by `logs-max` (default
    // 10) within a handful of later npm runs. Measured on the 2026-08-30
    // failure: the log was already gone, and the operator saw no npm error at
    // all, so the cause is permanently unrecoverable.
    const ciIdx = runnerSrc.indexOf("NPM, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']");
    const spawnOpts = runnerSrc.slice(ciIdx, ciIdx + 600);
    assert.doesNotMatch(spawnOpts, /stdio: 'inherit'/, 'npm ci output must be captured, not inherited');
    assert.match(spawnOpts, /stdio: \['ignore', 'pipe', 'pipe'\]/);
    assert.match(
      spawnOpts, /maxBuffer:/,
      'an explicit maxBuffer is required — on overflow spawnSync KILLS the child and reports '
      + 'ENOBUFS, which would be a brand-new way for provisioning to fail',
    );
    assert.match(runnerSrc, /function reportFailedInstall\(/);
    assert.match(runnerSrc, /NPM_FAILURE_TAIL_LINES/, 'the tail of npm output must be printed beside the failure');
    assert.match(runnerSrc, /\.prepush-npm-ci\.log/, 'the full transcript must be persisted');
    // shell:IS_WIN is REQUIRED, not incidental — Node 22 refuses to spawn a
    // `.cmd` without it (EINVAL). Measured on win32, it round-trips a child's
    // exit status faithfully (0→0, 3→3), so it was ruled OUT as a cause of the
    // fabricated non-zero exit it was suspected of.
    assert.match(spawnOpts, /shell: IS_WIN/);
  });

  it('treats npm exiting 0 as a claim, not proof the install finished (2026-08-30)', () => {
    // The same rule lib/prepush-sandbox-cleanup.mjs encodes for `git worktree
    // remove`. npm writes `.bin/` and the hidden lockfile LAST, at the end of
    // reify; the 2026-08-30 sandbox held 234 of the expected 236 top-level
    // entries and was missing exactly those two — which is how we know the
    // install died at finalisation rather than being externally killed.
    const ciIdx = runnerSrc.indexOf("NPM, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']");
    const after = runnerSrc.slice(ciIdx);
    assert.match(after, /const finished = fs\.existsSync\(hiddenLockPath\)/);
    assert.match(after, /'node_modules', '\.package-lock\.json'/);
    assert.match(after, /r\.status !== 0 \|\| !finished/,
      'an unfinished install must fail even when npm reported success');
  });

  it('PRESERVES the sandbox when provisioning failed, and only then (2026-08-30)', () => {
    // The sandbox is the last surviving evidence of a provisioning failure, and
    // deleting it is what made 2026-08-30 unreconstructable. But a failing `npm
    // run check` is the ordinary red push — preserving there would leak a ~1GB
    // husk on every one, so the flag is set by the throw site, not by the catch.
    assert.match(runnerSrc, /err\.preserveSandbox = true;/);
    assert.match(runnerSrc, /if \(err\?\.preserveSandbox\) preserveSandbox = true;/);
    assert.match(runnerSrc, /sandbox PRESERVED as evidence/);

    const flagIdx = runnerSrc.indexOf('err.preserveSandbox = true;');
    const checkSpawnIdx = runnerSrc.indexOf("NPM, ['run', 'check']");
    assert.ok(flagIdx !== -1 && checkSpawnIdx !== -1 && flagIdx < checkSpawnIdx,
      'only a PROVISIONING failure may set the flag — it must not be reachable from the check run');
  });

  it('compares package.json, not just package-lock.json, before trusting the linked node_modules (item 5 — sast-sandbox-backlog-hardening.md)', () => {
    // A pushed commit can hand-edit package.json dependency declarations
    // without regenerating the lockfile — the lockfile-only comparison this
    // regression guards against would then silently symlink the main
    // checkout's stale node_modules instead of installing.
    //
    // The MECHANISM narrowed on 2026-08-11 (whole-file → dependency-relevant
    // fields, because the whole-file form made the link path unreachable and so
    // was never exercised); the PROPERTY is unchanged and is what is pinned
    // here. Which fields count, and that unreadable input still installs, is
    // tests/prepush-dependency-identity.test.mjs.
    assert.match(runnerSrc, /pkgSandbox = path\.join\(sandbox, 'package\.json'\)/);
    assert.match(runnerSrc, /const deps = dependencySetChanged\(readOrNull\(pkgMain\), readOrNull\(pkgSandbox\)\)/);
    assert.match(runnerSrc, /lockChanged = filePairChanged\(lockMain, lockSandbox\) \|\| deps\.changed/);
  });

  it('resolves node_modules the way NODE does, so the link path is reachable in a worktree', () => {
    // Measured 2026-08-11: `<repoRoot>/node_modules` does not exist in a git
    // worktree, so `existsSync` was false and EVERY worktree push fell through
    // to a full `npm ci` — the fast path was dead code exactly where this repo's
    // sessions run. Same defect check-gate-poison-pills.mjs fixed on 2026-08-08;
    // the walk is shared now so there is one place to regress it.
    assert.match(runnerSrc, /from '\.\/lib\/node-modules-resolver\.mjs'/);
    assert.match(runnerSrc, /const mainModules = findNodeModules\(repoRoot\)/);
    assert.doesNotMatch(
      runnerSrc, /node_modules = path\.join\(repoRoot, 'node_modules'\)/,
      'the hard-coded repoRoot path is the defect; it must not come back',
    );
  });

  it('compares the manifest of the checkout that OWNS the modules it links', () => {
    // In a worktree the resolved node_modules belongs to the MAIN checkout while
    // repoRoot is the worktree. Comparing one checkout's manifest and linking
    // another's tree would decide "unchanged" about something it never read.
    assert.match(runnerSrc, /const modulesOwner = mainModules \? path\.dirname\(mainModules\) : repoRoot/);
    assert.match(runnerSrc, /pkgMain = path\.join\(modulesOwner, 'package\.json'\)/);
    assert.match(runnerSrc, /lockMain = path\.join\(modulesOwner, 'package-lock\.json'\)/);
  });

  it('an absent node_modules INSTALLS and says so, never links a path that is not there', () => {
    // On Windows a junction to a MISSING target succeeds and leaves a dangling
    // link, so "the symlink call didn't throw" is not evidence the link works.
    assert.match(runnerSrc, /if \(!lockChanged && mainModules\)/);
    assert.match(runnerSrc, /no node_modules found at or above/);
  });

  it('verifies the linked node_modules did not shrink during the run (2026-08-19 field incident)', () => {
    // A field report (main checkout's node_modules: 410 packages -> 0,
    // emptied progressively during npm test, not just at teardown) could not
    // be reproduced against the teardown path itself — see the incident note
    // in scripts/lib/prepush-sandbox-cleanup.mjs. This postcondition can't
    // name the mechanism, but it can guarantee the next occurrence is a loud,
    // attributable failure instead of a silent one.
    assert.match(runnerSrc, /from '\.\/lib\/node-modules-resolver\.mjs'/);
    assert.match(runnerSrc, /countTopLevelEntries/);
    assert.match(
      runnerSrc, /const mainModulesForGuard = findNodeModules\(repoRoot\)/,
      'the guard must snapshot BEFORE provisioning links the sandbox into this path',
    );
    const snapshotIdx = runnerSrc.indexOf('mainModulesForGuard');
    // The call SITE, not provisionNodeModules's own function definition
    // (which appears earlier in the file and would make this comparison
    // vacuously true regardless of where the snapshot actually sits).
    const provisionIdx = runnerSrc.indexOf('const modules = provisionNodeModules(sandbox, repoRoot, gitEnv)');
    assert.ok(snapshotIdx !== -1 && provisionIdx !== -1 && snapshotIdx < provisionIdx,
      'the pre-run snapshot must be taken before provisioning, not after');

    const checkIdx = runnerSrc.indexOf("NPM, ['run', 'check']");
    const guardIdx = runnerSrc.indexOf("modules === 'linked' && mainModulesForGuard");
    assert.ok(checkIdx !== -1 && guardIdx !== -1 && guardIdx > checkIdx,
      'the postcondition must be checked AFTER the run, not before');
    assert.match(
      runnerSrc.slice(guardIdx, guardIdx + 600), /postRunEntryCount < preRunEntryCount/,
      'the guard must fire on a shrink, not merely a difference',
    );
    assert.match(
      runnerSrc.slice(guardIdx, guardIdx + 600), /throw new Error/,
      'a detected shrink must fail the push, not just warn — the run cannot be trusted either way',
    );
  });

  it('installs when the main checkout\'s node_modules does not match its own package-lock.json (finding 2ec7f704)', () => {
    // Matching manifests between the two CHECKOUTS says nothing about whether
    // the MAIN checkout's own node_modules still reflects its OWN current
    // lockfile — e.g. a developer edited package-lock.json locally and never
    // re-ran `npm install`. The PROPERTY is unchanged since 2026-08-20; the
    // MECHANISM was replaced on 2026-08-30.
    //
    // It used to be an mtime heuristic — lockfile newer than the node_modules
    // directory ⇒ possibly stale. That is wrong in the HEALTHY case, not merely
    // lossy: `npm install` writes the lockfile last and a directory's mtime only
    // moves when a top-level entry is added or removed, so a tree npm had just
    // called "up to date in 6s" read STALE (lock 13:24:07, node_modules
    // 13:22:07) and stayed STALE until something unrelated created
    // `node_modules/.cache`, at which point the same tree read FRESH with the
    // lockfile 18 days older. On 2026-08-30 that coin-flip landed on STALE,
    // forced an `npm ci` that failed, and blocked a push.
    //
    // npm's own hidden lockfile is the content oracle. Verdict behaviour —
    // both directions, optional deps, and every fail-closed input — is
    // tests/prepush-installed-tree-identity.test.mjs; what is pinned HERE is
    // that the runner asks it, asks it about the MAIN checkout's tree, and
    // still routes the answer into the link-vs-install decision.
    assert.doesNotMatch(
      runnerSrc, /statMtimeMs/,
      'the mtime heuristic must not come back — it reports STALE on a healthy install',
    );
    assert.match(runnerSrc, /from '\.\/lib\/installed-tree-identity\.mjs'/);
    assert.match(
      runnerSrc, /const hiddenLock = mainModules \? path\.join\(mainModules, '\.package-lock\.json'\) : null;/,
      'the hidden lockfile must be read from the checkout that OWNS the modules, not from repoRoot',
    );
    assert.match(runnerSrc, /installedTreeStale\(readOrNull\(lockMain\), readOrNull\(hiddenLock\)\)/);
    assert.match(
      runnerSrc, /: \{ stale: true, reason: 'no node_modules to compare against' \}/,
      'no node_modules at all must install, never link',
    );
    assert.match(
      runnerSrc,
      /const lockChanged = filePairChanged\(lockMain, lockSandbox\) \|\| deps\.changed \|\| modulesStale;/,
    );
  });

  it('wraps every shared-metadata git worktree call in lock-contention retry (2026-07-23)', () => {
    // Sibling fix to the core.bare pin above: a transient lock (peer holds
    // .git/config.lock for a few hundred ms) is a different failure shape
    // from a corrupted value, and needs retry rather than an override. A raw
    // execFileSync('git', ['worktree', ...]) here would silently regress to
    // hard-failing on the very contention this session's incident reproduced.
    assert.match(runnerSrc, /from '\.\/lib\/git-lock-retry\.mjs'/);
    for (const call of ["'worktree', 'add'", "'worktree', 'remove'", "'worktree', 'prune'"]) {
      const idx = runnerSrc.indexOf(call);
      assert.ok(idx !== -1, `expected to find a ${call} call`);
      const line = runnerSrc.slice(runnerSrc.lastIndexOf('\n', idx), runnerSrc.indexOf('\n', idx));
      assert.match(line, /gitWithLockRetry\(/, `${call} must go through the lock-retry wrapper, not a raw execFileSync`);
    }
  });
});

describe('the pre-push hook feeds the sandbox a real range', () => {
  const hook = fs.readFileSync(path.join(REPO, '.githooks', 'pre-push'), 'utf-8');

  it('reads git stdin exactly once', () => {
    // stdin is a stream: the first reader consumes it. Before 2026-07-20 the
    // DB-seam advisory read it directly, so adding any second consumer would
    // silently starve one of them.
    const readers = hook.match(/^\s*(while read|.*\$\(cat\))/gm) || [];
    const catReads = hook.match(/\$\(cat\)/g) || [];
    assert.equal(catReads.length, 1, 'exactly one stdin capture expected');
    assert.ok(
      readers.length <= 2,
      'the while-loop must consume the CAPTURED copy (here-doc), not stdin again',
    );
    assert.match(hook, /<<EOF\n\$PUSH_STDIN/, 'the range loop must read the captured copy');
  });

  it('derives a first-push base from the fork point, not HEAD~1', () => {
    assert.match(hook, /merge-base origin\/main/);
    assert.doesNotMatch(hook, /RANGE_BASE.*HEAD~1/);
  });

  it('passes the range to the sandbox runner', () => {
    assert.match(hook, /--base/);
    assert.match(hook, /--head/);
    assert.match(hook, /prepush-check\.mjs/);
  });

  it('keeps an in-tree escape hatch', () => {
    assert.match(hook, /AUDIT_PREPUSH_SANDBOX/);
  });
});

describe('arch:coverage-gate absent-envelope behaviour (end-to-end)', () => {
  /**
   * Run the gate in a temp cwd that has a domain-map but no observed envelope.
   *
   * The strictness var is stripped from the inherited env first: these very
   * tests run INSIDE the sandbox during a pre-push, where the runner exports
   * ARCH_COVERAGE_REQUIRE_ENVELOPE=1 — so inheriting it made the "default
   * behaviour" case silently assert the strict behaviour instead. Found by the
   * sandbox running this suite against itself.
   */
  function runGate(extraEnv) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-arch-gate-'));
    try {
      fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true });
      fs.copyFileSync(
        path.join(REPO, '.audit-loop', 'domain-map.json'),
        path.join(dir, '.audit-loop', 'domain-map.json'),
      );
      const baseEnv = { ...process.env };
      delete baseEnv.ARCH_COVERAGE_REQUIRE_ENVELOPE;
      return spawnSync(process.execPath, [path.join(REPO, 'scripts', 'arch-coverage-gate.mjs')], {
        cwd: dir, encoding: 'utf-8', env: { ...baseEnv, ...extraEnv },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  it('still skips by default — a never-rendered consumer must not be blocked', () => {
    const r = runGate({});
    assert.equal(r.status, 0, 'default leniency for first-time consumers is deliberate and must survive');
    assert.match(r.stderr, /skipping/);
  });

  it('FAILS when the caller asserted an envelope would be present', () => {
    const r = runGate({ ARCH_COVERAGE_REQUIRE_ENVELOPE: '1' });
    assert.equal(r.status, 2, 'a gate that was promised evidence must not pass without it');
    assert.match(r.stderr, /FAILED/);
  });
});
