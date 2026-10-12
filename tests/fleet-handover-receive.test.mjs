/**
 * @fileoverview Phase 7 of docs/plans/fleet-unclaimed-work-and-switch-friction.md: the pre-switch gate (r), receive
 * outcome classes (p), whitelisted account identity (o), the scheduled-task line (q), claims waiting on the switch
 * (s) and per-repo memory destination lines (t). Every "does not" case has a control that fires the other way.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { accountIdentity, cliCommand, compareIdentity, normaliseWaitRef, SWITCH_TOKEN } from '../scripts/lib/fleet/handover.mjs';
import { receiveCommand } from '../scripts/lib/fleet/handover-render.mjs';

after(cleanupFleetRoots);

const SLUG = 'c--GIT-demo';
const envFor = (cfg) => scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '' });
const memFile = (cfg, rel, slug = SLUG) => path.join(cfg, 'projects', slug, 'memory', ...rel.split('/'));

/** A config root: memory, optional scheduled task, settings.json, and an optional .claude.json. */
function account(root, { task = 'weekly-check', settings = '{"permissions":{}}\n', claude = undefined, slug = SLUG } = {}) {
  for (const [rel, body] of Object.entries({ 'MEMORY.md': '- index\n', 'a.md': 'alpha\n' })) {
    fs.mkdirSync(path.dirname(memFile(root, rel, slug)), { recursive: true });
    fs.writeFileSync(memFile(root, rel, slug), body);
  }
  if (task) {
    fs.mkdirSync(path.join(root, 'scheduled-tasks', task), { recursive: true });
    fs.writeFileSync(path.join(root, 'scheduled-tasks', task, 'SKILL.md'), `---\nname: ${task}\ndescription: Weekly check\n---\nrun it\n`);
  }
  fs.writeFileSync(path.join(root, 'settings.json'), settings);
  if (claude !== undefined) fs.writeFileSync(path.join(root, '.claude.json'), typeof claude === 'string' ? claude : JSON.stringify(claude));
  return root;
}
const who = (email, uuid, mcp = {}) => ({ oauthAccount: { accountUuid: uuid, emailAddress: email, organizationUuid: 'org-1' }, mcpServers: mcp });
const run = (fx, cfg, args) => runFleet([...args, '--json'], { cwd: fx.repo, env: envFor(cfg) });
const prepare = (fx, cfg, extra = ['--scheduler-checked']) => run(fx, cfg, ['handover', 'prepare', ...extra]);
const receive = (fx, cfg, json, extra = []) => run(fx, cfg, ['handover', 'receive', '--from', json, ...extra]);

describe('pre-switch gate (r)', () => {
  it('a listed task with no --scheduler-checked: exit 3 naming the step, artefacts written, BEFORE YOU RELAUNCH first in text and markdown', () => {
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-gate-'));
    const r = prepare(fx, A, []);
    assert.equal(r.status, 3, r.stdout);
    assert.equal(r.json.reason, 'not ready: scheduler step unconfirmed');
    assert.ok(fs.existsSync(r.json.handover.json) && fs.existsSync(r.json.handover.md), 'artefacts still written');
    assert.match(r.json.text, /^BEFORE YOU RELAUNCH/);
    const md = fs.readFileSync(r.json.handover.md, 'utf8').split('\n');
    assert.equal(md.find((l) => l.startsWith('## ')), '## BEFORE YOU RELAUNCH', 'the first section of the markdown');
  });
  it('controls: the same with --scheduler-checked is exit 0; no tasks and no flag is exit 0 with no block', () => {
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-gate-ok-'));
    const r = prepare(fx, A);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.json.text, /confirmed with --scheduler-checked/);
    const none = prepare(makeFleetRepo(), account(tmpRoot('rcv-gate-none-'), { task: null }), []);
    assert.equal(none.status, 0, none.stdout);
    assert.doesNotMatch(none.json.text, /BEFORE YOU RELAUNCH/);
  });
  it('blocking unregistered work and the scheduler step together: both reasons are named', () => {
    const fx = makeFleetRepo();
    const wt = path.join(tmpRoot('rcv-gate-wt-'), 'dirty');
    git(['worktree', 'add', '-q', '-b', 'dirty', wt, 'main'], fx.repo);
    fs.writeFileSync(path.join(wt, 'unsaved.txt'), 'only here\n');
    const r = prepare(fx, account(tmpRoot('rcv-gate-both-')), []);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /worktrees hold unregistered work/);
    assert.match(r.json.reason, /not ready: scheduler step unconfirmed/);
  });
  it('--scheduler-checked on receive is an argv error (exit 2)', () => {
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-gate-argv-'));
    const p = prepare(fx, A);
    assert.equal(receive(fx, A, p.json.handover.json, ['--scheduler-checked']).status, 2);
  });
});

