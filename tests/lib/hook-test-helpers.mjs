/**
 * @fileoverview Shared bash-availability probe for hook-snippet tests
 * (round-1 code-audit M8 — was duplicated near-identically between
 * hook-snippet-behaviour.test.mjs and maintenance-hook-snippet.test.mjs).
 */
import { spawnSync } from 'node:child_process';

export function hasBash() {
  // The repo runs in WSL/git-bash on Windows; assume bash is on PATH.
  const r = spawnSync('bash', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0;
}
