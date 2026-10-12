/**
 * @fileoverview /fleet CLI — regressions pinned by audit rounds 2, 4 and 6 (lease
 * floor, PowerShell quoting, start baseline, entry guard, rendered commands, the
 * one evidence predicate, the async runner lifecycle). Split from
 * tests/fleet-cli.test.mjs for wall time; harness: tests/helpers/fleet-cli-harness.mjs.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './helpers/git.mjs';
import {
  FLEET_CLI, addBranch, cleanupFleetRoots, commitFile, prRow, runFleetAsync, scrubbedEnv, tmpRoot, writeFile,
} from './helpers/fleet-repo.mjs';
import { fleetDirOf, readyBranch, sessionFiles, sessionRec, setup } from './helpers/fleet-cli-harness.mjs';
import { startOidFor } from '../scripts/lib/fleet/commands.mjs';
import { SessionSchema, writeSession } from '../scripts/lib/fleet/registry.mjs';
import { quoteArg, renderCommand } from '../scripts/lib/fleet/shell-quote.mjs';
import {
  renderApprove, renderBuilt, renderChipPrompt, renderDryRun, renderOpenTrains, renderParticipantRules, renderReconcile,
} from '../scripts/lib/fleet/render-train.mjs';
import { leaseMsFrom, needsEvidenceKey } from '../scripts/lib/fleet/facts.mjs';

after(cleanupFleetRoots);

// ───────────────────────────────────────────────────────────────────────────
// Audit round 2
describe('round 2: lease floor, PowerShell quoting, start baseline, PR evidence, scrubbed env, base name', () => {
  it('H1: a lease under one minute is rejected on the CONVERTED value; 0.017h is accepted', () => {
    for (const bad of ['0.00000001', '0.0166', '0.0001']) {
      assert.throws(() => leaseMsFrom({ FLEET_LEASE_HOURS: bad }), (e) => e.name === 'ConfigError' && /at least 1 minute/.test(e.message), bad);
    }
    assert.equal(leaseMsFrom({ FLEET_LEASE_HOURS: '0.017' }), 61_200);
    const s = setup();
    const r = s.f(['status'], { env: { FLEET_LEASE_HOURS: '0.00000001' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FLEET_LEASE_HOURS/);
  });

  it('H2: on Windows only [A-Za-z0-9_./\\\\:-] stays bare; a leading @ (splatting) and + = , ~ # % are quoted', () => {
    assert.equal(renderCommand(['node', 'scripts/fleet.mjs', 'start', '--task', '@work'], 'win32'), "node scripts/fleet.mjs start --task '@work'");
    for (const a of ['@x', 'a@b', '+x', 'a=b', 'a,b', '~', '#x', '%x', 'a b', "a'b"]) assert.match(quoteArg(a, 'win32'), /^'.*'$/, a);
    for (const a of ['plain', 'a/b.mjs', 'C:\\x\\y-1.mjs', '--flag', 'a_b:c']) assert.equal(quoteArg(a, 'win32'), a);
    assert.equal(quoteArg('@work', 'linux'), '@work', 'POSIX behaviour unchanged');
  });

  describe('H3: a baseline that cannot be established is reported, never substituted', () => {
    const ctx = { cwd: '/x', config: { baseBranch: 'main' } };
    const fake = (table) => (args) => {
      if (args[0] === 'rev-parse') return table[args[3].replace(/\^\{commit\}$/, '')] ?? { ok: true, status: 0, stdout: `${'a'.repeat(40)}\n` };
      return table.mergeBase;
    };
    // The base arrives MEASURED (`resolveMeasurementBase`, which keeps "absent" and "git failed" apart).
    const measured = { ok: true, oid: 'b'.repeat(40), ref: 'main', source: 'local', relation: 'same', behindBy: 0 };
    it('unit: each failure kind is distinguished', () => {
      assert.equal(startOidFor(ctx, 'b', { ok: false, kind: 'base-unresolvable', reason: 'x' }, { git: fake({}) }).kind, 'base-unresolvable');
      assert.equal(startOidFor(ctx, 'b', { ok: false, kind: 'git-error', reason: 'fatal' }, { git: fake({}) }).kind, 'git-error');
      assert.equal(startOidFor(ctx, 'b', undefined, { git: fake({}) }).kind, 'base-unresolvable', 'an unmeasured base is not a baseline');
      assert.equal(startOidFor(ctx, 'b', measured, { git: fake({ mergeBase: { ok: false, status: 1, reason: 'x' } }) }).kind, 'no-merge-base');
      assert.equal(startOidFor(ctx, 'b', measured, { git: fake({ mergeBase: { ok: false, status: 128, reason: 'fatal' } }) }).kind, 'git-error');
      assert.equal(startOidFor(ctx, 'b', measured, { git: fake({ 'refs/heads/b': { ok: false, status: 1, reason: 'x' } }) }).kind, 'git-error', 'an unresolvable head is not a baseline either');
      assert.deepEqual(startOidFor(ctx, 'b', measured, { git: fake({ mergeBase: { ok: true, status: 0, stdout: `${'c'.repeat(40)}\n` } }) }), { ok: true, oid: 'c'.repeat(40) });
    });

    it('add refuses (exit 1, nothing adopted) when the base is not resolvable', () => {
      const s = setup({ fleetConfig: { baseBranch: 'nope' } });
      addBranch(s.fx.repo, 'feat-x', { 'x.txt': 'x\n' });
      const r = s.f(['add', 'feat-x', '--json']);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.json.reason, /base branch nope is not resolvable/);
      assert.equal(r.json.kind, 'base-unresolvable');
      assert.equal(sessionFiles(s.fx).length, 0);
    });

    it('add refuses unrelated histories (no merge-base) naming the branch', () => {
      const s = setup();
      git(['checkout', '-q', '--orphan', 'orph'], s.fx.repo);
      git(['rm', '-rfq', '.'], s.fx.repo);
      commitFile(s.fx.repo, 'o.txt', 'o\n');
      git(['checkout', '-q', 'main'], s.fx.repo);
      const r = s.f(['add', 'orph', '--json']);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.json.reason, /cannot adopt orph: .*no common ancestor/);
      assert.equal(r.json.kind, 'no-merge-base');
      assert.equal(sessionFiles(s.fx).length, 0);
    });

    it('start aborts atomically (exit 1, no worktree, no record) when the base is not resolvable', () => {
      const s = setup({ fleetConfig: { baseBranch: 'nope' } });
      const r = s.f(['start', '--task', 'one', '--task', 'two', '--json']);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.json.reason, /cannot resolve the base branch nope/);
      assert.equal(sessionFiles(s.fx).length, 0);
      assert.equal(fs.existsSync(path.join(s.fx.wtRoot, 'chips')), false);
    });

    it('claim never substitutes the branch head: startOid stays null and the reason is surfaced', () => {
      const s = setup({ fleetConfig: { baseBranch: 'nope' } });
      const r = s.f(['claim', '--id', 'a', '--intent', 'i', '--paths', 'p/**', '--json']);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(r.json.record.startOid, null);
      assert.match(r.json.startOidWarning, /nope/);
    });
  });

  it('M1: a fork-PR session (no branch) with a materialised ref contributes changed files to overlap AND the hook payload', () => {
    const s = setup({ gh: true, fleetConfig: { checks: [{ name: 'dump', script: 'hook.mjs', runner: ['node'], runIn: ['status'], severity: 'warn' }] } });
    writeFile(s.fx.repo, 'hook.mjs', `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(path.join(s.fx.root, 'payload.json'))},b);process.stdout.write('{"schemaVersion":1,"findings":[]}');});`);
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'fork-src', { 'p.txt': 'p\n' });
    git(['push', '-q', 'origin', `${oid}:refs/pull/9/head`], s.fx.repo);
    git(['branch', '-D', 'fork-src'], s.fx.repo);
    s.fake.setState({ list: [{ ...prRow({ number: 9, branch: 'fork-src', headOid: oid, baseOid: base }), isCrossRepository: true }] });
    assert.equal(s.f(['add', '#9']).status, 0);
    assert.equal(sessionRec(s.fx, 'pr-9').source.branch, null, 'a fork PR has no local branch name');
    assert.match(s.f(['status']).stdout, /changed files not queried/, 'before materialisation it says so');
    assert.equal(s.f(['ready', '--id', 'pr-9']).status, 0);
    readyBranch(s, 'local-b', { 'p.txt': 'conflicting\n' });
    const st = s.f(['status', '--json']);
    const pr = st.json.status.items.find((i) => i.id === 'pr-9');
    const lb = st.json.status.items.find((i) => i.id === 'local-b');
    assert.deepEqual(pr.changedFiles, ['p.txt']);
    assert.deepEqual(pr.overlaps.map((o) => [o.with, o.via.join('+'), o.files.join(',')]), [['local-b', 'files', 'p.txt']]);
    assert.deepEqual(lb.overlaps.map((o) => o.with), ['pr-9']);
    assert.doesNotMatch(st.stdout, /changed files not queried/);
    const payload = JSON.parse(fs.readFileSync(path.join(s.fx.root, 'payload.json'), 'utf8'));
    assert.deepEqual(payload.sessions.find((x) => x.id === 'pr-9').changedFiles, ['p.txt']);
    assert.ok(payload.overlaps.some((o) => [o.a, o.b].includes('pr-9')), 'overlaps reach the hook too');
  });

  it('M2: with gh and git in the SAME PATH directory the scrubbed env still resolves git and never the gh', () => {
    const d = tmpRoot('fleet-shared-');
    const ext = process.platform === 'win32' ? '.exe' : '';
    fs.copyFileSync(process.execPath, path.join(d, `gh${ext}`));
    fs.copyFileSync(process.execPath, path.join(d, `git${ext}`)); // a relocatable stand-in: answers `--version`
    const env = scrubbedEnv({}, { basePath: [d] });
    const g = spawnSync('git', ['--version'], { env, encoding: 'utf8' });
    assert.equal(g.error, undefined, 'git still resolves');
    assert.match(g.stdout, /^v\d+\./);
    const h = spawnSync('gh', ['--version'], { env, encoding: 'utf8' });
    assert.equal(h.error?.code, 'ENOENT', 'the real gh is unreachable');
    assert.ok(!(env.PATH ?? env.Path).split(path.delimiter).includes(d), 'the shared directory itself is not on PATH');
  });

  it('M3: the post-merge note names the ACTUAL base branch, not main', () => {
    const train = {
      trainId: 't-20260101000000-abcd', phase: 'tested', result: 'green', mergeMethod: 'direct-squash', baseOid: 'a'.repeat(40),
      destination: { remote: 'origin', ref: 'refs/heads/develop', fetchUrl: 'x', pushUrl: 'x', expectedOid: 'a'.repeat(40) },
      sources: [{ id: 's', oid: 'b'.repeat(40) }], candidate: { oid: 'c'.repeat(40), tree: 'd'.repeat(40) }, tierResults: [], checkResults: [],
      deferredTiers: [{ name: 'packaged', command: ['x'], stage: 'post-merge' }],
    };
    const built = renderBuilt({ train, approvability: { ok: true, reason: 'tested green' }, cmd: 'node f.mjs' });
    assert.match(built, /will run on `develop` after landing/);
    assert.match(built, /ONE develop run covers/);
    assert.doesNotMatch(built, /`main`|ONE main run/);
    const dry = renderDryRun({ plan: { baseOid: 'a'.repeat(40), destination: train.destination, mergeMethod: 'direct-squash', sources: train.sources, testCommand: [{ name: 'x', stage: 'pre-land' }], deferredTiers: train.deferredTiers } });
    assert.match(dry, /on `develop`/);
    const direct = renderApprove({ ok: true, mode: 'direct-squash', trainId: train.trainId, deferredTiers: train.deferredTiers, pushArgv: ['git', 'push'], train });
    assert.match(direct, /on `develop`/);
    const pr = renderApprove({ ok: true, mode: 'pr', trainId: train.trainId, deferredTiers: train.deferredTiers, plan: [], train });
    assert.match(pr, /on `develop`/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit round 4
describe('round 4: entry guard, local PR branch evidence, rendered commands', () => {
  it('H1: the CLI runs when invoked through a symlink with --preserve-symlinks-main (never a silent no-op), and directly', (t) => {
    const s = setup();
    const claim = s.f(['claim', '--id', 'feature-a', '--intent', 'i', '--paths', 'fa/**', '--json'], { env: { FLEET_NOW: '2026-10-05T10:00:00Z' } });
    assert.equal(claim.status, 0, claim.stdout + claim.stderr);
    assert.equal(sessionRec(s.fx, 'feature-a').leaseExpiresAt, '2026-10-05T14:00:00.000Z');
    const link = path.join(path.dirname(FLEET_CLI), `fleet-link-test-${process.pid}.mjs`);
    try { fs.symlinkSync(FLEET_CLI, link); } catch (e) { t.skip(`symlink creation is unavailable here (${e.code})`); return; }
    try {
      for (const flags of [['--preserve-symlinks-main'], []]) {
        const r = spawnSync(process.execPath, [...flags, link, 'touch', '--id', 'feature-a', '--json'], { cwd: s.fx.repo, env: { ...s.env, FLEET_NOW: '2026-10-05T11:00:00Z' }, encoding: 'utf8' });
        assert.equal(r.status, 0, `${flags.join(' ')}: ${r.stdout}${r.stderr}`);
        assert.notEqual(r.stdout.trim(), '', 'a silent exit 0 is the bug');
        assert.equal(sessionRec(s.fx, 'feature-a').leaseExpiresAt, '2026-10-05T15:00:00.000Z', `${flags.join(' ')}: the touch really ran`);
        const cur = sessionRec(s.fx, 'feature-a');
        writeSession(fleetDirOf(s.fx), SessionSchema.parse({ ...cur, rev: cur.rev + 1, leaseExpiresAt: '2026-10-05T14:00:00.000Z' }));
      }
    } finally { fs.rmSync(link, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    const direct = s.f(['touch', '--id', 'feature-a'], { env: { FLEET_NOW: '2026-10-05T12:00:00Z' } });
    assert.equal(direct.status, 0);
    assert.equal(sessionRec(s.fx, 'feature-a').leaseExpiresAt, '2026-10-05T16:00:00.000Z');
  });

  it('M1: a PR session whose LOCAL branch tip is not the PR head does not get that branch\'s evidence ("local branch tip A != PR head B")', () => {
    const s = setup({ gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'pr-branch', { 'p.txt': 'p\n' });
    const row = prRow({ number: 7, branch: 'pr-branch', headOid: oid, baseOid: base });
    s.fake.setState({ list: [row] });
    assert.equal(s.f(['add', '#7']).status, 0);
    const ok = s.f(['status', '--json']);
    assert.deepEqual(ok.json.status.items.find((i) => i.id === 'pr-7').changedFiles, ['p.txt'], 'control: tip == PR head');
    assert.doesNotMatch(ok.stdout, /changed files not queried/);
    const B = 'b'.repeat(40);
    s.fake.setState({ list: [{ ...row, headRefOid: B }] });
    const stale = s.f(['status', '--json']);
    assert.deepEqual(stale.json.status.items.find((i) => i.id === 'pr-7').changedFiles, []);
    assert.ok(stale.stdout.includes(`local branch tip ${oid.slice(0, 12)} != PR head ${B.slice(0, 12)}`), stale.stdout);
    s.fake.setState({ authFail: true });
    assert.match(s.f(['status']).stdout, /the PR head cannot be verified: PRs not queried/);
  });

  it('M3: every rendered instruction is built from the passed cmd (spaces and all); no literal `fleet <verb>` survives', () => {
    const cmd = renderCommand(['node', 'C:/with space/scripts/fleet.mjs'], 'linux');
    assert.equal(cmd, "node 'C:/with space/scripts/fleet.mjs'");
    const id = 't-20260101000000-abcd';
    const train = (phase, extra = {}) => ({ trainId: id, phase, result: 'green', conflict: { sourceId: 's' }, ...extra });
    const phases = ['snapshot', 'conflict', 'tested', 'approved', 'awaiting-merge', 'push-pending', 'diverged'];
    const open = renderOpenTrains([...phases.map((p) => train(p)), train('tested', { result: 'red' }), train('tested', { result: 'green-after-rerun' })], cmd);
    const dest = { remote: 'origin', ref: 'refs/heads/main', fetchUrl: 'x', pushUrl: 'x', expectedOid: 'a'.repeat(40) };
    const full = { ...train('tested'), mergeMethod: 'direct-squash', baseOid: 'a'.repeat(40), destination: dest, sources: [{ id: 's', oid: 'b'.repeat(40) }], candidate: { oid: 'c'.repeat(40), tree: 'd'.repeat(40) }, deferredTiers: [] };
    const texts = [
      open,
      renderParticipantRules(cmd),
      renderChipPrompt({ branch: 'b', worktree: 'w', task: 't', paths: [], cmd }),
      renderBuilt({ train: full, approvability: { ok: true, reason: 'tested green' }, cmd }),
      renderApprove({ ok: true, mode: 'pr', trainId: id, deferredTiers: [], plan: [], train: full }, cmd),
      renderReconcile({ reconciled: 'approved', trainId: id, remoteOid: 'a'.repeat(40) }, cmd),
    ];
    for (const text of texts) {
      assert.doesNotMatch(text, /(^|[^\w'])fleet (claim|ready|touch|hold|land|repair|start|status)\b/m, 'no literal fleet <verb>');
      for (const m of text.matchAll(/\bland --(approve|abandon|confirm|reconcile|resume)\b/g)) {
        assert.equal(text.slice(m.index - cmd.length - 1, m.index), `${cmd} `, `"${m[0]}" is not prefixed by the exact cmd in: ${text.slice(Math.max(0, m.index - 80), m.index + 40)}`);
      }
    }
    const rules = renderParticipantRules(cmd);
    for (const verb of ['claim', 'ready', 'touch', 'hold', 'land --approve']) assert.ok(rules.includes(`${cmd} ${verb}`), verb);
    assert.ok(texts[3].includes(`${cmd} land --approve ${id}`));
    assert.ok(texts[4].includes(`${cmd} land --confirm ${id}`));
    assert.ok(texts[5].includes(`${cmd} land --approve ${id}`));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit round 6
describe('round 6: ONE evidence predicate, per-session distrust, async runner lifecycle', () => {
  it('needsEvidenceKey: PR sessions (with or without a branch) yes; terminal, branch-kind and number-less no', () => {
    const pr = ({ state = 'working', source = {} } = {}) => ({ state, source: { kind: 'pr', prNumber: 42, branch: null, ...source } });
    assert.equal(needsEvidenceKey(pr()), true, 'branchless');
    assert.equal(needsEvidenceKey(pr({ source: { branch: 'feature' } })), true, 'with a branch');
    assert.equal(needsEvidenceKey(pr({ state: 'done' })), false);
    assert.equal(needsEvidenceKey(pr({ state: 'abandoned' })), false);
    assert.equal(needsEvidenceKey({ state: 'working', source: { kind: 'branch', prNumber: null, branch: 'x' } }), false);
    assert.equal(needsEvidenceKey(pr({ source: { prNumber: null } })), false);
  });

  it('pr-42 on branch "feature" with tip != PR head: the PR session warns and keeps NO borrowed evidence, while the branch\'s own evidence still feeds the join', () => {
    const s = setup({ gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'feature', { 'shared.txt': 'feature\n' });
    const row = prRow({ number: 42, branch: 'feature', headOid: oid, baseOid: base });
    s.fake.setState({ list: [row] });
    assert.equal(s.f(['add', '#42']).status, 0);
    assert.equal(sessionRec(s.fx, 'pr-42').source.branch, 'feature');
    readyBranch(s, 'other', { 'shared.txt': 'other\n' });
    // control: tip == PR head -> the session uses the branch evidence and overlaps 'other'
    const ok = s.f(['status', '--json']);
    assert.deepEqual(ok.json.status.items.find((i) => i.id === 'pr-42').changedFiles, ['shared.txt']);
    assert.deepEqual(ok.json.status.items.find((i) => i.id === 'pr-42').overlaps.map((o) => o.with), ['other']);
    // the PR head moves on: local tip != PR head
    const B = 'b'.repeat(40);
    s.fake.setState({ list: [{ ...row, headRefOid: B }] });
    const st = s.f(['status', '--json']);
    const items = st.json.status.items;
    const pr = items.find((i) => i.id === 'pr-42');
    assert.deepEqual(pr.changedFiles, [], 'the PR session itself is not given the branch evidence');
    assert.deepEqual(pr.overlaps, []);
    assert.ok(st.stdout.includes(`local branch tip ${oid.slice(0, 12)} != PR head ${B.slice(0, 12)}`), st.stdout);
    const feature = items.find((i) => i.id === 'feature');
    assert.ok(feature, 'the local branch is now its own (unregistered) consumer');
    assert.equal(feature.tracked, false);
    assert.deepEqual(feature.changedFiles, ['shared.txt'], 'the shared branch evidence was NOT wiped');
    assert.deepEqual(feature.overlaps.map((o) => [o.with, o.files]), [['other', ['shared.txt']]]);
    assert.deepEqual(items.find((i) => i.id === 'other').overlaps.map((o) => o.with), ['feature']);
  });

  it('runFleetAsync has the sync runner\'s lifecycle: a deadline kills the child and rejects; a spawn error rejects', async () => {
    const s = setup();
    await assert.rejects(() => runFleetAsync(['status'], { cwd: s.fx.repo, env: s.env, timeoutMs: 1 }), /timed out after 1ms \(child killed\)/);
    await assert.rejects(() => runFleetAsync(['status'], { cwd: path.join(s.fx.root, 'no-such-dir'), env: s.env }), /could not run/);
    const ok = await runFleetAsync(['status', '--json'], { cwd: s.fx.repo, env: s.env });
    assert.equal(ok.status, 0);
  });
});
