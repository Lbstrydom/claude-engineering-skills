/**
 * @fileoverview /fleet CLI end to end — the train: build, one combined run and
 * approve, direct-squash against a bare origin. Split from tests/fleet-cli.test.mjs
 * for wall time; harness: tests/helpers/fleet-cli-harness.mjs.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, commitFile, snapshotDir, tmpRoot, writeFile } from './helpers/fleet-repo.mjs';
import { OK_TIER, fleetDirOf, fwd, land, originLog, readyBranch, sessionRec, setup } from './helpers/fleet-cli-harness.mjs';
import { listTrains } from '../scripts/lib/fleet/registry.mjs';
import { approveTrain } from '../scripts/lib/fleet/train-approve.mjs';
import { defaultDeps } from '../scripts/lib/fleet/train.mjs';

after(cleanupFleetRoots);

// ───────────────────────────────────────────────────────────────────────────
describe('land (direct-squash against a bare origin)', () => {
  const cfg = (tiers = [OK_TIER], extra = {}) => ({ mergeMethod: 'direct-squash', testCommand: { tiers }, ...extra });

  function twoReady(over = {}) {
    const s = setup({ fleetConfig: cfg(over.tiers, over.extra) });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' }, {});
    readyBranch(s, 'feat-b', { 'b.txt': 'B\n' }, {});
    return s;
  }

  it('green: one combined run; approve pushes ONE commit per branch to origin to the recorded pushUrl; sessions become done', () => {
    const s = twoReady();
    const built = land(s);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const t = built.json.train;
    assert.equal(t.phase, 'tested');
    assert.equal(t.result, 'green');
    assert.equal(t.mergeMethod, 'direct-squash');
    assert.equal(t.destination.ref, 'refs/heads/main');
    assert.equal(t.destination.pushUrl, s.fx.origin);
    assert.equal(t.destination.expectedOid, git(['rev-parse', 'main'], s.fx.repo));
    assert.deepEqual(t.sources.map((x) => x.id).sort(), ['feat-a', 'feat-b']);
    assert.ok(t.candidate.oid && t.candidate.tree);
    assert.equal(path.dirname(t.worktree), s.fx.wtRoot, 'the worktree is under the configured root, outside .git');
    assert.ok(!fwd(t.worktree).includes('/.git/'));
    assert.match(built.json.text, /A green train does not prove each branch green alone/);
    assert.match(built.json.text, /land --approve t-\d{14}-[0-9a-f]{4}/);
    const before = git(['rev-parse', 'main'], s.fx.repo);
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), before, 'build never touches the base');

    const ap = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(ap.status, 0, ap.stdout + ap.stderr);
    assert.equal(ap.json.train.phase, 'landed');
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), t.candidate.oid, 'the pushed commit IS the tested candidate');
    const log = originLog(s.fx);
    assert.equal(log.length, 3, 'init + one commit per branch');
    assert.deepEqual(log.slice(0, 2).sort(), ['work on feat-a', 'work on feat-b']);
    assert.equal(fs.existsSync(t.worktree), false, 'the worktree is removed only after landed');
    assert.equal(ap.json.pushArgv[0], 'git');
    assert.equal(ap.json.pushArgv[2], s.fx.origin, 'pushed to the recorded URL, not the remote name');
    assert.ok(ap.json.pushArgv.some((a) => a === `--force-with-lease=refs/heads/main:${t.destination.expectedOid}`));
    // session finalisation: derived AND cached by the mutating verb
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'done');
    assert.equal(sessionRec(s.fx, 'feat-b').state, 'done');
    // a landed session no longer blocks admission
    assert.equal(s.f(['claim', '--id', 'newcomer', '--intent', 'fresh', '--paths', 'feat-a/**']).status, 0);
  });

  it('approving an already-landed train is refused naming the state', () => {
    const s = twoReady();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    const again = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(again.status, 3);
    assert.match(again.json.reason, /train is landed/);
  });

  it('a session whose rev moved after the train was built is NOT derived done', () => {
    const s = twoReady();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    // the session records change (rev bump) after the train was built
    const dir = fleetDirOf(s.fx);
    for (const id of ['feat-a', 'feat-b']) {
      const cur = sessionRec(s.fx, id);
      fs.writeFileSync(path.join(dir, 'sessions', fs.readdirSync(path.join(dir, 'sessions')).find((n) => n.startsWith(id))), `${JSON.stringify({ ...cur, state: 'ready', rev: cur.rev + 1 }, null, 2)}\n`);
    }
    // rev moved after the train was built -> NOT derived done
    assert.notEqual(s.f(['status', '--json']).json.status.items.find((i) => i.id === 'feat-a').state, 'done');
  });

  it('derived done when the rev is untouched: status derives it WITHOUT writing (byte-identical registry)', () => {
    const s = twoReady();
    const t = land(s).json.train;
    // land the train by writing ONLY the train record (as if the process died right after) — via a real approve in-process, with the cache write skipped
    const cfgObj = s.config();
    const dir = fleetDirOf(s.fx);
    const r = approveTrain({ cwd: s.fx.repo, trainId: t.trainId, doneCache: false, deps: defaultDeps({ log: () => {} }) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'ready', 'no cache was written (doneCache:false)');
    const before = snapshotDir(dir);
    const st = s.f(['status', '--json']);
    assert.equal(st.json.status.items.find((i) => i.id === 'feat-a').state, 'done', 'derived on read');
    assert.deepEqual(snapshotDir(dir), before, 'status wrote nothing even though derivation would change a state');
    void cfgObj;
  });

  it('a session that commits after landing, without any fleet command, is NOT done; a deleted source branch is', () => {
    const s = twoReady();
    const t = land(s).json.train;
    const dir = fleetDirOf(s.fx);
    approveTrain({ cwd: s.fx.repo, trainId: t.trainId, doneCache: false, deps: defaultDeps({ log: () => {} }) });
    git(['checkout', '-q', 'feat-a'], s.fx.repo);
    commitFile(s.fx.repo, 'late.txt', 'late\n');
    git(['checkout', '-q', 'main'], s.fx.repo);
    git(['branch', '-D', 'feat-b'], s.fx.repo);
    const items = s.f(['status', '--json']).json.status.items;
    assert.notEqual(items.find((i) => i.id === 'feat-a').state, 'done');
    assert.match(items.find((i) => i.id === 'feat-a').notes.join(' '), /newer commits exist/);
    assert.equal(items.find((i) => i.id === 'feat-b').state, 'done');
    void dir;
  });

  it('red then green on rerun: green-after-rerun; approve is refused WITHOUT --accept-rerun and allowed with it', () => {
    const marker = fwd(path.join(tmpRoot(), 'flaky'));
    const flaky = { name: 'default', command: ['node', '-e', `const f=require('fs');if(!f.existsSync('${marker}')){f.writeFileSync('${marker}','1');process.exit(1)}process.exit(0)`] };
    const s = twoReady({ tiers: [flaky] });
    const t = land(s).json.train;
    assert.equal(t.result, 'green-after-rerun');
    const refused = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(refused.status, 3);
    assert.match(refused.json.reason, /--accept-rerun/);
    const ok = s.f(['land', '--approve', t.trainId, '--accept-rerun', '--json']);
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.json.text, /first run failed; passed on rerun — possible flake/);
  });

  it('persistent red: the train is built, NOT approvable, and approve is refused naming the state', () => {
    const s = twoReady({ tiers: [{ name: 'default', command: ['node', '-e', 'process.exit(1)'] }] });
    const r = land(s);
    assert.equal(r.status, 3);
    assert.equal(r.json.train.result, 'red');
    const ap = s.f(['land', '--approve', r.json.train.trainId, '--json']);
    assert.equal(ap.status, 3);
    assert.match(ap.json.reason, /red/);
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), git(['rev-parse', 'main'], s.fx.repo), 'nothing pushed');
  });

  it('a test command that rewrites a tracked file is DIRTY, never approvable', () => {
    const s = twoReady({ tiers: [{ name: 'default', command: ['node', '-e', "require('fs').appendFileSync('a.txt','tamper')"] }] });
    const r = land(s);
    assert.equal(r.json.train.result, 'dirty');
    assert.equal(r.status, 3);
    assert.match(s.f(['land', '--approve', r.json.train.trainId, '--json']).json.reason, /dirty/);
  });

  it('a failed first run that leaves untracked files is reset before the rerun: a leftover cannot make the rerun pass', () => {
    const leftover = { name: 'default', command: ['node', '-e', "const f=require('fs');if(f.existsSync('leftover.txt'))process.exit(0);f.writeFileSync('leftover.txt','x');process.exit(1)"] };
    const s = twoReady({ tiers: [leftover] });
    const r = land(s);
    assert.equal(r.json.train.result, 'red', 'a rerun that would pass only because of leftovers is impossible');
    assert.equal(r.json.train.tierResults[0].reran, true);
  });

  it('a merge conflict stops the train at the conflicting branch; the worktree is left; approve is refused', () => {
    const s = setup({ fleetConfig: cfg() });
    readyBranch(s, 'feat-a', { 'a.txt': 'from a\n' });
    readyBranch(s, 'feat-b', { 'a.txt': 'from b\n' });
    const r = land(s);
    assert.equal(r.status, 3);
    assert.equal(r.json.train.phase, 'conflict');
    assert.equal(r.json.train.conflict.files[0], 'a.txt');
    assert.ok(['feat-a', 'feat-b'].includes(r.json.train.conflict.sourceId));
    assert.ok(fs.existsSync(r.json.train.worktree), 'left for inspection');
    const ap = s.f(['land', '--approve', r.json.train.trainId, '--json']);
    assert.equal(ap.status, 3);
    assert.match(ap.json.reason, /train is conflict/);
  });

  it('a local base ahead of the remote refuses the train (local base differs)', () => {
    const s = twoReady();
    commitFile(s.fx.repo, 'local-only.txt', 'x\n');
    const r = land(s);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /local base differs from origin\/main — sync first/);
  });

  it('--dry-run builds nothing and writes nothing; --select lands only the named ready sessions', () => {
    const s = twoReady();
    const dry = land(s, ['--dry-run']);
    assert.equal(dry.status, 0);
    assert.match(dry.json.text, /nothing was written or built/);
    assert.equal(listTrains(fleetDirOf(s.fx)).trains.length, 0);
    assert.equal(fs.existsSync(s.fx.wtRoot), false);
    const sel = land(s, ['--select', 'feat-b']);
    assert.deepEqual(sel.json.train.sources.map((x) => x.id), ['feat-b']);
    assert.equal(land(s, ['--select', 'nope']).status, 3);
  });

  it('refuses a registry that is incomplete, and a repo with no testCommand', () => {
    const noTests = setup({ fleetConfig: { mergeMethod: 'direct-squash' } });
    readyBranch(noTests, 'feat-a', { 'a.txt': 'A\n' });
    const r = land(noTests);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /no testCommand configured/);
    const s = twoReady();
    writeFile(s.fx.repo, '.git/fleet/sessions/junk.json', 'x');
    assert.match(land(s).json.reason, /registry incomplete/);
  });

  it('the string testCommand form behaves as one pre-land tier "default"; shell metacharacters are honoured', () => {
    const marker = fwd(path.join(tmpRoot(), 'shell-ran'));
    const s = twoReady({ extra: { testCommand: `node -e "require('fs').writeFileSync('${marker}','1')" && node -e "process.exit(0)"` } });
    const cfgNow = s.config();
    assert.equal(cfgNow.testCommand.length, 1);
    assert.equal(cfgNow.testCommand[0].shell, true);
    const r = land(s);
    assert.equal(r.json.train.result, 'green', JSON.stringify(r.json.train.tierResults));
    assert.equal(r.json.train.tierResults.length, 1);
    assert.equal(r.json.train.tierResults[0].name, 'default');
    assert.ok(fs.existsSync(marker), 'the && chain only works if a shell ran it');
  });
});
