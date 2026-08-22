/**
 * @fileoverview Impure I/O adapter for self-hosted-runner inventory
 * (docs/plans/self-hosted-runner-management.md, Phase 2). Every fs/exec/
 * network touch in the feature lives here; `scripts/lib/runner-inventory.mjs`
 * (the pure sibling) never imports `node:fs`/`node:child_process`.
 *
 * Discovery reads EXACT declared directories only (D10) — it never walks a
 * filesystem. `.credentials`/`.credentials_rsaparams` are never opened under
 * any code path (hard security invariant, §10).
 *
 * @module scripts/lib/runner-probe
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseRunnerConfig,
  parseOwnerFromGitRemote,
  RunnerHostsConfigSchema,
} from './runner-inventory.mjs';

// ─────────────────────────────────────────────────────────────────────────
// defaultInstallRoots — per §3's supervision platform matrix "default
// install roots" column. Built-in roots are always the 'local' kind (D10).
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {string} [platform] - typically `process.platform`
 * @returns {Array<{kind:'local', path:string}>}
 */
export function defaultInstallRoots(platform = process.platform) {
  if (platform === 'win32') {
    const userProfile = process.env.USERPROFILE || os.homedir();
    return [
      { kind: 'local', path: 'C:\\actions-runner' },
      { kind: 'local', path: path.join(userProfile, 'actions-runner') },
    ];
  }
  const home = os.homedir();
  return [
    { kind: 'local', path: path.join(home, 'actions-runner') },
    { kind: 'local', path: '/opt/actions-runner' },
  ];
}

/**
 * Test/operator escape hatch — mirrors `maintenance-checks.mjs`'s
 * `AUDIT_LOOP_STATE_DIR` override precedent (same repo, same shape of
 * problem: a hardcoded path with no CLI flag to redirect it).
 * `defaultInstallRoots`'s built-in paths are process-wide constants
 * (`C:\actions-runner`, `~/actions-runner`, …) — there is no `--config`
 * mechanism to SUPPRESS them (config only ever ADDS `extraRoots`). A
 * CLI-level subprocess test (Cluster B, `tests/runner-doctor-cli.test.mjs`)
 * has no other way to guarantee it never touches a real install, and on a
 * machine that genuinely HAS a runner at one of those paths — the plan's own
 * motivating incident, and verified present on this exact machine during
 * Cluster B implementation (`C:\actions-runner` exists here) — reading it
 * unconditionally would leak real, possibly corporate, install data into
 * test output. Exactly what this whole feature exists to keep out of a
 * public repo/CI log.
 *
 * `RUNNER_PROBE_ROOTS_OVERRIDE` (JSON array, same shape as
 * `defaultInstallRoots`'s return value) REPLACES the built-in list — but only
 * when `RUNNER_PROBE_TEST_MODE=1` is ALSO set (audit round 1, M6): requiring
 * two separately-named env vars together is what keeps an accidental/hostile
 * single env var from silently redirecting a production run's discovery.
 * Without `RUNNER_PROBE_TEST_MODE`, the override is IGNORED outright — real
 * defaults, unconditionally, exactly as if it were never set.
 *
 * With test mode on, a malformed or invalid override THROWS rather than
 * falling back to real defaults (audit round 1, H1/H3) — this variable exists
 * specifically to keep a test run away from a real, possibly corporate,
 * install; silently falling back to the very thing it was set to avoid on a
 * typo would turn a configuration mistake into exactly the leak this feature
 * exists to prevent. `config.extraRoots` is still appended as normal by the
 * caller either way.
 *
 * @param {string} platform
 * @returns {Array<{kind:'local', path:string}>|Array<object>}
 */
