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
 * only when PATH has none is the npm beside the running node used.
 *
 * ANY OTHER bare command (`corepack`, `pnpm`, a globally installed npm bin) is looked up the way a shell would, in the working
 * directory and then PATH, with the default PATHEXT order (.com, .exe, .bat, .cmd). The first hit decides: a .com/.exe/.bat is
 * spawned unchanged; a .cmd is rewritten ONLY when it is a pure node launcher (see cmdShimEntry) whose script exists, to
 * `node <script> args...` (the node.exe beside the shim when there is one, as the shims themselves prefer, else the running node).
 * A consumer's `fleet lease run -- corepack ...` was ENOENT before this (2026-11-28). A name with an extension other than `.cmd`
 * is the caller choosing a file type and is never rewritten; an explicit `name.cmd` looks for that shim only. Anything else is
 * returned unchanged, so the spawn fails with describeSpawnFailure's hint.
 *
 * @returns {{cmd: string, args: string[], rewritten: boolean, entry?: string}}
 */
export function resolveSpawnTarget({ cmd, args = [], platform = process.platform, execPath = process.execPath, exists = fs.existsSync, pathEnv = process.env.Path ?? process.env.PATH ?? '', readFile = (p) => fs.readFileSync(p, 'utf8'), env = process.env, cwd = process.cwd() }) {
  const same = { cmd, args, rewritten: false };
  if (platform !== 'win32' || typeof cmd !== 'string') return same;
  const w = path.win32;
  // Only a bare command name is rewritten: an explicit path is the caller choosing a binary.
  if (cmd !== w.basename(cmd)) return same;
  const base = w.basename(cmd).replace(/\.cmd$/i, '').toLowerCase();
  const shim = NODE_CLI_SHIMS[base];
  if (!shim) {
    const ext = w.extname(cmd).toLowerCase();
    if (ext !== '' && ext !== '.cmd') return same;
    return resolveCmdShim({ base, explicitCmd: ext === '.cmd', args, execPath, exists, dirs: [cwd, ...pathDirs(pathEnv)], readFile, env, cwd }) ?? same;
  }
  const entryIn = (dir) => w.join(dir, 'node_modules', 'npm', 'bin', shim);
  const fromPath = pathDirs(pathEnv)
    .find((d) => exists(w.join(d, `${base}.cmd`)) && exists(entryIn(d)));
  const entry = entryIn(fromPath ?? w.dirname(execPath));
  return fromPath !== undefined || exists(entry) ? { cmd: execPath, args: [entry, ...args], rewritten: true, entry } : same;
}

