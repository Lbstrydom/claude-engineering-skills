/**
 * @fileoverview `fleet handover` hardening (fleet chips theme PR 4; p-20261014064525-f69b, -9019, -328a): scheduled tasks
 * exported in full under a publication contract, the scheduler snapshot joined by id, the machine lease recorded, the
 * memory-backup reminder, the pickup order and peers-by-title in the coordination prompt, and receive re-hashing the copies.
 *
 * Every refusal is paired with the control that passes, and the publication contract is driven through injected faults
 * (a task read, a copy, and between the copies and the manifest write).
 *
 * Plan: docs/plans/fleet-chips-and-merge-friction.md section 2.4.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { HandoverManifestSchema, leaseState, prepareHandover } from '../scripts/lib/fleet/handover.mjs';
import { joinTaskRecords, parseSchedulerSnapshot, stageTaskExports, verifyTaskExports } from '../scripts/lib/fleet/handover-tasks.mjs';

after(cleanupFleetRoots);

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
const envFor = (cfg, extra = {}) => scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '', ...extra });

/** A config root with scheduled tasks (and a little memory, so prepare has something to read). */
function account(root, tasks = ['weekly-check', 'nightly-sync']) {
  const mem = path.join(root, 'projects', 'c--GIT-demo', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.writeFileSync(mem, '- index\n');
  for (const t of tasks) {
    fs.mkdirSync(path.join(root, 'scheduled-tasks', t), { recursive: true });
    fs.writeFileSync(path.join(root, 'scheduled-tasks', t, 'SKILL.md'), `---\nname: ${t}\ndescription: ${t} task\n---\nthe full body of ${t}\n`);
  }
  return root;
}
const run = (fx, cfg, args, extra) => runFleet([...args, '--json'], { cwd: fx.repo, env: envFor(cfg, extra) });

describe('parseSchedulerSnapshot', () => {
  const ids = ['a', 'b'];
  it('joins a valid array, and an object holding "tasks"', () => {
    const r = parseSchedulerSnapshot(JSON.stringify([{ id: 'a', cronExpression: '0 9 * * 1', enabled: true, extra: 1 }]), ids);
    assert.equal(r.ok, true);
    assert.deepEqual(r.byId.get('a'), { cronExpression: '0 9 * * 1', enabled: true }, 'only the schedule keys travel');
    assert.equal(parseSchedulerSnapshot(JSON.stringify({ tasks: [{ taskId: 'b', fireAt: '2026-10-16T09:00:00Z' }] }), ids).ok, true);
  });
  for (const [why, text, re] of [
    ['not JSON', '{', /not JSON/],
    ['not an array', '{"x":1}', /not a JSON array/],
    ['an entry without an id', '[{"cronExpression":"x"}]', /no string "id"/],
    ['a duplicate id', '[{"id":"a"},{"id":"a"}]', /twice/],
    ['an id with no task on disk', '[{"id":"ghost"}]', /no SKILL.md/],
    ['a non-boolean enabled', '[{"id":"a","enabled":"yes"}]', /not a boolean/],
    ['a non-string fireAt', '[{"id":"a","fireAt":5}]', /not a string/],
  ]) {
    it(`refuses ${why}`, () => {
      const r = parseSchedulerSnapshot(text, ids);
      assert.equal(r.ok, false);
      assert.match(r.reason, re);
    });
  }
});

describe('stageTaskExports: all or nothing', () => {
  it('copies every body, hashing the bytes WRITTEN, and publishes the directory', () => {
    const cfg = account(tmpRoot('ho-exp-'));
    const dest = path.join(tmpRoot('ho-dest-'), 'handover-x-tasks');
    const r = stageTaskExports({ configDir: cfg, ids: ['weekly-check', 'nightly-sync'], destDir: dest });
    assert.equal(r.ok, true, r.reason);
    const e = r.exports.get('weekly-check');
    const onDisk = fs.readFileSync(path.join(dest, 'weekly-check', 'SKILL.md'));
    assert.equal(e.sha256, sha(onDisk));
    assert.equal(e.path, path.join(dest, 'weekly-check', 'SKILL.md'));
  });

  it('a short write is REFUSED: nothing is staged or published', () => {
    const cfg = account(tmpRoot('ho-short-'), ['weekly-check']);
    const parent = tmpRoot('ho-dest-');
    const dest = path.join(parent, 'handover-y-tasks');
    const r = stageTaskExports({ configDir: cfg, ids: ['weekly-check'], destDir: dest, io: { writeFile: (p, b) => fs.writeFileSync(p, b.subarray(0, 5)) } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not match its source \(5 of \d+ bytes\)/);
    assert.deepEqual(fs.readdirSync(parent), []);
  });

  for (const [why, io, re] of [
    ['a task that cannot be read', { readFile: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }, /cannot read task .* \(EACCES\)/],
    ['a copy that fails', { writeFile: () => { throw Object.assign(new Error('x'), { code: 'ENOSPC' }); } }, /cannot copy task .* \(ENOSPC\)/],
    ['a publish rename that fails', { rename: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } }, /cannot publish/],
  ]) {
    it(`${why}: an error, and no copies left behind`, () => {
      const cfg = account(tmpRoot('ho-fault-'));
      const parent = tmpRoot('ho-fdest-');
      const dest = path.join(parent, 'handover-z-tasks');
      const r = stageTaskExports({ configDir: cfg, ids: ['weekly-check', 'nightly-sync'], destDir: dest, io });
      assert.equal(r.ok, false);
      assert.match(r.reason, re);
      assert.deepEqual(fs.readdirSync(parent), [], 'neither the staging directory nor the destination remains');
    });
  }
});

describe('joinTaskRecords / verifyTaskExports', () => {
  it('names why a schedule is unknown, with and without a snapshot', () => {
    const tasks = [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }];
    assert.equal(joinTaskRecords(tasks, null, null)[0].scheduleUnknown, 'unknown (no --scheduler-snapshot)');
    const joined = joinTaskRecords(tasks, null, new Map([['a', { enabled: false }]]));
    assert.deepEqual(joined[0].schedule, { enabled: false });
    assert.match(joined[1].scheduleUnknown, /not in the scheduler snapshot/);
  });
  it('re-hashes: ok, mismatch, missing, and none for a manifest written before the export', () => {
    const d = tmpRoot('ho-verify-');
    const f = path.join(d, 'SKILL.md');
    fs.writeFileSync(f, 'body\n');
    const rec = (over) => ({ id: 'a', description: 'A', export: { path: f, sha256: sha('body\n'), bytes: 5 }, ...over });
    assert.equal(verifyTaskExports([rec()])[0].export, 'ok');
    assert.equal(verifyTaskExports([rec({ export: { path: f, sha256: sha('other'), bytes: 5 } })])[0].export, 'mismatch');
    assert.equal(verifyTaskExports([rec({ export: { path: path.join(d, 'gone.md'), sha256: sha('x'), bytes: 1 } })])[0].export, 'missing');
    assert.equal(verifyTaskExports([{ id: 'a', description: 'A' }])[0].export, 'none');
  });
});

