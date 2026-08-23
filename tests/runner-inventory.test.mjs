import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRunnerConfig,
  assessRunnerHealth,
  assessRunnerIdentity,
  summariseInventory,
  quoteForShell,
  RunnerHostsConfigSchema,
  RUNNER_IDENTITY_FINDINGS,
  parseOwnerFromGitHubUrl,
  parseOwnerFromGitRemote,
  ownerGroupKey,
  ownerIdentityEquals,
  ownerCoversRepo,
} from '../scripts/lib/runner-inventory.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures / helpers
// ─────────────────────────────────────────────────────────────────────────

const SYNTHETIC_RUNNER_JSON = JSON.stringify({
  agentId: 999001,
  agentName: 'synthetic-test-agent',
  poolId: 1,
  serverUrl: 'https://pipelines.example-ghactions.invalid/00000000-secret-capability-segment-0000/',
  gitHubUrl: 'https://github.com/example-owner/example-repo',
  workFolder: '_work',
});

/** A "no findings" baseline install — each test deviates exactly one field. */
function baseInstall(overrides = {}) {
  return {
    root: 'C:/actions-runner',
    owner: { host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo', display: 'example-owner/example-repo' },
    groupKey: 'github.com::repo::example-owner/example-repo',
    agentId: 999001,
    agentName: 'plain-agent-name',
    workFolder: '_work',
    serverHost: 'pipelines.example-ghactions.invalid',
    supervision: {
      declaredServiceName: null,
      serviceState: 'no-declaration',
      serviceStateReason: null,
      foregroundPids: [],
      unsupervisedForegroundPids: [],
    },
    configuredAt: '2026-08-01T00:00:00.000Z',
    source: 'extraRoot',
    ...overrides,
  };
}

const NOT_AVAILABLE_CONTEXT = { hostname: 'this-machine', config: {}, currentRepoOwners: { status: 'not-a-repository' } };

// ─────────────────────────────────────────────────────────────────────────
// assessRunnerHealth
// ─────────────────────────────────────────────────────────────────────────

test('assessRunnerHealth: online + idle -> online-idle', () => {
  assert.equal(assessRunnerHealth({ status: 'available', row: { status: 'online', busy: false } }), 'online-idle');
});

test('assessRunnerHealth: online + busy -> online-busy', () => {
  assert.equal(assessRunnerHealth({ status: 'available', row: { status: 'online', busy: true } }), 'online-busy');
});

test('assessRunnerHealth: offline + busy -> wedged, distinct from plain offline', () => {
  const wedged = assessRunnerHealth({ status: 'available', row: { status: 'offline', busy: true } });
  const offline = assessRunnerHealth({ status: 'available', row: { status: 'offline', busy: false } });
  assert.equal(wedged, 'wedged');
  assert.equal(offline, 'offline');
  assert.notEqual(wedged, offline);
});

test('assessRunnerHealth: not-registered is authoritative by construction', () => {
  assert.equal(assessRunnerHealth({ status: 'not-registered' }), 'not-registered');
});

test('assessRunnerHealth: every non-available, non-not-registered status independently maps to unknown (never healthy)', () => {
  for (const status of ['unavailable', 'forbidden', 'malformed-response', 'untrusted-host']) {
    assert.equal(assessRunnerHealth({ status }), 'unknown', `expected ${status} -> unknown`);
  }
});

test('assessRunnerHealth: malformed/missing remoteResult degrades to unknown, never throws', () => {
  assert.equal(assessRunnerHealth(null), 'unknown');
  assert.equal(assessRunnerHealth(undefined), 'unknown');
  assert.equal(assessRunnerHealth({}), 'unknown');
  assert.equal(assessRunnerHealth({ status: 'available', row: { status: 'weird' } }), 'unknown');
});

// ─────────────────────────────────────────────────────────────────────────
// summariseInventory — rollup precedence, the direction the gate must NOT
// fire, and the absent-vs-error distinction.
// ─────────────────────────────────────────────────────────────────────────

test('summariseInventory: an unknown-health install never rolls up as clean or healthy', () => {
  for (const status of ['unavailable', 'forbidden', 'malformed-response', 'untrusted-host']) {
    const out = summariseInventory({
      installs: [{ ...baseInstall(), remoteStatus: { status } }],
      candidates: [{ root: 'C:/actions-runner', source: 'built-in', state: 'discovered', error: null }],
      identityContext: NOT_AVAILABLE_CONTEXT,
    });
    assert.equal(out.rollup, 'unknown', `status ${status} must roll up as 'unknown', not healthy/clean`);
    assert.equal(out.summary.healthy, 0);
    assert.equal(out.summary.unknownHealth, 1);
  }
});

test('summariseInventory: rollup precedence — partial-error beats unhealthy beats unknown beats advisory beats clean', () => {
  const errorCandidate = { root: '/broken', source: 'extraRoot', state: 'error', error: { code: 'UNREADABLE', detail: 'x' } };
  const withError = summariseInventory({
    installs: [{ ...baseInstall(), remoteStatus: { status: 'available', row: { status: 'offline', busy: true } } }],
    candidates: [errorCandidate],
    identityContext: NOT_AVAILABLE_CONTEXT,
  });
  assert.equal(withError.rollup, 'partial-error');

  const unhealthyOnly = summariseInventory({
    installs: [{ ...baseInstall(), remoteStatus: { status: 'not-registered' } }],
    candidates: [{ root: 'C:/actions-runner', source: 'built-in', state: 'discovered', error: null }],
    identityContext: NOT_AVAILABLE_CONTEXT,
  });
  assert.equal(unhealthyOnly.rollup, 'unhealthy');

  const unknownOnly = summariseInventory({
    installs: [{ ...baseInstall(), remoteStatus: { status: 'forbidden' } }],
    candidates: [{ root: 'C:/actions-runner', source: 'built-in', state: 'discovered', error: null }],
    identityContext: NOT_AVAILABLE_CONTEXT,
  });
  assert.equal(unknownOnly.rollup, 'unknown');

  const advisoryOnly = summariseInventory({
    installs: [{ ...baseInstall({ source: 'built-in' }), remoteStatus: { status: 'available', row: { status: 'online', busy: false } } }],
    candidates: [{ root: 'C:/actions-runner', source: 'built-in', state: 'discovered', error: null }],
    identityContext: NOT_AVAILABLE_CONTEXT,
  });
  assert.equal(advisoryOnly.rollup, 'advisory'); // undeclared-install fires (source: built-in)
});

test('summariseInventory: an all-absent candidate set is clean, not partial-error or unhealthy', () => {
  const out = summariseInventory({
    installs: [],
    candidates: [
      { root: 'C:/actions-runner', source: 'built-in', state: 'absent', error: null },
      { root: '/opt/actions-runner', source: 'built-in', state: 'absent', error: null },
    ],
  });
  assert.equal(out.rollup, 'clean');
  assert.equal(out.summary.installErrors, 0);
  assert.equal(out.installs.length, 0);
});

test('summariseInventory: absent candidates never contribute to installErrors; only state:error does', () => {
  const out = summariseInventory({
    installs: [],
    candidates: [
      { root: '/a', source: 'built-in', state: 'absent', error: null },
      { root: '/b', source: 'extraRoot', state: 'error', error: { code: 'UNREADABLE', detail: 'broken symlink' } },
    ],
  });
  assert.equal(out.summary.installErrors, 1);
  assert.equal(out.rollup, 'partial-error');
});

// ─────────────────────────────────────────────────────────────────────────
// assessRunnerIdentity — each finding fires, and is suppressed ONLY by its
// own declaration (R1 M1 — both cross-directions asserted absent).
// ─────────────────────────────────────────────────────────────────────────

test('host-name-mismatch: default (agentNameIsHostname false) never fires, even on the exact incident pattern', () => {
  const install = baseInstall({ agentName: 'corp-laptop-042' });
  const findings = assessRunnerIdentity(install, { hostname: 'pills-pc', config: {}, currentRepoOwners: { status: 'not-a-repository' } });
  assert.ok(!findings.some((f) => f.id === 'host-name-mismatch'));
});

test('host-name-mismatch: opt-in ON, a token not matching this machine (or any alias) fires', () => {
  const install = baseInstall({ agentName: 'corp-laptop-042' });
  const findings = assessRunnerIdentity(install, {
    hostname: 'pills-pc',
    config: { agentNameIsHostname: true },
    currentRepoOwners: { status: 'not-a-repository' },
  });
  assert.ok(findings.some((f) => f.id === 'host-name-mismatch'));
});

test('host-name-mismatch: a token that IS this machine (short form) does not fire', () => {
  // The maximal-run grammar means the candidate token is the WHOLE hyphenated
  // run, so an exact self-reference must not carry an extra suffix outside
  // the underlying hostname's own labels.
  const install = baseInstall({ agentName: 'build-linux' });
  const findings = assessRunnerIdentity(install, {
    hostname: 'build-linux', // exact match to the candidate token
    config: { agentNameIsHostname: true },
    currentRepoOwners: { status: 'not-a-repository' },
  });
  assert.ok(!findings.some((f) => f.id === 'host-name-mismatch'),
    'an agent correctly named after ITS OWN machine must never read as a mismatch');
});

test('host-name-mismatch: short hostname vs FQDN form are equivalent (neither alone is a false mismatch)', () => {
  // Machine hostname is an FQDN; agentName carries the short form only, set
  // off by an underscore so the hyphen-run grammar isolates it as its own
  // candidate token (an underscore is not part of the -/. joining charset).
  const install = baseInstall({ agentName: 'build-linux_02' });
  const findings = assessRunnerIdentity(install, {
    hostname: 'build-linux.corp.example.com',
    config: { agentNameIsHostname: true },
    currentRepoOwners: { status: 'not-a-repository' },
  });
  assert.ok(!findings.some((f) => f.id === 'host-name-mismatch'));
});

test('host-name-mismatch: a candidate token below the 2-label minimum never fires', () => {
  const install = baseInstall({ agentName: 'agent-x' }); // "x" alone is not a 2-label token by itself
  // Use a single unhyphenated word as agentName to guarantee no 2-label token exists.
  const install2 = baseInstall({ agentName: 'agentx' });
  const findings = assessRunnerIdentity(install2, {
    hostname: 'some-other-host',
    config: { agentNameIsHostname: true },
    currentRepoOwners: { status: 'not-a-repository' },
  });
  assert.ok(!findings.some((f) => f.id === 'host-name-mismatch'));
  void install;
});

test('host-name-mismatch: case differences never fire', () => {
  const install = baseInstall({ agentName: 'BUILD-LINUX' });
  const findings = assessRunnerIdentity(install, {
    hostname: 'Build-Linux',
    config: { agentNameIsHostname: true },
    currentRepoOwners: { status: 'not-a-repository' },
  });
  assert.ok(!findings.some((f) => f.id === 'host-name-mismatch'));
});

test('host-name-mismatch: suppressed ONLY by expectedHostname/hostnameAliases, never by acknowledgedOwners (R1 M1)', () => {
  const install = baseInstall({ agentName: 'foreign-host-01', owner: { host: 'github.com', ownerKind: 'org', ownerSlug: 'some-org', display: 'some-org' } });
  const ctx = {
    hostname: 'pills-pc',
    config: {
      agentNameIsHostname: true,
      acknowledgedOwners: [{ host: 'github.com', ownerKind: 'org', ownerSlug: 'some-org' }],
    },
    currentRepoOwners: { status: 'not-a-repository' },
  };
  const findings = assessRunnerIdentity(install, ctx);
  assert.ok(findings.some((f) => f.id === 'host-name-mismatch'), 'acknowledgedOwners must NOT suppress host-name-mismatch');
});

test('host-name-mismatch: hostnameAliases suppresses it correctly', () => {
  const install = baseInstall({ agentName: 'alias-host' });
  const findings = assessRunnerIdentity(install, {
    hostname: 'pills-pc',
    config: { agentNameIsHostname: true, hostnameAliases: ['alias-host'] },
    currentRepoOwners: { status: 'not-a-repository' },
  });
  assert.ok(!findings.some((f) => f.id === 'host-name-mismatch'));
});

test('supervision-mismatch: fires on serviceState not-registered (declared but absent)', () => {
  const install = baseInstall({ supervision: { declaredServiceName: 'actions.runner.x', serviceState: 'not-registered', serviceStateReason: null, foregroundPids: [], unsupervisedForegroundPids: [] } });
  const findings = assessRunnerIdentity(install, NOT_AVAILABLE_CONTEXT);
  assert.ok(findings.some((f) => f.id === 'supervision-mismatch'));
});

test('supervision-mismatch: fires on registered + unsupervised foreground pid (the motivating incident)', () => {
  const install = baseInstall({ supervision: { declaredServiceName: 'actions.runner.x', serviceState: 'registered', serviceStateReason: null, foregroundPids: [123], unsupervisedForegroundPids: [123] } });
  const findings = assessRunnerIdentity(install, NOT_AVAILABLE_CONTEXT);
  assert.ok(findings.some((f) => f.id === 'supervision-mismatch'));
});

test('supervision-mismatch: never fires on unknown or no-declaration', () => {
  for (const serviceState of ['unknown', 'no-declaration']) {
    const install = baseInstall({ supervision: { declaredServiceName: serviceState === 'unknown' ? 'actions.runner.x' : null, serviceState, serviceStateReason: null, foregroundPids: [], unsupervisedForegroundPids: [] } });
    const findings = assessRunnerIdentity(install, NOT_AVAILABLE_CONTEXT);
    assert.ok(!findings.some((f) => f.id === 'supervision-mismatch'), `must not fire on serviceState:'${serviceState}'`);
  }
});

test('supervision-mismatch: registered + a SUPERVISED foreground pid (present but not unsupervised) does not fire', () => {
  const install = baseInstall({ supervision: { declaredServiceName: 'actions.runner.x', serviceState: 'registered', serviceStateReason: null, foregroundPids: [123], unsupervisedForegroundPids: [] } });
  const findings = assessRunnerIdentity(install, NOT_AVAILABLE_CONTEXT);
  assert.ok(!findings.some((f) => f.id === 'supervision-mismatch'), 'a normal, correctly-running supervised install must not trip this');
});

test('supervision-mismatch: not suppressible by any config field', () => {
  const install = baseInstall({ supervision: { declaredServiceName: 'x', serviceState: 'not-registered', serviceStateReason: null, foregroundPids: [], unsupervisedForegroundPids: [] } });
  const findings = assessRunnerIdentity(install, { hostname: 'h', config: { acknowledgedOwners: [{ host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo' }], hostnameAliases: ['x'], expectedHostname: 'h' }, currentRepoOwners: { status: 'available', owners: [{ host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo' }] } });
  assert.ok(findings.some((f) => f.id === 'supervision-mismatch'));
});

test('foreign-owner: fires when repo-kind owner matches none of currentRepoOwners.owners and is not acknowledged', () => {
  const install = baseInstall({ owner: { host: 'github.com', ownerKind: 'repo', ownerSlug: 'corp/private-repo', display: 'corp/private-repo' } });
  const findings = assessRunnerIdentity(install, {
    hostname: 'h',
    config: {},
    currentRepoOwners: { status: 'available', owners: [{ host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo' }] },
  });
  assert.ok(findings.some((f) => f.id === 'foreign-owner'));
});

test('foreign-owner: suppressed by acknowledgedOwners, never by expectedHostname/hostnameAliases (R1 M1)', () => {
  const owner = { host: 'github.com', ownerKind: 'repo', ownerSlug: 'corp/private-repo', display: 'corp/private-repo' };
  const install = baseInstall({ owner });
  const ctxWrongSuppression = {
    hostname: 'h',
    config: { expectedHostname: 'h', hostnameAliases: ['h2'] },
    currentRepoOwners: { status: 'available', owners: [{ host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo' }] },
  };
  assert.ok(assessRunnerIdentity(install, ctxWrongSuppression).some((f) => f.id === 'foreign-owner'),
    'expectedHostname/hostnameAliases must NOT suppress foreign-owner');

  const ctxRightSuppression = {
    ...ctxWrongSuppression,
    config: { acknowledgedOwners: [{ host: 'github.com', ownerKind: 'repo', ownerSlug: 'corp/private-repo' }] },
  };
  assert.ok(!assessRunnerIdentity(install, ctxRightSuppression).some((f) => f.id === 'foreign-owner'));
});

test('foreign-owner evidence gating (R3 H2): only fires on currentRepoOwners.status==="available"; every other status suppresses it entirely', () => {
  const install = baseInstall({ owner: { host: 'github.com', ownerKind: 'repo', ownerSlug: 'corp/private-repo', display: 'corp/private-repo' } });
  for (const status of ['not-a-repository', 'unavailable', 'malformed']) {
    const findings = assessRunnerIdentity(install, { hostname: 'h', config: {}, currentRepoOwners: { status } });
    assert.ok(!findings.some((f) => f.id === 'foreign-owner'), `status ${status} must suppress foreign-owner, never fire it`);
  }
});

test('ownerCoversRepo scope-aware match (Gemini G1): an org-kind install matching the owner segment of a repo remote does not fire foreign-owner', () => {
  const install = baseInstall({ owner: { host: 'github.com', ownerKind: 'org', ownerSlug: 'example-owner', display: 'example-owner' } });
  const findings = assessRunnerIdentity(install, {
    hostname: 'h',
    config: {},
    currentRepoOwners: { status: 'available', owners: [{ host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo' }] },
  });
  assert.ok(!findings.some((f) => f.id === 'foreign-owner'), 'a legitimate org runner must not be flagged against its own repo remote');
});

test('ownerCoversRepo scope-aware match: a repo-kind install is still compared by strict full-tuple equality, never the org rule', () => {
  // Same owner SEGMENT as the remote, but repo-kind with a DIFFERENT repo name -> must still fire.
  const install = baseInstall({ owner: { host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/other-repo', display: 'example-owner/other-repo' } });
  const findings = assessRunnerIdentity(install, {
    hostname: 'h',
    config: {},
    currentRepoOwners: { status: 'available', owners: [{ host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo' }] },
  });
  assert.ok(findings.some((f) => f.id === 'foreign-owner'), 'a repo-kind mismatch must not be rescued by the org-scope rule');
});

test('undeclared-install: fires for a built-in-default-sourced install, never for extraRoot/wsl', () => {
  const builtIn = baseInstall({ source: 'built-in' });
  assert.ok(assessRunnerIdentity(builtIn, NOT_AVAILABLE_CONTEXT).some((f) => f.id === 'undeclared-install'));

  for (const source of ['extraRoot', 'wsl']) {
    const declared = baseInstall({ source });
    assert.ok(!assessRunnerIdentity(declared, NOT_AVAILABLE_CONTEXT).some((f) => f.id === 'undeclared-install'));
  }
});

test('RUNNER_IDENTITY_FINDINGS is the closed set assessRunnerIdentity ever emits', () => {
  const knownIds = new Set(RUNNER_IDENTITY_FINDINGS.map((f) => f.id));
  assert.deepEqual(knownIds, new Set(['host-name-mismatch', 'supervision-mismatch', 'foreign-owner', 'undeclared-install']));

  // Fire every finding at once and confirm every emitted id is in the closed set.
  const install = baseInstall({
    agentName: 'foreign-host-99',
    source: 'built-in',
    owner: { host: 'github.com', ownerKind: 'repo', ownerSlug: 'corp/private-repo', display: 'corp/private-repo' },
    supervision: { declaredServiceName: 'x', serviceState: 'not-registered', serviceStateReason: null, foregroundPids: [], unsupervisedForegroundPids: [] },
  });
  const findings = assessRunnerIdentity(install, {
    hostname: 'this-machine',
    config: { agentNameIsHostname: true },
    currentRepoOwners: { status: 'available', owners: [{ host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo' }] },
  });
  assert.ok(findings.length > 0);
  for (const f of findings) assert.ok(knownIds.has(f.id), `unexpected finding id: ${f.id}`);
});

// ─────────────────────────────────────────────────────────────────────────
// RunnerHostsConfigSchema (.strict())
// ─────────────────────────────────────────────────────────────────────────

test('RunnerHostsConfigSchema: a valid minimal object parses with all defaults applied', () => {
  const parsed = RunnerHostsConfigSchema.parse({});
  assert.deepEqual(parsed.extraRoots, []);
  assert.deepEqual(parsed.hostnameAliases, []);
  assert.equal(parsed.agentNameIsHostname, false);
  assert.deepEqual(parsed.acknowledgedOwners, []);
  assert.deepEqual(parsed.trustedHosts, ['github.com']);
});

test('RunnerHostsConfigSchema: an unknown top-level key is rejected (.strict())', () => {
  const result = RunnerHostsConfigSchema.safeParse({ trustedHosts: ['github.com'], notARealField: true });
  assert.equal(result.success, false);
});

test('RunnerHostsConfigSchema: extraRoots discriminated union accepts both local and wsl variants', () => {
  const parsed = RunnerHostsConfigSchema.parse({
    extraRoots: [
      { kind: 'local', path: '/srv/actions-runner' },
      { kind: 'wsl', distro: 'Ubuntu', pathInDistro: '/home/me/actions-runner' },
    ],
  });
  assert.equal(parsed.extraRoots.length, 2);
});

test('RunnerHostsConfigSchema: a malformed extraRoots entry (unknown kind) is rejected', () => {
  const result = RunnerHostsConfigSchema.safeParse({ extraRoots: [{ kind: 'network', path: '//x' }] });
  assert.equal(result.success, false);
});

// ─────────────────────────────────────────────────────────────────────────
// parseRunnerConfig
// ─────────────────────────────────────────────────────────────────────────

test('parseRunnerConfig: a well-formed synthetic .runner parses into a full partial-RunnerInstall', () => {
  const result = parseRunnerConfig(SYNTHETIC_RUNNER_JSON, { root: 'C:/actions-runner', configuredAt: '2026-08-01T00:00:00.000Z' });
  assert.equal(result.error, undefined);
  assert.equal(result.agentId, 999001);
  assert.equal(result.agentName, 'synthetic-test-agent');
  assert.equal(result.owner.ownerKind, 'repo');
  assert.equal(result.owner.ownerSlug, 'example-owner/example-repo');
  assert.equal(result.supervision, null); // filled in later by probeSupervision
  assert.equal(result.configuredAt, '2026-08-01T00:00:00.000Z');
});

test('parseRunnerConfig: truncated/invalid JSON returns the error variant, never a partial install', () => {
  const result = parseRunnerConfig('{ "agentId": 1, "agentName": ', { root: '/x' });
  assert.equal(result.error.code, 'MALFORMED');
  assert.equal(result.agentId, undefined);
});

test('parseRunnerConfig: a leading UTF-8 BOM does not break parsing (field verification, 2026-08-23 — the real actions/runner installer writes .runner as UTF-8-with-BOM on Windows; this failed against a live install before the fix)', () => {
  const withBom = '\uFEFF' + SYNTHETIC_RUNNER_JSON;
  const result = parseRunnerConfig(withBom, { root: 'C:/actions-runner' });
  assert.equal(result.error, undefined);
  assert.equal(result.agentId, 999001);
});

test('parseRunnerConfig: valid JSON that is not an object (array, null, string) is MALFORMED', () => {
  for (const content of ['[]', 'null', '"just a string"', '42']) {
    const result = parseRunnerConfig(content, { root: '/x' });
    assert.equal(result.error.code, 'MALFORMED', `content ${content} must be MALFORMED`);
  }
});

test('parseRunnerConfig: an unrecognised shape (missing required fields) returns MALFORMED, never destructures optimistically', () => {
  const result = parseRunnerConfig(JSON.stringify({ someOtherField: 'x' }), { root: '/x' });
  assert.equal(result.error.code, 'MALFORMED');
});

test('parseRunnerConfig: a gitHubUrl that does not parse to an owner is MALFORMED', () => {
  const content = JSON.stringify({ agentId: 1, agentName: 'a', gitHubUrl: 'not-a-url' });
  const result = parseRunnerConfig(content, { root: '/x' });
  assert.equal(result.error.code, 'MALFORMED');
});

test('parseRunnerConfig: serverUrl is reduced to a host — a secret-looking path segment never appears in the output', () => {
  const secretSegment = 'super-secret-capability-token-abc123';
  const content = JSON.stringify({
    agentId: 1, agentName: 'a', gitHubUrl: 'https://github.com/example-owner/example-repo',
    serverUrl: `https://pipelines.example.invalid/${secretSegment}/`,
  });
  const result = parseRunnerConfig(content, { root: '/x' });
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(secretSegment), 'the secret path segment must not survive into the parsed output');
  assert.equal(result.serverHost, 'pipelines.example.invalid');
});

// ─────────────────────────────────────────────────────────────────────────
// OwnerIdentity codec (D12/R2 M1)
// ─────────────────────────────────────────────────────────────────────────

test('parseOwnerFromGitHubUrl: org and repo shapes', () => {
  assert.deepEqual(parseOwnerFromGitHubUrl('https://github.com/example-org'), {
    host: 'github.com', ownerKind: 'org', ownerSlug: 'example-org', display: 'example-org',
  });
  assert.deepEqual(parseOwnerFromGitHubUrl('https://github.com/Example-Owner/Example-Repo'), {
    host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo', display: 'Example-Owner/Example-Repo',
  });
});

test('parseOwnerFromGitHubUrl: rejects userinfo, query, fragment, and non-https schemes', () => {
  assert.equal(parseOwnerFromGitHubUrl('https://user:pass@github.com/owner/repo'), null);
  assert.equal(parseOwnerFromGitHubUrl('https://github.com/owner/repo?ref=x'), null);
  assert.equal(parseOwnerFromGitHubUrl('https://github.com/owner/repo#frag'), null);
  assert.equal(parseOwnerFromGitHubUrl('ftp://github.com/owner/repo'), null);
  assert.equal(parseOwnerFromGitHubUrl('ssh://git@github.com/owner/repo'), null); // gitHubUrl is https-only
});

test('parseOwnerFromGitHubUrl: an enterprises/<name> path is rejected, never misread as a repo owner (Gemini G2)', () => {
  assert.equal(parseOwnerFromGitHubUrl('https://github.com/enterprises/some-enterprise'), null);
});

test('parseOwnerFromGitHubUrl: malformed input degrades to null, never throws', () => {
  assert.equal(parseOwnerFromGitHubUrl(''), null);
  assert.equal(parseOwnerFromGitHubUrl(null), null);
  assert.equal(parseOwnerFromGitHubUrl('not a url at all'), null);
  assert.equal(parseOwnerFromGitHubUrl('https://github.com/'), null); // zero segments
  assert.equal(parseOwnerFromGitHubUrl('https://github.com/a/b/c'), null); // three segments
});

test('parseOwnerFromGitRemote: https, ssh, and SCP-like forms agree on the same owner (with and without .git)', () => {
  const expected = { host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo', display: 'example-owner/example-repo' };
  assert.deepEqual(parseOwnerFromGitRemote('https://github.com/example-owner/example-repo.git'), expected);
  assert.deepEqual(parseOwnerFromGitRemote('https://github.com/example-owner/example-repo'), expected);
  assert.deepEqual(parseOwnerFromGitRemote('ssh://git@github.com/example-owner/example-repo.git'), expected);
  assert.deepEqual(parseOwnerFromGitRemote('git@github.com:example-owner/example-repo.git'), expected);
  assert.deepEqual(parseOwnerFromGitRemote('git@github.com:example-owner/example-repo'), expected);
});

test('parseOwnerFromGitRemote: rejects query, fragment, and unsupported schemes across all forms', () => {
  assert.equal(parseOwnerFromGitRemote('https://github.com/owner/repo.git?x=1'), null);
  assert.equal(parseOwnerFromGitRemote('https://github.com/owner/repo.git#x'), null);
  assert.equal(parseOwnerFromGitRemote('ftp://github.com/owner/repo.git'), null);
  assert.equal(parseOwnerFromGitRemote('git@github.com:owner/repo.git?x=1'), null);
});

test('parseOwnerFromGitRemote: rejects an https remote carrying userinfo, and an ssh/scp remote carrying an embedded password', () => {
  assert.equal(parseOwnerFromGitRemote('https://user:pass@github.com/owner/repo.git'), null);
  assert.equal(parseOwnerFromGitRemote('ssh://git:pass@github.com/owner/repo.git'), null);
  assert.equal(parseOwnerFromGitRemote('git:pass@github.com:owner/repo.git'), null);
});

test('parseOwnerFromGitRemote: the ordinary ssh transport user (git@) is accepted, not treated as a credential', () => {
  const result = parseOwnerFromGitRemote('ssh://git@github.com/example-owner/example-repo.git');
  assert.notEqual(result, null);
});

test('parseOwnerFromGitRemote: enterprises/<name> rejected here too', () => {
  assert.equal(parseOwnerFromGitRemote('https://github.com/enterprises/some-enterprise.git'), null);
});

test('ownerIdentityEquals: case-insensitive on host and slug, and kind-sensitive', () => {
  const a = { host: 'GitHub.com', ownerKind: 'repo', ownerSlug: 'Owner/Repo', display: 'Owner/Repo' };
  const b = { host: 'github.com', ownerKind: 'repo', ownerSlug: 'owner/repo', display: 'owner/repo' };
  assert.equal(ownerIdentityEquals(a, b), true);
  const c = { host: 'github.com', ownerKind: 'org', ownerSlug: 'owner/repo', display: 'owner/repo' };
  assert.equal(ownerIdentityEquals(a, c), false); // same slug text, different kind
  assert.equal(ownerIdentityEquals(a, null), false);
});

test('ownerGroupKey: deterministic — same input yields the same key every call', () => {
  const id = parseOwnerFromGitHubUrl('https://github.com/example-owner/example-repo');
  const k1 = ownerGroupKey(id);
  const k2 = ownerGroupKey(id);
  assert.equal(k1, k2);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.length > 0);
});

test('ownerCoversRepo: only meaningful for an org-kind first arg and a repo-kind second arg on the same host', () => {
  const org = { host: 'github.com', ownerKind: 'org', ownerSlug: 'example-owner', display: 'example-owner' };
  const repo = { host: 'github.com', ownerKind: 'repo', ownerSlug: 'example-owner/example-repo', display: 'example-owner/example-repo' };
  assert.equal(ownerCoversRepo(org, repo), true);

  const wrongHost = { ...repo, host: 'ghe.example.com' };
  assert.equal(ownerCoversRepo(org, wrongHost), false);

  const bothRepo = { ...org, ownerKind: 'repo', ownerSlug: 'example-owner/other' };
  assert.equal(ownerCoversRepo(bothRepo, repo), false); // first arg not org-kind

  const bothOrg = { ...repo, ownerKind: 'org' };
  assert.equal(ownerCoversRepo(org, bothOrg), false); // second arg not repo-kind
});

// ─────────────────────────────────────────────────────────────────────────
// quoteForShell (R3 M1)
// ─────────────────────────────────────────────────────────────────────────

test('quoteForShell: posix dialect round-trips quotes, spaces, and shell metacharacters', () => {
  const value = `it's a "test" with $(rm -rf /) & spaces; and | pipes`;
  const quoted = quoteForShell(value, 'posix');
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
  // Reconstruct what a POSIX shell would see: split on the escaped-quote idiom.
  const reconstructed = quoted.slice(1, -1).replace(/'\\''/g, "'");
  assert.equal(reconstructed, value);
});

test('quoteForShell: windows dialect round-trips quotes, spaces, and shell metacharacters', () => {
  const value = `has "quotes" and & ampersand and % percent and spaces`;
  const quoted = quoteForShell(value, 'windows');
  assert.ok(quoted.startsWith('"') && quoted.endsWith('"'));
  const reconstructed = quoted.slice(1, -1).replace(/""/g, '"');
  assert.equal(reconstructed, value);
});

test('quoteForShell: an unknown dialect throws rather than silently picking one', () => {
  assert.throws(() => quoteForShell('x', 'bash'), TypeError);
});
