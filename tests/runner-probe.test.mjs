import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultInstallRoots,
  resolveRunnerArtifact,
  readInstallFacts,
  probeSupervision,
  isTrustedHost,
  fetchRemoteRunner,
  readCurrentRepoOwners,
  loadLocalRunnerConfig,
  discoverInstalls,
} from '../scripts/lib/runner-probe.mjs';

// `resolveRunnerChild` (the generic, arbitrary-name containment resolver) is
// PRIVATE and stays that way — audit round 2 (M3/M5) found it re-exposed via
// `_internals`, which is itself an exported value any production caller could
// import and use to reach `.credentials`/`.credentials_rsaparams`. Every test
// below therefore exercises the containment logic ONLY through the narrow,
// enum-restricted public API, `resolveRunnerArtifact('runner'|'service', …)` —
// the same path a real caller is limited to.

const FIXTURE_ROOT = path.join(process.cwd(), 'tests', 'fixtures', 'runner', 'synthetic-install');

// ─────────────────────────────────────────────────────────────────────────
// Fake, fully in-memory fs — never touches the real filesystem, so a test
// machine that genuinely has a corporate runner at C:\actions-runner (the
// plan's own motivating incident) is never at risk of being read from.
// Keys are normalised (lower-cased, forward-slash) so callers can write
// either separator style.
// ─────────────────────────────────────────────────────────────────────────