function resolveBuiltInRoots(platform) {
  const override = process.env.RUNNER_PROBE_ROOTS_OVERRIDE;
  if (!override || process.env.RUNNER_PROBE_TEST_MODE !== '1') return defaultInstallRoots(platform);

  let parsed;
  try {
    parsed = JSON.parse(override);
  } catch (err) {
    throw new Error(`RUNNER_PROBE_ROOTS_OVERRIDE is set but not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('RUNNER_PROBE_ROOTS_OVERRIDE must be a JSON array');
  }
  // Per-kind required fields (audit round 3, M2/M7 — the R1 version only
  // checked `kind`, so `{kind:'local'}` with no `path` passed validation and
  // failed later with a confusing, un-attributed error instead of naming the
  // actual malformed entry).
  for (const [i, entry] of parsed.entries()) {
    const bad = (why) => { throw new Error(`RUNNER_PROBE_ROOTS_OVERRIDE[${i}] ${why}`); };
    if (!entry || typeof entry !== 'object') bad("is not an object (must be {kind:'local',path} or {kind:'wsl',distro,pathInDistro})");
    if (entry.kind === 'local') {
      if (typeof entry.path !== 'string' || !entry.path) bad("is kind:'local' but has no non-empty string 'path'");
    } else if (entry.kind === 'wsl') {
      if (typeof entry.distro !== 'string' || !entry.distro) bad("is kind:'wsl' but has no non-empty string 'distro'");
      if (typeof entry.pathInDistro !== 'string' || !entry.pathInDistro) bad("is kind:'wsl' but has no non-empty string 'pathInDistro'");
    } else {
      bad(`has an unrecognised kind: ${JSON.stringify(entry.kind)} (must be 'local' or 'wsl')`);
    }
  }
  process.stderr.write(
    '  [runner-probe] RUNNER_PROBE_ROOTS_OVERRIDE active — built-in default install roots are NOT being probed; using the override list instead\n',
  );
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────
// resolveRunnerChild — containment check scoped to an INSTALL DIRECTORY,
// not a repo (D10/§10). Deliberately not `sensitive-paths.mjs::resolveAndClassify`,
// which assumes repo-boundary semantics; this is a dedicated, smaller helper.
//
// PRIVATE by design (audit round 1, M2): it accepts an arbitrary `name` and
// would let a future caller resolve `.credentials`/`.credentials_rsaparams`
// through the same apparently-approved containment path — the "never opened"
// invariant would then rest on every future caller remembering a prose
// restriction rather than on an API boundary that enforces it. The only
// exported way to reach a child is `resolveRunnerArtifact`, whose `artifact`
// parameter is a closed enum that structurally cannot name a credential file.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {string} root - an install root (assumed already resolvable; callers
 *   that haven't confirmed that should go through `readInstallFacts` instead)
 * @param {string} name - the child to resolve, e.g. `.runner` or `.service`
 * @param {{fs?: typeof import('node:fs')}} [opts]
 * @returns {{ok:true, value:string, canonicalRoot:string} | {ok:false, error:{code:string, message:string}}}
 */
function resolveRunnerChild(root, name, opts = {}) {
  const fsMod = opts.fs || fs;

  let canonicalRoot;
  try {
    canonicalRoot = fsMod.realpathSync(root);
  } catch (err) {
    return { ok: false, error: { code: 'ROOT_UNRESOLVABLE', message: `cannot resolve install root ${root}: ${err.code || err.message}` } };
  }

  const childPath = path.join(canonicalRoot, name);

  // Audit round 3, H1: the containment check below only guards against the
  // TARGET escaping the root — it says nothing about a file named `.runner`
  // secretly BEING a symlink to `.credentials`, sitting right next to it in
  // the SAME root. That would sail through the escape check (the target is
  // in-root) while returning credential bytes to a caller that only ever
  // asked for the `.runner` artifact. The real `config.cmd`/`config.sh`
  // installer always writes these as plain regular files, so `.runner`/
  // `.service` being a symlink AT ALL — anywhere it points — is refused,
  // fail-closed, before ever following it.
  let directLstat;
  try {
    directLstat = fsMod.lstatSync(childPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, error: { code: 'CHILD_ABSENT', message: `${name} not found under ${canonicalRoot}` } };
    }
    return { ok: false, error: { code: 'CHILD_UNRESOLVABLE', message: `cannot stat ${childPath}: ${err.code || err.message}` } };
  }
  if (directLstat.isSymbolicLink()) {
    return { ok: false, error: { code: 'ARTIFACT_IS_SYMLINK', message: `${name} under ${canonicalRoot} is a symlink, not a regular file — refusing to follow it` } };
  }

  let canonicalChild;
  try {
    canonicalChild = fsMod.realpathSync(childPath);
  } catch (err) {
    return { ok: false, error: { code: 'CHILD_UNRESOLVABLE', message: `cannot resolve ${childPath}: ${err.code || err.message}` } };
  }

  const rel = path.relative(canonicalRoot, canonicalChild);
  const escaped = rel.startsWith('..') || path.isAbsolute(rel);
  if (escaped) {
    return { ok: false, error: { code: 'ESCAPES_ROOT', message: `${name} under ${root} resolves outside its install root` } };
  }

  return { ok: true, value: canonicalChild, canonicalRoot };
}

/** The ONLY artifact names the public API can resolve — a closed enum, not a
 * string, so a credential filename is unrepresentable, not merely
 * discouraged. A `Map`, not a plain object — audit round 2 (M2) flagged that
 * an object index (`RUNNER_ARTIFACTS[artifact]`) resolves inherited
 * `Object.prototype` names (`'constructor'`, `'toString'`, …) instead of
 * rejecting them, which `Map#get` structurally cannot do. Extend this set
 * (never widen the callers) if a future need arises; it is the single place
 * that decision is made. */
const RUNNER_ARTIFACTS = new Map([['runner', '.runner'], ['service', '.service']]);

/**
 * The narrow, public replacement for the generic containment resolver above.
 * `artifact` is restricted to `RUNNER_ARTIFACTS`' keys — `.credentials` and
 * `.credentials_rsaparams` have no entry, so no argument value can reach them.
 * @param {string} root
 * @param {'runner'|'service'} artifact
 * @param {{fs?: typeof import('node:fs')}} [opts]
 * @returns {{ok:true, value:string, canonicalRoot:string} | {ok:false, error:{code:string, message:string}}}
 */
export function resolveRunnerArtifact(root, artifact, opts = {}) {
  if (!RUNNER_ARTIFACTS.has(artifact)) {
    return { ok: false, error: { code: 'UNKNOWN_ARTIFACT', message: `not a recognised runner artifact: ${artifact}` } };
  }
  return resolveRunnerChild(root, RUNNER_ARTIFACTS.get(artifact), opts);
}

// ─────────────────────────────────────────────────────────────────────────
// readInstallFacts — `.runner` + `.service` ONLY. NEVER `.credentials` or
// `.credentials_rsaparams` under any code path.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {string} root - a candidate install root (not yet confirmed to exist)
 * @param {{fs?: typeof import('node:fs')}} [opts]
 * @returns {object} a partial RunnerInstall (supervision facts still `null`
 *   for `serviceState` — see `probeSupervision`) or `{root, error:{code,detail}}`
 */
export function readInstallFacts(root, opts = {}) {
  const fsMod = opts.fs || fs;

  let lst;
  try {
    lst = fsMod.lstatSync(root);
  } catch (err) {
    if (err.code === 'ENOENT') return { root, error: { code: 'NOT_CONFIGURED', detail: 'install root does not exist' } };
    return { root, error: { code: 'UNREADABLE', detail: `cannot stat install root: ${err.code || err.message}` } };
  }
  void lst;

  let canonicalRoot;
  try {
    canonicalRoot = fsMod.realpathSync(root);
  } catch (err) {
    // Broken/escaping symlink — fail closed, but only THIS install degrades;
    // the caller (discoverInstalls) never aborts the whole run over it.
    return { root, error: { code: 'UNREADABLE', detail: `broken symlink or unresolvable install root: ${err.code || err.message}` } };
  }

  try {
    if (!fsMod.statSync(canonicalRoot).isDirectory()) {
      return { root: canonicalRoot, error: { code: 'UNREADABLE', detail: 'install root is not a directory' } };
    }
  } catch (err) {
    return { root: canonicalRoot, error: { code: 'UNREADABLE', detail: `cannot stat resolved install root: ${err.code || err.message}` } };
  }

  const runnerChild = resolveRunnerArtifact(canonicalRoot, 'runner', { fs: fsMod });
  if (!runnerChild.ok) {
    if (runnerChild.error.code === 'CHILD_ABSENT') {
      return { root: canonicalRoot, error: { code: 'NOT_CONFIGURED', detail: '.runner not present under this root' } };
    }
    return { root: canonicalRoot, error: { code: 'UNREADABLE', detail: runnerChild.error.message } };
  }

  let runnerRaw;
  let configuredAt;
  try {
    runnerRaw = fsMod.readFileSync(runnerChild.value, 'utf-8');
    configuredAt = fsMod.statSync(runnerChild.value).mtime.toISOString();
  } catch (err) {
    return { root: canonicalRoot, error: { code: 'UNREADABLE', detail: `cannot read .runner: ${err.code || err.message}` } };
  }

  const parsed = parseRunnerConfig(runnerRaw, { root: canonicalRoot, configuredAt });
  if (parsed.error) return parsed;

  // `.service` is optional; unreadable/absent just means "no declaration",
  // never a whole-install error.
  const serviceChild = resolveRunnerArtifact(canonicalRoot, 'service', { fs: fsMod });
  let declaredServiceName = null;
  if (serviceChild.ok) {
    try {
      const content = fsMod.readFileSync(serviceChild.value, 'utf-8').trim();
      declaredServiceName = content || null;
    } catch {
      declaredServiceName = null;
    }
  }

  return {
    ...parsed,
    supervision: {
      declaredServiceName,
      serviceState: null,
      serviceStateReason: null,
      foregroundPids: [],
      unsupervisedForegroundPids: [],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// probeSupervision — per-platform tri/four-state serviceState + attributed
// process discovery (§3 supervision platform matrix + the two Gemini fixes).
// Every process executor is injectable; every real exec uses array args,
// never shell interpolation, with a 3s timeout.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Non-throwing exec wrapper: `{status, stdout, stderr}` on any completed
 * spawn (including non-zero exit), `{status:null, spawnError}` only when the
 * binary itself could not be spawned (ENOENT) — the procedural-failure case.
 */
function defaultExec(file, args, { timeoutMs = 3000 } = {}) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { status: null, stdout: '', stderr: '', spawnError: err };
    }
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: (err.stdout || '').toString(),
      stderr: (err.stderr || '').toString(),
    };
  }
}

/** Wraps every sub-invocation in `wsl.exe -d <distro> --` for a wsl-kind
 * target (Gemini G3) — the distro, not the host OS, determines the adapter. */
function buildRunner(target, execFn, timeoutMs) {
  const isWsl = Boolean(target && target.kind === 'wsl');
  return (file, args) => (isWsl
    ? execFn('wsl.exe', ['-d', target.distro, '--', file, ...args], { timeoutMs })
    : execFn(file, args, { timeoutMs }));
}

function probeServiceStatePosix(run, serviceName) {
  if (!serviceName) return { serviceState: 'no-declaration', serviceStateReason: null };
  const res = run('systemctl', ['--user', 'is-enabled', serviceName]);
  if (res.spawnError) {
    return { serviceState: 'unknown', serviceStateReason: `systemctl unavailable: ${res.spawnError.message || res.spawnError.code}` };
  }
  const text = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (/not[- ]found|no such file|could not be found|does not exist/i.test(text)) {
    return { serviceState: 'not-registered', serviceStateReason: null };
  }
  if (res.status === 0 || /^(enabled|disabled|static|linked)/im.test(text)) {
    return { serviceState: 'registered', serviceStateReason: null };
  }
  return { serviceState: 'unknown', serviceStateReason: `unrecognised systemctl output (exit ${res.status}): ${text.slice(0, 200)}` };
}

function probeServiceStateWindows(run, serviceName) {
  if (!serviceName) return { serviceState: 'no-declaration', serviceStateReason: null };
  const res = run('sc.exe', ['query', serviceName]);
  if (res.spawnError) {
    return { serviceState: 'unknown', serviceStateReason: `sc.exe unavailable: ${res.spawnError.message || res.spawnError.code}` };
  }
  const text = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status === 0 && /STATE\s*:/i.test(text)) {
    return { serviceState: 'registered', serviceStateReason: null };
  }
  if (/1060/.test(text) || /does not exist/i.test(text)) {
    return { serviceState: 'not-registered', serviceStateReason: null };
  }
  return { serviceState: 'unknown', serviceStateReason: `unrecognised sc.exe output (exit ${res.status}): ${text.trim().slice(0, 200)}` };
}

function discoverListenersPosix(run) {
  const pgrepRes = run('pgrep', ['-f', 'Runner.Listener']);
  if (pgrepRes.spawnError) return { ok: false };
  if (pgrepRes.status !== 0) return { ok: true, processes: [] }; // pgrep exits 1 on "no matches" — a legitimate empty result
  const pids = (pgrepRes.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isInteger);
  const processes = [];
  for (const pid of pids) {
    const cwdRes = run('readlink', ['-f', `/proc/${pid}/cwd`]);
    const cwd = cwdRes.status === 0 ? cwdRes.stdout.trim() : null;
    const ppidRes = run('ps', ['-o', 'ppid=', '-p', String(pid)]);
    const ppid = ppidRes.status === 0 ? Number(ppidRes.stdout.trim()) : null;
    processes.push({ pid, ppid: Number.isInteger(ppid) ? ppid : null, cwd, exePath: null });
  }
  return { ok: true, processes };
}

function discoverListenersWindows(run) {
  // Parent name is resolved INLINE (one call) rather than one extra call per
  // pid, since Windows attribution needs both the child's ExecutablePath and
  // its parent's Name to decide supervision.
  const res = run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='Runner.Listener.exe'\" | ForEach-Object { $parent = Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.ParentProcessId)\"; [PSCustomObject]@{ProcessId=$_.ProcessId;ParentProcessId=$_.ParentProcessId;ExecutablePath=$_.ExecutablePath;ParentName=$parent.Name} } | ConvertTo-Json -Compress",
  ]);
  if (res.spawnError || res.status !== 0) return { ok: false };
  let rows;
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  } catch {
    return { ok: false };
  }
  return {
    ok: true,
    processes: rows.map((r) => ({
      pid: r.ProcessId, ppid: r.ParentProcessId, exePath: r.ExecutablePath || null, cwd: null, parentName: r.ParentName || null,
    })),
  };
}