describe('prepare: the publication contract, end to end', () => {
  const ctxFor = (fx, cfg, extra = {}) => ({ env: envFor(cfg, extra), cwd: fx.repo, dir: path.join(fx.repo, '.git', 'fleet'), now: new Date(), cmd: 'node scripts/fleet.mjs' });
  const listed = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

  it('a fault between the copies and the manifest publishes NOTHING: no manifest, no markdown, no copies', async () => {
    const fx = makeFleetRepo();
    const cfg = account(tmpRoot('ho-pub-'));
    const ctx = ctxFor(fx, cfg);
    const r = await prepareHandover(ctx, {}, { beforeManifest: () => { throw new Error('disk full'); } });
    assert.match(r.error, /could not be published \(disk full\); the task copies were removed/);
    assert.deepEqual(listed(path.join(ctx.dir, 'handover')), []);
  });

  it('a rollback that cannot remove the copies says so, naming what is left', async () => {
    const fx = makeFleetRepo();
    const ctx = ctxFor(fx, account(tmpRoot('ho-pub-left-')));
    const r = await prepareHandover(ctx, {}, { beforeManifest: () => { throw new Error('disk full'); }, removeTasks: () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }); } });
    assert.match(r.error, /rollback incomplete\. NOT removed, delete by hand: .*-tasks \(EBUSY\)/);
    assert.doesNotMatch(r.error, /the task copies were removed/);
  });

  it('staging: a failed cleanup is part of the reason and the leftover is named', () => {
    const cfg = account(tmpRoot('ho-stage-left-'), ['weekly-check']);
    const dest = path.join(tmpRoot('ho-stage-dest-'), 'handover-q-tasks');
    const r = stageTaskExports({ configDir: cfg, ids: ['weekly-check'], destDir: dest, io: { rename: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }, rm: () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }); } } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /could not be removed \(EBUSY\)/);
    assert.equal(r.leftover.length, 1);
    rm(r.leftover[0]);
  });

  it('a task that cannot be read publishes nothing either', async () => {
    const fx = makeFleetRepo();
    const ctx = ctxFor(fx, account(tmpRoot('ho-pub-read-')));
    const r = await prepareHandover(ctx, {}, { taskIo: { readFile: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } } });
    assert.match(r.error, /scheduled-task export failed: cannot read task/);
    assert.deepEqual(listed(path.join(ctx.dir, 'handover')), []);
  });

  it('control: the same prepare without a fault publishes a manifest that lists every export, and it validates', async () => {
    const fx = makeFleetRepo();
    const ctx = ctxFor(fx, account(tmpRoot('ho-pub-ok-')), { FLEET_MEMORY_BACKUP_CMD: 'my-backup --to private-repo' });
    const r = await prepareHandover(ctx, {});
    assert.equal(r.error, undefined);
    const m = JSON.parse(fs.readFileSync(r.artifacts.json, 'utf8'));
    assert.equal(HandoverManifestSchema.safeParse(m).success, true);
    for (const t of m.scheduledTasks) assert.ok(fs.existsSync(t.export.path), `${t.id} export exists`);
    assert.equal(m.memoryBackupCmd, 'my-backup --to private-repo');
    assert.deepEqual(Object.keys(m.lease).sort(), ['holder', 'turn', 'waiters', 'windows'], 'an absent lease is a measured free one');
  });
});

