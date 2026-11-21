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
// EVERY resolver entry point on both the callback and promise APIs (resolve*, reverse,
// lookup, lookupService, ...), enumerated from the module rather than listed by hand —
// a fixed name list is what let `dns.promises.lookup` / `resolveMx` through. Pure
// accessors (setServers, getServers, setDefaultResultOrder, Resolver) do no I/O.
const DNS_NO_IO = new Set(['setServers', 'getServers', 'setDefaultResultOrder', 'getDefaultResultOrder', 'Resolver', 'promises']);
for (const target of [dns, dns.promises]) {
  for (const n of Object.keys(target)) {
    if (typeof target[n] !== 'function' || DNS_NO_IO.has(n) || n === 'lookup') continue;
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
dns.promises.lookup = function blockedLookupPromise(host) {
  record2('network', `dns.promises.lookup ${String(host).slice(0, 80)}`);
  return Promise.reject(new Error(`help-probe: blocked dns.promises.lookup ${host}`));
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

// Descriptor-based mutations the path-keyed table above cannot see. A write to
// stdout/stderr (fd 1, 2 — the help guard, console) stays allowed; any other fd is a write.
for (const n of ['fchmod', 'fchown', 'futimes', 'ftruncate', 'lchmod', 'lchown', 'lutimes']) {
  for (const suffix of ['', 'Sync']) patchTable(fs, `${n}${suffix}`);
}
for (const n of ['write', 'writeSync', 'writev', 'writevSync']) {
  const orig = fs[n];
  if (typeof orig !== 'function') continue;
  fs[n] = function patchedFdWrite(fd, ...rest) {
    if (fd === 1 || fd === 2) return orig.call(fs, fd, ...rest);
    record2('fs-write', `${n}(fd ${String(fd)})`);
    throw new Error(`help-probe: blocked fs-write ${n} on fd ${String(fd)}`);
  };
}

// Child processes: `node` (re-armed with this preload below) and read-only git are
// allowed; anything else could mutate or reach out, so it is a finding.
const GIT_READ_ONLY = new Set([
  'rev-parse', 'status', 'log', 'diff', 'show', 'ls-files', 'rev-list', 'merge-base', 'cat-file',
  'describe', 'symbolic-ref', 'check-ignore', 'for-each-ref', 'blame', 'name-rev', 'diff-tree',
  'diff-index', 'show-ref', 'version', 'var',
]);
// Options that precede the subcommand and take a SEPARATE value.
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** The real git subcommand and its remaining args: skip global options and their values. */
function gitSubcommand(args) {
  let i = 0;
  while (i < args.length) {
    const a = String(args[i]);
    if (GIT_GLOBAL_WITH_VALUE.has(a)) { i += 2; continue; }
    if (a.startsWith('-')) { i += 1; continue; }
    return { sub: a, rest: args.slice(i + 1).map(String) };
  }
  return { sub: null, rest: [] };
}

/** A subcommand that can ALSO write, allowed only in its listing/reading form. */
function gitReadOnlyForm(sub, rest) {
  // Even a read-only subcommand can write OUTSIDE node's fs instrumentation through
  // an output option (`git diff --output=<file>`, `--output <file>`, `-o <file>`).
  if (rest.some((a) => /^--output(?:=|$)|^-o$/.test(a))) return false;
  if (GIT_READ_ONLY.has(sub)) return true;
  if (sub === 'config') return rest.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a));
  if (sub === 'worktree') return rest[0] === 'list';
  if (sub === 'remote') return rest.length === 0 || (rest[0] === 'get-url') || rest.every((a) => a === '-v' || a === '--verbose');
  if (sub === 'branch') {
    // Listing forms only: no positional (a bare name CREATES a branch) and no mutating flag.
    const flags = rest.filter((a) => a.startsWith('-'));
    const positional = rest.filter((a) => !a.startsWith('-'));
    const listing = flags.some((a) => ['--list', '-l', '--show-current', '-a', '-r', '--all', '--remotes', '--contains', '--merged', '--no-merged'].includes(a));
    return flags.every((a) => !/^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(a))
      && (positional.length === 0 || listing);
  }
  return false;
}

// A shell string (exec/execSync) is validated as a WHOLE: any metacharacter that
// chains, pipes, redirects or substitutes makes the first-token check meaningless.
const SHELL_META = /[;&|<>`$(){}\n\r]/;

function spawnAllowed(cmd, args, viaShell, isFork = false) {
  const base = String(cmd).replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd)$/i, '');
  if (viaShell && SHELL_META.test([cmd, ...(args ?? [])].join(' '))) return false;
  if (base === 'node' || cmd === process.execPath) return true;
  // `fork(modulePath)` runs the module under Node itself (inheriting the preload).
  if (isFork) return true;
  if (base === 'git') {
    const { sub, rest } = gitSubcommand(args ?? []);
    return sub !== null && gitReadOnlyForm(sub, rest);
  }
  return false;
}

const PROBE_ENV_KEYS = ['NODE_OPTIONS', 'HELP_PROBE_LOG'];

/** A child given an EXPLICIT env that omits the preload would run uninstrumented: re-arm it. */
function withProbeEnv(opts) {
  if (!opts || typeof opts !== 'object' || !opts.env) return opts;
  const env = { ...opts.env };
  for (const k of PROBE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...opts, env };
}

function patchSpawn(name, shape) {
  const orig = cp[name];
  cp[name] = function patchedSpawn(...args) {
    let cmd; let argv;
    const viaShell = shape === 'cmdline';
    if (viaShell) { cmd = String(args[0]).trim().split(/\s+/)[0]; argv = String(args[0]).trim().split(/\s+/).slice(1); }
    else { cmd = args[0]; argv = Array.isArray(args[1]) ? args[1] : []; }
    // `shell: true` makes an array-form call a shell string as well.
    const optsIdx = args.findIndex((x, i) => i > 0 && x && typeof x === 'object' && !Array.isArray(x));
    const shell = viaShell || (optsIdx !== -1 && args[optsIdx].shell);
    if (!spawnAllowed(cmd, argv, shell, name === 'fork')) {
      record2('spawn', `${cmd} ${argv.join(' ')}`.slice(0, 200));
      throw new Error(`help-probe: blocked spawn ${cmd}`);
    }
    if (optsIdx !== -1) args[optsIdx] = withProbeEnv(args[optsIdx]);
    return orig.apply(cp, args);
  };
}
for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) patchSpawn(n, 'file');
for (const n of ['exec', 'execSync']) patchSpawn(n, 'cmdline');

syncBuiltinESMExports();
