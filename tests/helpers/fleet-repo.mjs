/**
 * @fileoverview Shared test helper for the /fleet suites — throwaway git repos
 * with a bare local `origin`, a PATH-level fake `gh`, and a CLI runner whose
 * environment can never reach the real `gh`, the user's git identity or a hook's
 * exported GIT_* variables.
 *
 * The fake `gh` is a COPY OF THE NODE BINARY named `gh` (so `spawn('gh')` with
 * `shell:false` resolves it on every OS, including Windows where a `.cmd` shim is
 * not spawnable) plus a `--require` preload that recognises it is running AS `gh`
 * (by `process.execPath`) and answers from a JSON state file. Under the real
 * `node` the preload is a no-op, so tier commands that run `node` are unaffected.
 * It rejects any `--json` field that is not in the recorded real-field fixture,
 * so a request the real CLI would refuse fails here too.
 *
 * @module tests/helpers/fleet-repo
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git } from './git.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FLEET_CLI = path.resolve(HERE, '..', '..', 'scripts', 'fleet.mjs');
const FIELDS_FIXTURE = path.resolve(HERE, '..', 'fixtures', 'fleet', 'gh-pr-view-fields.json');
const IS_WIN = process.platform === 'win32';

const roots = [];
/** A realpath'd temp dir, removed by `cleanupFleetRoots`. */
export function tmpRoot(prefix = 'fleet-') {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(d);
  return d;
}
export function cleanupFleetRoots() {
  for (const d of roots.splice(0)) {
    try {
      // junctions to node_modules etc. are unlinked by git worktree remove; best effort here
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch { /* best effort */ }
  }
}

export function writeFile(repo, rel, body) {
  const f = path.join(repo, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

export function commitFile(repo, rel, body, msg = `edit ${rel}`) {
  writeFile(repo, rel, body);
  git(['add', rel], repo);
  git(['commit', '-q', '-m', msg], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

/**
 * A repo on `main` with a bare `origin` (already pushed). The integration
 * worktree root is `<root>/wt` (outside both the repo and `.git`).
 */
export function makeFleetRepo({ files = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }, fleetConfig = null } = {}) {
  const root = tmpRoot();
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(['init', '--bare', '-q', '-b', 'main', origin], root);
  git(['init', '-q', '-b', 'main'], repo);
  for (const [k, v] of Object.entries({ 'user.email': 't@example.com', 'user.name': 'T', 'commit.gpgsign': 'false', 'core.autocrlf': 'false' })) git(['config', k, v], repo);
  for (const [rel, body] of Object.entries(files)) writeFile(repo, rel, body);
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-q', '-u', 'origin', 'main'], repo);
  if (fleetConfig) writeFile(repo, '.fleet.json', JSON.stringify(fleetConfig));
  return { root, repo, origin, wtRoot: path.join(root, 'wt') };
}

/** Create `name` off main with one commit, then return to main. Returns the tip oid. */
export function addBranch(repo, name, files, msg = `work on ${name}`) {
  git(['checkout', '-q', '-b', name, 'main'], repo);
  for (const [rel, body] of Object.entries(files)) writeFile(repo, rel, body);
  git(['add', '--', ...Object.keys(files)], repo);
  git(['commit', '-q', '-m', msg], repo);
  const oid = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', 'main'], repo);
  return oid;
}

// ── environment ─────────────────────────────────────────────────────────────

function pathKey(env) { return Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'; }

const GH_NAMES = ['gh', 'gh.exe', 'gh.cmd', 'gh.bat'];
const TOOL_NAMES = IS_WIN ? ['git.exe', 'node.exe'] : ['git', 'node'];
const shims = new Map();

/**
 * A PATH directory that holds a real `gh` ALSO holds other tools (often git).
 * Dropping it would lose them, so instead build a private shim dir containing
 * ONLY the tools the tests need (git, node) — symlinked, or copied where symlinks
 * are not permitted — and use that in its place. The real gh is never reachable.
 */
function shimDirFor(dir) {
  if (shims.has(dir)) return shims.get(dir);
  const shim = tmpRoot('fleet-shim-');
  let any = false;
  for (const n of TOOL_NAMES) {
    const src = path.join(dir, n);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(shim, n);
    try { fs.symlinkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
    any = true;
  }
  shims.set(dir, any ? shim : null);
  return any ? shim : null;
}

/**
 * process.env minus GIT_*, with every PATH directory that contains a `gh`
 * replaced by a shim dir holding only git/node (see `shimDirFor`).
 * @param {object} [extra] env overrides
 * @param {{prependPath?: string[], basePath?: string[]}} [opts] `basePath` replaces the inherited PATH entries (tests)
 */
export function scrubbedEnv(extra = {}, { prependPath = [], basePath } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_/i.test(k)) delete env[k];
  const key = pathKey(env);
  const dirs = basePath ?? String(env[key] ?? '').split(path.delimiter);
  const kept = [];
  for (const d of dirs) {
    if (!d) continue;
    if (!GH_NAMES.some((n) => fs.existsSync(path.join(d, n)))) { kept.push(d); continue; }
    const shim = shimDirFor(d);
    if (shim) kept.push(shim);
  }
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env[key] = [...prependPath, ...kept].join(path.delimiter);
  delete env.NODE_OPTIONS;
  delete env.FLEET_NOW;
  return { ...env, ...extra };
}

/** Install the fake `gh`; returns the dir to prepend to PATH plus helpers to drive it. */
export function installFakeGh(root) {
  const bin = path.join(root, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, IS_WIN ? 'gh.exe' : 'gh');
  fs.copyFileSync(process.execPath, exe);
  if (!IS_WIN) fs.chmodSync(exe, 0o755);
  const preload = path.join(root, 'fake-gh.cjs');
  fs.writeFileSync(preload, `
const path = require('path');
if (/^gh(\\.exe)?$/i.test(path.basename(process.execPath))) {
  const fs = require('fs');
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  const out = (s) => { fs.writeSync(1, s); process.exit(0); };
  const fail = (m) => { fs.writeSync(2, m + '\\n'); process.exit(1); };
  const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
  const fields = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIELDS, 'utf8')).view;
  if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
  const ji = args.indexOf('--json');
  const req = ji < 0 ? [] : String(args[ji + 1]).split(',');
  for (const f of req) if (!fields.includes(f)) fail('Unknown JSON field: "' + f + '"');
  if (state.authFail) fail('To get started with GitHub CLI, please run:  gh auth login');
  if (args[0] === 'pr' && args[1] === 'list') {
    // Like real gh: only the requested fields come back, and a token that cannot read
    // check rollups fails ONLY the call that asks for statusCheckRollup.
    if (req.includes('statusCheckRollup') && state.checksFail) fail(state.checksFail);
    const omit = new Set(state.checksOmit ?? []);
    const rows = (state.list ?? []).filter((r) => !(req.includes('statusCheckRollup') && omit.has(r.number)));
    out(JSON.stringify(req.length ? rows.map((r) => { const o = {}; for (const f of req) if (f in r) o[f] = r[f]; return o; }) : rows));
  }
  else if (args[0] === 'pr' && args[1] === 'view') {
    const row = (state.view ?? {})[args[2]];
    if (!row) fail('no pull requests found for ' + args[2]);
    const o = {}; for (const f of req) if (f in row) o[f] = row[f];
    out(JSON.stringify(o));
  } else fail('fake gh: refusing ' + args.join(' '));
}
`);
  const state = path.join(root, 'fake-gh-state.json');
  const log = path.join(root, 'fake-gh.log');
  fs.writeFileSync(state, JSON.stringify({ list: [], view: {} }));
  fs.writeFileSync(log, '');
  return {
    bin,
    env: { // Node's NODE_OPTIONS parser splits on spaces unless the value is double-quoted.
    NODE_OPTIONS: `--require="${preload.replace(/\\/g, '/')}"`, FAKE_GH_STATE: state, FAKE_GH_FIELDS: FIELDS_FIXTURE, FAKE_GH_LOG: log },
    setState(s) { fs.writeFileSync(state, JSON.stringify(s)); },
    calls() { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); },
  };
}

/** A gh `pr list`/`view` row for `branch` targeting `main`. */
export function prRow({ number, branch, headOid, baseOid, repo = 'o/n', state = 'OPEN' }) {
  const [owner, name] = repo.split('/');
  return {
    number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, state, isDraft: false, isCrossRepository: false,
    headRefName: branch, headRefOid: headOid, headRepository: { name }, headRepositoryOwner: { login: owner },
    baseRefName: 'main', baseRefOid: baseOid, statusCheckRollup: [], updatedAt: '2026-10-05T00:00:00Z', mergeCommit: null,
  };
}

// ── running the CLI ─────────────────────────────────────────────────────────

/** Run `fleet.mjs` synchronously. `json` is the parsed stdout when it is JSON. */
export function runFleet(args, { cwd, env }) {
  const r = spawnSync(process.execPath, [FLEET_CLI, ...args], { cwd, env, encoding: 'utf-8', timeout: 180_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/**
 * Async variant (for genuinely concurrent processes) with the SAME lifecycle
 * guarantees as `runFleet`: a spawn error rejects, and a deadline (default 180s,
 * `timeoutMs` overrides it for tests) kills the child and rejects with a clear message.
 */
export function runFleetAsync(args, { cwd, env, timeoutMs = 180_000 }) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [FLEET_CLI, ...args], { cwd, env });
    let stdout = ''; let stderr = ''; let settled = false;
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      c.kill('SIGKILL');
      settle(reject, new Error(`fleet ${args.join(' ')} timed out after ${timeoutMs}ms (child killed)`));
    }, timeoutMs);
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('error', (e) => settle(reject, new Error(`fleet ${args.join(' ')} could not run: ${e.message}`)));
    c.on('close', (status) => { let json = null; try { json = JSON.parse(stdout); } catch { /* human */ } settle(resolve, { status, stdout, stderr, json }); });
  });
}

/** Every file under `dir` → sha-free byte snapshot (path → contents), for "byte-identical" assertions. */
export function snapshotDir(dir) {
  const out = {};
  const walk = (d) => {
    let names; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