function normKey(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

function makeFakeFs(rawNodes) {
  const nodes = {};
  for (const [k, v] of Object.entries(rawNodes)) nodes[normKey(k)] = v;
  const reads = [];

  function resolveReal(p) {
    let current = normKey(p);
    let hops = 0;
    while (nodes[current] && nodes[current].type === 'symlink') {
      current = normKey(nodes[current].target);
      hops += 1;
      if (hops > 10) { const e = new Error('too many levels of symbolic links'); e.code = 'ELOOP'; throw e; }
    }
    if (!nodes[current]) { const e = new Error(`ENOENT: no such file or directory, '${p}'`); e.code = 'ENOENT'; throw e; }
    return current;
  }

  return {
    reads,
    lstatSync(p) {
      const k = normKey(p);
      if (!nodes[k]) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      const n = nodes[k];
      return { isDirectory: () => n.type === 'dir', isSymbolicLink: () => n.type === 'symlink' };
    },
    realpathSync(p) {
      return resolveReal(p);
    },
    statSync(p) {
      const real = resolveReal(p);
      const n = nodes[real];
      return { isDirectory: () => n.type === 'dir', mtime: n.mtime || new Date('2026-08-01T00:00:00.000Z') };
    },
    readFileSync(p) {
      reads.push(p);
      const real = resolveReal(p);
      const n = nodes[real];
      if (n.type !== 'file') { const e = new Error(`EISDIR: ${p}`); e.code = 'EISDIR'; throw e; }
      return n.content;
    },
  };
}

function trackingRealFs() {
  const reads = [];
  return {
    reads,
    lstatSync: (...args) => fs.lstatSync(...args),
    realpathSync: (...args) => fs.realpathSync(...args),
    statSync: (...args) => fs.statSync(...args),
    readFileSync: (p, ...rest) => { reads.push(p); return fs.readFileSync(p, ...rest); },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// defaultInstallRoots
// ─────────────────────────────────────────────────────────────────────────

test('defaultInstallRoots: win32 uses C:\\actions-runner + %USERPROFILE%\\actions-runner, all local-kind', () => {
  const roots = defaultInstallRoots('win32');
  assert.equal(roots.length, 2);
  assert.ok(roots.every((r) => r.kind === 'local'));
  assert.ok(roots.some((r) => r.path === 'C:\\actions-runner'));
});

test('defaultInstallRoots: linux/darwin use ~/actions-runner + /opt/actions-runner, all local-kind', () => {
  for (const platform of ['linux', 'darwin']) {
    const roots = defaultInstallRoots(platform);
    assert.equal(roots.length, 2);
    assert.ok(roots.every((r) => r.kind === 'local'));
    assert.ok(roots.some((r) => r.path === '/opt/actions-runner'));
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Containment (R1 H4) — via resolveRunnerArtifact, the only reachable API
// ─────────────────────────────────────────────────────────────────────────

test('resolveRunnerArtifact: a .runner symlink resolving OUTSIDE the canonicalised root is refused, fail-closed', () => {
  const fakeFs = makeFakeFs({
    'C:/fake-root': { type: 'dir' },
    'C:/fake-root/.runner': { type: 'symlink', target: 'C:/fake-outside/secret.json' },
    'C:/fake-outside/secret.json': { type: 'file', content: '{"leaked":true}' },
  });
  const result = resolveRunnerArtifact('C:/fake-root', 'runner', { fs: fakeFs });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ESCAPES_ROOT');
  assert.deepEqual(fakeFs.reads, []); // never actually read the escaping target
});

test('resolveRunnerArtifact: a .runner resolving INSIDE the root succeeds', () => {
  const fakeFs = makeFakeFs({
    'C:/fake-root': { type: 'dir' },
    'C:/fake-root/.runner': { type: 'file', content: '{}' },
  });
  const result = resolveRunnerArtifact('C:/fake-root', 'runner', { fs: fakeFs });
  assert.equal(result.ok, true);
});

test('resolveRunnerArtifact: an absent child returns CHILD_ABSENT, not a crash', () => {
  const fakeFs = makeFakeFs({ 'C:/fake-root': { type: 'dir' } });
  const result = resolveRunnerArtifact('C:/fake-root', 'runner', { fs: fakeFs });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CHILD_ABSENT');
});

// ─────────────────────────────────────────────────────────────────────────
// resolveRunnerArtifact — the narrow public API (audit round 1, M2).
// A credential filename must be UNREPRESENTABLE, not merely undocumented.
// ─────────────────────────────────────────────────────────────────────────

test('resolveRunnerArtifact: "runner" and "service" resolve exactly like the private helper', () => {
  const fakeFs = makeFakeFs({
    'C:/fake-root': { type: 'dir' },
    'C:/fake-root/.runner': { type: 'file', content: '{}' },
    'C:/fake-root/.service': { type: 'file', content: 'svc' },
  });
  assert.equal(resolveRunnerArtifact('C:/fake-root', 'runner', { fs: fakeFs }).ok, true);
  assert.equal(resolveRunnerArtifact('C:/fake-root', 'service', { fs: fakeFs }).ok, true);
});

test('resolveRunnerArtifact: no artifact value can name .credentials or .credentials_rsaparams', () => {
  const fakeFs = makeFakeFs({
    'C:/fake-root': { type: 'dir' },
    'C:/fake-root/.credentials': { type: 'file', content: '{"secret":true}' },
    'C:/fake-root/.credentials_rsaparams': { type: 'file', content: '{"secret":true}' },
  });
  // Neither the real basename nor the enum-ish spelling reaches a file —
  // every non-recognised value is UNKNOWN_ARTIFACT, never a filesystem read.
  for (const bogus of ['.credentials', '.credentials_rsaparams', 'credentials', 'credentials_rsaparams']) {
    const result = resolveRunnerArtifact('C:/fake-root', bogus, { fs: fakeFs });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'UNKNOWN_ARTIFACT');
  }
  assert.deepEqual(fakeFs.reads, []); // nothing was ever opened
});

// ─────────────────────────────────────────────────────────────────────────
// readInstallFacts — broken root symlink degrades to error, never aborts;
// NEVER reads .credentials/.credentials_rsaparams; no recursive traversal.
// ─────────────────────────────────────────────────────────────────────────

test('readInstallFacts: a root that is a broken symlink degrades to the error (UNREADABLE) variant', () => {
  const fakeFs = makeFakeFs({
    'C:/broken-root': { type: 'symlink', target: 'C:/does-not-exist' },
  });
  const result = readInstallFacts('C:/broken-root', { fs: fakeFs });
  assert.ok(result.error);
  assert.equal(result.error.code, 'UNREADABLE');
});

test('readInstallFacts: a root that simply does not exist yields NOT_CONFIGURED (the "absent" case upstream)', () => {
  const fakeFs = makeFakeFs({});
  const result = readInstallFacts('C:/nowhere', { fs: fakeFs });
  assert.equal(result.error.code, 'NOT_CONFIGURED');
});

test('readInstallFacts: a root that exists but has no .runner yields NOT_CONFIGURED, not a crash', () => {
  const fakeFs = makeFakeFs({ 'C:/empty-root': { type: 'dir' } });
  const result = readInstallFacts('C:/empty-root', { fs: fakeFs });
  assert.equal(result.error.code, 'NOT_CONFIGURED');
});

test('readInstallFacts: NEVER reads .credentials or .credentials_rsaparams — tracked via a read-tracking fs wrapper over the real synthetic fixture', () => {
  const tracker = trackingRealFs();
  const result = readInstallFacts(FIXTURE_ROOT, { fs: tracker });
  assert.equal(result.error, undefined, 'the fixture must parse cleanly');
  assert.equal(result.agentName, 'synthetic-test-agent');
  const readCredentials = tracker.reads.some((p) => /\.credentials(_rsaparams)?$/.test(String(p)));
  assert.equal(readCredentials, false, '.credentials/.credentials_rsaparams must never be opened');
});

test('readInstallFacts: no recursive traversal — a decoy nested directory with its own .runner is never read', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-probe-noswalk-'));
  try {
    fs.writeFileSync(path.join(tmpRoot, '.runner'), JSON.stringify({
      agentId: 1, agentName: 'root-agent', gitHubUrl: 'https://github.com/example-owner/example-repo',
    }));
    const nested = path.join(tmpRoot, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, '.runner'), JSON.stringify({
      agentId: 999, agentName: 'DECOY-should-never-be-read', gitHubUrl: 'https://github.com/decoy/decoy',
    }));

    const tracker = trackingRealFs();
    const result = readInstallFacts(tmpRoot, { fs: tracker });
    assert.equal(result.error, undefined);
    assert.equal(result.agentName, 'root-agent');
    assert.ok(!tracker.reads.some((p) => String(p).includes('nested')), 'the nested decoy .runner must never be opened');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// probeSupervision — tri/four-state serviceState, process attribution,
// unsupervisedForegroundPids, and WSL wrapping.
// ─────────────────────────────────────────────────────────────────────────

function makePosixStub({ serviceMode = null, pgrepStdout = '', cwdByPid = {}, ppidByPid = {}, commByPpid = {} } = {}) {
  const calls = [];
  const fn = (file, args) => {
    calls.push({ file, args });
    if (file === 'systemctl') {
      if (serviceMode === 'registered') return { status: 0, stdout: 'enabled\n', stderr: '' };
      if (serviceMode === 'not-registered') return { status: 4, stdout: '', stderr: 'Failed to get unit file state for x.service: No such file or directory\n' };
      if (serviceMode === 'unknown') return { status: null, stdout: '', stderr: '', spawnError: { code: 'ENOENT', message: 'systemctl missing' } };
      throw new Error('systemctl should not have been called for this test');
    }
    if (file === 'pgrep') {
      return pgrepStdout ? { status: 0, stdout: pgrepStdout, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (file === 'readlink') {
      const m = args[1].match(/\/proc\/(\d+)\/cwd/);
      const pid = m && m[1];
      const cwd = cwdByPid[pid];
      return cwd ? { status: 0, stdout: cwd, stderr: '' } : { status: 1, stdout: '', stderr: 'no such file' };
    }
    if (file === 'ps' && args.includes('ppid=')) {
      const pid = args[args.length - 1];
      const ppid = ppidByPid[pid];
      return ppid ? { status: 0, stdout: String(ppid), stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (file === 'ps' && args.includes('comm=')) {
      const ppid = args[args.length - 1];
      const comm = commByPpid[ppid];
      return comm ? { status: 0, stdout: comm, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unhandled stub call' };
  };
  fn.calls = calls;
  return fn;
}

test('probeSupervision (posix): serviceState is no-declaration when .service was absent — no systemctl call at all', () => {
  const execFn = makePosixStub();
  const result = probeSupervision({ root: 'C:/x', declaredServiceName: null }, { platform: 'linux', execFn });
  assert.equal(result.value.serviceState, 'no-declaration');
  assert.ok(!execFn.calls.some((c) => c.file === 'systemctl'));
});

test('probeSupervision (posix): registered / not-registered / unknown are three distinct, independently triggerable outcomes', () => {
  for (const [serviceMode, expected] of [['registered', 'registered'], ['not-registered', 'not-registered'], ['unknown', 'unknown']]) {
    const execFn = makePosixStub({ serviceMode, pgrepStdout: '' });
    const result = probeSupervision({ root: 'C:/x', declaredServiceName: 'actions.runner.x' }, { platform: 'linux', execFn });
    assert.equal(result.value.serviceState, expected, `serviceMode ${serviceMode}`);
  }
});

test('probeSupervision (posix): process attribution requires canonical cwd match — an unrelated process elsewhere is NOT attributed', () => {
  const execFn = makePosixStub({
    serviceMode: 'registered',
    pgrepStdout: '111\n222\n',
    cwdByPid: { 111: 'C:/actions-runner', 222: 'C:/some/unrelated/dir' },
    ppidByPid: { 111: '50', 222: '60' },
    commByPpid: { 50: 'systemd', 60: 'bash' },
  });
  const result = probeSupervision({ root: 'C:/actions-runner', declaredServiceName: 'actions.runner.x' }, { platform: 'linux', execFn });
  assert.deepEqual(result.value.foregroundPids, [111]);
});

test('probeSupervision (posix) — Gemini G1: a service-parented listener is excluded from unsupervisedForegroundPids; an unparented one is included', () => {
  const execFn = makePosixStub({
    serviceMode: 'registered',
    pgrepStdout: '111\n333\n',
    cwdByPid: { 111: 'C:/actions-runner', 333: 'C:/actions-runner' },
    ppidByPid: { 111: '50', 333: '70' },
    commByPpid: { 50: 'systemd', 70: 'bash' },
  });
  const result = probeSupervision({ root: 'C:/actions-runner', declaredServiceName: 'actions.runner.x' }, { platform: 'linux', execFn });
  assert.deepEqual(result.value.foregroundPids.sort(), [111, 333]);
  assert.deepEqual(result.value.unsupervisedForegroundPids, [333]);
});

function makeWindowsStub({ serviceMode = null, processes = [] } = {}) {
  const calls = [];
  const fn = (file, args) => {
    calls.push({ file, args });
    if (file === 'sc.exe') {
      if (serviceMode === 'registered') return { status: 0, stdout: 'SERVICE_NAME: x\n        STATE              : 4  RUNNING\n', stderr: '' };
      if (serviceMode === 'not-registered') return { status: 1060, stdout: '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n', stderr: '' };
      if (serviceMode === 'unknown') return { status: null, stdout: '', stderr: '', spawnError: { code: 'ENOENT', message: 'sc.exe missing' } };
      throw new Error('sc.exe should not have been called for this test');
    }
    if (file === 'powershell.exe') {
      return { status: 0, stdout: JSON.stringify(processes), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unhandled stub call' };
  };
  fn.calls = calls;
  return fn;
}

test('probeSupervision (windows): registered / not-registered / unknown are distinct outcomes', () => {
  for (const [serviceMode, expected] of [['registered', 'registered'], ['not-registered', 'not-registered'], ['unknown', 'unknown']]) {
    const execFn = makeWindowsStub({ serviceMode, processes: [] });
    const result = probeSupervision({ root: 'C:/actions-runner', declaredServiceName: 'actions.runner.x' }, { platform: 'win32', execFn });
    assert.equal(result.value.serviceState, expected);
  }
});

test('probeSupervision (windows): ExecutablePath attribution + Gemini G1 parent-name exclusion', () => {
  const execFn = makeWindowsStub({
    serviceMode: 'registered',
    processes: [
      { ProcessId: 111, ParentProcessId: 50, ExecutablePath: 'C:\\actions-runner\\bin\\Runner.Listener.exe', ParentName: 'Runner.Service.exe' },
      { ProcessId: 222, ParentProcessId: 60, ExecutablePath: 'C:\\Other\\Runner.Listener.exe', ParentName: 'explorer.exe' },
      { ProcessId: 333, ParentProcessId: 70, ExecutablePath: 'C:\\actions-runner\\bin\\Runner.Listener.exe', ParentName: 'cmd.exe' },
    ],
  });
  const result = probeSupervision({ root: 'C:/actions-runner', declaredServiceName: 'actions.runner.x' }, { platform: 'win32', execFn });
  assert.deepEqual(result.value.foregroundPids.sort(), [111, 333]);
  assert.deepEqual(result.value.unsupervisedForegroundPids, [333]);
});

test('probeSupervision — WSL (Gemini G3): a wsl-kind target wraps every command in `wsl.exe -d <distro> --`, regardless of host platform', () => {
  const calls = [];
  const execFn = (file, args) => {
    calls.push({ file, args });
    return { status: 1, stdout: '', stderr: '' }; // pgrep "no matches" style — content doesn't matter for this assertion
  };
  probeSupervision(
    { root: '\\\\wsl$\\Ubuntu\\home\\me\\actions-runner', declaredServiceName: null, kind: 'wsl', distro: 'Ubuntu' },
    { platform: 'win32', execFn },
  );
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.equal(c.file, 'wsl.exe', 'every sub-invocation must go through wsl.exe, never a bare Windows command');
    assert.deepEqual(c.args.slice(0, 3), ['-d', 'Ubuntu', '--']);
  }
  // The wrapped command itself must be the LINUX command set (pgrep), never sc.exe/powershell.
  assert.ok(calls.some((c) => c.args[3] === 'pgrep'));
});

// ─────────────────────────────────────────────────────────────────────────
// isTrustedHost (D13)
// ─────────────────────────────────────────────────────────────────────────

test('isTrustedHost: github.com is trusted with an empty/default config', () => {
  assert.equal(isTrustedHost({ host: 'github.com' }, {}), true);
  assert.equal(isTrustedHost({ host: 'github.com' }, null), true);
});

test('isTrustedHost: an unlisted host is untrusted by default', () => {
  assert.equal(isTrustedHost({ host: 'ghe.corp.example.com' }, {}), false);
});

test('isTrustedHost: an explicit trustedHosts entry is honoured, case-insensitively', () => {
  assert.equal(isTrustedHost({ host: 'GHE.corp.example.com' }, { trustedHosts: ['ghe.corp.example.com'] }), true);
});

// ─────────────────────────────────────────────────────────────────────────
// fetchRemoteRunner (D11) — direct by-ID lookup, never listing/pagination.
// ─────────────────────────────────────────────────────────────────────────

const REPO_OWNER = { host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo', display: 'example-owner/example-repo' };
const ORG_OWNER = { host: 'github.com', ownerKind: 'org', ownerSlug: 'example-org', display: 'example-org' };

test('fetchRemoteRunner: calls the endpoint implied by ownerKind with exactly the install\'s own agentId, never a list endpoint', () => {
  const calls = [];
  const ghFn = (args) => { calls.push(args); return { status: 0, stdout: JSON.stringify({ id: 42, name: 'x', status: 'online', busy: false, labels: [] }), stderr: '' }; };

  fetchRemoteRunner(REPO_OWNER, 42, { ghFn });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('repos/example-owner/example-repo/actions/runners/42'));
  assert.ok(!calls[0].some((a) => /runners$/.test(a)), 'must never hit the bare list endpoint');

  fetchRemoteRunner(ORG_OWNER, 7, { ghFn });
  assert.ok(calls[1].includes('orgs/example-org/actions/runners/7'));
});

test('fetchRemoteRunner: a stubbed 404 yields not-registered directly, no comparison logic', () => {
  const ghFn = () => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' });
  const result = fetchRemoteRunner(REPO_OWNER, 42, { ghFn });
  assert.deepEqual(result.value, { status: 'not-registered' });
});

test('fetchRemoteRunner: two installs sharing an owner tuple each trigger their OWN lookup call — never a shared/cached call', () => {
  let callCount = 0;
  const ghFn = () => { callCount += 1; return { status: 0, stdout: JSON.stringify({ id: 1, status: 'online', busy: false }), stderr: '' }; };
  fetchRemoteRunner(REPO_OWNER, 1, { ghFn });
  fetchRemoteRunner(REPO_OWNER, 2, { ghFn });
  assert.equal(callCount, 2);
});

test('fetchRemoteRunner: the request targets the install\'s own host via an explicit --hostname argument, never gh\'s ambient default', () => {
  const calls = [];
  const ghFn = (args) => { calls.push(args); return { status: 0, stdout: JSON.stringify({ id: 1, status: 'online', busy: false }), stderr: '' }; };
  const gheOwner = { host: 'ghe.corp.example.com', ownerKind: 'repo', ownerSlug: 'corp/repo', display: 'corp/repo' };
  fetchRemoteRunner(gheOwner, 1, { ghFn, config: { trustedHosts: ['ghe.corp.example.com'] } });
  assert.ok(calls[0].includes('--hostname'));
  assert.equal(calls[0][calls[0].indexOf('--hostname') + 1], 'ghe.corp.example.com');
});

test('fetchRemoteRunner: trustedHosts short-circuit — an untrusted host never reaches gh at all', () => {
  let called = false;
  const ghFn = () => { called = true; return { status: 0, stdout: '{}', stderr: '' }; };
  const untrusted = { host: 'evil.example.com', ownerKind: 'repo', ownerSlug: 'x/y', display: 'x/y' };
  const result = fetchRemoteRunner(untrusted, 1, { ghFn, config: {} });
  assert.deepEqual(result.value, { status: 'untrusted-host' });
  assert.equal(called, false, 'gh must never be invoked for an untrusted host');
});

test('fetchRemoteRunner: gh genuinely unspawnable -> adapter-level ok:false (procedural failure)', () => {
  const ghFn = () => { const e = new Error('gh not found'); e.code = 'ENOENT'; return { status: null, stdout: '', stderr: '', spawnError: e }; };
  const result = fetchRemoteRunner(REPO_OWNER, 1, { ghFn });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GH_BINARY_MISSING');
});

test('fetchRemoteRunner: a non-2xx / unparseable JSON response is a completed domain outcome, never a throw', () => {
  const malformedJson = () => ({ status: 0, stdout: 'not json', stderr: '' });
  const r1 = fetchRemoteRunner(REPO_OWNER, 1, { ghFn: malformedJson });
  assert.equal(r1.ok, true);
  assert.equal(r1.value.status, 'malformed-response');

  const forbidden = () => ({ status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration\n' });
  const r2 = fetchRemoteRunner(REPO_OWNER, 1, { ghFn: forbidden });
  assert.equal(r2.ok, true);
  assert.equal(r2.value.status, 'forbidden');
});

// ─────────────────────────────────────────────────────────────────────────
// readCurrentRepoOwners (R3 H2)
// ─────────────────────────────────────────────────────────────────────────

test('readCurrentRepoOwners: parses EVERY configured remote, not just origin', () => {
  const execFn = (args) => {
    if (args[0] === 'remote' && args.length === 1) return { status: 0, stdout: 'origin\nupstream\n', stderr: '' };
    if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
      return { status: 0, stdout: 'https://github.com/example-owner/example-repo.git\n', stderr: '' };
    }
    if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
      return { status: 0, stdout: 'git@github.com:upstream-owner/example-repo.git\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  };
  const result = readCurrentRepoOwners({ execFn });
  assert.equal(result.value.status, 'available');
  assert.equal(result.value.owners.length, 2);
  assert.ok(result.value.owners.some((o) => o.ownerSlug === 'example-owner/example-repo'));
  assert.ok(result.value.owners.some((o) => o.ownerSlug === 'upstream-owner/example-repo'));
});

test('readCurrentRepoOwners: not-a-repository / unavailable / malformed are distinct evidence statuses', () => {
  const notARepo = (args) => (args[0] === 'remote' ? { status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' } : { status: 1, stdout: '', stderr: '' });
  assert.equal(readCurrentRepoOwners({ execFn: notARepo }).value.status, 'not-a-repository');

  const gitMissing = () => { const e = new Error('spawn git ENOENT'); e.code = 'ENOENT'; return { status: null, stdout: '', stderr: '', spawnError: e }; };
  assert.equal(readCurrentRepoOwners({ execFn: gitMissing }).value.status, 'unavailable');

  const malformedRemote = (args) => {
    if (args[0] === 'remote' && args.length === 1) return { status: 0, stdout: 'origin\n', stderr: '' };
    if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'not-a-recognisable-remote-url\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  assert.equal(readCurrentRepoOwners({ execFn: malformedRemote }).value.status, 'malformed');
});

test('readCurrentRepoOwners: zero configured remotes is available with an empty owners list, not malformed', () => {
  const noRemotes = (args) => (args[0] === 'remote' && args.length === 1 ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: '' });
  const result = readCurrentRepoOwners({ execFn: noRemotes });
  assert.deepEqual(result.value, { status: 'available', owners: [] });
});

// ─────────────────────────────────────────────────────────────────────────
// loadLocalRunnerConfig
// ─────────────────────────────────────────────────────────────────────────

test('loadLocalRunnerConfig: an absent file is the one legitimate empty-config case', () => {
  const fakeFs = { readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } };
  const result = loadLocalRunnerConfig({ fs: fakeFs });
  assert.deepEqual(result, { ok: true, value: null });
});

test('loadLocalRunnerConfig: invalid JSON is ok:false, never a clean empty config', () => {
  const fakeFs = { readFileSync: () => '{ not json' };
  const result = loadLocalRunnerConfig({ fs: fakeFs });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_JSON');
});

test('loadLocalRunnerConfig: a schema violation (unknown key) is ok:false, never a clean empty config', () => {
  const fakeFs = { readFileSync: () => JSON.stringify({ trustedHosts: ['github.com'], notARealField: true }) };
  const result = loadLocalRunnerConfig({ fs: fakeFs });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_CONFIG');
});

test('loadLocalRunnerConfig: a valid file parses with defaults applied', () => {
  const fakeFs = { readFileSync: () => JSON.stringify({ agentNameIsHostname: true }) };
  const result = loadLocalRunnerConfig({ fs: fakeFs });
  assert.equal(result.ok, true);
  assert.equal(result.value.agentNameIsHostname, true);
  assert.deepEqual(result.value.trustedHosts, ['github.com']);
});

// ─────────────────────────────────────────────────────────────────────────
// discoverInstalls — exact declared directories, absent/discovered/error,
// WSL gating.
// ─────────────────────────────────────────────────────────────────────────

test('discoverInstalls: a default root that does not exist is absent, not error, and contributes no install', () => {
  const fakeFs = makeFakeFs({}); // nothing exists anywhere
  const { installs, candidates } = discoverInstalls({ platform: 'win32', fs: fakeFs, config: {} });
  assert.equal(installs.length, 0);
  assert.ok(candidates.every((c) => c.state === 'absent'));
});

test('discoverInstalls: a well-formed extraRoots entry is discovered and supervision-probed', () => {
  const fakeFs = makeFakeFs({
    // default win32 roots absent
    'C:/actions-runner-declared': { type: 'dir' },
    'C:/actions-runner-declared/.runner': {
      type: 'file',
      content: JSON.stringify({ agentId: 5, agentName: 'declared-agent', gitHubUrl: 'https://github.com/example-owner/example-repo' }),
    },
  });
  const execFn = () => ({ status: 1, stdout: '', stderr: '' }); // no processes/service found — fine
  const { installs, candidates } = discoverInstalls({
    platform: 'win32',
    fs: fakeFs,
    execFn,
    config: { extraRoots: [{ kind: 'local', path: 'C:/actions-runner-declared' }] },
  });
  assert.equal(installs.length, 1);
  assert.equal(installs[0].agentName, 'declared-agent');
  assert.equal(installs[0].source, 'extraRoot');
  assert.ok(candidates.some((c) => c.state === 'discovered' && c.source === 'extraRoot'));
});

test('discoverInstalls: a present-but-malformed root is state:error, and the run continues to other roots', () => {
  const fakeFs = makeFakeFs({
    'C:/broken': { type: 'dir' },
    'C:/broken/.runner': { type: 'file', content: 'not json at all' },
    'C:/healthy': { type: 'dir' },
    'C:/healthy/.runner': {
      type: 'file',
      content: JSON.stringify({ agentId: 6, agentName: 'healthy-agent', gitHubUrl: 'https://github.com/example-owner/example-repo' }),
    },
  });
  const execFn = () => ({ status: 1, stdout: '', stderr: '' });
  const { installs, candidates } = discoverInstalls({
    platform: 'win32',
    fs: fakeFs,
    execFn,
    config: { extraRoots: [{ kind: 'local', path: 'C:/broken' }, { kind: 'local', path: 'C:/healthy' }] },
  });
  assert.equal(installs.length, 1);
  assert.equal(installs[0].agentName, 'healthy-agent');
  const brokenCandidate = candidates.find((c) => normKey(c.root) === normKey('C:/broken'));
  assert.equal(brokenCandidate.state, 'error');
});

test('discoverInstalls: a wsl-kind extraRoots entry is skipped without includeWsl (notProbed.wsl true, nothing spawned) and only reached with it', () => {
  const fakeFs = makeFakeFs({}); // never touched when skipped
  let spawnCount = 0;
  const execFn = () => { spawnCount += 1; return { status: 1, stdout: '', stderr: '' }; };

  const skipped = discoverInstalls({
    platform: 'win32',
    fs: fakeFs,
    execFn,
    includeWsl: false,
    config: { extraRoots: [{ kind: 'wsl', distro: 'Ubuntu', pathInDistro: '/home/me/actions-runner' }] },
  });
  assert.equal(skipped.notProbed.wsl, true);
  assert.ok(typeof skipped.notProbed.reason === 'string' && skipped.notProbed.reason.length > 0);
  assert.equal(spawnCount, 0, 'the probe must not be the thing that starts the runner/distro');
  assert.ok(skipped.candidates.some((c) => c.source === 'wsl' && c.state === 'absent'));

  // Reached only with the opt-in — inject the WSL root's content via the
  // fake fs at the UNC-style read path this module uses.
  const fakeFsIncluded = makeFakeFs({
    '\\\\wsl$\\ubuntu\\home\\me\\actions-runner': { type: 'dir' },
    '\\\\wsl$\\ubuntu\\home\\me\\actions-runner\\.runner': {
      type: 'file',
      content: JSON.stringify({ agentId: 9, agentName: 'wsl-agent', gitHubUrl: 'https://github.com/example-owner/example-repo' }),
    },
  });
  const included = discoverInstalls({
    platform: 'win32',
    fs: fakeFsIncluded,
    execFn,
    includeWsl: true,
    config: { extraRoots: [{ kind: 'wsl', distro: 'Ubuntu', pathInDistro: '/home/me/actions-runner' }] },
  });
  assert.equal(included.notProbed.wsl, false);
  assert.equal(included.installs.length, 1);
  assert.equal(included.installs[0].agentName, 'wsl-agent');
});
