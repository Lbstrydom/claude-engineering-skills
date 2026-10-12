/**
 * @fileoverview `fleet handover prepare|receive` (docs/plans/fleet-handover.md).
 *
 * Every case runs against temp config roots via CLAUDE_CONFIG_DIR — never the real ~/.claude.
 * "Does not write / does not block" cases are paired with a control that fires the other way, so a
 * predicate answering one value for everything fails here.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './helpers/git.mjs';
import {
  HANDOVER_SCHEMA_VERSION, OP_ID_RE, checkHandoverFlags, collectMemory, decideFile, handoverId, loadManifest,
  claimCommand, mainCheckout, receiveHandover, safeRelSegments,
} from '../scripts/lib/fleet/handover.mjs';
import { withFileLockSync } from '../scripts/lib/file-lock.mjs';
import { quoteArg } from '../scripts/lib/fleet/shell-quote.mjs';
import { FLEET_CLI, cleanupFleetRoots, commitFile, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

/** A config root holding one project's memory, a scheduled task and a settings file. */
function seedConfig(root, { slug = 'c--GIT-demo', files = { 'MEMORY.md': '- index\n', 'a.md': 'alpha\n', 'sub/b.md': 'beta\n' }, task = 'weekly-check' } = {}) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, 'projects', slug, 'memory', ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  if (task) {
    fs.mkdirSync(path.join(root, 'scheduled-tasks', task), { recursive: true });
    fs.writeFileSync(path.join(root, 'scheduled-tasks', task, 'SKILL.md'), `---\nname: ${task}\ndescription: Weekly check\n---\nrun it\n`);
  }
  fs.writeFileSync(path.join(root, 'settings.json'), '{"mcpServers":{}}\n');
  return root;
}

describe('handoverId (R1-H3)', () => {
  it('is colon-free, matches the op-id pattern, and differs for the same millisecond', () => {
    const now = new Date('2026-10-11T09:30:12.345Z');
    const a = handoverId(now, 'aaaaaa'); const b = handoverId(now, 'bbbbbb');
    assert.equal(a, '20261011T093012345Z-aaaaaa');
    assert.ok(!a.includes(':'));
    assert.match(a, OP_ID_RE);
    assert.notEqual(a, b);
  });
});

