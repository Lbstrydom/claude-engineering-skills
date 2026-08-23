/**
 * @fileoverview CLI-level tests for scripts/actions-runner-doctor.mjs
 * (docs/plans/self-hosted-runner-management.md, Cluster B / Phase 3).
 *
 * Spawns the REAL CLI as a subprocess, with a stub `gh` injected onto PATH
 * (tests/fixtures/runner/gh-stub-preload.cjs — see that file's header for
 * how the stub works and why it's a copied node binary, not a .cmd shim).
 *
 * SAFETY (load-bearing, read before touching root/config resolution in this
 * file): `C:\actions-runner` genuinely exists on the machine this suite was
 * written on — the plan's own motivating incident. Every test that calls
 * `local`/`remove` therefore sets `RUNNER_PROBE_ROOTS_OVERRIDE` (never lets
 * discovery reach the real built-in default roots) AND passes an explicit
 * `--config` pointing at a path this suite guarantees is absent (never lets
 * a stray real `runner-hosts.local.json` on the developer's machine leak
 * in) AND runs with `cwd` set to a directory outside any git repository
 * (never depends on — or exposes — this repo's own git remote). Do not
 * remove any of the three without re-establishing an equivalent guarantee.
 */
import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'actions-runner-doctor.mjs');
// Forward slashes deliberately (NOT path.join's native separator): NODE_OPTIONS
// is parsed by node itself at child-process startup, and empirically (see the
// Cluster B implementation report) a raw Windows backslash path there gets
// silently mangled — a `\G` after a drive letter is dropped entirely, which
// breaks module resolution with no clear error. Windows accepts forward
// slashes in paths natively, so this sidesteps the parser instead of fighting it.
const GH_PRELOAD_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'runner', 'gh-stub-preload.cjs').replace(/\\/g, '/');
const FALLBACK_DOC = 'docs/runbooks/local-maintenance-checks.md';

let ghStubDir;
let noGitCwd;
let absentConfigPath;

before(() => {
  ghStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stub-'));
  const ghName = process.platform === 'win32' ? 'gh.exe' : 'gh';
  fs.copyFileSync(process.execPath, path.join(ghStubDir, ghName));
  if (process.platform !== 'win32') fs.chmodSync(path.join(ghStubDir, ghName), 0o755);

  noGitCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-doctor-cwd-'));
  absentConfigPath = path.join(noGitCwd, 'nonexistent-runner-hosts.json'); // never created
});

