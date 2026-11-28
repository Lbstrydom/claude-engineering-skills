/**
 * @fileoverview Consumer feedback PR 1, report 06a (docs/triage/copilot-feedback-2026-10-19.md): `fleet lease run -- npm ...`
 * must start on Windows without `shell: true`, and a spawn failure must name what was resolved and where.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { resolveSpawnTarget, describeSpawnFailure, runChild } from '../scripts/lib/fleet/lease-spawn.mjs';
import { cmdShimEntry, parseCmdShim } from '../scripts/lib/spawn-target.mjs';

describe('resolveSpawnTarget (Windows npm without a shell)', () => {
  const w = path.win32;
  const execPath = 'C:\\Program Files\\nodejs\\node.exe';
  const bundledDir = 'C:\\Program Files\\nodejs';
  const globalDir = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const entry = (dir, f = 'npm-cli.js') => w.join(dir, 'node_modules', 'npm', 'bin', f);
  const files = (...p) => (x) => p.includes(x);

  it('maps npm and npm.cmd to node + npm-cli.js on win32', () => {
    const exists = files(w.join(bundledDir, 'npm.cmd'), entry(bundledDir));
    for (const c of ['npm', 'npm.cmd']) {
      const t = resolveSpawnTarget({ cmd: c, args: ['ci'], platform: 'win32', execPath, exists, pathEnv: bundledDir });
      assert.equal(t.cmd, execPath);
      assert.deepEqual(t.args, [entry(bundledDir), 'ci']);
      assert.equal(t.rewritten, true);
    }
  });

  it('follows PATH precedence: a globally upgraded npm that comes first on PATH shadows the bundled one', () => {
    const exists = files(w.join(globalDir, 'npm.cmd'), entry(globalDir), w.join(bundledDir, 'npm.cmd'), entry(bundledDir));
    const t = resolveSpawnTarget({ cmd: 'npm', args: ['ci'], platform: 'win32', execPath, exists, pathEnv: `${globalDir};${bundledDir}` });
    assert.equal(t.entry, entry(globalDir));
    const t2 = resolveSpawnTarget({ cmd: 'npm', args: ['ci'], platform: 'win32', execPath, exists, pathEnv: `${bundledDir};${globalDir}` });
    assert.equal(t2.entry, entry(bundledDir), 'the order on PATH decides, not which is newer');
  });

  it('skips a PATH dir whose npm.cmd has no node entry point beside it (a version-manager shim) and falls back beside node', () => {
    const shimDir = 'C:\\nvm\\shims';
    const exists = files(w.join(shimDir, 'npm.cmd'), entry(bundledDir));
    const t = resolveSpawnTarget({ cmd: 'npm', args: [], platform: 'win32', execPath, exists, pathEnv: shimDir });
    assert.equal(t.entry, entry(bundledDir));
  });

  it('maps npx to npx-cli.js when present', () => {
    const exists = files(w.join(bundledDir, 'npx.cmd'), entry(bundledDir, 'npx-cli.js'));
    const t = resolveSpawnTarget({ cmd: 'npx', args: ['playwright', 'test'], platform: 'win32', execPath, exists, pathEnv: bundledDir });
    assert.deepEqual(t.args, [entry(bundledDir, 'npx-cli.js'), 'playwright', 'test']);
  });

  it('is the identity off win32, for other commands, for explicit paths, and when no entry point exists', () => {
    const exists = files(entry(bundledDir), w.join(bundledDir, 'npm.cmd'));
    const run = (o) => resolveSpawnTarget({ args: ['ci'], platform: 'win32', execPath, exists, pathEnv: bundledDir, ...o });
    assert.equal(run({ cmd: 'npm', platform: 'linux' }).rewritten, false);
    assert.equal(run({ cmd: 'git' }).rewritten, false);
    assert.equal(run({ cmd: 'C:\\tools\\npm.cmd' }).rewritten, false);
    assert.equal(run({ cmd: 'npm', exists: () => false }).rewritten, false);
  });

  it('never enables a shell: runChild spawns with shell false on the rewritten target', async () => {
    let seen;
    const fakeSpawn = (cmd, args, opts) => {
      seen = { cmd, args, opts };
      const c = new EventEmitter(); c.pid = 1;
      setImmediate(() => { c.emit('spawn'); c.emit('close', 0, null); });
      return c;
    };
    const exists = files(w.join(bundledDir, 'npm.cmd'), entry(bundledDir));
    const r = await runChild({ cmd: 'npm', args: ['ci'], spawn: fakeSpawn, platform: 'win32', execPath, exists, pathEnv: bundledDir });
    assert.equal(r.code, 0);
    assert.equal(seen.cmd, execPath);
    assert.equal(seen.opts.shell, false);
  });
});

describe('describeSpawnFailure', () => {
  it('names the requested command, the resolved executable and the cwd, and hints at the Windows cause', () => {
    const msg = describeSpawnFailure({
      cmd: 'pnpm', spawnError: 'spawn pnpm ENOENT', target: { cmd: 'pnpm', args: ['i'], rewritten: false },
      cwd: 'C:\\repo', platform: 'win32',
    });
    assert.match(msg, /could not start "pnpm"/);
    assert.match(msg, /spawn pnpm ENOENT/);
    assert.match(msg, /cwd: C:\\repo/);
    assert.match(msg, /resolved: pnpm \+1 arg\(s\)/);
    assert.match(msg, /node <entry-point>\.js/, 'a Windows shim hint');
  });

  it('prints the entry point for a rewritten target but never the arguments or the environment', () => {
    const msg = describeSpawnFailure({
      cmd: 'npm', spawnError: 'x', cwd: '/r', platform: 'win32',
      target: { cmd: 'node.exe', args: ['npm-cli.js', 'publish', '--//registry/:_authToken=hunter2'], rewritten: true, entry: 'npm-cli.js' },
    });
    assert.match(msg, /resolved: node\.exe npm-cli\.js \+2 arg\(s\)/);
    assert.doesNotMatch(msg, /hunter2|authToken/);
  });
});

describe('command-name normalisation', () => {
  const w = path.win32;
  const dir = 'C:/n'.replaceAll('/', String.fromCharCode(92));
  const exists = (p) => [w.join(dir, 'npm.cmd'), w.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')].includes(p);
  const run = (cmd) => resolveSpawnTarget({ cmd, args: [], platform: 'win32', execPath: dir + String.fromCharCode(92) + 'node.exe', exists, pathEnv: dir });

  it('strips only a literal .cmd extension, in any case', () => {
    assert.equal(run('NPM.CMD').rewritten, true);
    assert.equal(run('npm.cmd').rewritten, true);
  });

  it('does not treat a name that merely ends in cmd as the shim (the dot is literal)', () => {
    assert.equal(run('npm-cmd').rewritten, false);
    assert.equal(run('npmXcmd').rewritten, false);
  });
});

describe('resolveSpawnTarget (recognised .cmd shim templates: corepack, pnpm, npm global bins)', () => {
  const w = path.win32;
  const execPath = String.raw`C:\Program Files\nodejs\node.exe`;
  const nodeDir = String.raw`C:\Program Files\nodejs`;
  const globalDir = String.raw`C:\Users\u\AppData\Roaming\npm`;
  const crlf = (s) => s.split('\n').join('\r\n');
  // The bodies as their generators write them (captured 2026-11-28), CRLF and indentation as on disk.
  const COREPACK_CMD = crlf(String.raw`@SETLOCAL
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\node_modules\corepack\dist\corepack.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\node_modules\corepack\dist\corepack.js" %*
)
`);
  const PNPM_CMD = String.raw`@ECHO off
SETLOCAL
SET "_prog=node"
SET PATHEXT=%PATHEXT:;.JS;=;%

endLocal & "%_prog%" "%APPDATA%\..\Local\node\corepack\v1\pnpm\11.21.0\bin\pnpm.cjs" %*
`;
  const npmShim = (script) => crlf(String.raw`@ECHO off
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

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${script}" %*
`);
  const npmExeShim = (exe) => crlf(String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"${exe}"   %*
`);
  const corepackJs = w.join(nodeDir, 'node_modules', 'corepack', 'dist', 'corepack.js');
  const pnpmCjs = String.raw`C:\Users\u\AppData\Local\node\corepack\v1\pnpm\11.21.0\bin\pnpm.cjs`;
  const tscJs = w.join(globalDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const claudeExe = w.join(globalDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const files = {
    [w.join(nodeDir, 'corepack.cmd')]: COREPACK_CMD,
    [w.join(globalDir, 'pnpm.cmd')]: PNPM_CMD,
    [w.join(globalDir, 'tsc.cmd')]: npmShim(String.raw`%dp0%\node_modules\typescript\bin\tsc`),
    [w.join(globalDir, 'claude.cmd')]: npmExeShim(String.raw`%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe`),
  };
  const scripts = [corepackJs, pnpmCjs, tscJs, claudeExe];
  const exists = (p) => p in files || scripts.includes(p);
  const readFile = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
  const env = { APPDATA: String.raw`C:\Users\u\AppData\Roaming` };
  const cwd = String.raw`C:\repo`;
  const run = (cmd, o = {}) => resolveSpawnTarget({ cmd, args: ['-v'], platform: 'win32', execPath, exists, readFile, env, cwd, pathEnv: `${globalDir};${nodeDir}`, ...o });

  it('rewrites each recognised template to node + its script (or the exe itself)', () => {
    const c = run('corepack');
    assert.deepEqual([c.cmd, c.args], [execPath, [corepackJs, '-v']]);
    assert.equal(run('COREPACK.CMD').entry, corepackJs);
    assert.equal(run('pnpm').entry, pnpmCjs, '%APPDATA% expanded from env');
    assert.equal(run('tsc').entry, tscJs, 'npm cmd-shim, extensionless script');
    const cl = run('claude');
    assert.deepEqual([cl.cmd, cl.args, cl.direct], [claudeExe, ['-v'], true], 'npm exe shim spawns the exe directly');
  });

  it('chooses node as the shim does: `prog` prefers node.exe beside the shim, `path` (pnpm) never does', () => {
    const beside = w.join(globalDir, 'node.exe');
    const earlier = w.join(cwd, 'node.exe');
    const withNodes = (p) => p === beside || p === earlier || exists(p);
    assert.equal(run('tsc', { exists: withNodes }).cmd, beside);
    assert.equal(run('pnpm', { exists: withNodes }).cmd, earlier, 'pnpm sets _prog=node: the lookup decides, cwd first');
    assert.equal(run('pnpm').cmd, execPath, 'no node.exe found by the lookup: the running node');
  });

  it('a .cmd that is not exactly a template is returned by FULL PATH, never rewritten', () => {
    const shim = w.join(globalDir, 'tsc.cmd');
    const variant = (body) => run('tsc', { readFile: (p) => (p === shim ? body : readFile(p)) });
    const exitFirst = npmShim(String.raw`%dp0%\node_modules\typescript\bin\tsc`).replace('SETLOCAL', 'SETLOCAL\r\nexit /b 0');
    assert.deepEqual([variant(exitFirst).cmd, variant(exitFirst).rewritten], [shim, false], 'an exit before the launch');
    const extraArg = npmShim(String.raw`%dp0%\node_modules\typescript\bin\tsc`).replace('" %*', '" --strict %*');
    assert.equal(variant(extraArg).rewritten, false, 'a fixed argument a rewrite would drop');
    const otherNode = npmShim(String.raw`%dp0%\node_modules\typescript\bin\tsc`).replace('SET "_prog=node"', String.raw`SET "_prog=C:\node18\node.exe"`);
    assert.equal(variant(otherNode).rewritten, false, 'a different _prog');
    assert.equal(variant('@echo "%~dp0\\x.js"\r\n').rewritten, false);
  });

  it('follows the shell lookup: cwd first, .com/.exe spawn unchanged, a .bat is returned by full path', () => {
    assert.equal(run('corepack', { exists: (p) => p === w.join(cwd, 'corepack.exe') || exists(p) }).cmd, 'corepack');
    const bat = w.join(nodeDir, 'corepack.bat');
    assert.equal(run('corepack', { exists: (p) => p === bat || exists(p) }).cmd, bat);
  });

  it('honours an explicit extension: tool.exe is never rewritten, corepack.cmd is used even when corepack.exe comes first', () => {
    assert.equal(run('corepack.exe').rewritten, false);
    const exeFirst = (p) => p === w.join(globalDir, 'corepack.exe') || exists(p);
    assert.equal(run('corepack.cmd', { exists: exeFirst }).entry, corepackJs);
    assert.equal(run(String.raw`C:\tools\corepack.cmd`).rewritten, false, 'an explicit path is the caller choosing');
  });

  it('leaves it unrewritten when a variable is unset or the script is missing', () => {
    assert.equal(run('pnpm', { env: {} }).rewritten, false, 'unset %APPDATA% is unresolvable, never a guess');
    assert.equal(run('corepack', { exists: (p) => p in files }).rewritten, false);
    assert.equal(run('git').rewritten, false);
  });

  it('parseCmdShim: corepack must name the SAME script in both branches; the exe template needs an .exe', () => {
    assert.equal(parseCmdShim(COREPACK_CMD).template, 'corepack');
    assert.equal(parseCmdShim(COREPACK_CMD.replace('dist\\corepack.js" %*\r\n)', 'dist\\other.js" %*\r\n)')), null);
    assert.equal(parseCmdShim(npmExeShim(String.raw`%dp0%\x.js`)), null);
    assert.equal(parseCmdShim(npmShim(String.raw`%dp0%\x.exe`)), null);
  });

  it('expands paths literally ($& in a directory) and keeps the script case', () => {
    const dollar = String.raw`C:\tools\$&`;
    assert.equal(cmdShimEntry(COREPACK_CMD, dollar, {}, cwd), w.join(dollar, 'node_modules', 'corepack', 'dist', 'corepack.js'));
    assert.equal(parseCmdShim(npmShim(String.raw`%dp0%\node_modules\@Scope\Pkg\Bin.js`)).script, String.raw`%dp0%\node_modules\@Scope\Pkg\Bin.js`);
  });

  it('describeSpawnFailure counts arguments right for a direct exe target', () => {
    const msg = describeSpawnFailure({ cmd: 'claude', spawnError: 'x', cwd, platform: 'win32',
      target: { cmd: claudeExe, args: ['-p', 'hi'], rewritten: true, entry: claudeExe, direct: true } });
    assert.match(msg, /claude\.exe \+2 arg\(s\)/);
  });
});