describe('safeRelSegments (R1-H1)', () => {
  it('refuses anything that could escape; accepts a plain nested path', () => {
    for (const bad of ['', '/abs.md', '../x.md', 'a/../b.md', 'a/./b.md', 'a\\b.md', 'c:x.md', 'a//b.md']) {
      assert.equal(safeRelSegments(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(safeRelSegments('sub/b.md'), ['sub', 'b.md']);
  });
});

describe('decideFile — the receive decision table (R1-M1/R2-M2)', () => {
  const P = 'p'; const F = (hash) => ({ kind: 'file', hash }); const A = { kind: 'absent' }; const E = { kind: 'error', reason: 'EACCES' };
  const never = () => { throw new Error('source must not be read'); };
  it('rule 1: destination error', () => assert.equal(decideFile(P, E, never).outcome, 'destination-unreadable'));
  it('rule 2: D = P is present and the source is NOT read', () => assert.equal(decideFile(P, F(P), never).outcome, 'present'));
  it('rule 3: source error -> source-unreadable (D absent) / undetermined (D differs), never a conflict', () => {
    assert.equal(decideFile(P, A, () => E).outcome, 'source-unreadable');
    assert.equal(decideFile(P, F('d'), () => E).outcome, 'undetermined');
  });
  it('rule 4: both absent -> source-missing', () => assert.equal(decideFile(P, A, () => A).outcome, 'source-missing'));
  it('rules 5/6: absent destination copies (and says when the source moved on)', () => {
    assert.deepEqual([decideFile(P, A, () => F(P)).outcome, decideFile(P, A, () => F(P)).write], ['copied', true]);
    assert.equal(decideFile(P, A, () => F('s')).outcome, 'copied-source-changed');
  });
  it('rule 7: D = S != P is present-source-changed (stable re-run), rule 8: otherwise conflict', () => {
    assert.equal(decideFile(P, F('s'), () => F('s')).outcome, 'present-source-changed');
    assert.equal(decideFile(P, F('d'), () => F('s')).outcome, 'conflict');
    assert.equal(decideFile(P, F('d'), () => A).outcome, 'conflict');
  });
});

describe('checkHandoverFlags (R1-M3)', () => {
  it('refuses forbidden / missing flags and unknown subcommands before any I/O', () => {
    assert.throws(() => checkHandoverFlags('prepare', { '--from': 'x' }), /--from is not valid/);
    assert.throws(() => checkHandoverFlags('prepare', { '--dry-run': true }), /--dry-run is not valid/);
    assert.throws(() => checkHandoverFlags('receive', {}), /--from is required/);
    assert.throws(() => checkHandoverFlags('receive', { '--from': 'x', '--repo': ['y'] }), /--repo is not valid/);
    assert.throws(() => checkHandoverFlags('toString', {}), /unknown subcommand/);
    assert.doesNotThrow(() => checkHandoverFlags('receive', { '--from': 'x', '--dry-run': true }));
  });
});

describe('loadManifest — fails loudly, never reads as clean', () => {
  const dir = tmpRoot('handover-manifest-');
  const write = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  it('missing, malformed, wrong version and an unknown key each name their reason', () => {
    assert.equal(loadManifest(path.join(dir, 'absent.json')).reason, 'manifest-missing');
    assert.equal(loadManifest(write('bad.json', '{ nope')).reason, 'manifest-malformed');
    assert.equal(loadManifest(write('v.json', JSON.stringify({ schemaVersion: 99 }))).reason, 'manifest-schema-version');
    assert.equal(loadManifest(write('x.json', JSON.stringify({ schemaVersion: HANDOVER_SCHEMA_VERSION, surprise: 1 }))).reason, 'manifest-schema');
  });
});

describe('collectMemory — account-wide, with folder anomalies', () => {
  it('enumerates every projects/*/memory dir and reports a worktree-slug dir and a missing index', () => {
    const root = tmpRoot('handover-anomaly-');
    seedConfig(root, { slug: 'c--GIT-one', task: null });
    seedConfig(root, { slug: 'c--GIT-two--claude-worktrees-x', files: { 'note.md': 'n\n' }, task: null });
    fs.mkdirSync(path.join(root, 'projects', 'c--GIT-transcripts-only'), { recursive: true }); // no memory/
    const { memory, anomalies } = collectMemory(root);
    assert.deepEqual(memory.map((m) => m.dirName), ['c--GIT-one', 'c--GIT-two--claude-worktrees-x']);
    assert.deepEqual(anomalies.map((a) => a.kind).sort(), ['memory-under-worktree-slug', 'no-memory-index']);
  });
  it('a project dir that is a LINK is reported as an anomaly, never dropped as if it held no memory', () => {
    const root = seedConfig(tmpRoot('handover-mem-link-'), { task: null });
    const real = seedConfig(tmpRoot('handover-mem-real-'), { slug: 'c--GIT-real', task: null });
    fs.symlinkSync(path.join(real, 'projects', 'c--GIT-real'), path.join(root, 'projects', 'c--GIT-linked'), 'junction');
    const r = collectMemory(root);
    assert.deepEqual(r.anomalies.filter((a) => a.kind === 'project-is-link').map((a) => a.detail), ['c--GIT-linked']);
    assert.deepEqual(r.memory.map((m) => m.dirName), ['c--GIT-demo'], 'the link is not walked');
  });

  it('control: a clean layout reports no anomalies', () => {
    const root = seedConfig(tmpRoot('handover-clean-'), { task: null });
    assert.deepEqual(collectMemory(root).anomalies, []);
  });
});

describe('fleet handover — end to end through the CLI', () => {
  const setup = () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-a-'));
    const envFor = (cfg) => scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '' });
    const f = (args, cfg) => runFleet([...args, '--json'], { cwd: fx.repo, env: envFor(cfg) });
    // The fixture lists a scheduled task, so the pre-switch gate applies: these cases are not about it.
    const prep = f(['handover', 'prepare', '--scheduler-checked'], A);
    assert.equal(prep.status, 0, prep.stderr);
    return { fx, A, f, json: prep.json.handover.json, prep };
  };
  const memFile = (cfg, rel) => path.join(cfg, 'projects', 'c--GIT-demo', 'memory', ...rel.split('/'));

  it('prepare writes a colon-free pair under .git/fleet/handover and says the source repo did not resolve', () => {
    const { prep } = setup();
    const h = prep.json.handover;
    assert.match(path.basename(h.json), /^handover-\d{8}T\d{9}Z-[0-9a-f]{6}\.json$/);
    assert.ok(fs.existsSync(h.md));
    assert.match(h.json.replace(/\\/g, '/'), /\/\.git\/fleet\/handover\//);
    assert.deepEqual([h.memoryDirs, h.memoryFiles, h.scheduledTasks], [1, 3, 1]);
    assert.notEqual(h.sourceRepo.type, 'resolved', 'a fixture repo has no source repo beside it');
    assert.match(prep.json.text, /WARNING: source repo not resolved/);
  });

  it('same config root: verifies every file, copies nothing, exit 0', () => {
    const { A, f, json } = setup();
    const r = f(['handover', 'receive', '--from', json], A);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.handover.mode, 'same-config-root');
    assert.equal(r.json.handover.summary.verified, 3);
  });

  it('different config root: copies byte-identical, flags the task, re-run is idempotent; dry-run writes nothing', () => {
    const { f, json } = setup();
    const B = tmpRoot('handover-acct-b-');
    const dry = f(['handover', 'receive', '--from', json, '--dry-run'], B);
    assert.equal(dry.json.handover.summary.copied, 3);
    assert.equal(fs.existsSync(path.join(B, 'projects')), false, 'dry run wrote nothing');
    const r = f(['handover', 'receive', '--from', json], B);
    assert.equal(r.status, 0, 'a task to confirm or recreate is a follow-up, never a refusal (plan p)');
    assert.ok(r.json.handover.followUps.some((x) => x.kind === 'scheduled-tasks'));
    assert.equal(r.json.handover.summary.copied, 3);
    assert.equal(fs.readFileSync(memFile(B, 'sub/b.md'), 'utf8'), 'beta\n');
    assert.equal(r.json.handover.tasks[0].registration, 'unverified');
    const again = f(['handover', 'receive', '--from', json], B);
    assert.deepEqual([again.json.handover.summary.copied, again.json.handover.summary.present], [0, 3]);
    assert.equal(fs.readdirSync(path.join(B, '.fleet-handover-staging')).length, 0, 'no staging left behind');
  });

  it('a differing destination file is a CONFLICT and stays byte-identical (never overwritten)', () => {
    const { f, json } = setup();
    const B = tmpRoot('handover-acct-c-');
    fs.mkdirSync(path.dirname(memFile(B, 'a.md')), { recursive: true });
    fs.writeFileSync(memFile(B, 'a.md'), 'mine, not theirs\n');
    const r = f(['handover', 'receive', '--from', json], B);
    assert.equal(r.status, 3);
    assert.equal(r.json.handover.summary.conflicts, 1);
    assert.equal(fs.readFileSync(memFile(B, 'a.md'), 'utf8'), 'mine, not theirs\n');
    assert.equal(fs.readFileSync(memFile(B, 'MEMORY.md'), 'utf8'), '- index\n', 'the other files still copied');
  });

  it('a source edited after prepare copies the new bytes and a re-run is stable (rule 7), not a conflict', () => {
    const { A, f, json } = setup();
    fs.writeFileSync(memFile(A, 'a.md'), 'alpha v2\n');
    const C = tmpRoot('handover-acct-d-');
    const first = f(['handover', 'receive', '--from', json], C);
    assert.ok(first.json.handover.files.some((x) => x.outcome === 'copied-source-changed'));
    const second = f(['handover', 'receive', '--from', json], C);
    assert.ok(second.json.handover.files.some((x) => x.outcome === 'present-source-changed'));
    assert.equal(second.json.handover.summary.conflicts, 0);
  });

  it('a junction BELOW the destination root refuses the write (nothing lands outside)', () => {
    const { f, json } = setup();
    const B = tmpRoot('handover-acct-e-');
    const outside = tmpRoot('handover-outside-');
    fs.mkdirSync(path.join(B, 'projects'), { recursive: true });
    fs.symlinkSync(outside, path.join(B, 'projects', 'c--GIT-demo'), 'junction');
    const r = f(['handover', 'receive', '--from', json], B);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.json.handover.files.every((x) => x.outcome === 'unsafe-destination'));
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the junction');
  });

  it('a config root that is ITSELF a junction is followed (G2)', () => {
    const { f, json } = setup();
    const real = tmpRoot('handover-real-root-');
    const linkParent = tmpRoot('handover-link-parent-');
    const link = path.join(linkParent, 'cfg');
    fs.symlinkSync(real, link, 'junction');
    const r = f(['handover', 'receive', '--from', json], link);
    assert.equal(r.json.handover.summary.copied, 3, r.stdout);
    assert.ok(fs.existsSync(path.join(real, 'projects', 'c--GIT-demo', 'memory', 'a.md')));
  });

  it('only DEAD runs are swept (op-id shaped, .tmp-only); a foreign entry is left alone', () => {
    const { f, json } = setup();
    const B = tmpRoot('handover-acct-f-');
    const dead = path.join(B, '.fleet-handover-staging', '20260101T000000000Z-abcdef');
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(path.join(dead, '0.tmp'), 'partial');
    fs.mkdirSync(path.join(B, '.fleet-handover-staging', 'keepme'));
    const r = f(['handover', 'receive', '--from', json], B);
    assert.deepEqual(r.json.handover.sweep.swept, ['20260101T000000000Z-abcdef']);
    assert.ok(fs.existsSync(path.join(B, '.fleet-handover-staging', 'keepme')), 'not ours: reported, not deleted');
  });

  it('a receive while another holds the lock refuses and writes nothing', () => {
    const { fx, json } = setup();
    const B = tmpRoot('handover-acct-g-');
    fs.mkdirSync(B, { recursive: true });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: B };
    const held = withFileLockSync(path.join(fs.realpathSync.native(B), '.fleet-handover.lock'), {}, () =>
      receiveHandover({ cwd: fx.repo, env, now: new Date() }, { '--from': json }));
    assert.equal(held.value.code, 'refused');
    assert.equal(held.value.handover.lockContention, true);
    assert.equal(fs.existsSync(path.join(B, 'projects')), false);
    assert.equal(held.value.handover.summary.copied, 0, 'nothing reads as copied when this receiver never held the lock (R2-M1)');
    assert.ok(held.value.handover.files.every((x) => x.outcome === 'not-written-lock-held'));
  });

  it('a manifest from an incomplete prepare (unmeasured memory dirs) never receives clean (R2-H1)', () => {
    const { A, f, json } = setup();
    const manifest = JSON.parse(fs.readFileSync(json, 'utf8'));
    manifest.memoryErrors = [{ dirName: 'c--GIT-unreadable', reason: 'EACCES' }];
    const tampered = json.replace(/\.json$/, '-incomplete.json');
    fs.writeFileSync(tampered, JSON.stringify(manifest));
    const r = f(['handover', 'receive', '--from', tampered], A);
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.json.text, /NOT measured at prepare/);
  });

  it('a session registry that cannot be read completely is UNKNOWN live state, not "none" (R1-H4/M4)', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-i-'));
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: A, CLAUDE_AUDIT_LOOP_DIR: '' });
    assert.equal(runFleet(['claim', '--id', 'live-one', '--intent', 'live work', '--paths', 'src/**'], { cwd: fx.repo, env }).status, 0);
    const prep = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env });
    assert.equal(prep.json.handover.sessions, 1, 'the claim is in the manifest');
    const sessions = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet', 'sessions');
    fs.writeFileSync(path.join(sessions, 'corrupt.json'), '{ not json');
    const r = runFleet(['handover', 'receive', '--from', prep.json.handover.json, '--json'], { cwd: fx.repo, env });
    assert.equal(r.json.handover.liveUnknown.length, 1, r.stdout);
    assert.equal(r.status, 3, 'unknown live state is a human step, never a clean exit');
    // control: the same receive with the registry intact is not unknown
    fs.rmSync(path.join(sessions, 'corrupt.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const ok = runFleet(['handover', 'receive', '--from', prep.json.handover.json, '--json'], { cwd: fx.repo, env });
    assert.deepEqual([ok.json.handover.liveUnknown.length, ok.json.handover.liveSessions.map((x) => x.id)], [0, ['live-one']]);
  });

  it('a source memory dir swapped for a junction after prepare cannot anchor itself (R1-H3/H7)', () => {
    const { A, f, json } = setup();
    const mem = path.join(A, 'projects', 'c--GIT-demo', 'memory');
    const elsewhere = tmpRoot('handover-swap-');
    fs.writeFileSync(path.join(elsewhere, 'a.md'), 'alpha\n');
    rm(mem);
    fs.symlinkSync(elsewhere, mem, 'junction');
    const C = tmpRoot('handover-acct-j-');
    const r = f(['handover', 'receive', '--from', json], C);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.json.handover.files.every((x) => x.outcome === 'source-unreadable'), JSON.stringify(r.json.handover.files.map((x) => x.outcome)));
    assert.equal(fs.existsSync(path.join(C, 'projects', 'c--GIT-demo', 'memory', 'a.md')), false, 'nothing copied from the swapped dir');
  });

  it('a --repo without fleet state is reported as absent, never an error', () => {
    const fx = makeFleetRepo();
    const other = tmpRoot('handover-nofleet-');
    git(['init', '-q', other]);
    const A = seedConfig(tmpRoot('handover-acct-h-'), { task: null });
    const r = runFleet(['handover', 'prepare', '--repo', other, '--json'], { cwd: fx.repo, env: scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: A, CLAUDE_AUDIT_LOOP_DIR: '' }) });
    assert.equal(r.status, 0, r.stderr);
    const manifest = JSON.parse(fs.readFileSync(r.json.handover.json, 'utf8'));
    const entry = manifest.scope.repos.find((x) => path.resolve(x.path) === path.resolve(other));
    assert.equal(entry.fleet, 'absent');
    rm(other);
  });
});