after(() => {
  if (ghStubDir) fs.rmSync(ghStubDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  if (noGitCwd) fs.rmSync(noGitCwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** Windows env objects sometimes key the search path as `Path`, not `PATH` —
 * spreading `process.env` and then also setting `PATH` can leave BOTH keys
 * present with unspecified precedence. Strip every case-variant first. */
/**
 * Capture the real PATH value BEFORE stripping case-variant keys, then
 * rebuild with exactly one `PATH` key. Getting this wrong is silent and
 * nasty: reading `base.PATH` AFTER already deleting every case-insensitive
 * `path` key (the first, buggy version of this helper) always returns
 * undefined, so the reconstructed PATH ends up containing ONLY the gh-stub
 * dir — losing `C:\Windows\System32` and everything else. `sc.exe`/`git`
 * then silently ENOENT, and a spawn failure for `sc.exe` reads as
 * `serviceState:'unknown'` — which happens to trigger the SAME
 * `serviceStopRequired:true` branch as a genuinely `'registered'` service,
 * so a test asserting "registered -> stop step present" can pass for
 * completely the wrong reason. Caught by the mirror-image "not-registered ->
 * no stop step" test actually failing.
 */
function buildStubEnv(overrides = {}) {
  const originalPath = process.env.PATH ?? process.env.Path ?? process.env.path ?? '';
  const out = { ...process.env };
  for (const k of Object.keys(out)) {
    if (k.toLowerCase() === 'path') delete out[k];
  }
  out.PATH = `${ghStubDir}${path.delimiter}${originalPath}`;
  // Audit round 3 (M3/M5): quote the preload path — Node's own NODE_OPTIONS
  // parser splits on whitespace like a shell command line, so an unquoted
  // path breaks on any checkout/temp-dir path containing a space (common on
  // Windows). PRESERVE any inherited NODE_OPTIONS by appending rather than
  // clobbering it — a developer or CI environment that already sets one
  // (e.g. a memory-size flag) should not silently lose it for a spawned
  // test subprocess.
  const inheritedNodeOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  out.NODE_OPTIONS = `${inheritedNodeOptions}--require "${GH_PRELOAD_PATH}"`;
  out.GH_STUB_ACTIVE = '1';
  // Companion sentinel for RUNNER_PROBE_ROOTS_OVERRIDE (audit round 1, M6) —
  // runner-probe.mjs ignores the override entirely unless this is also set,
  // so every spawned CLI in this suite needs it, in this one shared place.
  out.RUNNER_PROBE_TEST_MODE = '1';
  return { ...out, ...overrides };
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: opts.cwd,
    env: buildStubEnv(opts.env),
    timeout: 15_000,
  });
}

function makeRunnerInstallDir({ agentId = 1, agentName = 'test-agent', gitHubUrl = 'https://github.com/example-owner/example-repo', malformed = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-install-'));
  fs.writeFileSync(
    path.join(dir, '.runner'),
    malformed ? 'not valid json' : JSON.stringify({ agentId, agentName, gitHubUrl, workFolder: '_work' }),
  );
  return dir;
}

function rmDirs(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function rootsOverride(...dirPaths) {
  return JSON.stringify(dirPaths.map((p) => ({ kind: 'local', path: p })));
}

// ─────────────────────────────────────────────────────────────────────────
// --selfcheck-relocation / unknown-flag rejection
// ─────────────────────────────────────────────────────────────────────────

test('--selfcheck-relocation prints OK, exits 0', () => {
  const r = runCli(['--selfcheck-relocation']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'OK\n');
});

test('an unknown flag exits non-zero with the ArgvError text', () => {
  const r = runCli(['--bogus-flag']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag/);
});

// ─────────────────────────────────────────────────────────────────────────
// RUNNER_PROBE_ROOTS_OVERRIDE safety gate (audit round 1, H1/H3/M6) — fully
// deterministic, no dependency on this machine's real filesystem state.
// ─────────────────────────────────────────────────────────────────────────

test('RUNNER_PROBE_ROOTS_OVERRIDE + RUNNER_PROBE_TEST_MODE=1: malformed JSON crashes rather than silently falling back to real default roots', () => {
  const r = runCli(['local', '--json'], {
    env: { RUNNER_PROBE_ROOTS_OVERRIDE: 'not valid json', RUNNER_PROBE_TEST_MODE: '1' },
  });
  assert.notEqual(r.status, 0, 'a malformed override in test mode must fail loud, never exit 0 against real roots');
  assert.match(r.stderr, /RUNNER_PROBE_ROOTS_OVERRIDE/);
});

// The complementary "override ignored without RUNNER_PROBE_TEST_MODE" case is
// deliberately NOT tested here via a full `local` CLI spawn (audit round 2,
// M1): "ignored" means falling through to the REAL `defaultInstallRoots()` —
// including the hardcoded `C:\actions-runner` default, which cannot be
// redirected by any env var (D10) — so a subprocess-level test of that path
// would read this machine's actual install every run, on any developer or CI
// box that happens to have one. Covered instead by a direct, in-process unit
// test against `_internals.resolveBuiltInRoots` in `tests/runner-probe.test.mjs`,
// which asserts the ignored-override case returns EXACTLY `defaultInstallRoots()`
// — same guarantee, no real filesystem read.

// ─────────────────────────────────────────────────────────────────────────
// No-sub-command path — byte-for-byte unchanged (R1 M3). Always passes
// --repo explicitly, so `resolveRepoSlug()` never touches git.
// ─────────────────────────────────────────────────────────────────────────

function expectedNoArgOutput(scenario, slug) {
  const lines = [`Repo: ${slug}`];
  if (scenario === 'viable') {
    lines.push('Actions enabled: true (allowed_actions: all)');
    lines.push('Self-hosted registration: viable');
    lines.push('\n>> This identity can self-serve a repo-scoped self-hosted runner right now.');
    lines.push('   Register it with the token this run just requested, then install it as a persistent service (see the printed steps).');
    lines.push('   This only covers THIS repo — for org-wide coverage, an org admin needs to grant org-level runner registration separately.');
    lines.push('\nRegistration token (expires 2026-08-01T00:00:00.000-00:00):');
    lines.push('  AABBCCDDEEFF00112233');
    lines.push('\nNext steps:');
    lines.push('  1. Download the runner for your platform from:');
    lines.push(`     https://github.com/${slug}/settings/actions/runners/new`);
    lines.push('  2. Configure it:');
    lines.push(`     config --url https://github.com/${slug} --token AABBCCDDEEFF00112233 --unattended`);
    lines.push('  3. Install it as a persistent service (survives logout/reboot):');
    lines.push('     svc install');
    lines.push('     svc start');
    lines.push('  4. Point the blocked workflow job at it: runs-on: self-hosted');
  } else if (scenario === 'no-admin-rights') {
    lines.push('Actions enabled: true (allowed_actions: all)');
    lines.push('Self-hosted registration: not viable');
    lines.push('\n>> Actions is enabled, but this identity cannot register a self-hosted runner (needs repo admin).');
    lines.push('   gh reported: HTTP 403: Must have admin rights to Repository. (https://api.github.com/repos/x/y/actions/runners/registration-token)');
    lines.push('   Ask a repo admin to run this same check, grant you admin, or register the runner themselves.');
    lines.push(`   Until then, use the local pre-push-hook fallback: ${FALLBACK_DOC}.`);
  } else if (scenario === 'actions-disabled') {
    lines.push('Actions enabled: false');
    lines.push('Self-hosted registration: not viable');
    lines.push('\n>> Actions is disabled entirely for this repo — a self-hosted runner cannot help.');
    lines.push('   Ask a repo or org admin to enable Actions (repo Settings -> Actions -> General), or');
    lines.push(`   use the local pre-push-hook fallback instead: ${FALLBACK_DOC}.`);
  } else if (scenario === 'unknown') {
    lines.push('Actions enabled: unknown');
    lines.push('Self-hosted registration: not viable');
    lines.push('\n>> Could not read this repo\'s Actions permissions or register a runner — gh call failed or this identity lacks repo access.');
    lines.push('   Confirm `gh auth status` is logged into the right host/account for this repo, then re-run.');
    lines.push(`   If this keeps failing, fall back to: ${FALLBACK_DOC}.`);
  }
  return `${lines.join('\n')}\n`;
}

const EXPECTED_STDERR = {
  viable: '',
  'no-admin-rights': '',
  'actions-disabled': '',
  unknown: 'warning: could not read actions/permissions: HTTP 404: Not Found (https://api.github.com/repos/x/y/actions/permissions)\n',
};

describe('no-sub-command path — byte-for-byte unchanged (R1 M3)', () => {
  const SLUG = 'example-owner/example-repo';
  for (const scenario of ['viable', 'no-admin-rights', 'actions-disabled', 'unknown']) {
    it(`scenario: ${scenario} — exact stdout, exact stderr, exit 0`, () => {
      const r = runCli(['--repo', SLUG], { env: { GH_STUB_SCENARIO: scenario } });
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      assert.equal(r.stdout, expectedNoArgOutput(scenario, SLUG));
      assert.equal(r.stderr, EXPECTED_STDERR[scenario]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// local --json
// ─────────────────────────────────────────────────────────────────────────

describe('local --json', () => {
  it('empty root set: ok:true, installs: [], rollup: clean, notProbed populated (honest empty, not silent)', () => {
    const r = runCli(['local', '--json', '--config', absentConfigPath], {
      env: { RUNNER_PROBE_ROOTS_OVERRIDE: '[]' },
      cwd: noGitCwd,
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const envelope = JSON.parse(r.stdout);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.installs, []);
    assert.equal(envelope.rollup, 'clean');
    assert.equal(typeof envelope.notProbed, 'object');
    assert.equal(envelope.notProbed.wsl, false);
  });

  it('--json and --quiet-when-clean together is refused (R2 H2)', () => {
    const r = runCli(['local', '--json', '--quiet-when-clean', '--config', absentConfigPath], {
      env: { RUNNER_PROBE_ROOTS_OVERRIDE: '[]' },
      cwd: noGitCwd,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /mutually exclusive/);
    assert.equal(r.stdout, '', '--json must never partially emit before the mutual-exclusion check fails');
  });

  it('--json alone on a clean rollup still emits the one-envelope JSON line (never suppressed)', () => {
    const r = runCli(['local', '--json', '--config', absentConfigPath], {
      env: { RUNNER_PROBE_ROOTS_OVERRIDE: '[]' },
      cwd: noGitCwd,
    });
    const envelope = JSON.parse(r.stdout);
    assert.equal(envelope.rollup, 'clean');
  });
});

describe('local --strict exit-code mapping across all 4 rollups', () => {
  it('clean: exit 0 even under --strict', () => {
    const r = runCli(['local', '--json', '--strict', '--config', absentConfigPath], {
      env: { RUNNER_PROBE_ROOTS_OVERRIDE: '[]' },
      cwd: noGitCwd,
    });
    assert.equal(JSON.parse(r.stdout).rollup, 'clean');
    assert.equal(r.status, 0);
  });

  it('advisory (undeclared-install only): exit 0 even under --strict — advisory never gates', () => {
    const dir = makeRunnerInstallDir({ agentId: 20, agentName: 'advisory-agent' });
    try {
      const r = runCli(['local', '--json', '--strict', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir), GH_STUB_RUNNER_STATUS: 'online-idle' },
        cwd: noGitCwd,
      });
      const envelope = JSON.parse(r.stdout);
      assert.equal(envelope.rollup, 'advisory', JSON.stringify(envelope));
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
    } finally { rmDirs(dir); }
  });

  it('unhealthy: exit 1 under --strict, exit 0 without it', () => {
    const dir = makeRunnerInstallDir({ agentId: 21, agentName: 'unhealthy-agent' });
    try {
      const strict = runCli(['local', '--json', '--strict', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir), GH_STUB_RUNNER_STATUS: 'not-registered' },
        cwd: noGitCwd,
      });
      assert.equal(JSON.parse(strict.stdout).rollup, 'unhealthy');
      assert.equal(strict.status, 1);

      const lenient = runCli(['local', '--json', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir), GH_STUB_RUNNER_STATUS: 'not-registered' },
        cwd: noGitCwd,
      });
      assert.equal(JSON.parse(lenient.stdout).rollup, 'unhealthy');
      assert.equal(lenient.status, 0);
    } finally { rmDirs(dir); }
  });

  it('unknown: exit 1 under --strict', () => {
    const dir = makeRunnerInstallDir({ agentId: 22, agentName: 'unknown-agent' });
    try {
      const r = runCli(['local', '--json', '--strict', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir), GH_STUB_RUNNER_STATUS: 'forbidden' },
        cwd: noGitCwd,
      });
      assert.equal(JSON.parse(r.stdout).rollup, 'unknown');
      assert.equal(r.status, 1);
    } finally { rmDirs(dir); }
  });

  it('partial-error: exit 1 under --strict', () => {
    const dir = makeRunnerInstallDir({ agentId: 23, agentName: 'error-agent', malformed: true });
    try {
      const r = runCli(['local', '--json', '--strict', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir) },
        cwd: noGitCwd,
      });
      assert.equal(JSON.parse(r.stdout).rollup, 'partial-error');
      assert.equal(r.status, 1);
    } finally { rmDirs(dir); }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// remove <selector> (prepare) — two-step, stateless-descriptor flow (D7)
// ─────────────────────────────────────────────────────────────────────────

describe('remove <selector> (prepare)', () => {
  it('zero local matches -> refuses, names the selector, nothing requested', () => {
    const r = runCli(['remove', 'nonexistent-selector', '--config', absentConfigPath], {
      env: { RUNNER_PROBE_ROOTS_OVERRIDE: '[]' },
      cwd: noGitCwd,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no local install matches selector "nonexistent-selector"/);
  });

  it('>1 local matches -> refuses, naming the ambiguity', () => {
    const dir1 = makeRunnerInstallDir({ agentId: 30, agentName: 'dup-name' });
    const dir2 = makeRunnerInstallDir({ agentId: 31, agentName: 'dup-name' });
    try {
      const r = runCli(['remove', 'dup-name', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir1, dir2) },
        cwd: noGitCwd,
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /matches 2 local installs/);
    } finally { rmDirs(dir1, dir2); }
  });

  it('unique match + remote available -> proceeds: token, structured recipe, verify command', () => {
    const dir = makeRunnerInstallDir({ agentId: 5, agentName: 'my-runner' });
    try {
      const r = runCli(['remove', 'my-runner', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir), GH_STUB_RUNNER_STATUS: 'online-idle' },
        cwd: noGitCwd,
      });
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      assert.match(r.stdout, /Removal token: REMOVE-TOKEN-00112233/);
      assert.match(r.stdout, /remove --verify --host github\.com --owner-kind repo --owner example-owner\/example-repo --agent-id 5/);
      assert.doesNotMatch(r.stderr, /already deregistered/);
    } finally { rmDirs(dir); }
  });

  it('unique match + remote not-registered -> proceeds WITH the distinct "already deregistered" warning', () => {
    const dir = makeRunnerInstallDir({ agentId: 6, agentName: 'orphan-runner' });
    try {
      const r = runCli(['remove', 'orphan-runner', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir), GH_STUB_RUNNER_STATUS: 'not-registered' },
        cwd: noGitCwd,
      });
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      assert.match(r.stderr, /already deregistered on GitHub — this will only clean up the LOCAL configuration/);
      assert.match(r.stdout, /Removal token:/);
    } finally { rmDirs(dir); }
  });

  for (const status of ['forbidden', 'unavailable', 'malformed']) {
    it(`unique match + remote status ${status} -> refuses, no token requested`, () => {
      const dir = makeRunnerInstallDir({ agentId: 7, agentName: 'refuse-me' });
      try {
        const r = runCli(['remove', 'refuse-me', '--config', absentConfigPath], {
          env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir), GH_STUB_RUNNER_STATUS: status },
          cwd: noGitCwd,
        });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /cannot confirm this runner's remote status/);
        assert.doesNotMatch(r.stdout, /Removal token:/);
      } finally { rmDirs(dir); }
    });
  }
});

