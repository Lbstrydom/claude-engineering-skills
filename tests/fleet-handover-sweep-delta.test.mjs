/**
 * @fileoverview Handover receive, two additions (proposals p-20261017123120-103f, p-20261017123914-6797):
 *  - the stale-session SWEEP follow-up (bounded, exceptions named, never resume, never archive on the departing account,
 *    "list what could not be archived"); and
 *  - the post-prepare DELTA: per repo, commits / PRs / claims / proposals newer than the handover's createdAt, where a
 *    failed measurement prints as UNMEASURED and never as "nothing new".
 * Each "does not" case has a control that fires the other way.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, commitFile, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { spawnSync } from 'node:child_process';
import { deltaFollowUp, deltaNeedsAttention, measureRepoDelta, previousStintStart, renderDeltaLines, unmeasuredDelta } from '../scripts/lib/fleet/handover-delta.mjs';
import { receiveFollowUps, OP_ID_RE } from '../scripts/lib/fleet/handover.mjs';

after(cleanupFleetRoots);

const SINCE = '2026-10-17T12:00:00.000Z';
const okRun = (stdout) => ({ ok: true, status: 0, stdout, stderr: '', reason: null });
const badRun = (reason) => ({ ok: false, status: 1, stdout: '', stderr: reason, reason });
const ghOk = (rows) => ({ status: 0, stdout: JSON.stringify(rows), stderr: '' });
const noFleet = { readSessions: () => ({ sessions: [], complete: true }), readProposals: () => ({ records: [], complete: true }) };

const sweepOf = (over = {}) => receiveFollowUps({
  tasks: [], settingsReview: [], identity: { account: { status: 'different', source: 'a', mine: 'b' } }, ghUnknown: [], waits: [],
  sweep: { createdAt: SINCE, lowerBound: '2026-10-14T08:00:00.000Z', claimed: [], ...over },
}).find((f) => f.kind === 'session-sweep');

describe('stale-session sweep follow-up (103f)', () => {
  it('tells the arriving account to list_sessions and archive sessions last active before createdAt, bounded below', () => {
    const d = sweepOf().detail;
    assert.match(d, /list_sessions/);
    assert.match(d, /archive every session last active before 2026-10-17T12:00:00\.000Z/);
    assert.match(d, /not earlier than 2026-10-14T08:00:00\.000Z/);
  });
  it('lists the exceptions: live-claim worktrees and uncommitted work no claim covers', () => {
    const d = sweepOf({ claimed: [{ repo: 'R', id: 'claude/x', worktree: 'C:/wt/x' }] }).detail;
    assert.match(d, /claude\/x \(C:\/wt\/x\)/);
    assert.match(d, /uncommitted work no claim covers/);
    assert.match(d, /list those for the user/);
  });
  it('never resume a pre-handover session; never archive on the DEPARTING account (archive_session removes the worktree)', () => {
    const d = sweepOf().detail;
    assert.match(d, /never resume a pre-handover session/i);
    assert.match(d, /archive_session removes the worktree by default/);
    assert.match(d, /never archive sessions on the departing account/i);
  });
  it('lesson (a): the sweep ends by listing what could NOT be archived (a classifier refusal), never implying all were', () => {
    assert.match(sweepOf().detail, /permission classifier/);
    assert.match(sweepOf().detail, /list what could not be archived/i);
  });
  it('lesson (b): list_sessions caps at 100 per call, so the sweep is bounded and the left-over is reported', () => {
    const d = sweepOf().detail;
    assert.match(d, /at most 100 per call/);
    assert.match(d, /older than that bound and left/);
  });
  it('no previous handover to bound by: says so rather than inventing a bound', () => {
    const d = sweepOf({ lowerBound: null }).detail;
    assert.match(d, /no earlier handover manifest/);
    assert.doesNotMatch(d, /not earlier than/);
  });
  it('control: the SAME account has no stale stint to sweep, so no follow-up', () => {
    const f = receiveFollowUps({ tasks: [], settingsReview: [], identity: { account: { status: 'same' } }, ghUnknown: [], waits: [], sweep: { createdAt: SINCE, lowerBound: null, claimed: [] } });
    assert.equal(f.find((x) => x.kind === 'session-sweep'), undefined);
  });
});

describe('previousStintStart: the arriving account last stint began at the SECOND-newest older manifest', () => {
  const id = (iso, h = 'aaaaaa') => `${iso.replace(/[-:.]/g, '')}-${h}`;
  const dirOf = (...ids) => ({ readdir: () => ids.map((i) => `handover-${i}.json`).concat(['handover-x.md', 'junk']) });
  const M0 = id('2026-10-10T08:00:00.000Z'); const M1 = id('2026-10-14T08:00:00.000Z'); const M2 = id('2026-10-17T12:00:00.000Z');
  it('three manifests: the bound is M0', () => {
    assert.ok(OP_ID_RE.test(M0));
    assert.deepEqual(previousStintStart('d', M2, dirOf(M0, M1, M2)), { ok: true, at: '2026-10-10T08:00:00.000Z' });
  });
  it('one older manifest only: no bound (null), not a guess', () => assert.deepEqual(previousStintStart('d', M2, dirOf(M1, M2)), { ok: true, at: null }));
  it('control: a NEWER manifest is not an older one', () => assert.deepEqual(previousStintStart('d', M1, dirOf(M0, M1, M2)), { ok: true, at: null }));
  it('an unlistable directory is unmeasured, never "no bound"', () => {
    const r = previousStintStart('d', M2, { readdir: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /EACCES/);
  });
});

describe('measureRepoDelta (6797): every field measured or UNMEASURED', () => {
  const log = '1111111111111111111111111111111111111111\tfix a\n2222222222222222222222222222222222222222\tadd b\n';
  const deps = (over = {}) => ({
    git: (args) => (args[0] === 'fetch' ? okRun('') : okRun(log)),
    gh: () => ghOk([{ number: 7, title: 'a pr', state: 'OPEN', updatedAt: '2026-10-17T13:00:00Z', headRefName: 'b' }]),
    fleetDirOf: () => 'FLEET', ...noFleet, ...over,
  });
  it('reports commits, PRs, claims and proposals newer than createdAt', () => {
    const d = measureRepoDelta('R', SINCE, deps({
      readSessions: () => ({ sessions: [{ id: 'claude/n', updatedAt: '2026-10-17T12:30:00.000Z', createdAt: '2026-10-17T12:30:00.000Z' }, { id: 'claude/old', updatedAt: '2026-10-17T11:00:00.000Z', createdAt: '2026-10-16T11:00:00.000Z' }], complete: true }),
      readProposals: () => ({ records: [{ id: 'p-1', what: 'w', createdAt: '2026-10-17T12:40:00.000Z', state: 'pending' }, { id: 'p-0', what: 'old', createdAt: '2026-10-16T00:00:00.000Z', state: 'pending' }], complete: true }),
    }));
    assert.deepEqual(d.commits.items.map((c) => c.subject), ['fix a', 'add b']);
    assert.deepEqual(d.prs.items.map((p) => p.number), [7]);
    assert.deepEqual(d.claims.items.map((c) => c.id), ['claude/n']);
    assert.deepEqual(d.proposals.items.map((p) => p.id), ['p-1']);
  });
  it('gh failing is UNMEASURED with the reason, never an empty list', () => {
    const d = measureRepoDelta('R', SINCE, deps({ gh: () => ({ status: 1, stdout: '', stderr: 'Could not resolve to a Repository with the name x/y' }) }));
    assert.equal(d.prs.measured, false);
    assert.match(d.prs.reason, /Could not resolve to a Repository/);
    assert.equal(d.prs.items, undefined);
    assert.match(renderDeltaLines(d).join('\n'), /PRs: UNMEASURED \(.*Could not resolve to a Repository/);
    assert.doesNotMatch(renderDeltaLines(d).join('\n'), /PRs: none/);
  });
  it('control: gh succeeding with an empty list IS a measured "none"', () => {
    const d = measureRepoDelta('R', SINCE, deps({ gh: () => ghOk([]) }));
    assert.equal(d.prs.measured, true);
    assert.match(renderDeltaLines(d).join('\n'), /PRs: none updated since/);
  });
  it('gh printing something that is not a JSON array is unmeasured', () => {
    assert.equal(measureRepoDelta('R', SINCE, deps({ gh: () => ({ status: 0, stdout: 'not json', stderr: '' }) })).prs.measured, false);
    assert.equal(measureRepoDelta('R', SINCE, deps({ gh: () => ({ status: 0, stdout: '{}', stderr: '' }) })).prs.measured, false);
  });
  it('a gh that could not spawn is unmeasured', () => {
    assert.equal(measureRepoDelta('R', SINCE, deps({ gh: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) })).prs.measured, false);
  });
  it('git log failing is unmeasured commits', () => {
    const d = measureRepoDelta('R', SINCE, deps({ git: (a) => (a[0] === 'fetch' ? okRun('') : badRun('git log exited 128: fatal')) }));
    assert.equal(d.commits.measured, false);
    assert.match(renderDeltaLines(d).join('\n'), /commits: UNMEASURED/);
  });
  it('fetches BEFORE the log; a failed fetch says the log is as of the last fetch', () => {
    const order = [];
    measureRepoDelta('R', SINCE, deps({ git: (a) => { order.push(a[0]); return okRun(a[0] === 'fetch' ? '' : log); } }));
    assert.deepEqual(order, ['fetch', 'log']);
    const d = measureRepoDelta('R', SINCE, deps({ git: (a) => (a[0] === 'fetch' ? badRun('git fetch failed: offline') : okRun(log)) }));
    assert.match(renderDeltaLines(d).join('\n'), /as of the last fetch/);
    assert.equal(d.commits.measured, true);
  });
  it('a successful fetch does NOT claim the log is stale (control)', () => {
    assert.doesNotMatch(renderDeltaLines(measureRepoDelta('R', SINCE, deps())).join('\n'), /as of the last fetch/);
  });
  it('--dry-run does not fetch (nothing written) and says so', () => {
    const calls = [];
    const d = measureRepoDelta('R', SINCE, deps({ fetch: false, git: (a) => { calls.push(a[0]); return okRun(log); } }));
    assert.deepEqual(calls, ['log']);
    assert.match(renderDeltaLines(d).join('\n'), /as of the last fetch/);
  });
  it('an unreadable registry or proposals dir is unmeasured claims / proposals, not none', () => {
    const d = measureRepoDelta('R', SINCE, deps({ readSessions: () => ({ sessions: [], complete: false, invalid: [{ file: 'f', reason: 'bad' }] }), readProposals: () => ({ records: [], complete: false, unmeasured: true, reason: 'x' }) }));
    assert.equal(d.claims.measured, false);
    assert.equal(d.proposals.measured, false);
  });
  it('the gh query asks for ALL states updated since createdAt', () => {
    let seen;
    measureRepoDelta('R', SINCE, deps({ gh: (cwd, args) => { seen = args; return ghOk([]); } }));
    assert.ok(seen.includes('--state') && seen[seen.indexOf('--state') + 1] === 'all');
    assert.ok(seen.includes(`updated:>=${SINCE}`));
  });
});

describe('audit R1 fixes', () => {
  const okLog = (stdout) => ({ ok: true, status: 0, stdout, stderr: '', reason: null });
  it('git log filters (--since-as-filter), it does not prune with --since', () => {
    let args;
    measureRepoDelta('R', SINCE, { git: (a) => { args = a; return okLog(''); }, gh: () => ghOk([]), fetch: false, fleetDirOf: () => 'F', ...noFleet });
    assert.ok(args.some((a) => a.startsWith('--since-as-filter=')));
    assert.ok(!args.some((a) => a.startsWith('--since=')));
  });
  it('REAL git: a new commit behind an older-dated tip is found (non-monotonic dates; --since would prune it)', () => {
    const fx = makeFleetRepo();
    const at = (iso) => ({ ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
    const commit = (name, iso) => { fs.writeFileSync(path.join(fx.repo, name), name); git(['add', name], fx.repo); const r = spawnSync('git', ['commit', '-q', '-m', name], { cwd: fx.repo, env: at(iso) }); assert.equal(r.status, 0, String(r.stderr)); };
    commit('newer-parent.txt', '2026-12-01T00:00:00Z');
    commit('older-tip.txt', '2020-01-01T00:00:00Z');
    const d = measureRepoDelta(fx.repo, '2026-11-01T00:00:00.000Z', { fetch: false, gh: () => ghOk([]), fleetDirOf: () => 'F', ...noFleet });
    assert.deepEqual(d.commits.items.map((c) => c.subject), ['newer-parent.txt']);
    // control: the pruning form really does miss it, so this test can fail
    const pruned = git(['log', '--all', `--since=${SINCE}`, '--format=%s'], fx.repo);
    assert.doesNotMatch(pruned, /newer-parent/);
  });
  it('an unreachable repo path still gets a delta record, every field UNMEASURED', () => {
    const d = unmeasuredDelta('/gone', SINCE, 'repo path no longer exists');
    for (const f of ['commits', 'prs', 'claims', 'proposals']) assert.equal(d[f].measured, false);
    assert.equal(deltaNeedsAttention(d), true);
    assert.match(renderDeltaLines(d).join('\n'), /commits: UNMEASURED \(repo path no longer exists\)/);
  });
  it('a vanished repo in the manifest appears in receive delta as UNMEASURED', () => {
    const fx = makeFleetRepo(); const fx2 = makeFleetRepo();
    const cfg = tmpRoot('rcv-gone-');
    fs.mkdirSync(path.join(cfg, 'projects', 'c--GIT-demo', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'projects', 'c--GIT-demo', 'memory', 'MEMORY.md'), '- i\n');
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '' });
    const p = runFleet(['handover', 'prepare', '--repo', fx2.repo, '--json'], { cwd: fx.repo, env });
    assert.equal(p.status, 0, p.stdout);
    fs.rmSync(fx2.repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const r = runFleet(['handover', 'receive', '--from', p.json.handover.json, '--json'], { cwd: fx.repo, env });
    const gone = r.json.handover.delta.find((x) => x.repo === fx2.repo);
    assert.ok(gone, r.stdout);
    assert.equal(gone.commits.measured, false);
    // the vanished repo is also named in the sweep: its claims were not readable, so nothing is archived blind
    const sw = r.json.handover.followUps.find((x) => x.kind === 'session-sweep');
    assert.ok(sw && sw.detail.includes(fx2.repo), r.stdout);
  });
  it('a repo whose live claims could not be read is named in the sweep: nothing archived blind', () => {
    const d = sweepOf({ claimsUnknown: ['C:/GIT/storyline'] }).detail;
    assert.match(d, /could NOT be read/);
    assert.match(d, /storyline/);
  });
  it('claims were read only in the handover repos: a session elsewhere stays open (scope is named)', () => {
    const d = sweepOf({ scopeRepos: ['C:/GIT/a', 'C:/GIT/b'] }).detail;
    assert.ok(d.includes('read only in C:/GIT/a, C:/GIT/b'), d);
    assert.match(d, /another repo/);
  });
  it('no bound: page through all, confirm with the user past 300 (not an arbitrary page cap)', () => {
    const d = sweepOf({ lowerBound: null }).detail;
    assert.match(d, /more than 300/);
    assert.doesNotMatch(d, /two pages/);
  });
  it('control: no unknown claims, no such warning', () => assert.doesNotMatch(sweepOf().detail, /could NOT be read/));
  it('a FAILED fetch alone needs attention (a stale log is not "nothing new"); a dry-run skip alone does not', () => {
    const base = { repo: 'R', since: SINCE, commits: { measured: true, total: 0, items: [] }, prs: { measured: true, total: 0, items: [] }, claims: { measured: true, total: 0, items: [] }, proposals: { measured: true, total: 0, items: [] } };
    const failed = { ...base, fetched: { done: false, failed: true, why: 'fetch failed: offline' } };
    assert.equal(deltaNeedsAttention(failed), true);
    assert.match(deltaFollowUp([failed]).detail, /as of the last fetch/);
    assert.equal(deltaNeedsAttention({ ...base, fetched: { done: false, why: 'skipped in --dry-run' } }), false);
  });
  it('a capped count is labelled capped in the follow-up, never an exact-looking total', () => {
    const d = { repo: 'R', since: SINCE, fetched: { done: true }, commits: { measured: true, total: 200, truncated: true, items: [] }, prs: { measured: true, total: 0, items: [] }, claims: { measured: true, total: 0, items: [] }, proposals: { measured: true, total: 0, items: [] } };
    assert.match(deltaFollowUp([d]).detail, /200\+ \(capped\) commits/);
  });
});

describe('receive end to end', () => {
  const envFor = (cfg) => scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '' });
  const cfgRoot = () => {
    const root = tmpRoot('rcv-delta-');
    fs.mkdirSync(path.join(root, 'projects', 'c--GIT-demo', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', 'c--GIT-demo', 'memory', 'MEMORY.md'), '- i\n');
    return root;
  };
  const sleep = (ms) => { const t = Date.now() + ms; while (Date.now() < t); };

  it('a commit made after prepare is listed; one made before it is not; gh (no GitHub remote) prints UNMEASURED, not none', () => {
    const fx = makeFleetRepo();
    const cfg = cfgRoot();
    commitFile(fx.repo, 'before.txt', 'x\n', 'before-prepare commit');
    git(['push', '-q', 'origin', 'main'], fx.repo); // prepare refuses unpushed work
    sleep(1100);
    const p = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(cfg) });
    assert.equal(p.status, 0, p.stdout);
    sleep(1100);
    commitFile(fx.repo, 'after.txt', 'y\n', 'after-prepare commit');
    git(['push', '-q', 'origin', 'main'], fx.repo);
    const r = runFleet(['handover', 'receive', '--from', p.json.handover.json, '--json'], { cwd: fx.repo, env: envFor(cfg) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.json.text, /after-prepare commit/);
    assert.doesNotMatch(r.json.text, /before-prepare commit/);
    assert.match(r.json.text, /PRs: UNMEASURED/);
    const delta = r.json.handover.delta.find((d) => d.repo === fx.repo);
    assert.equal(delta.commits.items.length, 1);
    assert.equal(delta.prs.measured, false);
    assert.ok(r.json.handover.followUps.some((f) => f.kind === 'delta'));
  });
  it('a claim and a proposal made after prepare are listed', () => {
    const fx = makeFleetRepo();
    const cfg = cfgRoot();
    const p = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(cfg) });
    assert.equal(p.status, 0, p.stdout);
    sleep(50);
    assert.equal(runFleet(['claim', '--id', 'claude/late', '--intent', 'late work', '--paths', 'x/**'], { cwd: fx.repo, env: envFor(cfg) }).status, 0);
    assert.equal(runFleet(['propose', '--what', 'late finding', '--where', 'a.txt', '--why', 'because'], { cwd: fx.repo, env: envFor(cfg) }).status, 0);
    const r = runFleet(['handover', 'receive', '--from', p.json.handover.json, '--json'], { cwd: fx.repo, env: envFor(cfg) });
    const delta = r.json.handover.delta.find((d) => d.repo === fx.repo);
    assert.deepEqual(delta.claims.items.map((c) => c.id), ['claude/late']);
    assert.equal(delta.proposals.items.length, 1);
    assert.match(r.json.text, /late finding/);
  });
  it('--dry-run does not fetch: a commit pushed to origin meanwhile stays unseen and the text says as-of-last-fetch', () => {
    const fx = makeFleetRepo();
    const cfg = cfgRoot();
    const p = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(cfg) });
    sleep(1100);
    const other = path.join(fx.root, 'other');
    git(['clone', '-q', fx.origin, other], fx.root);
    git(['config', 'user.email', 't@example.com'], other); git(['config', 'user.name', 'T'], other);
    commitFile(other, 'o.txt', 'o\n', 'pushed-by-old-account'); git(['push', '-q', 'origin', 'HEAD:main'], other);
    const dry = runFleet(['handover', 'receive', '--from', p.json.handover.json, '--dry-run', '--json'], { cwd: fx.repo, env: envFor(cfg) });
    assert.doesNotMatch(dry.json.text, /pushed-by-old-account/);
    assert.match(dry.json.text, /as of the last fetch/);
    const real = runFleet(['handover', 'receive', '--from', p.json.handover.json, '--json'], { cwd: fx.repo, env: envFor(cfg) });
    assert.match(real.json.text, /pushed-by-old-account/);
  });
  it('a different account gets the sweep follow-up', () => {
    const fx = makeFleetRepo();
    const A = cfgRoot(); const B = cfgRoot();
    fs.writeFileSync(path.join(A, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'a', emailAddress: 'a@x.test', organizationUuid: 'o' } }));
    fs.writeFileSync(path.join(B, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'b', emailAddress: 'b@x.test', organizationUuid: 'o' } }));
    const p = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(A) });
    const r = runFleet(['handover', 'receive', '--from', p.json.handover.json, '--json'], { cwd: fx.repo, env: envFor(B) });
    const sw = r.json.handover.followUps.find((f) => f.kind === 'session-sweep');
    assert.ok(sw, r.stdout);
    assert.match(r.json.text, /stale-session sweep/);
  });
});
