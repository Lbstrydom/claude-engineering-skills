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
