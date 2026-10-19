/**
 * @fileoverview Consumer feedback PR 1, report 06a (docs/triage/copilot-feedback-2026-10-19.md): `fleet lease run -- npm ...`
 * must start on Windows without `shell: true`, and a spawn failure must name what was resolved and where.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { resolveSpawnTarget, describeSpawnFailure, runChild } from '../scripts/lib/fleet/lease-spawn.mjs';

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
