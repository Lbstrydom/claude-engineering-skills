/**
 * @fileoverview Contract tests for the GitHub token-permission probe
 * (`scripts/lib/doctor/github-permissions.mjs`, `check-setup.mjs`'s "GitHub"
 * section).
 *
 * Header fixtures are transcribed from REAL responses measured 2026-08-28 with
 * `gh api -i` against `Lbstrydom/claude-engineering-skills` — not invented. A
 * hand-written fixture here would encode what the parser expects, which is the
 * assumption under test (AGENTS.md "Contracts across the prose<->code seam").
 * The two measured shapes:
 *
 *   fine-grained PAT  → `X-Accepted-Github-Permissions: checks=read`
 *   classic OAuth     → NO such header; `X-Accepted-Oauth-Scopes: repo`
 *
 * Every test drives an injected transport, so nothing here touches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPECTED_SOURCE_VAR,
  READ_PROBES,
  TOKEN_SOURCE_KINDS,
  WRITE_REQUIREMENTS,
  classifyProbeStatus,
  evaluateExpectedSource,
  tokenSourceKind,
  formatPermissionGroups,
  parseAcceptedOauthScopes,
  parseAcceptedPermissions,
  parseRequiredAccess,
  probeGitHubPermissions,
  readGhKeyringToken,
  resolveDefaultBranch,
  resolveTokenSources,
  tokenFingerprint,
  tokenKind,
} from '../scripts/lib/doctor/github-permissions.mjs';

// ── Header parsing ────────────────────────────────────────────────────────────

test('parseAcceptedPermissions reads the measured single-permission shape', () => {
  const p = parseAcceptedPermissions('checks=read');
  assert.deepEqual(p.groups, [['checks=read']]);
  assert.equal(p.permissionless, false);
  assert.equal(p.raw, 'checks=read');
});

test('parseAcceptedPermissions keeps alternatives and conjunctions apart', () => {
  // Comma = alternatives (either suffices); semicolon = all of them required.
  assert.deepEqual(
    parseAcceptedPermissions('issues=read,pull_requests=read').groups,
    [['issues=read'], ['pull_requests=read']],
  );
  assert.deepEqual(
    parseAcceptedPermissions('issues=write; pull_requests=write').groups,
    [['issues=write', 'pull_requests=write']],
  );
  assert.equal(formatPermissionGroups(parseAcceptedPermissions('issues=read,pull_requests=read').groups),
    'issues=read OR pull_requests=read');
  assert.equal(formatPermissionGroups(parseAcceptedPermissions('issues=write; pull_requests=write').groups),
    'issues=write + pull_requests=write');
});

test('allows_permissionless_access is a marker, never reported as a permission', () => {
  // Measured on GET /user. Recording it as a permission would print a
  // "GRANTED allows_permissionless_access=true" line meaning nothing.
  const p = parseAcceptedPermissions('allows_permissionless_access=true');
  assert.deepEqual(p.groups, []);
  assert.equal(p.permissionless, true);
});

test('an absent header is distinguishable from an empty one', () => {
  // Absent = GitHub declared nothing (the check could not measure).
  // Empty  = GitHub declared that NOTHING is required (a real answer).
  assert.equal(parseAcceptedPermissions(undefined).raw, null);
  assert.equal(parseAcceptedOauthScopes(undefined).raw, null);
  assert.equal(parseAcceptedOauthScopes('').raw, '');
  assert.deepEqual(parseAcceptedOauthScopes('').groups, []);
});

test('parseRequiredAccess picks the model from whichever header arrived', () => {
  assert.equal(parseRequiredAccess({ 'x-accepted-github-permissions': 'checks=read' }).model, 'fine-grained');
  // The classic-token case: measured live, a gho_ token gets NO fine-grained
  // header on any endpoint. Reading only that header would make this check
  // silently measure nothing for every consumer on a classic credential.
  const oauth = parseRequiredAccess({ 'x-accepted-oauth-scopes': 'repo', 'x-oauth-scopes': 'gist, repo' });
  assert.equal(oauth.model, 'oauth');
  assert.deepEqual(oauth.groups, [['repo']]);
  assert.equal(parseRequiredAccess({}).model, 'none');
});

test('the fine-grained header wins when both are present', () => {
  const both = parseRequiredAccess({
    'x-accepted-github-permissions': 'checks=read',
    'x-accepted-oauth-scopes': 'repo',
  });
  assert.equal(both.model, 'fine-grained');
  assert.deepEqual(both.groups, [['checks=read']]);
});

// ── Status classification ─────────────────────────────────────────────────────

test('classifyProbeStatus: 403 is MISSING, 404 is UNKNOWN, never the reverse', () => {
  assert.equal(classifyProbeStatus(403), 'missing');
  // Load-bearing: GitHub answers 404 (not 403) when a fine-grained token cannot
  // see a resource at all, AND when the resource genuinely does not exist (a
  // repo with no branch protection). Calling that MISSING would send an
  // operator to fix a permission that was never the problem.
  assert.equal(classifyProbeStatus(404), 'unknown');
  assert.equal(classifyProbeStatus(401), 'unauthorized');
});

test('classifyProbeStatus: the direction it must NOT fire', () => {
  // A false MISSING is the expensive error here — it sends someone editing
  // token permissions that were fine. No success status may ever produce one.
  for (const ok of [200, 201, 204, 299]) {
    assert.equal(classifyProbeStatus(ok), 'granted', `HTTP ${ok} must be granted`);
  }
  // 422 (measured: a nonexistent branch on .../check-runs) got PAST
  // authorization and failed validation — the permission IS granted.
  assert.equal(classifyProbeStatus(422), 'granted');
  assert.equal(classifyProbeStatus(500), 'error');
});

// ── Probe table invariants ────────────────────────────────────────────────────

test('every probe is read-only and addresses an existing resource', () => {
  // The rule the module exists under: no re-run / dispatch / create probe, ever.
  // A setup doctor that dispatches a workflow to learn it *could* has changed
  // the repo it was asked to inspect.
  const forbidden = /\/(dispatches|rerun|reruns|cancel|merge|forks|comments)\b/;
  for (const probe of READ_PROBES) {
    const p = probe.path({ slug: 'o/r', branch: 'main' });
    assert.ok(p.startsWith('/'), `${probe.id}: path must be host-relative`);
    assert.ok(!forbidden.test(p), `${probe.id}: ${p} looks like a side-effecting endpoint`);
    assert.ok(probe.reason && probe.reason.length > 10, `${probe.id}: must carry a human reason`);
  }
});

test('write requirements are documentation only — nothing probes them', () => {
  const probedPaths = READ_PROBES.map((p) => p.path({ slug: 'o/r', branch: 'main' })).join(' ');
  assert.ok(WRITE_REQUIREMENTS.length > 0);
  for (const w of WRITE_REQUIREMENTS) {
    assert.match(w.permission, /=write$/);
    assert.ok(w.scope, `${w.permission}: needs its classic-OAuth equivalent — a reader on a classic PAT cannot act on a fine-grained name`);
    assert.ok(w.reason.length > 10);
  }
  assert.ok(!/dispatches|rerun/.test(probedPaths));
});

test('branch-scoped probes use the resolved default branch, not a hardcoded main', () => {
  const paths = READ_PROBES.map((p) => p.path({ slug: 'o/r', branch: 'develop' }));
  assert.ok(paths.some((p) => p.includes('develop')));
  assert.ok(!paths.some((p) => p.includes('/main')), 'no probe may hardcode `main`');
});

// ── Permission names are DERIVED, never declared ──────────────────────────────

test('the probe table declares no permission name — they come from the header', () => {
  // If a permission name were hardcoded in READ_PROBES, this check would report
  // the repo's own stale table rather than what GitHub enforces today, and a
  // GitHub re-partition would show up as a wrong PASS instead of a changed name.
  const serialised = JSON.stringify(READ_PROBES.map((p) => ({
    id: p.id, reason: p.reason, path: p.path({ slug: 'o/r', branch: 'main' }),
  })));
  for (const name of ['checks=read', 'metadata=read', 'pull_requests=read', 'administration=read']) {
    assert.ok(!serialised.includes(name), `${name} must not be hardcoded in the probe table`);
  }
});

test('probeGitHubPermissions derives each permission from the response header', async () => {
  const responses = {
    '/repos/o/r': { status: 200, headers: { 'x-accepted-github-permissions': 'metadata=read' } },
    '/repos/o/r/branches/main/protection': { status: 403, headers: { 'x-accepted-github-permissions': 'administration=read' } },
  };
  const get = async (p) => responses[p] || { status: 200, headers: { 'x-accepted-github-permissions': 'contents=read' }, body: '' };
  const results = await probeGitHubPermissions({
    slug: 'o/r', branch: 'main', token: 't', get,
    probes: READ_PROBES.filter((p) => p.id === 'repo' || p.id === 'branch-protection'),
  });

  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.deepEqual(byId.repo.permissions, [['metadata=read']]);
  assert.equal(byId.repo.verdict, 'granted');
  // The measured example from the task: 403 + administration=read.
  assert.deepEqual(byId['branch-protection'].permissions, [['administration=read']]);
  assert.equal(byId['branch-protection'].verdict, 'missing');
});

test('a permission name the code has never seen still round-trips', () => {
  // Negative control for "derived, not hardcoded": if the parser only handled
  // known names this would fail. It must carry an invented one through intact.
  const p = parseAcceptedPermissions('some_future_permission=read');
  assert.equal(formatPermissionGroups(p.groups), 'some_future_permission=read');
});

test('a response with no permission header is reported as unmeasured, not as granted', async () => {
  const get = async () => ({ status: 200, headers: {}, body: '' });
  const [r] = await probeGitHubPermissions({
    slug: 'o/r', branch: 'main', token: 't', get, probes: [READ_PROBES[0]],
  });
  assert.equal(r.headerPresent, false);
  assert.deepEqual(r.permissions, []);
});

test('a transport error is an error verdict, never a silent pass', async () => {
  const get = async () => ({ status: 0, headers: {}, body: '', error: 'getaddrinfo ENOTFOUND' });
  const [r] = await probeGitHubPermissions({
    slug: 'o/r', branch: 'main', token: 't', get, probes: [READ_PROBES[0]],
  });
  assert.equal(r.verdict, 'error');
  assert.equal(r.error, 'getaddrinfo ENOTFOUND');
});

// ── Token sources ─────────────────────────────────────────────────────────────

test('token sources follow gh precedence and .env is credited over a mirrored shell value', () => {
  // check-setup.mjs imports lib/load-env.mjs, so a .env value is ALREADY in
  // process.env by the time this runs. Crediting the shell for it would name
  // the wrong source in the very output whose job is naming the right one.
  const mirrored = resolveTokenSources({
    processEnv: { GH_TOKEN: 'abc' },
    fileEnv: { GH_TOKEN: 'abc' },
    envFilePath: '/repo/.env',
    gh: { token: null, reason: 'not logged in' },
  });
  assert.equal(mirrored.sources.length, 1);
  assert.equal(mirrored.winner.id, 'dotenv:GH_TOKEN');
  assert.match(mirrored.winner.label, /\/repo\/\.env/);

  const shellWins = resolveTokenSources({
    processEnv: { GH_TOKEN: 'from-shell' },
    fileEnv: { GH_TOKEN: 'from-file' },
    envFilePath: '/repo/.env',
    gh: { token: 'from-keyring' },
  });
  assert.deepEqual(shellWins.sources.map((s) => s.id),
    ['env:GH_TOKEN', 'dotenv:GH_TOKEN', 'gh:keyring']);
  assert.equal(shellWins.winner.id, 'env:GH_TOKEN');
});

test('GH_TOKEN outranks GITHUB_TOKEN, matching gh itself', () => {
  const r = resolveTokenSources({
    processEnv: { GITHUB_TOKEN: 'b', GH_TOKEN: 'a' },
    fileEnv: {},
    gh: { token: null },
  });
  assert.equal(r.winner.id, 'env:GH_TOKEN');
});

test('the .env / keyring pair a consumer lost time to is surfaced, not collapsed', () => {
  // The incident: `.env` held one token, `gh`'s keyring another with different
  // permissions, and nothing ever compared them. Both must survive into the
  // source list so the caller can compare their identities.
  const r = resolveTokenSources({
    processEnv: {},
    fileEnv: { GH_TOKEN: 'dotenv-token' },
    envFilePath: '/repo/.env',
    gh: { token: 'keyring-token' },
  });
  assert.equal(r.sources.length, 2);
  assert.notEqual(tokenFingerprint('dotenv-token'), tokenFingerprint('keyring-token'));
});

test('no token anywhere degrades silently — no winner, and the gh reason is carried', () => {
  const r = resolveTokenSources({
    processEnv: {}, fileEnv: {}, gh: { token: null, reason: 'the `gh` CLI is not installed' },
  });
  assert.equal(r.winner, null);
  assert.deepEqual(r.sources, []);
  assert.equal(r.ghReason, 'the `gh` CLI is not installed');
});

test('readGhKeyringToken scrubs GH_TOKEN/GITHUB_TOKEN from the child env', () => {
  // `gh auth token` echoes those vars when set. Inheriting them would make the
  // keyring agree with the environment BY CONSTRUCTION, so the disagreement
  // warning could never fire — the check would look alive and measure nothing.
  let seenEnv = null;
  const exec = (_bin, _args, opts) => { seenEnv = opts.env; return 'keyring-value\n'; };
  const out = readGhKeyringToken({
    exec,
    env: { GH_TOKEN: 'shell', GITHUB_TOKEN: 'shell2', PATH: '/usr/bin' },
  });
  assert.equal(out.token, 'keyring-value');
  assert.equal(seenEnv.GH_TOKEN, undefined);
  assert.equal(seenEnv.GITHUB_TOKEN, undefined);
  assert.equal(seenEnv.PATH, '/usr/bin', 'the rest of the environment must survive');
});

test('readGhKeyringToken reports absence as a reason, never as a throw', () => {
  const enoent = readGhKeyringToken({ exec: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } });
  assert.equal(enoent.token, null);
  assert.match(enoent.reason, /not installed/);

  const loggedOut = readGhKeyringToken({
    exec: () => { const e = new Error('exit 1'); e.stderr = 'gh: not logged in\n'; throw e; },
  });
  assert.equal(loggedOut.token, null);
  assert.match(loggedOut.reason, /not logged in/);
});

test('tokenKind names the credential model without revealing the secret', () => {
  const secret = 'github_pat_11BP2FLMA0FKk7Wm3m3bue_supersecrettail';
  const kind = tokenKind(secret);
  assert.equal(kind, 'fine-grained PAT');
  assert.ok(!kind.includes('supersecrettail'));
  assert.ok(!secret.includes(tokenFingerprint(secret)), 'the fingerprint must not be a substring of the token');
  assert.equal(tokenKind('gho_abc'), 'OAuth token');
  assert.equal(tokenKind('ghp_abc'), 'classic PAT');
  assert.equal(tokenKind('ghs_abc'), 'GitHub App installation token');
  assert.equal(tokenKind('weird'), 'unrecognised token format');
});

test('tokenFingerprint is stable and discriminating', () => {
  assert.equal(tokenFingerprint('a'), tokenFingerprint('a'));
  assert.notEqual(tokenFingerprint('a'), tokenFingerprint('b'));
  assert.match(tokenFingerprint('a'), /^[0-9a-f]{8}$/);
});

// ── Declared token source (GH_TOKEN_SOURCE_EXPECTED) ──────────────────────────

test('tokenSourceKind reduces a source id to its kind, ignoring which var carried it', () => {
  // A repo declaring "my .env owns this" must not have to re-declare when it
  // renames GH_TOKEN to GITHUB_TOKEN.
  assert.equal(tokenSourceKind('dotenv:GH_TOKEN'), 'dotenv');
  assert.equal(tokenSourceKind('dotenv:GITHUB_TOKEN'), 'dotenv');
  assert.equal(tokenSourceKind('env:GH_TOKEN'), 'shell');
  assert.equal(tokenSourceKind('gh:keyring'), 'keyring');
  assert.equal(tokenSourceKind('something-else'), null);
  assert.equal(tokenSourceKind(undefined), null);
});

test('a declaration that HOLDS is a match', () => {
  const r = evaluateExpectedSource('dotenv', 'dotenv:GITHUB_TOKEN');
  assert.equal(r.state, 'match');
  assert.equal(r.declared, 'dotenv');
  assert.equal(r.actual, 'dotenv');
});

test('a declaration is falsifiable — the direction the opt-out must NOT suppress', () => {
  // The whole point of a declaration over a mute: the day the intended token
  // stops winning is exactly when the repo needs to hear about it. A blunt
  // suppression flag would be silent here.
  const r = evaluateExpectedSource('dotenv', 'env:GH_TOKEN');
  assert.equal(r.state, 'mismatch');
  assert.equal(r.declared, 'dotenv');
  assert.equal(r.actual, 'shell');
});

test('an unrecognised declaration is invalid, never a silent opt-out', () => {
  // A typo must not suppress the warning by accident — the failure mode where
  // a repo believes it declared something it did not.
  for (const bad of ['.env', 'dot-env', 'gh', 'true', 'yes']) {
    const r = evaluateExpectedSource(bad, 'dotenv:GITHUB_TOKEN');
    assert.equal(r.state, 'invalid', `"${bad}" must not be accepted`);
  }
  assert.deepEqual([...TOKEN_SOURCE_KINDS], ['shell', 'dotenv', 'keyring']);
});

test('declarations are case- and whitespace-insensitive, but absence stays unset', () => {
  assert.equal(evaluateExpectedSource('  DOTENV  ', 'dotenv:GH_TOKEN').state, 'match');
  for (const empty of [undefined, null, '', '   ']) {
    assert.equal(evaluateExpectedSource(empty, 'gh:keyring').state, 'unset');
  }
});

test('a declaration with no winning source cannot masquerade as a match', () => {
  // Guards the degenerate call: no token found, so there is no actual source.
  // `null === 'dotenv'` is false, so this lands on mismatch, never match.
  const r = evaluateExpectedSource('dotenv', null);
  assert.equal(r.state, 'mismatch');
  assert.equal(r.actual, null);
});

test('EXPECTED_SOURCE_VAR is the name the docs and the .env marker both use', () => {
  assert.equal(EXPECTED_SOURCE_VAR, 'GH_TOKEN_SOURCE_EXPECTED');
});

// ── Default-branch resolution ─────────────────────────────────────────────────

test('resolveDefaultBranch reads the repo response, and falls back rather than failing', async () => {
  const ok = await resolveDefaultBranch({
    slug: 'o/r', token: 't',
    get: async () => ({ status: 200, headers: {}, body: JSON.stringify({ default_branch: 'develop' }) }),
  });
  assert.equal(ok, 'develop');

  // A wrong branch yields 422, which classifyProbeStatus already reads as
  // "authorization passed" — so falling back is safe and beats aborting.
  const fallback = await resolveDefaultBranch({
    slug: 'o/r', token: 't', get: async () => ({ status: 403, headers: {}, body: '' }),
  });
  assert.equal(fallback, 'main');
});
