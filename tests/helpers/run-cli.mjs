/**
 * @fileoverview Shared test helper — spawn a repo CLI script under `node`.
 *
 * Several CLI test files independently defined an identical `runCli`
 * wrapper (flagged by `arch:duplicates`). `makeRunCli` is the factory:
 * bind it to a script path once, then call the returned function with
 * just the args — existing `runCli(args)` call sites stay unchanged.
 *
 * Extended (arch-drift-duplication-cleanup) to also serve the
 * `ship-commit-*.test.mjs` family, whose local `runCli` needed a per-test
 * default cwd (a temp repo reassigned every `beforeEach`, so it must be
 * resolved lazily via a THUNK, not captured once at factory time), a hermetic
 * env override, and `process.execPath` instead of a bare `'node'`. The
 * defaults (`command: 'node'`, no `buildEnv`, cwd `path.resolve('.')`)
 * preserve the exact prior behaviour for `makeRunCli(scriptPath)` callers
 * with no options.
 *
 * @module tests/helpers/run-cli
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * @param {string} scriptPath - absolute path to the CLI script under test
 * @param {object} [opts]
 * @param {string|(() => string)} [opts.cwd] - default cwd, or a thunk resolved
 *   per call (for a cwd that changes between tests, e.g. a `let repo` reassigned
 *   in `beforeEach`). Defaults to `path.resolve('.')`, matching the original
 *   unparameterized behaviour.
 * @param {string} [opts.command] - defaults to `'node'`.
 * @param {(cwd: string) => NodeJS.ProcessEnv} [opts.buildEnv] - when supplied,
 *   overrides the spawned process's env (computed from the resolved cwd).
 * @returns {(args?: string[], cwd?: string) => import('node:child_process').SpawnSyncReturns<string>}
 */
export function makeRunCli(scriptPath, { cwd: defaultCwd, command = 'node', buildEnv } = {}) {
  const resolveDefaultCwd = () => (typeof defaultCwd === 'function' ? defaultCwd() : (defaultCwd ?? path.resolve('.')));
  return (args = [], cwd) => {
    const resolvedCwd = cwd ?? resolveDefaultCwd();
    const opts = { encoding: 'utf-8', cwd: resolvedCwd };
    if (buildEnv) opts.env = buildEnv(resolvedCwd);
    return spawnSync(command, [scriptPath, ...args], opts);
  };
}
