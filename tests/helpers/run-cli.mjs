/**
 * @fileoverview Shared test helper — spawn a repo CLI script under `node`.
 *
 * Several CLI test files independently defined an identical `runCli`
 * wrapper (flagged by `arch:duplicates`). `makeRunCli` is the factory:
 * bind it to a script path once, then call the returned function with
 * just the args — existing `runCli(args)` call sites stay unchanged.
 *
 * @module tests/helpers/run-cli
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * @param {string} scriptPath - absolute path to the CLI script under test
 * @returns {(args?: string[]) => import('node:child_process').SpawnSyncReturns<string>}
 */
export function makeRunCli(scriptPath) {
  return (args = []) => spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf-8',
    cwd: path.resolve('.'),
  });
}
