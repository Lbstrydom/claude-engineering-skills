/**
 * @fileoverview Shared bash-availability probe for hook-snippet tests
 * (round-1 code-audit M8 — was duplicated near-identically between
 * hook-snippet-behaviour.test.mjs and maintenance-hook-snippet.test.mjs).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export function hasBash() {
  // The repo runs in WSL/git-bash on Windows; assume bash is on PATH.
  const r = spawnSync('bash', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0;
}

/**
 * Run git via `spawnSync`, asserting a clean exit rather than throwing.
 * Consolidated here (arch:drift duplication cleanup) — `prepush-push-range-stdin.test.mjs`
 * and `prepush-sync-bookkeeping-shortcircuit.test.mjs` each had their own
 * identical copy, both already importing `hasBash` from this module.
 */
export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout.trim();
}
