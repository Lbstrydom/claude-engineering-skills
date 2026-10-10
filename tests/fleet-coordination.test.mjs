/**
 * @fileoverview /fleet — the coordination layer: `next`, directives, footers
 * (plan docs/plans/fleet-consumer-feedback-oct.md §2.4).
 *
 * The problem it answers: host messages are held across permission modes, and a
 * delivered peer message is (correctly) untrusted, so sessions second-guess the
 * coordinator. Pinned here: obligations are derived from facts the recipient can
 * re-check; a directive is VERIFIED only when fleet derives the same action for
 * THAT recipient; facts outrank directives.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { deriveObligations, renderObligations, verifyDirective } from '../scripts/lib/fleet/obligations.mjs';
import {
  cleanupFleetRoots, commitFile, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv, writeFile,
} from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const NOW = new Date('2026-10-09T12:00:00Z');
const HOLD_AT = '2026-10-09T11:00:00.000Z';
const OID = (c) => c.repeat(40);
const item = (over = {}) => ({ id: 'feat', branch: 'feat', merged: null, readyStale: false, overlaps: [], notes: [], ...over });
const session = (over = {}) => ({ id: 'feat', source: { branch: 'feat' }, leaseExpiresAt: '2026-10-09T16:00:00Z', ...over });
const dir = (over) => ({ id: 'd-20261009110000-0001', to: 'feat', by: 'main', createdAt: '2026-10-09T11:00:00Z', expiresAt: '2026-10-10T11:00:00Z', acks: [], ...over });
const advance = (commits) => ({ queried: true, complete: true, commits });

describe('deriveObligations — from facts only', () => {
  it('own PR merged → DO archive-check then release', () => {
    const r = deriveObligations({ item: item({ merged: { merged: true, via: 'pr', pr: 7, commit: OID('a') } }), session: session(), now: NOW });
    assert.equal(r.obligations[0].kind, 'merged');
    assert.match(renderObligations(r)[0], /^DO .*PR #7 merged.*→ fleet archive-check$/);
  });
  it('base gained a commit touching my files → restack, naming the PR; one touching only other files → nothing (control)', () => {
    const adv = advance([{ oid: OID('b'), subject: 'x (#9)', pr: 9, files: ['a.txt', 'z.txt'] }, { oid: OID('c'), subject: 'y', pr: null, files: ['other.txt'] }]);
    const r = deriveObligations({ item: item(), session: session(), advance: adv, myFiles: ['a.txt'], now: NOW });
    const o = r.obligations.find((x) => x.kind === 'base-advanced');
    assert.deepEqual([o.evidence.prs, o.evidence.files, o.command], [[9], ['a.txt'], ['fleet', 'restack', 'feat']]);
    assert.equal(deriveObligations({ item: item(), session: session(), advance: adv, myFiles: ['q.txt'], now: NOW }).obligations.length, 0);
  });
  it('hold on, stale ready, lapsing lease all surface; an unmeasured base advance is info, not silence', () => {
    const r = deriveObligations({
      item: item({ readyStale: true }), session: session({ leaseExpiresAt: '2026-10-09T12:10:00Z' }), hold: { held: true, by: 'main', reason: 'CI busy', at: HOLD_AT },
      advance: { queried: false, reason: 'no merge-base' }, now: NOW,
    });
    const kinds = r.obligations.map((o) => o.kind);
    for (const k of ['ready-stale', 'hold', 'lease', 'base-advanced-unmeasured']) assert.ok(kinds.includes(k), k);
    assert.equal(r.obligations.at(-1).act, 'info', 'info sorts last');
  });
  it('directives not fully read are disclosed, never "no directives"', () => {
    const r = deriveObligations({ item: item(), session: session(), directives: { active: [], complete: false, reason: 'more than 200' }, now: NOW });
    assert.match(r.notes[0], /not fully read/);
  });
});

describe('obligations — review fixes (C2-R1)', () => {
  it('a branch name is rendered as data, never shell syntax (H3/H5)', () => {
    const r = deriveObligations({ item: item({ branch: 'feat;id', merged: { merged: 'partially', via: 'pr', pr: 3, extraCommits: 1 } }), session: session(), now: NOW });
    const line = renderObligations(r, { cmd: 'node scripts/fleet.mjs' })[0];
    assert.match(line, /node scripts\/fleet\.mjs restack '?feat;id'?$/);
    assert.doesNotMatch(line, / feat;id$/, 'quoted, not bare');
  });
  it('a hold survives footer truncation (M3)', () => {
    const adv = advance([{ oid: OID('b'), pr: 9, files: ['a.txt'] }]);
    const r = deriveObligations({
      item: item({ readyStale: true, merged: null }), session: session({ leaseExpiresAt: '2026-10-09T12:05:00Z' }), advance: adv, myFiles: ['a.txt'],
      hold: { held: true, at: HOLD_AT, reason: 'CI busy' }, now: NOW,
    });
    assert.equal(r.obligations[0].kind, 'hold');
    assert.match(renderObligations(r, { limit: 3 }).join('\n'), /HOLD/);
  });
  it('a terminal session is never told to renew its lease (M6)', () => {
    const r = deriveObligations({ item: item(), session: session({ state: 'done', leaseExpiresAt: '2026-10-08T00:00:00Z' }), now: NOW });
    assert.equal(r.obligations.some((o) => o.kind === 'lease'), false);
  });
  it('unknown changed files are disclosed, never read as "nothing touches you" (M2/M8)', () => {
    const r = deriveObligations({ item: item(), session: session(), advance: advance([]), filesUnknown: ['uncommitted files: probe deadline reached'], now: NOW });
    assert.match(r.obligations.find((o) => o.kind === 'base-advanced-unmeasured').text, /not fully known/);
  });
  it('dirty / uninspected worktree read from structured state, not note wording (M14)', () => {
    const merged = { merged: true, via: 'pr', pr: 7, commit: OID('a') };
    assert.match(deriveObligations({ item: item({ merged, workRemaining: true, notes: [] }), session: session(), now: NOW }).obligations[0].text, /still holds work/);
    assert.match(deriveObligations({ item: item({ merged, workRemaining: null, notes: [] }), session: session(), now: NOW }).obligations[0].text, /not inspected/);
  });
  it('a rebase citing a PR must be the partial-merge evidence too (M11)', () => {
    const ob = [{ kind: 'partially-merged', act: 'do', text: 'p', evidence: { pr: 5 } }];
    assert.equal(verifyDirective(dir({ kind: 'rebase', reason: { kind: 'pr-merged', ref: '#5' } }), { obligations: ob }).status, 'verified');
    assert.equal(verifyDirective(dir({ kind: 'rebase', reason: { kind: 'pr-merged', ref: '#6' } }), { obligations: ob }).status, 'unverified');
  });
});

describe('verifyDirective — corroborated, never "the cited record exists" (audit H4)', () => {
  const merged = { merged: true, via: 'pr', pr: 7, commit: OID('a') };
  const ob = (kind, evidence = {}) => [{ kind, act: 'do', text: kind, evidence }];
  it('release citing MY merged PR → verified; citing an unrelated merged PR → unverified', () => {
    assert.equal(verifyDirective(dir({ kind: 'release', reason: { kind: 'pr-merged', ref: '#7' } }), { obligations: ob('merged'), merged }).status, 'verified');
    assert.equal(verifyDirective(dir({ kind: 'release', reason: { kind: 'pr-merged', ref: '#8' } }), { obligations: ob('merged'), merged }).status, 'unverified');
    assert.equal(verifyDirective(dir({ kind: 'release', reason: { kind: 'pr-merged', ref: '#7' } }), { obligations: [], merged: null }).status, 'unverified', 'no merged evidence of my own');
  });
  it('a squash-merged release is verified through the base commit\'s (#N)', () => {
    const sq = { merged: true, via: 'squash', commit: OID('c') };
    const adv = advance([{ oid: OID('c'), pr: 7, files: [] }]);
    assert.equal(verifyDirective(dir({ kind: 'release', reason: { kind: 'pr-merged', ref: '#7' } }), { obligations: ob('merged'), merged: sq, advance: adv }).status, 'verified');
  });
  it('rebase needs a base change touching my files, and a cited PR must be among them', () => {
    const o = ob('base-advanced', { prs: [9] });
    assert.equal(verifyDirective(dir({ kind: 'rebase', reason: { kind: 'pr-merged', ref: '#9' } }), { obligations: o }).status, 'verified');
    assert.equal(verifyDirective(dir({ kind: 'rebase', reason: { kind: 'pr-merged', ref: '#3' } }), { obligations: o }).status, 'unverified');
    assert.equal(verifyDirective(dir({ kind: 'rebase', reason: { kind: 'pr-merged', ref: '#9' } }), { obligations: [] }).status, 'unverified');
  });
  it('pause/resume bind to ONE hold event; facts outrank directives', () => {
    const on = { held: true, at: HOLD_AT }; const off = { held: false, at: '2026-10-09T11:30:00.000Z' };
    const pause = dir({ kind: 'pause', reason: { kind: 'hold', ref: HOLD_AT } });
    assert.equal(verifyDirective(pause, { hold: on }).status, 'verified');
    assert.equal(verifyDirective(pause, { hold: off }).status, 'superseded', 'a pause after the hold was released');
    assert.equal(verifyDirective(pause, { hold: { held: true, at: '2026-10-09T11:45:00.000Z' } }).status, 'superseded', 'a newer hold event');
    const resume = dir({ kind: 'resume', reason: { kind: 'hold', ref: off.at } });
    assert.equal(verifyDirective(resume, { hold: off }).status, 'verified');
    assert.equal(verifyDirective(resume, { hold: on }).status, 'superseded', 'a resume while the hold is on');
  });
  it('a note is never verified — it routes to the user', () => {
    assert.equal(verifyDirective(dir({ kind: 'rerun-ready', reason: { kind: 'note', note: 'trust me' } }), { obligations: ob('ready-stale') }).status, 'unverified');
  });
  it('to:"all" — verified for one recipient, unverified for another', () => {
    const d = dir({ to: 'all', kind: 'rerun-ready', reason: { kind: 'train', ref: 't-20261009120000-abcd' } });
    const a = deriveObligations({ item: item({ id: 'a', readyStale: true }), session: session({ id: 'a' }), directives: { active: [d], complete: true }, now: NOW });
    const b = deriveObligations({ item: item({ id: 'b' }), session: session({ id: 'b' }), directives: { active: [d], complete: true }, now: NOW });
    assert.equal(a.directives[0].status, 'verified');
    assert.equal(b.directives[0].status, 'unverified');
    assert.equal(b.obligations.find((o) => o.kind === 'directive').act, 'ask');
  });
});

describe('CLI — next, directives, footers, hold events, host ids', () => {
  const setup = () => {
    const fx = makeFleetRepo();
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
    const f = (args, cwd = fx.repo) => runFleet(args, { cwd, env });
    const chip = (name, paths, extra = []) => {
      const wt = path.join(fx.root, `wt-${name}`);
      git(['worktree', 'add', '-q', '-b', name, wt, 'main'], fx.repo);
      const c = f(['claim', '--intent', `work on ${name}`, '--paths', paths, ...extra], wt);
      assert.equal(c.status, 0, c.stdout + c.stderr);
      return { wt, claim: c };
    };
    return { fx, fake, f, chip };
  };

  it('a base commit touching my files shows up as a DO restack in next AND in the touch footer — no status run needed', () => {
    const s = setup();
    const { wt } = s.chip('mine', 'a.txt');
    commitFile(wt, 'a.txt', 'mine\n');
    commitFile(s.fx.repo, 'a.txt', 'theirs (#77)\n', 'theirs (#77)');
    const n = s.f(['next', '--json'], wt);
    assert.equal(n.status, 0, n.stdout + n.stderr);
    const o = n.json.obligations.find((x) => x.kind === 'base-advanced');
    assert.deepEqual(o.evidence.prs, [77]);
    const t = s.f(['touch'], wt);
    assert.match(t.stdout, /next: DO +base gained 1 commit\(s\) touching your files.*restack mine/);
    assert.doesNotMatch(t.stdout, /→ fleet restack/, 'commands are printed as the CLI is really invoked');
  });

  it('hold on --notify posts a VERIFIED pause; hold off --note supersedes it with a VERIFIED resume', () => {
    const s = setup();
    const { wt } = s.chip('worker', 'b.txt');
    const on = s.f(['hold', 'on', '--reason', 'CI busy', '--notify', '--json']);
    assert.equal(on.status, 0, on.stdout + on.stderr);
    assert.equal(on.json.directive.kind, 'pause');
    let n = s.f(['next', '--json'], wt).json;
    assert.equal(n.directives.find((d) => d.kind === 'pause').status, 'verified');
    assert.ok(n.obligations.some((x) => x.kind === 'hold'));
    const off = s.f(['hold', 'off', '--note', 'rebase onto main: then continue', '--json']);
    assert.equal(off.json.hold.at, off.json.directive.reason.ref, 'the resume cites exactly this hold event');
    n = s.f(['next', '--json'], wt).json;
    assert.equal(n.directives.find((d) => d.kind === 'resume').status, 'verified');
    assert.equal(n.directives.find((d) => d.kind === 'pause').status, 'superseded');
  });

  it('directive create / list / ack; merge is not a kind; a dead recipient is refused', () => {
    const s = setup();
    const { wt } = s.chip('r1', 'c.txt');
    assert.equal(s.f(['directive', '--to', 'r1', '--kind', 'merge', '--reason', 'note', '--note', 'x']).status, 2);
    assert.equal(s.f(['directive', '--to', 'ghost', '--kind', 'rebase', '--reason', 'note', '--note', 'x']).status, 3);
    const c = s.f(['directive', '--to', 'r1', '--kind', 'rerun-ready', '--reason', 'note', '--note', 'please: re-run', '--json']);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    const id = c.json.directive.id;
    const n = s.f(['next', '--json'], wt).json;
    assert.equal(n.directives[0].status, 'unverified', 'a note is never verified');
    assert.equal(n.obligations.find((x) => x.kind === 'directive').act, 'ask');
    const a = s.f(['directive', '--ack', id, '--outcome', 'declined', '--note', 'user said no', '--json'], wt);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    const l = s.f(['directive', '--list', '--all', '--json']).json;
    assert.equal(l.active.length, 0, 'answered → archived');
    assert.equal(l.archived[0].acks[0].outcome, 'declined');
  });

  it('claim --host-session records the host id; status prints it', () => {
    const s = setup();
    s.chip('hosted', 'd.txt', ['--host-session', 'local_9f72abc']);
    const st = s.f(['status']);
    assert.match(st.stdout, /host: local_9f72abc/);
    assert.equal(s.f(['status', '--json']).json.status.hosts.hosted, 'local_9f72abc');
  });

  it('an invalid directive record is shown in status, never silently dropped (C2-R2-M1/M2)', () => {
    const s = setup();
    const act = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], s.fx.repo), 'fleet', 'directives', 'active');
    fs.mkdirSync(act, { recursive: true });
    fs.writeFileSync(path.join(act, 'd-20261009120000-dead.json'), '{"truncated":');
    const st = s.f(['status']);
    assert.match(st.stdout, /directives: invalid record d-20261009120000-dead\.json/);
    assert.equal(s.f(['status', '--json']).json.status.directives.invalid.length, 1);
  });

  it('a footer that cannot be derived never fails the verb', () => {
    const s = setup();
    const { wt } = s.chip('plain', 'e.txt');
    const r = s.f(['ready', '--json'], wt);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(Array.isArray(r.json.next));
  });
});
