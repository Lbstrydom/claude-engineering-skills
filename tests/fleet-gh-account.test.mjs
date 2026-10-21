/**
 * @fileoverview Each repo's own gh account (docs/plans/fleet-handover-winddown.md §2.10, proposal 3ca0): the token is read from gh's own
 * credential store for the DECLARED account, reaches only that repo's probe, never appears in output, and an unreadable account fails
 * closed naming itself. Each "does not" has a control that fires the other way.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { GH_AUTH_TIMEOUT_MS, GH_TOKEN_VARS, UNAVAILABLE_TOKEN, _resetGhAccountCache, ghAccountToken, ghEnvFor } from '../scripts/lib/fleet/gh-account.mjs';
import { parseFleetConfig } from '../scripts/lib/fleet/config.mjs';
import { ghUnknownLine } from '../scripts/lib/fleet/handover-render.mjs';

after(cleanupFleetRoots);
beforeEach(_resetGhAccountCache);

const okSpawn = (token) => (bin, args) => ({ status: 0, stdout: `${token}\n`, stderr: '', _args: args });

describe('ghAccountToken', () => {
  it('asks gh for exactly the declared account, with a bounded timeout and no inherited stdin', () => {
    let seen;
    const r = ghAccountToken('louis-strydom_wartsila', { spawn: (bin, args, opts) => { seen = { bin, args, opts }; return { status: 0, stdout: 'gho_x\n' }; } });
    assert.deepEqual(r, { ok: true, token: 'gho_x' });
    assert.deepEqual(seen.args, ['auth', 'token', '--user', 'louis-strydom_wartsila']);
    assert.equal(seen.opts.timeout, GH_AUTH_TIMEOUT_MS);
    assert.equal(seen.opts.stdio[0], 'ignore');
  });
  it('an account gh does not hold, an empty answer, or no gh at all is not-ok with a reason naming it (controls: a token is ok)', () => {
    const none = ghAccountToken('ghost', { spawn: () => ({ status: 1, stdout: '', stderr: 'no oauth token' }) });
    assert.deepEqual([none.ok, /signed-in account ghost/.test(none.reason)], [false, true]);
    assert.equal(ghAccountToken('empty', { spawn: () => ({ status: 0, stdout: '  \n' }) }).ok, false);
    assert.match(ghAccountToken('x', { spawn: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) }).reason, /gh not installed/);
    assert.equal(ghAccountToken('a', { spawn: okSpawn('t') }).ok, true);
  });
});

describe('ghEnvFor', () => {
  const base = { PATH: '/bin', GH_TOKEN: 'ambient-token' };
  it('no ghAccount declared: the environment is returned untouched (a repo without the key behaves as before)', () => {
    assert.equal(ghEnvFor({}, base).env, base);
    assert.equal(ghEnvFor(null, base).env, base);
    assert.equal(ghEnvFor({ ghAccount: null }, base).account, null);
  });
  it('declared: that account\'s token replaces the ambient one, in a COPY (the caller\'s environment is not mutated)', () => {
    const r = ghEnvFor({ ghAccount: 'storyline-acct' }, base, { spawn: okSpawn('gho_story') });
    assert.deepEqual([r.env.GH_TOKEN, r.account, r.error], ['gho_story', 'storyline-acct', undefined]);
    assert.equal(base.GH_TOKEN, 'ambient-token');
    assert.equal(r.env.PATH, '/bin');
  });
  it('declared but unreadable: FAILS CLOSED — a token that authenticates as nobody, never the ambient account\'s', () => {
    const r = ghEnvFor({ ghAccount: 'ghost' }, base, { spawn: () => ({ status: 1, stdout: '' }) });
    assert.equal(r.env.GH_TOKEN, UNAVAILABLE_TOKEN);
    assert.notEqual(r.env.GH_TOKEN, 'ambient-token');
    assert.match(r.error, /account ghost/);
  });
  it('H1/M1: EVERY credential variable is set to the declared account\'s token, so no inherited enterprise or GITHUB_TOKEN credential can override it', () => {
    const inherited = { GH_ENTERPRISE_TOKEN: 'ent-other', GITHUB_ENTERPRISE_TOKEN: 'ent-other-2', GITHUB_TOKEN: 'gt-other', GH_HOST: 'git.corp.example' };
    const r = ghEnvFor({ ghAccount: 'alice' }, { ...base, ...inherited }, { spawn: okSpawn('gho_alice') });
    for (const v of GH_TOKEN_VARS) assert.equal(r.env[v], 'gho_alice', v);
    assert.equal(r.env.GH_HOST, 'git.corp.example', 'the host selection is left alone');
    const failed = ghEnvFor({ ghAccount: 'ghost' }, { ...base, ...inherited }, { spawn: () => ({ status: 1, stdout: '' }) });
    for (const v of GH_TOKEN_VARS) assert.equal(failed.env[v], UNAVAILABLE_TOKEN, `${v} fails closed too`);
  });
  it('M2: the lookup runs in the probe\'s environment MINUS every credential variable (an ambient GH_TOKEN would be echoed back by gh auth token), keeping host and config selection', () => {
    let seen;
    ghAccountToken('alice', { spawn: (bin, args, opts) => { seen = opts.env; return { status: 0, stdout: 't' }; }, env: { ...base, GITHUB_TOKEN: 'x', GH_ENTERPRISE_TOKEN: 'y', GH_HOST: 'h.example', GH_CONFIG_DIR: '/cfg', PATH: '/bin' } });
    for (const v of GH_TOKEN_VARS) assert.equal(seen[v], undefined, `${v} must not reach the lookup`);
    assert.deepEqual([seen.GH_HOST, seen.GH_CONFIG_DIR, seen.PATH], ['h.example', '/cfg', '/bin']);
  });
  it('M3: the real lookup is remembered per account and host (account A twice = one gh call, account B asks again), with each account\'s own token', () => {
    const root = tmpRoot('gh-memo-');
    const gh = installFakeGh(root);
    gh.setState({ accounts: { a: 'TOKEN-A', b: 'TOKEN-B' } });
    const env = scrubbedEnv({ ...gh.env }, { prependPath: [gh.bin] });
    assert.deepEqual(ghAccountToken('a', { env }), { ok: true, token: 'TOKEN-A' });
    assert.deepEqual(ghAccountToken('a', { env }), { ok: true, token: 'TOKEN-A' });
    assert.deepEqual(ghAccountToken('b', { env }), { ok: true, token: 'TOKEN-B' });
    assert.deepEqual(ghAccountToken('a', { env: { ...env, GH_HOST: 'other.example' } }), { ok: true, token: 'TOKEN-A' }, 'another host is its own lookup');
    const lookups = gh.calls().filter((c) => c[0] === 'auth').map((c) => c[c.indexOf('--user') + 1]);
    assert.deepEqual(lookups, ['a', 'b', 'a'], 'a once, b once, a again only for the other host');
  });
});

describe('config: ghAccount is a name, validated with the rest of the file', () => {
  const parse = (cfg) => parseFleetConfig(cfg, { hasPackageTest: true });
  it('accepts a gh login (letters, digits, - and _), and a repo without it resolves to null (control)', () => {
    assert.equal(parse({ ghAccount: 'louis-strydom_wartsila' }).ok, true);
    assert.equal(parse({ ghAccount: 'louis-strydom_wartsila' }).value.ghAccount, 'louis-strydom_wartsila');
    assert.equal(parse({}).value.ghAccount, null);
  });
  it('refuses anything that is not a name: empty, spaces, a token-shaped or path-shaped value', () => {
    for (const bad of ['', 'two words', 'gho_' + 'x'.repeat(40), '../etc', 'a;b', 5]) assert.equal(parse({ ghAccount: bad }).ok, false, JSON.stringify(bad));
  });
});

describe('ghUnknownLine names the declared account', () => {
  it('a repo with a declared account says to sign in AS it; one without keeps the generic wording (control)', () => {
    const r = { path: '/r/story', ghRepo: 'o/story', gh: { queried: false, reason: 'gh not authenticated' } };
    assert.match(ghUnknownLine({ ...r, ghAccount: 'acct-1' }), /sign in to gh as acct-1/);
    assert.match(ghUnknownLine(r), /an account that can read o\/story/);
  });
});

describe('the handover probe uses the declared account — real CLI, fake gh', () => {
  /** A fixture repo (optionally declaring `ghAccount`) with the fake gh in front, holding the given signed-in accounts. */
  function world(fleetConfig, accounts) {
    const fx = makeFleetRepo({ fleetConfig });
    // a consumer COMMITS its .fleet.json (the skill says so); left untracked it would read as unregistered work in the main checkout
    if (fleetConfig) { git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'fleet config'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo); }
    const gh = installFakeGh(fx.root);
    gh.setState({ list: [], view: {}, merged: [], accounts });
    const A = tmpRoot('gh-acct-'); fs.mkdirSync(path.join(A, 'projects'), { recursive: true });
    const log = path.join(tmpRoot('gh-log-'), 'tokens.log');
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: A, CLAUDE_AUDIT_LOOP_DIR: '', GH_TOKEN: 'AMBIENT-TOKEN', FAKE_GH_TOKEN_LOG: log, ...gh.env }, { prependPath: [gh.bin] });
    return { fx, env, log };
  }
  const prepare = (w) => runFleet(['handover', 'prepare', '--winddown-waived', 'fixture', '--json'], { cwd: w.fx.repo, env: w.env });
  // Only the PR reads: the `auth token` lookup itself needs no credential and runs in the ambient environment.
  const tokensSeen = (w) => (fs.existsSync(w.log) ? fs.readFileSync(w.log, 'utf8') : '').split('\n').filter((l) => l.startsWith('pr ')).join('\n');

  it('the declared repo\'s PR probe runs with that account\'s token, never the ambient one, and the token reaches no output or manifest', () => {
    const w = world({ ghAccount: 'storyline-acct' }, { 'storyline-acct': 'SECRET-STORYLINE-TOKEN' });
    const r = prepare(w);
    assert.equal(r.status, 0, r.stdout);
    const seen = tokensSeen(w);
    assert.match(seen, /pr list SECRET-STORYLINE-TOKEN/, 'the probe ran as the declared account');
    assert.doesNotMatch(seen, /AMBIENT-TOKEN/, 'and never as the ambient one');
    for (const surface of [r.stdout, r.stderr, fs.readFileSync(r.json.handover.json, 'utf8'), fs.readFileSync(r.json.handover.md, 'utf8')]) assert.doesNotMatch(surface, /SECRET-STORYLINE-TOKEN/);
    assert.equal(JSON.parse(fs.readFileSync(r.json.handover.json, 'utf8')).scope.repos[0].ghAccount, 'storyline-acct', 'the NAME is recorded, so receive and the prose can name it');
  });

  it('control: a repo declaring no account is probed with the ambient token, exactly as before', () => {
    const w = world(null, { 'storyline-acct': 'SECRET-STORYLINE-TOKEN' });
    const r = prepare(w);
    assert.equal(r.status, 0, r.stdout);
    const seen = tokensSeen(w);
    assert.match(seen, /pr list AMBIENT-TOKEN/);
    assert.doesNotMatch(seen, /SECRET-STORYLINE-TOKEN/);
    assert.equal(JSON.parse(fs.readFileSync(r.json.handover.json, 'utf8')).scope.repos[0].ghAccount, undefined);
  });

  it('a declared account gh does not hold FAILS CLOSED: PR state is UNMEASURED naming it, and the ambient token is never used', () => {
    const w = world({ ghAccount: 'ghost-acct' }, {});
    const r = prepare(w);
    const m = JSON.parse(fs.readFileSync(r.json.handover.json, 'utf8'));
    assert.equal(m.scope.repos[0].gh.queried, false);
    assert.match(m.scope.repos[0].gh.reason, /gh account ghost-acct is not available/);
    assert.match(r.json.text, /sign in to gh as ghost-acct/);
    assert.doesNotMatch(tokensSeen(w), /AMBIENT-TOKEN/, 'the ambient account never answered for a repo that declared another');
  });
});