describe('remove: service-aware recipe (Gemini G2)', () => {
  it('no .service file (no-declaration) -> no stop step', () => {
    const dir = makeRunnerInstallDir({ agentId: 10, agentName: 'no-svc-runner' });
    try {
      const r = runCli(['remove', 'no-svc-runner', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir), GH_STUB_RUNNER_STATUS: 'online-idle' },
        cwd: noGitCwd,
      });
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      assert.doesNotMatch(r.stdout, /stop it BEFORE/);
    } finally { rmDirs(dir); }
  });

  it('.service declares a genuinely nonexistent OS service (not-registered) -> no stop step', () => {
    const dir = makeRunnerInstallDir({ agentId: 11, agentName: 'stale-svc-runner' });
    fs.writeFileSync(path.join(dir, '.service'), 'test-nonexistent-service-zzz-12345');
    try {
      const r = runCli(['remove', 'stale-svc-runner', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir), GH_STUB_RUNNER_STATUS: 'online-idle' },
        cwd: noGitCwd,
      });
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      assert.doesNotMatch(r.stdout, /stop it BEFORE/);
    } finally { rmDirs(dir); }
  });

  // Read-only `sc.exe query` against a well-known, near-universally-present
  // Windows service (Windows Update) — never starts/stops/modifies it.
  // Windows-only fixture; skipped on other platforms (probeServiceStatePosix
  // needs a real systemd unit name instead, out of scope for this CLI test —
  // the underlying registered/unknown -> serviceStopRequired:true branch is
  // already covered at the unit level in tests/runner-probe.test.mjs).
  it('.service declares a REAL registered OS service -> stop step present, ordered BEFORE config remove [win32]', { skip: process.platform !== 'win32' }, () => {
    const dir = makeRunnerInstallDir({ agentId: 12, agentName: 'live-svc-runner' });
    fs.writeFileSync(path.join(dir, '.service'), 'wuauserv');
    try {
      const r = runCli(['remove', 'live-svc-runner', '--config', absentConfigPath], {
        env: { RUNNER_PROBE_ROOTS_OVERRIDE: rootsOverride(dir), GH_STUB_RUNNER_STATUS: 'online-idle' },
        cwd: noGitCwd,
      });
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      assert.match(r.stdout, /stop it BEFORE/);
      const stopIdx = r.stdout.indexOf('stop it BEFORE');
      const removeIdx = r.stdout.indexOf('Run this INSIDE the install directory');
      assert.ok(stopIdx > -1 && removeIdx > -1 && stopIdx < removeIdx, 'service-stop instructions must precede config remove');
    } finally { rmDirs(dir); }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// remove --verify — distinct exit code per remote status (Gemini G1)
// ─────────────────────────────────────────────────────────────────────────

describe('remove --verify', () => {
  const DESCRIPTOR = ['--host', 'github.com', '--owner-kind', 'repo', '--owner', 'example-owner/example-repo', '--agent-id', '5'];

  it('missing required flags -> ArgvError', () => {
    const r = runCli(['remove', '--verify', '--host', 'github.com']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /requires --host, --owner-kind, --owner and --agent-id/);
  });

  it('malformed/internally-inconsistent descriptor (--owner-kind org with a two-segment --owner) refused before any network call', () => {
    const r = runCli(['remove', '--verify', '--host', 'github.com', '--owner-kind', 'org', '--owner', 'example-owner/example-repo', '--agent-id', '1']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /malformed or internally inconsistent/);
  });

  it('removed (not-registered) -> exit 0, printed on stdout', () => {
    const r = runCli(['remove', '--verify', ...DESCRIPTOR], { env: { GH_STUB_RUNNER_STATUS: 'not-registered' } });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(r.stdout, /removed/);
  });

  it('still-registered (available) -> exit 1, distinct message on stderr', () => {
    const r = runCli(['remove', '--verify', ...DESCRIPTOR], { env: { GH_STUB_RUNNER_STATUS: 'online-idle' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /still-registered/);
  });

  const INCONCLUSIVE = [['unavailable', 3], ['forbidden', 4], ['malformed', 5]];
  for (const [stubStatus, expectedCode] of INCONCLUSIVE) {
    it(`inconclusive (${stubStatus}) -> exit ${expectedCode} — never 0, never still-registered's 1`, () => {
      const r = runCli(['remove', '--verify', ...DESCRIPTOR], { env: { GH_STUB_RUNNER_STATUS: stubStatus } });
      assert.equal(r.status, expectedCode);
      assert.match(r.stderr, /inconclusive/);
    });
  }

  it('untrusted-host -> exit 6, refused via the SAME trustedHosts check discovery uses', () => {
    const r = runCli(
      ['remove', '--verify', '--host', 'untrusted.example.com', '--owner-kind', 'repo', '--owner', 'x/y', '--agent-id', '1', '--config', absentConfigPath],
      { cwd: noGitCwd },
    );
    assert.equal(r.status, 6);
    assert.match(r.stderr, /inconclusive \(untrusted-host\)/);
  });

  // All five non-removed outcomes must be pairwise distinct — the exact
  // requirement Gemini G1 raised (never conflate "couldn't check" with
  // either confirmed outcome).
  it('still-registered and every inconclusive status use DISTINCT exit codes', () => {
    const codes = new Set([1, ...INCONCLUSIVE.map(([, c]) => c), 6]);
    assert.equal(codes.size, 1 + INCONCLUSIVE.length + 1, 'exit codes collided — a distinct-outcome guarantee is broken');
  });
});