describe('unregistered work — worktrees holding work no claim covers', () => {
  const envFor = (cfg) => scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '' });
  const addWorktree = (fx, name) => {
    const wt = path.join(tmpRoot('handover-unreg-'), name);
    git(['worktree', 'add', '-q', '-b', name, wt], fx.repo);
    return wt;
  };
  const manifestOf = (prep) => JSON.parse(fs.readFileSync(prep.json.handover.json, 'utf8'));

  it('an unclaimed worktree with an uncommitted file is listed and prepare exits 3; a clean one is not (control)', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-u1-'), { task: null });
    const dirty = addWorktree(fx, 'coordinator-wip');
    fs.writeFileSync(path.join(dirty, 'notes.md'), 'in flight\n');
    addWorktree(fx, 'clean-side');
    const prep = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(prep.status, 3, prep.stdout);
    assert.equal(prep.json.handover.unregistered, 1);
    const [entry] = manifestOf(prep).scope.repos;
    assert.deepEqual(entry.unregistered.map((u) => [u.branch, u.risks.untracked]), [['coordinator-wip', 1]], 'the clean worktree is not listed');
    const md = fs.readFileSync(prep.json.handover.md, 'utf8');
    assert.match(md, /## Unregistered work/);
    assert.match(md, /claim --id coordinator-wip/);
    assert.doesNotMatch(md, /clean-side/);
  });

  it('local commits nothing remote holds count as unregistered work', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-u2-'), { task: null });
    const wt = addWorktree(fx, 'local-only');
    fs.writeFileSync(path.join(wt, 'x.txt'), 'x\n');
    git(['add', 'x.txt'], wt);
    git(['commit', '-q', '-m', 'local only'], wt);
    const prep = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(prep.status, 3, prep.stdout);
    assert.equal(manifestOf(prep).scope.repos[0].unregistered[0].risks.unpushed, 1);
  });

  it('a claim bound to the worktree covers it: prepare is clean (the direction it must NOT fire)', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-u3-'), { task: null });
    const wt = addWorktree(fx, 'claimed-wip');
    fs.writeFileSync(path.join(wt, 'notes.md'), 'in flight\n');
    assert.equal(runFleet(['claim', '--id', 'claimed-wip', '--intent', 'wip', '--paths', 'notes.md'], { cwd: wt, env: envFor(A) }).status, 0);
    const prep = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(prep.status, 0, prep.stdout);
    assert.deepEqual(manifestOf(prep).scope.repos[0].unregistered, []);
  });

  it('a branch adopted with `fleet add` (no worktree recorded) covers the worktree it is checked out in', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-u4-'), { task: null });
    const wt = addWorktree(fx, 'adopted');
    fs.writeFileSync(path.join(wt, 'y.txt'), 'y\n');
    git(['add', 'y.txt'], wt);
    git(['commit', '-q', '-m', 'adopted work'], wt);
    assert.equal(runFleet(['add', 'adopted'], { cwd: fx.repo, env: envFor(A) }).status, 0);
    const prep = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(prep.status, 0, prep.stdout);
    const [entry] = manifestOf(prep).scope.repos;
    assert.deepEqual(entry.unregistered, []);
    assert.equal(path.resolve(entry.sessions[0].worktree).toLowerCase(), path.resolve(wt).toLowerCase(), 'the session resolves the worktree its branch is checked out in');
  });

  it('receive re-checks: refuses (exit 3) while the work is unclaimed, clean once it is claimed', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-u5-'), { task: null });
    const wt = addWorktree(fx, 'late-claim');
    fs.writeFileSync(path.join(wt, 'notes.md'), 'in flight\n');
    const prep = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(prep.status, 3);
    const recv = () => runFleet(['handover', 'receive', '--from', prep.json.handover.json, '--json'], { cwd: fx.repo, env: envFor(A) });
    const r1 = recv();
    assert.equal(r1.status, 3, r1.stdout);
    assert.equal(r1.json.handover.unregistered.length, 1);
    assert.match(r1.json.text, /UNREGISTERED WORK: .*late-claim/);
    assert.equal(runFleet(['claim', '--id', 'late-claim', '--intent', 'wip', '--paths', 'notes.md'], { cwd: wt, env: envFor(A) }).status, 0);
    const r2 = recv();
    assert.deepEqual(r2.json.handover.unregistered, [], r2.stdout);
  });

  it('receive measures NOW: work that appeared after a clean prepare blocks (M1/H3)', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-u7-'), { task: null });
    const prep = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(prep.status, 0, prep.stdout);
    const wt = addWorktree(fx, 'after-prepare');
    fs.writeFileSync(path.join(wt, 'late.md'), 'new\n');
    const r = runFleet(['handover', 'receive', '--from', prep.json.handover.json, '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(r.status, 3, r.stdout);
    assert.deepEqual(r.json.handover.unregistered.map((u) => u.branch), ['after-prepare']);
  });

  it('a claim made after a clean prepare is a live session at receive, not invisible (R3-H1)', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-u9-'), { task: null });
    const prep = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(prep.status, 0, prep.stdout);
    const wt = addWorktree(fx, 'claimed-later');
    fs.writeFileSync(path.join(wt, 'n.md'), 'n\n');
    assert.equal(runFleet(['claim', '--id', 'claimed-later', '--intent', 'later', '--paths', 'n.md'], { cwd: wt, env: envFor(A) }).status, 0);
    const r = runFleet(['handover', 'receive', '--from', prep.json.handover.json, '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.deepEqual(r.json.handover.liveSessions.map((x) => [x.id, x.sincePrepare]), [['claimed-later', true]], r.stdout);
    assert.deepEqual(r.json.handover.unregistered, [], 'the claim covers its worktree');
    assert.match(r.json.text, /claimed since prepare/);
  });

  it('a scoped repo that cannot be measured is never "ready" and still gets a coordinator (H1)', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-u8-'), { task: null });
    const notRepo = tmpRoot('handover-notrepo-');
    const prep = runFleet(['handover', 'prepare', '--repo', notRepo, '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(prep.status, 3, prep.stdout);
    assert.match(prep.json.text, /NOT MEASURED in/);
    const md = fs.readFileSync(prep.json.handover.md, 'utf8');
    assert.ok(md.slice(md.indexOf('## Coordination prompt')).includes(`cwd "${notRepo}"`), 'the unmeasured repo still gets a coordinator');
  });

  it('the coordination prompt fans out one coordinator chip per repo, each with an explicit cwd (M2)', () => {
    const fx = makeFleetRepo();
    const other = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-u6-'), { task: null });
    assert.equal(runFleet(['claim', '--id', 'home-work', '--intent', 'here', '--paths', 'a.txt'], { cwd: fx.repo, env: envFor(A) }).status, 0);
    assert.equal(runFleet(['claim', '--id', 'other-work', '--intent', 'there', '--paths', 'b.txt'], { cwd: other.repo, env: envFor(A) }).status, 0);
    const prep = runFleet(['handover', 'prepare', '--repo', other.repo, '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(prep.status, 0, prep.stdout);
    const md = fs.readFileSync(prep.json.handover.md, 'utf8');
    const prompt = md.slice(md.indexOf('## Coordination prompt'));
    assert.ok(prompt.includes(`cwd "${other.repo}"`), prompt);
    assert.ok(prompt.includes(`cwd "${fx.repo}"`), 'the invoking repo gets an explicit cwd too, so the prompt does not depend on where it is pasted');
    assert.doesNotMatch(prompt, /this repo/);
    assert.ok(md.includes(`### ${other.repo}`), 'sessions are grouped per repo so a chip can be handed its own section');
  });
});

describe('defect h — a claim whose work landed is not a live session in a handover', () => {
  const envFor = (cfg) => scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '' });
  const landedClaim = (fx, env, name) => {
    const wt = path.join(tmpRoot('handover-h-'), name);
    git(['worktree', 'add', '-q', '-b', name, wt, 'main'], fx.repo);
    assert.equal(runFleet(['claim', '--intent', `${name} work`, '--paths', `${name}.txt`], { cwd: wt, env }).status, 0);
    commitFile(wt, `${name}.txt`, `${name}\n`);
    return wt;
  };

  it('a squash-merged, clean claim reads done in prepare AND receive, listed with its release command', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-h1-'), { task: null });
    const env = envFor(A);
    landedClaim(fx, env, 'landed');
    git(['merge', '--squash', 'landed'], fx.repo); git(['commit', '-q', '-m', 'landed (#5)'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
    // control: the status view already derives it done — the handover must agree with it
    const st = runFleet(['status', '--json'], { cwd: fx.repo, env }).json.status.items.find((i) => i.id === 'landed');
    assert.equal(st.state, 'done');
    const prep = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env });
    assert.equal(prep.status, 0, prep.stdout);
    const [entry] = JSON.parse(fs.readFileSync(prep.json.handover.json, 'utf8')).scope.repos;
    assert.deepEqual(entry.sessions.map((s) => s.id), [], 'a landed claim is never a session to resume');
    assert.deepEqual(entry.mergedUnreleased.map((m) => [m.id, m.release]), [['landed', 'node scripts/.claude-skills/fleet.mjs release --id landed']], 'a consumer-shaped repo runs its synced CLI');
    assert.deepEqual(entry.unregistered, [], 'its record is still non-terminal, so it still covers its worktree');
    assert.match(fs.readFileSync(prep.json.handover.md, 'utf8'), /Merged but not released[\s\S]*release --id landed/);
    const r = runFleet(['handover', 'receive', '--from', prep.json.handover.json, '--json'], { cwd: fx.repo, env });
    assert.deepEqual(r.json.handover.liveSessions, [], 'receive derives live sessions the same way');
    assert.deepEqual(r.json.handover.mergedUnreleased.map((m) => m.id), ['landed']);
    assert.match(r.json.text, /merged but not released .*release --id landed/);
  });

  it('control: an unmerged claim stays live in both, and a merged one with a dirty worktree stays live too', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-h2-'), { task: null });
    const env = envFor(A);
    landedClaim(fx, env, 'unmerged');
    const dirty = landedClaim(fx, env, 'merged-dirty');
    git(['merge', '--squash', 'merged-dirty'], fx.repo); git(['commit', '-q', '-m', 'merged-dirty (#6)'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
    fs.writeFileSync(path.join(dirty, 'scratch.md'), 'not committed\n');
    const prep = runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env });
    const [entry] = JSON.parse(fs.readFileSync(prep.json.handover.json, 'utf8')).scope.repos;
    assert.deepEqual(entry.sessions.map((s) => s.id).sort(), ['merged-dirty', 'unmerged']);
    assert.deepEqual(entry.mergedUnreleased, []);
    const r = runFleet(['handover', 'receive', '--from', prep.json.handover.json, '--json'], { cwd: fx.repo, env });
    assert.deepEqual(r.json.handover.liveSessions.map((x) => x.id).sort(), ['merged-dirty', 'unmerged']);
  });
});