function attributeProcess(proc, canonicalRoot, usePosix) {
  const rootNorm = String(canonicalRoot || '').replace(/\\/g, '/').toLowerCase();
  if (!rootNorm) return false;
  if (usePosix) {
    if (!proc.cwd) return false;
    const cwdNorm = String(proc.cwd).replace(/\\/g, '/').toLowerCase();
    return cwdNorm === rootNorm || cwdNorm.startsWith(`${rootNorm}/`);
  }
  if (!proc.exePath) return false;
  const exeNorm = String(proc.exePath).replace(/\\/g, '/').toLowerCase();
  return exeNorm === rootNorm || exeNorm.startsWith(`${rootNorm}/`);
}

/** Excludes a Runner.Listener whose parent IS the platform's own service
 * supervisor (Gemini G1) — a healthy supervised runner always has a
 * foreground listener process; that fact alone must never be the signal. */
function isParentServiceSupervisor(ppid, run, usePosix, proc) {
  if (!ppid) return false;
  if (!usePosix) {
    return typeof proc?.parentName === 'string' && /^Runner\.Service\.exe$/i.test(proc.parentName);
  }
  const res = run('ps', ['-o', 'comm=', '-p', String(ppid)]);
  if (res.status !== 0) return false;
  const name = (res.stdout || '').trim();
  return /systemd|runsvc/i.test(name);
}