describe('receive outcome classes (p): failed > refused > ok with follow-ups', () => {
  // Source: account a@x with MCP server "alpha"; destination: account b@x with "beta", a different settings.json, no
  // copy of the task, and an origin whose PR state cannot be read (no gh on PATH). Every one of those is a follow-up.
  const followUpOnly = () => {
    const fx = makeFleetRepo();
    git(['remote', 'set-url', 'origin', 'https://github.com/owner-x/repo-y.git'], fx.repo);
    const A = account(tmpRoot('rcv-src-'), { claude: who('a@x.test', 'uuid-a', { alpha: { command: 'a' } }) });
    const B = account(tmpRoot('rcv-dst-'), { task: null, settings: '{"permissions":{"allow":["x"]}}\n', claude: who('b@x.test', 'uuid-b', { beta: { command: 'b' } }) });
    fs.rmSync(path.join(B, 'projects'), { recursive: true, force: true }); // nothing to conflict with
    const p = prepare(fx, A);
    assert.equal(p.status, 0, p.stdout);
    return { fx, A, B, json: p.json.handover.json };
  };

  it('only follow-ups: ok, exit 0, followUps listed — for a real run and for --dry-run', () => {
    const { fx, B, json } = followUpOnly();
    for (const extra of [['--dry-run'], []]) {
      const r = receive(fx, B, json, extra);
      assert.equal(r.status, 0, `${extra}: ${r.stdout}`);
      assert.equal(r.json.ok, true);
      const kinds = r.json.handover.followUps.map((x) => x.kind).sort();
      assert.deepEqual(kinds, ['account', 'gh', 'mcp', 'scheduled-tasks', 'settings']);
      assert.match(r.json.text, /follow-ups \(not failures\):/);
    }
  });
  it('the same plus one memory conflict: refused, exit 3, follow-ups still carried', () => {
    const { fx, B, json } = followUpOnly();
    fs.mkdirSync(path.dirname(memFile(B, 'a.md')), { recursive: true });
    fs.writeFileSync(memFile(B, 'a.md'), 'mine\n');
    const r = receive(fx, B, json);
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.json.reason, /1 memory conflict\(s\) \(plus 5 follow-up\(s\)\)/);
  });
  it('the same plus a conflict AND an unsafe destination: failed, exit 1, outranking both', () => {
    const { fx, B, json } = followUpOnly();
    fs.mkdirSync(path.dirname(memFile(B, 'a.md')), { recursive: true });
    fs.writeFileSync(memFile(B, 'a.md'), 'mine\n');
    const outside = tmpRoot('rcv-outside-');
    const sub = path.join(path.dirname(memFile(B, 'a.md')), 'sub');
    fs.symlinkSync(outside, sub, 'junction');
    // a manifest file under sub/ makes the copy target land below the junction
    const m = JSON.parse(fs.readFileSync(json, 'utf8'));
    m.memory[0].files.push({ rel: 'sub/c.md', sha256: 'a'.repeat(64), bytes: 1 });
    const forged = json.replace(/\.json$/, '-sub.json');
    fs.writeFileSync(forged, JSON.stringify(m));
    const r = receive(fx, B, forged, ['--allow-older']);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json.code, 'error', 'the failed class (exit 1)');
    assert.ok(r.json.handover.files.some((x) => x.outcome === 'unsafe-destination'));
    assert.equal(r.json.handover.summary.conflicts, 1, 'the conflict is still there, outranked');
    assert.equal(fs.readdirSync(outside).length, 0, 'nothing landed outside');
  });
  it('control: changed-since-prepare alone stays exit 0 and is only counted', () => {
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-changed-'), { task: null });
    const p = prepare(fx, A, []);
    fs.writeFileSync(memFile(A, 'a.md'), 'alpha v2\n');
    const r = receive(fx, A, p.json.handover.json);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.json.handover.summary.changedSincePrepare, 1);
  });
});

