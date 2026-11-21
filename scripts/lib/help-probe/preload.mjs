/**
 * @fileoverview `--import` preload for the `--help` read-only probe.
 *
 * Instruments the process the probe spawns: every filesystem WRITE, every
 * NETWORK attempt and every non-read-only child spawn is appended to the JSONL
 * file named by `HELP_PROBE_LOG` and then BLOCKED (throws), so probing a CLI that
 * ignores `--help` and runs for real can neither mutate the tree nor reach the
 * network while still being caught. `NODE_OPTIONS` carries this preload into
 * child `node` processes, so a CLI that re-spawns itself is covered too.
 *
 * Why an instrument and not a snapshot diff: a diff only sees what changed,
 * after the fact, and a CLI that deletes and rewrites the same bytes (or writes
 * outside the tree) reads clean. This sees the attempt.
 *
 * @module scripts/lib/help-probe/preload
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const LOG = process.env.HELP_PROBE_LOG;

// The probe's own log write, captured BEFORE `appendFileSync` is patched below.
// Low-level fd calls, NOT `appendFileSync`: the stock appendFileSync routes
// through the public `fs.writeFileSync`, which is patched below, so the log
// write would be blocked by its own instrument and every finding would vanish.
const rawOpen = fs.openSync;
const rawWrite = fs.writeSync;
const rawClose = fs.closeSync;
function record2(kind, detail) {
  if (!LOG) return;
  try {
    const fd = rawOpen.call(fs, LOG, 'a');
    rawWrite.call(fs, fd, `${JSON.stringify({ kind, detail, pid: process.pid })}\n`);
    rawClose.call(fs, fd);
  } catch { /* the log itself must never throw */ }
}

const WRITE_NAMES = [
  'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile',
  'cp', 'truncate', 'symlink', 'link', 'chmod', 'chown', 'utimes', 'createWriteStream',
];

function describe(args) {
  const a = args.find((x) => typeof x === 'string' || x instanceof URL || Buffer.isBuffer(x));
  return a ? String(a).slice(0, 200) : '';
}

function patchTable(target, name) {
  const orig = target[name];
  if (typeof orig !== 'function') return;
  target[name] = function patched(...args) {
    record2('fs-write', `${name} ${describe(args)}`);
    throw new Error(`help-probe: blocked fs-write ${name} ${describe(args)}`);
  };
}

for (const base of WRITE_NAMES) {
  for (const n of [base, `${base}Sync`]) patchTable(fs, n);
  patchTable(fsp, base);
  patchTable(fs.promises, base);
}
// `open` is a write only for a writing flag — string ('w', 'a+', 'r+') or numeric
// (O_WRONLY | O_RDWR | O_APPEND | O_CREAT | O_TRUNC). Callback, sync and promise forms.
const WRITE_MASK = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND
  | fs.constants.O_CREAT | fs.constants.O_TRUNC;
function isWritingFlag(flags) {
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  if (typeof flags === 'number') return (flags & WRITE_MASK) !== 0;
  return false;
}
for (const [target, n] of [[fs, 'open'], [fs, 'openSync'], [fsp, 'open'], [fs.promises, 'open']]) {
  const orig = target[n];
  target[n] = function patchedOpen(p, flags, ...rest) {
    if (isWritingFlag(flags)) {
      record2('fs-write', `${n}(${flags}) ${String(p).slice(0, 200)}`);
      throw new Error(`help-probe: blocked fs-write ${n} ${String(p).slice(0, 200)}`);
    }
    return orig.call(target, p, flags, ...rest);
  };
}

// Network.
net.Socket.prototype.connect = function patchedConnect(...args) {
  record2('network', `connect ${JSON.stringify(args[0])?.slice(0, 120)}`);
  throw new Error('help-probe: blocked network connect');
};
for (const n of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveTxt', 'resolveSrv', 'reverse']) {
  for (const target of [dns, dns.promises]) {
    if (typeof target[n] !== 'function') continue;
    target[n] = function blockedResolve(host) {
      record2('network', `dns.${n} ${String(host).slice(0, 80)}`);
      throw new Error(`help-probe: blocked dns.${n}`);
    };
  }
}
for (const n of ['send', 'connect', 'bind']) {
  dgram.Socket.prototype[n] = function blockedDgram() {
    record2('network', `dgram.${n}`);
    throw new Error(`help-probe: blocked dgram.${n}`);
  };
}
dns.lookup = function blockedLookup(host, ...rest) {
  record2('network', `dns ${host}`);
  const cb = rest.find((x) => typeof x === 'function');
  const err = new Error(`help-probe: blocked dns ${host}`);
  if (cb) { process.nextTick(cb, err); return undefined; }
  throw err;
};
for (const m of [http, https]) {
  for (const n of ['request', 'get']) {
    m[n] = function blockedHttp() {
      record2('network', `${m === http ? 'http' : 'https'}.${n}`);
      throw new Error('help-probe: blocked network request');
    };
  }
}
globalThis.fetch = function blockedFetch(u) {
  record2('network', `fetch ${String(u?.url ?? u).slice(0, 120)}`);
  return Promise.reject(new Error('help-probe: blocked network fetch'));
};

// Child processes: `node` (carries this preload via NODE_OPTIONS) and read-only
// git are allowed; anything else could mutate or reach out, so it is a finding.
const GIT_READ_ONLY = new Set([
  'rev-parse', 'status', 'log', 'diff', 'show', 'ls-files', 'rev-list', 'merge-base', 'cat-file',
  'describe', 'symbolic-ref', 'check-ignore', 'for-each-ref', 'blame', 'name-rev', 'diff-tree',
  'diff-index', 'show-ref', 'version', '--version', 'var',
]);

function spawnAllowed(cmd, args) {
  const base = String(cmd).replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd)$/i, '');
  if (base === 'node' || cmd === process.execPath) return true;
  if (base === 'git') {
    const rest = (args ?? []).filter((a) => !String(a).startsWith('-') || a === '--version');
    // First non-option token is the subcommand (skips `-C <dir>`, `-c k=v` values heuristically).
    const sub = rest.find((a) => GIT_READ_ONLY.has(a));
    if (sub) return true;
    if ((args ?? []).includes('config') && (args ?? []).some((a) => a === '--get' || a === '--get-all' || a === '--list' || a === '-l')) return true;
    if ((args ?? []).includes('worktree') && (args ?? []).includes('list')) return true;
    if ((args ?? []).includes('branch') && !(args ?? []).some((a) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)/.test(a))) return true;
    return false;
  }
  return false;
}

function patchSpawn(name, shape) {
  const orig = cp[name];
  cp[name] = function patchedSpawn(...args) {
    let cmd; let argv;
    if (shape === 'cmdline') { cmd = String(args[0]).trim().split(/\s+/)[0]; argv = String(args[0]).trim().split(/\s+/).slice(1); }
    else { cmd = args[0]; argv = Array.isArray(args[1]) ? args[1] : []; }
    if (!spawnAllowed(cmd, argv)) {
      record2('spawn', `${cmd} ${argv.join(' ')}`.slice(0, 200));
      throw new Error(`help-probe: blocked spawn ${cmd}`);
    }
    return orig.apply(cp, args);
  };
}
for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) patchSpawn(n, 'file');
for (const n of ['exec', 'execSync']) patchSpawn(n, 'cmdline');

syncBuiltinESMExports();
