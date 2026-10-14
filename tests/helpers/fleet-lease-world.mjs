/**
 * @fileoverview Shared setup for the `fleet lease` CLI suites: two throwaway repos and ONE machine directory.
 * Plan: docs/plans/fleet-machine-lease.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './fleet-repo.mjs';

export const T0 = '2026-10-13T20:00:00.000Z';
export const T0_PLUS_2H = '2026-10-13T22:00:00.000Z';

/** Two repos and one shared machine directory. */
export function world() {
  const machine = tmpRoot('fleet-machine-');
  const a = makeFleetRepo(); const b = makeFleetRepo();
  const env = (extra = {}) => scrubbedEnv({ FLEET_TELEMETRY: 'off', FLEET_MACHINE_DIR: machine, FLEET_NOW: T0, ...extra });
  const runA = (args, extra) => runFleet(args, { cwd: a.repo, env: env(extra) });
  const runB = (args, extra) => runFleet(args, { cwd: b.repo, env: env(extra) });
  const leaseFile = path.join(machine, 'lease.json');
  const read = () => JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
  // Both repos use the branch name `main` as their session id: the collision the identity pair exists to prevent.
  for (const run of [runA, runB]) assert.equal(run(['claim', '--id', 'main', '--intent', 'coordinate', '--paths', 'a.txt']).status, 0);
  return { machine, a, b, env, runA, runB, leaseFile, read };
}

export const tokenOf = (r) => /token: ([0-9a-f]{16})/.exec(r.stdout)?.[1];
/** A pid that is certainly dead: a child that already exited. */
export const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

