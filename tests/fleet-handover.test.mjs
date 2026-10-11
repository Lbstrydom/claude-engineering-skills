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
import { git } from './helpers/git.mjs';
import {
  HANDOVER_SCHEMA_VERSION, OP_ID_RE, checkHandoverFlags, collectMemory, decideFile, handoverId, loadManifest,
  mainCheckout, receiveHandover, safeRelSegments,
} from '../scripts/lib/fleet/handover.mjs';
import { withFileLockSync } from '../scripts/lib/file-lock.mjs';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';

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
    const prep = f(['handover', 'prepare'], A);
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
    assert.equal(r.status, 3, 'the scheduled task must be recreated by a human');
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

describe('mainCheckout', () => {
  it('a linked worktree resolves to the MAIN checkout (one repo, one identity)', () => {
    const fx = makeFleetRepo();
    const wt = path.join(tmpRoot('handover-wt-'), 'wt');
    git(['worktree', 'add', '-q', '-b', 'side', wt], fx.repo);
    assert.equal(path.resolve(mainCheckout(wt)).toLowerCase(), path.resolve(fx.repo).toLowerCase());
  });
});