describe('account identity (o)', () => {
  it('a fake accessToken and an unrelated key never reach the manifest or the markdown; the whitelisted keys do (control)', () => {
    const fx = makeFleetRepo();
    const claude = { ...who('me@x.test', 'uuid-me', { srv: { command: 'x', env: { API_KEY: 'MCP-SECRET-VALUE-77' } } }), accessToken: 'sk-FAKE-TOKEN-0123456789', unrelatedKey: 'UNRELATED-VALUE-xyz',
      projects: { 'C:/proj/one': { mcpServers: { projsrv: { command: 'p' } }, history: ['PRIVATE-HISTORY'] }, 'C:/proj/none': { mcpServers: {} } } };
    const p = prepare(fx, account(tmpRoot('rcv-id-'), { claude }));
    const json = fs.readFileSync(p.json.handover.json, 'utf8'); const md = fs.readFileSync(p.json.handover.md, 'utf8');
    for (const secret of ['sk-FAKE-TOKEN-0123456789', 'UNRELATED-VALUE-xyz', 'MCP-SECRET-VALUE-77', 'PRIVATE-HISTORY', 'accessToken', 'unrelatedKey']) {
      assert.ok(!json.includes(secret), `manifest leaks ${secret}`);
      assert.ok(!md.includes(secret), `markdown leaks ${secret}`);
    }
    for (const kept of ['me@x.test', 'uuid-me', 'org-1', 'srv', 'projsrv']) { assert.ok(json.includes(kept), `manifest lacks ${kept}`); assert.ok(md.includes(kept), `markdown lacks ${kept}`); }
    assert.ok(!json.includes('C:/proj/none'), 'a project with no MCP servers is omitted');
    const claudeEntry = JSON.parse(json).settings.find((s) => s.name === '.claude.json');
    assert.deepEqual([claudeEntry.sha256, claudeEntry.volatile], [null, true], 'no hash for the volatile file');
  });
  it('same account reads "same account"; a different one prints both addresses', () => {
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-same-'), { task: null, claude: who('me@x.test', 'uuid-me') });
    const p = prepare(fx, A, []);
    const same = receive(fx, A, p.json.handover.json);
    assert.match(same.json.text, /account: same account/);
    assert.ok(!same.json.handover.followUps.some((x) => x.kind === 'account'));
    const B = account(tmpRoot('rcv-other-'), { task: null, claude: who('you@x.test', 'uuid-you') });
    fs.rmSync(path.join(B, 'projects'), { recursive: true, force: true });
    const diff = receive(fx, B, p.json.handover.json);
    assert.match(diff.json.text, /account: source me@x\.test → this you@x\.test \(different account\)/);
    assert.equal(diff.status, 0, 'an account change is a follow-up');
  });
  it('a .claude.json without oauthAccount, or unparseable, is an unknown account — a follow-up, never a throw', () => {
    assert.equal(accountIdentity(path.join(tmpRoot('rcv-none-'), 'absent.json')).account, null);
    const dir = tmpRoot('rcv-bad-');
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    assert.match(accountIdentity(path.join(dir, 'bad.json')).reason, /unreadable/);
    fs.writeFileSync(path.join(dir, 'noacct.json'), JSON.stringify({ mcpServers: { s: {} } }));
    const noAcct = accountIdentity(path.join(dir, 'noacct.json'));
    assert.equal(noAcct.account, null);
    assert.deepEqual(noAcct.mcp.global, ['s']);
    assert.equal(compareIdentity(noAcct, accountIdentity(path.join(dir, 'noacct.json'))).account.status, 'unknown', 'never "same" without an id');
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-unk-'), { task: null, claude: '{ not json' });
    const p = prepare(fx, A, []);
    assert.equal(p.status, 0, p.stdout);
    const r = receive(fx, A, p.json.handover.json);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(r.json.handover.followUps.some((x) => x.kind === 'account' && /not compared/.test(x.detail)));
  });
  it('MCP servers added and removed are listed by name', () => {
    const c = compareIdentity({ account: null, mcp: { global: ['a', 'b'], projects: [{ path: 'P', names: ['p1'] }] } }, { account: null, mcp: { global: ['b', 'c'], projects: [] } });
    assert.deepEqual(c.mcp, { added: ['c'], removed: ['a', 'p1 (P)'] });
  });
  it('a manifest written before identity (a .claude.json hash, no identity) still receives; the hash is ignored', () => {
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-legacy-'), { task: null, claude: who('me@x.test', 'uuid-me') });
    const p = prepare(fx, A, []);
    const m = JSON.parse(fs.readFileSync(p.json.handover.json, 'utf8'));
    delete m.identity; delete m.schedulerChecked;
    m.settings = m.settings.map((s) => { const { volatile, ...rest } = s; void volatile; return s.name === '.claude.json' ? { ...rest, sha256: 'f'.repeat(64) } : rest; });
    const legacy = p.json.handover.json.replace(/\.json$/, '-legacy.json');
    fs.writeFileSync(legacy, JSON.stringify(m));
    const r = receive(fx, A, legacy, ['--allow-older']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.json.handover.settings.find((s) => s.name === '.claude.json').status, 'by-identity');
    assert.match(r.json.text, /account: unknown \(not recorded at prepare/);
  });
});

describe('the scheduled-task line (q) and memory destinations (t)', () => {
  it('the task line says what it checked: files, never registration', () => {
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-q-'));
    const p = prepare(fx, A);
    assert.match(receive(fx, A, p.json.handover.json).json.text, /scheduled tasks: 1 file\(s\) present; scheduler registration not checked here/);
    const B = account(tmpRoot('rcv-q2-'), { task: null });
    fs.rmSync(path.join(B, 'projects'), { recursive: true, force: true });
    assert.match(receive(fx, B, p.json.handover.json).json.text, /scheduled tasks: 0 file\(s\) present, 1 missing here; scheduler registration not checked here/);
  });
  it('one memory line per dir in same-root AND copy mode; copy mode uses the destination\'s on-disk spelling on win32', () => {
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-t-'), { task: null });
    const p = prepare(fx, A, []);
    assert.match(receive(fx, A, p.json.handover.json).json.text, new RegExp(`memory ${SLUG} → .*projects[\\\\/]${SLUG}[\\\\/]memory`));
    const B = account(tmpRoot('rcv-t2-'), { task: null, slug: 'C--GIT-demo' }); // the destination spells the drive letter upper-case
    fs.rmSync(memFile(B, 'a.md', 'C--GIT-demo'));
    const r = receive(fx, B, p.json.handover.json);
    const want = process.platform === 'win32' ? 'C--GIT-demo' : SLUG;
    assert.match(r.json.text, new RegExp(`memory ${SLUG} → .*projects[\\\\/]${want}[\\\\/]memory`));
  });
});

describe('the pasteable receive command', () => {
  it('a manifest path with shell-active characters is quoted by the one renderer, never inside bare double quotes', () => {
    const json = '/tmp/repo $(touch pwned) `id`/.git/fleet/handover/handover-x.json';
    const posix = receiveCommand('node scripts/fleet.mjs', json, 'linux');
    assert.equal(posix, `node scripts/fleet.mjs handover receive --from '${json}'`, 'single-quoted: no expansion');
    assert.ok(!posix.includes(`"${json}"`));
    const plain = receiveCommand('node scripts/fleet.mjs', '/tmp/plain/handover-x.json', 'linux');
    assert.equal(plain, 'node scripts/fleet.mjs handover receive --from /tmp/plain/handover-x.json', 'control: a plain path needs no quoting');
  });
  it('an already-rendered command prefix (a quoted CLI path with spaces) is kept intact, never re-split', () => {
    const prefix = "node '/home/a b/repo/scripts/fleet.mjs'";
    assert.equal(receiveCommand(prefix, '/tmp/h.json', 'linux'), `${prefix} handover receive --from /tmp/h.json`);
    // the release and unblock commands use the same prefix rule
    const touch = cliCommand(prefix, ['touch', '--id', 'w x', '--clear-waiting']);
    assert.ok(touch.startsWith(`${prefix} touch --id `), touch);
    assert.ok(!touch.includes("'/home/a' "), 'the prefix was not re-split at its space');
  });
});

describe('claims waiting on the switch (s)', () => {
  it('the documented token in any spelling is listed with the clear command; human:ci is only a note line', () => {
    assert.equal(SWITCH_TOKEN, 'account-switch');
    for (const ref of ['account switch', 'account-switch', 'Account_Switch', '  ACCOUNT  -_ switch ']) assert.equal(normaliseWaitRef(ref), 'account-switch', ref);
    assert.notEqual(normaliseWaitRef('ci'), 'account-switch');
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-s-'), { task: null });
    const env = envFor(A);
    const claimWait = (id, ref) => {
      const wt = path.join(tmpRoot(`rcv-s-${id}-`), id);
      git(['worktree', 'add', '-q', '-b', id, wt, 'main'], fx.repo);
      const r = runFleet(['claim', '--intent', id, '--paths', `${id}.txt`, '--waiting-on', `human:${ref}`], { cwd: wt, env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    };
    claimWait('w-space', 'account switch');
    claimWait('w-dash', 'account-switch');
    claimWait('w-mixed', 'Account_Switch');
    claimWait('w-ci', 'ci');
    const p = prepare(fx, A, []);
    const r = receive(fx, A, p.json.handover.json);
    const onSwitch = r.json.handover.followUps.filter((x) => x.kind === 'waiting-on-switch');
    assert.deepEqual(onSwitch.map((x) => x.detail.split(' ')[0]).sort(), ['w-dash', 'w-mixed', 'w-space']);
    assert.ok(onSwitch.every((x) => /touch --id \S+ --clear-waiting/.test(x.detail)));
    assert.match(r.json.text, /note: w-ci \(.*\) waits on human:ci — not the human:account-switch token/);
    assert.ok(!onSwitch.some((x) => x.detail.startsWith('w-ci')));
  });
  it('a claim waiting on the switch AND something else: the command clears only the switch wait (it re-adds the rest)', () => {
    const fx = makeFleetRepo();
    const A = account(tmpRoot('rcv-s2-'), { task: null });
    const env = envFor(A);
    const wt = path.join(tmpRoot('rcv-s2-wt-'), 'w-both');
    git(['worktree', 'add', '-q', '-b', 'w-both', wt, 'main'], fx.repo);
    assert.equal(runFleet(['claim', '--intent', 'b', '--paths', 'b.txt', '--waiting-on', 'human:account-switch', '--waiting-on', 'ci:build-7:nightly'], { cwd: wt, env }).status, 0);
    const p = prepare(fx, A, []);
    const f = receive(fx, A, p.json.handover.json).json.handover.followUps.find((x) => x.kind === 'waiting-on-switch');
    assert.match(f.detail, /touch --id w-both --clear-waiting --waiting-on ci:build-7:nightly/);
    assert.match(f.detail, /re-adds its 1 other wait/);
    // running exactly those arguments leaves only the other wait
    assert.equal(runFleet(['touch', '--id', 'w-both', '--clear-waiting', '--waiting-on', 'ci:build-7:nightly'], { cwd: wt, env }).status, 0);
    const st = runFleet(['status', '--json'], { cwd: fx.repo, env }).json;
    const s = (st.items ?? st.status?.items ?? []).find((i) => i.id === 'w-both');
    assert.deepEqual((s?.waitingOn ?? []).map((w) => `${w.kind}:${w.ref}`), ['ci:build-7']);
  });
});