describe('the CLI: snapshot, receive re-hash, prompt and markdown', () => {
  it('--scheduler-snapshot joins by id; the markdown shows the schedule and the export', () => {
    const fx = makeFleetRepo();
    const cfg = account(tmpRoot('ho-cli-'));
    const snap = path.join(tmpRoot('ho-snap-'), 'snap.json');
    fs.writeFileSync(snap, JSON.stringify([{ id: 'weekly-check', cronExpression: '0 9 * * 1', enabled: true }, { id: 'nightly-sync', fireAt: '2026-10-16T02:00:00Z', enabled: false }]));
    const r = run(fx, cfg, ['handover', 'prepare', '--winddown-waived', 'fixture: no coordinator context to write', '--scheduler-checked', '--scheduler-snapshot', snap]);
    assert.equal(r.status, 0, r.stdout);
    const md = fs.readFileSync(r.json.handover.md, 'utf8');
    assert.match(md, /schedule: cronExpression 0 9 \* \* 1, enabled true/);
    assert.match(md, /full SKILL\.md: `.*handover-.*-tasks/);
    assert.match(md, /## Machine lease at prepare/);
    assert.match(md, /## Back up memory/);
  });

  it('a bad snapshot fails prepare (non-zero) and publishes nothing', () => {
    const fx = makeFleetRepo();
    const cfg = account(tmpRoot('ho-cli-bad-'));
    const snap = path.join(tmpRoot('ho-snap-bad-'), 'snap.json');
    fs.writeFileSync(snap, JSON.stringify([{ id: 'ghost' }]));
    const r = run(fx, cfg, ['handover', 'prepare', '--winddown-waived', 'fixture: no coordinator context to write', '--scheduler-checked', '--scheduler-snapshot', snap]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /no SKILL\.md/);
    const dir = path.join(fx.repo, '.git', 'fleet', 'handover');
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  });

  it('without a snapshot: each task says why its schedule is unknown, and BEFORE YOU RELAUNCH asks for one', () => {
    const fx = makeFleetRepo();
    const r = run(fx, account(tmpRoot('ho-cli-nosnap-')), ['handover', 'prepare', '--winddown-waived', 'fixture: no coordinator context to write']);
    assert.match(r.json.text, /--scheduler-snapshot <file>/);
    assert.match(fs.readFileSync(r.json.handover.md, 'utf8'), /schedule: unknown \(no --scheduler-snapshot\)/);
  });

  it('the coordination prompt opens with the pickup order and names peers by title', () => {
    const fx = makeFleetRepo();
    const r = run(fx, account(tmpRoot('ho-cli-prompt-')), ['handover', 'prepare', '--winddown-waived', 'fixture: no coordinator context to write', '--scheduler-checked']);
    const prompt = fs.readFileSync(r.json.handover.md, 'utf8').split('## Coordination prompt for the new account')[1];
    const ci = prompt.indexOf('(i) the CI queue');
    const disc = prompt.indexOf('(iii) only then discovery');
    const step1 = prompt.indexOf('1. Read the handover');
    assert.ok(ci > 0 && ci < disc && disc < step1, 'CI queue, then the lease window, then discovery, before any numbered step');
    assert.match(prompt, /<REPO>: Coordinator/);
    assert.match(prompt, /list_sessions/);
  });

  it('receive re-hashes the copies: a tampered copy is a named follow-up; the untouched control is not', () => {
    const fx = makeFleetRepo();
    const A = account(tmpRoot('ho-rcv-A-'));
    const p = run(fx, A, ['handover', 'prepare', '--winddown-waived', 'fixture: no coordinator context to write', '--scheduler-checked']);
    assert.equal(p.status, 0, p.stdout);
    const B = account(tmpRoot('ho-rcv-B-'));
    const clean = run(fx, B, ['handover', 'receive', '--from', p.json.handover.json, '--dry-run']);
    assert.ok(!(clean.json.handover.followUps ?? []).some((f) => f.kind === 'task-export'), JSON.stringify(clean.json.handover.followUps));
    const m = JSON.parse(fs.readFileSync(p.json.handover.json, 'utf8'));
    fs.writeFileSync(m.scheduledTasks[0].export.path, 'tampered\n');
    const tampered = run(fx, B, ['handover', 'receive', '--from', p.json.handover.json, '--dry-run']);
    const f = (tampered.json.handover.followUps ?? []).find((x) => x.kind === 'task-export');
    assert.ok(f, JSON.stringify(tampered.json.handover.followUps));
    assert.match(f.detail, /not the copy prepare hashed/);
  });

  it('--scheduler-snapshot on receive is an argv error (exit 2)', () => {
    const fx = makeFleetRepo();
    const r = run(fx, account(tmpRoot('ho-cli-argv-')), ['handover', 'receive', '--from', 'x.json', '--scheduler-snapshot', 'y.json']);
    assert.equal(r.status, 2);
  });
});

describe('leaseState', () => {
  it('a lease directory that is a file is UNMEASURED, never a free lease', () => {
    const d = tmpRoot('ho-lease-');
    const file = path.join(d, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const s = leaseState({ FLEET_MACHINE_DIR: file }, new Date());
    assert.ok(s.unmeasured, JSON.stringify(s));
    assert.ok(leaseState({ FLEET_MACHINE_DIR: 'relative/path' }, new Date()).unmeasured, 'a misconfigured dir is unmeasured too');
    rm(d);
  });
});