/**
 * @param {{root:string, declaredServiceName:string|null, kind?:'local'|'wsl', distro?:string}} target
 * @param {{platform?:string, execFn?:Function, timeoutMs?:number}} [opts]
 * @returns {{ok:true, value:object}}
 */
export function probeSupervision(target, opts = {}) {
  const { platform = process.platform, execFn = defaultExec, timeoutMs = 3000 } = opts;
  const isWsl = Boolean(target && target.kind === 'wsl');
  const usePosix = isWsl || platform !== 'win32';
  const run = buildRunner(target, execFn, timeoutMs);
  const declaredServiceName = target?.declaredServiceName ?? null;

  const serviceResult = usePosix
    ? probeServiceStatePosix(run, declaredServiceName)
    : probeServiceStateWindows(run, declaredServiceName);

  const discovery = usePosix ? discoverListenersPosix(run) : discoverListenersWindows(run);

  if (!discovery.ok) {
    return {
      ok: true,
      value: {
        declaredServiceName,
        serviceState: serviceResult.serviceState,
        serviceStateReason: serviceResult.serviceStateReason,
        foregroundPids: [],
        unsupervisedForegroundPids: [],
      },
    };
  }

  const attributed = discovery.processes.filter((p) => attributeProcess(p, target.root, usePosix));
  const foregroundPids = attributed.map((p) => p.pid);
  const unsupervisedForegroundPids = attributed
    .filter((p) => !isParentServiceSupervisor(p.ppid, run, usePosix, p))
    .map((p) => p.pid);

  return {
    ok: true,
    value: {
      declaredServiceName,
      serviceState: serviceResult.serviceState,
      serviceStateReason: serviceResult.serviceStateReason,
      foregroundPids,
      unsupervisedForegroundPids,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// discoverInstalls — exact declared directories only (D10), NEVER a walk.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   config?: object,
 *   platform?: string,
 *   includeWsl?: boolean,
 *   fs?: typeof import('node:fs'),
 *   execFn?: Function,
 *   timeoutMs?: number,
 * }} [opts]
 * @returns {{installs: object[], candidates: object[], notProbed: {wsl:boolean, reason:string|null}}}
 */
export function discoverInstalls(opts = {}) {
  const {
    config = {},
    platform = process.platform,
    includeWsl = false,
    fs: fsMod = fs,
    execFn = defaultExec,
    timeoutMs = 3000,
  } = opts;

  const roots = [
    ...resolveBuiltInRoots(platform).map((r) => ({ ...r, source: 'built-in' })),
    ...(config.extraRoots || []).map((r) => ({ ...r, source: r.kind === 'wsl' ? 'wsl' : 'extraRoot' })),
  ];

  const installs = [];
  const candidates = [];
  let wslSkipped = false;

  for (const r of roots) {
    const isWsl = r.kind === 'wsl';
    const label = isWsl ? `wsl:${r.distro}:${r.pathInDistro}` : r.path;

    if (isWsl && !includeWsl) {
      wslSkipped = true;
      candidates.push({ root: label, source: r.source, state: 'absent', error: null });
      continue;
    }

    // A WSL root's files are reached through the `\\wsl$\<distro>\<path>`
    // UNC convention — D5 itself names this as WSL's alternate reach
    // mechanism alongside `wsl -d X …`. The plan's §3 matrix specifies the
    // SUPERVISION-probing side only for WSL; this file-read mechanism is a
    // judgment call documented in the implementation report.
    // `pathInDistro`'s own leading slash is stripped before joining so the
    // result never doubles up a separator (e.g. `wsl$\Ubuntu\\home\...`).
    const readPath = isWsl
      ? `\\\\wsl$\\${r.distro}\\${r.pathInDistro.replace(/\//g, '\\').replace(/^\\+/, '')}`
      : r.path;

    const facts = readInstallFacts(readPath, { fs: fsMod });
    if (facts.error) {
      const state = facts.error.code === 'NOT_CONFIGURED' ? 'absent' : 'error';
      candidates.push({
        root: facts.root || label,
        source: r.source,
        state,
        error: state === 'error' ? facts.error : null,
      });
      continue;
    }

    const supervisionTarget = {
      root: facts.root,
      declaredServiceName: facts.supervision.declaredServiceName,
      kind: isWsl ? 'wsl' : 'local',
      ...(isWsl ? { distro: r.distro } : {}),
    };
    const supervision = probeSupervision(supervisionTarget, { platform, execFn, timeoutMs });

    installs.push({
      ...facts,
      source: r.source,
      // `kind`/`distro` — not in the plan §3 RunnerInstall snippet (neither
      // is `source`, already attached above and already relied on by
      // `assessRunnerIdentity`'s undeclaredInstallFires), but the CLI's
      // `remove` recipe (D7/Gemini G3/G4) needs to pick a shell dialect and,
      // for a wsl-kind install, the distro name to wrap the printed command
      // in `wsl.exe -d <distro> --` — and nothing else on this object carries
      // either. Additive only; every existing consumer reads named fields.
      kind: isWsl ? 'wsl' : 'local',
      ...(isWsl ? { distro: r.distro } : {}),
      supervision: supervision.ok ? supervision.value : facts.supervision,
    });
    candidates.push({ root: facts.root, source: r.source, state: 'discovered', error: null });
  }

  return {
    installs,
    candidates,
    notProbed: {
      wsl: wslSkipped,
      reason: wslSkipped
        ? 'WSL install roots are not probed by default (reaching into a distro can start it) — pass the WSL opt-in to include them.'
        : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// isTrustedHost (D13) — checked before any network call.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {{host:string}|null|undefined} owner
 * @param {{trustedHosts?: string[]}|null} [config]
 * @returns {boolean}
 */
export function isTrustedHost(owner, config) {
  if (!owner || !owner.host) return false;
  const trustedHosts = (config && Array.isArray(config.trustedHosts) && config.trustedHosts.length > 0)
    ? config.trustedHosts
    : ['github.com'];
  const folded = new Set(trustedHosts.map((h) => String(h).trim().toLowerCase()));
  return folded.has(String(owner.host).toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────
// fetchRemoteRunner (D11) — direct by-ID lookup, one call per install. No
// pagination, no listing, no page cap.
// ─────────────────────────────────────────────────────────────────────────

function defaultGhApi(args) {
  try {
    const stdout = execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { status: null, stdout: '', stderr: '', spawnError: err };
    }
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: (err.stdout || '').toString(),
      stderr: (err.stderr || '').toString(),
    };
  }
}

function classifyGhApiResult(res) {
  if (res.spawnError) {
    return { ok: false, error: { code: 'GH_BINARY_MISSING', message: res.spawnError.message || 'gh CLI not found on PATH' } };
  }
  if (res.status === 0) {
    let row;
    try {
      row = JSON.parse(res.stdout || '');
    } catch {
      return { ok: true, value: { status: 'malformed-response' } };
    }
    if (!row || typeof row !== 'object' || typeof row.id === 'undefined') {
      return { ok: true, value: { status: 'malformed-response' } };
    }
    return {
      ok: true,
      value: {
        status: 'available',
        row: { id: row.id, name: row.name, status: row.status, busy: !!row.busy, labels: row.labels || [] },
      },
    };
  }
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (/HTTP 404|Not Found/i.test(text)) return { ok: true, value: { status: 'not-registered' } };
  if (/HTTP 40[13]|Bad credentials|Resource not accessible|Forbidden/i.test(text)) return { ok: true, value: { status: 'forbidden' } };
  return { ok: true, value: { status: 'unavailable', reason: text.trim().slice(0, 200) || `gh exited ${res.status}` } };
}

/**
 * @param {import('./runner-inventory.mjs').OwnerIdentity|null} ownerIdentity
 * @param {number} agentId
 * @param {{ghFn?: Function, config?: object|null}} [opts]
 * @returns {{ok:true, value:object} | {ok:false, error:{code:string, message:string}}}
 */
export function fetchRemoteRunner(ownerIdentity, agentId, opts = {}) {
  const { ghFn = defaultGhApi, config = null } = opts;

  if (!ownerIdentity || !Number.isInteger(agentId)) {
    return { ok: true, value: { status: 'malformed-response' } };
  }
  if (!isTrustedHost(ownerIdentity, config)) {
    return { ok: true, value: { status: 'untrusted-host' } };
  }

  const endpoint = ownerIdentity.ownerKind === 'org'
    ? `orgs/${ownerIdentity.display}/actions/runners/${agentId}`
    : `repos/${ownerIdentity.display}/actions/runners/${agentId}`;
  // Explicit `--hostname` always, even for github.com — the request targets
  // the INSTALL's own host, never gh's ambient default (D13/§9).
  const args = ['api', endpoint, '--hostname', ownerIdentity.host];

  const res = ghFn(args);
  return classifyGhApiResult(res);
}

// ─────────────────────────────────────────────────────────────────────────
// readCurrentRepoOwners (R3 H2) — every configured git remote, not just origin.
// ─────────────────────────────────────────────────────────────────────────

function defaultGitExec(args, { cwd } = {}) {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: null, stdout: '', stderr: '', spawnError: err };
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: (err.stdout || '').toString(),
      stderr: (err.stderr || '').toString(),
    };
  }
}

/**
 * @param {{execFn?: Function, cwd?: string}} [opts]
 * @returns {{ok:true, value:{status:'available', owners:object[]} | {status:'not-a-repository'|'unavailable'|'malformed'}}}
 */
export function readCurrentRepoOwners(opts = {}) {
  const { execFn = defaultGitExec, cwd = process.cwd() } = opts;

  const namesRes = execFn(['remote'], { cwd });
  if (namesRes.spawnError) {
    return { ok: true, value: { status: 'unavailable' } };
  }
  if (namesRes.status !== 0) {
    const text = `${namesRes.stdout || ''}${namesRes.stderr || ''}`;
    if (/not a git repository/i.test(text)) return { ok: true, value: { status: 'not-a-repository' } };
    return { ok: true, value: { status: 'unavailable' } };
  }

  const names = (namesRes.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    return { ok: true, value: { status: 'available', owners: [] } };
  }

  const owners = [];
  let anyUrlRead = false;
  for (const name of names) {
    const urlRes = execFn(['remote', 'get-url', name], { cwd });
    if (urlRes.status !== 0) continue;
    anyUrlRead = true;
    const parsed = parseOwnerFromGitRemote((urlRes.stdout || '').trim());
    if (parsed) owners.push(parsed);
  }
  if (!anyUrlRead) {
    return { ok: true, value: { status: 'unavailable' } };
  }
  if (owners.length === 0) {
    return { ok: true, value: { status: 'malformed' } };
  }
  return { ok: true, value: { status: 'available', owners } };
}

// ─────────────────────────────────────────────────────────────────────────
// loadLocalRunnerConfig — reads scripts/lib/runner-hosts.local.json if present.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_LOCAL_CONFIG_PATH = path.join('scripts', 'lib', 'runner-hosts.local.json');

/**
 * @param {{configPath?: string, fs?: typeof import('node:fs')}} [opts]
 * @returns {{ok:true, value:object|null} | {ok:false, error:{code:string, message:string}}}
 */
export function loadLocalRunnerConfig(opts = {}) {
  const { configPath = DEFAULT_LOCAL_CONFIG_PATH, fs: fsMod = fs } = opts;

  let raw;
  try {
    raw = fsMod.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, value: null }; // absent — the one legitimate empty-config case
    return { ok: false, error: { code: 'UNREADABLE', message: `cannot read ${configPath}: ${err.code || err.message}` } };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_JSON', message: `${configPath} is not valid JSON: ${err.message}` } };
  }

  const parsed = RunnerHostsConfigSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'INVALID_CONFIG',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/** Test-only: internal helpers for direct unit coverage. */
export const _internals = {
  defaultExec,
  defaultGhApi,
  classifyGhApiResult,
  buildRunner,
  probeServiceStatePosix,
  probeServiceStateWindows,
  discoverListenersPosix,
  discoverListenersWindows,
  attributeProcess,
  isParentServiceSupervisor,
  defaultGitExec,
  DEFAULT_LOCAL_CONFIG_PATH,
  // Safe to expose (unlike resolveRunnerChild below): returns only path
  // DECLARATIONS, never reads file content, and every input it reads
  // (RUNNER_PROBE_ROOTS_OVERRIDE / RUNNER_PROBE_TEST_MODE) is already a
  // plain env var any caller can read directly — nothing here is a
  // capability this export could leak. Added for a direct, in-process unit
  // test of the test-mode gate (audit round 2, M1) that doesn't need a real
  // subprocess or this machine's real install paths.
  resolveBuiltInRoots,
  // `resolveRunnerChild` is deliberately ABSENT from this object (audit round 2,
  // M3/M5): `_internals` is itself an exported, importable value, so putting the
  // generic arbitrary-name resolver on it would have re-opened exactly the
  // credential-access path round 1's M2 fix closed — any production caller could
  // `import { _internals } from './runner-probe.mjs'` and pass `.credentials`
  // through it. The containment logic it implements is fully covered via
  // `resolveRunnerArtifact('runner'|'service', …)`, which is the only path any
  // caller — test or production — can reach it through.
};
