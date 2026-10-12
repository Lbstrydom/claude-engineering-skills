/**
 * @fileoverview The harness shared by the `tests/fleet-cli*.test.mjs` suites —
 * a fixture bound to a CLI runner, plus the small registry readers every part
 * asserts through.
 *
 * The /fleet CLI end-to-end suite was one file, and `node --test` runs a file's
 * tests serially while parallelising ACROSS files, so the longest file is the
 * wall-time floor of `npm test` (measured 2026-10-12: fleet-cli was 96% of the
 * pre-push gate's wall time and 13% of its summed test time). It is split by
 * theme into several files; this module is what they all had at the top of the
 * one file, moved verbatim so no test body changed.
 *
 * @module tests/helpers/fleet-cli-harness
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';
import { addBranch, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv } from './fleet-repo.mjs';
import { resolveConfig } from '../../scripts/lib/fleet/config.mjs';
import { readSessions } from '../../scripts/lib/fleet/registry.mjs';

export const OK_TIER = { name: 'default', command: ['node', '-e', 'process.exit(0)'] };
export const fwd = (p) => p.replace(/\\/g, '/');
export const fleetDirOf = (fx) => path.join(fx.repo, '.git', 'fleet');

/** A fixture plus a bound `f(args)` runner. `gh:false` leaves gh absent (PATH scrubbed). */
export function setup({ fleetConfig = null, gh = false, files } = {}) {
  const fx = makeFleetRepo({ fleetConfig, ...(files ? { files } : {}) });
  const fake = gh ? installFakeGh(fx.root) : null;
  const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...(fake ? fake.env : {}) }, { prependPath: fake ? [fake.bin] : [] });
  const f = (args, o = {}) => runFleet(args, { cwd: o.cwd ?? fx.repo, env: { ...env, ...(o.env ?? {}) } });
  return { fx, env, f, fake, config: () => resolveConfig(fx.repo, { env }) };
}

/** Create `name`, claim it (paths default to `<name>/**`) and mark it ready; ends on main. */
export function readyBranch(s, name, files, { paths = `${name}/**`, intent = `work on ${name}` } = {}) {
  const oid = addBranch(s.fx.repo, name, files);
  git(['checkout', '-q', name], s.fx.repo);
  const c = s.f(['claim', '--id', name, '--intent', intent, '--paths', paths, '--json']);
  assert.equal(c.status, 0, `claim ${name}: ${c.stdout}${c.stderr}`);
  const r = s.f(['ready', '--id', name, '--json']);
  assert.equal(r.status, 0, `ready ${name}: ${r.stdout}${r.stderr}`);
  git(['checkout', '-q', 'main'], s.fx.repo);
  return oid;
}

export const originLog = (fx, ref = 'main') => git(['--git-dir', fx.origin, 'log', '--format=%s', ref], fx.root).split('\n');
export const sessionFiles = (fx) => {
  try { return fs.readdirSync(path.join(fleetDirOf(fx), 'sessions')).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code === 'ENOENT') return []; // only "no such directory" means "no sessions"
    throw e;
  }
};
export const sessionRec = (fx, id) => readSessions(fleetDirOf(fx)).sessions.find((x) => x.id === id);
export const land = (s, extra = []) => s.f(['land', '--json', ...extra]);
