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

/**
 * The CLI bounds every git call it makes (15 s local, 30 s remote) and a build that fails on that bound has
 * measured the machine, not the code: one `land` is ~18 s alone and measured 66 s with null JSON under another
 * repo's gate. Only a failure that NAMES a timeout is retried (below); any other failure is a real one and is
 * rethrown at once, so this cannot turn a regression green.
 */
const LOAD_TIMEOUT_RE = /timed out after \d+ms/;
/**
 * An error that carries an explicit `loadTimeout` says where it came from and is believed; only an error with none
 * (an assertion message out of claim/ready, which has no structure to read) falls back to its text.
 */
export const isLoadTimeout = (e) => (typeof e?.loadTimeout === 'boolean' ? e.loadTimeout : LOAD_TIMEOUT_RE.test(String(e?.message ?? '')));

/** The green train out of a `land --json` result, or an Error carrying the CLI's full output (a null envelope used to surface as a bare TypeError). */
export function greenTrainOf(r) {
  const t = r.json?.train;
  if (t?.result === 'green') return t;
  const out = r.json ? JSON.stringify(r.json).slice(0, 2000) : `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-2000);
  // A train the CLI RETURNED is a verdict (red, conflict, ...) whatever its prose says; only a run that produced no
  // train at all can be the CLI's own bound firing.
  throw Object.assign(new Error(`land did not build a green train (status ${r.status}): ${out}`), { loadTimeout: !t && LOAD_TIMEOUT_RE.test(out) });
}

/** Run `build()`, rebuilding from scratch (it must create its own fixture) when it failed on a load timeout. */
export function retryOnLoadTimeout(build, { attempts = 3 } = {}) {
  for (let i = 1; ; i += 1) {
    try { return build(); } catch (e) {
      if (i >= attempts || !isLoadTimeout(e)) throw e;
    }
  }
}
