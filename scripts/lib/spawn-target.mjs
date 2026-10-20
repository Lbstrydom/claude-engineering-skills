/**
 * @fileoverview Where to actually spawn a command without a shell, and the one line printed when it could not start.
 * Extracted from `fleet/lease-spawn.mjs` (which re-exports both, so its importers are unchanged) so a shared-lib
 * module (`test-evidence.mjs`) can use the SAME resolver without a shared-lib -> fleet import: one oracle for the
 * Windows `npm`/`npx` shim rewrite, not a second copy that drifts.
 *
 * @module scripts/lib/spawn-target
 */
import fs from 'node:fs';
import path from 'node:path';

const NODE_CLI_SHIMS = Object.freeze({ npm: 'npm-cli.js', npx: 'npx-cli.js' });

/**
 * Where to actually spawn `cmd`. On Windows `npm`/`npx` are `.cmd` shims: `spawn('npm')` is ENOENT and `spawn('npm.cmd')` is EINVAL
 * without a shell, and `shell: true` is exactly what this module must not use (the argv is passed verbatim, nothing interpolated).
 * npm ships its own Node entry point (`<dir>/node_modules/npm/bin/npm-cli.js`) beside its shim, so the shim is replaced by
 * `node <entry> args...`, which needs no shell. WHICH npm is chosen follows what a shell would do: the first PATH directory holding
 * the shim AND its entry point wins (a globally upgraded npm in %APPDATA%/npm shadows the bundled one, as it does at a prompt);
 * only when PATH has none is the npm beside the running node used. Anything else, any other platform, or no entry point found is
 * returned unchanged.
 *
 * @returns {{cmd: string, args: string[], rewritten: boolean, entry?: string}}
 */
export function resolveSpawnTarget({ cmd, args = [], platform = process.platform, execPath = process.execPath, exists = fs.existsSync, pathEnv = process.env.Path ?? process.env.PATH ?? '' }) {
  const same = { cmd, args, rewritten: false };
  if (platform !== 'win32' || typeof cmd !== 'string') return same;
  const w = path.win32;
  const base = w.basename(cmd).replace(/\.cmd$/i, '').toLowerCase();
  const shim = NODE_CLI_SHIMS[base];
  // Only a bare command name is rewritten: an explicit path is the caller choosing a binary.
  if (!shim || cmd !== w.basename(cmd)) return same;
  const entryIn = (dir) => w.join(dir, 'node_modules', 'npm', 'bin', shim);
  const fromPath = String(pathEnv).split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)
    .find((d) => exists(w.join(d, `${base}.cmd`)) && exists(entryIn(d)));
  const entry = entryIn(fromPath ?? w.dirname(execPath));
  return fromPath !== undefined || exists(entry) ? { cmd: execPath, args: [entry, ...args], rewritten: true, entry } : same;
}

/**
 * The one line printed when the child could not be started: what was asked for, what was resolved, from where, and (on Windows)
 * why a shim fails. Never prints the environment, and never the arguments (they can carry tokens or credential URLs): only how
 * many there were.
 */
export function describeSpawnFailure({ cmd, spawnError, target, cwd = process.cwd(), platform = process.platform }) {
  const t = target ?? { cmd, args: [] };
  const n = (t.args ?? []).length - (t.rewritten ? 1 : 0); // the rewritten entry point is not a caller argument
  const exe = t.rewritten ? `${t.cmd} ${t.entry}` : t.cmd;
  const hint = platform === 'win32' && !t.rewritten
    ? ' On Windows a .cmd shim cannot be spawned without a shell: run the tool through node <entry-point>.js (for npm that is node_modules/npm/bin/npm-cli.js beside node.exe).'
    : '';
  return `could not start ${JSON.stringify(cmd)}: ${spawnError} (resolved: ${exe} +${n} arg(s); cwd: ${cwd}).${hint}`;
}