/** PATH as a shell walks it: split on `;`, unquoted, blanks dropped. */
function pathDirs(pathEnv) {
  return String(pathEnv).split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

/**
 * The shim TEMPLATES this module recognises: the exact bodies their generators write, with the target script (`{S}`) the only
 * variable part. Nothing is interpreted: a `.cmd` that is not byte-for-byte one of these (modulo line endings, case, runs of
 * whitespace and blank lines) is not rewritten, because any other batch content (a setup command, an `exit`, a different SET) is
 * behaviour a rewrite would silently drop. Each template states how its node is chosen, which is what the shim itself does:
 *  - `prog`: node.exe beside the shim when it exists, else `node` from the lookup;
 *  - `path`: `node` from the lookup;
 *  - `exe`:  `{S}` is itself the program (npm ships some bins as an .exe behind a .cmd).
 * Captured 2026-11-28 from npm 11's cmd-shim (global bins), corepack 0.x's own shim and the pnpm launcher corepack installs.
 * Stated limit: corepack's and pnpm's `SET PATHEXT=%PATHEXT:;.JS;=;%` (dropping `.JS`) is not replicated in the child's environment.
 */
const SHIM_TEMPLATES = Object.freeze([
  { name: 'npm-cmd-shim', node: 'prog', body: String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\node.exe" (
SET "_prog=%dp0%\node.exe"
) ELSE (
SET "_prog=node"
SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" {S} %*` },
  { name: 'npm-cmd-shim-exe', node: 'exe', body: String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
{S} %*` },
  { name: 'corepack', node: 'prog', body: String.raw`@SETLOCAL
@IF EXIST "%~dp0\node.exe" (
"%~dp0\node.exe" {S} %*
) ELSE (
@SET PATHEXT=%PATHEXT:;.JS;=;%
node {S} %*
)` },
  { name: 'corepack-pnpm', node: 'path', body: String.raw`@ECHO off
SETLOCAL
SET "_prog=node"
SET PATHEXT=%PATHEXT:;.JS;=;%
endLocal & "%_prog%" {S} %*` },
]);

/** Line endings, case, whitespace runs and blank lines are not behaviour; everything else is. */
const normaliseBatch = (t) => String(t).split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n').toLowerCase();

const TEMPLATE_RES = SHIM_TEMPLATES.map((t) => {
  const parts = normaliseBatch(t.body).split('{s}').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return { ...t, re: new RegExp(`^${parts.join('"([^"\\n]+)"')}$`, 'd') };
});

/**
 * Match a `.cmd` against SHIM_TEMPLATES. Every `{S}` in a template must capture the SAME path (corepack names it twice). An
 * `exe` template's script must end in `.exe`, a node template's must not name a native program.
 * @returns {{script: string, template: string, node: 'prog'|'path'|'exe'}|null}
 */
export function parseCmdShim(text) {
  const raw = String(text).split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n');
  const norm = raw.toLowerCase();
  if (norm.length !== raw.length) return null; // a case fold that changes length would break the offset recovery below
  for (const t of TEMPLATE_RES) {
    const m = t.re.exec(norm);
    if (!m) continue;
    if (new Set(m.slice(1)).size !== 1) return null;
    // Recover the script's original case from the match's own offsets (the match ran on the lower-cased copy).
    const [start, end] = m.indices[1];
    const script = raw.slice(start, end);
    const native = /\.(?:exe|com|bat|cmd)$/i.test(script);
    if ((t.node === 'exe') !== /\.exe$/i.test(script) || (t.node !== 'exe' && native)) return null;
    return { script, template: t.name, node: t.node };
  }
  return null;
}

/**
 * The script a pure launcher runs, as an absolute path, or null. `%~dp0`/`%dp0%` is the shim's own directory; any other `%VAR%`
 * comes from `env`, and an unset one makes the path unresolvable: null, never a guess. A relative result resolves against `cwd`,
 * where the shim would run.
 * @returns {string|null}
 */
export function cmdShimEntry(text, dir, env = process.env, cwd = process.cwd()) {
  const parsed = parseCmdShim(text);
  return parsed ? expandShimPath(parsed.script, dir, env, cwd) : null;
}

function expandShimPath(p, dir, env, cwd) {
  const vars = new Map(Object.entries(env ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let unresolved = false;
  // Function replacers: a directory or value containing `$&` must not be read as a replacement pattern.
  const expanded = p
    .replace(/%~dp0%?|%dp0%/gi, () => `${dir}\\`)
    .replace(/%([^%]+)%/g, (_, k) => {
      const v = vars.get(k.toLowerCase());
      if (v === undefined) unresolved = true;
      return v ?? '';
    });
  return unresolved ? null : path.win32.resolve(cwd, expanded);
}

/** The first `<base><ext>` a shell-free lookup over `dirs` finds, or null. */
function firstIn(dirs, base, exts, exists) {
  for (const dir of dirs) for (const e of exts) { const p = path.win32.join(dir, `${base}${e}`); if (exists(p)) return p; }
  return null;
}

/**
 * The first hit for a non-npm bare command, rewritten to node + its script; null means "spawn it unchanged".
 * A first hit that is a .bat, or a .cmd that is not a pure launcher, is returned as its FULL PATH: spawning it fails loudly (with
 * describeSpawnFailure's hint) instead of letting spawn's own .com/.exe search quietly run a different, later program.
 */
function resolveCmdShim({ base, explicitCmd, args, execPath, exists, dirs, readFile, env, cwd }) {
  const w = path.win32;
  for (const dir of dirs) {
    // Default PATHEXT order: whatever precedes .cmd in a directory is what a shell would run.
    if (!explicitCmd) {
      if (['.com', '.exe'].some((e) => exists(w.join(dir, `${base}${e}`)))) return null;
      const bat = w.join(dir, `${base}.bat`);
      if (exists(bat)) return { cmd: bat, args, rewritten: false };
    }
    const shimPath = w.join(dir, `${base}.cmd`);
    if (!exists(shimPath)) continue;
    const loud = { cmd: shimPath, args, rewritten: false };
    let text;
    try { text = readFile(shimPath); } catch { return loud; }
    const parsed = parseCmdShim(text);
    const entry = parsed && expandShimPath(parsed.script, dir, env, cwd);
    if (!entry || !exists(entry)) return loud;
    // A native launcher: spawn its exe directly (no entry argument is inserted, so `direct` tells describeSpawnFailure).
    if (parsed.node === 'exe') return { cmd: entry, args, rewritten: true, entry, direct: true };
    // Node as the template picks it: `prog` prefers the node.exe beside the shim; both fall back to node from the lookup.
    const besideNode = w.join(dir, 'node.exe');
    const node = (parsed.node === 'prog' && exists(besideNode)) ? besideNode
      : (firstIn(dirs, 'node', ['.com', '.exe'], exists) ?? execPath);
    return { cmd: node, args: [entry, ...args], rewritten: true, entry };
  }
  return null;
}

/**
 * The one line printed when the child could not be started: what was asked for, what was resolved, from where, and (on Windows)
 * why a shim fails. Never prints the environment, and never the arguments (they can carry tokens or credential URLs): only how
 * many there were.
 */
export function describeSpawnFailure({ cmd, spawnError, target, cwd = process.cwd(), platform = process.platform }) {
  const t = target ?? { cmd, args: [] };
  const viaNode = t.rewritten && !t.direct;
  const n = (t.args ?? []).length - (viaNode ? 1 : 0); // a node-rewritten entry point is not a caller argument
  const exe = viaNode ? `${t.cmd} ${t.entry}` : t.cmd;
  const hint = platform === 'win32' && !t.rewritten
    ? ' On Windows a .cmd shim cannot be spawned without a shell: run the tool through node <entry-point>.js (for npm that is node_modules/npm/bin/npm-cli.js beside node.exe).'
    : '';
  return `could not start ${JSON.stringify(cmd)}: ${spawnError} (resolved: ${exe} +${n} arg(s); cwd: ${cwd}).${hint}`;
}