describe('handover hardening (cluster C: e, l)', () => {
  const envFor = (cfg) => scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '' });
  const prepareIn = (fx, A) => runFleet(['handover', 'prepare', '--json'], { cwd: fx.repo, env: envFor(A) });

  it('a NEWER manifest beside the given one refuses (exit 3); --allow-older receives it deliberately (control)', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-l-'), { task: null });
    const first = prepareIn(fx, A);
    const second = prepareIn(fx, A);
    assert.equal(first.status, 0, first.stdout);
    assert.ok(second.json.handover.id > first.json.handover.id, 'ids sort chronologically');
    const old = runFleet(['handover', 'receive', '--from', first.json.handover.json, '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(old.status, 3, old.stdout);
    assert.match(old.json.reason, /newer handover manifest sits beside this one/);
    const deliberate = runFleet(['handover', 'receive', '--from', first.json.handover.json, '--allow-older', '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(deliberate.status, 0, deliberate.stdout);
    const newest = runFleet(['handover', 'receive', '--from', second.json.handover.json, '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(newest.status, 0, 'the newest receives without the flag');
    assert.equal(runFleet(['handover', 'prepare', '--allow-older'], { cwd: fx.repo, env: envFor(A) }).status, 2, '--allow-older is receive-only');
  });

  it('a repo whose PR state cannot be read says so and names the account needed; a manifest without the field still receives', () => {
    const fx = makeFleetRepo();
    git(['remote', 'set-url', 'origin', 'https://github.com/owner-x/repo-y.git'], fx.repo); // no gh on PATH: unreadable
    const A = seedConfig(tmpRoot('handover-acct-e-'), { task: null });
    const prep = prepareIn(fx, A);
    const [entry] = JSON.parse(fs.readFileSync(prep.json.handover.json, 'utf8')).scope.repos;
    assert.deepEqual([entry.gh.queried, entry.ghRepo], [false, 'owner-x/repo-y']);
    assert.match(prep.json.text, /PR state unknown in .* sign in to gh with an account that can read owner-x\/repo-y/);
    assert.match(fs.readFileSync(prep.json.handover.md, 'utf8'), /PR state unknown/);
    const recv = runFleet(['handover', 'receive', '--from', prep.json.handover.json, '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(recv.json.handover.ghUnknown[0].ghRepo, 'owner-x/repo-y', 're-measured at receive');
    // A manifest written before these fields existed still parses and receives.
    const m = JSON.parse(fs.readFileSync(prep.json.handover.json, 'utf8'));
    for (const r of m.scope.repos) { delete r.gh; delete r.ghRepo; delete r.mergedUnreleased; }
    const legacy = prep.json.handover.json.replace(/\.json$/, '-legacy.json');
    fs.writeFileSync(legacy, JSON.stringify(m));
    const r2 = runFleet(['handover', 'receive', '--from', legacy, '--allow-older', '--json'], { cwd: fx.repo, env: envFor(A) });
    assert.equal(r2.status, 0, r2.stdout);
    assert.equal(r2.json.ok, true, r2.stdout);
    assert.equal(r2.json.handover.id, prep.json.handover.id, 'the legacy manifest is the one received');
    assert.equal(r2.json.handover.ghUnknown[0].ghRepo, 'owner-x/repo-y', 'the missing fields are re-measured, not required');
  });

  it('a directory that cannot be listed refuses (the newer-manifest check did not run); --allow-older receives (control)', () => {
    const fx = makeFleetRepo();
    const A = seedConfig(tmpRoot('handover-acct-l2-'), { task: null });
    const prep = prepareIn(fx, A);
    const ctx = { cwd: fx.repo, env: envFor(A), now: new Date() };
    const broken = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
    const r = receiveHandover(ctx, { '--from': prep.json.handover.json }, { readdir: broken });
    assert.equal(r.code, 'refused');
    assert.equal(r.handover.reason, 'newer-manifest-unknown');
    assert.match(r.reason, /could not check for a newer handover manifest: .* \(EACCES\)/);
    const deliberate = receiveHandover(ctx, { '--from': prep.json.handover.json, '--allow-older': true }, { readdir: broken });
    assert.equal(deliberate.code, 'ok', JSON.stringify(deliberate.reason ?? null));
    assert.equal(deliberate.ok, true);
    assert.equal(deliberate.handover.id, prep.json.handover.id);
  });
});

describe('claimCommand (H2/M3, R2-H1)', () => {
  const cli = (platform) => quoteArg(path.resolve('/r', 'scripts/fleet.mjs'), platform);
  it('quotes every data argument on POSIX, and only claims after a successful cd', () => {
    const c = claimCommand({ worktree: "/w/it's $(rm -rf x)", branch: 'feat;$(id)' }, 'node scripts/fleet.mjs', '/r', 'linux');
    assert.equal(c, `cd '/w/it'\\''s $(rm -rf x)' && node ${cli('linux')} claim --id 'feat;$(id)' --intent 'what it is' --paths 'changed/paths/**'`);
  });
  it('quotes every data argument for PowerShell, and a failed Set-Location terminates', () => {
    const c = claimCommand({ worktree: "C:\\w\\it's", branch: 'feat;$x' }, 'node scripts/fleet.mjs', '/r', 'win32');
    assert.equal(c, `Set-Location -LiteralPath 'C:\\w\\it''s' -ErrorAction Stop; node ${cli('win32')} claim --id 'feat;$x' --intent 'what it is' --paths 'changed/paths/**'`);
  });
  it('executed from inside another fleet repo: a missing worktree claims nothing; an existing one claims IT', () => {
    const fx = makeFleetRepo();
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off' });
    const sourceRoot = path.resolve(path.dirname(FLEET_CLI), '..');
    const run = (cmd) => (process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: fx.repo, env, encoding: 'utf8' })
      : spawnSync('sh', ['-c', cmd], { cwd: fx.repo, env, encoding: 'utf8' }));
    const sessionsDir = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet', 'sessions');
    const records = () => (fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')) : []);
    const missing = run(claimCommand({ worktree: path.join(fx.root, 'gone'), branch: 'ghost' }, 'node scripts/fleet.mjs', sourceRoot));
    assert.notEqual(missing.status, 0, 'a failed directory change must fail the command');
    assert.deepEqual(records(), [], 'no claim was written against the shell\'s original directory');
    const wt = path.join(fx.root, 'real-wt');
    git(['worktree', 'add', '-q', '-b', 'real', wt], fx.repo);
    const okRun = run(claimCommand({ worktree: wt, branch: 'real' }, 'node scripts/fleet.mjs', sourceRoot));
    assert.equal(okRun.status, 0, okRun.stderr + okRun.stdout);
    const rec = JSON.parse(fs.readFileSync(path.join(sessionsDir, records()[0]), 'utf8'));
    assert.equal(path.resolve(rec.worktree).toLowerCase(), path.resolve(wt).toLowerCase(), 'the claim is bound to the target worktree');
  });
});

describe('mainCheckout', () => {
  it('a linked worktree resolves to the MAIN checkout (one repo, one identity)', () => {
    const fx = makeFleetRepo();
    const wt = path.join(tmpRoot('handover-wt-'), 'wt');
    git(['worktree', 'add', '-q', '-b', 'side', wt], fx.repo);
    assert.equal(path.resolve(mainCheckout(wt)).toLowerCase(), path.resolve(fx.repo).toLowerCase());
  });
});
